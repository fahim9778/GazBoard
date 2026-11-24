// A small picture of a board, drawn from its objects.
//
// This exists for one question: "somebody is sending you this - do you want
// it?" You cannot answer that without seeing what it is, and a name alone is
// no help when thirty of them say "Untitled board".
//
// It is deliberately SMALL, and that is a decision rather than a limitation.
// The dialog it appears in will often be on a projector in front of a class
// while the presenter decides. A thumbnail the size of a postage stamp is
// enough for the person standing at the laptop to recognise their own diagram
// - or to recognise that they do not want it on the wall - without the room
// getting a good look at it first. It is never blurred (a blur says "there is
// something to hide here" and invites the request to unblur), and it is never
// enlarged: content smaller than the frame is drawn at its own size and
// centred rather than blown up to fill it.

import { drawObject, isDarkBoard, setDarkBoard } from '../core/render.js';
import { boundsOf } from '../core/store.js';

// A board with tens of thousands of objects would take a visible pause to draw
// into a 170px box, and the dialog must appear at once. Past this many, the
// picture is made from the first slice; at this size nobody can tell.
const MAX_OBJECTS = 3000;

/*
 * Everything a picture needs before the first object is drawn: the canvas, the
 * paper, the objects that go in it, and where they sit. Shared by paint() and
 * paintGently(), so both make exactly the same picture.
 */
function prepare(objects, w, h, { bg = '#ffffff', dpr = 2, type } = {}) {
  const c = document.createElement('canvas');
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  const out = () => (type ? c.toDataURL(type, 0.8) : c.toDataURL());
  ctx.fillStyle = bg || '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  const list = (Array.isArray(objects) ? objects : [])
    .filter((o) => o && !o.hidden)
    .slice(0, MAX_OBJECTS);
  if (!list.length) return { out, list: [] };

  let box = null;
  for (const o of list) {
    let b = null;
    try { b = boundsOf(o); } catch { b = null; }
    if (!b || ![b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n))) continue;
    box = box ? {
      x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
      w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
      h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y)
    } : { ...b };
  }
  if (!box || box.w <= 0 || box.h <= 0) return { out, list: [] };

  const pad = 8 * dpr;
  // Capped at 1: a single small scribble is shown at the size it was drawn,
  // sitting in the middle of an otherwise empty board - which is the truth
  // about it - rather than magnified until it fills the frame and looks like
  // a finished piece of work.
  const s = Math.min(1, (c.width - pad * 2) / box.w, (c.height - pad * 2) / box.h);
  const place = () => ctx.setTransform(s, 0, 0, s,
    (c.width - box.w * s) / 2 - box.x * s,
    (c.height - box.h * s) / 2 - box.y * s);
  return { out, list, ctx, place };
}

function paint(objects, w, h, onload, opts) {
  const { out, list, ctx, place } = prepare(objects, w, h, opts);
  if (!list.length) return out();
  place();
  for (const o of list) {
    try { drawObject(ctx, o, onload); } catch { /* one bad object is not a broken dialog */ }
  }
  return out();
}

/**
 * An <img> showing this board's contents, which redraws itself if pictures on
 * the board finish loading after the first pass.
 *
 * @param {object[]} objects
 * @param {number} w  CSS pixels
 * @param {number} h  CSS pixels
 * @returns {HTMLImageElement}
 */
export function boardThumb(objects, w = 168, h = 106) {
  const img = document.createElement('img');
  img.alt = '';
  img.style.cssText = `width:${w}px;height:${h}px;display:block;border-radius:6px;`
    + 'border:1px solid var(--stroke);background:#fff';

  // Images on a board load asynchronously, and drawObject signals that by
  // calling back. Repaint when they do, but only a few times and never in a
  // tight loop - a dialog is not worth a runaway timer.
  let repaints = 0;
  let queued = false;
  const later = () => {
    if (queued || repaints >= 4) return;
    queued = true;
    setTimeout(() => { queued = false; repaints++; render(); }, 80);
  };
  const render = () => { img.src = paint(objects, w, h, later); };
  render();
  return img;
}

/**
 * The picture My boards shows for a board, as a small data URL saved inside the
 * board file itself (so it travels with it, and every platform's board list
 * already hands it back). Drawn like an export - the board's own paper and
 * ink, never the dark screen theme - so the same board looks the same in every
 * theme and on every device it is opened on.
 */
export function boardPicture(objects, background, w = 240, h = 150) {
  const was = isDarkBoard();
  setDarkBoard(false);
  try {
    return paint(objects, w, h, () => {}, { bg: background && background.color, dpr: 1.5, type: 'image/webp' });
  } catch { return null; }
  finally { setDarkBoard(was); }
}

/**
 * The same picture as boardPicture(), drawn a few objects at a time.
 *
 * The autosave asks for it while somebody may be writing. Drawing a busy board
 * in one go holds the page for tens of milliseconds, and a pen put down in that
 * moment feels it. Here the drawing stops every few milliseconds and lets
 * anything waiting - the pen above all - go first.
 *
 * The board's paper colour is a setting every drawing reads (setDarkBoard), and
 * the screen draws in between these pieces, so it is switched to "paper" only
 * for each piece and put straight back: the screen never sees it changed.
 *
 * @param {() => Promise<void>} pause  how to step aside between pieces
 * @param {number} sliceMs  how long one piece may take
 * @returns {Promise<string|null>}
 */
export async function boardPictureGently(objects, background, pause, sliceMs = 6, w = 240, h = 150) {
  const opts = { bg: background && background.color, dpr: 1.5, type: 'image/webp' };
  const was = isDarkBoard();
  try {
    setDarkBoard(false);
    let job;
    try { job = prepare(objects, w, h, opts); } finally { setDarkBoard(was); }
    const { out, list, ctx, place } = job;
    if (!list.length) return out();
    let i = 0;
    while (i < list.length) {
      const t0 = performance.now();
      const dark = isDarkBoard();
      setDarkBoard(false);
      try {
        place();
        do {
          // a canvas only collects the drawing and does the real work later, all at once, when the
          // picture is read out; reading one pixel after every few objects makes it do that work
          // here, in this piece, where it is counted
          const end = Math.min(list.length, i + 40);
          for (; i < end; i++) {
            try { drawObject(ctx, list[i], () => {}); } catch { /* one bad object is not a lost picture */ }
          }
          try { ctx.getImageData(0, 0, 1, 1); } catch { /* the picture still comes out, just in one go */ }
        } while (i < list.length && performance.now() - t0 < sliceMs);
      } finally { setDarkBoard(dark); }
      if (i < list.length) await pause();
    }
    return out();
  } catch { return null; }
}
