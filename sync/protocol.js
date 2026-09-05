// The parts of LAN sync that have nothing to do with sockets.
//
// Pairing codes, key agreement, and the sealing of a message once a key exists.
// Kept apart from the networking so all of it can be tested without binding a
// port, and so the security-relevant code is small enough to read in one go.
//
// Everything here uses Node's built-in crypto. No dependency is added for sync;
// a whiteboard that promises to work offline should not grow a supply chain to
// move a file across a room.

'use strict';

const crypto = require('node:crypto');

/* The wire format version. Two devices that disagree refuse each other rather
 * than guessing, so an old build can never half-understand a newer one. */
const PROTOCOL = 1;

/* Pairing codes are typed by a person, off a screen, across a desk. The
 * alphabet leaves out O/0, I/1 and similar so nobody has to squint, which
 * costs a little entropy and buys back far more in codes that work first try. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 4;

/* A short code is guessable if an attacker may keep trying, so the defence is
 * not length - it is that a code dies quickly and after very few attempts. */
const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

/* Wrong guesses are counted per device, so one person fumbling the code cannot
 * lock a room out. This is the whole-room brake: a rate rather than a total, so
 * it slows a machine grinding away without ever shutting people out. */
const ROOM_FAILURES_PER_MINUTE = 20;

/**
 * A pairing code: two groups of four, e.g. "7MPU-K7TM".
 *
 * randomInt is rejection-sampled by Node, so the alphabet stays uniform - a
 * plain `% length` would quietly favour the first few characters.
 */
function generateCode() {
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let s = '';
    for (let i = 0; i < CODE_GROUP_LEN; i++) {
      s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    groups.push(s);
  }
  return groups.join('-');
}

/** Accept a code however it was typed: spaces, lower case, missing dash. */
function normaliseCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Roughly how much guessing a code is worth, for the record. */
function codeEntropyBits() {
  return Math.round(CODE_GROUPS * CODE_GROUP_LEN * Math.log2(CODE_ALPHABET.length));
}

/* ------------------------------------------------------------------ *
 * Pairing
 *
 * An X25519 exchange, with the pairing code proving that the two ends are the
 * two devices in the room rather than something in between.
 *
 * The exchange alone stops a passive listener reading the session key. It does
 * NOT stop an active attacker sitting in the middle and doing two exchanges,
 * one with each side. What stops that is the confirmation each side sends: an
 * HMAC over the whole transcript, keyed by the code. A machine in the middle
 * cannot produce it without the code, and it only gets CODE_MAX_ATTEMPTS
 * guesses before the code is dead.
 * ------------------------------------------------------------------ */

/** One side's ephemeral key pair for a pairing attempt. */
function createPairingKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  };
}

function importPublicKey(b64) {
  return crypto.createPublicKey({
    key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki'
  });
}

/**
 * Everything both sides must agree on, in one canonical string.
 *
 * Both device ids and both public keys are in here, so a confirmation cannot be
 * lifted from one pairing and replayed into another, and neither side can be
 * talked into a different partner than it thinks it has.
 */
function transcript(a, b) {
  const ends = [
    `${a.deviceId}|${a.publicKey}`,
    `${b.deviceId}|${b.publicKey}`
  ].sort();                                   // order must not depend on who asked
  return `gazboard-pair/v${PROTOCOL}\n${ends[0]}\n${ends[1]}`;
}

/** The proof that this end knows the code. */
function confirmation(code, a, b, label) {
  return crypto.createHmac('sha256', normaliseCode(code))
    .update(`${label}\n${transcript(a, b)}`)
    .digest('base64');
}

/**
 * The long-term key for a paired device.
 *
 * Derived from the shared secret and bound to the transcript, so it is unique
 * to this pair of devices and this exchange. The pairing code is deliberately
 * NOT an input: it is a one-time proof of who is in the room, and a key that
 * outlived it should not be recoverable from it.
 */
function deriveDeviceKey(privateKey, theirPublicKeyB64, a, b) {
  const shared = crypto.diffieHellman({
    privateKey,
    publicKey: importPublicKey(theirPublicKeyB64)
  });
  return Buffer.from(crypto.hkdfSync(
    'sha256', shared, Buffer.from(transcript(a, b)), Buffer.from('gazboard-device-key'), 32
  ));
}

/** Compare two base64 confirmations without leaking where they differ. */
function confirmationMatches(expected, actual) {
  const e = Buffer.from(String(expected || ''), 'base64');
  const a = Buffer.from(String(actual || ''), 'base64');
  if (e.length === 0 || e.length !== a.length) return false;
  return crypto.timingSafeEqual(e, a);
}

/* ------------------------------------------------------------------ *
 * Sealing a message once the two devices share a key
 * ------------------------------------------------------------------ */

/**
 * Encrypt and authenticate a payload for a paired device.
 *
 * AES-256-GCM with a fresh 12-byte nonce every time. `aad` carries the parts
 * that travel in the clear - who this is from, what kind of message it is - so
 * they cannot be altered in flight without the open failing.
 */
function seal(deviceKey, aad, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deviceKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { v: PROTOCOL, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    aad, body: body.toString('base64') };
}

/** Undo seal(). Returns null on anything that does not verify - never throws. */
function open(deviceKey, envelope) {
  try {
    if (!envelope || envelope.v !== PROTOCOL) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', deviceKey,
      Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(envelope.aad)));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.body, 'base64')),
      decipher.final()
    ]);
  } catch {
    return null;                              // a bad tag is a forgery, not an error
  }
}

/**
 * A short, human-comparable fingerprint of a device key.
 *
 * Shown beside a paired device so two people can check by eye that they paired
 * with each other and not with something in between.
 */
function fingerprint(deviceKey) {
  const d = crypto.createHash('sha256').update(deviceKey).digest('hex').toUpperCase();
  return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}`;
}

/** A device id that stays put across restarts. Random, meaningless, not a name. */
function newDeviceId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  PROTOCOL, CODE_TTL_MS, CODE_MAX_ATTEMPTS, ROOM_FAILURES_PER_MINUTE,
  generateCode, normaliseCode, codeEntropyBits,
  createPairingKeys, transcript, confirmation, deriveDeviceKey, confirmationMatches,
  seal, open, fingerprint, newDeviceId
};
