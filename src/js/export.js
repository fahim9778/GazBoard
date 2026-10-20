// Exporting: PNG bitmap, SVG vector, and the .gazboard document format.

import { worldBounds, validTableSize } from './core/store.js';
import { pageRects } from './core/pages.js';
import { wrapText, boxesIntersect } from './core/util.js';
import { objectRuns, layoutRich, effective, needsRich, chipColours, chipPad } from './core/richtext.js';
import { layoutPages } from './ui/pdfdialog.js';
import { FONT, faceOf, CURTAIN_COLOR, drawBoardLink, linkRectsOf, getImage, setDarkBoard, isDarkBoard, pencilDarkness, pencilWidth } from './core/render.js';
import { refLabel, refMissing, lookupBoard } from './core/boardrefs.js';
import { Store } from './core/store.js';
import { useConnectorStore } from './core/connectors.js';
import { Surface } from './core/surface.js';
import { t } from './i18n.js';
import { mathEntry, mathPng, hasMaths, inlineFit } from './core/maths.js';
import { connectorSvg } from './core/connectors.js';

/**
 * What a bitmap or vector export covers.
 *
 * On a pad the sheet IS the export - that is the whole point of choosing one -
 * so this returns one sheet's rectangle. Which sheet is the caller's business:
 * PNG and SVG default to the one you are looking at, PDF walks all of them.
 */
function exportBounds(app, pad = 60, pageIndex = null) {
  const rects = pageRects(app.store.doc.pages);
  if (rects.length) {
    const i = pageIndex == null ? Math.max(0, app.currentPageIndex()) : pageIndex;
    return { ...rects[Math.min(Math.max(i, 0), rects.length - 1)] };
  }
  const b = app.store.contentBounds();
  if (!b) {
    const v = app.surface.cam.viewport(app.surface.width, app.surface.height);
    return { x: v.x, y: v.y, w: v.w, h: v.h };
  }
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

/** Exposed so the suite can check what an export would cover. */
export const exportBoundsForTest = (app, pageIndex = null) => exportBounds(app, 60, pageIndex);

export async function exportPng(app, { scale = 2, transparent = false, selectionOnly = false, filePath: givenPath = null } = {}) {
  let box;
  if (selectionOnly && app.surface.selection.size) {
    box = app.surface.selectionBounds();
    box = { x: box.x - 24, y: box.y - 24, w: box.w + 48, h: box.h + 48 };
  } else box = exportBounds(app);
  await app.mathsReady?.();

  const maxPx = 12000;
  const s = Math.min(scale, maxPx / Math.max(box.w, box.h));
  // the ruling prints with the page; a selection is a cut-out and comes without it
  const canvas = app.surface.renderTo(box, s, !transparent, !transparent && !(selectionOnly && app.surface.selection.size));
  // the line is sized like small writing on the board itself, so it reads at any export size
  stampCanvas(canvas, Math.max(10, 13 * s), Math.max(8, 12 * s));
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const buf = await blob.arrayBuffer();

  // givenPath lets the test suite run this without a native dialog
  const filePath = givenPath || await window.board.saveDialog({
    title: t('Export as PNG'),
    defaultPath: safeName(app.store.doc.name) + '.png',
    filters: [{ name: t('PNG image'), extensions: ['png'] }]
  });
  if (!filePath) return null;
  await window.board.writeFile(filePath, buf);
  app.toast(t('Exported {name}', { name: filePath.split(/[\\/]/).pop() }));
  return filePath;
}

export async function exportSvg(app, opts = {}) {
  await app.mathsReady?.();
  const box = exportBounds(app);
  const others = await linkedSources(app, opts.linked);
  const svg = buildSvg(app, box, others);
  const filePath = opts.filePath || await window.board.saveDialog({
    title: t('Export as SVG'),
    defaultPath: safeName(app.store.doc.name) + '.svg',
    filters: [{ name: t('SVG image'), extensions: ['svg'] }]
  });
  if (!filePath) return null;
  await window.board.writeFile(filePath, new TextEncoder().encode(svg).buffer);
  app.toast(t('Exported {name}', { name: filePath.split(/[\\/]/).pop() }));
  return filePath;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/* ------------------------------------------------------------------ *
 *  "Made with GazBoard"
 *
 *  A small grey line in the bottom-right corner of every exported page and
 *  picture, the way a website says who made it at the foot of the page. It
 *  never sits on the work. In a PDF and an SVG the word GazBoard is a link
 *  to where the app comes from; a PNG is a flat picture and cannot be.
 * ------------------------------------------------------------------ */
export const MADE_WITH = { lead: 'Made with ', name: 'GazBoard', url: 'https://github.com/fahim9778/GazBoard' };
const STAMP_INK = 'rgba(96,94,92,0.72)';
const stampFont = (size) => `${size}px ${faceOf('ui')}`;

/**
 * Write the line onto a finished canvas, `size` canvas pixels high, `pad`
 * pixels in from the bottom-right corner.
 * @returns the word GazBoard's box, as fractions of the canvas, for its link
 */
function stampCanvas(canvas, size, pad) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = '600 ' + stampFont(size);
  const bold = ctx.measureText(MADE_WITH.name).width;
  ctx.font = stampFont(size);
  const lead = ctx.measureText(MADE_WITH.lead).width;
  const right = canvas.width - pad, base = canvas.height - pad;
  ctx.fillStyle = STAMP_INK;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(MADE_WITH.lead, right - bold - lead, base);
  ctx.font = '600 ' + stampFont(size);
  ctx.fillText(MADE_WITH.name, right - bold, base);
  ctx.restore();
  const top = base - size * 1.05, h = size * 1.35;
  return { fx: (right - bold) / canvas.width, fy: top / canvas.height, fw: bold / canvas.width, fh: h / canvas.height };
}

/** The same line as SVG, bottom-right of `box`, with GazBoard a link. */
function stampSvg(box, size = 13) {
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = '600 ' + stampFont(size);
  const bold = meas.measureText(MADE_WITH.name).width;
  const pad = size, right = box.x + box.w - pad, base = box.y + box.h - pad;
  const family = esc(faceOf('ui')).replace(/"/g, "'");
  return `<g class="made-with" font-family="${family}" font-size="${size}" fill="#605e5c" fill-opacity="0.72">` +
    `<text x="${(right - bold).toFixed(1)}" y="${base.toFixed(1)}" text-anchor="end">${esc(MADE_WITH.lead.trim())}&#160;</text>` +
    `<a href="${MADE_WITH.url}" xlink:href="${MADE_WITH.url}" target="_blank"><title>${MADE_WITH.url}</title>` +
    `<text x="${right.toFixed(1)}" y="${base.toFixed(1)}" text-anchor="end" font-weight="600">${MADE_WITH.name}</text></a></g>`;
}

/**
 * The board as an SVG. With `others` - the boards it links to, read by
 * linkedSources() - they go underneath it, each under its own name, and every
 * link becomes clickable: a click shows just the board it names (an SVG
 * <view>), the way a link on the board opens it.
 */
export function buildSvg(app, box, others = []) {
  const doc = app.store.doc;
  const meas = document.createElement('canvas').getContext('2d');
  if (!others.length) {
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">`);
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${doc.background.color || '#fff'}"/>`);
    parts.push(...svgObjects(app.store.objects, meas));
    parts.push(stampSvg(box));
    parts.push('</svg>');
    return parts.join('\n');
  }

  // where each board goes: this one where it is, the others one under another
  const GAP = 120, TITLE = 76;
  const views = [{ id: doc.id, box }];
  const placed = [];
  let y = box.y + box.h + GAP, width = box.w;
  for (const src of others) {
    const rects = pageRects(src.store.doc.pages);
    const cb = src.store.contentBounds();
    const bb = rects.length
      ? rects.reduce((a, r) => ({ x: Math.min(a.x, r.x), y: Math.min(a.y, r.y), w: Math.max(a.x + a.w, r.x + r.w) - Math.min(a.x, r.x), h: Math.max(a.y + a.h, r.y + r.h) - Math.min(a.y, r.y) }))
      : cb ? { x: cb.x - 60, y: cb.y - 60, w: cb.w + 120, h: cb.h + 120 } : { x: 0, y: 0, w: 400, h: 300 };
    const dx = box.x - bb.x, dy = y + TITLE - bb.y;
    placed.push({ src, bb, dx, dy, top: y });
    views.push({ id: src.id, box: { x: box.x, y, w: bb.w, h: TITLE + bb.h } });
    rects.forEach((r, i) => views.push({ id: src.id + '-p' + (i + 1), box: { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h } }));
    width = Math.max(width, bb.w);
    y += TITLE + bb.h + GAP;
  }
  const height = y - GAP - box.y;
  const have = new Set(views.map((v) => v.id));
  const target = (ref) => {
    const b = lookupBoard(ref);
    if (!b) return null;
    if (ref.page > 0 && have.has(b.id + '-p' + ref.page)) return b.id + '-p' + ref.page;
    return have.has(b.id) ? b.id : null;
  };
  const links = (objects) => {
    const out = [];
    for (const o of objects) {
      for (const { ref, quad } of linkRectsOf(o)) {
        const to = target(ref);
        if (!to) continue;
        out.push(`<a href="#gb-${esc(to)}"><title>${esc(refLabel(ref))}</title><polygon points="${quad.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="#000" fill-opacity="0"/></a>`);
      }
    }
    return out;
  };
  const family = esc(faceOf('ui')).replace(/"/g, "'");

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${box.x} ${box.y} ${width} ${height}">`);
  for (const v of views) parts.push(`<view id="gb-${esc(v.id)}" viewBox="${v.box.x} ${v.box.y} ${v.box.w} ${v.box.h}"/>`);
  parts.push(`<g id="board-${esc(doc.id)}">`);
  parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${doc.background.color || '#fff'}"/>`);
  parts.push(...svgObjects(app.store.objects, meas));
  parts.push(...links(app.store.objects));
  parts.push(stampSvg(box));
  parts.push('</g>');
  for (const { src, bb, dx, dy, top } of placed) {
    parts.push(`<text x="${box.x}" y="${top + 46}" font-family="${family}" font-size="34" font-weight="600" fill="#201f1e">${esc(src.name || t('Untitled board'))}</text>`);
    parts.push(`<a href="#gb-${esc(doc.id)}"><text x="${box.x + bb.w}" y="${top + 46}" text-anchor="end" font-family="${family}" font-size="24" fill="#0f6cbd">↑ ${esc(doc.name || t('Untitled board'))}</text></a>`);
    parts.push(`<g id="board-${esc(src.id)}" transform="translate(${dx} ${dy})">`);
    parts.push(`<rect x="${bb.x}" y="${bb.y}" width="${bb.w}" height="${bb.h}" fill="${src.store.doc.background.color || '#fff'}"/>`);
    useConnectorStore(src.store);
    try {
      parts.push(...svgObjects(src.store.objects, meas));
      parts.push(...links(src.store.objects));
    } finally { useConnectorStore(app.store); }
    parts.push(stampSvg(bb));
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** Every object of a board, as SVG elements. */
function svgObjects(objects, meas) {
  const parts = [];
  for (const o of objects) {
    if (o.hidden) continue;       // written on a cover that has been lifted
    const b = worldBounds(o);
    const rot = o.rotation ? ` transform="rotate(${(o.rotation * 180) / Math.PI} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : '';
    if (o.type === 'stroke') {
      const d = o.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const hl = o.tool === 'highlighter';
      // a pencil line goes out as soft graphite: its width and darkness, without the grain an SVG cannot carry
      const pencil = !hl && o.effect === 'pencil';
      const op = hl ? (o.opacity ?? 0.38) : pencil ? +pencilDarkness(o).toFixed(2) : null;
      parts.push(`<path d="${d}" fill="none" stroke="${o.color}" stroke-width="${pencil ? +pencilWidth(o).toFixed(2) : o.width}" stroke-linecap="round" stroke-linejoin="round"${op != null ? ` opacity="${op}"` : ''}${rot}/>`);
    } else if (o.type === 'connector') {
      parts.push(connectorSvg(o));
    } else if (o.type === 'boardlink') {
      // a card for another board goes out as a picture of itself
      const k = 2, cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(o.w * k)); cv.height = Math.max(1, Math.ceil(o.h * k));
      const cx = cv.getContext('2d');
      cx.scale(k, k); cx.translate(-o.x, -o.y);
      drawBoardLink(cx, { ...o, rotation: 0 }, null);
      parts.push(`<image x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${cv.toDataURL('image/png')}"${rot}><title>${esc(refLabel(o.board || {}))}</title></image>`);
    } else if (o.type === 'shape') {
      parts.push(shapeSvg(o, rot));
      if (o.text) parts.push(textSvg(meas, o.text, o.x + 10, o.y + 10, o.w - 20, o.h - 20, { align: 'center', valign: 'middle', color: o.textColor || '#201f1e', size: o.fontSize || 20, runs: objectRuns(o), bold: o.bold, italic: o.italic, font: o.font }, rot));
    } else if (o.type === 'note') {
      parts.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="4" fill="${o.color}"${rot}/>`);
      if (o.text) parts.push(textSvg(meas, o.text, o.x + 14, o.y + 14, o.w - 28, o.h - 28, { align: o.align || 'center', valign: 'middle', color: o.textColor || '#201f1e', size: o.fontSize || 22, runs: objectRuns(o), bold: o.bold, italic: o.italic, underline: o.underline, font: o.font }, rot));
    } else if (o.type === 'text') {
      parts.push(textSvg(meas, o.text, o.x, o.y, o.w, o.h, { align: o.align || 'left', valign: 'top', color: o.color, size: o.fontSize || 24, font: o.font, runs: objectRuns(o), bold: o.bold, italic: o.italic, underline: o.underline }, rot));
    } else if (o.type === 'emoji') {
      /*
       * An emoji goes out as the character itself, not as a picture of it.
       * Whoever opens the SVG sees it in their own emoji font, which is the
       * same bargain the board makes on screen; a viewer with no emoji font
       * at all gets a placeholder box, and there is nothing to be done about
       * that short of embedding a font in every export.
       */
      const size = Math.min(o.w, o.h);
      parts.push(`<text x="${o.x + o.w / 2}" y="${o.y + o.h / 2}" font-size="${size}" text-anchor="middle" dominant-baseline="central" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"${rot}>${esc(o.ch || '')}</text>`);
    } else if (o.type === 'math') {
      /*
       * A maths box goes out as a sharp picture of the formula. The board's
       * own picture of it is an SVG holding web page text, which browsers show
       * but Word, Inkscape and Illustrator do not; a PNG every one of them can.
       */
      const e = mathEntry(o.tex, o.color || '#201f1e');
      if (e.status === 'ready' && e.img) {
        const k = Math.min(Math.abs(o.w) / e.w, Math.abs(o.h) / e.h), dw = e.w * k, dh = e.h * k;
        const x = Math.min(o.x, o.x + o.w) + (Math.abs(o.w) - dw) / 2, y = Math.min(o.y, o.y + o.h) + (Math.abs(o.h) - dh) / 2;
        parts.push(`<image x="${x}" y="${y}" width="${dw}" height="${dh}" href="${mathPng(e, dw, dh)}"${rot}><title>${esc(o.tex || '')}</title></image>`);
      }
    } else if (o.type === 'image') {
      parts.push(`<image x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${o.src}" preserveAspectRatio="none"${rot}/>`);
    } else if (o.type === 'curtain') {
      // a lifted cover is not on the board, so it is not in the picture either
      if (!o.revealed) {
        parts.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${Math.min(14, Math.abs(o.w) / 6, Math.abs(o.h) / 6)}" fill="${o.color || CURTAIN_COLOR}"${rot}/>`);
      }
    } else if (o.type === 'table') {
      if (!validTableSize(o)) continue;
      const cw = o.w / o.cols, ch = o.h / o.rows;
      parts.push(`<g${rot}><rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.fill || '#fff'}"/>`);
      for (let c = 0; c <= o.cols; c++) parts.push(`<line x1="${o.x + c * cw}" y1="${o.y}" x2="${o.x + c * cw}" y2="${o.y + o.h}" stroke="${o.stroke || '#605e5c'}" stroke-width="${o.lineWidth || 2}"/>`);
      for (let r = 0; r <= o.rows; r++) parts.push(`<line x1="${o.x}" y1="${o.y + r * ch}" x2="${o.x + o.w}" y2="${o.y + r * ch}" stroke="${o.stroke || '#605e5c'}" stroke-width="${o.lineWidth || 2}"/>`);
      for (const [key, val] of Object.entries(o.cells || {})) {
        const [r, c] = key.split(',').map(Number);
        parts.push(textSvg(meas, val, o.x + c * cw + 6, o.y + r * ch + 6, cw - 12, ch - 12, { align: 'center', valign: 'middle', color: '#201f1e', size: 16, runs: objectRuns(o, key) }, ''));
      }
      parts.push('</g>');
    }
  }
  return parts;
}

function shapeSvg(o, rot) {
  const st = `fill="${o.fill && o.fill !== 'none' ? o.fill : 'none'}" stroke="${o.stroke && o.stroke !== 'none' ? o.stroke : 'none'}" stroke-width="${o.lineWidth || 3}" stroke-linejoin="round" stroke-linecap="round"`;
  const { x, y, w, h } = o;
  const cx = x + w / 2, cy = y + h / 2;
  switch (o.kind) {
    case 'ellipse': case 'circle':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${Math.abs(w / 2)}" ry="${Math.abs(h / 2)}" ${st}${rot}/>`;
    case 'roundRect':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(Math.abs(w), Math.abs(h)) * 0.16}" ${st}${rot}/>`;
    case 'line': case 'arrow': case 'doubleArrow': {
      const marker = o.kind === 'line' ? '' : ' marker-end="url(#ah)"';
      return `<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="${o.stroke}"/></marker></defs>` +
        `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="${o.stroke}" stroke-width="${o.lineWidth || 3}" stroke-linecap="round"${marker}${rot}/>`;
    }
    case 'triangle': return `<polygon points="${cx},${y} ${x + w},${y + h} ${x},${y + h}" ${st}${rot}/>`;
    case 'diamond': return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" ${st}${rot}/>`;
    case 'pentagon': case 'hexagon': case 'octagon': {
      const n = o.kind === 'pentagon' ? 5 : o.kind === 'hexagon' ? 6 : 8;
      const start = o.kind === 'pentagon' ? -Math.PI / 2 : o.kind === 'hexagon' ? 0 : Math.PI / 8;
      const pts = [];
      for (let i = 0; i < n; i++) { const a = start + (i * Math.PI * 2) / n; pts.push(`${cx + Math.cos(a) * w / 2},${cy + Math.sin(a) * h / 2}`); }
      return `<polygon points="${pts.join(' ')}" ${st}${rot}/>`;
    }
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const f = i % 2 ? 0.42 : 1; pts.push(`${cx + Math.cos(a) * (w / 2) * f},${cy + Math.sin(a) * (h / 2) * f}`); }
      return `<polygon points="${pts.join(' ')}" ${st}${rot}/>`;
    }
    default: return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${st}${rot}/>`;
  }
}

function textSvg(meas, text, x, y, w, h, opt, rot) {
  const size = opt.size || 20;
  const family = faceOf(opt.font);      // every face, not just handwriting
  if (opt.runs || needsRich(text)) return richTextSvg(meas, x, y, w, h, { ...opt, runs: opt.runs || [{ t: text }] }, rot, size, family);
  meas.font = `${size}px ${family}`;
  const lines = wrapText(meas, text, w);
  const lh = size * 1.28;
  let ty = y + size;
  if (opt.valign === 'middle') ty = y + (h - lines.length * lh) / 2 + size;
  const anchor = opt.align === 'center' ? 'middle' : opt.align === 'right' ? 'end' : 'start';
  const tx = opt.align === 'center' ? x + w / 2 : opt.align === 'right' ? x + w : x;
  const spans = lines.map((l, i) => `<tspan x="${tx}" y="${(ty + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join('');
  return `<text font-family="${esc(family).replace(/"/g, "'")}" font-size="${size}" fill="${opt.color || '#201f1e'}" text-anchor="${anchor}"${rot}>${spans}</text>`;
}

/*
 * Styled words in an SVG: the same line breaks the board makes, each line a
 * text chunk of its own, each styled stretch a <tspan> carrying its weight,
 * slant, underline and colour. Anything that opens an SVG - a browser,
 * Inkscape, PowerPoint - shows them as they were on the board.
 */
function richTextSvg(meas, x, y, w, h, opt, rot, size, family) {
  const base = { family, weight: '400', bold: !!opt.bold, italic: !!opt.italic, underline: !!opt.underline, color: opt.color || '#201f1e', size };
  const lines = layoutRich(meas, opt.runs, w, base);
  const lh = size * 1.28;
  let ty = y + size;
  if (opt.valign === 'middle') ty = y + (h - lines.length * lh) / 2 + size;
  const anchor = opt.align === 'center' ? 'middle' : opt.align === 'right' ? 'end' : 'start';
  const tx = opt.align === 'center' ? x + w / 2 : opt.align === 'right' ? x + w : x;
  // A line with maths in it is laid out piece by piece, so each formula's
  // picture can sit exactly where the board draws it.
  const pictures = [];
  const rows = lines.map((line, i) => {
    if (line.segs.some((sg) => sg.math != null || sg.ref)) {
      let lx = opt.align === 'center' ? x + (w - line.w) / 2 : opt.align === 'right' ? x + w - line.w : x;
      const by = ty + i * lh;
      const out = [];
      for (const sg of line.segs) {
        const e0 = effective(sg.st, base);
        if (sg.ref) {
          // a link to a board: its name on its pill, as the board shows it
          const col = chipColours(refMissing(sg.ref), false), pad = chipPad(size);
          pictures.push(`<rect x="${(lx + 1).toFixed(1)}" y="${(by - size * 0.08).toFixed(1)}" width="${Math.max(2, sg.w - 2).toFixed(1)}" height="${(size * 1.2).toFixed(1)}" rx="${(size * 0.35).toFixed(1)}" fill="${col.fill}"/>`);
          pictures.push(`<text x="${(lx + pad).toFixed(1)}" y="${(by + size).toFixed(1)}" font-family="${esc(family).replace(/"/g, "'")}" font-size="${size}" fill="${col.ink}"${e0.bold ? ' font-weight="600"' : ''}${e0.italic ? ' font-style="italic"' : ''}>${esc(sg.t)}</text>`);
          lx += sg.w;
          continue;
        }
        const me = sg.math != null ? mathEntry(sg.math, e0.color || '#201f1e', null, false) : null;
        if (me && me.status === 'ready' && me.img) {
          const f = inlineFit(me, size, lh);
          const dw = me.w * f.k, dh = me.h * f.k;
          pictures.push(`<image x="${(lx - f.pad).toFixed(1)}" y="${(by - me.base * f.k).toFixed(1)}" width="${dw.toFixed(1)}" height="${dh.toFixed(1)}" href="${mathPng(me, dw, dh)}"><title>${esc(sg.math)}</title></image>`);
        } else {
          const attrs = [];
          if (e0.bold) attrs.push('font-weight="600"');
          if (e0.italic) attrs.push('font-style="italic"');
          if (e0.underline) attrs.push('text-decoration="underline"');
          if (e0.color && e0.color !== base.color) attrs.push(`fill="${esc(e0.color)}"`);
          out.push(`<tspan x="${lx.toFixed(1)}" y="${by.toFixed(1)}" text-anchor="start" ${attrs.join(' ')}>${esc(sg.t)}</tspan>`);
        }
        lx += sg.w;
      }
      return out.join('');
    }
    const segs = line.segs.map((sg) => {
      const e = effective(sg.st, base);
      const attrs = [];
      if (e.bold) attrs.push('font-weight="600"');
      if (e.italic) attrs.push('font-style="italic"');
      if (e.underline) attrs.push('text-decoration="underline"');
      if (e.color && e.color !== base.color) attrs.push(`fill="${esc(e.color)}"`);
      return attrs.length ? `<tspan ${attrs.join(' ')}>${esc(sg.t)}</tspan>` : esc(sg.t);
    }).join('');
    return `<tspan x="${tx}" y="${(ty + i * lh).toFixed(1)}">${segs}</tspan>`;
  }).join('');
  const words = `<text xml:space="preserve" font-family="${esc(family).replace(/"/g, "'")}" font-size="${size}" fill="${esc(base.color)}" text-anchor="${anchor}"${rot}>${rows}</text>`;
  return pictures.length ? `<g${rot}>${words.replace(rot, '')}${pictures.join('')}</g>` : words;
}

/* ------------------------------------------------------------------ *
 *  PDF
 *
 *  Each sheet is rendered by the same canvas renderer that paints the
 *  board, so the PDF is exactly what you were looking at. The bitmaps go
 *  into an HTML page sized in millimetres, which the main process prints.
 * ------------------------------------------------------------------ */
const MM_PER_PX = 25.4 / 96;
const MAX_SHEETS = 300;

/* ------------------------------------------------------------------ *
 *  The boards a board links to, in a PDF or an SVG
 *
 *  A link in a file sent to someone goes nowhere unless the board it names
 *  is in the file too. So, when asked, the linked boards go in after this
 *  one, and every link to a board that is in the file becomes clickable.
 * ------------------------------------------------------------------ */

/**
 * The boards with these ids, each read and made ready to draw: its pictures
 * loaded and its maths typeset. A board that cannot be read is left out.
 * @returns {Promise<{id:string,name:string,store:Store}[]>}
 */
export async function linkedSources(app, ids) {
  const out = [];
  for (const id of ids || []) {
    if (!id || id === app.store.doc.id || out.some((x) => x.id === id)) continue;
    let data = null;
    try { data = await window.board.boards.load(id); } catch { data = null; }
    if (!data) continue;
    try { data = (await app.resolveAssets?.(data)) || data; } catch { /* drawn without its pictures */ }
    const store = new Store();
    try { store.load(data); } catch { continue; }
    store.doc.id = id;
    await picturesReady(store.objects);
    await app.mathsReady?.(store.objects);
    out.push({ id, name: store.doc.name, store });
  }
  return out;
}

/** Wait (a few seconds at most) for every picture on a board to be loaded, so it is in the drawing. */
async function picturesReady(objects) {
  const srcs = [...new Set(objects.filter((o) => o && o.type === 'image' && o.src).map((o) => o.src))];
  const until = Date.now() + 5000;
  while (srcs.some((src) => !getImage(src)) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Draw part of a board that is not the open one, exactly as the board itself is drawn. */
function renderOther(app, src, box, scale) {
  const wasDark = isDarkBoard();
  setDarkBoard(false);
  useConnectorStore(src.store);
  try { return Surface.prototype._renderTo.call({ store: src.store }, box, scale, true, true); }
  finally { useConnectorStore(app.store); setDarkBoard(wasDark); }
}

/**
 * Where the links are on one sheet, as fractions of its picture, each with the
 * sheet it jumps to. Only links to something in the file are kept.
 */
function sheetLinks(src, tile, target) {
  const out = [];
  for (const o of src.store.objects) {
    if (!o || o.hidden || !boxesIntersect(tile, worldBounds(o))) continue;
    for (const { ref, quad } of linkRectsOf(o)) {
      const to = target(ref);
      if (to == null) continue;
      const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
      const x0 = Math.max(tile.x, Math.min(...xs)), x1 = Math.min(tile.x + tile.w, Math.max(...xs));
      const y0 = Math.max(tile.y, Math.min(...ys)), y1 = Math.min(tile.y + tile.h, Math.max(...ys));
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      out.push({ fx: (x0 - tile.x) / tile.w, fy: (y0 - tile.y) / tile.h, fw: (x1 - x0) / tile.w, fh: (y1 - y0) / tile.h, to });
    }
  }
  return out;
}

export async function exportPdf(app, opts) {
  await app.mathsReady?.();
  const main = { id: app.store.doc.id, name: app.store.doc.name, store: app.store, main: true };
  const sheets = [];        // { src, box, wMm, hMm, q, page }
  let L;

  // A pad exports as itself: one PDF page per board page, at the board's own
  // paper size. Tiling is for infinite boards, which have no page boundaries
  // of their own and have to be cut into sheets somehow.
  const padRects = pageRects(app.store.doc.pages);
  if (padRects.length) {
    const first = padRects[0];
    const pageW = first.w * MM_PER_PX, pageH = first.h * MM_PER_PX;
    L = { pageW, pageH, innerW: pageW, innerH: pageH, marginMm: 0 };
    padRects.forEach((r, i) => {
      const want = opts.quality || 2;
      const longest = Math.max(r.w, r.h);
      sheets.push({ src: main, box: r, wMm: r.w * MM_PER_PX, hMm: r.h * MM_PER_PX, q: longest * want > 10000 ? 10000 / longest : want, page: i + 1 });
    });
  } else {
    const box = exportBounds(app, 40);
    L = layoutPages(box, opts);
    if (L.cols * L.rows > 200) { app.toast(t('That is over 200 pages — try a bigger page size')); return null; }
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const tile = L.cols === 1 && L.rows === 1
          ? box
          : { x: box.x + c * L.tileW, y: box.y + r * L.tileH, w: L.tileW, h: L.tileH };
        // Render at the resolution the sheet will actually be printed at: when
        // "fit on one page" enlarges a small board, the bitmap has to grow with
        // it or the print comes out soft. Capped so a huge board cannot
        // exhaust memory.
        const want = (opts.quality || 2) * Math.max(1, L.scale ?? 1);
        const longest = Math.max(tile.w, tile.h);
        sheets.push({ src: main, box: tile, wMm: tile.w * MM_PER_PX * (L.scale ?? 1), hMm: tile.h * MM_PER_PX * (L.scale ?? 1), q: longest * want > 10000 ? 10000 / longest : want, page: 0 });
      }
    }
  }

  // opts.filePath lets the test suite run this end to end without a native dialog
  const filePath = opts.filePath || await window.board.saveDialog({
    title: t('Export as PDF'),
    defaultPath: safeName(app.store.doc.name) + '.pdf',
    filters: [{ name: t('PDF document'), extensions: ['pdf'] }]
  });
  if (!filePath) return null;

  // The linked boards come after, each fitted on the same size of paper:
  // a pad page by page, an infinite board whole on one sheet.
  const others = await linkedSources(app, opts.linked);
  for (const src of others) {
    const rects = pageRects(src.store.doc.pages);
    const cb = src.store.contentBounds();
    const boxes = rects.length ? rects : [cb ? { x: cb.x - 40, y: cb.y - 40, w: cb.w + 80, h: cb.h + 80 } : { x: 0, y: 0, w: 400, h: 300 }];
    boxes.forEach((r, i) => {
      const k = Math.min(L.innerW / (r.w * MM_PER_PX), L.innerH / (r.h * MM_PER_PX));
      const want = (opts.quality || 2) * Math.max(1, k);
      const longest = Math.max(r.w, r.h);
      sheets.push({ src, box: r, wMm: r.w * MM_PER_PX * k, hMm: r.h * MM_PER_PX * k, q: longest * want > 10000 ? 10000 / longest : want, page: rects.length ? i + 1 : 0 });
    });
  }
  const n = sheets.length;
  if (n > MAX_SHEETS) { app.toast(t('That is over {n} pages — include fewer linked boards', { n: MAX_SHEETS })); return null; }

  // which sheet each board, and each page of a pad, starts on
  const first = new Map();
  sheets.forEach((sh, i) => {
    if (!first.has(sh.src.id)) first.set(sh.src.id, i);
    if (sh.page) first.set(sh.src.id + '#' + sh.page, i);
  });
  const target = (ref) => {
    const b = lookupBoard(ref);
    if (!b) return null;
    if (ref.page > 0 && first.has(b.id + '#' + ref.page)) return first.get(b.id + '#' + ref.page);
    return first.has(b.id) ? first.get(b.id) : null;
  };

  const progress = app.showProgress(t('Exporting PDF'), n > 1 ? t('{n} of {total} pages', { n: 0, total: n }) : t('Rendering…'));
  try {
    const pages = [];
    for (const sh of sheets) {
      const canvas = sh.src.main ? app.surface.renderTo(sh.box, sh.q, true) : renderOther(app, sh.src, sh.box, sh.q);
      // "Made with GazBoard", 2.6 mm high, 4 mm in from the corner of the sheet's picture
      const pxPerMm = canvas.width / Math.min(sh.wMm, L.innerW);
      const made = stampCanvas(canvas, 2.6 * pxPerMm, 4 * pxPerMm);
      const sheetLinksHere = sheetLinks(sh.src, sh.box, target);
      sheetLinksHere.push({ ...made, url: MADE_WITH.url });
      pages.push({ src: canvas.toDataURL('image/png'), wMm: sh.wMm, hMm: sh.hMm, links: sheetLinksHere });
      const k = pages.length;
      progress.update(k / n, n > 1 ? t('{n} of {total} pages', { n: k, total: n }) : t('Rendering…'));
      await new Promise((r2) => setTimeout(r2, 0));       // let the UI breathe
    }

    progress.update(0.95, t('Writing the PDF…'));
    // opts.printer lets the suite see the page the PDF is printed from
    // the board's name is the PDF's title, which is what a PDF reader shows in its title bar
    const payload = { html: pdfHtml(pages, L, app.store.doc.name || t('Untitled board')), widthIn: L.pageW / 25.4, heightIn: L.pageH / 25.4 };
    const res = await (opts.printer ? opts.printer(payload) : window.board.exportPdf(payload));
    if (!res.ok) { progress.close(); app.toast(res.error || t('PDF export failed')); return null; }
    await window.board.writeFile(filePath, res.data);
    progress.close();
    app.toast(n === 1
      ? t('Exported {name} — {n} page', { name: filePath.split(/[\\/]/).pop(), n })
      : t('Exported {name} — {n} pages', { name: filePath.split(/[\\/]/).pop(), n }));
    return filePath;
  } catch (e) {
    progress.close();
    app.toast(t('PDF export failed: {error}', { error: e.message }));
    return null;
  }
}

function pdfHtml(pages, L, title = '') {
  const margin = L.marginMm || 0;
  const body = pages.map((p, i) => {
    // centre the sheet's bitmap inside the printable area
    const w = Math.min(p.wMm, L.innerW), h = Math.min(p.hMm, L.innerH);
    const left = margin + (L.innerW - w) / 2, top = margin + (L.innerH - h) / 2;
    // a link is a clear box over the words or card it is on; the PDF printer
    // turns each into a jump to the sheet it names
    const links = (p.links || []).map((k) => {
      const x = left + k.fx * w, y = top + k.fy * h, lw = k.fw * w, lh = k.fh * h;
      if (k.url) return `<a class="gblink" href="${esc(k.url)}" data-url="${esc(k.url)}" data-x="${x.toFixed(2)}" data-y="${y.toFixed(2)}" data-w="${lw.toFixed(2)}" data-h="${lh.toFixed(2)}" style="left:${x.toFixed(2)}mm;top:${y.toFixed(2)}mm;width:${lw.toFixed(2)}mm;height:${lh.toFixed(2)}mm"></a>`;
      return `<a class="gblink" href="#s${k.to}" data-to="${k.to}" data-x="${x.toFixed(2)}" data-y="${y.toFixed(2)}" data-w="${lw.toFixed(2)}" data-h="${lh.toFixed(2)}" style="left:${x.toFixed(2)}mm;top:${y.toFixed(2)}mm;width:${lw.toFixed(2)}mm;height:${lh.toFixed(2)}mm"></a>`;
    }).join('');
    return `<div class="sheet" id="s${i}"><img src="${p.src}" style="width:${w}mm;height:${h}mm">${links}</div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: ${L.pageW}mm ${L.pageH}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .sheet {
    position: relative;
    width: ${L.pageW}mm; height: ${L.pageH}mm;
    box-sizing: border-box; padding: ${margin}mm;
    display: flex; align-items: center; justify-content: center;
    page-break-after: always; break-after: page; overflow: hidden;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  img { display: block; image-rendering: auto; }
  a.gblink { position: absolute; display: block; }
  </style></head><body>
${body}
  </body></html>`;
}

/* ------------------------------------------------------------------ *
 *  .gazboard files
 * ------------------------------------------------------------------ */
/**
 * A picture whose file is missing is held in memory as an empty src plus the
 * reference it could not resolve, so nothing tries to load a URL that is not
 * there. Writing that empty src into a .gazboard file would throw the reference
 * away and make the loss permanent - the file would carry an image object with
 * no picture and no way to find one, even back on the machine that has it.
 * Write the reference instead: put the file back and the picture returns.
 *
 * Exported so the suite can check it without driving a native save dialog.
 */
export function exportable(doc) {
  if (!doc || !Array.isArray(doc.objects)) return doc;
  // `origin` records where this copy was opened from on this machine. Sending
  // "C:\\Users\\...\\Downloads\\board.gazboard" to whoever you share the file with
  // is nobody's business but yours.
  const { origin, ...doc2 } = doc;
  doc = doc2;
  return { ...doc, objects: doc.objects.map((o) => {
    if (!o || o.type !== 'image' || !o.missing || !o.assetId) return o;
    const { missing, ...rest } = o;          // a runtime marker, not board data
    return { ...rest, src: 'asset:' + o.assetId, assetId: o.assetId };
  }) };
}

export async function saveBoardFile(app) {
  const filePath = await window.board.saveDialog({
    title: t('Save a copy'),
    defaultPath: safeName(app.store.doc.name) + '.gazboard',
    filters: [{ name: t('GazBoard file'), extensions: ['gazboard'] }, { name: 'JSON', extensions: ['json'] }]
  });
  if (!filePath) return null;
  const json = JSON.stringify(exportable(app.store.toJSON({ app: 'GazBoard', version: 1 })), null, 0);
  await window.board.writeFile(filePath, new TextEncoder().encode(json).buffer);
  app.toast(t('Saved {name}', { name: filePath.split(/[\\/]/).pop() }));
  return filePath;
}

/**
 * @param {{folder?: string|null}} opts  folder: the My boards folder this was asked for from. A board that is
 *   new to this computer is filed there; one it already had stays wherever it is.
 */
export async function openBoardFile(app, opts = {}) {
  const paths = await window.board.openDialog({
    title: t('Open a board'),
    properties: ['openFile'],
    filters: [{ name: t('GazBoard file'), extensions: ['gazboard', 'openboard', 'json'] }]
  });
  if (!paths || !paths.length) return false;
  const buf = await window.board.readFile(paths[0]);
  const data = JSON.parse(new TextDecoder().decode(buf));
  // Which file this is, so re-opening it returns to its own board instead of
  // asking again and making another copy. See claimLocalBoard().
  let origin = paths[0];
  try { origin = (await window.board.fileOrigin?.(paths[0])) || paths[0]; } catch { /* keep the path */ }
  data.origin = origin;
  let before = null;
  if (opts.folder) { try { before = new Set(((await window.board.boards.list()) || []).map((b) => b.id)); } catch { before = null; } }
  await app.loadBoard(data, { asCopy: false });
  if (before && !before.has(app.store.doc.id)) app.fileBoardIn?.(app.store.doc.id, opts.folder);
  app.toast(t('Opened {name}', { name: data.name || t('board') }));
  return true;
}

export const safeName = (n) => String(n || 'board').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80).trim() || 'board';
