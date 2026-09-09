// A real desktop sync node controlled by the Android JVM interoperability suite.
'use strict';
const readline = require('node:readline');
const P = require('../sync/protocol.js');
const { createSyncNode } = require('../sync/node.js');

const devices = new Map();
const incoming = [];
const deviceId = P.newDeviceId();
let outcome = 'saved';
let keys;
const node = createSyncNode({
  deviceId, deviceName: 'Desktop বাংলা 🖊️', host: '127.0.0.1', discoveryPort: 0,
  paired: {
    get: (id) => devices.get(id), set: (id, rec) => devices.set(id, rec),
    remove: (id) => devices.delete(id), all: () => [...devices.values()]
  },
  onBoard: async (msg) => { incoming.push(msg); return outcome; }
});
const handlers = {
  start: async () => { await node.start(); return { deviceId, port: node.port, address: '127.0.0.1' }; },
  pairing: (args) => node.beginPairing(args),
  pair: ({ peer, code }) => node.pairWith(peer, code),
  send: ({ peer, board }) => node.send(peer, board),
  stillPaired: (peer) => node.stillPaired(peer),
  unpair: (id) => node.unpair(id),
  devices: () => node.pairedDevices(),
  incoming: () => incoming,
  decline: () => { outcome = null; return true; },
  endSession: () => node.endSession(),
  stop: () => node.stop(),
  keys: () => { keys = P.createPairingKeys(); return { deviceId, publicKey: keys.publicKey }; },
  proof: ({ us, them, code, envelope, plain }) => {
    const key = P.deriveDeviceKey(keys.privateKey, them.publicKey, us, them);
    return {
      key: key.toString('base64'),
      proof: P.confirmation(code, us, them, 'responder'),
      fingerprint: P.fingerprint(key),
      opened: P.open(key, envelope)?.toString('base64') || null,
      sealed: P.seal(key, { from: deviceId, kind: 'board', v: 1, port: 53318, name: 'বাংলা 🖊️ / \n' }, Buffer.from(plain, 'base64'))
    };
  }
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const handler = handlers[request.method];
    if (!handler) throw new Error('Unknown test command');
    const result = await handler(request.args);
    process.stdout.write(JSON.stringify({ id: request.id, result: result ?? null }) + '\n');
  } catch (e) { process.stdout.write(JSON.stringify({ id: request?.id, error: e.message }) + '\n'); }
});
input.on('close', async () => { await node.stop(); process.exit(0); });
