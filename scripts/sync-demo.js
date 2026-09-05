#!/usr/bin/env node
//
// A bench test for LAN sync, before any of it is wired into the app.
//
// Two machines, two terminals. One waits, the other sends. Nothing here is part
// of GazBoard itself - it exists so the transport can be tried on a real
// network, with real wifi and a real router in the way, rather than only on
// loopback inside a test.
//
//   node scripts/sync-demo.js receive
//   node scripts/sync-demo.js send <address> <code> [board.gazboard]
//   node scripts/sync-demo.js discover
//
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const P = require('../sync/protocol.js');
const { createSyncNode, TRANSFER_PORT } = require('../sync/node.js');

const [, , mode, ...rest] = process.argv;

/** Every address this machine can be reached on, so the other end can be told one. */
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** Paired devices, in memory only. This is a bench, not an installation. */
function store() {
  const m = new Map();
  return { get: (id) => m.get(id) || null, set: (id, r) => m.set(id, r),
    remove: (id) => m.delete(id), all: () => [...m.values()] };
}

const line = () => console.log('─'.repeat(58));

function sampleBoard() {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push({ x: 200 + i * 8, y: 300 + Math.sin(i / 4) * 60, p: 0.5 });
  return {
    id: 'demo' + Date.now().toString(36),
    name: 'Sent from ' + os.hostname(),
    schema: 2, pages: [], camera: { x: 0, y: 0, z: 1 },
    objects: [
      { id: 'ink1', type: 'stroke', tool: 'pen', color: '#e81123', width: 6, effect: 'none',
        points: pts, bbox: { x: 200, y: 240, w: 320, h: 120 }, rotation: 0 },
      { id: 'txt1', type: 'text', x: 200, y: 420, w: 400, h: 40,
        text: 'Hello from ' + os.hostname(), fontSize: 24, color: '#201f1e',
        align: 'left', valign: 'top', rotation: 0, font: 'hand', background: 'none' }
    ]
  };
}

/* ------------------------------------------------------------------ */

async function receive() {
  const remember = rest.includes('--remember');
  const autoAccept = rest.includes('--yes');
  const outDir = path.join(process.cwd(), 'sync-inbox');
  fs.mkdirSync(outDir, { recursive: true });

  const node = createSyncNode({
    deviceId: P.newDeviceId(),
    deviceName: os.hostname(),
    paired: store(),
    onPeers: () => {},
    onBoard: async ({ board, from }) => {
      const objects = Array.isArray(board.objects) ? board.objects.length : 0;
      console.log('');
      line();
      console.log(`  A board is arriving from  ${from.name}`);
      console.log(`  Name                      ${board.name || 'Untitled board'}`);
      console.log(`  Items                     ${objects}`);
      console.log(`  Size                      ${(JSON.stringify(board).length / 1024).toFixed(1)} KB`);
      line();

      // --yes is for a bench run with nobody watching: two terminals driven by
      // a script, or a check in CI. It is loudly announced at start-up, because
      // a receiver that accepts anything is the opposite of the design.
      const answer = autoAccept ? 'y' : await ask('  Accept it? [y/N] ');
      if (autoAccept) console.log('  Accept it? [y/N] y   (--yes)');
      if (!/^y/i.test(answer)) {
        console.log('  Declined. Nothing was written.\n');
        return null;
      }
      const file = path.join(outDir, `${Date.now()}-${(board.name || 'board').replace(/[^\w-]+/g, '-')}.gazboard`);
      fs.writeFileSync(file, JSON.stringify(board, null, 0));
      console.log(`  Saved to ${file}\n`);
      return 'kept-both';
    }
  });

  await node.start();

  const me = process.argv[1] && /gazboard-sync/.test(process.argv[1])
    ? 'gazboard-sync.js' : 'scripts/sync-demo.js';

  /*
   * Keep a usable code on screen for as long as this is running.
   *
   * A code lasts five minutes, which is right for a class but wrong for a
   * terminal somebody leaves open while they work out which folder the file is
   * in. Without this, the window sat there showing a code that had quietly
   * died, and the other machine got "no pairing in progress" with nothing on
   * screen to explain it.
   */
  function showCode(first) {
    const session = node.beginPairing({ remember });
    if (first) {
      line();
      console.log('  GazBoard sync — waiting');
      line();
      console.log(`  This machine     ${os.hostname()}`);
      for (const a of addresses()) console.log(`  Address          ${a.address}   (${a.name})`);
      console.log(`  Listening on     port ${node.port}`);
      console.log(`  Pairing          ${remember ? 'remembered' : 'just for this session'}`);
      if (node.port !== TRANSFER_PORT) {
        console.log('');
        console.log(`  !! This is NOT the usual port (${TRANSFER_PORT}). Something else has it —`);
        console.log('     most likely another copy of this still running from earlier.');
        console.log('     The other machine assumes the usual port, so sending by');
        console.log('     ADDRESS WILL FAIL until you close the other copy and');
        console.log('     start this again. Discovery still finds it.');
      }
      if (autoAccept) console.log('  --yes given: every board will be accepted without asking.');
    } else {
      console.log('');
      console.log('  That code expired. Here is a fresh one:');
    }
    console.log('');
    console.log(`  PAIRING CODE     ${session.code}`);
    console.log(`  Good until       ${new Date(session.expiresAt).toLocaleTimeString()}`);
    console.log('');
    // Every address, not just the first. A laptop with wifi and ethernet and a
    // VM adapter has several, and only one of them is the one the other machine
    // can reach - guessing on the person's behalf sends them to a dead end.
    const all = addresses();
    console.log(all.length > 1
      ? '  On the other machine — try these in turn, one of them is reachable:'
      : '  On the other machine:');
    if (!all.length) console.log(`     node ${me} send <this machine's address> ${session.code}`);
    for (const a of all) console.log(`     node ${me} send ${a.address} ${session.code}     (${a.name})`);
    console.log('');
    console.log('  Ctrl+C to stop. A new code appears here when this one runs out.');
    line();
    return session;
  }

  let session = showCode(true);
  const keepAlive = setInterval(() => {
    if (Date.now() > session.expiresAt - 1000) session = showCode(false);
  }, 2000);

  process.on('SIGINT', async () => {
    clearInterval(keepAlive);
    console.log('\n  Stopping. Session pairings are forgotten.');
    await node.stop();
    process.exit(0);
  });
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/* ------------------------------------------------------------------ */

async function send() {
  const [address, code, file] = rest;
  if (!address || !code) {
    console.error('  usage: node scripts/sync-demo.js send <address> <code> [board.gazboard]');
    process.exit(1);
  }

  const board = file
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : sampleBoard();

  const node = createSyncNode({
    deviceId: P.newDeviceId(), deviceName: os.hostname(), paired: store(),
    onBoard: async () => 'kept-both'
  });
  await node.start();

  try {
    line();
    console.log(`  Looking for a GazBoard at ${address} ...`);
    const peer = await node.addByAddress(address);
    console.log(`  Found     ${peer.name}`);

    console.log(`  Pairing with code ${code.toUpperCase()} ...`);
    // "no pairing in progress" is the far end saying it has no live code. Said
    // plainly, because the usual cause is a code that timed out while somebody
    // was reading the instructions.

    const rec = await node.pairWith({ ...peer, address, port: peer.port }, code);
    console.log(`  Paired    fingerprint ${rec.fingerprint}`);
    console.log(`            ${rec.remember ? 'remembered on the other machine' : 'just for this session'}`);
    console.log('');
    console.log(`  Sending "${board.name}" (${Array.isArray(board.objects) ? board.objects.length : 0} items) ...`);

    const result = await node.send({ ...peer, address, port: peer.port, deviceId: rec.deviceId }, board);
    line();
    if (result.accepted) console.log(`  Accepted on the other machine — ${result.outcome}`);
    else console.log(`  Declined on the other machine`);
    line();
  } catch (e) {
    line();
    console.error(`  Did not work: ${e.message}`);
    if (/no answer|refused the connection|cannot be reached|not a GazBoard/.test(e.message)) {
      console.error('');
      console.error('  Nothing is listening there. In order of likelihood:');
      console.error('   1. A firewall on THAT machine is blocking incoming');
      console.error('      connections. Windows asks once, the first time; if it was');
      console.error('      dismissed, allow node.exe on private networks.');
      console.error(`   2. It is listening on an unusual port. Its screen says which;`);
      console.error(`      anything other than ${TRANSFER_PORT} means another copy is`);
      console.error('      still running there.');
      console.error('   3. Wrong address of several. Its screen lists them all.');
      console.error('   4. The receive command is not actually running.');
    }
    if (/no pairing in progress|not expecting/.test(e.message)) {
      console.error('');
      console.error('  The other machine is not showing a pairing code right now.');
      console.error('  Look at its screen: if the code there is newer than the one');
      console.error('  you typed, use that one. Codes last five minutes.');
    }
    line();
    process.exitCode = 1;
  } finally {
    await node.stop();
  }
}

/* ------------------------------------------------------------------ */

async function discover() {
  const node = createSyncNode({
    deviceId: P.newDeviceId(), deviceName: os.hostname() + ' (looking)', paired: store(),
    onBoard: async () => null,
    onPeers: (list) => {
      console.clear();
      line();
      console.log('  GazBoards this machine can see');
      line();
      if (!list.length) console.log('  (nothing yet)');
      for (const p of list) console.log(`  ${p.name.padEnd(28)} ${p.address}:${p.port}`);
      line();
      console.log('  Ctrl+C to stop.');
    }
  });
  await node.start();
  const me2 = process.argv[1] && /gazboard-sync/.test(process.argv[1])
    ? 'gazboard-sync.js' : 'scripts/sync-demo.js';
  line();
  console.log(`  This machine is ${os.hostname()} on ${addresses().map((a) => a.address).join(', ') || 'no network'}`);
  console.log('  Listening for other GazBoards, and announcing itself.');
  console.log('');
  console.log('  On the OTHER computer, run either of these:');
  console.log(`     node ${me2} discover        (each will list the other)`);
  console.log(`     node ${me2} receive         (also ready to take a board)`);
  console.log('');
  console.log('  Nothing appears? Both machines must be on the same wifi, and a');
  console.log('  firewall may be blocking UDP. Sending by address still works.');
  line();
  process.on('SIGINT', async () => { await node.stop(); process.exit(0); });
}

/* ------------------------------------------------------------------ */

if (mode === 'receive') receive();
else if (mode === 'send') send();
else if (mode === 'discover') discover();
else {
  const me = process.argv[1] && /gazboard-sync/.test(process.argv[1])
    ? 'gazboard-sync.js' : 'scripts/sync-demo.js';
  console.log(`
  GazBoard LAN sync — bench test

    node ${me} receive [--remember] [--yes]
        Waits for a board. Prints this machine's address and a pairing code.
        --remember keeps the pairing after the app closes.
        --yes accepts without asking, for an unattended bench run.

    node ${me} send <address> <code> [board.gazboard]
        Pairs with that machine and sends a board. Sends a sample if no file.

    node ${me} discover
        Just lists the GazBoards it can see, to check the network carries
        peer-to-peer traffic at all.
`);
}
