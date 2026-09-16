// Small compatibility fixes kept out of the drawing core: page pads behave like
// documents when they fit the window, and each physical-looking pen in the tray
// remembers the colour/effect the user gave it.

import { PENS, penIcon } from './ui/palettes.js';
import { openToolPopover } from './ui/toolbar.js';
import { closePopover, isOpen } from './ui/popover.js';
import { stripBounds } from './core/pages.js';

function penById(id) { return PENS.find((p) => p.id === id) || null; }

function slot(settings, pen) {
  const saved = settings.penSlots?.[pen.id];
  return {
    color: typeof saved?.color === 'string' ? saved.color : pen.color,
    effect: typeof saved?.effect === 'string' ? saved.effect : pen.effect
  };
}

function activePenId(settings) {
  if (penById(settings.activePenId)) return settings.activePenId;
  const exact = PENS.find((p) => p.color === settings.penColor && p.effect === settings.penEffect);
  return exact?.id || PENS[0]?.id || null;
}

function rememberCurrentPen(settings) {
  const id = activePenId(settings);
  const pen = penById(id);
  if (!pen) return;
  const slots = settings.penSlots && typeof settings.penSlots === 'object'
    ? settings.penSlots : (settings.penSlots = {});
  slots[id] = {
    color: typeof settings.penColor === 'string' ? settings.penColor : pen.color,
    effect: typeof settings.penEffect === 'string' ? settings.penEffect : pen.effect
  };
  settings.activePenId = id;
}

function choosePen(app, pen, anchor = null) {
  const s = app.settings;
  const held = app.tool === 'pen' && activePenId(s) === pen.id;
  rememberCurrentPen(s);
  const next = slot(s, pen);
  s.activePenId = pen.id;
  s.penColor = next.color;
  s.penEffect = next.effect;
  app.saveSettings();
  app.setTool('pen');
  app.syncUI();
  if (held && anchor) openToolPopover(app, anchor, 'pen');
  else closePopover();
}

function syncPenTray(app) {
  const bar = document.getElementById('toolbar');
  if (!bar) return;
  const s = app.settings;
  const active = activePenId(s);
  for (const button of bar.querySelectorAll('.pen[data-pen]')) {
    const pen = penById(button.dataset.pen);
    if (!pen) continue;
    const p = slot(s, pen);
    const paint = `${p.color}|${p.effect}`;
    if (button.dataset.rememberedPaint !== paint) {
      const hasKey = !!button.querySelector('.kbd');
      const key = hasKey ? `<span class="kbd">${PENS.indexOf(pen) + 1}</span>` : '';
      button.innerHTML = penIcon(p.color, p.effect) + '<span class="size-dot"></span>' + key;
      button.dataset.rememberedPaint = paint;
    }
    button.classList.toggle('active', app.tool === 'pen' && active === pen.id);
    button.title = `Pen ${PENS.indexOf(pen) + 1} — ${p.effect === 'none' ? p.color : p.effect}; click again for options`;
  }
}

function installPenMemory(app) {
  const s = app.settings;
  // Carry an existing pre-slot custom colour into the currently inferred pen,
  // so an upgrade never resets a deliberate choice.
  rememberCurrentPen(s);

  const originalSync = app.syncUI.bind(app);
  app.syncUI = (...args) => {
    const result = originalSync(...args);
    syncPenTray(app);
    return result;
  };
  syncPenTray(app);

  const bar = document.getElementById('toolbar');
  bar?.addEventListener('click', (e) => {
    const button = e.target instanceof Element ? e.target.closest('.pen[data-pen]') : null;
    if (!button || !bar.contains(button)) return;
    const pen = penById(button.dataset.pen);
    if (!pen) return;
    // The old target listener would put the factory colour back. Own the click
    // here instead, before it reaches that listener.
    e.preventDefault();
    e.stopImmediatePropagation();
    choosePen(app, pen, button);
  }, true);

  // The compact phone/tablet tray puts pens 4–6 in the "More pens" popover.
  // They are not persistent toolbar buttons, so recognise those rows while the
  // popover is open and route them through the same slot picker.
  document.addEventListener('click', (e) => {
    if (!isOpen('pens')) return;
    const row = e.target instanceof Element ? e.target.closest('.menu-item') : null;
    if (!row) return;
    const label = row.textContent.trim();
    const pen = PENS.find((p) => label === p.label);
    if (!pen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    choosePen(app, pen);
  }, true);

  // A colour/effect button inside the pen popover changes the global pen
  // settings in toolbar.js. After that click finishes, save the result back to
  // the active physical pen slot too.
  document.addEventListener('click', () => {
    if (!isOpen('tool:pen')) return;
    queueMicrotask(() => {
      rememberCurrentPen(app.settings);
      app.saveSettings();
      syncPenTray(app);
    });
  }, true);

  // App's built-in 1–6 handler still points at factory colours. Capture the
  // numbers first so keyboard users get the same remembered pens as click/tap.
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    const tag = String(target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key < '1' || e.key > String(PENS.length)) return;
    const pen = PENS[Number(e.key) - 1];
    if (!pen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    choosePen(app, pen);
    app.toast?.(`Pen ${Number(e.key)}`, 'pen');
  }, true);
}

function centerFinitePages(surface) {
  const pages = surface.store?.doc?.pages;
  if (!pages?.length || !surface.width || !surface.cam) return false;
  const b = stripBounds(pages);
  if (!b || b.w * surface.cam.z > surface.width) return false;
  const x = surface.width / 2 - (b.x + b.w / 2) * surface.cam.z;
  if (Math.abs(surface.cam.x - x) < 0.01) return false;
  surface.cam.x = x;
  return true;
}

function installFinitePagePanGuard(app) {
  const surface = app.surface;
  const originalClamp = surface.clampCamera.bind(surface);
  surface.clampCamera = () => {
    originalClamp();
    centerFinitePages(surface);
  };

  const originalResize = surface.onResize;
  surface.onResize = (w, h) => {
    originalResize?.(w, h);
    surface.clampCamera();
    surface.invalidate();
  };

  // Loading/switching a board changes pages without necessarily moving the
  // camera. A cheap centre check after a document change keeps reopened pads
  // from inheriting a useless sideways offset.
  app.store.subscribe(() => {
    if (centerFinitePages(surface)) surface.invalidate();
  });

  surface.clampCamera();
  surface.invalidate();
}

function install() {
  const app = window.app;
  if (!app || app.__feedbackFixesInstalled) return;
  app.__feedbackFixesInstalled = true;
  installFinitePagePanGuard(app);
  installPenMemory(app);
  app.syncUI();
}

// app.js registers its DOMContentLoaded listener before this module is loaded,
// so App exists by the time this listener runs. The readyState branch keeps the
// module safe if it is imported manually by a test or a dev console later.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install);
  else install();
}

export { centerFinitePages };
