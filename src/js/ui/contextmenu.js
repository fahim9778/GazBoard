// Right-click menu and the floating selection toolbar.

import { h, openPopover, closePopover } from './popover.js';
import { icon } from './icons.js';
import { PEN_COLORS, NOTE_COLORS, TEXT_COLORS, SHAPE_STROKES, SHAPE_FILLS } from './palettes.js';

function item(label, iconName, onClick, opts = {}) {
  const b = h('button', { class: 'menu-item' + (opts.danger ? ' danger' : '') },
    h('span', { html: icon(iconName, 17), style: 'display:flex' }),
    h('span', {}, label),
    opts.key ? h('span', { class: 'k' }, opts.key) : null);
  if (opts.disabled) b.setAttribute('disabled', '');
  b.addEventListener('click', () => { closePopover(); onClick(); });
  return b;
}

export function showContextMenu(app, e) {
  const sel = app.surface.selection;
  const wp = app.surface.toWorld(e);

  // right-clicking an unselected object selects it first
  const hit = app.pickAt(wp);
  if (hit && !sel.has(hit.id)) app.setSelection([hit.id]);

  const has = app.surface.selection.size > 0;
  const one = app.surface.selection.size === 1 ? app.store.get([...app.surface.selection][0]) : null;
  const editable = one && ['note', 'text', 'shape', 'table'].includes(one.type);

  const menu = h('div', { class: 'menu' });
  const allLocked = has && app.selected.every((o) => o.locked);

  if (allLocked) {
    menu.appendChild(item('Unlock', 'unlock', () => app.command('edit.lock')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item('Copy', 'copy', () => app.command('edit.copy'), { key: 'Ctrl+C' }));
    menu.appendChild(item('Export selection as PNG…', 'image', () => app.command('export.pngSelection')));
    openPopover({ x: e.clientX, y: e.clientY }, menu, { key: 'ctx' });
    return;
  }

  if (has) {
    if (editable) menu.appendChild(item('Edit text', 'text', () => app.beginTextEdit(one), { key: 'F2' }));
    menu.appendChild(item('Cut', 'copy', () => app.command('edit.cut'), { key: 'Ctrl+X' }));
    menu.appendChild(item('Copy', 'copy', () => app.command('edit.copy'), { key: 'Ctrl+C' }));
    menu.appendChild(item('Duplicate', 'duplicate', () => app.command('edit.duplicate'), { key: 'Ctrl+D' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item('Bring to front', 'front', () => app.command('order.front'), { key: 'Ctrl+Shift+]' }));
    menu.appendChild(item('Send to back', 'front', () => app.command('order.back'), { key: 'Ctrl+Shift+[' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    const locked = [...app.surface.selection].every((id) => app.store.get(id)?.locked);
    menu.appendChild(item(locked ? 'Unlock' : 'Lock', locked ? 'unlock' : 'lock', () => app.command('edit.lock')));
    menu.appendChild(item('Export selection as PNG…', 'image', () => app.command('export.pngSelection')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item('Delete', 'trash', () => app.command('edit.delete'), { key: 'Del', danger: true }));
  } else {
    menu.appendChild(item('Paste', 'copy', () => app.command('edit.paste'), { key: 'Ctrl+V' }));
    menu.appendChild(item('Select all', 'select', () => app.command('edit.selectAll'), { key: 'Ctrl+A' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item('Sticky note here', 'note', () => app.addNoteAt(wp)));
    menu.appendChild(item('Text here', 'text', () => app.addTextAt(wp)));
    menu.appendChild(item('Insert image…', 'image', () => app.command('insert.image')));
    menu.appendChild(item('Insert document…', 'doc', () => app.command('insert.document')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item('Templates…', 'template', () => app.panels.templates()));
    menu.appendChild(item('Format background…', 'palette', () => app.panels.background()));
    menu.appendChild(item('Clear canvas', 'trash', () => app.command('edit.clear'), { danger: true }));
  }
  openPopover({ x: e.clientX, y: e.clientY }, menu, { key: 'ctx' });
}

/* ------------------------------------------------------------------ *
 *  Floating toolbar above the current selection
 * ------------------------------------------------------------------ */
export function updateSelectionBar(app) {
  const bar = document.getElementById('ctxbar');
  const sel = [...app.surface.selection].map((id) => app.store.get(id)).filter(Boolean);
  if (!sel.length || app.textEditor.active) { bar.classList.remove('show'); return; }

  const box = app.surface.selectionScreenBox(10);
  if (!box) { bar.classList.remove('show'); return; }

  bar.innerHTML = '';
  const types = new Set(sel.map((o) => o.type));
  const allLocked = sel.every((o) => o.locked);

  if (allLocked) {
    const label = h('span', { style: 'display:flex;align-items:center;gap:6px;padding:0 8px;font-size:12.5px;color:var(--text-2)' },
      h('span', { html: icon('lock', 15), style: 'display:flex' }),
      h('span', {}, sel.length > 1 ? `${sel.length} locked` : 'Locked'));
    bar.appendChild(label);
    const unlock = h('button', { title: 'Unlock', html: icon('unlock', 17) });
    unlock.addEventListener('click', () => app.command('edit.lock'));
    unlock.style.cssText += 'width:auto;padding:0 10px;gap:6px;color:var(--accent-2)';
    unlock.insertAdjacentHTML('beforeend', '<span style="font-size:12.5px">Unlock</span>');
    unlock.style.display = 'flex';
    unlock.style.alignItems = 'center';
    bar.appendChild(unlock);
    placeBar(bar, box);
    return;
  }

  const mk = (title, iconName, fn) => {
    const b = h('button', { title, html: icon(iconName, 17) });
    b.addEventListener('click', fn);
    return b;
  };

  // colour control, only for the things that actually have a colour
  const COLOURABLE = new Set(['stroke', 'shape', 'note', 'text', 'table']);
  if (types.size === 1 && COLOURABLE.has([...types][0])) {
    const type = [...types][0];
    const swatch = h('button', { class: 'colour-btn', title: 'Colour' });
    const dot = h('span', {});
    const currentColor = type === 'shape' ? sel[0].stroke : sel[0].color;
    dot.style.cssText = `width:17px;height:17px;border-radius:50%;background:${currentColor || '#201f1e'};box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)`;
    swatch.appendChild(dot);
    swatch.addEventListener('click', () => openColorPopover(app, swatch, type, sel));
    bar.appendChild(swatch);
  }

  if ([...types].every((t) => ['note', 'text', 'shape', 'table'].includes(t)) && sel.length === 1)
    bar.appendChild(mk('Edit text (F2)', 'text', () => app.beginTextEdit(sel[0])));

  // a table gets its own row and column controls
  if (sel.length === 1 && sel[0].type === 'table') {
    const t = sel[0];
    bar.appendChild(h('span', { class: 'bar-sep' }));
    bar.appendChild(mk('Add row', 'rowAdd', () => app.command('table.addRow')));
    const lessRow = mk('Remove row', 'rowDel', () => app.command('table.removeRow'));
    if ((t.rows | 0) <= 1) lessRow.disabled = true;
    bar.appendChild(lessRow);
    bar.appendChild(mk('Add column', 'colAdd', () => app.command('table.addCol')));
    const lessCol = mk('Remove column', 'colDel', () => app.command('table.removeCol'));
    if ((t.cols | 0) <= 1) lessCol.disabled = true;
    bar.appendChild(lessCol);
    bar.appendChild(h('span', { class: 'bar-sep' }));
  }

  bar.appendChild(mk('Duplicate (Ctrl+D)', 'duplicate', () => app.command('edit.duplicate')));
  bar.appendChild(mk('Bring to front', 'front', () => app.command('order.front')));
  bar.appendChild(mk(sel.every((o) => o.locked) ? 'Unlock' : 'Lock', sel.every((o) => o.locked) ? 'unlock' : 'lock', () => app.command('edit.lock')));
  bar.appendChild(mk('Delete (Del)', 'trash', () => app.command('edit.delete')));

  placeBar(bar, box);
}

function placeBar(bar, box) {
  bar.classList.add('show');
  const stage = document.getElementById('stage').getBoundingClientRect();
  const w = bar.offsetWidth || 200;
  let left = box.x + box.w / 2 - w / 2;
  left = Math.max(8, Math.min(left, stage.width - w - 8));
  let top = box.y - bar.offsetHeight - 44;
  if (top < 8) top = Math.min(box.y + box.h + 12, stage.height - bar.offsetHeight - 80);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function openColorPopover(app, anchor, type, sel) {
  const colors = type === 'note' ? NOTE_COLORS : type === 'text' ? TEXT_COLORS : type === 'shape' ? SHAPE_STROKES : PEN_COLORS;
  const grid = h('div', { class: 'swatches' });
  for (const c of colors) {
    const b = h('button', { class: 'sw', title: c });
    b.style.background = c;
    b.addEventListener('click', () => {
      const key = type === 'shape' ? 'stroke' : 'color';
      app.store.updateMany(sel.map((o) => o.id), { [key]: c }, 'recolour');
      app.rememberColor(type, key, c);     // the next new object keeps this colour
      closePopover();
      app.surface.invalidate();
      updateSelectionBar(app);
    });
    grid.appendChild(b);
  }
  const body = h('div', {}, h('h4', {}, type === 'shape' ? 'Outline' : 'Colour'), grid);

  if (type === 'shape') {
    const fills = h('div', { class: 'swatches' });
    for (const c of SHAPE_FILLS) {
      const b = h('button', { class: 'sw', title: c === 'none' ? 'No fill' : c });
      b.style.background = c === 'none' ? 'repeating-linear-gradient(45deg,#fff,#fff 4px,#ddd 4px,#ddd 8px)' : c;
      b.addEventListener('click', () => {
        app.store.updateMany(sel.map((o) => o.id), { fill: c }, 'fill');
        app.rememberColor('shape', 'fill', c);
        closePopover(); app.surface.invalidate();
      });
      fills.appendChild(b);
    }
    body.appendChild(h('h4', { style: 'margin-top:12px' }, 'Fill'));
    body.appendChild(fills);
  }
  openPopover(anchor, body, { key: 'selcolor' });
}
