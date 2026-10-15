'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Storage = require('../storage-location.js');

test('storage config defaults when missing and persists an absolute custom folder', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gazboard-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(Storage.readConfig(root), null);
  const boards = path.join(root, 'Nextcloud', 'GazBoard');
  Storage.writeConfig(root, boards);
  assert.deepEqual(Storage.readConfig(root), { version: 1, boardsDir: boards });
  assert.equal(Storage.defaultBoardsDir(root), path.join(root, 'boards'));
});

test('validation creates a writable folder and reports existing board files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gazboard-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'custom');
  const result = Storage.validateBoardsDir(folder, { currentDir: path.join(root, 'boards'), appPath: path.join(root, 'app') });
  assert.equal(result.ok, true);
  assert.equal(result.isEmpty, true);
  assert.equal(fs.readdirSync(folder).length, 0, 'write probe is removed');
  fs.writeFileSync(path.join(folder, 'one.json'), '{}');
  assert.deepEqual(
    (({ ok, isEmpty, existingBoards }) => ({ ok, isEmpty, existingBoards }))(Storage.validateBoardsDir(folder)),
    { ok: true, isEmpty: false, existingBoards: 1 }
  );
});

test('validation rejects files, non-absolute paths, app folders, and overlapping boards folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gazboard-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const current = path.join(root, 'boards');
  fs.mkdirSync(app);
  fs.mkdirSync(current);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'x');
  assert.equal(Storage.validateBoardsDir('relative/path').ok, false);
  assert.equal(Storage.validateBoardsDir(file).ok, false);
  assert.equal(Storage.validateBoardsDir(path.join(app, 'data'), { appPath: app }).ok, false);
  assert.equal(Storage.validateBoardsDir(path.join(current, 'nested'), { currentDir: current }).ok, false);
  assert.equal(Storage.validateBoardsDir(root, { currentDir: current }).ok, false);
  assert.equal(Storage.validateBoardsDir(path.join(current, 'nested'), { protectedDir: current }).ok, false);
  assert.equal(Storage.validateBoardsDir(current, { protectedDir: current }).ok, true);
  assert.equal(Storage.validateBoardsDir(current, { currentDir: current }).ok, true);
});

test('startup validation does not create a missing folder and rejects paths that cannot be created', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gazboard-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, 'not-mounted');
  assert.equal(Storage.validateBoardsDir(missing, { create: false }).ok, false);
  assert.equal(fs.existsSync(missing), false);
  const readOnly = path.join(root, 'read-only');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o555);
  try { assert.equal(Storage.validateBoardsDir(readOnly).ok, false); }
  finally { fs.chmodSync(readOnly, 0o755); }
});
