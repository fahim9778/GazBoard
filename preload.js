'use strict';
const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');
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
function clipboardSignature() {
  try {
    const formats = clipboard.availableFormats('clipboard').slice().sort().join('|');
    const text = clipboard.readText('clipboard');
    const image = clipboard.readImage('clipboard');
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
    const image = clipboard.readImage('clipboard');
    return {
      text: clipboard.readText('clipboard') || '',
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
    if (payload && payload.clear) { clipboard.clear(); return true; }
    if (payload && payload.image) {
      const img = nativeImage.createFromDataURL(payload.image);
      if (!img || img.isEmpty()) return false;
      clipboard.writeImage(img);
    } else {
      clipboard.writeText(String((payload && payload.text) || ''));
    }
    return true;
  } catch { return false; }
}

contextBridge.exposeInMainWorld('board', {
  info: () => ipcRenderer.invoke('app:info'),
  clipboardSignature,
  clipboardRead,
  ...(process.argv.includes('--smoke') ? { clipboardWriteForTests } : {}),

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

  onMenu: (cb) => ipcRenderer.on('menu:command', (_e, id) => cb(id)),
  onOpenFile: (cb) => ipcRenderer.on('board:open', (_e, data) => cb(data)),
  onWindowResized: (cb) => ipcRenderer.on('window:resized', () => cb()),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => { await cb(); ipcRenderer.send('app:flushed'); }),

  // used only by the hidden conversion window
  convertReady: (msg) => ipcRenderer.send('convert:ready', msg),
  convertError: (msg) => ipcRenderer.send('convert:error', msg)
});
