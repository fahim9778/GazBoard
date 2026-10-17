// Tool cursors drawn as SVG and handed to CSS as data URIs.
//
// A crosshair is what a drawing program uses when it has nothing better; a pen
// tool should say "you are holding a pen". These glyphs are tinted with the
// colour actually loaded in the tool, so the cursor doubles as a colour readout,
// and the hotspot sits exactly on the nib point — what you click is what you draw.

const cache = new Map();

const esc = (svg) => svg.replace(/#/g, '%23').replace(/"/g, "'").replace(/\s+/g, ' ').trim();

/** A tilted pen: nib at the top-left, barrel running down to the bottom-right. */
function penSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <g stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round" fill="none">
      <path d="M2 2 L10.4 5.6 L5.6 10.4 Z"/>
      <path d="M9.4 4.6 L21.2 16.4 A2.4 2.4 0 0 1 21.2 19.8 L19.8 21.2 A2.4 2.4 0 0 1 16.4 21.2 L4.6 9.4 Z"/>
    </g>
    <path d="M2 2 L10.4 5.6 L5.6 10.4 Z" fill="${color}"/>
    <path d="M9.4 4.6 L21.2 16.4 A2.4 2.4 0 0 1 21.2 19.8 L19.8 21.2 A2.4 2.4 0 0 1 16.4 21.2 L4.6 9.4 Z" fill="${color}"/>
    <path d="M7.2 7.2 L18.8 18.8" stroke="#ffffff" stroke-width="1.1" stroke-opacity=".55" fill="none"/>
  </svg>`;
}

/** A highlighter: the same tilt, but a flat chisel tip instead of a point. */
function markerSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <g stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round" fill="none">
      <path d="M2.2 5.2 L6.4 1.9 L11.6 7.1 L7.4 10.4 Z"/>
      <path d="M9.6 5.2 L21.4 17 A2.4 2.4 0 0 1 21.4 20.4 L20 21.8 A2.4 2.4 0 0 1 16.6 21.8 L4.8 10 Z"/>
    </g>
    <path d="M2.2 5.2 L6.4 1.9 L11.6 7.1 L7.4 10.4 Z" fill="${color}" fill-opacity=".62"/>
    <path d="M9.6 5.2 L21.4 17 A2.4 2.4 0 0 1 21.4 20.4 L20 21.8 A2.4 2.4 0 0 1 16.6 21.8 L4.8 10 Z" fill="${color}"/>
  </svg>`;
}

/**
 * A pencil, at the same tilt: a point in the lead's colour, a cone of bare
 * wood, a yellow barrel and a pink eraser on the end - the pencil in the tray,
 * so the hand and the tray agree on what is being held.
 */
function pencilSvg(color) {
  const outline = 'M0 0 L3.6 7.6 V27.4 A1.6 1.6 0 0 1 2 29 H-2 A1.6 1.6 0 0 1 -3.6 27.4 V7.6 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <g transform="translate(2 2) rotate(-45)">
      <path d="${outline}" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round" fill="#ffffff"/>
      <path d="M-3.6 7.6 H3.6 V24.6 H-3.6 Z" fill="#f2c230"/>
      <path d="M-1.1 7.6 H1.1 V24.6 H-1.1 Z" fill="#e0ad1c"/>
      <path d="M-3.6 24.6 H3.6 V26 H-3.6 Z" fill="#b9b6b0"/>
      <path d="M-3.6 26 H3.6 V27.4 A1.6 1.6 0 0 1 2 29 H-2 A1.6 1.6 0 0 1 -3.6 27.4 Z" fill="#f4a6b8"/>
      <path d="M0 0 L3.6 7.6 H-3.6 Z" fill="#e9c99a" stroke="#c9a46c" stroke-width=".6" stroke-linejoin="round"/>
      <path d="M0 0 L1.6 3.4 H-1.6 Z" fill="${color}"/>
    </g>
  </svg>`;
}

const glyph = (kind, color) => (kind === 'highlighter' ? markerSvg(color) : kind === 'pencil' ? pencilSvg(color) : penSvg(color));

/**
 * @param {'pen'|'pencil'|'highlighter'} kind
 * @param {string} color  the colour loaded in the tool
 * @param {string} fallback used when the browser refuses the image
 */
export function inkCursor(kind, color, fallback = 'crosshair') {
  const key = kind + color;
  let c = cache.get(key);
  if (!c) {
    const svg = glyph(kind, color);
    // hotspot: the nib point. The pen and the pencil tip at 2,2; the chisel meets the board at 2,5.
    const hot = kind === 'highlighter' ? '2 5' : '2 2';
    c = `url("data:image/svg+xml,${esc(svg)}") ${hot}, ${fallback}`;
    cache.set(key, c);
  }
  return c;
}

/* ------------------------------------------------------------------ *
 * The same glyphs, as a plain image for the ink-pointer layer.
 *
 * A CSS cursor is drawn by the operating system, and Windows takes the system
 * pointer away the moment a pen touches the digitiser, putting it back on lift.
 * On a tablet that reads as the nib blinking once per stroke, and there is
 * nothing CSS can do about it - the thing being hidden is not ours.
 *
 * So the nib becomes an element of our own, moved with a transform. Not painted
 * into the canvas: while hovering there is no stroke in flight and therefore no
 * cached frame to reuse, so a canvas nib means redrawing the entire board on
 * every pointer move. A composited layer moves for free and leaves the board
 * alone.
 * ------------------------------------------------------------------ */

/** The glyph on its own, with no hotspot - for `background-image`. */
export function inkGlyphUrl(kind, color) {
  const key = 'img' + kind + color;
  let u = cache.get(key);
  if (!u) {
    const svg = glyph(kind, color);
    u = `url("data:image/svg+xml,${esc(svg)}")`;
    cache.set(key, u);
  }
  return u;
}

/** Where the drawing tip sits inside that 26x26 glyph. */
export function inkGlyphHotspot(kind) {
  return kind === 'highlighter' ? { x: 2, y: 5 } : { x: 2, y: 2 };
}
