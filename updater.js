'use strict';
/*
 * Updating GazBoard from inside GazBoard.
 *
 * Finding out THAT there is a new version is main.js's job (updates:check),
 * and it only ever happens because the person said yes to it. This file does
 * the part after that, and again only when asked: fetch the new version,
 * check it is exactly what the release says it is, and put it in place of
 * the running one on a restart.
 *
 * Windows (the installed build) uses electron-updater, the updater that ships
 * with the tool GazBoard is built with. It fetches only the parts of the
 * installer that changed (the .blockmap files on the release), checks the
 * whole file against the SHA-512 in latest.yml, and reinstalls silently over
 * the top. The portable .exe cannot replace itself, so it keeps the download
 * page.
 *
 * macOS cannot use that updater: it only accepts a new version signed by the
 * same paid Apple developer certificate, and GazBoard is signed ad hoc. So it
 * is done here, by hand and carefully: download the .zip for this Mac's chip,
 * check its SHA-512 against latest-mac.yml, unpack it with ditto, check the
 * result is GazBoard, is the promised version and has an intact signature -
 * and only after GazBoard has quit, swap the folders and open the new one.
 * The old app is moved aside first and put back if anything goes wrong, so a
 * failed update leaves the version that worked.
 *
 * Linux keeps the download page here; AppImage updates are a separate piece
 * of work.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

/** Where release files are downloaded from. Overridable so the suite can serve them from localhost. */
const downloadBase = () => (process.env.GAZBOARD_UPDATE_DOWNLOADS || 'https://github.com/fahim9778/GazBoard/releases/download').replace(/\/+$/, '');

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/* ------------------------------------------------------------------ *
 *  Can this copy of GazBoard update itself?
 * ------------------------------------------------------------------ */

/** The .app folder an executable lives in, or null. /Applications/GazBoard.app/Contents/MacOS/GazBoard -> /Applications/GazBoard.app */
function macBundle(execPath) {
  const p = String(execPath || '');
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(p);
  return m ? m[1] : null;
}

/**
 * How an update can be installed here: 'install' (download it and restart
 * into it) or 'page' (open the download page), with the reason when it is the page.
 */
function installMode({ platform = process.platform, execPath = process.execPath, env = process.env, packaged = true, canWrite = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } } } = {}) {
  if (!packaged && !env.GAZBOARD_UPDATE_TEST) return { mode: 'page', reason: 'not-installed' };
  if (platform === 'win32') {
    // electron-builder's portable .exe unpacks itself to a temp folder on every start
    if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) return { mode: 'page', reason: 'portable' };
    return { mode: 'install', kind: 'win' };
  }
  if (platform === 'darwin') {
    const bundle = macBundle(execPath);
    if (!bundle) return { mode: 'page', reason: 'not-an-app' };
    // still on the disk image, or run from Downloads and moved aside by macOS (App Translocation): nothing to replace
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return { mode: 'page', reason: 'not-in-applications' };
    if (!canWrite(path.dirname(bundle))) return { mode: 'page', reason: 'read-only' };
    return { mode: 'install', kind: 'mac', bundle };
  }
  return { mode: 'page', reason: 'platform' };
}

/* ------------------------------------------------------------------ *
 *  latest-mac.yml
 * ------------------------------------------------------------------ */

/**
 * The files a latest*.yml lists, as [{url, sha512, size}]. The format is the
 * small, fixed one electron-builder writes, read without a YAML library:
 *
 *   version: 4.6.0
 *   files:
 *     - url: GazBoard-4.6.0-arm64-mac.zip
 *       sha512: Ab3...==
 *       size: 101234567
 */
function parseLatestYml(text) {
  const files = [];
  let version = null, cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = /^version:\s*['"]?([^'"\s]+)['"]?$/.exec(line))) { version = m[1]; continue; }
    if ((m = /^\s*-\s+url:\s*['"]?([^'"]+?)['"]?$/.exec(line))) { cur = { url: m[1] }; files.push(cur); continue; }
    if (!cur || !/^\s{2,}\S/.test(line) || /^\S/.test(line)) { if (/^\S/.test(line)) cur = null; continue; }
    if ((m = /^\s+sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?$/.exec(line))) cur.sha512 = m[1];
    else if ((m = /^\s+size:\s*(\d+)$/.exec(line))) cur.size = Number(m[1]);
  }
  return { version, files: files.filter((f) => f.url && f.sha512) };
}

/** This Mac's .zip from the list: the arm64 one on Apple chips, the other one on Intel. */
function pickMacZip(files, arch = process.arch) {
  const zips = (files || []).filter((f) => /\.zip$/i.test(f.url));
  const arm = zips.find((f) => /arm64/i.test(f.url));
  const intel = zips.find((f) => !/arm64/i.test(f.url));
  return arch === 'arm64' ? (arm || null) : (intel || null);
}

/* ------------------------------------------------------------------ *
 *  Downloading
 * ------------------------------------------------------------------ */

/** A small text file (latest-mac.yml), following GitHub's redirect to its file store. */
async function fetchText(net, url) {
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`the release has no ${path.basename(new URL(url).pathname)} (${res.status})`);
  return res.text();
}

/** Stream a file to disk, reporting progress and hashing as it goes. Resolves to the SHA-512 in base64. */
async function downloadTo(net, url, dest, { size = 0, onProgress = () => {}, signal } = {}) {
  const res = await net.fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      onProgress(total ? got / total : 0, got, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return { sha512: hash.digest('base64'), bytes: got };
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(cmd)}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout).trim())));
});

/* ------------------------------------------------------------------ *
 *  Putting the new Mac app in place
 * ------------------------------------------------------------------ */

/*
 * Runs after GazBoard has quit. Every step that can fail leaves the old app
 * where it was, and whatever happens, GazBoard is opened again at the end -
 * the new one, or the old one if the swap could not be made.
 */
const SWAP_SCRIPT = `#!/bin/bash
# GazBoard's updater: replace the app once the running copy has quit.
pid="$1"; app="$2"; new="$3"; work="$4"
open_cmd="\${GAZBOARD_OPEN:-/usr/bin/open}"
case "$app" in *.app) ;; *) exit 2 ;; esac
case "$new" in *.app) ;; *) exit 2 ;; esac
[ -d "$new" ] || exit 2
# wait up to a minute for GazBoard to finish quitting (tenths of a second; the suite shortens it)
limit="\${GAZBOARD_SWAP_WAIT:-600}"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$limit" ]; do sleep 0.1; i=$((i+1)); done
if kill -0 "$pid" 2>/dev/null; then exit 3; fi
backup="$work/previous.app"
rm -rf "$backup"
if ! mv "$app" "$backup"; then "$open_cmd" "$app"; exit 4; fi
# GAZBOARD_SWAP_FAIL_NEW lets the suite prove the way back works
if [ -z "$GAZBOARD_SWAP_FAIL_NEW" ] && mv "$new" "$app"; then
  rm -rf "$backup"
  "$open_cmd" "$app"
  exit 0
fi
# the new one did not go in: put the old one back exactly as it was
rm -rf "$app"
mv "$backup" "$app"
"$open_cmd" "$app"
exit 5
`;

/* ------------------------------------------------------------------ *
 *  The updater itself
 * ------------------------------------------------------------------ */

/**
 * @param {object} deps  electron's app and net, and where to keep notes between runs
 */
function createUpdater({ app, net, notePath, env = process.env, platform = process.platform, execPath = process.execPath, arch = process.arch, canWrite }) {
  let ready = null;          // the downloaded update, waiting for a restart
  let busy = null;
  let installOnQuit = false;

  const mode = () => installMode({ platform, execPath, env, packaged: app.isPackaged, ...(canWrite ? { canWrite } : {}) });

  /* A note left for the next start, so it can say "updated to 4.6.0" - or that it was not. */
  const writeNote = async (note) => { try { await fsp.writeFile(notePath, JSON.stringify(note)); } catch { /* best effort */ } };
  async function takeNote() {
    let note = null;
    try { note = JSON.parse(await fsp.readFile(notePath, 'utf8')); } catch { return null; }
    try { await fsp.unlink(notePath); } catch { /* gone already */ }
    if (!note || !VERSION_RE.test(note.to || '')) return null;
    return { to: note.to, from: note.from, done: app.getVersion() === note.to, kind: note.kind };
  }

  async function downloadWin(version, onProgress) {
    const { NsisUpdater } = require('electron-updater');
    const u = new NsisUpdater();
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.disableWebInstaller = true;
    u.forceDevUpdateConfig = !!env.GAZBOARD_UPDATE_TEST;
    /*
     * GazBoard's Windows builds are not code-signed, so there is no publisher
     * certificate to compare - electron-updater would refuse every update for
     * that alone. The file is still checked: its SHA-512 must match the one in
     * latest.yml, fetched over HTTPS from the same GitHub release, which is
     * exactly the trust a download from the release page gets.
     */
    u.verifyUpdateCodeSignature = () => Promise.resolve(null);
    u.logger = null;
    /*
     * The installed build carries app-update.yml (written by electron-builder
     * from build.publish), which names the folder the installer keeps a copy
     * of itself in - the copy differential downloads are built from. Should
     * it be missing, a minimal one stands in, and the update is simply
     * downloaded whole.
     */
    const onDisk = path.join(process.resourcesPath || '', 'app-update.yml');
    if (!fs.existsSync(onDisk)) {
      const stand = path.join(os.tmpdir(), 'gazboard-app-update.yml');
      // the suite downloads into a folder of its own, never the real updater's
      fs.writeFileSync(stand, `updaterCacheDirName: ${env.GAZBOARD_UPDATE_TEST ? 'gazboard-updater-test' : 'gazboard-updater'}\n`);
      u.updateConfigPath = stand;
    }
    // The suite exercises the Windows download on its own machine; there, electron-updater
    // has to be told which platform's file to read (latest.yml, not latest-linux.yml).
    if (env.GAZBOARD_UPDATE_TEST && platform !== process.platform) u._testOnlyOptions = { platform, isUseDifferentialDownload: false };
    // after the config path: setting that resets the feed
    u.setFeedURL({ provider: 'generic', url: `${downloadBase()}/v${version}` });
    u.on('download-progress', (p) => onProgress((p.percent || 0) / 100, p.transferred || 0, p.total || 0));
    const found = await u.checkForUpdates();
    const info = found && found.updateInfo;
    if (!info || info.version !== version) throw new Error(`the release does not offer ${version} for Windows`);
    await u.downloadUpdate();
    return { kind: 'win', version, updater: u };
  }

  async function downloadMac(version, onProgress, bundle) {
    const base = `${downloadBase()}/v${version}`;
    const list = parseLatestYml(await fetchText(net, `${base}/latest-mac.yml`));
    if (list.version !== version) throw new Error(`the release describes ${list.version || 'no version'}, not ${version}`);
    const file = pickMacZip(list.files, arch);
    if (!file) throw new Error(`the release has no Mac download for this ${arch === 'arm64' ? 'Apple chip' : 'Intel'} Mac`);
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'gazboard-update-'));
    const zip = path.join(work, path.basename(file.url));
    const got = await downloadTo(net, `${base}/${file.url.split('/').map(encodeURIComponent).join('/')}`, zip, { size: file.size, onProgress });
    if (got.sha512 !== file.sha512) throw new Error('the download does not match the release (checksum differs) - nothing was changed');
    if (file.size && got.bytes !== file.size) throw new Error('the download is incomplete - nothing was changed');
    const unpacked = path.join(work, 'new');
    await fsp.mkdir(unpacked);
    await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    const apps = (await fsp.readdir(unpacked)).filter((n) => n.endsWith('.app'));
    if (apps.length !== 1) throw new Error('the download does not contain the app');
    const newApp = path.join(unpacked, apps[0]);
    const plist = (key, at) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(at, 'Contents', 'Info.plist')]);
    const [id, have, theirs] = await Promise.all([plist('CFBundleIdentifier', bundle), plist('CFBundleShortVersionString', newApp), plist('CFBundleIdentifier', newApp)]);
    if (theirs !== id) throw new Error('the download is not GazBoard');
    if (have !== version) throw new Error(`the download is version ${have}, not ${version}`);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);
    try { await fsp.unlink(zip); } catch { /* only space */ }
    // written now, so that putting it in place on quit needs nothing that can still be in flight
    const script = path.join(work, 'swap.sh');
    await fsp.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
    return { kind: 'mac', version, newApp, work, bundle, script };
  }

  return {
    mode,
    takeNote,

    /** Fetch and check the new version. Resolves to {ok} or {ok:false, error}. */
    async download(version, onProgress = () => {}) {
      if (!VERSION_RE.test(String(version || ''))) return { ok: false, error: 'not a version' };
      if (ready && ready.version === version) return { ok: true, version };
      if (busy) return { ok: false, error: 'already downloading' };
      const m = mode();
      if (m.mode !== 'install') return { ok: false, error: 'this copy of GazBoard cannot update itself', reason: m.reason };
      busy = (m.kind === 'win' ? downloadWin(version, onProgress) : downloadMac(version, onProgress, m.bundle));
      try {
        ready = await busy;
        return { ok: true, version };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      } finally { busy = null; }
    },

    get ready() { return ready ? ready.version : null; },

    /**
     * Put the downloaded version in place. now = quit and restart into it at
     * once; otherwise it goes in when GazBoard is next closed.
     */
    async install({ now = true } = {}) {
      if (!ready) return { ok: false, error: 'nothing downloaded' };
      await writeNote({ to: ready.version, from: app.getVersion(), kind: ready.kind, at: Date.now() });
      if (!now) {
        installOnQuit = true;
        if (ready.kind === 'win') { ready.updater.autoInstallOnAppQuit = true; ready.updater.addQuitHandler(); }
        return { ok: true, later: true };
      }
      if (ready.kind === 'win') {
        // silent reinstall over the top, then start the new version
        ready.updater.quitAndInstall(true, true);
        return { ok: true };
      }
      this.startMacSwap();
      app.quit();
      return { ok: true };
    },

    /** Hand the Mac swap to a helper that waits for this process to end. */
    startMacSwap() {
      if (!ready || ready.kind !== 'mac' || ready.swapping) return false;
      ready.swapping = true;
      const child = spawn('/bin/bash', [ready.script, String(process.pid), ready.bundle, ready.newApp, ready.work], { detached: true, stdio: 'ignore', env });
      child.unref();
      return true;
    },

    /** Called as GazBoard quits: a "when I close it" update goes in now. */
    onQuit() {
      if (installOnQuit && ready && ready.kind === 'mac') { try { this.startMacSwap(); } catch { /* the old app stays */ } }
      // Windows: electron-updater's own autoInstallOnAppQuit does it
    }
  };
}

module.exports = { createUpdater, installMode, macBundle, parseLatestYml, pickMacZip, downloadTo, SWAP_SCRIPT };
