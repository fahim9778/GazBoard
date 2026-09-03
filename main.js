'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

const SRC = path.join(__dirname, 'src');
const isDev = process.argv.includes('--dev');

// The one place the app knows about the internet, and it only looks.
const RELEASES_URL = 'https://github.com/fahim9778/GazBoard/releases';
// Overridable so the suite can serve a known reply from localhost and test the
// whole chain - fetch, parse, compare, decide - without depending on the
// network or on what happens to be released today.
const UPDATE_API = process.env.GAZBOARD_UPDATE_API
  || 'https://api.github.com/repos/fahim9778/GazBoard/releases/latest';

// Smoke runs use a throwaway profile so tests never see (or clobber) real boards.
// GAZBOARD_USER_DATA points the whole profile somewhere else and is kept between
// runs - the restart tests need two launches to share one profile, and it doubles
// as an explicit override for anyone who wants one.
/**
 * Where a portable build keeps its boards: a folder beside the .exe.
 *
 * electron-builder's portable target unpacks itself into a temp directory and
 * runs from there, so left alone it would write to the same per-user AppData
 * folder the installer uses - the stick would carry the program and leave the
 * work behind, and a portable copy would quietly share (and an uninstall could
 * delete) an installed copy's boards. PORTABLE_EXECUTABLE_DIR is the one thing
 * that survives the unpack: it is where the .exe the user double-clicked
 * actually lives.
 *
 * The folder is not merely checked for permission but written to, because a
 * write-protected stick, a CD, or a network share can all claim to be writable
 * and then refuse. If it cannot be written, this returns null and the app falls
 * back to the normal per-user folder rather than refusing to start.
 *
 * Exported for the test suite; there is no other reason for it to be public.
 */
function portableUserData(env = process.env) {
  const exeDir = env.PORTABLE_EXECUTABLE_DIR;
  if (!exeDir) return null;
  const beside = path.join(exeDir, 'GazBoard-Data');
  try {
    fs.mkdirSync(beside, { recursive: true });
    const probe = path.join(beside, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return beside;
  } catch {
    return null;                 // read-only stick, or unpacked into Program Files
  }
}
module.exports.portableUserData = portableUserData;

if (process.env.GAZBOARD_USER_DATA) {
  fs.mkdirSync(process.env.GAZBOARD_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.GAZBOARD_USER_DATA);
} else if (portableUserData()) {
  // ahead of --smoke on purpose: it is the only way the suite can watch a real
  // launch pick the folder beside the .exe, and a smoke run is never portable
  // unless a test deliberately makes it one
  app.setPath('userData', portableUserData());
} else if (process.argv.includes('--smoke')) {
  const tmp = path.join(os.tmpdir(), 'gazboard-smoke');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  app.setPath('userData', tmp);
}

/* ------------------------------------------------------------------ *
 *  app:// protocol  (lets the renderer use real ES modules + workers)
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } }
]);

function registerProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.normalize(path.join(SRC, rel));
    if (!target.startsWith(SRC)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

/* ------------------------------------------------------------------ *
 *  Board storage (local only - no accounts, no cloud)
 * ------------------------------------------------------------------ */
const dataDir = () => path.join(app.getPath('userData'), 'boards');
async function ensureDataDir() { await fsp.mkdir(dataDir(), { recursive: true }); }

// Which board was open last. This used to live in the renderer's localStorage,
// which Chromium flushes to disk lazily - so a machine that was restarted rather
// than shut down cleanly lost the pointer, the app opened a blank canvas, and
// every launch left another empty "Untitled board" behind. It looked exactly
// like the boards had been deleted. It is a plain file written by the main
// process now, so it is on disk the moment it is set.
const lastBoardFile = () => path.join(app.getPath('userData'), 'last-board.json');

/**
 * Write via a temp file and rename. Rename is atomic on Windows and POSIX, so a
 * power cut can leave the old file or the new one - never a half-written one.
 */
/* =================================================================== *
 *  The asset store
 *
 *  Pictures and imported pages used to be written inside the board file, as
 *  base64 text. A board carrying a few slides came to tens of megabytes, and
 *  every save rewrote all of it to record one new stroke - which is time spent
 *  on the thread that watches the pen.
 *
 *  They live in their own files now, named for a SHA-256 of their contents, and
 *  the board keeps only "asset:<name>". Identical pictures are stored once
 *  however many boards or pages use them, and a picture is only ever written
 *  the first time it is seen.
 *
 *  Nothing is ever deleted here. An orphaned file costs disk; a file deleted
 *  while a board still wanted it costs someone their work.
 * =================================================================== */
const assetsDir = () => path.join(app.getPath('userData'), 'assets');
const ASSET_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;   // nothing else is opened
const ASSET_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
};
const ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};

/** Split a data: URL into its media type and its bytes. Null if it is not one. */
function decodeDataUrl(url) {
  const m = /^data:([^;,]*)(;base64)?,/.exec(String(url || ''));
  if (!m) return null;
  const body = String(url).slice(m[0].length);
  try {
    return {
      mime: m[1] || 'application/octet-stream',
      buf: m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
    };
  } catch { return null; }
}

async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, text);
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    // rename across a lock (Windows AV, a synced folder) - fall back to a plain write
    await fsp.writeFile(file, text);
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function setLastBoard(id) {
  try { await writeAtomic(lastBoardFile(), JSON.stringify({ id, at: Date.now() })); } catch {}
}
async function getLastBoard() {
  try { return JSON.parse(await fsp.readFile(lastBoardFile(), 'utf8')).id || null; } catch { return null; }
}

// The app was called OpenBoard up to 1.12. Electron derives userData from the
// package name, so the rename would have stranded every board saved before it.
// On first run under the new name we copy the old folder across; the original is
// left untouched, so an older build still opens its own boards.
// Folders this app has used before, lower-cased. Electron derives the folder
// from productName, so every rename strands the previous one; this is the list
// of names to look for beside the current folder.
const LEGACY_PROFILE_NAMES = ['openboard'];

/**
 * Bring boards across from an earlier name of this app.
 *
 * Matching is done by listing the parent folder and comparing lower-cased, not
 * by guessing the exact spelling: the old folder was "OpenBoard" with capitals,
 * and a literal path only happened to match because Windows filesystems ignore
 * case. On Linux and macOS it would have missed silently, and the user's boards
 * would still be sitting there.
 *
 * Nothing is ever overwritten and the originals are left alone, so this is safe
 * to run on every launch - which it does, in case someone reinstalls the old
 * version, makes more boards, and comes back.
 */
async function migrateLegacyData() {
  try {
    const here = app.getPath('userData');
    const parent = path.dirname(here);
    const mine = path.basename(here).toLowerCase();

    let siblings = [];
    try { siblings = await fsp.readdir(parent, { withFileTypes: true }); } catch { return; }

    let moved = 0, from = [];
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      if (name === mine || !LEGACY_PROFILE_NAMES.includes(name)) continue;

      const src = path.join(parent, entry.name, 'boards');
      if (!fs.existsSync(src)) continue;
      const to = dataDir();
      await fsp.mkdir(to, { recursive: true });
      for (const f of await fsp.readdir(src)) {
        if (!f.endsWith('.json')) continue;
        const dest = path.join(to, f);
        if (fs.existsSync(dest)) continue;              // never overwrite newer work
        await fsp.copyFile(path.join(src, f), dest);
        moved++;
      }
      if (moved) from.push(entry.name);
    }
    if (moved) console.log(`carried ${moved} board(s) over from ${from.join(', ')}`);
    return { moved, from };
  } catch (e) {
    console.warn('legacy board migration skipped:', e.message);
    return { moved: 0, from: [] };
  }
}

/* ------------------------------------------------------------------ *
 *  Windows
 * ------------------------------------------------------------------ */
let mainWindow = null;
let pendingOpen = null;
/*
 * Sticky, unlike pendingOpen, which is cleared the moment the file is handed to
 * the window. The renderer asks whether a file was double-clicked so it knows
 * not to reopen its own last board on top - and it may ask before or after the
 * hand-off. A flag that goes false halfway through would just move the race
 * rather than settle it.
 */
let openedFromFile = false;
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const area = screen.getDisplayMatching(s).workArea;      // ignore a monitor that is gone
    const visible = s.x + s.width > area.x && s.x < area.x + area.width &&
                    s.y + s.height > area.y && s.y < area.y + area.height;
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch { return null; }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.isMaximized() || mainWindow.isFullScreen() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: mainWindow.isMaximized() }));
  } catch { /* not worth bothering the user about */ }
}          // .gazboard file passed on the command line

function boardFileFromArgv(argv) {
  return argv.slice(1).find((a) => /\.(gazboard|openboard|json)$/i.test(a) && fs.existsSync(a)) || null;
}

async function openBoardPath(filePath) {
  if (!filePath) return;
  try {
    const data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    // Which file this is, not just what is in it. An exported board keeps the
    // id of the board it came from, so two different files can carry the same
    // id; the renderer needs the path to tell them apart. See claimLocalBoard().
    data.origin = filePath;
    openedFromFile = true;
    if (mainWindow && !mainWindow.isDestroyed()) send('board:open', data);
    else pendingOpen = data;
  } catch (e) {
    dialog.showErrorBox('Could not open board', `${filePath}\n\n${e.message}`);
  }
}

function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1440, height: saved?.height ?? 900,
    x: saved?.x, y: saved?.y,
    // Small enough to snap beside another window. Windows Snap works in
    // LOGICAL pixels, so on a 1920-wide screen at 150% scaling half the desktop
    // is only 640 logical px - a 900px minimum silently refuses to fit there and
    // the window ends up overlapping whatever it was meant to sit next to.
    minWidth: 460, minHeight: 480,
    backgroundColor: '#f3f2f1',
    title: 'GazBoard',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(SRC, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  });
  Menu.setApplicationMenu(buildMenu());
  mainWindow.loadURL('app://board/index.html');
  mainWindow.once('ready-to-show', () => {
    if (saved?.maximized) mainWindow.maximize();
    mainWindow.show();
    send('window:resized');
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingOpen) { send('board:open', pendingOpen); pendingOpen = null; }
    send('window:resized');
  });

  // Belt and braces for the canvas: tell the renderer to re-measure on every
  // window geometry change, including the ones that fire no DOM resize event.
  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'move'])
    mainWindow.on(ev, () => send('window:resized'));
  screen.on('display-metrics-changed', () => send('window:resized'));

  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
      if (/cert_verify|ssl_client/.test(message)) return;
      console.log(`[renderer] ${message}${src ? ' (' + String(src).split('/').pop() + ':' + line + ')' : ''}`);
    });
    mainWindow.webContents.once('did-finish-load', async () => {
      try { await require(process.env.GAZBOARD_TEST || './test/smoke.js').run(mainWindow, app); }
      catch (e) { console.error('SMOKE FAILED:', e); app.exit(1); }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function send(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const cmd = (id) => () => send('menu:command', id);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New board', accelerator: 'CmdOrCtrl+N', click: cmd('board.new') },
        { label: 'Open board…', accelerator: 'CmdOrCtrl+O', click: cmd('board.open') },
        { label: 'Save a copy…', accelerator: 'CmdOrCtrl+S', click: cmd('board.save') },
        { type: 'separator' },
        { label: 'Insert image…', click: cmd('insert.image') },
        { label: 'Insert document (Word / PowerPoint / PDF)…', click: cmd('insert.document') },
        { type: 'separator' },
        { label: 'Export as PNG…', click: cmd('export.png') },
        { label: 'Export as PDF…', click: cmd('export.pdf') },
        { label: 'Export as SVG…', click: cmd('export.svg') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('edit.undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: cmd('edit.redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: cmd('edit.cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: cmd('edit.copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: cmd('edit.paste') },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: cmd('edit.duplicate') },
        { label: 'Delete', click: cmd('edit.delete') },
        { type: 'separator' },
        { label: 'Select all', accelerator: 'CmdOrCtrl+A', click: cmd('edit.selectAll') },
        { label: 'Clear canvas', click: cmd('edit.clear') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: cmd('view.zoomIn') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: cmd('view.zoomOut') },
        { label: 'Reset zoom', accelerator: 'CmdOrCtrl+0', click: cmd('view.zoomReset') },
        { label: 'Fit to board', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('view.fit') },
        { type: 'separator' },
        { label: 'Format background…', click: cmd('view.background') },
        { label: 'Toggle ruler', accelerator: 'CmdOrCtrl+R', click: cmd('view.ruler') },
        { type: 'separator' },
        { label: 'Full screen', accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11', role: 'togglefullscreen' },
        { label: 'Maximise window', click: () => { if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } },
        { role: 'toggleDevTools' }
      ]
    },
    { label: 'Help', submenu: [ { label: 'Keyboard shortcuts', click: cmd('help.shortcuts') }, { label: 'About GazBoard', click: cmd('help.about') } ] }
  ];
  return Menu.buildFromTemplate(template);
}

/* ------------------------------------------------------------------ *
 *  LibreOffice discovery (best-fidelity Office conversion path)
 * ------------------------------------------------------------------ */
function sofficeCandidates() {
  const p = process.platform;
  if (p === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice'];
  if (p === 'win32') return [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.exe')
  ];
  return ['/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/usr/bin/libreoffice'];
}
let _soffice; // undefined = not probed, null = absent
function findSoffice() {
  if (process.env.GAZBOARD_DISABLE_LIBREOFFICE === '1') return null;
  if (_soffice !== undefined) return _soffice;
  _soffice = sofficeCandidates().find((c) => { try { return c && fs.existsSync(c); } catch { return false; } }) || null;
  return _soffice;
}

function runSoffice(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('LibreOffice timed out')); }, 120000);
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err || ('exit ' + code))); });
  });
}

async function convertWithSoffice(filePath) {
  const bin = findSoffice();
  if (!bin) return null;
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'gazboard-'));
  const profile = pathToFileURL(path.join(out, 'profile')).toString();
  try {
    await runSoffice(bin, ['--headless', '--norestore', '--invisible', `-env:UserInstallation=${profile}`,
      '--convert-to', 'pdf:writer_pdf_Export', '--outdir', out, filePath], out);
    const pdf = (await fsp.readdir(out)).find((f) => f.toLowerCase().endsWith('.pdf'));
    if (!pdf) return null;
    const buf = await fsp.readFile(path.join(out, pdf));
    return buf;
  } catch (e) {
    console.warn('[import] LibreOffice conversion failed:', e.message);
    return null;
  } finally {
    fsp.rm(out, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 *  Fallback conversion: hidden window renders the file to HTML
 *  (mammoth for .docx, built-in OOXML reader for .pptx) then printToPDF
 * ------------------------------------------------------------------ */
function convertWithHiddenWindow(filePath, kind) {
  return new Promise((resolve, reject) => {
    const token = 'cv' + Date.now() + Math.random().toString(36).slice(2);
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: false }
    });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; ipcMain.removeListener('convert:ready', onReady); ipcMain.removeListener('convert:error', onError); try { win.destroy(); } catch {} fn(v); };
    const onReady = async (_e, msg) => {
      if (msg.token !== token) return;
      try {
        const pdf = await win.webContents.printToPDF({
          printBackground: true, margins: { marginType: 'none' },
          // Electron's printToPDF takes a custom page size in INCHES
          pageSize: { width: msg.widthMm / 25.4, height: msg.heightMm / 25.4 }
        });
        done(resolve, pdf);
      } catch (e) { done(reject, e); }
    };
    const onError = (_e, msg) => { if (msg.token === token) done(reject, new Error(msg.message)); };
    ipcMain.on('convert:ready', onReady);
    ipcMain.on('convert:error', onError);
    setTimeout(() => done(reject, new Error('Conversion timed out')), 120000);
    const q = new URLSearchParams({ token, kind, file: filePath });
    win.loadURL('app://board/convert.html?' + q.toString());
  });
}

/* ------------------------------------------------------------------ *
 *  Exporting the board to PDF
 *
 *  The renderer builds one HTML page per sheet (each holding a bitmap of
 *  that sheet, rendered by the same canvas renderer that draws the board,
 *  so what you print is exactly what you saw). We load it in a hidden
 *  window and let Chromium print it at the requested paper size.
 * ------------------------------------------------------------------ */
function printHtmlToPdf(html, { widthIn, heightIn, landscape = false }) {
  return new Promise(async (resolve, reject) => {
    let dir = null, win = null;
    const cleanup = () => {
      try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
      if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('PDF export timed out')); }, 180000);
    try {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gazboard-pdf-'));
      const file = path.join(dir, 'sheet.html');
      await fsp.writeFile(file, html, 'utf8');
      win = new BrowserWindow({
        show: false, width: 1200, height: 900,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: false }
      });
      await win.loadURL(pathToFileURL(file).toString());
      // give the embedded bitmaps a moment to decode before printing
      await win.webContents.executeJavaScript(
        'new Promise(r => { const go = () => requestAnimationFrame(() => requestAnimationFrame(r));' +
        ' if (document.fonts && document.fonts.ready) document.fonts.ready.then(go); else go(); })', true);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        margins: { marginType: 'none' },
        landscape: false,          // the page size below is already oriented
        pageSize: { width: widthIn, height: heightIn }   // Electron wants INCHES
      });
      clearTimeout(timer);
      cleanup();
      resolve(pdf);
    } catch (e) {
      clearTimeout(timer);
      cleanup();
      reject(e);
    }
  });
}

/* ------------------------------------------------------------------ *
 *  IPC
 * ------------------------------------------------------------------ */
function ipc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform,
    electron: process.versions.electron, chrome: process.versions.chrome,
    libreoffice: !!findSoffice(), userData: app.getPath('userData'),
    // the suite drives the app headlessly; it must never be stopped by a
    // consent dialog, and it must never reach the network
    smoke: process.argv.includes('--smoke'),
    // A .gazboard was double-clicked: the renderer must not open anything of
    // its own choosing, or its guess will land on top of what was asked for.
    // Answered from the main process because it knows before the window exists,
    // which is the only way to settle this without a race.
    pendingBoardFile: openedFromFile
  }));

  ipcMain.handle('fs:readFile', async (_e, p) => { const b = await fsp.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });

  ipcMain.handle('dialog:open', async (_e, opts) => {
    const r = await dialog.showOpenDialog(mainWindow, opts || {});
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:save', async (_e, opts) => {
    const r = await dialog.showSaveDialog(mainWindow, opts || {});
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('fs:writeFile', async (_e, { filePath, data }) => {
    await fsp.writeFile(filePath, Buffer.from(data));
    return true;
  });

  ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    // only ever our own releases page - never an arbitrary URL from the board
    if (typeof url !== 'string' || !url.startsWith(RELEASES_URL)) return false;
    await shell.openExternal(url);
    return true;
  });

  /**
   * Ask GitHub what the newest release is.
   *
   * The only network call the app ever makes, and it happens solely because
   * the user said yes to it. Nothing is sent: no board data, no identifier,
   * not even a query string - it is a plain GET of a public endpoint, and
   * GitHub sees what any web request shows it. The answer is a version string
   * and a URL; deciding what to do with them belongs to the renderer.
   */
  ipcMain.handle('updates:check', async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const endpoint = process.env.GAZBOARD_UPDATE_API || UPDATE_API;
      const res = await net.fetch(endpoint, {
        signal: ctl.signal,
        headers: { 'User-Agent': `GazBoard/${app.getVersion()}`, Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) return { ok: false, error: `GitHub replied ${res.status}` };
      const j = await res.json();
      if (!j || typeof j.tag_name !== 'string') return { ok: false, error: 'Unexpected reply from GitHub' };
      return {
        ok: true,
        version: j.tag_name.replace(/^v/i, ''),
        name: typeof j.name === 'string' ? j.name : j.tag_name,
        url: RELEASES_URL + '/tag/' + encodeURIComponent(j.tag_name),
        prerelease: !!j.prerelease
      };
    } catch (e) {
      // offline, blocked, rate-limited or timed out - all the same to the caller
      return { ok: false, error: e.name === 'AbortError' ? 'The check timed out' : 'No connection' };
    } finally {
      clearTimeout(timer);
    }
  });

  /* --- board persistence --- */
  ipcMain.handle('boards:list', async () => {
    await ensureDataDir();
    const files = (await fsp.readdir(dataDir())).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const st = await fsp.stat(path.join(dataDir(), f));
        const raw = JSON.parse(await fsp.readFile(path.join(dataDir(), f), 'utf8'));
        out.push({ id: raw.id || path.basename(f, '.json'), name: raw.name || 'Untitled board', modified: st.mtimeMs, objects: (raw.objects || []).length, thumb: raw.thumb || null, origin: raw.origin || null });
      } catch {}
    }
    return out.sort((a, b) => b.modified - a.modified);
  });
  ipcMain.handle('boards:load', async (_e, id) => {
    await ensureDataDir();
    try { return JSON.parse(await fsp.readFile(path.join(dataDir(), id + '.json'), 'utf8')); } catch { return null; }
  });
  ipcMain.handle('boards:save', async (_e, payload) => {
    await ensureDataDir();
    // The renderer sends { id, json }. An older shape - the board object itself -
    // is still accepted so nothing breaks if the two sides are ever out of step.
    const board = (payload && typeof payload.json === 'string')
      ? { id: payload.id, json: payload.json }
      : { id: payload.id, json: JSON.stringify(payload) };
    // the board and the "last open" pointer are two separate files; there is no
    // ordering between them, so they go out together rather than one after the
    // other
    await Promise.all([
      writeAtomic(path.join(dataDir(), board.id + '.json'), board.json),
      setLastBoard(board.id)
    ]);
    return true;
  });
  /**
   * Store one picture and return the name the board should remember. Returns
   * null if it cannot - the caller then keeps the picture inline, exactly as
   * before, so a failure here can never lose an image.
   */
  ipcMain.handle('assets:put', async (_e, dataUrl) => {
    try {
      const d = decodeDataUrl(dataUrl);
      if (!d || !d.buf.length) return null;
      const ext = ASSET_EXT[d.mime] || 'bin';
      const id = crypto.createHash('sha256').update(d.buf).digest('hex') + '.' + ext;
      await fsp.mkdir(assetsDir(), { recursive: true });
      const file = path.join(assetsDir(), id);
      // already stored: the name IS the contents, so there is nothing to do
      try { await fsp.access(file); return { id }; } catch { /* first time */ }
      await writeAtomic(file, d.buf);
      return { id };
    } catch { return null; }
  });

  /** Read one picture back as a data: URL. Null when it is not there. */
  ipcMain.handle('assets:get', async (_e, id) => {
    if (!ASSET_NAME.test(String(id || ''))) return null;
    try {
      const buf = await fsp.readFile(path.join(assetsDir(), id));
      const mime = ASSET_MIME[String(id).split('.').pop()] || 'application/octet-stream';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch { return null; }
  });

  /** Which of these are already stored. Used to avoid sending bytes needlessly. */
  ipcMain.handle('assets:have', async (_e, ids) => {
    const out = {};
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!ASSET_NAME.test(String(id || ''))) { out[id] = false; continue; }
      try { await fsp.access(path.join(assetsDir(), id)); out[id] = true; } catch { out[id] = false; }
    }
    return out;
  });

  ipcMain.handle('boards:last', () => getLastBoard());
  // idempotent, and safe to call any time: it only ever copies files that are missing
  ipcMain.handle('boards:migrate', () => migrateLegacyData());
  ipcMain.handle('boards:setLast', (_e, id) => setLastBoard(id));

  /**
   * The board to open on launch: the one that was last open, or failing that
   * the most recently touched one. Falling back to a blank canvas while the
   * user's work sits on disk is the one thing this must never do.
   */
  ipcMain.handle('boards:resume', async () => {
    await ensureDataDir();
    const read = async (id) => {
      try { return JSON.parse(await fsp.readFile(path.join(dataDir(), id + '.json'), 'utf8')); } catch { return null; }
    };
    const wanted = await getLastBoard();
    if (wanted) {
      const doc = await read(wanted);
      if (doc) return { board: doc, reason: 'pointer' };
    }
    // pointer missing or stale - fall back to the newest board that has anything in it
    const files = (await fsp.readdir(dataDir())).filter((f) => f.endsWith('.json'));
    const stats = [];
    for (const f of files) {
      try {
        const st = await fsp.stat(path.join(dataDir(), f));
        stats.push({ id: path.basename(f, '.json'), mtime: st.mtimeMs });
      } catch {}
    }
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const c of stats) {
      const doc = await read(c.id);
      if (doc && (doc.objects || []).length) return { board: doc, reason: 'newest' };
    }
    for (const c of stats) {                     // nothing with content: take the newest empty one
      const doc = await read(c.id);
      if (doc) return { board: doc, reason: 'empty' };
    }
    return { board: null, reason: 'none' };
  });
  ipcMain.handle('boards:delete', async (_e, id) => {
    let ok = false;
    try { await fsp.unlink(path.join(dataDir(), id + '.json')); ok = true; } catch { ok = false; }
    // The "last open" pointer must not go on naming a board that no longer
    // exists, or the next launch spends its first moments trying to open a
    // deleted file before falling back.
    try { if (await getLastBoard() === id) await setLastBoard(null); } catch {}
    return ok;
  });

  /* --- document import: anything -> PDF bytes --- */
  ipcMain.handle('export:pdf', async (_e, { html, widthIn, heightIn }) => {
    try {
      const pdf = await printHtmlToPdf(html, { widthIn, heightIn });
      return { ok: true, data: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) };
    } catch (e) {
      console.warn('[export] PDF failed:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('import:toPdf', async (_e, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const b = await fsp.readFile(filePath);
      return { ok: true, engine: 'native', data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name: path.basename(filePath) };
    }
    const office = ['.doc', '.docx', '.rtf', '.odt', '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods', '.txt'];
    if (!office.includes(ext)) return { ok: false, error: 'Unsupported file type: ' + ext };

    const viaOffice = await convertWithSoffice(filePath);
    if (viaOffice) return { ok: true, engine: 'libreoffice', data: viaOffice.buffer.slice(viaOffice.byteOffset, viaOffice.byteOffset + viaOffice.byteLength), name: path.basename(filePath) };

    const kind = ['.docx', '.doc', '.odt', '.rtf', '.txt'].includes(ext) ? 'word'
      : ['.pptx', '.ppt', '.odp'].includes(ext) ? 'slides' : null;
    if (!kind) return { ok: false, error: 'Install LibreOffice to import ' + ext + ' files.' };
    if (ext === '.doc' || ext === '.ppt' || ext === '.odt' || ext === '.odp')
      return { ok: false, error: 'Legacy/ODF formats need LibreOffice installed. Save as .docx / .pptx and try again.' };
    try {
      const pdf = await convertWithHiddenWindow(filePath, kind);
      return { ok: true, engine: 'builtin', data: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength), name: path.basename(filePath) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

/* ------------------------------------------------------------------ */
// One window owns the app; a second launch (or a double-clicked .gazboard
// file) hands its argument to the running instance instead.
const singleInstance = process.argv.includes('--smoke') ? true : app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    openBoardPath(boardFileFromArgv(argv));
  });

  app.on('open-file', (e, filePath) => { e.preventDefault(); openBoardPath(filePath); });   // macOS

  app.whenReady().then(async () => {
    registerProtocol();
    ipc();
    await migrateLegacyData();
    await openBoardPath(boardFileFromArgv(process.argv));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
/**
 * Give the renderer a moment to write out anything the autosave debounce is
 * still holding, before the process goes away. Bounded, because a quit that
 * hangs is worse than losing the last half-second.
 */
let flushed = false;
app.on('before-quit', (e) => {
  if (flushed || !mainWindow || mainWindow.isDestroyed()) return;
  e.preventDefault();
  const finish = () => { if (flushed) return; flushed = true; app.quit(); };
  const timer = setTimeout(finish, 2000);
  ipcMain.once('app:flushed', () => { clearTimeout(timer); finish(); });
  try { mainWindow.webContents.send('app:flush'); } catch { clearTimeout(timer); finish(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
