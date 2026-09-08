// Hit testing: which object is under the pointer, what falls inside a
// marquee or lasso, and which stroke a point eraser touches.

import { boundsOf, worldBounds } from './store.js';
import { distToSegment, pointInBox, pointInPolygon, rotatePoint, boxesIntersect, boxContains } from './util.js';
import { shapePath } from './render.js';

const scratch = document.createElement('canvas').getContext('2d');

/** Map a world point into an object's un-rotated local space. */
export function toLocal(o, p) {
  if (!o.rotation) return p;
  const b = boundsOf(o);
  return rotatePoint(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, -o.rotation);
}

export function hitObject(o, p, tol = 6) {
  const lp = toLocal(o, p);
  const b = boundsOf(o);

  if (o.type === 'stroke') {
    if (!pointInBox(lp, { x: b.x - tol, y: b.y - tol, w: b.w + tol * 2, h: b.h + tol * 2 })) return false;
    const r = Math.max(tol, (o.width || 4) / 2 + 2);
    const pts = o.points;
    if (pts.length === 1) return Math.hypot(pts[0].x - lp.x, pts[0].y - lp.y) <= r;
    for (let i = 1; i < pts.length; i++) if (distToSegment(lp, pts[i - 1], pts[i]) <= r) return true;
    return false;
  }

  if (o.type === 'shape') {
    if (!pointInBox(lp, { x: b.x - tol, y: b.y - tol, w: b.w + tol * 2, h: b.h + tol * 2 })) return false;
    const filled = o.fill && o.fill !== 'none';
    scratch.save();
    shapePath(scratch, o.kind, o.x, o.y, o.w, o.h);
    let hit = false;
    if (filled && o.kind !== 'line' && o.kind !== 'arrow' && o.kind !== 'doubleArrow') hit = scratch.isPointInPath(lp.x, lp.y);
    if (!hit) {
      scratch.lineWidth = Math.max((o.lineWidth || 3) + tol * 1.4, 8);
      hit = scratch.isPointInStroke(lp.x, lp.y);
    }
    scratch.restore();
    return hit;
  }

  return pointInBox(lp, { x: b.x - tol / 2, y: b.y - tol / 2, w: b.w + tol, h: b.h + tol });
}

/**
 * Topmost object at `p`, or null.
 *
 * Locked objects ARE returned: a click has to be able to reach one, otherwise
 * locking is a one-way trip with no way to select the thing and unlock it.
 * Everything that moves or deletes in bulk - marquee, lasso, eraser - skips
 * them instead, which is where the protection actually belongs.
 */
export function pick(store, p, tol = 6, { includeLocked = true } = {}) {
  const order = store.doc.order;
  for (let i = order.length - 1; i >= 0; i--) {
    const o = store.doc.objects[order[i]];
    if (!o || (o.locked && !includeLocked)) continue;
    if (hitObject(o, p, tol)) return o;
  }
  return null;
}

export function pickAll(store, p, tol = 6, { includeLocked = true } = {}) {
  const out = [];
  for (const o of store.objects) if (o && (includeLocked || !o.locked) && hitObject(o, p, tol)) out.push(o);
  return out.reverse();
}

/** Objects intersecting (or fully inside, when `contain`) a world rect. */
export function inBox(store, box, contain = false) {
  const b = normalizeBox(box);
  return store.objects.filter((o) => {
    if (!o || o.locked) return false;
    const ob = worldBounds(o);
    return contain ? boxContains(b, ob) : boxesIntersect(b, ob);
  });
}

/** Objects whose centre (or any stroke point) falls inside a lasso polygon. */
export function inLasso(store, poly) {
  if (poly.length < 3) return [];
  return store.objects.filter((o) => {
    if (!o || o.locked) return false;
    if (o.type === 'stroke') {
      let inside = 0;
      const step = Math.max(1, Math.floor(o.points.length / 12));
      for (let i = 0; i < o.points.length; i += step) if (pointInPolygon(o.points[i], poly)) inside++;
      return inside >= Math.max(1, Math.ceil(o.points.length / step / 2));
    }
    const b = worldBounds(o);
    const corners = [
      { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
      { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    ];
    return corners.filter((c) => pointInPolygon(c, poly)).length >= 3;
  });
}

/** Strokes crossed by an eraser segment. */
export function strokesAlong(store, a, b, radius) {
  const hits = [];
  const box = normalizeBox({ x: Math.min(a.x, b.x) - radius, y: Math.min(a.y, b.y) - radius, w: Math.abs(a.x - b.x) + radius * 2, h: Math.abs(a.y - b.y) + radius * 2 });
  // In place, not through the `objects` getter: that copies the whole document
  // into a fresh array, and this runs on every single pointer move of a scrub.
  const objs = store.doc.objects;
  for (const id of store.doc.order) {
    const o = objs[id];
    if (!o || o.locked) continue;
    const ob = worldBounds(o);
    if (!boxesIntersect(box, ob)) continue;
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(2, radius / 2)));
    for (let i = 0; i <= steps; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
      if (hitObject(o, p, radius)) { hits.push(o); break; }
    }
  }
  return hits;
}

export function normalizeBox(b) {
  return { x: b.w < 0 ? b.x + b.w : b.x, y: b.h < 0 ? b.y + b.h : b.y, w: Math.abs(b.w), h: Math.abs(b.h) };
}
