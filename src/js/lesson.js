/*
 * Record a lesson: your voice and the board together, saved as one video.
 *
 * Press record, teach as you always do, press stop, and save. The video shows
 * the board exactly as the room saw it - the ink appearing as it was written,
 * the view moving as you panned and zoomed, the laser where you pointed, undo
 * where you undid - with your voice in step.
 *
 * Why it never slows the pen down
 * -------------------------------
 * Nothing is filmed while you teach. A screen recorder copies the whole screen
 * thirty times a second, which is exactly the work that makes ink feel heavy.
 * This keeps notes instead, and they are tiny:
 *
 *   - every change to the board, as it happens (the board already announces
 *     each one; this only listens - store.onApplied)
 *   - twenty times a second: where the view is, how far the pen has got along
 *     the line it is drawing, and where the laser is - a few numbers read and
 *     put down, nothing drawn
 *   - your voice, taken on the browser's own audio thread (lesson-tap.js) and
 *     compressed as it arrives, a tenth of a second at a time
 *
 * The video is made afterwards, from those notes: the board is drawn again,
 * frame by frame, at 2560 x 1440 where the machine can encode it (1920 x 1080
 * or 1280 x 720 where it cannot). Drawn, not copied from the screen, so the
 * writing is as sharp as the board itself, whatever size the window was. And
 * while the video is being made it steps aside the moment the pen touches the
 * board, and carries on when it lifts.
 *
 * Desktop and web. The Android app has no way in to the microphone yet, so it
 * does not offer it.
 */
import { t } from './i18n.js';
import { Surface } from './core/surface.js';
import { Camera } from './core/camera.js';
import { Store, boundsOf } from './core/store.js';
import { pageRects, pageIndexForBoxIn } from './core/pages.js';
import { drawObject, setPageColor, getImage } from './core/render.js';
import { encoderChoice } from './replay.js';
import { muxMp4AV, muxWebmAV } from './videomux.js';
import { progressToast } from './backup.js';
import { h } from './ui/popover.js';
import { icon } from './ui/icons.js';

/*
 * How long one video is, and how long a lesson can go on.
 *
 * A finished video is put together in memory before it is saved, so one video is
 * kept to an hour (half an hour on a phone, which has less memory, and whose app
 * can hand the page at most 1 GB per file). A lesson that goes on longer does not
 * stop: the recording carries straight on, and when it is saved it comes out as
 * part 1, part 2, ... - each its own video, made one after the other once the
 * lesson is over, like the "converting" step of a meeting recorder. Nothing extra
 * happens while teaching; the parts are only cut when the video is made.
 *
 * The limit is a guard, not a goal: notes and voice for four hours are about
 * 250 MB, which a computer holds easily.
 */
export const LESSON_PART_MS = 60 * 60 * 1000;
export const PHONE_PART_MS = 30 * 60 * 1000;
export const LESSON_LIMIT_MS = 4 * 60 * 60 * 1000;
export const PHONE_LIMIT_MS = 2 * 60 * 60 * 1000;
const PHONE_FILE_MAX = 1000 * 1024 * 1024;
export const onAndroid = () => typeof document !== 'undefined' && document.documentElement?.dataset.platform === 'android';
export const lessonPartMs = () => (onAndroid() ? PHONE_PART_MS : LESSON_PART_MS);
export const lessonMaxMs = () => (onAndroid() ? PHONE_LIMIT_MS : LESSON_LIMIT_MS);
/** A last part shorter than this is not worth a file of its own: it goes on the end of the one before. */
const TAIL_MS = 2000;
/** How often the notes are taken. Twenty a second is smooth for a pan and costs nothing. */
export const SAMPLE_MS = 50;
export const FPS = 30;
const VOICE_BITRATE = 128000;

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const clone = (v) => { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Can this copy of GazBoard record a lesson at all? */
export function lessonAvailable() {
  if (typeof window === 'undefined') return false;
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Bits a second for the picture: plenty for thin ink, and a still board costs far less than this. */
export function lessonBitrate(w, h) {
  // a phone: a little less, so half an hour fits in a file Android will hand over
  if (onAndroid()) return Math.round(Math.min(6_000_000, Math.max(3_000_000, w * h * FPS * 0.05)));
  return Math.round(Math.min(10_000_000, Math.max(5_000_000, w * h * FPS * 0.07)));
}

async function audioSupported(codec) {
  if (typeof AudioEncoder !== 'function') return false;
  try { return !!(await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 1, bitrate: VOICE_BITRATE })).supported; }
  catch { return false; }
}

/**
 * The sharpest video this machine can make for a window of this shape, and the
 * sound to go with it. Decided BEFORE recording, because the voice is
 * compressed while you speak and has to suit the file it will end up in.
 */
export async function lessonFormat(cssW, cssH, sizes = [2560, 1920, 1280], prefer = null) {
  const w0 = Math.max(1, cssW), h0 = Math.max(1, cssH);
  for (const longest of sizes) {
    const s = longest / Math.max(w0, h0);
    const W = even(w0 * s), H = even(h0 * s);
    const bits = lessonBitrate(W, H);
    const v = prefer === 'webm' ? await webmChoice(W, H, bits) : await encoderChoice(W, H, FPS, bits);
    if (!v) continue;
    let audio = null;
    if (v.ext === 'mp4') audio = (await audioSupported('mp4a.40.2')) ? 'aac' : (await audioSupported('opus')) ? 'opus' : null;
    else audio = (await audioSupported('opus')) ? 'opus' : null;
    return { video: v, W, H, scale: W / w0, bits, audio };
  }
  return null;
}

/** WebM only: what a machine with no H.264 encoder uses (and what the suite checks that path with). */
async function webmChoice(w, h, bitrate) {
  if (typeof VideoEncoder !== 'function') return null;
  for (const codec of ['vp09.00.50.08', 'vp09.00.40.08', 'vp8']) {
    const config = { codec, width: w, height: h, bitrate, framerate: FPS };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, ext: 'webm' }; } catch { /* the next one */ }
  }
  return null;
}

/** mm:ss, or h:mm:ss past an hour. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

/* ================================================================== *
 *  Taking the notes
 * ================================================================== */

export class LessonRecorder {
  constructor(app) {
    this.app = app;
    this.state = 'idle';            // idle | starting | recording | paused | saving
    this.bar = null;
    this.last = null;               // the last lesson, kept until it is saved or another one starts
  }

  get recording() { return this.state === 'recording' || this.state === 'paused'; }
  get busy() { return this.state !== 'idle'; }

  /** The lesson's own clock: milliseconds of recording, pauses left out. */
  now(at = performance.now()) {
    if (!this.t0) return 0;
    const end = this.pausedAt != null ? Math.min(at, this.pausedAt) : at;
    return Math.max(0, end - this.t0 - this.pausedTotal);
  }

  /**
   * Start recording.
   * @param {object} [o]
   * @param {MediaStream} [o.stream]  a sound source to use instead of the microphone (the suite's tone)
   * @param {boolean} [o.silent]      no sound at all
   * @param {number[]} [o.sizes]      video sizes to try, longest side first
   * @param {string} [o.prefer]       'webm' to skip MP4 (the suite)
   * @param {number} [o.partMs]       how long one part is (the suite uses seconds, not an hour)
   * @param {number} [o.limitMs]      when the recording stops by itself (the suite)
   */
  async start(o = {}) {
    if (this.state !== 'idle') return false;
    this.partMs = o.partMs || null;
    this.limitMs = o.limitMs || null;
    if (!lessonAvailable()) {
      this.app.toast(t('Recording a lesson needs the GazBoard app on a computer'), 'help', 5000);
      return false;
    }
    this.state = 'starting';
    try {
      const surf = this.app.surface;
      const format = await lessonFormat(surf.width, surf.height, o.sizes || (onAndroid() ? [1920, 1280] : undefined), o.prefer);
      if (!format) {
        this.app.toast(t('This device cannot record video'), 'help', 5000);
        this.state = 'idle';
        return false;
      }
      let stream = o.stream || null;
      let micNote = '';
      if (!stream && !o.silent && format.audio) {
        const res = await openMicrophone();
        stream = res.stream; micNote = res.why;
      }
      if (!stream && !o.silent) {
        const go = await this.app.confirm(t('Record without sound?'),
          format.audio
            ? t('GazBoard could not use a microphone ({why}). You can still record the board without your voice.', { why: micNote || t('none found') })
            : t('This device cannot record sound in a video. You can still record the board without your voice.'),
          t('Record without sound'));
        if (!go) { this.state = 'idle'; return false; }
      }
      this.format = format;
      this.audio = null;
      if (stream && format.audio) this.audio = await this.openTap(stream, format.audio, !!o.stream);
      this.begin();
      return true;
    } catch (e) {
      this.teardown();
      this.state = 'idle';
      this.app.toast(t('Could not start recording: {error}', { error: e.message || String(e) }), 'help', 6000);
      return false;
    }
  }

  /** The voice: microphone -> audio thread (lesson-tap.js) -> compressed as it comes. */
  async openTap(stream, codec, borrowed) {
    let ac;
    try { ac = new AudioContext({ sampleRate: 48000 }); } catch { ac = new AudioContext(); }
    await ac.audioWorklet.addModule(new URL('./lesson-tap.js', import.meta.url).href);
    if (ac.state === 'suspended') { try { await ac.resume(); } catch { /* it starts with the first sound */ } }
    const sr = ac.sampleRate;
    const src = ac.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ac, 'gazboard-lesson-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ac.createGain();
    mute.gain.value = 0;                  // the voice is listened to, never played back into the room
    src.connect(tap); tap.connect(mute); mute.connect(ac.destination);
    const a = { ac, src, tap, mute, stream, borrowed, codec, sampleRate: sr, chunks: [], description: null, frames: 0, failed: null };
    a.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const d = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (d && !a.description) a.description = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const fallback = codec === 'aac' ? 1024 : 960;
        const duration = chunk.duration ? Math.max(1, Math.round((chunk.duration * sr) / 1e6)) : fallback;
        a.chunks.push({ data, timestamp: chunk.timestamp, duration, durationUs: chunk.duration || Math.round((fallback / sr) * 1e6) });
      },
      error: (e) => { a.failed = e; }
    });
    a.encoder.configure({ codec: codec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: sr, numberOfChannels: 1, bitrate: VOICE_BITRATE });
    tap.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.flushed) { a.onFlushed?.(); return; }
      if (!m.samples || a.failed || a.encoder.state !== 'configured') return;
      const data = m.samples;
      const ad = new AudioData({ format: 'f32', sampleRate: sr, numberOfFrames: data.length, numberOfChannels: 1,
        timestamp: Math.round((a.frames / sr) * 1e6), data });
      a.frames += data.length;
      try { a.encoder.encode(ad); } catch (err) { a.failed = err; }
      ad.close();
    };
    return a;
  }

  begin() {
    const app = this.app, surf = app.surface, store = app.store;
    const d = store.doc;
    this.lesson = {
      start: { order: d.order.slice(), objects: clone(d.objects), background: clone(d.background || {}), pages: clone(d.pages || []) },
      events: [], cams: [], laser: [], boardName: d.name || '',
      // when each part began, on the wall clock: the parts' file names say so
      partMs: this.partMs || lessonPartMs(), partStarts: [Date.now()]
    };
    this.t0 = performance.now();
    this.pausedTotal = 0;
    this.pausedAt = null;
    this.curWet = null; this.wetSamples = null;
    this.lastLaser = performance.now();
    this.camKey = '';
    this.sampleCam();
    // every change to the board, the moment it is made
    this.offApplied = store.onApplied((op) => this.noteOp(op));
    // another board opened: this lesson is over
    this.offStore = store.subscribe((reason) => {
      if (reason === 'load' && this.recording) this.stop({ why: 'board' });
    });
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    /*
     * A phone that goes to another app, or whose screen locks, stops GazBoard's page
     * - and with it the microphone. Rather than a recording with a hole in it that
     * nobody chose, the lesson pauses itself and waits, showing Paused, for Resume.
     */
    this.onHide = () => { if (document.hidden && onAndroid() && this.state === 'recording') this.pause(); };
    document.addEventListener('visibilitychange', this.onHide);
    this.state = 'recording';
    this.showBar();
    app.syncUI?.();
  }

  noteOp(op) {
    const at = this.now();
    const ev = { t: at, op: clone(op) };
    // a line just finished: how fast it was written, so the video writes it at the same pace
    if (op.t === 'add' && op.obj && op.obj.type === 'stroke' && this.curWet && (op.obj === this.curWet || op.obj.id === this.curWet.id)) {
      const s = this.wetSamples || [];
      ev.draw = { samples: [...s, { t: at, n: this.curWet.points.length }], len: this.curWet.points.length };
      this.curWet = null; this.wetSamples = null;
    }
    this.lesson.events.push(ev);
  }

  sampleCam() {
    const surf = this.app.surface, c = surf.cam;
    const key = `${c.x}|${c.y}|${c.z}|${surf.width}|${surf.height}`;
    if (key === this.camKey) return;
    this.camKey = key;
    this.lesson.cams.push({ t: this.now(), x: c.x, y: c.y, z: c.z, w: surf.width, h: surf.height });
  }

  /** Twenty times a second: a handful of numbers, nothing drawn. */
  sample() {
    if (!this.lesson) return;
    const surf = this.app.surface;
    const at = this.now();
    this.sampleCam();
    // the line being written: how far along it is
    const wet = surf.wet;
    if (wet !== this.curWet) {
      this.curWet = wet || null;
      this.wetSamples = wet ? [{ t: at, n: wet.points.length }] : null;
    } else if (wet) {
      const last = this.wetSamples[this.wetSamples.length - 1];
      if (!last || last.n !== wet.points.length) this.wetSamples.push({ t: at, n: wet.points.length });
    }
    // the laser, point by point with the moment each was made
    if (this.state === 'recording') {
      const pts = surf.laser;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.t > this.lastLaser) this.lesson.laser.push({ x: p.x, y: p.y, t: this.now(p.t) });
      }
      if (pts.length) this.lastLaser = Math.max(this.lastLaser, pts[pts.length - 1].t);
      this.lesson.laserColor = surf.laserColor || null;
    }
    // a new part begins: nothing is cut now, only noted (the parts are made when the video is)
    const L = this.lesson, k = Math.floor(at / L.partMs);
    if (k >= L.partStarts.length) {
      L.partStarts.push(Date.now() - (at - k * L.partMs));
      this.syncBar();
    }
    if (this.timeEl) {
      const s = clock(at);
      if (this.timeEl.textContent !== s) this.timeEl.textContent = s;
    }
    if (at >= (this.limitMs || lessonMaxMs())) this.stop({ why: 'long' });
  }

  pause() {
    if (this.state !== 'recording') return;
    this.pausedAt = performance.now();
    this.state = 'paused';
    this.audio?.tap.port.postMessage({ paused: true });
    this.syncBar();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = null;
    this.lastLaser = performance.now();
    this.state = 'recording';
    this.audio?.tap.port.postMessage({ paused: false });
    this.syncBar();
  }

  /** Stop listening to everything; the notes are kept. */
  teardown() {
    clearInterval(this.timer); this.timer = null;
    if (this.onHide) { document.removeEventListener('visibilitychange', this.onHide); this.onHide = null; }
    this.offApplied?.(); this.offApplied = null;
    this.offStore?.(); this.offStore = null;
    this.hideBar();
  }

  /** Hand back the voice: the last tenth of a second, then the encoder's last pieces. */
  async closeTap() {
    const a = this.audio;
    if (!a) return null;
    try {
      await Promise.race([new Promise((r) => { a.onFlushed = r; a.tap.port.postMessage({ flush: true }); }), sleep(600)]);
      // the last message may still be on its way to this thread
      await sleep(20);
      if (a.encoder.state === 'configured') await a.encoder.flush();
    } catch (e) { a.failed = a.failed || e; }
    try { a.encoder.close(); } catch { /* closed */ }
    try { a.src.disconnect(); a.tap.disconnect(); a.mute.disconnect(); } catch { /* gone */ }
    if (!a.borrowed) for (const tr of a.stream.getTracks()) { try { tr.stop(); } catch { /* stopped */ } }
    try { await a.ac.close(); } catch { /* closed */ }
    this.audio = null;
    if (a.failed || !a.chunks.length) return null;
    return { codec: a.codec, sampleRate: a.sampleRate, channels: 1, chunks: a.chunks, description: a.description, bitrate: VOICE_BITRATE };
  }

  /**
   * Stop, make the video and ask where to save it.
   * @param {object} [o]  { save: false } returns the finished file instead of asking (the suite)
   */
  async stop(o = {}) {
    if (!this.recording) return null;
    const duration = this.now();
    this.teardown();
    this.state = 'saving';
    this.app.syncUI?.();
    if (o.why === 'board') this.app.toast(t('Recording stopped: another board was opened'), 'help', 4000);
    if (o.why === 'long') this.app.toast(t('Recording stopped after {hours} hours', { hours: Math.round((this.limitMs || lessonMaxMs()) / 3600000) }), 'help', 5000);
    const voice = await this.closeTap();
    const lesson = { ...this.lesson, duration, format: this.format, voice };
    this.lesson = null;
    this.last = lesson;
    try {
      if (o.save === false) return await makeLessonVideo(lesson, { yieldTo: o.yieldTo || (() => this.penBusy()), onProgress: o.onProgress });
      return await this.saveLast();
    } finally {
      this.state = 'idle';
      this.app.syncUI?.();
    }
  }

  /** Is the pen (or a finger, or the mouse) doing something on the board right now? */
  penBusy() {
    const it = this.app.interaction;
    return !!(it && (it.action || (it.pointers && it.pointers.size)));
  }

  /**
   * While the video is being made: step aside whenever the person is using the
   * app - a pen on the board, the mouse moving, the wheel, a key - and carry on
   * a moment after they stop. Making the video then only ever uses time nobody
   * else wanted, so nothing they do can feel slower for it.
   */
  watchHands() {
    let lastInput = 0;
    const note = () => { lastInput = performance.now(); };
    const kinds = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'];
    for (const k of kinds) window.addEventListener(k, note, { capture: true, passive: true });
    return {
      busy: () => this.penBusy() || performance.now() - lastInput < 350,
      off: () => { for (const k of kinds) window.removeEventListener(k, note, { capture: true }); }
    };
  }

  /**
   * Make the video of the last lesson and save it. Cancelling keeps the lesson so it can be saved later.
   *
   * A lesson longer than one part comes out as several videos, made one after the other. On a
   * computer the first asks where to save and the rest go into the same folder by themselves;
   * on a phone or in a browser, where the app cannot pick a file name next to another, each part
   * asks. A part that is saved stays saved: "Save it now" after a cancel carries on from the next.
   *
   * @param {object} [io]  { saveDialog, writeFile } in place of the app's own (the suite answers the dialog itself)
   */
  async saveLast(io = {}) {
    const ask = io.saveDialog || ((o) => window.board.saveDialog(o));
    const write = io.writeFile || ((p, b) => window.board.writeFile(p, b));
    const lesson = this.last;
    if (!lesson) return null;
    const parts = lessonParts(lesson);
    const many = parts.length > 1;
    const base = String(lesson.boardName || 'board').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80).trim() || 'board';
    // the desktop app writes real files, so the parts after the first can go beside it
    const beside = !onAndroid() && typeof location !== 'undefined' && location.protocol === 'app:';
    const saved = lesson.savedPaths || (lesson.savedPaths = []);
    for (let k = lesson.savedParts || 0; k < parts.length; k++) {
      const part = parts[k];
      const ctrl = new AbortController();
      const label = many ? t('Making part {n} of {total}…', { n: k + 1, total: parts.length }) : t('Making the lesson video…');
      const toast = progressToast(label, { onCancel: () => ctrl.abort() });
      let res = null;
      const hands = this.watchHands();
      try {
        res = await makeLessonVideo(many ? lessonPart(lesson, part.from, part.to) : lesson,
          { signal: ctrl.signal, yieldTo: hands.busy, onProgress: (p) => toast.set(null, p) });
      } catch (e) {
        hands.off();
        toast.done();
        this.app.toast(t('Could not make the lesson video: {error}', { error: e.message || String(e) }), 'help', 7000,
          { label: t('Try again'), onClick: () => this.saveLast() });
        return null;
      }
      hands.off();
      toast.done();
      if (!res) {
        this.app.toast(t('The lesson is kept until you record another one'), 'help', 7000, { label: t('Save it now'), onClick: () => this.saveLast() });
        return null;
      }
      if (onAndroid() && res.bytes.length > PHONE_FILE_MAX) {
        this.app.toast(t('This lesson video is too big to save on a phone ({size} MB). Shorter lessons save fine.', { size: Math.round(res.bytes.length / 1048576) }), 'help', 8000);
        lesson.savedParts = k + 1;
        continue;
      }
      const name = lessonFileName(base, part.wall, many ? k + 1 : 0, res.ext);
      const dir = beside && saved.length ? folderOf(saved[0]) : null;
      let path = null;
      if (dir) {
        path = dir + name;
        try { await write(path, res.bytes); } catch {
          // the folder went away (a USB stick pulled out): ask instead
          path = null;
        }
      }
      while (!path) {
        path = await ask({
          title: many ? t('Save part {n} of {total}', { n: k + 1, total: parts.length }) : t('Save the lesson video'),
          defaultPath: name,
          filters: [{ name: res.ext.toUpperCase(), extensions: [res.ext] }]
        });
        if (path) { await write(path, res.bytes); break; }
        const drop = await this.app.confirm(t('Throw this lesson away?'), t('The video has not been saved anywhere yet.'), t('Throw it away'));
        if (drop) { this.last = null; return null; }
      }
      saved.push(path);
      lesson.savedParts = k + 1;
      res = null;   // this part's video is written: let it go before the next is made
    }
    this.last = null;
    if (!saved.length) return null;
    if (many) this.app.toast(t('Saved {count} parts of the lesson', { count: saved.length }));
    else this.app.toast(t('Saved {name}', { name: String(saved[0]).split(/[\\/]/).pop() }));
    return many ? saved : saved[0];
  }

  /* ---------------- the bar ---------------- */

  showBar() {
    if (this.bar) return;
    this.timeEl = h('span', { class: 'lesson-time', 'data-lesson-time': '1' }, '0:00');
    this.pauseBtn = h('button', { type: 'button', class: 'lesson-btn', 'data-lesson-pause': '1' });
    this.pauseBtn.addEventListener('click', () => (this.state === 'paused' ? this.resume() : this.pause()));
    const stop = h('button', { type: 'button', class: 'lesson-btn lesson-stop', 'data-lesson-stop': '1', title: t('Stop and save'), 'aria-label': t('Stop and save') },
      h('span', { class: 'lesson-square' }), h('span', {}, t('Stop')));
    stop.addEventListener('click', () => this.stop());
    this.dot = h('span', { class: 'lesson-dot' });
    this.bar = h('div', { class: 'lesson-bar', role: 'status', 'data-lesson-bar': '1' },
      this.dot, h('span', { class: 'lesson-label' }, t('Recording')), this.timeEl, this.pauseBtn, stop);
    (document.getElementById('stage') || document.body).appendChild(this.bar);
    this.syncBar();
  }

  syncBar() {
    if (!this.bar) return;
    const paused = this.state === 'paused';
    this.bar.classList.toggle('paused', paused);
    const part = this.lesson ? this.lesson.partStarts.length : 1;
    this.bar.querySelector('.lesson-label').textContent = paused ? t('Paused')
      : part > 1 ? t('Recording · part {n}', { n: part }) : t('Recording');
    this.pauseBtn.textContent = paused ? t('Resume') : t('Pause');
  }

  hideBar() {
    if (this.bar) this.bar.remove();
    this.bar = null; this.timeEl = null;
  }

  toggle() { return this.recording ? this.stop() : this.start(); }
}

/** The microphone, with the room's echo and hum taken out by the browser. Never throws. */
async function openMicrophone() {
  try {
    // macOS asks the person first, and only when GazBoard says what it wants the microphone for
    if (window.board && typeof window.board.askMicrophone === 'function') {
      const ok = await window.board.askMicrophone();
      if (ok === false) return { stream: null, why: t('not allowed') };
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false
    });
    return { stream, why: '' };
  } catch (e) {
    const why = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? t('not allowed')
      : e && e.name === 'NotFoundError' ? t('none found') : (e && e.message) || String(e);
    return { stream: null, why };
  }
}

/* ================================================================== *
 *  Making the video
 * ================================================================== */

/** Where the view was at lesson time t: held still between notes, and gliding across the last 50 ms into each new one. */
export function viewAt(cams, t) {
  if (!cams.length) return { x: 0, y: 0, z: 1, w: 0, h: 0 };
  let lo = 0, hi = cams.length - 1;
  if (t <= cams[0].t) return cams[0];
  if (t >= cams[hi].t) return cams[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cams[mid].t <= t) lo = mid; else hi = mid; }
  const a = cams[lo], b = cams[hi];
  const glideFrom = Math.max(a.t, b.t - SAMPLE_MS);
  if (t <= glideFrom) return a;
  const k = (t - glideFrom) / Math.max(1, b.t - glideFrom);
  // glide the CENTRE and the zoom, so a zoom with the wheel does not swing sideways on the way
  const ca = { x: (a.w / 2 - a.x) / a.z, y: (a.h / 2 - a.y) / a.z };
  const cb = { x: (b.w / 2 - b.x) / b.z, y: (b.h / 2 - b.y) / b.z };
  const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * k);
  const w = a.w + (b.w - a.w) * k, hh = a.h + (b.h - a.h) * k;
  const cx = ca.x + (cb.x - ca.x) * k, cy = ca.y + (cb.y - ca.y) * k;
  return { x: w / 2 - cx * z, y: hh / 2 - cy * z, z, w, h: hh };
}

/** How many of a line's points had been written by lesson time t. */
export function pointsBy(draw, t, total) {
  const s = draw.samples;
  if (!s.length || t >= s[s.length - 1].t) return total;
  if (t < s[0].t) return 0;
  let i = 0;
  while (i < s.length - 1 && s[i + 1].t <= t) i++;
  const a = s[i], b = s[i + 1] || a;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  const n = a.n + (b.n - a.n) * k;
  return Math.max(1, Math.min(total, Math.round((n / Math.max(1, draw.len)) * total)));
}

/**
 * The parts a lesson comes out as: [{ from, to, wall }], lesson-clock milliseconds, and when on
 * the wall clock each part began (for its file name). One part for anything up to the part length;
 * a few seconds left over at the very end join the last part instead of making a file of their own.
 */
export function lessonParts(lesson) {
  const len = Math.max(0, lesson.duration || 0);
  const partMs = lesson.partMs || lessonPartMs();
  const n = Math.max(1, Math.ceil((len - Math.min(TAIL_MS, partMs / 10)) / partMs));
  const starts = lesson.partStarts || [];
  const began = starts[0] || lesson.startedAt || Date.now();
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ from: k * partMs, to: k === n - 1 ? Infinity : (k + 1) * partMs, wall: starts[k] || began + k * partMs });
  }
  return out;
}

/**
 * One part of a lesson, as a lesson of its own: the board as it stood when the part began, and
 * from there the same notes - changes, view, laser, voice - with the part's start as time zero.
 * Nothing is copied that does not need to be: the voice's pieces are shared, not duplicated.
 */
export function lessonPart(lesson, from, to) {
  const store = new Store();
  store.doc.order = lesson.start.order.slice();
  store.doc.objects = clone(lesson.start.objects);
  store.doc.background = clone(lesson.start.background);
  store.doc.pages = clone(lesson.start.pages);
  const events = [];
  for (const ev of lesson.events) {
    if (ev.t < from) {
      // a change that happened before this part: it is simply on the board when the part begins
      store._apply(clone(ev.op));
      continue;
    }
    if (ev.t >= to) break;
    const moved = { ...ev, t: ev.t - from };
    if (ev.draw) moved.draw = { ...ev.draw, samples: ev.draw.samples.map((p) => ({ ...p, t: p.t - from })) };
    events.push(moved);
  }
  // the view: where it stood as the part began, then every move during it
  const cams = [];
  let before = null;
  for (const c of lesson.cams) {
    if (c.t <= from) { before = c; continue; }
    if (c.t >= to) break;
    cams.push({ ...c, t: c.t - from });
  }
  if (before) cams.unshift({ ...before, t: 0 });
  const laser = lesson.laser.filter((p) => p.t >= from && p.t < to).map((p) => ({ ...p, t: p.t - from }));
  let voice = null;
  if (lesson.voice) {
    const a = from * 1000, b = to * 1000;
    const chunks = lesson.voice.chunks.filter((c) => c.timestamp >= a && c.timestamp < b).map((c) => ({ ...c, timestamp: c.timestamp - a }));
    if (chunks.length) voice = { ...lesson.voice, chunks };
  }
  const end = Math.min(to, lesson.duration);
  return {
    ...lesson,
    start: { order: store.doc.order.slice(), objects: store.doc.objects, background: store.doc.background, pages: store.doc.pages },
    events, cams, laser, voice, duration: Math.max(0, end - from)
  };
}

/** "Chapter 4 2026-11-24 18-14-33.mp4", or "... part 2.mp4": the moment it began makes every name its own. */
export function lessonFileName(base, wall, part, ext) {
  const d = new Date(wall || Date.now());
  const two = (n) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  return `${base} ${when}${part ? ' ' + t('part {n}', { n: part }) : ''}.${ext}`;
}

/** The folder part of a saved file's path, with its separator. */
function folderOf(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(0, i + 1) : '';
}

/** Pictures decode in the background; the video waits for them so none is missing from a frame. */
async function preload(lesson) {
  const srcs = new Set();
  for (const o of Object.values(lesson.start.objects || {})) if (o && o.src) srcs.add(o.src);
  for (const ev of lesson.events) {
    if (ev.op.obj && ev.op.obj.src) srcs.add(ev.op.obj.src);
    if (ev.op.after && ev.op.after.src) srcs.add(ev.op.after.src);
  }
  await Promise.all([...srcs].map((src) => new Promise((res) => {
    const timer = setTimeout(res, 5000);
    const done = () => { clearTimeout(timer); res(); };
    if (getImage(src, done)) done();
  })));
  try { await document.fonts?.ready; } catch { /* fonts are a nicety */ }
}

/**
 * The video, frame by frame, from the lesson's notes.
 *
 * @param {object} lesson  what LessonRecorder kept
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.onProgress]  0..1
 * @param {Function} [o.yieldTo]     returns true while the person is using the pen: the video waits
 * @returns {Promise<{bytes: Uint8Array, ext: string, width: number, height: number, frames: number}|null>}  null if cancelled
 */
export async function makeLessonVideo(lesson, { signal, onProgress, yieldTo } = {}) {
  const f = lesson.format;
  const W = f.W, H = f.H, s = f.scale, cssW = W / s, cssH = H / s;
  await preload(lesson);

  // the board as it was when recording began, played forward
  const store = new Store();
  store.doc.order = lesson.start.order.slice();
  store.doc.objects = clone(lesson.start.objects);
  store.doc.background = clone(lesson.start.background);
  store.doc.pages = clone(lesson.start.pages);
  const events = lesson.events.map((ev) => ({ ...ev, op: clone(ev.op) }));

  // a painter that is the real board's own painting code, aimed at a bigger canvas
  const cam = new Camera();
  let imagesArrived = false;
  const painter = {
    cam, dpr: s, store, editing: null, _paper: null,
    screenTransform: Surface.prototype.screenTransform,
    _paintPaper: Surface.prototype._paintPaper,
    laser: [], laserColor: lesson.laserColor || null
  };
  const base = document.createElement('canvas');
  base.width = W; base.height = H;
  const bctx = base.getContext('2d', { alpha: false });
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d', { alpha: false });

  const voice = lesson.voice;
  const total = Math.max(lesson.duration, voice ? (voice.chunks.reduce((n, c) => n + c.duration, 0) / voice.sampleRate) * 1000 : 0);
  const frames = Math.max(1, Math.ceil((total / 1000) * FPS)) + Math.round(FPS * 0.5);   // and a moment on the finished board

  const chunks = [];
  let avcC = null, failed = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && !avcC) avcC = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // the time the picture was made for travels with it, so a picture an encoder leaves out cannot shift the rest
      chunks.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
    },
    error: (e) => { failed = e; }
  });
  encoder.configure({ ...f.video.config, bitrate: f.bits, bitrateMode: 'variable', latencyMode: 'quality' });
  let sent = 0;

  let ei = 0, li = 0, lastKey = '', lastView = '', slice = performance.now();
  // what was added on top since the base was last painted: drawn onto it as it is, rather than the whole board again
  let fresh = [], whole = true;
  // A lesson is mostly talking over a board that is standing still. A frame that is the same picture as the one
  // before is handed to the encoder again as it is, without being drawn or copied off the canvas a second time.
  let held = null, heldKey = '';
  const page = (store.doc.background && store.doc.background.color) || null;
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) return null;
      if (failed) throw failed;
      // somebody is using the app: wait until they stop, before any drawing
      while (yieldTo && yieldTo()) { if (signal?.aborted) return null; await sleep(60); slice = performance.now(); }
      const T = (i * 1000) / FPS;
      // the board's changes up to this moment
      while (ei < events.length && events[ei].t <= T) {
        const op = events[ei].op;
        const onTop = op.t === 'add' && op.obj && (op.index == null || op.index >= store.doc.order.length) && !store.doc.objects[op.obj.id];
        store._apply(op);
        if (onTop) fresh.push(op.obj); else whole = true;
        ei++;
      }
      // the view at this moment, in the shape of the first frame
      const v = viewAt(lesson.cams, T);
      const z = v.z || 1;
      const cx = ((v.w || cssW) / 2 - v.x) / z, cy = ((v.h || cssH) / 2 - v.y) / z;
      cam.z = z; cam.x = cssW / 2 - cx * z; cam.y = cssH / 2 - cy * z;
      const key = `${store.rev}|${cam.x}|${cam.y}|${cam.z}`;
      const moving = (() => {
        for (let j = ei; j < events.length; j++) {
          const ev = events[j];
          if (ev.draw && ev.draw.samples[0].t <= T) return true;
          if (ev.t > T + 60000) break;
        }
        const L = lesson.laser;
        let k = li;
        while (k < L.length && L[k].t < T - Surface.LASER_LIFE) k++;
        return k < L.length && L[k].t <= T;
      })();
      if (!moving && !imagesArrived && held && heldKey === key) {
        const again = new VideoFrame(held, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        encoder.encode(again, { keyFrame: i % (FPS * 10) === 0 || i === frames - 1 });
        again.close(); sent++;
        while (encoder.encodeQueueSize > 4) await sleep(2);
        if (performance.now() - slice > 8) {
          onProgress?.(i / frames);
          await sleep(0);
          while (yieldTo && yieldTo()) { if (signal?.aborted) return null; await sleep(60); }
          slice = performance.now();
        }
        continue;
      }
      const view = `${cam.x}|${cam.y}|${cam.z}`;
      if (key !== lastKey || imagesArrived) {
        setPageColor((store.doc.background && store.doc.background.color) || page);
        if (!whole && !imagesArrived && view === lastView && fresh.length) {
          // only new things on top, and the view has not moved: they go on the picture already there
          const rects = pageRects(store.doc.pages || []);
          bctx.setTransform(s * z, 0, 0, s * z, s * cam.x, s * cam.y);
          for (const o of fresh) {
            const pi = rects.length ? pageIndexForBoxIn(rects, boundsOf(o)) : -1;
            bctx.save();
            if (pi >= 0) { const r = rects[pi]; bctx.beginPath(); bctx.rect(r.x, r.y, r.w, r.h); bctx.clip(); }
            try { drawObject(bctx, o, () => { imagesArrived = true; }); } catch { /* one thing never stops the video */ }
            bctx.restore();
          }
        } else {
          bctx.setTransform(1, 0, 0, 1, 0, 0);
          Surface.prototype._drawScene.call(painter, bctx, cssW, cssH, () => { imagesArrived = true; });
        }
        imagesArrived = false;
        fresh = []; whole = false;
        lastKey = key; lastView = view;
      } else if (fresh.length) { fresh = []; }
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.drawImage(base, 0, 0);
      // lines still being written at this moment
      octx.setTransform(s * z, 0, 0, s * z, s * cam.x, s * cam.y);
      for (let j = ei; j < events.length; j++) {
        const ev = events[j];
        if (!ev.draw) { if (ev.t > T + 2000) break; continue; }
        if (ev.draw.samples[0].t > T) { if (ev.t > T + 60000) break; continue; }
        const o = ev.op.obj, n = pointsBy(ev.draw, T, o.points.length);
        if (n < 1) continue;
        try { drawObject(octx, n >= o.points.length ? o : { ...o, points: o.points.slice(0, Math.max(2, n)) }); } catch { /* one line never stops the video */ }
      }
      // the laser, as it looked at this moment
      const L = lesson.laser;
      if (L.length) {
        const from = T - Surface.LASER_LIFE;
        while (li < L.length && L[li].t < from) li++;
        const trail = [];
        for (let k = li; k < L.length && L[k].t <= T; k++) trail.push(L[k]);
        if (trail.length) {
          painter.laser = trail;
          octx.setTransform(1, 0, 0, 1, 0, 0);
          try { Surface.prototype.drawLaser.call(painter, octx, T); } catch { /* a pointer is a nicety */ }
        }
      }
      const vf = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      // the last picture is a key picture: no encoder may leave out how the lesson ended
      encoder.encode(vf, { keyFrame: i % (FPS * 10) === 0 || i === frames - 1 }); sent++;
      if (held) held.close();
      held = moving ? null : vf; heldKey = moving ? '' : key;
      if (moving) vf.close();
      // never let the encoder fall behind, never hold the window: a few milliseconds of work, then a turn for the board
      while (encoder.encodeQueueSize > 4) await sleep(2);
      if (performance.now() - slice > 8) {
        onProgress?.(i / frames);
        await sleep(0);
        while (yieldTo && yieldTo()) { if (signal?.aborted) return null; await sleep(60); }
        slice = performance.now();
      }
    }
    await encoder.flush();
    if (failed) throw failed;
  } finally {
    if (held) { try { held.close(); } catch { /* closed */ } }
    try { encoder.close(); } catch { /* closed */ }
    base.width = base.height = 1;
  }
  if (!chunks.length) throw new Error(t('the video encoder gave nothing back'));
  onProgress?.(1);
  // for the suite and for bug reports: did the encoder keep every picture, in order?
  let reordered = 0;
  for (let k = 1; k < chunks.length; k++) if (chunks[k].ts < chunks[k - 1].ts) reordered++;
  const report = { sent, kept: chunks.length, reordered, codec: f.video.config.codec, lastTs: chunks.length ? Math.round(chunks[chunks.length - 1].ts / 1000) : 0 };
  if (f.video.ext === 'mp4') {
    if (!avcC) throw new Error('no H.264 description');
    const audio = voice ? { codec: voice.codec, chunks: voice.chunks, description: voice.description, sampleRate: voice.sampleRate, channels: 1, bitrate: voice.bitrate } : null;
    return { bytes: muxMp4AV({ frames: chunks, avcC, width: W, height: H, fps: FPS }, audio), ext: 'mp4', width: W, height: H, frames: chunks.length, report };
  }
  const audio = voice ? { chunks: voice.chunks, description: voice.description, sampleRate: voice.sampleRate, channels: 1 } : null;
  return { bytes: muxWebmAV({ frames: chunks, codec: f.video.config.codec, width: W, height: H, fps: FPS }, audio), ext: 'webm', width: W, height: H, frames: chunks.length, report };
}
