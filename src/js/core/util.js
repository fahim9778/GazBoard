// Small shared helpers: ids, geometry, colour, text layout.

export const uid = (p = 'o') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

export function rotatePoint(px, py, cx, cy, a) {
  const c = Math.cos(a), s = Math.sin(a), dx = px - cx, dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

export function bboxOfPoints(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

export function unionBox(a, b) {
  if (!a) return b; if (!b) return a;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const boxesIntersect = (a, b) => !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
export const boxContains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const pointInBox = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(points, tol) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Chaikin-style smoothing used for wet ink. */
export function smoothPoints(pts, iterations = 1) {
  let out = pts;
  for (let k = 0; k < iterations; k++) {
    if (out.length < 3) return out;
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, p: (a.p + b.p) / 2 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, p: (a.p + b.p) / 2 });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

export function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function readableText(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.6 ? '#201f1e' : '#ffffff';
}

export function hsl(h, s, l) { return `hsl(${h} ${s}% ${l}%)`; }

/** Word-wrap `text` into lines that fit `maxWidth` for the current ctx font. */
/**
 * Break a run of text that has nowhere to break.
 *
 * Wrapping normally happens at spaces, but a long unbroken run - a URL, a file
 * name, or someone leaning on the keyboard - has none, so it used to be laid
 * out as one line however wide the box was and simply ran off the edge of the
 * sticky note. When a piece will not fit whole, it is cut by character
 * instead. The cut point is found by halving rather than by walking one letter
 * at a time, so a long paste stays cheap to lay out.
 */
function breakUnbreakable(ctx, piece, maxWidth, lines) {
  let rest = piece;
  while (rest.length > 1 && ctx.measureText(rest).width > maxWidth) {
    let lo = 1, hi = rest.length - 1, cut = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.measureText(rest.slice(0, mid)).width <= maxWidth) { cut = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return rest;
}

export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw) { lines.push(''); continue; }
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      const test = line + word;
      if (ctx.measureText(test).width > maxWidth && line.trim()) {
        lines.push(line.replace(/\s+$/, ''));
        line = breakUnbreakable(ctx, word.replace(/^\s+/, ''), maxWidth, lines);
      } else line = test;
    }
    line = breakUnbreakable(ctx, line, maxWidth, lines);
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

export function fitFontSize(ctx, text, maxW, maxH, family, weight, max = 96, min = 8) {
  let lo = min, hi = max, best = min;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    ctx.font = `${weight} ${mid}px ${family}`;
    const lines = wrapText(ctx, text, maxW);
    const h = lines.length * mid * 1.25;
    // Height alone is not enough: a line that cannot be broken can be wider
    // than the box at any size, and only the width test catches it.
    let widest = 0;
    for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
    if (h <= maxH && widest <= maxW) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

export const throttle = (fn, ms) => {
  let last = 0, timer = null, lastArgs = null;
  return (...a) => {
    lastArgs = a;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs); }, ms - (now - last));
  };
};

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
