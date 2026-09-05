// The desktop side of LAN sync: identity, remembered devices, and the wiring
// between the sync node and the app.
//
// Kept apart from sync/node.js on purpose. That file is plain networking with
// no idea where it is running; this one knows about the userData folder, the
// window, and how GazBoard asks a person a question. Splitting them is what
// lets the transport be tested without Electron.
//
// Nothing here starts until the person switches sync on.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSyncNode, TRANSFER_PORT, DISCOVERY_PORT } = require('./node.js');
const P = require('./protocol.js');

/**
 * Who this machine is, and who it trusts.
 *
 * The device id is random and meaningless — it identifies a machine to its
 * pairs and nothing else. Devices paired "just for now" are held in memory and
 * never written, so closing GazBoard forgets a classroom without anyone having
 * to remember to.
 */
function createIdentity(userDataDir) {
  const idFile = path.join(userDataDir, 'sync-identity.json');
  const pairedFile = path.join(userDataDir, 'sync-paired.json');

  let identity = null;
  try { identity = JSON.parse(fs.readFileSync(idFile, 'utf8')); } catch { /* first run */ }
  if (!identity || !identity.deviceId) {
    identity = { deviceId: P.newDeviceId(), name: os.hostname() || 'This computer' };
    try { fs.writeFileSync(idFile, JSON.stringify(identity, null, 2)); } catch { /* read-only home */ }
  }

  let onDisk = [];
  try { onDisk = JSON.parse(fs.readFileSync(pairedFile, 'utf8')); } catch { /* none yet */ }
  const devices = new Map();
  for (const rec of Array.isArray(onDisk) ? onDisk : []) {
    if (rec && rec.deviceId && rec.key) devices.set(rec.deviceId, { ...rec, remember: true });
  }

  const flush = () => {
    // Only the remembered ones reach the disk. That single line is what makes
    // "just for this session" true rather than merely intended.
    const keep = [...devices.values()].filter((r) => r.remember);
    try { fs.writeFileSync(pairedFile, JSON.stringify(keep, null, 2)); } catch { /* not fatal */ }
  };

  return {
    deviceId: identity.deviceId,
    get deviceName() { return identity.name; },
    setDeviceName(name) {
      identity.name = String(name || '').slice(0, 64) || os.hostname() || 'This computer';
      try { fs.writeFileSync(idFile, JSON.stringify(identity, null, 2)); } catch {}
      return identity.name;
    },
    paired: {
      get: (id) => devices.get(id) || null,
      set: (id, rec) => { devices.set(id, rec); flush(); },
      remove: (id) => { devices.delete(id); flush(); },
      all: () => [...devices.values()]
    }
  };
}

/**
 * Sync as the app sees it: off until asked, and answerable about why.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {Function} opts.askAboutBoard  async ({ board, from }) => outcome|null,
 *        which is the renderer showing someone the arriving board and waiting.
 * @param {Function} opts.onPeers        called when the visible device list changes
 */
function createSyncService({ userDataDir, askAboutBoard, onPeers = () => {} }) {
  const id = createIdentity(userDataDir);
  let node = null;
  let lastError = null;

  function state() {
    return {
      running: !!node && node.running,
      deviceName: id.deviceName,
      deviceId: id.deviceId,
      port: node ? node.port : 0,
      // A port other than the usual one means something else has it, and the
      // other machine will not find us by address. Worth saying out loud.
      unusualPort: !!node && node.running && node.port !== TRANSFER_PORT,
      expectedPort: TRANSFER_PORT,
      // False when the announcement socket could not bind. Boards still travel
      // - that is TCP - but nobody appears in anybody's list by themselves.
      discovery: !!node && node.discovery,
      discoveryPort: DISCOVERY_PORT,
      error: lastError,
      peers: node ? node.peers() : [],
      paired: node ? node.pairedDevices() : id.paired.all().map((r) => ({
        deviceId: r.deviceId, name: r.name, remember: !!r.remember, pairedAt: r.pairedAt
      }))
    };
  }

  async function start() {
    if (node && node.running) return state();
    lastError = null;
    node = createSyncNode({
      deviceId: id.deviceId,
      deviceName: id.deviceName,
      paired: id.paired,
      onPeers,
      onBoard: askAboutBoard
    });
    try {
      await node.start();
    } catch (e) {
      lastError = e.message || String(e);
      node = null;
    }
    return state();
  }

  async function stop() {
    if (node) { await node.stop(); node = null; }
    return state();
  }

  return {
    state, start, stop,
    setDeviceName: (n) => { const name = id.setDeviceName(n); return name; },
    beginPairing: (opts) => (node ? node.beginPairing(opts) : null),
    cancelPairing: () => { if (node) node.cancelPairing(); },
    pairWith: (peer, code) => {
      if (!node) throw new Error('sync is switched off');
      return node.pairWith(peer, code);
    },
    send: (peer, board, onProgress) => {
      if (!node) throw new Error('sync is switched off');
      return node.send(peer, board, onProgress);
    },
    addByAddress: (address) => {
      if (!node) throw new Error('sync is switched off');
      return node.addByAddress(address);
    },
    // Awaited, so the caller knows when the other machine has been told and can
    // redraw a list that is now right on both computers.
    unpair: async (deviceId) => {
      if (node) return node.unpair(deviceId);
      // Sharing is switched off, so nobody can be told. Forgetting still has to
      // happen: the record is on this disk whether the service is running or not.
      id.paired.remove(deviceId);
      return false;
    },
    endSession: () => (node ? node.endSession() : 0)
  };
}

module.exports = { createSyncService, createIdentity };
