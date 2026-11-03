'use strict';
// The Play upload: a tagged Android release hands its bundle to Google Play as
// a DRAFT, by itself. These checks run scripts/play-upload.js against a stand-in
// for Google's servers on this machine - one that checks the robot's signature
// with the real public key - so the whole conversation is tested without a
// Play account, a network or a key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'play-upload.js');
const { playNotes, upload } = require(SCRIPT);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** A pretend Google: token endpoint plus the few Play calls the script makes. Records everything. */
function fakeGoogle({ existing = [], bundleCode = null } = {}) {
  const log = [];
  const state = { edits: new Map(), committed: null, deleted: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      log.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '', type: req.headers['content-type'] || '', size: body.length });
      if (url.pathname === '/token') {
        const assertion = new URLSearchParams(body.toString()).get('assertion') || '';
        const [h, c, s] = assertion.split('.');
        const ok = !!s && crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
        const claims = ok ? JSON.parse(Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) : {};
        state.claims = claims;
        return ok ? send(200, { access_token: 'tok-123', expires_in: 3600 }) : send(400, { error: 'invalid_grant', error_description: 'bad signature' });
      }
      if (req.headers.authorization !== 'Bearer tok-123') return send(401, { error: { message: 'no token' } });
      const base = '/androidpublisher/v3/applications/com.gazboard.app';
      let m;
      if (req.method === 'POST' && url.pathname === `${base}/edits`) { const id = 'e' + (state.edits.size + 1); state.edits.set(id, {}); return send(200, { id }); }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/upload\/androidpublisher\/v3\/applications\/com\.gazboard\.app\/edits\/(\w+)\/bundles$/))) {
        state.uploaded = { edit: m[1], size: body.length, media: url.searchParams.get('uploadType') };
        return send(200, { versionCode: bundleCode, sha256: 'x' });
      }
      if (req.method === 'GET' && (m = url.pathname.match(/\/edits\/(\w+)\/tracks\/(\w+)$/))) return send(200, { track: m[2], releases: existing });
      if (req.method === 'PUT' && (m = url.pathname.match(/\/edits\/(\w+)\/tracks\/(\w+)$/))) { state.put = { track: m[2], body: JSON.parse(body.toString()) }; return send(200, state.put.body); }
      if (req.method === 'POST' && (m = url.pathname.match(/\/edits\/(\w+):commit$/))) { state.committed = m[1]; return send(200, { id: m[1] }); }
      if (req.method === 'DELETE' && (m = url.pathname.match(/\/edits\/(\w+)$/))) { state.deleted.push(m[1]); res.writeHead(204); return res.end(); }
      send(404, { error: { message: `no such call: ${req.method} ${url.pathname}` } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const api = `http://127.0.0.1:${server.address().port}`;
    resolve({ api, log, state, close: () => new Promise((r) => server.close(r)), key: { client_email: 'robot@gazboard-play.iam.gserviceaccount.com', private_key: PEM, token_uri: `${api}/token` } });
  }));
}

function scratchBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-play-'));
  const aab = path.join(dir, 'GazBoard-4.12.0-android-v3.aab');
  fs.writeFileSync(aab, crypto.randomBytes(4096));
  return aab;
}

test('the Play notes are the release\'s feature names, under Play\'s 500-character limit', () => {
  const md = read('release-notes/4.12.0.md');
  const notes = playNotes(md, '4.12.0');
  assert.ok(notes.length <= 500, `notes are ${notes.length} characters (Play allows 500): ${notes}`);
  for (const want of ['Board replay', 'Formula graphs', 'Spotlight', 'Spinner wheel'])
    assert.ok(notes.includes(want), `"${want}" is missing from the Play notes: ${notes}`);
  assert.ok(notes.startsWith("What's new in 4.12.0: "), `notes start: ${notes.slice(0, 40)}`);
  const long = Array.from({ length: 80 }, (_, i) => `**Feature number ${i} with a long name:** text`).join('\n\n');
  const cut = playNotes(long, '9.9.9');
  assert.ok(cut.length <= 500 && /and more\.$/.test(cut), `a very long list is cut to fit and says "and more": ${cut.length} characters, ends "${cut.slice(-30)}"`);
  const none = playNotes('', '9.9.9');
  assert.ok(none.length <= 500 && none.includes('9.9.9'), `with no notes file it still says the version: ${none}`);
});

test('a tagged release goes to Play as a draft on the closed test, keeping what testers have now and replacing an older draft', async () => {
  const g = await fakeGoogle({
    bundleCode: 4120003,
    existing: [
      { name: '4.12.0 (4120000)', versionCodes: ['4120000'], status: 'completed' },
      { name: '4.12.0 (4120002)', versionCodes: ['4120002'], status: 'draft' }
    ]
  });
  try {
    const aab = scratchBundle();
    const done = await upload({ key: g.key, aab, version: '4.12.0', code: 4120003, track: 'alpha', notes: 'n', api: g.api });
    const put = g.state.put;
    const calls = g.log.map((l) => `${l.method} ${l.path}`).join(' | ');
    assert.equal(g.state.claims.iss, g.key.client_email, `the token was asked for as ${g.state.claims.iss}`);
    assert.equal(g.state.claims.scope, 'https://www.googleapis.com/auth/androidpublisher', `token scope ${g.state.claims.scope}`);
    assert.ok(g.state.uploaded && g.state.uploaded.size === 4096 && g.state.uploaded.media === 'media', `bundle upload: ${JSON.stringify(g.state.uploaded)}; calls: ${calls}`);
    assert.ok(put && put.track === 'alpha', `track written: ${JSON.stringify(put)}`);
    const rel = put.body.releases;
    assert.deepEqual(rel.map((r) => `${r.versionCodes[0]}:${r.status}`), ['4120000:completed', '4120003:draft'],
      `releases on the track afterwards: ${JSON.stringify(rel)} (wanted the testers' release kept, the old draft gone, the new one as a draft)`);
    assert.equal(rel[1].releaseNotes[0].language, 'en-US', `notes language ${JSON.stringify(rel[1].releaseNotes)}`);
    assert.equal(g.state.committed, done.edit, `committed edit ${g.state.committed}, made ${done.edit}`);
    assert.equal(done.replacedDrafts, 1, `replaced ${done.replacedDrafts} draft(s)`);
    assert.ok(g.log.filter((l) => l.path !== '/token').every((l) => l.auth === 'Bearer tok-123'), `every Play call carries the token: ${JSON.stringify(g.log)}`);
  } finally { await g.close(); }
});

test('if Play reads a different version from the bundle, nothing is committed and the edit is let go', async () => {
  const g = await fakeGoogle({ bundleCode: 4120001 });
  try {
    const aab = scratchBundle();
    await assert.rejects(upload({ key: g.key, aab, version: '4.12.0', code: 4120003, track: 'alpha', notes: 'n', api: g.api }),
      (e) => /version code 4120001.*not 4120003/.test(e.message) || assert.fail(`unexpected error: ${e.message}`));
    assert.equal(g.state.committed, null, `an edit was committed: ${g.state.committed}`);
    assert.deepEqual(g.state.deleted, ['e1'], `edits deleted: ${JSON.stringify(g.state.deleted)} (wanted the open one let go)`);
    assert.equal(g.state.put, undefined, `the track was changed: ${JSON.stringify(g.state.put)}`);
  } finally { await g.close(); }
});

test('a key Google does not accept is reported in plain words, with Google\'s reason', async () => {
  const g = await fakeGoogle({ bundleCode: 4120003 });
  try {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const aab = scratchBundle();
    await assert.rejects(upload({ key: { ...g.key, private_key: other }, aab, version: '4.12.0', code: 4120003, track: 'alpha', notes: 'n', api: g.api }),
      (e) => /refused the robot's key \(400\): bad signature/.test(e.message) || assert.fail(`unexpected error: ${e.message}`));
    assert.equal(g.state.uploaded, undefined, `a bundle was uploaded with a bad key: ${JSON.stringify(g.state.uploaded)}`);
  } finally { await g.close(); }
});

const runScript = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) =>
    resolve({ code: err ? err.code : 0, out: stdout + stderr }));
});

test('with no Play key set up, the step says so and does not fail the release', async () => {
  const r = await runScript(['play/none.aab', '4.12.0', '4120003'], { PLAY_SERVICE_ACCOUNT_JSON: '' });
  assert.equal(r.code, 0, `exit code ${r.code}; output: ${r.out}`);
  assert.match(r.out, /No PLAY_SERVICE_ACCOUNT_JSON secret/, `output: ${r.out}`);
});

test('a secret that is not the key file is named as the problem, not a crash', async () => {
  const aab = scratchBundle();
  const bad = await runScript([aab, '4.12.0', '4120003'], { PLAY_SERVICE_ACCOUNT_JSON: 'not json' });
  assert.ok(bad.code !== 0 && /not valid JSON/.test(bad.out), `exit ${bad.code}; output: ${bad.out}`);
  const wrong = await runScript([aab, '4.12.0', '4120003'], { PLAY_SERVICE_ACCOUNT_JSON: '{"type":"something else"}' });
  assert.ok(wrong.code !== 0 && /no client_email or private_key/.test(wrong.out), `exit ${wrong.code}; output: ${wrong.out}`);
});

test('the whole script, end to end, against the stand-in Google', async () => {
  const g = await fakeGoogle({ bundleCode: 4120003, existing: [] });
  try {
    const aab = scratchBundle();
    const r = await runScript([aab, '4.12.0', '4120003'], { PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(g.key), PLAY_API_BASE: g.api, PLAY_TRACK: '' });
    assert.equal(r.code, 0, `exit code ${r.code}; output: ${r.out}`);
    assert.ok(g.state.put && g.state.put.track === 'alpha', `an empty PLAY_TRACK means the closed test: ${JSON.stringify(g.state.put)}`);
    assert.match(r.out, /waiting as a draft on "alpha"/, `output: ${r.out}`);
    assert.ok(!r.out.includes('PRIVATE KEY'), 'the key must never be printed');
  } finally { await g.close(); }
});

test('the workflow sends the bundle only for tags, after the GitHub release, with the key from a secret', () => {
  const yml = read('.github/workflows/android-release.yml');
  const at = (s) => yml.indexOf(s);
  const step = yml.slice(at('- name: Send the bundle to Google Play as a draft'));
  assert.ok(at('- name: Send the bundle to Google Play as a draft') > at('- name: Publish the release'), 'the Play step must come after the GitHub release');
  assert.match(step, /if: github\.ref_type == 'tag'/, `the Play step runs on manual runs too:\n${step.slice(0, 400)}`);
  assert.match(step, /PLAY_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.PLAY_SERVICE_ACCOUNT_JSON \}\}/, `the key is not taken from the secret:\n${step.slice(0, 600)}`);
  assert.match(step, /node scripts\/play-upload\.js "play\/\$AAB_NAME" "\$VERSION" "\$CODE"/, `the step does not run the script on the Play bundle:\n${step.slice(0, 800)}`);
  assert.ok(!/uses: .*upload-google-play/.test(yml), 'no third-party action handles the key');
});
