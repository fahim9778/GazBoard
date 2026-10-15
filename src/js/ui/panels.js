// Right-hand slide-in panel: templates, background, settings, boards.

import { t, LANGUAGES, currentLanguage } from '../i18n.js';
import { packFor, isInstalled, isActive, installFromFile, remove as removeFontPack, sizeLabel } from '../fontpack.js';
import { h } from './popover.js';
import { icon } from './icons.js';
import { TEMPLATES, templateThumb } from '../templates.js';
import { PAPER, paperForPage } from './pdfdialog.js';
import { exportBoards } from '../board-export.js';
import { BOARD_COLORS, PATTERNS } from './palettes.js';
import { inkTrailSupported } from '../core/inktrail.js';
import { PATTERN_SPACINGS } from '../core/render.js';
import { todayStamp } from '../core/pages.js';
import * as F from '../core/folders.js';

/**
 * How a paired computer that is NOT currently visible should be shown.
 *
 * It gets its last known address on the row, because that is useful, and it
 * does NOT get a Send button, because it is not there. A blue "Send this board"
 * under a heading that says the machine is not showing up is a promise the app
 * cannot keep - and with GazBoard closed on the other end it can only ever end
 * in a failure the person did not need to be walked into.
 *
 * The address earns its keep another way: renderSync quietly knocks on it, and
 * a computer that answers moves up into the live list by itself, with an
 * ordinary Send button, within a few seconds. So a machine that really is
 * reachable but never announces itself still becomes usable - which is the
 * whole point - without anybody being offered a button to nowhere.
 */
export function awayRow(rec) {
  return {
    ...rec,
    paired: true,
    offline: true,
    address: rec.lastAddress || null,
    lastKnown: !!rec.lastAddress
  };
}

export function createPanels(app) {
  const panel = document.getElementById('panel');
  const title = document.getElementById('panelTitle');
  const body = document.getElementById('panelBody');
  let currentKey = null;
  let currentRender = null;

  document.getElementById('panelClose').addEventListener('click', close);

  function close() {
    panel.classList.remove('open');
    currentKey = null; currentRender = null;
    // The page fades rather than sliding away; it stops being a page once it has gone.
    // Becoming the side panel again happens with no animation at all: otherwise
    // the faded page turned back into a fully visible side panel and slid off
    // the screen - a flash of My boards just as the board came up, filling a
    // phone screen where the side panel is as wide as the screen.
    setTimeout(() => {
      if (currentKey === 'boards' || !panel.classList.contains('page')) return;
      panel.classList.add('snap');
      panel.classList.remove('page');
      void panel.offsetWidth;          // settle the closed place before animations come back
      panel.classList.remove('snap');
    }, 160);
  }

  function open(key, label, render) {
    if (currentKey === key) { close(); return; }
    currentKey = key;
    currentRender = render;
    title.textContent = label;
    body.innerHTML = '';
    body.appendChild(render());
    // My boards is a whole page, not a strip down the side (see boards()).
    panel.classList.toggle('page', key === 'boards' && app.settings.boardsPage !== false);
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
    open('templates', t('Templates'), () => {
      const groups = new Map();
      for (const t of TEMPLATES) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group).push(t);
      }
      const wrap = h('div', {});
      wrap.appendChild(h('p', { style: 'margin:0 0 14px;color:var(--text-2);font-size:13px' },
        t('Templates are added to the board — your existing content is kept. Canvas sizes only change the shape of the page.')));
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
    open('background', t('Canvas'), () => {
      const bg = app.store.doc.background;
      const colors = h('div', { class: 'bg-grid' });
      for (const c of BOARD_COLORS) {
        const b = h('button', { class: 'bg-sw' + (bg.color === c ? ' active' : ''), title: c });
        b.style.background = c;
        b.addEventListener('click', () => {
          const patch = { color: c, patternColor: c === '#2b2b2b' ? '#5a5a5a' : '#c8c6c4' };
          app.store.setBackground(patch);
          app.rememberCanvas(patch);
          rerender(); refresh();
        });
        colors.appendChild(b);
      }

      const pats = h('div', { class: 'pat-grid' });
      for (const p of PATTERNS) {
        const b = h('button', { class: 'pat' + (bg.pattern === p.id ? ' active' : ''), title: p.label });
        b.appendChild(h('span', {}, p.label));
        b.style.backgroundImage = patternPreview(p.id, bg.patternColor);
        b.style.backgroundSize = PREVIEW_SIZE[p.id] || '';
        b.style.backgroundColor = bg.color;
        b.dataset.pattern = p.id;
        b.addEventListener('click', () => {
          const before = { ...app.store.doc.background };
          const ops = [{ t: 'doc', before: { background: before }, after: { background: { ...before, pattern: p.id } } }];
          // Notebook paper dates each sheet. Sheets that were made before
          // pages had dates get today's - the day this pad became notebook
          // paper - in the same step, so one undo takes both back.
          if (p.id === 'notebook' && app.store.pages.some((q) => !q.date)) {
            const today = todayStamp();
            ops.push(app.store.pagesOp(app.store.pages.map((q) => (q.date ? { ...q } : { ...q, date: today }))));
          }
          app.store.commit('background', ops);
          app.rememberCanvas({ pattern: p.id });
          rerender(); refresh();
        });
        pats.appendChild(b);
      }

      // how far apart the pattern's lines are - the choice also becomes the spacing of every new board
      const spacingRow = h('div', { class: 'bg-sizes' });
      const spacingNow = PATTERN_SPACINGS.includes(bg.spacing) ? bg.spacing : 40;
      const SPACING_LABEL = { 19: t('Narrow'), 28: t('Small'), 40: t('Normal'), 56: t('Wide') };
      for (const v of PATTERN_SPACINGS) {
        const b = h('button', { class: 'btn' + (spacingNow === v ? ' primary' : ''), 'data-spacing': String(v) }, SPACING_LABEL[v]);
        b.addEventListener('click', () => {
          app.store.setBackground({ spacing: v });
          app.settings.patternSpacing = v;
          app.saveSettings();
          rerender(); refresh();
        });
        spacingRow.appendChild(b);
      }
      const mm = (v) => (Math.round(v / (96 / 25.4) * 2) / 2).toLocaleString();
      const spacingNote = h('p', { style: 'margin:6px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
        t('About {mm} mm apart when printed. New boards use this spacing too.', { mm: mm(spacingNow) }));
      // notebook paper on a pad carries the date each sheet was started; this hides or shows it
      let dateRow = null;
      if (bg.pattern === 'notebook' && app.store.pageCount) {
        const dateBox = h('input', { type: 'checkbox', 'data-page-date': '1' });
        dateBox.checked = bg.pageDate !== false;
        const setDate = (v) => {
          app.store.setBackground({ pageDate: v });
          app.settings.pageDate = v;
          app.saveSettings();
          rerender(); refresh();
        };
        dateBox.addEventListener('change', () => setDate(dateBox.checked));
        const dateWords = h('span', { style: 'cursor:pointer' }, t('Show the date'));
        dateWords.addEventListener('click', () => { dateBox.checked = !dateBox.checked; setDate(dateBox.checked); });
        dateRow = h('div', { style: 'margin-top:12px' },
          h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('label', { class: 'toggle' }, dateBox), dateWords),
          h('p', { style: 'margin:6px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
            t('Each page shows the day it was started, from this computer\'s calendar. It stays the same when you open the board later.')));
      }
      const spacingSection = (bg.pattern && bg.pattern !== 'none')
        ? h('div', { class: 'section' }, h('h5', {}, t('Spacing')), spacingRow, spacingNote, dateRow) : null;

      const custom = h('input', { type: 'color', value: bg.color });
      custom.addEventListener('input', () => app.store.setBackground({ color: custom.value }));
      // one write when the picker is let go, not one per drag of the slider
      custom.addEventListener('change', () => app.rememberCanvas({ color: custom.value }));

      // Canvas size. Infinite is the default and always will be. Choosing a
      // paper size turns the board into a pad: ink is clipped to the sheet and
      // pages can be added, the way a notebook works.
      const page = app.store.page;
      const current = page ? paperForPage(page) : null;
      const orientation = current ? current.orientation : (app.settings.pageOrientation || 'portrait');

      const sizeRow = h('div', { class: 'bg-sizes' });

      /*
       * Show the press before doing the work.
       *
       * setPageSize() is asynchronous - it reaches for the paper table with a
       * dynamic import, then relays out every sheet and commits. On a desktop
       * that is imperceptible. In a phone WebView, where the first import of a
       * module comes off the app's own asset server, it is a visible beat, and
       * for that beat the tap looks ignored: the page is changing, but the row
       * still shows the old size as the chosen one.
       *
       * So the row answers immediately and rerender() corrects the whole panel
       * when the work lands. The optimistic paint can never be wrong for long -
       * whatever actually happened is what gets drawn a moment later.
       */
      const showPressed = (row, pressed) => {
        for (const other of Array.from(row.children)) {
          if (other.classList && other.classList.contains('btn')) other.classList.toggle('primary', other === pressed);
        }
      };

      const sizeBtn = (id, label, active) => {
        const b = h('button', { class: 'btn' + (active ? ' primary' : '') }, label);
        // rerender(), not just refresh(): refresh() repaints the CANVAS, which
        // is why the page changed but this panel went on showing the old size
        // as the chosen one - and went on hiding the "fit it onto the page"
        // offer at the exact moment it became worth offering.
        b.addEventListener('click', async () => {
          showPressed(sizeRow, b);
          await app.setPageSize(id, orientation);
          rerender(); refresh();
        });
        return b;
      };
      sizeRow.appendChild(sizeBtn('infinite', t('Infinite'), !page));
      for (const p of PAPER) {
        if (!p.w || !p.h) continue;             // "fit board" is an export choice only
        sizeRow.appendChild(sizeBtn(p.id, p.label, !!current && current.paper === p.id));
      }

      const orientRow = h('div', { class: 'bg-sizes' });
      for (const o of [{ id: 'portrait', label: t('Portrait') }, { id: 'landscape', label: t('Landscape') }]) {
        const b = h('button', { class: 'btn' + (orientation === o.id ? ' primary' : ''), disabled: !page }, o.label);
        b.addEventListener('click', async () => {
          showPressed(orientRow, b);
          const paper = current ? current.paper : (app.settings.pagePaper || 'a4');
          await app.setPageSize(paper, o.id);
          rerender();
          refresh();
        });
        orientRow.appendChild(b);
      }

      // when there is a page and work hangs off it, offer the one-click fix
      const off = app.offPageObjects();
      const fitRow = h('div', { class: 'bg-sizes' });
      if (page && off.length) {
        const b = h('button', { class: 'btn primary', style: 'width:100%' },
          off.length === 1 ? t('Fit 1 item onto the page') : t('Fit {n} items onto the page', { n: off.length }));
        b.addEventListener('click', () => { app.bringOntoPages(off); rerender(); refresh(); });
        fitRow.appendChild(b);
        fitRow.appendChild(h('p', { style: 'margin:2px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
          t('Exports cover the sheet, so anything outside it is left out.')));
      }

      const sizeNote = h('p', { style: 'margin:8px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
        page
          ? t('Anything you draw outside the sheet stays where it is — it just sits off the page, and exports use the sheet.')
          : t('The canvas has no edges. Pick a size to work on a fixed sheet instead.'));

      const remembering = app.settings.rememberCanvas === true;
      const box = h('input', { type: 'checkbox' });
      box.checked = remembering;
      const setRemember = (v) => {
        app.settings.rememberCanvas = v;
        // Turning it ON adopts what is on screen right now, so the switch means
        // what it says immediately rather than from the next change onwards.
        if (v) {
          const bg = app.store.doc.background || {};
          const cur = app.store.page ? paperForPage(app.store.page) : null;
          app.settings.canvasDefaults = {
            color: bg.color, pattern: bg.pattern, patternColor: bg.patternColor,
            paper: cur ? cur.paper : 'infinite', orientation: cur ? cur.orientation : orientation
          };
        }
        app.saveSettings();
        rerender();
      };
      box.addEventListener('change', () => setRemember(box.checked));
      const words = h('span', { style: 'cursor:pointer' }, t('Use this canvas for new boards'));
      words.addEventListener('click', () => { box.checked = !box.checked; setRemember(box.checked); });

      const rememberRow = h('div', {},
        h('div', { style: 'display:flex;align-items:center;gap:10px' },
          h('label', { class: 'toggle' }, box), words),
        h('p', { style: 'margin:6px 0 0;font-size:12px;color:var(--text-2);line-height:1.6' },
          remembering
            ? t('The size, colour and pattern you choose here are used for every NEW board. Boards you already have are left exactly as they are.')
            : t('Every new board starts on the plain infinite canvas.'))
      );

      return h('div', {},
        h('div', { class: 'section' }, h('h5', {}, t('Canvas size')), sizeRow, orientRow, fitRow, sizeNote),
        h('div', { class: 'section' }, h('h5', {}, t('Colour')), colors),
        h('div', { class: 'section' }, h('h5', {}, t('Custom colour')), custom),
        h('div', { class: 'section' }, h('h5', {}, t('Pattern')), pats),
        spacingSection,
        h('div', { class: 'section' }, h('h5', {}, t('New boards')), rememberRow)
      );
    });
  }

  // the little tiles show a few repeats of the pattern rather than one line across the top
  const PREVIEW_SIZE = { grid: '11px 11px', lines: '100% 11px', columns: '11px 100%', graph: '11px 11px', dots: '10px 10px', notebook: '100% 100%, 100% 9px' };

  function patternPreview(id, color = '#c8c6c4') {
    const c = encodeURIComponent(color);
    switch (id) {
      case 'grid': return `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
      case 'lines': return `linear-gradient(${color} 1px, transparent 1px)`;
      case 'columns': return `linear-gradient(90deg, ${color} 1px, transparent 1px)`;
      case 'graph': return `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
      case 'dots': return `radial-gradient(${color} 1.2px, transparent 1.2px)`;
      case 'notebook': return 'linear-gradient(90deg, transparent 13px, #e0707f 13px, #e0707f 14px, transparent 14px), linear-gradient(#8db6e2 1px, transparent 1px)';
      default: return 'none';
    }
  }

  /* ---------------- sharing on the local network ----------------
   *
   * Everything here is dead unless window.board.sync exists (the desktop
   * build) AND the person has switched sharing on. With it off, this section
   * is a toggle and a paragraph explaining what the toggle does; nothing
   * below it runs and no socket is open.
   */
  let syncHost = null;                     // the live part of the section

  /*
   * The firewall answer, kept rather than asked for again.
   *
   * Checking spawns PowerShell, and this block redraws itself every time a
   * computer appears or disappears on the network. Asking Windows each time
   * would put a process launch behind every heartbeat, so it is asked once
   * when sharing comes up and after that only when somebody presses a button.
   */
  let fwInfo = null;
  let fwBusy = false;

  const dim = (t) => h('div', { style: 'font-size:12px;color:var(--text-2);line-height:1.6' }, t);

  const banner = (tone, ...kids) => h('div', {
    style: 'font-size:12px;line-height:1.6;margin-top:10px;padding:9px 11px;border-radius:6px;'
      + (tone === 'bad'
        ? 'background:rgba(232,17,35,.10);border:1px solid rgba(232,17,35,.35)'
        : tone === 'warn'
          ? 'background:rgba(255,185,0,.12);border:1px solid rgba(255,185,0,.40)'
          : 'background:rgba(16,124,16,.10);border:1px solid rgba(16,124,16,.30)')
  }, ...kids);

  const smallBtn = (label, onclick, primary) => {
    const b = h('button', { class: 'btn' + (primary ? ' primary' : ''), onclick },
      label);
    b.style.cssText += 'padding:4px 10px;font-size:12.5px;margin-top:8px;margin-right:6px';
    return b;
  };

  async function checkFirewall(host) {
    if (fwBusy) return;
    fwBusy = true;
    try { fwInfo = await window.board.sync.firewall.check(); }
    catch { fwInfo = { supported: false, state: 'unknown' }; }
    fwBusy = false;
    if (host && host.isConnected) renderSync(host);
  }

  /**
   * What Windows Firewall has been told, and an offer to change it.
   *
   * The failure this exists for is silent by design: the app is listening, the
   * port is open, and every packet from the next desk is dropped before it
   * arrives. Nothing in GazBoard can feel that from the inside - a connection
   * to your own machine never crosses the firewall - so this reads the rules
   * and says what they mean, which is the most honest thing available.
   */
  function firewallBlock(host, reachedByOthers) {
    const fw = fwInfo;
    if (!fw || fw.supported === false) return null;   // a platform with no firewall we know

    // Whose firewall, in the words the person's own machine uses. The advice is
    // the same everywhere; the noun is not, and calling firewalld "Windows
    // Firewall" would make the whole banner untrustworthy.
    /*
     * The name has to be the one on the person's own machine, and the fallback
     * has to be generic.
     *
     * This used to end `: 'Windows Firewall'`, so every tool it did not have a
     * case for - nftables, iptables, a machine with no firewall at all - was
     * announced to its owner as Windows Firewall. On Ubuntu that produced
     * "GazBoard could not read Windows Firewall on this computer. This machine
     * uses nftables directly", which contradicts itself inside two sentences
     * and tells the reader the whole panel was written by someone who never
     * ran it. Defaulting to the generic word is always merely vague; defaulting
     * to a product name is wrong.
     */
    const named = {
      'Windows Firewall': 'Windows Firewall',
      'macOS firewall': t('the macOS firewall'),
      firewalld: 'firewalld',
      ufw: 'ufw',
      nftables: 'nftables',
      iptables: 'iptables'
    }[fw.tool] || t('the firewall');
    // Only Windows can be repaired from in here, and the answer comes from the
    // main process rather than being inferred from which fields turned up.
    const canFix = fw.repairable === true;

    const showHelp = () => app.showFirewallHelp('failed', fw);

    if (fw.state === 'unknown') {
      /*
       * We could not read the rules. That is a normal state on a machine
       * somebody else administers - a lab or classroom PC - and it is worth
       * describing what it FEELS like rather than only what failed, because
       * the shape of it is confusing on its own: sending works, receiving does
       * not, and the other computer can see you while you cannot see it.
       *
       * Both halves have the same cause. Going out is allowed; coming in needs
       * a rule this account cannot write.
       */
      const locked = /administrator|policy|not one/i.test(fw.detail || '');
      return h('div', {},
        banner('warn',
          (fw.detail
            ? t('{detail}. So it cannot say whether other machines can reach you.', { detail: fw.detail.charAt(0).toUpperCase() + fw.detail.slice(1) })
            : t('GazBoard could not read {firewall} on this computer. So it cannot say whether other machines can reach you.', { firewall: named }))),
        locked ? banner('warn',
          h('b', {}, t('What that usually looks like.')),
          ' ' + t('This computer can send boards out and can be seen by others, while boards sent TO it never arrive and its own list stays empty. Going out is always allowed; coming in needs a rule only an administrator can add. Until somebody adds it, share the other way round - send from this computer instead of to it.')) : null,
        banner('warn',
          locked
            ? t('The two commands that open the way are below. They need an administrator, so pass them to whoever looks after this machine rather than trying them here.')
            : t('If nobody can reach you, the commands to open the way are here.'),
          smallBtn(t('Show the commands'), showHelp, true)),
        programLine(fw),
        h('div', {}, smallBtn(t('Check again'), () => checkFirewall(host))));
    }

    const fix = async () => {
      app.toast(t('Windows will ask for permission to change the firewall'), 'help', 5000);
      let r = null;
      try { r = await window.board.sync.firewall.repair(); }
      catch (e) { r = { ok: false, reason: 'failed', detail: e.message }; }
      fwInfo = (r && r.after) || fwInfo;
      if (r && r.ok) app.toast(t('Other computers can reach GazBoard now'));
      else if (r && r.reason === 'cancelled') app.showFirewallHelp('cancelled', fwInfo);
      else app.showFirewallHelp('failed', fwInfo);
      if (host.isConnected) renderSync(host);
    };

    // The action offered depends on whether this machine can be changed from
    // in here. Same banner, same wording up to the last sentence.
    const actions = (verb) => canFix
      ? [' ' + t('GazBoard can do that: Windows will ask you to confirm once.'),
        smallBtn(verb, fix, true),
        smallBtn(t('Show me the commands instead'), showHelp)]
      : [' ' + t('GazBoard will not change your firewall by itself here - it would need your password, and handing that to an app to run a command you have not seen is a bad habit to teach. The two lines that do it are one click away.'),
      smallBtn(t('Show me the commands'), showHelp, true)];

    const kids = [];

    if (fw.state === 'off') {
      kids.push(banner('good', fw.tool === 'none'
        ? t('No firewall is running on this computer, so nothing is standing between you and the other machines.')
        : t('{firewall} is switched off, so nothing is standing between you and the other machines.', { firewall: named.charAt(0).toUpperCase() + named.slice(1) })));
    } else if (fw.state === 'blocked') {
      kids.push(banner('bad',
        h('b', {}, t('{firewall} is blocking this.', { firewall: named.charAt(0).toUpperCase() + named.slice(1) })),
        fw.blockAll
          ? ' ' + t('It is set to refuse every incoming connection, whatever the app - so no board can reach this computer until that is changed in System Settings under Network, Firewall.')
          : ' ' + t('Somewhere along the way its "allow this app?" question was answered with no - or closed, which counts as no - and it wrote a rule that turns away every board sent to this computer. A block always wins over an allow, so it has to be removed rather than overruled.'),
        ...(fw.blockAll ? [] : actions(t('Fix it')))));
    } else if (fw.state === 'no-rule' && reachedByOthers) {
      /*
       * Rules say no; the network says yes. The network wins.
       *
       * Another computer's announcement has arrived here, which is proof that
       * inbound packets are getting through - whatever the rule listing does or
       * does not show. Shouting "nothing has been allowed" over the top of a
       * working device list is how a person ends up distrusting the whole
       * panel, so this states both facts and stops short of alarming anybody.
       */
      kids.push(banner('warn',
        h('b', {}, t('Other computers are already reaching this one.')),
        ' ' + t('GazBoard cannot find a {firewall} rule naming this program, but something is clearly letting them in - a rule opening the ports, or one your administrator set. Nothing needs doing unless a board actually fails to arrive.', { firewall: named }),
        smallBtn(t('Allow this program too'), canFix ? fix : showHelp)));
    } else if (fw.state === 'no-rule') {
      kids.push(banner('warn',
        h('b', {}, t('Nothing has been allowed through {firewall} yet.', { firewall: named })),
        ' ' + t('{firewall} turns away incoming connections unless a rule says otherwise, so other computers can probably see this one in their list and still fail to send it anything.', { firewall: named.charAt(0).toUpperCase() + named.slice(1) })
        + (canFix ? ' ' + t('If Windows has not asked you yet, it will the first time somebody tries. You can settle it now instead.') : ''),
        ...actions(t('Allow it now'))));
    } else if (fw.state === 'allowed') {
      const good = banner('good', fw.viaPorts
        ? (fw.portRules && fw.portRules.length
          ? t('{firewall} is letting other computers reach GazBoard through ports {boards} and {discovery} — “{rule}”. That is a rule about the ports rather than about this program, which works just as well.', { firewall: named.charAt(0).toUpperCase() + named.slice(1), boards: fw.ports.boards, discovery: fw.ports.discovery, rule: fw.portRules[0] })
          : t('{firewall} is letting other computers reach GazBoard through ports {boards} and {discovery}. That is a rule about the ports rather than about this program, which works just as well.', { firewall: named.charAt(0).toUpperCase() + named.slice(1), boards: fw.ports.boards, discovery: fw.ports.discovery }))
        : (canFix
          ? t('{firewall} is letting other computers reach GazBoard on your private and work networks.', { firewall: named.charAt(0).toUpperCase() + named.slice(1) })
          : t('{firewall} is letting other computers reach GazBoard.', { firewall: named.charAt(0).toUpperCase() + named.slice(1) })));
      if (canFix && fw.ours > 0 && !fw.viaPorts) {
        good.appendChild(h('div', {},
          smallBtn(t('Remove that permission'), async () => {
            if (!await app.confirm(t('Remove the firewall permission?'),
              t('Other computers will stop being able to send you boards until it is allowed again. Windows will ask you to confirm.'), t('Remove it'))) return;
            let r = null;
            try { r = await window.board.sync.firewall.remove(); }
            catch { r = { ok: false }; }
            fwInfo = (r && r.after) || null;
            app.toast(r && r.ok ? t('Firewall permission removed') : t('Nothing was changed'), r && r.ok ? 'check' : 'help');
            if (host.isConnected) renderSync(host);
          })));
      }
      kids.push(good);
    }

    // Worth saying whatever the rules say: the Windows rule is scoped to
    // private and work networks, so on a network Windows has filed as Public it
    // does nothing at all. Plenty of university wifi is filed that way.
    if (fw.publicOnly) {
      kids.push(banner('warn',
        h('b', {}, t('Windows has this network marked as Public.')),
        ' ' + t('GazBoard only ever asks to be reachable on private and work networks, never on a public one - a café or an airport is not somewhere to leave a door open. Nobody will be able to reach you here until this network is marked private, in Windows Settings under Network & internet.')));
    }

    kids.push(programLine(fw));
    kids.push(h('div', {}, smallBtn(t('Check again'), () => checkFirewall(host))));
    return h('div', {}, ...kids);
  }

  /*
   * Which program this is about, in small print.
   *
   * A firewall rule names one executable, and there are easily three of them in
   * play: the installed GazBoard.exe, the portable one, and the electron.exe
   * under node_modules that `npm start` runs. Permission given to one says
   * nothing about the others, and without this line a green banner on one and
   * an amber banner on another looks like a bug rather than the plain truth
   * about two different programs.
   */
  function programLine(fw) {
    if (!fw.program) return null;
    return h('div', {
      style: 'font-size:11px;color:var(--text-2);margin-top:8px;word-break:break-all;opacity:.85'
    }, t('This is about {program}', { program: fw.program }));
  }

  /** Called from the app when the device list or the service state changes. */
  function syncChanged() {
    if (syncHost && syncHost.isConnected) renderSync(syncHost);
  }

  async function renderSync(host) {
    const st = await app.refreshSyncStatus();
    if (!host.isConnected) return;                 // the panel closed meanwhile
    host.innerHTML = '';

    if (!st || !st.running) {
      /*
       * "Starting…" is only true while a start is actually in flight. A start
       * that failed leaves the main process reporting "not running, no error",
       * because from its point of view nothing was ever asked of it - so
       * without the reason the app kept from its own attempt, this box would
       * sit on "Starting…" for the rest of the session. That is how a build
       * shipped without its sync modules looked from the outside.
       */
      const why = (st && st.error) || app.syncStartError;
      if (why) {
        host.appendChild(banner('bad',
          h('b', {}, t('Sharing could not start.')), ' ' + why,
          smallBtn(t('Try again'), async () => { await app.startSync(); renderSync(host); }, true)));
      } else {
        host.appendChild(dim(t('Starting…')));
      }
      return;
    }

    // The name is what everyone else in the room sees in their list, so it is
    // worth being able to change - but through a dialog rather than a live
    // text box, because this block redraws itself whenever a device appears
    // or disappears and would eat what you were halfway through typing.
    host.appendChild(h('div', { style: 'display:flex;gap:8px;align-items:flex-start' },
      h('div', { style: 'flex:1;min-width:0' },
        dim(t('Others see this computer as “{name}”. Listening on port {port}.', { name: st.deviceName, port: st.port }))),
      h('button', {
        class: 'btn', style: 'padding:3px 9px;font-size:12px;flex:none',
        onclick: async () => {
          const name = await app.promptText(t('Name this computer'),
            t('This is the name other people pick from when they send you a board.'),
            { value: st.deviceName, confirmLabel: t('Rename') });
          if (!name) return;
          await window.board.sync.setName(name);
          renderSync(host);
        }
      }, t('Rename'))));

    /*
     * This computer's address, spelled out.
     *
     * "Add a computer by address" asks for the address the other computer
     * shows - and until now no computer showed one. Anyone who already knew
     * how to find it did not need the feature; anyone who needed the feature
     * was being sent to a command prompt to run ipconfig, which is not a thing
     * to ask of a teacher two minutes before a class.
     *
     * Read fresh on every redraw rather than kept, because moving from wifi to
     * a cable changes it and nothing tells the app that happened.
     */
    const addrs = st.addresses || [];
    if (addrs.length) {
      const many = addrs.length > 1;
      const box = h('div', {
        // Named so it can be told apart from the prose around it. What goes in
        // here is the MACHINE's words - addresses, and Windows' own name for
        // each adapter, which on one desk is literally "WiFi 2" - not ours.
        class: 'addr-box',
        style: 'margin-top:9px;padding:9px 11px;border-radius:6px;background:var(--surface-2);'
          + 'border:1px solid var(--stroke)'
      }, h('div', { style: 'font-size:12px;color:var(--text-2);line-height:1.6' },
        many
          ? t('This computer\u2019s addresses. If it never turns up in someone\u2019s list, they can add it by hand with one of these - whichever is the network you are both on.')
          : t('This computer\u2019s address. If it never turns up in someone\u2019s list, they can add it by hand with this.')));

      for (const a of addrs) {
        box.appendChild(h('div', { style: 'display:flex;align-items:center;gap:9px;margin-top:7px' },
          h('span', {
            style: 'font-family:ui-monospace,Consolas,monospace;font-size:14.5px;font-weight:600;'
              + 'letter-spacing:.3px'
          }, a.address),
          // The interface name is noise when there is only one address, and
          // the only way to tell them apart when there are two.
          many ? h('span', { style: 'font-size:11.5px;color:var(--text-2)' }, a.name) : null,
          // An address the adapter invented for itself because nothing
          // answered. It works down one cable and nowhere else, so it is
          // listed last and labelled rather than left to be picked by mistake.
          a.selfAssigned ? h('span', {
            style: 'font-size:11px;color:var(--text-2);opacity:.85',
            title: t('This computer gave itself this address because the network did not answer. It only works over a direct cable between two computers - try the other address first.')
          }, t('direct cable only')) : null,
          h('button', {
            class: 'btn',
            style: 'padding:2px 9px;font-size:11.5px;margin-left:auto;flex:none',
            onclick: async () => {
              // Copying is the whole point - the person reading this is the
              // one who did not know where to find it, and typing four numbers
              // off a screen onto another machine is how they get it wrong.
              try {
                await navigator.clipboard.writeText(a.address);
                app.toast(t('Address copied - {address}', { address: a.address }), 'check', 3000);
              } catch {
                app.toast(t('Could not copy. The address is {address}', { address: a.address }), 'help', 6000);
              }
            }
          }, t('Copy'))));
      }
      host.appendChild(box);
    }

    if (st.discovery === false) {
      /*
       * The announcement socket did not come up - something else has UDP
       * 53319. Worth its own line, because the symptom is specific and
       * otherwise unexplainable: the list below stays empty for ever while
       * sending and receiving work perfectly well by address.
       */
      host.appendChild(h('div', {
        style: 'font-size:12px;line-height:1.6;margin-top:6px;padding:8px 10px;border-radius:6px;'
          + 'background:rgba(255,185,0,.12);border:1px solid rgba(255,185,0,.4)'
      }, t('Something else is using port {port}, so this computer cannot announce itself and will not appear in anyone else\'s list - nor they in yours. Handing boards across still works: use "Add a computer by address" below, on both machines.', { port: st.discoveryPort || 53319 })));
    }
    if (st.unusualPort) {
      // Somebody else has the usual port - almost always a second copy of
      // GazBoard. Discovery still works; typing an address will not, and that
      // failure is otherwise completely silent.
      host.appendChild(h('div', {
        style: 'font-size:12px;line-height:1.6;margin-top:6px;padding:8px 10px;border-radius:6px;'
          + 'background:rgba(255,185,0,.12);border:1px solid rgba(255,185,0,.4)'
      }, t('Something else is using port {expected}, so this is on {port} instead - most likely another copy of GazBoard already running. Other computers can still find this one in their list, but adding it by address will not work until that copy is closed.', { expected: st.expectedPort, port: st.port })));
    }

    // Asked once, the first time this block is drawn with sharing running.
    // After that it is only re-asked by the button, because asking spawns a
    // process and this redraws on every heartbeat.
    if (window.board.sync.firewall) {
      if (fwInfo === null && !fwBusy) checkFirewall(host);
      // Whether anyone has actually got through is better evidence than any
      // rule listing, so the banner is told about it.
      const fw = firewallBlock(host, ((st.peers || []).length > 0));
      if (fw) host.appendChild(fw);
    }

    const seen = st.peers || [];
    const visible = new Set(seen.map((p) => p.deviceId));
    const away = (st.paired || []).filter((r) => !visible.has(r.deviceId));

    host.appendChild(h('h5', { style: 'margin:16px 0 8px' }, t('Computers on this network')));

    if (!seen.length) {
      host.appendChild(dim(t('Nothing found yet. The other computer needs GazBoard open with sharing switched on, on the same network. If it never appears, a firewall is blocking the announcement - you can still add it by its address below.')));
    }

    for (const p of seen) host.appendChild(deviceRow(p, host));

    if (away.length) {
      host.appendChild(h('h5', { style: 'margin:16px 0 8px' }, t('Paired, but not showing up right now')));
      for (const r of away) host.appendChild(deviceRow(awayRow(r), host));
      // ...and see whether any of them is actually there. One that answers
      // appears in the live list above on the next redraw.
      knockOnAway(away, host);
    }

    host.appendChild(h('button', {
      class: 'btn primary', style: 'width:100%;margin-top:14px',
      onclick: () => app.showPairingCode()
    }, t('Show my pairing code')));

    host.appendChild(h('button', {
      class: 'btn', style: 'width:100%;margin-top:8px',
      onclick: async () => {
        const addr = await app.promptText(t('Add a computer by address'),
          t('Type the address the other computer shows under its own name - four numbers with dots, like 192.168.0.243. Use this when it never turns up in the list by itself. If the only address it shows starts with 169.254, that one reaches it over a direct cable between the two computers and nowhere else.'),
          { placeholder: '192.168.0.243', confirmLabel: t('Look for it') });
        if (!addr) return;
        /*
         * An address starting 169.254 is one the other computer gave ITSELF
         * after asking the network for one and hearing nothing back.
         *
         * It is typed in and dialled like any other, because two laptops on
         * one cable have nothing else to offer each other and it is the right
         * answer there. But it is the right answer nowhere else, and it will
         * stop working the moment either machine gets a real address - so
         * whoever typed it is told, once, what they have just added.
         */
        const selfAssigned = /^\s*169\.254\./.test(addr);
        const r = await window.board.sync.addByAddress(addr);
        if (r && r.ok && r.peer) {
          if (selfAssigned) {
            app.toast(t('Found {name} - but that address only works over a direct cable between these two computers. Over the ordinary network it will not. If sharing stops working later, ask for its other address.', { name: r.peer.name }), 'help', 11000);
          } else app.toast(t('Found {name}', { name: r.peer.name }));
          renderSync(host);
        } else if (selfAssigned) {
          app.toast(t('Nothing answered at that address. Addresses starting 169.254 are ones a computer gives itself when the network does not answer, and only reach it over a direct cable - ask that computer for the other address its sharing panel shows.'),
            'help', 11000);
        } else {
          app.toast(t('Nothing answered at that address: {error}', { error: (r && r.error) || t('no answer') }), 'help', 7000);
        }
      }
    }, t('Add a computer by address…')));

    const temporary = (st.paired || []).filter((r) => !r.remember);
    if (temporary.length) {
      host.appendChild(h('button', {
        class: 'btn', style: 'width:100%;margin-top:8px',
        onclick: async () => {
          const n = await window.board.sync.endSession();
          app.toast(n === 1 ? t('Forgot one computer') : t('Forgot {n} computers', { n }));
          renderSync(host);
        }
      }, temporary.length === 1
        ? t('End this session (forget {n} temporary pairing)', { n: temporary.length })
        : t('End this session (forget {n} temporary pairings)', { n: temporary.length })));
      host.appendChild(dim(t('Closing GazBoard does this by itself.')));
    }
  }

  /*
   * Announcements do not have to travel both ways. A firewall on one machine,
   * a wifi that keeps its clients apart, two subnets that carry no broadcasts
   * between them - any of these leaves this computer seeing nothing while the
   * other sees it perfectly well, and the one that sees nothing can neither
   * find nor send to a machine that is sitting right there.
   *
   * So for any paired computer we have an address for, try the address. It is
   * one small request that either answers or does not; answering puts it in
   * the visible list, where it behaves like any other computer on the network.
   * Throttled per device, because this block redraws on every heartbeat and
   * nobody needs their switched-off desktop knocked on twice a second.
   */
  const knocked = new Map();
  const KNOCK_EVERY_MS = 15000;

  function knockOnAway(list, host) {
    const now = Date.now();
    for (const rec of list) {
      if (!rec.lastAddress) continue;
      if (now - (knocked.get(rec.deviceId) || 0) < KNOCK_EVERY_MS) continue;
      knocked.set(rec.deviceId, now);
      Promise.resolve(window.board.sync.addByAddress(rec.lastAddress))
        .then((r) => { if (r && r.ok && host.isConnected) renderSync(host); })
        .catch(() => { /* not there; the row stays where it is */ });
    }
  }

  function deviceRow(p, host) {
    const line = [];
    if (p.address) line.push(p.lastKnown ? t('{address} (last seen here)', { address: p.address }) : p.address);
    line.push(p.paired ? t('paired') : t('not paired yet'));
    if (p.paired && p.fingerprint) line.push(p.fingerprint);
    if (p.paired && p.remember === false) line.push(t('just for now'));

    const actions = h('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' });

    if (!p.paired) {
      actions.appendChild(h('button', {
        class: 'btn primary', style: 'padding:4px 10px;font-size:12.5px',
        onclick: async () => {
          const code = await app.promptText(t('Pair with {name}', { name: p.name }),
            t('That computer shows a pairing code under Settings › Share on this network. Type it here.'),
            { placeholder: 'ABCD-2345', uppercase: true, confirmLabel: t('Pair') });
          if (!code) return;
          const r = await window.board.sync.pairWith(p, code);
          if (r && r.ok) {
            app.toast(t('Paired with {name} · {fingerprint}', { name: r.device.name || p.name, fingerprint: r.device.fingerprint }), 'check', 6000);
            renderSync(host);
          } else app.toast(('' + ((r && r.error) || t('pairing failed'))), 'help', 7000);
        }
      }, t('Pair…')));
    } else {
      if (!p.offline) {
        const sendBtn = h('button', {
          class: 'btn primary', style: 'padding:4px 10px;font-size:12.5px',
          onclick: () => app.sendCurrentBoardTo(p)
        }, t('Send this board'));
        actions.appendChild(sendBtn);
        /*
         * Ask, quietly, whether they still have us.
         *
         * Forgetting only reaches a machine that is listening. Forget this one
         * while it was switched off and it never heard - so it opens the next
         * morning still offering to send, and the only way it found out was to
         * send a whole board and be turned away. In front of a class.
         *
         * The answer is only given to somebody holding the shared key, so this
         * asks nothing a stranger could ask. A machine too old to answer says
         * nothing at all, and nothing changes for it.
         */
        if (p.paired && window.board.sync.stillPaired) {
          Promise.resolve(window.board.sync.stillPaired(p))
            .then((yes) => {
              if (yes !== false || !sendBtn.isConnected) return;
              sendBtn.remove();
              actions.insertBefore(h('span', {
                style: 'font-size:12px;color:var(--text-2);align-self:center'
              }, t('has forgotten this computer - pair again')), actions.firstChild);
              if (host && host.isConnected) setTimeout(() => renderSync(host), 1200);
            })
            .catch(() => {});
        }
      }
      actions.appendChild(h('button', {
        class: 'btn', style: 'padding:4px 10px;font-size:12.5px',
        onclick: async () => {
          if (!await app.confirm(t('Forget {name}?', { name: p.name }),
            t('Both computers stop being paired, and either of you has to pair again before a board can go either way.'), t('Forget it'))) return;
          const r = await window.board.sync.unpair(p.deviceId);
          /*
           * Whether the other machine heard about it is worth saying.
           *
           * This end has forgotten them regardless - that is not negotiable and
           * does not depend on the network. But if they were switched off, their
           * screen goes on saying "paired" until they next try to send, and
           * somebody who was not told that would reasonably think it had failed.
           */
          app.toast(r && r.told
            ? t('{name} has been told, and you are unpaired on both', { name: p.name })
            : t('Forgotten here. {name} was not reachable, so it will find out the next time it tries to send you something', { name: p.name }), r && r.told ? 'check' : 'help',
          r && r.told ? 3000 : 7000);
          renderSync(host);
        }
      }, t('Forget')));
    }

    return h('div', {
      style: 'border:1px solid var(--stroke);border-radius:8px;padding:10px 12px;margin-bottom:8px'
        + (p.offline ? ';opacity:.65' : '')
    },
    h('div', { style: 'font-size:13.5px;font-weight:600;overflow-wrap:anywhere' }, p.name || t('Unknown device')),
    dim(line.join(' · ')),
    actions);
  }

  /* ---------------- settings ---------------- */

  /* ---------------- sharing ---------------- */

  /*
   * Sharing gets its own panel, and its own button.
   *
   * It used to be a section of Settings, which was wrong twice over. It was
   * buried - four screens down past pen colours and autosave, for the one
   * thing in the app a person opens with a specific job in mind. And it was
   * slow: the firewall check shells out to PowerShell, so opening Settings to
   * change a nib waited on a process that had nothing to do with nibs.
   *
   * Out here it opens when it is wanted and Settings opens at once.
   */
  function sharing() {
    open('sharing', t('Share on this network'), () => {
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

      const syncBlock = () => {
        const host = h('div', { style: 'margin-top:10px' });
        syncHost = host;
        setTimeout(() => renderSync(host), 0);
        return host;
      };

      if (!(window.board && window.board.sync)) {
        return h('div', {}, h('div', { class: 'section' },
          h('h5', {}, t('Not in this version')),
          h('div', { style: 'font-size:12.5px;color:var(--text-2);line-height:1.6' },
            t('Handing boards straight to another computer is in the desktop app. In a browser there is no way to listen for one.'))));
      }

      return h('div', {}, h('div', { class: 'section' },

          h('h5', {}, t('Share on this network')),
          row(t('Share boards on this network'), mkToggle(() => s.sync === true, async (v) => {
            s.sync = v;
            if (v) {
              // A switch that stays on after the thing behind it failed to
              // start is a lie the person then has to discover for themselves.
              const up = await app.startSync();
              if (!up) { s.sync = false; app.saveSettings(); }
            } else {
              try { await window.board.sync.stop(); app.toast(t('Sharing switched off')); }
              catch { /* it was not running anyway */ }
              app.syncStartError = null;
            }
            rerender();
          }),
            // "Windows may ask once" was here, on all three platforms. The
            // firewall banner below names the real one; this stays neutral.
            t('Off unless you switch it on. When it is on, this computer says hello to other GazBoards on the same network so you can hand a board straight across - no account, no internet, nothing leaves the room. Your computer may ask once whether to allow it through the firewall; say yes for private networks or nobody will be able to reach you. Nothing is ever saved without you being asked first.')),
          row(t('Sound when a board starts arriving'), mkToggle(() => s.arrivalSound !== false,
            (v) => { s.arrivalSound = v; if (v) app.playArrivalChime(); }),
            t('Two soft notes and a moment of highlight on the top bar the instant a board starts coming in - so the "accept this board?" question is expected rather than a surprise over the sentence you were writing.')),
          row(t('Send pictures at full size'), mkToggle(() => s.syncFullPictures === true,
            (v) => { s.syncFullPictures = v; app.saveSettings(); }),
            t('Off sends each picture no bigger than a board shows it - 2000 pixels on the long side - so boards arrive quickly and a phone is not swamped. Your own copy always keeps the original. Turn this on only to hand over photos at their original size.')),
          row(t('When a board arrives'), mkChoice(
            [[true, t('Open it')], [false, t('Just file it')]],
            () => s.syncOpenOnArrival !== false,
            (v) => { s.syncOpenOnArrival = v; app.saveSettings(); rerender(); }
          ), s.syncOpenOnArrival !== false
            ? t('Once you accept a board it opens straight away, which is what you want between your own machines. If several arrive at once only the last one opens - the rest are filed, so you are not watching boards flash past.')
            : t('Accepted boards are filed in My boards and you carry on with what you were doing. Right for a class handing work in. The one exception is replacing a board you have open: that always reloads, or you would be looking at the copy it just replaced.')),
          s.sync ? syncBlock() : null
      ),
      /*
       * The commands, always reachable.
       *
       * The firewall check reads rules and reasons about them; it cannot test
       * that another computer can actually get in, because a connection to
       * your own machine never crosses the firewall. So it can say "allowed"
       * about a machine nothing can reach - a rule scoped to a profile this
       * network is not on, or something further out on the network doing the
       * blocking. When that happens the banner is reassuring and wrong, and
       * there was nothing to click.
       */
      h('div', { class: 'section' },
        h('h5', {}, t('Still not working?')),
        h('div', { style: 'font-size:12.5px;color:var(--text-2);line-height:1.6;margin-bottom:10px' },
          t('GazBoard reads the firewall rules on this computer, which is not the same as another computer proving it can get in - so it can say all is well when it is not. These are the commands that open the way, written for this computer\u2019s own system, and they do no harm if the way is already open.')),
        (() => {
          const b = h('button', { class: 'btn', style: 'width:100%' }, t('Show the firewall commands'));
          b.addEventListener('click', () => app.showFirewallHelp('manual'));
          return b;
        })()));
    });
  }

  /**
   * The language list. Each name is written in its own language, so someone
   * who cannot read the one on screen can still find theirs.
   *
   * Changing it reloads the window: every label in the app is built once, in
   * one language, and building them all again is exactly what a reload does.
   * The board is saved first, so nothing is lost on the way.
   */
  function languagePicker() {
    const sel = h('select', { class: 'lang-select', 'aria-label': t('Language') });
    const now = app.settings.language || 'auto';
    const opts = [['auto', t('Same as this device')], ...LANGUAGES.map((l) => [l.code, l.name])];
    for (const [code, name] of opts) {
      const o = h('option', { value: code }, name);
      if (code === now) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', async () => {
      app.settings.language = sel.value;
      app.saveSettings();
      try { await app.persist(); } catch { /* the reload still switches the language */ }
      location.reload();
    });
    return sel;
  }

  /**
   * The optional Chinese font, for someone using the app in Chinese. Three
   * states: not here (download it, or add a copy got another way), arriving
   * (a percentage), installed (remove it). See fontpack.js.
   */
  function fontPackRow() {
    const pack = packFor(currentLanguage());
    if (!pack) return null;
    const host = h('div', { class: 'fontpack', style: 'margin:-6px 0 16px' });
    /*
     * Drawn straight away from what is already known - a font in use is a
     * font that is installed - and then checked against the device's own
     * storage, which can take a moment to answer. Waiting for that answer
     * before drawing anything left the row empty for a beat on a busy
     * machine, and made it look as if there was nothing to offer.
     */
    const fill = async () => {
      draw(isActive(pack.id));
      const have = await isInstalled(pack.id);
      if (have !== isActive(pack.id)) draw(have);
    };
    const draw = (have) => {
      host.innerHTML = '';
      const note = h('div', { style: 'font-size:12px;color:var(--text-2);margin-bottom:6px' },
        have
          ? t('The Chinese font is installed on this device, so Chinese on a board looks the same everywhere. It works offline.')
          : t('Optional: download the Chinese font once ({size}) so Chinese on a board looks the same on every device. Until then your system font is used.', { size: sizeLabel(pack) }));
      host.appendChild(note);
      const btns = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      const mk = (label, cls, fn) => {
        const b = h('button', { class: 'btn' + (cls ? ' ' + cls : '') }, label);
        b.style.cssText += 'padding:4px 10px;font-size:12.5px';
        b.addEventListener('click', () => fn(b));
        btns.appendChild(b);
        return b;
      };
      if (have) {
        mk(t('Remove the Chinese font'), 'fp-remove', async () => { await removeFontPack(pack.id); fill(); });
      } else {
        mk(t('Download ({size})', { size: sizeLabel(pack) }), 'primary fp-download', async (b) => {
          b.disabled = true;
          const r = await app.fetchFontPack(pack.id, (got, total) => {
            b.textContent = t('Downloading… {pct}%', { pct: Math.min(100, Math.round(got / total * 100)) });
          });
          if (!r.ok) b.disabled = false;
          fill();
        });
        const install = async (f) => {
          if (!f) return;
          const r = await installFromFile(pack.id, f);
          app.toast(r.ok ? t('Chinese font installed — it works offline from now on') : r.error, r.ok ? 'check' : 'help', 6000);
          fill();
        };
        const picker = h('input', { type: 'file', accept: '.woff2', style: 'display:none' });
        picker.addEventListener('change', () => install(picker.files && picker.files[0]));
        btns.appendChild(picker);
        // An Android WebView ignores a file input unless the app answers for
        // it, so there the phone's own picker is asked instead. No type filter:
        // a downloaded .woff2 is often labelled as plain data and would be
        // hidden; the fingerprint check refuses anything that is not the font.
        const pickNative = async () => {
          try {
            const paths = await window.board.openDialog({ title: t('Add a font file…'), properties: ['openFile'] });
            if (!paths?.length) return;
            const buf = await window.board.readFile(paths[0]);
            await install({ arrayBuffer: async () => buf });
          } catch (e) { app.toast(e.message, 'help', 6000); }
        };
        mk(t('Add a font file…'), 'fp-file', () =>
          document.documentElement.dataset.platform === 'android' ? pickNative() : picker.click());
      }
      host.appendChild(btns);
    };
    fill();
    return host;
  }

  function settings() {
    open('settings', t('Settings'), () => {
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

      // The live half of the sharing section: status, devices, buttons. It is
      // built empty and filled in, because what goes in it comes from the main
      // process, and it refills itself whenever a computer comes or goes.
      const syncBlock = () => {
        const host = h('div', { style: 'margin-top:10px' });
        syncHost = host;
        setTimeout(() => renderSync(host), 0);
        return host;
      };

      const mkToggle = (get, set) => {
        const i = h('input', { type: 'checkbox' });
        i.checked = get();
        i.addEventListener('change', () => { set(i.checked); app.saveSettings(); app.surface.invalidate(); });
        return h('label', { class: 'toggle' }, i);
      };

      const info = h('div', { style: 'font-size:12px;color:var(--text-2);line-height:1.6' });
      const storage = window.board?.storage ? h('div', {}) : null;
      let storageMessage = '', storageMessageIsError = false;
      let storageDeleteToken = null;
      const drawStorage = async () => {
        if (!storage) return;
        const [i, state] = await Promise.all([window.board.info(), window.board.storage.get()]);
        if (!storage.isConnected) return;
        const path = i.boardsDir || state.current || (i.userData ? i.userData + '/boards' : '');
        storage.replaceChildren(...[
          i.storage?.status === 'fallback' ? h('div', { style: 'padding:8px 10px;margin-bottom:8px;border:1px solid rgba(255,185,0,.4);border-radius:6px;background:rgba(255,185,0,.12);font-size:12px;line-height:1.5' }, t('The chosen boards folder is unavailable. GazBoard is using the default folder for this session.')) : null,
          h('code', { style: 'font-size:11px;display:block;word-break:break-all;margin-bottom:8px' }, path),
          h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
            h('button', { class: 'btn', onclick: async () => {
              const picked = await window.board.storage.choose();
              if (!picked?.ok) {
                const reason = picked?.reason || picked?.error;
                if (reason) { storageMessage = `${t('Could not change the boards folder')}: ${reason}`; storageMessageIsError = true; await drawStorage(); }
                return;
              }
              if (picked.unchanged) return;
              const currentCount = ((await window.board.boards.list()) || []).length;
              const mode = await app.choose(t('Change boards folder?'), picked.isEmpty
                ? t('The selected folder is empty. Copy your {n} current boards there, or start empty?', { n: currentCount })
                : t('The selected folder already has {n} boards. Use those as is, or copy your boards in while keeping both on a name clash?', { n: picked.existingBoards || 0 }),
              picked.isEmpty
                ? [{ id: 'copy', label: t('Copy my boards here'), primary: true }, { id: 'empty', label: t('Start empty') }]
                : [{ id: 'use-as-is', label: t('Use as is'), primary: true }, { id: 'copy-merge', label: t('Copy and keep both') }]);
              if (!mode) return;
              const progress = app.showProgress(t('Changing boards folder'), t('Saving the open board and changing storage…'));
              let result;
              try { result = await window.board.storage.apply({ path: picked.path, mode }); }
              catch (error) { result = { ok: false, error: error.message || String(error) }; }
              finally { progress.close(); }
              storageMessageIsError = !result?.ok;
              storageMessage = result?.ok ? t('Boards folder changed') : `${t('Could not change the boards folder')}: ${result?.error || ''}`;
              storageDeleteToken = result?.deleteToken || null;
              await drawStorage();
            } }, t('Change folder…')),
            h('button', { class: 'btn', onclick: async () => {
              const destination = await window.board.storage.get();
              if (!destination.isCustom) return;
              const currentCount = ((await window.board.boards.list()) || []).length;
              const mode = await app.choose(t('Reset boards folder?'), destination.defaultIsEmpty
                ? t('The default folder is empty. Copy your {n} current boards there, or start empty?', { n: currentCount })
                : t('The default folder already has {n} boards. Use those as is, or copy your boards in while keeping both on a name clash?', { n: destination.defaultExistingBoards || 0 }),
              destination.defaultIsEmpty
                ? [{ id: 'copy', label: t('Copy my boards here'), primary: true }, { id: 'empty', label: t('Start empty') }]
                : [{ id: 'use-as-is', label: t('Use as is'), primary: true }, { id: 'copy-merge', label: t('Copy and keep both') }]);
              if (!mode) return;
              const progress = app.showProgress(t('Resetting boards folder'), t('Saving the open board and changing storage…'));
              let result;
              try { result = await window.board.storage.reset({ mode }); }
              catch (error) { result = { ok: false, error: error.message || String(error) }; }
              finally { progress.close(); }
              storageMessageIsError = !result?.ok;
              storageMessage = result?.ok ? t('Boards folder reset to default') : `${t('Could not reset the boards folder')}: ${result?.error || ''}`;
              storageDeleteToken = result?.deleteToken || null;
              await drawStorage();
            } }, t('Reset to default')),
            h('button', { class: 'btn', onclick: () => window.board.openBoardsFolder?.() }, t('Open folder'))),
          storageDeleteToken ? h('button', { class: 'btn', style: 'margin-top:8px', onclick: async () => {
            const result = await window.board.storage.deleteOld(storageDeleteToken);
            if (result?.ok) { storageDeleteToken = null; storageMessage = t('Old copies moved to Trash'); storageMessageIsError = false; }
            else if (!result?.canceled) { storageMessage = `${t('Could not remove old copies')}: ${result?.error || ''}`; storageMessageIsError = true; }
            await drawStorage();
          } }, t('Move old copies to Trash…')) : null,
          h('p', { style: 'font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:0' }, t('Tip: pick a folder inside Nextcloud, Dropbox or Syncthing to sync your boards. Use GazBoard on one computer at a time.'))
        ].filter(Boolean));
        if (storageMessage) storage.append(h('div', {
          role: 'status', style: `font-size:12px;margin-top:8px;color:${storageMessageIsError ? 'var(--danger,#c50f1f)' : 'var(--text-2)'}`
        }, storageMessage));
      };
      drawStorage().catch(() => {});
      window.board.info().then((i) => {
        const platformLines = i.electron
          ? `Electron ${i.electron} · Chromium ${i.chrome}<br>` +
            t('Office conversion: <b>{how}</b>', { how: i.libreoffice ? t('LibreOffice detected') : t('built-in converter') }) + '<br>' +
            (i.sofficePath ? `<code style="font-size:11px">${i.sofficePath}</code><br>` : '') +
            t('Boards folder: <code style="font-size:11px">{path}</code>', { path: i.boardsDir || i.userData + '/boards' })
          : i.isAndroid
          ? `Android · WebView ${i.chrome}<br>` +
            t('Office conversion: <b>{how}</b>', { how: t('built-in converter') }) + '<br>' +
            t('Boards storage: <code style="font-size:11px">{path}</code>', { path: i.boardsDir || i.userData })
          : t('Runtime: <b>Web / Progressive Web App</b> · {mode}', { mode: i.pwa ? t('Standalone App') : t('Browser') }) + '<br>' +
            t('Boards storage: <code style="font-size:11px">{path}</code>', { path: i.boardsDir || i.userData });

        info.innerHTML = t('{app} · by {maker}', { app: `<b style="color:var(--text)">GazBoard ${i.version}</b>`, maker: '<b style="color:var(--accent)">theBoringCodes</b>' }) + '<br>' +
          `MD. Fakhruddin Gazzali · <a href="mailto:fahim9778@gmail.com" target="_blank" style="color:var(--accent)">fahim9778@gmail.com</a><br>` +
          t('Co-created with {heart} by {makers}', { heart: '<span style="color:#e81123">&hearts;</span>', makers: 'Claude Cowork &amp; GPT Sol, Astra' }) + '<br>' +
          platformLines;
      });

      return h('div', {},
        h('div', { class: 'section' },
          h('h5', {}, t('Appearance')),
          row(t('Language'), languagePicker(),
            t('The words on the menus, buttons and messages. What you write on a board is yours and stays as it is.')),
          fontPackRow(),
          row(t('Theme'),
            mkChoice([['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]],
              () => s.theme || 'system',
              (v) => { s.theme = v; app.saveSettings(); rerender(); }),
            t('System follows whatever your computer or phone is set to, and changes with it. Light and Dark override that. Exports and printing are always on white paper, whichever you pick, so a board you share looks the same to everyone.')),
        ),
        h('div', { class: 'section' },
          h('h5', {}, t('Inking')),
          row(t('Straighten shapes I draw'), mkToggle(() => s.inkToShape, (v) => (s.inkToShape = v)),
            t('Off by default: ink is kept exactly as you drew it. Switch on and a hand-drawn circle, box or arrow snaps to a clean shape when you lift the pen — one undo returns your ink.')),
          row(t('Pressure sensitivity'), mkToggle(() => s.pressure, (v) => (s.pressure = v)),
            t('Vary ink width with how hard you press - within a stroke, not just between strokes. Works with a graphics tablet, a Surface pen or an S Pen; a mouse or a finger reports no pressure and draws at one width.')),
          row(t('Pen side button rubs out'), mkToggle(() => s.penButtonErases !== false,
            (v) => (s.penButtonErases = v)),
            t('Hold the button on the side of your stylus while you draw and it erases instead, the way it does in Samsung\u2019s own apps. Turning a pen over to use its blunt end always erases and is not affected by this. Switch off if you would rather that button opened the right-click menu.')),
          row(t('Draw with the mouse'), mkChoice(
            [['auto', t('Auto')], ['yes', t('Always')], ['no', t('Never')]],
            () => s.inkWithMouse,
            (v) => { s.inkWithMouse = v; app.saveSettings(); rerender(); }
          ), s.inkWithMouse === 'auto'
            ? (app.penSeenThisSession
              ? t('A stylus has been used since the app started, so the mouse pans the canvas instead of inking. It draws again next time you open GazBoard.')
              : t('The mouse draws until a stylus is used, then it pans instead — only for this session.'))
            : s.inkWithMouse === 'yes'
              ? t('The mouse always inks, like a stylus. Pan with space and drag, the middle button, right-drag, or the pan tool. Choose this if you draw with a mouse and have no pen.')
              : t('Never (default): the pen inks and the mouse moves the canvas and drags objects — both at the same time, whichever tool is chosen.')),
          row(t('Draw with a finger'), mkChoice(
            [['auto', t('Auto')], ['yes', t('Always')], ['no', t('Never')]],
            () => s.inkWithFinger || 'auto',
            (v) => { s.inkWithFinger = v; app.saveSettings(); rerender(); }
          ), (s.inkWithFinger || 'auto') === 'auto'
            ? (app.penSeenThisSession
              ? t('A pen has been used since the app started, so one finger moves the board and the pen draws. Your finger draws again next time you open GazBoard without a pen.')
              : t('No pen has touched the screen, so your finger draws and two fingers move the board. The moment a pen is used they swap over \u2014 only for this session.'))
            : (s.inkWithFinger === 'yes'
              ? t('Your finger always draws. Move the board with two fingers, or with the hand tool.')
              : t('One finger always moves the board and never draws \u2014 tap to select, hold to pick something up. Choose this if you always write with a pen and keep resting a hand on the screen.'))),
          row(t('Pointer while inking'), mkChoice(
            [['nib', t('Pen nib')], ['arrow', t('Arrow')], ['crosshair', t('Crosshair')]],
            () => s.inkPointer || 'nib',
            (v) => { s.inkPointer = v; app.saveSettings(); app.interaction.inkPointer = null;
                     app.surface.invalidate(); rerender(); }
          ), (s.inkPointer || 'nib') === 'nib'
            ? t('A pen tip in the colour you are drawing with, painted onto the board itself so it stays put for the whole stroke — Windows hides the ordinary pointer while a stylus is touching the screen.')
            : (s.inkPointer === 'arrow'
              ? t('The ordinary mouse pointer, the way most whiteboards do it. On a tablet it will disappear while the pen is down; that is Windows, not GazBoard.')
              : t('A crosshair for placing a mark exactly. Same caveat as the arrow on a tablet.'))),
          // Only worth offering where a finger can actually draw. On a
          // mouse-only desktop this switch would do nothing at all, and a
          // setting that does nothing is worse than no setting.
          (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
            ? row(t('Show the nib when drawing with a finger'),
                mkToggle(() => s.nibOnTouch === true, (v) => { s.nibOnTouch = v;
                  app.interaction.hideInkPointer(); }),
                t('Off (default): drawing with a finger shows no pen nib, because your fingertip is already on the spot and the nib only hides under your hand. A stylus or a mouse on this machine still gets one. Switch on if you are on a Surface or another touchscreen PC and want the nib under your finger too.'))
            : null,
          row(t('Ruler snapping'), mkToggle(() => app.ruler.snap, (v) => (app.ruler.snap = v)))
        ),
        storage ? h('div', { class: 'section' }, h('h5', {}, t('Storage')), storage) : null,
        h('div', { class: 'section' },
          h('h5', {}, t('Canvas')),
          row(t('Mouse wheel zooms'), mkToggle(() => s.wheelZoom, (v) => (s.wheelZoom = v)), t('Off: wheel and trackpad pan, Ctrl+wheel zooms.')),
          row(t('Auto-pan at the edges'), mkToggle(() => s.edgePan, (v) => (s.edgePan = v)),
            t('While drawing or dragging, running the pointer into the edge of the window scrolls the canvas. A mouse button held down during a pen stroke drags the canvas too.')),
          row(t('Return to select after drawing'), mkToggle(() => s.returnToSelect, (v) => (s.returnToSelect = v))),
          row(t('Outline grouped objects'), mkToggle(() => s.showGroupOutlines !== false, (v) => {
            s.showGroupOutlines = v;
            app.saveSettings();
            app.surface.showGroupOutlines = v;
            app.surface.invalidate();
          }), t('A faint dashed ring round each group, so a finished drawing shows which parts are tied together. The group you are touching is drawn more clearly. Locked objects always show their dotted outline.')),
          row(t('Right-drag pans the canvas'), mkToggle(() => s.rightDragPans !== false, (v) => (s.rightDragPans = v)),
            t('Hold the right mouse button and drag to move around — useful on a laptop with no pen and no middle button. A right click that does not move still opens the usual menu.')),
          row(t('Check for updates'), mkToggle(() => s.updateCheck === true, (v) => { s.updateCheck = v; app.saveSettings(); if (v) app.checkForUpdates({ force: true }); }),
            t('Asks GitHub at most twice a day whether a newer version exists, and tells you if so. Nothing is downloaded or installed automatically, and nothing about you or your boards is ever sent. Off means the app never touches the network.')),
          row(t('Shortcut letters on the toolbar'), mkToggle(() => s.showToolKeys !== false, (v) => (s.showToolKeys = v)),
            t('Shows the key for each tool in the corner of its button — V, P, H, E and so on — so you can switch without stopping to look them up.')),
          row(t('Low-latency inking'), mkToggle(() => s.lowLatencyInk, (v) => { s.lowLatencyInk = v; app.toast(t('Takes effect next time GazBoard opens')); }),
            t('Shaves a little lag off the pen by letting the canvas skip a buffering step. On some graphics drivers this makes the board flicker while you write or drag, especially with imported document pages on it — leave it off if you see that. Applies when the app is reopened.')),
          // Windows only: elsewhere the switch would do nothing, so it is not offered.
          inkTrailSupported() ? row(t('Windows Ink trail (experimental)'), mkToggle(() => s.inkTrail === true, (v) => { s.inkTrail = v; app.inkTrail?.setEnabled(v); }),
            t('Lets Windows paint the newest bit of a pen stroke straight to the screen, so the ink stays closer to the nib — the way Microsoft Whiteboard does it. Only the plain pen uses it; the highlighter, rainbow and galaxy inks and the ruler draw as before. Nothing about your boards changes.')) : null,
          // where GazBoard prepares the deck itself (the desktop app); the phone app always uses the final look
          window.board?.importTakesBytes ? row(t('Animated slides come in after the last click'), mkToggle(() => s.slidesFinalLook !== false, (v) => { s.slidesFinalLook = v; app.saveSettings(); }),
            t('On (default): each slide comes in the way it looks once every click is done — what fades out is gone, what moves is where it stops, what grows is full size. Off: the slide as it is before the first click, with everything on it at once.'))
            : null,
          // Windows desktop only: Office is driven through Windows itself, so elsewhere the switch would do nothing.
          (window.board?.importTakesBytes && /Windows/i.test(navigator.userAgent || '')) || window.__gazboardShowOfficeRow === true
            ? row(t('Import with Microsoft Office (beta)'), mkToggle(() => s.officeImport === true, (v) => { s.officeImport = v; app.saveSettings(); }),
              t('Word, Excel and PowerPoint files are opened in your own Microsoft Office, out of sight, and saved as PDF pages — an exact copy, the way Microsoft Whiteboard shows them. Slower: Office takes a few seconds to start. Wide spreadsheets are fitted to one page across. If Office is not installed, the usual converter is used.'))
            : null,
          row(t('My boards as a full page'), mkToggle(() => s.boardsPage !== false, (v) => { s.boardsPage = v; app.saveSettings(); }),
            t('On (default): folders down the side, coloured folder tiles and a picture of every board. Off: a simple list in the side panel.')),
          row(t('Autosave'), mkToggle(() => s.autosave, (v) => (s.autosave = v)), t('Boards are stored locally on this computer.'))
        ),
        /*
         * Back to how it shipped.
         *
         * Every switch above is one somebody can turn the wrong way and not
         * remember which, and the honest ones - pressure, low-latency inking,
         * pointer style - are exactly the ones that get poked at when
         * something looks wrong. One button back to a known state is worth
         * more than a list of what each default was.
         *
         * Boards, paired computers and sharing are untouched; the wording
         * says so, because a "reset" button that might delete work is a button
         * nobody dares press.
         */
        h('div', { class: 'section' },
          h('h5', {}, t('Reset to defaults')),
          row(t('Put every setting back to how it shipped'),
            (() => {
              const b = h('button', { class: 'btn' }, t('Reset settings'));
              b.style.cssText += 'padding:4px 12px;font-size:12.5px';
              b.addEventListener('click', async () => {
                if (!await app.confirm(t('Reset every setting?'),
                  t('Pens, pointers, zoom, autosave and the rest go back to how GazBoard shipped. Your boards are not touched, paired computers are kept, and sharing stays exactly as it is now.'), t('Reset them'))) return;
                app.resetSettings();
                app.toast(t('Settings are back to how they shipped'));
                rerender();
              });
              return b;
            })(),
            t('Your boards, your paired computers and the sharing switch are left alone.')),
          // Only the web build. An Electron window has no stale service worker
          // to get stuck behind, and offering a "hard refresh" there would be
          // a button that appears to do nothing.
          (window.board && !window.board.sync) ? row(t('Reload the app from scratch'),
            (() => {
              const b = h('button', { class: 'btn' }, t('Hard refresh'));
              b.style.cssText += 'padding:4px 12px;font-size:12.5px';
              b.addEventListener('click', async () => {
                if (!await app.confirm(t('Reload GazBoard from scratch?'),
                  t('The saved copy of the app in this browser is thrown away and fetched again. Your boards are stored separately and are not affected. Save anything unsaved first.'), t('Reload'))) return;
                try {
                  if (navigator.serviceWorker) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map((r) => r.unregister()));
                  }
                  if (window.caches) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((k) => caches.delete(k)));
                  }
                } catch { /* nothing cached, or a browser that will not say */ }
                // Cache-busted so the browser cannot hand back the page it
                // already has, which is the whole thing being escaped from.
                location.replace(location.pathname + '?r=' + Date.now());
              });
              return b;
            })(),
            t('Use this when GazBoard in the browser looks out of date after an update. It clears the offline copy and fetches the newest one. Boards are kept.')) : null
        ),
        // Sharing lives in its own panel now. It was the heaviest thing in
        // here - it reads the firewall, which shells out to PowerShell, so
        // opening Settings to change a pen colour waited on that - and it was
        // also the hardest to find, four screens down a list of switches.
        (window.board && window.board.sync) ? h('div', { class: 'section' },
          h('h5', {}, t('Share on this network')),
          h('div', { style: 'font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:10px' },
            t('Handing a board to another computer in the room has its own panel now - the Share button on the top bar.')),
          (() => {
            const b = h('button', { class: 'btn primary', style: 'width:100%' }, t('Open sharing'));
            b.addEventListener('click', () => sharing());
            return b;
          })()
        ) : null,
        h('div', { class: 'section' },
          h('h5', {}, t('Board')),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.new'); close(); } }, t('New board')),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.open'); close(); } }, t('Open a board file…')),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.save'); close(); } }, t('Save a copy…')),
          h('button', { class: 'btn danger', style: 'width:100%', onclick: () => app.command('edit.clear') }, t('Clear this canvas'))
        ),
        h('div', { class: 'section' }, h('h5', {}, t('About')), info,
          h('p', { style: 'font-size:12px;color:var(--text-2);margin-top:10px;line-height:1.6' },
            t('Boards save automatically on this device. Use My boards to reopen them, or Save a copy to keep a board file in a folder you choose. There is no sign-in, no account and no cloud. The one thing that ever leaves this device is a board you hand to another GazBoard yourself, over your own network, and even then it goes straight from here to there, never through anybody\'s server.')))
      );
    });
  }

  /* ---------------- boards ---------------- */
  /*
   * My boards, with folders.
   *
   * A filing cabinet: folders inside folders, a path across the top that says
   * where you are and takes you back up, and boards that can be moved with
   * "Move to…" or simply picked up and dropped on a folder - held for a moment
   * on a touch screen, dragged straight away with a mouse. The folders are a
   * catalogue kept in this device's settings (see core/folders.js); the boards
   * themselves are never touched by any of it.
   */
  /**
   * My boards: the full-page gallery by default, or - switched off in
   * Settings - the plain list in the side panel it used to be.
   */
  function boards(opts = {}) {
    return app.settings.boardsPage === false ? boardsList(opts) : boardsGallery(opts);
  }

  async function boardsGallery(opts = {}) {
    // Re-drawing in place (after a move, a new folder, a step into a folder)
    // must not go through open(), which treats a second open as "close". And
    // asking for My boards while it is already showing just refreshes it: it
    // covers the whole window, so there is no button behind it to toggle.
    if (!(currentKey === 'boards' && document.getElementById('boardList'))) {
      open('boards', t('My boards'), () => h('div', { id: 'boardList' }, h('p', { style: 'color:var(--text-2)' }, t('Loading…'))));
    }
    const all = await window.board.boards.list();
    if (!all.some((b) => b.id === app.store.doc.id)) all.unshift({
      id: app.store.doc.id, name: app.store.doc.name, objects: app.store.count, modified: app.store.doc.modified
    });
    // The board in front is shown as it is right now, not as it was at its last save.
    for (const b of all) if (b.id === app.store.doc.id) b.thumb = app.boardPictureFor?.() || b.thumb || null;
    const host = document.getElementById('boardList');
    if (!host) return;
    if (F.pruneBoards(app.settings, all)) app.saveSettings();
    const here = app.boardFolder && F.folderPath(app.settings, app.boardFolder).length ? app.boardFolder : null;
    app.boardFolder = here;
    const list = F.boardsIn(app.settings, all, here);
    const go = (id) => { app.boardFolder = id || null; boards({ stay: true }); };
    const keep = () => { try { localStorage.setItem('gazboard.settings', JSON.stringify(app.settings)); } catch { /* storage refused */ } app.syncBoardPath?.(); };

    /*
     * The page: a list of folders down the side (on a screen wide enough for
     * one), and on the right the folder you are in - its folders as coloured
     * tiles, then its boards as pictures. The same filing cabinet as before,
     * laid out the way a notes app lays out a library.
     */
    host.innerHTML = '';
    host.className = 'gallery';
    const side = h('aside', { class: 'gal-side', 'aria-label': t('Folders') });
    const main = h('div', { class: 'gal-main' });
    host.appendChild(side);
    host.appendChild(main);

    const sideItem = (id, name, depth, count, colour) => {
      const b = h('button', { class: 'side-item' + ((id || null) === here ? ' here' : ''), 'data-drop-folder': id || '', 'data-side-folder': id || '',
        style: `padding-inline-start:${12 + depth * 16}px` },
        h('span', { class: 'side-icon', html: icon(id ? 'folder' : 'board', 18), style: colour ? `color:${colour}` : '' }),
        h('span', { class: 'side-name' }, name),
        h('span', { class: 'side-count' }, String(count)));
      b.addEventListener('click', () => go(id || null));
      side.appendChild(b);
    };
    side.appendChild(h('div', { class: 'side-title' }, t('Folders')));
    sideItem(null, t('My boards'), 0, F.boardsIn(app.settings, all, null).length, null);
    const tree = (parent, depth) => {
      for (const f of F.childFolders(app.settings, parent)) {
        sideItem(f.id, f.name, depth, F.folderCounts(app.settings, all, f.id).boards, F.folderColour(f));
        tree(f.id, depth + 1);
      }
    };
    tree(null, 1);

    const actions = h('div', { class: 'gal-actions' });
    actions.appendChild(h('button', { class: 'btn primary', onclick: () => {
      app.command('board.new');
      // A new board is filed in the folder you are looking at.
      if (here) { F.moveBoard(app.settings, app.store.doc.id, here); keep(); }
      close();
    } }, t('+ New board')));
    actions.appendChild(h('div', { style: 'display:contents' },
      h('button', { class: 'btn', 'data-new-folder': '1', onclick: async () => {
        const name = await app.askText(t('New folder'), here
          ? t('Made inside “{name}”.', { name: F.folderPath(app.settings, here).pop().name })
          : t('A folder for a subject, a course or a term. Folders can hold folders.'),
        { value: '', placeholder: t('CSE221, Lectures, Spring 2026…'), ok: t('Create') });
        if (name === null || !String(name).trim()) return;
        F.createFolder(app.settings, name, here); keep(); boards({ stay: true });
      } }, t('+ New folder')),
      // Opening a .gazboard file had a keyboard shortcut and nothing to click,
      // which is no use to anyone who does not already know it is there.
      h('button', { class: 'btn', onclick: () => { app.command('board.open'); close(); } }, t('Open a board file…'))));

    // The path: where you are, and every step back up. Each step is also a
    // place to drop a board or a folder.
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': t('Folder path') });
    const steps = [{ id: null, name: t('My boards') }, ...F.folderPath(app.settings, here)];
    steps.forEach((st, i) => {
      if (i) crumbs.appendChild(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'));
      const last = i === steps.length - 1;
      const c = h('button', { class: 'crumb' + (last ? ' here' : ''), 'data-drop-folder': st.id || '', title: st.name }, st.name);
      if (!last) c.addEventListener('click', () => go(st.id));
      crumbs.appendChild(c);
    });
    main.appendChild(h('div', { class: 'gal-head' }, crumbs, actions));

    const chosen = new Set();
    const boxes = [];
    /*
     * A ticked board moves with all the other ticked ones. Moving a board that
     * is not ticked moves just that one, so a stray tick somewhere else never
     * drags half the list along with it.
     */
    const movingWith = (id) => (chosen.has(id) ? [...chosen] : [id]);
    const moveBoards = (ids, to) => {
      for (const id of ids) F.moveBoard(app.settings, id, to);
      keep();
      const where = to ? F.folderPath(app.settings, to).pop().name : t('My boards');
      app.toast(ids.length > 1 ? t('Moved {n} boards to {name}', { n: ids.length, name: where }) : t('Moved to {name}', { name: where }), 'check');
      boards({ stay: true });
    };
    const exportButton = h('button', { class: 'btn primary', disabled: true }, t('Export selected (0)'));
    const moveSelected = h('button', { class: 'btn', disabled: true, 'data-move-selected': '1' }, t('Move selected (0)…'));
    const selectAll = h('input', { type: 'checkbox', 'aria-label': t('Select all boards') });
    const syncChosen = () => {
      exportButton.disabled = !chosen.size;
      moveSelected.disabled = !chosen.size;
      moveSelected.textContent = t('Move selected ({n})…', { n: chosen.size });
      exportButton.textContent = chosen.size > 1
        ? t('Export selected ({n}) as ZIP…', { n: chosen.size })
        : t('Export selected ({n})…', { n: chosen.size });
      selectAll.checked = chosen.size === list.length && !!list.length;
      selectAll.indeterminate = chosen.size > 0 && chosen.size < list.length;
    };
    selectAll.addEventListener('change', () => {
      chosen.clear();
      for (const { input, id } of boxes) { input.checked = selectAll.checked; if (input.checked) chosen.add(id); }
      syncChosen();
    });
    exportButton.addEventListener('click', async () => {
      const ids = [...chosen];
      exportButton.disabled = true;
      selectAll.disabled = true;
      boxes.forEach(({ input }) => { input.disabled = true; });
      exportButton.textContent = t('Exporting…');
      try { await exportBoards(app, ids); }
      catch (e) { app.toast(e.message || t('Could not export the selected boards'), 'help', 6000); }
      finally {
        selectAll.disabled = false;
        boxes.forEach(({ input }) => { input.disabled = false; });
        syncChosen();
      }
    });

    /* -- folders here, as coloured tiles -- */
    const folders = F.childFolders(app.settings, here);
    const folderGrid = h('div', { class: 'folder-grid' });
    for (const f of folders) {
      const n = F.folderCounts(app.settings, all, f.id);
      const what = [
        n.boards === 1 ? t('1 board') : t('{n} boards', { n: n.boards }),
        n.folders ? (n.folders === 1 ? t('1 folder') : t('{n} folders', { n: n.folders })) : null
      ].filter(Boolean).join(' · ');
      const tile = h('button', { class: 'folder-tile', 'data-folder': f.id, 'data-drop-folder': f.id, title: f.name + ' · ' + what,
        style: `--fc:${F.folderColour(f)}` },
        h('span', { class: 'ft-tab', 'aria-hidden': 'true' }),
        h('span', { class: 'ft-count' }, String(n.boards)),
        h('b', { class: 'ft-name' }, f.name),
        h('small', { class: 'ft-what' }, what),
        h('span', { class: 'ft-actions' },
          h('span', { class: 'icon-btn', title: t('Folder colour'), html: icon('palette', 15), 'data-colour-folder': f.id, onclick: async (e) => {
            e.stopPropagation();
            const c = await chooseColour(f);
            if (!c) return;
            F.setFolderColour(app.settings, f.id, c); keep(); boards({ stay: true });
          } }),
          h('span', { class: 'icon-btn', title: t('Rename'), html: icon('text', 15), onclick: async (e) => {
            e.stopPropagation();
            const name = await app.askText(t('Rename folder'), '', { value: f.name, placeholder: f.name, ok: t('Save') });
            if (name === null || !String(name).trim()) return;
            F.renameFolder(app.settings, f.id, name); keep(); boards({ stay: true });
          } }),
          h('span', { class: 'icon-btn', title: t('Move to…'), html: icon('folderMove', 15), 'data-move': f.id, onclick: async (e) => {
            e.stopPropagation();
            const to = await chooseFolder(t('Move “{name}” to…', { name: f.name }), { moving: f.id, from: here });
            if (to === undefined) return;
            if (!F.moveFolder(app.settings, f.id, to)) { app.toast(t('A folder cannot go inside itself'), 'help'); return; }
            keep(); boards({ stay: true });
          } }),
          h('span', { class: 'icon-btn', title: t('Delete folder'), html: icon('trash', 15), onclick: async (e) => {
            e.stopPropagation();
            const inside = n.boards || n.folders;
            const ok = await app.confirm(t('Delete folder?'), inside
              ? t('“{name}” goes, but nothing in it is deleted: its boards and folders move up a level.', { name: f.name })
              : t('“{name}” is empty and will be removed.', { name: f.name }), t('Delete folder'));
            if (!ok) return;
            F.deleteFolder(app.settings, f.id); keep(); boards({ stay: true });
          } })));
      tile.addEventListener('click', () => { if (!tile._dragged) go(f.id); });
      pickUp(tile, { kind: 'folder', id: f.id, name: f.name });
      folderGrid.appendChild(h('div', { class: 'tile-wrap' }, tile));
    }
    if (folders.length) main.appendChild(folderGrid);

    main.appendChild(h('div', { class: 'gal-tools' },
      h('label', { style: 'display:flex;align-items:center;gap:8px;min-height:44px' }, selectAll, t('Select all')), exportButton, moveSelected));
    moveSelected.addEventListener('click', async () => {
      const ids = [...chosen];
      if (!ids.length) return;
      const to = await chooseFolder(t('Move {n} boards to…', { n: ids.length }), { from: here });
      if (to === undefined) return;
      moveBoards(ids, to);
    });
    const boardGrid = h('div', { class: 'board-grid' });
    main.appendChild(boardGrid);
    if (!list.length && !folders.length) main.appendChild(h('p', { style: 'color:var(--text-2);font-size:13px' },
      here ? t('This folder is empty. Make a new board here, or move boards in with “Move to…” or by dragging them onto it.') : t('No saved boards yet.')));
    if (all.length > 1 && !F.folderList(app.settings).length) main.appendChild(h('p', { style: 'font-size:12px;color:var(--text-2)' },
      t('Tip: + New folder files boards by subject. Hold a board and drag it onto a folder, or use its “Move to…” button.')));

    // Every board this app has ever saved is a plain file in one folder. Showing
    // people where, and letting them open it, is worth more than any reassurance
    // in a settings screen.
    window.board.info().then((i) => {
      if (!document.getElementById('boardList')) return;
      if (i.electron) {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, all.length === 1
            ? t('{n} board, saved on this computer at:', { n: all.length })
            : t('{n} boards, saved on this computer at:', { n: all.length })),
          h('code', { style: 'font-size:11px;display:block;margin:4px 0 8px;word-break:break-all' }, i.boardsDir || i.userData + '/boards'),
          h('button', { class: 'btn', style: 'width:100%', onclick: () => {
            if (window.board.openBoardsFolder) window.board.openBoardsFolder();
            else window.board.showItem(i.boardsDir || i.userData + '/boards');
          } }, t('Open that folder')));
        main.appendChild(h('p', { class: 'gal-note' }, t('Choose boards to export. One saves as a .gazboard file; several save together in a ZIP. Extract the ZIP to open its boards.'))); main.appendChild(foot);
      } else if (i.isAndroid) {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, all.length === 1
            ? t('{n} board, saved in GazBoard’s private storage on this Android device.', { n: all.length })
            : t('{n} boards, saved in GazBoard’s private storage on this Android device.', { n: all.length })),
          h('p', {}, t('Boards and images save automatically and reopen here. Android’s Files app cannot browse this private folder.')),
          h('p', {}, t('Select boards above to export them with their images. Choose Downloads, Documents or another location in the Android file picker.')),
          h('p', {}, t('Uninstalling GazBoard or clearing its app storage deletes these local boards. Export copies you want to keep; exports are separate from autosave.')),
          h('button', { class: 'btn', style: 'width:100%', onclick: () => { app.command('board.save'); close(); } }, t('Save current board…')));
        main.appendChild(h('p', { class: 'gal-note' }, t('Choose boards to export. One saves as a .gazboard file; several save together in a ZIP. Extract the ZIP to open its boards.'))); main.appendChild(foot);
      } else {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, all.length === 1
            ? t('{n} board, stored in browser persistence:', { n: all.length })
            : t('{n} boards, stored in browser persistence:', { n: all.length })),
          h('code', { style: 'font-size:11px;display:block;margin:4px 0 8px;word-break:break-all' }, i.userData));
        main.appendChild(h('p', { class: 'gal-note' }, t('Choose boards to export. One saves as a .gazboard file; several save together in a ZIP. Extract the ZIP to open its boards.'))); main.appendChild(foot);
      }
    });

    /* -- boards here, as pictures -- */
    for (const b of list) {
      const input = h('input', { type: 'checkbox', 'aria-label': t('Export {name}', { name: b.name || t('Untitled board') }) });
      boxes.push({ input, id: b.id });
      input.addEventListener('change', () => {
        if (input.checked) chosen.add(b.id); else chosen.delete(b.id);
        wrap.classList.toggle('ticked', input.checked);
        syncChosen();
      });
      const when = new Date(b.modified).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      const tile = h('button', { class: 'board-tile' + (b.id === app.store.doc.id ? ' current' : ''), 'data-board': b.id,
        title: b.objects === 1 ? t('{n} item · {date}', { n: b.objects, date: new Date(b.modified).toLocaleString() }) : t('{n} items · {date}', { n: b.objects, date: new Date(b.modified).toLocaleString() }) },
        h('span', { class: 'bt-thumb' }, b.thumb
          ? h('img', { src: b.thumb, alt: '', draggable: 'false', loading: 'lazy' })
          : h('span', { class: 'bt-blank', html: icon('board', 30) })),
        h('b', { class: 'bt-name' }, b.name || t('Untitled board')),
        h('small', { class: 'bt-date' }, when),
        h('span', { class: 'bt-actions' },
          h('span', { class: 'icon-btn', title: t('Move to…'), html: icon('folderMove', 15), 'data-move': b.id, onclick: async (e) => {
            e.stopPropagation();
            const ids = movingWith(b.id);
            const to = await chooseFolder(ids.length > 1 ? t('Move {n} boards to…', { n: ids.length }) : t('Move “{name}” to…', { name: b.name || t('Untitled board') }), { from: here });
            if (to === undefined) return;
            moveBoards(ids, to);
          } }),
          h('span', { class: 'icon-btn', title: t('Delete'), html: icon('trash', 15), onclick: async (e) => { e.stopPropagation(); if (await app.confirm(t('Delete board?'), t('"{name}" will be permanently removed.', { name: b.name }), t('Delete'))) { await app.deleteBoard(b.id); boards({ stay: true }); } } })));
      tile.addEventListener('click', async () => {
        if (tile._dragged) return;
        const data = await window.board.boards.load(b.id);
        if (data) { await app.loadBoard(data); close(); }
        else if (b.id === app.store.doc.id) close();      // the board in front, not saved yet
      });
      pickUp(tile, { kind: 'board', id: b.id, name: b.name || t('Untitled board') });
      const wrap = h('div', { class: 'tile-wrap board-wrap' },
        h('label', { class: 'tick', title: t('Select') }, input), tile);
      boardGrid.appendChild(wrap);
    }

    /*
     * Pick a row up and drop it on a folder.
     *
     * A mouse drags at once - press, move, drop - like a file in Explorer. A
     * finger or a pen has to HOLD first, for about half a second, because
     * moving straight away is how a list is scrolled; only a steady hold lifts
     * the row, with a buzz where the device can. While something is lifted the
     * list does not scroll under the finger, except at its top and bottom
     * edges, where it rolls along so a folder off screen can still be reached.
     * Letting go anywhere but a folder puts it back where it was.
     */
    function pickUp(row, item) {
      row.style.touchAction = 'pan-y';
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.icon-btn')) return;
        const touchy = e.pointerType !== 'mouse';
        const start = { x: e.clientX, y: e.clientY };
        let lifted = null, timer = null, last = start, roll = 0;
        const scroller = host.querySelector('.gal-main') || body;
        const targetAt = (x, y) => {
          const el = document.elementFromPoint(x, y)?.closest?.('[data-drop-folder]');
          if (!el || !host.contains(el) && !el.closest('.crumbs')) return null;
          const to = el.getAttribute('data-drop-folder') || null;
          if (item.kind === 'folder' && (to === item.id || (to && F.isInside(app.settings, to, item.id)))) return null;
          if (item.kind === 'board' && to === F.folderOf(app.settings, item.id)) return null;
          if (item.kind === 'folder' && to === (F.folderPath(app.settings, item.id).slice(-2, -1)[0]?.id || null)) return null;
          return { el, to };
        };
        let over = null;
        const mark = (hit) => {
          if (over && (!hit || over.el !== hit.el)) over.el.classList.remove('drop-here');
          over = hit;
          if (over) over.el.classList.add('drop-here');
        };
        const lift = () => {
          const many = item.kind === 'board' ? movingWith(item.id).length : 1;
          lifted = h('div', { class: 'drag-ghost' }, h('span', { html: icon(item.kind === 'folder' ? 'folder' : 'board', 16), style: 'display:flex' }),
            many > 1 ? t('{n} boards', { n: many }) : item.name);
          document.body.appendChild(lifted);
          row.classList.add('lifted');
          host.classList.add('dragging');
          try { navigator.vibrate?.(15); } catch { /* no buzz on this device */ }
          place(last.x, last.y);
        };
        const place = (x, y) => {
          if (!lifted) return;
          lifted.style.left = x + 12 + 'px';
          lifted.style.top = y + 12 + 'px';
          mark(targetAt(x, y));
          const r = scroller.getBoundingClientRect();
          roll = y < r.top + 40 ? -8 : y > r.bottom - 40 ? 8 : 0;
        };
        const tick = () => { if (!lifted) return; if (roll) { scroller.scrollTop += roll; mark(targetAt(last.x, last.y)); } requestAnimationFrame(tick); };
        const stopScroll = (ev) => { if (lifted) ev.preventDefault(); };
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          last = { x: ev.clientX, y: ev.clientY };
          const far = Math.hypot(last.x - start.x, last.y - start.y);
          if (!lifted) {
            if (touchy) { if (far > 10) finish(); return; }     // a swipe: it was a scroll
            if (far > 6) { lift(); requestAnimationFrame(tick); }
            return;
          }
          place(last.x, last.y);
        };
        const finish = (ev) => {
          clearTimeout(timer);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', finish);
          document.removeEventListener('touchmove', stopScroll);
          if (!lifted) return;
          const hit = ev && ev.type === 'pointerup' ? targetAt(ev.clientX, ev.clientY) : null;
          mark(null);
          lifted.remove(); lifted = null;
          row.classList.remove('lifted');
          host.classList.remove('dragging');
          row._dragged = true;
          setTimeout(() => { row._dragged = false; }, 0);
          if (!hit) return;
          if (item.kind === 'board') { moveBoards(movingWith(item.id), hit.to); return; }
          if (!F.moveFolder(app.settings, item.id, hit.to)) return;
          keep();
          app.toast(t('Moved to {name}', { name: hit.to ? F.folderPath(app.settings, hit.to).pop().name : t('My boards') }), 'check');
          boards({ stay: true });
        };
        const up = (ev) => { if (ev.pointerId === e.pointerId) finish(ev); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', finish);
        document.addEventListener('touchmove', stopScroll, { passive: false });
        if (touchy) timer = setTimeout(() => { lift(); requestAnimationFrame(tick); }, 450);
      });
      // The long-press menu a phone would otherwise open over a held row.
      row.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    /*
     * Where should it go? Every folder, indented under the one it is in, with
     * the top level first. The place it already is, and - when a folder is
     * moving - that folder and everything inside it, cannot be chosen.
     * Resolves to a folder id, null for the top level, or undefined on cancel.
     */
    /** A colour for a folder: the palette, as a little dialog. Resolves to a colour or null. */
    function chooseColour(f) {
      return new Promise((resolve) => {
        const overlay = document.getElementById('overlay');
        const card = document.getElementById('overlayCard');
        card.innerHTML = '';
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; app._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
        const grid = h('div', { class: 'swatches folder-swatches' });
        for (const c of F.FOLDER_COLOURS) {
          const b = h('button', { class: 'sw' + (c === F.folderColour(f) ? ' on' : ''), title: c, 'data-folder-colour': c });
          b.style.background = c;
          b.addEventListener('click', () => done(c));
          grid.appendChild(b);
        }
        card.appendChild(h('h3', {}, t('Colour for “{name}”', { name: f.name })));
        card.appendChild(grid);
        card.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => done(null) }, t('Cancel'))));
        app.showOverlay(() => done(null));
      });
    }

    function chooseFolder(title, { moving = null, from = null } = {}) {
      return new Promise((resolve) => {
        const overlay = document.getElementById('overlay');
        const card = document.getElementById('overlayCard');
        card.innerHTML = '';
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; app._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
        const tree = h('div', { class: 'folder-tree' });
        const add = (id, name, depth) => {
          const blocked = (moving && id && (id === moving || F.isInside(app.settings, id, moving))) || id === (moving ? (F.folderPath(app.settings, moving).slice(-2, -1)[0]?.id || null) : from);
          const b = h('button', { class: 'board-row', 'data-choose': id || '', disabled: blocked || null, style: `padding-left:${10 + depth * 18}px` },
            h('span', { html: icon(id ? 'folder' : 'board', 18), style: 'display:flex;color:var(--accent-2)' }),
            h('span', { class: 'meta' }, h('b', {}, name), blocked && !(moving && id && (id === moving || F.isInside(app.settings, id, moving))) ? h('small', {}, t('It is here now')) : null));
          if (!blocked) b.addEventListener('click', () => done(id || null));
          tree.appendChild(b);
          if (id && moving && (id === moving)) return;          // nothing inside the one being moved
          for (const c of F.childFolders(app.settings, id)) add(c.id, c.name, depth + 1);
        };
        add(null, t('My boards'), 0);
        card.appendChild(h('h3', {}, title));
        card.appendChild(tree);
        card.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => done(undefined) }, t('Cancel'))));
        app.showOverlay(() => done(undefined));
      });
    }
  }

  async function boardsList(opts = {}) {
    // Re-drawing in place (after a move, a new folder, a step into a folder)
    // must not go through open(), which treats a second open as "close".
    if (!(opts && opts.stay && currentKey === 'boards' && document.getElementById('boardList'))) {
      open('boards', t('My boards'), () => h('div', { id: 'boardList' }, h('p', { style: 'color:var(--text-2)' }, t('Loading…'))));
    }
    const all = await window.board.boards.list();
    if (!all.some((b) => b.id === app.store.doc.id)) all.unshift({
      id: app.store.doc.id, name: app.store.doc.name, objects: app.store.count, modified: app.store.doc.modified
    });
    const host = document.getElementById('boardList');
    if (!host) return;
    if (F.pruneBoards(app.settings, all)) app.saveSettings();
    const here = app.boardFolder && F.folderPath(app.settings, app.boardFolder).length ? app.boardFolder : null;
    app.boardFolder = here;
    const list = F.boardsIn(app.settings, all, here);
    const go = (id) => { app.boardFolder = id || null; boards({ stay: true }); };
    const keep = () => { try { localStorage.setItem('gazboard.settings', JSON.stringify(app.settings)); } catch { /* storage refused */ } app.syncBoardPath?.(); };

    host.innerHTML = '';
    host.appendChild(h('button', { class: 'btn primary', style: 'width:100%;margin-bottom:8px', onclick: () => {
      app.command('board.new');
      // A new board is filed in the folder you are looking at.
      if (here) { F.moveBoard(app.settings, app.store.doc.id, here); keep(); }
      close();
    } }, t('+ New board')));
    host.appendChild(h('div', { style: 'display:flex;gap:8px;margin-bottom:14px' },
      h('button', { class: 'btn', style: 'flex:1', 'data-new-folder': '1', onclick: async () => {
        const name = await app.askText(t('New folder'), here
          ? t('Made inside “{name}”.', { name: F.folderPath(app.settings, here).pop().name })
          : t('A folder for a subject, a course or a term. Folders can hold folders.'),
        { value: '', placeholder: t('CSE221, Lectures, Spring 2026…'), ok: t('Create') });
        if (name === null || !String(name).trim()) return;
        F.createFolder(app.settings, name, here); keep(); boards({ stay: true });
      } }, t('+ New folder')),
      // Opening a .gazboard file had a keyboard shortcut and nothing to click,
      // which is no use to anyone who does not already know it is there.
      h('button', { class: 'btn', style: 'flex:1', onclick: () => { app.command('board.open'); close(); } }, t('Open a board file…'))));

    // The path: where you are, and every step back up. Each step is also a
    // place to drop a board or a folder.
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': t('Folder path') });
    const steps = [{ id: null, name: t('My boards') }, ...F.folderPath(app.settings, here)];
    steps.forEach((st, i) => {
      if (i) crumbs.appendChild(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'));
      const last = i === steps.length - 1;
      const c = h('button', { class: 'crumb' + (last ? ' here' : ''), 'data-drop-folder': st.id || '', title: st.name }, st.name);
      if (!last) c.addEventListener('click', () => go(st.id));
      crumbs.appendChild(c);
    });
    host.appendChild(crumbs);

    const chosen = new Set();
    const boxes = [];
    /*
     * A ticked board moves with all the other ticked ones. Moving a board that
     * is not ticked moves just that one, so a stray tick somewhere else never
     * drags half the list along with it.
     */
    const movingWith = (id) => (chosen.has(id) ? [...chosen] : [id]);
    const moveBoards = (ids, to) => {
      for (const id of ids) F.moveBoard(app.settings, id, to);
      keep();
      const where = to ? F.folderPath(app.settings, to).pop().name : t('My boards');
      app.toast(ids.length > 1 ? t('Moved {n} boards to {name}', { n: ids.length, name: where }) : t('Moved to {name}', { name: where }), 'check');
      boards({ stay: true });
    };
    const exportButton = h('button', { class: 'btn primary', disabled: true }, t('Export selected (0)'));
    const moveSelected = h('button', { class: 'btn', disabled: true, 'data-move-selected': '1' }, t('Move selected (0)…'));
    const selectAll = h('input', { type: 'checkbox', 'aria-label': t('Select all boards') });
    const syncChosen = () => {
      exportButton.disabled = !chosen.size;
      moveSelected.disabled = !chosen.size;
      moveSelected.textContent = t('Move selected ({n})…', { n: chosen.size });
      exportButton.textContent = chosen.size > 1
        ? t('Export selected ({n}) as ZIP…', { n: chosen.size })
        : t('Export selected ({n})…', { n: chosen.size });
      selectAll.checked = chosen.size === list.length && !!list.length;
      selectAll.indeterminate = chosen.size > 0 && chosen.size < list.length;
    };
    selectAll.addEventListener('change', () => {
      chosen.clear();
      for (const { input, id } of boxes) { input.checked = selectAll.checked; if (input.checked) chosen.add(id); }
      syncChosen();
    });
    exportButton.addEventListener('click', async () => {
      const ids = [...chosen];
      exportButton.disabled = true;
      selectAll.disabled = true;
      boxes.forEach(({ input }) => { input.disabled = true; });
      exportButton.textContent = t('Exporting…');
      try { await exportBoards(app, ids); }
      catch (e) { app.toast(e.message || t('Could not export the selected boards'), 'help', 6000); }
      finally {
        selectAll.disabled = false;
        boxes.forEach(({ input }) => { input.disabled = false; });
        syncChosen();
      }
    });

    /* -- folders here -- */
    const folders = F.childFolders(app.settings, here);
    for (const f of folders) {
      const n = F.folderCounts(app.settings, all, f.id);
      const what = [
        n.boards === 1 ? t('1 board') : t('{n} boards', { n: n.boards }),
        n.folders ? (n.folders === 1 ? t('1 folder') : t('{n} folders', { n: n.folders })) : null
      ].filter(Boolean).join(' · ');
      const row = h('button', { class: 'board-row folder-row', style: 'flex:1;min-width:0', 'data-folder': f.id, 'data-drop-folder': f.id },
        h('span', { html: icon('folder', 20), style: 'color:var(--accent-2);display:flex' }),
        h('span', { class: 'meta' }, h('b', {}, f.name), h('small', {}, what)),
        h('span', { class: 'icon-btn', title: t('Rename'), html: icon('text', 16), onclick: async (e) => {
          e.stopPropagation();
          const name = await app.askText(t('Rename folder'), '', { value: f.name, placeholder: f.name, ok: t('Save') });
          if (name === null || !String(name).trim()) return;
          F.renameFolder(app.settings, f.id, name); keep(); boards({ stay: true });
        } }),
        h('span', { class: 'icon-btn', title: t('Move to…'), html: icon('folderMove', 16), 'data-move': f.id, onclick: async (e) => {
          e.stopPropagation();
          const to = await chooseFolder(t('Move “{name}” to…', { name: f.name }), { moving: f.id, from: here });
          if (to === undefined) return;
          if (!F.moveFolder(app.settings, f.id, to)) { app.toast(t('A folder cannot go inside itself'), 'help'); return; }
          keep(); boards({ stay: true });
        } }),
        h('span', { class: 'icon-btn', title: t('Delete folder'), html: icon('trash', 16), onclick: async (e) => {
          e.stopPropagation();
          const inside = n.boards || n.folders;
          const ok = await app.confirm(t('Delete folder?'), inside
            ? t('“{name}” goes, but nothing in it is deleted: its boards and folders move up a level.', { name: f.name })
            : t('“{name}” is empty and will be removed.', { name: f.name }), t('Delete folder'));
          if (!ok) return;
          F.deleteFolder(app.settings, f.id); keep(); boards({ stay: true });
        } })
      );
      row.addEventListener('click', () => { if (!row._dragged) go(f.id); });
      pickUp(row, { kind: 'folder', id: f.id, name: f.name });
      host.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('span', { style: 'display:block;min-width:40px' }), row));
    }

    host.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0' },
      h('label', { style: 'display:flex;align-items:center;gap:8px;min-height:44px' }, selectAll, t('Select all')), exportButton, moveSelected));
    moveSelected.addEventListener('click', async () => {
      const ids = [...chosen];
      if (!ids.length) return;
      const to = await chooseFolder(t('Move {n} boards to…', { n: ids.length }), { from: here });
      if (to === undefined) return;
      moveBoards(ids, to);
    });
    host.appendChild(h('p', { style: 'font-size:12px;color:var(--text-2)' },
      t('Choose boards to export. One saves as a .gazboard file; several save together in a ZIP. Extract the ZIP to open its boards.')));
    if (!list.length && !folders.length) host.appendChild(h('p', { style: 'color:var(--text-2);font-size:13px' },
      here ? t('This folder is empty. Make a new board here, or move boards in with “Move to…” or by dragging them onto it.') : t('No saved boards yet.')));
    if (all.length > 1 && !F.folderList(app.settings).length) host.appendChild(h('p', { style: 'font-size:12px;color:var(--text-2)' },
      t('Tip: + New folder files boards by subject. Hold a board and drag it onto a folder, or use its “Move to…” button.')));

    // Every board this app has ever saved is a plain file in one folder. Showing
    // people where, and letting them open it, is worth more than any reassurance
    // in a settings screen.
    window.board.info().then((i) => {
      if (!document.getElementById('boardList')) return;
      if (i.electron) {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, all.length === 1
            ? t('{n} board, saved on this computer at:', { n: all.length })
            : t('{n} boards, saved on this computer at:', { n: all.length })),
          h('code', { style: 'font-size:11px;display:block;margin:4px 0 8px;word-break:break-all' }, i.boardsDir || i.userData + '/boards'),
          h('button', { class: 'btn', style: 'width:100%', onclick: () => {
            if (window.board.openBoardsFolder) window.board.openBoardsFolder();
            else window.board.showItem(i.boardsDir || i.userData + '/boards');
          } }, t('Open that folder')));
        host.appendChild(foot);
      } else if (i.isAndroid) {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, all.length === 1
            ? t('{n} board, saved in GazBoard’s private storage on this Android device.', { n: all.length })
            : t('{n} boards, saved in GazBoard’s private storage on this Android device.', { n: all.length })),
          h('p', {}, t('Boards and images save automatically and reopen here. Android’s Files app cannot browse this private folder.')),
          h('p', {}, t('Select boards above to export them with their images. Choose Downloads, Documents or another location in the Android file picker.')),
          h('p', {}, t('Uninstalling GazBoard or clearing its app storage deletes these local boards. Export copies you want to keep; exports are separate from autosave.')),
          h('button', { class: 'btn', style: 'width:100%', onclick: () => { app.command('board.save'); close(); } }, t('Save current board…')));
        host.appendChild(foot);
      } else {
        const foot = h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12px;color:var(--text-2);line-height:1.6' },
          h('div', {}, all.length === 1
            ? t('{n} board, stored in browser persistence:', { n: all.length })
            : t('{n} boards, stored in browser persistence:', { n: all.length })),
          h('code', { style: 'font-size:11px;display:block;margin:4px 0 8px;word-break:break-all' }, i.userData));
        host.appendChild(foot);
      }
    });

    /* -- boards here -- */
    for (const b of list) {
      const input = h('input', { type: 'checkbox', 'aria-label': t('Export {name}', { name: b.name || t('Untitled board') }) });
      boxes.push({ input, id: b.id });
      input.addEventListener('change', () => {
        if (input.checked) chosen.add(b.id); else chosen.delete(b.id);
        syncChosen();
      });
      const row = h('button', { class: 'board-row', style: 'flex:1;min-width:0', 'data-board': b.id },
        h('span', { html: icon('board', 20), style: 'color:var(--text-2);display:flex' }),
        h('span', { class: 'meta' },
          h('b', {}, b.name || t('Untitled board')),
          h('small', {}, b.objects === 1
            ? t('{n} item · {date}', { n: b.objects, date: new Date(b.modified).toLocaleString() })
            : t('{n} items · {date}', { n: b.objects, date: new Date(b.modified).toLocaleString() }))),
        h('span', { class: 'icon-btn', title: t('Move to…'), html: icon('folderMove', 16), 'data-move': b.id, onclick: async (e) => {
          e.stopPropagation();
          const ids = movingWith(b.id);
          const to = await chooseFolder(ids.length > 1 ? t('Move {n} boards to…', { n: ids.length }) : t('Move “{name}” to…', { name: b.name || t('Untitled board') }), { from: here });
          if (to === undefined) return;
          moveBoards(ids, to);
        } }),
        h('span', { class: 'icon-btn', title: t('Delete'), html: icon('trash', 16), onclick: async (e) => { e.stopPropagation(); if (await app.confirm(t('Delete board?'), t('"{name}" will be permanently removed.', { name: b.name }), t('Delete'))) { await app.deleteBoard(b.id); boards({ stay: true }); } } })
      );
      row.addEventListener('click', async () => {
        if (row._dragged) return;
        const data = await window.board.boards.load(b.id);
        if (data) { await app.loadBoard(data); close(); }
      });
      pickUp(row, { kind: 'board', id: b.id, name: b.name || t('Untitled board') });
      host.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('label', { style: 'display:grid;place-items:center;min-width:40px;min-height:48px' }, input), row));
    }

    /*
     * Pick a row up and drop it on a folder.
     *
     * A mouse drags at once - press, move, drop - like a file in Explorer. A
     * finger or a pen has to HOLD first, for about half a second, because
     * moving straight away is how a list is scrolled; only a steady hold lifts
     * the row, with a buzz where the device can. While something is lifted the
     * list does not scroll under the finger, except at its top and bottom
     * edges, where it rolls along so a folder off screen can still be reached.
     * Letting go anywhere but a folder puts it back where it was.
     */
    function pickUp(row, item) {
      row.style.touchAction = 'pan-y';
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.icon-btn')) return;
        const touchy = e.pointerType !== 'mouse';
        const start = { x: e.clientX, y: e.clientY };
        let lifted = null, timer = null, last = start, roll = 0;
        const scroller = body;
        const targetAt = (x, y) => {
          const el = document.elementFromPoint(x, y)?.closest?.('[data-drop-folder]');
          if (!el || !host.contains(el) && !el.closest('.crumbs')) return null;
          const to = el.getAttribute('data-drop-folder') || null;
          if (item.kind === 'folder' && (to === item.id || (to && F.isInside(app.settings, to, item.id)))) return null;
          if (item.kind === 'board' && to === F.folderOf(app.settings, item.id)) return null;
          if (item.kind === 'folder' && to === (F.folderPath(app.settings, item.id).slice(-2, -1)[0]?.id || null)) return null;
          return { el, to };
        };
        let over = null;
        const mark = (hit) => {
          if (over && (!hit || over.el !== hit.el)) over.el.classList.remove('drop-here');
          over = hit;
          if (over) over.el.classList.add('drop-here');
        };
        const lift = () => {
          const many = item.kind === 'board' ? movingWith(item.id).length : 1;
          lifted = h('div', { class: 'drag-ghost' }, h('span', { html: icon(item.kind === 'folder' ? 'folder' : 'board', 16), style: 'display:flex' }),
            many > 1 ? t('{n} boards', { n: many }) : item.name);
          document.body.appendChild(lifted);
          row.classList.add('lifted');
          host.classList.add('dragging');
          try { navigator.vibrate?.(15); } catch { /* no buzz on this device */ }
          place(last.x, last.y);
        };
        const place = (x, y) => {
          if (!lifted) return;
          lifted.style.left = x + 12 + 'px';
          lifted.style.top = y + 12 + 'px';
          mark(targetAt(x, y));
          const r = scroller.getBoundingClientRect();
          roll = y < r.top + 40 ? -8 : y > r.bottom - 40 ? 8 : 0;
        };
        const tick = () => { if (!lifted) return; if (roll) { scroller.scrollTop += roll; mark(targetAt(last.x, last.y)); } requestAnimationFrame(tick); };
        const stopScroll = (ev) => { if (lifted) ev.preventDefault(); };
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          last = { x: ev.clientX, y: ev.clientY };
          const far = Math.hypot(last.x - start.x, last.y - start.y);
          if (!lifted) {
            if (touchy) { if (far > 10) finish(); return; }     // a swipe: it was a scroll
            if (far > 6) { lift(); requestAnimationFrame(tick); }
            return;
          }
          place(last.x, last.y);
        };
        const finish = (ev) => {
          clearTimeout(timer);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', finish);
          document.removeEventListener('touchmove', stopScroll);
          if (!lifted) return;
          const hit = ev && ev.type === 'pointerup' ? targetAt(ev.clientX, ev.clientY) : null;
          mark(null);
          lifted.remove(); lifted = null;
          row.classList.remove('lifted');
          host.classList.remove('dragging');
          row._dragged = true;
          setTimeout(() => { row._dragged = false; }, 0);
          if (!hit) return;
          if (item.kind === 'board') { moveBoards(movingWith(item.id), hit.to); return; }
          if (!F.moveFolder(app.settings, item.id, hit.to)) return;
          keep();
          app.toast(t('Moved to {name}', { name: hit.to ? F.folderPath(app.settings, hit.to).pop().name : t('My boards') }), 'check');
          boards({ stay: true });
        };
        const up = (ev) => { if (ev.pointerId === e.pointerId) finish(ev); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', finish);
        document.addEventListener('touchmove', stopScroll, { passive: false });
        if (touchy) timer = setTimeout(() => { lift(); requestAnimationFrame(tick); }, 450);
      });
      // The long-press menu a phone would otherwise open over a held row.
      row.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    /*
     * Where should it go? Every folder, indented under the one it is in, with
     * the top level first. The place it already is, and - when a folder is
     * moving - that folder and everything inside it, cannot be chosen.
     * Resolves to a folder id, null for the top level, or undefined on cancel.
     */
    function chooseFolder(title, { moving = null, from = null } = {}) {
      return new Promise((resolve) => {
        const overlay = document.getElementById('overlay');
        const card = document.getElementById('overlayCard');
        card.innerHTML = '';
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; app._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
        const tree = h('div', { class: 'folder-tree' });
        const add = (id, name, depth) => {
          const blocked = (moving && id && (id === moving || F.isInside(app.settings, id, moving))) || id === (moving ? (F.folderPath(app.settings, moving).slice(-2, -1)[0]?.id || null) : from);
          const b = h('button', { class: 'board-row', 'data-choose': id || '', disabled: blocked || null, style: `padding-left:${10 + depth * 18}px` },
            h('span', { html: icon(id ? 'folder' : 'board', 18), style: 'display:flex;color:var(--accent-2)' }),
            h('span', { class: 'meta' }, h('b', {}, name), blocked && !(moving && id && (id === moving || F.isInside(app.settings, id, moving))) ? h('small', {}, t('It is here now')) : null));
          if (!blocked) b.addEventListener('click', () => done(id || null));
          tree.appendChild(b);
          if (id && moving && (id === moving)) return;          // nothing inside the one being moved
          for (const c of F.childFolders(app.settings, id)) add(c.id, c.name, depth + 1);
        };
        add(null, t('My boards'), 0);
        card.appendChild(h('h3', {}, title));
        card.appendChild(tree);
        card.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => done(undefined) }, t('Cancel'))));
        app.showOverlay(() => done(undefined));
      });
    }
  }

  function refresh() { app.surface.invalidate(); }

  /** A font pack arrived or went: the Settings row redraws itself. */
  function fontsChanged() { if (currentKey === 'settings') rerender(); }

  /** My boards, drawn again if it is up - boards and folders changed underneath it. */
  const boardsChanged = () => { if (currentKey === 'boards') boards({ stay: true }); };
  return { templates, background, settings, sharing, boards, close, syncChanged, fontsChanged, boardsChanged, refreshStorage() { if (currentKey === 'settings') rerender(); else if (currentKey === 'boards') boards({ stay: true }); }, get open() { return !!currentKey; }, get page() { return currentKey === 'boards' && panel.classList.contains('page'); } };
}
