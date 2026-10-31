// The class timer: a big clock on the board.
//
// "Five minutes for this question" is said in every lesson, and the only clock
// in most classrooms is on the teacher's wrist. This puts one on the board,
// large enough to read from the back row, and chimes when time is up.
//
// It is not part of the board. It is not saved, not exported and not sent to
// anyone, and it keeps running when you switch boards - it belongs to the
// lesson, not to the page you happen to be on. Where it sits and how big it
// is ARE remembered, because a teacher who moved it out of the way once does
// not want to move it again every lesson.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

export const TIMER_PRESETS = [1, 3, 5, 10];   // minutes
/** The clock goes red for the last stretch, so the room sees time running out. */
export const LOW_MS = 30000;
export const MIN_SCALE = 0.6;
export const MAX_SCALE = 3;
const MAX_MS = 24 * 3600000;

/** 4:59, 10:00, 0:07, 1:05:00 - the leading unit is never padded. */
export function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hr = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  return hr ? `${hr}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Whatever a person is likely to type for "how long", in ms - or null.
 *
 *   7        seven minutes (a bare number is minutes: that is how people say it)
 *   2.5      two and a half minutes
 *   7:30     seven minutes thirty
 *   1:05:00  an hour and five minutes
 *   90s  45 sec  2m  1h  1h 30m  1m30s
 *
 * Anything under a second or over a day is refused rather than guessed at.
 */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/,/g, '.');
  if (!t) return null;
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(t)) ms = parseFloat(t) * 60000;
  else if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    const parts = t.split(':').map(Number);
    if (parts.slice(1).some((p) => p > 59)) return null;
    const [a, b, c] = parts;
    ms = parts.length === 2 ? (a * 60 + b) * 1000 : (a * 3600 + b * 60 + c) * 1000;
  } else {
    const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\s*/gy;
    let total = 0, m, at = 0;
    while ((m = re.exec(t))) {
      const n = parseFloat(m[1]);
      const u = m[2][0];
      total += n * (u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000);
      at = re.lastIndex;
    }
    if (at !== t.length || !total) return null;
    ms = total;
  }
  if (!(ms >= 1000) || ms > MAX_MS) return null;
  return Math.round(ms);
}

export class ClassTimer {
  /**
   * @param {HTMLElement} host  what the clock floats over (the stage)
   * @param {object} opts
   * @param {() => number} [opts.now]  the clock. The suite swaps in its own so
   *   five minutes can pass in a line of code rather than five minutes.
   * @param {() => void} [opts.chime]  what to do at zero
   * @param {{x:number,y:number,scale:number}|null} [opts.box]  where it was left
   * @param {(box) => void} [opts.onPlace]  told when it is moved or resized
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.now = opts.now || (() => performance.now());
    this.chime = opts.chime || playTimerChime;
    this.onPlace = opts.onPlace || null;
    this.state = 'closed';        // closed | idle | running | paused | done
    this.picking = false;         // the list of times is showing
    this.endAt = 0;
    this.left = 0;                // ms remaining, while paused
    this.total = 0;
    this.box = { x: 16, y: 14, scale: 1, ...(opts.box || {}) };
    this._tick = null;
    this.el = null;
  }

  /** Time left, in ms. Worked out from the clock every time, never counted
   *  down by the ticker - a ticker throttled in a background tab would
   *  otherwise lose seconds, and a lesson timer that runs slow is worse than
   *  none. */
  remaining() {
    if (this.state === 'running') return Math.max(0, this.endAt - this.now());
    if (this.state === 'paused') return this.left;
    return 0;
  }

  get visible() { return this.state !== 'closed'; }
  /** A countdown exists, whether or not the list of times is over it. */
  get active() { return this.state === 'running' || this.state === 'paused'; }
  /** The last thirty seconds: the clock turns red. */
  get low() { return this.active && this.remaining() <= LOW_MS; }

  open() {
    if (this.state === 'closed') { this.state = 'idle'; this.picking = true; }
    this.render();
  }

  close() {
    this.state = 'closed';
    this.picking = false;
    this.stopTicking();
    this._endDrag?.();
    if (this.el) { this.el.remove(); this.el = null; }
  }

  toggle() { if (this.visible) this.close(); else this.open(); }

  /** Start a countdown. Takes minutes, or `{ ms }` for an exact length. */
  start(minutes) {
    const ms = typeof minutes === 'object' ? minutes.ms : minutes * 60000;
    if (!(ms > 0)) return false;
    this.total = ms;
    this.endAt = this.now() + ms;
    this.state = 'running';
    this.picking = false;
    this.startTicking();
    this.render();
    return true;
  }

  /** Start from whatever was typed. False, and nothing changes, if it made no sense. */
  startTyped(text) {
    const ms = parseDuration(text);
    if (ms == null) return false;
    return this.start({ ms });
  }

  pause() {
    if (this.state !== 'running') return;
    this.left = this.remaining();
    this.state = 'paused';
    this.stopTicking();
    this.render();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.endAt = this.now() + this.left;
    this.state = 'running';
    this.startTicking();
    this.render();
  }

  /** One more minute. After time is up it starts a fresh minute running. */
  addMinute() {
    if (this.state === 'running') this.endAt += 60000;
    else if (this.state === 'paused') this.left += 60000;
    else if (this.state === 'done') { this.start(1); return; }
    else return;
    this.render();
  }

  /**
   * Show the list of times WITHOUT stopping the one that is running.
   *
   * Looking at the other choices is not a decision. The countdown carries on
   * underneath - it is still shown, smaller, at the top of the list - and only
   * picking a new time replaces it. "Keep this one" goes back to it as it was.
   */
  chooseAnother() {
    this.picking = true;
    if (this.state === 'done') this.state = 'idle';
    this.render();
  }

  keepCurrent() {
    if (!this.active) return;
    this.picking = false;
    this.render();
  }

  startTicking() {
    this.stopTicking();
    // A quarter of a second: the digits change once a second, and sampling
    // four times as often means the change is never more than a blink late.
    this._tick = setInterval(() => this.tick(), 250);
  }

  stopTicking() { if (this._tick) { clearInterval(this._tick); this._tick = null; } }

  /** Called by the ticker; also by the suite, after moving its clock on. */
  tick() {
    if (this.state !== 'running') return;
    if (this.remaining() <= 0) {
      this.state = 'done';
      this.picking = false;
      this.stopTicking();
      try { this.chime(); } catch { /* no sound is no reason to stop */ }
      this.render();
      return;
    }
    this.renderDigits();
  }

  renderDigits() {
    if (!this.el) return;
    for (const d of this.el.querySelectorAll('.ct-digits, .ct-now-digits')) d.textContent = formatClock(this.remaining());
    this.el.classList.toggle('ct-low', this.low);
  }

  /** Put the box where it belongs, kept on screen however the window changed. */
  place() {
    const el = this.el;
    if (!el) return;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.box.scale || 1));
    this.box.scale = s;
    el.style.transform = `scale(${s})`;
    el.style.setProperty('--ct-s', String(s));
    const hw = this.host.clientWidth || window.innerWidth || 0;
    const hh = this.host.clientHeight || window.innerHeight || 0;
    const w = el.offsetWidth * s;
    // at least a good corner of it stays reachable, so it can always be dragged back
    const keep = 48;
    this.box.x = Math.min(Math.max(this.box.x, keep - w), Math.max(0, hw - keep));
    this.box.y = Math.min(Math.max(this.box.y, 0), Math.max(0, hh - keep));
    if (!hw) this.box.x = Math.max(0, this.box.x);
    el.style.left = this.box.x + 'px';
    el.style.top = this.box.y + 'px';
  }

  render() {
    if (this.state === 'closed') return;
    if (!this.el) {
      this.el = h('div', { id: 'classTimer', role: 'timer', 'aria-live': 'off' });
      this.wireMoving(this.el);
      this.host.appendChild(this.el);
    }
    const el = this.el;
    el.innerHTML = '';
    el.className = 'ct-' + this.state + (this.picking ? ' ct-picking' : '');
    const btn = (title, ic, fn, cls = '') => {
      const b = h('button', { class: 'ct-btn ' + cls, title, 'aria-label': title, html: icon(ic, 18) });
      b.addEventListener('click', fn);
      return b;
    };
    const close = btn(t('Close the timer'), 'close', () => this.close(), 'ct-close');
    const grip = h('span', { class: 'ct-resize', title: t('Drag to make the clock bigger or smaller') });

    if (this.picking || this.state === 'idle') {
      const body = h('div', { class: 'ct-pick' });
      if (this.active) {
        // the countdown that is still going, and the way back to it
        const now = h('div', { class: 'ct-now' },
          h('span', { class: 'ct-now-label' }, this.state === 'paused' ? t('Paused at') : t('Still running')),
          h('span', { class: 'ct-now-digits' }, formatClock(this.remaining())));
        const keep = h('button', { class: 'ct-keep', title: t('Go back to the running timer') }, t('Keep this one'));
        keep.addEventListener('click', () => this.keepCurrent());
        now.appendChild(keep);
        body.appendChild(now);
      }
      const row = h('div', { class: 'ct-presets' });
      for (const m of TIMER_PRESETS) {
        const b = h('button', { class: 'ct-preset', title: m > 1 ? t('{m} minutes', { m }) : t('{m} minute', { m }) }, t('{m} min', { m }));
        b.dataset.minutes = String(m);
        b.addEventListener('click', () => this.start(m));
        row.appendChild(b);
      }
      body.appendChild(row);
      // any length at all, typed
      const input = h('input', { class: 'ct-input', type: 'text', inputmode: 'text', spellcheck: 'false',
        placeholder: t('or type: 7, 7:30, 90s, 1h'), 'aria-label': t('Any length of time') });
      const go = h('button', { class: 'ct-go', title: t('Start') }, t('Start'));
      const tryStart = () => {
        if (!this.startTyped(input.value)) {
          input.classList.add('ct-bad');
          input.title = t('Try 7 (minutes), 7:30, 90s or 1h 15m');
          input.focus();
        }
      };
      input.addEventListener('input', () => input.classList.remove('ct-bad'));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); tryStart(); }
        if (e.key === 'Escape' && this.active) { e.preventDefault(); this.keepCurrent(); }
      });
      go.addEventListener('click', tryStart);
      body.appendChild(h('div', { class: 'ct-custom' }, input, go));
      el.appendChild(h('span', { class: 'ct-title', html: icon('timer', 18) }));
      el.appendChild(body);
      el.appendChild(close);
      el.appendChild(grip);
      this.renderDigits();
      this.place();
      return;
    }

    const digits = h('button', { class: 'ct-digits', title: this.state === 'running' ? t('Pause') : t('Carry on') },
      formatClock(this.remaining()));
    digits.addEventListener('click', () => {
      if (this.state === 'running') this.pause();
      else if (this.state === 'paused') this.resume();
    });
    el.appendChild(digits);
    const controls = h('div', { class: 'ct-controls' });
    if (this.state === 'running') controls.appendChild(btn(t('Pause'), 'pause', () => this.pause(), 'ct-pause'));
    if (this.state === 'paused') controls.appendChild(btn(t('Carry on'), 'play', () => this.resume(), 'ct-resume'));
    controls.appendChild(btn(t('One more minute'), 'plus', () => this.addMinute(), 'ct-more'));
    controls.appendChild(btn(t('Choose another time — this one keeps running until you pick'), 'timer',
      () => this.chooseAnother(), 'ct-reset'));
    controls.appendChild(close);
    el.appendChild(controls);
    el.appendChild(grip);
    this.renderDigits();
    this.place();
  }

  /**
   * Drag the clock anywhere; drag its corner to size it.
   *
   * The whole card is the handle, digits included - they are the biggest
   * thing on it and the obvious place to grab. A press that travels is a
   * move and its click is swallowed, so dragging by the digits never pauses
   * the timer by accident; a press that stays put is an ordinary click.
   */
  wireMoving(el) {
    /*
     * Why the corner used to be flaky, and what holds it together now:
     *  - the moves and the release were only heard on the card itself, so a
     *    quick tug that left the card before the first move was heard lost
     *    the drag: the clock stopped growing, the release happened outside
     *    and was never heard, and the drag stayed "on" - so later, just
     *    passing the mouse over the corner went on resizing it. The moves and
     *    the release are now heard on the whole window for as long as the
     *    drag lasts, and a move with no button held ends a drag that lost
     *    its release.
     *  - the corner is grabbed with the pointer held from the very press (it
     *    has no click to protect), and its target stays a fair size on
     *    screen however small the clock is.
     *  - the size follows the pointer both ways: down grows it as well as
     *    right, so the corner stays under the pointer.
     */
    let drag = null;
    const finish = (e, cancelled) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      const id = drag.id;
      drag = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', lost);
      try { if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id); } catch { /* never captured */ }
      el.classList.remove('ct-sizing');
      if (moved) {
        if (!cancelled && e && e.type === 'pointerup') {
          // the click that follows a drag is the end of the drag, not a press
          const eat = (c) => { c.stopPropagation(); c.preventDefault(); };
          el.addEventListener('click', eat, { capture: true, once: true });
          setTimeout(() => el.removeEventListener('click', eat, { capture: true }), 0);
        }
        this.onPlace?.({ ...this.box });
      }
    };
    const move = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // the button was let go somewhere the release was not heard: that drag is over
      if (e.pointerType === 'mouse' && e.buttons === 0) { finish(e, true); return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < (drag.resize ? 1 : 4)) return;
      if (!drag.moved && !drag.resize) {
        // now it is a drag: keep hold of the pointer even if it outruns the card
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      }
      drag.moved = true;
      if (drag.resize) {
        // the corner follows the pointer: whichever way it went further sets the size
        const ws = drag.w * drag.box.scale, hs = drag.h * drag.box.scale;
        const k = Math.max((ws + dx) / ws, (hs + dy) / hs);
        this.box.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, drag.box.scale * Math.max(0.1, k)));
      } else {
        this.box.x = drag.box.x + dx;
        this.box.y = drag.box.y + dy;
      }
      this.place();
    };
    const up = (e) => finish(e, false);
    const cancel = (e) => finish(e, true);
    const lost = () => finish(null, true);
    el.addEventListener('pointerdown', (e) => {
      // the board underneath must not see presses meant for the clock
      e.stopPropagation();
      // a press in a box you type in is for the text - selecting it, placing the caret - never for moving the card
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) return;
      if (drag) finish(null, true);             // a stale drag never outlives a new press
      const resize = e.target instanceof Element && !!e.target.closest('.ct-resize');
      drag = {
        id: e.pointerId, x: e.clientX, y: e.clientY, resize, moved: false,
        box: { ...this.box }, w: el.offsetWidth || 1, h: el.offsetHeight || 1
      };
      /*
       * A move is NOT captured here. Capturing the pointer on the card at the
       * press makes the card the target of the click that follows - so the
       * click never reached Start, Pause, a preset or Close, and the clock
       * could be started by the keyboard but never stopped. A move is only
       * captured once the press has turned into a drag, and a drag's click
       * is swallowed anyway. The corner has no click, so it holds on at once.
       */
      if (resize) {
        e.preventDefault();
        el.classList.add('ct-sizing');
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      }
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('blur', lost);
    });
    this._endDrag = () => finish(null, true);
  }
}

/**
 * Time's up: the same soft three-note rise the app uses when a board arrives,
 * played twice so it is heard over a room that has started talking.
 *
 * Deliberately not tied to the "chime when a board arrives" setting - that
 * switch is about boards, and someone who silenced it still set this timer
 * because they wanted to be told.
 */
let audio = null;
export function playTimerChime() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = audio || (audio = new Ctx());
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  for (const rep of [0, 0.6]) {
    [[659, 0], [880, 0.1], [1175, 0.2]].forEach(([hz, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      const t = now + rep + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.36);
    });
  }
}
