// Partial (point) erasing: cut the eraser's swept capsule out of a stroke and
// return the surviving runs of points.

import { distToSegment, dist, bboxOfPoints, uid, rotatePoint } from './util.js';
import { boundsOf } from './store.js';

/**
 * Insert interpolated points so a wide gap can't slip past the eraser.
 *
 * These are PROBES, not ink. They are marked so they can be taken out again
 * once the cut is made - see cutPoints(). They sit on the straight line between
 * two real samples, so removing one puts the geometry back exactly as it was.
 */
function densify(pts, maxGap) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = dist(a, b);
    if (d > maxGap) {
      const n = Math.min(64, Math.ceil(d / maxGap));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
          p: (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * t, probe: true });
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * Cut the segment a→b (radius r) out of `points`.
 * @returns {null | Array<Array<{x,y,p}>>} null when nothing was touched,
 *          otherwise the runs that survive (possibly an empty array).
 */
export function cutPoints(points, a, b, r) {
  const pts = densify(points, Math.max(0.75, r * 0.5));
  let touched = false;
  const keep = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const hit = distToSegment(pts[i], a, b) <= r;
    keep[i] = !hit;
    if (hit) touched = true;
  }
  if (!touched) return null;

  /*
   * Take the probes back out.
   *
   * Only the two at the ends of a run earn their place: those are the new cut
   * edges, and nothing else describes where the eraser stopped. Every other
   * probe lies on a straight line between two real samples, so dropping it
   * changes nothing about the shape - and KEEPING it, or worse simplifying the
   * whole run afterwards, rewrites points the eraser never went near. That is
   * what rounded off sharp corners the first time a stroke was erased: the ink
   * renderer curves through the midpoints of the samples, so a corner is only
   * as sharp as its neighbouring samples are close, and resampling moved them.
   */
  const finish = (run) => {
    if (run.length < 2) return;
    const kept = run.filter((p, i) => !p.probe || i === 0 || i === run.length - 1);
    if (kept.length < 2) return;
    runs.push(kept.map(({ probe, ...p }) => p));
  };

  const runs = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) cur.push(pts[i]);
    else { finish(cur); cur = []; }
  }
  finish(cur);
  return runs;
}

/** Rotation baked into the points, so fragments keep their place on the board. */
export function bakedPoints(stroke) {
  if (!stroke.rotation) return stroke.points;
  const b = boundsOf(stroke);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return stroke.points.map((p) => {
    const q = rotatePoint(p.x, p.y, cx, cy, stroke.rotation);
    return { x: q.x, y: q.y, p: p.p };
  });
}

/**
 * Split one stroke with the eraser.
 * @returns {null | Array<object>} null when untouched, otherwise the
 *          replacement stroke objects (empty array = fully erased).
 */
export function splitStroke(stroke, a, b, r) {
  const points = bakedPoints(stroke);
  const runs = cutPoints(points, a, b, r);
  if (runs === null) return null;

  const minLength = Math.max(1.2, r * 0.25);
  // No simplify pass. The runs already carry the original samples and nothing
  // else, and thinning them would move the very points the shape is made of.
  return runs
    .filter((run) => run.length > 1 && pathLength(run) >= minLength)
    .map((run) => ({
      ...structuredClone(stroke),
      id: uid('s'),
      rotation: 0,
      points: run.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), p: +(p.p ?? 0.5).toFixed(2) })),
      bbox: bboxOfPoints(run)
    }));
}

function pathLength(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += dist(pts[i - 1], pts[i]);
  return t;
}
