// Folders for My boards: a filing cabinet for boards, by subject.
//
// The folders are a catalogue kept beside the boards, never written into them.
// A board file looks exactly as it always has, so a board sent to somebody,
// saved as a file or opened in an older GazBoard carries no folder with it and
// loses nothing. The catalogue lives in the app's settings on this device:
//
//     folders:      [{ id, name, parent }]      parent null = the top level
//     boardFolders: { boardId: folderId }        missing = the top level
//
// Every function here is careful about one thing above all: nothing it does can
// ever lose a board. Deleting a folder moves what was in it up a level. A board
// filed in a folder that no longer exists simply shows at the top.

const uid = () => 'f' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function folderList(s) { return Array.isArray(s.folders) ? s.folders : []; }

function byId(s, id) { return folderList(s).find((f) => f.id === id) || null; }

/** The folder a board is filed in, or null for the top level (or a folder that has gone). */
export function folderOf(s, boardId) {
  const id = s.boardFolders && s.boardFolders[boardId];
  return id && byId(s, id) ? id : null;
}

/** Where a folder really sits: its parent, or the top level if that parent has gone. */
function parentOf(s, f) { return f.parent && byId(s, f.parent) ? f.parent : null; }

/** Folders directly inside `parent` (null = the top level), by name. */
export function childFolders(s, parent = null) {
  return folderList(s).filter((f) => parentOf(s, f) === (parent || null))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** The boards from `list` that are filed directly in `folder`. */
export function boardsIn(s, list, folder = null) {
  return list.filter((b) => folderOf(s, b.id) === (folder || null));
}

/** From the top down to `id`: [{id, name}, ...]. Empty for the top level. */
export function folderPath(s, id) {
  const out = [];
  const seen = new Set();
  let f = byId(s, id);
  while (f && !seen.has(f.id)) { seen.add(f.id); out.unshift({ id: f.id, name: f.name }); f = f.parent ? byId(s, f.parent) : null; }
  return out;
}

/** Is `id` the folder `ancestor` itself, or somewhere inside it? */
export function isInside(s, id, ancestor) {
  const seen = new Set();
  let f = byId(s, id);
  while (f && !seen.has(f.id)) {
    if (f.id === ancestor) return true;
    seen.add(f.id);
    f = f.parent ? byId(s, f.parent) : null;
  }
  return false;
}

/** How much is in a folder, counting everything below it. */
export function folderCounts(s, list, id) {
  let boards = 0, folders = 0;
  for (const f of folderList(s)) if (f.id !== id && isInside(s, f.id, id)) folders++;
  for (const b of list) { const at = folderOf(s, b.id); if (at && isInside(s, at, id)) boards++; }
  return { boards, folders };
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

export function createFolder(s, name, parent = null) {
  const n = cleanName(name);
  if (!n) return null;
  const f = { id: uid(), name: n, parent: parent && byId(s, parent) ? parent : null };
  s.folders = [...folderList(s), f];      // a new list, never the shared default one
  return f.id;
}

export function renameFolder(s, id, name) {
  const f = byId(s, id), n = cleanName(name);
  if (!f || !n) return false;
  f.name = n;
  return true;
}

/**
 * Remove a folder. What was inside it - boards and folders alike - moves up
 * into the folder it was in, so deleting a folder never deletes a board.
 */
export function deleteFolder(s, id) {
  const f = byId(s, id);
  if (!f) return false;
  const up = f.parent && byId(s, f.parent) ? f.parent : null;
  s.folders = folderList(s).filter((x) => x.id !== id).map((c) => (c.parent === id ? { ...c, parent: up } : c));
  const map = { ...(s.boardFolders || {}) };
  for (const [b, at] of Object.entries(map)) if (at === id) { if (up) map[b] = up; else delete map[b]; }
  s.boardFolders = map;
  // remembered, so a copy of this catalogue elsewhere (another computer, the phone's folder copy) is not
  // taken as a reason to bring the folder back
  s.removedFolders = [...(Array.isArray(s.removedFolders) ? s.removedFolders : []).filter((x) => x !== id), id].slice(-500);
  return true;
}

/** File a board in a folder (null = the top level). */
export function moveBoard(s, boardId, folder = null) {
  const map = { ...(s.boardFolders && typeof s.boardFolders === 'object' ? s.boardFolders : {}) };
  if (folder && byId(s, folder)) map[boardId] = folder;
  else delete map[boardId];
  s.boardFolders = map;
  return true;
}

/** Move a folder into another. Refused when that would put it inside itself. */
export function moveFolder(s, id, into = null) {
  const f = byId(s, id);
  if (!f) return false;
  if (into && (into === id || isInside(s, into, id))) return false;
  f.parent = into && byId(s, into) ? into : null;
  return true;
}

/** Forget boards that are no longer there, so the catalogue does not grow for ever. */
export function pruneBoards(s, list) {
  if (!s.boardFolders) return false;
  const have = new Set(list.map((b) => b.id));
  const map = { ...s.boardFolders };
  let changed = false;
  for (const b of Object.keys(map)) if (!have.has(b)) { delete map[b]; changed = true; }
  if (changed) s.boardFolders = map;
  return changed;
}

/** The colours a folder can wear. Bright enough on a light page, calm enough on a dark one. */
export const FOLDER_COLOURS = ['#e8484b', '#f28c28', '#f2c12e', '#3fae5a', '#2f8fd8', '#7b5cd6', '#d0458e', '#7a7f87'];

/** A folder's colour: the one chosen for it, or one picked from its id so it never changes by itself. */
export function folderColour(f) {
  if (f && typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color)) return f.color;
  let h = 0;
  for (const ch of String(f && f.id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_COLOURS[h % FOLDER_COLOURS.length];
}

/** Give a folder its own colour (a new list, like every other change here). */
export function setFolderColour(s, id, colour) {
  if (!byId(s, id) || !/^#[0-9a-f]{6}$/i.test(String(colour || ''))) return false;
  s.folders = folderList(s).map((f) => (f.id === id ? { ...f, color: colour } : f));
  return true;
}

/*
 * The catalogue travels with the boards.
 *
 * It is kept in this device's settings, which do not move when the boards do:
 * choosing another boards folder, opening the same folder on a second
 * computer, or bringing boards back on a reinstalled phone found every board
 * but none of the folders they were filed in. So a copy is written beside the
 * boards (folders.json), and read back in when boards arrive from there.
 *
 * Reading it back only ever ADDS: folders this device does not have, and
 * filing for boards this device has not filed. What is already here wins, so
 * nothing anyone sorted on this device is undone. A folder deleted elsewhere
 * is deleted here the usual safe way - what was in it moves up a level - and
 * one deleted here is not brought back by an older copy.
 */
export function catalogueOf(s) {
  return {
    version: 1,
    folders: folderList(s),
    boardFolders: s.boardFolders && typeof s.boardFolders === 'object' ? s.boardFolders : {},
    deviceFolders: s.deviceFolders && typeof s.deviceFolders === 'object' ? s.deviceFolders : {},
    removedFolders: Array.isArray(s.removedFolders) ? s.removedFolders : []
  };
}

const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 128;

/** Fold a catalogue from elsewhere into this one. True when anything changed. */
export function mergeCatalogue(s, inc) {
  if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return false;
  let changed = false;
  const removed = new Set((Array.isArray(s.removedFolders) ? s.removedFolders : []).filter(isId));
  for (const id of Array.isArray(inc.removedFolders) ? inc.removedFolders : []) {
    if (!isId(id)) continue;
    if (byId(s, id)) { deleteFolder(s, id); changed = true; }
    removed.add(id);
  }
  const have = new Set(folderList(s).map((f) => f.id));
  const add = [];
  for (const f of Array.isArray(inc.folders) ? inc.folders : []) {
    if (!f || !isId(f.id) || have.has(f.id) || removed.has(f.id)) continue;
    const name = cleanName(f.name);
    if (!name) continue;
    const g = { id: f.id, name, parent: isId(f.parent) ? f.parent : null };
    if (typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color)) g.color = f.color;
    add.push(g); have.add(g.id);
  }
  if (add.length) {
    s.folders = [...folderList(s), ...add];
    // a damaged copy could have two new folders inside each other; neither would ever show, so they go to the top
    for (const g of add) {
      const seen = new Set([g.id]);
      for (let p = byId(s, g.parent); p; p = p.parent ? byId(s, p.parent) : null) {
        if (seen.has(p.id)) { g.parent = null; break; }
        seen.add(p.id);
      }
    }
    changed = true;
  }
  const fill = (key, from) => {
    if (!from || typeof from !== 'object' || Array.isArray(from)) return;
    const map = { ...(s[key] && typeof s[key] === 'object' ? s[key] : {}) };
    let touched = false;
    for (const [k, folder] of Object.entries(from)) {
      if (!isId(k) || !isId(folder) || !byId(s, folder)) continue;
      if (map[k] && byId(s, map[k])) continue;          // this device's own filing wins
      map[k] = folder; touched = true;
    }
    if (touched) { s[key] = map; changed = true; }
  };
  fill('boardFolders', inc.boardFolders);
  fill('deviceFolders', inc.deviceFolders);
  s.removedFolders = [...removed].slice(-500);
  return changed;
}
