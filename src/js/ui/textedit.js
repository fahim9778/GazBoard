// In-place text editing: a positioned <textarea> layered over the canvas.

import { boundsOf } from '../core/store.js';
import { fitFontSize, readableText, wrapText, clamp } from '../core/util.js';
import { faceOf, noteTypeRange } from '../core/render.js';

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
    // A pen-and-touch Windows laptop reports touch points and fires ontouchstart
    // exactly as a phone does, so testing for touch AT ALL made the board scroll
    // out from under anyone editing a note low in the window on a touchscreen PC.
    // What this actually wants to know is whether the pointer is a fingertip, and
    // that is what (pointer: coarse) reports: a phone or tablet matches, a laptop
    // with a mouse or a pen does not, touchscreen or otherwise.
    const touchFirst = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (p.y > vh * 0.65 && touchFirst) {
      app.surface.cam.panBy(0, -(p.y - vh * 0.38));
      app.surface.clampCamera();
      app.surface.invalidate();
    }

    // The canvas must stop drawing this object's text while the textarea is
    // showing it, or the two sit a pixel apart and smear into each other.
    app.surface.editing = { id: obj.id, cell };
    // On a phone the keyboard takes most of the screen and the toolbar ends up
    // sitting on the very box being typed into. The pens are no use mid-word,
    // so they stand down until the words are finished - see app.css.
    document.body.classList.add('typing');

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
    /*
     * Caret at the end, not everything selected.
     *
     * Opening an existing box with all of its text highlighted means the next
     * key you press deletes the lot. That is a fine way to REPLACE something
     * and a terrible default for coming back to fix a word, which is what
     * re-opening a text box is nearly always for. Every text box on a page
     * behaves the other way: you get a caret, and the text stays put. Ctrl+A
     * is still there for anyone who did want all of it.
     */
    setTimeout(() => {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }, 0);
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
      /*
       * Grows AND shrinks. It used to only grow, so a note that had swollen to
       * hold a paragraph stayed that size no matter how much of it you deleted
       * - you could empty the thing completely and still be looking at a note
       * four lines tall.
       *
       * The floor is the height the note had when this edit began, never
       * smaller: a note somebody sized by hand keeps the size they gave it.
       * And the measuring is done against that same fixed height rather than
       * the live one, because the automatic font size is chosen to fit the
       * height - measure against a height that is itself changing and the two
       * chase each other.
       */
      const base = this.startH != null ? this.startH : o.h;
      const want = Math.max(base, this.noteHeight(o, this.el.value, base));
      if (want !== o.h) { o.h = want; box = boundsOf(o); }
    }

    /*
     * A text box is exactly as tall as its words, as you type them.
     *
     * It used to keep the height it was created with, so the moment the text
     * ran past one line the box scrolled inside itself and the first line went
     * out of sight. Then I made it grow but not shrink, on the theory that
     * resizing on every backspace would make the frame flinch. That was wrong
     * twice over: deleting a paragraph left a tall empty box, and the box then
     * snapped smaller anyway the instant you clicked away, because that is what
     * commit() has always done. A jump at the end is worse than movement while
     * typing, and this way there is no jump at all - what you are looking at
     * while you type is already the finished size.
     *
     * Nothing here can oscillate: the width is fixed while editing, so the
     * number of lines depends on the words alone and never on the height.
     */
    if (o.type === 'text' && !this.cell && o.autoSize !== false) {
      const want = this.fitBox(o, this.el.value).h;
      if (want !== o.h) { o.h = want; box = boundsOf(o); }
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
      // A note's type range comes from its own width, so it is the same on
      // screen whatever zoom the note was made at - see noteTypeRange().
      const range = o.type === 'note' ? noteTypeRange(o) : { max: 72, min: 10 };
      size = fitFontSize(this.measure, this.el.value || ' ', ww, wh, face, '400', range.max, range.min);
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
    const ink = o.type === 'note' ? (o.textColor || readableText(o.color || '#ffd94a'))
      : (o.color || o.textColor || '#201f1e');
    s.color = ink;
    s.caretColor = ink;                 // a black caret is invisible on a dark note
    /*
     * Show what will actually be there.
     *
     * Everything except a note used to be typed into an opaque white panel,
     * which hid the shape it was inside, the ink behind it, and the fact that a
     * text box has no fill of its own. You typed onto white and got something
     * else the moment you clicked away. A note keeps its own colour because a
     * note really is a coloured square; everything else shows whatever the
     * object will actually be drawn with, which is usually nothing.
     */
    s.background = o.type === 'note' ? o.color
      : (!this.cell && o.background && o.background !== 'none' ? o.background : 'transparent');
    // The frame has to be visible against whatever it is sitting on, and on a
    // dark note that is not near-black.
    s.outlineColor = o.type === 'note' ? ink : 'rgba(0,0,0,.45)';
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
    this.app.surface.editing = null;      // the canvas owns the text again
    document.body.classList.remove('typing');
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
      if (target.type === 'text' && target.autoSize !== false) {
        // Rewind the growth that happened while typing, so the undo entry
        // records the height the box had BEFORE this edit rather than the one
        // it drifted to during it. fitBox reads the width and the font, never
        // the height, so the answer is the same either way.
        if (this.startH != null) target.h = this.startH;
        Object.assign(patch, this.fitBox(target, value));
      }
      if (target.type === 'note') {
        // Rewind the live resizing so update() records the height the note had
        // before this edit, then ask for the height the finished text needs -
        // never below where it started.
        if (this.startH != null) target.h = this.startH;
        const base = target.h;
        const want = Math.max(base, this.noteHeight(target, value, base));
        if (want !== target.h) patch.h = want;
      }
      store.update(target.id, patch, 'edit text');
      // an empty brand-new text box is not worth keeping
      if (!value && target.type === 'text') store.remove([target.id], 'remove empty text');
    } else if (!value && target.type === 'text' && !target.text) {
      store.remove([target.id], 'remove empty text');
    } else if (this.startH != null && (target.type === 'note' || target.type === 'text')) {
      target.h = this.startH;      // nothing changed, so neither should the box
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
  noteHeight(o, value, baseH = o.h) {
    const pad = Math.max(10, o.w * 0.08);
    const innerW = Math.max(8, o.w - pad * 2);
    const face = faceOf(o.font);
    const weight = o.bold ? '600' : '400';
    let size = o.fontSize;
    if (!size) {
      // Against baseH, not the live height. The automatic size is picked to fit
      // the box, and the box is about to be sized to fit the text: measuring
      // against a height that is itself moving sets the two chasing each other.
      this.measure.font = `${weight} 16px ${face}`;
      const range = noteTypeRange(o);
      size = fitFontSize(this.measure, value || ' ', innerW, Math.max(8, baseH - pad * 2), face, weight, range.max, range.min);
    }
    this.measure.font = `${weight} ${size}px ${face}`;
    const lines = wrapText(this.measure, value || ' ', innerW);
    // What the text NEEDS. Whether the note is allowed to become that small is
    // the caller's business, and the answer is never below the size it started.
    return Math.ceil(lines.length * size * 1.28 + pad * 2);
  }

  cancel() {
    if (!this.el) return;
    const target = this.target;
    const el = this.el;
    /*
     * Clear the fields BEFORE detaching the textarea.
     *
     * Removing a focused element fires `blur`, and the blur handler is
     * commit(). With this.el still set, that commit ran for real - so
     * cancelling an edit quietly SAVED it instead of throwing it away, the
     * note-height rewind below never happened, and commit's own el.remove()
     * then threw on a node that was already gone. Nulling first makes the
     * blur-driven commit hit its own guard and return, which is what it
     * should always have done.
     */
    this.el = null; this.target = null; this.cell = null;
    this.app.surface.editing = null;      // the canvas owns the text again
    document.body.classList.remove('typing');
    el.remove();
    // A cancelled edit gives back whatever height it grew to while typing -
    // for a text box exactly as for a note.
    if (target && (target.type === 'note' || target.type === 'text') && this.startH != null) {
      target.h = this.startH;
    }
    this.startH = null;
    if (target && target.type === 'text' && !target.text) this.app.store.remove([target.id], 'remove empty text');
    this.app.afterTextEdit();
    this.app.surface.invalidate();
  }

  reposition() { if (this.el) this.place(); }
}
