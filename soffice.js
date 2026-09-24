'use strict';
/*
 * Finding LibreOffice.
 *
 * The app shells out to soffice to turn a Word, PowerPoint or Excel file into
 * PDF pages. Word and PowerPoint have a built-in fallback, so they still work
 * without it; a spreadsheet has none, and LibreOffice is the only way one can
 * be imported at all.
 *
 * This used to be three hardcoded paths under C:. That is where the installer
 * puts it by default and nowhere else, so anyone who moved it to a second
 * drive - which people with a small system drive do, and a 700MB install is
 * worth moving - ended up with LibreOffice working perfectly on their machine
 * and an app that swore it was not installed, with no setting anywhere to put
 * it right.
 *
 * So the search now goes, in order:
 *
 *   1. GAZBOARD_SOFFICE, if it is set and points at something real. An
 *      explicit answer always wins, and it is the escape hatch for a layout
 *      nothing below guesses.
 *   2. Whatever is on PATH. This is how it is normally found on Linux and
 *      macOS, and it works on Windows for anyone who put it there.
 *   3. The usual install folders, on every fixed drive rather than only C.
 *
 * Nothing here spawns a process: spawning `where` or `which` would cost a
 * subprocess on a cold path, and reading PATH tells us the same thing. The
 * whole search happens once per launch and the answer is remembered.
 */

const path = require('node:path');
const fs = require('node:fs');

/** Is this a file we can actually run? */
function usable(p, exists) {
  if (!p) return false;
  try { return exists(p); } catch { return false; }
}

/** The binary's name on this platform. */
function binaryNames(platform) {
  return platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice', 'libreoffice'];
}

/**
 * Everywhere worth looking, in the order worth looking.
 *
 * Exported so the suite can see the whole list rather than only the winner -
 * a failure that prints where it looked is worth far more than one that says
 * "not found".
 */
function sofficeCandidates(platform = process.platform, env = process.env) {
  const out = [];
  /*
   * Joined with the TARGET platform's rules, not the host's. path.join alone
   * builds "D:\\LibreOffice/program/soffice.exe" when this is asked what a
   * Windows machine would have while running somewhere else - which is exactly
   * what the suite asks it, and what CI runs on.
   */
  const J = platform === 'win32' ? path.win32 : path.posix;

  // 1. told outright
  if (env.GAZBOARD_SOFFICE) out.push(env.GAZBOARD_SOFFICE);

  // 2. on PATH
  const names = binaryNames(platform);
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || env.Path || '').split(sep)) {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (!d) continue;
    for (const n of names) out.push(J.join(d, n));
  }

  // 3. the usual places
  if (platform === 'darwin') {
    out.push('/Applications/LibreOffice.app/Contents/MacOS/soffice',
             '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice');
  } else if (platform === 'win32') {
    /*
     * Both shapes, on every drive letter rather than only C: the installer
     * offers "D:\Program Files\LibreOffice" and plain "D:\LibreOffice"
     * depending on how the path is typed, and people use both.
     *
     * A drive that is not there costs one failed lookup, so the whole sweep is
     * cheaper than it looks. B and below are skipped because on the machines
     * that still have an A: drive, touching it makes a noise.
     */
    const tails = [
      J.join('Program Files', 'LibreOffice', 'program', 'soffice.exe'),
      J.join('Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
      J.join('LibreOffice', 'program', 'soffice.exe')
    ];
    for (let i = 'C'.charCodeAt(0); i <= 'Z'.charCodeAt(0); i++) {
      const drive = String.fromCharCode(i) + ':\\';
      for (const t of tails) out.push(drive + t);
    }
    if (env.LOCALAPPDATA)
      out.push(J.join(env.LOCALAPPDATA, 'Programs', 'LibreOffice', 'program', 'soffice.exe'));
  } else {
    out.push('/usr/bin/soffice', '/usr/local/bin/soffice',
             '/snap/bin/libreoffice', '/usr/bin/libreoffice',
             '/opt/libreoffice/program/soffice');
  }

  // the same folder can arrive twice - from PATH and from the list below it
  return [...new Set(out)];
}

/**
 * The first candidate that is really there, or null.
 *
 * `exists` is injected so the suite can ask "what would this find on a machine
 * laid out like THIS" without needing that machine.
 */
function resolveSoffice({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.GAZBOARD_DISABLE_LIBREOFFICE === '1') return null;
  /*
   * A drive is asked about once, before any of the folders on it.
   *
   * Most machines have two or three drives and the sweep covers twenty-four,
   * so the great majority of these lookups are on letters that do not exist.
   * That is free on a local disk. It is not free on a mapped network drive
   * that is currently unreachable - an office machine with a disconnected
   * share can take a moment to answer - so the answer for each letter is
   * settled once and the three folders on a dead drive are never tried.
   */
  const driveIsThere = {};
  for (const c of sofficeCandidates(platform, env)) {
    const m = platform === 'win32' ? /^([A-Za-z]:\\)/.exec(c) : null;
    if (m) {
      const root = m[1].toUpperCase();
      if (driveIsThere[root] === undefined) driveIsThere[root] = usable(root, exists);
      if (!driveIsThere[root]) continue;
    }
    if (usable(c, exists)) return c;
  }
  return null;
}

module.exports = { resolveSoffice, sofficeCandidates };
