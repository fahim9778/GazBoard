// Automated Test Suite for GazBoard Web/PWA Runtime.
// Runs standalone in Node.js / headless environment to verify all Web/PWA subsystems.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist-web');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  const tag = ok ? '  ok  ' : ' FAIL ';
  const msg = `${tag} [web-pwa] ${name}${detail ? ' — ' + detail : ''}`;
  results.push(msg);
  console.log(msg);
}

// Minimal mock of browser globals for testing web adapters in Node
function setupWebGlobals() {
  const storeMap = new Map();
  const metaMap = new Map();
  const assetMap = new Map();

  class MockIDBRequest {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
    }
  }

  class MockIDBTransaction {
    constructor(db, storeNames, mode) {
      this.db = db;
      this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
      this.mode = mode;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this._pending = 0;
    }

    objectStore(name) {
      return new MockIDBObjectStore(this, name);
    }

    _queue(fn) {
      const req = new MockIDBRequest();
      this._pending++;
      queueMicrotask(() => {
        try {
          fn(req);
          if (req.onsuccess) req.onsuccess({ target: req });
        } catch (err) {
          req.error = err;
          if (req.onerror) req.onerror({ target: req });
        } finally {
          this._pending--;
          if (this._pending === 0) {
            queueMicrotask(() => {
              if (this.oncomplete) this.oncomplete({ target: this });
            });
          }
        }
      });
      return req;
    }
  }

  class MockIDBObjectStore {
    constructor(tx, name) {
      this.tx = tx;
      this.name = name;
    }

    get(key) {
      return this.tx._queue((req) => {
        const store = this.tx.db._getStore(this.name);
        req.result = store.get(key);
      });
    }

    getKey(key) {
      return this.tx._queue((req) => {
        const store = this.tx.db._getStore(this.name);
        req.result = store.has(key) ? key : undefined;
      });
    }

    put(value) {
      return this.tx._queue((req) => {
        const store = this.tx.db._getStore(this.name);
        const key = value.id || value.key;
        store.set(key, value);
        req.result = key;
      });
    }

    delete(key) {
      return this.tx._queue((req) => {
        const store = this.tx.db._getStore(this.name);
        store.delete(key);
        req.result = undefined;
      });
    }

    getAll() {
      return this.tx._queue((req) => {
        const store = this.tx.db._getStore(this.name);
        req.result = Array.from(store.values());
      });
    }

    createIndex() {}
  }

  class MockIDBDatabase {
    constructor() {
      this.objectStoreNames = {
        _stores: new Set(['boards', 'assets', 'meta']),
        contains(name) { return this._stores.has(name); }
      };
      this.onversionchange = null;
      this._storesData = {
        boards: storeMap,
        assets: assetMap,
        meta: metaMap
      };
    }

    _getStore(name) {
      if (!this._storesData[name]) this._storesData[name] = new Map();
      return this._storesData[name];
    }

    createObjectStore(name) {
      this.objectStoreNames._stores.add(name);
      return new MockIDBObjectStore(null, name);
    }

    transaction(storeNames, mode) {
      return new MockIDBTransaction(this, storeNames, mode);
    }

    close() {}
  }

  const mockDbInstance = new MockIDBDatabase();

  global.indexedDB = {
    open: (name, version) => {
      const req = new MockIDBRequest();
      queueMicrotask(() => {
        req.result = mockDbInstance;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    }
  };

  global.HTMLElement = class HTMLElement {};

  global.window = {
    location: { href: 'http://localhost:8080/', protocol: 'http:', hostname: 'localhost' },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  class MockElement extends global.HTMLElement {
    constructor(tag) {
      super();
      this.tagName = String(tag || 'div').toUpperCase();
      this.style = {};
    }
    setAttribute() {}
    getAttribute() { return null; }
    appendChild() {}
    removeChild() {}
    remove() {}
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, bottom: 100, left: 0, right: 100 }; }
    click() {}
    addEventListener() {}
  }

  global.document = {
    createElement: (tag) => new MockElement(tag),
    body: {
      appendChild: () => {},
      removeChild: () => {}
    },
    addEventListener: () => {},
    querySelectorAll: () => []
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',
      onLine: true,
      storage: {
        persist: async () => true,
        persisted: async () => true,
        estimate: async () => ({ quota: 10737418240, usage: 1048576 })
      }
    },
    configurable: true,
    writable: true
  });

  if (!global.crypto || !global.crypto.subtle) {
    try {
      global.crypto = {
        subtle: {
          digest: async (algo, buf) => {
            const hash = crypto.createHash('sha256').update(Buffer.from(buf)).digest();
            return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
          }
        }
      };
    } catch {}
  }

  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
  global.Blob = class MockBlob {
    constructor(parts, opts = {}) {
      this.parts = parts || [];
      this.type = opts.type || '';
      let len = 0;
      for (const p of this.parts) len += (p.byteLength || p.length || 0);
      this.size = len;
    }
    async arrayBuffer() {
      const bufs = this.parts.map((p) => {
        if (typeof p === 'string') return Buffer.from(p, 'utf8');
        if (p instanceof ArrayBuffer) return Buffer.from(p);
        if (ArrayBuffer.isView(p)) return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
        return Buffer.from(p);
      });
      const combined = Buffer.concat(bufs);
      return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
    }
    async text() {
      const buf = await this.arrayBuffer();
      return new TextDecoder().decode(buf);
    }
  };

  global.URL = class MockURL extends URL {
    static createObjectURL(blob) { return 'blob:mock-' + Math.random().toString(36); }
    static revokeObjectURL() {}
  };

  global.atob = (str) => Buffer.from(str, 'base64').toString('binary');
  global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
}

async function runTests() {
  console.log('\n=== Running GazBoard Web & PWA Test Suite ===\n');
  setupWebGlobals();

  /* ---------------- 1. Web App Manifest Validation ---------------- */
  try {
    const manifestPath = path.join(SRC, 'manifest.webmanifest');
    check('manifest.webmanifest exists', fs.existsSync(manifestPath));
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

    check('manifest has correct name', manifest.name === 'GazBoard');
    check('manifest display is standalone', manifest.display === 'standalone');
    check('manifest start_url is defined', !!manifest.start_url);
    check('manifest has theme_color and background_color', manifest.theme_color === '#6264a7' && manifest.background_color === '#f3f2f1');
    check('manifest defines 192px and 512px icons',
      manifest.icons.some((i) => i.sizes === '192x192') &&
      manifest.icons.some((i) => i.sizes === '512x512')
    );

    for (const icon of manifest.icons) {
      const iconPath = path.join(SRC, icon.src);
      check(`icon file exists: ${icon.src}`, fs.existsSync(iconPath));
    }
  } catch (e) {
    check('manifest validation failed', false, e.message);
  }

  /* ---------------- 2. Service Worker & Atomic Precaching Verification ---------------- */
  try {
    const swPath = path.join(SRC, 'sw.js');
    check('sw.js exists', fs.existsSync(swPath));
    const swContent = await fsp.readFile(swPath, 'utf8');

    check('sw.js implements install, activate, fetch, message events',
      swContent.includes("addEventListener('install'") &&
      swContent.includes("addEventListener('activate'") &&
      swContent.includes("addEventListener('fetch'") &&
      swContent.includes("addEventListener('message'")
    );

    check('sw.js uses cache.addAll for atomic precaching',
      swContent.includes('cache.addAll(PRECACHE_ASSETS)')
    );

    check('sw.js does not swallow precache errors with individual try-catch blocks',
      !swContent.includes('Precache item skipped')
    );

    const match = /const PRECACHE_ASSETS = (\[[\s\S]*?\]);/.exec(swContent);
    check('sw.js has PRECACHE_ASSETS list', !!match);

    if (match) {
      const assets = eval(match[1]);
      let missingCount = 0;
      for (const a of assets) {
        if (a === './' || a === '.') continue;
        const clean = a.replace(/^\.\//, '');
        const full = path.join(SRC, clean);
        if (!fs.existsSync(full)) {
          missingCount++;
          console.error(`Missing precache file: ${clean}`);
        }
      }
      check(`all ${assets.length} precached assets exist in src/`, missingCount === 0);
    }

    // Direct lifecycle execution test in VM sandbox
    function simulateSwInstall(swScript, mockAddAll) {
      let installHandler = null;
      const fakeSelf = {
        addEventListener: (type, fn) => {
          if (type === 'install') installHandler = fn;
        },
        skipWaiting: () => {},
        clients: { claim: async () => {} }
      };
      fakeSelf.self = fakeSelf;

      let openedCache = null;
      let cachedAssets = null;
      const fakeCaches = {
        open: async (name) => {
          openedCache = name;
          return {
            addAll: async (assets) => {
              cachedAssets = assets;
              return mockAddAll(assets);
            }
          };
        }
      };

      const context = vm.createContext({
        self: fakeSelf,
        caches: fakeCaches,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        fetch: async () => {},
        Response: class {},
        URL: URL,
        navigator: { onLine: true }
      });

      vm.runInContext(swScript, context);

      if (!installHandler) {
        throw new Error('Install event handler not found');
      }

      let waitPromise = null;
      const event = {
        waitUntil: (p) => {
          waitPromise = p;
        }
      };

      installHandler(event);
      return { waitPromise, getOpenedCache: () => openedCache, getCachedAssets: () => cachedAssets };
    }

    // 2a. All precache assets succeed
    const successSim = simulateSwInstall(swContent, async (assets) => undefined);
    let successError = null;
    try {
      await successSim.waitPromise;
    } catch (e) {
      successError = e;
    }
    check('atomic install succeeds when all precache assets succeed',
      successError === null &&
      successSim.getOpenedCache().startsWith('gazboard-shell-v') &&
      Array.isArray(successSim.getCachedAssets()) &&
      successSim.getCachedAssets().length > 0
    );

    // 2b. At least one precache asset fails
    const failError = new Error('Network error: 404 Not Found for precache asset');
    const failureSim = simulateSwInstall(swContent, async () => {
      throw failError;
    });
    let failureError = null;
    try {
      await failureSim.waitPromise;
    } catch (e) {
      failureError = e;
    }
    check('atomic install rejects when any precache asset fails', failureError === failError);

    // 2c. Failure causes installation to reject rather than warn/continue
    check('precache failure rejects install event waitUntil promise and prevents incomplete worker activation',
      failureError !== null && failureError.message.includes('404 Not Found')
    );

    // 2d. Service Worker version.json fetch timeout & captive portal regression test
    check('sw.js specifies AbortSignal.timeout(5000) for version.json network fetch',
      swContent.includes('fetch(req, { signal: AbortSignal.timeout(5000) })')
    );

    async function simulateSwFetch(swScript, reqUrl, mockFetchImpl) {
      let fetchHandler = null;
      const fakeSelf = {
        addEventListener: (type, fn) => {
          if (type === 'fetch') fetchHandler = fn;
        },
        skipWaiting: () => {},
        clients: { claim: async () => {} }
      };
      fakeSelf.self = fakeSelf;

      let interceptedOpts = null;
      let timeoutMs = null;
      const trackedAbortSignal = {
        timeout: (ms) => {
          timeoutMs = ms;
          return AbortSignal.timeout(ms);
        }
      };

      class MockResponse {
        constructor(body, init = {}) {
          this.body = body;
          this.headers = new Map(Object.entries(init.headers || {}));
          this.status = init.status || 200;
        }
        async json() {
          return typeof this.body === 'string' ? JSON.parse(this.body) : this.body;
        }
      }

      let respondWithPromise = null;
      const fakeEvent = {
        request: {
          method: 'GET',
          url: reqUrl,
          mode: 'cors'
        },
        respondWith: (p) => {
          respondWithPromise = p;
        }
      };

      const context = vm.createContext({
        self: fakeSelf,
        caches: { open: async () => ({ addAll: async () => {} }) },
        console: { log: () => {}, warn: () => {}, error: () => {} },
        fetch: async (req, opts) => {
          interceptedOpts = opts;
          return mockFetchImpl(req, opts);
        },
        Response: MockResponse,
        AbortSignal: trackedAbortSignal,
        URL: URL,
        navigator: { onLine: true }
      });

      vm.runInContext(swScript, context);

      if (!fetchHandler) {
        throw new Error('Fetch event handler not found');
      }

      fetchHandler(fakeEvent);
      const res = await respondWithPromise;
      return { res, interceptedOpts, timeoutMs };
    }

    const timeoutSim = await simulateSwFetch(
      swContent,
      'https://example.com/version.json?t=123456789',
      async (_req, _opts) => {
        const timeoutErr = new Error('The operation was aborted due to timeout');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
    );

    check('sw.js intercepts version.json and configures exactly 5000ms timeout signal',
      timeoutSim.timeoutMs === 5000 &&
      timeoutSim.interceptedOpts &&
      timeoutSim.interceptedOpts.signal instanceof AbortSignal
    );

    const timeoutBody = await timeoutSim.res.json();
    check('sw.js returns offline fallback when version.json fetch times out (captive portal)',
      timeoutSim.res &&
      timeoutBody &&
      timeoutBody.ok === false &&
      timeoutBody.error === 'Offline' &&
      timeoutSim.res.headers.get('Content-Type') === 'application/json'
    );

    const successSimFetch = await simulateSwFetch(
      swContent,
      'https://example.com/version.json',
      async () => {
        return {
          status: 200,
          headers: new Map([['Content-Type', 'application/json']]),
          json: async () => ({ version: '2.5.0', buildId: '2.5.0-pwa' })
        };
      }
    );
    const successBody = await successSimFetch.res.json();
    check('sw.js returns live network response when version.json fetch succeeds',
      successSimFetch.res &&
      successBody &&
      successBody.version === '2.5.0'
    );
  } catch (e) {
    check('service worker validation failed', false, e.message);
  }

  /* ---------------- 3. Versioning & Update Comparison Logic ---------------- */
  try {
    const { isNewer } = await import('../src/js/core/version.js');
    check('version comparator recognizes 2.5.0 newer than 2.4.0', isNewer('2.5.0', '2.4.0') === true);
    check('version comparator recognizes 2.4.1 newer than 2.4.0', isNewer('2.4.1', '2.4.0') === true);
    check('version comparator recognizes 3.0.0 newer than 2.4.0', isNewer('3.0.0', '2.4.0') === true);
    check('version comparator recognizes 2.4.0 not newer than 2.4.0', isNewer('2.4.0', '2.4.0') === false);
    check('version comparator recognizes 2.3.9 not newer than 2.4.0', isNewer('2.3.9', '2.4.0') === false);

    const updateMgr = await import('../src/js/platform/update-manager.js');
    const originalFetch = global.fetch;

    // Test update check with initialized installed version (same as server)
    updateMgr.setAppVersion('2.4.1');
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '2.4.1' })
    });
    const checkSame = await updateMgr.checkForUpdate();
    check('update-manager reports current version when on latest', checkSame.ok === true && checkSame.version === '2.4.1' && checkSame.name === 'GazBoard 2.4.1');

    // Test update check with newer version on server
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '2.5.0' })
    });
    const checkNewer = await updateMgr.checkForUpdate();
    check('update-manager reports remote version when newer update exists', checkNewer.ok === true && checkNewer.version === '2.5.0' && checkNewer.name === 'GazBoard 2.5.0');

    // Test update check with uninitialized version (null)
    updateMgr.setAppVersion(null);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '0.0.0' })
    });
    const checkUnset = await updateMgr.checkForUpdate();
    check('update-manager does not use remote version as fallback for uninitialized current version', checkUnset.ok === true && checkUnset.version === null && checkUnset.name === 'GazBoard');

    global.fetch = originalFetch;
  } catch (e) {
    check('version comparison test failed', false, e.message);
  }

  /* ---------------- 4. PDF 1.4 Binary Generator Verification ---------------- */
  try {
    const { generatePdfFromHtml } = await import('../src/js/platform/web-pdf.js');

    // Create a 1x1 transparent PNG data URL
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const dataUrl = `data:image/png;base64,${pngBase64}`;

    // Test with mock DOM parser in Node
    global.DOMParser = class MockDOMParser {
      parseFromString(html) {
        const sheetMatches = [...html.matchAll(/<div class="sheet"([^>]*)>([\s\S]*?)<\/div>/gi)];
        const sheets = sheetMatches.map((sm) => {
          const sheetAttrs = sm[1];
          const inner = sm[2];
          const imgMatch = /<img[^>]+src="([^">]+)"([^>]*)>/i.exec(inner);
          const styleMatch = /style="([^"]*)"/i.exec(sheetAttrs);
          const sheetStyle = styleMatch ? styleMatch[1] : '';

          const imgEl = imgMatch ? {
            getAttribute: (attr) => {
              if (attr === 'src') return imgMatch[1];
              if (attr === 'style') {
                const s = /style="([^"]*)"/i.exec(imgMatch[2]);
                return s ? s[1] : '';
              }
              return null;
            },
            src: imgMatch[1]
          } : null;

          return {
            getAttribute: (attr) => attr === 'style' ? sheetStyle : null,
            querySelector: (sel) => sel === 'img' ? imgEl : null,
            querySelectorAll: (sel) => sel === 'img' && imgEl ? [imgEl] : []
          };
        });

        const imgMatches = [...html.matchAll(/<img[^>]+src="([^">]+)"([^>]*)>/gi)];
        const allImgs = imgMatches.map((im) => ({
          getAttribute: (attr) => {
            if (attr === 'src') return im[1];
            if (attr === 'style') {
              const s = /style="([^"]*)"/i.exec(im[2]);
              return s ? s[1] : '';
            }
            return null;
          },
          src: im[1]
        }));

        return {
          querySelector: (sel) => {
            if (sel === '.sheet') return sheets[0] || null;
            if (sel === 'img') return allImgs[0] || null;
            return null;
          },
          querySelectorAll: (sel) => {
            if (sel === '.sheet') return sheets;
            if (sel.includes('img')) return allImgs;
            return [];
          }
        };
      }
    };

    global.Image = class MockImage {
      constructor() {
        this.naturalWidth = 100;
        this.naturalHeight = 100;
        this.width = 100;
        this.height = 100;
        setTimeout(() => { if (this.onload) this.onload(); }, 10);
      }
    };

    const mockCtx = {
      fillStyle: '',
      fillRect: () => {},
      drawImage: () => {}
    };

    const origCreateElement = global.document.createElement;
    global.document.createElement = (tag) => {
      if (tag.toLowerCase() === 'canvas') {
        return {
          width: 100,
          height: 100,
          getContext: () => mockCtx,
          toBlob: (cb) => {
            // Mock JPEG header + bytes
            const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]);
            cb(new global.Blob([fakeJpeg], { type: 'image/jpeg' }));
          }
        };
      }
      return origCreateElement(tag);
    };

    // 4a. A4 Landscape with Narrow Margin (8mm)
    const a4LandscapeHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: 297mm 210mm; margin: 0; }
      .sheet { width: 297mm; height: 210mm; box-sizing: border-box; padding: 8mm; }
    </style></head><body>
      <div class="sheet"><img src="${dataUrl}" style="width:281mm;height:174.4mm"></div>
    </body></html>`;

    const a4Res = await generatePdfFromHtml({
      html: a4LandscapeHtml,
      widthIn: 297 / 25.4,
      heightIn: 210 / 25.4
    });

    check('generatePdfFromHtml succeeds for A4 landscape', a4Res.ok === true);
    check('generatePdfFromHtml returns ArrayBuffer', a4Res.data instanceof ArrayBuffer);

    const a4Bytes = Buffer.from(a4Res.data);
    const a4Text = a4Bytes.toString('latin1');
    check('PDF has %PDF-1.4 header', a4Text.startsWith('%PDF-1.4'));
    check('PDF contains /Type /Catalog', a4Text.includes('/Type /Catalog'));
    check('PDF contains /Type /Pages', a4Text.includes('/Type /Pages'));
    check('PDF contains /Type /Page', a4Text.includes('/Type /Page'));
    check('PDF contains /Type /XObject', a4Text.includes('/Type /XObject'));
    check('PDF contains /Filter /DCTDecode', a4Text.includes('/Filter /DCTDecode'));
    check('PDF contains xref table and %%EOF trailer', a4Text.includes('xref') && a4Text.includes('%%EOF'));

    const a4Boxes = [...a4Text.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
      .map((m) => ({ wPt: +m[3] - +m[1], hPt: +m[4] - +m[2], wMm: ((+m[3] - +m[1]) / 72) * 25.4, hMm: ((+m[4] - +m[2]) / 72) * 25.4 }));

    check('A4 landscape PDF MediaBox matches 297mm x 210mm',
      a4Boxes.length === 1 && Math.abs(a4Boxes[0].wMm - 297) < 0.5 && Math.abs(a4Boxes[0].hMm - 210) < 0.5
    );

    const a4Stream = /stream\s*\n([\s\S]*?)endstream/.exec(a4Text)?.[1] || '';
    check('A4 landscape image is placed with 8mm horizontal margin and centered vertically',
      a4Stream.includes('22.68') && a4Stream.includes('50.4')
    );

    // 4b. Letter Portrait with Normal Margin (15mm)
    const letterPortraitHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: 215.9mm 279.4mm; margin: 0; }
      .sheet { width: 215.9mm; height: 279.4mm; box-sizing: border-box; padding: 15mm; }
    </style></head><body>
      <div class="sheet"><img src="${dataUrl}" style="width:185.9mm;height:115.4mm"></div>
    </body></html>`;

    const letterRes = await generatePdfFromHtml({
      html: letterPortraitHtml,
      widthIn: 8.5,
      heightIn: 11
    });

    const letterBytes = Buffer.from(letterRes.data);
    const letterText = letterBytes.toString('latin1');
    const letterBoxes = [...letterText.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
      .map((m) => ({ wPt: +m[3] - +m[1], hPt: +m[4] - +m[2], wMm: ((+m[3] - +m[1]) / 72) * 25.4, hMm: ((+m[4] - +m[2]) / 72) * 25.4 }));

    check('Letter portrait PDF MediaBox matches 215.9mm x 279.4mm (8.5in x 11in)',
      letterBoxes.length === 1 && Math.abs(letterBoxes[0].wMm - 215.9) < 0.5 && Math.abs(letterBoxes[0].hMm - 279.4) < 0.5
    );

    const letterStream = /stream\s*\n([\s\S]*?)endstream/.exec(letterText)?.[1] || '';
    check('Letter portrait image is placed with 15mm margin offset', letterStream.includes('42.52'));

    // 4c. A5 Tiled Multi-Page Export (2 pages)
    const tiledHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: 148mm 210mm; margin: 0; }
      .sheet { width: 148mm; height: 210mm; }
    </style></head><body>
      <div class="sheet"><img src="${dataUrl}" style="width:148mm;height:210mm"></div>
      <div class="sheet"><img src="${dataUrl}" style="width:148mm;height:210mm"></div>
    </body></html>`;

    const tiledRes = await generatePdfFromHtml({
      html: tiledHtml,
      widthIn: 148 / 25.4,
      heightIn: 210 / 25.4
    });

    const tiledBytes = Buffer.from(tiledRes.data);
    const tiledText = tiledBytes.toString('latin1');
    const tiledBoxes = [...tiledText.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
      .map((m) => ({ wPt: +m[3] - +m[1], hPt: +m[4] - +m[2], wMm: ((+m[3] - +m[1]) / 72) * 25.4, hMm: ((+m[4] - +m[2]) / 72) * 25.4 }));

    check('A5 tiled export generates multiple pages', tiledBoxes.length === 2);
    check('A5 tiled export pages all have A5 portrait MediaBox (148mm x 210mm)',
      tiledBoxes.every((b) => Math.abs(b.wMm - 148) < 0.5 && Math.abs(b.hMm - 210) < 0.5)
    );

    // 4d. Multi-page Pad Export (3 pages)
    const padHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: 210mm 297mm; margin: 0; }
      .sheet { width: 210mm; height: 297mm; }
    </style></head><body>
      <div class="sheet"><img src="${dataUrl}" style="width:210mm;height:297mm"></div>
      <div class="sheet"><img src="${dataUrl}" style="width:210mm;height:297mm"></div>
      <div class="sheet"><img src="${dataUrl}" style="width:210mm;height:297mm"></div>
    </body></html>`;

    const padRes = await generatePdfFromHtml({
      html: padHtml,
      widthIn: 210 / 25.4,
      heightIn: 297 / 25.4
    });

    const padBytes = Buffer.from(padRes.data);
    const padText = padBytes.toString('latin1');
    const padBoxes = [...padText.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
      .map((m) => ({ wPt: +m[3] - +m[1], hPt: +m[4] - +m[2], wMm: ((+m[3] - +m[1]) / 72) * 25.4, hMm: ((+m[4] - +m[2]) / 72) * 25.4 }));

    check('Multi-page pad export generates 3 pages', padBoxes.length === 3);
    check('Multi-page pad export pages have correct pad paper dimensions (A4 portrait)',
      padBoxes.every((b) => Math.abs(b.wMm - 210) < 0.5 && Math.abs(b.hMm - 297) < 0.5)
    );

    // 4e. Full PDF specification & PDF.js parser compatibility verification
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const parsedPdf = await pdfjsLib.getDocument({ data: new Uint8Array(padRes.data) }).promise;
    check('Generated PDF parses successfully with PDF.js', parsedPdf.numPages === 3);
    const page1 = await parsedPdf.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    check('PDF.js viewport matches target page geometry (595.28pt x 841.89pt)',
      Math.abs(vp.width - 595.28) < 0.5 && Math.abs(vp.height - 841.89) < 0.5
    );
  } catch (e) {
    check('PDF generation test failed', false, e.message);
  }

  /* ---------------- 5. Mobile Responsive CSS Validation ---------------- */
  try {
    const cssPath = path.join(SRC, 'css', 'app.css');
    check('app.css exists', fs.existsSync(cssPath));
    const css = await fsp.readFile(cssPath, 'utf8');

    check('app.css supports 100dvh dynamic viewport unit', css.includes('100dvh'));
    check('app.css includes safe-area-inset padding',
      css.includes('env(safe-area-inset-top') &&
      css.includes('env(safe-area-inset-bottom')
    );
    check('app.css includes pointer: coarse touch target rules', css.includes('@media (pointer: coarse)'));
    check('app.css includes smartphone media query (max-width: 480px)', css.includes('@media (max-width: 480px)'));
    check('app.css includes touch-action: none on canvas', css.includes('touch-action: none'));
  } catch (e) {
    check('mobile CSS audit failed', false, e.message);
  }

  /* ---------------- 6. Web Files Bridge Validation ---------------- */
  try {
    const { registerSessionFile, readVirtualFile, writeVirtualFile, fileOrigin } = await import('../src/js/platform/web-files.js');

    const fakeFile = new global.Blob(['Hello GazBoard'], { type: 'text/plain' });
    fakeFile.name = 'test-board.gazboard';

    const token = registerSessionFile(fakeFile);
    check('registerSessionFile returns virt:// path', token.startsWith('virt://'));

    const readBuf = await readVirtualFile(token);
    const readText = new TextDecoder().decode(readBuf);
    check('readVirtualFile retrieves original file contents', readText === 'Hello GazBoard');

    const writeOk = await writeVirtualFile('export.png', new Uint8Array([1, 2, 3]));
    check('writeVirtualFile initiates download without error', writeOk === true);

    // The virtual token counts picks; it does not name the file. Opening the
    // same board twice has to look like the same board, or the desktop's
    // copy-vs-same-document question would be asked again on every open and
    // breed a copy each time. See claimLocalBoard() in app.js.
    const again = new global.Blob(['Hello GazBoard'], { type: 'text/plain' });
    again.name = 'test-board.gazboard';
    Object.defineProperty(again, 'lastModified', { value: 1700000000000 });
    Object.defineProperty(fakeFile, 'lastModified', { value: 1700000000000 });
    const t2 = registerSessionFile(again);
    check('a second pick of the same file gets a different token', token !== t2);
    check('but the same origin, so it is recognised as the same board',
      fileOrigin(token) && fileOrigin(token) === fileOrigin(t2), fileOrigin(t2));

    // a genuinely different file must NOT be mistaken for it
    const other = new global.Blob(['Hello GazBoard, but longer'], { type: 'text/plain' });
    other.name = 'test-board.gazboard';
    Object.defineProperty(other, 'lastModified', { value: 1700000000000 });
    const t3 = registerSessionFile(other);
    check('a different file of the same name is not mistaken for it',
      fileOrigin(t3) !== fileOrigin(token), fileOrigin(t3));

    check('an unknown token has no origin at all', fileOrigin('virt://nope/x') === null);
  } catch (e) {
    check('web files bridge failed', false, e.message);
  }

  /* ---------------- 7. Web Platform Adapter Contract Parity ---------------- */
  try {
    const adapterPath = fs.existsSync(path.join(DIST, 'js', 'platform', 'web-adapter.js'))
      ? '../dist-web/js/platform/web-adapter.js'
      : '../src/js/platform/web-adapter.js';
    const { createWebAdapter } = await import(adapterPath);
    const adapter = createWebAdapter();

    const requiredMethods = [
      'info', 'readFile', 'fileOrigin', 'writeFile', 'openDialog', 'saveDialog',
      'showItem', 'openReleases', 'checkForUpdate', 'importToPdf', 'exportPdf',
      'onMenu', 'onOpenFile', 'onWindowResized', 'onFlush'
    ];

    for (const m of requiredMethods) {
      check(`adapter has method: ${m}`, typeof adapter[m] === 'function');
    }

    const requiredBoardMethods = ['list', 'load', 'save', 'remove', 'last', 'setLast', 'resume', 'migrate'];
    for (const m of requiredBoardMethods) {
      check(`adapter.boards has method: ${m}`, typeof adapter.boards[m] === 'function');
    }

    const requiredAssetMethods = ['put', 'get', 'have'];
    for (const m of requiredAssetMethods) {
      check(`adapter.assets has method: ${m}`, typeof adapter.assets[m] === 'function');
    }

    const info = await adapter.info();
    const expectedVersion = fs.existsSync(path.join(DIST, 'js', 'platform', 'web-adapter.js'))
      ? PKG.version
      : '__APP_VERSION__';
    check('adapter.info() returns web runtime info', info.platform === 'browser' && info.isWeb === true && info.version === expectedVersion);
  } catch (e) {
    check('web adapter contract parity failed', false, e.message);
  }

  /* ---------------- 8. Popover Event Listener Leak & Cleanup ---------------- */
  try {
    const { openPopover, closePopover } = await import('../src/js/ui/popover.js');
    const listeners = [];
    const origAdd = global.document.addEventListener;
    const origRemove = global.document.removeEventListener;

    global.document.addEventListener = (type, fn, capture) => {
      listeners.push({ type, fn, capture });
      if (origAdd) origAdd(type, fn, capture);
    };
    global.document.removeEventListener = (type, fn, capture) => {
      const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (idx >= 0) listeners.splice(idx, 1);
      if (origRemove) origRemove(type, fn, capture);
    };

    const content = global.document.createElement('div');
    const anchor = { x: 100, y: 100 };
    openPopover(anchor, content, { key: 'test-pop' });

    // Simulate tick for setTimeout listener attachment
    await new Promise((r) => setTimeout(r, 10));
    check('openPopover adds pointerdown listener', listeners.some((l) => l.type === 'pointerdown'));

    closePopover();
    check('closePopover cleans up document pointerdown listener (no leak)', !listeners.some((l) => l.type === 'pointerdown'));

    global.document.addEventListener = origAdd;
    global.document.removeEventListener = origRemove;
  } catch (e) {
    check('popover listener cleanup test failed', false, e.message);
  }

  /* ---------------- 9. Standard Fonts Precache Verification ---------------- */
  try {
    const swPath = path.join(SRC, 'sw.js');
    const swContent = await fsp.readFile(swPath, 'utf8');
    const requiredFonts = [
      'FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb',
      'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb', 'FoxitSerif.pfb',
      'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb',
      'FoxitSymbol.pfb', 'LiberationSans-Bold.ttf', 'LiberationSans-BoldItalic.ttf',
      'LiberationSans-Italic.ttf', 'LiberationSans-Regular.ttf'
    ];

    let allFontsPresent = true;
    for (const f of requiredFonts) {
      if (!swContent.includes(f)) {
        allFontsPresent = false;
        break;
      }
    }
    check('Service Worker precaches standard fonts for offline PDF rendering', allFontsPresent);
    check('Service Worker handles ignoreSearch for resilient offline SPA navigation', swContent.includes('ignoreSearch: true'));
  } catch (e) {
    check('standard fonts precache test failed', false, e.message);
  }

  /* ---------------- 10. Build Version Derivation & Single Source of Truth ---------------- */
  try {
    check('package.json provides valid version string', typeof PKG.version === 'string' && /^\d+\.\d+\.\d+/.test(PKG.version));

    check('dist-web distribution directory exists', fs.existsSync(DIST));

    const distSwPath = path.join(DIST, 'sw.js');
    check('dist-web/sw.js exists', fs.existsSync(distSwPath));
    const distSwContent = await fsp.readFile(distSwPath, 'utf8');
    check('dist-web/sw.js contains package.json version', distSwContent.includes(`const VERSION = ${JSON.stringify(PKG.version)};`));
    check('dist-web/sw.js defines versioned shell cache', distSwContent.includes('const SHELL_CACHE = `gazboard-shell-v${VERSION}`;'));
    check('dist-web/sw.js defines versioned runtime cache', distSwContent.includes('const RUNTIME_CACHE = `gazboard-runtime-v${VERSION}`;'));
    check('dist-web/sw.js uses atomic cache.addAll precaching', distSwContent.includes('cache.addAll(PRECACHE_ASSETS)'));

    const distAdapterPath = path.join(DIST, 'js', 'platform', 'web-adapter.js');
    check('dist-web/web-adapter.js exists', fs.existsSync(distAdapterPath));
    const distAdapterContent = await fsp.readFile(distAdapterPath, 'utf8');
    check('dist-web/web-adapter.js contains package.json version', distAdapterContent.includes(`const APP_VERSION = ${JSON.stringify(PKG.version)};`));

    const distVersionPath = path.join(DIST, 'version.json');
    check('dist-web/version.json exists', fs.existsSync(distVersionPath));
    const distVersionMeta = JSON.parse(await fsp.readFile(distVersionPath, 'utf8'));
    check('dist-web/version.json contains package.json version', distVersionMeta.version === PKG.version);
    check('dist-web/version.json buildId derives from package.json version', typeof distVersionMeta.buildId === 'string' && distVersionMeta.buildId.startsWith(`${PKG.version}-pwa-`));
  } catch (e) {
    check('build version derivation verification failed', false, e.message);
  }

  /* ---------------- 11. Storage & haveAssets() Promise Resolution Verification ---------------- */
  try {
    const storage = await import('../src/js/platform/web-storage.js');

    // Bounded execution helper ensuring tests fail fast if a promise hangs
    function withTimeout(promise, ms = 1000, desc = 'operation') {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${desc}`)), ms);
      });
      return Promise.race([
        promise.then((res) => { clearTimeout(timer); return res; }, (err) => { clearTimeout(timer); throw err; }),
        timeoutPromise
      ]);
    }

    // 11a. Regression test for reviewer's bug: invalid IDs must not cause haveAssets() to hang indefinitely
    const singleInvalidRes = await withTimeout(storage.haveAssets(['invalid-asset-id']), 500, 'haveAssets single invalid ID');
    check('haveAssets resolves promptly for invalid asset ID without hanging', singleInvalidRes && singleInvalidRes['invalid-asset-id'] === false);

    const multiInvalidRes = await withTimeout(storage.haveAssets(['invalid-1', 'invalid-2', '']), 500, 'haveAssets multiple invalid IDs');
    check('haveAssets resolves promptly for list of multiple invalid IDs',
      multiInvalidRes &&
      multiInvalidRes['invalid-1'] === false &&
      multiInvalidRes['invalid-2'] === false &&
      multiInvalidRes[''] === false
    );

    // 11b. Empty and non-array inputs
    const emptyRes = await withTimeout(storage.haveAssets([]), 500, 'haveAssets empty array');
    check('haveAssets settles for empty array input', typeof emptyRes === 'object' && Object.keys(emptyRes).length === 0);

    const nullRes = await withTimeout(storage.haveAssets(null), 500, 'haveAssets null');
    const undefinedRes = await withTimeout(storage.haveAssets(undefined), 500, 'haveAssets undefined');
    check('haveAssets settles for non-array input (null/undefined)',
      typeof nullRes === 'object' && Object.keys(nullRes).length === 0 &&
      typeof undefinedRes === 'object' && Object.keys(undefinedRes).length === 0
    );

    // 11c. Put a real asset and verify haveAssets detects both existing and missing IDs
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const dataUrl = `data:image/png;base64,${pngBase64}`;
    const putRes = await storage.putAsset(dataUrl);
    check('storage.putAsset stores an asset and returns an ID', putRes && typeof putRes.id === 'string' && /^[0-9a-f]{64}\.png$/.test(putRes.id));

    const existingId = putRes.id;
    const missingId = '0000000000000000000000000000000000000000000000000000000000000000.png';

    const existingRes = await withTimeout(storage.haveAssets([existingId]), 500, 'haveAssets existing ID');
    check('haveAssets resolves true for existing asset ID', existingRes && existingRes[existingId] === true);

    const missingRes = await withTimeout(storage.haveAssets([missingId]), 500, 'haveAssets missing ID');
    check('haveAssets resolves false for missing valid asset ID', missingRes && missingRes[missingId] === false);

    // 11d. Mixed input with existing, missing, invalid, and empty strings
    const mixedInput = [existingId, 'invalid-id-123', missingId, '', 'another-bad-id'];
    const mixedRes = await withTimeout(storage.haveAssets(mixedInput), 500, 'haveAssets mixed input');
    check('haveAssets resolves correct mapping for mixed valid, missing, and invalid IDs',
      mixedRes &&
      mixedRes[existingId] === true &&
      mixedRes['invalid-id-123'] === false &&
      mixedRes[missingId] === false &&
      mixedRes[''] === false &&
      mixedRes['another-bad-id'] === false
    );

    // 11e. Duplicate IDs in input list
    const duplicateRes = await withTimeout(storage.haveAssets([existingId, 'bad-id', existingId]), 500, 'haveAssets duplicates');
    check('haveAssets resolves correctly when input list contains duplicate IDs',
      duplicateRes &&
      duplicateRes[existingId] === true &&
      duplicateRes['bad-id'] === false
    );

    // 11f. Adapter delegation parity (window.board.assets.have)
    const { createWebAdapter } = await import('../src/js/platform/web-adapter.js');
    const adapter = createWebAdapter();
    const adapterRes = await withTimeout(adapter.assets.have([existingId, 'bad-id']), 500, 'adapter.assets.have');
    check('adapter.assets.have delegates to storage and resolves accurately',
      adapterRes &&
      adapterRes[existingId] === true &&
      adapterRes['bad-id'] === false
    );
  } catch (e) {
    check('storage haveAssets verification failed', false, e.message);
  }

  /* ---------------- 12. SHA-256 Fallback & Content-Addressed Collision Regression ---------------- */
  try {
    const storage = await import('../src/js/platform/web-storage.js');
    const origCryptoDesc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

    function makePngDataUrl(buf) {
      return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
    }

    try {
      // Temporarily disable Web Crypto (crypto.subtle) to explicitly force pure-JS fallback path
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });

      // Test 1: NIST SHA-256 Vectors (FIPS 180-4) via putAsset
      const nistVectors = [
        { name: 'empty string', text: '', expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
        { name: 'abc', text: 'abc', expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
        { name: 'fox without period', text: 'The quick brown fox jumps over the lazy dog', expected: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592' },
        { name: 'fox with period', text: 'The quick brown fox jumps over the lazy dog.', expected: 'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c' }
      ];

      for (const nv of nistVectors) {
        const dataUrl = `data:image/png;base64,${Buffer.from(nv.text).toString('base64')}`;
        const res = await storage.putAsset(dataUrl);
        const expectedId = `${nv.expected}.png`;
        check(`SHA-256 fallback matches NIST vector for ${nv.name}`, res && res.id === expectedId, `id: ${res?.id}`);
      }

      // Test 2: Differential Testing against Node.js crypto across multiple boundary lengths
      const testLengths = [0, 1, 2, 7, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 255, 256, 1024, 2048];
      let diffPassed = true;
      let diffFailureDetail = '';

      for (const len of testLengths) {
        const buf = Buffer.alloc(len);
        for (let i = 0; i < len; i++) {
          buf[i] = (i * 37 + (i % 7) * 13) & 0xff;
        }
        const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');
        const dataUrl = makePngDataUrl(buf);
        const res = await storage.putAsset(dataUrl);
        if (!res || res.id !== `${expectedHash}.png`) {
          diffPassed = false;
          diffFailureDetail = `Length ${len}: got ${res?.id}, expected ${expectedHash}.png`;
          break;
        }
      }
      check('SHA-256 fallback matches Node crypto across boundary lengths (0..2048 bytes)', diffPassed, diffFailureDetail);

      // Test 3: Disable Web Crypto verification
      check('SHA-256 fallback executes successfully when Web Crypto subtle is unavailable', typeof global.crypto === 'undefined');

      // Test 4: Reproduce reviewer 48-byte differential collision pattern
      const bufA = Buffer.alloc(48);
      const bufB = Buffer.alloc(48);
      for (let i = 0; i < 48; i++) {
        bufA[i] = (i * 5) & 0xff;
        bufB[i] = (i * 5) & 0xff;
      }
      bufB[0] ^= 0x5a;
      bufB[24] ^= 0x5a;

      const hashA = crypto.createHash('sha256').update(bufA).digest('hex');
      const hashB = crypto.createHash('sha256').update(bufB).digest('hex');
      const resA = await storage.putAsset(makePngDataUrl(bufA));
      const resB = await storage.putAsset(makePngDataUrl(bufB));

      check('Reviewer 48-byte differential inputs are non-identical', !bufA.equals(bufB));
      check('SHA-256 fallback generates distinct hashes for 48-byte differential inputs (no % 24 collision)',
        resA && resB && resA.id !== resB.id && resA.id === `${hashA}.png` && resB.id === `${hashB}.png`,
        `resA: ${resA?.id?.slice(0, 16)}..., resB: ${resB?.id?.slice(0, 16)}...`
      );

      // Test 5: Asset-level regression: distinct assets coexist in IndexedDB without silent replacement
      const getA = await storage.getAsset(resA.id);
      const getB = await storage.getAsset(resB.id);
      const expectedUrlA = makePngDataUrl(bufA);
      const expectedUrlB = makePngDataUrl(bufB);

      check('Distinct assets coexist independently in store without deduplication collision',
        getA === expectedUrlA && getB === expectedUrlB && getA !== getB
      );

    } finally {
      if (origCryptoDesc) {
        Object.defineProperty(globalThis, 'crypto', origCryptoDesc);
      }
    }

    // Verify Web Crypto fast path produces identical hash to fallback path
    const testSample = Buffer.from('GazBoard Web Crypto Fast Path Parity Verification');
    const fastExpectedHash = crypto.createHash('sha256').update(testSample).digest('hex');
    const fastRes = await storage.putAsset(makePngDataUrl(testSample));
    check('Web Crypto fast path and fallback generate identical standard SHA-256 IDs',
      fastRes && fastRes.id === `${fastExpectedHash}.png`
    );

  } catch (e) {
    check('SHA-256 fallback regression tests failed', false, e.message);
  }

  /* ---------------- Sharing on the network is desktop-only ----------------
   *
   * The browser cannot bind a listening socket or answer one, so LAN sharing
   * has no meaning here. What matters is that the web build does not merely
   * fail at it quietly but never offers it: no folder of transport code in the
   * bundle, no bridge to call, and no section in Settings promising something
   * this runtime cannot do.
   */
  try {
    const adapter = fs.readFileSync(path.join(SRC, 'js/platform/web-adapter.js'), 'utf8');
    // `async` contains "sync", so this looks for the property, not the word.
    check('the web build exposes no sync bridge at all',
      !/\bsync\s*:/.test(adapter) && !/board\.sync\s*=/.test(adapter));

    const shipped = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else shipped.push(full);
      }
    };
    if (fs.existsSync(DIST)) walk(DIST);

    // None of the transport ships. It is main-process CommonJS that the
    // renderer never imports, so it cannot arrive here by accident - but a
    // build script that started copying the repo wholesale would change that.
    const transport = shipped.filter((f) => /[\\/]sync[\\/]/.test(f)
      || /(protocol|firewall)\.js$/.test(path.basename(f)));
    check('and none of the transport code is in the bundle',
      transport.length === 0, transport.map((f) => path.relative(DIST, f)).join(', '));

    const bundle = shipped.filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    check('nothing in the web bundle can open a socket or announce this browser',
      !/createSyncNode|dgram|setBroadcast|X25519/.test(bundle));

    // The Settings section is behind a guard rather than absent from the file,
    // so the guard itself is the thing worth pinning.
    const panels = fs.readFileSync(path.join(SRC, 'js/ui/panels.js'), 'utf8');
    check('Settings only offers sharing when there is a bridge to do it with',
      /\(window\.board && window\.board\.sync\) \? h\('div'/.test(panels));

    const app = fs.readFileSync(path.join(SRC, 'js/app.js'), 'utf8');
    check('and start-up gives up on sharing before touching anything',
      /if \(!window\.board \|\| !window\.board\.sync\) return;/.test(app));
  } catch (e) {
    check('desktop-only sharing checks failed', false, e.message);
  }

  /* ---------------- Results Summary ---------------- */
  console.log(`\n========================================`);
  console.log(`  Web/PWA Test Suite: ${pass} passed, ${fail} failed`);
  console.log(`========================================\n`);

  if (fail > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test runner encountered unexpected error:', err);
  process.exit(1);
});
