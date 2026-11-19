/*
 * Handwriting to text: lasso some ink, press "Convert to text", get a text box.
 *
 * Never automatic. The ink stays exactly as it was drawn until somebody asks,
 * and one Undo brings it straight back - the strokes go and the text box
 * arrives in a single step, so a single step reverses it.
 *
 * The reading itself is done by the device, never a server of ours:
 *   - Windows: its own handwriting recognizer, the one the pen keyboard uses
 *     (main.js runs it through PowerShell, so nothing is installed or bundled).
 *   - Android: Google's ML Kit, on the phone. It needs a language pack
 *     downloaded from Google once (about 20 MB); after that it is offline.
 * Mac, Linux and the web version have no recognizer to ask, so they never
 * show the button.
 *
 * The ink is read a LINE at a time. Two lines sent as one blob come back as one
 * run-on guess; split, each line is read on its own and the text box gets the
 * same line breaks the writing had.
 */
import { t, currentLanguage } from './i18n.js';
import { boundsOf } from './core/store.js';

/** Recognizer language for a GazBoard language code: what to ask Android for, and what to look for in Windows' recognizer names. */
export const INK_LANGS = {
  en: { tag: 'en-US', names: ['English'] },
  bn: { tag: 'bn', names: ['Bengali', 'Bangla', 'বাংলা'] },
  'zh-Hans': { tag: 'zh-Hani-CN', names: ['Chinese (Simplified)', 'Simplified', '简体'] },
  'zh-Hant': { tag: 'zh-Hani-TW', names: ['Chinese (Traditional)', 'Traditional', '繁體'] },
  ar: { tag: 'ar', names: ['Arabic', 'العربية'] },
  es: { tag: 'es-ES', names: ['Spanish', 'Español'] },
  'pt-BR': { tag: 'pt-BR', names: ['Portuguese (Brazil)', 'Portuguese', 'Português'] },
  de: { tag: 'de-DE', names: ['German', 'Deutsch'] }
};

/** The language to read handwriting in: the setting, or the app's own language when it is on Auto. */
export function inkLanguage(app) {
  const want = app.settings.handwritingLang;
  const code = want && want !== 'auto' && INK_LANGS[want] ? want : currentLanguage();
  return INK_LANGS[code] ? code : 'en';
}

/** Is there a recognizer on this device to ask? */
export function inkReaderAvailable(app) {
  // the test suite can stand in a reader (an object) or rule one out (false), whatever machine it runs on
  if (app && app._inkReader) return true;
  if (app && app._inkReader === false) return false;
  const b = typeof window !== 'undefined' ? window.board : null;
  if (!b || typeof b.recognizeInk !== 'function') return false;
  if (document.documentElement?.dataset.platform === 'android') return true;
  return typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent || '');
}

/** The ink strokes in the selection that can be read: pen and pencil, not the highlighter. */
export function readableInk(objs) {
  return objs.filter((o) => o && o.type === 'stroke' && o.tool !== 'highlighter' && !o.locked
    && Array.isArray(o.points) && o.points.length >= 1);
}

/**
 * Sort strokes into lines of writing, top to bottom, each line left to right.
 *
 * A stroke joins the line whose middle band it overlaps; otherwise it starts a
 * new one. Dots and accents are short, so they are matched by their centre
 * rather than their full height - the dot on an i lands with its i.
 */
export function inkLines(strokes) {
  const items = strokes.map((o) => ({ o, b: boundsOf(o) })).sort((a, b) => (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2));
  const heights = items.map((i) => i.b.h).sort((a, b) => a - b);
  const typical = Math.max(1, heights[Math.floor(heights.length * 0.6)] || 1);
  const lines = [];
  // the letters set the lines; dots, commas and accents are placed afterwards, in the nearest line
  const big = items.filter((it) => it.b.h >= typical * 0.4), small = items.filter((it) => it.b.h < typical * 0.4);
  for (const it of big) {
    const cy = it.b.y + it.b.h / 2;
    let best = null, bestD = Infinity;
    for (const L of lines) {
      const d = Math.abs(cy - (L.top + L.bottom) / 2);
      // inside the line's band, with a little give for descenders
      if (cy >= L.top - typical * 0.35 && cy <= L.bottom + typical * 0.35 && d < bestD) { best = L; bestD = d; }
    }
    if (!best) { best = { items: [], top: it.b.y, bottom: it.b.y + it.b.h }; lines.push(best); }
    best.items.push(it);
    best.top = Math.min(best.top, it.b.y); best.bottom = Math.max(best.bottom, it.b.y + it.b.h);
  }
  for (const it of small) {
    const cy = it.b.y + it.b.h / 2;
    let best = null, bestD = Infinity;
    for (const L of lines) {
      const d = cy < L.top ? L.top - cy : cy > L.bottom ? cy - L.bottom : 0;
      if (d < bestD) { best = L; bestD = d; }
    }
    if (!best) { best = { items: [], top: it.b.y, bottom: it.b.y + it.b.h }; lines.push(best); }
    best.items.push(it);
  }
  lines.sort((a, b) => a.top - b.top);
  for (const L of lines) L.items.sort((a, b) => a.b.x - b.b.x);
  return lines.map((L) => ({ strokes: L.items.map((i) => i.o), top: L.top, bottom: L.bottom }));
}

/**
 * The points a recognizer is given: each line moved to the origin and scaled
 * so its writing is about 100 units tall, which is the size both recognizers
 * are happiest with. Only the copy sent out is scaled - the ink is untouched.
 */
export function linesForReader(lines) {
  return lines.map((L) => {
    const h = Math.max(1, L.bottom - L.top);
    const k = 100 / h;
    let x0 = Infinity;
    for (const o of L.strokes) for (const p of o.points) x0 = Math.min(x0, p.x);
    return L.strokes.map((o) => o.points.map((p) => [Math.round((p.x - x0) * k * 10) / 10, Math.round((p.y - L.top) * k * 10) / 10]));
  });
}

/** The text box that replaces the ink: where the writing was, about as big, in its most-used colour. */
export function textForInk(app, strokes, lines, texts, id) {
  const all = strokes.map(boundsOf);
  const x = Math.min(...all.map((b) => b.x)), y = Math.min(...all.map((b) => b.y));
  const right = Math.max(...all.map((b) => b.x + b.w));
  const lineH = lines.map((L) => L.bottom - L.top).sort((a, b) => a - b);
  const median = lineH[Math.floor(lineH.length / 2)] || 40;
  // handwriting stands taller than type of the same size: a letter body is about 0.7 of the box
  const fontSize = Math.max(10, Math.round(median * 0.72));
  const counts = new Map();
  for (const o of strokes) counts.set(o.color, (counts.get(o.color) || 0) + o.points.length);
  const color = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || app.settings.textColor;
  const text = texts.join('\n');
  // wide enough for the longest line, so a short read never wraps into a tall narrow column
  const longest = Math.max(...texts.map((s) => s.length), 1);
  const w = Math.max(fontSize * 3, (right - x) * 1.08, longest * fontSize * 0.62);
  return {
    id, type: 'text', x, y, w, wrapW: w,
    h: Math.max(fontSize * 1.4, texts.length * fontSize * 1.35), text, rotation: 0, color, fontSize,
    align: 'left', valign: 'top', font: app.settings.textFont, background: 'none', at: Date.now()
  };
}

let busy = false;

/**
 * Convert the selected ink to a text box. Resolves to the new text object, or
 * null when nothing was converted (and says why).
 */
export async function convertInkToText(app, { uid }) {
  if (busy) return null;
  const strokes = readableInk(app.selected);
  if (!strokes.length) { app.toast(t('Select some handwriting first'), 'help'); return null; }
  if (!inkReaderAvailable(app)) { app.toast(t('Handwriting can be read on Windows and Android'), 'help'); return null; }
  const code = inkLanguage(app);
  const lang = INK_LANGS[code];
  const lines = inkLines(strokes);
  const request = { lang: lang.tag, match: lang.names, lines: linesForReader(lines) };
  // window.board, or a stand-in the test suite gives the app (window.board itself cannot be changed)
  const reader = app._inkReader || window.board;
  busy = true;
  let progress = null;
  try {
    progress = app.showProgress?.(t('Reading your handwriting…'), t('This stays on your device.'));
    let res = await reader.recognizeInk(request);
    // Android: the language pack is not on the phone yet. Ask before fetching anything.
    if (res && res.code === 'needs-model') {
      progress?.close(); progress = null;
      const name = res.language || lang.tag;
      const ok = await app.confirm(t('Download handwriting for {language}?', { language: name }),
        t('Reading handwriting needs a language pack from Google, about 20 MB, downloaded once. After that it works offline, and your writing never leaves this device.'),
        t('Download'));
      if (!ok) return null;
      progress = app.showProgress?.(t('Downloading handwriting for {language}…', { language: name }), t('This happens only once.'));
      const got = await reader.downloadInkModel({ lang: lang.tag });
      if (!got || !got.ok) { app.toast(t('Could not download the handwriting pack: {error}', { error: (got && got.error) || t('no connection') }), 'help', 6000); return null; }
      progress?.update?.(0, t('Reading your handwriting…'));
      res = await reader.recognizeInk(request);
    }
    if (!res || !res.ok) {
      if (res && res.code === 'no-recognizer') {
        app.toast(t('Windows has no handwriting recognizer for this language. Add it in Settings → Time & language → Language → Options → Handwriting.'), 'help', 9000);
      } else {
        app.toast(t('Could not read the handwriting: {error}', { error: (res && res.error) || t('unknown problem') }), 'help', 6000);
      }
      return null;
    }
    const texts = [].concat(res.lines || []).map((s) => String(s ?? '').trim());
    if (!texts.some(Boolean)) { app.toast(t('No words could be read in that ink'), 'help'); return null; }
    const o = textForInk(app, strokes, lines, texts.filter((s, i) => s || i < texts.length - 1), uid('t'));
    // one step: the ink goes, the text comes - so one Undo puts the ink back exactly as it was
    const dels = strokes
      .map((s) => ({ s, i: app.store.indexOf(s.id) }))
      .sort((a, b) => b.i - a.i)
      .map(({ s, i }) => ({ t: 'del', id: s.id, obj: structuredClone(s), index: i }));
    app.store.commit('convert handwriting', [...dels, { t: 'add', obj: o }]);
    app.setSelection([o.id]);
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    app.toast(coarse ? t('Converted to text. Undo brings the ink back.') : t('Converted to text. Ctrl+Z brings the ink back.'), 'check', 5000);
    return o;
  } catch (e) {
    app.toast(t('Could not read the handwriting: {error}', { error: e.message || String(e) }), 'help', 6000);
    return null;
  } finally {
    progress?.close();
    busy = false;
  }
}
