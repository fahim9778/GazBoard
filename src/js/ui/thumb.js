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

import { drawObject } from '../core/render.js';
import { boundsOf } from '../core/store.js';

// A board with tens of thousands of objects would take a visible pause to draw
// into a 170px box, and the dialog must appear at once. Past this many, the
// picture is made from the first slice; at this size nobody can tell.
const MAX_OBJECTS = 3000;

function paint(objects, w, h, onload) {
  const dpr = 2;                                   // sharp on any screen
  const c = document.createElement('canvas');
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  const list = (Array.isArray(objects) ? objects : [])
    .filter((o) => o && !o.hidden)
    .slice(0, MAX_OBJECTS);
  if (!list.length) return c.toDataURL();

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
  if (!box || box.w <= 0 || box.h <= 0) return c.toDataURL();

  const pad = 8 * dpr;
  // Capped at 1: a single small scribble is shown at the size it was drawn,
  // sitting in the middle of an otherwise empty board - which is the truth
  // about it - rather than magnified until it fills the frame and looks like
  // a finished piece of work.
  const s = Math.min(1, (c.width - pad * 2) / box.w, (c.height - pad * 2) / box.h);
  ctx.setTransform(s, 0, 0, s,
    (c.width - box.w * s) / 2 - box.x * s,
    (c.height - box.h * s) / 2 - box.y * s);
  for (const o of list) {
    try { drawObject(ctx, o, onload); } catch { /* one bad object is not a broken dialog */ }
  }
  return c.toDataURL();
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
