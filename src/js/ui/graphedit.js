// The graph editor: the formulas, their colours, the sliders for any letters
// in them, and how much of the plane the graph shows.
//
// Every change shows on the board straight away, on the graph itself, so a
// teacher can drag a slider in front of the class and watch the curve move.
// None of that is a change to the board yet: Done keeps it all as one step
// that one Undo takes back, and Cancel (or Escape) puts the graph back
// exactly as it was. A graph that was just made and is cancelled goes away.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { toHtml, loadKatex } from '../core/maths.js';
import { readFormula, slidersOf, GRAPH_COLORS, fmtNum } from '../core/plot.js';
import { graphData, nearestOnCurve } from '../core/graph.js';

const FIELDS = ['exprs', 'xMin', 'xMax', 'yMin', 'yMax', 'tMin', 'tMax', 'params', 'grid', 'points', 'labels', 'pins'];

const clone = (o) => JSON.parse(JSON.stringify(o));
export function graphFields(o) { const out = {}; for (const k of FIELDS) if (o[k] !== undefined) out[k] = clone(o[k]); return out; }

export class GraphEditor {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.id = null;
    this._outside = (e) => {
      if (!this.el || this.el.contains(e.target)) return;
      // a tap on one of the graph's curves pins a point there, and the editor stays open
      if (e.target === this.app.surface.canvas) {
        const pin = this.pinAt(e.clientX, e.clientY);
        if (pin) { e.preventDefault(); e.stopPropagation(); this.togglePin(pin); return; }
      }
      this.finish();
    };
  }

  get active() { return !!this.el; }

  /** Open on a graph. `fresh`: it was only just made, so Cancel removes it again. */
  open(obj, { fresh = false } = {}) {
    this.close();
    const app = this.app;
    this.id = obj.id;
    this.fresh = fresh;
    this.before = graphFields(obj);
    this.draft = graphFields(obj);
    if (!Array.isArray(this.draft.exprs) || !this.draft.exprs.length) this.draft.exprs = [{ src: '', color: GRAPH_COLORS[0] }];
    this.draft.params = this.draft.params || {};
    this.timers = new Map();
    // the sliders are drawn afresh for this opening: the last opening's list must not stand in for them
    this._sliderKey = null;

    this.rows = h('div', { class: 'gx-rows' });
    this.sliders = h('div', { class: 'gx-sliders' });
    const add = h('button', { type: 'button', class: 'btn gx-add', 'data-graph-add': '1' }, t('+ Add formula'));
    add.addEventListener('click', () => {
      const used = new Set(this.draft.exprs.map((e) => e.color));
      this.draft.exprs.push({ src: '', color: GRAPH_COLORS.find((c) => !used.has(c)) || GRAPH_COLORS[this.draft.exprs.length % GRAPH_COLORS.length] });
      this.drawRows(this.draft.exprs.length - 1);
    });

    const num = (key, label) => {
      const i = h('input', { type: 'number', step: 'any', class: 'gx-num', 'data-range': key, 'aria-label': label, value: String(this.draft[key] ?? '') });
      i.addEventListener('input', () => { const v = parseFloat(i.value); if (Number.isFinite(v)) { this.draft[key] = v; this.apply(); } });
      return i;
    };
    this.rangeInputs = {};
    const pair = (a, b, name) => {
      const ia = num(a, `${name} ${t('from')}`), ib = num(b, `${name} ${t('to')}`);
      this.rangeInputs[a] = ia; this.rangeInputs[b] = ib;
      return h('label', { class: 'gx-range' }, h('span', {}, name), ia, h('span', { class: 'gx-to' }, t('to')), ib);
    };
    const fitY = h('button', { type: 'button', class: 'btn gx-small', 'data-graph-fit': '1' }, t('Fit y'));
    fitY.addEventListener('click', () => this.fitY());
    const square = h('button', { type: 'button', class: 'btn gx-small', 'data-graph-square': '1', title: t('The same scale across and up, so a circle looks round') }, t('Equal scale'));
    square.addEventListener('click', () => this.square());
    this.tRange = pair('tMin', 'tMax', 't, θ');
    const ranges = h('div', { class: 'gx-ranges' }, pair('xMin', 'xMax', 'x'), pair('yMin', 'yMax', 'y'), this.tRange, h('div', { class: 'gx-range-btns' }, fitY, square));

    const toggle = (key, label) => {
      const i = h('input', { type: 'checkbox', 'data-toggle': key });
      i.checked = this.draft[key] !== false;
      i.addEventListener('change', () => { this.draft[key] = i.checked; this.apply(); });
      return h('label', { class: 'gx-toggle' }, i, h('span', {}, label));
    };
    const toggles = h('div', { class: 'gx-toggles' }, toggle('grid', t('Grid')), toggle('points', t('Key points')), toggle('labels', t('Formula labels')));
    const clearPins = h('button', { type: 'button', class: 'btn gx-small' }, t('Clear pinned points'));
    clearPins.addEventListener('click', () => { this.draft.pins = []; this.apply(); });
    this.clearPins = clearPins;

    const done = h('button', { type: 'button', class: 'btn primary', 'data-graph-done': '1' }, t('Done'));
    done.addEventListener('click', () => this.finish());
    const cancel = h('button', { type: 'button', class: 'btn', 'data-graph-cancel': '1' }, t('Cancel'));
    cancel.addEventListener('click', () => this.cancel());

    this.el = h('div', { class: 'math-editor graph-editor', id: 'graphEditor', role: 'dialog', 'aria-label': t('Formula graph') },
      h('div', { class: 'mx-head' }, h('b', {}, t('Formula graph')), h('small', {}, t('One formula per line: y = x^2 · x^2 + y^2 = 9 · r = 2sin(3θ) · (cos t, sin t) · (2, 3)'))),
      this.rows, add, this.sliders, ranges,
      h('div', { class: 'gx-foot' }, toggles, clearPins),
      h('div', { class: 'mx-actions' }, h('small', { class: 'mx-tip' }, t('Tip: tap a curve on the board to pin a point on it.')), cancel, done));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); }
    });
    document.getElementById('stage').appendChild(this.el);
    this.drawRows(0);
    this.place();
    loadKatex().then(() => this.drawPreviews()).catch(() => {});
    setTimeout(() => document.addEventListener('pointerdown', this._outside, true), 0);
    app.syncUI?.();
  }

  /** The formula rows, with the focus put in row `focus`. */
  drawRows(focus = -1) {
    this.rows.replaceChildren();
    this.inputs = [];
    this.draft.exprs.forEach((e, i) => {
      const sw = h('button', { type: 'button', class: 'gx-swatch', style: `background:${e.color}`, title: t('Colour'), 'aria-label': t('Colour') });
      sw.addEventListener('click', () => {
        const k = GRAPH_COLORS.indexOf(e.color);
        e.color = GRAPH_COLORS[(k + 1) % GRAPH_COLORS.length];
        sw.style.background = e.color;
        this.apply();
      });
      const input = h('input', { type: 'text', class: 'gx-src', dir: 'ltr', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', value: e.src || '',
        placeholder: i === 0 ? 'y = x^2' : 'x^2 + y^2 = 9', 'data-graph-row': String(i), 'aria-label': t('Formula') });
      input.addEventListener('input', () => { e.src = input.value; this.apply(); this.preview(i); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (ev.shiftKey || i < this.draft.exprs.length - 1) { (this.inputs[i + 1] || input).focus(); return; }
          if (input.value.trim()) { this.el.querySelector('[data-graph-add]').click(); return; }
          this.finish();
        }
      });
      const eye = h('button', { type: 'button', class: 'gx-icon' + (e.on === false ? ' off' : ''), title: t('Show or hide'), html: icon('eye', 16) });
      eye.addEventListener('click', () => { e.on = e.on === false; eye.classList.toggle('off', e.on === false); this.apply(); });
      const del = h('button', { type: 'button', class: 'gx-icon', title: t('Remove'), html: icon('close', 16) });
      del.addEventListener('click', () => {
        this.draft.exprs.splice(i, 1);
        if (!this.draft.exprs.length) this.draft.exprs.push({ src: '', color: GRAPH_COLORS[0] });
        this.drawRows(Math.min(i, this.draft.exprs.length - 1));
        this.apply();
      });
      const out = h('div', { class: 'gx-out', 'data-graph-out': String(i) });
      this.rows.appendChild(h('div', { class: 'gx-row' }, h('div', { class: 'gx-line' }, sw, input, eye, del), out));
      this.inputs.push(input);
    });
    this.drawPreviews();
    this.drawSliders();
    if (focus >= 0 && this.inputs[focus]) setTimeout(() => { const f = this.inputs[focus]; if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 0);
  }

  drawPreviews() { this.draft.exprs.forEach((_, i) => this.preview(i)); }

  /** Under each formula: how it reads, typeset - or, if it does not read, why not. */
  preview(i) {
    clearTimeout(this.timers.get(i));
    this.timers.set(i, setTimeout(async () => {
      const out = this.el && this.el.querySelector(`[data-graph-out="${i}"]`);
      const e = this.draft.exprs[i];
      if (!out || !e) return;
      if (!String(e.src || '').trim()) { out.replaceChildren(); out.className = 'gx-out'; return; }
      let r;
      try { r = readFormula(e.src); } catch (err) { out.className = 'gx-out bad'; out.textContent = err.message; return; }
      const kind = { fx: '', fy: '', polar: t('polar'), param: t('parametric'), implicit: t('equation'), point: t('point'), slider: t('slider') }[r.kind] || '';
      out.className = 'gx-out';
      try {
        const html = (await toHtml(r.tex, false)).html;
        if (!this.el) return;
        out.innerHTML = html;
      } catch { out.textContent = r.tex; }
      if (kind) out.appendChild(h('span', { class: 'gx-kind' }, kind));
    }, 120));
  }

  /** A slider for every letter the formulas use that is not x, y, t, r or θ. */
  drawSliders() {
    const lines = this.draft.exprs.map((e) => { try { return readFormula(e.src); } catch { return null; } });
    const { names, given } = slidersOf(lines.filter(Boolean));
    const key = names.join(',');
    if (key === this._sliderKey) return;
    this._sliderKey = key;
    this.stopPlay();
    this.sliders.replaceChildren();
    for (const n of names) {
      const p = this.draft.params[n] || (this.draft.params[n] = { v: Number.isFinite(given[n]) ? given[n] : 1, min: -5, max: 5 });
      const range = h('input', { type: 'range', min: String(p.min), max: String(p.max), step: 'any', value: String(p.v), 'data-slider': n, 'aria-label': n });
      const val = h('input', { type: 'number', step: 'any', class: 'gx-num gx-val', value: fmtNum(p.v, 3), 'aria-label': n });
      const lo = h('input', { type: 'number', step: 'any', class: 'gx-num gx-lim', value: String(p.min), 'aria-label': `${n} min` });
      const hi = h('input', { type: 'number', step: 'any', class: 'gx-num gx-lim', value: String(p.max), 'aria-label': `${n} max` });
      const play = h('button', { type: 'button', class: 'gx-icon', title: t('Play'), 'data-slider-play': n, html: icon('play', 16) });
      const set = (v, from) => {
        p.v = v;
        if (from !== range) range.value = String(v);
        if (from !== val) val.value = fmtNum(v, 3);
        this.apply();
      };
      range.addEventListener('input', () => set(parseFloat(range.value), range));
      val.addEventListener('input', () => { const v = parseFloat(val.value); if (Number.isFinite(v)) set(v, val); });
      const lim = () => {
        const a = parseFloat(lo.value), b = parseFloat(hi.value);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) { p.min = a; p.max = b; range.min = String(a); range.max = String(b); }
      };
      lo.addEventListener('change', lim); hi.addEventListener('change', lim);
      // ▶ sweeps the slider from end to end and back, so the class can watch what the letter does
      play.addEventListener('click', () => {
        if (this.playing && this.playing.name === n) { this.stopPlay(); return; }
        this.stopPlay();
        let dir = 1, last = performance.now();
        play.innerHTML = icon('pause', 16);
        const step = (now) => {
          if (!this.playing || this.playing.name !== n) return;
          const span = p.max - p.min, dt = Math.min(100, now - last); last = now;
          let v = p.v + dir * span * dt / 4000;
          if (v >= p.max) { v = p.max; dir = -1; } else if (v <= p.min) { v = p.min; dir = 1; }
          set(v);
          this.playing.raf = requestAnimationFrame(step);
        };
        this.playing = { name: n, button: play, raf: requestAnimationFrame(step) };
      });
      this.sliders.appendChild(h('div', { class: 'gx-slider' }, h('b', {}, n), play, lo, range, hi, h('span', { class: 'gx-eq' }, '='), val));
    }
    // a letter no longer used keeps its setting in case it comes back, but takes no room
    this.sliders.style.display = names.length ? '' : 'none';
  }

  stopPlay() {
    if (!this.playing) return;
    cancelAnimationFrame(this.playing.raf);
    this.playing.button.innerHTML = icon('play', 16);
    this.playing = null;
  }

  /** Show the draft on the board, as a preview only. */
  apply() {
    if (!this.el) return;
    const app = this.app;
    app.store.rawPatch(this.id, clone(this.draft));
    app.surface.invalidate();
    this.drawSliders();
    const parametric = this.draft.exprs.some((e) => { try { const r = readFormula(e.src); return r.kind === 'param' || r.kind === 'polar'; } catch { return false; } });
    this.tRange.style.display = parametric ? '' : 'none';
    this.clearPins.style.display = (this.draft.pins || []).length ? '' : 'none';
  }

  /** Make y fit whatever the curves do across the x range. */
  fitY() {
    const o = this.app.store.get(this.id);
    if (!o) return;
    let lo = Infinity, hi = -Infinity;
    const d = graphData({ ...o, ...this.draft, yMin: -1e6, yMax: 1e6 });
    for (const c of d.curves) {
      if (c.point) { lo = Math.min(lo, c.point[1]); hi = Math.max(hi, c.point[1]); }
      for (const p of c.paths) for (let i = 1; i < p.length; i += 2) if (Math.abs(p[i]) < 1e5) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    }
    if (!(hi > lo)) return;
    const pad = (hi - lo) * 0.08;
    this.setRange({ yMin: +(lo - pad).toPrecision(4), yMax: +(hi + pad).toPrecision(4) });
  }

  /** The same scale both ways, keeping the middle where it is: a circle comes out round. */
  square() {
    const o = this.app.store.get(this.id);
    if (!o) return;
    const d = this.draft;
    const perX = (d.xMax - d.xMin) / Math.abs(o.w);
    const mid = (d.yMin + d.yMax) / 2, half = (perX * Math.abs(o.h)) / 2;
    this.setRange({ yMin: +(mid - half).toPrecision(4), yMax: +(mid + half).toPrecision(4) });
  }

  setRange(r) {
    Object.assign(this.draft, r);
    for (const [k, v] of Object.entries(r)) if (this.rangeInputs[k]) this.rangeInputs[k].value = String(v);
    this.apply();
  }

  /** The point on a curve under a spot on the screen, if a curve is near enough to mean it. */
  pinAt(clientX, clientY) {
    const app = this.app, o = app.store.get(this.id);
    if (!o) return null;
    const r = app.surface.canvas.getBoundingClientRect();
    const wp = app.surface.cam.toWorld(clientX - r.left, clientY - r.top);
    if (wp.x < Math.min(o.x, o.x + o.w) || wp.x > Math.max(o.x, o.x + o.w) || wp.y < Math.min(o.y, o.y + o.h) || wp.y > Math.max(o.y, o.y + o.h)) return null;
    const hit = nearestOnCurve(o, wp.x, wp.y);
    const reach = 14 / (app.surface.cam.z || 1);
    return hit && hit.d <= reach ? { i: hit.i, x: +hit.x.toPrecision(6), y: +hit.y.toPrecision(6) } : null;
  }

  /** A point pinned by a tap on the board: added to the draft, or taken off if it is already there. */
  togglePin(pin) {
    const pins = this.draft.pins || (this.draft.pins = []);
    const o = this.app.store.get(this.id);
    const near = pins.findIndex((p) => p.i === pin.i && Math.abs(p.x - pin.x) < Math.abs((this.draft.xMax - this.draft.xMin) / 60));
    if (near >= 0) pins.splice(near, 1); else pins.push(pin);
    if (o) this.apply();
  }

  /** Under the graph being edited, always on screen. */
  place() {
    if (!this.el) return;
    const app = this.app, stage = document.getElementById('stage').getBoundingClientRect();
    const el = this.el;
    const narrow = stage.width < 620;
    el.classList.toggle('docked', narrow);
    if (narrow) { el.style.left = ''; el.style.top = ''; return; }
    const o = app.store.get(this.id);
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x = stage.width - w - 16, y = 70;
    if (o) {
      const a = app.surface.cam.toScreen(o.x, o.y), b = app.surface.cam.toScreen(o.x + o.w, o.y + o.h);
      const right = Math.max(a.x, b.x) + 16, left = Math.min(a.x, b.x) - w - 16;
      x = right + w < stage.width - 8 ? right : left > 8 ? left : stage.width - w - 16;
      y = Math.min(a.y, b.y);
    }
    el.style.left = Math.round(Math.max(8, Math.min(stage.width - w - 8, x))) + 'px';
    el.style.top = Math.round(Math.max(8, Math.min(stage.height - hh - 8, y))) + 'px';
  }

  /** Keep it: one step on the undo list. */
  finish() {
    if (!this.el) return;
    const id = this.id, draft = clone(this.draft), before = this.before;
    draft.exprs = draft.exprs.filter((e) => String(e.src || '').trim());
    this.close();
    const app = this.app;
    if (!app.store.get(id)) return;
    app.store.rawPatch(id, before);
    if (!draft.exprs.length) {
      // nothing left to draw: a graph that was just made goes; one that was there keeps its old formulas
      if (this.fresh) dropFresh(app, id);
      app.surface.invalidate();
      return;
    }
    if (JSON.stringify(graphFields({ ...before })) !== JSON.stringify(graphFields(draft))) app.store.update(id, draft, 'edit graph');
    app.setSelection([id]);
    app.surface.invalidate();
  }

  /** Put it back as it was. */
  cancel() {
    if (!this.el) return;
    const id = this.id, before = this.before, fresh = this.fresh;
    this.close();
    const app = this.app;
    if (!app.store.get(id)) return;
    app.store.rawPatch(id, before);
    if (fresh) dropFresh(app, id);
    app.surface.invalidate();
  }

  close() {
    this.stopPlay();
    document.removeEventListener('pointerdown', this._outside, true);
    if (this.el) { this.el.remove(); this.el = null; this.app.syncUI?.(); }
  }
}

/** A graph made a moment ago and then cancelled: taken back as if it had never been made, not deleted as a step of its own. */
function dropFresh(app, id) {
  const st = app.store, last = st.undoStack[st.undoStack.length - 1];
  if (last && last.ops.length === 1 && last.ops[0].t === 'add' && last.ops[0].obj && last.ops[0].obj.id === id) {
    st.undo();
    st.redoStack.pop();
  } else st.remove([id], 'delete graph');
  app.setSelection([]);
}
