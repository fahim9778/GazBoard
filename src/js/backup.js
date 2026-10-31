// "Back up all my boards" and "Restore from a backup".
//
// One ZIP holds every board on this device, each as an ordinary .gazboard file
// with its pictures inside it, and a small gazboard-backup.json that lists them
// and carries the My boards folders they were filed in. Because the boards are
// plain .gazboard files, unzipping a backup by hand still gets every board
// back - the backup never depends on GazBoard being able to read it.
//
// Restoring only ever ADDS. A board that is already here exactly as it is in
// the backup is left alone; one that is here but different is kept, and the
// backup's copy arrives beside it as a second board. Nothing on this device is
// ever written over, so restoring the wrong backup - or the same one twice -
// cannot cost anybody their work.

import { exportable, safeName } from './export.js';
import { uid } from './core/util.js';
import { t } from './i18n.js';
import { h } from './ui/popover.js';
import { icon } from './ui/icons.js';

export const MANIFEST = 'gazboard-backup.json';
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;
// A backup this big is not one GazBoard made; refuse it rather than freeze trying.
const MAX_BOARDS = 5000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

let zipLibrary;
export async function loadZip() {
  if (window.JSZip) return window.JSZip;
  if (!zipLibrary) zipLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => { script.remove(); zipLibrary = null; reject(new Error(t('Could not load the ZIP exporter'))); };
    document.head.appendChild(script);
  });
  return zipLibrary;
}

/**
 * A toast that stays while work goes on, says how far it has got, and can
 * offer Cancel. Nothing modal: the board stays usable underneath it.
 */
export function progressToast(text, { onCancel } = {}) {
  const host = document.getElementById('toasts');
  const label = h('span', {}, text);
  const bar = h('span', { class: 'toast-progress' }, h('span', { style: 'width:0%' }));
  const el = h('div', { class: 'toast toast-busy', role: 'status' },
    h('span', { html: icon('doc', 16), style: 'display:flex' }),
    h('span', { style: 'display:flex;flex-direction:column;gap:4px;min-width:160px' }, label, bar));
  if (onCancel) {
    const b = h('button', { class: 'toast-action' }, t('Cancel'));
    b.addEventListener('click', () => onCancel());
    el.appendChild(b);
  }
  host?.appendChild(el);
  return {
    el,
    set(msg, share) {
      if (msg != null) label.textContent = msg;
      if (share != null) bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, share)) * 100) + '%';
    },
    done() { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }
  };
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Every board, its pictures and its folders, in one ZIP.
 * @returns {Promise<{path:string, boards:number}|null>} null when the save was cancelled
 */
export async function backupAllBoards(app, { pathFor } = {}) {
  app.commitTextEdit?.();
  // what is on screen goes in as it is now, not as it was at the last autosave
  try { await app.persist?.({ force: false }); } catch { /* the stored copy still goes in */ }
  const list = ((await window.board.boards.list()) || []).filter((b) => b && b.id);
  const openId = app.store.doc.id;
  const openListed = list.some((b) => b.id === openId);
  const ids = list.map((b) => b.id);
  if (!openListed && app.store.objects.length) ids.unshift(openId);
  if (!ids.length) { app.toast(t('There are no boards to back up yet'), 'help'); return null; }

  const path = pathFor ? await pathFor() : await window.board.saveDialog({
    title: t('Back up all my boards'),
    defaultPath: `GazBoard backup ${today()}.zip`,
    filters: [{ name: t('ZIP archive'), extensions: ['zip'] }]
  });
  if (!path) return null;

  let cancelled = false;
  const toast = progressToast(t('Backing up {done} of {total}…', { done: 0, total: ids.length }),
    { onCancel: () => { cancelled = true; } });
  try {
    const Zip = await loadZip();
    const zip = new Zip();
    const names = new Set();
    const entries = [];
    let skipped = 0;
    for (let i = 0; i < ids.length; i++) {
      if (cancelled) { app.toast(t('Backup cancelled'), 'help'); return null; }
      const id = ids[i];
      let source = null;
      try {
        source = id === openId ? structuredClone(app.store.toJSON()) : await window.board.boards.load(id);
      } catch { source = null; }
      if (!source) { skipped++; continue; }
      let doc = source;
      try { doc = await app.resolveAssets(source); } catch { doc = source; }
      const base = safeName(doc.name);
      let name = base + '.gazboard', n = 2;
      while (names.has(name.toLowerCase())) name = `${base} (${n++}).gazboard`;
      names.add(name.toLowerCase());
      zip.file('boards/' + name, JSON.stringify(exportable(doc)));
      entries.push({ id: doc.id, name: doc.name || '', file: 'boards/' + name, modified: doc.modified || 0 });
      toast.set(t('Backing up {done} of {total}…', { done: i + 1, total: ids.length }), (i + 1) / ids.length * 0.8);
      // let the pen and the screen have a turn between boards
      await new Promise((r) => setTimeout(r, 0));
    }
    const s = app.settings;
    zip.file(MANIFEST, JSON.stringify({
      app: 'GazBoard', kind: 'backup', version: 1, created: new Date().toISOString(),
      boards: entries,
      folders: Array.isArray(s.folders) ? s.folders : [],
      boardFolders: s.boardFolders && typeof s.boardFolders === 'object' ? s.boardFolders : {}
    }, null, 1));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 3 } },
      (m) => toast.set(null, 0.8 + (m.percent / 100) * 0.2));
    if (cancelled) { app.toast(t('Backup cancelled'), 'help'); return null; }
    await window.board.writeFile(path, bytes);
    const file = String(path).split(/[\\/]/).pop();
    app.toast(skipped
      ? t('Backed up {n} boards to {file}. {skipped} could not be read.', { n: entries.length, file, skipped })
      : entries.length === 1 ? t('Backed up 1 board to {file}', { file }) : t('Backed up {n} boards to {file}', { n: entries.length, file }),
    skipped ? 'help' : 'check', 5000);
    return { path, boards: entries.length };
  } finally { toast.done(); }
}

/** What is on a board, leaving out how it happens to be stored, so the same drawing compares equal. */
function drawingOf(d) {
  try {
    return JSON.stringify({ o: Array.isArray(d.objects) ? d.objects : Object.values(d.objects || {}), p: d.pages || [] },
      (k, v) => (k === 'src' || k === 'assetId' || k === 'missing' || k === 'thumb' ? undefined : v));
  } catch { return null; }
}

/** One board file from a backup, made safe to keep, or null if it is not a board. */
function boardFrom(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(data.objects) && !(data.objects && typeof data.objects === 'object')) return null;
  if (Array.isArray(data.objects)) data.objects = data.objects.filter((o) => o && typeof o === 'object' && typeof o.id === 'string');
  delete data.origin;                              // where it was opened from on another machine: not ours
  if (typeof data.name !== 'string') data.name = t('Untitled board');
  return data;
}

/**
 * Read a backup (or any ZIP of .gazboard files) and add its boards here.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{added:number, same:number, beside:number, bad:number}>}
 */
export async function restoreBackupBytes(app, bytes, { onProgress } = {}) {
  const Zip = await loadZip();
  let zip;
  try { zip = await Zip.loadAsync(bytes); } catch { throw new Error(t('That file is not a GazBoard backup')); }
  const files = Object.values(zip.files).filter((f) => !f.dir && /\.(gazboard|json)$/i.test(f.name) && f.name !== MANIFEST
    && !/(^|\/)(__MACOSX|\.)/.test(f.name));
  let manifest = null;
  if (zip.files[MANIFEST]) {
    try { manifest = JSON.parse(await zip.files[MANIFEST].async('string')); } catch { manifest = null; }
    if (manifest && (manifest.app !== 'GazBoard' || manifest.kind !== 'backup')) manifest = null;
  }
  const boardFiles = files.filter((f) => /\.gazboard$/i.test(f.name) || (manifest && f.name.startsWith('boards/')));
  if (!boardFiles.length) throw new Error(t('That file is not a GazBoard backup'));
  if (boardFiles.length > MAX_BOARDS) throw new Error(t('That backup is too large to open'));
  const total = boardFiles.reduce((n, f) => n + (Number(f._data && f._data.uncompressedSize) || 0), 0);
  if (total > MAX_BYTES) throw new Error(t('That backup is too large to open'));

  const list = ((await window.board.boards.list()) || []).filter(Boolean);
  const here = new Map(list.map((b) => [b.id, b]));
  const openId = app.store.doc.id;
  const remap = {};                                 // id in the backup -> id here, when they differ
  const out = { added: 0, same: 0, beside: 0, bad: 0 };
  let newest = null;

  for (let i = 0; i < boardFiles.length; i++) {
    onProgress?.(i, boardFiles.length);
    const data = boardFrom(await boardFiles[i].async('string'));
    if (!data) { out.bad++; continue; }
    const from = typeof data.id === 'string' ? data.id : '';
    let id = PLAIN_ID.test(from) ? from : uid('b');
    const clash = here.has(id) || id === openId;
    if (clash) {
      let mine = null;
      try { mine = id === openId ? app.store.toJSON() : await window.board.boards.load(id); } catch { mine = null; }
      if (mine && drawingOf(mine) === drawingOf(data)) { out.same++; if (from) remap[from] = id; continue; }
      // different work under the same id: keep both, the copy here untouched
      id = uid('b');
      data.name = besideName(data.name, list);
      out.beside++;
    } else out.added++;
    data.id = id;
    if (from && from !== id) remap[from] = id;
    if (!(await app.saveIncomingBoard(data, false))) { out.bad++; if (clash) out.beside--; else out.added--; continue; }
    if (!newest || (Number(data.modified) || 0) > newest.modified) newest = { id, modified: Number(data.modified) || 0 };
    here.set(id, { id, name: data.name });
    list.push({ id, name: data.name });
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.(boardFiles.length, boardFiles.length);

  // the folders they were filed in: added to the ones here, never replacing them
  if (manifest && (Array.isArray(manifest.folders) || manifest.boardFolders)) {
    const folders = (Array.isArray(manifest.folders) ? manifest.folders : [])
      .filter((f) => f && PLAIN_ID.test(String(f.id || '')) && (f.parent == null || PLAIN_ID.test(String(f.parent))));
    const boardFolders = {};
    const bf = manifest.boardFolders && typeof manifest.boardFolders === 'object' && !Array.isArray(manifest.boardFolders) ? manifest.boardFolders : {};
    for (const [b, f] of Object.entries(bf)) {
      if (!PLAIN_ID.test(b) || !PLAIN_ID.test(String(f))) continue;
      boardFolders[remap[b] || b] = f;
    }
    // removedFolders is left out on purpose: a backup must never delete a folder here
    app.takeCatalogue({ version: 1, folders, boardFolders });
    app.queueCatalogue?.({ now: true });
  }
  await app.refreshBoardDirectory?.();
  // a fresh install shows an empty board: put the newest board that came back in its place
  if (newest && app.unsavedNew && !app.store.objects.length) {
    try {
      const doc = await window.board.boards.load(newest.id);
      if (doc) await app.loadBoard(doc, { claimed: true });
    } catch { /* it is in My boards either way */ }
  }
  app.panels?.boardsChanged?.();
  return out;
}

function besideName(name, list) {
  const base = `${String(name || t('Untitled board')).trim() || t('Untitled board')} (${t('from backup')})`;
  const taken = new Set(list.map((b) => String(b && b.name || '')));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return `${base} ${Date.now()}`;
}

/** Ask for a backup file, then restore it. */
export async function restoreBackup(app) {
  const paths = await window.board.openDialog({
    title: t('Restore from a backup'),
    properties: ['openFile'],
    filters: [{ name: t('ZIP archive'), extensions: ['zip'] }]
  });
  if (!paths || !paths.length) return null;
  const toast = progressToast(t('Restoring…'));
  try {
    const buf = await window.board.readFile(paths[0]);
    const r = await restoreBackupBytes(app, buf, {
      onProgress: (i, n) => toast.set(t('Restoring {done} of {total}…', { done: i, total: n }), n ? i / n : 1)
    });
    const parts = [];
    if (r.added) parts.push(r.added === 1 ? t('1 board restored') : t('{n} boards restored', { n: r.added }));
    if (r.beside) parts.push(r.beside === 1 ? t('1 kept beside your own copy') : t('{n} kept beside your own copies', { n: r.beside }));
    if (r.same) parts.push(r.same === 1 ? t('1 was already here') : t('{n} were already here', { n: r.same }));
    if (r.bad) parts.push(r.bad === 1 ? t('1 could not be read') : t('{n} could not be read', { n: r.bad }));
    app.toast(parts.join(' · ') || t('Nothing to restore'), r.bad ? 'help' : 'check', 6000);
    return r;
  } catch (e) {
    app.toast(e && e.message ? e.message : t('That file is not a GazBoard backup'), 'help', 6000);
    return null;
  } finally { toast.done(); }
}
