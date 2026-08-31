// In-place text editing: a positioned <textarea> layered over the canvas.

import { boundsOf } from '../core/store.js';
import { fitFontSize, readableText, wrapText, clamp } from '../core/util.js';
import { faceOf } from '../core/render.js';

export class TextEditor {
  constructor(app) {
    this.app = app;
    this.layer = document.getElementById('editLayer');
    this.el = null;
    this.target = null;
    this.cell = null;
    this.measure = document.createElement('canvas').getContext('2d');
  }

  get active() { return !!this.el; }

  begin(obj, cell = null) {
    this.commit();
    const app = this.app;
    this.target = obj;
    this.cell = cell;
    // A note grows to fit what is typed into it. The height it had when
    // editing started is kept so the growth can be rewound and re-applied as
    // part of the same undo entry as the text itself.
    this.startH = obj.h;

    const ta = document.createElement('textarea');
    ta.spellcheck = true;
    ta.value = cell ? (obj.cells?.[cell] || '') : (obj.text || '');
    this.el = ta;
    this.layer.appendChild(ta);
    // On touch/mobile viewports, keep active edit target in comfortable visible area above software keyboard
    const p = app.surface.cam.toScreen(obj.x + (obj.w || 200) / 2, obj.y + (obj.h || 100) / 2);
    const vh = window.visualViewport ? window.visualViewport.height : (window.innerHeight || 768);
    if (p.y > vh * 0.65 && ('ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0))) {
      app.surface.cam.panBy(0, -(p.y - vh * 0.38));
      app.surface.clampCamera();
      app.surface.invalidate();
    }

    this.place();

    ta.addEventListener('input', () => { this.place(); app.surface.invalidate(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); app.surface.canvas.focus(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); }
      else if (e.key === 'Tab' && cell) { e.preventDefault(); this.commit(); }
    });
    ta.addEventListener('blur', () => this.commit());
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
    app.surface.invalidate();
  }

  place() {
    if (!this.el || !this.target) return;
    const app = this.app, cam = app.surface.cam, o = this.target;
    let box;
    if (this.cell) {
      const [r, c] = this.cell.split(',').map(Number);
      const cw = o.w / o.cols, ch = o.h / o.rows;
      box = { x: o.x + c * cw, y: o.y + r * ch, w: cw, h: ch };
    } else box = boundsOf(o);

    if (o.type === 'note' && !this.cell) {
      const grown = this.noteHeight(o, this.el.value);
      if (grown > o.h) { o.h = grown; box = boundsOf(o); }
    }

    const pad = o.type === 'note' ? Math.max(10, o.w * 0.08) : o.type === 'shape' ? 10 : 0;
    const wx = box.x + pad, wy = box.y + pad, ww = box.w - pad * 2, wh = box.h - pad * 2;
    const p = cam.toScreen(wx, wy);

    let size = o.fontSize || 0;
    // Measure in the face the text is actually set in. Comic Sans runs much wider
    // than Segoe UI, so autofitting against the sans face overflows the note.
    const face = faceOf(o.font);
    if (!size) {
      this.measure.font = `16px ${face}`;
      size = fitFontSize(this.measure, this.el.value || ' ', ww, wh, face, '400', o.type === 'note' ? 46 : 72, 10);
    }
    const s = this.el.style;
    s.left = p.x + 'px';
    s.top = p.y + 'px';
    s.width = Math.max(24, ww * cam.z) + 'px';
    s.height = Math.max(20, wh * cam.z) + 'px';
    s.fontSize = size * cam.z + 'px';
    s.lineHeight = 1.28;
    s.fontFamily = face;      // what you type in is what gets committed
    s.fontWeight = o.bold ? '600' : '400';
    s.fontStyle = o.italic ? 'italic' : 'normal';
    s.textAlign = this.cell ? 'center' : (o.align || (o.type === 'text' ? 'left' : 'center'));
    s.color = o.type === 'note' ? (o.textColor || readableText(o.color || '#ffd94a')) : (o.color || o.textColor || '#201f1e');
    s.background = o.type === 'note' ? o.color : 'rgba(255,255,255,.96)';
    s.transform = o.rotation ? `rotate(${o.rotation}rad)` : '';
    s.transformOrigin = '0 0';
    s.padding = '0';
    if (o.type === 'note' || o.type === 'shape' || this.cell) {
      const lines = this.el.value.split('\n').length;
      const contentH = lines * size * 1.28 * cam.z;
      s.paddingTop = Math.max(0, (wh * cam.z - contentH) / 2) + 'px';
    } else s.paddingTop = '0';
  }

  commit() {
    if (!this.el || !this.target) return;
    const value = this.el.value;
    const o = this.target;
    const el = this.el;
    this.el = null;
    const target = this.target;
    const cell = this.cell;
    this.target = null; this.cell = null;
    el.remove();

    const store = this.app.store;
    if (cell) {
      const cells = { ...(target.cells || {}) };
      if ((cells[cell] || '') !== value) {
        if (value) cells[cell] = value; else delete cells[cell];
        store.update(target.id, { cells }, 'edit table');
      }
    } else if ((target.text || '') !== value) {
      const patch = { text: value };
      if (target.type === 'text' && target.autoSize !== false) Object.assign(patch, this.fitBox(target, value));
      if (target.type === 'note') {
        // rewind the live growth so update() records the height it had before
        // this edit, then ask for the height the finished text needs
        if (this.startH != null) target.h = this.startH;
        const grown = this.noteHeight(target, value);
        if (grown > target.h) patch.h = grown;
      }
      store.update(target.id, patch, 'edit text');
      // an empty brand-new text box is not worth keeping
      if (!value && target.type === 'text') store.remove([target.id], 'remove empty text');
    } else if (!value && target.type === 'text' && !target.text) {
      store.remove([target.id], 'remove empty text');
    } else if (target.type === 'note' && this.startH != null) {
      target.h = this.startH;      // nothing changed, so neither should the note
    }
    this.startH = null;

    this.app.afterTextEdit();
    this.app.surface.invalidate();
    this.app.syncUI();
  }

  /**
   * Shrink a text box to the text in it.
   *
   * A new box starts wide enough to type into; leaving it that size afterwards
   * gives a short label a selection frame several times its own width.
   */
  fitBox(o, value) {
    const size = o.fontSize || 24;
    const family = faceOf(o.font);
    this.measure.font = `${o.bold ? '600 ' : ''}${size}px ${family}`;
    const pad = size * 0.35;
    const lines = wrapText(this.measure, value, Math.max(40, o.w));
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, this.measure.measureText(line).width);
    return {
      w: clamp(widest + pad, size * 1.2, o.w),   // never wider than it started: long text wraps
      h: Math.max(size * 1.3, lines.length * size * 1.28 + pad * 0.4)
    };
  }

  /**
   * How tall a note has to be for its text to fit inside it.
   *
   * Notes shrink their text first - that is what they have always done - and
   * only grow when even the smallest size will not fit. The result is never
   * smaller than the note already is, so a note the user sized by hand keeps
   * the size they gave it.
   */
  noteHeight(o, value) {
    const pad = Math.max(10, o.w * 0.08);
    const innerW = Math.max(8, o.w - pad * 2);
    const face = faceOf(o.font);
    const weight = o.bold ? '600' : '400';
    let size = o.fontSize;
    if (!size) {
      this.measure.font = `${weight} 16px ${face}`;
      size = fitFontSize(this.measure, value || ' ', innerW, Math.max(8, o.h - pad * 2), face, weight, 46, 10);
    }
    this.measure.font = `${weight} ${size}px ${face}`;
    const lines = wrapText(this.measure, value || ' ', innerW);
    return Math.max(o.h, Math.ceil(lines.length * size * 1.28 + pad * 2));
  }

  cancel() {
    if (!this.el) return;
    const target = this.target;
    this.el.remove();
    if (target && target.type === 'note' && this.startH != null) target.h = this.startH;
    this.startH = null;
    this.el = null; this.target = null; this.cell = null;
    if (target && target.type === 'text' && !target.text) this.app.store.remove([target.id], 'remove empty text');
    this.app.afterTextEdit();
    this.app.surface.invalidate();
  }

  reposition() { if (this.el) this.place(); }
}
