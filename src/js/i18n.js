// The app in more languages than English.
//
// Every word the app shows goes through t(). The English sentence itself is
// the key: `t('Export as PNG…')`. A language file maps each English sentence
// to its translation, and anything a file has not got yet simply stays in
// English - a half-finished translation is still a working app.
//
// Only the app's own words are translated: menus, buttons, tooltips,
// dialogs, messages. What people write and draw on a board is theirs and is
// never touched, and the board itself is always laid out left to right.
//
// The dictionary is loaded before anything else runs. This module finishes
// with a top-level await, and every module that imports it waits for that -
// so a label built when a module first loads, like a pen's name in a list,
// is already in the right language.

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'es', name: 'Español' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'de', name: 'Deutsch' }
];

let lang = 'en';
let dict = {};

/**
 * The language to use when nobody has chosen one: the machine's own, if it is
 * one we have, otherwise English. Taiwan, Hong Kong and Macau read
 * Traditional Chinese; the rest of the Chinese-speaking world Simplified.
 */
export function detectLanguage(list = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || []) {
  for (const raw of list) {
    const l = String(raw || '').toLowerCase();
    if (!l) continue;
    if (l.startsWith('zh')) {
      return /hant|-tw|-hk|-mo/.test(l) ? 'zh-Hant' : 'zh-Hans';
    }
    if (l.startsWith('pt')) return 'pt-BR';
    const base = l.split('-')[0];
    const hit = LANGUAGES.find((x) => x.code === base);
    if (hit) return hit.code;
  }
  return 'en';
}

/** The code in use right now. */
export function currentLanguage() { return lang; }

/** 'rtl' for Arabic, 'ltr' for everything else. */
export function direction(code = lang) {
  return LANGUAGES.find((x) => x.code === code)?.dir || 'ltr';
}

/** What the person chose in Settings, or 'auto'. Read straight from storage,
 *  because this runs before the app - and its settings - exist. */
export function chosenLanguage() {
  try {
    const s = JSON.parse(localStorage.getItem('gazboard.settings') || '{}');
    return s.language || 'auto';
  } catch { return 'auto'; }
}

export function resolveLanguage(choice = chosenLanguage()) {
  if ((!choice || choice === 'auto') && typeof window !== 'undefined' && window.board && window.board.smoke) return 'en';
  if (choice && choice !== 'auto' && LANGUAGES.some((x) => x.code === choice)) return choice;
  return detectLanguage();
}

/**
 * Translate one sentence.
 *
 *   t('Page {n} of {total}', { n: 2, total: 5 })
 *
 * Placeholders are named, never positional, because word order is one of the
 * first things to change between languages.
 */
export function t(text, vars) {
  let out = (lang !== 'en' && Object.prototype.hasOwnProperty.call(dict, text) && dict[text]) || text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

/** Load a language's dictionary and make it the one in use. */
export async function setLanguage(code) {
  const want = LANGUAGES.some((x) => x.code === code) ? code : 'en';
  let next = {};
  if (want !== 'en') {
    try {
      const url = new URL(`../locales/${want}.json`, import.meta.url);
      const res = await fetch(url);
      if (res.ok) next = await res.json();
    } catch { /* a missing file leaves the app in English, not broken */ }
  }
  dict = next;
  lang = want;
  // some test harnesses load this with a bare stand-in for document
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = want;
    document.documentElement.dir = direction(want);
  }
  return want;
}

/**
 * Words written straight into index.html - a tooltip, a placeholder, a
 * label - translated in place. The English stays in the page, so the page
 * still reads properly before this runs and in any build without it.
 */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[title]')) el.title = t(el.getAttribute('title'));
  for (const el of root.querySelectorAll('[aria-label]')) el.setAttribute('aria-label', t(el.getAttribute('aria-label')));
  for (const el of root.querySelectorAll('[placeholder]')) el.placeholder = t(el.getAttribute('placeholder'));
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.textContent.trim());
}

await setLanguage(resolveLanguage());
