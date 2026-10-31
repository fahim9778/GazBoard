// A small animated-GIF writer, for saving a board replay as a GIF.
//
// Whiteboards are mostly one background colour and a handful of ink colours,
// which suits GIF's 256-colour limit well. The palette is made once, from the
// last frame (which has every colour the replay will ever show), and each
// pixel is matched to it through a 32x32x32 table, so a frame costs one table
// lookup per pixel rather than a search.

/** Up to 256 colours that cover the picture, by splitting the busiest box of colours in two until there are enough. */
export function makePalette(rgba, max = 256) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const all = [...counts.entries()].map(([k, n]) => ({ r: (k >> 10) & 31, g: (k >> 5) & 31, b: k & 31, n }));
  let boxes = [all];
  while (boxes.length < max) {
    let pick = -1, bestSpan = 0;
    boxes.forEach((bx, i) => {
      if (bx.length < 2) return;
      const span = spanOf(bx);
      if (span.size > bestSpan) { bestSpan = span.size; pick = i; }
    });
    if (pick < 0) break;
    const bx = boxes[pick];
    const ch = spanOf(bx).ch;
    bx.sort((a, b) => a[ch] - b[ch]);
    let total = 0; for (const c of bx) total += c.n;
    let acc = 0, cut = 1;
    for (let i = 0; i < bx.length - 1; i++) { acc += bx[i].n; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(pick, 1, bx.slice(0, cut), bx.slice(cut));
  }
  const pal = [];
  for (const bx of boxes) {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of bx) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n; }
    if (!n) continue;
    pal.push([Math.round((r / n) * 255 / 31), Math.round((g / n) * 255 / 31), Math.round((b / n) * 255 / 31)]);
  }
  if (!pal.length) pal.push([255, 255, 255]);
  return pal;
}

function spanOf(bx) {
  let lo = { r: 31, g: 31, b: 31 }, hi = { r: 0, g: 0, b: 0 };
  for (const c of bx) for (const k of ['r', 'g', 'b']) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
  const spans = { r: hi.r - lo.r, g: hi.g - lo.g, b: hi.b - lo.b };
  const ch = spans.r >= spans.g && spans.r >= spans.b ? 'r' : spans.g >= spans.b ? 'g' : 'b';
  let n = 0; for (const c of bx) n += c.n;
  return { ch, size: spans[ch] * Math.log2(1 + n) };
}

export class GifWriter {
  constructor(width, height, palette, { loop = true } = {}) {
    this.w = width; this.h = height;
    this.pal = palette.slice(0, 256);
    while (this.pal.length < 256) this.pal.push([0, 0, 0]);
    this.lut = new Int16Array(32768).fill(-1);
    this.chunks = [];
    this.size = 0;
    const head = [];
    for (const c of 'GIF89a') head.push(c.charCodeAt(0));
    head.push(width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0);   // 256-colour global table
    for (const [r, g, b] of this.pal) head.push(r, g, b);
    if (loop) head.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
    this.push(head);
  }

  push(arr) { const u = arr instanceof Uint8Array ? arr : Uint8Array.from(arr); this.chunks.push(u); this.size += u.length; }

  nearest(k) {
    const r = ((k >> 10) & 31) * 255 / 31, g = ((k >> 5) & 31) * 255 / 31, b = (k & 31) * 255 / 31;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.pal.length; i++) {
      const p = this.pal[i];
      const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
      if (d < bd) { bd = d; best = i; }
    }
    this.lut[k] = best;
    return best;
  }

  /**
   * One frame of RGBA pixels, shown for `delay` hundredths of a second.
   * Only the rectangle that changed since the last frame is stored; the rest
   * of the last frame is left showing, which is most of a replay's frame.
   */
  addFrame(rgba, delay = 10) {
    const W = this.w, H = this.h, prev = this.prev;
    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
    if (prev) {
      x0 = W; y0 = H; x1 = -1; y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W * 4;
        for (let x = 0; x < W; x++) {
          const j = row + x * 4;
          if (rgba[j] !== prev[j] || rgba[j + 1] !== prev[j + 1] || rgba[j + 2] !== prev[j + 2]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }       // nothing changed: one pixel, the same as before
    }
    this.prev = rgba.slice();
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    const idx = new Uint8Array(w * hh);
    const lut = this.lut;
    for (let y = 0, i = 0; y < hh; y++) {
      for (let x = 0, j = ((y0 + y) * W + x0) * 4; x < w; x++, i++, j += 4) {
        const k = ((rgba[j] >> 3) << 10) | ((rgba[j + 1] >> 3) << 5) | (rgba[j + 2] >> 3);
        const v = lut[k];
        idx[i] = v >= 0 ? v : this.nearest(k);
      }
    }
    const d = Math.max(2, Math.round(delay));
    this.push([0x21, 0xf9, 4, 0x04, d & 255, d >> 8, 0, 0]);          // disposal 1: leave this frame in place
    this.push([0x2c, x0 & 255, x0 >> 8, y0 & 255, y0 >> 8, w & 255, w >> 8, hh & 255, hh >> 8, 0]);
    this.push(lzw(idx, 8));
  }

  finish() {
    this.push([0x3b]);
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/** GIF's variable-width LZW, packed into 255-byte sub-blocks. */
function lzw(indices, minSize) {
  const clear = 1 << minSize, eoi = clear + 1;
  const out = [minSize];
  let block = [];
  let cur = 0, bits = 0;
  const emit = (code, size) => {
    cur |= code << bits; bits += size;
    while (bits >= 8) {
      block.push(cur & 255); cur >>>= 8; bits -= 8;
      if (block.length === 255) { out.push(255, ...block); block = []; }
    }
  };
  let dict = new Map();
  let next = eoi + 1, size = minSize + 1;
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = prefix * 4096 + c;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear, size);
      dict = new Map(); next = eoi + 1; size = minSize + 1;
    }
    prefix = c;
  }
  emit(prefix, size);
  emit(eoi, size);
  if (bits > 0) { block.push(cur & 255); }
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return Uint8Array.from(out);
}
