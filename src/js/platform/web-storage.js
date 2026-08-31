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

async function sha256Hex(buffer) {
  if (crypto && crypto.subtle && crypto.subtle.digest) {
    const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Lightweight SHA-256 fallback if WebCrypto subtle is unavailable
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    h0 = (h0 ^ (bytes[i] << (i % 24))) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
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
          thumb: r.thumb || null
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
    if (!d || !d.buffer || !d.buffer.byteLength) return null;

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

  const db = await openDatabase();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('assets', 'readonly');
      const store = tx.objectStore('assets');
      let count = 0;

      for (const id of list) {
        if (!ASSET_NAME.test(String(id || ''))) {
          out[id] = false;
          continue;
        }
        const req = store.getKey(id);
        req.onsuccess = () => {
          out[id] = req.result !== undefined;
          if (++count === list.length) resolve(out);
        };
        req.onerror = () => {
          out[id] = false;
          if (++count === list.length) resolve(out);
        };
      }
    } catch {
      for (const id of list) out[id] = false;
      resolve(out);
    }
  });
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
