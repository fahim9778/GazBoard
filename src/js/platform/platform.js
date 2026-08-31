// Platform initialization module for GazBoard.
// Seamlessly activates the appropriate platform runtime (Electron or Web/PWA).

import { createWebAdapter, emitOpenFile } from './web-adapter.js';
import { registerSessionFile } from './web-files.js';

export function initPlatform() {
  if (typeof window === 'undefined') return;

  // 1. Electron Runtime Detection
  if (window.board && typeof window.board.info === 'function') {
    // Electron's preload script has already mounted window.board.
    return;
  }

  // 2. Browser / PWA Runtime Initialization
  window.board = createWebAdapter();

  // 3. Register Service Worker in Secure Contexts
  if ('serviceWorker' in navigator) {
    const isLocalhost = Boolean(
      window.location.hostname === 'localhost' ||
      window.location.hostname === '[::1]' ||
      window.location.hostname.match(/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/)
    );

    if (window.location.protocol === 'https:' || isLocalhost) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .then((reg) => {
            // Check for update on launch
            reg.update().catch(() => {});
          })
          .catch((err) => {
            console.warn('[pwa] Service Worker registration failed:', err);
          });
      });
    }
  }

  // 4. Global Drag & Drop handling for web browser
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;

    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (['gazboard', 'openboard', 'json'].includes(ext)) {
        try {
          const text = await f.text();
          const doc = JSON.parse(text);
          if (doc && (doc.objects || doc.id)) {
            emitOpenFile(doc);
            return;
          }
        } catch {}
      }
    }
  });
}

// Auto-run on import
initPlatform();
