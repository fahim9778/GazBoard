/*
 * The page strip: a column of small pictures of every sheet in a pad, down the
 * side of the board, like the page list in a PDF reader. Click one to go to
 * that page; the page you are on is outlined.
 *
 * Only on paper boards - an infinite canvas has no pages to list. It opens
 * from a small tab on the left edge of the board (where a PDF reader keeps
 * its page list), or from the page navigator's menu, folds away with the
 * arrow at its top, and remembers whether it was open.
 *
 * It sits OVER the board rather than pushing it aside, so opening it never
 * moves the page you are writing on.
 *
 * Pictures are the costly part, so they are made lazily and only when a page
 * has really changed: each page gets a fingerprint of the things on it, and a
 * picture is redrawn only when the fingerprint moves and the picture is in
 * sight. Writing on page 3 of a 40-page pad redraws page 3's picture, once,
 * after the pen has rested - never the other 39, and never while writing.
 */
import { t } from '../i18n.js';
import { h } from './popover.js';
import { icon } from './icons.js';
import { pageRects, pageIndexForBoxIn } from '../core/pages.js';
import { worldBounds } from '../core/store.js';

// CSS pixels across one picture: smaller on a phone, where the strip must not cover half the page
const thumbWidth = () => (typeof innerWidth === 'number' && innerWidth < 700 ? 72 : 112);
const IDLE_MS = 700;        // how long the board has to rest before pictures are redrawn

export class PageStrip {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.list = null;
    this.items = [];          // { box, canvas, label, sig, drawnSig }
    this.current = -1;
    this.redraws = 0;         // for the suite: how many pictures have actually been drawn
    this._timer = null;
    this._bg = '';
    app.store.subscribe(() => this.changed());
    // a phone turned round, or a window dragged narrow: the pictures change size, so they are drawn again
    let lastW = thumbWidth();
    window.addEventListener('resize', () => {
      const w = thumbWidth(); if (w === lastW) return; lastW = w;
      for (const it of this.items) it.drawnSig = null;
      if (this.open) { this.layout(); this.schedule(120); }
    });
  }

  get open() { return !!(this.el && this.el.classList.contains('show')); }

  /** Whether the strip can be shown at all: a pad, not presenting. */
  get possible() { return this.app.pageCount > 0 && !this.app.presenting; }

  toggle(on = !this.open) {
    this.app.settings.pageStrip = !!on;
    this.app.saveSettings();
    this.sync();
  }

  ensure() {
    if (this.el) return;
    this.list = h('div', { class: 'ps-list', role: 'list' });
    const close = h('button', { type: 'button', class: 'ps-close', title: t('Hide page pictures'), 'aria-label': t('Hide page pictures'), html: icon('chevronRight', 16) });
    close.addEventListener('click', () => this.toggle(false));
    this.el = h('aside', { id: 'pagestrip', 'aria-label': t('Pages') },
      h('div', { class: 'ps-head' }, h('span', {}, t('Pages')), close), this.list);
    (document.getElementById('stage') || document.body).appendChild(this.el);
    this.list.addEventListener('scroll', () => this.schedule(60), { passive: true });
  }

  /** The tab on the board's edge that opens the strip: only there while the strip is folded away. */
  ensureTab() {
    if (this.tab) return;
    this.tab = h('button', { type: 'button', id: 'pagetab', title: t('Show page pictures'), 'aria-label': t('Show page pictures') });
    this.tab.innerHTML = icon('pages', 17) + `<span class="pt-arrow">${icon('chevronRight', 13, 2)}</span>`;
    this.tab.addEventListener('click', () => this.toggle(true));
    (document.getElementById('stage') || document.body).appendChild(this.tab);
  }

  /** Show or hide it to match the board and the setting, and bring it up to date. */
  sync() {
    const want = this.possible && this.app.settings.pageStrip === true;
    if (this.possible || this.tab) { this.ensureTab(); this.tab.classList.toggle('show', this.possible && !want); }
    if (!want) { if (this.el) this.el.classList.remove('show'); document.body.classList.remove('has-pagestrip'); return; }
    const was = this.open;
    this.ensure();
    this.el.classList.add('show');
    document.body.classList.add('has-pagestrip');
    if (!was || this.items.length !== this.app.pageCount) {
      this.layout();
      this.markCurrent(true);
      this.schedule(0);
    }
  }

  /** One row per sheet; rows are kept between calls so their pictures are too. */
  layout() {
    const rects = pageRects(this.app.store.doc.pages);
    while (this.items.length > rects.length) this.items.pop().row.remove();
    rects.forEach((box, i) => {
      let it = this.items[i];
      if (!it) {
        const canvas = document.createElement('canvas');
        const label = h('span', { class: 'ps-num' });
        const row = h('button', { type: 'button', class: 'ps-page', role: 'listitem' }, h('span', { class: 'ps-sheet' }, canvas), label);
        row.addEventListener('click', () => this.app.goToPage(this.items.indexOf(it)));
        this.list.appendChild(row);
        it = this.items[i] = { row, canvas, label, sig: '', drawnSig: null, box };
      }
      it.box = box;
      it.label.textContent = String(i + 1);
      it.row.title = t('Page {n}', { n: i + 1 });
      const tw = thumbWidth();
      const hgt = Math.round(tw * box.h / box.w);
      it.canvas.style.width = tw + 'px';
      it.canvas.style.height = hgt + 'px';
    });
  }

  /** The board changed: fingerprint the pages again after it has rested. */
  changed() {
    if (!this.open) return;
    this.layout();                                   // a page added, removed or resized
    this.schedule(IDLE_MS);
  }

  schedule(ms) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), ms);
  }

  /**
   * A cheap fingerprint of each page: what is on it and where. Anything that
   * would change the picture - an object added, moved, recoloured, resized,
   * written into - changes its line; the paper itself counts for every page.
   */
  signatures() {
    const doc = this.app.store.doc;
    const rects = this.items.map((it) => it.box);
    const parts = rects.map(() => []);
    for (const id of doc.order) {
      const o = doc.objects[id];
      if (!o) continue;
      const b = worldBounds(o);
      const i = pageIndexForBoxIn(rects, b);
      if (i < 0) continue;
      parts[i].push(id, Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h),
        o.points ? o.points.length : '', o.color || o.stroke || '', o.fill || '', o.text ? o.text.length + ':' + hashOf(o.text) : '',
        o.runs ? hashOf(JSON.stringify(o.runs)) : '', o.revealed ? 1 : 0, o.src ? o.src.length : '');
    }
    const paper = JSON.stringify(doc.background || {});
    return parts.map((p, i) => paper + '|' + (doc.pages[i]?.date || '') + '|' + hashOf(p.join(',')));
  }

  /** Redraw the pictures that are out of date and in sight (or nearly). */
  refresh() {
    if (!this.open) return;
    const sigs = this.signatures();
    const view = this.list.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let budget = 6;                                  // pictures per pass, so a big pad never stalls the pen
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      it.sig = sigs[i];
      if (it.drawnSig === it.sig) continue;
      const r = it.row.getBoundingClientRect();
      if (r.bottom < view.top - 400 || r.top > view.bottom + 400) continue;
      if (budget-- <= 0) { this.schedule(30); break; }
      this.draw(it, dpr);
    }
  }

  draw(it, dpr) {
    const scale = (thumbWidth() * dpr) / it.box.w;
    let pic;
    try { pic = this.app.surface.renderTo(it.box, scale, true, true); } catch { return; }
    it.canvas.width = pic.width;
    it.canvas.height = pic.height;
    it.canvas.getContext('2d').drawImage(pic, 0, 0);
    it.drawnSig = it.sig;
    this.redraws++;
  }

  /** Outline the page the view is on, and keep it in sight in the strip. */
  markCurrent(force = false) {
    if (!this.open) return;
    const i = this.app.currentPageIndex();
    if (i === this.current && !force) return;
    this.current = i;
    this.items.forEach((it, k) => it.row.classList.toggle('current', k === i));
    const row = this.items[i]?.row;
    if (row) {
      const lr = this.list.getBoundingClientRect(), rr = row.getBoundingClientRect();
      if (rr.top < lr.top || rr.bottom > lr.bottom) row.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** A short, stable number for a string - enough to notice a change, nothing more. */
function hashOf(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0).toString(36);
}
