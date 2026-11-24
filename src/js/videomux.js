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

/* ------------------------------------------------------------------ *
 * Picture AND sound - the lesson recorder (lesson.js)
 *
 * The same two containers, each with a second track for the voice. Kept apart
 * from the two writers above, which the replay uses, so that adding sound
 * could not change a single byte of a replay file.
 *
 *   MP4:  H.264 picture with AAC sound (Windows and Mac make AAC), or with
 *         Opus sound where the machine only makes Opus (Linux).
 *   WebM: VP9 or VP8 picture with Opus sound, for a machine with no H.264.
 *
 * Each track's samples sit together in one block of the file, picture first.
 * Players read the index and find both; nothing is lost by not interleaving.
 * ------------------------------------------------------------------ */

/** The Opus header both containers need: from the encoder when it gave one, made here when not. */
export function opusHead(description, channels, sampleRate) {
  const d = description ? new Uint8Array(description) : null;
  if (d && d.length >= 19 && String.fromCharCode(...d.slice(0, 8)) === 'OpusHead') return d;
  const h = new Uint8Array(19);
  h.set(enc.encode('OpusHead'), 0);
  h[8] = 1; h[9] = channels;
  const v = new DataView(h.buffer);
  v.setUint16(10, 312, true);          // pre-skip: what libopus asks for at 48 kHz
  v.setUint32(12, sampleRate, true);
  v.setInt16(16, 0, true); h[18] = 0;
  return h;
}

/** An MPEG-4 descriptor: tag, a four-byte length, the body. */
function desc(tag, body) {
  const b = body instanceof Uint8Array ? [...body] : body.flat(Infinity);
  const n = b.length;
  return [tag, 0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127, ...b];
}

/**
 * When each picture is shown, from the times the encoder stamped on it.
 *
 * A machine's own video encoder may leave a picture out (some do with a run of
 * identical ones), or hand pictures back out of order. Counting pictures and
 * assuming one every 1/30 s would then run the whole video fast and out of step
 * with the voice. So every picture keeps the time it was made for: each one
 * lasts until the next one starts, and pictures handed back out of order get
 * the offsets a player needs to put them back in order.
 *
 * @returns {{ dts: number[], cts: number[]|null, shift: number, durs: number[], total: number }} in 1/90000 s
 */
export function videoTimes(frames, fps) {
  const T = 90000, one = Math.round(T / fps);
  const pts = frames.map((f, i) => (Number.isFinite(f.ts) ? Math.round((f.ts * T) / 1e6) : i * one));
  const sorted = pts.slice().sort((x, y) => x - y);
  const dts = sorted.slice();                         // decode times: the same times, in the order they were handed back
  let shift = 0;
  for (let i = 0; i < pts.length; i++) shift = Math.max(shift, dts[i] - pts[i]);
  const cts = pts.some((p, i) => p !== dts[i]) ? pts.map((p, i) => p - dts[i] + shift) : null;
  const durs = dts.map((d, i) => (i + 1 < dts.length ? Math.max(1, dts[i + 1] - d) : one));
  const total = sorted.length ? sorted[sorted.length - 1] + one - sorted[0] : 0;
  return { dts, cts, shift, durs, total };
}

/**
 * @param {object} v  { frames: [{data, key, ts?}], avcC, width, height, fps } - ts: the encoder's time, microseconds
 * @param {object|null} a  { chunks: [{data, duration}] (duration in samples), codec: 'aac'|'opus',
 *                           description, sampleRate, channels } - null for a silent lesson
 */
export function muxMp4AV(v, a) {
  const hasA = !!(a && a.chunks && a.chunks.length);
  const n = v.frames.length;
  const VT = 90000;
  const vt = videoTimes(v.frames, v.fps);
  const vDurMs = Math.round((vt.total / VT) * 1000);
  const sr = hasA ? a.sampleRate : 48000, ch = hasA ? a.channels : 1;
  const aDurSamples = hasA ? a.chunks.reduce((s, c) => s + c.duration, 0) : 0;
  const aDurMs = Math.round((aDurSamples / sr) * 1000);
  const durMs = Math.max(vDurMs, aDurMs);
  const vSizes = v.frames.map((f) => f.data.length);
  const aSizes = hasA ? a.chunks.map((c) => c.data.length) : [];
  const vBytes = vSizes.reduce((x, y) => x + y, 0);
  const keys = [];
  v.frames.forEach((f, i) => { if (f.key) keys.push(i + 1); });
  const rle = (list) => {
    const out = [];
    for (const d of list) { const last = out[out.length - 1]; if (last && last[1] === d) last[0]++; else out.push([1, d]); }
    return out;
  };
  const vRuns = rle(vt.durs);
  const aRuns = hasA ? rle(a.chunks.map((c) => c.duration)) : [];
  const ftyp = box('ftyp', str4('isom'), u32(512), str4('isom'), str4('iso2'), str4('avc1'), str4('mp41'));
  const sampleEntry = () => {
    const common = [[0, 0, 0, 0, 0, 0], u16(1), u32(0), u32(0), u16(ch), u16(16), u16(0), u16(0), u32(sr * 65536 >>> 0)];
    if (a.codec === 'opus') {
      const head = opusHead(a.description, ch, sr);
      const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      // dOps is the Ogg header in big-endian, version 0
      const dOps = box('dOps', [0, ch], u16(hv.getUint16(10, true)), u32(hv.getUint32(12, true)), u16(hv.getInt16(16, true) & 0xffff), [0]);
      return box('Opus', ...common, dOps);
    }
    const asc = a.description ? [...new Uint8Array(a.description)] : [0x11, 0x88];   // AAC-LC, 48 kHz, mono
    const dcd = desc(0x04, [0x40, 0x15, 0, 0x18, 0, ...u32(a.bitrate || 128000), ...u32(a.bitrate || 128000), desc(0x05, asc)]);
    const es = desc(0x03, [...u16(2), 0, ...dcd, ...desc(0x06, [0x02])]);
    return box('mp4a', ...common, full('esds', 0, 0, es));
  };
  const moovFor = (vOff, aOff) => {
    const avc1 = box('avc1',
      [0, 0, 0, 0, 0, 0], u16(1), u16(0), u16(0), new Array(12).fill(0), u16(v.width), u16(v.height),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Array(32).fill(0), u16(0x0018), u16(0xffff),
      box('avcC', v.avcC));
    const vstbl = [
      full('stsd', 0, 0, u32(1), avc1),
      full('stts', 0, 0, u32(vRuns.length), vRuns.flatMap(([c, d]) => [...u32(c), ...u32(d)])),
      ...(vt.cts ? [full('ctts', 0, 0, u32(n), vt.cts.flatMap((o) => [...u32(1), ...u32(o)]))] : []),
      full('stss', 0, 0, u32(keys.length), keys.flatMap(u32)),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), vSizes.flatMap(u32)),
      full('stco', 0, 0, u32(1), u32(vOff))];
    // pictures handed back out of order are shown from the first one in order, not a frame late
    const edts = vt.shift ? [box('edts', full('elst', 0, 0, u32(1), u32(vDurMs), u32(vt.shift), u16(1), u16(0)))] : [];
    const vtrak = box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(vDurMs), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(v.width << 16), u32(v.height << 16)),
      ...edts,
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(VT), u32(vt.dts.length ? vt.dts[vt.dts.length - 1] + vt.durs[vt.durs.length - 1] : 0), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), str4('vide'), u32(0), u32(0), u32(0), [...enc.encode('GazBoard lesson'), 0]),
        box('minf',
          full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl', ...vstbl))));
    const atrak = hasA ? box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(aDurMs), u32(0), u32(0), u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(sr), u32(aDurSamples), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), str4('soun'), u32(0), u32(0), u32(0), [...enc.encode('GazBoard voice'), 0]),
        box('minf',
          full('smhd', 0, 0, u16(0), u16(0)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl',
            full('stsd', 0, 0, u32(1), sampleEntry()),
            full('stts', 0, 0, u32(aRuns.length), aRuns.flatMap(([c, d]) => [...u32(c), ...u32(d)])),
            full('stsc', 0, 0, u32(1), u32(1), u32(a.chunks.length), u32(1)),
            full('stsz', 0, 0, u32(0), u32(a.chunks.length), aSizes.flatMap(u32)),
            full('stco', 0, 0, u32(1), u32(aOff)))))) : null;
    return box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(hasA ? 3 : 2)),
      vtrak, ...(atrak ? [atrak] : []));
  };
  const size0 = moovFor(0, 0).length;
  const mdatStart = ftyp.length + size0;
  const vOff = mdatStart + 8, aOff = vOff + vBytes;
  const moov = moovFor(vOff, aOff);
  const mdatSize = 8 + vBytes + aSizes.reduce((x, y) => x + y, 0);
  const out = new Uint8Array(ftyp.length + moov.length + mdatSize);
  let o = 0;
  out.set(ftyp, o); o += ftyp.length;
  out.set(moov, o); o += moov.length;
  out.set([...u32(mdatSize), ...str4('mdat')], o); o += 8;
  for (const f of v.frames) { out.set(f.data, o); o += f.data.length; }
  if (hasA) for (const c of a.chunks) { out.set(c.data, o); o += c.data.length; }
  return out;
}

/**
 * @param {object} v  { frames: [{data, key}], codec, width, height, fps }
 * @param {object|null} a  { chunks: [{data, timestamp}] (timestamp in microseconds), description, sampleRate, channels }
 */
export function muxWebmAV(v, a) {
  if (!a || !a.chunks.length) a = null;
  const frameMs = 1000 / v.fps;
  const vMs = (f, i) => Math.round(Number.isFinite(f.ts) ? f.ts / 1000 : i * frameMs);
  const header = el(0x1A45DFA3, cat([el(0x4286, uint(1)), el(0x42F7, uint(1)), el(0x42F2, uint(4)), el(0x42F3, uint(8)),
    el(0x4282, enc.encode('webm')), el(0x4287, uint(4)), el(0x4285, uint(2))]));
  const lastAudio = a ? a.chunks[a.chunks.length - 1] : null;
  const lastPic = v.frames.length ? vMs(v.frames[v.frames.length - 1], v.frames.length - 1) + frameMs : 0;
  const durMs = Math.max(lastPic, lastAudio ? (lastAudio.timestamp + (lastAudio.durationUs || 20000)) / 1000 : 0);
  const info = el(0x1549A966, cat([el(0x2AD7B1, uint(1000000)), el(0x4D80, enc.encode('GazBoard')), el(0x5741, enc.encode('GazBoard')),
    el(0x4489, f64(durMs))]));
  const vtrack = el(0xAE, cat([el(0xD7, uint(1)), el(0x73C5, uint(1)), el(0x83, uint(1)),
    el(0x86, enc.encode(v.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9')),
    el(0xE0, cat([el(0xB0, uint(v.width)), el(0xBA, uint(v.height))]))]));
  const atrack = a ? el(0xAE, cat([el(0xD7, uint(2)), el(0x73C5, uint(2)), el(0x83, uint(2)),
    el(0x86, enc.encode('A_OPUS')), el(0x63A2, opusHead(a.description, a.channels, a.sampleRate)),
    el(0x56AA, uint(6500000)), el(0x56BB, uint(80000000)),
    el(0xE1, cat([el(0xB5, f64(a.sampleRate)), el(0x9F, uint(a.channels))]))])) : null;
  const tracks = el(0x1654AE6B, cat(atrack ? [vtrack, atrack] : [vtrack]));
  // every block in time order; a new cluster at each key frame, and at least every 30 s
  const blocks = [];
  v.frames.forEach((f, i) => blocks.push({ track: 1, t: vMs(f, i), data: f.data, key: f.key }));
  if (a) for (const c of a.chunks) blocks.push({ track: 2, t: Math.round(c.timestamp / 1000), data: c.data, key: true });
  blocks.sort((x, y) => x.t - y.t || x.track - y.track);
  const clusters = [];
  let cur = null;
  for (const b of blocks) {
    if (!cur || (b.track === 1 && b.key) || b.t - cur.t0 > 30000) {
      if (cur) clusters.push(el(0x1F43B675, cat(cur.parts)));
      cur = { t0: b.t, parts: [el(0xE7, uint(b.t))] };
    }
    const rel = b.t - cur.t0;
    const block = new Uint8Array(4 + b.data.length);
    block.set([0x80 | b.track, (rel >> 8) & 255, rel & 255, b.key ? 0x80 : 0], 0);
    block.set(b.data, 4);
    cur.parts.push(el(0xA3, block));
  }
  if (cur) clusters.push(el(0x1F43B675, cat(cur.parts)));
  return cat([header, el(0x18538067, cat([info, tracks, ...clusters]))]);
}
