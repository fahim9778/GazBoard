'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function setup(handler) {
  global.window = { addEventListener() {}, dispatchEvent() {} };
  global.document = { documentElement: { dataset: {} }, addEventListener() {} };
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
  return { adapter: createAndroidAdapter(native), calls, native };
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
