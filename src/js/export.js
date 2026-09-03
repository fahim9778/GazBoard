// Exporting: PNG bitmap, SVG vector, and the .gazboard document format.

import { worldBounds } from './core/store.js';
import { pageRects } from './core/pages.js';
import { wrapText } from './core/util.js';
import { layoutPages } from './ui/pdfdialog.js';
import { FONT, faceOf } from './core/render.js';

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

export async function exportPng(app, { scale = 2, transparent = false, selectionOnly = false } = {}) {
  let box;
  if (selectionOnly && app.surface.selection.size) {
    box = app.surface.selectionBounds();
    box = { x: box.x - 24, y: box.y - 24, w: box.w + 48, h: box.h + 48 };
  } else box = exportBounds(app);

  const maxPx = 12000;
  const s = Math.min(scale, maxPx / Math.max(box.w, box.h));
  const canvas = app.surface.renderTo(box, s, !transparent);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const buf = await blob.arrayBuffer();

  const filePath = await window.board.saveDialog({
    title: 'Export as PNG',
    defaultPath: safeName(app.store.doc.name) + '.png',
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  });
  if (!filePath) return null;
  await window.board.writeFile(filePath, buf);
  app.toast('Exported ' + filePath.split(/[\\/]/).pop());
  return filePath;
}

export async function exportSvg(app) {
  const box = exportBounds(app);
  const svg = buildSvg(app, box);
  const filePath = await window.board.saveDialog({
    title: 'Export as SVG',
    defaultPath: safeName(app.store.doc.name) + '.svg',
    filters: [{ name: 'SVG image', extensions: ['svg'] }]
  });
  if (!filePath) return null;
  await window.board.writeFile(filePath, new TextEncoder().encode(svg).buffer);
  app.toast('Exported ' + filePath.split(/[\\/]/).pop());
  return filePath;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function buildSvg(app, box) {
  const doc = app.store.doc;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">`);
  parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${doc.background.color || '#fff'}"/>`);

  const meas = document.createElement('canvas').getContext('2d');

  for (const o of app.store.objects) {
    const b = worldBounds(o);
    const rot = o.rotation ? ` transform="rotate(${(o.rotation * 180) / Math.PI} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : '';
    if (o.type === 'stroke') {
      const d = o.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const hl = o.tool === 'highlighter';
      parts.push(`<path d="${d}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"${hl ? ` opacity="${o.opacity ?? 0.38}"` : ''}${rot}/>`);
    } else if (o.type === 'shape') {
      parts.push(shapeSvg(o, rot));
      if (o.text) parts.push(textSvg(meas, o.text, o.x + 10, o.y + 10, o.w - 20, o.h - 20, { align: 'center', valign: 'middle', color: o.textColor || '#201f1e', size: o.fontSize || 20 }, rot));
    } else if (o.type === 'note') {
      parts.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="4" fill="${o.color}"${rot}/>`);
      if (o.text) parts.push(textSvg(meas, o.text, o.x + 14, o.y + 14, o.w - 28, o.h - 28, { align: o.align || 'center', valign: 'middle', color: o.textColor || '#201f1e', size: o.fontSize || 22 }, rot));
    } else if (o.type === 'text') {
      parts.push(textSvg(meas, o.text, o.x, o.y, o.w, o.h, { align: o.align || 'left', valign: 'top', color: o.color, size: o.fontSize || 24, font: o.font }, rot));
    } else if (o.type === 'image') {
      parts.push(`<image x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${o.src}" preserveAspectRatio="none"${rot}/>`);
    } else if (o.type === 'table') {
      const cw = o.w / o.cols, ch = o.h / o.rows;
      parts.push(`<g${rot}><rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.fill || '#fff'}"/>`);
      for (let c = 0; c <= o.cols; c++) parts.push(`<line x1="${o.x + c * cw}" y1="${o.y}" x2="${o.x + c * cw}" y2="${o.y + o.h}" stroke="${o.stroke || '#605e5c'}" stroke-width="${o.lineWidth || 2}"/>`);
      for (let r = 0; r <= o.rows; r++) parts.push(`<line x1="${o.x}" y1="${o.y + r * ch}" x2="${o.x + o.w}" y2="${o.y + r * ch}" stroke="${o.stroke || '#605e5c'}" stroke-width="${o.lineWidth || 2}"/>`);
      for (const [key, val] of Object.entries(o.cells || {})) {
        const [r, c] = key.split(',').map(Number);
        parts.push(textSvg(meas, val, o.x + c * cw + 6, o.y + r * ch + 6, cw - 12, ch - 12, { align: 'center', valign: 'middle', color: '#201f1e', size: 16 }, ''));
      }
      parts.push('</g>');
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
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

/* ------------------------------------------------------------------ *
 *  PDF
 *
 *  Each sheet is rendered by the same canvas renderer that paints the
 *  board, so the PDF is exactly what you were looking at. The bitmaps go
 *  into an HTML page sized in millimetres, which the main process prints.
 * ------------------------------------------------------------------ */
const MM_PER_PX = 25.4 / 96;

export async function exportPdf(app, opts) {
  // A pad exports as itself: one PDF page per board page, at the board's own
  // paper size. The tiling path below is for infinite boards, which have no
  // page boundaries of their own and have to be cut into sheets somehow.
  const padRects = pageRects(app.store.doc.pages);
  if (padRects.length) return exportPadPdf(app, opts, padRects);

  const box = exportBounds(app, 40);
  const L = layoutPages(box, opts);
  const sheets = L.cols * L.rows;
  if (sheets > 200) { app.toast('That is over 200 pages — try a bigger page size'); return null; }

  // opts.filePath lets the test suite run this end to end without a native dialog
  const filePath = opts.filePath || await window.board.saveDialog({
    title: 'Export as PDF',
    defaultPath: safeName(app.store.doc.name) + '.pdf',
    filters: [{ name: 'PDF document', extensions: ['pdf'] }]
  });
  if (!filePath) return null;

  const progress = app.showProgress('Exporting PDF', sheets > 1 ? `0 of ${sheets} pages` : 'Rendering…');
  try {
    const pages = [];
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const tile = L.cols === 1 && L.rows === 1
          ? box
          : { x: box.x + c * L.tileW, y: box.y + r * L.tileH, w: L.tileW, h: L.tileH };
        // Render at the resolution the sheet will actually be printed at: when
        // "fit on one page" enlarges a small board, the bitmap has to grow with
        // it or the print comes out soft. Capped so a huge board cannot
        // exhaust memory.
        const want = opts.quality * Math.max(1, L.scale ?? 1);
        const longest = Math.max(tile.w, tile.h);
        const q = longest * want > 10000 ? 10000 / longest : want;
        const canvas = app.surface.renderTo(tile, q, true);
        pages.push({
          src: canvas.toDataURL('image/png'),
          wMm: tile.w * MM_PER_PX * (L.scale ?? 1),
          hMm: tile.h * MM_PER_PX * (L.scale ?? 1)
        });
        const n = pages.length;
        progress.update(n / sheets, sheets > 1 ? `${n} of ${sheets} pages` : 'Rendering…');
        await new Promise((r2) => setTimeout(r2, 0));       // let the UI breathe
      }
    }

    progress.update(0.95, 'Writing the PDF…');
    const html = pdfHtml(pages, L);
    const res = await window.board.exportPdf({
      html, widthIn: L.pageW / 25.4, heightIn: L.pageH / 25.4
    });
    if (!res.ok) { progress.close(); app.toast(res.error || 'PDF export failed'); return null; }
    await window.board.writeFile(filePath, res.data);
    progress.close();
    app.toast(`Exported ${filePath.split(/[\\/]/).pop()} — ${sheets} page${sheets === 1 ? '' : 's'}`);
    return filePath;
  } catch (e) {
    progress.close();
    app.toast('PDF export failed: ' + e.message);
    return null;
  }
}

/** Every sheet of the pad, in order, as the pages of one PDF. */
async function exportPadPdf(app, opts, rects) {
  const filePath = opts.filePath || await window.board.saveDialog({
    title: 'Export as PDF',
    defaultPath: safeName(app.store.doc.name) + '.pdf',
    filters: [{ name: 'PDF document', extensions: ['pdf'] }]
  });
  if (!filePath) return null;

  const n = rects.length;
  const progress = app.showProgress('Exporting PDF', n > 1 ? `0 of ${n} pages` : 'Rendering…');
  try {
    const first = rects[0];
    const pages = [];
    for (let i = 0; i < n; i++) {
      const r = rects[i];
      const want = opts.quality || 2;
      const longest = Math.max(r.w, r.h);
      const q = longest * want > 10000 ? 10000 / longest : want;
      const canvas = app.surface.renderTo(r, q, true);
      pages.push({ src: canvas.toDataURL('image/png'), wMm: r.w * MM_PER_PX, hMm: r.h * MM_PER_PX });
      progress.update((i + 1) / n, n > 1 ? `${i + 1} of ${n} pages` : 'Rendering…');
      await new Promise((r2) => setTimeout(r2, 0));         // let the UI breathe
    }

    progress.update(0.95, 'Writing the PDF…');
    const pageW = first.w * MM_PER_PX, pageH = first.h * MM_PER_PX;
    const L = { pageW, pageH, innerW: pageW, innerH: pageH, margin: 0 };
    const res = await window.board.exportPdf({ html: pdfHtml(pages, L), widthIn: pageW / 25.4, heightIn: pageH / 25.4 });
    if (!res.ok) { progress.close(); app.toast(res.error || 'PDF export failed'); return null; }
    await window.board.writeFile(filePath, res.data);
    progress.close();
    app.toast(`Exported ${filePath.split(/[\\/]/).pop()} — ${n} page${n === 1 ? '' : 's'}`);
    return filePath;
  } catch (e) {
    progress.close();
    app.toast('PDF export failed: ' + e.message);
    return null;
  }
}

function pdfHtml(pages, L) {
  const body = pages.map((p) => {
    // centre the sheet's bitmap inside the printable area
    const w = Math.min(p.wMm, L.innerW), h = Math.min(p.hMm, L.innerH);
    return `<div class="sheet"><img src="${p.src}" style="width:${w}mm;height:${h}mm"></div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${L.pageW}mm ${L.pageH}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .sheet {
    width: ${L.pageW}mm; height: ${L.pageH}mm;
    box-sizing: border-box; padding: ${L.marginMm}mm;
    display: flex; align-items: center; justify-content: center;
    page-break-after: always; break-after: page; overflow: hidden;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  img { display: block; image-rendering: auto; }
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
    title: 'Save a copy',
    defaultPath: safeName(app.store.doc.name) + '.gazboard',
    filters: [{ name: 'GazBoard file', extensions: ['gazboard'] }, { name: 'JSON', extensions: ['json'] }]
  });
  if (!filePath) return null;
  const json = JSON.stringify(exportable(app.store.toJSON({ app: 'GazBoard', version: 1 })), null, 0);
  await window.board.writeFile(filePath, new TextEncoder().encode(json).buffer);
  app.toast('Saved ' + filePath.split(/[\\/]/).pop());
  return filePath;
}

export async function openBoardFile(app) {
  const paths = await window.board.openDialog({
    title: 'Open a board',
    properties: ['openFile'],
    filters: [{ name: 'GazBoard file', extensions: ['gazboard', 'openboard', 'json'] }]
  });
  if (!paths.length) return;
  const buf = await window.board.readFile(paths[0]);
  const data = JSON.parse(new TextDecoder().decode(buf));
  // Which file this is, so re-opening it returns to its own board instead of
  // asking again and making another copy. See claimLocalBoard().
  let origin = paths[0];
  try { origin = (await window.board.fileOrigin?.(paths[0])) || paths[0]; } catch { /* keep the path */ }
  data.origin = origin;
  await app.loadBoard(data, { asCopy: false });
  app.toast('Opened ' + (data.name || 'board'));
}

export const safeName = (n) => String(n || 'board').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80).trim() || 'board';
