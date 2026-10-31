// Maths boxes: LaTeX, typeset by KaTeX, drawn on the board as a picture.
//
// KaTeX lays maths out as ordinary web page text in its own fonts. The board
// is a canvas, which cannot hold web page text, so each formula is laid out
// once off screen, wrapped up as a small SVG picture with the few fonts it
// actually uses tucked inside, and that picture is what the board draws. It
// is a vector picture, so it stays sharp at any zoom, in a PNG, and in a PDF.
//
// Only the LaTeX is ever saved. The picture is made again from it on any
// device that opens the board, so a maths box is always editable as what was
// typed, and a board file stays small.
//
// Everything here works offline: KaTeX and its fonts ship inside the app and
// are only loaded the first time a board has maths on it.

const BASE = 40;                         // CSS px the formula is laid out at
const PAD = 6;                           // room for glyphs that lean out of their box
const ROOT = new URL('../../vendor/katex/', import.meta.url).href;
const CAP = 300;                         // formulas kept ready before the oldest go

let katexP = null;
let cssP = null;
const fontP = new Map();                 // family -> Promise<css with the fonts inline>
const cache = new Map();                 // tex + colour -> entry
let arrived = null;                      // called when any formula finishes, for repaints nobody asked for by name

/** Who to tell when a formula's picture arrives (the board repaints). */
export function onMathArrived(fn) { arrived = fn; }

/** KaTeX itself, loaded on first use. Its stylesheet comes with it, for the editor's preview. */
export function loadKatex() {
  if (typeof window !== 'undefined' && window.katex) return Promise.resolve(window.katex);
  if (!katexP) {
    katexP = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ROOT + 'katex.min.css';
      const css = new Promise((res) => { link.onload = res; link.onerror = res; });
      document.head.appendChild(link);
      const s = document.createElement('script');
      s.src = ROOT + 'katex.min.js';
      s.onload = () => css.then(() => resolve(window.katex));
      s.onerror = () => { katexP = null; reject(new Error('KaTeX could not be loaded')); };
      document.head.appendChild(s);
    });
  }
  return katexP;
}

/** KaTeX's stylesheet, split into its layout rules and its @font-face rules by family. */
function stylesheet() {
  if (!cssP) {
    cssP = fetch(ROOT + 'katex.min.css').then((r) => r.text()).then((text) => {
      const faces = new Map();
      const layout = text.replace(/@font-face\{[^}]*\}/g, (rule) => {
        const fam = /font-family:\s*([^;]+);/.exec(rule);
        if (fam) {
          const name = fam[1].replace(/["']/g, '').trim();
          if (!faces.has(name)) faces.set(name, []);
          faces.get(name).push(rule);
        }
        return '';
      });
      return { layout, faces };
    }).catch((e) => { cssP = null; throw e; });
  }
  return cssP;
}

const asDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

/** The @font-face rules for one KaTeX family, with the font files written inside them. */
function fontCss(family) {
  if (!fontP.has(family)) {
    fontP.set(family, stylesheet().then(async ({ faces }) => {
      const rules = faces.get(family) || [];
      const out = [];
      for (const rule of rules) {
        let r = rule;
        for (const m of rule.matchAll(/url\(([^)]+)\)/g)) {
          const file = m[1].replace(/["']/g, '');
          const data = await asDataUrl(await (await fetch(ROOT + file)).blob());
          r = r.replace(m[0], `url(${data})`);
        }
        out.push(r);
      }
      return out.join('');
    }).catch((e) => { fontP.delete(family); throw e; }));
  }
  return fontP.get(family);
}

/** The KaTeX options GazBoard always uses: never throw, never run anything, never balloon. */
const OPTIONS = { displayMode: true, throwOnError: false, output: 'html', strict: 'ignore', trust: false, maxSize: 40, maxExpand: 300 };

/** Turn LaTeX into HTML, plus what was wrong with it, if anything. */
export async function toHtml(tex, display = true) {
  const k = await loadKatex();
  const html = k.renderToString(String(tex || ''), display ? OPTIONS : { ...OPTIONS, displayMode: false });
  const err = /class="katex-error"[^>]*title="([^"]*)"/.exec(html);
  return { html, error: err ? err[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null };
}

const LOCAL = '.gb-math .katex-display{margin:0!important}.gb-math .katex{text-rendering:geometricPrecision}';

/**
 * Lay one formula out and wrap it as a picture.
 * @returns {Promise<{img: HTMLImageElement, w: number, h: number, error: string|null, svg: string}>}
 */
export async function typeset(tex, color = '#201f1e', display = true) {
  const { html, error } = await toHtml(tex, display);
  const { layout } = await stylesheet();
  const host = document.createElement('div');
  host.className = 'gb-math';
  const look = `font-size:${BASE}px;color:${color};display:inline-block;white-space:nowrap;line-height:normal;padding:${PAD}px;direction:ltr`;
  host.style.cssText = `position:fixed;left:-20000px;top:0;visibility:hidden;${look}`;
  host.innerHTML = html;
  // Where the formula's baseline is, so maths in a sentence sits on the line with the words.
  const mark = document.createElement('span');
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  if (!display) host.appendChild(mark);
  if (!document.getElementById('gb-math-local')) {
    const st = document.createElement('style');
    st.id = 'gb-math-local';
    st.textContent = LOCAL;
    document.head.appendChild(st);
  }
  document.body.appendChild(host);
  try {
    host.getBoundingClientRect();                 // lay it out, so its fonts are asked for
    if (document.fonts?.ready) await document.fonts.ready;
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width)), h = Math.max(1, Math.ceil(r.height));
    const base = display ? h - PAD : mark.getBoundingClientRect().top - r.top;
    mark.remove();
    // Only the fonts this formula actually uses go inside the picture.
    const families = new Set();
    for (const el of host.querySelectorAll('*')) {
      const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
      if (f.startsWith('KaTeX_')) families.add(f);
    }
    const fonts = (await Promise.all([...families].map(fontCss))).join('');
    host.style.cssText = look;
    const body = new XMLSerializer().serializeToString(host);
    const style = (fonts + layout + LOCAL).replace(/</g, '\\3c ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
      + `<foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml">`
      + `<style>${style}</style>${body}</div></foreignObject></svg>`;
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('The formula picture could not be drawn'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    try { await img.decode?.(); } catch { /* already decoded */ }
    return { img, w, h, base, error, svg };
  } finally {
    host.remove();
  }
}

const keyOf = (tex, color, display) => (display ? 'D' : 'I') + String(tex || '') + '\u0000' + String(color || '');

/**
 * The picture for a formula, if it is ready. If it is not, it is started, and
 * `onload` is called once it is - the same promise an image on the board makes.
 */
export function mathEntry(tex, color, onload, display = true) {
  const key = keyOf(tex, color, display);
  let e = cache.get(key);
  if (e) {
    // most recently used goes to the back, so the oldest are the ones dropped
    cache.delete(key); cache.set(key, e);
    if (e.status === 'loading' && onload) e.waiters.add(onload);
    return e;
  }
  e = { status: 'loading', img: null, w: 0, h: 0, error: null, svg: '', waiters: new Set(onload ? [onload] : []) };
  cache.set(key, e);
  while (cache.size > CAP) cache.delete(cache.keys().next().value);
  e.promise = typeset(tex, color, display).then((r) => {
    Object.assign(e, r, { status: 'ready' });
  }).catch((err) => {
    e.status = 'failed';
    e.error = String(err && err.message || err);
  }).finally(() => {
    const ws = [...e.waiters]; e.waiters.clear();
    for (const w of ws) { try { w(); } catch { /* a repaint that failed is not ours to report */ } }
    try { arrived?.(); } catch { /* likewise */ }
  });
  return e;
}

/** Wait until a formula's picture is ready (or has failed). */
export function mathReady(tex, color, display = true) {
  const e = mathEntry(tex, color, null, display);
  return e.status === 'loading' ? e.promise.then(() => e) : Promise.resolve(e);
}

/**
 * Get every maths box in `objects` ready to draw, in the colours an export
 * uses (the board's own ink, never the dark screen theme). Exports, copies
 * and board pictures call this first, because they draw in one go and cannot
 * wait for a picture to arrive afterwards.
 */
let graphLabelsOf = null;
export function useGraphLabels(fn) { graphLabelsOf = fn; }

export function mathsReady(objects, paint = (c) => c || '#201f1e') {
  const jobs = [];
  for (const o of objects || []) {
    if (!o || o.hidden) continue;
    if (o.type === 'math') { jobs.push(mathReady(o.tex, paint(o.color))); continue; }
    // a graph's typeset labels (graph.js hands them in, so this file needs nothing from it)
    if (o.type === 'graph') { for (const l of graphLabelsOf ? graphLabelsOf(o) : []) jobs.push(mathReady(l.tex, l.color, false)); continue; }
    // maths in the words: every formula, in every colour the words around it come in
    const texts = [o.text, ...Object.values(o.cells || {})].filter((x) => typeof x === 'string' && x.indexOf('$') >= 0);
    if (!texts.length) continue;
    const colours = new Set(['#201f1e', o.color, o.textColor].filter(Boolean));
    for (const runs of [o.runs, ...Object.values(o.cellRuns || {})]) for (const r of runs || []) if (r && r.c) colours.add(r.c);
    for (const text of texts) for (const sp of mathSpans(text)) for (const c of colours) jobs.push(mathReady(sp.tex, c, false));
  }
  return jobs.length ? Promise.all(jobs).then(() => {}) : Promise.resolve();
}

/** The size a formula comes out at for a given lettering size (world px). */
export function naturalSize(e, size) {
  const k = size / BASE;
  return { w: e.w * k, h: e.h * k };
}

/** The lettering size a box is showing its formula at, from its height. */
export function sizeOfBox(o, e) {
  if (!e || !e.h) return null;
  return Math.min(Math.abs(o.w) / e.w, Math.abs(o.h) / e.h) * BASE;
}

/** A sharp PNG of a formula, for places that cannot take the SVG (an SVG export read by Word or Inkscape). */
export function mathPng(e, w, h, scale = 3) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(e.img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

export const MATH_BASE = BASE;

/*
 * Maths inside a sentence: $...$ in a text box, a sticky note, a shape's label
 * or a table cell. The rule for what counts is the one Pandoc and most maths
 * editors use, so prices survive: the opening $ is followed by something that
 * is not a space, the closing $ comes straight after something that is not a
 * space and is not followed by a digit. "$5 and $10" is two prices; "$x^2$" is
 * maths. \$ is always a plain dollar sign. $$...$$ works too.
 */
export const INLINE_MATH = /(?<!\\)\$\$([^$]+?)\$\$|(?<!\\)\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/g;

/** Does this text have any maths in it? */
export function hasMaths(text) {
  if (!text || text.indexOf('$') < 0) return false;
  INLINE_MATH.lastIndex = 0;
  const yes = INLINE_MATH.test(text);
  INLINE_MATH.lastIndex = 0;
  return yes;
}

/** Every maths stretch in a text: [{start, end, tex}] by character offset. */
export function mathSpans(text) {
  const out = [];
  if (!text || text.indexOf('$') < 0) return out;
  INLINE_MATH.lastIndex = 0;
  let m;
  while ((m = INLINE_MATH.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, tex: (m[1] ?? m[2]).trim() });
  INLINE_MATH.lastIndex = 0;
  return out;
}

/**
 * How a formula sits in a line of text at `size` px with lines `lh` apart:
 * its scale, and its width once the padding round the picture is left off.
 * A tall formula (a fraction, a sum with limits) is shrunk to the line rather
 * than pushing the lines apart, so a box keeps the height it has always had.
 */
export function inlineFit(e, size, lh) {
  let k = size / BASE;
  const inkH = Math.max(1, e.h - PAD * 2);
  const room = lh * 1.12;
  if (inkH * k > room) k = room / inkH;
  return { k, w: Math.max(0, (e.w - PAD * 2) * k), pad: PAD * k };
}
