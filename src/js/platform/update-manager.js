// Background update manager for the Web/PWA runtime.
// Automatically and safely discovers new deployments and coordinates atomic updates.

import { isNewer } from '../core/version.js';

let _currentVersion = '2.4.0';
let _updateAvailable = false;
let _waitingWorker = null;
let _updateListeners = new Set();
let _broadcast = null;

if (typeof BroadcastChannel !== 'undefined') {
  try {
    _broadcast = new BroadcastChannel('gazboard-updates');
    _broadcast.onmessage = (e) => {
      if (e.data?.type === 'UPDATE_AVAILABLE') {
        notifyUpdate(e.data.version);
      }
    };
  } catch {}
}

export function setAppVersion(v) {
  _currentVersion = v;
}

export function onUpdateAvailable(cb) {
  _updateListeners.add(cb);
  if (_updateAvailable) cb({ version: _updateAvailable, waiting: !!_waitingWorker });
  return () => _updateListeners.delete(cb);
}

function notifyUpdate(version) {
  _updateAvailable = version;
  for (const cb of _updateListeners) {
    try { cb({ version, waiting: !!_waitingWorker }); } catch {}
  }
}

/** Check whether a newer version has been deployed. */
export async function checkForUpdate(opts = {}) {
  if (!navigator.onLine) {
    return { ok: false, error: 'No connection' };
  }

  // 1. Trigger Service Worker update check
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        if (reg.waiting) {
          _waitingWorker = reg.waiting;
          notifyUpdate('latest');
        }
      }
    } catch (e) {
      console.warn('[update] SW update check failed:', e.message);
    }
  }

  // 2. Fetch version.json from origin (never cached)
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch('./version.json?t=' + Date.now(), {
      signal: ctl.signal,
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timer);

    if (!res.ok) return { ok: false, error: `Server replied ${res.status}` };
    const meta = await res.json();
    if (!meta || !meta.version) return { ok: false, error: 'Invalid version manifest' };

    const remoteVer = meta.version;
    const newer = isNewer(remoteVer, _currentVersion);

    if (newer) {
      _updateAvailable = remoteVer;
      notifyUpdate(remoteVer);
      if (_broadcast) {
        _broadcast.postMessage({ type: 'UPDATE_AVAILABLE', version: remoteVer });
      }
      return {
        ok: true,
        version: remoteVer,
        name: `GazBoard ${remoteVer}`,
        url: window.location.href,
        prerelease: false
      };
    }

    return {
      ok: true,
      version: _currentVersion,
      name: `GazBoard ${_currentVersion}`,
      url: window.location.href,
      prerelease: false
    };
  } catch (e) {
    return {
      ok: false,
      error: e.name === 'AbortError' ? 'The check timed out' : 'No connection'
    };
  }
}

/**
 * Apply the downloaded update atomically.
 * Tells the waiting Service Worker to skip waiting, then reloads once active.
 */
export async function applyUpdate() {
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    const worker = reg?.waiting || _waitingWorker;

    if (worker) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!reloaded) {
          reloaded = true;
          window.location.reload();
        }
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
  }

  // Fallback reload
  window.location.reload();
}

/** Initialize background update monitoring. */
export function initUpdateWatcher() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'UPDATE_READY') {
        notifyUpdate(event.data.version || 'latest');
      }
    });

    navigator.serviceWorker.ready.then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            _waitingWorker = newWorker;
            notifyUpdate('latest');
          }
        });
      });
    });
  }

  // Check periodically when online
  window.addEventListener('online', () => {
    setTimeout(() => checkForUpdate().catch(() => {}), 3000);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      checkForUpdate().catch(() => {});
    }
  });
}
