// Complete Web Platform Adapter implementing the `window.board` bridge.
// Provides 100% API parity with the Electron preload bridge using standard browser APIs.

import * as storage from './web-storage.js';
import * as files from './web-files.js';
import { generatePdfFromHtml } from './web-pdf.js';
import * as updater from './update-manager.js';

const APP_VERSION = '__APP_VERSION__';
updater.setAppVersion(APP_VERSION);

const _menuListeners = new Set();
const _openFileListeners = new Set();

export function createWebAdapter() {
  // Request persistent storage on startup
  storage.requestPersistentStorage().catch(() => {});

  // Initialize update monitoring
  updater.initUpdateWatcher();

  // Wire keyboard shortcuts for menu commands in browser
  window.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.metaKey || e.ctrlKey;
    if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      emitMenu('board.new');
    } else if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      emitMenu('board.open');
    } else if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      emitMenu('board.save');
    }
  });

  return {
    info: async () => {
      const chromeMatch = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
      return {
        version: APP_VERSION,
        platform: 'browser',
        electron: null,
        chrome: chromeMatch ? chromeMatch[1] : 'Web',
        libreoffice: false,
        userData: 'Browser Storage (IndexedDB)',
        smoke: false,
        isWeb: true,
        pwa: typeof window !== 'undefined' && (
          (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
          (typeof navigator !== 'undefined' && navigator.standalone === true)
        )
      };
    },

    readFile: (p) => files.readVirtualFile(p),
    fileOrigin: (p) => files.fileOrigin(p),
    writeFile: (filePath, data) => files.writeVirtualFile(filePath, data),
    openDialog: (opts) => files.openFileDialog(opts),
    saveDialog: (opts) => files.saveFileDialog(opts),
    showItem: (_p) => {
      console.log('[platform] Data stored in persistent browser IndexedDB');
    },
    openReleases: (url) => {
      window.open(url || 'https://github.com/fahim9778/GazBoard/releases', '_blank', 'noopener,noreferrer');
      return Promise.resolve(true);
    },
    checkForUpdate: () => updater.checkForUpdate(),

    boards: {
      list: () => storage.listBoards(),
      load: (id) => storage.loadBoard(id),
      save: (b) => storage.saveBoard(b),
      remove: (id) => storage.deleteBoard(id),
      last: () => storage.getLastBoard(),
      setLast: (id) => storage.setLastBoard(id),
      resume: () => storage.resumeBoard(),
      migrate: () => storage.migrateLegacyData()
    },

    assets: {
      put: (dataUrl) => storage.putAsset(dataUrl),
      get: (id) => storage.getAsset(id),
      have: (ids) => storage.haveAssets(ids)
    },

    importToPdf: async (filePath) => {
      try {
        const buf = await files.readVirtualFile(filePath);
        const name = String(filePath).split(/[\\/]/).pop() || 'document.pdf';
        const ext = name.split('.').pop().toLowerCase();

        if (ext === 'pdf') {
          return { ok: true, engine: 'native', data: buf, name };
        }

        // For other formats in web runtime, advise user
        return {
          ok: false,
          error: `Web runtime directly imports PDF and image files. For ${ext.toUpperCase()} documents, please export to PDF first.`
        };
      } catch (e) {
        return { ok: false, error: e.message || 'Could not import file' };
      }
    },

    exportPdf: (payload) => generatePdfFromHtml(payload),

    onMenu: (cb) => { _menuListeners.add(cb); },
    onOpenFile: (cb) => { _openFileListeners.add(cb); },
    onWindowResized: (cb) => {
      window.addEventListener('resize', () => cb());
      if (screen && screen.orientation) {
        screen.orientation.addEventListener('change', () => cb());
      }
    },
    onFlush: (cb) => {
      window.addEventListener('beforeunload', async () => {
        try { await cb(); } catch {}
      });
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
          try { await cb(); } catch {}
        }
      });
    },

    // Hidden window converter hooks (no-op in browser)
    convertReady: () => {},
    convertError: () => {}
  };
}

function emitMenu(id) {
  for (const cb of _menuListeners) {
    try { cb(id); } catch {}
  }
}

export function emitOpenFile(data) {
  for (const cb of _openFileListeners) {
    try { cb(data); } catch {}
  }
}
