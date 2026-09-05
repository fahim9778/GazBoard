// LAN sync: the protocol, and two nodes actually talking to each other.
//
// Everything here runs on loopback inside one process, so the transfer path is
// covered without a second machine and without Electron. Nothing in this file
// touches the app's own suites.

'use strict';

const assert = require('node:assert');
const P = require('../sync/protocol.js');
const { createSyncNode } = require('../sync/node.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  const tag = ok ? '  ok  ' : ' FAIL ';
  if (ok) pass++; else fail++;
  console.log(`${tag} [sync] ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * Run one group of checks, and survive it blowing up.
 *
 * A section that throws used to take the whole run with it, so a single broken
 * thing hid every check after it - which is the opposite of what a suite is for.
 * A crash is now just a failure with a name on it, and the rest still runs.
 */
async function section(name, fn) {
  try { await fn(); }
  catch (e) { check(`${name}: section crashed`, false, e && e.message); }
}

/**
 * A paired-device store, standing in for the real one.
 *
 * The real store writes remembered devices to disk and keeps session ones only
 * in memory, so closing the app forgets a classroom by itself. This copy tracks
 * the same split so the tests can see which is which.
 */
function memoryStore() {
  const m = new Map();
  return {
    get: (id) => m.get(id) || null,
    set: (id, rec) => m.set(id, rec),
    remove: (id) => m.delete(id),
    all: () => [...m.values()],
    size: () => m.size,
    remembered: () => [...m.values()].filter((r) => r.remember).length
  };
}

const BOARD = {
  id: 'bsync1', name: 'Lesson plan', schema: 2, pages: [], camera: { x: 0, y: 0, z: 1 },
  objects: [{ id: 't1', type: 'text', x: 0, y: 0, w: 200, h: 40, text: 'from the other machine',
    fontSize: 20, color: '#201f1e', align: 'left', valign: 'top', rotation: 0,
    font: 'hand', background: 'none' }]
};

/**
 * Two nodes that can reach each other but cannot broadcast to the whole LAN
 * while the tests run. Discovery is exercised separately; these are wired by
 * address so a test machine never shouts at its own network.
 */
async function pair() {
  const aStore = memoryStore(), bStore = memoryStore();
  const arrivals = [];
  let verdict = () => 'kept-both';

  const A = createSyncNode({
    deviceId: P.newDeviceId(), deviceName: 'Desk PC', paired: aStore,
    host: '127.0.0.1', broadcast: '127.0.0.1', discoveryPort: 0,
    onBoard: async () => 'kept-both'
  });
  const B = createSyncNode({
    deviceId: P.newDeviceId(), deviceName: 'Classroom tablet', paired: bStore,
    host: '127.0.0.1', broadcast: '127.0.0.1', discoveryPort: 0,
    onBoard: async (msg) => { arrivals.push(msg); return verdict(msg); }
  });

  await A.start();
  await B.start();
  return {
    A, B, aStore, bStore, arrivals,
    setVerdict: (fn) => { verdict = fn; },
    peerB: { deviceId: null, name: 'Classroom tablet', address: '127.0.0.1', port: B.port },
    stop: async () => { await A.stop(); await B.stop(); }
  };
}

async function run() {
  /* ---------------- the protocol on its own ---------------- */

  const code = P.generateCode();
  check('a pairing code is readable and worth guessing at',
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && P.codeEntropyBits() >= 40,
    `${code}, ${P.codeEntropyBits()} bits`);
  check('confusable characters are left out of codes',
    !/[O0I1]/.test(new Array(200).fill(0).map(() => P.generateCode()).join('')));
  check('a code typed with the wrong case or spacing still matches',
    P.normaliseCode(' 7mpu k7tm ') === P.normaliseCode('7MPU-K7TM'));

  {
    const a = { deviceId: 'aaa', ...P.createPairingKeys() };
    const b = { deviceId: 'bbb', ...P.createPairingKeys() };
    const pa = { deviceId: a.deviceId, publicKey: a.publicKey };
    const pb = { deviceId: b.deviceId, publicKey: b.publicKey };

    check('both ends build the same transcript whoever asked first',
      P.transcript(pa, pb) === P.transcript(pb, pa));
    check('the two roles prove different things',
      P.confirmation(code, pa, pb, 'initiator') !== P.confirmation(code, pa, pb, 'responder'));
    check('a wrong code fails the proof',
      !P.confirmationMatches(P.confirmation(code, pa, pb, 'initiator'),
        P.confirmation('AAAA-AAAA', pa, pb, 'initiator')));

    const ka = P.deriveDeviceKey(a.privateKey, b.publicKey, pa, pb);
    const kb = P.deriveDeviceKey(b.privateKey, a.publicKey, pa, pb);
    check('key agreement lands on one 32-byte key', ka.equals(kb) && ka.length === 32);
    check('and both ends show the same fingerprint',
      P.fingerprint(ka) === P.fingerprint(kb), P.fingerprint(ka));

    const env = P.seal(ka, { from: 'aaa', kind: 'board' }, Buffer.from('secret board'));
    check('a sealed board opens at the other end',
      P.open(kb, env).toString() === 'secret board');
    check('a board resealed to a different sender does not open',
      P.open(kb, { ...env, aad: { from: 'eve', kind: 'board' } }) === null);
    check('a tampered body does not open',
      P.open(kb, { ...env, body: Buffer.from('nope').toString('base64') }) === null);
    check('a stranger with the wrong key gets nothing',
      P.open(require('node:crypto').randomBytes(32), env) === null);
    check('the ciphertext does not contain the plaintext',
      !Buffer.from(env.body, 'base64').toString('latin1').includes('secret'));
  }

  /* ---------------- two nodes, over a socket ---------------- */

  await section('pairing and transfer', async () => {
    const t = await pair();
    try {
      const showing = t.B.beginPairing();
      check('the receiving device shows a code that expires',
        /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(showing.code) && showing.expiresAt > Date.now());

      // a stranger who has not been given the code gets nowhere
      let refused = null;
      try { await t.A.pairWith(t.peerB, 'ZZZZ-ZZZZ'); } catch (e) { refused = e.message; }
      check('a wrong code is refused, and says how many tries are left',
        refused && /did not match/.test(refused), refused);
      check('and nothing was paired by the attempt',
        t.aStore.size() === 0 && t.bStore.size() === 0);

      const rec = await t.A.pairWith(t.peerB, showing.code);
      check('the right code pairs the two devices',
        !!rec && rec.deviceId && t.aStore.size() === 1 && t.bStore.size() === 1);
      check('both sides stored the same key',
        t.aStore.all()[0].key === t.bStore.all()[0].key);
      check('and each shows a fingerprint a person can compare',
        /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(rec.fingerprint), rec.fingerprint);
      check('the paired record carries the other device\'s name, not its id',
        t.bStore.all()[0].name === 'Desk PC', t.bStore.all()[0].name);

      // the session stays open on purpose - a room full of people share one code
      const again = await t.A.pairWith(t.peerB, showing.code);
      check('the same code still works while pairing is open', !!again && again.deviceId === rec.deviceId);

      /* ---- the transfer itself ---- */
      t.peerB.deviceId = rec.deviceId;
      const result = await t.A.send(t.peerB, BOARD);
      check('a paired device can send a board',
        result.accepted === true && result.outcome === 'kept-both', JSON.stringify(result));
      check('and it arrives whole, with the sender named',
        t.arrivals.length === 1
        && t.arrivals[0].board.objects[0].text === 'from the other machine'
        && t.arrivals[0].from.name === 'Desk PC');

      /* ---- the receiving end decides, and the sender is told ---- */
      t.setVerdict(() => null);
      const declined = await t.A.send(t.peerB, BOARD);
      check('the receiving device can decline, and the sender hears about it',
        declined.accepted === false && declined.outcome === 'declined',
        JSON.stringify(declined));

      t.setVerdict(() => 'replaced');
      const replaced = await t.A.send(t.peerB, BOARD);
      check('and the sender is told which answer came back',
        replaced.accepted === true && replaced.outcome === 'replaced');
    } finally { await t.stop(); }
  });

  /* ---------------- what an unpaired device can do ---------------- */

  await section('what an unpaired device can do', async () => {
    const t = await pair();
    try {
      t.peerB.deviceId = 'a-device-that-never-paired';
      let err = null;
      try { await t.A.send(t.peerB, BOARD); } catch (e) { err = e.message; }
      check('an unpaired device cannot send anything', !!err, err);
      check('and nothing reached the other end', t.arrivals.length === 0);

      // forge an envelope with a key of our own choosing
      const forged = P.seal(require('node:crypto').randomBytes(32),
        { from: 'a-device-that-never-paired', kind: 'board', v: P.PROTOCOL },
        Buffer.from(JSON.stringify(BOARD)));
      const reply = await new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(forged));
        const req = require('node:http').request({
          host: '127.0.0.1', port: t.B.port, path: '/send', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length }
        }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve(0));
        req.end(data);
      });
      check('a forged transfer is refused outright', reply === 401, 'status ' + reply);
      check('and still nothing reached the other end', t.arrivals.length === 0);

      // pairing endpoints answer nothing while no code is on screen
      const noPairing = await new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify({ v: P.PROTOCOL, deviceId: 'x', publicKey: 'y' }));
        const req = require('node:http').request({
          host: '127.0.0.1', port: t.B.port, path: '/pair/hello', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length }
        }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve(0));
        req.end(data);
      });
      check('pairing is closed unless someone asked for a code', noPairing === 409, 'status ' + noPairing);
    } finally { await t.stop(); }
  });

  /* ---------------- guessing costs, and runs out ---------------- */

  await section('guessing costs, per device', async () => {
    const t = await pair();
    try {
      t.B.beginPairing();
      const errors = [];
      for (let i = 0; i < P.CODE_MAX_ATTEMPTS + 2; i++) {
        try { await t.A.pairWith(t.peerB, 'AAAA-AAAA'); } catch (e) { errors.push(e.message); }
      }
      check('every wrong guess is refused', errors.length === P.CODE_MAX_ATTEMPTS + 2);
      check('and that device runs out of attempts',
        /too many attempts/.test(errors[errors.length - 1]), errors[errors.length - 1]);
      check('nothing was paired along the way', t.aStore.size() === 0 && t.bStore.size() === 0);

      // the room is not locked out by one person fumbling: a DIFFERENT device,
      // with the right code, still gets in
      const showing = t.B.beginPairing();
      const errors2 = [];
      for (let i = 0; i < P.CODE_MAX_ATTEMPTS + 1; i++) {
        try { await t.A.pairWith(t.peerB, 'AAAA-AAAA'); } catch (e) { errors2.push(e.message); }
      }
      const C = createSyncNode({
        deviceId: P.newDeviceId(), deviceName: "Student's laptop", paired: memoryStore(),
        host: '127.0.0.1', broadcast: '127.0.0.1', discoveryPort: 0,
        onBoard: async () => 'kept-both'
      });
      await C.start();
      try {
        const ok = await C.pairWith({ address: '127.0.0.1', port: t.B.port }, showing.code);
        check('one person fumbling the code does not lock the room out', !!ok && !!ok.deviceId);
      } finally { await C.stop(); }
    } finally { await t.stop(); }
  });

  await section('temporary versus remembered pairings', async () => {
    const t = await pair();
    try {
      // a class: paired for now
      const cls = t.B.beginPairing({ remember: false });
      check('pairing defaults to just for now', cls.remember === false);
      await t.A.pairWith(t.peerB, cls.code);
      check('the device is paired and can send',
        t.bStore.size() === 1 && t.bStore.remembered() === 0);
      check('both ends agree it is temporary',
        t.aStore.all()[0].remember === false && t.bStore.all()[0].remember === false);

      const dropped = t.B.endSession();
      check('ending the class forgets everyone who was there',
        dropped === 1 && t.bStore.size() === 0);

      // home devices: remembered
      const home = t.B.beginPairing({ remember: true });
      check('remembering is a deliberate choice', home.remember === true);
      const rec = await t.A.pairWith(t.peerB, home.code);
      check('a remembered device is kept',
        t.bStore.remembered() === 1 && rec.remember === true);
      check('and ending a session leaves it alone',
        t.B.endSession() === 0 && t.bStore.size() === 1);

      check('the paired list says which is which',
        t.B.pairedDevices()[0].remember === true && !!t.B.pairedDevices()[0].fingerprint);
      t.B.unpair(t.B.pairedDevices()[0].deviceId);
      check('and a device can be removed by hand', t.bStore.size() === 0);
    } finally { await t.stop(); }
  });

  await section('closing the app forgets a classroom', async () => {
    const t = await pair();
    const cls = t.B.beginPairing({ remember: false });
    await t.A.pairWith(t.peerB, cls.code);
    check('paired for the session', t.bStore.size() === 1);
    await t.stop();
    check('and gone once the app closes', t.bStore.size() === 0);
  });

  await section('stopping really stops', async () => {
    const t = await pair();
    const portB = t.B.port;
    check('a started node is listening', portB > 0 && t.B.running);
    await t.stop();
    check('and a stopped node is not', t.B.port === 0 && !t.B.running);
    const dead = await new Promise((resolve) => {
      const req = require('node:http').request(
        { host: '127.0.0.1', port: portB, path: '/ping', method: 'GET', timeout: 2000 },
        (res) => { res.resume(); resolve('answered ' + res.statusCode); });
      req.on('timeout', () => { req.destroy(); resolve('refused'); });
      req.on('error', () => resolve('refused'));
      req.end();
    });
    check('the port is closed afterwards, not merely ignored', dead === 'refused', dead);
  });

  /* ---------------- finding a device by address ---------------- */

  await section('finding a device by address', async () => {
    const t = await pair();
    try {
      const found = await t.A.addByAddress('127.0.0.1', t.B.port);
      check('a device can be added by address when discovery cannot see it',
        !!found && found.name === 'Classroom tablet' && found.paired === false,
        found && found.name);
      let notThere = null;
      try { await t.A.addByAddress('127.0.0.1', 1); } catch (e) { notThere = e.message; }
      check('and an address with nothing on it says so plainly', !!notThere, notThere);
    } finally { await t.stop(); }
  });

  /* ---------------- the Windows Firewall repair ----------------
   *
   * None of this can be RUN here - there is no Windows and no firewall. What
   * can be checked, and is worth checking, is what it would say if there were:
   * the scripts are built as strings, so the promises they make are inspectable
   * on any machine. The one that matters most is the order - clearing blocks
   * before adding an allow - because getting that backwards produces a repair
   * that reports success and changes nothing.
   */

  await section('the firewall repair', async () => {
    const FW = require('../sync/firewall.js');
    const { TRANSFER_PORT, DISCOVERY_PORT } = require('../sync/node.js');
    const exe = 'C:\\Program Files\\GazBoard\\GazBoard.exe';
    const repair = FW._scripts.repairScript(exe);
    const inspect = FW._scripts.inspectScript(exe);

    check('it knows how to look at Windows, macOS and Linux',
      FW.supported() === ['win32', 'darwin', 'linux'].includes(process.platform),
      process.platform);
    // Detect and explain everywhere; actually change the machine only where
    // that can be done without asking for a password. See the file's header.
    check('but only changes the firewall by itself on Windows',
      FW.repairable() === (process.platform === 'win32'));

    if (process.platform !== 'win32') {
      /*
       * macOS and Linux are read-only by design: they detect and explain, and
       * hand over a command rather than asking for a password to run one they
       * have not shown you. So the assertion here is that a repair REFUSES,
       * clearly, and that what it refuses towards is a real answer.
       */
      const r = await FW.inspect(process.execPath);
      const states = ['allowed', 'no-rule', 'blocked', 'off', 'unknown'];
      check('it reads the firewall on this machine too, not only on Windows',
        r.supported === true && states.includes(r.state),
        `${r.state} via ${r.tool || 'no tool'}` + (r.detail ? ` (${r.detail})` : ''));
      check('and says plainly that it will not change it from in here',
        r.repairable === false);

      const fixed = await FW.repair(exe);
      check('a repair here refuses rather than pretending, or asking for a password',
        fixed.ok === false && fixed.reason === 'manual', fixed.reason);

      // The commands still have to be right, and right for the tool in charge.
      const ufw = FW.manualCommands(exe, 'linux', 'ufw');
      check('ufw gets ufw commands',
        ufw.length === 2 && ufw.every((c) => c.startsWith('sudo ufw allow'))
        && ufw[0].includes(`${TRANSFER_PORT}/tcp`) && ufw[1].includes(`${DISCOVERY_PORT}/udp`),
        ufw.join(' ; '));

      const fd = FW.manualCommands(exe, 'linux', 'firewalld');
      check('firewalld gets firewalld commands, including the reload that makes them stick',
        fd.length === 3 && fd[0].includes(`--add-port=${TRANSFER_PORT}/tcp`)
        && fd[1].includes(`--add-port=${DISCOVERY_PORT}/udp`) && /--reload/.test(fd[2]),
        fd.join(' ; '));

      const unsure = FW.manualCommands(exe, 'linux', null);
      check('and when it cannot tell which is in charge it offers both rather than guessing wrong',
        unsure.length === 2 && /firewalld/.test(unsure[0]) && /ufw/.test(unsure[1]));

      const mac = FW.manualCommands('/Applications/GazBoard.app/Contents/MacOS/GazBoard', 'darwin');
      check('macOS gets socketfilterfw, pointed at the .app rather than the binary inside it',
        mac.length === 2 && mac.every((c) => c.includes('/Applications/GazBoard.app"')
          && !c.includes('Contents/MacOS')), mac.join(' ; '));
      // A dismissed macOS prompt lands the app in the list AS BLOCKED, so being
      // listed is not being allowed - unblockapp is the line that matters.
      check('and unblocks as well as adds, because listed is not the same as allowed',
        mac.some((c) => c.includes('--add')) && mac.some((c) => c.includes('--unblockapp')));

      check('a platform with no firewall this knows gets no commands at all, not the wrong ones',
        FW.manualCommands(exe, 'sunos').length === 0);
    } else {
      /*
       * On Windows this is the real thing: PowerShell is spawned, the actual
       * firewall is read, and the answer is about this actual machine. It reads
       * only - nothing here changes a rule or raises a prompt.
       *
       * The verdict is printed rather than asserted, because every one of the
       * four is legitimate. What IS asserted is that it came back at all, in
       * one piece, within the timeout - which is the part that would break.
       */
      const live = await FW.inspect(process.execPath);
      const states = ['allowed', 'no-rule', 'blocked', 'unknown'];
      check('reading the real firewall on this machine works',
        live.supported === true && states.includes(live.state),
        `${live.state}` + (live.state === 'unknown' ? ` (${live.detail || 'no detail'})` : ''));
      check('and it says which program it looked at',
        typeof live.program === 'string' && live.program.length > 0, live.program);
      check('and that this is a machine it can put right by itself', live.repairable === true);
      if (live.state !== 'unknown') {
        check('and which kind of network this machine is on',
          Array.isArray(live.networks), (live.networks || []).join(', ') || 'none');
        check('counting the rules it found rather than assuming',
          typeof live.blocked === 'number' && typeof live.allowed === 'number',
          `${live.blocked} blocking, ${live.allowed} allowing, ${live.ours} of them ours`);
      }
    }

    // A block beats an allow in Windows Firewall, so a repair that adds
    // permission without clearing the blocks first is a no-op that looks like
    // a fix. This is the assertion that stops that being reintroduced.
    const clearAt = repair.indexOf("$_.Action -eq 'Block'");
    const allowAt = repair.indexOf('New-NetFirewallRule');
    check('the repair clears blocking rules before it adds permission',
      clearAt > -1 && allowAt > -1 && clearAt < allowAt, `block at ${clearAt}, allow at ${allowAt}`);
    check('and replaces its own earlier rules rather than piling up duplicates',
      /Remove-NetFirewallRule -DisplayName 'GazBoard sharing\*'/.test(repair));

    check('it opens exactly the two ports the transport uses',
      repair.includes(`-Protocol TCP -LocalPort ${TRANSFER_PORT}`)
      && repair.includes(`-Protocol UDP -LocalPort ${DISCOVERY_PORT}`),
      `TCP ${TRANSFER_PORT} / UDP ${DISCOVERY_PORT}`);
    check('and opens them inbound only, for this one program',
      (repair.match(/-Direction Inbound -Program \$exe/g) || []).length === 2);

    // Public is a café, an airport, a hotel. Never.
    check('it never asks to be reachable on a public network',
      !/Public/.test(FW.PROFILES) && !/-Profile \S*Public/.test(repair), FW.PROFILES);
    check('only on private and work networks', FW.PROFILES === 'Private,Domain');

    check('the check looks for rules by program as well as by name, so a block Windows wrote is found',
      /Get-NetFirewallApplicationFilter -Program \$exe/.test(inspect)
      && /Get-NetFirewallRule -DisplayName 'GazBoard sharing\*'/.test(inspect));

    /*
     * And by PORT, which is the one it missed. A rule can let GazBoard in
     * without ever naming the executable - an administrator opening the two
     * ports does exactly that - and looking only for program rules produced
     * "nothing has been allowed" on a machine where boards were visibly
     * arriving. Confident, alarming and wrong.
     */
    check('and by port, because a rule can let us in without naming this program',
      /Get-NetFirewallPortFilter/.test(inspect)
      && new RegExp(`LocalPort -contains '${TRANSFER_PORT}'`).test(inspect)
      && new RegExp(`LocalPort -contains '${DISCOVERY_PORT}'`).test(inspect));
    check('counting only inbound allow rules among those, not every rule that mentions the port',
      /\$_\.Direction -eq 'Inbound' -and "\$\(\$_\.Enabled\)" -eq 'True' -and \$_\.Action -eq 'Allow'/.test(inspect));
    // A LocalPort of "Any" may belong to some entirely different program, so
    // reading it as permission would swap a false alarm for a false all-clear.
    check('and never treating a wide-open "Any" rule as permission for us',
      !/LocalPort -contains 'Any'/.test(inspect) && !/LocalPort -eq 'Any'/.test(inspect));
    check('and reports which kind of network this machine is on',
      /Get-NetConnectionProfile/.test(inspect));

    // A path is dropped into PowerShell as a single-quoted literal, where the
    // only escape is doubling the quote. Anything else and a folder with an
    // apostrophe in it - which Windows allows - would end the string early.
    const odd = FW._scripts.q("C:\\Users\\O'Brien\\GazBoard.exe");
    check('a path with an apostrophe in it cannot break out of the script',
      odd === "'C:\\Users\\O''Brien\\GazBoard.exe'", odd);

    // -EncodedCommand takes UTF-16LE base64, which is what carries a script
    // with quotes and newlines through two shells without any escaping at all.
    const round = Buffer.from(FW._scripts.encode('Write-Output "hi"'), 'base64').toString('utf16le');
    check('the script survives being handed to an elevated shell', round === 'Write-Output "hi"', round);

    const manual = FW.manualCommands(exe, 'win32');
    check('the same thing is available as text for a machine that refuses elevation',
      manual.length === 2 && manual.every((c) => c.includes(exe) && c.startsWith('New-NetFirewallRule')));
  });

  /* ---------------- a big board, and a person who takes their time ----------------
   *
   * Two things that only appear once a board stops being a scribble.
   */

  await section('a large board', async () => {
    const t = await pair();
    try {
      const showing = t.B.beginPairing();
      const rec = await t.A.pairWith(t.peerB, showing.code);
      t.peerB.deviceId = rec.deviceId;

      // ~6 MB of text, which is the shape a board of imported pages takes once
      // its pictures are sitting inside it as base64.
      const big = { ...BOARD, id: 'bbig', name: 'Imported slides',
        objects: [{ ...BOARD.objects[0], text: 'x'.repeat(6 * 1024 * 1024) }] };

      const seen = [];
      const result = await t.A.send(t.peerB, big, (sent, total) => seen.push([sent, total]));
      check('a multi-megabyte board arrives whole',
        result.accepted === true
        && t.arrivals[t.arrivals.length - 1].board.objects[0].text.length === 6 * 1024 * 1024);

      /*
       * Progress is not decoration here. Without it a forty-megabyte transfer
       * over classroom wifi is indistinguishable from a hang, and the only
       * evidence either way was a toast that had faded four seconds in.
       */
      check('and reports progress on the way, more than once', seen.length > 1, `${seen.length} updates`);
      check('counting up rather than jumping straight to the end',
        seen[0][0] > 0 && seen[0][0] < seen[seen.length - 1][0],
        `${seen[0][0]} … ${seen[seen.length - 1][0]}`);
      check('and finishing on the exact total, not near it',
        seen[seen.length - 1][0] === seen[seen.length - 1][1]);
      check('the wire total is bigger than the board, because it is sealed and base64',
        seen[0][1] > 6 * 1024 * 1024,
        `${(seen[0][1] / 1048576).toFixed(1)} MB on the wire for a 6.0 MB board`);
    } finally { await t.stop(); }
  });

  await section('a receiver who takes their time', async () => {
    const t = await pair();
    try {
      const showing = t.B.beginPairing();
      const rec = await t.A.pairWith(t.peerB, showing.code);
      t.peerB.deviceId = rec.deviceId;

      /*
       * THE bug this section exists for.
       *
       * Node's socket timeout is an IDLE timer. Once the body has gone out the
       * socket falls quiet while somebody on the other machine reads the "do
       * you want this board?" dialog - and at the old thirty seconds, anyone
       * who paused to think was told the transfer had failed while the
       * receiving end went right on accepting it and saving the board. Two
       * machines, two stories, and the one that lost was the one holding the
       * original.
       */
      t.setVerdict(async () => {
        await new Promise((r) => setTimeout(r, 35000));      // past the old 30s
        return 'kept-both';
      });

      const started = Date.now();
      const result = await t.A.send(t.peerB, BOARD);
      const waited = Math.round((Date.now() - started) / 1000);
      check('a sender waits for a person to decide instead of giving up on them',
        result.accepted === true && result.outcome === 'kept-both', `answered after ${waited}s`);
      check('and both machines end up telling the same story',
        t.arrivals.length === 1 && waited >= 34, `${t.arrivals.length} arrival(s), ${waited}s`);
    } finally { await t.stop(); }
  });

  /* ---------------- forgetting, which has to travel ----------------
   *
   * Pairing is a fact two machines hold between them, so one of them dropping
   * it quietly is not enough: the other went on showing "paired" with a Send
   * button that could only ever fail, and the failure said "not paired" about
   * a device its own screen insisted was paired.
   */

  await section('forgetting a device tells it so', async () => {
    const t = await pair();
    try {
      const showing = t.B.beginPairing();
      const rec = await t.A.pairWith(t.peerB, showing.code);
      t.peerB.deviceId = rec.deviceId;
      check('both machines start out paired', t.aStore.size() === 1 && t.bStore.size() === 1);

      // Telling them needs an address, which discovery would normally supply.
      await t.A.addByAddress('127.0.0.1', t.B.port);

      const told = await t.A.unpair(rec.deviceId);
      check('forgetting reaches the other machine', told === true, String(told));
      check('and it forgot too, rather than still calling us paired',
        t.aStore.size() === 0 && t.bStore.size() === 0,
        `A ${t.aStore.size()}, B ${t.bStore.size()}`);
    } finally { await t.stop(); }
  });

  await section('forgetting a device that is not there', async () => {
    const t = await pair();
    try {
      const showing = t.B.beginPairing();
      const rec = await t.A.pairWith(t.peerB, showing.code);
      await t.A.addByAddress('127.0.0.1', t.B.port);
      await t.B.stop();                       // switched off, or on another network

      /*
       * This end forgets FIRST and unconditionally. A machine that is off must
       * never be able to keep itself in somebody's trusted list by being
       * unreachable - which is what making the removal conditional on the
       * message getting through would do.
       */
      const told = await t.A.unpair(rec.deviceId);
      check('a machine that cannot be reached is still forgotten here', t.aStore.size() === 0);
      check('and the caller is told plainly that the other end does not know yet',
        told === false, String(told));
    } finally { try { await t.A.stop(); } catch {} }
  });

  await section('a device that forgot us while we were away', async () => {
    const t = await pair();
    try {
      const showing = t.B.beginPairing();
      const rec = await t.A.pairWith(t.peerB, showing.code);
      t.peerB.deviceId = rec.deviceId;

      // B forgets A while A is unreachable, so the message never arrives and
      // the two machines are left believing different things.
      for (const r of t.bStore.all()) t.bStore.remove(r.deviceId);
      check('one side now believes something the other does not',
        t.aStore.size() === 1 && t.bStore.size() === 0);

      let said = null;
      try { await t.A.send(t.peerB, BOARD); } catch (e) { said = e.message; }
      check('sending says who forgot whom, in words that name the fix',
        !!said && /forgotten this one/.test(said) && /pair again/.test(said), said);
      // Keeping the record would leave a device listed as paired that can never
      // be sent to, failing the same confusing way every time.
      check('and the stale pairing is dropped rather than left to fail again',
        t.aStore.size() === 0, String(t.aStore.size()));
    } finally { await t.stop(); }
  });

  /* ---------------- a discovery port somebody else already has ----------------
   *
   * 53318 and 53319 sit in the range operating systems hand out for short-lived
   * outgoing sockets. They are not registered to anybody and nothing guarantees
   * they are free - so "another program has it" is a case that has to work,
   * not one to hope about.
   *
   * The transfer port already falls back to a random one. The announcement
   * port used to have no story at all: bind() only calls back on success, so a
   * refused bind left start() pending for ever and the window sat on
   * "Starting…" with nothing to explain it. The app was not broken, it was
   * waiting, which is the worst way to fail.
   */

  await section('a discovery port that is already taken', async () => {
    const dgram = require('node:dgram');
    const hog = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    const taken = await new Promise((resolve) => {
      hog.bind(0, '127.0.0.1', () => resolve(hog.address().port));
    });

    const node = createSyncNode({
      deviceId: P.newDeviceId(), deviceName: 'Crowded machine', paired: memoryStore(),
      host: '127.0.0.1', broadcast: '127.0.0.1', discoveryPort: taken,
      onBoard: async () => null
    });

    try {
      const started = await Promise.race([
        node.start().then(() => 'started'),
        new Promise((r) => setTimeout(() => r('hung'), 8000))
      ]);
      check('starting still finishes rather than hanging for ever', started === 'started', started);
      check('and the transfer port is up, because that is what carries boards',
        node.running === true && node.port > 0, `port ${node.port}`);

      // Whether the bind was actually refused depends on the platform's
      // reuseAddr behaviour, so this asserts the SHAPE of the answer rather
      // than which way it went - what matters is that there is an answer.
      check('and it says plainly whether it can announce itself',
        typeof node.discovery === 'boolean', String(node.discovery));

      /*
       * A board still travels either way: that is TCP, and adding by address
       * needs no announcements at all. It takes a second node to prove it,
       * because a node deliberately refuses to discover itself.
       */
      const finder = createSyncNode({
        deviceId: P.newDeviceId(), deviceName: 'Looking for it', paired: memoryStore(),
        host: '127.0.0.1', broadcast: '127.0.0.1', discoveryPort: 0,
        onBoard: async () => null
      });
      await finder.start();
      try {
        const peer = await finder.addByAddress('127.0.0.1', node.port);
        check('and a machine that cannot announce itself is still reachable by address',
          !!peer && peer.name === 'Crowded machine', peer && peer.name);
      } finally { await finder.stop(); }
    } finally {
      await node.stop();
      try { hog.close(); } catch {}
    }
  });

  /* ---------------- what actually ends up in the installer ----------------
   *
   * electron-builder's `files` is a WHITELIST, not an ignore list. Anything not
   * named in it is simply absent from app.asar - and because `npm start` runs
   * from the repo, where every file is present, the gap is invisible until
   * somebody installs the built app on another machine and it dies with
   * "Cannot find module". Which is exactly what happened to sync/: the whole
   * folder was written, tested and shipped into a build that did not contain it.
   *
   * So this walks every relative require the packaged code makes and asks
   * whether the whitelist would carry it. It costs nothing and it catches the
   * next root-level module before it reaches an installer.
   */

  await section('what the installer actually contains', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const patterns = (pkg.build && pkg.build.files) || [];

    // Only the handful of glob shapes electron-builder is given here.
    const toRe = (p) => new RegExp('^' + p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/\*/g, ' ')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*') + '$');

    const allow = patterns.filter((p) => !p.startsWith('!')).map(toRe);
    const deny = patterns.filter((p) => p.startsWith('!')).map((p) => toRe(p.slice(1)));
    const packaged = (rel) => allow.some((re) => re.test(rel)) && !deny.some((re) => re.test(rel));

    // Every file the main process can reach by a relative require, walked from
    // the two entry points electron-builder is told about.
    const seen = new Set();
    const missing = [];
    const walk = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) { missing.push(`${rel} (not on disk)`); return; }
      if (!packaged(rel)) missing.push(rel);
      const src = fs.readFileSync(abs, 'utf8');
      for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        let next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        if (!/\.[cm]?js$/.test(next)) next += '.js';
        walk(next);
      }
    };
    walk('main.js');
    walk('preload.js');

    check('every module the app requires is inside the installer',
      missing.length === 0,
      missing.length ? 'MISSING: ' + missing.join(', ') : `${seen.size} files reachable, all packaged`);

    // Named rather than merely implied, because this is the one that got away.
    check('the sync folder is on the packaged list by name',
      patterns.some((p) => /^sync\//.test(p)), patterns.join(' | '));
    for (const f of ['sync/desktop.js', 'sync/node.js', 'sync/protocol.js', 'sync/firewall.js']) {
      check(`${f} would be in app.asar`, packaged(f));
    }
  });

  console.log(`\n========================================`);
  console.log(`  LAN Sync Tests: ${pass} passed, ${fail} failed`);
  console.log(`========================================\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('sync test runner failed:', e); process.exit(1); });
