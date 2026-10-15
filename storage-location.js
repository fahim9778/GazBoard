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

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function validateBoardsDir(dir, { currentDir, protectedDir, appPath, create = true } = {}) {
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
    const entries = fs.readdirSync(real, { withFileTypes: true });
    const existingBoards = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).length;
    return { ok: true, path: real, isEmpty: existingBoards === 0, existingBoards };
  } catch (e) {
    return { ok: false, reason: e.message || 'This folder is not writable.' };
  }
}

module.exports = { configFile, defaultBoardsDir, readConfig, writeConfig, validateBoardsDir, within };
