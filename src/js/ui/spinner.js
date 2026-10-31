// The spinner wheel: "who answers next?" decided by a wheel the whole room can watch.
//
// Like the class timer, it belongs to the lesson, not to the board: it floats
// over the board, is never saved into it, exported or sent, and stays put when
// you switch boards. The names on it, and where it sits and how big it is, are
// remembered, so a class list typed once is there next lesson.
//
// The spin is decided the moment it starts (a fair random pick), and the
// wheel is then simply animated to land on it - slowing down gently, clicking
// past each name, and stopping with the winner under the pointer.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { ClassTimer, MIN_SCALE, MAX_SCALE } from './timer.js';

export const WHEEL_COLORS = ['#0f6cbd', '#d13438', '#107c10', '#ca5010', '#8764b8', '#038387', '#c239b3', '#986f0b', '#4f6bed', '#e3008c'];
export const MAX_NAMES = 60;
const SPIN_MS = 4600;

/** The names typed, one a line (commas work too), tidied: no blanks, nothing silly long, not too many. */
export function parseNames(text) {
  return String(text || '').split(/[\n,;]+/).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, MAX_NAMES);
}

const defaultNames = () => Array.from({ length: 12 }, (_, i) => String(i + 1));

export class SpinnerWheel {
  /**
   * @param {HTMLElement} host  what it floats over (the stage)
   * @param {object} opts
   * @param {string[]} [opts.names]  the names it had last time
   * @param {{x,y,scale}} [opts.box]  where it was left
   * @param {(state) => void} [opts.onSave]  told when the names, the place or the size change
   * @param {() => number} [opts.random]  the suite swaps in its own, so a spin can be checked
   * @param {(ms) => void} [opts.sound]  tick/finish sounds; null for silence
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.names = Array.isArray(opts.names) && opts.names.length ? opts.names.slice(0, MAX_NAMES) : defaultNames();
    this.box = { x: 0, y: 70, scale: 1, ...(opts.box || {}), placed: !!opts.box };
    this.removeWinner = !!opts.removeWinner;
    this.onSave = opts.onSave || null;
    this.random = opts.random || Math.random;
    this.sound = opts.sound === undefined ? tickSound : opts.sound;
    this.angle = 0;               // radians the wheel has turned
    this.spinning = null;
    this.winner = null;
    this.editing = false;
    this.el = null;
  }

  get visible() { return !!this.el; }
  toggle() { if (this.el) this.close(); else this.open(); }

  open() {
    if (this.el) return;
    this.el = h('div', { id: 'spinnerWheel', role: 'dialog', 'aria-label': t('Spinner wheel') });
    this.host.appendChild(this.el);
    ClassTimer.prototype.wireMoving.call(this, this.el);
    this.render();
    if (!this.box.placed) {
      // first time: top right of the board, clear of the class timer's corner
      const hw = this.host.clientWidth || window.innerWidth;
      this.box.x = Math.max(8, hw - (this.el.offsetWidth || 300) - 16);
      this.box.placed = true;
    }
    this.place();
  }

  close() {
    this.stop();
    this._endDrag?.();
    if (this.el) { this.el.remove(); this.el = null; }
  }

  /** Where it sits and how big, kept on screen. The class timer's rules, so the two behave alike. */
  place() {
    const el = this.el;
    if (!el) return;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.box.scale || 1));
    this.box.scale = s;
    el.style.transform = `scale(${s})`;
    el.style.setProperty('--ct-s', String(s));
    const hw = this.host.clientWidth || window.innerWidth || 0, hh = this.host.clientHeight || window.innerHeight || 0;
    const w = el.offsetWidth * s, keep = 48;
    this.box.x = Math.min(Math.max(this.box.x, keep - w), Math.max(0, hw - keep));
    this.box.y = Math.min(Math.max(this.box.y, 0), Math.max(0, hh - keep));
    el.style.left = this.box.x + 'px';
    el.style.top = this.box.y + 'px';
  }

  onPlace(box) { this.save(); }

  save() { this.onSave?.({ names: this.names.slice(), box: { x: this.box.x, y: this.box.y, scale: this.box.scale }, removeWinner: this.removeWinner }); }

  /** Which name is under the pointer (at the top) for a given turn of the wheel. */
  nameAt(angle) {
    const n = this.names.length;
    if (!n) return -1;
    const seg = (Math.PI * 2) / n;
    // segment i spans [i*seg, (i+1)*seg) clockwise from the top, before turning
    const a = ((-angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.floor(a / seg) % n;
  }

  /** Spin. The winner is chosen now, fairly; the wheel is then turned to land on it. */
  spin() {
    if (this.spinning || this.names.length < 2) return null;
    const n = this.names.length, seg = (Math.PI * 2) / n;
    const pick = Math.min(n - 1, Math.floor(this.random() * n));
    // land somewhere inside the picked slice, not on its edge
    const within = (0.2 + this.random() * 0.6) * seg;
    const target = -(pick * seg + within);
    const turns = 5 + Math.floor(this.random() * 3);
    const from = this.angle;
    let to = target - turns * Math.PI * 2;
    while (to > from - turns * Math.PI * 2) to -= Math.PI * 2;
    this.winner = null;
    this.spinning = { from, to, t0: performance.now(), pick, last: this.nameAt(from) };
    this.render();
    const step = (now) => {
      const s = this.spinning;
      if (!s) return;
      const p = Math.min(1, (now - s.t0) / SPIN_MS);
      const e = 1 - Math.pow(1 - p, 4);            // fast, then a long gentle slowing down
      this.angle = s.from + (s.to - s.from) * e;
      const at = this.nameAt(this.angle);
      if (at !== s.last) { s.last = at; try { this.sound?.('tick'); } catch { /* silence is fine */ } }
      this.drawWheel();
      if (p < 1) { s.raf = requestAnimationFrame(step); return; }
      this.finish();
    };
    this.spinning.raf = requestAnimationFrame(step);
    return pick;
  }

  /** Jump straight to the end of a spin (and the suite's way of not waiting four seconds). */
  finish() {
    const s = this.spinning;
    if (!s) return;
    cancelAnimationFrame(s.raf);
    this.angle = s.to;
    this.spinning = null;
    this.winner = this.names[s.pick];
    try { this.sound?.('done'); } catch { /* silence is fine */ }
    this.render();
  }

  stop() { if (this.spinning) { cancelAnimationFrame(this.spinning.raf); this.spinning = null; } }

  /** Take the winner off the wheel (with "remove after each spin" on, before the next spin). */
  dropWinner() {
    if (this.winner == null) return;
    const i = this.names.indexOf(this.winner);
    if (i >= 0) this.names.splice(i, 1);
    this.winner = null;
    this.angle = 0;
    this.save();
    this.render();
  }

  setNames(list) {
    this.names = list.length ? list : defaultNames();
    this.winner = null;
    this.angle = 0;
    this.save();
  }

  render() {
    const el = this.el;
    if (!el) return;
    el.innerHTML = '';
    el.className = this.spinning ? 'sw-spinning' : '';
    const btn = (title, ic, fn, cls = '') => {
      const b = h('button', { class: 'ct-btn ' + cls, title, 'aria-label': title, html: icon(ic, 18) });
      b.addEventListener('click', fn);
      return b;
    };
    const head = h('div', { class: 'sw-head' },
      h('b', {}, t('Spinner wheel')),
      btn(t('Edit the names'), 'text', () => { this.editing = !this.editing; this.render(); }, 'sw-edit'),
      btn(t('Close the spinner wheel'), 'close', () => this.close(), 'sw-close'));
    el.appendChild(head);
    if (this.editing) {
      const area = h('textarea', { class: 'sw-names', rows: '8', spellcheck: 'false', 'aria-label': t('Names, one a line') });
      area.value = this.names.join('\n');
      area.addEventListener('keydown', (e) => e.stopPropagation());
      const keep = h('label', { class: 'sw-keep' }, h('input', { type: 'checkbox' }), h('span', {}, t('Take the winner off the wheel after each spin')));
      keep.firstChild.checked = this.removeWinner;
      keep.firstChild.addEventListener('change', () => { this.removeWinner = keep.firstChild.checked; this.save(); });
      const done = h('button', { class: 'ct-go sw-done' }, t('Done'));
      done.addEventListener('click', () => { this.setNames(parseNames(area.value)); this.editing = false; this.render(); });
      el.appendChild(h('div', { class: 'sw-editor' }, h('small', {}, t('One name a line — or numbers, groups, topics. Up to 60.')), area, keep, done));
    } else {
      const canvas = h('canvas', { class: 'sw-wheel', width: '560', height: '560', 'aria-hidden': 'true' });
      const wrap = h('div', { class: 'sw-wrap' }, canvas, h('div', { class: 'sw-pointer' }));
      canvas.addEventListener('click', () => this.spin());
      el.appendChild(wrap);
      const result = h('div', { class: 'sw-result', 'aria-live': 'polite' }, this.winner != null ? this.winner : this.spinning ? '…' : '');
      el.appendChild(result);
      const spin = h('button', { class: 'ct-go sw-spin', disabled: this.spinning || this.names.length < 2 ? '' : null }, t('Spin'));
      spin.addEventListener('click', () => {
        if (this.winner != null && this.removeWinner) { const keepAngle = this.angle; this.dropWinner(); this.angle = keepAngle; }
        this.spin();
      });
      el.appendChild(h('div', { class: 'sw-actions' }, spin,
        this.winner != null && !this.removeWinner ? (() => { const b = h('button', { class: 'sw-remove' }, t('Take off the wheel')); b.addEventListener('click', () => this.dropWinner()); return b; })() : null));
      this.canvas = canvas;
      this.drawWheel();
    }
    el.appendChild(h('span', { class: 'ct-resize', title: t('Drag to make it bigger or smaller') }));
    this.place();
  }

  drawWheel() {
    const c = this.canvas;
    if (!c || !c.isConnected) return;
    const ctx = c.getContext('2d');
    const W = c.width, r = W / 2 - 6, cx = W / 2, cy = W / 2;
    const n = this.names.length, seg = (Math.PI * 2) / Math.max(1, n);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);
    const winning = this.winner != null ? this.names.indexOf(this.winner) : -1;
    for (let i = 0; i < n; i++) {
      // slice i starts at the top (-90°) and runs clockwise
      const a0 = -Math.PI / 2 + i * seg, a1 = a0 + seg;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, a0, a1); ctx.closePath();
      let col = WHEEL_COLORS[i % WHEEL_COLORS.length];
      if (n % WHEEL_COLORS.length === 1 && i === n - 1) col = WHEEL_COLORS[(i + 3) % WHEEL_COLORS.length];   // never two the same side by side
      ctx.fillStyle = col;
      ctx.globalAlpha = winning >= 0 && i !== winning ? 0.35 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
      // the name along the middle of its slice
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      const size = Math.max(12, Math.min(34, seg * r * 0.42, 420 / Math.max(4, (this.names[i] || '').length + 2)));
      ctx.font = `600 ${size}px 'GazBoard Open Sans', 'Segoe UI', sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      let label = this.names[i];
      while (label.length > 1 && ctx.measureText(label).width > r * 0.78) label = label.slice(0, -2) + '…';
      ctx.fillText(label, r - 16, 1);
      ctx.restore();
    }
    ctx.restore();
    // the hub
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.stroke();
  }
}

/** A soft click for each name that passes the pointer, and a little chime at the end. */
let audio = null, lastDone = -1, lastTick = -1;
/** @returns {boolean|null} true if it played, false if it was too soon after the last one, null if this machine has no sound */
export function tickSound(kind) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = audio || (audio = new Ctx());
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  // never stacked: sounds asked for on top of each other add up to a blast, so the extra ones are dropped
  const wall = performance.now();
  if (kind === 'done') { if (lastDone >= 0 && wall - lastDone < 500) return false; lastDone = wall; }
  else { if (lastTick >= 0 && wall - lastTick < 30) return false; lastTick = wall; }
  const now = ctx.currentTime;
  const notes = kind === 'done' ? [[784, 0], [1047, 0.11], [1319, 0.22]] : [[2200, 0]];
  for (const [hz, at] of notes) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = kind === 'done' ? 'triangle' : 'square';
    osc.frequency.value = hz;
    const tt = now + at, len = kind === 'done' ? 0.4 : 0.025;
    gain.gain.setValueAtTime(0.0001, tt);
    gain.gain.exponentialRampToValueAtTime(kind === 'done' ? 0.28 : 0.05, tt + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, tt + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(tt); osc.stop(tt + len + 0.02);
  }
  return true;
}
