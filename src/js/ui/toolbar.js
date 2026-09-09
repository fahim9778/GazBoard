// Bottom tool pill + its option popovers, plus the top bar wiring.

import { icon } from './icons.js';
import { openPopover, closePopover, h, isOpen } from './popover.js';
import {
  PEN_COLORS, PEN_EFFECTS, HIGHLIGHTER_COLORS, NOTE_COLORS, TEXT_COLORS,
  SHAPE_STROKES, SHAPE_FILLS, SHAPES, SHAPE_LABELS, shapeIcon,
  PENS, penIcon, FONTS
} from './palettes.js';

const TOOL_ICON = {
  select: 'select', lasso: 'lasso', pen: 'pen', highlighter: 'highlighter',
  eraser: 'eraser', note: 'note', text: 'text', shape: 'shapes'
};
const CMD_ICON = { undo: 'undo', redo: 'redo', insert: 'insert', ruler: 'ruler', more: 'more' };

/**
 * The toolbar is built here rather than in the HTML, because the pen tray is
 * data-driven: each pen is its own button carrying its own colour, the way
 * Whiteboard lays them out, and the one in your hand lifts out of the bar.
 */
/**
 * Is this a phone-shaped screen being poked with a finger?
 *
 * Both halves matter. A coarse pointer alone catches a 12" tablet, which has
 * room for the whole tray; a narrow window alone catches a half-width desktop
 * window, where the mouse is still the pointer and the keys still work. The
 * compact bar is for the case where neither the width nor the pointer is
 * generous - and it is read once, at start-up, because rebuilding a toolbar
 * under somebody's thumb while they rotate the phone is worse than a bar that
 * is slightly too small until the next launch.
 */
export function isPhoneLayout() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches
    && (matchMedia('(max-width: 760px)').matches || matchMedia('(max-height: 460px)').matches);
}

export function initToolbar(app) {
  const bar = document.getElementById('toolbar');
  bar.innerHTML = '';
  if (isPhoneLayout()) { initPhoneToolbar(app, bar); wireTopBar(app); return; }

  const sep = () => bar.appendChild(h('div', { class: 'sep' }));

  const iconTool = (opts) => {
    const b = h('button', { class: 'tool', title: opts.title });
    if (opts.tool) b.dataset.tool = opts.tool;
    if (opts.cmd) b.dataset.cmd = opts.cmd;
    if (opts.pop) b.dataset.pop = opts.pop;
    b.innerHTML = icon(opts.icon, 20);
    if (opts.dot) b.appendChild(h('span', { class: 'dot' }));
    // The shortcut letter lives on the button. Nobody memorises a shortcut
    // sheet mid-lesson; seeing "P" under the pen is what makes them get used.
    if (opts.key) b.appendChild(h('span', { class: 'kbd' }, opts.key));
    b.addEventListener('click', (e) => opts.onClick(e, b));
    bar.appendChild(b);
    return b;
  };
  const toggleTool = (tool) => (e, b) => {
    const was = app.tool === tool;
    app.setTool(tool);
    app.syncUI();
    if (was) openToolPopover(app, b, tool); else closePopover();
  };

  iconTool({ tool: 'select', icon: 'select', key: 'V', title: 'Select (V)', onClick: () => app.setTool('select') });
  iconTool({ tool: 'lasso', icon: 'lasso', key: 'L', title: 'Lasso select (L)', onClick: () => app.setTool('lasso') });
  iconTool({ tool: 'pan', icon: 'hand', key: 'G', title: 'Pan the canvas (G) \u2014 drag to move around. Space, the middle mouse button and the scroll wheel do this too',
    onClick: () => app.setTool('pan') });
  iconTool({ tool: 'laser', icon: 'laser', key: 'X', title: 'Laser pointer (X) \u2014 leaves a trail that fades; nothing is saved',
    onClick: () => app.setTool('laser') });
  sep();

  /* ---- the pen tray ---- */
  for (const pen of PENS) {
    const b = h('button', { class: 'pen', title: `${pen.label} (${PENS.indexOf(pen) + 1}) \u2014 click again for thickness` });
    b.dataset.pen = pen.id;
    if (pen.id === 'black') b.dataset.tool = 'pen';       // the canonical pen button
    // every pen wears its own number: 1-6 reach them directly, which is the
    // whole point of putting the keys on the buttons
    b.innerHTML = penIcon(pen.color, pen.effect) + '<span class="size-dot"></span>'
      + `<span class="kbd">${PENS.indexOf(pen) + 1}</span>`;
    b.addEventListener('click', () => {
      const s = app.settings;
      const held = app.tool === 'pen' && s.penColor === pen.color && s.penEffect === pen.effect;
      s.penColor = pen.color;
      s.penEffect = pen.effect;
      app.saveSettings();
      app.setTool('pen');
      app.syncUI();
      if (held) openToolPopover(app, b, 'pen'); else closePopover();
    });
    bar.appendChild(b);
  }

  const hl = h('button', { class: 'pen', title: 'Highlighter (H) \u2014 click again for options' });
  hl.dataset.tool = 'highlighter';
  hl.innerHTML = penIcon(app.settings.highlighterColor, 'none', 'highlighter') + '<span class="kbd">H</span>';
  hl.addEventListener('click', (e) => toggleTool('highlighter')(e, hl));
  bar.appendChild(hl);

  const er = h('button', { class: 'pen', title: 'Eraser (E) \u2014 click again for options' });
  er.dataset.tool = 'eraser';
  er.innerHTML = penIcon('#f7a8c4', 'none', 'eraser') + '<span class="kbd">E</span>';
  er.addEventListener('click', (e) => toggleTool('eraser')(e, er));
  bar.appendChild(er);
  sep();

  iconTool({ cmd: 'ruler', icon: 'ruler', title: 'Ruler (Ctrl+R)', onClick: () => app.command('ruler') });
  iconTool({ tool: 'text', icon: 'text', dot: true, key: 'T', title: 'Text (T) \u2014 click again for font and size',
    onClick: toggleTool('text') });
  iconTool({ tool: 'note', icon: 'note', dot: true, key: 'N', title: 'Sticky note (N) \u2014 click again for colours',
    onClick: toggleTool('note') });
  iconTool({ tool: 'shape', icon: 'shapes', dot: true, key: 'S', title: 'Shapes (S)', onClick: toggleTool('shape') });
  iconTool({ cmd: 'insert.image', icon: 'image', title: 'Insert image', onClick: () => app.command('insert.image') });
  iconTool({ cmd: 'insert', icon: 'insert', pop: 'insert', title: 'Insert document, table or template',
    onClick: (e, b) => openInsertPopover(app, b) });
  sep();

  iconTool({ cmd: 'undo', icon: 'undo', title: 'Undo (Ctrl+Z)', onClick: () => app.command('undo') });
  iconTool({ cmd: 'redo', icon: 'redo', title: 'Redo (Ctrl+Y)', onClick: () => app.command('redo') });
  iconTool({ cmd: 'more', icon: 'more', pop: 'more', title: 'More', onClick: (e, b) => openMorePopover(app, b) });

  wireTopBar(app);
}

/* ==================================================================
 *  The phone bar.
 *
 *  The desktop tray is seventeen buttons wide. On a phone that becomes a
 *  horizontal scroller: the thing you reach for most - a pen - is as much work
 *  to find as the thing you reach for once a month, and both of them are a
 *  swipe away from where your thumb already is.
 *
 *  So this is a different bar, not the same bar squeezed. What survives on it
 *  is what a person writing on a board actually touches: three pens, the
 *  rubber, undo. Everything else earns its place behind one of two menus, and
 *  the pointing tools - select, lasso, hand, laser - go to the back, because
 *  none of them puts a mark on the board.
 *
 *  The desktop bar above is untouched. This is chosen once at start-up by
 *  isPhoneLayout(), so a laptop, a tablet and a half-width window all keep the
 *  tray they have always had.
 * ================================================================== */

/** The three pens that live on the bar; the rest are one tap deeper. */
const PHONE_PENS = ['black', 'red', 'blue'];

function initPhoneToolbar(app, bar) {
  bar.classList.add('phone');

  const btn = (cls, title, html) => {
    const b = h('button', { class: cls, title });
    b.innerHTML = html;
    bar.appendChild(b);
    return b;
  };
  const sep = () => bar.appendChild(h('div', { class: 'sep' }));

  const choosePen = (pen, b) => {
    const s = app.settings;
    const held = app.tool === 'pen' && s.penColor === pen.color && s.penEffect === pen.effect;
    s.penColor = pen.color;
    s.penEffect = pen.effect;
    app.saveSettings();
    app.setTool('pen');
    app.syncUI();
    if (held && b) openToolPopover(app, b, 'pen'); else closePopover();
  };

  /* ---- the three everyday pens ---- */
  for (const id of PHONE_PENS) {
    const pen = PENS.find((p) => p.id === id);
    if (!pen) continue;
    const b = btn('pen', `${pen.label} — tap again for thickness`,
      penIcon(pen.color, pen.effect) + '<span class="size-dot"></span>');
    b.dataset.pen = pen.id;
    if (pen.id === 'black') b.dataset.tool = 'pen';
    b.addEventListener('click', () => choosePen(pen, b));
  }

  /* ---- everything else that makes a mark, one tap deeper ---- */
  const rest = btn('tool tool-sm', 'More pens and the highlighter', icon('chevronUp', 18));
  rest.dataset.pop = 'pens';
  rest.addEventListener('click', () => {
    const body = h('div', { class: 'menu' });
    for (const pen of PENS) {
      if (PHONE_PENS.includes(pen.id)) continue;
      const row = h('button', { class: 'menu-item' },
        h('span', { html: penIcon(pen.color, pen.effect), style: 'display:flex;width:17px' }),
        h('span', {}, pen.label));
      row.addEventListener('click', () => { closePopover(); choosePen(pen, null); });
      body.appendChild(row);
    }
    body.appendChild(h('div', { class: 'menu-sep' }));
    body.appendChild(menuItem('Highlighter', 'highlighter', () => { app.setTool('highlighter'); app.syncUI(); }));
    openPopover(rest, body, { key: 'pens' });
  });

  /* ---- the rubber, beside the pens where it belongs ---- */
  const er = btn('pen', 'Eraser — tap again for options',
    penIcon('#f7a8c4', 'none', 'eraser'));
  er.dataset.tool = 'eraser';
  er.addEventListener('click', () => {
    const was = app.tool === 'eraser';
    app.setTool('eraser');
    app.syncUI();
    if (was) openToolPopover(app, er, 'eraser'); else closePopover();
  });
  sep();

  /*
   * Finger draws / finger moves the board.
   *
   * Only shown once a pen has actually touched this screen. On a phone with no
   * stylus the finger is the only thing there is, it draws, and a button
   * offering to take that away would be a trap rather than a choice.
   */
  const fingerBtn = btn('tool tool-sm', 'Finger draws or moves the board', icon('hand', 18));
  fingerBtn.dataset.cmd = 'fingerInk';
  fingerBtn.addEventListener('click', () => { app.toggleFingerInk(); syncToolbar(app); });

  /* ---- undo and redo, the other thing a hand reaches for constantly ---- */
  const un = btn('tool tool-sm', 'Undo', icon('undo', 18));
  un.dataset.cmd = 'undo';
  un.addEventListener('click', () => app.command('undo'));
  const re = btn('tool tool-sm', 'Redo', icon('redo', 18));
  re.dataset.cmd = 'redo';
  re.addEventListener('click', () => app.command('redo'));
  sep();

  /* ---- things you add to the board ---- */
  const add = btn('tool tool-sm', 'Add a note, text, shape, ruler or picture', icon('plus', 18));
  add.dataset.pop = 'add';
  add.addEventListener('click', () => {
    const pickTool = (t) => () => { app.setTool(t); app.syncUI(); };
    openPopover(add, h('div', { class: 'menu' },
      menuItem('Sticky note', 'note', pickTool('note')),
      menuItem('Text', 'text', pickTool('text')),
      menuItem('Shape', 'shapes', pickTool('shape')),
      menuItem(app.ruler.visible ? 'Hide ruler' : 'Ruler', 'ruler', () => app.command('ruler')),
      h('div', { class: 'menu-sep' }),
      menuItem('Picture…', 'image', () => app.command('insert.image')),
      menuItem('Document (Word, PowerPoint, PDF)…', 'doc', () => app.command('insert.document')),
      menuItem('Table', 'table', () => app.command('insert.table'))
    ), { key: 'add' });
  });

  /* ---- and the rest: pointing tools first, then the old More menu ---- */
  const more = btn('tool tool-sm', 'More', icon('more', 18));
  more.dataset.pop = 'more';
  more.addEventListener('click', () => {
    const pickTool = (t) => () => { app.setTool(t); app.syncUI(); };
    openPopover(more, h('div', { class: 'menu' },
      menuItem('Select', 'select', pickTool('select')),
      menuItem('Lasso select', 'lasso', pickTool('lasso')),
      menuItem('Move the board', 'hand', pickTool('pan')),
      menuItem('Laser pointer', 'laser', pickTool('laser')),
      h('div', { class: 'menu-sep' }),
      menuItem('Boards…', 'board', () => app.panels.boards()),
      menuItem('Templates…', 'template', () => app.panels.templates()),
      menuItem('Format background…', 'palette', () => app.panels.background()),
      menuItem('Select all', 'select', () => app.command('edit.selectAll')),
      h('div', { class: 'menu-sep' }),
      menuItem('Export as PNG…', 'export', () => app.command('export.png')),
      menuItem('Export as PDF…', 'doc', () => app.command('export.pdf')),
      menuItem('Save a copy…', 'doc', () => app.command('board.save')),
      menuItem('Open board…', 'board', () => app.command('board.open')),
      h('div', { class: 'menu-sep' }),
      menuItem('Share on this network…', 'share', () => app.panels.sharing()),
      menuItem('Settings', 'settings', () => app.panels.settings()),
      menuItem('About GazBoard', 'board', () => app.showAbout()),
      menuItem('Clear canvas', 'trash', () => app.command('edit.clear'), { danger: true })
    ), { key: 'more' });
  });
}

/* ---- top bar and zoom controls ---- */
function wireTopBar(app) {
  const top = [
    ['btnBoards', 'board', () => app.panels.boards()],
    ['btnTemplates', 'template', () => app.panels.templates()],
    ['btnBackground', 'palette', () => app.panels.background()],
    ['btnExport', 'export', (e) => openExportPopover(app, e.currentTarget)],
    ['btnShare', 'share', () => app.panels.sharing()],
    ['btnSettings', 'settings', () => app.panels.settings()],
    ['btnHelp', 'help', () => app.showShortcuts()]
  ];
  const labels = { btnBoards: 'Boards', btnTemplates: 'Templates', btnBackground: 'Background', btnExport: 'Export' };
  for (const [id, ic, fn] of top) {
    const el = document.getElementById(id);
    // A build without sharing has no such button in the page, and asking for
    // one that is not there used to take the whole toolbar down with it.
    if (!el) continue;
    el.innerHTML = icon(ic, 18) + (labels[id] ? `<span>${labels[id]}</span>` : '');
    el.addEventListener('click', fn);
  }
  document.getElementById('panelClose').innerHTML = icon('close', 18);

  for (const [sel, name] of [['[data-cmd="zoomOut"]', 'zoomOut'], ['[data-cmd="zoomIn"]', 'zoomIn'], ['[data-cmd="fit"]', 'fit']]) {
    const el = document.querySelector('#zoombar ' + sel);
    el.innerHTML = icon(name, 18);
    el.addEventListener('click', () => app.command(name));
  }
  document.getElementById('zoomLabel').addEventListener('click', () => app.command('zoomReset'));

  initPagebar(app);
}

/* ------------------------------------------------------------------ *
 *  The page navigator
 *
 *  Only ever shown on a pad. On an infinite board there are no pages to
 *  step through, and a control that is permanently disabled is just clutter.
 * ------------------------------------------------------------------ */
function initPagebar(app) {
  const bar = document.getElementById('pagebar');
  if (!bar) return;
  const btn = (k) => bar.querySelector(`[data-page="${k}"]`);
  btn('prev').innerHTML = icon('back', 18);
  btn('next').innerHTML = `<span style="display:flex;transform:rotate(180deg)">${icon('back', 18)}</span>`;
  btn('add').innerHTML = icon('insert', 18);
  btn('more').innerHTML = icon('more', 18);

  btn('prev').addEventListener('click', () => app.command('page.prev'));
  btn('next').addEventListener('click', () => app.command('page.next'));
  btn('add').addEventListener('click', () => app.command('page.add'));
  document.getElementById('pageLabel').addEventListener('click', () => app.command('view.fitPage'));

  btn('more').addEventListener('click', (e) => {
    const last = app.pageCount <= 1;
    openPopover(e.currentTarget, h('div', { class: 'menu' },
      menuItem('Add a page after this one', 'insert', () => app.command('page.add')),
      menuItem('Duplicate this page', 'duplicate', () => app.command('page.duplicate')),
      menuItem('Fit the whole pad in the window', 'fit', () => app.command('view.fitAllPages')),
      menuItem('Fit everything onto the paper', 'shapes', () => app.command('page.fitContent')),
      h('div', { class: 'menu-sep' }),
      menuItem('Delete this page', 'trash', () => app.command('page.delete'), { danger: true, disabled: last })
    ), { align: 'end' });
  });
}

/** Reflect the current page in the navigator. Called from syncToolbar. */
function syncPagebar(app) { app.syncPageLabel(); }

/* ------------------------------------------------------------------ */
/** Move the `active` marker to `el` immediately - the popover stays open, so
 *  waiting for the next render would show the previous choice. */
function markActive(wrap, el, cls = 'active') {
  for (const sib of wrap.children) sib.classList.remove(cls);
  el.classList.add(cls);
}

function swatchRow(colors, current, onPick, extra = []) {
  const wrap = h('div', { class: 'swatches' });
  for (const c of colors) {
    const b = h('button', { class: 'sw' + (c === current ? ' active' : ''), title: c, 'aria-label': c });
    b.style.background = c;
    b.addEventListener('click', () => { markActive(wrap, b); onPick(c); });
    wrap.appendChild(b);
  }
  for (const e of extra) wrap.appendChild(e);
  return wrap;
}

function sizeRow(sizes, current, onPick, color = '#201f1e') {
  const wrap = h('div', { class: 'sizes' });
  for (const s of sizes) {
    const b = h('button', { class: 'size' + (s === current ? ' active' : ''), title: s + ' px' });
    const dotSize = Math.max(4, Math.min(22, s));
    b.innerHTML = `<i style="width:${dotSize}px;height:${dotSize}px;background:${color}"></i>`;
    b.addEventListener('click', () => { markActive(wrap, b); onPick(s); });
    wrap.appendChild(b);
  }
  return wrap;
}

/** Each face previewed in itself, so 'Handwriting' looks like handwriting. */
function fontRow(fonts, current, onPick) {
  const wrap = h('div', { class: 'font-row' });
  for (const f of fonts) {
    const b = h('button', { class: 'font-opt' + (f.id === current ? ' active' : ''), title: f.label });
    b.innerHTML = `<span style="font-family:${f.stack}">Aa</span><small>${f.label}</small>`;
    b.addEventListener('click', () => { markActive(wrap, b); onPick(f.id); });
    wrap.appendChild(b);
  }
  return wrap;
}

function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', {}, label));
}

/* ------------------------------------------------------------------ */
export function openToolPopover(app, anchor, tool) {
  const s = app.settings;
  let body;

  if (tool === 'pen') {
    const effects = h('div', { class: 'row' },
      ...PEN_EFFECTS.map((e) => {
        const b = h('button', { class: 'btn' + (s.penEffect === e.id ? ' primary' : '') }, e.label);
        b.style.padding = '4px 10px';
        b.style.fontSize = '12.5px';
        b.addEventListener('click', () => {
          markActive(effects, b, 'primary');
          s.penEffect = e.id;
          app.saveSettings();
          app.syncUI();
        });
        return b;
      })
    );
    body = h('div', {},
      h('h4', {}, 'Ink colour'),
      swatchRow(PEN_COLORS, s.penEffect === 'none' ? s.penColor : null, (c) => {
        s.penColor = c; s.penEffect = 'none'; app.saveSettings(); app.syncUI(); closePopover();
      }),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('label', {}, 'Effect')),
      effects,
      h('h4', { style: 'margin-top:6px' }, 'Thickness'),
      sizeRow([2, 4, 7, 12, 20], s.penWidth, (v) => { s.penWidth = v; app.saveSettings(); app.syncUI(); }, s.penColor),
      h('div', { class: 'row', style: 'margin-top:12px' },
        toggle('Straighten shapes I draw', s.inkToShape, (v) => {
          s.inkToShape = v;
          app.saveSettings();
          app.toast(v ? 'Hand-drawn shapes will be straightened' : 'Ink is left exactly as drawn', 'pen');
        })),
      h('div', { class: 'row' },
        toggle('Ruler snapping', app.ruler.snap, (v) => { app.ruler.snap = v; }))
    );
  } else if (tool === 'highlighter') {
    body = h('div', {},
      h('h4', {}, 'Highlighter'),
      swatchRow(HIGHLIGHTER_COLORS, s.highlighterColor, (c) => { s.highlighterColor = c; app.saveSettings(); app.syncUI(); closePopover(); }),
      h('h4', { style: 'margin-top:12px' }, 'Thickness'),
      sizeRow([12, 20, 30, 44], s.highlighterWidth, (v) => { s.highlighterWidth = v; app.saveSettings(); app.syncUI(); }, s.highlighterColor)
    );
  } else if (tool === 'eraser') {
    const mkMode = (id, label, hint) => {
      const b = h('button', { class: 'menu-item' + (s.eraserMode === id ? ' active-mode' : '') },
        h('span', { style: 'display:flex;flex-direction:column;gap:2px;text-align:left' },
          h('span', {}, label),
          h('small', { style: 'color:var(--text-2);font-size:11.5px' }, hint)),
        s.eraserMode === id ? h('span', { class: 'k', html: '&#10003;' }) : null);
      b.style.alignItems = 'flex-start';
      b.addEventListener('click', () => {
        if (id === 'all') { app.command('edit.clear'); closePopover(); return; }
        s.eraserMode = id; app.saveSettings(); openToolPopover(app, anchor, 'eraser');
      }, { once: false });
      return b;
    };
    body = h('div', { style: 'min-width:270px' },
      h('h4', {}, 'Eraser size'),
      sizeRow([10, 16, 30, 60], s.eraserSize, (v) => { s.eraserSize = v; app.saveSettings(); app.syncUI(); }),
      h('h4', { style: 'margin-top:14px' }, 'Mode'),
      h('div', { class: 'menu', style: 'padding:0' },
        mkMode('partial', 'Erase parts of ink', 'Rubs strokes out where you drag'),
        mkMode('object', 'Erase whole strokes', 'Removes a whole stroke in one touch'),
        mkMode('all', 'Erase everything', 'Clears the canvas'))
    );
  } else if (tool === 'note') {
    body = h('div', {},
      h('h4', {}, 'Note colour'),
      swatchRow(NOTE_COLORS, s.noteColor, (c) => { s.noteColor = c; app.saveSettings(); app.syncUI(); app.applyToSelection({ color: c }, 'note'); closePopover(); }),
      h('h4', { style: 'margin-top:12px' }, 'Size'),
      h('div', { class: 'row' }, ...[['Small', 140], ['Medium', 200], ['Large', 280]].map(([l, v]) => {
        const b = h('button', { class: 'btn' + (s.noteSize === v ? ' primary' : '') }, l);
        b.style.fontSize = '12.5px';
        b.addEventListener('click', () => { markActive(b.parentNode, b, 'primary'); s.noteSize = v; app.saveSettings(); });
        return b;
      })),
      h('h4', { style: 'margin-top:12px' }, 'Font'),
      fontRow(FONTS, s.noteFont, (id) => {
        s.noteFont = id; app.saveSettings(); app.applyToSelection({ font: id }, 'note');
      })
    );
  } else if (tool === 'text') {
    body = h('div', {},
      h('h4', {}, 'Text colour'),
      swatchRow(TEXT_COLORS, s.textColor, (c) => { s.textColor = c; app.saveSettings(); app.syncUI(); app.applyToSelection({ color: c }, 'text'); closePopover(); }),
      h('h4', { style: 'margin-top:12px' }, 'Size'),
      sizeRow([16, 24, 32, 48, 72], s.textSize, (v) => { s.textSize = v; app.saveSettings(); app.applyToSelection({ fontSize: v }, 'text'); }),
      h('h4', { style: 'margin-top:12px' }, 'Font'),
      fontRow(FONTS, s.textFont, (id) => {
        s.textFont = id; app.saveSettings(); app.applyToSelection({ font: id }, 'text');
      })
    );
  } else if (tool === 'shape') {
    const grid = h('div', { class: 'shape-grid' });
    for (const k of SHAPES) {
      const b = h('button', { class: 'shape-btn' + (s.shapeKind === k ? ' active' : ''), title: SHAPE_LABELS[k] });
      b.innerHTML = shapeIcon(k, 22);
      b.addEventListener('click', () => { markActive(grid, b); s.shapeKind = k; app.saveSettings(); app.setTool('shape'); app.syncUI(); });
      grid.appendChild(b);
    }
    const fills = h('div', { class: 'swatches' });
    for (const c of SHAPE_FILLS) {
      const b = h('button', { class: 'sw' + (c === s.shapeFill ? ' active' : ''), title: c === 'none' ? 'No fill' : c });
      b.style.background = c === 'none' ? 'repeating-linear-gradient(45deg,#fff,#fff 4px,#ddd 4px,#ddd 8px)' : c;
      b.addEventListener('click', () => { markActive(fills, b); s.shapeFill = c; app.saveSettings(); app.applyToSelection({ fill: c }, 'shape'); });
      fills.appendChild(b);
    }
    body = h('div', {},
      h('h4', {}, 'Shape'), grid,
      h('h4', { style: 'margin-top:12px' }, 'Outline'),
      swatchRow(SHAPE_STROKES, s.shapeStroke, (c) => { s.shapeStroke = c; app.saveSettings(); app.applyToSelection({ stroke: c }, 'shape'); }),
      h('h4', { style: 'margin-top:12px' }, 'Fill'), fills,
      h('h4', { style: 'margin-top:12px' }, 'Line width'),
      sizeRow([1, 2, 3, 5, 8], s.shapeLineWidth, (v) => { s.shapeLineWidth = v; app.saveSettings(); app.applyToSelection({ lineWidth: v }, 'shape'); }, s.shapeStroke)
    );
  }

  openPopover(anchor, body, { key: 'tool:' + tool });
}

/* ------------------------------------------------------------------ */
function menuItem(label, iconName, onClick, opts = {}) {
  const b = h('button', { class: 'menu-item' + (opts.danger ? ' danger' : '') },
    h('span', { html: icon(iconName, 17), style: 'display:flex' }),
    h('span', {}, label),
    opts.key ? h('span', { class: 'k' }, opts.key) : null
  );
  if (opts.disabled) b.setAttribute('disabled', '');
  b.addEventListener('click', () => { closePopover(); onClick(); });
  return b;
}

export function openInsertPopover(app, anchor) {
  const body = h('div', { class: 'menu' },
    menuItem('Image…', 'image', () => app.command('insert.image')),
    menuItem('Document (Word, PowerPoint, PDF)…', 'doc', () => app.command('insert.document')),
    menuItem('Table', 'table', () => app.command('insert.table')),
    h('div', { class: 'menu-sep' }),
    menuItem('Paste from clipboard', 'copy', () => app.command('edit.paste'), { key: 'Ctrl+V' }),
    menuItem('Templates…', 'template', () => app.panels.templates())
  );
  openPopover(anchor, body, { key: 'insert' });
}

export function openMorePopover(app, anchor) {
  const body = h('div', { class: 'menu' },
    menuItem('Templates…', 'template', () => app.panels.templates()),
    menuItem('Format background…', 'palette', () => app.panels.background()),
    menuItem(app.ruler.visible ? 'Hide ruler' : 'Show ruler', 'ruler', () => app.command('ruler'), { key: 'Ctrl+R' }),
    h('div', { class: 'menu-sep' }),
    menuItem('Select all', 'select', () => app.command('edit.selectAll'), { key: 'Ctrl+A' }),
    menuItem('Export as PNG…', 'export', () => app.command('export.png')),
    menuItem('Export as PDF…', 'doc', () => app.command('export.pdf')),
    menuItem('Save a copy…', 'doc', () => app.command('board.save'), { key: 'Ctrl+S' }),
    menuItem('Open board…', 'board', () => app.command('board.open'), { key: 'Ctrl+O' }),
    h('div', { class: 'menu-sep' }),
    menuItem('Share on this network…', 'share', () => app.panels.sharing()),
    menuItem('Settings', 'settings', () => app.panels.settings()),
    menuItem('Keyboard shortcuts', 'help', () => app.showShortcuts()),
    menuItem('Check for updates…', 'update', () => app.checkForUpdates({ force: true })),
    menuItem('About GazBoard', 'board', () => app.showAbout()),
    menuItem('Clear canvas', 'trash', () => app.command('edit.clear'), { danger: true })
  );
  openPopover(anchor, body, { key: 'more' });
}

export function openExportPopover(app, anchor) {
  const body = h('div', { class: 'menu' },
    menuItem('Export board as PNG…', 'image', () => app.command('export.png')),
    menuItem('Export selection as PNG…', 'image', () => app.command('export.pngSelection'), { disabled: !app.surface.selection.size }),
    menuItem('Export as PDF…', 'doc', () => app.command('export.pdf')),
    menuItem('Export as SVG…', 'export', () => app.command('export.svg')),
    menuItem('Fit everything onto the paper', 'shapes', () => app.command('page.fitContent'), { disabled: !app.store.pageCount }),
    h('div', { class: 'menu-sep' }),
    menuItem('Save a copy (.gazboard)…', 'doc', () => app.command('board.save'), { key: 'Ctrl+S' }),
    menuItem('Open a board file…', 'board', () => app.command('board.open'), { key: 'Ctrl+O' })
  );
  openPopover(anchor, body, { key: 'export', placement: 'bottom', align: 'end' });
}

/** Refresh active states, the raised pen, and the little colour dots. */
export function syncToolbar(app) {
  const bar = document.getElementById('toolbar');
  const s = app.settings;

  syncPagebar(app);
  bar.classList.toggle('hide-keys', s.showToolKeys === false);

  for (const b of bar.querySelectorAll('.pen[data-pen]')) {
    const pen = PENS.find((p) => p.id === b.dataset.pen);
    b.classList.toggle('active',
      app.tool === 'pen' && s.penColor === pen.color && s.penEffect === pen.effect);
  }
  const hl = bar.querySelector('.pen[data-tool="highlighter"]');
  if (hl) {
    hl.classList.toggle('active', app.tool === 'highlighter');
    // the badge is part of the button, so it has to be re-added when the
    // highlighter is repainted or recolouring silently drops the "H"
    const want = penIcon(s.highlighterColor, 'none', 'highlighter') + '<span class="kbd">H</span>';
    if (hl.dataset.paint !== s.highlighterColor) { hl.innerHTML = want; hl.dataset.paint = s.highlighterColor; }
  }
  const er = bar.querySelector('.pen[data-tool="eraser"]');
  if (er) er.classList.toggle('active', app.tool === 'eraser');

  /*
   * The finger button says which way round things are RIGHT NOW, and appears
   * only once there is a pen to be the other option. Its icon is the thing the
   * finger will do if you press it - a hand when the finger draws, a pen when
   * the finger is moving the board - which is the way a toggle reads when you
   * are looking at it rather than remembering it.
   */
  const fb = bar.querySelector('.tool[data-cmd="fingerInk"]');
  if (fb) {
    const offer = app.penSeenThisSession || s.inkWithFinger === 'no';
    fb.style.display = offer ? '' : 'none';
    const drawing = app.fingerInks;
    // Only repaint when it actually flips: syncUI runs on every tool change,
    // and rewriting a button's contents that often is work for nothing.
    const want = drawing ? 'hand' : 'pen';
    if (fb.dataset.face !== want) { fb.innerHTML = icon(want, 18); fb.dataset.face = want; }
    fb.classList.toggle('active', !drawing);
    fb.title = drawing
      ? 'Your finger draws — tap to move the board with it instead'
      : 'Your finger moves the board — tap to draw with it instead';
  }

  for (const btn of bar.querySelectorAll('.tool')) {
    const t = btn.dataset.tool, c = btn.dataset.cmd;
    if (t) btn.classList.toggle('active', app.tool === t);
    if (c === 'ruler') btn.classList.toggle('active', app.ruler.visible);
    if (c === 'undo') btn.toggleAttribute('disabled', !app.store.canUndo);
    if (c === 'redo') btn.toggleAttribute('disabled', !app.store.canRedo);
    const dot = btn.querySelector('.dot');
    if (dot) dot.style.background = t === 'note' ? s.noteColor : t === 'text' ? s.textColor : s.shapeStroke;
  }
}
