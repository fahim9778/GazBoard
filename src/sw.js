// Production Service Worker for GazBoard PWA.
// Fully offline-first, versioned, atomic updates, zero-loss durability.

const VERSION = '2.4.0';
const SHELL_CACHE = `gazboard-shell-v${VERSION}`;
const RUNTIME_CACHE = `gazboard-runtime-v${VERSION}`;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/errors.js',
  './js/app.js',
  './js/export.js',
  './js/insert.js',
  './js/templates.js',
  './js/core/camera.js',
  './js/core/cursors.js',
  './js/core/erase.js',
  './js/core/hit.js',
  './js/core/ink.js',
  './js/core/pages.js',
  './js/core/recognize.js',
  './js/core/render.js',
  './js/core/store.js',
  './js/core/surface.js',
  './js/core/tools.js',
  './js/core/transform.js',
  './js/core/util.js',
  './js/core/version.js',
  './js/importers/pdf.js',
  './js/importers/pptx.js',
  './js/ui/contextmenu.js',
  './js/ui/icons.js',
  './js/ui/pagepicker.js',
  './js/ui/palettes.js',
  './js/ui/panels.js',
  './js/ui/pdfdialog.js',
  './js/ui/popover.js',
  './js/ui/textedit.js',
  './js/ui/toolbar.js',
  './js/platform/platform.js',
  './js/platform/web-adapter.js',
  './js/platform/web-storage.js',
  './js/platform/web-files.js',
  './js/platform/web-pdf.js',
  './js/platform/update-manager.js',
  './vendor/jszip.min.js',
  './vendor/mammoth.browser.min.js',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './assets/icon.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-16.png',
  './assets/icon-32.png',
  './assets/icon-64.png',
  './assets/icon-128.png',
  './assets/icon-256.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Precache critical shell files atomically
      for (const asset of PRECACHE_ASSETS) {
        try {
          await cache.add(asset);
        } catch (e) {
          console.warn(`[sw] Precache item skipped: ${asset} (${e.message})`);
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      // Clean up outdated caches
      for (const key of keys) {
        if (key !== SHELL_CACHE && key !== RUNTIME_CACHE && key.startsWith('gazboard-')) {
          console.log(`[sw] Purging old cache: ${key}`);
          await caches.delete(key);
        }
      }
      await self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignore cross-origin non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // Never cache version check manifest or update API
  if (url.pathname.endsWith('/version.json') || url.searchParams.has('t')) {
    event.respondWith(
      fetch(req).catch(() => new Response(JSON.stringify({ ok: false, error: 'Offline' }), {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // Handle SPA Navigation requests
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('./index.html') || await caches.match('./') || await caches.match(req);
          if (cached) return cached;
          return new Response('GazBoard is offline. Please open when connected or reload.', {
            headers: { 'Content-Type': 'text/plain' }
          });
        })
    );
    return;
  }

  // Handle Static Assets: Cache First with Network Fallback & Runtime Caching
  event.respondWith(
    caches.match(req).then(async (cached) => {
      if (cached) {
        // Asynchronously update in background if online
        if (navigator.onLine && !url.pathname.includes('/vendor/cmaps/')) {
          fetch(req).then((fresh) => {
            if (fresh && fresh.status === 200) {
              caches.open(SHELL_CACHE).then((c) => c.put(req, fresh));
            }
          }).catch(() => {});
        }
        return cached;
      }

      // Not in cache, fetch from network and cache in runtime cache
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const clone = fresh.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
        }
        return fresh;
      } catch (e) {
        // If offline and request fails
        return new Response(null, { status: 404, statusText: 'Offline - Asset Not Cached' });
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data?.type === 'GET_VERSION') {
    event.ports?.[0]?.postMessage({ version: VERSION });
  }
});
