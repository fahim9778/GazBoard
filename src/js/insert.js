// Inserting images and documents (Word / PowerPoint / PDF) onto the board.

import { pageRects, pageIndexForBox, offsetIntoRect, nearestPageIndex } from './core/pages.js';
import { uid } from './core/util.js';
import { boundsOf } from './core/store.js';
import { openPdf } from './importers/pdf.js';
import { choosePages } from './ui/pagepicker.js';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const DOC_EXT = ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'odt', 'odp', 'rtf', 'txt', 'xlsx', 'xls'];

export const FILTERS = {
  image: [{ name: 'Images', extensions: IMAGE_EXT }],
  document: [
    { name: 'Documents', extensions: DOC_EXT },
    { name: 'PDF', extensions: ['pdf'] },
    { name: 'Word', extensions: ['docx', 'doc', 'rtf', 'odt'] },
    { name: 'PowerPoint', extensions: ['pptx', 'ppt', 'odp'] }
  ],
  any: [{ name: 'All supported', extensions: [...IMAGE_EXT, ...DOC_EXT] }]
};

const bytesToDataUrl = (buf, mime) => new Promise((res) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.readAsDataURL(new Blob([buf], { type: mime }));
});

const mimeFor = (ext) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[ext] || 'image/png');

/**
 * Sniff the real file type from its magic bytes so a renamed executable can't
 * pass as an image.
 *
 * From a contribution by @anupamme (PR #1). The WEBP fourcc check at offset 8
 * is the one addition: "RIFF" alone is any RIFF container, a .wav among them.
 *
 * This is defence in depth rather than a hole being closed - a renamed binary
 * served as a data: URL cannot execute, it simply fails to decode. What it
 * genuinely buys is refusing to hand unverified bytes to an SVG parser, and
 * telling you the file is wrong instead of failing later with "Could not read
 * image".
 */
function looksLikeImage(buf, ext) {
  const b = new Uint8Array(buf);
  if (ext === 'png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  if (ext === 'jpg' || ext === 'jpeg') return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  if (ext === 'gif') return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  if (ext === 'bmp') return b[0] === 0x42 && b[1] === 0x4D;
  if (ext === 'webp') return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (ext === 'svg') return /^\s*(<\?xml|<svg)/i.test(new TextDecoder().decode(b.slice(0, 256)));
  return false;
}

/** Exposed so the suite can check the sniffer without touching the filesystem. */
export const looksLikeImageForTest = looksLikeImage;

/** Name every file that was turned away, so a skipped import is never silent. */
function reportRejected(app, rejected) {
  if (!rejected.length) return;
  const names = rejected.slice(0, 3).join(', ');
  const more = rejected.length > 3 ? ` and ${rejected.length - 3} more` : '';
  app.toast(rejected.length === 1
    ? `${names} is not the image it claims to be — skipped`
    : `${rejected.length} files are not the images they claim to be — skipped: ${names}${more}`, 'help', 4200);
}

function measure(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
    img.onerror = () => rej(new Error('Could not read image'));
    img.src = dataUrl;
  });
}

const DROP_GAP = 40;         // breathing room between a new arrival and its neighbours
const DROP_RINGS = 6;       // how far out to look before giving up on "nearby"

/**
 * Where a newly inserted picture or page should land.
 *
 * The old rule was one line: eighty pixels to the right of everything already
 * on the board. On a fresh board that is exactly right. On a board that has
 * been used it is a trap, because "everything" includes the far end - a sticky
 * note somebody dragged off to the side an hour ago, or the last page of a
 * ninety-page PDF imported this morning. The new picture then lands beyond ALL
 * of it, thousands of units from the sentence being written, and since the view
 * follows what it just inserted, the board appears to bolt sideways and leave
 * the work behind.
 *
 * What a person means by "put it here" is: near what I am looking at, and not
 * on top of anything. So the search starts at the middle of the current view
 * and steps outwards a slot at a time until it finds room. Ring by ring, so
 * whatever it finds is the CLOSEST free space rather than merely the first one
 * some scan happened to reach - and the ring is left as soon as it yields
 * anything, because a nearer spot can never appear in a later one.
 *
 * Only when the whole neighbourhood is full does it fall back to the old
 * behaviour, which is the honest answer at that point: there is genuinely no
 * room near you.
 */
export function dropOrigin(app, w, h) {
  const view = app.surface.cam.viewport(app.surface.width, app.surface.height);
  const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
  const middle = { x: cx - w / 2, y: cy - h / 2 };

  const taken = [];
  for (const o of app.store.objects) { const b = boundsOf(o); if (b) taken.push(b); }
  if (!taken.length) return middle;

  const clear = (x, y) => !taken.some((b) =>
    x < b.x + b.w + DROP_GAP && x + w + DROP_GAP > b.x
    && y < b.y + b.h + DROP_GAP && y + h + DROP_GAP > b.y);

  if (clear(middle.x, middle.y)) return middle;

  // A slot is the thing's own size: the next place it could sit without
  // touching where it would have been.
  const stepX = w + DROP_GAP, stepY = h + DROP_GAP;
  for (let r = 1; r <= DROP_RINGS; r++) {
    let best = null, bestD = Infinity;
    for (let iy = -r; iy <= r; iy++) {
      for (let ix = -r; ix <= r; ix++) {
        if (Math.max(Math.abs(ix), Math.abs(iy)) !== r) continue;   // this ring only
        const x = middle.x + ix * stepX, y = middle.y + iy * stepY;
        if (!clear(x, y)) continue;
        const d = Math.hypot(x + w / 2 - cx, y + h / 2 - cy);
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    if (best) return best;
  }

  const b = app.store.contentBounds();
  return b ? { x: b.x + b.w + DROP_GAP * 2, y: b.y } : middle;
}

export async function insertImagesFromPaths(app, paths) {
  const objs = [];
  const rejected = [];
  for (const p of paths) {
    const ext = p.split('.').pop().toLowerCase();
    if (!IMAGE_EXT.includes(ext)) continue;
    const name = p.split(/[\\/]/).pop();
    const buf = await window.board.readFile(p);
    // the extension says what it is; the bytes decide
    if (!looksLikeImage(buf, ext)) { rejected.push(name); continue; }
    const dataUrl = await bytesToDataUrl(buf, mimeFor(ext));
    objs.push(await makeImageObject(app, dataUrl, name, objs.length));
  }
  reportRejected(app, rejected);
  if (objs.length) {
    app.store.addMany(objs, 'insert image');
    app.setSelection(objs.map((o) => o.id));
    app.frameSelection();
  }
  return objs;
}

export async function insertImageFiles(app, files, at) {
  const objs = [];
  const rejected = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    // A dropped file arrives with a MIME type the OS guessed from its name, so
    // this path needs the same check - more so, since nothing here ever looked
    // at an extension in the first place.
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXT.includes(ext)) {
      const head = await f.slice(0, 256).arrayBuffer();
      if (!looksLikeImage(head, ext)) { rejected.push(f.name); continue; }
    }
    const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    objs.push(await makeImageObject(app, dataUrl, f.name, objs.length, at));
  }
  reportRejected(app, rejected);
  if (objs.length) {
    app.store.addMany(objs, 'insert image');
    app.setSelection(objs.map((o) => o.id));
  }
  return objs;
}

async function makeImageObject(app, dataUrl, name, index = 0, at) {
  const { w, h } = await measure(dataUrl);
  const maxW = 640;
  const scale = Math.min(1, maxW / w);
  const W = w * scale, H = h * scale;
  const o = at ? { x: at.x - W / 2, y: at.y - H / 2 } : dropOrigin(app, W, H);
  const obj = { id: uid('img'), type: 'image', x: o.x + index * 24, y: o.y + index * 24, w: W, h: H, rotation: 0, src: dataUrl, name };
  return fitOntoPaper(app, obj);
}

/**
 * Convert a Word / PowerPoint / PDF file to page bitmaps and lay them out.
 *
 * Anything with more than one page goes through the picker first, so you can
 * take page 4 of a 90-page PDF instead of all ninety. Every page lands as its
 * own independent object - nothing is grouped.
 */
export async function insertDocument(app, filePath, opts = {}) {
  const name = filePath.split(/[\\/]/).pop();
  const progress = app.showProgress(`Importing ${name}`, 'Converting document…');
  let doc = null;
  try {
    const res = await window.board.importToPdf(filePath);
    if (!res.ok) { progress.close(); app.toast(res.error || 'Import failed'); return null; }

    progress.update(0.2, res.engine === 'libreoffice' ? 'Converted with LibreOffice — reading pages…' : 'Reading pages…');
    doc = await openPdf(res.data);
    const total = doc.numPages;
    if (!total) { progress.close(); app.toast('No pages found in that document'); return null; }
    progress.close();

    let pages = opts.pages || null;
    let layout = opts.layout || null;

    if (!pages) {
      if (total === 1) { pages = [1]; layout = layout || 'row'; }
      else {
        const choice = await choosePages(app, { name, count: total, thumb: (n) => doc.thumb(n) });
        if (!choice) { await doc.destroy(); app.toast('Import cancelled'); return null; }
        pages = choice.pages;
        layout = choice.layout;
        opts = { ...opts, quality: choice.quality };
      }
    }
    layout = layout || (pages.length > 6 ? 'grid' : 'row');

    const render = app.showProgress(`Importing ${name}`, `Rendering ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
    const rendered = [];
    for (let i = 0; i < pages.length; i++) {
      render.update((i + 1) / pages.length, `Rendering page ${pages[i]} (${i + 1} of ${pages.length})…`);
      rendered.push(await doc.render(pages[i], opts.quality ?? app.settings.importQuality ?? 2));
    }
    await doc.destroy();
    doc = null;

    const { objs, pages: padPages, focus } = layoutPages(app, rendered, { name, layout, multiPage: total > 1 });
    // growing the pad and filling it are one commit, so one undo removes both
    const ops = [];
    if (padPages) ops.push(app.store.pagesOp(padPages));
    for (const obj of objs) ops.push({ t: 'add', obj });
    app.store.commit('insert document', ops);
    app.setSelection([]);                       // separate objects, not a selected clump
    if (focus >= 0) app.goToPage(focus); else app.frameObjects(objs);
    render.close();
    app.toast(`${name}: ${objs.length} page${objs.length === 1 ? '' : 's'} added${res.engine === 'builtin' ? ' (built-in converter)' : ''}`, 'doc');
    return objs;
  } catch (e) {
    progress.close();
    if (doc) await doc.destroy().catch(() => {});
    app.toast('Import failed: ' + e.message);
    return null;
  }
}

/** Place rendered pages on the board without overlapping what is already there. */
function layoutPages(app, rendered, { name, layout, multiPage }) {
  const mk = (p, box) => ({
    id: uid('pg'), type: 'image', kind: 'page',
    x: box.x, y: box.y, w: box.w, h: box.h,
    rotation: 0, src: p.dataUrl,
    name, label: multiPage ? `${name} — page ${p.page}` : name,
    docSource: name, docPage: p.page
  });

  // On a pad, an imported document becomes pages of the pad - one sheet each,
  // centred and scaled to fit. That is what importing a PDF into a notebook is
  // supposed to mean, and it is why nothing has to be cropped.
  const pad = app.pages;
  if (pad.length) {
    const margin = 24;
    const occupied = new Set(app.store.objects.map((o) => pageIndexForBox(pad, boundsOf(o))));
    const here = app.currentPageIndex();
    const start = occupied.has(here) ? pad.length : here;

    const pages = pad.map((q) => ({ ...q }));
    while (pages.length < start + rendered.length) pages.push({ ...pad[pad.length - 1] });
    const rects = pageRects(pages);

    const objs = rendered.map((p, i) => {
      const r = rects[start + i];
      const s = Math.min((r.w - margin * 2) / p.width, (r.h - margin * 2) / p.height);
      const w = p.width * s, h = p.height * s;
      return mk(p, { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h });
    });
    return { objs, pages: pages.length > pad.length ? pages : null, focus: start };
  }

  const worldScale = 1.6;                       // 72dpi points -> comfortable board units
  const gap = 48;
  const cellW = Math.max(...rendered.map((p) => p.width)) * worldScale;
  const cellH = Math.max(...rendered.map((p) => p.height)) * worldScale;

  const perRow = layout === 'grid' ? Math.min(6, Math.ceil(Math.sqrt(rendered.length)))
    : layout === 'stack' ? 1 : rendered.length;
  const step = layout === 'stack' ? 42 : null;

  const cols = layout === 'stack' ? 1 : Math.min(perRow, rendered.length);
  const rows = layout === 'stack' ? 1 : Math.ceil(rendered.length / perRow);
  const spanW = layout === 'stack' ? cellW + step * (rendered.length - 1) : cols * (cellW + gap) - gap;
  const spanH = layout === 'stack' ? cellH + step * (rendered.length - 1) : rows * (cellH + gap) - gap;
  const origin = dropOrigin(app, spanW, spanH);

  const objs = rendered.map((p, i) => {
    let x, y;
    if (layout === 'stack') { x = origin.x + i * step; y = origin.y + i * step; }
    else {
      const col = i % perRow, row = Math.floor(i / perRow);
      x = origin.x + col * (cellW + gap);
      y = origin.y + row * (cellH + gap);
    }
    return mk(p, { x, y, w: p.width * worldScale, h: p.height * worldScale });
  });
  return { objs, pages: null, focus: -1 };
}

/**
 * Shrink and slide a new object onto the sheet it landed nearest.
 *
 * A phone photo is several thousand units across and A4 is 794, so dropping
 * one onto a pad without this would put a picture on the paper that is mostly
 * off it - and clipped ink you cannot see is exactly what pages are meant to
 * prevent.
 */
function fitOntoPaper(app, obj) {
  const pad = app.pages;
  if (!pad.length) return obj;
  const margin = 16;
  const rects = pageRects(pad);
  let i = pageIndexForBox(pad, obj);
  if (i < 0) i = nearestPageIndex(pad, obj.x + obj.w / 2, obj.y + obj.h / 2);
  const r = { x: rects[i].x + margin, y: rects[i].y + margin, w: rects[i].w - margin * 2, h: rects[i].h - margin * 2 };
  const s = Math.min(r.w / obj.w, r.h / obj.h, 1);
  if (s < 1) { obj.w *= s; obj.h *= s; }
  const { dx, dy } = offsetIntoRect(obj, r);
  obj.x += dx; obj.y += dy;
  return obj;
}

export async function pickAndInsertDocument(app) {
  const paths = await window.board.openDialog({
    title: 'Insert a document',
    properties: ['openFile', 'multiSelections'],
    filters: FILTERS.document
  });
  for (const p of paths) await insertDocument(app, p);
}

export async function pickAndInsertImage(app) {
  const paths = await window.board.openDialog({
    title: 'Insert an image',
    properties: ['openFile', 'multiSelections'],
    filters: FILTERS.image
  });
  if (paths.length) await insertImagesFromPaths(app, paths);
}

export function isImagePath(p) { return IMAGE_EXT.includes(p.split('.').pop().toLowerCase()); }
export function isDocPath(p) { return DOC_EXT.includes(p.split('.').pop().toLowerCase()); }
