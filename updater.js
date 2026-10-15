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
 * installer that changed (the .blockmap files on the release, compared with
 * the copy of the installer it keeps in %LOCALAPPDATA%\gazboard-updater,
 * one part per request because that is all GitHub serves), checks the
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
 * failed update leaves the version that worked. The zip is kept afterwards,
 * so that the next update can be built from it, fetching only the parts the
 * release's .blockmap files say have changed; a Mac that has none (it came
 * from the disk image) downloads the whole zip once.
 *
 * Linux, as an AppImage, downloads only what changed (zsync.js): the .zsync
 * beside the release's AppImage shows which parts of the AppImage already on
 * this computer can be kept, the rest is fetched, and the whole new file must
 * match the SHA-1 the .zsync promises. It is written beside the old one and
 * renamed over it - the same file name, so menu entries and shortcuts keep
 * working - and GazBoard is started again from it once this copy has quit.
 * The .deb and .rpm are updated by the system's own package manager, and
 * keep the download page.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');

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
  if (platform === 'linux') {
    // an AppImage says where it is; anything else (a .deb, a source checkout) has no file of its own to replace
    let file = env.APPIMAGE;
    if (!file || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { mode: 'page', reason: 'not-an-appimage' };
    // started through a link: the file to replace is the one it points at, so the link goes on working
    try { file = fs.realpathSync(file); } catch { /* keep the name it was started by */ }
    if (!canWrite(path.dirname(file))) return { mode: 'page', reason: 'read-only' };
    return { mode: 'install', kind: 'appimage', file };
  }
  return { mode: 'page', reason: 'platform' };
}

/** The release's AppImage for this machine. Only 64-bit Intel/AMD is built; anything else is the download page's business. */
function appImageName(version, arch = process.arch) {
  if (arch === 'x64') return `GazBoard-${version}.AppImage`;
  if (arch === 'arm64') return `GazBoard-${version}-arm64.AppImage`;
  return null;
}

/**
 * The environment for starting the new AppImage: the running one's own
 * variables taken out. They point into its mounted copy, which disappears the
 * moment it quits, and the new AppImage sets its own.
 */
function cleanAppImageEnv(env) {
  const out = { ...env };
  const mount = env.APPDIR;
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete out[k];
  if (mount) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || !v.includes(mount)) continue;
      // PATH and friends are lists the AppImage put its own folders in front of: only those come out
      const kept = v.split(':').filter((part) => part && !part.includes(mount));
      if (kept.length) out[k] = kept.join(':'); else delete out[k];
    }
  }
  return out;
}

/*
 * Runs after GazBoard has quit: wait for it to be gone (the new one would
 * otherwise find it still running and hand itself over to it), then start
 * the AppImage, which by now is the new version.
 */
const APPIMAGE_RESTART = 'pid="$1"; file="$2"; shift 2; i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.1; i=$((i+1)); done; exec "$file" "$@"';

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

/**
 * A file being written, where a failure (the disk is full, the folder went)
 * comes back as an error from the next write instead of escaping as an
 * uncaught exception and leaving the download stuck forever.
 */
function safeWriter(dest) {
  const out = fs.createWriteStream(dest);
  let failed = null;
  const waiting = new Set();
  out.on('error', (e) => { failed = e; for (const w of waiting) w(); waiting.clear(); });
  const wait = (ev) => new Promise((r) => { const done = () => { waiting.delete(done); r(); }; waiting.add(done); out.once(ev, done); });
  return {
    async write(buf) {
      if (failed) throw failed;
      if (!out.write(buf)) await wait('drain');
      if (failed) throw failed;
    },
    async end() {
      if (!failed && !out.writableFinished) await new Promise((r) => { waiting.add(r); out.end(r); });
      if (failed) throw failed;
    }
  };
}

/** Stream a file to disk, reporting progress and hashing as it goes. Resolves to the SHA-512 in base64. */
async function downloadTo(net, url, dest, { size = 0, onProgress = () => {}, signal } = {}) {
  const res = await net.fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const hash = crypto.createHash('sha512');
  const out = safeWriter(dest);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      await out.write(Buffer.from(value));
      onProgress(total ? got / total : 0, got, total);
    }
  } finally {
    await out.end();
  }
  return { sha512: hash.digest('base64'), bytes: got };
}

/* ------------------------------------------------------------------ *
 *  The Mac: only the parts of the zip that changed
 * ------------------------------------------------------------------ */

/*
 * electron-builder writes a .blockmap beside each Mac zip: the zip cut into
 * chunks at places chosen by its content, with a fingerprint for each. Two
 * releases' blockmaps side by side say which chunks of the new zip are the
 * same as chunks of the old one - nearly all of them - and only the rest has
 * to be fetched. The old zip is the one this Mac downloaded last time (kept
 * for exactly this); a Mac that came to its version from the disk image has
 * none, and downloads the whole zip once.
 */

/** A blockmap (gzipped JSON) as {sizes, checksums} for its one file. */
async function fetchBlockmap(net, url) {
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`no blockmap (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 32 * 1024 * 1024) throw new Error('the blockmap is far too big');
  const map = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  const f = map && Array.isArray(map.files) && map.files[0];
  if (!f || !Array.isArray(f.sizes) || !Array.isArray(f.checksums) || f.sizes.length !== f.checksums.length) throw new Error('not a blockmap');
  return { sizes: f.sizes.map(Number), checksums: f.checksums.map(String) };
}

/**
 * The new zip as a list of steps: copy this many bytes from here in the old
 * zip, or fetch this range of the new one. Neighbouring steps are joined.
 */
function deltaPlan(oldMap, newMap) {
  const where = new Map();
  let off = 0;
  for (let i = 0; i < oldMap.sizes.length; i++) {
    const key = `${oldMap.checksums[i]}:${oldMap.sizes[i]}`;
    if (!where.has(key)) where.set(key, off);
    off += oldMap.sizes[i];
  }
  const steps = [];
  let pos = 0, fetch = 0;
  for (let i = 0; i < newMap.sizes.length; i++) {
    const size = newMap.sizes[i];
    if (!(size > 0)) throw new Error('bad blockmap');
    const from = where.get(`${newMap.checksums[i]}:${size}`);
    const last = steps[steps.length - 1];
    if (from !== undefined) {
      if (last && last.copy !== undefined && last.copy + last.size === from) last.size += size;
      else steps.push({ copy: from, size });
    } else {
      fetch += size;
      if (last && last.start !== undefined && last.start + last.size === pos) last.size += size;
      else steps.push({ start: pos, size });
    }
    pos += size;
  }
  // A short run kept between two fetches costs a whole request to save a few kilobytes: fetch it with them.
  const joined = [];
  for (const st of steps) {
    const prev = joined[joined.length - 1], before = joined[joined.length - 2];
    if (st.start !== undefined && prev && prev.copy !== undefined && prev.size <= 65536 && before && before.start !== undefined) {
      joined.pop();
      before.size = st.start + st.size - before.start;
      fetch += prev.size;
      continue;
    }
    if (st.start !== undefined && prev && prev.start !== undefined) { prev.size = st.start + st.size - prev.start; continue; }
    joined.push({ ...st });
  }
  const requests = joined.filter((x) => x.start !== undefined).length;
  return { steps: joined, total: pos, fetch, oldTotal: off, requests };
}

/** Build the new zip from the old one and the fetched ranges, hashing as it goes. Resolves to the SHA-512 in base64. */
async function assembleDelta(net, { oldFile, plan, url, dest, onProgress = () => {} }) {
  const hash = crypto.createHash('sha512');
  const fd = await fsp.open(oldFile, 'r');
  const out = safeWriter(dest);
  const write = async (buf) => { hash.update(buf); await out.write(buf); };
  let got = 0;
  try {
    if ((await fd.stat()).size !== plan.oldTotal) throw new Error('the zip kept from last time is not the one its blockmap describes');
    for (const step of plan.steps) {
      if (step.copy !== undefined) {
        for (let done = 0; done < step.size;) {
          const n = Math.min(4 << 20, step.size - done);
          const buf = Buffer.alloc(n);
          const { bytesRead } = await fd.read(buf, 0, n, step.copy + done);
          if (bytesRead !== n) throw new Error('the zip kept from last time is shorter than expected');
          await write(buf);
          done += n;
        }
      } else {
        const res = await net.fetch(url, { redirect: 'follow', headers: { Range: `bytes=${step.start}-${step.start + step.size - 1}` } });
        if (res.status !== 206) throw new Error(`the server would not send part of the file (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== step.size) throw new Error('the server sent a different part than asked for');
        await write(buf);
        got += buf.length;
        onProgress(plan.fetch ? got / plan.fetch : 1, got, plan.fetch);
      }
    }
  } finally {
    await fd.close();
    await out.end().catch(() => {});
  }
  return { sha512: hash.digest('base64'), bytes: plan.total, fetched: got };
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
    // asked once at every start: a good moment to clear an AppImage update that was never put in place
    try { const m = mode(); if (m.kind === 'appimage' && !ready) await removeStaleAppImageUpdates(m.file); } catch { /* only space */ }
    let note = null;
    try { note = JSON.parse(await fsp.readFile(notePath, 'utf8')); } catch { return null; }
    try { await fsp.unlink(notePath); } catch { /* gone already */ }
    if (!note || !VERSION_RE.test(note.to || '')) return null;
    return { to: note.to, from: note.from, done: app.getVersion() === note.to, kind: note.kind };
  }

  /* The Mac zip kept from the last update, for the next one to be built from. One at a time, never more. */
  const keptDir = () => path.join(path.dirname(notePath), 'update-cache');
  async function readKept() {
    try {
      const info = JSON.parse(await fsp.readFile(path.join(keptDir(), 'kept.json'), 'utf8'));
      const file = path.join(keptDir(), 'kept.zip');
      if (!info || !VERSION_RE.test(info.version || '') || !/^[\w.-]+\.zip$/.test(info.name || '') || !fs.existsSync(file)) return null;
      return { ...info, file };
    } catch { return null; }
  }
  async function keep(zip, info) {
    try {
      await fsp.mkdir(keptDir(), { recursive: true });
      await fsp.rm(path.join(keptDir(), 'kept.json'), { force: true });
      // the zip may be on another disk (the temp folder): a copy, then the original goes
      await fsp.copyFile(zip, path.join(keptDir(), 'kept.zip'));
      await fsp.writeFile(path.join(keptDir(), 'kept.json'), JSON.stringify(info));
    } catch { /* only a smaller download next time is lost */ }
    try { await fsp.unlink(zip); } catch { /* only space */ }
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
    // GAZBOARD_UPDATE_DIFF: the suite's own test of the parts-only download, where a failure must not hide behind a whole download
    if (env.GAZBOARD_UPDATE_TEST && (platform !== process.platform || env.GAZBOARD_UPDATE_DIFF)) u._testOnlyOptions = { platform, isUseDifferentialDownload: !!env.GAZBOARD_UPDATE_DIFF };
    /*
     * After the config path: setting that resets the feed.
     *
     * One part per request. Asked for several parts at once (its default for a
     * plain web address), GitHub answers "501 Unsupported client range", and
     * electron-updater quietly falls back to downloading the whole installer -
     * which is what every Windows update did until 4.7.1: 102 MB where 4 MB
     * had changed. electron-updater's own GitHub setting does exactly this.
     */
    u.setFeedURL({ provider: 'generic', url: `${downloadBase()}/v${version}`, useMultipleRangeRequest: false });
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
    const zipUrl = `${base}/${file.url.split('/').map(encodeURIComponent).join('/')}`;
    let got = null;
    // the zip this Mac came to its present version with, if it was updated in place last time
    const kept = await readKept();
    if (kept && kept.version === app.getVersion() && kept.arch === arch) {
      try {
        const [oldMap, newMap] = await Promise.all([
          fetchBlockmap(net, `${downloadBase()}/v${kept.version}/${encodeURIComponent(kept.name)}.blockmap`),
          fetchBlockmap(net, `${zipUrl}.blockmap`)
        ]);
        const plan = deltaPlan(oldMap, newMap);
        if (file.size && plan.total !== file.size) throw new Error('the blockmap does not describe this zip');
        // so many scattered pieces that asking for each would be slower than one download: just download it
        if (plan.requests > 400 || plan.fetch > file.size * 0.7) throw new Error('not worth it');
        got = await assembleDelta(net, { oldFile: kept.file, plan, url: zipUrl, dest: zip, onProgress });
        if (got.sha512 !== file.sha512) got = null;        // not right: fetch it whole instead
      } catch { got = null; }
    }
    if (!got) got = await downloadTo(net, zipUrl, zip, { size: file.size, onProgress });
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
    // kept for next time, in place of the last one: the zip the next update is built from
    await keep(zip, { version, arch, name: path.basename(file.url) });
    // written now, so that putting it in place on quit needs nothing that can still be in flight
    const script = path.join(work, 'swap.sh');
    await fsp.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
    return { kind: 'mac', version, newApp, work, bundle, script };
  }

  async function downloadAppImage(version, onProgress, file) {
    const name = appImageName(version, arch);
    if (!name) throw new Error('there is no AppImage for this kind of computer');
    const base = `${downloadBase()}/v${version}`;
    const zres = await net.fetch(`${base}/${encodeURIComponent(name)}.zsync`, { redirect: 'follow' });
    if (!zres.ok) throw new Error(`the release has no ${name}.zsync (${zres.status})`);
    const zbuf = Buffer.from(await zres.arrayBuffer());
    if (zbuf.length > 32 * 1024 * 1024) throw new Error('the .zsync is far too big');
    const Z = require('./zsync.js');
    const z = Z.parseZsync(zbuf);
    if (z.filename && z.filename !== name) throw new Error(`the .zsync describes ${z.filename}, not ${name}`);
    await removeStaleAppImageUpdates(file);
    // read with room for zsync's padding after it, so the comparison needs no second copy of a 100 MB file
    const size = (await fsp.stat(file)).size;
    const padded = Buffer.alloc(size + 2 * z.blocksize);
    const fh = await fsp.open(file, 'r');
    try {
      for (let at = 0; at < size;) {
        const { bytesRead } = await fh.read(padded, at, size - at, at);
        if (!bytesRead) throw new Error('could not read the AppImage that is running');
        at += bytesRead;
      }
    } finally { await fh.close(); }
    onProgress(0, 0, 0);
    const got = await Z.assemble({ zsync: zbuf, local: padded.subarray(0, size), padded, url: `${base}/${encodeURIComponent(name)}`, fetch: (u, init) => net.fetch(u, init), onProgress });
    // beside the old one, so the rename that puts it in place cannot cross from one disk to another
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.update-${version}`);
    try {
      await fsp.writeFile(temp, got.data, { mode: 0o755 });
      if ((await fsp.stat(temp)).size !== z.length) throw new Error('short');
      await fsp.chmod(temp, 0o755);
    } catch (e) {
      await fsp.unlink(temp).catch(() => {});
      throw new Error(`the update could not be written beside GazBoard (${e.code || e.message}) - nothing was changed`);
    }
    return { kind: 'appimage', version, file, temp, downloaded: got.downloaded, whole: got.whole };
  }

  /** An update downloaded but never put in place (GazBoard was closed first, or a newer one came): it only takes space. */
  async function removeStaleAppImageUpdates(file, except = null) {
    const dir = path.dirname(file), prefix = `.${path.basename(file)}.update-`;
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const n of names) if (n.startsWith(prefix) && path.join(dir, n) !== except) await fsp.unlink(path.join(dir, n)).catch(() => {});
  }

  /** Put the new AppImage where the old one is, under the same name. The running copy keeps going from the old one. */
  async function placeAppImage() {
    if (ready.placed) return;
    await fsp.rename(ready.temp, ready.file);
    ready.placed = true;
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
      busy = (m.kind === 'win' ? downloadWin(version, onProgress)
        : m.kind === 'appimage' ? downloadAppImage(version, onProgress, m.file)
        : downloadMac(version, onProgress, m.bundle));
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
      if (ready.kind === 'appimage') {
        try { await placeAppImage(); }
        catch (e) { await fsp.unlink(notePath).catch(() => {}); return { ok: false, error: `the new version could not be put in place: ${e.message}` }; }
        if (!now) return { ok: true, later: true };       // already in place: the next start is the new version
        const flags = process.argv.slice(1).filter((a) => /^--/.test(a));
        const child = spawn('/bin/sh', ['-c', APPIMAGE_RESTART, 'gazboard-restart', String(process.pid), ready.file, ...flags],
          { detached: true, stdio: 'ignore', env: cleanAppImageEnv(env) });
        child.unref();
        app.quit();
        return { ok: true };
      }
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

module.exports = { createUpdater, installMode, macBundle, parseLatestYml, pickMacZip, downloadTo, SWAP_SCRIPT, appImageName, cleanAppImageEnv, APPIMAGE_RESTART, fetchBlockmap, deltaPlan, assembleDelta };
