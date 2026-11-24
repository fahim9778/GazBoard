/*
 * Saving a board without holding up the pen.
 *
 * Turning a busy board into text for the file is real work: on a board with
 * five thousand strokes it is about 80 ms, on fifteen thousand a quarter of a
 * second. Done in one go, a pen put down during that moment waits for it, and
 * the start of the next word comes out late - the small hitch people feel
 * while autosave is on.
 *
 * So the autosave does the same work in small pieces, a few milliseconds each,
 * and steps aside in between so the pen, the screen and everything else go
 * first. Nothing about WHAT is saved changes: the text written is exactly what
 * JSON.stringify would have written for the whole board, character for
 * character (the suite checks that), so the file is the same file.
 */

/** Step aside: let everything that is waiting (a pen, a frame to draw) run, then carry on. */
export const pause = () => new Promise((r) => setTimeout(r, 0));

/** How long one piece of the work may take before stepping aside. */
export const SLICE_MS = 6;

/** Roughly how much text goes in one piece handed to the desktop app to write (see App._persistNow). */
export const CHUNK_CHARS = 1 << 20;

/**
 * JSON.stringify(doc), worked through a few objects at a time.
 *
 * The board's own fields are written in one go (they are small); its objects -
 * strokes, pictures, text, everything on it - are written one by one and joined,
 * which is exactly how JSON.stringify writes a list.
 *
 * With `chunked`, the text comes back as a list of pieces of about CHUNK_CHARS
 * each instead of one long string: joined, they are the same text. The desktop
 * app takes them one at a time, so handing a big board over never holds the
 * pen up either (copying a 30 MB string across in one go takes ~70 ms).
 *
 * @param {object} doc  the board as it is about to be saved
 * @param {object} [o]
 * @param {() => Promise<void>} [o.step]  how to step aside (the suite passes its own)
 * @param {number} [o.sliceMs]
 * @param {boolean} [o.chunked]
 * @returns {Promise<{ json?: string, chunks?: string[], work: number, pieces: number }>}
 *   work: the milliseconds actually spent writing, not counting the waits
 */
export async function stringifyGently(doc, { step = pause, sliceMs = SLICE_MS, chunked = false } = {}) {
  const objects = Array.isArray(doc && doc.objects) ? doc.objects : null;
  let work = 0, pieces = 1;
  let t0 = performance.now();
  const done = (texts) => {
    work += performance.now() - t0;
    if (chunked) return { chunks: texts, work, pieces };
    t0 = performance.now();
    const json = texts.length === 1 ? texts[0] : texts.join('');
    work += performance.now() - t0;
    return { json, work, pieces };
  };
  if (!objects) return done([JSON.stringify(doc)]);
  // A marker no board could contain stands in for the list, so the list lands in exactly the place
  // JSON.stringify would put it, between the same neighbours.
  const mark = 'gb-objects-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const head = JSON.stringify({ ...doc, objects: [mark] });
  const holder = '["' + mark + '"]';
  const at = head.indexOf(holder);
  // never expected; if it ever happens, do it the plain way rather than risk the file
  if (at < 0 || head.indexOf(mark, at + holder.length) >= 0) return done([JSON.stringify(doc)]);

  const texts = [];
  let cur = [head.slice(0, at) + '['], curLen = cur[0].length;
  const close = () => { if (cur.length) texts.push(cur.length === 1 ? cur[0] : cur.join('')); cur = []; curLen = 0; };
  for (let i = 0; i < objects.length; i++) {
    // undefined (and anything JSON cannot write) becomes null in a list, exactly as JSON.stringify does it
    let piece = JSON.stringify(objects[i]);
    if (piece === undefined) piece = 'null';
    if (i > 0) piece = ',' + piece;
    cur.push(piece); curLen += piece.length;
    if (curLen >= CHUNK_CHARS) close();
    if (i + 1 < objects.length && performance.now() - t0 >= sliceMs) {
      work += performance.now() - t0;
      await step();
      pieces++;
      t0 = performance.now();
    }
  }
  cur.push(']' + head.slice(at + holder.length));
  close();
  return done(texts);
}
