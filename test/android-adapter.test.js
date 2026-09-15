'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function setup(handler) {
  const windowHandlers = new Map();
  const documentHandlers = new Map();
  global.window = {
    app: { selected: [], clipboard: [] },
    addEventListener(type, fn) { windowHandlers.set(type, fn); },
    dispatchEvent() {}
  };
  global.document = {
    documentElement: { dataset: {} },
    addEventListener(type, fn) { documentHandlers.set(type, fn); }
  };
  const calls = [];
  const native = {
    postMessage(text) {
      const request = JSON.parse(text);
      calls.push(request);
      queueMicrotask(async () => {
        try {
          const result = await handler(request);
          native.onmessage({ data: JSON.stringify({ id: request.id, result }) });
        } catch (e) { native.onmessage({ data: JSON.stringify({ id: request.id, error: e.message }) }); }
      });
    }
  };
  const { createAndroidAdapter } = await import('../src/js/platform/android-adapter.js');
  return { adapter: createAndroidAdapter(native), calls, native, windowHandlers, documentHandlers };
}

test('Pairing and send preserve the preload API and surface native errors', async () => {
  const { adapter, calls } = await setup(({ method, args }) => {
    if (method === 'sync:pairWith') return { ok: true, device: args.peer };
    throw new Error('Device is offline');
  });
  const peer = { deviceId: 'desktop', address: '192.168.1.8' };
  assert.deepEqual(await adapter.sync.pairWith(peer, 'ABCD-2345'), { ok: true, device: peer });
  assert.deepEqual(calls[0].args, { peer, code: 'ABCD-2345' });
  assert.deepEqual(await adapter.sync.send(peer, {}), { ok: false, error: 'Device is offline' });
});

test('Large Unicode boards cross bounded binary chunks without losing characters', async () => {
  const chunks = [];
  const token = 'a'.repeat(32);
  let saved;
  const { adapter, calls } = await setup(({ method, args, argsFile }) => {
    if (method === 'blob:begin') return { token };
    if (method === 'blob:append') {
      assert.equal(args.offset, chunks.reduce((sum, part) => sum + part.length, 0));
      chunks.push(Buffer.from(args.data, 'base64'));
    }
    if (method === 'boards:save') {
      assert.equal(argsFile, token);
      saved = JSON.parse(Buffer.concat(chunks).toString());
    }
    return true;
  });
  const board = { id: 'lesson', json: JSON.stringify({ id: 'lesson', name: 'বাংলা 🖊️'.repeat(30000), objects: [] }) };
  assert.equal(await adapter.boards.save(board), true);
  assert.deepEqual(saved, board);
  assert.ok(calls.every((request) => JSON.stringify(request).length < 140000));
  assert.equal(calls.at(-1).method, 'blob:release');
});

test('File writes preserve typed-array offsets and cancellation returns no path', async () => {
  const chunks = [];
  const token = 'b'.repeat(32);
  const { adapter } = await setup(({ method, args }) => {
    if (method === 'blob:begin') return { token };
    if (method === 'blob:append') chunks.push(Buffer.from(args.data, 'base64'));
    if (method === 'dialog:save') return null;
    return true;
  });
  await adapter.writeFile('file', new Uint8Array([9, 1, 2, 8]).subarray(1, 3));
  assert.deepEqual([...Buffer.concat(chunks)], [1, 2]);
  assert.equal(await adapter.saveDialog({}), null);
});

test('Flush acknowledgement follows the completed persistence callback', async () => {
  const order = [];
  const { adapter, native } = await setup(({ method }) => { order.push(method); return true; });
  adapter.onFlush(async () => { await Promise.resolve(); order.push('saved'); });
  await native.onmessage({ data: JSON.stringify({ event: 'flush', result: { ticket: 'flush1' } }) });
  assert.deepEqual(order, ['saved', 'app:flushed']);
});

test('Android keyboard paste keeps GazBoard objects until the system clipboard changes', async () => {
  const { adapter, native, windowHandlers } = await setup(() => true);
  const commands = [];
  adapter.onMenu((id) => commands.push(id));
  window.app.selected = [{ id: 'a' }, { id: 'b' }];

  const keydown = windowHandlers.get('keydown');
  assert.equal(typeof keydown, 'function');
  const key = (value, target = { tagName: 'CANVAS', isContentEditable: false }) => {
    let prevented = false;
    let stopped = false;
    const e = {
      key: value, ctrlKey: true, metaKey: false, altKey: false, target,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; }
    };
    keydown(e);
    return { prevented, stopped };
  };

  let e = key('c');
  assert.deepEqual(commands, ['edit.copy']);
  assert.ok(e.prevented && e.stopped);

  e = key('v');
  assert.deepEqual(commands, ['edit.copy', 'edit.paste']);
  assert.ok(e.prevented && e.stopped);

  // Touch/menu Copy reaches App directly rather than the key handler. A real
  // board clipboard must still make a later hardware-keyboard paste work.
  window.app.clipboard = [{ id: 'touch-copy' }];
  e = key('v');
  assert.deepEqual(commands, ['edit.copy', 'edit.paste', 'edit.paste']);
  assert.ok(e.prevented && e.stopped);

  await native.onmessage({ data: JSON.stringify({ event: 'clipboardChanged', result: null }) });
  assert.deepEqual(window.app.clipboard, [], 'newer Android clipboard clears the stale object copy');
  e = key('v');
  assert.deepEqual(commands, ['edit.copy', 'edit.paste', 'edit.paste']);
  assert.ok(!e.prevented && !e.stopped, 'newer system clipboard must fall through to WebView paste');

  e = key('c', { tagName: 'TEXTAREA', isContentEditable: false });
  assert.deepEqual(commands, ['edit.copy', 'edit.paste', 'edit.paste']);
  assert.ok(!e.prevented && !e.stopped, 'text editing keeps native clipboard behavior');

  window.app.selected = [];
  e = key('c');
  assert.deepEqual(commands, ['edit.copy', 'edit.paste', 'edit.paste']);
  assert.ok(!e.prevented && !e.stopped, 'copy with no GazBoard selection must not steal the system clipboard');
});

test('Holding blank Android board space opens the Paste context menu without leaving a gesture behind', async () => {
  const { windowHandlers } = await setup(() => true);
  const canvas = { id: 'c' };
  let cancelled = 0;
  let selectionCleared = 0;
  let menuAt = null;
  window.app = {
    selected: [],
    clipboard: [{ id: 'note-copy' }],
    surface: {
      canvas,
      toWorld: ({ clientX, clientY }) => ({ x: clientX, y: clientY })
    },
    pickAt: () => null,
    interaction: { cancelGesture() { cancelled++; return true; } },
    setSelection(ids) { assert.deepEqual(ids, []); selectionCleared++; },
    showContextMenu(e) { menuAt = { x: e.clientX, y: e.clientY }; }
  };

  const down = windowHandlers.get('pointerdown');
  assert.equal(typeof down, 'function');
  down({ pointerType: 'touch', button: 0, pointerId: 7, clientX: 120, clientY: 240, target: canvas });
  await new Promise((resolve) => setTimeout(resolve, 480));

  assert.equal(cancelled, 1);
  assert.equal(selectionCleared, 1);
  assert.deepEqual(menuAt, { x: 120, y: 240 });
});
