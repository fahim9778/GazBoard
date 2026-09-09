'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// The browser bundle lives under src's ES-module package; load its UMD export
// as CommonJS here, using exactly the same ZIP implementation as the app.
const zipModule = { exports: {} };
new Function('module', 'exports', 'require', require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../src/vendor/jszip.min.js'), 'utf8'))(zipModule, zipModule.exports, require);
const JSZip = zipModule.exports;

async function setup(cancel = false) {
  const saved = { id: 'saved', name: 'Lesson', origin: '/private/source', objects: [{ type: 'image', src: 'asset:picture' }] };
  const current = { id: 'current', name: 'Lesson', objects: [{ type: 'text', text: 'Latest unsaved edit বাংলা' }] };
  const writes = [], reads = [];
  global.window = { JSZip, board: {
    boards: { load: async (id) => { reads.push(id); return id === saved.id ? saved : null; } },
    saveDialog: async (options) => cancel ? null : options.defaultPath,
    writeFile: async (path, bytes) => { writes.push({ path, bytes }); }
  } };
  const app = {
    store: { doc: current, toJSON: () => current },
    commitTextEdit() {}, toast() {},
    resolveAssets: async (doc) => ({ ...doc, objects: doc.objects.map((o) => o.src === 'asset:picture'
      ? { ...o, src: 'data:image/png;base64,cGljdHVyZQ==' } : o) })
  };
  const { exportBoards } = await import('../src/js/board-export.js');
  return { app, saved, current, writes, reads, exportBoards };
}

test('Only the chosen saved board is exported, with inline images and no private origin', async () => {
  const { app, saved, current, writes, reads, exportBoards } = await setup();
  await exportBoards(app, ['saved']);
  assert.deepEqual(reads, ['saved']);
  assert.equal(app.store.doc, current);
  const doc = JSON.parse(new TextDecoder().decode(writes[0].bytes));
  assert.equal(doc.id, 'saved');
  assert.equal(doc.origin, undefined);
  assert.equal(doc.objects[0].src, 'data:image/png;base64,cGljdHVyZQ==');
  assert.equal(saved.objects[0].src, 'asset:picture');
});

test('Several chosen boards become a ZIP with distinct names and current unsaved edits', async () => {
  const { app, current, writes, exportBoards } = await setup();
  await exportBoards(app, ['saved', 'current', 'saved']);
  const zip = await JSZip.loadAsync(writes[0].bytes);
  assert.deepEqual(Object.keys(zip.files), ['Lesson.gazboard', 'Lesson (2).gazboard']);
  assert.equal(JSON.parse(await zip.file('Lesson (2).gazboard').async('string')).objects[0].text, 'Latest unsaved edit বাংলা');
  assert.equal(app.store.doc, current);
});

test('No selection, cancellation and a missing board never write a partial export', async () => {
  const { app, writes, exportBoards } = await setup(true);
  assert.equal(await exportBoards(app, []), null);
  assert.equal(await exportBoards(app, ['saved']), null);
  await assert.rejects(exportBoards(app, ['missing']), /no longer available/);
  assert.equal(writes.length, 0);
});
