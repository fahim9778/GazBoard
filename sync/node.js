// LAN sync: finding other GazBoards, pairing with them, and moving a board.
//
// Deliberately has no Electron in it. It takes plain callbacks and returns
// plain promises, so two of these can be stood up inside one test process and
// talk to each other over loopback - which is how the transfer path gets tested
// without a second machine.
//
// Nothing here runs unless start() is called. An installed copy that never
// turns sync on binds no port and sends no packet.

'use strict';

const http = require('node:http');
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');
const P = require('./protocol.js');

/* Discovery. A port nobody else is using, and a broadcast address rather than
 * multicast: broadcast survives more consumer routers, which is the case that
 * actually matters here. */
const DISCOVERY_PORT = 53319;

/* The transfer port is FIXED, not ephemeral.
 *
 * Typing an address is the fallback for when discovery cannot see a device, and
 * it is only a fallback if the address is all you type. An ephemeral port would
 * mean reading a random five-digit number off the other machine's screen and
 * typing that too, which nobody would do. If the port is already taken the app
 * still starts on a random one - discovery will find it, only manual entry
 * cannot. */
const TRANSFER_PORT = 53318;
const ANNOUNCE_EVERY_MS = 3000;
const PEER_FORGOTTEN_AFTER_MS = 12000;

/* A board with a few imported pages is large; a board that claims to be 200 MB
 * is either a mistake or someone filling your disk. */
const MAX_BOARD_BYTES = 64 * 1024 * 1024;

/* An unauthenticated request gets very little room and very little patience. */
const MAX_PAIR_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
/**
 * How long a send may sit waiting for an answer.
 *
 * Deliberately longer than the five minutes the receiving app gives the person
 * at the dialog, so that end times out first and replies "declined" properly,
 * rather than this end guessing from a dead socket.
 */
const SEND_TIMEOUT_MS = 5.5 * 60 * 1000;

const json = (res, code, body) => {
  const s = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': s.length });
  res.end(s);
};

/** Read a request body, refusing anything over the cap without buffering it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {string} opts.deviceId     stable across restarts
 * @param {string} opts.deviceName   what the other side shows a person
 * @param {object} opts.paired       { get(id), set(id, rec), remove(id), all() } - persistence
 * @param {Function} opts.onBoard    async ({ board, from }) => outcome string; the
 *                                   receiving side's decision. Throwing, or
 *                                   returning null, declines the transfer.
 * @param {Function} [opts.onPeers]  called when the visible device list changes
 */
function createSyncNode(opts) {
  const {
    deviceId, deviceName, paired, onBoard, onPeers = () => {},
    host = '0.0.0.0', broadcast = '255.255.255.255', discoveryPort = DISCOVERY_PORT
  } = opts;

  let server = null;
  let udp = null;
  let announceTimer = null;
  let port = 0;
  let running = false;
  let discovery = false;          // did the announcement socket come up?

  const peers = new Map();          // deviceId -> { deviceId, name, address, port, seen }
  let pending = null;               // the pairing code currently on screen, if any

  /* ---------------- discovery ---------------- */

  function announcement() {
    return Buffer.from(JSON.stringify({
      t: 'gazboard', v: P.PROTOCOL, id: deviceId, name: deviceName, port
    }));
  }

  function notePeer(msg, address) {
    if (!msg || msg.t !== 'gazboard' || msg.id === deviceId) return;
    if (msg.v !== P.PROTOCOL) return;         // a version we cannot speak to
    const before = peers.get(msg.id);
    peers.set(msg.id, {
      deviceId: msg.id, name: String(msg.name || 'Unknown device').slice(0, 64),
      address, port: msg.port, seen: Date.now()
    });
    if (!before || before.address !== address || before.name !== msg.name) onPeers(list());
  }

  function forgetStalePeers() {
    const cutoff = Date.now() - PEER_FORGOTTEN_AFTER_MS;
    let dropped = false;
    for (const [id, p] of peers) if (p.seen < cutoff) { peers.delete(id); dropped = true; }
    if (dropped) onPeers(list());
  }

  /**
   * Where to shout.
   *
   * 255.255.255.255 is the "limited broadcast" address, and on a machine with
   * more than one network interface - a laptop with wifi and a docked ethernet
   * port, a PC with a VM adapter, anything with a VPN installed - the operating
   * system picks ONE interface for it, and often the wrong one. The announcement
   * then goes out somewhere nobody is listening and discovery silently finds
   * nothing, with no error to explain it.
   *
   * The reliable form is each interface's own subnet broadcast: 192.168.0.255
   * for 192.168.0.x. That is computed per interface from its address and mask,
   * and every one of them is used. The limited broadcast is kept as well, for
   * the case where a subnet one is refused.
   */
  function broadcastTargets() {
    if (broadcast !== '255.255.255.255') return [broadcast];   // a test pinning it
    const out = new Set(['255.255.255.255']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
        const ip = a.address.split('.').map(Number);
        const mask = a.netmask.split('.').map(Number);
        if (ip.length !== 4 || mask.length !== 4) continue;
        out.add(ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255)).join('.'));
      }
    }
    return [...out];
  }

  function announce() {
    if (!udp || !running) return;
    forgetStalePeers();
    const msg = announcement();
    for (const target of broadcastTargets()) {
      try { udp.send(msg, discoveryPort, target); } catch { /* that route is not up */ }
    }
  }

  /* ---------------- the server side of pairing ---------------- */

  /**
   * Open pairing and put a code on screen.
   *
   * This is a SESSION, not a single handshake. The code works for as long as
   * the window is open, and any number of devices may use it — because the
   * case that matters is a code on a projector and a room full of people, and
   * one code per student is not a feature, it is a punishment.
   *
   * `remember` is the difference between the two ways people pair:
   *   false  a class or a meeting. Paired for now, forgotten when the app
   *          closes. This is the default, because most pairings are once.
   *   true   your own devices. Kept until you remove them.
   *
   * The person who shows the code is the one whose disk is at stake, so the
   * person who shows the code is the one who chooses.
   */
  function beginPairing({ remember = false, ttlMs = P.CODE_TTL_MS } = {}) {
    pending = {
      code: P.generateCode(),
      expires: Date.now() + ttlMs,
      remember: !!remember,
      attemptsBy: new Map(),        // device id -> wrong guesses
      recentFailures: []            // timestamps, for the room-wide rate limit
    };
    return { code: pending.code, expiresAt: pending.expires, remember: pending.remember };
  }

  function cancelPairing() { pending = null; halfPaired.clear(); }

  function livePairing() {
    if (!pending) return null;
    if (Date.now() > pending.expires) { pending = null; return null; }
    return pending;
  }

  /**
   * Has this device used up its guesses, or is the room being ground through?
   *
   * Counting per device rather than in total matters in a classroom: one
   * student fumbling the code must not lock everybody else out. The room-wide
   * limit is a rate, not a total, for the same reason — it slows a machine down
   * without ever closing the door on people.
   */
  function guessingRefused(active, who) {
    if ((active.attemptsBy.get(who) || 0) >= P.CODE_MAX_ATTEMPTS) return 'too many attempts from that device';
    const minuteAgo = Date.now() - 60000;
    active.recentFailures = active.recentFailures.filter((t) => t > minuteAgo);
    if (active.recentFailures.length >= P.ROOM_FAILURES_PER_MINUTE) return 'too many wrong codes just now - wait a moment';
    return null;
  }

  function noteWrongGuess(active, who) {
    active.attemptsBy.set(who, (active.attemptsBy.get(who) || 0) + 1);
    active.recentFailures.push(Date.now());
  }

  /*
   * Pairing is two round trips, and the order is the security.
   *
   *   hello    initiator sends its half; responder answers with its half.
   *            Nothing is proved and nothing is stored yet.
   *   confirm  initiator proves it knows the code; ONLY THEN does the
   *            responder prove it too, and only then does either side keep a key.
   *
   * The initiator proving first is what stops an attacker harvesting a MAC over
   * the code and grinding it offline: without the code, it never sees one. The
   * code's whole value is during the five minutes it is on screen, and an
   * attacker gets CODE_MAX_ATTEMPTS online guesses inside that window.
   */
  const halfPaired = new Map();      // initiator deviceId -> { keys, them, at }

  function sweepHalfPaired() {
    const cutoff = Date.now() - P.CODE_TTL_MS;
    for (const [id, h] of halfPaired) if (h.at < cutoff) halfPaired.delete(id);
  }

  async function handleHello(req, res) {
    if (!livePairing()) return json(res, 409, { error: 'no pairing in progress' });
    sweepHalfPaired();

    let body;
    try { body = JSON.parse((await readBody(req, MAX_PAIR_BYTES)).toString()); }
    catch { return json(res, 400, { error: 'bad request' }); }
    if (body.v !== P.PROTOCOL) return json(res, 400, { error: 'version mismatch' });
    if (!body.deviceId || !body.publicKey) return json(res, 400, { error: 'bad request' });

    const keys = P.createPairingKeys();
    halfPaired.set(String(body.deviceId), {
      keys,
      them: { deviceId: String(body.deviceId), publicKey: String(body.publicKey) },
      name: String(body.name || 'Unknown device').slice(0, 64),
      at: Date.now()
    });
    return json(res, 200, { v: P.PROTOCOL, deviceId, name: deviceName, publicKey: keys.publicKey });
  }

  async function handleConfirm(req, res) {
    const active = livePairing();
    if (!active) return json(res, 409, { error: 'no pairing in progress' });

    let body;
    try { body = JSON.parse((await readBody(req, MAX_PAIR_BYTES)).toString()); }
    catch { return json(res, 400, { error: 'bad request' }); }

    const half = body.deviceId && halfPaired.get(String(body.deviceId));
    if (!half) return json(res, 409, { error: 'start again' });

    const us = { deviceId, publicKey: half.keys.publicKey };
    const who = half.them.deviceId;

    const barred = guessingRefused(active, who);
    if (barred) return json(res, 429, { error: barred, attemptsLeft: 0 });

    if (!P.confirmationMatches(P.confirmation(active.code, half.them, us, 'initiator'), body.confirm)) {
      noteWrongGuess(active, who);
      const left = Math.max(0, P.CODE_MAX_ATTEMPTS - (active.attemptsBy.get(who) || 0));
      return json(res, 403, { error: 'wrong code', attemptsLeft: left });
    }

    const key = P.deriveDeviceKey(half.keys.privateKey, half.them.publicKey, half.them, us);
    paired.set(who, {
      deviceId: who, name: half.name,
      key: key.toString('base64'), pairedAt: Date.now(),
      // The store keeps remembered devices on disk and session ones only in
      // memory, so closing the app is what forgets a classroom.
      remember: active.remember
    });
    halfPaired.delete(who);
    // The session stays open. Others in the room still have to pair.

    return json(res, 200, {
      v: P.PROTOCOL, deviceId, name: deviceName,
      confirm: P.confirmation(active.code, half.them, us, 'responder'),
      fingerprint: P.fingerprint(key),
      remembered: active.remember
    });
  }

  /* ---------------- the server side of a transfer ---------------- */

  async function handleSend(req, res) {
    let envelope;
    try { envelope = JSON.parse((await readBody(req, MAX_BOARD_BYTES)).toString()); }
    catch (e) {
      return json(res, e.message === 'too large' ? 413 : 400, { error: e.message || 'bad request' });
    }

    const from = envelope?.aad?.from;
    const rec = from && paired.get(from);
    // An unpaired sender is told nothing beyond "no". Whether a given device id
    // is known here is not something a stranger gets to probe for.
    if (!rec) return json(res, 401, { error: 'not paired' });

    const plain = P.open(Buffer.from(rec.key, 'base64'), envelope);
    if (!plain) return json(res, 401, { error: 'not paired' });

    let board;
    try { board = JSON.parse(plain.toString()); } catch { return json(res, 400, { error: 'bad board' }); }

    try {
      const outcome = await onBoard({ board, from: { deviceId: from, name: rec.name } });
      if (!outcome) return json(res, 200, { accepted: false, outcome: 'declined' });
      return json(res, 200, { accepted: true, outcome });
    } catch {
      return json(res, 200, { accepted: false, outcome: 'declined' });
    }
  }

  /* ---------------- the client side ---------------- */

  /** Pair with a peer using the code it is showing. Resolves to the paired record. */
  async function pairWith(peer, code) {
    const keys = P.createPairingKeys();
    const us = { deviceId, publicKey: keys.publicKey };

    const hello = await post(peer, '/pair/hello',
      { v: P.PROTOCOL, deviceId, name: deviceName, publicKey: keys.publicKey });
    if (!hello.ok) throw new Error(hello.body?.error || 'the other device is not expecting a pairing');

    const them = { deviceId: String(hello.body.deviceId), publicKey: String(hello.body.publicKey) };
    if (!them.deviceId || !them.publicKey) throw new Error('the other device answered oddly');

    // Prove first. Only after this does the other end prove anything back, so a
    // wrong code never earns a MAC that could be attacked at leisure.
    const done = await post(peer, '/pair/confirm', {
      v: P.PROTOCOL, deviceId,
      confirm: P.confirmation(code, us, them, 'initiator')
    });
    if (!done.ok) {
      const left = done.body?.attemptsLeft;
      throw new Error(done.body?.error === 'wrong code'
        ? `that code did not match${typeof left === 'number' ? ` - ${left} attempt${left === 1 ? '' : 's'} left` : ''}`
        : (done.body?.error || 'pairing failed'));
    }

    if (!P.confirmationMatches(P.confirmation(code, us, them, 'responder'), done.body.confirm)) {
      throw new Error('the other device did not prove it knew the code');
    }

    const key = P.deriveDeviceKey(keys.privateKey, them.publicKey, us, them);
    const rec = {
      deviceId: them.deviceId,
      name: String(done.body.name || hello.body.name || peer.name || 'Unknown device').slice(0, 64),
      key: key.toString('base64'),
      pairedAt: Date.now(),
      // Mirror what the far end decided, so both machines forget at the same time.
      remember: !!done.body.remembered
    };
    paired.set(rec.deviceId, rec);
    return { ...rec, fingerprint: P.fingerprint(key) };
  }

  /** Send one board to a paired peer. Resolves to what the other end decided. */
  async function send(peer, board, onProgress = null) {
    const rec = paired.get(peer.deviceId);
    if (!rec) throw new Error('not paired with that device');
    const payload = Buffer.from(JSON.stringify(board));
    if (payload.length > MAX_BOARD_BYTES) throw new Error('board is too large to send');

    const envelope = P.seal(Buffer.from(rec.key, 'base64'),
      { from: deviceId, kind: 'board', v: P.PROTOCOL }, payload);

    /*
     * This one waits on a PERSON, so it cannot share the ordinary timeout.
     *
     * Node's socket timeout is an idle timer, and once the body is sent the
     * socket goes quiet while somebody on the other machine looks at the
     * "do you want this board?" dialog. At 30 seconds that meant anyone who
     * paused to think was told the transfer had failed - while the receiving
     * end went right on accepting it and saving the board. Two machines, two
     * different stories about the same transfer, and the one that lost was
     * the one holding the original.
     *
     * The far end gives up after five minutes and answers "declined", so this
     * waits slightly longer and lets that be the thing that decides.
     */
    const reply = await post(peer, '/send', envelope,
      { timeoutMs: SEND_TIMEOUT_MS, onProgress });

    /*
     * "Not paired" from a device we think we ARE paired with means they
     * forgot us while we were away - unpaired on their side with this machine
     * off or on another network, so the message never arrived.
     *
     * Believing them is the only sensible move. Keeping the record would leave
     * a device listed as paired that can never be sent to again, and every
     * later attempt would fail the same way with the same confusing words.
     */
    if (reply.status === 401) {
      paired.remove(peer.deviceId);
      onPeers(list());
      throw new Error(`${rec.name || 'that computer'} has forgotten this one - pair again to send to it`);
    }
    if (!reply.ok) throw new Error(reply.body?.error || 'the other device refused it');
    return reply.body;                          // { accepted, outcome }
  }

  /* ---------------- plumbing ---------------- */

  /**
   * @param {object} opts
   * @param {number} opts.timeoutMs  how long the socket may sit idle
   * @param {Function} opts.onProgress  (sent, total) while the body goes out
   */
  function post(peer, path, body, { timeoutMs = REQUEST_TIMEOUT_MS, onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: peer.address, port: peer.port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not json */ }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('the other device did not answer')); });
      req.on('error', reject);

      if (!onProgress) { req.end(data); return; }

      /*
       * Written in pieces so there is something honest to report.
       *
       * A board carrying imported pages goes on the wire at roughly 1.8x the
       * size of the pictures on it - the data: URLs are base64 once, and the
       * sealed envelope is base64 again - so tens of megabytes is ordinary and
       * a slow wifi makes it a real wait. Sending it as one buffer gives the
       * person nothing to look at but a toast that has already faded.
       */
      const CHUNK = 256 * 1024;
      let sent = 0;
      const pump = () => {
        while (sent < data.length) {
          const end = Math.min(sent + CHUNK, data.length);
          const more = req.write(data.subarray(sent, end));
          sent = end;
          try { onProgress(sent, data.length); } catch { /* never the caller's fault */ }
          if (!more) { req.once('drain', pump); return; }   // let the socket catch up
        }
        req.end();
      };
      pump();
    });
  }

  /* ---------------- lifecycle ---------------- */

  function list() {
    return [...peers.values()]
      .map((p) => {
        const rec = paired.get(p.deviceId);
        return {
          deviceId: p.deviceId, name: p.name, address: p.address, port: p.port,
          paired: !!rec,
          fingerprint: rec ? P.fingerprint(Buffer.from(rec.key, 'base64')) : null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function start() {
    if (running) return { port };
    running = true;

    server = http.createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'GET' && req.url === '/ping') {
        return json(res, 200, { v: P.PROTOCOL, deviceId, name: deviceName });
      }
      if (req.method === 'POST' && req.url === '/pair/hello') return handleHello(req, res).catch(() => json(res, 400, { error: 'bad request' }));
      if (req.method === 'POST' && req.url === '/pair/confirm') return handleConfirm(req, res).catch(() => json(res, 400, { error: 'bad request' }));
      if (req.method === 'POST' && req.url === '/send') return handleSend(req, res).catch(() => json(res, 400, { error: 'bad request' }));
      if (req.method === 'POST' && req.url === '/unpair') return handleUnpair(req, res).catch(() => json(res, 400, { error: 'bad request' }));
      return json(res, 404, { error: 'not found' });
    });
    server.on('error', () => { /* a port that will not bind is not a crash */ });

    // Preferred port first; anything already using it means we take what we can
    // get and rely on discovery, rather than refusing to start.
    await new Promise((resolve) => {
      const fallback = () => {
        server.removeAllListeners('error');
        server.on('error', () => {});
        server.listen(0, host, resolve);
      };
      server.once('error', fallback);
      server.listen(TRANSFER_PORT, host, () => { server.removeAllListeners('error'); server.on('error', () => {}); resolve(); });
    });
    port = server.address().port;

    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (buf, rinfo) => {
      let msg = null;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      notePeer(msg, rinfo.address);
    });
    /*
     * Discovery is a convenience; the transfer port is the feature.
     *
     * 53319 sits in the range operating systems hand out for short-lived
     * outgoing sockets, so another program CAN be holding it - rarely, but it
     * is not ours by right and nothing guarantees it is free. reuseAddr covers
     * most of that, and when it does not, the only correct outcome is to carry
     * on without discovery: boards travel over TCP, and "add a computer by
     * address" needs no announcements at all.
     *
     * What must never happen is what used to: bind() only calls back on
     * SUCCESS, so a refused bind left this promise pending for ever and
     * start() simply never returned. The window then sat on "Starting…"
     * with no error anywhere, which is the worst failure in the file - the
     * app was not broken, it was waiting, and nothing said so.
     */
    discovery = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      udp.once('error', () => done(false));
      // A bind that neither succeeds nor errors is not a state anyone should
      // have to sit through either.
      const guard = setTimeout(() => done(false), 4000);
      if (guard.unref) guard.unref();
      try {
        udp.bind(discoveryPort, () => {
          clearTimeout(guard);
          try { udp.setBroadcast(true); } catch { /* not permitted here */ }
          done(true);
        });
      } catch { clearTimeout(guard); done(false); }
    });
    // From here on a UDP error is just a packet that did not go anywhere.
    udp.on('error', () => { /* no route for a broadcast; by address still works */ });

    if (discovery) {
      announce();
      announceTimer = setInterval(announce, ANNOUNCE_EVERY_MS);
      if (announceTimer.unref) announceTimer.unref();
    } else {
      try { udp.close(); } catch {}
      udp = null;
    }
    return { port, discovery };
  }

  async function stop() {
    endSession();                 // a pairing "just for now" does not survive a close
    running = false;
    if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
    if (udp) { try { udp.close(); } catch {} udp = null; }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    discovery = false;
    peers.clear();
    pending = null;
    halfPaired.clear();
    port = 0;
  }

  /** Add a device by address when discovery cannot see it. */
  async function addByAddress(address, addrPort = TRANSFER_PORT) {
    const reply = await new Promise((resolve, reject) => {
      const req = http.request({ host: address, port: addrPort, path: '/ping', method: 'GET', timeout: 5000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('not a GazBoard')); } });
        });
      req.on('timeout', () => req.destroy(new Error('no answer from that address')));
      // Node's own wording here is for programmers, not for someone standing at
      // a laptop wondering why nothing happened.
      req.on('error', (e) => reject(new Error(
        e.code === 'ECONNREFUSED' ? 'that machine refused the connection'
          : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'that address cannot be reached from here'
            : e.code === 'ETIMEDOUT' ? 'no answer from that address'
              : e.message)));
      req.end();
    });
    if (reply.v !== P.PROTOCOL || !reply.deviceId) throw new Error('not a GazBoard');
    notePeer({ t: 'gazboard', v: reply.v, id: reply.deviceId, name: reply.name, port: addrPort }, address);
    return list().find((p) => p.deviceId === reply.deviceId);
  }

  /**
   * Forget one device, and tell it so.
   *
   * Pairing is a fact two machines hold between them, so forgetting has to
   * travel. Dropping it on one side only left the other still showing "paired"
   * with a Send button that could only ever fail - and the failure would say
   * "not paired" about a device its own screen insisted was paired.
   *
   * The order matters. This end forgets FIRST and unconditionally: a machine
   * that is switched off, or on another network, must never be able to keep
   * itself in somebody's trusted list by being unreachable. Telling them is
   * best effort on top of that, and its failure changes nothing here.
   *
   * The message is sealed with the key the two of them share, which is what
   * stops a stranger on the wifi from unpairing people for sport.
   */
  async function unpair(id) {
    const rec = paired.get(id);
    paired.remove(id);
    if (!rec) return false;

    const peer = peers.get(id);
    if (!peer) return false;                 // not on the network right now
    try {
      const envelope = P.seal(Buffer.from(rec.key, 'base64'),
        { from: deviceId, kind: 'unpair', v: P.PROTOCOL }, Buffer.from(deviceId));
      await post(peer, '/unpair', envelope, { timeoutMs: 5000 });
      onPeers(list());
      return true;
    } catch {
      // They find out the next time they try to send: see send().
      return false;
    }
  }

  /**
   * The other end has forgotten us.
   *
   * Authenticated by the shared key - an envelope that will not open is simply
   * ignored, and the reply is the same either way so nothing about who is or is
   * not paired here leaks to whoever asked.
   */
  async function handleUnpair(req, res) {
    let envelope;
    try { envelope = JSON.parse((await readBody(req, 64 * 1024)).toString()); }
    catch { return json(res, 400, { error: 'bad request' }); }

    const from = envelope?.aad?.from;
    const rec = from && paired.get(from);
    if (rec) {
      const plain = P.open(Buffer.from(rec.key, 'base64'), envelope);
      if (plain && plain.toString() === from) {
        paired.remove(from);
        onPeers(list());                     // the list now says "not paired"
      }
    }
    return json(res, 200, { ok: true });
  }

  /**
   * Drop everyone who was only paired for now.
   *
   * What a teacher presses at the end of a class, and what closing the app
   * should do by itself.
   */
  function endSession() {
    let dropped = 0;
    for (const rec of paired.all()) {
      if (!rec.remember) { paired.remove(rec.deviceId); dropped++; }
    }
    pending = null;
    halfPaired.clear();
    return dropped;
  }

  return {
    start, stop, peers: list, addByAddress,
    beginPairing, cancelPairing, pairWith, send, unpair, endSession,
    pairedDevices: () => paired.all().map((r) => ({
      deviceId: r.deviceId, name: r.name, remember: !!r.remember, pairedAt: r.pairedAt,
      fingerprint: P.fingerprint(Buffer.from(r.key, 'base64'))
    })),
    get port() { return port; },
    get running() { return running; },
    // False when the announcement socket could not bind: everything still
    // works, but only by address - nobody appears in anybody's list.
    get discovery() { return discovery; }
  };
}

module.exports = { createSyncNode, DISCOVERY_PORT, TRANSFER_PORT, MAX_BOARD_BYTES };
