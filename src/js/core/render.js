// Canvas painting: backgrounds, every object type, and the selection chrome.

import { boundsOf, worldBounds, strokeDrawWidth } from './store.js';
import { pageRects as worldPageRects } from './pages.js';
import { hexToRgba, readableText, wrapText, fitFontSize, clamp } from './util.js';
import { inkPath, inkRuns, strokeWeight, hasPressureVariation } from './ink.js';
import { objectRuns, layoutRich, fitRichSize, drawRichLines, needsRich, watchChips } from './richtext.js';
import { mathEntry, hasMaths } from './maths.js';
import { drawConnector } from './connectors.js';
import { lookupBoard, refLabel, refMissing } from './boardrefs.js';

import { fontStack } from '../ui/palettes.js';
import { t, currentLanguage, direction } from '../i18n.js';

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

/**
 * How far apart the lines, squares and dots of a pattern are, in world units
 * (96 to the inch): about 5, 7.5, 10.5 and 15 mm on a printed sheet. 40 is
 * what every board had before there was a choice, and what a board with no
 * setting still gets.
 */
export const PATTERN_SPACINGS = [19, 28, 40, 56];   // ~5, 7.5, 10.5 and 15 mm on paper; 19 matches Xournal++'s 5 mm graph paper

/* ---------- notebook paper ----------
 *
 * Pale blue rules, a red margin down the left and a clear strip across the
 * top where the date the sheet was started sits, small and grey. Everything
 * is measured in millimetres of paper so it prints the size it looks. The
 * board itself never mirrors - Arabic only moves the date to the other end of
 * the strip, because text belongs to the reader but the paper belongs to the
 * board and has to look the same to everyone who opens it.
 */
export const NOTEBOOK = { line: '#8db6e2', margin: '#e0707f', date: '#8a8886', marginMm: 25, headMm: 22, dateMm: 3.8, edgeMm: 15 };
const MM = 96 / 25.4;

/**
 * Where everything on one sheet of notebook paper goes, in screen pixels.
 * Exported so the suite can check the date really lands in the strip.
 * @param {{x:number,y:number,w:number,h:number}} sheet  the sheet on screen
 */
export function notebookLayout(sheet, base, z, rtl = false) {
  const head = Math.max(3 * base, NOTEBOOK.headMm * MM) * z;
  const top = sheet.y + head;                                // the first rule
  const marginX = sheet.x + NOTEBOOK.marginMm * MM * z;
  const fontPx = NOTEBOOK.dateMm * MM * z;
  const baseline = top - Math.max(0.3 * base, 2.5 * MM) * z;
  const dateX = rtl ? marginX + 5 * MM * z : sheet.x + sheet.w - NOTEBOOK.edgeMm * MM * z;
  return { top, marginX, fontPx, baseline, dateX, align: rtl ? 'left' : 'right' };
}

const LOCALE_FOR = { en: null, bn: 'bn-BD', ar: 'ar-u-nu-arab', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', es: 'es', 'pt-BR': 'pt-BR' };
const dateFormats = new Map();

/**
 * "2026-10-06" as the reader's language writes it: Tue, October 6, 2026 /
 * মঙ্গল, ৬ অক্টোবর, ২০২৬ / الثلاثاء، ٦ أكتوبر ٢٠٢٦. The stored day never
 * changes; only the way it is written does. English follows the computer's
 * own English (US or UK order).
 */
export function formatPageDate(iso, lang = currentLanguage()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  let loc = LOCALE_FOR[lang];
  if (loc === undefined) loc = lang;
  if (loc === null) {
    const sys = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    loc = /^en\b/i.test(sys) ? sys : 'en';
  }
  let f = dateFormats.get(loc);
  if (!f) {
    try { f = new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); }
    catch { f = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); }
    dateFormats.set(loc, f);
  }
  // noon, so no timezone can tip it into the day before or after
  return f.format(new Date(+m[1], +m[2] - 1, +m[3], 12));
}

function drawNotebook(ctx, bg, cam, base, step, anchor, bounds, page, x0, y0, x1, y1) {
  const z = cam.z;
  ctx.strokeStyle = NOTEBOOK.line;
  ctx.globalAlpha = 0.9;
  if (!anchor) {
    // the infinite canvas has no top and no left edge: just the blue rules
    const oy = ((cam.y % step) + step) % step;
    ctx.beginPath();
    for (let y = lineFrom(oy, step, y0); y < y1; y += step) { ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); }
    ctx.stroke();
    return;
  }
  const rtl = direction() === 'rtl';
  const L = notebookLayout(bounds || { x: anchor.x, y: anchor.y, w: x1 - anchor.x, h: y1 - anchor.y }, base, z, rtl);
  ctx.beginPath();
  for (let y = lineFrom(L.top, step, Math.max(y0, L.top)); y < y1; y += step) { ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); }
  ctx.stroke();

  ctx.strokeStyle = NOTEBOOK.margin;
  ctx.lineWidth = clamp(0.3 * MM * z, 1, 2.5);
  ctx.beginPath();
  ctx.moveTo(L.marginX, y0); ctx.lineTo(L.marginX, y1);
  ctx.stroke();

  // the day the sheet was started - never today's date standing in for it
  if (bg.pageDate === false || !page?.date || L.fontPx < 6) return;
  const text = formatPageDate(page.date);
  if (!text) return;
  ctx.globalAlpha = 1;
  ctx.fillStyle = NOTEBOOK.date;
  ctx.font = `${L.fontPx.toFixed(2)}px ${FONT}`;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = L.align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, L.dateX, L.baseline);
}

/* ---------- music staff and guitar tab ----------
 *
 * Manuscript paper: groups of five lines for notes, or six for guitar tab,
 * with a clear gap between groups for lyrics, chord names and fingering. The
 * spacing choice sets how big each group is, like buying manuscript paper with
 * a bigger or smaller staff: Normal is a staff about 15 mm tall, roomy enough
 * to write notes with a pen. On a sheet the groups start below a top margin,
 * stop short of both side edges, and open with a bar line - tab also gets the
 * T-A-B letters down its start, the way printed tab paper has them. Measured
 * from the sheet's own corner, so the printout matches the screen.
 */
export const STAFF = {
  staff: { lines: 5, gap: 0.35, period: 2.75 },   // gap = line gap / spacing; period = system height / staff height
  tab: { lines: 6, gap: 0.42, period: 2.5 }
};
export function staffLayout(kind, base) {
  const k = STAFF[kind];
  const gap = base * k.gap;                      // world units between two lines of one staff
  const height = gap * (k.lines - 1);
  return { lines: k.lines, gap, height, period: height * k.period, top: 18 * MM, side: 12 * MM };
}

function drawStaves(ctx, bg, cam, base, kind, anchor, bounds, x0, y0, x1, y1, exact) {
  const L = staffLayout(kind, base);
  let z = cam.z;
  let scale = 1;
  if (!anchor && !exact) {
    // the infinite canvas keeps its staves readable however far it is zoomed, like the grid
    while (L.gap * z * scale < 4) scale *= 2;
    while (L.gap * z * scale > 40) scale /= 2;
  }
  const gap = L.gap * z * scale, period = L.period * z * scale, height = L.height * z * scale;
  if (gap < 1.5) return;                        // too small to tell five lines from one
  let left = x0, right = x1, first;
  if (anchor && bounds) {
    left = Math.max(x0, bounds.x + L.side * z);
    right = Math.min(x1, bounds.x + bounds.w - L.side * z);
    first = bounds.y + L.top * z;
  } else {
    first = (((anchor ? anchor.y : cam.y) % period) + period) % period;
  }
  if (right <= left) return;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = clamp(0.12 * MM * z, 1, 1.6);
  const bottom = anchor && bounds ? bounds.y + bounds.h - L.top * z * 0.6 : Infinity;
  let sy = first + Math.max(0, Math.floor((y0 - height - first) / period)) * period;
  ctx.beginPath();
  for (; sy < y1 && sy + height <= bottom; sy += period) {
    if (sy + height < y0) continue;
    for (let i = 0; i < L.lines; i++) {
      const y = Math.round(sy + i * gap) + 0.5;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    if (anchor && bounds) {
      // the bar line that opens each staff, and the one that closes it
      const xl = Math.round(bounds.x + L.side * z) + 0.5, xr = Math.round(bounds.x + bounds.w - L.side * z) - 0.5;
      ctx.moveTo(xl, Math.round(sy) + 0.5); ctx.lineTo(xl, Math.round(sy + height) + 0.5);
      ctx.moveTo(xr, Math.round(sy) + 0.5); ctx.lineTo(xr, Math.round(sy + height) + 0.5);
    }
  }
  ctx.stroke();
  if (kind !== 'tab' || !anchor || !bounds || gap < 5) return;
  ctx.font = `700 ${(gap * 1.3).toFixed(2)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tx = bounds.x + L.side * z + gap * 1.3;
  const paper = boardPaint(bg.color);
  sy = first + Math.max(0, Math.floor((y0 - height - first) / period)) * period;
  for (; sy < y1 && sy + height <= bottom; sy += period) {
    if (sy + height < y0) continue;
    // T, A and B down the start of the six strings, on a clear patch, as printed tab paper has them
    ctx.globalAlpha = 1;
    ctx.fillStyle = paper;
    ctx.fillRect(tx - gap * 0.6, sy + 1.5, gap * 1.2, height - 3);
    ctx.fillStyle = NOTEBOOK.date;
    ['T', 'A', 'B'].forEach((ch, i) => ctx.fillText(ch, tx, sy + gap * (1 + i * 1.5)));
  }
}

function drawPattern(ctx, bg, cam, w, h, anchor, bounds, page, exact = false) {
  const pattern = bg.pattern || 'none';
  if (pattern === 'none') return;

  const base = PATTERN_SPACINGS.includes(bg.spacing) ? bg.spacing : 40;   // world spacing
  let step = base * cam.z;
  if (anchor || exact) {
    /*
     * A sheet of paper has its ruling printed on it: true to size at every
     * zoom, so the lines sit the same distance apart on screen, in a PDF and
     * on the printout, and handwriting keeps its proportion to them. They are
     * only thinned out once they would run together.
     */
    while (step < 6) step *= 2;
  } else {
    while (step < 14) step *= 2;          // keep it readable when zoomed out
    while (step > 120) step /= 2;
  }
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

  if (pattern === 'notebook') {
    drawNotebook(ctx, bg, cam, base, step, anchor, bounds, page, x0, y0, x1, y1);
  } else if (pattern === 'staff' || pattern === 'tab') {
    drawStaves(ctx, bg, cam, base, pattern, anchor, bounds, x0, y0, x1, y1, exact);
  } else if (pattern === 'grid' || pattern === 'lines' || pattern === 'columns') {
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
    ctx.fillStyle = boardPaint(bg.color);
    ctx.fillRect(0, 0, w, h);
    drawPattern(ctx, bg, cam, w, h, null);
    ctx.restore();
    return;
  }

  // the desk the pad sits on
  ctx.fillStyle = shadeOf(boardPaint(bg.color));
  ctx.fillRect(0, 0, w, h);

  sheets.forEach((sheet, i) => {
    if (sheet.x > w || sheet.y > h || sheet.x + sheet.w < 0 || sheet.y + sheet.h < 0) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.20)';
    ctx.shadowBlur = Math.min(26, 10 + cam.z * 8);
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = boardPaint(bg.color);
    ctx.fillRect(sheet.x, sheet.y, sheet.w, sheet.h);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(sheet.x, sheet.y, sheet.w, sheet.h);
    ctx.clip();
    drawPattern(ctx, bg, cam, w, h, { x: sheet.x, y: sheet.y }, sheet, pages[i]);
    ctx.restore();

    strokePageEdge(ctx, sheet);
  });
  ctx.restore();
}

/**
 * Just the ruling, for an export: the lines, squares, dots or notebook paper
 * the board shows, without the desk, shadows and page edges that only make
 * sense on screen. A pad is ruled sheet by sheet from each sheet's own corner,
 * exactly as it is drawn on screen, so the printout matches what was written on.
 */
export function drawRuling(ctx, bg, cam, w, h, pages = null) {
  if (!bg || !bg.pattern || bg.pattern === 'none') return;
  ctx.save();
  const sheets = pages && pages.length ? pageRects(pages, cam) : [];
  // an export is printed, so even an infinite board's ruling comes out true to size
  if (!sheets.length) drawPattern(ctx, bg, cam, w, h, null, null, null, true);
  else sheets.forEach((sheet, i) => {
    if (sheet.x > w || sheet.y > h || sheet.x + sheet.w < 0 || sheet.y + sheet.h < 0) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(sheet.x, sheet.y, sheet.w, sheet.h); ctx.clip();
    drawPattern(ctx, bg, cam, w, h, { x: sheet.x, y: sheet.y }, sheet, pages[i]);
    ctx.restore();
  });
  ctx.restore();
}

/* =================================================================== *
 *  Light and dark
 *
 *  A dark board is a screen decision, not a document one. The file on disk is
 *  unchanged: a stroke drawn in the default black is still #201f1e in the JSON,
 *  in the PDF, in the PNG and in a board sent to somebody else. Only the
 *  painting of it on THIS screen, right now, is allowed to differ.
 *
 *  That is what makes a dark board safe. The obvious approach - have the black
 *  pen write white - produces white ink in a white-backgrounded export: a page
 *  that looks blank. And it would only help work drawn after the switch, while
 *  every board already written would stay invisible on the dark canvas.
 *  Mapping at paint time fixes both at once and risks neither.
 *
 *  The mapping applies to DEFAULT ink only. A colour somebody chose on purpose
 *  is theirs and is painted as chosen; red stays red. Default black and the
 *  default black of text are the two that flip, because on a dark board they
 *  are the difference between writing and not.
 *
 *  And they flip only when the page under them is really painted dark. A
 *  board in a colour of its own - off-white, cream, light blue - stays light
 *  in the dark theme, and light ink on it was very nearly invisible: the
 *  default pen wrote light grey on off-white. So the page colour is asked
 *  first; on a light page black stays black, whatever the theme.
 * =================================================================== */

const DEFAULT_INK = '#201f1e';
const DARK_INK = '#f3f2f1';
// the pencil's graphite, and what it turns into on a dark page: soft grey, like chalk
const PENCIL_INK = '#4b4a48';
const DARK_PENCIL = '#cfccc6';
const DARK_BOARD = '#1f1e1d';

let darkBoard = false;
let pageColor = '#ffffff';

/** The colour of the board being painted, so default ink can tell whether the page under it is dark. */
export function setPageColor(color) { pageColor = color || '#ffffff'; }

/** true for a dark colour (brightness under `below`, 0-1), false for a light one, null when it cannot be read. */
export function isDarkColor(color, below = 0.5) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < below;
}

/** Does default ink paint light right now? Only on a dark screen, and only over a page that is painted dark. */
function lightInk() {
  if (!darkBoard) return false;
  const dark = isDarkColor(boardPaint(pageColor));
  return dark === null ? true : dark;
}

/**
 * Paint the board dark from here on - screen only.
 *
 * Export deliberately turns this OFF around its own rendering rather than
 * trusting the current value, so a PDF is white paper with black ink whatever
 * the screen happens to be doing while it is generated.
 */
export function setDarkBoard(on) { darkBoard = !!on; }
export function isDarkBoard() { return darkBoard; }

/** The colour to actually paint with, once the theme has had its say. */
export function inkPaint(color, fallback = DEFAULT_INK) {
  const c = color || fallback;
  if (!lightInk()) return c;
  const lc = String(c).toLowerCase();
  if (lc === PENCIL_INK) return DARK_PENCIL;
  return lc === DEFAULT_INK ? DARK_INK : c;
}

/** The board's own colour, once the theme has had its say. */
export function boardPaint(color) {
  const c = color || '#ffffff';
  if (!darkBoard) return c;
  // A colour somebody chose for this board is kept - they wanted that board
  // yellow. Only the default white sheet becomes a dark sheet.
  return String(c).toLowerCase() === '#ffffff' ? DARK_BOARD : c;
}

/* =================================================================== *
 *  Ink
 * =================================================================== */
/** Gradient down the stroke for the rainbow and galaxy inks. */
function inkStyle(ctx, o) {
  if (!o.effect || o.effect === 'none') return inkPaint(o.color);
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

/* =================================================================== *
 *  Pencil
 *
 *  A pencil is a pen whose ink is graphite: grainy, a little see-through, so
 *  going over a line again makes it darker, the way shading works on paper.
 *  How hard the pen pressed sets how dark the whole line is (a light touch
 *  sketches, a firm one draws), and a stylus held on its side lays down a
 *  wide, soft stroke. None of it changes what is stored: a pencil line is an
 *  ordinary stroke with effect 'pencil', so every board that has one still
 *  opens in an older GazBoard, as a plain line.
 * =================================================================== */
const GRAIN = 96;
let grainMask = null;
const grainCache = new Map();

/** The paper tooth: which bits of the line the graphite catches on. Made once, the same every time. */
function pencilGrainMask() {
  if (grainMask !== null) return grainMask;
  let c = null;
  try {
    if (typeof OffscreenCanvas === 'function') c = new OffscreenCanvas(GRAIN, GRAIN);
    else if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = c.height = GRAIN; }
  } catch { c = null; }
  if (!c) { grainMask = false; return false; }
  const g = c.getContext('2d');
  const img = g.createImageData(GRAIN, GRAIN);
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 10000) / 10000; };
  // a coarse layer for the tooth of the paper, a fine one for the specks of lead
  const coarse = Array.from({ length: (GRAIN / 4) * (GRAIN / 4) }, rnd);
  for (let y = 0; y < GRAIN; y++) {
    for (let x = 0; x < GRAIN; x++) {
      const tooth = coarse[((y >> 2) % (GRAIN / 4)) * (GRAIN / 4) + ((x >> 2) % (GRAIN / 4))];
      const speck = rnd();
      // diagonal fibres, faintly, as paper has
      const fibre = 0.5 + 0.5 * Math.sin((x + y * 0.6) * 0.9);
      const a = Math.max(0, Math.min(1, 0.32 + tooth * 0.38 + speck * 0.42 - fibre * 0.12));
      const i = (y * GRAIN + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  grainMask = c;
  return c;
}

/** The graphite as a fill, in this colour. Falls back to the plain colour where there is no canvas to make it on. */
function pencilStyle(ctx, color) {
  const mask = pencilGrainMask();
  if (!mask || typeof ctx.createPattern !== 'function') return color;
  let tile = grainCache.get(color);
  if (!tile) {
    let c;
    try {
      c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(GRAIN, GRAIN) : document.createElement('canvas');
      c.width = c.height = GRAIN;
    } catch { return color; }
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, GRAIN, GRAIN);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0);
    tile = c;
    if (grainCache.size > 40) grainCache.clear();
    grainCache.set(color, tile);
  }
  try { return ctx.createPattern(tile, 'repeat') || color; } catch { return color; }
}

/** How dark a pencil line is (0-1): set by how hard it was pressed, lighter when the pencil lay on its side. */
export function pencilDarkness(o) {
  const pts = o.points || [];
  let sum = 0;
  for (const q of pts) sum += q.p ?? 0.5;
  const p = pts.length ? sum / pts.length : 0.5;
  const tilt = Math.max(0, Math.min(1, o.tilt || 0));
  return Math.max(0.3, Math.min(1, 0.42 + p * 0.62)) * (1 - tilt * 0.35);
}

/** A pencil on its side lays down a wider line. */
export function pencilWidth(o) { return strokeDrawWidth({ ...o, effect: 'pencil' }); }

export function drawStroke(ctx, o) {
  const pts = o.points;
  if (!pts || !pts.length) return;
  const path = inkPath(o);
  if (!path) return;
  const highlighter = o.tool === 'highlighter';
  if (o.effect === 'pencil' && !highlighter) {
    ctx.save();
    // on a dark page a pencil works like chalk: more of it shows, so colours stay bright rather than sinking into the dark
    const d = pencilDarkness(o);
    ctx.globalAlpha = (o.opacity ?? 1) * (lightInk() ? Math.min(1, 0.3 + d * 0.85) : d);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = pencilStyle(ctx, inkPaint(o.color));
    ctx.lineWidth = pencilWidth(o);
    ctx.stroke(path);                     // one call: a line does not darken itself, only a second line over it does
    ctx.restore();
    return;
  }

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
    case 'cloud': cloud(ctx, x, y, w, h); break;
    case 'line': ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); break;
    case 'arrow': case 'doubleArrow': {
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
      break;
    }
    default: ctx.rect(x, y, w, h);
  }
}

/*
 * A cloud, drawn as one outline.
 *
 * It used to be five whole circles stroked on top of each other, which is why
 * every overlap showed through and the result looked like a diagram of
 * intersecting sets rather than weather. Here the bumps are still circles, but
 * only the outside of each is drawn: where two neighbours cross, the crossing
 * point on the far side from the middle becomes the seam, and each arc runs
 * from the seam behind it to the seam ahead. The path closes on itself, so a
 * fill has nothing to bleed through and a dashed stroke runs round the edge
 * the way it does on every other shape.
 *
 * Bumps are sized from the gap to their neighbours rather than from the box.
 * Sizing them from the box was the thing that fell apart on a wide flat cloud:
 * the bumps stayed small while the gaps stretched, until the underside came
 * apart into a row of loose circles.
 */
function cloud(ctx, x, y, w, h) {
  const aw = Math.abs(w), ah = Math.abs(h);
  if (aw < 1 || ah < 1) return;
  const ox = w < 0 ? x + w : x, oy = h < 0 ? y + h : y;
  const cx = ox + aw / 2, cy = oy + ah / 2;
  // Position in the box, then relative size. Large and overlapping along the
  // crown, smaller and lower underneath, so the base sits flatter than the top.
  const SPEC = [
    [0.20, 0.58, 1.15], [0.35, 0.36, 1.30], [0.58, 0.32, 1.35], [0.78, 0.50, 1.20],
    [0.84, 0.70, 0.92], [0.62, 0.78, 1.00], [0.38, 0.80, 0.98], [0.16, 0.72, 0.90]
  ];
  const n = SPEC.length;
  const c = SPEC.map(([fx, fy]) => ({ x: ox + aw * fx, y: oy + ah * fy, r: 0 }));
  for (let i = 0; i < n; i++) {
    const p = c[(i - 1 + n) % n], q = c[(i + 1) % n];
    const gap = (Math.hypot(c[i].x - p.x, c[i].y - p.y) + Math.hypot(c[i].x - q.x, c[i].y - q.y)) / 2;
    c[i].r = gap * 0.66 * SPEC[i][2];
  }
  // Where two neighbouring bumps cross, on the outside of the cloud.
  const seam = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (!d || d >= a.r + b.r || d <= Math.abs(a.r - b.r)) return null;
    const t = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
    const k = Math.sqrt(Math.max(0, a.r * a.r - t * t));
    const mx = a.x + (dx * t) / d, my = a.y + (dy * t) / d;
    const p1 = { x: mx + (k * dy) / d, y: my - (k * dx) / d };
    const p2 = { x: mx - (k * dy) / d, y: my + (k * dx) / d };
    return Math.hypot(p1.x - cx, p1.y - cy) > Math.hypot(p2.x - cx, p2.y - cy) ? p1 : p2;
  };
  const seams = [];
  for (let i = 0; i < n; i++) seams.push(seam(c[i], c[(i + 1) % n]));
  let open = false;
  for (let i = 0; i < n; i++) {
    const back = seams[(i - 1 + n) % n], fwd = seams[i], b = c[i];
    // Neighbours that somehow do not meet: draw the whole bump rather than
    // leave a hole. Nothing in the shipped proportions reaches this, but a
    // shape dragged to a freakish aspect should still look like something.
    if (!back || !fwd) {
      ctx.moveTo(b.x + b.r, b.y);
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      open = false;
      continue;
    }
    if (!open) { ctx.moveTo(back.x, back.y); open = true; }
    ctx.arc(b.x, b.y, b.r, Math.atan2(back.y - b.y, back.x - b.x), Math.atan2(fwd.y - b.y, fwd.x - b.x));
  }
  if (open) ctx.closePath();
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
    // The outline is ink like any other: the default one follows the theme
    // (light on a dark board, exactly as the colour picker promises), a colour
    // somebody chose is left alone. It used to be painted as stored, so every
    // default shape came out black on a dark board.
    const outline = inkPaint(o.stroke);
    ctx.strokeStyle = outline;
    ctx.lineWidth = o.lineWidth || 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (o.dash) ctx.setLineDash(o.dash === 'dot' ? [1, ctx.lineWidth * 2.2] : [ctx.lineWidth * 3, ctx.lineWidth * 2.2]);
    shapePath(ctx, o.kind, x, y, w, h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (o.kind === 'arrow' || o.kind === 'doubleArrow') {
      const size = (o.lineWidth || 3) * 3.4;
      arrowHead(ctx, { x, y }, { x: x + w, y: y + h }, size, outline);
      if (o.kind === 'doubleArrow') arrowHead(ctx, { x: x + w, y: y + h }, { x, y }, size, outline);
    }
  }
  if (o.text && !hideText) {
    const pad = 10;
    const papered = !!o.fill && o.fill !== 'none';
    drawTextBlock(ctx, o.text, x + pad, y + pad, w - pad * 2, h - pad * 2, {
      runs: objectRuns(o), paint: papered ? (c) => c || '#201f1e' : (c) => inkPaint(c), ownInk: papered,
      color: papered ? (o.textColor || '#201f1e') : inkPaint(o.textColor), size: o.fontSize || 0, align: 'center', valign: 'middle',
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
  /*
   * Words with styles of their own go the rich way (see richtext.js). Plain
   * text - every board made before rich text, and every box nobody has
   * formatted - takes exactly the path below that it always has.
   */
  // Maths in the words ($...$) is drawn by the rich path too, which knows how to set it.
  const runs = opt.runs || (needsRich(text) ? [{ t: text }] : null);
  if (runs) {
    const base = { family, weight: '400', bold: weight === '600', italic: !!opt.italic, underline: !!opt.underline, color: opt.color, size: opt.size,
      onload: opt.onload, lineHeight: opt.lineHeight };
    if (!base.size) base.size = fitRichSize(ctx, runs, w, h, base, opt.maxSize || 72, opt.minSize || 10);
    const lines = layoutRich(ctx, runs, w, base);
    drawRichLines(ctx, lines, x, y, w, h, base, { align: opt.align, valign: opt.valign, lineHeight: opt.lineHeight, // plain words with maths in them keep the colours the plain path gives them
      paint: opt.paint || (opt.runs || opt.ownInk ? undefined : (c) => inkPaint(c)), onload: opt.onload, paper: !!opt.ownInk });
    return;
  }
  const italic = opt.italic ? 'italic ' : '';
  let size = opt.size;
  if (!size) size = fitFontSize(ctx, text, w, h, family, weight, opt.maxSize || 72, opt.minSize || 10);
  ctx.save();
  ctx.font = `${italic}${weight} ${size}px ${family}`;
  // Words on a paper of their own (a sticky note, a table, a filled shape) keep
  // their ink in the dark theme: light letters on a yellow note cannot be read.
  ctx.fillStyle = opt.ownInk ? (opt.color || '#201f1e') : inkPaint(opt.color);
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
    runs: objectRuns(o),
    color: o.textColor || readableText(o.color || '#ffd94a'), ownInk: true,
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
    runs: objectRuns(o), paint: (c) => inkPaint(c),
    color: inkPaint(o.color), size: o.fontSize || 24,
    align: o.align || 'left', valign: o.valign || 'top',
    family: faceOf(o.font),
    weight: o.bold ? '600' : '400', italic: o.italic, underline: o.underline
  });
}

/*
 * Whatever emoji font the machine already has.
 *
 * Nothing is bundled and nothing is fetched, so this keeps working on a plane
 * like the rest of the app. The cost is that the same character is drawn in
 * each platform's own style - a board made on Windows and opened on a phone
 * shows Samsung's version of the smile. Every app that leans on the system
 * font has this, and the alternative is shipping a ten-megabyte font to make
 * a smiley look identical everywhere, which is not a trade worth making.
 */
/*
 * Emoji are drawn from a font we ship, not the one the machine happens to own.
 *
 * The system fonts are not equal. Windows draws emoji from outlines, so they
 * stay sharp however big you make them. Android's are photographs - one
 * picture per emoji, about a hundred pixels across, and nothing larger to fall
 * back on - so a big one on a dense phone screen is a small picture stretched,
 * and it looks it. Bundling outlines fixes that, and has a second effect worth
 * as much: a board now shows the same artwork to everyone who opens it,
 * instead of a different rocket on each machine.
 *
 * The system fonts stay in the list behind ours, so a character the bundle
 * does not carry still draws rather than turning into an empty box.
 */
const EMOJI_FONT = '"GazBoard Emoji","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla","EmojiOne Color",sans-serif';
const EMOJI_BASE = 100;
const emojiInk = new Map();
let emojiRuler = null;

/**
 * How much room a character's ink actually takes, measured once and kept.
 *
 * Emoji are not square. A face is round, a rocket is long, a prohibition sign
 * is wider than it is tall, and the advance width a font reports is not the
 * same as the ink. Measuring is what stops one landing stretched, and the
 * answer never changes for a given character, so it is worth remembering.
 *
 * Falls back to a square when there is no canvas to measure with - during a
 * board rebuild, say - which is a fair guess and never a crash.
 */
export function emojiInkSize(ch) {
  const key = ch || '';
  const hit = emojiInk.get(key);
  if (hit) return hit;
  let out = { w: EMOJI_BASE, h: EMOJI_BASE };
  try {
    if (!emojiRuler && typeof document !== 'undefined') {
      emojiRuler = document.createElement('canvas').getContext('2d');
    }
    if (emojiRuler) {
      emojiRuler.font = `${EMOJI_BASE}px ${EMOJI_FONT}`;
      emojiRuler.textAlign = 'center';
      emojiRuler.textBaseline = 'alphabetic';
      const m = emojiRuler.measureText(key);
      const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
      const w = (left != null && right != null) ? left + right : m.width;
      const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
      const h = (asc != null && desc != null) ? asc + desc : EMOJI_BASE;
      if (w > 1 && h > 1) out = { w, h, asc, desc };
    }
  } catch { /* no canvas, no measurement, square it is */ }
  emojiInk.set(key, out);
  return out;
}

/**
 * Throw the measurements away.
 *
 * Sizes are measured once and kept, which is right while the font stays put.
 * The bundled emoji font arrives a moment after start-up, though, and anything
 * measured before it landed describes the machine's own artwork instead of
 * ours - a slightly different width, so a slightly wrong box. Called once the
 * font is in, so the next measurement is the real one.
 */
export function forgetEmojiMetrics() {
  emojiInk.clear();
  emojiRuler = null;
}

/** The shape of a character: wider than tall is above 1. */
export function emojiAspect(ch) {
  const { w, h } = emojiInkSize(ch);
  return w / h;
}

/**
 * An emoji, sitting in its box without being squashed into it.
 *
 * It used to stretch to fill, on the reasoning that shapes do and handles
 * should never look broken. That was wrong here: a rectangle stretched is
 * still a rectangle, but a face stretched is a face with something wrong with
 * it, and every emoji dropped on a square box arrived subtly wrong because
 * almost none of them are square. So the glyph is scaled by whichever of the
 * two fits, keeping its proportions, and centred in whatever room is left.
 * New ones are given a box shaped like the character in the first place, so
 * there is usually no room left over to notice.
 */
export function drawEmoji(ctx, o) {
  const ch = o.ch || '\u{1F642}';
  const aw = Math.abs(o.w), ah = Math.abs(o.h);
  if (aw < 1 || ah < 1) return;
  const x = o.w < 0 ? o.x + o.w : o.x, y = o.h < 0 ? o.y + o.h : o.y;
  const ink = emojiInkSize(ch);
  const asc = ink.asc ?? EMOJI_BASE * 0.78;
  const desc = ink.desc ?? EMOJI_BASE * 0.08;
  const k = Math.min(aw / ink.w, ah / ink.h);
  ctx.save();
  ctx.font = `${EMOJI_BASE}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.translate(x + aw / 2, y + ah / 2);
  ctx.scale(k, k);
  // Emoji sit high on the line, so putting the baseline on the middle leaves
  // them low in the box; this puts the ink's middle there instead.
  ctx.fillText(ch, 0, (asc - desc) / 2);
  ctx.restore();
}

/**
 * A maths box: its formula as a picture, as large as fits the box and centred
 * in it. Until the picture is ready (the first time a board with maths opens)
 * the LaTeX itself stands in, faintly, so nothing jumps about unexplained.
 */
export function drawMath(ctx, o, onload) {
  const aw = Math.abs(o.w), ah = Math.abs(o.h);
  if (aw < 1 || ah < 1) return;
  const x = o.w < 0 ? o.x + o.w : o.x, y = o.h < 0 ? o.y + o.h : o.y;
  const e = mathEntry(o.tex, inkPaint(o.color), onload);
  if (e.status === 'ready' && e.img) {
    const k = Math.min(aw / e.w, ah / e.h);
    const dw = e.w * k, dh = e.h * k;
    ctx.drawImage(e.img, x + (aw - dw) / 2, y + (ah - dh) / 2, dw, dh);
    return;
  }
  ctx.save();
  ctx.strokeStyle = 'rgba(128,128,128,.45)';
  ctx.lineWidth = Math.max(1, Math.min(aw, ah) / 80);
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, aw, ah);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(128,128,128,.8)';
  const size = Math.max(6, Math.min(ah * 0.4, aw / Math.max(4, String(o.tex || '').length * 0.6)));
  ctx.font = `${size}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(o.tex || ''), x + aw / 2, y + ah / 2, aw);
  ctx.restore();
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
    ctx.fillText(t('Picture not found'), o.x + o.w / 2, o.y + o.h / 2);
  } else {
    ctx.fillStyle = '#edebe9';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.fillStyle = '#a19f9d';
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(t('Loading…'), o.x + o.w / 2, o.y + o.h / 2);
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
      runs: objectRuns(o, key),
      color: o.textColor || '#201f1e', ownInk: true, size: o.fontSize || 0, maxSize: 26,
      align: 'center', valign: 'middle', family: FONT, weight: o.headerRow && r === 0 ? '600' : '400'
    });
  }
  ctx.restore();
}

/* =================================================================== *
 *  Answer covers
 * =================================================================== */
export const CURTAIN_COLOR = '#5b5fc7';
export const CURTAIN_LABEL = t('Tap to reveal');

/**
 * A card laid over part of the board, the way a teacher slides a sheet of
 * paper down an overhead to show one line at a time.
 *
 * Solid on purpose, and the same on a light board and a dark one: its whole
 * job is that nothing underneath shows through, and a see-through cover is a
 * spoiler. Faint stripes and a label say "there is something under here" so
 * nobody mistakes it for a coloured box they are meant to read.
 *
 * Once revealed it draws nothing at all - it is not faded, not outlined, not
 * in the export. Undo, or "Cover answers again", brings it back.
 */
export function drawCurtain(ctx, o) {
  if (o.revealed) return;
  const { x, y, w, h } = o;
  const aw = Math.abs(w), ah = Math.abs(h);
  /*
   * Everything in proportion to the card itself: the corners, the stripes and
   * the label all grow and shrink with it. They used to be fixed board sizes
   * (a 40-unit label, 28-unit stripes), which is fine on a card made at 100%
   * and hopeless on one made zoomed right out - that card is twenty times as
   * many board units across, so its label came out a twentieth of the size,
   * a speck in the middle of a big purple block. The same rule the sticky
   * notes follow: the size of the card is where the zoom already went.
   */
  const unit = Math.min(aw, ah);
  const r = unit * 0.13;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  ctx.fillStyle = o.color || CURTAIN_COLOR;
  ctx.fill();
  ctx.clip();
  // the stripes: light, wide, and at 45 degrees so they read as a pattern
  // rather than as ruled lines somebody might try to write on
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = unit * 0.09;
  const gap = Math.max(1e-6, unit * 0.25);
  ctx.beginPath();
  for (let d = -ah; d < aw; d += gap) { ctx.moveTo(x + d, y + ah); ctx.lineTo(x + d + ah, y); }
  ctx.stroke();
  const label = o.label ?? CURTAIN_LABEL;
  if (label) {
    const size = curtainLabelSize(ctx, o, label);
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
  }
  ctx.restore();
}

/**
 * How big the label on a cover is, in board units: 30% of the card's height,
 * or smaller if that would not fit across 86% of its width. Measured rather
 * than guessed, because the label is translated and "Tap to reveal" is a
 * very different length in Bangla, Arabic and Chinese. No fixed floor or
 * ceiling in board units - see drawCurtain() for why that was the bug.
 */
export function curtainLabelSize(ctx, o, label = o.label ?? CURTAIN_LABEL) {
  const aw = Math.abs(o.w), ah = Math.abs(o.h);
  let size = ah * 0.3;
  if (!label || !(size > 0)) return size;
  ctx.save();
  ctx.font = `600 ${size}px ${FONT}`;
  const wide = ctx.measureText(label).width;
  ctx.restore();
  if (wide > aw * 0.86) size *= (aw * 0.86) / wide;
  return size;
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
    case 'emoji': drawEmoji(ctx, o); break;
    case 'math': drawMath(ctx, o, onload); break;
    case 'table': drawTable(ctx, o, hideCell); break;
    case 'curtain': drawCurtain(ctx, o); break;
    case 'connector': drawConnector(ctx, o, (c) => inkPaint(c)); break;
    case 'boardlink': drawBoardLink(ctx, o, onload); break;
  }
  ctx.restore();
}

/* =================================================================== *
 *  Links to other boards
 * =================================================================== */
/*
 * A card for another board: its picture, and its name underneath, the way My
 * boards shows it. The picture is the one My boards keeps, so it is as fresh
 * as the last time that board was saved. A board that is not on this computer
 * gets a grey, dashed card that still says what it was.
 */
export function drawBoardLink(ctx, o, onload) {
  const ref = o.board || {};
  const b = lookupBoard(ref);
  const missing = refMissing(ref);
  const dark = darkBoard;
  const { x, y, w, h } = o;
  const r = Math.min(12, w * 0.06, h * 0.06);
  const pad = Math.max(4, Math.min(w, h) * 0.04);
  const labelH = Math.max(18, Math.min(h * 0.24, 44));
  ctx.save();
  // the card
  ctx.shadowColor = 'rgba(0,0,0,0.16)';
  ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.fillStyle = dark ? '#2d2c2b' : '#ffffff';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = missing ? (dark ? '#605e5c' : '#a19f9d') : (dark ? '#4a6f94' : '#9cc3e8');
  if (missing) ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  // the picture
  const px = x + pad, py = y + pad, pw = Math.max(1, w - pad * 2), ph = Math.max(1, h - pad * 2 - labelH);
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, Math.max(2, r - pad / 2)); else ctx.rect(px, py, pw, ph);
  ctx.clip();
  ctx.fillStyle = missing ? (dark ? '#3b3a39' : '#edebe9') : '#f3f2f1';
  ctx.fillRect(px, py, pw, ph);
  const img = !missing && b && b.thumb ? getImage(b.thumb, onload) : null;
  if (img) {
    // fill the frame, cropping what does not fit, as the gallery does
    const k = Math.max(pw / img.width, ph / img.height);
    const dw = img.width * k, dh = img.height * k;
    ctx.drawImage(img, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = missing ? (dark ? '#a19f9d' : '#8a8886') : '#a19f9d';
    const fs = Math.max(8, Math.min(ph * 0.14, pw * 0.07));
    ctx.font = `400 ${fs}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(missing ? t('Not on this computer') : t('No picture yet'), px + pw / 2, py + ph / 2, pw - 8);
  }
  ctx.restore();
  // a hairline round the picture, so a white page still reads as a page
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, Math.max(2, r - pad / 2)); else ctx.rect(px + 0.5, py + 0.5, pw - 1, ph - 1);
  ctx.stroke();
  // the name, with a little arrow saying it goes somewhere
  const fs = Math.max(8, labelH * 0.46);
  const ly = y + h - pad - labelH / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const ink = missing ? (dark ? '#a19f9d' : '#8a8886') : (dark ? '#8ccbff' : '#0f6cbd');
  ctx.fillStyle = ink; ctx.strokeStyle = ink;
  // the arrow: a short stroke up and to the right, with its head
  const ax = x + pad + fs * 0.15, ay = ly, as = fs * 0.62;
  ctx.lineWidth = Math.max(1, fs / 9); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay + as / 2); ctx.lineTo(ax + as, ay - as / 2);
  ctx.moveTo(ax + as * 0.35, ay - as / 2); ctx.lineTo(ax + as, ay - as / 2); ctx.lineTo(ax + as, ay + as * 0.15);
  ctx.stroke();
  ctx.font = `600 ${fs}px ${FONT}`;
  const tx = ax + as + fs * 0.45, room = x + w - pad - tx;
  let label = refLabel(ref);
  if (ctx.measureText(label).width > room) {
    while (label.length > 1 && ctx.measureText(label + '…').width > room) label = label.slice(0, -1);
    label += '…';
  }
  ctx.fillText(label, tx, ly);
  if (missing) ctx.fillRect(tx, ly, Math.min(room, ctx.measureText(label).width), Math.max(1, fs / 14));
  ctx.restore();
}

/*
 * Where an object's links are on the board, as four corners each.
 *
 * A card is a link all over. Links inside words have no object of their own,
 * so the words are laid out again - on a scrap of canvas nobody sees, at the
 * board's own scale - and the pills are noted as they are drawn. That is the
 * same code that draws them for real, so a link is found exactly where it is
 * seen, whatever the box's size, wrapping, alignment or turn.
 */
let probe = null;
export function linkRectsOf(o) {
  if (!o || o.hidden) return [];
  if (o.type === 'boardlink') {
    const b = boundsOf(o);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }, a = o.rotation || 0;
    const turn = (px, py) => (a ? { x: c.x + (px - c.x) * Math.cos(a) - (py - c.y) * Math.sin(a), y: c.y + (px - c.x) * Math.sin(a) + (py - c.y) * Math.cos(a) } : { x: px, y: py });
    return [{ ref: o.board, quad: [turn(b.x, b.y), turn(b.x + b.w, b.y), turn(b.x + b.w, b.y + b.h), turn(b.x, b.y + b.h)] }];
  }
  const has = (v) => typeof v === 'string' && v.includes('](b:');
  if (!has(o.text) && !(o.cells && Object.values(o.cells).some(has))) return [];
  if (typeof document === 'undefined') return [];
  probe = probe || document.createElement('canvas').getContext('2d');
  probe.setTransform(1, 0, 0, 1, 0, 0);
  const list = [];
  watchChips(list);
  try { drawObject(probe, o, null, null); } finally { watchChips(null); }
  return list;
}

/** Is world point p inside a four-cornered shape? */
export function inQuad(q, p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross !== 0) { const s = Math.sign(cross); if (sign && s !== sign) return false; sign = s; }
  }
  return true;
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
/**
 * A dashed ring round a group, so grouping is something you can see.
 *
 * Without it, a group is invisible until you touch it and four things light up
 * at once, which is a surprise rather than an explanation. It is drawn only
 * for a group that is selected or under the cursor - ringing every group on
 * the board all the time would turn a diagram into a pile of boxes.
 */
export function drawGroupHint(ctx, cam, b, active = true, name = '') {
  const p = cam.toScreen(b.x, b.y);
  const w = b.w * cam.z, h = b.h * cam.z;
  ctx.save();
  // Faint for a group merely sitting there, clearer for the one being touched.
  // A poster made of six groups should read as a poster, not as six boxes.
  ctx.strokeStyle = active ? 'rgba(0, 120, 212, 0.55)' : 'rgba(0, 120, 212, 0.22)';
  ctx.lineWidth = active ? 1.5 : 1;
  ctx.setLineDash(active ? [7, 5] : [4, 6]);
  const x = p.x - 7, y = p.y - 7, rw = w + 14, rh = h + 14;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, rw, rh, 9);
  else ctx.rect(x, y, rw, rh);
  ctx.stroke();
  ctx.setLineDash([]);
  /*
   * The name sits on the ring itself, top-left, the way a labelled box is
   * labelled on paper. It is drawn on a slab of the board's own colour so it
   * stays readable over whatever it crosses, and it is left off entirely when
   * the group is too small to hold it - a label wider than the thing it names
   * is worse than no label.
   */
  if (name && rw > 54) {
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let label = name;
    if (ctx.measureText(label).width > rw - 12) {
      while (label.length > 1 && ctx.measureText(label + '\u2026').width > rw - 12) label = label.slice(0, -1);
      label += '\u2026';
    }
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(x + 6, y - 8, tw + 8, 15);
    ctx.fillStyle = active ? 'rgba(0, 90, 158, 0.95)' : 'rgba(0, 90, 158, 0.6)';
    ctx.fillText(label, x + 10, y + 3.5);
  }
  ctx.restore();
}

/**
 * A dotted ring round something locked.
 *
 * The padlock badge says which object is locked once you have found it; this
 * says where its edges are, which is the part that matters when you are
 * wondering why a drag is doing nothing. Grey rather than blue, because it is
 * not a selection and should not look like one.
 */
export function drawLockedOutline(ctx, cam, o) {
  const b = worldBounds(o);
  const p = cam.toScreen(b.x, b.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(96, 94, 92, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.strokeRect(p.x - 3, p.y - 3, b.w * cam.z + 6, b.h * cam.z + 6);
  ctx.setLineDash([]);
  ctx.restore();
}

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
