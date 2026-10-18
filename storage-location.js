'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_NAME = 'storage-location.json';

function configFile(userDataDir) { return path.join(userDataDir, CONFIG_NAME); }
function defaultBoardsDir(userDataDir) { return path.join(userDataDir, 'boards'); }

function readConfig(userDataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(userDataDir), 'utf8'));
    return cfg && cfg.version === 1 && typeof cfg.boardsDir === 'string' && path.isAbsolute(cfg.boardsDir)
      ? { version: 1, boardsDir: path.resolve(cfg.boardsDir) } : null;
  } catch { return null; }
}

function writeConfig(userDataDir, boardsDir) {
  const file = configFile(userDataDir), tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, boardsDir: path.resolve(boardsDir) }, null, 2));
  fs.renameSync(tmp, file);
}

/*
 * GazBoard keeps its files in a folder of its own inside the one picked.
 *
 * Boards are .json files named after their id, and a folder that someone
 * already uses - Documents, a project, a synced share - is full of .json files
 * that have nothing to do with GazBoard. Writing straight into it would list
 * those as boards, and deleting one of those "boards" would delete somebody's
 * file. So picking Documents means Documents/GazBoard. A folder that is itself
 * called GazBoard is taken as it is, so picking the same place twice (or on a
 * second computer) lands on the same boards.
 */
const FOLDER_NAME = 'GazBoard';
function boardsFolderFor(picked) {
  const resolved = path.resolve(picked);
  return path.basename(resolved).toLowerCase() === FOLDER_NAME.toLowerCase() ? resolved : path.join(resolved, FOLDER_NAME);
}

/**
 * Is this parsed file one of GazBoard's boards? A board is an object holding
 * its objects, with an id or the board's own fields beside them. Anything else
 * in the folder is left alone: never listed, never opened, never deleted.
 * (The file name is not held against it: a board copied in by hand under
 * another name is still a board.)
 */
function isBoardFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const objs = raw.objects;
  if (!(Array.isArray(objs) || (objs && typeof objs === 'object'))) return false;
  return typeof raw.id === 'string' || 'background' in raw || 'schema' in raw || 'name' in raw;
}

/** How many of GazBoard's boards are in this folder. Other .json files do not count. */
function countBoards(dir) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    try { if (isBoardFile(JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')))) n++; } catch {}
  }
  return n;
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// count: false skips reading every board to count them. Launch only needs to know the folder is
// there and writable; reading a whole Google Drive or OneDrive folder to count it made every start wait.
function validateBoardsDir(dir, { currentDir, protectedDir, appPath, create = true, count = true } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, reason: 'Choose an absolute folder path.' };
  const resolved = path.resolve(dir);
  try {
    if (appPath && within(path.resolve(appPath), resolved))
      return { ok: false, reason: 'Choose a folder outside the GazBoard application.' };
    if (currentDir && path.resolve(currentDir) !== resolved
        && (within(path.resolve(currentDir), resolved) || within(resolved, path.resolve(currentDir))))
      return { ok: false, reason: 'Choose a folder that does not contain or sit inside the current boards folder.' };
    if (protectedDir && resolved !== path.resolve(protectedDir)
        && (within(path.resolve(protectedDir), resolved) || within(resolved, path.resolve(protectedDir))))
      return { ok: false, reason: 'Choose a folder outside the default boards folder.' };
    if (create) fs.mkdirSync(resolved, { recursive: true });
    const real = fs.realpathSync(resolved);
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: 'The chosen path is not a folder.' };
    if (appPath) {
      let appReal = appPath;
      try { appReal = fs.realpathSync(appPath); } catch {}
      if (within(appReal, real)) return { ok: false, reason: 'Choose a folder outside the GazBoard application.' };
    }
    if (currentDir) {
      let currentReal = currentDir;
      try { currentReal = fs.realpathSync(currentDir); } catch {}
      if (currentReal !== real && (within(currentReal, real) || within(real, currentReal)))
        return { ok: false, reason: 'Choose a folder that does not contain or sit inside the current boards folder.' };
    }
    if (protectedDir) {
      let protectedReal = protectedDir;
      try { protectedReal = fs.realpathSync(protectedDir); } catch {}
      if (protectedReal !== real && (within(protectedReal, real) || within(real, protectedReal)))
        return { ok: false, reason: 'Choose a folder outside the default boards folder.' };
    }
    if (create || fs.existsSync(real)) {
      const probe = path.join(real, `.gazboard-write-${process.pid}-${Date.now()}`);
      const bytes = Buffer.from('GazBoard storage check');
      try {
        fs.writeFileSync(probe, bytes, { flag: 'wx' });
        if (!fs.readFileSync(probe).equals(bytes)) return { ok: false, reason: 'GazBoard could not verify writes to this folder.' };
      } finally { try { fs.unlinkSync(probe); } catch {} }
    }
    const existingBoards = count ? countBoards(real) : null;
    return { ok: true, path: real, isEmpty: existingBoards === 0, existingBoards };
  } catch (e) {
    return { ok: false, reason: e.message || 'This folder is not writable.' };
  }
}

module.exports = { configFile, defaultBoardsDir, readConfig, writeConfig, validateBoardsDir, within, boardsFolderFor, isBoardFile, countBoards, FOLDER_NAME };
