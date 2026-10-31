// Presenting: the board and nothing else.
//
// A lesson projected from a laptop spends a fifth of the screen on the top
// bar, the page bar, the zoom bar and the toolbar - none of which the class
// needs to see. Presenting takes all of it away, fills the screen where the
// machine allows it, and turns the page keys (and a clicker, which sends the
// same keys) into "next page".
//
// The tools are only tucked away, not taken away. Bring the pointer to the
// bottom edge and the toolbar slides back up; the small bar in the corner
// has a button that keeps it up, for a touchscreen with no pointer to hover.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

/** How close to the bottom edge the pointer has to come to call the tools up. */
export const TOOLS_EDGE = 90;

export function initPresentBar(app) {
  const stage = document.getElementById('stage');
  if (!stage || document.getElementById('presentbar')) return;
  const btn = (key, title, ic) => {
    const b = h('button', { title, 'aria-label': title, html: icon(ic, 18) });
    b.dataset.present = key;
    return b;
  };
  const prev = btn('prev', t('Previous page (Page Up)'), 'back');
  const next = btn('next', t('Next page (Page Down)'), 'chevronRight');
  const label = h('span', { id: 'presentLabel' });
  const tools = btn('tools', t('Show the tools'), 'pen');
  const timer = btn('timer', t('Class timer'), 'timer');
  const spot = btn('spotlight', t('Spotlight (Ctrl+Alt+S)'), 'laser');
  const wheel = btn('spinner', t('Spinner wheel'), 'spinner');
  const exit = btn('exit', t('Stop presenting (Esc)'), 'close');
  const bar = h('div', { id: 'presentbar', hidden: true }, prev, label, next, tools, timer, spot, wheel, exit);
  stage.appendChild(bar);

  // Presses here are for the bar, never for the board under it.
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  prev.addEventListener('click', () => app.presentStep(-1));
  next.addEventListener('click', () => app.presentStep(1));
  tools.addEventListener('click', () => app.setPresentTools(!app.presentToolsPinned));
  timer.addEventListener('click', () => app.command('timer.open'));
  spot.addEventListener('click', () => app.command('spotlight'));
  wheel.addEventListener('click', () => app.command('spinner.open'));
  exit.addEventListener('click', () => app.stopPresenting());

  /*
   * The toolbar comes back when the pointer reaches the bottom edge, and goes
   * again when it leaves - unless it was pinned up from the corner bar.
   *
   * Only a HOVERING pointer counts. A pen writing along the bottom line of a
   * page is not asking for the toolbar, and having it slide up under the nib
   * would be exactly the clutter presenting is meant to remove.
   */
  document.addEventListener('pointermove', (e) => {
    if (!app.presenting || app.presentToolsPinned || e.buttons) return;
    const vh = window.innerHeight || 0;
    const near = e.clientY >= vh - TOOLS_EDGE;
    const onBar = e.target instanceof Element && !!e.target.closest('#toolbar, .pop');
    if (near) document.body.classList.add('show-tools');
    else if (!onBar && e.clientY < vh - TOOLS_EDGE * 2) document.body.classList.remove('show-tools');
  }, { passive: true });
}

/** Page count, where we are, and which buttons make sense right now. */
export function syncPresentBar(app) {
  const bar = document.getElementById('presentbar');
  if (!bar) return;
  bar.hidden = !app.presenting;
  if (!app.presenting) return;
  const n = app.pageCount;
  const i = n ? app.currentPageIndex() : -1;
  const pages = n > 1;
  for (const k of ['prev', 'next']) bar.querySelector(`[data-present="${k}"]`).hidden = !pages;
  const label = document.getElementById('presentLabel');
  label.hidden = !pages;
  if (pages) {
    label.textContent = `${i + 1} / ${n}`;
    bar.querySelector('[data-present="prev"]').disabled = i <= 0;
    bar.querySelector('[data-present="next"]').disabled = i >= n - 1;
  }
  const tools = bar.querySelector('[data-present="tools"]');
  tools.classList.toggle('on', !!app.presentToolsPinned);
  tools.title = app.presentToolsPinned ? t('Tuck the tools away') : t('Show the tools');
}
