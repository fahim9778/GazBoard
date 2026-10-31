// Packing encoded video frames into a file: MP4 for H.264, WebM for VP9.
//
// The replay is encoded frame by frame with WebCodecs (VideoEncoder), which
// hands back the compressed frames but no file around them. These two small
// writers make the file. Each knows one video track and nothing else - no
// sound, no edits - which is all a replay needs, and keeps them short enough
// to check by eye.

/* ------------------------------------------------------------------ *
 * MP4 (ISO BMFF), one H.264 track, frames in 'avc' (length-prefixed) form
 * ------------------------------------------------------------------ */

const enc = new TextEncoder();
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >>> 8) & 255, n & 255]; }
function str4(s) { return [...enc.encode(s)].slice(0, 4); }

/** A box: its size, its four-letter type, then what is in it (numbers, arrays and Uint8Arrays mixed). */
function box(type, ...parts) {
  const flat = [];
  let size = 8;
  for (const p of parts) {
    const a = p instanceof Uint8Array ? p : Uint8Array.from(p.flat ? p.flat(Infinity) : p);
    flat.push(a); size += a.length;
  }
  const out = new Uint8Array(size);
  out.set([...u32(size), ...str4(type)], 0);
  let o = 8;
  for (const a of flat) { out.set(a, o); o += a.length; }
  return out;
}
const full = (type, version, flags, ...parts) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

/**
 * @param {{data: Uint8Array, key: boolean}[]} frames  in order, one per frame
 * @param {Uint8Array} avcC  the decoder configuration the encoder gave
 */
export function muxMp4(frames, avcC, width, height, fps) {
  const n = frames.length;
  const ts = fps * 1000, delta = 1000;                 // media timescale: 1/1000 of a frame
  const durMs = Math.round((n / fps) * 1000);
  const ftyp = box('ftyp', str4('isom'), u32(512), str4('isom'), str4('iso2'), str4('avc1'), str4('mp41'));
  const sizes = frames.map((f) => f.data.length);
  const keys = [];
  frames.forEach((f, i) => { if (f.key) keys.push(i + 1); });
  const moovFor = (chunkOffset) => {
    const avc1 = box('avc1',
      [0, 0, 0, 0, 0, 0], u16(1), u16(0), u16(0), new Array(12).fill(0), u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Array(32).fill(0), u16(0x0018), u16(0xffff),
      box('avcC', avcC));
    const stbl = box('stbl',
      full('stsd', 0, 0, u32(1), avc1),
      full('stts', 0, 0, u32(1), u32(n), u32(delta)),
      full('stss', 0, 0, u32(keys.length), keys.flatMap(u32)),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), sizes.flatMap(u32)),
      full('stco', 0, 0, u32(1), u32(chunkOffset)));
    const minf = box('minf',
      full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
      box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
      stbl);
    const mdia = box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(n * delta), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), str4('vide'), u32(0), u32(0), u32(0), [...enc.encode('GazBoard replay'), 0]),
      minf);
    const trak = box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)),
      mdia);
    return box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2)),
      trak);
  };
  // the index goes before the pictures, so a player can start before the whole file has arrived
  const size0 = moovFor(0).length;
  const mdatSize = 8 + sizes.reduce((a, b) => a + b, 0);
  const moov = moovFor(ftyp.length + size0 + 8);
  const out = new Uint8Array(ftyp.length + moov.length + mdatSize);
  let o = 0;
  out.set(ftyp, o); o += ftyp.length;
  out.set(moov, o); o += moov.length;
  out.set([...u32(mdatSize), ...str4('mdat')], o); o += 8;
  for (const f of frames) { out.set(f.data, o); o += f.data.length; }
  return out;
}

/* ------------------------------------------------------------------ *
 * WebM (Matroska), one VP9 or VP8 track
 * ------------------------------------------------------------------ */

function idBytes(id) { const b = []; let x = id; while (x > 0) { b.unshift(x & 255); x = Math.floor(x / 256); } return b; }
function sizeVint(n) {
  // eight bytes always: simple, and fine for files this size
  const b = [1];
  for (let i = 6; i >= 0; i--) b.push(Math.floor(n / Math.pow(256, i)) & 255);
  return b;
}
function el(id, data) {
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const head = [...idBytes(id), ...sizeVint(d.length)];
  const out = new Uint8Array(head.length + d.length);
  out.set(head, 0); out.set(d, head.length);
  return out;
}
function uint(n) { const b = []; let x = Math.round(n); do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return b; }
function f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; }
function cat(list) {
  const n = list.reduce((a, b) => a + b.length, 0), out = new Uint8Array(n);
  let o = 0; for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

export function muxWebm(frames, codec, width, height, fps) {
  const header = el(0x1A45DFA3, cat([el(0x4286, uint(1)), el(0x42F7, uint(1)), el(0x42F2, uint(4)), el(0x42F3, uint(8)),
    el(0x4282, enc.encode('webm')), el(0x4287, uint(4)), el(0x4285, uint(2))]));
  const frameMs = 1000 / fps;
  const info = el(0x1549A966, cat([el(0x2AD7B1, uint(1000000)), el(0x4D80, enc.encode('GazBoard')), el(0x5741, enc.encode('GazBoard')),
    el(0x4489, f64(frames.length * frameMs))]));
  const tracks = el(0x1654AE6B, el(0xAE, cat([el(0xD7, uint(1)), el(0x73C5, uint(1)), el(0x83, uint(1)),
    el(0x86, enc.encode(codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9')),
    el(0xE0, cat([el(0xB0, uint(width)), el(0xBA, uint(height))]))])));
  // a new cluster at every key frame, so the times inside a cluster stay small
  const clusters = [];
  let cur = null;
  frames.forEach((f, i) => {
    const t = Math.round(i * frameMs);
    if (!cur || f.key || t - cur.t0 > 30000) { if (cur) clusters.push(el(0x1F43B675, cat(cur.parts))); cur = { t0: t, parts: [el(0xE7, uint(t))] }; }
    const rel = t - cur.t0;
    const block = new Uint8Array(4 + f.data.length);
    block.set([0x81, (rel >> 8) & 255, rel & 255, f.key ? 0x80 : 0], 0);
    block.set(f.data, 4);
    cur.parts.push(el(0xA3, block));
  });
  if (cur) clusters.push(el(0x1F43B675, cat(cur.parts)));
  return cat([header, el(0x18538067, cat([info, tracks, ...clusters]))]);
}
