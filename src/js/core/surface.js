// The canvas view: sizing, the draw loop, culling, overlays.

import { Camera } from './camera.js';
import { drawBackground, drawRuling, drawObject, drawSelection, drawMemberOutline, drawLockBadge, drawGroupHint, drawLockedOutline, FONT, setDarkBoard, isDarkBoard, faceOf, inkPaint, setPageColor } from './render.js';
import { worldBounds, boundsOf } from './store.js';
import { pageRects, pageIndexForBox, pageIndexForBoxIn, stripBounds } from './pages.js';
import { boxesIntersect } from './util.js';
import { currentLanguage } from '../i18n.js';
import { route as connectorRoute, midPoint } from './connectors.js';

export class Surface {
  /**
   * @param {object} opts
   * @param {boolean} opts.lowLatency  ask for a desynchronized ("low latency")
   *   canvas. It shaves a little lag off the pen, but it hands the canvas to
   *   the compositor without the usual double buffering, and on some Windows
   *   graphics drivers - notably since the Chromium that came with Electron 43
   *   - a board carrying several large page bitmaps blinks on every repaint.
   *   A steady picture beats a few milliseconds, so this is off unless asked
   *   for. It can only be set when the canvas is created, so changing it takes
   *   effect the next time the app opens.
   */
  constructor(canvas, store, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: !!opts.lowLatency });
    this.store = store;
    this.cam = new Camera();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = 0; this.height = 0;
    this.dirty = true;
    this.overlays = [];        // fn(ctx, surface) drawn in screen space
    this.wet = null;           // in-progress stroke object
    this.laser = [];           // pointer trail: {x,y,t} world points, never saved
    /*
     * What an empty board says before anything is on it. Drawn over the board
     * rather than placed on it, the way the laser is: it is not an object, so
     * it cannot be selected, erased, saved, synced, undone or exported, and a
     * board with nothing on it stays a board with nothing on it. Null turns it
     * off. See drawGreeting().
     */
    this.greeting = 'Happy Inking !!';
    this._greetingDrawn = null;   // what the last frame drew, for the suite
    // Answer covers on their way out: id -> { obj, t0 }. See fadeOut().
    this._fades = new Map();
    this._lockedRev = -1;      // revision the locked-object list was built for
    this._locked = [];
    this._groupRev = -1;       // and the same for the group outlines
    this._groupBoxes = null;
    // Outline every group, or only the one being touched. The app keeps this
    // in step with its settings; the surface does not reach back for it.
    this.showGroupOutlines = true;
    this.selection = new Set();
    this.hoverId = null;
    this._raf = null;
    this._warming = null;      // handle of a queued idle rebuild, see warmFreeze()
    this._onFrame = this._onFrame.bind(this);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener('resize', () => this.resize());
    // a move between monitors changes devicePixelRatio without a resize event
    this._watchPixelRatio();
    this.resize(true);
    this.start();
  }

  start() { if (!this._raf) this._raf = requestAnimationFrame(this._onFrame); }

  _watchPixelRatio() {
    const arm = () => {
      const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', () => { this.resize(); arm(); }, { once: true });
    };
    try { arm(); } catch { /* older engines: the per-frame check still covers it */ }
  }
  /**
   * The object whose text is being typed into right now, as { id, cell }.
   * Set by the text editor. Its text is left off the canvas while the textarea
   * is showing the same words in the same place - see drawObject().
   */
  editing = null;

  invalidate() { this.dirty = true; this._band = null; this._bandOnly = false; this._fullAsked = true; }

  /**
   * Repaint from scratch, frozen copy and all.
   *
   * invalidate() asks for a new frame, but a frame is allowed to reuse the
   * frozen copy of the board when nothing in the document has moved. That is
   * the wrong answer when the change is in HOW things are drawn rather than
   * what they are - a late-arriving font, a picture that finished loading -
   * because the document revision never moves and the copy stays convincingly
   * stale. Throwing the copy away first means the next frame really is drawn
   * again.
   */
  repaintAll() { this._ink = null; this._paper = null; this.invalidate(); }

  /*
   * Repaint only this world-space box on the next frame.
   *
   * Anything that calls plain invalidate() before the frame lands wins - a
   * band and a whole board asked for in the same breath is a whole board, and
   * that is the safe way round. Several bands in one frame are merged, so a
   * fast scrub that reports six times between frames still costs one repaint
   * of the area it covered.
   */
  invalidateBand(box) {
    this.dirty = true;
    // Somebody has already asked for the whole board this frame. A band cannot
    // undo that - the safe direction is always towards painting more.
    if (this._fullAsked) return;
    if (!this._band) { this._band = { ...box }; this._bandOnly = true; return; }
    const b = this._band;
    const x = Math.min(b.x, box.x), y = Math.min(b.y, box.y);
    const r = Math.max(b.x + b.w, box.x + box.w), t = Math.max(b.y + b.h, box.y + box.h);
    this._band = { x, y, w: r - x, h: t - y };
  }

  /**
   * What the frozen copy is a picture OF.
   *
   * Everything that could change the picture is in here: the document
   * revision, where the camera is, how big the buffer is, and which object is
   * being typed into - a cell being edited is deliberately left off the canvas
   * while the textarea shows the same words in the same place. If any of it
   * moves, the copy is a picture of a board that no longer exists, and the
   * board is repainted rather than blitted.
   */
  freezeKey() {
    const cam = this.cam;
    const ed = this.editing ? `${this.editing.id}:${this.editing.cell || ''}` : '';
    const page = (this.store.doc.background && this.store.doc.background.color) || '';
    return `${this.store.rev}.${this._liveRev || 0}|${cam.x}|${cam.y}|${cam.z}|${this.width}|${this.height}|${this.dpr}|${ed}|${page}`;
  }

  /**
   * Objects were changed in place, mid-gesture.
   *
   * A drag, a resize or a rotation moves objects on every pointer move but
   * only files the change with the store when the gesture ends, so the
   * document revision does not move while it is going on. The frozen copy is
   * keyed on that revision - and the idle rebuild takes a fresh copy the
   * moment the board settles - so a resize began by blitting the board as it
   * was before the drag: the handles followed the pointer while the object
   * itself sat still, and a text box being narrowed showed its words still
   * laid out at the old width until the drag ended. This moves the key on
   * every such change, so the copy is only ever used for the board it shows.
   */
  touch() {
    this._liveRev = (this._liveRev || 0) + 1;
    this.invalidate();
  }

  /**
   * Paint one finished stroke INTO the frozen copy instead of voiding it.
   *
   * Lifting the pen commits the stroke to the document, which moves the
   * revision, which made the frozen copy stale - so the NEXT stroke had to
   * repaint every object on the board before it could draw anything. Writing a
   * word is a dozen short strokes, not one long one, so a crowded board paid
   * that price a dozen times over and the pen visibly stuttered between
   * letters. On 2688 objects pulled right back that was about 48ms a stroke.
   *
   * The stroke just finished is the only thing that changed, so painting only
   * it into the copy leaves the copy correct, and the next stroke starts by
   * blitting a board that is already right. Called by finishStroke(); anything
   * else that changes the document still moves the key and gets a real
   * repaint, which is the safe direction.
   */
  extendFreeze(obj) {
    if (!this._ink || !obj) return false;
    const cam = this.cam;
    const g = this._ink.canvas.getContext('2d');
    g.setTransform(this.dpr * cam.z, 0, 0, this.dpr * cam.z, this.dpr * cam.x, this.dpr * cam.y);
    const onload = () => { this._ink = null; this.invalidate(); };
    const pages = this.store.doc.pages;
    const i = pages.length ? pageIndexForBox(pages, boundsOf(obj)) : -1;
    if (i >= 0) {
      // ink has to be clipped to its own sheet here exactly as it is on screen,
      // or a stroke that ran off the paper would be baked into the copy
      const r = pageRects(pages)[i];
      g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
      drawObject(g, obj, onload, this.editing);
      g.restore();
    } else drawObject(g, obj, onload, this.editing);
    this._ink.key = this.freezeKey();
    return true;
  }

  /**
   * Sync the drawing buffer to the element's real layout box.
   *
   * The element's SIZE is left entirely to CSS (`inset: 0`), so it can never
   * drift from the stage; only the backing store is set here. This is called
   * from resize events and again every frame, where it costs two cached layout
   * reads and returns immediately unless something actually changed - which is
   * what makes it self-correcting after a maximize, a monitor change, or a
   * display-scaling change that fires no event we happened to listen for.
   */
  resize(force = false) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (!force && w === this.width && h === this.height && dpr === this.dpr) return false;

    this.width = w; this.height = h; this.dpr = dpr;
    this._painted = false;         // the buffer was thrown away with the old size
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    // A window that just changed shape changes where the paper belongs in it:
    // a page centred a moment ago is off to one side now, and nothing else
    // asks for it until the next pan. Cheap, and a no-op on a board with no
    // pages at all.
    this.clampCamera();
    this.invalidate();
    this.onResize?.(w, h);
    return true;
  }

  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.cam.toWorld(e.clientX - r.left, e.clientY - r.top);
  }
  toScreenPt(w) { return this.cam.toScreen(w.x, w.y); }
  screenPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  selectionBounds() {
    let b = null;
    for (const id of this.selection) {
      const o = this.store.get(id);
      if (!o) continue;
      const ob = worldBounds(o);
      b = b ? {
        x: Math.min(b.x, ob.x), y: Math.min(b.y, ob.y),
        w: Math.max(b.x + b.w, ob.x + ob.w) - Math.min(b.x, ob.x),
        h: Math.max(b.y + b.h, ob.y + ob.h) - Math.min(b.y, ob.y)
      } : ob;
    }
    return b;
  }

  /** True when every selected object is locked - no transform handles then. */
  selectionIsLocked() {
    if (!this.selection.size) return false;
    for (const id of this.selection) { const o = this.store.get(id); if (o && !o.locked) return false; }
    return true;
  }

  selectionScreenBox(pad = 6) {
    const b = this.selectionBounds();
    if (!b) return null;
    const p = this.cam.toScreen(b.x, b.y);
    return { x: p.x - pad, y: p.y - pad, w: b.w * this.cam.z + pad * 2, h: b.h * this.cam.z + pad * 2 };
  }

  static LASER_LIFE = 520;       // ms a point stays visible
  static FADE_MS = 260;          // ms a lifted answer cover takes to melt away

  /** Drop trail points that have faded out. */
  pruneLaser() {
    if (!this.laser.length) return;
    const cut = performance.now() - Surface.LASER_LIFE;
    let i = 0;
    while (i < this.laser.length && this.laser[i].t < cut) i++;
    if (i) this.laser.splice(0, i);
  }

  _onFrame() {
    this._raf = requestAnimationFrame(this._onFrame);
    this.resize();                 // cheap no-op unless the box or DPR moved
    // a fading trail has to keep repainting even when nothing else changed
    if (this.laser.length) { this.pruneLaser(); this.dirty = true; }
    if (this._fades.size) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  /** CSS-pixel coordinates map 1:1 to the canvas after this. */
  screenTransform(ctx = this.ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

  /**
   * The paper - desk, sheets, ruling, the date - painted ONCE per view and
   * then copied, never re-drawn piecemeal.
   *
   * Erasing repaints only the strip under the eraser. Re-drawing the ruling
   * inside that strip gave pixels that were very nearly, but not exactly, the
   * ones the full paint had made: a graphics card smooths a line a hair
   * differently when it is cut by a clip, and at 125% or 150% display scaling
   * that showed as faint boxes along the eraser's path on dark boards and
   * notebook paper. A straight copy of pixels from one picture of the paper
   * cannot differ from itself, whatever the card does - so the strip and the
   * whole board now both take their paper from the same picture. It is
   * redrawn only when something about the paper changes: the view, the size,
   * the board's colour or pattern, its pages, the theme or the language.
   */
  _paintPaper(ctx, w, h, pages) {
    const bg = this.store.doc.background;
    const d = this.dpr || 1;
    const bw = ctx.canvas.width, bh = ctx.canvas.height;
    // a canvas of another size (an export, a test probe) just paints directly
    if (bw !== Math.round(w * d) || bh !== Math.round(h * d) || typeof document === 'undefined') {
      drawBackground(ctx, bg, this.cam, Math.max(w, bw / d), Math.max(h, bh / d), pages);
      return;
    }
    const cam = this.cam;
    const key = [bw, bh, d, cam.x, cam.y, cam.z, isDarkBoard(), currentLanguage(),
      JSON.stringify(bg), JSON.stringify(pages)].join('|');
    let p = this._paper;
    if (!p || p.key !== key) {
      const c = (p && p.canvas) || document.createElement('canvas');
      if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
      const g = c.getContext('2d', { alpha: false });
      g.setTransform(d, 0, 0, d, 0, 0);
      /*
       * Paint the whole buffer, not just w x h CSS pixels. At 125% a window
       * 1426.4 CSS pixels wide has a buffer 1783 device pixels wide, but
       * 1426 x 1.25 only reaches 1782.5 - the last column was half painted,
       * half left black, and came out grey. Repainting every frame used to
       * hide that (the half-coverage piled up towards the right colour); a
       * picture painted once does not get that second chance.
       */
      drawBackground(g, bg, cam, bw / d, bh / d, pages);
      p = this._paper = { key, canvas: c };
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(p.canvas, 0, 0);
    ctx.restore();
  }

  /** Background and every object, in world space. No selection chrome. */
  drawScene(ctx, w = this.width, h = this.height, onload = () => this.invalidate(), clip = null) {
    const cam = this.cam;
    this.screenTransform(ctx);
    const pages = this.store.doc.pages;
    /*
     * `clip` is a world-space box: paint ONLY that, and leave the rest of the
     * canvas holding the pixels it already had.
     *
     * An eraser changes the document on every move, so the frozen copy a pen
     * stroke leans on is void and the whole board was being repainted - on
     * 2688 objects pulled right back, far more than a frame's worth, every
     * move. But an eraser only ever changes the ink it is passing over. The
     * band under it is a few hundred pixels; the other several million have
     * not changed and do not need touching.
     */
    if (clip) {
      const a = cam.toScreen(clip.x, clip.y);
      const b = cam.toScreen(clip.x + clip.w, clip.y + clip.h);
      /*
       * The band's edges must fall on whole DEVICE pixels, not whole CSS
       * pixels. At 125% or 150% display scaling a CSS-pixel edge lands part of
       * the way through a device pixel, so the clip only half-covers that row
       * of pixels - and the desk colour, the sheet and the ruling are each
       * blended into it a second time over what was already there. On a white
       * page that is invisible; on a dark board or notebook paper it left a
       * faint box outline behind every move of the eraser.
       */
      const d = this.dpr || 1;
      const x0 = Math.floor(a.x * d - 1) / d, y0 = Math.floor(a.y * d - 1) / d;
      const x1 = Math.ceil(b.x * d + 1) / d, y1 = Math.ceil(b.y * d + 1) / d;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
    }
    this._paintPaper(ctx, w, h, pages);

    ctx.setTransform(this.dpr * cam.z, 0, 0, this.dpr * cam.z, this.dpr * cam.x, this.dpr * cam.y);

    const view = cam.viewport(w, h);
    const pad = 64 / cam.z;
    const vbox = { x: view.x - pad, y: view.y - pad, w: view.w + pad * 2, h: view.h + pad * 2 };

    /*
     * Walk the document in place rather than building a copy of it.
     *
     * `store.objects` is a getter that maps and filters the whole order array
     * into a NEW array every time it is read - 2688 objects allocated, on
     * every frame, only to be thrown away. Reading the same two fields
     * directly costs nothing and allocates nothing, which matters most on
     * exactly the boards where the frame was already tight.
     */
    const visible = [];
    const objs = this.store.doc.objects;
    for (const id of this.store.doc.order) {
      const o = objs[id];
      if (!o) continue;
      const wb = worldBounds(o);
      if (!boxesIntersect(vbox, wb)) continue;
      // Outside the band being repainted: its pixels are already right.
      if (clip && !boxesIntersect(clip, wb)) continue;
      visible.push(o);
    }

    if (!pages.length) {
      for (const o of visible) drawObject(ctx, o, onload, this.editing);
      if (clip) ctx.restore();
      return;
    }

    // Each sheet clips its own contents, so ink can never spill into the
    // gutter or onto a neighbouring page. Objects that belong to no sheet are
    // content from a board saved before clipping existed that the user chose
    // to keep - they stay visible on the desk rather than vanishing, which is
    // the whole point of having asked.
    const rects = pageRects(pages);
    const buckets = rects.map(() => []);
    const loose = [];
    for (const o of visible) {
      const i = pageIndexForBoxIn(rects, boundsOf(o));
      if (i >= 0) buckets[i].push(o); else loose.push(o);
    }
    for (const o of loose) drawObject(ctx, o, onload, this.editing);
    for (let i = 0; i < rects.length; i++) {
      if (!buckets[i].length) continue;
      const r = rects[i];
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      for (const o of buckets[i]) drawObject(ctx, o, onload, this.editing);
      ctx.restore();
    }
    if (clip) ctx.restore();
  }

  /** Paint the scene into an offscreen buffer we can blit while inking. */
  _freezeScene(key) {
    const bw = Math.max(1, Math.round(this.width * this.dpr));
    const bh = Math.max(1, Math.round(this.height * this.dpr));
    /*
     * The buffer is reused between strokes.
     *
     * Allocating a fresh full-screen canvas for every stroke is real work at
     * the exact moment somebody is putting pen to board - on a big display,
     * several megabytes a stroke, cleared and thrown away, all day. The frame
     * inside it is never trusted on age: freezeKey() decides whether it is
     * still a picture of the board as it is now, and it is repainted the
     * moment it is not.
     */
    let c = this._inkCanvas;
    if (!c || c.width !== bw || c.height !== bh) {
      c = document.createElement('canvas');
      c.width = bw; c.height = bh;
      this._inkCanvas = c;
    }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);
    // an image that finishes decoding mid-stroke has to invalidate the freeze,
    // or it would not appear until the pen lifted
    this.drawScene(g, this.width, this.height, () => { this._ink = null; this.invalidate(); });
    return { canvas: c, key };
  }

  /**
   * Take the photograph before it is needed.
   *
   * The board keeps a frozen copy of itself and blits that instead of drawing
   * every object again - which is what makes a crowded board usable at all.
   * Pan, zoom or open a board and that copy is a picture of somewhere else, so
   * it is thrown away. Nothing then takes a new one until something asks, and
   * the thing that asks is a pen touching down: the first stroke after moving
   * around paid for repainting the entire board before any ink could appear.
   * Around 80ms on five thousand strokes, all of it in the worst possible
   * place.
   *
   * The time was already there, unused. Between the hand stopping and the pen
   * landing there is always a gap - reaction time, deciding where to draw -
   * and it is far longer than the repaint. So the copy is taken during that
   * gap instead, and the pen finds it waiting.
   *
   * Nothing on the drawing path waits for this. A stroke that starts first
   * takes the old route and pays what it pays today; the copy is simply not
   * ready yet, which is exactly the situation before any of this existed. The
   * key is read when the work RUNS rather than when it is scheduled, so a
   * second pan mid-wait produces a copy of where the board ended up rather
   * than a stale one nobody wants.
   */
  warmFreeze() {
    // A timer handle of 0 is a real handle. `!= null` so a queued rebuild is
    // never mistaken for "nothing queued" and scheduled a second time.
    if (this._warming != null) return;
    const run = () => {
      this._warming = null;
      // Something is being drawn: the live path owns the copy and builds its
      // own. Stepping in here would repaint the board underneath a moving pen.
      if (this.wet || this.laser.length) return;
      const key = this.freezeKey();
      if (this._ink && this._ink.key === key) return;
      this._ink = this._freezeScene(key);
    };
    this._warming = (typeof requestIdleCallback === 'function')
      ? requestIdleCallback(run, { timeout: 300 })
      : setTimeout(run, 120);
  }

  /** The stroke under the pen, clipped to its own sheet. */
  _drawWet(ctx) {
    const cam = this.cam, pages = this.store.doc.pages;
    ctx.setTransform(this.dpr * cam.z, 0, 0, this.dpr * cam.z, this.dpr * cam.x, this.dpr * cam.y);
    const onload = () => this.invalidate();
    const one = (obj) => {
      if (!obj || !obj.points || obj.points.length < 2) return;
      const wi = pages.length ? pageIndexForBox(pages, boundsOf(obj)) : -1;
      if (wi >= 0) {
        const r = pageRects(pages)[wi];
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
        drawObject(ctx, obj, onload);
        ctx.restore();
      } else drawObject(ctx, obj, onload);
    };
    /*
     * A stroke the ruler cut in two is still one gesture in flight. The pieces
     * already drawn are not on the board yet - they are committed together on
     * lift - so they are painted here alongside the live one, or the first half
     * of the line would vanish the moment the pen came out the other side.
     */
    if (this.wetPieces) for (const piece of this.wetPieces) one(piece);
    one(this.wet);
  }

  /**
   * Paint the board.
   *
   * While a stroke is in flight the rest of the board cannot change, so it is
   * painted once into an offscreen canvas and blitted after that. Handwriting
   * on an imported page used to repaint every page bitmap under the nib on
   * every pointer move; now a stroke costs one blit and one polyline no matter
   * how heavy the page beneath it is. The cache is keyed on the document
   * revision, the camera and the buffer size, so anything that could change
   * the picture drops it automatically.
   */
  draw() {
    const { ctx, cam } = this;
    const w = this.width, h = this.height;
    if (!w || !h) return;
    // default ink asks the page whether it is dark, so the page has to be this board's
    setPageColor(this.store.doc.background && this.store.doc.background.color);

    /*
     * The laser repaints on every single frame while it fades, and nothing
     * underneath it can change while it does - it is a pointing device, it
     * writes nothing into the document. Redrawing the whole board 60 times a
     * second for a trail that is a dozen points long is what made the laser
     * crawl on a heavy board; it now blits the same frozen copy a stroke uses.
     */
    if (this.wet || this.laser.length) {
      const key = this.freezeKey();
      if (!this._ink || this._ink.key !== key) this._ink = this._freezeScene(key);
      this.screenTransform();
      ctx.drawImage(this._ink.canvas, 0, 0, w, h);
      if (this.wet) this._drawWet(ctx);
    } else if (this._bandOnly && this._band && this._painted && !this.showsGreeting() && !this._fades.size) {
      /*
       * Only the band that changed. The rest of the canvas keeps the pixels it
       * already has, which is the whole point: on a big board an eraser move
       * costs the area under the eraser rather than the entire document.
       *
       * `_painted` is the guard. A band is only meaningful on top of a frame
       * that is already correct, so the very first paint after a resize, a
       * board load or a camera move is always the full one.
       */
      this.drawScene(ctx, w, h, () => this.invalidate(), this._band);
    } else if (this._ink && this._ink.key === this.freezeKey()) {
      /*
       * Nothing has changed since the copy was taken, so blit it.
       *
       * This is the frame AFTER a pen lift, and on a crowded board it was the
       * whole remaining cost of handwriting. Printing rather than joining
       * letters means a lift after every letter, and each lift landed here and
       * repainted all 2688 objects - measured at 32ms a letter, worst case
       * over 100ms, while the strokes themselves cost 0.02ms a move.
       *
       * The key is what makes this safe rather than a stale-picture bug: it
       * carries the document revision, the camera, the buffer size and the
       * cell being typed into, and every document change goes through the
       * store and moves the revision. If the key still matches, the copy is
       * this board, and blitting it is the same picture as painting it.
       */
      this.screenTransform();
      ctx.drawImage(this._ink.canvas, 0, 0, w, h);
      this._painted = true;
    } else {
      /*
       * A late-decoding image has to drop the frozen copy as well as ask for a
       * repaint. Asking for a repaint alone would find the key unchanged - an
       * image arriving is not a document change - and blit the copy that was
       * taken before the picture existed, so it would never appear.
       */
      this.drawScene(ctx, w, h, () => { this._ink = null; this.invalidate(); });
      this._painted = true;
    }

    /*
     * "How much needs painting" is a question about ONE frame.
     *
     * Cleared here rather than in the frame loop, because draw() is reached by
     * other routes - an export, a test, a forced repaint - and a flag left
     * standing from a previous frame quietly turns every later band request
     * into a whole-board repaint. Which is exactly what it did.
     */
    this._fullAsked = false;
    this._band = null;
    this._bandOnly = false;

    // The board is drawn and nothing is in flight: a good moment to have the
    // frozen copy ready for whatever comes next. See warmFreeze().
    if (!this.wet && !this.laser.length
        && (!this._ink || this._ink.key !== this.freezeKey())) this.warmFreeze();

    // ---- screen-space overlays (CSS pixels) ----
    // Never cached: selection handles, hover and lock badges have to track the
    // pointer, and they are cheap.
    this.screenTransform();
    const view = cam.viewport(w, h);
    const pad = 64 / cam.z;
    const vbox = { x: view.x - pad, y: view.y - pad, w: view.w + pad * 2, h: view.h + pad * 2 };

    if (this.hoverId && !this.selection.has(this.hoverId)) {
      const o = this.store.get(this.hoverId);
      if (o) {
        const b = worldBounds(o);
        const p = cam.toScreen(b.x, b.y);
        ctx.save();
        ctx.strokeStyle = 'rgba(0,120,212,0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - 3, p.y - 3, b.w * cam.z + 6, b.h * cam.z + 6);
        ctx.restore();
      }
    }

    /*
     * Locked objects wear a badge. Finding them used to mean walking the whole
     * document on every single frame - on a board with a thousand strokes that
     * is a thousand checks per frame, for a handful of badges, while the pen is
     * moving. Which objects are locked can only change when the document does,
     * so the list is kept and rebuilt on the revision instead.
     */
    if (this._lockedRev !== this.store.rev) {
      this._lockedRev = this.store.rev;
      this._locked = this.store.objects.filter((o) => o && o.locked);
    }
    for (const o of this._locked) {
      if (!boxesIntersect(vbox, worldBounds(o))) continue;
      drawLockedOutline(ctx, cam, o);
      drawLockBadge(ctx, cam, o);
    }

    /*
     * Groups worth pointing out: the one being touched, and the one under the
     * cursor. Their outlines are measured when the document changes rather
     * than every frame, for the same reason the locked list is.
     */
    const active = new Set();
    for (const id of this.selection) {
      const o = this.store.get(id);
      if (o?.groupId) active.add(o.groupId);
    }
    const hovered = this.hoverId ? this.store.get(this.hoverId) : null;
    if (hovered?.groupId) active.add(hovered.groupId);
    // Every group on the board is outlined, faintly, so that a finished poster
    // says which of its parts are tied together without being prodded first.
    // Anyone who finds that busy can switch it off in Settings.
    const showAll = this.showGroupOutlines !== false;
    const gids = showAll ? null : active;
    if (showAll || gids.size) {
      if (this._groupRev !== this.store.rev || !this._groupBoxes) {
        this._groupRev = this.store.rev;
        this._groupBoxes = new Map();
        for (const o of this.store.objects) {
          if (!o?.groupId) continue;
          const b = worldBounds(o);
          const cur = this._groupBoxes.get(o.groupId);
          if (!cur) {
            this._groupBoxes.set(o.groupId, { x: b.x, y: b.y, r: b.x + b.w, d: b.y + b.h, name: o.groupName || '' });
            continue;
          }
          /*
           * Every member has to agree on the name for it to be shown.
           *
           * The name is stored on the pieces, so one piece carrying a name the
           * others do not is not a group called that - it is a leftover from
           * some earlier grouping. Taking the first one found would let an old
           * name reappear on a group nobody gave it to, which is worse than
           * showing no name at all.
           */
          if ((o.groupName || '') !== cur.name) cur.name = '';
          cur.x = Math.min(cur.x, b.x); cur.y = Math.min(cur.y, b.y);
          cur.r = Math.max(cur.r, b.x + b.w); cur.d = Math.max(cur.d, b.y + b.h);
        }
      }
      for (const gid of (gids || this._groupBoxes?.keys() || [])) {
        const c = this._groupBoxes?.get(gid);
        if (!c) continue;
        const box = { x: c.x, y: c.y, w: c.r - c.x, h: c.d - c.y };
        if (!boxesIntersect(vbox, box)) continue;
        drawGroupHint(ctx, cam, box, active.has(gid), c.name);
      }
    }

    const lone = this.selection.size === 1 ? this.store.get([...this.selection][0]) : null;
    if (lone && lone.type === 'connector') {
      // an arrow on its own is handled by its ends and its middle, not by a box
      this.drawArrowChrome(ctx, lone);
    } else if (this.selection.size) {
      const locked = this.selectionIsLocked();
      if (this.selection.size > 1) for (const id of this.selection) { const o = this.store.get(id); if (o) drawMemberOutline(ctx, cam, o); }
      const box = this.selectionScreenBox();
      if (box) drawSelection(ctx, box, locked ? { handles: false, dashed: true } : { rotate: true });
    }

    this.drawFades(ctx);

    // under everything else that floats, the laser included
    this.drawGreeting(ctx);

    for (const fn of this.overlays) fn(ctx, this);

    // The laser goes on last: it is a pointing device, so it belongs above
    // everything, selection handles included.
    this.drawLaser(ctx);
  }

  /** A selected arrow: a ring at each end (filled when it holds on to something) and a diamond in the middle. */
  drawArrowChrome(ctx, o) {
    const cam = this.cam;
    const r = connectorRoute(o);
    ctx.save();
    // a faint highlight along the arrow, so it reads as selected
    ctx.strokeStyle = 'rgba(0,120,212,0.35)';
    ctx.lineWidth = (o.lineWidth || 3) * cam.z + 6;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    r.pts.forEach((p, i) => { const q = cam.toScreen(p.x, p.y); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.stroke();
    if (!o.locked) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0078d4';
      for (const [p, held] of [[r.a, r.attachedA], [r.b, r.attachedB]]) {
        const q = cam.toScreen(p.x, p.y);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = held ? '#0078d4' : '#ffffff';
        ctx.fill(); ctx.stroke();
      }
      if (r.kind !== 'elbow') {
        const m = midPoint(o), q = cam.toScreen(m.x, m.y);
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - 6); ctx.lineTo(q.x + 6, q.y); ctx.lineTo(q.x, q.y + 6); ctx.lineTo(q.x - 6, q.y); ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Let a lifted answer cover melt away rather than blink out.
   *
   * The document already says it is revealed, so the board underneath is
   * painted without it and nothing about saving, undo or export has to know
   * a fade exists. This is only the last quarter-second of its picture,
   * drawn over the top and getting fainter. A blink reads as a glitch; a
   * fade reads as "and here is the answer".
   */
  fadeOut(obj, ms = Surface.FADE_MS) {
    if (!obj) return;
    this._fades.set(obj.id, { obj: { ...obj, revealed: false, hidden: false }, t0: performance.now(), ms });
    this.dirty = true;
  }

  drawFades(ctx, now = performance.now()) {
    if (!this._fades.size) return;
    const cam = this.cam;
    ctx.save();
    ctx.setTransform(this.dpr * cam.z, 0, 0, this.dpr * cam.z, this.dpr * cam.x, this.dpr * cam.y);
    for (const [id, f] of this._fades) {
      const k = (now - f.t0) / f.ms;
      if (k >= 1) { this._fades.delete(id); continue; }
      ctx.globalAlpha = 1 - k;
      drawObject(ctx, f.obj);
    }
    ctx.restore();
  }

  /**
   * Is the board empty enough to say hello?
   *
   * Nothing on it, and no ink in flight: the greeting goes the moment a pen
   * touches down, not when the stroke is finished, because a greeting still
   * sitting under the first line somebody is drawing is in their way. If that
   * stroke comes to nothing - a palm, a tap too short to keep - the board is
   * still empty and it comes back on its own.
   */
  showsGreeting() {
    return !!this.greeting && !this.wet && !!this.store && this.store.objects.length === 0;
  }

  /**
   * "Happy Inking !!", faintly, in the middle of the window.
   *
   * Screen-sized rather than board-sized, so it reads the same at any zoom
   * and stays put while the board is panned underneath. In the Handwriting
   * face, in the board's own ink - dark on a light board, light on a dark
   * one - and far enough towards the background that nobody mistakes it for
   * something they wrote.
   *
   * Drawn in full every frame it shows, never as part of a repaint of just
   * the strip an eraser touched: text this faint painted over its own last
   * copy would darken with every move.
   */
  drawGreeting(ctx) {
    this._greetingDrawn = null;
    if (!this.showsGreeting()) return;
    const w = this.width, h = this.height;
    const size = Math.round(Math.max(28, Math.min(72, Math.min(w, h) * 0.09)));
    const font = `400 ${size}px ${faceOf('marker')}`;
    const color = inkPaint(null);
    const x = w / 2, y = h / 2;
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.greeting, x, y);
    ctx.restore();
    this._greetingDrawn = { text: this.greeting, x, y, size, font, color };
  }

  /**
   * The laser trail.
   *
   * Painted straight to the canvas from a list of timestamped points and never
   * committed, so it is not in the document, not in the undo stack, not in an
   * export, and gone a moment after the pointer stops. Points are kept in world
   * coordinates so the dot stays on the word it is pointing at when the canvas
   * is panned or zoomed underneath it.
   */
  drawLaser(ctx) {
    const pts = this.laser;
    if (!pts.length) return;
    const now = performance.now();
    const cam = this.cam;
    const rgb = hexToRgb(this.laserColor || '#ff2d2d');
    const head = pts[pts.length - 1];
    const headFade = 1 - Math.min(1, (now - head.t) / Surface.LASER_LIFE);
    if (headFade <= 0) return;

    const sp = pts.map((p) => cam.toScreen(p.x, p.y));
    const hp = sp[sp.length - 1];

    ctx.save();
    this.screenTransform(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // ONE path, stroked twice.
    //
    // The trail used to be a stroke per segment, each with its own alpha. Every
    // joint therefore got a round cap painted on top of the next segment's
    // round cap, so the alpha doubled at each one and the trail came out as a
    // string of beads with visible edges. A single path has no interior caps -
    // only joins, which composite once - so the fade has to come from a
    // gradient along the path instead of from per-segment alpha.
    if (sp.length > 1) {
      const tail = sp[0];
      const span = Math.hypot(hp.x - tail.x, hp.y - tail.y);
      let paint;
      if (span < 1) {
        paint = `rgba(${rgb},${0.9 * headFade})`;       // pointer held still
      } else {
        const g = ctx.createLinearGradient(tail.x, tail.y, hp.x, hp.y);
        g.addColorStop(0, `rgba(${rgb},0)`);
        g.addColorStop(0.30, `rgba(${rgb},${0.16 * headFade})`);
        g.addColorStop(0.70, `rgba(${rgb},${0.55 * headFade})`);
        g.addColorStop(1, `rgba(${rgb},${0.95 * headFade})`);
        paint = g;
      }

      ctx.beginPath();
      ctx.moveTo(sp[0].x, sp[0].y);
      if (sp.length === 2) {
        ctx.lineTo(sp[1].x, sp[1].y);
      } else {
        // curve through the midpoints, the way the ink renderer does, so the
        // trail is smooth rather than a chain of straight pieces
        for (let i = 1; i < sp.length - 1; i++) {
          const m = { x: (sp[i].x + sp[i + 1].x) / 2, y: (sp[i].y + sp[i + 1].y) / 2 };
          ctx.quadraticCurveTo(sp[i].x, sp[i].y, m.x, m.y);
        }
        ctx.lineTo(hp.x, hp.y);
      }

      // soft halo first, then the core on top of it
      ctx.strokeStyle = paint;
      ctx.globalAlpha = 0.30;
      ctx.lineWidth = 11;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }

    // the bright head, so a pointer that is not moving is still visible
    const glow = ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, 13);
    glow.addColorStop(0, `rgba(${rgb},${0.95 * headFade})`);
    glow.addColorStop(0.35, `rgba(${rgb},${0.45 * headFade})`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(hp.x, hp.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.75 * headFade})`;
    ctx.beginPath(); ctx.arc(hp.x, hp.y, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /**
   * Keep the pad reachable.
   *
   * On an infinite board the camera is free, because there is nothing to lose
   * sight of. On a pad, panning far enough leaves nothing on screen but empty
   * desk with no clue which way the paper went - so the strip is held to at
   * least a strip of KEEP pixels inside the window. It never fights ordinary
   * panning; it only refuses to let the last of the paper leave.
   */
  clampCamera() {
    const pages = this.store.doc.pages;
    if (!pages.length || !this.width || !this.height) return;
    const b = stripBounds(pages);
    if (!b) return;
    const { cam } = this;
    const sw = b.w * cam.z, sh = b.h * cam.z;

    /*
     * Sideways, paper is not like a canvas.
     *
     * A pad has a fixed width and an unlimited height: page two sits below page
     * one, so scrolling DOWN is how you read it and a little overshoot at the
     * ends is welcome. Scrolling SIDEWAYS reaches nothing - there is no more
     * paper out there, only desk - and every pixel spent on it is a pixel of
     * the page pushed off the other edge. People kept sliding A4 half out of
     * the window by accident and had to drag it back.
     *
     * So the two directions get different rules. Left and right: the page is
     * pinned to the middle when it fits, and when it does not - because the
     * zoom is past what the window holds - it may move only as far as its own
     * edges, never showing desk beside it. Up and down is left exactly as it
     * was, because that is the direction a pad is meant to travel in.
     */
    if (sw <= this.width) cam.x = (this.width - sw) / 2 - b.x * cam.z;
    else cam.x = Math.max(this.width - sw - b.x * cam.z, Math.min(cam.x, -b.x * cam.z));

    const keepY = Math.min(160, sh);
    const loY = keepY - b.y * cam.z - sh, hiY = this.height - keepY - b.y * cam.z;
    if (loY <= hiY) cam.y = Math.max(loY, Math.min(cam.y, hiY));
  }

  /** Render the board (or a region) to an offscreen canvas - used by export. */
  /**
   * Render to an offscreen canvas - this is what an export is made of.
   *
   * Always on white paper with black ink, whatever the screen is set to. A
   * board is shared, printed and opened on other people's machines; it must not
   * carry one person's choice of a dark screen into everybody else's copy. The
   * dark mapping is switched off around this and put back afterwards rather
   * than assumed to be off, because an export can happen at any moment.
   */
  renderTo(box, scale = 2, background = true, ruling = background) {
    const wasDark = isDarkBoard();
    setDarkBoard(false);
    try { return this._renderTo(box, scale, background, ruling); }
    finally { setDarkBoard(wasDark); }
  }

  _renderTo(box, scale = 2, background = true, ruling = background) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(box.w * scale));
    c.height = Math.max(1, Math.round(box.h * scale));
    const ctx = c.getContext('2d');
    if (background) {
      ctx.fillStyle = this.store.doc.background.color || '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      // the ruling is part of the paper, so it prints - a grid you wrote on
      // should still be there on the printout
      if (ruling) drawRuling(ctx, this.store.doc.background, { x: -box.x * scale, y: -box.y * scale, z: scale }, c.width, c.height, this.store.doc.pages);
    }
    ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
    const pages = this.store.doc.pages;
    const rects = pageRects(pages);
    for (const o of this.store.objects) {
      if (!o) continue;
      if (!boxesIntersect(box, worldBounds(o))) continue;
      // an export has to clip exactly as the screen does, or a stroke that
      // runs off the paper would reappear in the PDF
      const i = rects.length ? pageIndexForBoxIn(rects, boundsOf(o)) : -1;
      if (i >= 0) {
        const r = rects[i];
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
        drawObject(ctx, o);
        ctx.restore();
      } else drawObject(ctx, o);
    }
    return c;
  }
}

/**
 * "#ff2d2d" -> "255,45,45", so alpha can be varied inside a gradient stop.
 * Falls back to the default laser red rather than throwing on a bad value.
 */
function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
  if (!m) return '255,45,45';
  return [1, 2, 3].map((i) => parseInt(m[i], 16)).join(',');
}
