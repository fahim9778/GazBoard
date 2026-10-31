// The spotlight: the room's eyes on one spot.
//
// The board goes dark except a soft round light that follows the pointer,
// the pen or a finger, like a torch on a whiteboard in a dim room. Writing
// still works underneath it - the light is a sheet laid over the board that
// lets every touch through - and the toolbars stay lit, so nothing has to be
// switched off to carry on teaching.
//
// It is not part of the board: not saved, not exported, not sent, like the
// laser. Its size is remembered.

import { h } from './popover.js';

export const SPOT_MIN = 60, SPOT_MAX = 600;

export class Spotlight {
  constructor(host, { radius = 170, onResize = null } = {}) {
    this.host = host;
    this.r = Math.min(SPOT_MAX, Math.max(SPOT_MIN, radius || 170));
    this.onResize = onResize;
    this.el = null;
    this.x = null; this.y = null;
    this._move = (e) => this.follow(e.clientX, e.clientY);
  }

  get on() { return !!this.el; }
  toggle() { if (this.el) this.close(); else this.open(); return this.on; }

  open() {
    if (this.el) return;
    this.el = h('div', { id: 'spotlight', 'aria-hidden': 'true' });
    this.host.appendChild(this.el);
    const r = this.host.getBoundingClientRect();
    if (this.x == null) { this.x = r.width / 2; this.y = r.height / 2; }
    // every pointer, every kind, heard before anything else can stop it - but never stopped here
    window.addEventListener('pointermove', this._move, { capture: true, passive: true });
    window.addEventListener('pointerdown', this._move, { capture: true, passive: true });
    this.paint();
  }

  close() {
    window.removeEventListener('pointermove', this._move, { capture: true });
    window.removeEventListener('pointerdown', this._move, { capture: true });
    if (this.el) { this.el.remove(); this.el = null; }
  }

  follow(clientX, clientY) {
    if (!this.el) return;
    const r = this.host.getBoundingClientRect();
    this.x = clientX - r.left; this.y = clientY - r.top;
    this.paint();
  }

  /** Bigger or smaller: [ and ] (or Alt+wheel), in steps that feel the same at any size. */
  resize(factor) {
    this.r = Math.round(Math.min(SPOT_MAX, Math.max(SPOT_MIN, this.r * factor)));
    this.paint();
    this.onResize?.(this.r);
  }

  paint() {
    if (!this.el) return;
    const s = this.el.style;
    s.setProperty('--sx', this.x + 'px');
    s.setProperty('--sy', this.y + 'px');
    s.setProperty('--sr', this.r + 'px');
  }
}
