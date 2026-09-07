// Ink geometry.
//
// A stroke is drawn as ONE stroked path down its centreline, not as a filled
// outline. That matters:
//
//   * A single ctx.stroke() rasterises the whole stroke once, so a highlighter
//     that crosses itself composites once and cannot darken at the overlap -
//     the blotches that started this rewrite.
//   * Curving through the MIDPOINTS of the input points keeps every segment
//     inside its control triangle, so the path can never overshoot or loop.
//     Offsetting a centreline into a left/right outline has no such guarantee:
//     at a sharp turn the two sides cross and the fill throws out a spike,
//     which is what put barbs on the letters.
//
// Width used to be constant along a whole stroke: the mean pressure set one
// weight and that was that. It matched a felt pen, and it meant that pressing
// harder in the middle of a word did nothing whatsoever - which is not what
// anybody means by pressure sensitivity, and people said so.
//
// Varying it does NOT mean going back to offsetting an outline. The rule above
// still holds and is still why letters have no barbs. Instead a stroke is cut
// into RUNS of neighbouring points that want a similar width, and each run is
// stroked down its own centreline, the same way the whole stroke used to be.
// Runs overlap by a point and the caps are round, so the joins are invisible.
// Opaque ink over opaque ink of the same colour is the same colour, so nothing
// darkens - and the highlighter, which is translucent and WOULD darken at an
// overlap, keeps the single-path route it always had.

import { clamp, dist } from './util.js';

const PRESSURE_FLOOR = 0.82;   // stroke weight at the lightest touch
const PRESSURE_RANGE = 0.36;   // ... plus this much at the heaviest

/*
 * The same idea for a width that varies WITHIN a stroke, but with room to see.
 *
 * These two are chosen so that a middling press - 0.5, which is what a mouse,
 * a finger and every stroke drawn before this reports - lands on exactly 1.0,
 * the width the stroke would have had anyway. So a board full of old ink looks
 * the way it always did, and only genuine pen pressure moves the line.
 */
const VARY_FLOOR = 0.55;
const VARY_RANGE = 0.90;

/** How many distinct widths a stroke is allowed. Enough to read as smooth,
 *  few enough that a page of handwriting is still a handful of draw calls. */
const WIDTH_STEPS = 7;

/** Pressure jitters sample to sample; the width people SEE should not. */
function smoothPressure(pts) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      sum += clamp(pts[j].p ?? 0.5, 0, 1); c++;
    }
    out[i] = sum / c;
  }
  return out;
}

/**
 * Does this stroke actually carry pressure, or is it all one number?
 *
 * A mouse reports nothing and gets 0.5 for every point; so does every stroke
 * saved before any of this existed. Those must keep taking the old single-path
 * route exactly as before - not because it is faster, though it is, but
 * because it is the only way to be certain a board drawn last year opens
 * looking the way its owner left it.
 */
export function hasPressureVariation(pts) {
  if (!pts || pts.length < 4) return false;
  let lo = 1, hi = 0;
  for (const q of pts) {
    const v = clamp(q.p ?? 0.5, 0, 1);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 0.08;
}

/** Light moving average - removes sensor jitter without rounding letterforms. */
function smoothPath(pts, passes = 1) {
  if (pts.length < 3) return pts;
  let cur = pts;
  for (let k = 0; k < passes; k++) {
    const next = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      next.push({
        x: (cur[i - 1].x + cur[i].x * 2 + cur[i + 1].x) / 4,
        y: (cur[i - 1].y + cur[i].y * 2 + cur[i + 1].y) / 4,
        p: cur[i].p
      });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** Drop points that sit on top of each other; they only add noise. */
function dedupe(pts, min) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (dist(out[out.length - 1], pts[i]) >= min) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}

/** Mean pressure over the stroke - sets its weight. */
export function strokeWeight(points, size, pressure = true) {
  if (!pressure || !points.length) return size;
  let sum = 0, n = 0;
  for (const p of points) { sum += clamp(p.p ?? 0.5, 0, 1); n++; }
  return size * (PRESSURE_FLOOR + (sum / n) * PRESSURE_RANGE);
}

/**
 * The centreline, curved through the midpoints of the samples.
 * @returns {Path2D}
 */
export function preparePoints(points, size) {
  return smoothPath(dedupe(points, Math.max(0.35, size * 0.08)), 1);
}

export function centrelinePath(points, size) {
  const path = new Path2D();
  if (!points || !points.length) return path;

  const pts = preparePoints(points, size);

  if (pts.length === 1) {                       // a dot
    path.moveTo(pts[0].x + 0.01, pts[0].y);
    path.lineTo(pts[0].x, pts[0].y);
    return path;
  }

  path.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) { path.lineTo(pts[1].x, pts[1].y); return path; }

  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    path.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  return path;
}

/** One run's path, built exactly the way centrelinePath builds the whole one. */
function runPath(pts) {
  const path = new Path2D();
  if (!pts.length) return path;
  path.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) { path.lineTo(pts[0].x + 0.01, pts[0].y); return path; }
  if (pts.length === 2) { path.lineTo(pts[1].x, pts[1].y); return path; }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    path.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  return path;
}

/**
 * A stroke cut into runs of similar width, each with its own centreline.
 *
 * Widths are quantised to a few steps so that neighbouring samples that want
 * 4.31 and 4.34 pixels end up in one run rather than two; without that, a
 * stroke would be one draw call per point and a page of handwriting would
 * crawl. Each run reaches one point back into the run before it, so the round
 * cap of one lands inside the body of the next and there is no seam.
 *
 * @returns {Array<{path: Path2D, width: number}>}
 */
export function pressureRuns(points, size) {
  const pts = preparePoints(points, size);
  if (pts.length < 2) return [{ path: runPath(pts), width: size }];

  const soft = smoothPressure(pts);
  const step = (i) => {
    const w = VARY_FLOOR + soft[i] * VARY_RANGE;
    // Quantise in the 0..1 space, then turn back into a width, so the steps
    // are evenly spaced however thick the pen is.
    const t = clamp((w - VARY_FLOOR) / VARY_RANGE, 0, 1);
    return Math.round(t * (WIDTH_STEPS - 1));
  };

  const runs = [];
  let start = 0;
  let bucket = step(0);
  const widthFor = (b) => size * (VARY_FLOOR + (b / (WIDTH_STEPS - 1)) * VARY_RANGE);

  for (let i = 1; i <= pts.length; i++) {
    const here = i < pts.length ? step(i) : -1;
    if (here === bucket) continue;
    // One point of overlap on each side, so consecutive runs share geometry
    // and the joins disappear under the round caps.
    const from = Math.max(0, start - 1);
    const to = Math.min(pts.length, i + 1);
    runs.push({ path: runPath(pts.slice(from, to)), width: widthFor(bucket) });
    start = i;
    bucket = here;
  }
  return runs;
}

/* Paths are stable once a stroke is committed, so keep the last one. */
const cache = new WeakMap();
const runCache = new WeakMap();

/** The runs for a committed stroke, kept the same way inkPath keeps its path. */
export function inkRuns(stroke) {
  const pts = stroke.points;
  if (!pts || !pts.length) return null;
  const size = stroke.width || 4;
  const hit = runCache.get(pts);
  if (hit && hit.len === pts.length && hit.size === size) return hit.runs;
  const runs = pressureRuns(pts, size);
  runCache.set(pts, { len: pts.length, size, runs });
  return runs;
}

export function inkPath(stroke) {
  const pts = stroke.points;
  if (!pts || !pts.length) return null;
  const size = stroke.width || 4;
  const hit = cache.get(pts);
  if (hit && hit.len === pts.length && hit.size === size) return hit.path;
  const path = centrelinePath(pts, size);
  cache.set(pts, { len: pts.length, size, path });
  return path;
}
