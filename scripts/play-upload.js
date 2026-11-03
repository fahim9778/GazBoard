#!/usr/bin/env node
'use strict';
/*
 * Hands a release's Play bundle (.aab) to Google Play as a DRAFT.
 *
 *   node scripts/play-upload.js <bundle.aab> <version> <versionCode>
 *
 * Run by the Android release workflow after a tag has built. The bundle lands
 * on a Play track (PLAY_TRACK, "alpha" - the closed test - unless the
 * repository variable says otherwise) as a draft, with short release notes
 * made from release-notes/<version>.md. Nothing reaches anyone until a person
 * presses "Send for review" in Play Console: a second tag a couple of hours
 * later simply replaces the waiting draft, so a busy day costs one review,
 * not one per tag.
 *
 * The robot's key comes from PLAY_SERVICE_ACCOUNT_JSON (a repository secret).
 * With no key this says so and does nothing, so the workflow keeps working for
 * forks and before the key is set up.
 *
 * Only Node's own fetch and crypto are used. The key never passes through
 * anyone else's code.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PACKAGE = 'com.gazboard.app';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const NOTES_MAX = 500;            // Play's limit per language

/** Short Play notes from the release's own notes: the feature names, under 500 characters. */
function playNotes(md, version) {
  const names = [];
  for (const line of (md || '').split(/\r?\n/)) {
    const m = line.match(/^\*\*(.+?)[:：]?\*\*/);
    if (m) names.push(m[1].replace(/[:：]\s*$/, '').trim());
  }
  const head = `What's new in ${version}: `;
  if (!names.length) return `GazBoard ${version}. Full notes: https://github.com/fahim9778/GazBoard/releases`;
  let text = head;
  for (let i = 0; i < names.length; i++) {
    const piece = (i ? ', ' : '') + names[i];
    if ((text + piece + '.').length > NOTES_MAX) { text += ', and more'; break; }
    text += piece;
  }
  text += '.';
  return text.length > NOTES_MAX ? text.slice(0, NOTES_MAX - 1) + '…' : text;
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A one-hour access token for the robot, from its key. */
async function accessToken(key, now = Math.floor(Date.now() / 1000)) {
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google refused the robot's key (${res.status}): ${body.error_description || body.error || 'no reason given'}`);
  return body.access_token;
}

/** Upload, set the track's draft, commit. Returns what was done, for the log. */
async function upload({ key, aab, version, code, track, notes, api = 'https://androidpublisher.googleapis.com' }) {
  const token = await accessToken(key);
  const base = `${api}/androidpublisher/v3/applications/${PACKAGE}`;
  const call = async (method, url, body, type = 'application/json') => {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': type } : {}) },
      body: body === undefined ? undefined : (type === 'application/json' ? JSON.stringify(body) : body)
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) throw new Error(`${method} ${url.replace(api, '')} failed (${res.status}): ${(json.error && json.error.message) || text.slice(0, 300)}`);
    return json;
  };

  const edit = await call('POST', `${base}/edits`, {});
  try {
    const bundle = await call('POST', `${api}/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${edit.id}/bundles?uploadType=media`,
      fs.readFileSync(aab), 'application/octet-stream');
    if (String(bundle.versionCode) !== String(code)) throw new Error(`Play read version code ${bundle.versionCode} from the bundle, not ${code}`);
    // keep the track's other releases (the one testers have now); only an older draft is replaced
    const current = await call('GET', `${base}/edits/${edit.id}/tracks/${track}`);
    const kept = (current.releases || []).filter((r) => r.status !== 'draft');
    const draft = { name: `${version} (${code})`, versionCodes: [String(code)], status: 'draft', releaseNotes: [{ language: 'en-US', text: notes }] };
    await call('PUT', `${base}/edits/${edit.id}/tracks/${track}`, { track, releases: [...kept, draft] });
    await call('POST', `${base}/edits/${edit.id}:commit`);
    return { edit: edit.id, track, versionCode: bundle.versionCode, replacedDrafts: (current.releases || []).length - kept.length };
  } catch (e) {
    // an edit left open blocks the next one: let it go
    await call('DELETE', `${base}/edits/${edit.id}`).catch(() => {});
    throw e;
  }
}

async function main() {
  const [aab, version, code] = process.argv.slice(2);
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON || '';
  if (!raw.trim()) { console.log('No PLAY_SERVICE_ACCOUNT_JSON secret: the Play bundle stays in this run\'s artifacts for uploading by hand.'); return; }
  if (!aab || !version || !code) throw new Error('usage: play-upload.js <bundle.aab> <version> <versionCode>');
  if (!fs.existsSync(aab)) throw new Error(`no bundle at ${aab}`);
  let key;
  try { key = JSON.parse(raw); } catch { throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON - paste the whole .json key file into the secret'); }
  if (!key.client_email || !key.private_key) throw new Error('PLAY_SERVICE_ACCOUNT_JSON has no client_email or private_key - is it the service account key file?');
  const track = (process.env.PLAY_TRACK || 'alpha').trim();
  const notesFile = path.join(__dirname, '..', 'release-notes', `${version}.md`);
  const notes = playNotes(fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '', version);
  console.log(`Uploading ${path.basename(aab)} (version code ${code}) to the Play track "${track}" as a draft`);
  console.log(`Play notes (${notes.length} characters): ${notes}`);
  const done = await upload({ key, aab, version, code, track, notes, api: process.env.PLAY_API_BASE || undefined });
  console.log(`Done: version code ${done.versionCode} is waiting as a draft on "${done.track}"${done.replacedDrafts ? ` (it replaced ${done.replacedDrafts} older draft)` : ''}. Send it for review in Play Console → Publishing overview.`);
}

if (require.main === module) main().catch((e) => { console.error(`::error::Google Play upload: ${e.message}`); process.exit(1); });
module.exports = { playNotes, accessToken, upload };
