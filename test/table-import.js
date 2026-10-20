'use strict';

async function checkTables(win, check) {
  const results = await win.webContents.executeJavaScript(`(async () => {
    const { Store, validTableSize } = await import('app://board/js/core/store.js');
    const { drawTable } = await import('app://board/js/core/render.js');
    const { buildSvg, linkedSources } = await import('app://board/js/export.js');
    const results = [];
    const table = { id: 'table', type: 'table', x: 0, y: 0, w: 100, h: 100, rows: 3, cols: 3, cells: {} };
    const board = objects => ({ id: 'table-test', name: 'Table test', objects, pages: [] });
    const invalid = [JSON.parse('1e309'), -Infinity, NaN, 0, -1, 1.5, 41, 1000000000, '3', null, undefined];
    for (const axis of ['rows', 'cols']) for (const value of invalid) {
      const label = axis + '=' + String(value);
      const bad = { ...table, [axis]: value };
      const store = new Store();
      store.add({ id: 'keep', type: 'note', text: 'Keep my work' });
      const previous = store.doc, rev = store.rev, undo = store.undoStack.length;
      let rejected = false;
      try { store.load(board([table, bad])); } catch { rejected = true; }
      results.push(['rejects table import ' + label, rejected && store.doc === previous && store.rev === rev && store.undoStack.length === undo]);
      let calls = 0;
      const ctx = new Proxy({}, { get: () => () => { if (++calls > 400) throw Error('Unbounded drawing'); } });
      try { drawTable(ctx, bad); } catch {}
      results.push(['canvas skips invalid table ' + label, calls === 0]);
      // On a broken implementation, do not let the SVG loop hang the test runner.
      if (typeof validTableSize === 'function' && !validTableSize(bad)) {
        const svg = buildSvg({ store: { doc: { background: {} }, objects: [bad] } }, { x: 0, y: 0, w: 100, h: 100 });
        results.push(['SVG skips invalid table ' + label, !svg.includes('<line ')]);
      }
    }
    for (const [rows, cols] of [[1, 1], [3, 3], [40, 40]]) {
      const good = { ...table, rows, cols };
      const store = new Store();
      store.load(board([good]));
      const ctx = document.createElement('canvas').getContext('2d');
      drawTable(ctx, store.objects[0]);
      const svg = buildSvg({ store }, { x: 0, y: 0, w: 100, h: 100 });
      results.push(['valid table loads, draws and exports ' + rows + 'x' + cols, (svg.match(/<line /g) || []).length === rows + cols + 2]);
      const reopened = new Store(); reopened.load(JSON.parse(JSON.stringify(store.toJSON())));
      results.push(['valid table survives save/reopen ' + rows + 'x' + cols, reopened.objects[0].rows === rows && reopened.objects[0].cols === cols]);
    }
    for (const field of ['objectList', 'objects']) {
      const store = new Store();
      let rejected = false;
      try { store.load({ [field]: field === 'objects' ? { table: { ...table, rows: Infinity } } : [{ ...table, cols: Infinity }] }); } catch { rejected = true; }
      results.push(['legacy ' + field + ' import rejects invalid tables', rejected]);
    }
    const a = window.app, previous = a.store.doc;
    let rejected = false;
    try { await a.loadBoard(board([{ ...table, cols: JSON.parse('1e309') }]), { claimed: true, silent: true }); } catch { rejected = true; }
    results.push(['app rejects malformed import and keeps the open board', rejected && a.store.doc === previous]);
    if (rejected) { a.surface.draw(); results.push(['editor still draws after rejecting the import', true]); }
    const id = 'table-invalid-' + Date.now();
    try {
      await window.board.boards.save({ ...board([{ ...table, cols: 41 }]), id });
      const sources = await linkedSources(a, [id]);
      results.push(['linked export skips a board with invalid tables', sources.length === 0]);
    } finally { await window.board.boards.remove(id); }
    return results;
  })()`, true);
  for (const [name, ok] of results) check(name, ok);
}

exports.checkTables = checkTables;
exports.run = async (win, app) => {
  let failed = 0;
  try {
    await checkTables(win, (name, ok) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name); });
  } catch (e) { failed++; console.error(e); }
  app.exit(failed ? 1 : 0);
};
