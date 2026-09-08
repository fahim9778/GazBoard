// The canvas view: sizing, the draw loop, culling, overlays.

import { Camera } from './camera.js';
import { drawBackground, drawObject, drawSelection, drawMemberOutline, drawLockBadge, FONT } from './render.js';
import { worldBounds, boundsOf } from './store.js';
import { pageRects, pageIndexForBox, pageIndexForBoxIn, stripBounds } from './pages.js';
import { boxesIntersect } from './util.js';

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
    this._lockedRev = -1;      // revision the locked-object list was built for
    this._locked = [];
    this.selection = new Set();
    this.hoverId = null;
    this._raf = null;
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
    return `${this.store.rev}|${cam.x}|${cam.y}|${cam.z}|${this.width}|${this.height}|${this.dpr}|${ed}`;
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
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  /** CSS-pixel coordinates map 1:1 to the canvas after this. */
  screenTransform(ctx = this.ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

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
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.floor(a.x), Math.floor(a.y),
        Math.ceil(b.x - a.x) + 1, Math.ceil(b.y - a.y) + 1);
      ctx.clip();
    }
    drawBackground(ctx, this.store.doc.background, cam, w, h, pages);

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

  /** The stroke under the pen, clipped to its own sheet. */
  _drawWet(ctx) {
    const cam = this.cam, pages = this.store.doc.pages;
    ctx.setTransform(this.dpr * cam.z, 0, 0, this.dpr * cam.z, this.dpr * cam.x, this.dpr * cam.y);
    const onload = () => this.invalidate();
    const wi = pages.length ? pageIndexForBox(pages, boundsOf(this.wet)) : -1;
    if (wi >= 0) {
      const r = pageRects(pages)[wi];
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      drawObject(ctx, this.wet, onload);
      ctx.restore();
    } else drawObject(ctx, this.wet, onload);
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
    } else if (this._bandOnly && this._band && this._painted) {
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
      drawLockBadge(ctx, cam, o);
    }

    if (this.selection.size) {
      const locked = this.selectionIsLocked();
      if (this.selection.size > 1) for (const id of this.selection) { const o = this.store.get(id); if (o) drawMemberOutline(ctx, cam, o); }
      const box = this.selectionScreenBox();
      if (box) drawSelection(ctx, box, locked ? { handles: false, dashed: true } : { rotate: true });
    }

    for (const fn of this.overlays) fn(ctx, this);

    // The laser goes on last: it is a pointing device, so it belongs above
    // everything, selection handles included.
    this.drawLaser(ctx);
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
    const keepX = Math.min(160, sw), keepY = Math.min(160, sh);
    const loX = keepX - b.x * cam.z - sw, hiX = this.width - keepX - b.x * cam.z;
    const loY = keepY - b.y * cam.z - sh, hiY = this.height - keepY - b.y * cam.z;
    if (loX <= hiX) cam.x = Math.max(loX, Math.min(cam.x, hiX));
    if (loY <= hiY) cam.y = Math.max(loY, Math.min(cam.y, hiY));
  }

  /** Render the board (or a region) to an offscreen canvas - used by export. */
  renderTo(box, scale = 2, background = true) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(box.w * scale));
    c.height = Math.max(1, Math.round(box.h * scale));
    const ctx = c.getContext('2d');
    if (background) {
      ctx.fillStyle = this.store.doc.background.color || '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
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
