'use strict';
const { contextBridge, ipcRenderer, clipboard } = require('electron');
const crypto = require('crypto');

/*
 * GazBoard keeps object copies in its own in-memory clipboard. The renderer also
 * accepts ordinary text/images from the OS clipboard, so Cmd/Ctrl+V has to know
 * which one was copied most recently.
 *
 * Remember the OS clipboard's contents at the moment GazBoard copies/cuts an
 * object. If the OS clipboard is unchanged when Paste is pressed, the GazBoard
 * object copy is newer and wins. If another app changed the OS clipboard in the
 * meantime, leave Paste alone so the renderer's normal paste event can import
 * that text/image instead.
 */
let menuCallback = null;
let shortcutsWired = false;
let gazClipboardBaseline = null;
let lastDelivered = null;
const DUPLICATE_COMMAND_WINDOW = 150;

function editableTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

function systemClipboardSignature() {
  try {
    const formats = clipboard.availableFormats('clipboard').slice().sort();
    const text = clipboard.readText('clipboard');
    const image = clipboard.readImage('clipboard');
    let imageHash = '';
    if (image && !image.isEmpty()) {
      imageHash = crypto.createHash('sha256').update(image.toPNG()).digest('hex');
    }
    return JSON.stringify([formats, text, imageHash]);
  } catch {
    return null;
  }
}

function deliverMenu(id, source) {
  const now = Date.now();
  if (lastDelivered
      && lastDelivered.id === id
      && lastDelivered.source !== source
      && now - lastDelivered.at < DUPLICATE_COMMAND_WINDOW) {
    lastDelivered = { id, source, at: now };
    return false;
  }

  lastDelivered = { id, source, at: now };
  if (id === 'edit.copy' || id === 'edit.cut') {
    gazClipboardBaseline = systemClipboardSignature();
  }
  if (menuCallback) menuCallback(id);
  return true;
}

function internalPasteStillNewest() {
  if (gazClipboardBaseline === null) return false;
  const now = systemClipboardSignature();
  if (now !== null && now !== gazClipboardBaseline) {
    gazClipboardBaseline = null;
    return false;
  }
  return true;
}

function wireClipboardShortcuts() {
  if (shortcutsWired || typeof window === 'undefined') return;
  shortcutsWired = true;

  window.addEventListener('keydown', (e) => {
    if (!menuCallback || editableTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;

    const key = String(e.key || '').toLowerCase();
    let command = null;
    if (key === 'c') command = 'edit.copy';
    else if (key === 'x') command = 'edit.cut';
    else if (key === 'v' && internalPasteStillNewest()) command = 'edit.paste';
    else return; // ordinary OS clipboard paste is handled by the renderer

    e.preventDefault();
    e.stopImmediatePropagation();
    deliverMenu(command, 'keyboard');
  }, true);
}

contextBridge.exposeInMainWorld('board', {
  info: () => ipcRenderer.invoke('app:info'),

  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  // On the desktop the path names the file already; the web build has to work
  // one out from the File itself. See claimLocalBoard().
  fileOrigin: (p) => p,
  writeFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', { filePath, data }),
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openBoardsFolder: () => ipcRenderer.invoke('shell:openBoards'),
  openReleases: (url) => ipcRenderer.invoke('shell:openExternal', url),
  checkForUpdate: () => ipcRenderer.invoke('updates:check'),

  boards: {
    list: () => ipcRenderer.invoke('boards:list'),
    load: (id) => ipcRenderer.invoke('boards:load', id),
    save: (b) => ipcRenderer.invoke('boards:save', b),
    remove: (id) => ipcRenderer.invoke('boards:delete', id),
    last: () => ipcRenderer.invoke('boards:last'),
    setLast: (id) => ipcRenderer.invoke('boards:setLast', id),
    resume: () => ipcRenderer.invoke('boards:resume'),
    migrate: () => ipcRenderer.invoke('boards:migrate')
  },

  // Pictures and imported pages: stored once, by content, outside the board file.
  assets: {
    put: (dataUrl) => ipcRenderer.invoke('assets:put', dataUrl),
    get: (id) => ipcRenderer.invoke('assets:get', id),
    have: (ids) => ipcRenderer.invoke('assets:have', ids)
  },

  /*
   * LAN sync. Every call is inert until sync.start() has been made, so a build
   * whose owner never turns it on opens no socket and announces nothing.
   */
  sync: {
    state: () => ipcRenderer.invoke('sync:state'),
    start: () => ipcRenderer.invoke('sync:start'),
    stop: () => ipcRenderer.invoke('sync:stop'),
    setName: (name) => ipcRenderer.invoke('sync:setName', name),
    beginPairing: (opts) => ipcRenderer.invoke('sync:beginPairing', opts),
    cancelPairing: () => ipcRenderer.invoke('sync:cancelPairing'),
    pairWith: (peer, code) => ipcRenderer.invoke('sync:pairWith', { peer, code }),
    send: (peer, board) => ipcRenderer.invoke('sync:send', { peer, board }),
    addByAddress: (address) => ipcRenderer.invoke('sync:addByAddress', address),
    unpair: (deviceId) => ipcRenderer.invoke('sync:unpair', deviceId),
    stillPaired: (peer) => ipcRenderer.invoke('sync:stillPaired', peer),
    endSession: () => ipcRenderer.invoke('sync:endSession'),
    /*
     * Windows Firewall. `check` only reads and raises nothing; `repair` and
     * `remove` each raise one UAC prompt, so they are wired to buttons and to
     * nothing else. `commands` is the fallback for a machine where elevation
     * is refused outright - the text an administrator would need.
     */
    firewall: {
      check: () => ipcRenderer.invoke('sync:firewall:check'),
      repair: () => ipcRenderer.invoke('sync:firewall:repair'),
      remove: () => ipcRenderer.invoke('sync:firewall:remove'),
      commands: () => ipcRenderer.invoke('sync:firewall:commands')
    },
    // the device list changed underfoot
    onPeers: (fn) => ipcRenderer.on('sync:peers', (_e, peers) => fn(peers)),
    onReceiving: (fn) => ipcRenderer.on('sync:receiving', (_e, info) => fn(info)),
    // a board is at the door; answer with an outcome string, or null to decline
    onIncoming: (fn) => ipcRenderer.on('sync:incoming', (_e, msg) => fn(msg)),
    // bytes going out during a send, so a long transfer does not look hung
    onSendProgress: (fn) => ipcRenderer.on('sync:sendProgress', (_e, p) => fn(p)),
    // One channel, not one per question: a ticket that has already timed out
    // comes back as false rather than as a missing-handler error.
    answer: (ticket, outcome) => ipcRenderer.invoke('sync:answer', { ticket, outcome })
  },

  importToPdf: (filePath) => ipcRenderer.invoke('import:toPdf', filePath),
  exportPdf: (payload) => ipcRenderer.invoke('export:pdf', payload),

  onMenu: (cb) => {
    menuCallback = cb;
    wireClipboardShortcuts();
    ipcRenderer.on('menu:command', (_e, id) => {
      // An accelerator and the renderer key event can both report the same
      // keystroke. The short duplicate window makes one physical keypress one
      // GazBoard command, while still allowing repeated real presses.
      if (id === 'edit.paste' && !internalPasteStillNewest()) return;
      deliverMenu(id, 'menu');
    });
  },
  onOpenFile: (cb) => ipcRenderer.on('board:open', (_e, data) => cb(data)),
  onWindowResized: (cb) => ipcRenderer.on('window:resized', () => cb()),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => { await cb(); ipcRenderer.send('app:flushed'); }),

  // used only by the hidden conversion window
  convertReady: (msg) => ipcRenderer.send('convert:ready', msg),
  convertError: (msg) => ipcRenderer.send('convert:error', msg)
});
