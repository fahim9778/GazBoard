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
  fs.writeFileSync(path.join(folder, 'one.json'), JSON.stringify({ id: 'one', name: 'One', objects: [] }));
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'someone else', version: '1.0.0' }));
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
  // a read-only folder can only be made where permissions are enforced: not for root, and not on Windows
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const readOnly = path.join(root, 'read-only');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o555);
  try { assert.equal(Storage.validateBoardsDir(readOnly).ok, false); }
  finally { fs.chmodSync(readOnly, 0o755); }
});

test('a picked folder gets a GazBoard folder of its own, unless it already is one', () => {
  const docs = path.resolve('/home/me/Documents');
  assert.equal(Storage.boardsFolderFor(docs), path.join(docs, 'GazBoard'), 'Documents -> Documents/GazBoard');
  assert.equal(Storage.boardsFolderFor(path.join(docs, 'GazBoard')), path.join(docs, 'GazBoard'),
    'picking the GazBoard folder itself (or the same place on a second computer) lands on the same boards');
  assert.equal(Storage.boardsFolderFor(path.join(docs, 'gazboard')), path.join(docs, 'gazboard'), 'whatever the capitals');
});

test('only GazBoard boards count as boards; other programs\' .json files are left alone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gazboard-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const verdicts = {
    board: Storage.isBoardFile({ id: 'b1', name: 'Week 5', objects: [] }),
    oldBoard: Storage.isBoardFile({ name: 'Old', background: {}, objects: [] }),
    packageJson: Storage.isBoardFile({ name: 'my-project', version: '1.0.0' }),
    notes: Storage.isBoardFile({ title: 'Shopping', items: ['milk'] }),
    list: Storage.isBoardFile([1, 2]),
    nothing: Storage.isBoardFile(null)
  };
  assert.deepEqual(verdicts, { board: true, oldBoard: true, packageJson: false, notes: false, list: false, nothing: false },
    `verdicts: ${JSON.stringify(verdicts)}`);
  fs.writeFileSync(path.join(root, 'b1.json'), JSON.stringify({ id: 'b1', name: 'Week 5', objects: [] }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'my-project' }));
  fs.writeFileSync(path.join(root, 'broken.json'), '{ not json');
  assert.equal(Storage.countBoards(root), 1, `counted ${Storage.countBoards(root)} in ${fs.readdirSync(root).join(', ')}`);
});
