// Board replay: the board drawn again, stroke by stroke, in the order it was made.
//
// How it stays smooth on a board with tens of thousands of strokes:
//
//   - Finished strokes are painted ONCE onto a canvas of their own (the "base")
//     and never again. Each frame copies the base to the screen and draws only
//     the one stroke still being written over it. So a frame costs the same
//     with 20 strokes behind it or 20,000.
//   - Every so often the base is copied aside as a checkpoint. Dragging the
//     slider backwards goes to the nearest checkpoint and draws forward from
//     there, rather than from the start.
//   - Drawing is given a time budget per frame. When the machine cannot draw
//     what the clock asks for in that time, the replay slows down instead of
//     dropping strokes or stalling the window: it shows less per second, never
//     a frozen screen.
//
// Strokes made from this version on carry `at`, the moment the pen went down,
// so the replay keeps the rhythm they were written with (long pauses
// shortened). Boards from before that, and objects without it, replay at an
// even pace in the order they are layered.
//
// The replay never touches the board: it works on a copy taken when it opens,
// and nothing it draws is saved.

import { drawObject, drawRuling, setDarkBoard, isDarkBoard } from './core/render.js';
import { boundsOf, worldBounds } from './core/store.js';
import { pageRects, pageIndexForBoxIn } from './core/pages.js';
import { h } from './ui/popover.js';
import { icon } from './ui/icons.js';
import { t } from './i18n.js';
import { progressToast } from './backup.js';
import { GifWriter, makePalette } from './gif.js';
import { muxMp4, muxWebm } from './videomux.js';

/** The longest a replay lasts at 1x; a board with more in it is played faster rather than for longer. */
export const MAX_REPLAY_MS = 120000;
export const SPEEDS = [1, 2, 4];

function strokeLength(o) {
  const p = o.points;
  if (!Array.isArray(p) || p.length < 2) return 0;
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}

/**
 * The order things were made in. Layer order, except that objects which know
 * when they were made are put back in that order among the places they hold.
 */
export function replayOrder(objects) {
  const list = objects.filter(Boolean);
  const timed = [];
  list.forEach((o, i) => { if (Number.isFinite(o.at)) timed.push(i); });
  if (!timed.length) return list;
  const sorted = timed.map((i) => list[i]).sort((a, b) => a.at - b.at);
  const out = list.slice();
  timed.forEach((slot, k) => { out[slot] = sorted[k]; });
  return out;
}

/** When each object starts and how long it takes, in replay milliseconds at 1x. */
export function replayPlan(objects) {
  const seq = replayOrder(objects);
  const items = [];
  let clock = 0, prev = null;
  for (const o of seq) {
    const isStroke = o.type === 'stroke' && Array.isArray(o.points) && o.points.length > 1;
    const d = isStroke ? Math.min(900, Math.max(120, strokeLength(o) * 1.6)) : 260;
    let gap = 60;
    if (prev && Number.isFinite(o.at) && Number.isFinite(prev.o.at)) {
      gap = Math.min(700, Math.max(30, o.at - prev.o.at - prev.d));
    }
    const t0 = prev ? clock + gap : 0;
    let b = null;
    try { b = worldBounds(o); } catch { b = null; }
    const item = { o, t0, d, t1: t0 + d, stroke: isStroke, b };
    items.push(item);
    clock = item.t1;
    prev = item;
  }
  let total = clock + 600;
  if (total > MAX_REPLAY_MS) {
    const k = MAX_REPLAY_MS / total;
    for (const it of items) { it.t0 *= k; it.d *= k; it.t1 = it.t0 + it.d; }
    total = MAX_REPLAY_MS;
  }
  return { items, total: items.length ? total : 0 };
}

/** The part of the board the replay frames: everything on it, with a margin. */
export function replayBox(objects, pages) {
  let b = null;
  for (const o of objects) {
    if (!o) continue;
    const r = boundsOf(o);
    if (!Number.isFinite(r.x) || !Number.isFinite(r.w)) continue;
    b = b ? { x: Math.min(b.x, r.x), y: Math.min(b.y, r.y), x2: Math.max(b.x2, r.x + r.w), y2: Math.max(b.y2, r.y + r.h) }
      : { x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h };
  }
  if (!b) return { x: 0, y: 0, w: 800, h: 600 };
  const pad = Math.max(24, Math.max(b.x2 - b.x, b.y2 - b.y) * 0.04);
  return { x: b.x - pad, y: b.y - pad, w: b.x2 - b.x + pad * 2, h: b.y2 - b.y + pad * 2 };
}

/**
 * Draws a replay plan onto a canvas of a given size, incrementally.
 */
export class ReplayRenderer {
  /**
   * @param {{cull?: boolean, maxMarks?: number}} opts  cull: paint only what is
   *   inside the box, for a zoomed-in view; maxMarks: how many checkpoints to keep
   */
  constructor(plan, doc, box, width, height, { cull = false, maxMarks = 10, canvas = null } = {}) {
    this.plan = plan;
    this.items = plan.items;
    this.doc = doc;
    this.w = Math.max(2, Math.round(width));
    this.h = Math.max(2, Math.round(height));
    const k = Math.min(this.w / box.w, this.h / box.h);
    this.k = k;
    // centred: the box fills one way and is centred the other
    this.ox = (this.w - box.w * k) / 2 - box.x * k;
    this.oy = (this.h - box.h * k) / 2 - box.y * k;
    this.rects = pageRects(doc.pages || []);
    // the part of the board this canvas shows, in board units
    this.box = { x: -this.ox / k, y: -this.oy / k, w: this.w / k, h: this.h / k };
    this.cull = cull;
    this.painted = 0;                    // objects actually drawn, for the suite: a zoomed view draws only what it shows
    // a canvas handed back by an earlier close-up is used again rather than a new one made each time the view moves
    this.base = canvas && canvas.width === this.w && canvas.height === this.h ? canvas : document.createElement('canvas');
    if (this.base.width !== this.w || this.base.height !== this.h) { this.base.width = this.w; this.base.height = this.h; }
    this.bctx = this.base.getContext('2d');
    this.drawn = 0;                      // items fully painted on the base
    this.marks = new Map();              // item index -> canvas copy of the base at that point
    const n = this.items.length;
    // only so many copies, whatever the size of the board: memory stays bounded
    this.every = Math.max(150, Math.ceil(n / Math.max(1, maxMarks)));
    this.lagging = false;
    this.clearBase();
  }

  clearBase() {
    const c = this.bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.fillStyle = (this.doc.background && this.doc.background.color) || '#ffffff';
    c.fillRect(0, 0, this.w, this.h);
    const wasDark = isDarkBoard();
    setDarkBoard(false);
    try { drawRuling(c, this.doc.background || {}, { x: this.ox, y: this.oy, z: this.k }, this.w, this.h, this.doc.pages || []); }
    catch { /* a plain background is still a background */ }
    finally { setDarkBoard(wasDark); }
    this.drawn = 0;
  }

  /** Paint one object (or the first part of a stroke) in board coordinates, at this canvas's scale or another. */
  paint(ctx, o, share = 1, k = this.k, ox = this.ox, oy = this.oy) {
    ctx.save();
    ctx.setTransform(k, 0, 0, k, ox, oy);
    let obj = o;
    if (share < 1) {
      if (o.type === 'stroke' && Array.isArray(o.points)) {
        const m = Math.max(2, Math.ceil(o.points.length * share));
        obj = { ...o, points: o.points.slice(0, m) };
      } else ctx.globalAlpha *= Math.max(0, share);
    }
    const i = this.rects.length ? pageIndexForBoxIn(this.rects, boundsOf(o)) : -1;
    if (i >= 0) { const r = this.rects[i]; ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip(); }
    try { drawObject(ctx, obj); } catch { /* one bad object never stops the replay */ }
    ctx.restore();
  }

  /** Is this item inside what the canvas shows? Always yes unless the canvas is a zoomed-in view. */
  shows(it) {
    if (!this.cull || !it.b) return true;
    const b = it.b, v = this.box;
    return b.x <= v.x + v.w && b.x + b.w >= v.x && b.y <= v.y + v.h && b.y + b.h >= v.y;
  }

  /** How many items have finished by replay time t. */
  doneBy(t) {
    const it = this.items;
    let lo = 0, hi = it.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (it[mid].t1 <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /**
   * Bring the base up to time t, spending at most `budget` ms.
   * @returns {boolean} true when it got there
   */
  advanceTo(t, budget = Infinity) {
    const want = this.doneBy(t);
    if (want < this.drawn) {
      // backwards: the nearest copy at or before it, or a clean sheet
      let best = 0;
      for (const at of this.marks.keys()) if (at <= want && at > best) best = at;
      if (best > 0) {
        const c = this.bctx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1; c.globalCompositeOperation = 'copy';
        c.drawImage(this.marks.get(best), 0, 0);
        c.globalCompositeOperation = 'source-over';
        this.drawn = best;
      } else this.clearBase();
    }
    const wasDark = isDarkBoard();
    setDarkBoard(false);
    const start = performance.now();
    try {
      while (this.drawn < want) {
        const it = this.items[this.drawn];
        if (this.shows(it)) { this.paint(this.bctx, it.o); this.painted++; }
        this.drawn++;
        if (this.drawn % this.every === 0 && !this.marks.has(this.drawn)) {
          const copy = document.createElement('canvas');
          copy.width = this.w; copy.height = this.h;
          copy.getContext('2d').drawImage(this.base, 0, 0);
          this.marks.set(this.drawn, copy);
        }
        if ((this.drawn & 7) === 0 && performance.now() - start > budget) break;
      }
    } finally { setDarkBoard(wasDark); }
    return this.drawn >= want;
  }

  /** The replay time the base has actually reached. */
  reached() { return this.drawn ? this.items[this.drawn - 1].t1 : 0; }

  /** The picture at time t: the base, and whatever is being written right then. */
  present(ctx, t) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.base, 0, 0);
    ctx.restore();
    if (this.drawn !== this.doneBy(t)) return;           // still catching up: the base is the honest picture
    const wasDark = isDarkBoard();
    setDarkBoard(false);
    try {
      for (let i = this.drawn; i < this.items.length; i++) {
        const it = this.items[i];
        if (it.t0 > t) break;
        if (this.shows(it)) this.paint(ctx, it.o, Math.min(1, (t - it.t0) / (it.d || 1)));
      }
    } finally { setDarkBoard(wasDark); }
  }

  /** Part of this canvas - the board region v - filling a W x H picture, with the writing in progress on top. */
  presentView(ctx, t, v, W, H) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.base, v.x * this.k + this.ox, v.y * this.k + this.oy, v.w * this.k, v.h * this.k, 0, 0, W, H);
    ctx.restore();
    if (this.drawn !== this.doneBy(t)) return;
    const k = W / v.w, ox = -v.x * k, oy = -v.y * k;
    const wasDark = isDarkBoard();
    setDarkBoard(false);
    try {
      for (let i = this.drawn; i < this.items.length; i++) {
        const it = this.items[i];
        if (it.t0 > t) break;
        if (this.shows(it)) this.paint(ctx, it.o, Math.min(1, (t - it.t0) / (it.d || 1)), k, ox, oy);
      }
    } finally { setDarkBoard(wasDark); }
  }

  dispose() { this.marks.clear(); this.base.width = this.base.height = 1; }

  /** Finished with, but its canvas kept for the next close-up. */
  release() { this.marks.clear(); const c = this.base; this.base = null; return c; }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A box grown on one side so it has the same shape as the window: nothing stretched, nothing cut. */
export function shaped(box, aspect) {
  let { x, y, w, h } = box;
  if (w / h < aspect) { const w2 = h * aspect; x -= (w2 - w) / 2; w = w2; }
  else { const h2 = w / aspect; y -= (h2 - h) / 2; h = h2; }
  return { x, y, w, h };
}

/**
 * Zoom and pan for the replay, without making it heavier.
 *
 * The whole board is always being drawn on one canvas (`full`), at the size
 * that fits the window. Zoomed in, the screen first shows the right part of
 * that canvas enlarged - instantly, if a little soft - and a moment after the
 * view stops moving, a second canvas (`sharp`) is drawn for just that part of
 * the board, at full sharpness, and takes over. Only the strokes inside the
 * view are drawn on it, so a close-up of a huge board is quick to make.
 *
 * Follow the pen: zoomed in, the view glides along to wherever the writing
 * is, the way your eyes follow a teacher along a long board.
 */
export class ReplayCamera {
  /** @param {{instant?: boolean}} opts  instant: redraw the close-up as soon as the view moves (for saving, where every frame must be sharp) */
  constructor(plan, doc, box, width, height, { instant = false } = {}) {
    this.instant = instant;
    this.plan = plan;
    this.doc = doc;
    this.w = Math.max(2, Math.round(width));
    this.h = Math.max(2, Math.round(height));
    this.fit = shaped(box, this.w / this.h);
    this.full = new ReplayRenderer(plan, doc, this.fit, this.w, this.h, { maxMarks: 16 });
    this.view = { ...this.fit };
    this.sharp = null;
    this._timer = null;
    this.glide = null;
    this.follow = true;
    this.onChange = null;
    this.stats = { sharpBuilt: 0, glides: 0, cuts: 0 };
    // how fast Follow may drift, in window-widths a second; a saved replay played faster than real time drifts faster to match
    this.followSpeed = 0.3;
    this.glideMs = 1400;
  }

  get items() { return this.full.items; }
  get drawn() { return this.full.drawn; }
  doneBy(t) { return this.full.doneBy(t); }
  reached() { return this.full.reached(); }

  /** 1 is the whole board; 4 is a quarter of its width filling the window. */
  get zoom() { return this.fit.w / this.view.w; }
  maxZoom() { return Math.max(1, this.fit.w / 120); }
  center() { return { x: this.view.x + this.view.w / 2, y: this.view.y + this.view.h / 2 }; }

  /** Look at (cx, cy) at this zoom. Kept inside the board; the sharp copy is made once it stops moving. */
  setView(cx, cy, zoom) {
    const z = clamp(zoom, 1, this.maxZoom());
    const f = this.fit, w = f.w / z, h = f.h / z;
    const v = { x: clamp(cx - w / 2, f.x, f.x + f.w - w), y: clamp(cy - h / 2, f.y, f.y + f.h - h), w, h };
    const o = this.view;
    if (Math.abs(v.x - o.x) < 1e-6 && Math.abs(v.y - o.y) < 1e-6 && Math.abs(v.w - o.w) < 1e-6) return;
    this.view = v;
    // still inside the sharp close-up, at its scale: nothing to redraw, the picture is just taken from a different spot
    if (this.covers(this.sharp, v)) { this.onChange?.(this); return; }
    if (this.sharp) { this.spare = this.sharp.release(); this.sharp = null; }
    clearTimeout(this._timer); this._timer = null;
    if (z > 1.0001) {
      // following, the view is on the move: a sharp picture straight away rather than a soft one in the meantime
      if (this.instant || (this.follow && !this.glide)) this.sharpen();
      else this._timer = setTimeout(() => this.sharpen(), 140);
    }
    this.onChange?.(this);
  }

  /** Does this sharp canvas hold the whole of view v, at v's scale? */
  covers(r, v) {
    if (!r || !r.base) return false;
    const k = this.w / v.w;
    if (Math.abs(r.k - k) > k * 0.003) return false;
    const b = r.box, e = v.w * 1e-4;
    return v.x >= b.x - e && v.y >= b.y - e && v.x + v.w <= b.x + b.w + e && v.y + v.h <= b.y + b.h + e;
  }

  /**
   * Draw the close-up sharp: the view and a margin round it (or a given
   * region, for a glide), at the view's scale. Moving about inside that
   * margin - and a whole Follow glide - then needs no redrawing at all, so
   * the picture stays sharp while it moves instead of going soft.
   */
  sharpen(region = null) {
    this._timer = null;
    if (this.zoom <= 1.0001) return;
    const v = this.view, k = this.w / v.w;
    // wide to the sides while following, since that is the way writing goes: a drift then stays sharp for a long way
    const mx = this.follow ? 0.7 : 0.3, my = 0.3;
    let box = region || { x: v.x - v.w * mx, y: v.y - v.h * my, w: v.w * (1 + mx * 2), h: v.h * (1 + my * 2) };
    // memory stays bounded: a region too big for that is drawn as just the view
    if (box.w * k * box.h * k > 9e6) box = { ...v };
    const W = Math.max(2, Math.round(box.w * k)), H = Math.max(2, Math.round(box.h * k));
    const spare = this.spare && this.spare.width === W && this.spare.height === H ? this.spare : null;
    this.sharp = new ReplayRenderer(this.plan, this.doc, box, W, H, { cull: true, maxMarks: 4, canvas: spare });
    this.spare = null;
    this.stats.sharpBuilt++;
    this.onChange?.(this);
  }

  /** Glide to look at (cx, cy) at this zoom, instead of jumping. */
  glideTo(cx, cy, zoom, ms = 450, now = performance.now()) {
    const c = this.center();
    this.glide = { from: { x: c.x, y: c.y, z: this.zoom }, to: { x: cx, y: cy, z: zoom }, t0: now, ms };
    this.stats.glides++;
    // a glide that keeps its zoom gets one sharp canvas covering all of it, drawn now, before it moves
    if (Math.abs(zoom - this.zoom) < this.zoom * 1e-3 && this.zoom > 1.0001) {
      const v = this.view, f = this.fit;
      const tx = clamp(cx - v.w / 2, f.x, f.x + f.w - v.w), ty = clamp(cy - v.h / 2, f.y, f.y + f.h - v.h);
      const x0 = Math.min(v.x, tx), y0 = Math.min(v.y, ty), x1 = Math.max(v.x, tx) + v.w, y1 = Math.max(v.y, ty) + v.h;
      const m = v.w * 0.08;
      const region = { x: x0 - m, y: y0 - m, w: x1 - x0 + m * 2, h: y1 - y0 + m * 2 };
      const end = { x: tx, y: ty, w: v.w, h: v.h };
      if (!(this.covers(this.sharp, v) && this.covers(this.sharp, end))) {
        clearTimeout(this._timer); this._timer = null;
        if (this.sharp) { this.spare = this.sharp.release(); this.sharp = null; }
        this.sharpen(region);
      }
    }
  }

  /** Where the writing is at time t: the pen's tip on a stroke being written, or the middle of whatever just appeared. */
  penAt(t) {
    const items = this.items;
    if (!items.length) return null;
    let i = this.full.doneBy(t);
    if (i >= items.length || items[i].t0 > t) i = Math.max(0, i - 1);
    const it = items[i];
    const o = it.o;
    if (it.stroke && t >= it.t0 && t < it.t1) {
      const p = o.points[Math.min(o.points.length - 1, Math.floor(o.points.length * (t - it.t0) / (it.d || 1)))];
      if (p && Number.isFinite(p.x) && !o.rotation) return { x: p.x, y: p.y };
    }
    const b = it.b;
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  }

  /**
   * Called every frame: a glide moves on, and Follow keeps the writing in view.
   *
   * Follow is a slow, steady drift, like a camera operator easing along a
   * board - never a swing. The view does not move while the pen is in the
   * middle part of it; as the pen heads for an edge, the view starts drifting
   * after it, and it never drifts faster than about a third of its own width
   * a second, gathering speed and slowing down gently. Only when the writing
   * has jumped far away (the next line, the other end of the board) does the
   * view go straight there, because a long slide is worse to watch than a cut.
   */
  update(t, now = performance.now()) {
    const dt = this._lastNow == null ? 0 : Math.min(100, Math.max(0, now - this._lastNow)) / 1000;
    this._lastNow = now;
    if (this.glide) {
      const g = this.glide;
      const p = clamp((now - g.t0) / g.ms, 0, 1);
      const e = (1 - Math.cos(Math.PI * p)) / 2;          // the gentlest start and stop
      this.setView(g.from.x + (g.to.x - g.from.x) * e, g.from.y + (g.to.y - g.from.y) * e, g.from.z + (g.to.z - g.from.z) * e);
      if (p >= 1) { this.glide = null; this.vel = { x: 0, y: 0 }; }
      return;
    }
    if (!this.follow || this.zoom <= 1.0001) { this.vel = { x: 0, y: 0 }; return; }
    const pen = this.penAt(t);
    if (!pen) return;
    const v = this.view;
    const farOut = pen.x < v.x - v.w * 0.5 || pen.x > v.x + v.w * 1.5 || pen.y < v.y - v.h * 0.5 || pen.y > v.y + v.h * 1.5;
    if (farOut) { this.setView(pen.x, pen.y, this.zoom); this.vel = { x: 0, y: 0 }; this.stats.cuts++; return; }
    // where the view would like its middle to be: unchanged while the pen is in the middle 40%,
    // otherwise far enough along that the pen sits 30% in from the edge it is heading for
    const c = this.center();
    let tx = c.x, ty = c.y;
    if (pen.x > v.x + v.w * 0.7) tx = pen.x + v.w * 0.2; else if (pen.x < v.x + v.w * 0.3) tx = pen.x - v.w * 0.2;
    if (pen.y > v.y + v.h * 0.7) ty = pen.y + v.h * 0.2; else if (pen.y < v.y + v.h * 0.3) ty = pen.y - v.h * 0.2;
    const vmax = v.w * this.followSpeed;                    // board units a second
    const want = { x: clamp((tx - c.x) * 1.2, -vmax, vmax), y: clamp((ty - c.y) * 1.2, -vmax, vmax) };
    const vel = this.vel || { x: 0, y: 0 };
    // gathering speed and easing off gradually, over about a second
    const k = 1 - Math.exp(-dt * 2.2);
    vel.x += (want.x - vel.x) * k; vel.y += (want.y - vel.y) * k;
    this.vel = vel;
    const moving = Math.abs(vel.x) + Math.abs(vel.y) >= v.w * 0.002;
    if (moving && !this._drifting) this.stats.glides++;
    this._drifting = moving;
    if (!moving) return;
    this.setView(c.x + vel.x * dt, c.y + vel.y * dt, this.zoom);
  }

  /** Still settling: a glide under way, or the sharp copy not made or not caught up yet. */
  pending(t) {
    const drifting = !!this.vel && Math.abs(this.vel.x) + Math.abs(this.vel.y) > this.view.w * 0.002;
    return !!this.glide || drifting || !!this._timer || (!!this.sharp && this.sharp.drawn !== this.sharp.doneBy(t));
  }

  advanceTo(t, budget = Infinity) {
    const start = performance.now();
    const there = this.full.advanceTo(t, budget);
    if (this.sharp) this.sharp.advanceTo(t, this.instant ? Infinity : Math.max(3, budget - (performance.now() - start)));
    return there;
  }

  /** Is the sharp close-up ready to show? */
  sharpShown(t) { return this.zoom > 1.0001 && this.covers(this.sharp, this.view) && this.sharp.drawn === this.sharp.doneBy(t); }

  present(ctx, t) {
    if (this.zoom <= 1.0001) { this.full.present(ctx, t); return; }
    if (this.sharpShown(t)) { this.sharp.presentView(ctx, t, this.view, this.w, this.h); return; }
    // meanwhile: that part of the whole-board canvas, enlarged, with the writing in progress drawn sharp on top
    const f = this.full, v = this.view;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(f.base, v.x * f.k + f.ox, v.y * f.k + f.oy, v.w * f.k, v.h * f.k, 0, 0, this.w, this.h);
    ctx.restore();
    if (f.drawn !== f.doneBy(t)) return;
    const k = this.w / v.w, ox = -v.x * k, oy = -v.y * k;
    const wasDark = isDarkBoard();
    setDarkBoard(false);
    try {
      for (let i = f.drawn; i < f.items.length; i++) {
        const it = f.items[i];
        if (it.t0 > t) break;
        f.paint(ctx, it.o, Math.min(1, (t - it.t0) / (it.d || 1)), k, ox, oy);
      }
    } finally { setDarkBoard(wasDark); }
  }

  dispose() {
    clearTimeout(this._timer);
    this.full.dispose();
    if (this.sharp) this.sharp.dispose();
    this.sharp = null;
    if (this.spare) this.spare.width = this.spare.height = 1;
    this.spare = null;
  }
}

/**
 * A clock that runs the replay: real time times the speed, except that it
 * never runs ahead of what has been drawn. That is the adaptive slow-down.
 */
export class ReplayPlayer {
  constructor(renderer, canvas, { onTick } = {}) {
    this.r = renderer;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = 0;
    this.speed = 1;
    this.playing = false;
    this.onTick = onTick;
    this.frame = this.frame.bind(this);
    this.raf = null;
    this.last = 0;
    this.budget = 10;
    this.slowFrames = 0;
    this.stats = { frames: 0, maxWork: 0, slowed: 0 };
  }

  get total() { return this.r.plan.total; }

  play() {
    if (this.t >= this.total) this.t = 0;
    this.playing = true; this.last = performance.now(); this.kick();
  }

  pause() { this.playing = false; this.kick(); }

  /*
   * A jump along the slider. While it is being reached the clock holds still and the drawing gets the
   * bigger budget a paused replay gets, even if the replay is playing: a jump forward is a long way
   * to draw, and the slow-machine rule below (hold the clock back to what is drawn) used to pull a
   * click while playing back to wherever the drawing had got to in one frame - well short of the click.
   */
  seek(t) { this.t = Math.max(0, Math.min(this.total, t)); this.seeking = true; this.last = performance.now(); this.kick(); }

  kick() { if (!this.raf) this.raf = requestAnimationFrame(this.frame); }

  frame(now) {
    this.raf = null;
    const t0 = performance.now();
    if (this.playing && !this.seeking) {
      const dt = Math.min(100, Math.max(0, now - this.last));
      this.t = Math.min(this.total, this.t + dt * this.speed);
    }
    this.last = now;
    this.r.update?.(this.t, now);
    // paused, or getting to where the slider was put, it may take longer per frame: getting to the spot quickly matters more than smoothness
    const there = this.r.advanceTo(this.t, this.playing && !this.seeking ? this.budget : 45);
    if (there) this.seeking = false;
    else if (this.playing && !this.seeking) {
      // the machine could not keep up: the clock waits for the drawing
      this.t = Math.max(this.r.reached(), Math.min(this.t, this.r.reached() + 50));
      this.stats.slowed++;
    }
    this.r.present(this.ctx, this.t);
    const work = performance.now() - t0;
    this.stats.frames++;
    this.stats.maxWork = Math.max(this.stats.maxWork, work);
    if (this.playing && this.t >= this.total) this.playing = false;
    this.onTick?.(this);
    if (this.playing || !there || this.r.pending?.(this.t)) this.kick();
  }

  stop() { this.playing = false; if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
}

/*
 * A copy of the board that the replay can keep. Only each object's top level
 * is copied - a few milliseconds on a huge board, where a deep copy was a
 * noticeable pause. That is enough while the replay is open, because it
 * covers the board and nothing can be moved underneath it; a save, which can
 * go on after it is closed, copies the points too first (see ownCopy).
 */
function snapshot(app) {
  const d = app.store.doc;
  return {
    doc: { background: { ...(d.background || {}) }, pages: (d.pages || []).map((p) => ({ ...p })) },
    objects: app.store.objects.map((o) => ({ ...o }))
  };
}

function outSize(box, longest) {
  const k = longest / Math.max(box.w, box.h);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { w: even(box.w * k), h: even(box.h * k) };
}

const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The video types this machine says it can record, best first: MP4 where it can, WebM otherwise. */
export function videoTypes() {
  const MR = typeof MediaRecorder === 'function' ? MediaRecorder : null;
  if (!MR) return [];
  const out = [];
  for (const [mime, ext] of [['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']]) {
    try { if (MR.isTypeSupported(mime) && !out.some((x) => x.ext === ext)) out.push({ mime, ext }); } catch { /* try the next */ }
  }
  return out;
}
export function videoType() { return videoTypes()[0] || null; }

/**
 * Record the replay as a video, in the background.
 * Plays at whatever speed keeps the video under a minute.
 *
 * A machine can say yes to MP4 and then hand back an empty file - a Windows
 * PC whose video encoder will not take the job does exactly that. So an empty
 * recording is never saved: the next type the machine offers (WebM) is tried.
 */
export async function recordVideo(source, opts = {}) {
  // Encoded frame by frame first: exact, as fast as the machine allows, and independent of whether
  // the window is on screen. Recording a canvas as it plays (MediaRecorder) is the fallback.
  if (opts.via !== 'recorder') {
    const res = await encodeVideo(source, opts);
    if (res === null) return null;                         // cancelled
    if (res && res.bytes.length) return res;
  }
  const types = videoTypes();
  for (let i = 0; i < types.length; i++) {
    const res = await recordAs(source, types[i], opts);
    if (res === null) return null;                         // cancelled
    if (res.bytes.length) return res;
  }
  throw new Error(t('This device cannot record video'));
}

/** The best video this machine can encode itself: H.264 in an MP4, else VP9 or VP8 in a WebM. */
/** Why the last frame-by-frame save gave way to the recorder, for the tests and for bug reports. */
export let encodeNote = '';

export async function encoderChoice(w, h, fps, bitrate) {
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') return null;
  // H.264 level 4.0 stops at 1920x1080; a tall or square board at full size needs level 5
  const list = [['avc1.420028', 'mp4'], ['avc1.640028', 'mp4'], ['avc1.420032', 'mp4'], ['avc1.4d0032', 'mp4'], ['avc1.640032', 'mp4'],
    ['vp09.00.40.08', 'webm'], ['vp09.00.50.08', 'webm'], ['vp8', 'webm']];
  for (const [codec, ext] of list) {
    const config = { codec, width: w, height: h, bitrate, framerate: fps, ...(ext === 'mp4' ? { avc: { format: 'avc' } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, ext }; } catch { /* the next one */ }
  }
  return null;
}

/**
 * The replay as a video file, made one frame at a time with the machine's own encoder.
 * @returns {Promise<{bytes: Uint8Array, ext: string}|null|false>} null if cancelled, false if this way is not available
 */
export async function encodeVideo(source, { speed = 1, longest = 1920, onProgress, signal, fps = 30, view = null } = {}) {
  const plan = replayPlan(source.objects);
  const pace = Math.max(speed, plan.total / 60000);
  const cam = savingCamera(plan, source, view, longest, pace);
  const w = cam.w, hh = cam.h;
  const bits = Math.round(Math.min(16_000_000, Math.max(6_000_000, w * hh * fps * 0.2)));
  const choice = await encoderChoice(w, hh, fps, bits);
  if (!choice) { cam.dispose(); encodeNote = 'no encoder'; return false; }
  const out = document.createElement('canvas');
  out.width = w; out.height = hh;
  const octx = out.getContext('2d');
  const chunks = [];
  let desc = null, failed = null, sent = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !desc) {
        const d = meta.decoderConfig.description;
        desc = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, key: chunk.type === 'key' });
    },
    error: (e) => { failed = e; }
  });
  try {
    encoder.configure(choice.config);
    const frameMs = 1000 / fps;
    const frames = Math.ceil(plan.total / pace / frameMs) + Math.round(fps * 0.8);   // and a moment on the finished board
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) { try { encoder.close(); } catch { /* closed */ } return null; }
      if (failed) throw failed;
      const clock = Math.min(plan.total, i * frameMs * pace);
      cam.update(clock, i * frameMs);
      cam.advanceTo(clock, Infinity);
      cam.present(octx, clock);
      const vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 }); sent++;
      vf.close();
      // the encoder works alongside; never let it fall far behind, and let the window have a turn
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      if (i % 4 === 3) { onProgress?.(i / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
    await encoder.flush();
    if (failed) throw failed;
    encoder.close();
  } catch (e) {
    try { encoder.close(); } catch { /* already closed */ }
    encodeNote = 'encoder failed: ' + (e && e.message || e);
    return false;                                          // let the recorder try instead
  } finally { cam.dispose(); }
  if (!chunks.length) { encodeNote = `encoder gave no frames (${sent} sent, ${w}x${hh}, ${choice.config.codec})`; return false; }
  encodeNote = '';
  if (choice.ext === 'mp4') {
    if (!desc) { encodeNote = 'no H.264 description'; return false; }
    return { bytes: muxMp4(chunks, desc, w, hh, fps), ext: 'mp4' };
  }
  return { bytes: muxWebm(chunks, choice.config.codec, w, hh, fps), ext: 'webm' };
}

/*
 * The camera a saved replay is filmed with. Whole board: the board's own
 * shape, at full size. Zoomed in on screen: a 16:9 frame showing the same
 * amount of board across as the window does, at the same spot or following
 * the pen - so writing that is readable on screen is readable in the file.
 */
export function savingCamera(plan, source, view, longest, pace = 1) {
  const box = replayBox(source.objects, source.doc.pages);
  const zoomed = !!(view && view.zoomed);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const size = zoomed ? { w: even(longest), h: even(longest * 9 / 16) } : outSize(box, longest);
  const cam = new ReplayCamera(plan, source.doc, box, size.w, size.h, { instant: true });
  cam.follow = zoomed && !!view.follow;
  cam.followSpeed = 0.3 * Math.max(1, pace);
  if (zoomed) {
    let viewW = view.viewW;
    if (cam.follow) {
      // A file usually plays faster than the replay was watched. Close up, the pen would then race
      // across the frame faster than anyone can follow, so the shot is widened until it crosses no
      // more than half the frame a second.
      let travel = 0;
      const it = plan.items;
      for (let i = 1; i < it.length; i++) if (it[i].b && it[i - 1].b) travel += Math.hypot(it[i].b.x - it[i - 1].b.x, it[i].b.y - it[i - 1].b.y);
      const perSecond = plan.total ? (travel / plan.total) * 1000 * Math.max(1, pace) : 0;
      viewW = Math.max(viewW, perSecond / 0.5);
    }
    const at = (cam.follow && cam.penAt(0)) || { x: view.cx, y: view.cy };
    cam.setView(at.x, at.y, Math.max(1, cam.fit.w / viewW));
  }
  return cam;
}

async function recordAs(source, type, { speed = 1, longest = 1920, onProgress, signal, fps = 30, view = null } = {}) {
  const plan = replayPlan(source.objects);
  const pace = Math.max(speed, plan.total / 60000);
  const r = savingCamera(plan, source, view, longest, pace);
  const w = r.w, hh = r.h;
  const out = document.createElement('canvas');
  out.width = w; out.height = hh;
  const octx = out.getContext('2d');
  r.present(octx, 0);
  // frames are handed over one by one as they are drawn, rather than left to
  // be noticed: a canvas that is not on screen is not always watched for changes
  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const frame = () => { try { track && track.requestFrame && track.requestFrame(); } catch { /* the stream carries on */ } };
  let rec;
  // a high bit rate: thin ink lines on a plain background are what video compression smears first
  const bits = Math.round(Math.min(16_000_000, Math.max(6_000_000, w * hh * fps * 0.2)));
  try { rec = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: bits }); }
  catch { stream.getTracks().forEach((tr) => tr.stop()); r.dispose(); return { bytes: new Uint8Array(0), ext: type.ext }; }
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; rec.onerror = res; });
  rec.start(1000);
  frame();
  let clock = 0, last = performance.now(), aborted = false;
  try {
    await new Promise((resolve) => {
      const step = () => {
        if (signal?.aborted) { aborted = true; resolve(); return; }
        const now = performance.now();
        clock = Math.min(plan.total, clock + Math.min(100, now - last) * pace);
        last = now;
        r.update(clock, now);
        if (!r.advanceTo(clock, 12)) clock = Math.max(r.reached(), Math.min(clock, r.reached() + 50));
        r.present(octx, clock);
        frame();
        onProgress?.(plan.total ? clock / plan.total : 1);
        if (clock >= plan.total) {                       // hold the finished board a moment
          let held = 0;
          const hold = () => { frame(); if (++held >= 6) resolve(); else setTimeout(hold, 100); };
          setTimeout(hold, 100);
          return;
        }
        setTimeout(step, 1000 / fps);
      };
      step();
    });
  } finally {
    // the recorder is stopped and allowed to hand over its last piece BEFORE the picture source goes
    try { if (rec.state !== 'inactive') { rec.requestData(); rec.stop(); } } catch { /* already stopped */ }
    await Promise.race([stopped, new Promise((res) => setTimeout(res, 3000))]);
    stream.getTracks().forEach((tr) => tr.stop());
    r.dispose();
  }
  if (aborted) return null;
  const blob = new Blob(parts, { type: type.mime.split(';')[0] });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: type.ext };
}

/** Make the replay into an animated GIF, a frame at a time, without holding up the window. */
export async function makeGif(source, { longest = 640, fps = 10, maxSeconds = 20, onProgress, signal, view = null } = {}) {
  const plan = replayPlan(source.objects);
  // a GIF plays the replay at whatever pace fits it into its length; Follow glides to match
  const gifPace = Math.max(1, plan.total / (Math.min(maxSeconds, Math.max(2, plan.total / 1000)) * 1000));
  const r = savingCamera(plan, source, view, longest, gifPace);
  const w = r.w, hh = r.h;
  const out = document.createElement('canvas');
  out.width = w; out.height = hh;
  const octx = out.getContext('2d', { willReadFrequently: true });
  try {
    const seconds = Math.min(maxSeconds, Math.max(2, plan.total / 1000));
    const frames = Math.max(2, Math.round(seconds * fps));
    // the palette comes from the finished board, which has every colour the replay will show
    while (!r.full.advanceTo(plan.total, 12)) {
      if (signal?.aborted) return null;
      await new Promise((res) => setTimeout(res, 0));
    }
    r.full.present(octx, plan.total);
    const gif = new GifWriter(w, hh, makePalette(octx.getImageData(0, 0, w, hh).data));
    r.full.clearBase();
    const step = 1000 / fps;
    for (let f = 0; f <= frames; f++) {
      if (signal?.aborted) return null;
      const at = plan.total * (f / frames);
      r.update(at, f * step);
      while (!r.advanceTo(at, 12)) await new Promise((res) => setTimeout(res, 0));
      r.present(octx, at);
      gif.addFrame(octx.getImageData(0, 0, w, hh).data, f === frames ? 300 : Math.round(100 / fps));
      onProgress?.(f / frames);
      await new Promise((res) => setTimeout(res, 0));
    }
    return { bytes: gif.finish(), ext: 'gif' };
  } finally { r.dispose(); }
}

/*
 * Before a save that may go on while the board is being used: the points of
 * each stroke copied too, since dragging a stroke moves its points where they
 * are. A few hundred strokes at a time, so the window never waits for it.
 */
async function ownCopy(source) {
  const objects = source.objects.slice();
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (Array.isArray(o.points)) objects[i] = { ...o, points: o.points.map((q) => ({ ...q })) };
    if (i % 500 === 499) await new Promise((res) => setTimeout(res, 0));
  }
  return { doc: source.doc, objects };
}

/** Save a replay file, with a progress toast that can be cancelled and does not hold up the board. */
async function saveReplay(app, source, kind, speed, view = null) {
  const name = String(app.store.doc.name || 'board').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80).trim() || 'board';
  const ctrl = new AbortController();
  const toast = progressToast(kind === 'gif' ? t('Making the GIF…') : t('Recording the video…'), { onCancel: () => ctrl.abort() });
  app.replayJob = ctrl;
  try {
    source = await ownCopy(source);
    const res = kind === 'gif'
      ? await makeGif(source, { view, signal: ctrl.signal, onProgress: (p) => toast.set(null, p) })
      : await recordVideo(source, { speed, view, signal: ctrl.signal, onProgress: (p) => toast.set(null, p) });
    if (!res) { app.toast(t('Cancelled'), 'help'); return null; }
    toast.done();
    const path = await window.board.saveDialog({
      title: kind === 'gif' ? t('Save replay as GIF') : t('Save replay as video'),
      defaultPath: `${name} replay.${res.ext}`,
      filters: [{ name: kind === 'gif' ? 'GIF' : res.ext.toUpperCase(), extensions: [res.ext] }]
    });
    if (!path) return null;
    await window.board.writeFile(path, res.bytes);
    app.toast(t('Saved {name}', { name: String(path).split(/[\\/]/).pop() }));
    return path;
  } catch (e) {
    app.toast(t('Could not save the replay: {error}', { error: e.message || String(e) }), 'help', 6000);
    return null;
  } finally { toast.done(); if (app.replayJob === ctrl) app.replayJob = null; }
}

/** The replay window over the board, with its controls. */
export function openReplay(app) {
  closeReplay(app);
  app.commitTextEdit?.();
  const source = snapshot(app);
  if (!source.objects.length) { app.toast(t('Nothing on this board to replay yet'), 'help'); return null; }
  const plan = replayPlan(source.objects);
  const box = replayBox(source.objects, source.doc.pages);

  const canvas = h('canvas', { class: 'replay-canvas' });
  const mini = h('canvas', { class: 'replay-mini', 'aria-label': t('Whole board') });
  const stage = h('div', { class: 'replay-stage' }, canvas, mini);
  const playBtn = h('button', { class: 'btn replay-play', 'aria-label': t('Play') });
  const time = h('span', { class: 'replay-time' }, '0:00');
  const slider = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'replay-slider', 'aria-label': t('Replay position') });
  const speedBtns = SPEEDS.map((s) => h('button', { class: 'btn replay-speed', 'data-speed': String(s) }, s + '×'));
  const closeBtn = h('button', { class: 'btn replay-close', 'aria-label': t('Close'), html: icon('close', 18) });
  const videoBtn = h('button', { class: 'btn' }, t('Save video'));
  const gifBtn = h('button', { class: 'btn' }, t('Save GIF'));
  const zoomOut = h('button', { class: 'btn replay-zoom', 'data-zoom': 'out', 'aria-label': t('Zoom out'), html: icon('zoomOut', 18) });
  const zoomIn = h('button', { class: 'btn replay-zoom', 'data-zoom': 'in', 'aria-label': t('Zoom in'), html: icon('zoomIn', 18) });
  const zoomLabel = h('span', { class: 'replay-zoom-label' }, '100%');
  const wholeBtn = h('button', { class: 'btn', 'data-zoom': 'whole' }, t('Whole board'));
  const followBtn = h('button', { class: 'btn replay-follow', 'data-zoom': 'follow' }, t('Follow pen'));
  if (!videoType() && typeof VideoEncoder !== 'function') videoBtn.disabled = true;
  const bar = h('div', { class: 'replay-bar' },
    h('div', { class: 'replay-row' }, playBtn, time, slider),
    h('div', { class: 'replay-row' },
      h('span', { class: 'replay-speeds' }, ...speedBtns),
      h('span', { class: 'replay-zooms' }, zoomOut, zoomLabel, zoomIn, wholeBtn, followBtn),
      h('span', { style: 'flex:1' }), videoBtn, gifBtn, closeBtn));
  const layer = h('div', { class: 'replay-layer', role: 'dialog', 'aria-label': t('Replay') }, stage, bar);
  document.body.appendChild(layer);

  // the canvas fills the space it has; the whole board is fitted inside it, and zooming shows less of it, larger
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = stage.getBoundingClientRect();
  const cw = Math.max(2, Math.floor(rect.width - 16)), ch = Math.max(2, Math.floor(rect.height - 16));
  // never more than about 2.4 million pixels, however big the screen: memory stays bounded
  const px = Math.min(dpr, dpr * Math.sqrt(2.4e6 / (cw * dpr * ch * dpr)));
  canvas.width = Math.max(2, Math.round(cw * px)); canvas.height = Math.max(2, Math.round(ch * px));
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  const camera = new ReplayCamera(plan, source.doc, box, canvas.width, canvas.height);

  // the overview in the corner: the whole board, with the part being shown outlined
  const mw = Math.round(Math.min(180, cw * 0.3)), mh = Math.max(24, Math.round(mw * camera.fit.h / camera.fit.w));
  const mh2 = Math.min(mh, Math.round(ch * 0.35)), mw2 = Math.round(mh2 * camera.fit.w / camera.fit.h);
  mini.width = Math.round(mw2 * dpr); mini.height = Math.round(mh2 * dpr);
  mini.style.width = mw2 + 'px'; mini.style.height = mh2 + 'px';
  const mctx = mini.getContext('2d');
  // redrawn a few times a second, not every frame: it is small, and copying the whole board down is not free
  let miniAt = -1e9, miniView = '';
  const drawMini = () => {
    const on = camera.zoom > 1.0001;
    mini.style.display = on ? 'block' : 'none';
    if (!on) return;
    const now = performance.now(), key = JSON.stringify(camera.view);
    if (key === miniView && now - miniAt < 250) return;
    miniAt = now; miniView = key;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = 'copy';
    mctx.drawImage(camera.full.base, 0, 0, mini.width, mini.height);
    mctx.globalCompositeOperation = 'source-over';
    const f = camera.fit, v = camera.view, k = mini.width / f.w;
    mctx.lineWidth = Math.max(1.5, dpr * 1.5);
    mctx.strokeStyle = '#0078d4';
    mctx.fillStyle = 'rgba(0,120,212,.12)';
    mctx.fillRect((v.x - f.x) * k, (v.y - f.y) * k, v.w * k, v.h * k);
    mctx.strokeRect((v.x - f.x) * k, (v.y - f.y) * k, v.w * k, v.h * k);
  };

  // board units under a point on the canvas (CSS pixels from its corner)
  const worldAt = (x, y) => ({ x: camera.view.x + (x / cw) * camera.view.w, y: camera.view.y + (y / ch) * camera.view.h });
  // a little smaller than it was written: more of the board in view, so Follow has less moving to do
  const closeUp = () => Math.min(camera.maxZoom(), Math.max(1.5, camera.fit.w / (cw * 1.4)));
  // zoom around a point, keeping what is under it where it is
  const zoomAround = (x, y, z) => {
    const p = worldAt(x, y);
    const z2 = Math.min(camera.maxZoom(), Math.max(1, z));
    const w2 = camera.fit.w / z2, h2 = camera.fit.h / z2;
    camera.glide = null;
    camera.setView(p.x - (x / cw) * w2 + w2 / 2, p.y - (y / ch) * h2 + h2 / 2, z2);
    player.kick();
  };
  const setFollow = (on) => { camera.follow = on; sync(player); };

  let dragging = false;
  const sync = (p) => {
    playBtn.innerHTML = icon(p.playing ? 'pause' : 'play', 18);
    playBtn.setAttribute('aria-label', p.playing ? t('Pause') : t('Play'));
    time.textContent = `${fmt(p.t / p.speed)} / ${fmt(p.total / p.speed)}`;
    if (!dragging) slider.value = String(Math.round((p.total ? p.t / p.total : 0) * 1000));
    for (const b of speedBtns) b.classList.toggle('on', Number(b.dataset.speed) === p.speed);
    zoomLabel.textContent = Math.round((cw / camera.view.w) * 100) + '%';
    followBtn.classList.toggle('on', camera.follow);
    followBtn.setAttribute('aria-pressed', String(camera.follow));
    zoomOut.disabled = camera.zoom <= 1.0001;
    zoomIn.disabled = camera.zoom >= camera.maxZoom() - 1e-6;
    drawMini();
  };
  const player = new ReplayPlayer(camera, canvas, { onTick: sync });
  camera.onChange = () => player.kick();

  playBtn.onclick = () => (player.playing ? player.pause() : player.play());
  slider.addEventListener('input', () => { dragging = true; player.seek(player.total * Number(slider.value) / 1000); });
  slider.addEventListener('change', () => { dragging = false; sync(player); });
  for (const b of speedBtns) b.onclick = () => { player.speed = Number(b.dataset.speed); sync(player); };
  zoomIn.onclick = () => zoomAround(cw / 2, ch / 2, camera.zoom * 1.6);
  zoomOut.onclick = () => zoomAround(cw / 2, ch / 2, camera.zoom / 1.6);
  wholeBtn.onclick = () => { const f = camera.fit; camera.glideTo(f.x + f.w / 2, f.y + f.h / 2, 1, 350); player.kick(); };
  followBtn.onclick = () => {
    setFollow(!camera.follow);
    // following from the whole board means going in close, to where the pen is
    if (camera.follow && camera.zoom <= 1.0001) {
      const pen = camera.penAt(player.t) || camera.center();
      camera.glideTo(pen.x, pen.y, closeUp(), 400);
    }
    player.kick();
  };
  // the file is filmed the way the replay is being watched: whole board, or this close up, following the pen or not
  const viewNow = () => {
    const c = camera.center();
    return { zoomed: camera.zoom > 1.0001, follow: camera.follow, cx: c.x, cy: c.y, viewW: camera.view.w };
  };
  videoBtn.onclick = () => saveReplay(app, source, 'video', player.speed, viewNow());
  gifBtn.onclick = () => saveReplay(app, source, 'gif', player.speed, viewNow());

  // Wheel or trackpad pinch zooms where the pointer is; dragging moves around;
  // two fingers pinch and move; a double click or double tap goes in close
  // there, or back out to the whole board.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    zoomAround(e.clientX - r.left, e.clientY - r.top, camera.zoom * k);
  }, { passive: false });
  const touches = new Map();
  let pan = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a real pointer: nothing to hold on to */ }
    touches.set(e.pointerId, local(e));
    pan = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const was = touches.get(e.pointerId), now = local(e);
    touches.set(e.pointerId, now);
    if (touches.size === 1) {
      if (!pan && Math.hypot(now.x - was.x, now.y - was.y) < 1) return;
      pan = true;
      if (camera.follow) setFollow(false);           // looking somewhere else: the view stays where it is put
      camera.glide = null;
      const c = camera.center();
      camera.setView(c.x - (now.x - was.x) * camera.view.w / cw, c.y - (now.y - was.y) * camera.view.h / ch, camera.zoom);
      player.kick();
    } else if (touches.size === 2) {
      const [a, b] = [...touches.entries()].map(([id, p]) => (id === e.pointerId ? { now: p, was } : { now: p, was: p }));
      const d0 = Math.hypot(a.was.x - b.was.x, a.was.y - b.was.y), d1 = Math.hypot(a.now.x - b.now.x, a.now.y - b.now.y);
      if (d0 > 4) {
        pan = true;
        const mx = (a.now.x + b.now.x) / 2, my = (a.now.y + b.now.y) / 2;
        zoomAround(mx, my, camera.zoom * (d1 / d0));
      }
    }
  });
  const lift = (e) => { touches.delete(e.pointerId); if (!touches.size) pan = null; };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('dblclick', (e) => {
    const p = local(e);
    if (camera.zoom > 1.0001) wholeBtn.onclick();
    else { const w = worldAt(p.x, p.y); camera.glideTo(w.x, w.y, closeUp(), 350); player.kick(); }
  });
  // the overview: touch or drag on it to look there
  const lookFromMini = (e) => {
    const r = mini.getBoundingClientRect(), f = camera.fit;
    if (camera.follow) setFollow(false);
    camera.glide = null;
    camera.setView(f.x + ((e.clientX - r.left) / r.width) * f.w, f.y + ((e.clientY - r.top) / r.height) * f.h, camera.zoom);
    player.kick();
  };
  let miniDown = false;
  mini.addEventListener('pointerdown', (e) => { miniDown = true; try { mini.setPointerCapture(e.pointerId); } catch { /* as above */ } lookFromMini(e); });
  mini.addEventListener('pointermove', (e) => { if (miniDown) lookFromMini(e); });
  mini.addEventListener('pointerup', () => { miniDown = false; });

  // While the replay is up, keys belong to it: Delete or Ctrl+Z must not reach the board hidden underneath.
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeReplay(app); }
    else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); playBtn.click(); }
    else if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); zoomIn.onclick(); }
    else if (e.key === '-' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); zoomOut.onclick(); }
  };
  closeBtn.onclick = () => closeReplay(app);
  window.addEventListener('keydown', onKey, true);

  /*
   * A long board fitted into the window can come out too small to read. Then
   * the replay starts close up - about the size it was written at - and
   * follows the pen; Whole board is a click away.
   */
  const readable = cw / camera.fit.w;
  if (readable < 0.55 && plan.items.length) {
    const first = camera.penAt(0) || camera.center();
    camera.setView(first.x, first.y, closeUp());
    clearTimeout(camera._timer);
    camera.sharpen();
  }

  app.replay = { layer, player, camera, renderer: camera.full, plan, source, onKey, canvas, mini, controls: { zoomIn, zoomOut, wholeBtn, followBtn, zoomLabel } };
  sync(player);
  player.play();
  return app.replay;
}

export function closeReplay(app) {
  const r = app.replay;
  if (!r) return;
  r.player.stop();
  r.camera.dispose();
  window.removeEventListener('keydown', r.onKey, true);
  r.layer.remove();
  app.replay = null;
}
