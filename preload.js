'use strict';
const { contextBridge, ipcRenderer, clipboard, nativeImage, webUtils } = require('electron');
const crypto = require('node:crypto');

/**
 * A fingerprint of the machine's clipboard.
 *
 * Copying objects on a board cannot be written to the machine's clipboard - an
 * object is an id, a position and a group, none of which survive being turned
 * into text - so the board keeps its own copy. Paste then has to answer one
 * question: which was copied more recently, the objects or whatever is on the
 * machine's clipboard? Taking a fingerprint when the objects are copied
 * answers it exactly. Unchanged at paste time means nothing else has been
 * copied since, so the objects are what was meant.
 *
 * The picture is hashed properly rather than described by its size. Two
 * screenshots of the same window are the same size and different pictures, so
 * size alone would call the second one "no change" and quietly hand back the
 * board's older copy instead. The hash runs over the raw bitmap rather than a
 * PNG: same certainty, none of the compression work, and it only happens when
 * something is copied or pasted rather than on the way past.
 */
/*
 * The clipboard the test suite uses on somebody's own computer.
 *
 * The paste checks have to put real things on a clipboard - a line of text, a
 * link, a screenshot - and read them back. Putting them on the MACHINE's
 * clipboard was tidy on the face of it, because the suite put back whatever
 * had been there afterwards. But Windows keeps a history of everything that
 * was ever copied (Windows+V), and so do most clipboard managers: every run
 * left "typed into another window" and a made-up example.com link sitting in
 * that history, looking as if something had copied them behind the person's
 * back. Putting the clipboard back cannot take a line out of a history.
 *
 * So on a person's machine the suite gets a clipboard of its own, here in
 * memory, and the machine's is never touched. The build machines (CI) have no
 * history and nobody's work on them, so they still use the real one and the
 * checks keep testing the real thing. GAZBOARD_REAL_CLIPBOARD=1 does the same
 * locally for anyone who wants it. A normal launch is not affected at all:
 * without --smoke there is no stand-in.
 */
const SMOKE = process.argv.includes('--smoke');
const standIn = SMOKE && !process.env.CI && process.env.GAZBOARD_REAL_CLIPBOARD !== '1'
  ? { text: '', image: null, html: '' } : null;
const cb = standIn ? {
  availableFormats: () => [...(standIn.text ? ['text/plain'] : []), ...(standIn.image ? ['image/png'] : [])],
  readText: () => standIn.text,
  readImage: () => standIn.image || nativeImage.createEmpty(),
  readHTML: () => standIn.html,
  writeText: (t) => { standIn.text = String(t); standIn.image = null; standIn.html = ''; },
  writeImage: (img) => { standIn.image = img; standIn.text = ''; standIn.html = ''; },
  write: (d) => { standIn.text = d.text ? String(d.text) : ''; standIn.html = d.html ? String(d.html) : ''; standIn.image = d.image || null; },
  clear: () => { standIn.text = ''; standIn.image = null; standIn.html = ''; }
} : clipboard;

/**
 * Putting something ON the machine's clipboard because somebody asked to -
 * "Copy as picture" and "Copy text". Never called by an ordinary Ctrl+C,
 * which keeps objects inside the board and leaves the clipboard alone.
 *
 * Words go up as plain text and as formatted text at once, so Word keeps the
 * bold and the colours while a chat box takes the plain words.
 */
function clipboardWrite(payload) {
  try {
    const d = {};
    if (payload && payload.text) d.text = String(payload.text);
    if (payload && payload.html) d.html = String(payload.html);
    if (payload && payload.image) {
      const img = nativeImage.createFromDataURL(payload.image);
      if (!img || img.isEmpty()) return false;
      d.image = img;
    }
    if (!d.text && !d.html && !d.image) return false;
    cb.write(d);
    return true;
  } catch { return false; }
}

function clipboardSignature() {
  try {
    const formats = cb.availableFormats('clipboard').slice().sort().join('|');
    const text = cb.readText('clipboard');
    const image = cb.readImage('clipboard');
    let picture = '';
    if (image && !image.isEmpty()) {
      const { width, height } = image.getSize();
      picture = `${width}x${height}:` +
        crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
    }
    return `${formats}\u0000${text}\u0000${picture}`;
  } catch {
    return null;
  }
}

/**
 * What the machine's clipboard is holding, when somebody actually asks to
 * paste. Turning a picture into bytes is only worth doing at that moment -
 * never on the way past, which is what made hashing it on every keypress the
 * wrong shape for the question.
 */
function clipboardRead() {
  try {
    const image = cb.readImage('clipboard');
    let html = '';
    try { html = cb.readHTML('clipboard') || ''; } catch { html = ''; }
    return {
      text: cb.readText('clipboard') || '',
      html,
      image: image && !image.isEmpty() ? image.toDataURL() : null,
      signature: clipboardSignature()
    };
  } catch {
    return { text: '', image: null, signature: null };
  }
}

/**
 * Putting something ON the machine's clipboard - for the test suite, and for
 * nothing else.
 *
 * The board itself never writes to the machine's clipboard: copying objects on
 * a board must not throw away the address or the phone number somebody had
 * waiting there. But the test that PROVES that rule has to put real things on
 * the real clipboard first, and the browser's own clipboard API refuses point
 * blank from a window that is not the one in front - "Document is not
 * focused". A suite that opens a window and runs for minutes on a machine
 * somebody is still using loses the foreground constantly, so those writes
 * failed and took eight checks down with them on every run. Asking the window
 * back to the front does not help and should not: an app cannot steal focus
 * from whatever the person is actually doing.
 *
 * Electron's clipboard has no focus rule. It is the same clipboard the
 * fingerprint above is read from, so what lands there is exactly what the
 * board will see. Handed to the page only when the app was started with
 * --smoke, which a shipped build never is.
 */
function clipboardWriteForTests(payload) {
  try {
    /*
     * Putting the machine's clipboard BACK is as much a part of this as
     * putting things on it. The suite runs on a developer's own machine, and
     * a test that eats whatever they had copied - and leaves its own sample
     * text there to be pasted into something real later - is a test that
     * misbehaves. An empty clipboard is restored as empty, not as ''.
     */
    if (payload && payload.clear) { cb.clear(); return true; }
    if (payload && payload.image) {
      const img = nativeImage.createFromDataURL(payload.image);
      if (!img || img.isEmpty()) return false;
      cb.writeImage(img);
    } else if (payload && payload.html) {
      cb.write({ text: String(payload.text || ''), html: String(payload.html) });
    } else {
      cb.writeText(String((payload && payload.text) || ''));
    }
    return true;
  } catch { return false; }
}

contextBridge.exposeInMainWorld('board', {
  info: () => ipcRenderer.invoke('app:info'),
  clipboardSignature,
  clipboardRead,
  clipboardWrite,
  // The suite is written against the English wording, so a smoke run is in
  // English whatever language the machine it runs on is set to.
  ...(SMOKE ? { clipboardWriteForTests, clipboardHtmlForTests: () => { try { return cb.readHTML('clipboard') || ''; } catch { return ''; } }, smoke: true, clipboardIsStandIn: !!standIn } : {}),

  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  // On the desktop the path names the file already; the web build has to work
  // one out from the File itself. See claimLocalBoard().
  fileOrigin: (p) => p,
  /*
   * Where a dropped file lives on disk. Electron took File.path away in
   * version 32, so a file dragged in from Explorer or Finder only says where it
   * is when asked through webUtils. Without this, documents dropped on the
   * board were quietly ignored.
   */
  pathForFile: (file) => { try { return (webUtils && webUtils.getPathForFile(file)) || ''; } catch { return ''; } },
  writeFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', { filePath, data }),
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openBoardsFolder: () => ipcRenderer.invoke('shell:openBoards'),
  openReleases: (url) => ipcRenderer.invoke('shell:openExternal', url),
  checkForUpdate: () => ipcRenderer.invoke('updates:check'),
  // Download-and-install, for the builds that can update themselves (see updater.js).
  updates: {
    mode: () => ipcRenderer.invoke('updates:mode'),
    download: (version) => ipcRenderer.invoke('updates:download', version),
    install: (opts) => ipcRenderer.invoke('updates:install', opts || {}),
    note: () => ipcRenderer.invoke('updates:note'),
    onProgress: (cb) => ipcRenderer.on('updates:progress', (_e, p) => cb(p))
  },

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

  importToPdf: (filePath, opts) => ipcRenderer.invoke('import:toPdf', filePath, opts || {}),
  // this importer takes a fixed-up copy of a deck as bytes, and can be asked to use Microsoft Office
  importTakesBytes: true,
  exportPdf: (payload) => ipcRenderer.invoke('export:pdf', payload),

  onMenu: (cb) => ipcRenderer.on('menu:command', (_e, id) => cb(id)),
  // The native menu bar belongs to the main process, so it is told which
  // language to rebuild itself in.
  setLanguage: (code) => ipcRenderer.send('app:language', code),
  onOpenFile: (cb) => ipcRenderer.on('board:open', (_e, data) => cb(data)),
  onWindowResized: (cb) => ipcRenderer.on('window:resized', () => cb()),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => { await cb(); ipcRenderer.send('app:flushed'); }),

  // used only by the hidden conversion window
  convertReady: (msg) => ipcRenderer.send('convert:ready', msg),
  convertError: (msg) => ipcRenderer.send('convert:error', msg)
});
