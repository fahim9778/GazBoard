// Canvas painting: backgrounds, every object type, and the selection chrome.

import { boundsOf, worldBounds } from './store.js';
import { pageRects as worldPageRects } from './pages.js';
import { hexToRgba, readableText, wrapText, fitFontSize, clamp } from './util.js';
import { inkPath, inkRuns, strokeWeight, hasPressureVariation } from './ink.js';

import { fontStack } from '../ui/palettes.js';

export const FONT = fontStack('ui');
export const HAND_FONT = fontStack('hand');

/** Resolve an object's font id to a CSS stack. */
export const faceOf = (id) => fontStack(id || 'ui');

/* ---------- image cache ---------- */
const imgCache = new Map();
export function getImage(src, onload) {
  if (!src) return null;
  let rec = imgCache.get(src);
  if (!rec) {
    const img = new Image();
    rec = { img, ready: false };
    imgCache.set(src, rec);
    img.onload = () => { rec.ready = true; onload && onload(); };
    img.onerror = () => { rec.error = true; };
    img.src = src;
  }
  return rec.ready ? rec.img : null;
}

/* =================================================================== *
 *  Backgrounds
 * =================================================================== */
/**
 * Paints in SCREEN space, in CSS pixels. The caller must already have applied
 * the device-pixel-ratio transform - resetting to the identity matrix here
 * would paint CSS-pixel coordinates into a device-pixel buffer and leave the
 * right and bottom of the canvas unpainted on any HiDPI display.
 */
/**
 * The sheets, when the board is a pad rather than an infinite canvas.
 *
 * Drawn in screen space, like the background they sit on: white rectangles
 * with a soft shadow over a dimmed surround. The ruling belongs to the paper,
 * so it is anchored to each sheet's own top-left corner and clipped to it -
 * a continuous world grid would meet every page at a different offset and
 * look nothing like a pad.
 */
export function pageRects(pages, cam) {
  return worldPageRects(pages).map((r) => ({
    x: r.x * cam.z + cam.x, y: r.y * cam.z + cam.y, w: r.w * cam.z, h: r.h * cam.z
  }));
}

/** Kept for the single-sheet callers: the first sheet in screen space. */
export function pageRect(pages, cam) {
  return pageRects(pages, cam)[0] || null;
}

/** First grid line at or after `from`, on the lattice `origin + k*step`. */
const lineFrom = (origin, step, from) => origin + Math.ceil((from - origin) / step) * step;

function drawPattern(ctx, bg, cam, w, h, anchor, bounds) {
  const pattern = bg.pattern || 'none';
  if (pattern === 'none') return;

  const base = 40;                        // world spacing
  let step = base * cam.z;
  while (step < 14) step *= 2;            // keep it readable when zoomed out
  while (step > 120) step /= 2;
  const ax = anchor ? anchor.x : cam.x;
  const ay = anchor ? anchor.y : cam.y;
  const ox = ((ax % step) + step) % step;
  const oy = ((ay % step) + step) % step;
  const color = bg.patternColor || '#c8c6c4';

  // Only sweep the part of the canvas this sheet actually covers. Running the
  // full width and height once per sheet and leaning on the clip meant a pad
  // paid for its whole ruling as many times as it had visible pages.
  const x0 = bounds ? Math.max(0, bounds.x) : 0;
  const y0 = bounds ? Math.max(0, bounds.y) : 0;
  const x1 = bounds ? Math.min(w, bounds.x + bounds.w) : w;
  const y1 = bounds ? Math.min(h, bounds.y + bounds.h) : h;
  if (x1 <= x0 || y1 <= y0) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;

  if (pattern === 'grid' || pattern === 'lines' || pattern === 'columns') {
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    if (pattern !== 'lines') for (let x = lineFrom(ox, step, x0); x < x1; x += step) { ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); }
    if (pattern !== 'columns') for (let y = lineFrom(oy, step, y0); y < y1; y += step) { ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); }
    ctx.stroke();
  } else if (pattern === 'dots') {
    ctx.globalAlpha = 0.8;
    const r = clamp(step / 22, 0.8, 2.4);
    for (let x = lineFrom(ox, step, x0); x < x1; x += step) for (let y = lineFrom(oy, step, y0); y < y1; y += step) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  } else if (pattern === 'graph') {
    ctx.globalAlpha = 0.3;
    const small = step / 4;
    const sox = ((ax % small) + small) % small, soy = ((ay % small) + small) % small;
    ctx.beginPath();
    for (let x = lineFrom(sox, small, x0); x < x1; x += small) { ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); }
    for (let y = lineFrom(soy, small, y0); y < y1; y += small) { ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); }
    ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let x = lineFrom(ox, step, x0); x < x1; x += step) { ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); }
    for (let y = lineFrom(oy, step, y0); y < y1; y += step) { ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Paints in SCREEN space, in CSS pixels. The caller must already have applied
 * the device-pixel-ratio transform - resetting to the identity matrix here
 * would paint CSS-pixel coordinates into a device-pixel buffer and leave the
 * right and bottom of the canvas unpainted on any HiDPI display.
 */
export function drawBackground(ctx, bg, cam, w, h, pages = null) {
  ctx.save();

  const sheets = pages && pages.length ? pageRects(pages, cam) : [];
  if (!sheets.length) {
    ctx.fillStyle = bg.color || '#ffffff';
    ctx.fillRect(0, 0, w, h);
    drawPattern(ctx, bg, cam, w, h, null);
    ctx.restore();
    return;
  }

  // the desk the pad sits on
  ctx.fillStyle = shadeOf(bg.color || '#ffffff');
  ctx.fillRect(0, 0, w, h);

  for (const sheet of sheets) {
    if (sheet.x > w || sheet.y > h || sheet.x + sheet.w < 0 || sheet.y + sheet.h < 0) continue;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.20)';
    ctx.shadowBlur = Math.min(26, 10 + cam.z * 8);
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = bg.color || '#ffffff';
    ctx.fillRect(sheet.x, sheet.y, sheet.w, sheet.h);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(sheet.x, sheet.y, sheet.w, sheet.h);
    ctx.clip();
    drawPattern(ctx, bg, cam, w, h, { x: sheet.x, y: sheet.y }, sheet);
    ctx.restore();

    strokePageEdge(ctx, sheet);
  }
  ctx.restore();
}

/* =================================================================== *
 *  Ink
 * =================================================================== */
/** Gradient down the stroke for the rainbow and galaxy inks. */
function inkStyle(ctx, o) {
  if (!o.effect || o.effect === 'none') return o.color;
  const pts = o.points;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const g = len < 1
    ? ctx.createLinearGradient(a.x - 20, a.y, a.x + 20, a.y)
    : ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  const hue = o.hue || 0;
  const stops = 12;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    g.addColorStop(t,
      o.effect === 'rainbow'
        ? `hsl(${(hue + t * 320) % 360} 88% 54%)`
        : `hsl(${250 + Math.sin(t * Math.PI * 2 + hue) * 55} 72% ${38 + Math.sin(t * 6) * 9}%)`);
  }
  return g;
}

export function drawStroke(ctx, o) {
  const pts = o.points;
  if (!pts || !pts.length) return;
  const path = inkPath(o);
  if (!path) return;
  const highlighter = o.tool === 'highlighter';

  ctx.save();
  if (highlighter) {
    ctx.globalAlpha = o.opacity ?? 0.38;
    ctx.globalCompositeOperation = 'multiply';
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = inkStyle(ctx, o);

  /*
   * Two ways to lay this down, and which one is used is decided by the ink
   * itself rather than by a setting.
   *
   * A stroke that carries real pressure - a pen, on a machine with pressure
   * switched on - is drawn as runs of varying width, so pressing harder in the
   * middle of a word thickens the middle of the word. That is the thing people
   * mean by pressure sensitivity, and it did not used to happen: the mean of
   * the whole stroke set one width for the lot.
   *
   * Everything else goes down exactly as it always did, in one call. A mouse
   * reports no pressure, a finger reports none worth having, the highlighter
   * is translucent and would darken where a stroke crossed itself, and every
   * stroke saved before today has 0.5 written at every point. Those must not
   * change - a board drawn last year has to open looking like itself.
   */
  const varying = !highlighter && o.pressure !== false && hasPressureVariation(pts);
  if (varying) {
    /*
     * How big this stroke actually is on the glass, not in the document.
     *
     * Splitting a stroke into runs is only worth paying for when somebody can
     * see the result. Pulled back to a bird's-eye view the whole swing of a
     * pen is a fraction of one screen pixel, and paying for it on every object
     * at once is what made a big board crawl.
     */
    let scale = 1;
    try {
      const m = ctx.getTransform();
      scale = Math.hypot(m.a, m.b) || 1;
    } catch { scale = 1; }               // an old canvas without getTransform
    const runs = inkRuns(o, scale);
    for (const r of runs) { ctx.lineWidth = r.width; ctx.stroke(r.path); }
  } else {
    ctx.lineWidth = highlighter ? (o.width || 20) : strokeWeight(pts, o.width || 4, o.pressure !== false);
    ctx.stroke(path);                     // one call: no seams, no overlap darkening
  }

  if (o.effect === 'galaxy') {
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.lineWidth = Math.max(1, (o.width || 4) * 0.22);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([1, (o.width || 4) * 1.6]);
    ctx.stroke(path);
    ctx.restore();
  }
  ctx.restore();
}

/* =================================================================== *
 *  Shapes
 * =================================================================== */
export function shapePath(ctx, kind, x, y, w, h) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  ctx.beginPath();
  switch (kind) {
    case 'rect': ctx.rect(x, y, w, h); break;
    case 'roundRect': {
      const r = Math.min(Math.abs(w), Math.abs(h)) * 0.16;
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
      break;
    }
    case 'ellipse': ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2); break;
    case 'circle': { const r = Math.min(Math.abs(rx), Math.abs(ry)); ctx.arc(cx, cy, r, 0, Math.PI * 2); break; }
    case 'triangle': ctx.moveTo(cx, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); break;
    case 'rightTriangle': ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.closePath(); break;
    case 'diamond': ctx.moveTo(cx, y); ctx.lineTo(x + w, cy); ctx.lineTo(cx, y + h); ctx.lineTo(x, cy); ctx.closePath(); break;
    case 'pentagon': polygon(ctx, cx, cy, rx, ry, 5, -Math.PI / 2); break;
    case 'hexagon': polygon(ctx, cx, cy, rx, ry, 6, 0); break;
    case 'octagon': polygon(ctx, cx, cy, rx, ry, 8, Math.PI / 8); break;
    case 'star': {
      const n = 5;
      for (let i = 0; i < n * 2; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / n;
        const f = i % 2 ? 0.42 : 1;
        const px = cx + Math.cos(ang) * rx * f, py = cy + Math.sin(ang) * ry * f;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'cloud': {
      const bumps = [[0.18, 0.68, 0.20], [0.38, 0.42, 0.26], [0.62, 0.40, 0.24], [0.82, 0.66, 0.19], [0.5, 0.72, 0.28]];
      for (const [fx, fy, fr] of bumps) {
        const r = Math.min(Math.abs(w), Math.abs(h)) * fr;
        ctx.moveTo(x + w * fx + r, y + h * fy);
        ctx.arc(x + w * fx, y + h * fy, r, 0, Math.PI * 2);
      }
      break;
    }
    case 'line': ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); break;
    case 'arrow': case 'doubleArrow': {
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
      break;
    }
    default: ctx.rect(x, y, w, h);
  }
}

function polygon(ctx, cx, cy, rx, ry, n, rot) {
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI * 2) / n;
    const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function arrowHead(ctx, from, to, size, color) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(a - 0.42) * size, to.y - Math.sin(a - 0.42) * size);
  ctx.lineTo(to.x - Math.cos(a + 0.42) * size, to.y - Math.sin(a + 0.42) * size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawShape(ctx, o, hideText = false) {
  const { x, y, w, h } = o;
  ctx.save();
  if (o.fill && o.fill !== 'none') {
    ctx.fillStyle = o.fill;
    shapePath(ctx, o.kind, x, y, w, h);
    ctx.fill(o.kind === 'cloud' ? 'nonzero' : 'nonzero');
  }
  if (o.stroke && o.stroke !== 'none') {
    ctx.strokeStyle = o.stroke;
    ctx.lineWidth = o.lineWidth || 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (o.dash) ctx.setLineDash(o.dash === 'dot' ? [1, ctx.lineWidth * 2.2] : [ctx.lineWidth * 3, ctx.lineWidth * 2.2]);
    shapePath(ctx, o.kind, x, y, w, h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (o.kind === 'arrow' || o.kind === 'doubleArrow') {
      const size = (o.lineWidth || 3) * 3.4;
      arrowHead(ctx, { x, y }, { x: x + w, y: y + h }, size, o.stroke);
      if (o.kind === 'doubleArrow') arrowHead(ctx, { x: x + w, y: y + h }, { x, y }, size, o.stroke);
    }
  }
  if (o.text && !hideText) {
    const pad = 10;
    drawTextBlock(ctx, o.text, x + pad, y + pad, w - pad * 2, h - pad * 2, {
      color: o.textColor || '#201f1e', size: o.fontSize || 0, align: 'center', valign: 'middle',
      family: faceOf(o.font), weight: o.bold ? '600' : '400', italic: o.italic
    });
  }
  ctx.restore();
}

/* =================================================================== *
 *  Text blocks (shared by text boxes, notes, shapes, tables)
 * =================================================================== */
export function drawTextBlock(ctx, text, x, y, w, h, opt = {}) {
  if (!text) return;
  const family = opt.family || FONT;
  const weight = opt.weight || '400';
  const italic = opt.italic ? 'italic ' : '';
  let size = opt.size;
  if (!size) size = fitFontSize(ctx, text, w, h, family, weight, opt.maxSize || 72, opt.minSize || 10);
  ctx.save();
  ctx.font = `${italic}${weight} ${size}px ${family}`;
  ctx.fillStyle = opt.color || '#201f1e';
  ctx.textBaseline = 'top';
  const lines = wrapText(ctx, text, w);
  const lh = size * (opt.lineHeight || 1.28);
  const total = lines.length * lh;
  let ty = y;
  if (opt.valign === 'middle') ty = y + (h - total) / 2;
  else if (opt.valign === 'bottom') ty = y + h - total;
  const align = opt.align || 'left';
  ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
  const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
  for (const line of lines) {
    if (ty > y + h + lh) break;
    ctx.fillText(line, tx, ty);
    if (opt.underline) {
      const m = ctx.measureText(line);
      const lw = m.width;
      const lx = align === 'center' ? tx - lw / 2 : align === 'right' ? tx - lw : tx;
      ctx.fillRect(lx, ty + size * 1.05, lw, Math.max(1, size / 16));
    }
    ty += lh;
  }
  ctx.restore();
}

/* =================================================================== *
 *  Notes / text / images / tables
 * =================================================================== */
/*
 * How big a note is allowed to set its own type.
 *
 * A note's SIZE is chosen in screen pixels and converted to board units, so a
 * new note looks the same whatever the board is zoomed to - at 50% it is twice
 * as many board units across, and comes out the same size on screen. The type
 * inside it was capped at a flat 46 board units, which is not a screen measure
 * at all: at 50% that cap is 23 screen pixels inside a note that still looks
 * 200 wide, and at 200% it is 92. Same note, same words, type that changed size
 * with the zoom the note happened to be made at.
 *
 * Tying the cap to the note's own width fixes that, because the width is where
 * the zoom already went. The ratios are the old numbers at the old default
 * size, so a note made at 100% is unchanged to the pixel.
 */
export function noteTypeRange(o) {
  const w = Math.max(40, o.w || 200);
  return { max: Math.max(12, w * (46 / 200)), min: Math.max(6, w * (10 / 200)) };
}

export function drawNote(ctx, o, hideText = false) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = o.color || '#ffd94a';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(o.x, o.y, o.w, o.h, 4); else ctx.rect(o.x, o.y, o.w, o.h);
  ctx.fill();
  ctx.shadowColor = 'transparent';

  // subtle paper fold
  const g = ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h);
  g.addColorStop(0, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0.05)');
  ctx.fillStyle = g;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(o.x, o.y, o.w, o.h, 4); else ctx.rect(o.x, o.y, o.w, o.h);
  ctx.fill();

  const pad = Math.max(10, o.w * 0.08);
  const type = noteTypeRange(o);
  drawTextBlock(ctx, hideText ? '' : o.text, o.x + pad, o.y + pad, o.w - pad * 2, o.h - pad * 2, {
    color: o.textColor || readableText(o.color || '#ffd94a'),
    size: o.fontSize || 0, maxSize: type.max, minSize: type.min,
    align: o.align || 'center', valign: 'middle',
    family: faceOf(o.font),
    weight: o.bold ? '600' : '400', italic: o.italic, underline: o.underline
  });
  ctx.restore();
}

export function drawText(ctx, o, hideText = false) {
  if (o.background && o.background !== 'none') {
    ctx.save();
    ctx.fillStyle = o.background;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(o.x - 4, o.y - 4, o.w + 8, o.h + 8, 4); else ctx.rect(o.x - 4, o.y - 4, o.w + 8, o.h + 8);
    ctx.fill();
    ctx.restore();
  }
  drawTextBlock(ctx, hideText ? '' : o.text, o.x, o.y, o.w, o.h, {
    color: o.color || '#201f1e', size: o.fontSize || 24,
    align: o.align || 'left', valign: o.valign || 'top',
    family: faceOf(o.font),
    weight: o.bold ? '600' : '400', italic: o.italic, underline: o.underline
  });
}

export function drawImage(ctx, o, onload) {
  const img = getImage(o.src, onload);
  ctx.save();
  if (o.kind === 'page') {
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.shadowColor = 'transparent';
  }
  if (img) {
    ctx.drawImage(img, o.x, o.y, o.w, o.h);
  } else if (o.missing) {
    // The board points at a picture whose file is not there - most likely the
    // board travelled without the assets folder beside it. Say so, and hold the
    // space: the reference is kept, so putting the file back brings it back.
    ctx.fillStyle = '#faf9f8';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = '#c8c6c4';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
    ctx.setLineDash([]);
    ctx.fillStyle = '#a19f9d';
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('Picture not found', o.x + o.w / 2, o.y + o.h / 2);
  } else {
    ctx.fillStyle = '#edebe9';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.fillStyle = '#a19f9d';
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('Loading…', o.x + o.w / 2, o.y + o.h / 2);
  }
  if (o.kind === 'page') {
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
    if (o.label) {
      ctx.fillStyle = '#605e5c';
      ctx.font = `${Math.max(11, o.w * 0.022)}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(o.label, o.x, o.y - 8);
    }
  }
  ctx.restore();
}

export function drawTable(ctx, o, hideCell = null) {
  const cols = o.cols || 3, rows = o.rows || 3;
  const cw = o.w / cols, ch = o.h / rows;
  ctx.save();
  ctx.fillStyle = o.fill || '#ffffff';
  ctx.fillRect(o.x, o.y, o.w, o.h);
  if (o.headerRow) {
    ctx.fillStyle = o.headerColor || '#f3f2f1';
    ctx.fillRect(o.x, o.y, o.w, ch);
  }
  ctx.strokeStyle = o.stroke || '#605e5c';
  ctx.lineWidth = o.lineWidth || 2;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) { ctx.moveTo(o.x + c * cw, o.y); ctx.lineTo(o.x + c * cw, o.y + o.h); }
  for (let r = 0; r <= rows; r++) { ctx.moveTo(o.x, o.y + r * ch); ctx.lineTo(o.x + o.w, o.y + r * ch); }
  ctx.stroke();
  const cells = o.cells || {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const key = r + ',' + c;
    const t = cells[key];
    if (!t || key === hideCell) continue;
    drawTextBlock(ctx, t, o.x + c * cw + 6, o.y + r * ch + 6, cw - 12, ch - 12, {
      color: o.textColor || '#201f1e', size: o.fontSize || 0, maxSize: 26,
      align: 'center', valign: 'middle', family: FONT, weight: o.headerRow && r === 0 ? '600' : '400'
    });
  }
  ctx.restore();
}

/* =================================================================== *
 *  Dispatch
 * =================================================================== */
/**
 * @param {object|null} editing  the object whose text is currently being typed
 *   into, as { id, cell }. Its text is left OFF the canvas, because a textarea
 *   is showing the same words in the same place at the same size - and two
 *   copies a pixel or two apart read as a smeared double image. This used to be
 *   hidden by accident: the editor was an opaque white panel, so the canvas
 *   copy underneath was simply covered up. Making the panel see-through, which
 *   is what a text box should be, uncovered it.
 */
export function drawObject(ctx, o, onload, editing = null) {
  if (o.hidden) return;
  const mine = !!editing && editing.id === o.id;
  const hideText = mine && !editing.cell;
  const hideCell = mine ? (editing.cell || null) : null;
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  if (o.rotation) {
    const b = boundsOf(o);
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    ctx.rotate(o.rotation);
    ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
  }
  switch (o.type) {
    case 'stroke': drawStroke(ctx, o); break;
    case 'shape': drawShape(ctx, o, hideText); break;
    case 'note': drawNote(ctx, o, hideText); break;
    case 'text': drawText(ctx, o, hideText); break;
    case 'image': drawImage(ctx, o, onload); break;
    case 'table': drawTable(ctx, o, hideCell); break;
  }
  ctx.restore();
}

/* =================================================================== *
 *  Selection chrome (drawn in screen space)
 * =================================================================== */
export const HANDLE = 9;
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePositions(box) {
  const { x, y, w, h } = box;
  return {
    nw: { x, y }, n: { x: x + w / 2, y }, ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 }, se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h }, sw: { x, y: y + h }, w: { x, y: y + h / 2 },
    rot: { x: x + w / 2, y: y - 28 }
  };
}

/** A hairline around the sheet so the boundary reads even on a white board. */
function strokePageEdge(ctx, sheet) {
  ctx.save();
  ctx.strokeStyle = 'rgba(32,31,30,.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(sheet.x) + 0.5, Math.round(sheet.y) + 0.5, Math.round(sheet.w), Math.round(sheet.h));
  ctx.restore();
}

/** A touch darker than the paper, for the surround. */
function shadeOf(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
  if (!m) return '#e8e6e3';
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  const mix = (c) => Math.round(c * 0.90);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Screen space, CSS pixels - see the note on drawBackground. */
export function drawSelection(ctx, screenBox, opts = {}) {
  const { x, y, w, h } = screenBox;
  ctx.save();
  ctx.strokeStyle = '#0078d4';
  ctx.lineWidth = 1.5;
  ctx.setLineDash(opts.dashed ? [5, 4] : []);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  if (opts.handles !== false) {
    const pos = handlePositions(screenBox);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0078d4';
    ctx.lineWidth = 1.5;
    for (const k of HANDLES) {
      const p = pos[k];
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE / 2, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    if (opts.rotate !== false) {
      const p = pos.rot;
      ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE / 2 + 1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}

/** Small padlock at the top-left of a locked object, drawn in screen space. */
export function drawLockBadge(ctx, cam, o) {
  const b = worldBounds(o);
  const p = cam.toScreen(b.x, b.y);
  const s = 15;
  const x = p.x + 4, y = p.y + 4;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(32,31,30,0.72)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, s + 7, s + 5, 4); else ctx.rect(x, y, s + 7, s + 5);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  const cx = x + (s + 7) / 2, cy = y + (s + 5) / 2;
  ctx.beginPath();                       // shackle
  ctx.arc(cx, cy - 1.2, 3, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();                       // body
  if (ctx.roundRect) ctx.roundRect(cx - 4.5, cy - 1, 9, 6.5, 1.4); else ctx.rect(cx - 4.5, cy - 1, 9, 6.5);
  ctx.fill();
  ctx.restore();
}

export function drawMemberOutline(ctx, cam, o) {
  const b = worldBounds(o);
  const p = cam.toScreen(b.x, b.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(0,120,212,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(p.x, p.y, b.w * cam.z, b.h * cam.z);
  ctx.restore();
}
