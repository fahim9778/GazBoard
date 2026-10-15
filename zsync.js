'use strict';
/*
 * Downloading only what changed in a Linux AppImage.
 *
 * Every GazBoard AppImage release carries a .zsync file beside it (made by
 * zsyncmake in the release workflow). It describes the new AppImage as a list
 * of fixed-size blocks, each with two fingerprints: a quick one that can be
 * slid along a file one byte at a time, and a sturdier one (MD4) to confirm a
 * match. Reading the AppImage that is already on this computer through that
 * list shows which blocks are already here - most of them, between two
 * releases - and only the rest are fetched, as byte ranges of the new file.
 *
 * Whatever happens, the result is checked against the SHA-1 of the whole new
 * file, which the .zsync carries. If it does not match, or the server will
 * not send ranges, the whole file is downloaded instead and checked the same
 * way. A wrong file is never put in place.
 *
 * This follows zsync 0.6.2 (the format zsyncmake writes): the rolling sum is
 * librcksum's, "Hash-Lengths: seq,rsum,check" says how many consecutive
 * blocks must match and how many bytes of each fingerprint are stored, and a
 * short last block is padded with zeros.
 */

const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 *  The .zsync file
 * ------------------------------------------------------------------ */

function parseZsync(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const end = b.indexOf('\n\n');
  if (end < 0) throw new Error('not a .zsync file (no header)');
  const head = {};
  for (const line of b.subarray(0, end).toString('latin1').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (!/^0\.\d/.test(head.zsync || '')) throw new Error('not a .zsync file this updater understands');
  const blocksize = Number(head.blocksize), length = Number(head.length);
  const [seq, rsumBytes, checkBytes] = String(head['hash-lengths'] || '1,4,16').split(',').map(Number);
  if (!(blocksize >= 512 && blocksize <= 1 << 20 && (blocksize & (blocksize - 1)) === 0)) throw new Error('bad block size in .zsync');
  if (!(length >= 0) || !(seq >= 1 && seq <= 2) || !(rsumBytes >= 1 && rsumBytes <= 4) || !(checkBytes >= 3 && checkBytes <= 16)) {
    throw new Error('bad hash lengths in .zsync');
  }
  if (!/^[0-9a-f]{40}$/i.test(head['sha-1'] || '')) throw new Error('the .zsync carries no SHA-1');
  if (head.z) throw new Error('compressed .zsync files are not supported');
  const blocks = Math.ceil(length / blocksize);
  const per = rsumBytes + checkBytes;
  const data = b.subarray(end + 2);
  if (data.length < blocks * per) throw new Error('the .zsync is cut short');
  const rsums = new Uint32Array(blocks);
  const checks = new Array(blocks);
  for (let i = 0; i < blocks; i++) {
    const o = i * per;
    // the stored bytes are the LAST rsumBytes of [a_hi a_lo b_hi b_lo]
    let v = 0;
    for (let k = 0; k < rsumBytes; k++) v = (v * 256) + data[o + k];
    rsums[i] = v >>> 0;
    checks[i] = data.subarray(o + rsumBytes, o + per);
  }
  return {
    blocksize, length, seq, rsumBytes, checkBytes, blocks, rsums, checks,
    sha1: head['sha-1'].toLowerCase(), url: head.url || null, filename: head.filename || null
  };
}

/* the stored part of a rolling sum, as a number: a and b are 16-bit, only the last rsumBytes bytes are kept */
const keep = (a, b, rsumBytes) => {
  const full = (((a & 0xffff) << 16) | (b & 0xffff)) >>> 0;
  return rsumBytes >= 4 ? full : (full % 2 ** (8 * rsumBytes)) >>> 0;
};

/* ------------------------------------------------------------------ *
 *  MD4 (only for confirming blocks; zsync's choice, not ours)
 * ------------------------------------------------------------------ */

function md4(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const len = msg.length;
  const words = ((len + 8) >>> 6) + 1;
  const x = new Uint32Array(words * 16);
  for (let i = 0; i < len; i++) x[i >> 2] |= msg[i] << ((i % 4) * 8);
  x[len >> 2] |= 0x80 << ((len % 4) * 8);
  x[words * 16 - 2] = (len * 8) >>> 0;
  x[words * 16 - 1] = Math.floor(len / 0x20000000);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rl = (v, s) => (v << s) | (v >>> (32 - s));
  const F = (p, q, r) => (p & q) | (~p & r), G = (p, q, r) => (p & q) | (p & r) | (q & r), H = (p, q, r) => p ^ q ^ r;
  for (let i = 0; i < x.length; i += 16) {
    const [aa, bb, cc, dd] = [a, b, c, d];
    const r1 = [3, 7, 11, 19], r2 = [3, 5, 9, 13], r3 = [3, 9, 11, 15];
    for (let k = 0; k < 16; k++) {
      const t = (a + F(b, c, d) + x[i + k]) | 0;
      [a, b, c, d] = [d, rl(t, r1[k % 4]), b, c];
    }
    for (let k = 0; k < 16; k++) {
      const idx = (k % 4) * 4 + (k >> 2);
      const t = (a + G(b, c, d) + x[i + idx] + 0x5a827999) | 0;
      [a, b, c, d] = [d, rl(t, r2[k % 4]), b, c];
    }
    const order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let k = 0; k < 16; k++) {
      const t = (a + H(b, c, d) + x[i + order[k]] + 0x6ed9eba1) | 0;
      [a, b, c, d] = [d, rl(t, r3[k % 4]), b, c];
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0); out.writeInt32LE(b, 4); out.writeInt32LE(c, 8); out.writeInt32LE(d, 12);
  return out;
}

/* Electron's own crypto has MD4 and is many times faster; plain Node 17+ does not, so the one above stands in. */
const fastMd4 = (() => {
  try {
    if (crypto.createHash('md4').update('abc').digest('hex') === 'a448017aaf21d8525fc10ae87aa6729d') return (b) => crypto.createHash('md4').update(b).digest();
  } catch { /* not in this build */ }
  return md4;
})();

/* ------------------------------------------------------------------ *
 *  Which blocks of the new file are already here
 * ------------------------------------------------------------------ */

/**
 * For each block of the new file, where in `local` it can be copied from
 * (a byte offset), or -1 when it has to be downloaded.
 *
 * Slides along the whole local file one byte at a time, so it gives way to
 * everything else now and then (an AppImage is over 100 MB).
 */
async function findBlocks(z, local, padded = null) {
  const { blocksize: bs, blocks, seq, rsumBytes, checkBytes } = z;
  const from = new Float64Array(blocks).fill(-1);
  if (!blocks || !local.length) return from;
  // a short last block was fingerprinted padded with zeros; so is the file it is looked for in
  // (a caller that read the file with that room after it already, passes it, and nothing is copied)
  const src = padded && padded.length >= local.length + 2 * bs && padded.buffer === local.buffer && padded.byteOffset === local.byteOffset
    && padded.subarray(local.length).every((x) => x === 0) ? padded : Buffer.concat([local, Buffer.alloc(bs * 2)]);
  const span = 2 ** (8 * rsumBytes);
  const pairs = seq === 2;
  // a pair of stored sums as one number (exact up to 3 bytes each); 4-byte pairs fall back to text keys
  const exact = !pairs || rsumBytes <= 3;
  const pairKey = (k1, k2) => (exact ? k1 * span + k2 : `${k1}:${k2}`);
  const table = new Map();
  const add = (k, i) => { const l = table.get(k); if (l) l.push(i); else table.set(k, [i]); };
  // a cheap first filter on the sum(s) at each position: nearly every position is turned away here
  const seen = new Uint8Array(1 << 21);           // 16M bits
  const h24 = (k1, k2) => ((Math.imul(k1, 0x9e3779b1) ^ Math.imul(k2 + 1, 0x85ebca6b)) >>> 8) & 0xffffff;
  const mark = (h) => { seen[h >>> 3] |= 1 << (h & 7); };
  const marked = (h) => (seen[h >>> 3] >>> (h & 7)) & 1;
  // with pairs, the very last block has no partner: it is looked for on its own
  const lastAlone = pairs ? z.rsums[blocks - 1] : -1;
  for (let i = 0; i < blocks; i++) {
    if (pairs && i + 1 < blocks) { add(pairKey(z.rsums[i], z.rsums[i + 1]), i); mark(h24(z.rsums[i], z.rsums[i + 1])); }
    else { add(pairs ? 'last' : z.rsums[i], i); if (!pairs) mark(h24(z.rsums[i], 0)); }
  }
  const confirm = (pos, i) => fastMd4(src.subarray(pos, pos + bs)).compare(z.checks[i], 0, checkBytes, 0, checkBytes) === 0;
  const sum = (pos) => {
    let a = 0, b = 0;
    for (let k = 0; k < bs; k++) { a = (a + src[pos + k]) & 0xffff; b = (b + a) & 0xffff; }
    return [a, b];
  };
  // the stored part of the sums, written out per width: this runs once for every byte of the file
  const kept = rsumBytes >= 4 ? (a, b) => ((a << 16) | b) >>> 0
    : rsumBytes === 3 ? (a, b) => ((a & 0xff) << 16) | b
    : rsumBytes === 2 ? (a, b) => b
    : (a, b) => b & 0xff;
  const shift = Math.log2(bs);
  const last = local.length;
  let [a1, b1] = sum(0);
  let [a2, b2] = pairs ? sum(bs) : [0, 0];
  let nextYield = 1 << 20;
  for (let pos = 0; pos < last;) {
    if (pos >= nextYield) { nextYield = pos + (1 << 20); await new Promise((r) => setImmediate(r)); }
    const k1 = kept(a1, b1);
    const k2 = pairs ? kept(a2, b2) : 0;
    let hit = false;
    const pairHere = marked(h24(k1, k2));
    if (pairHere || k1 === lastAlone) {
      const lists = pairs ? [pairHere ? table.get(pairKey(k1, k2)) : null, k1 === lastAlone ? table.get('last') : null]
        : [table.get(k1)];
      for (const list of lists) {
        if (!list) continue;
        for (const i of list) {
          if (from[i] >= 0 || !confirm(pos, i)) continue;
          // a pair is only trusted when the second block checks out too (zsync's own rule)
          if (pairs && i + 1 < blocks) {
            if (!confirm(pos + bs, i + 1)) continue;
            if (from[i + 1] < 0) from[i + 1] = pos + bs;
          }
          from[i] = pos; hit = true;
        }
      }
    }
    if (hit) {
      // jump a whole block and start the sums afresh there
      pos += bs;
      if (pos >= last) break;
      // the second window is exactly where the first one now starts
      if (pairs) { a1 = a2; b1 = b2; [a2, b2] = sum(pos + bs); } else [a1, b1] = sum(pos);
      continue;
    }
    // slide the window(s) one byte
    const o1 = src[pos], n1 = src[pos + bs];
    a1 = (a1 - o1 + n1) & 0xffff; b1 = (b1 + a1 - ((o1 << shift) & 0xffff)) & 0xffff;
    if (pairs) {
      const n2 = src[pos + 2 * bs];
      a2 = (a2 - n1 + n2) & 0xffff; b2 = (b2 + a2 - ((n1 << shift) & 0xffff)) & 0xffff;
    }
    pos++;
  }
  return from;
}

/** The byte ranges of the new file still to fetch, close neighbours joined so there are few requests. */
function rangesToFetch(z, from, { join = 8 } = {}) {
  const out = [];
  for (let i = 0; i < z.blocks; i++) {
    if (from[i] >= 0) continue;
    const start = i * z.blocksize, end = Math.min(z.length, (i + 1) * z.blocksize) - 1;
    const prev = out[out.length - 1];
    if (prev && start - prev[1] - 1 <= join * z.blocksize) prev[1] = end;
    else out.push([start, end]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Putting the new file together
 * ------------------------------------------------------------------ */

/**
 * Build the new file from the old one and whatever has to be downloaded.
 *
 * @param {object} o
 * @param {Buffer} o.zsync      the .zsync file
 * @param {Buffer} o.local      the AppImage already here
 * @param {string} o.url        where the new file is
 * @param {(url, init) => Promise<Response>} o.fetch
 * @param {(fraction, got, total) => void} [o.onProgress]
 * @returns {Promise<{data: Buffer, downloaded: number, reused: number, whole: boolean}>}
 */
async function assemble({ zsync, local, padded = null, url, fetch, onProgress = () => {} }) {
  const z = parseZsync(zsync);
  const from = await findBlocks(z, local, padded);
  const out = Buffer.alloc(z.length);
  let reused = 0;
  for (let i = 0; i < z.blocks; i++) {
    if (from[i] < 0) continue;
    const start = i * z.blocksize, n = Math.min(z.blocksize, z.length - start);
    local.copy(out, start, from[i], Math.min(local.length, from[i] + n));
    reused += n;
  }
  const ranges = rangesToFetch(z, from);
  const total = ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
  let got = 0;
  const whole = async () => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    onProgress(1, data.length, data.length);
    return data;
  };
  const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
  try {
    for (const [a, b] of ranges) {
      const res = await fetch(url, { redirect: 'follow', headers: { Range: `bytes=${a}-${b}` } });
      // a server that ignores Range sends the whole file with 200: take it as it is
      if (res.status === 200) {
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length !== z.length || sha1(data) !== z.sha1) throw new Error('the download does not match the release (checksum differs) - nothing was changed');
        return { data, downloaded: data.length, reused: 0, whole: true };
      }
      if (res.status !== 206) throw new Error(`download failed (${res.status})`);
      const part = Buffer.from(await res.arrayBuffer());
      if (part.length !== b - a + 1) throw new Error('the server sent a different part than asked for');
      part.copy(out, a);
      got += part.length;
      onProgress(total ? got / total : 1, got, total);
    }
    if (sha1(out) === z.sha1) { onProgress(1, got, total); return { data: out, downloaded: got, reused, whole: false }; }
  } catch (e) {
    if (/checksum differs/.test(e.message)) throw e;
    // anything odd on the way: fall through to the whole file
  }
  const data = await whole();
  if (data.length !== z.length || sha1(data) !== z.sha1) throw new Error('the download does not match the release (checksum differs) - nothing was changed');
  return { data, downloaded: data.length, reused: 0, whole: true };
}

module.exports = { parseZsync, findBlocks, rangesToFetch, assemble, md4 };
