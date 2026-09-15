// Android keeps the same renderer contract as preload.js. Files and large
// boards cross in bounded chunks, so imported pages never hit a message limit.
import { generatePdfFromHtml } from './web-pdf.js';

const FILE_ROOT = 'https://appassets.androidplatform.net/files/';
const CHUNK_BYTES = 96 * 1024;
const BLANK_HOLD_MS = 450;
const BLANK_PEN_HOLD_MS = 700;
const BLANK_HOLD_SLOP = 11;

export function createAndroidAdapter(native = window.GazBoardNative) {
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  const openQueue = [];
  let internalClipboardNewest = false;
  const emit = async (name, payload) => {
    const callbacks = listeners.get(name);
    if (!callbacks?.size) {
      if (name === 'open') openQueue.push(payload);
      return;
    }
    for (const cb of callbacks) {
      try { await cb(payload); } catch (e) { console.error('[android]', name, e); }
    }
  };
  const on = (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    if (name === 'open') for (const data of openQueue.splice(0)) emit(name, data);
  };
  const editableTarget = (target) => {
    if (!target) return false;
    const tag = String(target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
  };
  const hasBoardClipboard = () => Array.isArray(window.app?.clipboard) && window.app.clipboard.length > 0;
  const wireClipboardShortcuts = () => {
    window.addEventListener('keydown', (e) => {
      if (editableTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = String(e.key || '').toLowerCase();

      if (key === 'c' || key === 'x') {
        // Do not steal a system copy when GazBoard has nothing selected. When
        // objects are selected, stop WebView's native copy path and make the
        // board clipboard the newest thing instead.
        if (!window.app?.selected?.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        internalClipboardNewest = true;
        void emit('menu', key === 'c' ? 'edit.copy' : 'edit.cut');
        return;
      }

      // A touch-screen Copy goes straight through App rather than this adapter,
      // so the actual board clipboard is also authoritative here. A native
      // clipboard change clears it below, preserving "last copy wins".
      if (key === 'v' && (internalClipboardNewest || hasBoardClipboard())) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void emit('menu', 'edit.paste');
      }
      // Otherwise leave Ctrl/Cmd+V alone: WebView will deliver its ordinary
      // paste event and App will import the current OS text/image clipboard.
    }, true);
  };
  const wireBlankPasteHold = () => {
    let timer = null;
    let pointerId = null;
    let origin = null;
    let anchor = null;
    let pointerType = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pointerId = null;
      origin = null;
      anchor = null;
      pointerType = null;
    };

    window.addEventListener('pointerdown', (e) => {
      clear();
      const app = window.app;
      if ((e.pointerType !== 'touch' && e.pointerType !== 'pen') || e.button !== 0
          || !app?.surface || !hasBoardClipboard()) return;
      if (e.target !== app.surface.canvas) return;

      // This gesture belongs to genuinely blank board space. Holding an object
      // keeps the existing Android select/move gesture and its More menu.
      let wp;
      try { wp = app.surface.toWorld(e); } catch { return; }
      if (app.pickAt?.(wp)) return;

      pointerId = e.pointerId;
      pointerType = e.pointerType;
      origin = { x: e.clientX, y: e.clientY };
      anchor = { clientX: e.clientX, clientY: e.clientY };
      timer = setTimeout(() => {
        timer = null;
        const live = window.app;
        if (pointerId !== e.pointerId || !live?.surface || !hasBoardClipboard()) { clear(); return; }

        // Do not leave a dot of ink (or a half-started pan) underneath the menu.
        // Interaction owns the gesture, so let it roll the preview back cleanly.
        live.interaction?.cancelGesture?.();
        live.setSelection?.([]);
        live.showContextMenu?.({ ...anchor, pointerType });
        pointerId = null;
        origin = null;
        anchor = null;
        pointerType = null;
      }, e.pointerType === 'pen' ? BLANK_PEN_HOLD_MS : BLANK_HOLD_MS);
    }, true);

    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId || !origin) return;
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > BLANK_HOLD_SLOP) clear();
    }, true);
    window.addEventListener('pointerup', (e) => { if (e.pointerId === pointerId) clear(); }, true);
    window.addEventListener('pointercancel', (e) => { if (e.pointerId === pointerId) clear(); }, true);
  };
  const file = async (token, asJson = false) => {
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid native file reference');
    const response = await fetch(FILE_ROOT + token);
    if (!response.ok) throw new Error('The temporary file is no longer available');
    try { return await (asJson ? response.json() : response.arrayBuffer()); }
    finally { raw('blob:release', { token }).catch(() => {}); }
  };
  native.onmessage = async ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
      if (message.event) {
        const payload = message.resultFile ? await file(message.resultFile, true) : message.result;
        await emit(message.event, payload);
        if (message.event === 'flush') await raw('app:flushed', { ticket: payload?.ticket });
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else {
        try { request.resolve(message.resultFile ? await file(message.resultFile, true) : message.result); }
        catch (e) { request.reject(e); }
      }
    } catch (e) { console.error('[android] Invalid bridge reply', e); }
  };
  function raw(method, args = null, argsFile = null) {
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Android did not finish this operation. Please try again.'));
      }, 360000);
      pending.set(id, { resolve, reject, timer });
      try { native.postMessage(JSON.stringify({ id, method, args, argsFile })); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  async function upload(bytes) {
    const { token } = await raw('blob:begin', { size: bytes.byteLength });
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        let binary = '';
        for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
        await raw('blob:append', { token, offset, data: btoa(binary) });
      }
      await raw('blob:finish', { token });
      return token;
    } catch (e) { raw('blob:release', { token }).catch(() => {}); throw e; }
  }
  async function call(method, args = null) {
    const serialized = JSON.stringify(args);
    if (serialized.length < CHUNK_BYTES) return raw(method, args);
    const token = await upload(new TextEncoder().encode(serialized));
    try { return await raw(method, null, token); }
    finally { raw('blob:release', { token }).catch(() => {}); }
  }
  const guarded = async (method, args) => {
    try { return await call(method, args); }
    catch (e) { return { ok: false, error: e.message }; }
  };
  document.documentElement.dataset.platform = 'android';
  const adapter = {
    info: () => call('app:info'),
    readFile: async (p) => file((await call('fs:readFile', p)).token),
    fileOrigin: (p) => p,
    writeFile: async (filePath, data) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const token = await upload(bytes);
      try { return await call('fs:writeFile', { filePath, token }); }
      finally { raw('blob:release', { token }).catch(() => {}); }
    },
    openDialog: (opts) => call('dialog:open', opts),
    saveDialog: (opts) => call('dialog:save', opts),
    showItem: (p) => call('shell:showItem', p),
    openBoardsFolder: () => call('shell:openBoards'),
    openReleases: (url) => call('shell:openExternal', url),
    checkForUpdate: () => guarded('updates:check'),
    background: () => call('app:background'),
    boards: {
      list: () => call('boards:list'),
      load: (id) => call('boards:load', id),
      save: (board) => call('boards:save', board),
      remove: (id) => call('boards:delete', id),
      last: () => call('boards:last'),
      setLast: (id) => call('boards:setLast', id),
      resume: () => call('boards:resume'),
      migrate: () => call('boards:migrate')
    },
    assets: {
      put: (dataUrl) => call('assets:put', dataUrl),
      get: (id) => call('assets:get', id),
      have: (ids) => call('assets:have', ids)
    },
    sync: {
      state: () => call('sync:state'),
      start: () => call('sync:start'),
      stop: () => call('sync:stop'),
      setName: (name) => call('sync:setName', name),
      beginPairing: (opts) => call('sync:beginPairing', opts),
      cancelPairing: () => call('sync:cancelPairing'),
      pairWith: (peer, code) => guarded('sync:pairWith', { peer, code }),
      send: (peer, board) => guarded('sync:send', { peer, board }),
      addByAddress: (address) => guarded('sync:addByAddress', address),
      unpair: (deviceId) => call('sync:unpair', deviceId),
      stillPaired: (peer) => call('sync:stillPaired', peer),
      endSession: () => call('sync:endSession'),
      onPeers: (cb) => on('peers', cb),
      onReceiving: (cb) => on('receiving', cb),
      onIncoming: (cb) => on('incoming', cb),
      onSendProgress: (cb) => on('sendProgress', cb),
      answer: (ticket, outcome) => call('sync:answer', { ticket, outcome })
    },
    importToPdf: async (p) => {
      const result = await guarded('import:toPdf', p);
      if (!result.ok) return result;
      try { return { ...result, data: await file(result.token) }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    // The desktop's export already supplies one rendered bitmap per sheet.
    // Reuse the existing offline PDF writer without another rasterization.
    exportPdf: (payload) => generatePdfFromHtml(payload),
    onMenu: (cb) => on('menu', cb),
    onOpenFile: (cb) => { on('open', cb); call('app:ready').catch(() => {}); },
    onWindowResized: (cb) => { on('resize', cb); window.addEventListener('resize', cb); },
    onFlush: (cb) => {
      on('flush', cb);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') Promise.resolve(cb()).catch(() => {});
      });
    },
    convertReady: (msg) => call('convert:ready', msg),
    convertError: (msg) => call('convert:error', msg)
  };
  // A native clipboard change means something outside the board-object copy is
  // newer. Drop both the keyboard priority flag and the in-memory object copy;
  // this also makes touch Copy obey the same "last copy wins" rule.
  on('clipboardChanged', () => {
    internalClipboardNewest = false;
    if (Array.isArray(window.app?.clipboard)) window.app.clipboard = [];
  });
  wireClipboardShortcuts();
  wireBlankPasteHold();
  on('file', async (p) => {
    // Native share/open intents use the same document and image import paths
    // as the toolbar. Wait for App's initialization before dispatching them.
    window.dispatchEvent(new CustomEvent('gazboard:import-file', { detail: p }));
  });
  on('back', () => window.dispatchEvent(new CustomEvent('gazboard:back')));
  on('showBoards', () => window.app?.panels.boards());
  on('sharingStopped', () => {
    if (!window.app) return;
    window.app.settings.sync = false;
    window.app.saveSettings();
    window.app.panels.syncChanged();
  });
  return adapter;
}
