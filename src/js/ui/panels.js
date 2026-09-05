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
    const named = fw.tool === 'ufw' ? 'ufw'
      : fw.tool === 'firewalld' ? 'firewalld'
        : fw.tool === 'macOS firewall' ? 'the macOS firewall'
          : 'Windows Firewall';
    // Only Windows can be repaired from in here, and the answer comes from the
    // main process rather than being inferred from which fields turned up.
    const canFix = fw.repairable === true;

    const showHelp = () => app.showFirewallHelp('failed');

    if (fw.state === 'unknown') {
      return h('div', {},
        banner('warn', `GazBoard could not read ${named} on this computer, so it cannot say whether other `
          + 'machines can reach you.'
          + (fw.detail ? ' ' + fw.detail.charAt(0).toUpperCase() + fw.detail.slice(1) + '.' : '')
          + ' If nobody can, the commands to open the way are here.',
        smallBtn('Show the commands', showHelp, true)),
        programLine(fw),
        h('div', {}, smallBtn('Check again', () => checkFirewall(host))));
    }

    const fix = async () => {
      app.toast('Windows will ask for permission to change the firewall', 'help', 5000);
      let r = null;
      try { r = await window.board.sync.firewall.repair(); }
      catch (e) { r = { ok: false, reason: 'failed', detail: e.message }; }
      fwInfo = (r && r.after) || fwInfo;
      if (r && r.ok) app.toast('Other computers can reach GazBoard now');
      else if (r && r.reason === 'cancelled') app.showFirewallHelp('cancelled');
      else app.showFirewallHelp('failed');
      if (host.isConnected) renderSync(host);
    };

    // The action offered depends on whether this machine can be changed from
    // in here. Same banner, same wording up to the last sentence.
    const actions = (verb) => canFix
      ? [' GazBoard can do that: Windows will ask you to confirm once.',
        smallBtn(verb, fix, true),
        smallBtn('Show me the commands instead', showHelp)]
      : [' GazBoard will not change your firewall by itself here - it would need your password, and '
        + 'handing that to an app to run a command you have not seen is a bad habit to teach. '
        + 'The two lines that do it are one click away.',
      smallBtn('Show me the commands', showHelp, true)];

    const kids = [];

    if (fw.state === 'off') {
      kids.push(banner('good', fw.tool === 'none'
        ? 'No firewall is running on this computer, so nothing is standing between you and the other machines.'
        : `${named.charAt(0).toUpperCase() + named.slice(1)} is switched off, so nothing is standing between `
          + 'you and the other machines.'));
    } else if (fw.state === 'blocked') {
      kids.push(banner('bad',
        h('b', {}, `${named.charAt(0).toUpperCase() + named.slice(1)} is blocking this.`),
        fw.blockAll
          ? ' It is set to refuse every incoming connection, whatever the app - so no board can reach this '
            + 'computer until that is changed in System Settings under Network, Firewall.'
          : ' Somewhere along the way its "allow this app?" question was answered with no - or closed, '
            + 'which counts as no - and it wrote a rule that turns away every board sent to this computer. '
            + 'A block always wins over an allow, so it has to be removed rather than overruled.',
        ...(fw.blockAll ? [] : actions('Fix it'))));
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
        h('b', {}, 'Other computers are already reaching this one.'),
        ` GazBoard cannot find a ${named} rule naming this program, but something is clearly letting `
        + 'them in - a rule opening the ports, or one your administrator set. Nothing needs doing '
        + 'unless a board actually fails to arrive.',
        smallBtn('Allow this program too', canFix ? fix : showHelp)));
    } else if (fw.state === 'no-rule') {
      kids.push(banner('warn',
        h('b', {}, `Nothing has been allowed through ${named} yet.`),
        ` ${named.charAt(0).toUpperCase() + named.slice(1)} turns away incoming connections unless a rule `
        + 'says otherwise, so other computers can probably see this one in their list and still fail to '
        + 'send it anything.'
        + (canFix ? ' If Windows has not asked you yet, it will the first time somebody tries. You can '
          + 'settle it now instead.' : ''),
        ...actions('Allow it now')));
    } else if (fw.state === 'allowed') {
      const good = banner('good', fw.viaPorts
        ? `${named.charAt(0).toUpperCase() + named.slice(1)} is letting other computers reach GazBoard `
          + `through ports ${fw.ports.boards} and ${fw.ports.discovery}`
          + (fw.portRules && fw.portRules.length ? ` — “${fw.portRules[0]}”.` : '.')
          + ' That is a rule about the ports rather than about this program, which works just as well.'
        : `${named.charAt(0).toUpperCase() + named.slice(1)} is letting other computers reach GazBoard`
          + (canFix ? ' on your private and work networks.' : '.'));
      if (canFix && fw.ours > 0 && !fw.viaPorts) {
        good.appendChild(h('div', {},
          smallBtn('Remove that permission', async () => {
            if (!await app.confirm('Remove the firewall permission?',
              'Other computers will stop being able to send you boards until it is allowed again. '
              + 'Windows will ask you to confirm.', 'Remove it')) return;
            let r = null;
            try { r = await window.board.sync.firewall.remove(); }
            catch { r = { ok: false }; }
            fwInfo = (r && r.after) || null;
            app.toast(r && r.ok ? 'Firewall permission removed' : 'Nothing was changed', r && r.ok ? 'check' : 'help');
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
        h('b', {}, 'Windows has this network marked as Public.'),
        ' GazBoard only ever asks to be reachable on private and work networks, never on a public one - '
        + 'a café or an airport is not somewhere to leave a door open. Nobody will be able to reach you '
        + 'here until this network is marked private, in Windows Settings under Network & internet.'));
    }

    kids.push(programLine(fw));
    kids.push(h('div', {}, smallBtn('Check again', () => checkFirewall(host))));
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
    }, 'This is about ' + fw.program);
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
          h('b', {}, 'Sharing could not start.'), ' ' + why,
          smallBtn('Try again', async () => { await app.startSync(); renderSync(host); }, true)));
      } else {
        host.appendChild(dim('Starting…'));
      }
      return;
    }

    // The name is what everyone else in the room sees in their list, so it is
    // worth being able to change - but through a dialog rather than a live
    // text box, because this block redraws itself whenever a device appears
    // or disappears and would eat what you were halfway through typing.
    host.appendChild(h('div', { style: 'display:flex;gap:8px;align-items:flex-start' },
      h('div', { style: 'flex:1;min-width:0' },
        dim(`Others see this computer as “${st.deviceName}”. Listening on port ${st.port}.`)),
      h('button', {
        class: 'btn', style: 'padding:3px 9px;font-size:12px;flex:none',
        onclick: async () => {
          const name = await app.promptText('Name this computer',
            'This is the name other people pick from when they send you a board.',
            { value: st.deviceName, confirmLabel: 'Rename' });
          if (!name) return;
          await window.board.sync.setName(name);
          renderSync(host);
        }
      }, 'Rename')));
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
      }, `Something else is using port ${st.discoveryPort || 53319}, so this computer cannot announce `
        + 'itself and will not appear in anyone else\'s list - nor they in yours. Handing boards across '
        + 'still works: use "Add a computer by address" below, on both machines.'));
    }
    if (st.unusualPort) {
      // Somebody else has the usual port - almost always a second copy of
      // GazBoard. Discovery still works; typing an address will not, and that
      // failure is otherwise completely silent.
      host.appendChild(h('div', {
        style: 'font-size:12px;line-height:1.6;margin-top:6px;padding:8px 10px;border-radius:6px;'
          + 'background:rgba(255,185,0,.12);border:1px solid rgba(255,185,0,.4)'
      }, `Something else is using port ${st.expectedPort}, so this is on ${st.port} instead - most likely `
        + 'another copy of GazBoard already running. Other computers can still find this one in their list, '
        + 'but adding it by address will not work until that copy is closed.'));
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

    host.appendChild(h('h5', { style: 'margin:16px 0 8px' }, 'Computers on this network'));

    if (!seen.length) {
      host.appendChild(dim('Nothing found yet. The other computer needs GazBoard open with sharing switched '
        + 'on, on the same wifi. If it never appears, a firewall is blocking the announcement - you can still '
        + 'add it by its address below.'));
    }

    for (const p of seen) host.appendChild(deviceRow(p, host));

    if (away.length) {
      host.appendChild(h('h5', { style: 'margin:16px 0 8px' }, 'Paired, but not switched on right now'));
      for (const r of away) host.appendChild(deviceRow({ ...r, paired: true, offline: true }, host));
    }

    host.appendChild(h('button', {
      class: 'btn primary', style: 'width:100%;margin-top:14px',
      onclick: () => app.showPairingCode()
    }, 'Show my pairing code'));

    host.appendChild(h('button', {
      class: 'btn', style: 'width:100%;margin-top:8px',
      onclick: async () => {
        const addr = await app.promptText('Add a computer by address',
          'Type the address the other computer shows under its own name - four numbers with dots, '
          + 'like 192.168.0.243. Use this when it never turns up in the list by itself.',
          { placeholder: '192.168.0.243', confirmLabel: 'Look for it' });
        if (!addr) return;
        const r = await window.board.sync.addByAddress(addr);
        if (r && r.ok && r.peer) { app.toast('Found ' + r.peer.name); renderSync(host); }
        else app.toast('Nothing answered at that address: ' + ((r && r.error) || 'no answer'), 'help', 7000);
      }
    }, 'Add a computer by address…'));

    const temporary = (st.paired || []).filter((r) => !r.remember);
    if (temporary.length) {
      host.appendChild(h('button', {
        class: 'btn', style: 'width:100%;margin-top:8px',
        onclick: async () => {
          const n = await window.board.sync.endSession();
          app.toast(n === 1 ? 'Forgot one computer' : 'Forgot ' + n + ' computers');
          renderSync(host);
        }
      }, `End this session (forget ${temporary.length} temporary pairing${temporary.length === 1 ? '' : 's'})`));
      host.appendChild(dim('Closing GazBoard does this by itself.'));
    }
  }

  function deviceRow(p, host) {
    const line = [];
    if (p.address) line.push(p.address);
    line.push(p.paired ? 'paired' : 'not paired yet');
    if (p.paired && p.fingerprint) line.push(p.fingerprint);
    if (p.paired && p.remember === false) line.push('just for now');

    const actions = h('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' });

    if (!p.paired) {
      actions.appendChild(h('button', {
        class: 'btn primary', style: 'padding:4px 10px;font-size:12.5px',
        onclick: async () => {
          const code = await app.promptText('Pair with ' + p.name,
            'That computer shows a pairing code under Settings › Share on this network. Type it here.',
            { placeholder: 'ABCD-2345', uppercase: true, confirmLabel: 'Pair' });
          if (!code) return;
          const r = await window.board.sync.pairWith(p, code);
          if (r && r.ok) {
            app.toast('Paired with ' + (r.device.name || p.name) + ' · ' + r.device.fingerprint, 'check', 6000);
            renderSync(host);
          } else app.toast(('' + ((r && r.error) || 'pairing failed')), 'help', 7000);
        }
      }, 'Pair…'));
    } else {
      if (!p.offline) {
        actions.appendChild(h('button', {
          class: 'btn primary', style: 'padding:4px 10px;font-size:12.5px',
          onclick: () => app.sendCurrentBoardTo(p)
        }, 'Send this board'));
      }
      actions.appendChild(h('button', {
        class: 'btn', style: 'padding:4px 10px;font-size:12.5px',
        onclick: async () => {
          if (!await app.confirm('Forget ' + p.name + '?',
            'Both computers stop being paired, and either of you has to pair again before a board '
            + 'can go either way.', 'Forget it')) return;
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
            ? p.name + ' has been told, and you are unpaired on both'
            : 'Forgotten here. ' + p.name + ' was not reachable, so it will find out '
              + 'the next time it tries to send you something', r && r.told ? 'check' : 'help',
          r && r.told ? 3000 : 7000);
          renderSync(host);
        }
      }, 'Forget'));
    }

    return h('div', {
      style: 'border:1px solid var(--stroke);border-radius:8px;padding:10px 12px;margin-bottom:8px'
        + (p.offline ? ';opacity:.65' : '')
    },
    h('div', { style: 'font-size:13.5px;font-weight:600;overflow-wrap:anywhere' }, p.name || 'Unknown device'),
    dim(line.join(' · ')),
    actions);
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
        // Only the desktop build has this at all; the web build's preload has
        // no sync, and an empty section explaining a feature that cannot exist
        // there would be worse than no section.
        (window.board && window.board.sync) ? h('div', { class: 'section' },
          h('h5', {}, 'Share on this network'),
          row('Share boards on this network', mkToggle(() => s.sync === true, async (v) => {
            s.sync = v;
            if (v) {
              // A switch that stays on after the thing behind it failed to
              // start is a lie the person then has to discover for themselves.
              const up = await app.startSync();
              if (!up) { s.sync = false; app.saveSettings(); }
            } else {
              try { await window.board.sync.stop(); app.toast('Sharing switched off'); }
              catch { /* it was not running anyway */ }
              app.syncStartError = null;
            }
            rerender();
          }),
            'Off unless you switch it on. When it is on, this computer says hello to other GazBoards on the '
            + 'same wifi so you can hand a board straight across - no account, no internet, nothing leaves the '
            + 'room. Windows may ask once whether to allow it through the firewall; say yes for private '
            + 'networks or nobody will be able to reach you. Nothing is ever saved without you being asked first.'),
          row('When a board arrives', mkChoice(
            [[true, 'Open it'], [false, 'Just file it']],
            () => s.syncOpenOnArrival !== false,
            (v) => { s.syncOpenOnArrival = v; app.saveSettings(); rerender(); }
          ), s.syncOpenOnArrival !== false
            ? 'Once you accept a board it opens straight away, which is what you want between your own '
              + 'machines. If several arrive at once only the last one opens - the rest are filed, so you '
              + 'are not watching boards flash past.'
            : 'Accepted boards are filed in My boards and you carry on with what you were doing. Right for '
              + 'a class handing work in. The one exception is replacing a board you have open: that always '
              + 'reloads, or you would be looking at the copy it just replaced.'),
          s.sync ? syncBlock() : null
        ) : null,
        h('div', { class: 'section' },
          h('h5', {}, 'Board'),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.new'); close(); } }, 'New board'),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.open'); close(); } }, 'Open a board file…'),
          h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: () => { app.command('board.save'); close(); } }, 'Save a copy…'),
          h('button', { class: 'btn danger', style: 'width:100%', onclick: () => app.command('edit.clear') }, 'Clear this canvas')
        ),
        h('div', { class: 'section' }, h('h5', {}, 'About'), info,
          h('p', { style: 'font-size:12px;color:var(--text-2);margin-top:10px;line-height:1.6' },
            'Everything stays on this device. There is no sign-in, no account and no cloud: your boards are files in a folder on this computer. The one thing that ever reaches another machine is a board you hand it yourself, over your own wifi, with sharing switched on above — and even then it goes straight from here to there, never through anybody\'s server.'))
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

  return { templates, background, settings, boards, close, syncChanged, get open() { return !!currentKey; } };
}
