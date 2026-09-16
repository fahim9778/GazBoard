export const PEN_COLORS = [
  '#201f1e', '#e81123', '#ff8c00', '#fff100', '#107c10', '#0078d4', '#8764b8', '#e3008c',
  '#00b7c3', '#8e562e', '#605e5c', '#ffffff'
];

export const PEN_EFFECTS = [
  { id: 'none', label: 'Solid' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'galaxy', label: 'Galaxy' }
];

export const HIGHLIGHTER_COLORS = ['#fff100', '#b0ff57', '#00e5ff', '#ff8ad8', '#ffa64d', '#c9a0ff'];

export const NOTE_COLORS = ['#ffd94a', '#a4e7a0', '#9ad9f5', '#ffb3c7', '#d6c7f5', '#ffcf99', '#e6e6e6', '#ffffff'];

export const TEXT_COLORS = ['#201f1e', '#e81123', '#ff8c00', '#107c10', '#0078d4', '#8764b8', '#e3008c', '#605e5c'];

export const SHAPE_STROKES = ['#201f1e', '#e81123', '#ff8c00', '#107c10', '#0078d4', '#8764b8', '#e3008c', '#605e5c'];
export const SHAPE_FILLS = ['none', '#ffffff', '#fde68a', '#bbf7d0', '#bfdbfe', '#e9d5ff', '#fecaca', '#f3f4f6'];

export const BOARD_COLORS = ['#ffffff', '#faf9f8', '#fdf6e3', '#eef6ff', '#f2fbf3', '#fdf2f8', '#f5f3ff', '#2b2b2b'];
export const PATTERNS = [
  { id: 'none', label: 'Plain' },
  { id: 'grid', label: 'Grid' },
  { id: 'dots', label: 'Dots' },
  { id: 'lines', label: 'Lines' },
  { id: 'columns', label: 'Columns' },
  { id: 'graph', label: 'Graph' }
];

export const SHAPES = [
  'rect', 'roundRect', 'ellipse', 'triangle', 'rightTriangle',
  'diamond', 'pentagon', 'hexagon', 'octagon', 'star',
  'cloud', 'line', 'arrow', 'doubleArrow'
];

export const SHAPE_LABELS = {
  rect: 'Rectangle', roundRect: 'Rounded rectangle', ellipse: 'Ellipse', circle: 'Circle',
  triangle: 'Triangle', rightTriangle: 'Right triangle', diamond: 'Diamond', pentagon: 'Pentagon',
  hexagon: 'Hexagon', octagon: 'Octagon', star: 'Star', cloud: 'Cloud',
  line: 'Line', arrow: 'Arrow', doubleArrow: 'Double arrow'
};

/* The pens that sit in the toolbar, in order, the way Whiteboard lays them out. */
export const PENS = [
  { id: 'black',   color: '#201f1e', effect: 'none',    label: 'Black pen' },
  { id: 'red',     color: '#e81123', effect: 'none',    label: 'Red pen' },
  { id: 'blue',    color: '#0078d4', effect: 'none',    label: 'Blue pen' },
  { id: 'green',   color: '#107c10', effect: 'none',    label: 'Green pen' },
  { id: 'rainbow', color: '#e81123', effect: 'rainbow', label: 'Rainbow pen' },
  { id: 'galaxy',  color: '#8764b8', effect: 'galaxy',  label: 'Galaxy pen' }
];

/**
 * The tray as it actually is, with any recolouring the user has done.
 *
 * PENS above is how the tray SHIPS. It is a constant, so reading a pen's colour
 * from it always gave the factory answer - which is why recolouring the black
 * pen, picking up another, and coming back to black handed you black again.
 * The choice was never stored anywhere; only `penColor`, the one colour in the
 * hand right now, was, and picking any pen overwrote it.
 *
 * What a person changed is kept in settings.pens, keyed by pen id, holding only
 * the pens they actually touched. Everything else falls through to the shipped
 * value, so the tray needs no migration and a settings file written by an older
 * build opens with its pens exactly as they were.
 */
export function penList(settings) {
  const mine = (settings && settings.pens) || {};
  return PENS.map((p) => {
    const m = mine[p.id];
    if (!m) return p;
    return { ...p, color: m.color || p.color, effect: m.effect || p.effect };
  });
}

/** One pen from that tray, by id. */
export function penById(settings, id) {
  return penList(settings).find((p) => p.id === id) || null;
}

/**
 * Remember what a pen was changed to.
 *
 * A pen recoloured to what it shipped as is forgotten rather than stored, so
 * "put it back to black" leaves no trace behind to be carried forever.
 */
export function rememberPen(settings, id, { color, effect } = {}) {
  const base = PENS.find((p) => p.id === id);
  if (!base) return;
  const next = { color: color || base.color, effect: effect || base.effect };
  const mine = settings.pens || (settings.pens = {});
  if (next.color === base.color && next.effect === base.effect) delete mine[id];
  else mine[id] = next;
}

/**
 * Which pen is in the hand.
 *
 * Settings written before pens could be recoloured have no `activePen`, so the
 * colour in hand is matched against the tray instead - the way the toolbar used
 * to decide this. That fallback is only for the first run after upgrading: the
 * moment a pen is picked up, its id is recorded and the guessing stops. It is
 * also why the id is what gets stored, not the colour: two pens set to the same
 * colour would otherwise both light up, and neither would be wrong.
 */
export function heldPenId(settings) {
  if (settings.activePen && PENS.some((p) => p.id === settings.activePen)) return settings.activePen;
  const match = penList(settings).find((p) => p.color === settings.penColor && p.effect === settings.penEffect);
  return match ? match.id : null;
}

/**
 * A pen drawn as a pen: barrel in its own colour, pale nib, so the row reads as
 * a tray of pens rather than a row of identical buttons.
 */
export function penIcon(color, effect, kind = 'pen') {
  const uid = 'g' + Math.random().toString(36).slice(2, 8);
  let fill = color;
  let defs = '';
  if (effect === 'rainbow') {
    defs = `<linearGradient id="${uid}" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#e81123"/><stop offset=".3" stop-color="#ff8c00"/>
      <stop offset=".55" stop-color="#107c10"/><stop offset=".8" stop-color="#0078d4"/>
      <stop offset="1" stop-color="#8764b8"/></linearGradient>`;
    fill = `url(#${uid})`;
  } else if (effect === 'galaxy') {
    defs = `<radialGradient id="${uid}" cx=".35" cy=".3" r=".9">
      <stop offset="0" stop-color="#b18cff"/><stop offset=".55" stop-color="#5b3ba8"/>
      <stop offset="1" stop-color="#231447"/></radialGradient>`;
    fill = `url(#${uid})`;
  }

  if (kind === 'highlighter') {
    return `<svg viewBox="0 0 26 44" width="26" height="44" aria-hidden="true">
      <path d="M6 15h14v22a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" fill="${fill}"/>
      <path d="M8.5 4.5h9v10.5h-9z" fill="#f3f2f1" stroke="#c8c6c4" stroke-width="1"/>
      <path d="M9.5 1h7v3.5h-7z" fill="#a19f9d"/>
      <rect x="6" y="27" width="14" height="3" fill="rgba(0,0,0,.14)"/></svg>`;
  }
  if (kind === 'eraser') {
    return `<svg viewBox="0 0 26 44" width="26" height="44" aria-hidden="true">
      <path d="M5 20h16v17a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#f7a8c4"/>
      <path d="M5 12a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8H5z" fill="#f3f2f1" stroke="#c8c6c4"/>
      <rect x="5" y="19" width="16" height="2.5" fill="rgba(0,0,0,.12)"/></svg>`;
  }

  return `<svg viewBox="0 0 26 44" width="26" height="44" aria-hidden="true">
    <defs>${defs}</defs>
    <path d="M6.5 14h13v23a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3z" fill="${fill}"/>
    <path d="M13 1.5 19.5 14h-13z" fill="#f3f2f1" stroke="#c8c6c4" stroke-width="1" stroke-linejoin="round"/>
    <path d="M13 4.6 17 12h-8z" fill="${fill}"/>
    <rect x="6.5" y="26" width="13" height="3" fill="rgba(255,255,255,.22)"/></svg>`;
}

/** Named text faces, including the comic/handwriting one. */
export const FONTS = [
  { id: 'ui',     label: 'Sans',        stack: `'Segoe UI Variable','Segoe UI',-apple-system,Arial,sans-serif` },
  { id: 'hand',   label: 'Handwriting', stack: `'Comic Sans MS','Segoe Print','Ink Free','Segoe Script','Bradley Hand','Chalkboard SE','Comic Neue',cursive` },
  { id: 'marker', label: 'Marker',      stack: `'Ink Free','Segoe Marker','Comic Sans MS',cursive` },
  { id: 'serif',  label: 'Serif',       stack: `Georgia,'Times New Roman',serif` },
  { id: 'mono',   label: 'Mono',        stack: `'Cascadia Mono',Consolas,'Courier New',monospace` }
];

export function fontStack(id) {
  return (FONTS.find((f) => f.id === id) || FONTS[0]).stack;
}

/** Tiny preview SVG for a shape button. */
export function shapeIcon(kind, size = 22) {
  const s = size, m = 3, w = s - m * 2, h = s - m * 2, cx = s / 2, cy = s / 2;
  const attrs = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"';
  const poly = (n, rot) => {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = rot + (i * Math.PI * 2) / n; pts.push(`${(cx + Math.cos(a) * w / 2).toFixed(1)},${(cy + Math.sin(a) * h / 2).toFixed(1)}`); }
    return pts.join(' ');
  };
  let body;
  switch (kind) {
    case 'rect': body = `<rect x="${m}" y="${m + 2}" width="${w}" height="${h - 4}" ${attrs}/>`; break;
    case 'roundRect': body = `<rect x="${m}" y="${m + 2}" width="${w}" height="${h - 4}" rx="4" ${attrs}/>`; break;
    case 'ellipse': body = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2 - 2}" ${attrs}/>`; break;
    case 'triangle': body = `<polygon points="${cx},${m} ${s - m},${s - m} ${m},${s - m}" ${attrs}/>`; break;
    case 'rightTriangle': body = `<polygon points="${m},${m} ${m},${s - m} ${s - m},${s - m}" ${attrs}/>`; break;
    case 'diamond': body = `<polygon points="${cx},${m} ${s - m},${cy} ${cx},${s - m} ${m},${cy}" ${attrs}/>`; break;
    case 'pentagon': body = `<polygon points="${poly(5, -Math.PI / 2)}" ${attrs}/>`; break;
    case 'hexagon': body = `<polygon points="${poly(6, 0)}" ${attrs}/>`; break;
    case 'octagon': body = `<polygon points="${poly(8, Math.PI / 8)}" ${attrs}/>`; break;
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const f = i % 2 ? 0.44 : 1; pts.push(`${(cx + Math.cos(a) * (w / 2) * f).toFixed(1)},${(cy + Math.sin(a) * (h / 2) * f).toFixed(1)}`); }
      body = `<polygon points="${pts.join(' ')}" ${attrs}/>`; break;
    }
    case 'cloud': body = `<path d="M6 15a3 3 0 0 1 .6-6 4 4 0 0 1 7.6-1.2A3.4 3.4 0 0 1 17 15z" ${attrs}/>`; break;
    case 'line': body = `<line x1="${m}" y1="${s - m}" x2="${s - m}" y2="${m}" ${attrs}/>`; break;
    case 'arrow': body = `<line x1="${m}" y1="${s - m}" x2="${s - m}" y2="${m}" ${attrs}/><polyline points="${s - m - 6},${m} ${s - m},${m} ${s - m},${m + 6}" ${attrs}/>`; break;
    case 'doubleArrow': body = `<line x1="${m}" y1="${s - m}" x2="${s - m}" y2="${m}" ${attrs}/><polyline points="${s - m - 6},${m} ${s - m},${m} ${s - m},${m + 6}" ${attrs}/><polyline points="${m + 6},${s - m} ${m},${s - m} ${m},${s - m - 6}" ${attrs}/>`; break;
    default: body = `<rect x="${m}" y="${m}" width="${w}" height="${h}" ${attrs}/>`;
  }
  return `<svg viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">${body}</svg>`;
}
