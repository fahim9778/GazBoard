// The ring: shortcuts around the pen tip.
//
// Holding a pen or a finger still on empty board opens a ring of round buttons
// centred where you held: your three latest pens, the highlighter, the eraser,
// the lasso, Paste, and "Insert & more…" for everything the old list menu had.
// Undo and Redo sit in the middle. It is the press-and-hold menu, made for a
// hand rather than a mouse - every button is a thumb's width, all of them the
// same short reach from where the pen already is.
//
// Two ways to use it, both natural on a tablet:
//   - keep the pen down, slide onto a button and lift: done in one stroke
//   - lift first, then tap a button
// Tapping anywhere else, or Esc, puts it away. A mouse keeps its right-click
// list: the ring is for hands without a right button.

import { h } from './popover.js';
import { icon } from './icons.js';
import { penById, penList, heldPenId, penIcon } from './palettes.js';
import { t } from '../i18n.js';
import { inkPaint } from '../core/render.js';

const RING_R = 82;          // where the buttons sit, px from the centre
const BTN = 54;             // each button's size
const HUB = 30;             // the middle's radius: Undo on the left half, Redo on the right
const OUTER = RING_R + BTN / 2 + 6;

/** The three pens the ring offers: the latest ones used, topped up from the tray in tray order. */
export function ringPens(settings) {
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id) && penById(settings, id)) ids.push(id); };
  for (const id of settings.recentPens || []) add(id);
  add(heldPenId(settings));
  for (const p of penList(settings)) add(p.id);
  return ids.slice(0, 3).map((id) => penById(settings, id));
}

/** Note a pen as just used, for the ring's "latest pens". */
export function rememberRecentPen(settings, id) {
  if (!id) return;
  settings.recentPens = [id, ...(settings.recentPens || []).filter((x) => x !== id)].slice(0, 3);
}

export class RadialMenu {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.items = [];
    this.hot = null;
    this._key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } };
    /*
     * A press anywhere but on a button puts the ring away - and then carries on
     * as the press it is. The ring used to lie over the whole window to catch
     * that press, so the press went no further: holding the pen again to get a
     * fresh ring only closed the old one, Windows' own pen press-and-hold then
     * landed on the bare canvas with nothing in hand, and the old list menu came
     * up instead. Every other hold was the ring, every other one the list.
     */
    this._outside = (e) => {
      if (!this.el) return;
      if (e.target instanceof Element && e.target.closest('#radialMenu .rad-btn, #radialMenu .rad-hub')) return;
      this.close();
    };
  }

  get open() { return !!this.el; }

  /** The slices, in order clockwise from the top. Each: { id, label, html, run }. */
  slices(wp) {
    const a = this.app, s = a.settings;
    const pens = ringPens(s).map((p) => ({
      id: 'pen:' + p.id, label: p.label, html: penIcon(inkPaint(p.color), p.effect),
      active: a.tool === 'pen' && heldPenId(s) === p.id,
      run: async () => { (await import('./toolbar.js')).choosePen(a, p.id); }
    }));
    const tool = (id, html, label) => ({ id, label, html, active: a.tool === id, run: () => a.setTool(id) });
    return [
      ...pens,
      tool('highlighter', penIcon(s.highlighterColor, 'none', 'highlighter'), t('Highlighter')),
      tool('eraser', penIcon('#f7a8c4', 'none', 'eraser'), t('Eraser')),
      tool('lasso', icon('lasso', 24), t('Lasso select')),
      { id: 'paste', label: t('Paste'), html: icon('paste', 24), run: () => a.pasteAt(wp) },
      { id: 'more', label: t('Insert & more…'), html: icon('more', 24), run: () => a.showContextMenu(this._at) }
    ];
  }

  /**
   * Open at a screen point. `pressing`: the pen or finger is still down, so a
   * slide-and-lift can choose.
   */
  show(at, wp) {
    this.close();
    const W = innerWidth, H = innerHeight, m = OUTER + 8;
    // kept whole on screen: a hold near an edge moves the ring in, not off
    const cx = Math.min(W - m, Math.max(m, at.clientX)), cy = Math.min(H - m, Math.max(m, at.clientY));
    this._at = { clientX: at.clientX, clientY: at.clientY };
    this.center = { x: cx, y: cy };
    const list = this.slices(wp);
    const n = list.length;
    this.items = list.map((it, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const b = h('button', { type: 'button', class: 'rad-btn' + (it.active ? ' active' : ''), title: it.label, 'aria-label': it.label,
        'data-radial': it.id, html: it.html });
      b.style.left = (cx + Math.cos(ang) * RING_R - BTN / 2) + 'px';
      b.style.top = (cy + Math.sin(ang) * RING_R - BTN / 2) + 'px';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.choose(it); });
      return { ...it, ang, el: b };
    });
    const undo = h('button', { type: 'button', class: 'rad-hub rad-undo', title: t('Undo'), 'aria-label': t('Undo'), 'data-radial': 'undo', html: icon('undo', 18) });
    const redo = h('button', { type: 'button', class: 'rad-hub rad-redo', title: t('Redo'), 'aria-label': t('Redo'), 'data-radial': 'redo', html: icon('redo', 18) });
    for (const [b, left] of [[undo, true], [redo, false]]) {
      b.style.left = (left ? cx - HUB : cx) + 'px';
      b.style.top = (cy - HUB) + 'px';
    }
    this.hub = {
      undo: { id: 'undo', label: t('Undo'), el: undo, run: () => this.app.command('edit.undo'), keep: true },
      redo: { id: 'redo', label: t('Redo'), el: redo, run: () => this.app.command('edit.redo'), keep: true }
    };
    undo.addEventListener('click', (e) => { e.stopPropagation(); this.choose(this.hub.undo); });
    redo.addEventListener('click', (e) => { e.stopPropagation(); this.choose(this.hub.redo); });
    const ring = h('div', { class: 'rad-ring' });
    ring.style.left = (cx - OUTER) + 'px'; ring.style.top = (cy - OUTER) + 'px';
    ring.style.width = ring.style.height = (OUTER * 2) + 'px';
    this.label = h('div', { class: 'rad-label' });
    this.label.style.left = cx + 'px'; this.label.style.top = (cy - OUTER - 34) + 'px';
    this.el = h('div', { id: 'radialMenu', role: 'menu', 'aria-label': t('Shortcuts') }, ring, ...this.items.map((i) => i.el), undo, redo, this.label);
    document.body.appendChild(this.el);
    document.addEventListener('keydown', this._key, true);
    document.addEventListener('pointerdown', this._outside, true);
    this.opened = performance.now();
  }

  /** Which slice (or hub half) a screen point is over, if any. */
  hit(x, y) {
    if (!this.center) return null;
    const dx = x - this.center.x, dy = y - this.center.y, d = Math.hypot(dx, dy);
    if (d <= HUB) return dx < 0 ? this.hub.undo : this.hub.redo;
    if (d < HUB + 8 || d > OUTER + 24) return null;
    const ang = Math.atan2(dy, dx), n = this.items.length, step = (2 * Math.PI) / n;
    let best = null, bestGap = Infinity;
    for (const it of this.items) {
      const gap = Math.abs(Math.atan2(Math.sin(ang - it.ang), Math.cos(ang - it.ang)));
      if (gap < bestGap) { bestGap = gap; best = it; }
    }
    return bestGap <= step / 2 ? best : null;
  }

  /** The pen or finger, still down, sliding over the ring. */
  track(x, y) {
    const it = this.hit(x, y);
    if (it === this.hot) return;
    if (this.hot) this.hot.el.classList.remove('hot');
    this.hot = it;
    if (it) it.el.classList.add('hot');
    this.label.textContent = it ? it.label : '';
    this.label.classList.toggle('show', !!it);
  }

  /** The pen or finger lifts. Over a button: that is the choice. Anywhere else: the ring stays, for a tap. */
  release(x, y) {
    const it = this.hit(x, y);
    // lifting right where the hold began is just letting go - the ring stays for a tap
    if (it && Math.hypot(x - this.center.x, y - this.center.y) > HUB) { this.choose(it); return true; }
    this.track(-1e6, -1e6);
    return false;
  }

  choose(it) {
    // Undo and Redo keep the ring open, so several steps back are several taps, not several holds
    if (!it.keep) this.close();
    Promise.resolve().then(() => it.run()).catch(() => {});
  }

  close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    this.items = [];
    this.hot = null;
    this.center = null;
    document.removeEventListener('keydown', this._key, true);
    document.removeEventListener('pointerdown', this._outside, true);
  }
}
