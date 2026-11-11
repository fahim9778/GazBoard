// Arrows that hold on to things.
//
// A connector is an arrow (or a plain line) whose two ends are either a free
// point on the board or attached to something: a shape, a note, a text box, a
// maths box, a picture, a stroke of handwriting, or a whole group. An attached
// end does not remember a spot on the object - it remembers the OBJECT, and
// where the end meets it is worked out every time the arrow is drawn, from
// where the two things are now. That is what makes an end slide round to
// whichever side faces the other object as things are moved, and it is also
// why moving, resizing, rotating, undoing and redoing never have to know that
// arrows exist: there is nothing on the arrow to keep up to date.
//
//   { type: 'connector', route: 'straight' | 'elbow' | 'curved', bend,
//     a: { id? | group?, x, y },  b: { id? | group?, x, y },
//     heads: 'end' | 'both' | 'none', stroke, lineWidth, dash, x, y, w, h }
//
// Each end keeps the last place it was drawn (x, y) as well. An end whose
// object has gone - deleted, or in a board opened somewhere that object never
// existed - simply stays where it last was, and if the object comes back with
// an undo it picks it up again. x/y/w/h are the arrow's last bounding box, so
// anything that reads a file without working the route out still gets a box.

import { worldBounds } from './store.js';
import { distToSegment, bboxOfPoints, clamp } from './util.js';

export const ROUTES = ['straight', 'elbow', 'curved'];
const GAP = 6;            // world units between an object's edge and the arrow's end
const STUB = 24;          // how far an elbow leaves an edge before it turns
const CURVE_STEPS = 24;   // segments a curve is measured with for hits and bounds

let store = null;
/** The board the arrows look their objects up in. Set once by the app. */
export function useConnectorStore(s) { store = s; }

const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const gone = (o) => !o || o.hidden || (o.type === 'curtain' && o.revealed);

/** The box an end is attached to right now, or null for a free end. */
export function endBox(end) {
  if (!end || !store) return null;
  const objs = store.doc.objects;
  if (end.group) {
    let box = null;
    for (const id of store.doc.order) {
      const o = objs[id];
      if (!o || o.groupId !== end.group || o.type === 'connector' || gone(o)) continue;
      const b = worldBounds(o);
      box = box ? {
        x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
        w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
        h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y)
      } : { ...b };
    }
    return box;
  }
  if (end.id) {
    const o = objs[end.id];
    if (gone(o) || o.type === 'connector') return null;
    return worldBounds(o);
  }
  return null;
}

/** Is this end holding on to something that is on the board right now? */
export const isAttached = (end) => !!endBox(end);

/**
 * Where a line from the middle of `box` towards `aim` leaves the box, pushed
 * GAP further out. Falls back to the middle of the nearest side when `aim` is
 * inside the box (two overlapping objects).
 */
function borderPoint(box, aim, gap = GAP) {
  const c = center(box);
  const dx = aim.x - c.x, dy = aim.y - c.y;
  const hw = box.w / 2 + gap, hh = box.h / 2 + gap;
  if (!dx && !dy) return { x: c.x + hw, y: c.y };
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  if (t >= 1) {
    // the point aimed at is inside: leave by the side facing it
    return Math.abs(dx) / hw > Math.abs(dy) / hh
      ? { x: c.x + Math.sign(dx) * hw, y: c.y }
      : { x: c.x, y: c.y + Math.sign(dy) * hh };
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/*
 * Lanes: several straight arrows between the same two things.
 *
 * A straight arrow runs from the middle of one box towards the middle of the other, so a second
 * arrow between the same pair - A to B again, or B back to A - lay exactly on top of the first,
 * and two arrows read as one line with a head at each end. They are now laid side by side, LANE
 * apart, centred on the line between the two middles, like the lanes of a road: one arrow alone is
 * exactly where it always was. Only straight arrows holding a thing at BOTH ends take a lane; a
 * curved or elbow arrow already has its own path, and a loose end goes where it was put.
 */
const LANE = 18;
const endKey = (e) => (e && e.id ? 'i:' + e.id : e && e.group ? 'g:' + e.group : null);
const pairOf = (o) => {
  const ka = endKey(o.a), kb = endKey(o.b);
  return ka && kb && ka !== kb ? (ka < kb ? ka + '|' + kb : kb + '|' + ka) : null;
};
let lanesCache = { rev: -1, doc: null, map: null };
/** pair -> the straight, both-ends-held arrows between it, in board order. Rebuilt when the board changes. */
function lanesFor(pair) {
  if (!store || !pair) return null;
  const doc = store.doc;
  if (lanesCache.rev !== store.rev || lanesCache.doc !== doc) {
    const map = new Map();
    for (const id of doc.order) {
      const o = doc.objects[id];
      if (!o || o.type !== 'connector' || (ROUTES.includes(o.route) ? o.route : 'straight') !== 'straight') continue;
      if (!endBox(o.a) || !endBox(o.b)) continue;
      const k = pairOf(o);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(o.id);
    }
    lanesCache = { rev: store.rev, doc, map };
  }
  return lanesCache.map.get(pair) || null;
}

/** Where a line from `from` towards `to` leaves `box` (pushed GAP out), or null if `from` is not inside it. */
function rayExit(box, from, to, gap = GAP) {
  const x0 = box.x - gap, x1 = box.x + box.w + gap, y0 = box.y - gap, y1 = box.y + box.h + gap;
  if (from.x < x0 || from.x > x1 || from.y < y0 || from.y > y1) return null;
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len, uy = dy / len;
  const tx = ux > 0 ? (x1 - from.x) / ux : ux < 0 ? (x0 - from.x) / ux : Infinity;
  const ty = uy > 0 ? (y1 - from.y) / uy : uy < 0 ? (y0 - from.y) / uy : Infinity;
  const t = Math.min(tx, ty);
  return { x: from.x + ux * t, y: from.y + uy * t };
}

/** Which side of `box` faces `aim`: 'e', 'w', 'n' or 's'. */
function sideFacing(box, aim) {
  const c = center(box);
  const dx = (aim.x - c.x) / (box.w / 2 + 1), dy = (aim.y - c.y) / (box.h / 2 + 1);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : (dy >= 0 ? 's' : 'n');
}
const DIR = { e: { x: 1, y: 0 }, w: { x: -1, y: 0 }, s: { x: 0, y: 1 }, n: { x: 0, y: -1 } };
function sidePoint(box, side) {
  const c = center(box);
  if (side === 'e') return { x: box.x + box.w + GAP, y: c.y };
  if (side === 'w') return { x: box.x - GAP, y: c.y };
  if (side === 's') return { x: c.x, y: box.y + box.h + GAP };
  return { x: c.x, y: box.y - GAP };
}

/** The right-angled path from pA (leaving along dA) to pB (arriving against dB). */
function elbowPath(pA, dA, pB, dB) {
  const sA = { x: pA.x + dA.x * STUB, y: pA.y + dA.y * STUB };
  const sB = { x: pB.x + dB.x * STUB, y: pB.y + dB.y * STUB };
  const horizA = dA.x !== 0, horizB = dB.x !== 0;
  let pts;
  if (horizA && horizB) {
    const ahead = dA.x > 0 ? sB.x >= sA.x : sB.x <= sA.x;
    if (ahead && dA.x === -dB.x) {
      const mx = (pA.x + pB.x) / 2;
      pts = [pA, { x: mx, y: pA.y }, { x: mx, y: pB.y }, pB];
    } else {
      const my = (pA.y + pB.y) / 2;
      const x1 = dA.x === dB.x ? (dA.x > 0 ? Math.max(sA.x, sB.x) : Math.min(sA.x, sB.x)) : null;
      pts = x1 != null
        ? [pA, { x: x1, y: pA.y }, { x: x1, y: pB.y }, pB]
        : [pA, sA, { x: sA.x, y: my }, { x: sB.x, y: my }, sB, pB];
    }
  } else if (!horizA && !horizB) {
    const ahead = dA.y > 0 ? sB.y >= sA.y : sB.y <= sA.y;
    if (ahead && dA.y === -dB.y) {
      const my = (pA.y + pB.y) / 2;
      pts = [pA, { x: pA.x, y: my }, { x: pB.x, y: my }, pB];
    } else {
      const mx = (pA.x + pB.x) / 2;
      const y1 = dA.y === dB.y ? (dA.y > 0 ? Math.max(sA.y, sB.y) : Math.min(sA.y, sB.y)) : null;
      pts = y1 != null
        ? [pA, { x: pA.x, y: y1 }, { x: pB.x, y: y1 }, pB]
        : [pA, sA, { x: mx, y: sA.y }, { x: mx, y: sB.y }, sB, pB];
    }
  } else if (horizA) {
    // leave sideways, arrive from above or below: one corner, if it is ahead of both
    const corner = { x: pB.x, y: pA.y };
    if ((corner.x - pA.x) * dA.x > 0 && (corner.y - pB.y) * dB.y > 0) pts = [pA, corner, pB];
    else pts = [pA, sA, { x: sA.x, y: sB.y }, sB, pB];
  } else {
    const corner = { x: pA.x, y: pB.y };
    if ((corner.y - pA.y) * dA.y > 0 && (corner.x - pB.x) * dB.x > 0) pts = [pA, corner, pB];
    else pts = [pA, sA, { x: sB.x, y: sA.y }, sB, pB];
  }
  // drop repeated and straight-through points
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      const r = out[out.length - 2];
      const collinear = (Math.abs(r.x - q.x) < 0.01 && Math.abs(q.x - p.x) < 0.01) || (Math.abs(r.y - q.y) < 0.01 && Math.abs(q.y - p.y) < 0.01);
      if (collinear) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** The free direction an unattached end arrives from: along the main axis towards it. */
function freeDir(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? -1 : 1, y: 0 } : { x: 0, y: dy >= 0 ? -1 : 1 };
}

const quad = (p0, c, p1, t) => ({
  x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x,
  y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y
});

/** Where the curve's control point sits for a chord p0-p1 and a bend. */
function control(p0, p1, bend) {
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  return { x: mx - dy * bend, y: my + dx * bend };
}
export const DEFAULT_BEND = 0.25;

/**
 * The arrow as it should be drawn now.
 *
 * Returns the points it runs through (a polyline; a curve is sampled), the
 * control point of a curve, the two ends, the direction each arrowhead points,
 * and the bounding box with room for the heads. Also writes the ends' current
 * places back onto the arrow, so a saved board, an export, or the end of an
 * object that is later deleted all have them.
 */
export function route(o) {
  const boxA = endBox(o.a), boxB = endBox(o.b);
  const refA = boxA ? center(boxA) : { x: o.a?.x ?? 0, y: o.a?.y ?? 0 };
  const refB = boxB ? center(boxB) : { x: o.b?.x ?? 0, y: o.b?.y ?? 0 };
  const kind = ROUTES.includes(o.route) ? o.route : 'straight';
  let pts, ctrl = null, pA, pB;

  if (kind === 'elbow') {
    let dA, dB;
    if (boxA) { const s = sideFacing(boxA, refB); pA = sidePoint(boxA, s); dA = DIR[s]; }
    else { pA = refA; }
    if (boxB) { const s = sideFacing(boxB, refA); pB = sidePoint(boxB, s); dB = DIR[s]; }
    else { pB = refB; }
    // a free end leaves (or arrives) along whichever axis the other end mostly lies on
    if (!dA) dA = freeDir(pB, pA);
    if (!dB) dB = freeDir(pA, pB);
    /*
     * Two things roughly in line with each other, facing: run the arrow
     * straight across instead of with a tiny step in it - through the middle
     * of the stretch the two boxes share.
     */
    if (boxA && boxB && dA.x === -dB.x && dA.y === -dB.y) {
      if (dA.y) {
        const lo = Math.max(boxA.x, boxB.x), hi = Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
        if (hi - lo >= 12 && Math.abs(pA.x - pB.x) > 0.5) { const x = (lo + hi) / 2; pA = { x, y: pA.y }; pB = { x, y: pB.y }; }
      } else {
        const lo = Math.max(boxA.y, boxB.y), hi = Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
        if (hi - lo >= 12 && Math.abs(pA.y - pB.y) > 0.5) { const y = (lo + hi) / 2; pA = { x: pA.x, y }; pB = { x: pB.x, y }; }
      }
    }
    pts = elbowPath(pA, dA, pB, dB);
  } else if (kind === 'curved') {
    const bend = Number.isFinite(o.bend) ? o.bend : DEFAULT_BEND;
    // The bend is measured from the line between the two objects' middles, so
    // it stays put as the ends slide round; each end leaves its object
    // heading for the curve's control point, the way the curve bends.
    ctrl = control(refA, refB, bend);
    pA = boxA ? borderPoint(boxA, ctrl) : refA;
    pB = boxB ? borderPoint(boxB, ctrl) : refB;
    pts = [];
    for (let i = 0; i <= CURVE_STEPS; i++) pts.push(quad(pA, ctrl, pB, i / CURVE_STEPS));
  } else {
    pA = boxA ? borderPoint(boxA, refB) : refA;
    pB = boxB ? borderPoint(boxB, refA) : refB;
    // more than one straight arrow between these two things: this one keeps to its own lane
    const pair = boxA && boxB ? pairOf(o) : null;
    const lane = pair ? lanesFor(pair) : null;
    const i = lane ? lane.indexOf(o.id) : -1;
    if (lane && lane.length > 1 && i >= 0) {
      // the same sideways direction for every arrow of the pair, whichever way each one points
      const [first] = pair.split('|');
      const fromRef = endKey(o.a) === first ? refA : refB, toRef = fromRef === refA ? refB : refA;
      const dx = toRef.x - fromRef.x, dy = toRef.y - fromRef.y, len = Math.hypot(dx, dy) || 1;
      const off = (i - (lane.length - 1) / 2) * LANE;
      const nx = (-dy / len) * off, ny = (dx / len) * off;
      const sA = { x: refA.x + nx, y: refA.y + ny }, sB = { x: refB.x + nx, y: refB.y + ny };
      const eA = rayExit(boxA, sA, sB), eB = rayExit(boxB, sB, sA);
      if (eA && eB) { pA = eA; pB = eB; }
    }
    pts = [pA, pB];
  }

  // the arrowheads point along the last stretch of line into each end
  const tailFrom = ctrl || pts[1] || pB;
  const headFrom = ctrl || pts[pts.length - 2] || pA;
  const lw = o.lineWidth || 3;
  const b = bboxOfPoints(pts, headSize(lw) + lw + 2);

  // remember where the ends are now
  if (o.a) { o.a.x = pA.x; o.a.y = pA.y; }
  if (o.b) { o.b.x = pB.x; o.b.y = pB.y; }
  o.x = b.x; o.y = b.y; o.w = b.w; o.h = b.h;

  return { kind, pts, ctrl, a: pA, b: pB, tailFrom, headFrom, bbox: b, attachedA: !!boxA, attachedB: !!boxB };
}

/** The arrow's bounding box, worked out from where its objects are now. */
export function connectorBounds(o) {
  try { return route(o).bbox; } catch { return { x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0 }; }
}

/** Is world point `p` on the arrow (within `tol`)? */
export function hitConnector(o, p, tol = 6) {
  const r = route(o);
  const reach = Math.max(tol, (o.lineWidth || 3) / 2 + 3);
  for (let i = 1; i < r.pts.length; i++) if (distToSegment(p, r.pts[i - 1], r.pts[i]) <= reach) return true;
  return false;
}

/** The point halfway along the arrow - where the bend handle sits. */
export function midPoint(o) {
  const r = route(o);
  if (r.ctrl) return quad(r.a, r.ctrl, r.b, 0.5);
  // halfway along the path's length
  let total = 0;
  for (let i = 1; i < r.pts.length; i++) total += Math.hypot(r.pts[i].x - r.pts[i - 1].x, r.pts[i].y - r.pts[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < r.pts.length; i++) {
    const p = r.pts[i - 1], q = r.pts[i];
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l >= left && l > 0) return { x: p.x + (q.x - p.x) * (left / l), y: p.y + (q.y - p.y) * (left / l) };
    left -= l;
  }
  return { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 };
}

/**
 * The bend that puts the middle of the curve through `p`.
 *
 * A quadratic curve passes halfway to its control point, so the control point
 * goes twice as far out as the point being dragged.
 */
export function bendThrough(o, p) {
  const boxA = endBox(o.a), boxB = endBox(o.b);
  const refA = boxA ? center(boxA) : { x: o.a?.x ?? 0, y: o.a?.y ?? 0 };
  const refB = boxB ? center(boxB) : { x: o.b?.x ?? 0, y: o.b?.y ?? 0 };
  const dx = refB.x - refA.x, dy = refB.y - refA.y, len2 = dx * dx + dy * dy;
  if (len2 < 1) return 0;
  const m = { x: (refA.x + refB.x) / 2, y: (refA.y + refB.y) / 2 };
  // The middle of a quadratic curve is a quarter of each end plus half the
  // control point. The ends depend a little on where the control point is,
  // so settle it in a few rounds.
  let c = { x: 2 * p.x - m.x, y: 2 * p.y - m.y };
  for (let i = 0; i < 6; i++) {
    const pA = boxA ? borderPoint(boxA, c) : refA;
    const pB = boxB ? borderPoint(boxB, c) : refB;
    c = { x: 2 * p.x - (pA.x + pB.x) / 2, y: 2 * p.y - (pA.y + pB.y) / 2 };
  }
  // only the part across the line between the objects is a bend
  return clamp(((c.x - m.x) * -dy + (c.y - m.y) * dx) / len2, -2.5, 2.5);
}

/* ---------- drawing ---------- */
/** Arrowheads a little bolder than the plain arrow shape's, so a thin arrow still reads. */
export const headSize = (lw) => lw * 3.4 + 4;

function arrowHead(ctx, from, to, size) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(a - 0.42) * size, to.y - Math.sin(a - 0.42) * size);
  ctx.lineTo(to.x - Math.cos(a + 0.42) * size, to.y - Math.sin(a + 0.42) * size);
  ctx.closePath();
  ctx.fill();
}

/** Draw the arrow in world space. `paint` turns its stored colour into the colour to draw. */
export function drawConnector(ctx, o, paint = (c) => c) {
  const r = route(o);
  const colour = paint(o.stroke || '#201f1e');
  const lw = o.lineWidth || 3;
  const size = headSize(lw);
  const heads = o.heads || 'end';
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (o.dash) ctx.setLineDash(o.dash === 'dot' ? [1, lw * 2.2] : [lw * 3, lw * 2.2]);
  // stop the line short of each arrowhead so a thick line does not poke through its point
  const pts = r.pts.map((p) => ({ ...p }));
  const trim = (end, from) => {
    const d = Math.hypot(end.x - from.x, end.y - from.y);
    if (d < 1) return;
    const k = Math.min(size * 0.6, d * 0.9) / d;
    end.x -= (end.x - from.x) * k; end.y -= (end.y - from.y) * k;
  };
  if ((heads === 'end' || heads === 'both') && pts.length > 1) trim(pts[pts.length - 1], r.headFrom);
  if (heads === 'both' && pts.length > 1) trim(pts[0], r.tailFrom);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (r.ctrl) ctx.quadraticCurveTo(r.ctrl.x, r.ctrl.y, pts[pts.length - 1].x, pts[pts.length - 1].y);
  else for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (heads === 'end' || heads === 'both') arrowHead(ctx, r.headFrom, r.b, size);
  if (heads === 'both') arrowHead(ctx, r.tailFrom, r.a, size);
  ctx.restore();
}

/** The arrow as an SVG path (plus heads), for vector export. */
export function connectorSvg(o) {
  const r = route(o);
  const lw = o.lineWidth || 3;
  const colour = o.stroke || '#201f1e';
  const f = (n) => n.toFixed(1);
  const d = r.ctrl
    ? `M${f(r.a.x)} ${f(r.a.y)} Q${f(r.ctrl.x)} ${f(r.ctrl.y)} ${f(r.b.x)} ${f(r.b.y)}`
    : r.pts.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join(' ');
  const dash = o.dash ? ` stroke-dasharray="${o.dash === 'dot' ? `1 ${lw * 2.2}` : `${lw * 3} ${lw * 2.2}`}"` : '';
  const head = (from, to) => {
    const a = Math.atan2(to.y - from.y, to.x - from.x), s = headSize(lw);
    const p1 = { x: to.x - Math.cos(a - 0.42) * s, y: to.y - Math.sin(a - 0.42) * s };
    const p2 = { x: to.x - Math.cos(a + 0.42) * s, y: to.y - Math.sin(a + 0.42) * s };
    return `<polygon points="${f(to.x)},${f(to.y)} ${f(p1.x)},${f(p1.y)} ${f(p2.x)},${f(p2.y)}" fill="${colour}"/>`;
  };
  const heads = o.heads || 'end';
  return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round"${dash}/>` +
    (heads === 'end' || heads === 'both' ? head(r.headFrom, r.b) : '') +
    (heads === 'both' ? head(r.tailFrom, r.a) : '');
}

/* ---------- what an end can grab ---------- */
/**
 * The thing an arrow end dropped at `p` would hold on to, as an end spec
 * ({ id } or { group }), or null. The topmost thing whose box the point is in
 * (with a little slack), never another arrow, a lifted cover or loose ink. A
 * member of a group gives the whole group, unless that group is open for
 * editing, which is the one time its members are separate things.
 */
export function targetAt(s, p, slack = 8, { except = null, openGroup = null } = {}) {
  const order = s.doc.order;
  for (let i = order.length - 1; i >= 0; i--) {
    const o = s.doc.objects[order[i]];
    if (!o || o.type === 'connector' || gone(o) || o.id === except) continue;
    // Handwriting is not a thing to point at: an arrow drawn past some ink
    // must not grab it. Ink grouped with other things is part of that group.
    if (o.type === 'stroke' && !(o.groupId && o.groupId !== openGroup)) continue;
    // Nor is a line. Its box is just the rectangle its two ends happen to span, so holding on to it
    // pulled the new line's end to the edge of that box - near the line's middle, nowhere near
    // where it was put (issue #47). A line's ENDS are what a new line meets; see lineEnds().
    if (o.type === 'shape' && LINEAR.has(o.kind) && !(o.groupId && o.groupId !== openGroup)) continue;
    const b = worldBounds(o);
    if (p.x < b.x - slack || p.x > b.x + b.w + slack || p.y < b.y - slack || p.y > b.y + b.h + slack) continue;
    if (o.groupId && o.groupId !== openGroup) return { group: o.groupId };
    return { id: o.id };
  }
  return null;
}

const LINEAR = new Set(['line', 'arrow', 'doubleArrow']);

/**
 * The two ends of every line on the board: the line shapes (turned with their shape, if turned)
 * and the free or attached ends of every arrow. A new line started or finished within reach of
 * one of these lands exactly on it, so lines meet - a triangle drawn from three lines closes.
 */
export function lineEnds(s) {
  const out = [];
  for (const id of s.doc.order) {
    const o = s.doc.objects[id];
    if (!o || gone(o)) continue;
    if (o.type === 'shape' && LINEAR.has(o.kind)) {
      const ends = [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }];
      const r = o.rotation || 0;
      if (r) {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2, c = Math.cos(r), sn = Math.sin(r);
        for (const e of ends) { const dx = e.x - cx, dy = e.y - cy; e.x = cx + dx * c - dy * sn; e.y = cy + dx * sn + dy * c; }
      }
      out.push(...ends);
    } else if (o.type === 'connector') {
      // Only an arrow's FREE ends. An end holding a box sits just outside that box, right where the
      // next arrow out of the same box would be started - and meeting it there would leave that
      // second arrow loose instead of holding the box like the first.
      try {
        const r = route(o);
        if (r && r.a && !r.attachedA) out.push({ x: r.a.x, y: r.a.y });
        if (r && r.b && !r.attachedB) out.push({ x: r.b.x, y: r.b.y });
      } catch { /* an arrow that cannot be routed has no ends to meet */ }
    }
  }
  return out;
}

export const sameTarget = (u, v) => !!u && !!v && ((u.id && u.id === v.id) || (u.group && u.group === v.group));

/** The four dots a new arrow can be dragged out of, round an object's box. */
export function dotsFor(box, offsetWorld) {
  const c = center(box);
  return {
    n: { x: c.x, y: box.y - offsetWorld },
    e: { x: box.x + box.w + offsetWorld, y: c.y },
    s: { x: c.x, y: box.y + box.h + offsetWorld },
    w: { x: box.x - offsetWorld, y: c.y }
  };
}

/** Does this arrow hold on to `id` (or a group `id` belongs to)? */
export function holds(o, objOrId, groupId) {
  const id = typeof objOrId === 'string' ? objOrId : objOrId?.id;
  const gid = typeof objOrId === 'string' ? groupId : objOrId?.groupId;
  return [o.a, o.b].some((e) => e && ((e.id && e.id === id) || (e.group && gid && e.group === gid)));
}
