const TOUCH_HOLD_MS = 450;
const PEN_HOLD_MS = 700;
const HOLD_SLOP = 11;
const NATIVE_MENU_GUARD_MS = 900;
const NATIVE_MENU_GUARD_RADIUS = 28;

/**
 * Give desktop touchscreens the same blank-board paste gesture as Android.
 *
 * This deliberately lives above the active tool: Select may be drawing a
 * marquee, Pen may have started a wet dot and Pan may have started moving the
 * camera, but a stationary hold on genuinely blank board space means the same
 * thing in all of them. When the hold wins, Interaction is asked to abandon
 * that preview before the context menu is shown.
 */
export function installBlankPasteGesture({
  host = window,
  documentRoot = () => document.documentElement,
  getApp = () => window.app,
  showMenu,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = (id) => clearTimeout(id),
  clock = () => Date.now()
} = {}) {
  if (!host?.addEventListener || typeof showMenu !== 'function') return () => {};

  let timer = null;
  let pointerId = null;
  let pointerType = null;
  let origin = null;
  let anchor = null;
  let suppressUntil = 0;
  let suppressAnchor = null;

  const clearActive = () => {
    if (timer !== null) cancelSchedule(timer);
    timer = null;
    pointerId = null;
    pointerType = null;
    origin = null;
    anchor = null;
  };
  const android = () => documentRoot?.()?.dataset?.platform === 'android';
  const touchLike = (type) => type === 'touch' || type === 'pen';

  host.addEventListener('pointerdown', (e) => {
    clearActive();
    if (android() || !touchLike(e.pointerType) || e.button !== 0) return;

    const app = getApp();
    if (!app?.surface?.canvas || e.target !== app.surface.canvas) return;

    let wp;
    try { wp = app.surface.toWorld(e); } catch { return; }
    // Holding an object keeps GazBoard's existing select/move gesture. This is
    // only the empty-board equivalent of a mouse right-click.
    if (app.pickAt?.(wp)) return;

    pointerId = e.pointerId;
    pointerType = e.pointerType;
    origin = { x: e.clientX, y: e.clientY };
    anchor = { clientX: e.clientX, clientY: e.clientY };
    const heldPointer = pointerId;
    const heldType = pointerType;

    timer = schedule(() => {
      timer = null;
      const live = getApp();
      if (pointerId !== heldPointer || !live?.surface?.canvas) { clearActive(); return; }

      // A hold may have started a dot, marquee or pan underneath. None of that
      // should survive the gesture which opened the context menu.
      live.interaction?.cancelGesture?.();
      live.setSelection?.([]);
      suppressAnchor = { ...anchor };
      suppressUntil = clock() + NATIVE_MENU_GUARD_MS;
      showMenu(live, { ...anchor, pointerType: heldType });

      pointerId = null;
      pointerType = null;
      origin = null;
      anchor = null;
    }, heldType === 'pen' ? PEN_HOLD_MS : TOUCH_HOLD_MS);
  }, true);

  host.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId || !origin) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > HOLD_SLOP) clearActive();
  }, true);
  host.addEventListener('pointerup', (e) => { if (e.pointerId === pointerId) clearActive(); }, true);
  host.addEventListener('pointercancel', (e) => { if (e.pointerId === pointerId) clearActive(); }, true);

  // Windows can synthesize its own contextmenu from a pen/touch hold. While
  // GazBoard's blank hold is armed (or has just fired at this exact spot), that
  // native menu is the same gesture arriving by a second route, so swallow it.
  host.addEventListener('contextmenu', (e) => {
    const armed = pointerId !== null && touchLike(pointerType);
    const nearRecent = suppressAnchor && clock() < suppressUntil
      && Math.hypot(e.clientX - suppressAnchor.clientX, e.clientY - suppressAnchor.clientY) <= NATIVE_MENU_GUARD_RADIUS;
    if (!armed && !nearRecent) return;
    e.preventDefault?.();
    e.stopImmediatePropagation?.();
  }, true);

  return clearActive;
}

export const BLANK_PASTE_TIMING = Object.freeze({
  touch: TOUCH_HOLD_MS,
  pen: PEN_HOLD_MS,
  slop: HOLD_SLOP
});
