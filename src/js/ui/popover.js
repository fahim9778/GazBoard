// A single lightweight popover manager shared by the toolbar and menus.

let current = null;

export function closePopover() {
  if (current) {
    if (current.cleanup) {
      try { current.cleanup(); } catch {}
    }
    current.el.remove();
    current.onClose?.();
    current = null;
  }
}

export function isOpen(key) { return current?.key === key; }

/** Is any popover on screen at all? Used to decide what Escape closes first. */
export function popoverOpen() { return !!current; }

/**
 * @param {HTMLElement|{x:number,y:number}} anchor
 * @param {HTMLElement} content
 * @param {{key?:string, placement?:'top'|'bottom'|'point', align?:'center'|'start'|'end', onClose?:Function, className?:string}} opts
 */
export function openPopover(anchor, content, opts = {}) {
  const key = opts.key;
  if (key && isOpen(key)) { closePopover(); return null; }
  closePopover();

  const el = document.createElement('div');
  el.className = 'pop ' + (opts.className || '');
  el.appendChild(content);
  document.body.appendChild(el);

  const vw = window.visualViewport ? window.visualViewport.width : (window.innerWidth || 1024);
  const vh = window.visualViewport ? window.visualViewport.height : (window.innerHeight || 768);
  const vx = window.visualViewport ? (window.visualViewport.offsetLeft || 0) : 0;
  const vy = window.visualViewport ? (window.visualViewport.offsetTop || 0) : 0;

  const r = el.getBoundingClientRect();
  let left, top;
  if (anchor instanceof HTMLElement) {
    const a = anchor.getBoundingClientRect();
    const align = opts.align || 'center';
    left = align === 'start' ? a.left : align === 'end' ? a.right - r.width : a.left + a.width / 2 - r.width / 2;
    top = opts.placement === 'bottom' ? a.bottom + 8 : a.top - r.height - 8;
    if (top < vy + 8) top = a.bottom + 8;
  } else {
    left = anchor.x; top = anchor.y;
    if (top + r.height > vy + vh - 8) top = Math.max(vy + 8, anchor.y - r.height);
  }
  el.style.left = Math.max(vx + 8, Math.min(left, vx + vw - r.width - 8)) + 'px';
  el.style.top = Math.max(vy + 8, Math.min(top, vy + vh - r.height - 8)) + 'px';

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('pointerdown', off, true);
  };

  const off = (e) => {
    if (!current) return;
    if (current.el.contains(e.target)) return;
    if (anchor instanceof HTMLElement && anchor.contains(e.target)) return;
    cleanup();
    closePopover();
  };

  current = { el, key, onClose: opts.onClose, cleanup };
  setTimeout(() => {
    if (current && current.cleanup === cleanup) {
      document.addEventListener('pointerdown', off, true);
    }
  }, 0);
  return el;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
