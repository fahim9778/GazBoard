// Automated Test Suite for GazBoard Web/PWA Runtime.
// Runs standalone in Node.js / headless environment to verify all Web/PWA subsystems.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

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

  global.navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',
    onLine: true,
    storage: {
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ quota: 10737418240, usage: 1048576 })
    }
  };

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

  /* ---------------- 2. Service Worker & Precache Asset Verification ---------------- */
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

    const versionJsonPath = path.join(SRC, 'version.json');
    check('version.json exists', fs.existsSync(versionJsonPath));
    const versionMeta = JSON.parse(await fsp.readFile(versionJsonPath, 'utf8'));
    check('version.json has valid version string', /^\d+\.\d+\.\d+/.test(versionMeta.version));
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
        return {
          querySelectorAll: (sel) => {
            if (sel.includes('img')) {
              return [
                {
                  getAttribute: (attr) => attr === 'src' ? dataUrl : 'width:210mm;height:297mm',
                  src: dataUrl
                }
              ];
            }
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

    const pdfRes = await generatePdfFromHtml({
      html: `<div class="sheet"><img src="${dataUrl}" style="width:210mm;height:297mm"></div>`,
      widthIn: 8.27,
      heightIn: 11.69
    });

    check('generatePdfFromHtml succeeds', pdfRes.ok === true);
    check('generatePdfFromHtml returns ArrayBuffer', pdfRes.data instanceof ArrayBuffer);

    const pdfBytes = Buffer.from(pdfRes.data);
    const pdfText = pdfBytes.toString('binary');
    check('PDF has %PDF-1.4 header', pdfText.startsWith('%PDF-1.4'));
    check('PDF contains /Type /Catalog', pdfText.includes('/Type /Catalog'));
    check('PDF contains /Type /Pages', pdfText.includes('/Type /Pages'));
    check('PDF contains /Type /Page', pdfText.includes('/Type /Page'));
    check('PDF contains /Type /XObject', pdfText.includes('/Type /XObject'));
    check('PDF contains /Filter /DCTDecode', pdfText.includes('/Filter /DCTDecode'));
    check('PDF contains xref table and %%EOF trailer', pdfText.includes('xref') && pdfText.includes('%%EOF'));
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
    const { registerSessionFile, readVirtualFile, writeVirtualFile } = await import('../src/js/platform/web-files.js');

    const fakeFile = new global.Blob(['Hello GazBoard'], { type: 'text/plain' });
    fakeFile.name = 'test-board.gazboard';

    const token = registerSessionFile(fakeFile);
    check('registerSessionFile returns virt:// path', token.startsWith('virt://'));

    const readBuf = await readVirtualFile(token);
    const readText = new TextDecoder().decode(readBuf);
    check('readVirtualFile retrieves original file contents', readText === 'Hello GazBoard');

    const writeOk = await writeVirtualFile('export.png', new Uint8Array([1, 2, 3]));
    check('writeVirtualFile initiates download without error', writeOk === true);
  } catch (e) {
    check('web files bridge failed', false, e.message);
  }

  /* ---------------- 7. Web Platform Adapter Contract Parity ---------------- */
  try {
    const { createWebAdapter } = await import('../src/js/platform/web-adapter.js');
    const adapter = createWebAdapter();

    const requiredMethods = [
      'info', 'readFile', 'writeFile', 'openDialog', 'saveDialog',
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
    check('adapter.info() returns web runtime info', info.platform === 'browser' && info.isWeb === true && info.version === '2.4.0');
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

  /* ---------------- Results Summary ---------------- */
  console.log(`\n========================================`);
  console.log(`  Web/PWA Test Suite: ${pass} passed, ${fail} failed`);
  console.log(`========================================\n`);

  if (fail > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner encountered unexpected error:', err);
  process.exit(1);
});
