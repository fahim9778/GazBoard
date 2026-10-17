/*
 * The pencil's sound: the scratch of graphite on paper.
 *
 * Two earlier tries taught what not to do. Filtered noise sounded like rain:
 * an even hiss with nothing in it. Short snippets of a real pencil, fired one
 * after another, were grainy enough but came out as a buzzing patter, and got
 * harsh and loud the faster you drew. Neither is how a pencil sounds to the
 * person holding it: a soft, continuous scratch with its own small irregular
 * catches, that hardly gets louder when you hurry.
 *
 * So this plays a real pencil, continuously. pencil-texture.wav is 20 stretches
 * (0.42 s each) of a pencil scratching steadily on paper, taken from a
 * recording by BigSoundBank (sound 0221, public domain under CC0). While the
 * pencil is down they are played end to end, each one chosen at random and
 * blended into the next over a long, gentle crossfade, so there is no pattern
 * to pick out and no seam to hear. The hand only steers it, and gently:
 *
 *   speed     moving brings it in; holding still lets it fade; hurrying adds
 *             only a little loudness and a little brightness
 *   pressure  a light touch is softer than a firm one
 *   tilt      a pencil on its side, shading, is duller and softer
 *
 * and it fades away the moment the pencil lifts.
 *
 * Putting the pencil down makes its own small sound too: the tick of the lead
 * meeting the paper, which is all a dot is. That is one of eight real
 * touch-downs from the same recording, softer for a light touch.
 *
 * It is a nicety and nothing may depend on it: no audio device, a browser that
 * will not start sound, the recording not loaded yet, a phone on silent - each
 * of those simply means no sound, never an error in the middle of a drawing.
 */

const STRETCH = 0.42;                     // seconds per stretch in the recording
const STRETCHES = 20;
// after the stretches, eight touch-downs from the same recording: the small tick of a pencil meeting the paper
const TAPS_AT = STRETCH * STRETCHES;
const TAP = 0.08;
const TAPS = 8;
const FADE = 0.09;                        // crossfade between stretches
const LEVEL = 0.42;                       // overall loudness: about as loud as a pencil next to you
const SOURCE = new URL('../../assets/sounds/pencil-texture.wav', import.meta.url).href;

let ctx = null;           // one AudioContext for the life of the app, made on first use
let bankBytes = null;     // the recording, fetched once
const banks = new WeakMap();   // decoded, per context
let voice = null;         // the stroke being drawn now, if any

function audio() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

async function fetchBank() {
  if (!bankBytes) bankBytes = fetch(SOURCE).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  return bankBytes;
}

/** The recording, decoded for this context. Resolves to null if it cannot be had. */
async function bankFor(ac) {
  if (banks.has(ac)) return banks.get(ac);
  const p = (async () => {
    const bytes = await fetchBank();
    if (!bytes) return null;
    try { return await ac.decodeAudioData(bytes.slice(0)); } catch { return null; }
  })();
  banks.set(ac, p);
  return p;
}

/** Fetch and decode ahead of the first stroke, so the first line is heard too. */
export function preload() {
  const ac = audio();
  if (ac) bankFor(ac);
}

let seed = 0x2545f491;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

function makeVoice(ac, bank, at) {
  // warmth: the top of the scratch rounded off, more so for a pencil on its side
  const tone = ac.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 7000; tone.Q.value = 0.4;
  const hand = ac.createGain(); hand.gain.value = 0;          // follows the hand
  tone.connect(hand); hand.connect(ac.destination);
  return { ac, bank, tone, hand, next: at, rate: 1, level: 0, lastStretch: -1, sources: new Set() };
}

/** Lay stretches of the recording end to end, crossfaded, from where the last one ends up to `until`. */
function fill(v, until) {
  while (v.next < until) {
    let k = Math.floor(rnd() * STRETCHES);
    if (k === v.lastStretch) k = (k + 1 + Math.floor(rnd() * (STRETCHES - 1))) % STRETCHES;
    v.lastStretch = k;
    const len = STRETCH * (0.7 + rnd() * 0.25);              // a part of a stretch, so no two passes line up
    const from = k * STRETCH + rnd() * (STRETCH - len);
    const src = v.ac.createBufferSource();
    src.buffer = v.bank;
    src.playbackRate.value = v.rate;
    const g = v.ac.createGain();
    const at = v.next, dur = len / v.rate;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(1, at + FADE);
    g.gain.setValueAtTime(1, at + dur - FADE);
    g.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(g); g.connect(v.tone);
    src.start(at, from, len + 0.005);
    v.sources.add(src);
    src.onended = () => v.sources.delete(src);
    v.next = at + dur - FADE;                                // overlap by the crossfade
  }
}

/**
 * The pencil is moving at `speed` (px per ms), pressing `p` (0-1), lying over
 * `tilt` (0 upright - 1 on its side), at time `now`. The sound follows, and
 * unless another movement comes it fades shortly after - a pencil that stops
 * moving stops sounding.
 */
function steer(v, speed, p, tilt, now) {
  const target = Math.min(1, speed / 1.2);
  v.level = v.level * 0.7 + target * 0.3;
  const press = Math.max(0, Math.min(1, p));
  const side = Math.max(0, Math.min(1, tilt));
  // moving at all brings most of it in; hurrying adds only a little more
  const moving = Math.min(1, v.level * 3);
  const loud = LEVEL * Math.pow(moving, 0.8) * (0.85 + 0.3 * v.level) * (0.5 + 0.65 * press) * (1 - 0.3 * side);
  v.rate = (0.94 + 0.08 * v.level - 0.08 * side);
  const g = v.hand.gain;
  g.cancelScheduledValues(now);
  g.setTargetAtTime(loud, now, 0.045);
  g.setTargetAtTime(0, now + 0.12, 0.07);
  v.tone.frequency.setTargetAtTime((5200 + 2600 * v.level) * (1 - 0.45 * side), now, 0.08);
  fill(v, now + 0.6);
}

/** The tick of the pencil meeting the paper, at `at`, pressing `p`. */
function tap(ac, bank, at, p) {
  const src = ac.createBufferSource();
  src.buffer = bank;
  src.playbackRate.value = 0.95 + rnd() * 0.1;
  const g = ac.createGain();
  g.gain.value = LEVEL * 0.9 * (0.3 + 0.8 * Math.max(0, Math.min(1, p)));
  const soft = ac.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 6500; soft.Q.value = 0.4;
  src.connect(soft); soft.connect(g); g.connect(ac.destination);
  src.start(at, TAPS_AT + Math.floor(rnd() * TAPS) * TAP, TAP);
}

function release(v, t) {
  try {
    v.hand.gain.cancelScheduledValues(t);
    v.hand.gain.setTargetAtTime(0, t, 0.03);
    for (const s of v.sources) { try { s.stop(t + 0.25); } catch { /* not started */ } }
  } catch { /* already gone */ }
}

/** The pencil touched down, pressing p. */
export function start(p = 0.5) {
  stop();
  const ac = audio();
  if (!ac) return false;
  try {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const pending = { ac, ready: false, last: null, v: null };
    voice = pending;
    bankFor(ac).then((bank) => {
      if (voice !== pending || !bank) return;
      try { tap(ac, bank, ac.currentTime, p); } catch { /* no tick, no matter */ }
      pending.v = makeVoice(ac, bank, ac.currentTime);
      pending.ready = true;
    });
    return true;
  } catch { voice = null; return false; }
}

/**
 * The pencil moved to (x, y) in screen pixels, pressing p and tilted by tilt.
 * Speed is worked out from the last move.
 */
export function move(x, y, now = (typeof performance !== 'undefined' ? performance.now() : Date.now()), p = 0.5, tilt = 0) {
  const w = voice;
  if (!w) return;
  if (w.last && w.ready) {
    const dt = Math.max(1, now - w.last.t);
    try { steer(w.v, Math.hypot(x - w.last.x, y - w.last.y) / dt, p, tilt, w.ac.currentTime); } catch { /* a closed context: just silence */ }
  }
  w.last = { x, y, t: now };
}

/** The pencil lifted (or the stroke was cancelled). */
export function stop() {
  const w = voice;
  voice = null;
  if (w && w.v) release(w.v, w.ac.currentTime);
}

/** Whether a stroke's sound is playing - for the suite. */
export function playing() { return !!voice; }

/**
 * The same sound, worked out ahead of time instead of live: for the suite, and
 * for recording what the pencil sounds like. `strokes` is a list of strokes,
 * each a list of pointer samples { t (ms from the start), x, y, p, tilt }.
 * Resolves to an AudioBuffer, or null where there is no offline audio.
 */
export async function renderOffline(strokes, seconds, sampleRate = 44100) {
  const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
  if (!OAC) return null;
  const ac = new OAC(1, Math.ceil(seconds * sampleRate), sampleRate);
  const bank = await bankFor(ac);
  if (!bank) return null;
  for (const events of strokes) {
    if (!events.length) continue;
    tap(ac, bank, events[0].t / 1000, events[0].p ?? 0.5);
    const v = makeVoice(ac, bank, events[0].t / 1000);
    let last = null;
    for (const e of events) {
      if (last) steer(v, Math.hypot(e.x - last.x, e.y - last.y) / Math.max(1, e.t - last.t), e.p ?? 0.5, e.tilt || 0, e.t / 1000);
      last = e;
    }
    release(v, events[events.length - 1].t / 1000 + 0.01);
  }
  return ac.startRendering();
}
