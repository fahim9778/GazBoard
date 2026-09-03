// IndexedDB storage and content-addressed asset store for the Web/PWA runtime.
// Fully persistent, atomic, and safe across application updates and browser restarts.

const DB_NAME = 'gazboard_db';
const DB_VERSION = 1;

const ASSET_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const ASSET_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
};
const ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};

let _dbPromise = null;

export function openDatabase() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Object store for boards: stores board JSON and metadata
      if (!db.objectStoreNames.contains('boards')) {
        const boardStore = db.createObjectStore('boards', { keyPath: 'id' });
        boardStore.createIndex('modified', 'modified', { unique: false });
      }

      // Object store for content-addressed assets (pictures, slides, PDF pages)
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'id' });
      }

      // Key/Value metadata store (last-board pointer, settings, persistence status)
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        _dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      _dbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB'));
    };

    request.onblocked = () => {
      console.warn('[storage] IndexedDB upgrade blocked by another open tab');
    };
  });

  return _dbPromise;
}

/** Request persistent storage from the browser to prevent eviction. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        const granted = await navigator.storage.persist();
        console.log(`[storage] Persistent storage request result: ${granted}`);
        return granted;
      }
      return isPersisted;
    }
  } catch (e) {
    console.warn('[storage] Could not request persistence:', e.message);
  }
  return false;
}

/** Check storage quota and usage. */
export async function getStorageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      return await navigator.storage.estimate();
    }
  } catch {}
  return null;
}

function decodeDataUrl(url) {
  const m = /^data:([^;,]*)(;base64)?,/.exec(String(url || ''));
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const body = String(url).slice(m[0].length);
  try {
    if (m[2]) {
      const binStr = atob(body);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
      return { mime, buffer: bytes.buffer };
    } else {
      const decoded = decodeURIComponent(body);
      const bytes = new TextEncoder().encode(decoded);
      return { mime, buffer: bytes.buffer };
    }
  } catch {
    return null;
  }
}

// SHA-256 round constants (first 32 bits of fractional parts of cube roots of first 64 primes 2..311)
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * Genuine standards-compliant SHA-256 implementation (FIPS 180-4).
 * Used as a zero-dependency fallback when Web Crypto subtle is unavailable.
 */
function sha256Fallback(buffer) {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const src = buffer instanceof Uint8Array
    ? buffer
    : (ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer));

  const len = src.length;
  // Pad message: append 0x80 bit marker, zeros, and 64-bit big-endian bit length
  const totalLen = (len + 9 + 63) & ~63;
  const msg = new Uint8Array(totalLen);
  msg.set(src);
  msg[len] = 0x80;

  const bitLenHi = Math.floor((len * 8) / 0x100000000) >>> 0;
  const bitLenLo = (len * 8) >>> 0;
  msg[totalLen - 8] = (bitLenHi >>> 24) & 0xff;
  msg[totalLen - 7] = (bitLenHi >>> 16) & 0xff;
  msg[totalLen - 6] = (bitLenHi >>> 8) & 0xff;
  msg[totalLen - 5] = bitLenHi & 0xff;
  msg[totalLen - 4] = (bitLenLo >>> 24) & 0xff;
  msg[totalLen - 3] = (bitLenLo >>> 16) & 0xff;
  msg[totalLen - 2] = (bitLenLo >>> 8) & 0xff;
  msg[totalLen - 1] = bitLenLo & 0xff;

  const W = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const idx = offset + t * 4;
      W[t] = ((msg[idx] << 24) | (msg[idx + 1] << 16) | (msg[idx + 2] << 8) | msg[idx + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const w2 = W[t - 2];
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

async function sha256Hex(buffer) {
  if (typeof crypto !== 'undefined' && crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through to standards-compliant pure-JS fallback if digest rejects
    }
  }
  return sha256Fallback(buffer);
}


/* ---------------- Board Operations ---------------- */

export async function listBoards() {
  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('boards', 'readonly');
      const store = tx.objectStore('boards');
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result || [];
        const out = records.map((r) => ({
          id: r.id,
          name: r.name || 'Untitled board',
          modified: r.modified || Date.now(),
          objects: typeof r.objects === 'number' ? r.objects : (r.doc?.objects || []).length,
          thumb: r.thumb || null,
          origin: r.origin || r.doc?.origin || null
        }));
        out.sort((a, b) => b.modified - a.modified);
        resolve(out);
      };
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function loadBoard(id) {
  if (!id) return null;
  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('boards', 'readonly');
      const store = tx.objectStore('boards');
      const request = store.get(id);
      request.onsuccess = () => {
        const r = request.result;
        if (!r) { resolve(null); return; }
        if (r.doc) { resolve(r.doc); return; }
        if (typeof r.json === 'string') {
          try { resolve(JSON.parse(r.json)); return; } catch {}
        }
        resolve(null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveBoard(payload) {
  if (!payload) return false;
  const db = await openDatabase();

  let id = payload.id;
  let doc = null;
  if (typeof payload === 'object' && !payload.json) {
    doc = payload;
    id = id || doc.id;
  } else if (typeof payload.json === 'string') {
    try { doc = JSON.parse(payload.json); id = id || doc.id; } catch {}
  } else if (typeof payload === 'string') {
    try { doc = JSON.parse(payload); id = id || doc.id; } catch {}
  }

  if (!id) id = 'board-' + Date.now();
  if (doc) doc.id = id;
  const name = doc?.name || payload.name || 'Untitled board';
  const modified = Date.now();
  const objects = Array.isArray(doc?.objects) ? doc.objects.length : 0;
  const thumb = doc?.thumb || payload.thumb || null;

  // Storing doc directly eliminates 50% duplicate serialization overhead in IndexedDB
  const record = { id, name, modified, objects, thumb, doc };

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['boards', 'meta'], 'readwrite');
      const boardsStore = tx.objectStore('boards');
      const metaStore = tx.objectStore('meta');

      boardsStore.put(record);
      metaStore.put({ key: 'last-board', value: { id, at: modified } });

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => {
        const err = tx.error || new Error('Failed to save board');
        if (err.name === 'QuotaExceededError') {
          console.error('[storage] QuotaExceededError while saving board:', err);
        }
        reject(err);
      };
    } catch (e) {
      reject(e);
    }
  });
}

export async function deleteBoard(id) {
  if (!id) return false;
  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['boards', 'meta'], 'readwrite');
      const boardsStore = tx.objectStore('boards');
      const metaStore = tx.objectStore('meta');

      boardsStore.delete(id);

      const lastReq = metaStore.get('last-board');
      lastReq.onsuccess = () => {
        if (lastReq.result?.value?.id === id) {
          metaStore.delete('last-board');
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getLastBoard() {
  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('last-board');
      req.onsuccess = () => resolve(req.result?.value?.id || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setLastBoard(id) {
  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'last-board', value: { id, at: Date.now() } });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Find the board to resume on startup:
 * 1. The last open board if valid.
 * 2. The most recently modified board with objects.
 * 3. The newest empty board.
 * 4. Otherwise none.
 */
export async function resumeBoard() {
  const wanted = await getLastBoard();
  if (wanted) {
    const doc = await loadBoard(wanted);
    if (doc) return { board: doc, reason: 'pointer' };
  }

  const list = await listBoards();
  if (!list.length) return { board: null, reason: 'none' };

  for (const item of list) {
    const doc = await loadBoard(item.id);
    if (doc && (doc.objects || []).length) return { board: doc, reason: 'newest' };
  }

  const doc = await loadBoard(list[0].id);
  if (doc) return { board: doc, reason: 'empty' };

  return { board: null, reason: 'none' };
}

/* ---------------- Asset Operations ---------------- */

export async function putAsset(dataUrl) {
  try {
    const d = decodeDataUrl(dataUrl);
    if (!d || !d.buffer) return null;

    const ext = ASSET_EXT[d.mime] || 'bin';
    const hash = await sha256Hex(d.buffer);
    const id = `${hash}.${ext}`;

    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction('assets', 'readwrite');
      const store = tx.objectStore('assets');
      const req = store.get(id);

      req.onsuccess = () => {
        if (req.result) {
          resolve({ id });
          return;
        }
        store.put({ id, mime: d.mime, dataUrl, buffer: d.buffer, created: Date.now() });
      };

      tx.oncomplete = () => resolve({ id });
      tx.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('[assets] put failed:', e);
    return null;
  }
}

export async function getAsset(id) {
  if (!ASSET_NAME.test(String(id || ''))) return null;
  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('assets', 'readonly');
      const store = tx.objectStore('assets');
      const req = store.get(id);

      req.onsuccess = () => {
        const item = req.result;
        if (!item) { resolve(null); return; }
        if (item.dataUrl) { resolve(item.dataUrl); return; }
        if (item.buffer) {
          const mime = item.mime || ASSET_MIME[String(id).split('.').pop()] || 'application/octet-stream';
          const bytes = new Uint8Array(item.buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          resolve(`data:${mime};base64,${btoa(binary)}`);
          return;
        }
        resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function haveAssets(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const out = {};
  if (!list.length) return out;

  try {
    const db = await openDatabase();
    const tx = db.transaction('assets', 'readonly');
    const store = tx.objectStore('assets');

    const checks = list.map((id) => {
      if (!ASSET_NAME.test(String(id || ''))) {
        return Promise.resolve([id, false]);
      }
      return new Promise((resolve) => {
        try {
          const req = store.getKey(id);
          req.onsuccess = () => resolve([id, req.result !== undefined]);
          req.onerror = () => resolve([id, false]);
        } catch {
          resolve([id, false]);
        }
      });
    });

    const results = await Promise.all(checks);
    for (const [id, exists] of results) {
      out[id] = exists;
    }
    return out;
  } catch {
    for (const id of list) out[id] = false;
    return out;
  }
}

/* ---------------- Migrations ---------------- */

export async function migrateLegacyData() {
  let moved = 0;
  try {
    // Check if any legacy localStorage boards exist
    const legacyKeys = ['openboard.board', 'openboard.last-board', 'gazboard.board'];
    for (const k of legacyKeys) {
      const raw = localStorage.getItem(k);
      if (raw) {
        try {
          const doc = JSON.parse(raw);
          if (doc && doc.id) {
            await saveBoard(doc);
            moved++;
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[storage] Legacy migration error:', e);
  }
  return { moved, from: moved ? ['localStorage'] : [] };
}
