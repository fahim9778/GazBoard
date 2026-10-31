// Drawing a formula graph: the grid, the axes with their numbers, the curves,
// the marked points and the typeset labels - on the board, and in an SVG.
//
// Both are drawn from one list of pieces (graphScene), so what is exported is
// exactly what is on the board. The curves are worked out once for each state
// of the graph and kept, so panning and zooming the board costs only the
// drawing, never the maths.

import { computeGraph, keyPoints, niceStep, fmtNum } from './plot.js';
import { mathEntry, useGraphLabels } from './maths.js';

const cache = new Map();          // object id -> { sig, data }
const CAP = 200;

const FRAME = '#c8c6c4', GRID = '#edebe9', GRID_MAJOR = '#d2d0ce', AXIS = '#605e5c', NUM = '#605e5c';

function sigOf(o) {
  return JSON.stringify([o.exprs, o.xMin, o.xMax, o.yMin, o.yMax, o.tMin, o.tMax, o.params, Math.round(Math.abs(o.w) / 40), Math.round(Math.abs(o.h) / 40)]);
}

/** The curves and points of a graph, worked out once per state of it. */
export function graphData(o) {
  const sig = sigOf(o);
  const hit = cache.get(o.id);
  if (hit && hit.sig === sig) return hit.data;
  const pxW = Math.max(200, Math.min(1600, Math.abs(o.w) * 1.5)), pxH = Math.max(150, Math.min(1600, Math.abs(o.h) * 1.5));
  const g = sane(o);
  const res = computeGraph(g, pxW, pxH);
  const pts = keyPoints(g, res.curves);
  const data = { g, curves: res.curves, keys: pts, env: res.env, sliders: res.sliders };
  cache.set(o.id, { sig, data });
  while (cache.size > CAP) cache.delete(cache.keys().next().value);
  return data;
}

/** The ranges made sensible, whatever a file says: finite, the right way round, not zero wide. */
export function sane(o) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  let xMin = num(o.xMin, -6), xMax = num(o.xMax, 6), yMin = num(o.yMin, -4), yMax = num(o.yMax, 6);
  if (xMax < xMin) [xMin, xMax] = [xMax, xMin];
  if (yMax < yMin) [yMin, yMax] = [yMax, yMin];
  if (xMax - xMin < 1e-9) { xMin -= 1; xMax += 1; }
  if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
  let tMin = num(o.tMin, 0), tMax = num(o.tMax, Math.PI * 2);
  if (tMax <= tMin) tMax = tMin + Math.PI * 2;
  // a range of a billion turns would sample nothing useful: kept to a thousand
  if (tMax - tMin > 1000) tMax = tMin + 1000;
  const exprs = (Array.isArray(o.exprs) ? o.exprs : []).slice(0, 12).map((e) => ({ src: String(e && e.src || '').slice(0, 300), color: typeof e?.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : '#0063b1', on: e?.on !== false }));
  return { exprs, xMin, xMax, yMin, yMax, tMin, tMax, params: o.params && typeof o.params === 'object' ? o.params : {} };
}

/** Graph coordinates to board coordinates, for this box. */
export function mapper(o, g) {
  const x = Math.min(o.x, o.x + o.w), y = Math.min(o.y, o.y + o.h), w = Math.abs(o.w), h = Math.abs(o.h);
  return {
    x, y, w, h,
    X: (gx) => x + ((gx - g.xMin) / (g.xMax - g.xMin)) * w,
    Y: (gy) => y + h - ((gy - g.yMin) / (g.yMax - g.yMin)) * h,
    gx: (bx) => g.xMin + ((bx - x) / w) * (g.xMax - g.xMin),
    gy: (by) => g.yMin + ((y + h - by) / h) * (g.yMax - g.yMin)
  };
}

/**
 * Everything to draw, as simple pieces in board coordinates.
 * kinds: rect, line, path, text, dot, tex
 */
export function graphScene(o) {
  const data = graphData(o);
  const g = data.g;
  const m = mapper(o, g);
  const out = [];
  const fs = Math.max(8, Math.min(18, Math.min(m.w, m.h) / 26));      // the numbers' size, in board units
  const lw = Math.max(1.6, Math.min(m.w, m.h) / 170);
  out.push({ k: 'rect', x: m.x, y: m.y, w: m.w, h: m.h, fill: '#ffffff', stroke: FRAME, sw: 1 });
  out.push({ k: 'clip', x: m.x, y: m.y, w: m.w, h: m.h });
  // the grid: a line every round step, the axes darker
  const sx = niceStep(g.xMax - g.xMin, Math.max(4, m.w / (fs * 5))), sy = niceStep(g.yMax - g.yMin, Math.max(3, m.h / (fs * 3.5)));
  if (o.grid !== false) {
    for (let k = Math.ceil(g.xMin / sx); k * sx <= g.xMax + 1e-9; k++) if (k !== 0) out.push({ k: 'line', x1: m.X(k * sx), y1: m.y, x2: m.X(k * sx), y2: m.y + m.h, stroke: k % 5 ? GRID : GRID_MAJOR, sw: 1 });
    for (let k = Math.ceil(g.yMin / sy); k * sy <= g.yMax + 1e-9; k++) if (k !== 0) out.push({ k: 'line', x1: m.x, y1: m.Y(k * sy), x2: m.x + m.w, y2: m.Y(k * sy), stroke: k % 5 ? GRID : GRID_MAJOR, sw: 1 });
  }
  // the axes, where they are in view, and the numbers along them
  const ax = g.yMin <= 0 && g.yMax >= 0 ? m.Y(0) : null, ay = g.xMin <= 0 && g.xMax >= 0 ? m.X(0) : null;
  const numY = ax != null ? Math.min(m.y + m.h - fs * 0.3, ax + fs * 0.25) : m.y + m.h - fs * 1.3;
  const numX = ay != null ? Math.max(m.x + fs * 0.3, ay - fs * 0.35) : m.x + fs * 0.3;
  if (ax != null) out.push({ k: 'line', x1: m.x, y1: ax, x2: m.x + m.w, y2: ax, stroke: AXIS, sw: 1.4 });
  if (ay != null) out.push({ k: 'line', x1: ay, y1: m.y, x2: ay, y2: m.y + m.h, stroke: AXIS, sw: 1.4 });
  for (let k = Math.ceil(g.xMin / sx); k * sx <= g.xMax + 1e-9; k++) {
    if (k === 0 && ay != null) continue;
    const px = m.X(k * sx);
    if (px < m.x + fs || px > m.x + m.w - fs) continue;
    out.push({ k: 'text', x: px, y: numY, text: fmtNum(k * sx, 6), size: fs, fill: NUM, align: 'center', base: 'top' });
  }
  for (let k = Math.ceil(g.yMin / sy); k * sy <= g.yMax + 1e-9; k++) {
    if (k === 0 && ax != null) continue;
    const py = m.Y(k * sy);
    if (py < m.y + fs || py > m.y + m.h - fs) continue;
    out.push({ k: 'text', x: ay != null ? numX : numX, y: py, text: fmtNum(k * sy, 6), size: fs, fill: NUM, align: ay != null ? 'right' : 'left', base: 'middle' });
  }
  if (ax != null && ay != null) out.push({ k: 'text', x: ay - fs * 0.35, y: ax + fs * 0.25, text: '0', size: fs, fill: NUM, align: 'right', base: 'top' });
  // the curves
  for (const c of data.curves) {
    if (c.hidden || c.error) continue;
    if (c.point) { out.push({ k: 'dot', x: m.X(c.point[0]), y: m.Y(c.point[1]), r: lw * 2.2, fill: c.color, stroke: '#ffffff', sw: lw * 0.6 }); continue; }
    for (const p of c.paths) {
      const pts = new Array(p.length);
      for (let i = 0; i < p.length; i += 2) { pts[i] = m.X(p[i]); pts[i + 1] = m.Y(p[i + 1]); }
      out.push({ k: 'path', pts, stroke: c.color, sw: lw });
    }
  }
  // the points worth marking, and any pinned by a tap
  const marks = [];
  if (o.points !== false) for (const p of data.keys) marks.push({ ...p, color: data.curves[p.i]?.color || AXIS });
  for (const pin of Array.isArray(o.pins) ? o.pins : []) {
    const c = data.curves[pin.i];
    if (!c || c.hidden || c.error) continue;
    const y = c.fx ? c.fx(pin.x) : pin.y;
    if (Number.isFinite(pin.x) && Number.isFinite(y)) marks.push({ x: pin.x, y, kind: 'pin', i: pin.i, color: c.color });
  }
  const inView = marks.filter((p) => p.x >= g.xMin && p.x <= g.xMax && p.y >= g.yMin && p.y <= g.yMax);
  const labelAll = inView.length <= 12;
  for (const p of inView) {
    const bx = m.X(p.x), by = m.Y(p.y);
    out.push({ k: 'dot', x: bx, y: by, r: lw * (p.kind === 'pin' ? 2.2 : 1.8), fill: p.kind === 'pin' ? p.color : '#ffffff', stroke: p.color, sw: lw * 0.8 });
    if (labelAll || p.kind === 'pin') {
      const text = `(${fmtNum(p.x, 2)}, ${fmtNum(p.y, 2)})`;
      const right = bx < m.x + m.w * 0.75;
      out.push({ k: 'text', x: bx + (right ? 1 : -1) * lw * 3, y: by - lw * 2.5, text, size: fs * 0.9, fill: '#323130', align: right ? 'left' : 'right', base: 'bottom', halo: true });
    }
  }
  // each formula, typeset, beside its curve
  if (o.labels !== false) {
    const placed = [];
    let order = 0;
    for (const c of data.curves) {
      if (c.hidden || c.error || !c.tex) continue;
      const spot = labelSpot(c, g, m, placed, fs, order++);
      if (!spot) continue;
      placed.push(spot);
      out.push({ k: 'tex', tex: c.tex, color: c.color, x: spot.x, y: spot.y, h: fs * 1.55, align: spot.align });
    }
  }
  out.push({ k: 'unclip' });
  return { pieces: out, data, map: m, lw, fs };
}

/**
 * Where a curve's label goes: on a part of the curve inside the box, away
 * from the edges, and clear of the labels already placed. Each curve starts
 * looking at a different place along the x axis, so labels spread out instead
 * of piling up at one end.
 */
function labelSpot(c, g, m, placed, fs, order = 0) {
  let best = null;
  const want = g.xMin + (g.xMax - g.xMin) * [0.8, 0.25, 0.6, 0.4, 0.9, 0.12][order % 6];
  const lw = Math.min(m.w * 0.45, Math.max(fs * 4, (c.tex || '').length * fs * 0.42)), lh = fs * 1.7;
  const consider = (gx, gy) => {
    if (!(gx >= g.xMin && gx <= g.xMax && gy >= g.yMin && gy <= g.yMax)) return;
    const bx = m.X(gx), by = m.Y(gy);
    if (by < m.y + lh * 1.2 || by > m.y + m.h - lh || bx < m.x + fs * 2 || bx > m.x + m.w - fs * 2) return;
    const right = bx < m.x + m.w * 0.6;
    const x0 = right ? bx + fs * 0.6 : bx - fs * 0.6 - lw, y0 = by - fs * 0.5 - lh / 2;
    // a label that would run out of the box, or over another label, is a poor spot
    let score = Math.abs(gx - want) / (g.xMax - g.xMin);
    if (x0 < m.x + 4 || x0 + lw > m.x + m.w - 4) score += 3;
    for (const q of placed) if (x0 < q.x0 + q.w && x0 + lw > q.x0 && y0 < q.y0 + q.h && y0 + lh > q.y0) score += 10;
    if (!best || score < best.score) best = { x: right ? bx + fs * 0.6 : bx - fs * 0.6, y: by - fs * 0.5, align: right ? 'left' : 'right', score, x0, y0, w: lw, h: lh };
  };
  if (c.point) consider(c.point[0], c.point[1]);
  for (const p of c.paths) for (let i = 0; i < p.length; i += 4) consider(p[i], p[i + 1]);
  return best && best.score < 10 ? best : null;
}

/* ------------------------------------------------------------------ *
 * On the board
 * ------------------------------------------------------------------ */

export function drawGraph(ctx, o, onload, font) {
  if (Math.abs(o.w) < 4 || Math.abs(o.h) < 4) return;
  let scene;
  try { scene = graphScene(o); } catch { return; }
  ctx.save();
  for (const p of scene.pieces) {
    switch (p.k) {
      case 'rect':
        ctx.fillStyle = p.fill; ctx.fillRect(p.x, p.y, p.w, p.h);
        ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw; ctx.strokeRect(p.x, p.y, p.w, p.h);
        break;
      case 'clip': ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip(); break;
      case 'unclip': ctx.restore(); break;
      case 'line':
        ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw;
        ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke();
        break;
      case 'path': {
        ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.pts[0], p.pts[1]);
        for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1]);
        ctx.stroke();
        break;
      }
      case 'dot':
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.fill; ctx.fill();
        ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw; ctx.stroke();
        break;
      case 'text':
        ctx.font = `${p.size}px ${font}`;
        ctx.textAlign = p.align; ctx.textBaseline = p.base;
        if (p.halo) { ctx.lineWidth = p.size * 0.3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineJoin = 'round'; ctx.strokeText(p.text, p.x, p.y); }
        ctx.fillStyle = p.fill; ctx.fillText(p.text, p.x, p.y);
        break;
      case 'tex': {
        const e = mathEntry(p.tex, p.color, onload, false);
        if (e.status === 'ready' && e.img && e.h) {
          const k = p.h / e.h, w = e.w * k;
          const x = p.align === 'right' ? p.x - w : p.x, y = p.y - p.h / 2;
          ctx.fillStyle = 'rgba(255,255,255,.82)';
          ctx.fillRect(x - p.h * 0.12, y - p.h * 0.06, w + p.h * 0.24, p.h * 1.12);
          ctx.drawImage(e.img, x, y, w, p.h);
        }
        break;
      }
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * In an SVG
 * ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let clipSeq = 0;

/** The graph as SVG elements: lines and paths stay lines and paths; the labels are sharp pictures. */
export function graphSvg(o, rot, family, texPng) {
  const { pieces } = graphScene(o);
  const parts = [`<g${rot || ''}>`];
  let open = 0;
  for (const p of pieces) {
    switch (p.k) {
      case 'rect': parts.push(`<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${p.sw}"/>`); break;
      case 'clip': {
        const id = 'gbclip' + (++clipSeq);
        parts.push(`<clipPath id="${id}"><rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"/></clipPath><g clip-path="url(#${id})">`);
        open++;
        break;
      }
      case 'unclip': if (open) { parts.push('</g>'); open--; } break;
      case 'line': parts.push(`<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" stroke="${p.stroke}" stroke-width="${p.sw}"/>`); break;
      case 'path': {
        let d = `M${n(p.pts[0])} ${n(p.pts[1])}`;
        for (let i = 2; i < p.pts.length; i += 2) d += `L${n(p.pts[i])} ${n(p.pts[i + 1])}`;
        parts.push(`<path d="${d}" fill="none" stroke="${p.stroke}" stroke-width="${n(p.sw)}" stroke-linejoin="round" stroke-linecap="round"/>`);
        break;
      }
      case 'dot': parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.r)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${n(p.sw)}"/>`); break;
      case 'text': {
        const anchor = p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start';
        const base = p.base === 'top' ? 'hanging' : p.base === 'bottom' ? 'text-after-edge' : 'central';
        const halo = p.halo ? ' stroke="#ffffff" stroke-width="' + n(p.size * 0.3) + '" paint-order="stroke" stroke-linejoin="round"' : '';
        parts.push(`<text x="${n(p.x)}" y="${n(p.y)}" font-family="${family}" font-size="${n(p.size)}" fill="${p.fill}" text-anchor="${anchor}" dominant-baseline="${base}"${halo}>${esc(p.text)}</text>`);
        break;
      }
      case 'tex': {
        const e = mathEntry(p.tex, p.color, null, false);
        if (e.status === 'ready' && e.img && e.h) {
          const k = p.h / e.h, w = e.w * k;
          const x = p.align === 'right' ? p.x - w : p.x, y = p.y - p.h / 2;
          parts.push(`<rect x="${n(x - p.h * 0.12)}" y="${n(y - p.h * 0.06)}" width="${n(w + p.h * 0.24)}" height="${n(p.h * 1.12)}" fill="#ffffff" fill-opacity="0.82"/>`);
          parts.push(`<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(p.h)}" href="${texPng(e, w, p.h)}"><title>${esc(p.tex)}</title></image>`);
        }
        break;
      }
    }
  }
  while (open--) parts.push('</g>');
  parts.push('</g>');
  return parts.join('');
}

const n = (v) => (Math.round(v * 100) / 100).toString();

/** The typeset labels of every graph in `objects`, so an export can wait for them. */
export function graphLabels(o) {
  try {
    const d = graphData(o);
    if (o.labels === false) return [];
    return d.curves.filter((c) => !c.hidden && !c.error && c.tex).map((c) => ({ tex: c.tex, color: c.color }));
  } catch { return []; }
}

/**
 * The nearest point on a curve to a spot on the board, for pinning a point with a tap.
 * @returns {{i, x, y, d}|null}  graph coordinates and the distance in board units
 */
export function nearestOnCurve(o, bx, by) {
  const data = graphData(o);
  const m = mapper(o, data.g);
  let best = null;
  for (const c of data.curves) {
    if (c.hidden || c.error) continue;
    for (const p of c.paths) for (let i = 0; i < p.length; i += 2) {
      const d = Math.hypot(m.X(p[i]) - bx, m.Y(p[i + 1]) - by);
      if (!best || d < best.d) best = { i: c.i, x: p[i], y: p[i + 1], d };
    }
  }
  // a function of x: the exact point on it, at the x tapped
  if (best && data.curves[best.i].fx) {
    const f = data.curves[best.i].fx;
    const gx = m.gx(bx), gy = f(gx);
    if (Number.isFinite(gy) && Math.abs(m.Y(gy) - by) <= best.d + 2) best = { ...best, x: gx, y: gy, d: Math.abs(m.Y(gy) - by) };
  }
  return best;
}

useGraphLabels(graphLabels);
