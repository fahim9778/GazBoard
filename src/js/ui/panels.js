// Right-hand slide-in panel: templates, background, settings, boards.

import { h } from './popover.js';
import { icon } from './icons.js';
import { TEMPLATES, templateThumb } from '../templates.js';
import { PAPER, paperForPage } from './pdfdialog.js';
import { BOARD_COLORS, PATTERNS } from './palettes.js';

export function createPanels(app) {
  const panel = document.getElementById('panel');
  const title = document.getElementById('panelTitle');
  const body = document.getElementById('panelBody');
  let currentKey = null;
  let currentRender = null;

  document.getElementById('panelClose').addEventListener('click', close);

  function close() { panel.classList.remove('open'); currentKey = null; currentRender = null; }

  function open(key, label, render) {
    if (currentKey === key) { close(); return; }
    currentKey = key;
    currentRender = render;
    title.textContent = label;
    body.innerHTML = '';
    body.appendChild(render());
    panel.classList.add('open');
  }

  /** Redraw the open panel in place - used when a control changes its own state. */
  function rerender() {
    if (!currentRender) return;
    body.innerHTML = '';
    body.appendChild(currentRender());
  }

  /* ---------------- templates ---------------- */
  const thumbCache = new Map();
  function templates() {
    open('templates', 'Templates', () => {
      const groups = new Map();
      for (const t of TEMPLATES) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group).push(t);
      }
      const wrap = h('div', {});
      wrap.appendChild(h('p', { style: 'margin:0 0 14px;color:var(--text-2);font-size:13px' },
        'Templates are added to the board — your existing content is kept. Canvas sizes only change the shape of the page.'));
      for (const [group, list] of groups) {
        const sec = h('div', { class: 'section' }, h('h5', {}, group));
        const grid = h('div', { class: 'tpl-grid' });
        for (const t of list) {
          if (!thumbCache.has(t.id)) thumbCache.set(t.id, templateThumb(t));
          const btn = h('button', { class: 'tpl', title: t.name });
          const img = h('img', { class: 'thumb', src: thumbCache.get(t.id), alt: '' });
          btn.appendChild(img);
          btn.appendChild(h('span', { class: 'name' }, t.name));
          btn.addEventListener('click', () => { app.applyTemplate(t); close(); });
          grid.appendChild(btn);
        }
        sec.appendChild(grid);
        wrap.appendChild(sec);
      }
      return wrap;
    });
  }

  /* ---------------- background ---------------- */
  function background() {
    open('background', 'Format background', () => {
      const bg = app.store.doc.background;
      const colors = h('div', { class: 'bg-grid' });
      for (const c of BOARD_COLORS) {
        const b = h('button', { class: 'bg-sw' + (bg.color === c ? ' active' : ''), title: c });
        b.style.background = c;
        b.addEventListener('click', () => { app.store.setBackground({ color: c, patternColor: c === '#2b2b2b' ? '#5a5a5a' : '#c8c6c4' }); rerender(); refresh(); });
        colors.appendChild(b);
      }

      const pats = h('div', { class: 'pat-grid' });
      for (const p of PATTERNS) {
        const b = h('button', { class: 'pat' + (bg.pattern === p.id ? ' active' : ''), title: p.label });
        b.appendChild(h('span', {}, p.label));
        b.style.backgroundImage = patternPreview(p.id, bg.patternColor);
        b.style.backgroundColor = bg.color;
        b.addEventListener('click', () => { app.store.setBackground({ pattern: p.id }); rerender(); refresh(); });
        pats.appendChild(b);
      }

      const custom = h('input', { type: 'color', value: bg.color });
      custom.addEventListener('input', () => app.store.setBackground({ color: custom.value }));

      // Canvas size. Infinite is the default and always will be. Choosing a
      // paper size turns the board into a pad: ink is clipped to the sheet and
      // pages can be added, the way a notebook works.
      const page = app.store.page;
      const current = page ? paperForPage(page) : null;
      const orientation = current ? current.orientation : (app.settings.pageOrientation || 'portrait');

      const sizeRow = h('div', { class: 'bg-sizes' });
      const sizeBtn = (id, label, active) => {
        const b = h('button', { class: 'btn' + (active ? ' primary' : '') }, label);
        b.addEventListener('click', async () => { await app.setPageSize(id, orientation); refresh(); });
        return b;
      };
      sizeRow.appendChild(sizeBtn('infinite', 'Infinite', !page));
      for (const p of PAPER) {
        if (!p.w || !p.h) continue;             // "fit board" is an export choice only
        sizeRow.appendChild(sizeBtn(p.id, p.label, !!current && current.paper === p.id));
      }

      const orientRow = h('div', { class: 'bg-sizes' });
      for (const o of [{ id: 'portrait', label: 'Portrait' }, { id: 'landscape', label: 'Landscape' }]) {
        const b = h('button', { class: 'btn' + (orientation === o.id ? ' primary' : ''), disabled: !page }, o.label);
        b.addEventListener('click', async () => {
          const paper = current ? current.paper : (app.settings.pagePaper || 'a4');
          await app.setPageSize(paper, o.id);
          refresh();
        });
        orientRow.appendChild(b);
      }

      // when there is a page and work hangs off it, offer the one-click fix
      const off = app.offPageObjects();
      const fitRow = h('div', { class: 'bg-sizes' });
      if (page && off.length) {
        const b = h('button', { class: 'btn primary', style: 'width:100%' },
          off.length === 1 ? 'Fit 1 item onto the page' : `Fit ${off.length} items onto the page`);
        b.addEventListener('click', () => { app.fitContentToPage(); refresh(); });
        fitRow.appendChild(b);
        fitRow.appendChild(h('p', { style: 'margin:2px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
          'Exports cover the sheet, so anything outside it is left out.'));
      }

      const sizeNote = h('p', { style: 'margin:8px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
        page
          ? 'Anything you draw outside the sheet stays where it is — it just sits off the page, and exports use the sheet.'
          : 'The canvas has no edges. Pick a size to work on a fixed sheet instead.');

      return h('div', {},
        h('div', { class: 'section' }, h('h5', {}, 'Canvas size'), sizeRow, orientRow, fitRow, sizeNote),
        h('div', { class: 'section' }, h('h5', {}, 'Colour'), colors),
        h('div', { class: 'section' }, h('h5', {}, 'Custom colour'), custom),
        h('div', { class: 'section' }, h('h5', {}, 'Pattern'), pats)
      );
    });
  }

  function patternPreview(id, color = '#c8c6c4') {
    const c = encodeURIComponent(color);
    switch (id) {
      case 'grid': return `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
      case 'lines': return `linear-gradient(${color} 1px, transparent 1px)`;
      case 'columns': return `linear-gradient(90deg, ${color} 1px, transparent 1px)`;
      case 'graph': return `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
      case 'dots': return `radial-gradient(${color} 1.2px, transparent 1.2px)`;
      default: return 'none';
    }
  }

  /* ---------------- settings ---------------- */
  function settings() {
    open('settings', 'Settings', () => {
      const s = app.settings;
      const row = (label, control, hint) => h('div', { style: 'margin-bottom:16px' },
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' },
          h('span', { style: 'font-size:13.5px' }, label), control),
        hint ? h('div', { style: 'font-size:12px;color:var(--text-2);margin-top:4px' }, hint) : null);

      const mkChoice = (options, get, set) => {
        const wrap = h('div', { style: 'display:flex;gap:4px' });
        for (const [value, label] of options) {
          const b = h('button', { class: 'btn' + (get() === value ? ' primary' : '') }, label);
          b.style.cssText += 'padding:4px 10px;font-size:12.5px';
          b.addEventListener('click', () => set(value));
          wrap.appendChild(b);
        }
        return wrap;
      };

      const mkToggle = (get, set) => {
        const i = h('input', { type: 'checkbox' });
        i.checked = get();
        i.addEventListener('change', () => { set(i.checked); app.saveSettings(); app.surface.invalidate(); });
        return h('label', { class: 'toggle' }, i);
      };

      const info = h('div', { style: 'font-size:12px;color:var(--text-2);line-height:1.6' });
      window.board.info().then((i) => {
        const platformLines = i.electron
          ? `Electron ${i.electron} · Chromium ${i.chrome}<br>` +
            `Office conversion: <b>${i.libreoffice ? 'LibreOffice detected' : 'built-in converter'}</b><br>` +
            `Boards folder: <code style="font-size:11px">${i.userData}</code>`
          : `Runtime: <b>Web / Progressive Web App</b> · ${i.pwa ? 'Standalone App' : 'Browser'}<br>` +
            `Boards storage: <code style="font-size:11px">${i.userData}</code>`;

        info.innerHTML = `<b style="color:var(--text)">GazBoard ${i.version}</b> · by <b style="color:var(--accent)">theBoringCodes</b><br>` +
          `MD. Fakhruddin Gazzali · <a href="mailto:fahim9778@gmail.com" target="_blank" style="color:var(--accent)">fahim9778@gmail.com</a><br>` +
          `Created with <span style="color:#e81123">&hearts;</span> with Claude Cowork<br>` +
          platformLines;
      });

      return h('div', {},
        h('div', { class: 'section' },
          h('h5', {}, 'Inking'),
          row('Straighten shapes I draw', mkToggle(() => s.inkToShape, (v) => (s.inkToShape = v)),
            'Off by default: ink is kept exactly as you drew it. Switch on and a hand-drawn circle, box or arrow snaps to a clean shape when you lift the pen — one undo returns your ink.'),
          row('Pressure sensitivity', mkToggle(() => s.pressure, (v) => (s.pressure = v)), 'Vary ink width with pen pressure.'),
          row('Draw with the mouse', mkChoice(
            [['auto', 'Auto'], ['yes', 'Always'], ['no', 'Never']],
            () => s.inkWithMouse,
            (v) => { s.inkWithMouse = v; app.saveSettings(); rerender(); }
          ), s.inkWithMouse === 'auto'
            ? (app.penSeenThisSession
              ? 'A stylus has been used since the app started, so the mouse pans the canvas instead of inking. It draws again next time you open GazBoard.'
              : 'The mouse draws until a stylus is used, then it pans instead — only for this session.')
            : s.inkWithMouse === 'yes'
              ? 'The mouse always inks, like a stylus. Pan with space and drag, the middle button, right-drag, or the pan tool. Choose this if you draw with a mouse and have no pen.'
              : 'Never (default): the pen inks and the mouse moves the canvas and drags objects — both at the same time, whichever tool is chosen.'),
          row('Pointer while inking', mkChoice(
            [['nib', 'Pen nib'], ['arrow', 'Arrow'], ['crosshair', 'Crosshair']],
            () => s.inkPointer || 'nib',
            (v) => { s.inkPointer = v; app.saveSettings(); app.interaction.inkPointer = null;
                     app.surface.invalidate(); rerender(); }
          ), (s.inkPointer || 'nib') === 'nib'
            ? 'A pen tip in the colour you are drawing with, painted onto the board itself so it stays put for the whole stroke — Windows hides the ordinary pointer while a stylus is touching the screen.'
            : (s.inkPointer === 'arrow'
              ? 'The ordinary mouse pointer, the way most whiteboards do it. On a tablet it will disappear while the pen is down; that is Windows, not GazBoard.'
              : 'A crosshair for placing a mark exactly. Same caveat as the arrow on a tablet.')),
          row('Ruler snapping', mkToggle(() => app.ruler.snap, (v) => (app.ruler.snap = v)))
        ),
        h('div', { class: 'section' },
          h('h5', {}, 'Canvas'),
          row('Mouse wheel zooms', mkToggle(() => s.wheelZoom, (v) => (s.wheelZoom = v)), 'Off: wheel and trackpad pan, Ctrl+wheel zooms.'),
          row('Auto-pan at the edges', mkToggle(() => s.edgePan, (v) => (s.edgePan = v)),
            'While drawing or dragging, running the pointer into the edge of the window scrolls the canvas. A mouse button held down during a pen stroke drags the canvas too.'),
          row('Return to select after drawing', mkToggle(() => s.returnToSelect, (v) => (s.returnToSelect = v))),
          row('Right-drag pans the canvas', mkToggle(() => s.rightDragPans !== false, (v) => (s.rightDragPans = v)),
            'Hold the right mouse button and drag to move around — useful on a laptop with no pen and no middle button. A right click that does not move still opens the usual menu.'),
          row('Check for updates', mkToggle(() => s.updateCheck === true, (v) => { s.updateCheck = v; app.saveSettings(); if (v) app.checkForUpdates({ force: true }); }),
            'Asks GitHub once a day whether a newer version exists, and tells you if so. Nothing is downloaded or installed automatically, and nothing about you or your boards is ever sent. Off means the app never touches the network.'),
          row('Shortcut letters on the toolbar', mkToggle(() => s.showToolKeys !== false, (v) => (s.showToolKeys = v)),
            'Shows the key for each tool in the corner of its button — V, P, H, E and so on — so you can switch without stopping to look them up.'),
          row('Low-latency inking', mkToggle(() => s.lowLatencyInk, (v) => { s.lowLatencyInk = v; app.toast('Takes effect next time GazBoard opens'); }),
            'Shaves a little lag off the pen by letting the canvas skip a buffering step. On some graphics drivers this makes the board flicker while you write or drag, especially with imported document pages on it — leave it off if you see that. Applies when the app is reopened.'),
          row('Autosave', mkToggle(() => s.autosave, (v) => (s.autosave = v)), 'Boards are stored locally on this computer.')
        ),
        h('div', { class: 'section' },
          h('h5', {}, 'Board'),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.new'); close(); } }, 'New board'),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.open'); close(); } }, 'Open a board file…'),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.save'); close(); } }, 'Save a copy…'),
          h('button', { class: 'btn danger', style: 'width:100%', onclick: () => app.command('edit.clear') }, 'Clear this canvas')
        ),
        h('div', { class: 'section' }, h('h5', {}, 'About'), info,
          h('p', { style: 'font-size:12px;color:var(--text-2);margin-top:10px;line-height:1.6' },
            'Everything stays on this device — there is no sign-in and no cloud sync. The document model is an operation log, so a sync layer can be added later without changing the editor.'))
      );
    });
  }

  /* ---------------- boards ---------------- */
  async function boards() {
    open('boards', 'My boards', () => h('div', { id: 'boardList' }, h('p', { style: 'color:var(--text-2)' }, 'Loading…')));
    const list = await window.board.boards.list();
    const host = document.getElementById('boardList');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(h('button', { class: 'btn primary', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.new'); close(); } }, '+ New board'));
    // Opening a .gazboard file had a keyboard shortcut and nothing to click,
    // which is no use to anyone who does not already know it is there.
    host.appendChild(h('button', { class: 'btn', style: 'width:100%;margin-bottom:14px', onclick: () => { app.command('board.open'); close(); } }, 'Open a board file…'));
    if (!list.length) host.appendChild(h('p', { style: 'color:var(--text-2);font-size:13px' }, 'No saved boards yet.'));

    // Every board this app has ever saved is a plain file in one folder. Showing
    // people where, and letting them open it, is worth more than any reassurance
    // in a settings screen.
    window.board.info().then((i) => {
      if (!document.getElementById('boardList')) return;
      if (i.electron) {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, `${list.length} board${list.length === 1 ? '' : 's'}, saved on this computer at:`),
          h('code', { style: 'font-size:11px;display:block;margin:4px 0 8px;word-break:break-all' }, i.userData + '/boards'),
          h('button', { class: 'btn', style: 'width:100%', onclick: () => window.board.showItem(i.userData + '/boards') }, 'Open that folder'));
        host.appendChild(foot);
      } else {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, `${list.length} board${list.length === 1 ? '' : 's'}, stored in browser persistence:`),
          h('code', { style: 'font-size:11px;display:block;margin:4px 0 8px;word-break:break-all' }, i.userData));
        host.appendChild(foot);
      }
    });
    for (const b of list) {
      const row = h('button', { class: 'board-row' },
        h('span', { html: icon('board', 20), style: 'color:var(--text-2);display:flex' }),
        h('span', { class: 'meta' },
          h('b', {}, b.name || 'Untitled board'),
          h('small', {}, `${b.objects} item${b.objects === 1 ? '' : 's'} · ${new Date(b.modified).toLocaleString()}`)),
        h('span', { class: 'icon-btn', title: 'Delete', html: icon('trash', 16), onclick: async (e) => { e.stopPropagation(); if (await app.confirm('Delete board?', `"${b.name}" will be permanently removed.`, 'Delete')) { await app.deleteBoard(b.id); boards(); } } })
      );
      row.addEventListener('click', async () => {
        const data = await window.board.boards.load(b.id);
        if (data) { await app.loadBoard(data); close(); }
      });
      host.appendChild(row);
    }
  }

  function refresh() { app.surface.invalidate(); }

  return { templates, background, settings, boards, close, get open() { return !!currentKey; } };
}
