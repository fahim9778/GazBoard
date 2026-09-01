// Pointer interaction: one small state machine covering every tool.

import { uid, bboxOfPoints, clamp, dist, simplify, unionBox } from './util.js';
import { boundsOf, worldBounds, withAttached } from './store.js';
import { pick, inBox, inLasso, strokesAlong, normalizeBox } from './hit.js';
import { handlePositions, HANDLE, HANDLES, drawShape } from './render.js';
import { translateObject, scaleObject, rotateObjectAround, normalizeRect, anchorFor, CURSORS } from './transform.js';
import { recognize, fitError, MAX_FIT_ERROR } from './recognize.js';
import { splitStroke } from './erase.js';
import { inkCursor } from './cursors.js';
import { pageRects, pageIndexAt, pageIndexForBox, nearestPageIndex, offsetIntoRect, inRect } from './pages.js';

const TAP_SLOP = 4;
const HANDLE_GRAB = 12;   // forgiving grab radius around a handle's 9px dot

/** Gestures that should keep going while the canvas scrolls beneath them. */
const EDGE_PANNABLE = new Set(['draw', 'erase', 'lasso', 'marquee', 'move', 'resize', 'rotate', 'shapeDraw', 'textDraw']);
// 'laser' is deliberately absent: pointing near the edge of the window should
// not drag the board out from under what you are pointing at.

export class Interaction {
  constructor(app) {
    this.app = app;
    this.surface = app.surface;
    this.store = app.store;
    this.canvas = app.surface.canvas;

    this.pointers = new Map();
    this.action = null;
    this.spaceDown = false;
    this.pinch = null;
    this.secondaryPan = null;   // mouse dragging the canvas while the pen draws
    this.lastMotion = null;     // last pointer position of the primary gesture
    this.actionId = null;       // the pointer that owns the gesture in flight
    this._penAt = 0;            // when the stylus was last heard from
    this._wheelFrom = null;     // 'mouse' or 'trackpad', for the stream in flight
    this._wheelAt = 0;
    this._penSp = null;         // and where it was, in screen coordinates
    this._edgeRaf = null;
    this.rightPan = null;       // an in-flight right-button drag
    this._eatNextMenu = false;  // a right-drag must not end in a context menu

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', (e) => { if (!this.action) { this.surface.hoverId = null; this.surface.invalidate(); } });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A right-DRAG panned the canvas, so it is not a right-CLICK: swallow the
      // menu this once. A plain right-click never sets this and is unaffected.
      if (this._eatNextMenu) { this._eatNextMenu = false; return; }
      // Some platforms raise contextmenu on press rather than release. There
      // the menu wins and the drag is abandoned, which is exactly what happened
      // before this existed - the feature is simply not gained there, and
      // nothing that used to work is lost.
      this.rightPan = null;
      this.app.showContextMenu(e);
    });

    this.surface.overlays.push((ctx, s) => this.drawOverlay(ctx, s));
  }

  get tool() { return this.app.tool; }
  get ruler() { return this.app.ruler; }

  /* ------------------------------------------------------------ */
  effectiveTool(e) {
    if (this.spaceDown || e.button === 1) return 'pan';
    if (e.pointerType === 'pen' && (e.buttons & 32 || e.button === 5)) return 'eraser';  // pen tail
    if (e.button === 2) return 'select';
    // Whiteboard's rule: once a stylus is in play the mouse stops being a pen
    // and becomes a POINTER - it selects and drags objects, and pans the empty
    // canvas. It is not a plain pan tool: dragging a picture has to move the
    // picture, not the whole board.
    if (e.pointerType === 'mouse' && !this.app.mouseInks && (this.tool === 'pen' || this.tool === 'highlighter'))
      return 'mousePointer';
    return this.tool;
  }

  pressure(e) {
    if (!this.app.settings.pressure) return 0.5;
    if (e.pointerType === 'pen' && e.pressure > 0) return clamp(e.pressure, 0.05, 1);
    if (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5) return clamp(e.pressure, 0.1, 1);
    return 0.5;
  }

  /* ------------------------------------------------------------ */
  onDown(e) {
    if (e.button === 2) {
      this.app.hideMenus();
      // Right-drag pans, for anyone without a pen, a middle button or a
      // trackpad. It starts nothing that touches the document, and a right
      // click that does not move still opens the context menu as always.
      // Only ever from an idle canvas. Windows reports a pen's barrel button as
      // a button-2 pointerdown on the SAME pointerId that is already writing,
      // so squeezing it mid-word used to hand the pen to the panner: the rest
      // of that stroke was swallowed, and because the matching pointerup took
      // the right-drag path below, the pointer was never released either - so
      // the NEXT stroke counted as a second finger and never started at all.
      if (this.app.settings.rightDragPans !== false && !this.action && !this.pointers.has(e.pointerId)) {
        const sp0 = this.surface.screenPoint(e);
        this.rightPan = { id: e.pointerId, sp: sp0, cam: { x: this.surface.cam.x, y: this.surface.cam.y }, moved: false };
        try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
      }
      return;
    }
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    if (e.pointerType === 'pen') this._penAt = performance.now();
    this.app.hideMenus();
    // A pointerup that never arrives - a pen lifted as the window loses focus,
    // a cancel routed elsewhere - used to leave its id in the map for good.
    // The next pen down then looked like a second finger and was treated as a
    // pinch instead of a stroke, and the one after that was ignored outright.
    // With no gesture in flight nothing can be relying on these entries, so
    // they are stale by definition and safe to forget.
    if (this.pointers.size && !this.action && !this.pinch && !this.secondaryPan) this.pointers.clear();
    const sp = this.surface.screenPoint(e);
    const wp = this.surface.cam.toWorld(sp.x, sp.y);
    if (e.pointerType === 'pen') this.app.notePenSeen();
    this.pointers.set(e.pointerId, { sp, wp, type: e.pointerType });

    if (this.pointers.size === 2) {
      // Two fingers pinch. A mouse (or a second pen) arriving while a stroke
      // is already down means "pan the canvas under what I'm drawing" instead.
      const types = [...this.pointers.values()].map((p) => p.type);
      // A hand resting on the glass while the pen writes is a palm, not a
      // second finger. It used to satisfy "not every pointer is touch", so it
      // started a canvas pan under the nib: the cursor turned into a hand for
      // a moment and the writing slid away underneath. Drop it and carry on
      // inking. The mouse-pans-under-the-pen gesture below is unaffected -
      // that one is a mouse, deliberately put down by the other hand.
      if (this.action && e.pointerType === 'touch' && types.includes('pen')) {
        this.pointers.delete(e.pointerId);
        try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
        return;
      }
      if (this.action && !types.every((t) => t === 'touch')) this.startSecondaryPan(e, sp);
      else this.startPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    // commit first: committing hands the board back to the pen, and the tool
    // must be resolved after that or the first stylus touch after typing runs
    // the old tool
    this.app.commitTextEdit();
    const tool = this.effectiveTool(e);

    // ruler interaction takes priority when it is showing
    if (this.ruler.visible) {
      const zone = this.rulerZone(sp);
      if (zone === 'rotate') { this.action = { type: 'rulerRotate', start: wp, a0: this.ruler.angle }; return; }
      if (zone === 'body' && (tool === 'select' || tool === 'pan')) {
        this.action = { type: 'rulerMove', start: wp, x0: this.ruler.x, y0: this.ruler.y };
        return;
      }
    }

    // a visible handle is always draggable, whatever tool is active
    if (!this.spaceDown && e.button !== 1 && tool !== 'select' && this.startHandleGesture(sp, wp)) {
      this.surface.invalidate();
      return;
    }

    switch (tool) {
      case 'pan':
        if (!this.spaceDown && e.button !== 1 && this.surface.selection.size) this.app.setSelection([]);
        this.action = { type: 'pan', sp, cam: { x: this.surface.cam.x, y: this.surface.cam.y } };
        break;
      case 'mousePointer': {
        // On an object the mouse drags it; on bare canvas it pans. It does NOT
        // leave a selection behind: handles and the selection bar belong to
        // Select and Lasso, and having them appear around your handwriting
        // while the pen tool is active is just clutter you then have to clear.
        const hit = pick(this.store, wp, 8 / this.surface.cam.z);
        if (hit && !hit.locked) {
          const objs = withAttached(this.store, [hit.id])
            .map((id) => this.store.get(id)).filter(Boolean).filter((o) => !o.locked);
          this.action = {
            type: 'move', start: wp, objs, transient: true,
            snap: this.store.snapshot(objs.map((o) => o.id)),
            origin: new Map(objs.map((o) => [o.id, { ...boundsOf(o) }]))
          };
        } else {
          // empty canvas: let go of whatever was selected, then pan
          if (this.surface.selection.size) this.app.setSelection([]);
          this.action = { type: 'pan', sp, cam: { x: this.surface.cam.x, y: this.surface.cam.y } };
        }
        break;
      }
      case 'laser':
        this.surface.laser = [{ x: wp.x, y: wp.y, t: performance.now() }];
        this.action = { type: 'laser' };
        break;
      case 'pen': case 'highlighter': this.startStroke(e, wp, tool); break;
      case 'eraser': this.startErase(wp); break;
      case 'lasso':
        // after a lasso select, dragging inside the selection moves it
        if (this.startMoveOnSelection(wp)) break;
        this.action = { type: 'lasso', pts: [wp] };
        break;
      case 'shape': this.action = { type: 'shapeDraw', start: wp, cur: wp, shift: e.shiftKey }; break;
      case 'text': case 'note': {
        // clicking something that is already there should get hold of it,
        // not drop a new note or text box on top of it
        const hit = pick(this.store, wp, 8 / this.surface.cam.z);
        if (hit) {
          this.app.setSelection([hit.id]);
          if (hit.locked) { this.app.hintLocked(); break; }
          if (['note', 'text', 'shape', 'table'].includes(hit.type)) {
            this.app.armToolRestore();
            this.app.setTool('select');
            this.app.beginTextEdit(hit);
          } else {
            this.app.setTool('select');
            this.startSelect(e, sp, wp);
          }
          break;
        }
        if (tool === 'note') this.dropNote(wp);
        else this.action = { type: 'textDraw', start: wp, cur: wp };
        break;
      }
      case 'select': default: this.startSelect(e, sp, wp); break;
    }
    // Whichever pointer began the gesture owns it until it lifts.
    this.actionId = this.action ? e.pointerId : null;
    this.surface.invalidate();
  }

  /** Advance a right-button drag. Returns true when it consumed the event. */
  moveRightPan(e) {
    const rp = this.rightPan;
    if (!rp || e.pointerId !== rp.id) return false;
    // Something real took this pointer after the right button went down. It
    // owns the movement; the pan quietly stands down.
    if (this.action) { this.rightPan = null; return false; }
    const sp = this.surface.screenPoint(e);
    const dx = sp.x - rp.sp.x, dy = sp.y - rp.sp.y;
    if (!rp.moved && Math.hypot(dx, dy) < TAP_SLOP) return true;   // still a click
    rp.moved = true;
    this.surface.cam.x = rp.cam.x + dx;
    this.surface.cam.y = rp.cam.y + dy;
    this.surface.clampCamera();
    this.canvas.style.cursor = 'grabbing';
    this.app.syncZoom();
    this.surface.invalidate();
    return true;
  }

  onMove(e) {
    if (this.moveRightPan(e)) return;
    if (e.pointerType === 'pen' && e.buttons) this.app.notePenSeen();
    const sp = this.surface.screenPoint(e);
    if (e.pointerType === 'pen') { this._penAt = performance.now(); this._penSp = sp; }
    const wp = this.surface.cam.toWorld(sp.x, sp.y);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { sp, wp, type: e.pointerType });

    if (this.pinch && this.pointers.size >= 2) { this.updatePinch(); return; }

    if (this.secondaryPan && e.pointerId === this.secondaryPan.id) { this.updateSecondaryPan(sp); return; }

    if (!this.action) {
      /*
       * Windows puts the mouse pointer back the instant the pen leaves
       * proximity: a pointermove arrives with pointerType 'mouse', at the
       * position the nib just left, with no button held. Nobody touched the
       * mouse. Answering it repainted the cursor, so every full stop and every
       * lifted stroke ended in a hand flashing where the nib had been.
       *
       * The ghost is recognisable by WHERE it lands: on the nib's own last
       * position, moments after it. A mouse someone has actually picked up is
       * somewhere else, and keeps sending moves besides - so a hand is still
       * shown the instant the mouse is really used.
       */
      if (e.pointerType === 'mouse' && !e.buttons && this._penSp
          && performance.now() - this._penAt < 800
          && Math.hypot(sp.x - this._penSp.x, sp.y - this._penSp.y) < 4) return;
      this.updateHover(sp, wp, e.pointerType);
      return;
    }

    // Every pointer used to advance the active gesture, whoever it belonged to.
    // A palm sliding on the screen therefore dragged the pen's stroke over to
    // the palm - the ink jumped, or looked like it had simply gone missing.
    if (this.actionId != null && e.pointerId !== this.actionId) return;

    this.lastMotion = { sp, mods: { shift: e.shiftKey, alt: e.altKey }, pressure: this.pressure(e) };
    this.applyMotion(sp, this.lastMotion.mods, e);
    this.updateEdgePan();
    this.surface.invalidate();
  }

  /**
   * Advance the active gesture to a screen point. `e` is the originating
   * pointer event when there is one; auto-pan and canvas-under-the-pen panning
   * call this with `e === null`, which is why nothing here may depend on it.
   */
  applyMotion(sp, mods = {}, e = null) {
    const a = this.action;
    if (!a) return;
    const wp = this.surface.cam.toWorld(sp.x, sp.y);
    const pressure = e ? this.pressure(e) : (this.lastMotion?.pressure ?? 0.5);

    switch (a.type) {
      case 'pan': {
        this.surface.cam.x = a.cam.x + (sp.x - a.sp.x);
        this.surface.cam.y = a.cam.y + (sp.y - a.sp.y);
        this.surface.clampCamera();
        break;
      }
      case 'draw': {
        // The pen leaving the paper does not end the stroke - the points that
        // land off the sheet are simply not picked up, and drawing resumes if
        // it comes back on, exactly as ink behaves at the edge of a page.
        const keep = (q) => !a.sheet || inRect(a.sheet, q.x, q.y);
        const pt = this.snapToRuler({ ...wp, p: pressure }, a);
        let added = false;

        /*
         * Spacing is judged for each candidate point against the one before it,
         * never for the batch as a whole.
         *
         * It used to gate on the LAST position in the batch: if the pen ended
         * the frame near where the previous point was, the whole batch was
         * thrown away - and a high-rate pen delivers a batch per frame. On the
         * turns of an n, w or s the nib goes out and comes straight back, so
         * the frame ends close to where it started even though the pen
         * travelled a long way in between. The excursion was in the coalesced
         * events, and it was discarded with them: the peak of the letter
         * simply never arrived.
         */
        const offer = (cand) => {
          const prev = a.obj.points[a.obj.points.length - 1];
          if (prev && dist(prev, cand) * this.surface.cam.z <= 1.2) return;
          if (!keep(cand)) return;
          a.obj.points.push(cand);
          added = true;
        };

        // coalesced events give smoother ink on high-rate pens
        const evs = e && e.getCoalescedEvents ? e.getCoalescedEvents() : null;
        if (evs && evs.length) {
          for (const ce of evs) {
            const csp = this.surface.screenPoint(ce);
            const cwp = this.surface.cam.toWorld(csp.x, csp.y);
            offer(this.snapToRuler({ ...cwp, p: this.pressure(ce) }, a));
          }
        } else offer(pt);

        if (added) a.obj.bbox = bboxOfPoints(a.obj.points);
        break;
      }
      case 'erase': {
        this.eraseSweep(a, a.last, wp);
        a.last = wp;
        a.cursor = wp;
        break;
      }
      case 'laser': {
        // One point per frame turns a fast sweep into a chain of long straight
        // chords that visibly lag the pointer. The coalesced events carry where
        // the pointer actually went between frames, same as ink does.
        const trail = this.surface.laser;
        const now = performance.now();
        const push = (q) => {
          const last = trail[trail.length - 1];
          if (last && dist(last, q) * this.surface.cam.z <= 1.5) return;
          trail.push({ x: q.x, y: q.y, t: now });
        };
        const evs = e && e.getCoalescedEvents ? e.getCoalescedEvents() : null;
        if (evs && evs.length) {
          for (const ce of evs) {
            const csp = this.surface.screenPoint(ce);
            push(this.surface.cam.toWorld(csp.x, csp.y));
          }
        } else push(wp);
        break;
      }
      case 'marquee': a.cur = wp; break;
      case 'lasso': {
        const last = a.pts[a.pts.length - 1];
        if (dist(last, wp) * this.surface.cam.z > 3) a.pts.push(wp);
        break;
      }
      case 'move': {
        let dx = wp.x - a.start.x, dy = wp.y - a.start.y;
        if (mods.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        for (const o of a.objs) {
          const b = a.origin.get(o.id);
          translateObject(o, b.x + dx - boundsOf(o).x, b.y + dy - boundsOf(o).y);
        }
        this.clampGroupToPaper(a.objs);
        break;
      }
      case 'resize': {
        const box = a.box;
        const anchor = a.anchor;
        let sx = 1, sy = 1;
        const h = a.handle;
        if (h.includes('e')) sx = (wp.x - anchor.x) / (box.x + box.w - anchor.x || 1);
        if (h.includes('w')) sx = (wp.x - anchor.x) / (box.x - anchor.x || 1);
        if (h.includes('s')) sy = (wp.y - anchor.y) / (box.y + box.h - anchor.y || 1);
        if (h.includes('n')) sy = (wp.y - anchor.y) / (box.y - anchor.y || 1);
        if (h === 'n' || h === 's') sx = 1;
        if (h === 'e' || h === 'w') sy = 1;
        const uniform = mods.shift || a.objs.some((o) => o.type === 'image') || (h.length === 2 && !mods.alt);
        if (uniform && h.length === 2) { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * s; sy = Math.sign(sy || 1) * s; }
        sx = clamp(sx, -20, 20); sy = clamp(sy, -20, 20);
        if (Math.abs(sx) < 0.02) sx = 0.02 * Math.sign(sx || 1);
        if (Math.abs(sy) < 0.02) sy = 0.02 * Math.sign(sy || 1);
        for (const o of a.objs) {
          Object.assign(o, structuredClone(a.origin.get(o.id)));
          scaleObject(o, sx, sy, anchor.x, anchor.y);
        }
        this.clampGroupToPaper(a.objs);
        break;
      }
      case 'rotate': {
        const c = a.center;
        let ang = Math.atan2(wp.y - c.y, wp.x - c.x) - a.a0;
        if (mods.shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
        for (const o of a.objs) {
          Object.assign(o, structuredClone(a.origin.get(o.id)));
          rotateObjectAround(o, ang, c.x, c.y);
        }
        this.clampGroupToPaper(a.objs);
        a.angle = ang;
        break;
      }
      case 'shapeDraw': a.cur = wp; a.shift = !!mods.shift; break;
      case 'textDraw': a.cur = wp; break;
      case 'rulerMove': {
        this.ruler.x = a.x0 + (wp.x - a.start.x);
        this.ruler.y = a.y0 + (wp.y - a.start.y);
        break;
      }
      case 'rulerRotate': {
        const ang = Math.atan2(wp.y - this.ruler.y, wp.x - this.ruler.x);
        this.ruler.angle = mods.shift ? Math.round(ang / (Math.PI / 36)) * (Math.PI / 36) : ang;
        break;
      }
    }
  }

  onUp(e) {
    if (e.pointerType === 'pen') { this._penAt = performance.now(); this._penSp = this.surface.screenPoint(e); }
    if (this.rightPan && e.pointerId === this.rightPan.id) {
      const moved = this.rightPan.moved;
      this.rightPan = null;
      // only a drag swallows the menu; a plain right-click still opens it
      if (moved) this._eatNextMenu = true;
      // Only bow out early if this pointer is doing nothing else. If it is also
      // mid-gesture, fall through so the gesture is finished and the pointer is
      // forgotten, rather than both being left hanging.
      if (!this.pointers.has(e.pointerId)) {
        this.updateHover(this.surface.screenPoint(e), this.surface.cam.toWorld(0, 0), e.pointerType);
        return;
      }
    }
    this.pointers.delete(e.pointerId);
    if (this.secondaryPan && e.pointerId === this.secondaryPan.id) { this.secondaryPan = null; return; }
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const a = this.action;
    if (!a) return;
    this.stopEdgePan();
    this.lastMotion = null;
    const sp = this.surface.screenPoint(e);
    const wp = this.surface.cam.toWorld(sp.x, sp.y);

    switch (a.type) {
      case 'laser': break;            // the trail fades on its own
      case 'draw': this.finishStroke(a); break;
      case 'erase': this.finishErase(a); break;
      case 'marquee': {
        const box = normalizeBox({ x: a.start.x, y: a.start.y, w: a.cur.x - a.start.x, h: a.cur.y - a.start.y });
        const found = (Math.abs(box.w) < 3 && Math.abs(box.h) < 3) ? [] : inBox(this.store, box, false);
        this.app.setSelection(found.map((o) => o.id), a.additive);
        break;
      }
      case 'lasso': {
        const found = inLasso(this.store, a.pts);
        this.app.setSelection(found.map((o) => o.id), e.shiftKey);
        break;
      }
      case 'move': {
        const moved = Math.hypot(wp.x - a.start.x, wp.y - a.start.y) * this.surface.cam.z;
        if (!a.transient && moved < TAP_SLOP && a.tapId) this.app.setSelection([a.tapId], false);
        this.store.commitSnapshot('move', a.snap);
        break;
      }
      case 'resize': this.store.commitSnapshot('resize', a.snap); break;
      case 'rotate': this.store.commitSnapshot('rotate', a.snap); break;
      case 'shapeDraw': this.finishShape(a); break;
      case 'textDraw': this.finishTextBox(a); break;
    }
    this.action = null;
    this.actionId = null;
    this.app.syncUI();
    // The one moment a save cannot interrupt anything: the gesture is over and
    // the next has not begun.
    this.app.onGestureEnd?.();
    this.surface.invalidate();
  }

  /* ------------------------------------------------------------ *
   *  gesture starters
   * ------------------------------------------------------------ */
  /** Which transform handle is under `sp`, if any. */
  handleAt(sp) {
    const sel = this.surface.selection;
    if (!sel.size || this.surface.selectionIsLocked()) return null;
    const box = this.surface.selectionScreenBox();
    if (!box) return null;
    const hp = handlePositions(box);
    for (const k of [...HANDLES, 'rot'])
      if (Math.hypot(hp[k].x - sp.x, hp[k].y - sp.y) <= HANDLE_GRAB) return k;
    return null;
  }

  /**
   * Start a resize or rotate from a handle.
   *
   * This runs before the active tool is consulted: if a handle is visible it is
   * draggable, whatever tool is selected. Without that, handles shown on a
   * freshly created or freshly imported object look live but do nothing until
   * you also switch to Select.
   */
  startHandleGesture(sp, wp) {
    const k = this.handleAt(sp);
    if (!k) return false;
    const sel = this.surface.selection;
    const ids = withAttached(this.store, [...sel]);
    const objs = ids.map((id) => this.store.get(id)).filter(Boolean);
    if (!objs.length) return false;
    const snap = this.store.snapshot(ids);
    const origin = new Map(objs.map((o) => [o.id, structuredClone(o)]));
    const wbox = this.surface.selectionBounds();
    if (k === 'rot') {
      const c = { x: wbox.x + wbox.w / 2, y: wbox.y + wbox.h / 2 };
      this.action = { type: 'rotate', objs, snap, origin, center: c, a0: Math.atan2(wp.y - c.y, wp.x - c.x) };
    } else {
      this.action = { type: 'resize', objs, snap, origin, handle: k, box: wbox, anchor: anchorFor(k, wbox) };
    }
    return true;
  }

  /**
   * Begin dragging the existing selection if `wp` is inside it.
   * Used by the lasso tool so a selection can be moved without switching tools.
   */
  startMoveOnSelection(wp) {
    const sel = this.surface.selection;
    if (!sel.size || this.surface.selectionIsLocked()) return false;
    const b = this.surface.selectionBounds();
    const hit = pick(this.store, wp, 8 / this.surface.cam.z);
    const inside = b && wp.x >= b.x && wp.x <= b.x + b.w && wp.y >= b.y && wp.y <= b.y + b.h;
    if (!inside && !(hit && sel.has(hit.id))) return false;
    const objs = withAttached(this.store, [...sel])
      .map((id) => this.store.get(id)).filter(Boolean).filter((o) => !o.locked);
    if (!objs.length) return false;
    this.action = {
      type: 'move', start: wp, objs,
      snap: this.store.snapshot(objs.map((o) => o.id)),
      origin: new Map(objs.map((o) => [o.id, { ...boundsOf(o) }]))
    };
    return true;
  }

  startSelect(e, sp, wp) {
    if (this.startHandleGesture(sp, wp)) return;

    const sel = this.surface.selection;
    const hit = pick(this.store, wp, 8 / this.surface.cam.z);
    if (hit && hit.locked) {
      // selectable so it can be unlocked, but it does not move
      this.app.setSelection([hit.id]);
      this.app.hintLocked();
      return;
    }
    if (hit) {
      let ids;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        ids = new Set(sel);
        ids.has(hit.id) ? ids.delete(hit.id) : ids.add(hit.id);
        this.app.setSelection([...ids], false);
      } else if (!sel.has(hit.id)) {
        this.app.setSelection([hit.id], false);
      }
      const objs = withAttached(this.store, [...this.surface.selection])
        .map((id) => this.store.get(id)).filter(Boolean).filter((o) => !o.locked);
      if (!objs.length) return;
      this.action = {
        type: 'move', start: wp, objs,
        snap: this.store.snapshot(objs.map((o) => o.id)),
        origin: new Map(objs.map((o) => [o.id, { ...boundsOf(o) }])),
        tapId: hit.id
      };
      return;
    }

    if (!e.shiftKey) this.app.setSelection([], false);
    this.action = { type: 'marquee', start: wp, cur: wp, additive: e.shiftKey };
  }

  /* ------------------------------------------------------------ *
   *  Paper
   *
   *  On a pad the sheet is a real boundary, not a hint: ink stops at the
   *  edge and objects cannot be dragged off it. Input is clamped here AND
   *  the renderer clips to the sheet - the two together mean a stroke that
   *  runs off the paper is neither stored outside it nor painted outside
   *  it, however the gesture arrives.
   * ------------------------------------------------------------ */
  get pages() { return this.store.doc.pages; }

  /** The sheet under a world point. Null on an infinite board or in a gutter. */
  sheetAt(wp) {
    const pages = this.pages;
    if (!pages.length) return null;
    const i = pageIndexAt(pages, wp.x, wp.y);
    return i < 0 ? null : pageRects(pages)[i];
  }

  /** False only when the board has sheets and this point misses all of them. */
  onPaper(wp) { return !this.pages.length || pageIndexAt(this.pages, wp.x, wp.y) >= 0; }

  /** Nudge one new object onto the sheet it was dropped nearest. */
  placeOnPaper(obj) { this.clampGroupToPaper([obj]); return obj; }

  /**
   * Slide a group back onto its sheet, keeping the objects' relative
   * positions - clamping each one separately would shear a multi-selection
   * apart the moment it touched an edge.
   */
  clampGroupToPaper(objs) {
    const pages = this.pages;
    if (!pages.length || !objs || !objs.length) return;
    const rects = pageRects(pages);
    let b = null;
    for (const o of objs) b = unionBox(b, boundsOf(o));
    if (!b) return;
    let i = pageIndexForBox(pages, b);
    if (i < 0) i = nearestPageIndex(pages, b.x + b.w / 2, b.y + b.h / 2);
    const { dx, dy } = offsetIntoRect(b, rects[i]);
    if (dx || dy) for (const o of objs) translateObject(o, dx, dy);
  }

  startStroke(e, wp, tool) {
    const s = this.app.settings;
    const isHl = tool === 'highlighter';
    const obj = {
      id: uid('s'), type: 'stroke', tool: isHl ? 'highlighter' : 'pen',
      color: isHl ? s.highlighterColor : s.penColor,
      width: isHl ? s.highlighterWidth : s.penWidth,
      effect: isHl ? 'none' : s.penEffect,
      hue: Math.random() * 360,
      opacity: isHl ? 0.38 : 1,
      points: [], bbox: { x: wp.x, y: wp.y, w: 0, h: 0 }, rotation: 0
    };
    // starting in the gutter is drawing on the desk: nothing happens
    const sheet = this.sheetAt(wp);
    if (this.pages.length && !sheet) return;
    const first = this.snapToRuler({ ...wp, p: this.pressure(e) }, null);
    obj.points.push(first);
    this.surface.wet = obj;
    this.action = { type: 'draw', obj, snapAxis: null, sheet };
  }

  finishStroke(a) {
    const obj = a.obj;
    this.surface.wet = null;
    if (obj.points.length < 2) {
      const p = obj.points[0];
      obj.points = [p, { x: p.x + 0.6, y: p.y + 0.6, p: p.p }];
    }
    // The ink is kept exactly as drawn.
    //
    // This used to run Douglas-Peucker over the points first, which threw away
    // three quarters of them. The renderer curves through the MIDPOINTS of the
    // points it is given, so a thinned set comes out visibly rounder than a
    // dense one: the stroke you were watching was redrawn, smoother, the
    // instant you lifted the pen. Handwriting has to stay where you put it.
    //
    // Nothing is lost by keeping them: points are only captured when the pen
    // has moved at least ~1.2px on screen, so the density is already bounded.
    obj.points = obj.points.map((p) => ({
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), p: +(p.p ?? 0.5).toFixed(2)
    }));
    obj.bbox = bboxOfPoints(obj.points);

    obj.attachedTo = this.lockedHostFor(obj) || undefined;

    // The ink is always committed first, even when it is about to be replaced.
    // Straightening is then a SECOND transaction, so one undo gives you your
    // handwriting back instead of destroying it - which is what happened when
    // the shape was the only thing ever added to the document.
    this.store.add(obj, 'draw');

    if (this.app.settings.inkToShape && obj.tool === 'pen') {
      const r = recognize(obj.points);
      // classified AND actually shaped like the thing it was classified as
      const fit = r ? fitError(obj.points, r.kind, r) : 1;
      if (r && r.confidence > 0.6 && fit < MAX_FIT_ERROR) {
        const shape = {
          id: uid('sh'), type: 'shape', kind: r.kind === 'circle' ? 'ellipse' : r.kind,
          x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0,
          stroke: obj.color, fill: 'none', lineWidth: Math.max(2, obj.width * 0.9),
          attachedTo: obj.attachedTo
        };
        this.store.commit('ink to shape', [
          { t: 'del', id: obj.id, obj: structuredClone(obj), index: this.store.indexOf(obj.id) },
          { t: 'add', obj: shape }
        ]);
        this.app.setSelection([shape.id]);
        this.app.toast(`Straightened into a ${r.kind} — undo (Ctrl+Z) keeps your ink`, 'shape', 3600);
      }
    }
  }

  /**
   * The locked object a newly drawn item sits on, if any.
   * Topmost wins, and the item has to sit mostly inside it.
   */
  lockedHostFor(obj) {
    const b = worldBounds(obj);
    const area = Math.max(1, b.w * b.h);
    const order = this.store.doc.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const host = this.store.doc.objects[order[i]];
      if (!host || !host.locked || host.id === obj.id) continue;
      const hb = worldBounds(host);
      const ox = Math.max(0, Math.min(b.x + b.w, hb.x + hb.w) - Math.max(b.x, hb.x));
      const oy = Math.max(0, Math.min(b.y + b.h, hb.y + hb.h) - Math.max(b.y, hb.y));
      // a thin stroke has almost no area, so fall back to its centre
      const centreIn = b.x + b.w / 2 >= hb.x && b.x + b.w / 2 <= hb.x + hb.w &&
                       b.y + b.h / 2 >= hb.y && b.y + b.h / 2 <= hb.y + hb.h;
      if ((ox * oy) / area > 0.6 || (centreIn && ox > 0 && oy > 0)) return host.id;
    }
    return null;
  }

  /* ---------------- erasing ----------------
   * 'partial'  splits ink where the eraser crosses it (other objects go whole)
   * 'object'   removes anything the eraser touches, whole
   * 'all'      clears the board
   *
   * While the gesture runs, fragments are written straight into the document
   * so the result is visible immediately. finishErase() rewinds that scratch
   * state and replays it as one undoable transaction.                        */
  startErase(wp) {
    const mode = this.app.settings.eraserMode;
    if (mode === 'all') { this.store.clear(); return; }
    this.action = {
      type: 'erase', mode: mode === 'object' || mode === 'stroke' ? 'object' : 'partial',
      last: wp, cursor: wp,
      travel: 0,              // how far this scrub has gone - the eraser grows with it
      radiusPx: this.app.settings.eraserSize / 2,
      originals: new Map(),   // id -> { obj (pristine clone), index }
      fragments: new Map()    // id -> fragment object currently in the doc
    };
    this.eraseSweep(this.action, wp, wp);
  }

  eraseSweep(a, from, to) {
    const store = this.store;
    // Scrubbing over a lot of ink widens the eraser, so clearing an area does
    // not mean forty little passes. It resets when the stroke is lifted.
    a.travel = (a.travel || 0) + Math.hypot(to.x - from.x, to.y - from.y);
    const grow = 1 + Math.min(Interaction.ERASER_MAX_GROWTH, a.travel / Interaction.ERASER_GROWTH_SPAN);
    const r = (this.app.settings.eraserSize / 2 / this.surface.cam.z) * grow;
    a.radiusPx = r * this.surface.cam.z;
    const hits = strokesAlong(store, from, to, r);
    let changed = false;

    for (const o of hits) {
      // The eraser touches ink and NOTHING else, in either mode.
      //
      // You must be able to annotate a picture or an imported page and rub the
      // annotation off without destroying what is underneath - and a teacher
      // scrubbing out a wrong answer over a slide must not lose the slide. The
      // guard used to apply only in part-erase mode, so whole-stroke mode
      // deleted images, notes, shapes and imported pages on contact.
      //
      // Removing a picture is what Select and Delete are for: deliberate,
      // visible, and aimed at one thing.
      if (o.type !== 'stroke') continue;
      const partial = a.mode === 'partial';
      const isFragment = a.fragments.has(o.id);

      if (partial) {
        const parts = splitStroke(o, from, to, r, Math.max(0.35, 0.7 / this.surface.cam.z));
        if (parts === null) continue;                       // eraser missed the ink itself
        const index = store.rawRemove(o.id);
        if (isFragment) a.fragments.delete(o.id);
        else if (!a.originals.has(o.id)) a.originals.set(o.id, { obj: structuredClone(o), index });
        let k = 0;
        for (const part of parts) { store.rawInsert(part, index + k++); a.fragments.set(part.id, part); }
        changed = true;
      } else {
        const index = store.rawRemove(o.id);
        if (isFragment) a.fragments.delete(o.id);
        else if (!a.originals.has(o.id)) a.originals.set(o.id, { obj: structuredClone(o), index });
        changed = true;
      }
    }
    if (changed) this.surface.invalidate();
  }

  finishErase(a) {
    const store = this.store;
    if (!a.originals.size) return;

    const desiredOrder = store.doc.order.slice();

    // rewind the scratch edits so commit() can apply the real transaction
    for (const id of a.fragments.keys()) store.rawRemove(id);
    for (const [id, rec] of a.originals) if (!store.has(id)) store.rawInsert(rec.obj, rec.index);

    // deletions, highest index first, so undo re-inserts them in ascending order
    const dels = [...a.originals.entries()]
      .map(([id, rec]) => ({ t: 'del', id, obj: rec.obj, index: store.indexOf(id) }))
      .sort((x, y) => y.index - x.index);
    const delSet = new Set(dels.map((d) => d.id));

    const adds = [...a.fragments.values()].map((obj) => ({ t: 'add', obj }));
    const orderAfterAdds = store.doc.order.filter((id) => !delSet.has(id)).concat(adds.map((op) => op.obj.id));

    const ops = [...dels, ...adds];
    if (orderAfterAdds.join() !== desiredOrder.join())
      ops.push({ t: 'order', before: orderAfterAdds, after: desiredOrder });

    store.commit(a.mode === 'partial' ? 'erase ink' : 'erase', ops);
    for (const id of a.fragments.keys()) this.surface.selection.delete(id);
    for (const id of a.originals.keys()) this.surface.selection.delete(id);
  }

  finishShape(a) {
    const s = this.app.settings;
    const kind = s.shapeKind;
    const isLinear = kind === 'line' || kind === 'arrow' || kind === 'doubleArrow';
    let geo;
    if (isLinear) {
      let end = a.cur;
      if (a.shift) {
        const dx = end.x - a.start.x, dy = end.y - a.start.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        end = { x: a.start.x + Math.cos(ang) * len, y: a.start.y + Math.sin(ang) * len };
      }
      geo = { x: a.start.x, y: a.start.y, w: end.x - a.start.x, h: end.y - a.start.y };
      if (Math.hypot(geo.w, geo.h) < 6) return;
    } else {
      geo = normalizeRect(a.start, a.cur, a.shift);
      if (geo.w < 6 || geo.h < 6) { geo = { x: a.start.x - 60, y: a.start.y - 45, w: 120, h: 90 }; }
    }
    const obj = {
      id: uid('sh'), type: 'shape', kind, ...geo, rotation: 0,
      stroke: s.shapeStroke, fill: s.shapeFill, lineWidth: s.shapeLineWidth, dash: s.shapeDash, text: ''
    };
    this.store.add(this.placeOnPaper(obj), 'shape');
    if (this.app.settings.returnToSelect) this.app.setTool('select');
    this.app.setSelection([obj.id]);
  }

  dropNote(wp) {
    const s = this.app.settings;
    const size = this.app.worldSize(s.noteSize || 200);
    const obj = {
      id: uid('n'), type: 'note', x: wp.x - size / 2, y: wp.y - size / 2, w: size, h: size,
      color: s.noteColor, text: '', rotation: 0, align: 'center', font: s.noteFont || 'ui'
    };
    this.placeOnPaper(obj);
    obj.attachedTo = this.lockedHostFor(obj) || undefined;
    this.store.add(obj, 'note');
    // switch tools BEFORE opening the editor: setTool commits any open edit,
    // and committing an empty brand-new box deletes it again
    this.app.armToolRestore();
    if (this.app.settings.returnToSelect) this.app.setTool('select');
    this.app.setSelection([obj.id]);
    this.app.beginTextEdit(obj);
  }

  finishTextBox(a) {
    const w = Math.abs(a.cur.x - a.start.x), h = Math.abs(a.cur.y - a.start.y);
    const s = this.app.settings;
    const fontSize = this.app.worldSize(s.textSize);
    const box = w > 20 && h > 12
      ? normalizeRect(a.start, a.cur)
      : { x: a.start.x, y: a.start.y - fontSize * 0.7, w: this.app.worldSize(360), h: fontSize * 1.6 };
    const obj = {
      id: uid('t'), type: 'text', ...box, text: '', rotation: 0,
      color: s.textColor, fontSize, align: 'left', valign: 'top',
      font: s.textFont || 'ui', background: 'none'
    };
    this.placeOnPaper(obj);
    obj.attachedTo = this.lockedHostFor(obj) || undefined;
    this.store.add(obj, 'text');
    this.app.armToolRestore();
    if (this.app.settings.returnToSelect) this.app.setTool('select');
    this.app.setSelection([obj.id]);
    this.app.beginTextEdit(obj);
  }

  /* ------------------------------------------------------------ *
   *  hover, wheel, pinch
   * ------------------------------------------------------------ */
  /**
   * @param {string} deviceType pointerType of the event that triggered this.
   *   It matters: "the mouse points instead of inking" is a rule about the
   *   MOUSE, so a hovering stylus must not be dragged through it - otherwise
   *   every stroke the nib passes over lights up while you are writing.
   */
  /** Re-tint the cursor after a colour change, without waiting for the pointer to move. */
  refreshInkCursor() {
    const t = this.tool;
    if ((t !== 'pen' && t !== 'highlighter') || !this.canvas) return;
    if (!this.canvas.style.cursor.startsWith('url(')) return;   // mouse is pointing, not inking
    this.canvas.style.cursor = this.inkCursor(t);
  }

  /** The pen/highlighter cursor, tinted with the colour the tool is loaded with. */
  inkCursor(tool) {
    const s = this.app.settings;
    return inkCursor(tool === 'highlighter' ? 'highlighter' : 'pen',
      tool === 'highlighter' ? s.highlighterColor : s.penColor);
  }

  updateHover(sp, wp, deviceType = 'mouse') {
    let cursor = 'default';
    const t = this.tool;
    const inkTool = t === 'pen' || t === 'highlighter';
    const mousePointer = deviceType === 'mouse' && !this.app.mouseInks && inkTool;
    if (this.spaceDown) cursor = 'grab';
    else if (mousePointer) cursor = 'grab';
    else if (inkTool) cursor = this.inkCursor(t);
    else if (t === 'eraser') cursor = 'none';
    else if (t === 'shape' || t === 'text' || t === 'lasso') cursor = 'crosshair';
    else if (t === 'note') cursor = 'copy';
    else if (t === 'pan') cursor = 'grab';

    const overHandle = this.handleAt(sp);
    if (overHandle) {
      this.surface.hoverId = null;
      this.canvas.style.cursor = CURSORS[overHandle] || 'pointer';
      return;
    }

    if (mousePointer) {
      // the cursor says what a click will do; no outline, because highlighting
      // ink as you move over it is noise on a board full of handwriting
      const hit = pick(this.store, wp, 8 / this.surface.cam.z);
      this.surface.hoverId = null;
      this.canvas.style.cursor = hit ? (hit.locked ? 'not-allowed' : 'move') : 'grab';
      return;
    }

    if (inkTool) {                      // a hovering stylus just draws a nib
      this.surface.hoverId = null;
      this.canvas.style.cursor = this.inkCursor(t);
      return;
    }

    if (t === 'laser') {                // a pointing tool wants a precise cursor
      this.surface.hoverId = null;
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    if (t === 'select' || t === 'lasso') {
      const hit = pick(this.store, wp, 8 / this.surface.cam.z);
      this.surface.hoverId = hit ? hit.id : null;
      if (t === 'select') cursor = hit ? (hit.locked ? 'not-allowed' : 'move') : 'default';
    } else this.surface.hoverId = null;

    if (this.ruler.visible && this.rulerZone(sp)) cursor = this.rulerZone(sp) === 'rotate' ? 'grab' : 'move';
    if (t === 'eraser') { this.eraserCursor = sp; this.surface.invalidate(); }
    this.canvas.style.cursor = cursor;
  }

  /**
   * Which device sent this wheel event: 'mouse' or 'trackpad'.
   *
   * This used to be guessed from how BIG the movement was - under 40 counted
   * as a trackpad, anything more as a mouse wheel. A gentle two-finger scroll
   * is small, so that appeared to work; a hard flick is not, so it sailed past
   * the threshold and zoomed the board instead of scrolling it. Flicking up
   * zoomed out, flicking down zoomed in - the opposite of what the hand did.
   *
   * How hard you flick says nothing about what you are flicking. A mouse wheel
   * turns in notches, so it arrives in whole multiples of 120 with no sideways
   * component, or in line and page units. A trackpad sends a continuous
   * stream, usually fractional and rarely perfectly vertical.
   *
   * A flick is then followed by momentum events the system invents, and those
   * can look like anything at all - so once a stream has been recognised, the
   * rest of it is treated the same way. A new gesture starts after a pause.
   */
  wheelDevice(e) {
    const now = performance.now();
    const sameGesture = this._wheelFrom && now - (this._wheelAt || 0) < 350;
    this._wheelAt = now;
    if (sameGesture) return this._wheelFrom;

    const dy = e.deltaY || 0;
    const dx = e.deltaX || 0;
    // the legacy value is the reliable one: a notch is always +/-120
    const notch = typeof e.wheelDeltaY === 'number' ? Math.abs(e.wheelDeltaY) : null;
    const notched = e.deltaMode !== 0
      || (dx === 0 && notch !== null && notch !== 0 && notch % 120 === 0 && Number.isInteger(dy));
    this._wheelFrom = notched ? 'mouse' : 'trackpad';
    return this._wheelFrom;
  }

  onWheel(e) {
    e.preventDefault();
    const sp = this.surface.screenPoint(e);

    // scrolling mid-gesture moves the canvas under the pen rather than zooming
    if (this.action && Interaction.EDGE_PANNABLE.has(this.action.type)) {
      this.surface.cam.panBy(-(e.deltaX || 0), -(e.deltaY || 0));
      this.surface.clampCamera();
      this.trackCanvasMove();
      this.surface.invalidate();
      return;
    }
    if (this.ruler.visible && this.rulerZone(sp)) {
      this.ruler.angle += (e.deltaY > 0 ? 1 : -1) * (Math.PI / 180) * (e.shiftKey ? 5 : 1);
      this.surface.invalidate();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      this.surface.cam.zoomAt(sp.x, sp.y, Math.exp(-e.deltaY * 0.0022));
    } else if (e.shiftKey) {
      this.surface.cam.panBy(-e.deltaY, 0);
    } else if (this.wheelDevice(e) === 'trackpad' && !this.app.settings.wheelZoom) {
      this.surface.cam.panBy(-e.deltaX, -e.deltaY);
    } else {
      this.surface.cam.zoomAt(sp.x, sp.y, Math.exp(-e.deltaY * 0.0018));
    }
    this.surface.clampCamera();
    this.app.syncZoom();
    this.surface.invalidate();
  }

  /* ------------------------------------------------------------ *
   *  Panning the canvas while a gesture is in flight
   *
   *  Two ways in: a mouse (or second pen) pressed while the stylus is down
   *  drags the canvas under the pen, and running the pointer into the edge of
   *  the window scrolls automatically. Both keep feeding the active gesture,
   *  so a stroke carries on unbroken across the move.
   * ------------------------------------------------------------ */
  startSecondaryPan(e, sp) {
    this.secondaryPan = { id: e.pointerId, sp, cam: { x: this.surface.cam.x, y: this.surface.cam.y } };
    this.canvas.style.cursor = 'grabbing';
  }

  updateSecondaryPan(sp) {
    const s = this.secondaryPan;
    this.surface.cam.x = s.cam.x + (sp.x - s.sp.x);
    this.surface.cam.y = s.cam.y + (sp.y - s.sp.y);
    this.surface.clampCamera();
    this.trackCanvasMove();
    this.app.syncZoom();
    this.surface.invalidate();
  }

  /** Re-apply the primary gesture after the camera moved beneath it. */
  trackCanvasMove() {
    if (this.action && this.lastMotion) this.applyMotion(this.lastMotion.sp, this.lastMotion.mods, null);
  }

  static ERASER_MAX_GROWTH = 1.8;      // up to 2.8x the chosen size
  static ERASER_GROWTH_SPAN = 900;     // world units of scrubbing to reach it

  static EDGE_MARGIN = 56;
  static EDGE_MAX_SPEED = 16;
  static EDGE_PANNABLE = EDGE_PANNABLE;

  /** Scroll velocity in px/frame for a pointer sitting near the edge. */
  edgeVelocity(sp) {
    if (!this.app.settings.edgePan) return null;
    if (!this.action || !Interaction.EDGE_PANNABLE.has(this.action.type)) return null;
    const m = Interaction.EDGE_MARGIN, max = Interaction.EDGE_MAX_SPEED;
    const w = this.surface.width, h = this.surface.height;
    let fx = 0, fy = 0;
    if (sp.x < m) fx = (m - sp.x) / m;
    else if (sp.x > w - m) fx = -(sp.x - (w - m)) / m;
    if (sp.y < m) fy = (m - sp.y) / m;
    else if (sp.y > h - m) fy = -(sp.y - (h - m)) / m;
    if (!fx && !fy) return null;
    const ease = (f) => Math.sign(f) * Math.min(1, Math.abs(f)) ** 1.7 * max;
    return { vx: ease(fx), vy: ease(fy) };
  }

  updateEdgePan() {
    if (this.lastMotion && this.edgeVelocity(this.lastMotion.sp)) this.startEdgePan();
    else this.stopEdgePan();
  }

  startEdgePan() {
    if (this._edgeRaf) return;
    const tick = () => {
      this._edgeRaf = null;
      if (!this.action || !this.lastMotion) return;
      const v = this.edgeVelocity(this.lastMotion.sp);
      if (!v) return;
      this.surface.cam.panBy(v.vx, v.vy);
      this.surface.clampCamera();
      this.trackCanvasMove();
      this.app.syncZoom();
      this.surface.invalidate();
      this._edgeRaf = requestAnimationFrame(tick);
    };
    this._edgeRaf = requestAnimationFrame(tick);
  }

  stopEdgePan() {
    if (this._edgeRaf) { cancelAnimationFrame(this._edgeRaf); this._edgeRaf = null; }
  }

  startPinch() {
    if (this.action && this.action.type === 'draw') {
      this.surface.wet = null;
      this.action = null;
    } else if (this.action) this.action = null;
    const [a, b] = [...this.pointers.values()];
    this.pinch = {
      d0: Math.hypot(a.sp.x - b.sp.x, a.sp.y - b.sp.y) || 1,
      c0: { x: (a.sp.x + b.sp.x) / 2, y: (a.sp.y + b.sp.y) / 2 },
      cam: { x: this.surface.cam.x, y: this.surface.cam.y, z: this.surface.cam.z }
    };
  }

  updatePinch() {
    const [a, b] = [...this.pointers.values()];
    const d = Math.hypot(a.sp.x - b.sp.x, a.sp.y - b.sp.y) || 1;
    const c = { x: (a.sp.x + b.sp.x) / 2, y: (a.sp.y + b.sp.y) / 2 };
    const p = this.pinch;
    const cam = this.surface.cam;
    cam.x = p.cam.x; cam.y = p.cam.y; cam.z = p.cam.z;
    cam.panBy(c.x - p.c0.x, c.y - p.c0.y);
    cam.zoomAt(c.x, c.y, d / p.d0);
    this.surface.clampCamera();
    this.app.syncZoom();
    this.surface.invalidate();
  }

  onDoubleClick(e) {
    const wp = this.surface.toWorld(e);
    const hit = pick(this.store, wp, 8 / this.surface.cam.z);
    if (!hit) {
      if (this.tool === 'select') { this.app.setTool('text'); this.action = null; }
      return;
    }
    // only the picking tools own selection chrome
    if (this.tool !== 'pen' && this.tool !== 'highlighter') this.app.setSelection([hit.id]);
    if (hit.locked) { this.app.setSelection([hit.id]); this.app.hintLocked(); return; }
    if (hit.type === 'note' || hit.type === 'text' || hit.type === 'shape') {
      this.app.setSelection([hit.id]);
      this.app.beginTextEdit(hit);
    } else if (hit.type === 'table') {
      this.app.setSelection([hit.id]);
      this.app.beginTableEdit(hit, wp);
    }
  }

  /* ------------------------------------------------------------ *
   *  ruler
   * ------------------------------------------------------------ */
  rulerRect() {
    const r = this.ruler;
    const z = this.surface.cam.z;
    const c = this.surface.cam.toScreen(r.x, r.y);
    return { c, len: r.length * z, thick: r.thickness * z, angle: r.angle };
  }

  rulerZone(sp) {
    const { c, len, thick, angle } = this.rulerRect();
    const dx = sp.x - c.x, dy = sp.y - c.y;
    const along = dx * Math.cos(angle) + dy * Math.sin(angle);
    const perp = -dx * Math.sin(angle) + dy * Math.cos(angle);
    if (Math.abs(along - len / 2) < 16 && Math.abs(perp) < thick) return 'rotate';
    if (Math.abs(along) <= len / 2 && perp >= -2 && perp <= thick) return 'body';
    return null;
  }

  /** Project a point onto the ruler edge when drawing close to it. */
  snapToRuler(pt, action) {
    const r = this.ruler;
    if (!r.visible || !r.snap) return pt;
    const z = this.surface.cam.z;
    const dx = pt.x - r.x, dy = pt.y - r.y;
    const along = dx * Math.cos(r.angle) + dy * Math.sin(r.angle);
    const perp = -dx * Math.sin(r.angle) + dy * Math.cos(r.angle);
    const band = 26 / z;
    if (Math.abs(perp) > band || Math.abs(along) > r.length / 2 + 40 / z) return pt;
    return {
      x: r.x + Math.cos(r.angle) * along,
      y: r.y + Math.sin(r.angle) * along,
      p: pt.p
    };
  }

  /* ------------------------------------------------------------ *
   *  overlay (marquee, lasso, wet shape, ruler, eraser ring)
   * ------------------------------------------------------------ */
  drawOverlay(ctx, s) {
    const cam = s.cam;
    const a = this.action;

    if (a && a.type === 'marquee') {
      const p0 = cam.toScreen(a.start.x, a.start.y), p1 = cam.toScreen(a.cur.x, a.cur.y);
      const x = Math.min(p0.x, p1.x), y = Math.min(p0.y, p1.y), w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
      ctx.save();
      ctx.fillStyle = 'rgba(0,120,212,0.10)';
      ctx.strokeStyle = '#0078d4';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.restore();
    }

    if (a && a.type === 'lasso' && a.pts.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#0078d4';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const p0 = cam.toScreen(a.pts[0].x, a.pts[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (const p of a.pts.slice(1)) { const q = cam.toScreen(p.x, p.y); ctx.lineTo(q.x, q.y); }
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,120,212,0.08)';
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Feedback while dragging with an ink tool: there is no selection chrome in
    // that mode, so without this you cannot see what you have hold of.
    if (a && a.type === 'move' && a.transient && a.objs.length) {
      let box = null;
      for (const o of a.objs) {
        const b = worldBounds(o);
        box = box ? {
          x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
          w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
          h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y)
        } : b;
      }
      if (box) {
        const p = cam.toScreen(box.x, box.y);
        ctx.save();
        ctx.strokeStyle = '#0078d4';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - 5, p.y - 5, box.w * cam.z + 10, box.h * cam.z + 10);
        ctx.restore();
      }
    }

    if (a && a.type === 'shapeDraw') {
      const st = this.app.settings;
      const ghost = { type: 'shape', kind: st.shapeKind, stroke: st.shapeStroke, fill: st.shapeFill, lineWidth: st.shapeLineWidth, dash: st.shapeDash };
      const isLinear = ['line', 'arrow', 'doubleArrow'].includes(st.shapeKind);
      let g;
      if (isLinear) g = { x: a.start.x, y: a.start.y, w: a.cur.x - a.start.x, h: a.cur.y - a.start.y };
      else g = normalizeRect(a.start, a.cur, a.shift);
      const p = cam.toScreen(g.x, g.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(cam.z, cam.z);
      ctx.translate(-g.x, -g.y);
      ctx.globalAlpha = 0.85;
      drawGhostShape(ctx, { ...ghost, ...g });
      ctx.restore();
    }

    if (a && a.type === 'textDraw') {
      const p0 = cam.toScreen(a.start.x, a.start.y), p1 = cam.toScreen(a.cur.x, a.cur.y);
      ctx.save();
      ctx.strokeStyle = '#0078d4';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
      ctx.restore();
    }

    if (this.tool === 'eraser' && this.eraserCursor && !this.pointers.size) {
      this.drawEraserRing(ctx, this.eraserCursor);
    }
    if (a && a.type === 'erase' && a.cursor) {
      this.drawEraserRing(ctx, cam.toScreen(a.cursor.x, a.cursor.y), a.radiusPx);
    }

    if (this.ruler.visible) this.drawRuler(ctx);
  }

  drawEraserRing(ctx, sp, radius) {
    const r = radius || this.app.settings.eraserSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.strokeStyle = '#605e5c';
    ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawRuler(ctx) {
    const { c, len, thick, angle } = this.rulerRect();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(angle);
    const g = ctx.createLinearGradient(0, 0, 0, thick);
    g.addColorStop(0, 'rgba(255,255,255,0.92)');
    g.addColorStop(1, 'rgba(233,231,229,0.92)');
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-len / 2, 0, len, thick, 3); else ctx.rect(-len / 2, 0, len, thick);
    ctx.fill(); ctx.stroke();

    // tick marks every 10 world px
    const z = this.surface.cam.z;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const stepWorld = 10;
    const stepPx = stepWorld * z;
    if (stepPx > 3) {
      const n = Math.floor(len / 2 / stepPx);
      for (let i = -n; i <= n; i++) {
        const x = i * stepPx;
        const major = i % 10 === 0, mid = i % 5 === 0;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, major ? 13 : mid ? 9 : 5);
        ctx.stroke();
        if (major && stepPx > 6) ctx.fillText(String(Math.abs(i * stepWorld)), x, 24);
      }
    }
    // angle readout + rotate grip
    const degv = ((angle * 180) / Math.PI + 360) % 360;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(degv.toFixed(0) + '°', 0, thick - 8);
    ctx.beginPath();
    ctx.arc(len / 2 - 14, thick / 2, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#0078d4';
    ctx.fill();
    ctx.restore();
  }
}

function drawGhostShape(ctx, o) { drawShape(ctx, o); }
