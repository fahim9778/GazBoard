/*
 * Recent boards: the boards this device opened last, newest first.
 *
 * It is a list of bookmarks and nothing more - a board's id, the name it had
 * and when it was opened - kept in this device's settings. The boards
 * themselves are never touched by it, so whatever happens to the list, the
 * worst it can do is point at the wrong place. It is not carried in folders.json
 * either: two computers sharing a boards folder each keep their own recents,
 * the way two browsers keep their own history.
 *
 * A board the list remembers but that is no longer there - deleted outside
 * GazBoard, or left behind in another boards folder - is still shown, marked as
 * not available, until it is removed by hand. Quietly dropping it would leave
 * people wondering where it went.
 */

export const KEEP = 12;      // remembered
export const SHOW = 8;       // shown at the top of My boards

const valid = (r) => r && typeof r.id === 'string' && r.id && Number.isFinite(r.at);
const listOf = (settings) => (Array.isArray(settings.recentBoards) ? settings.recentBoards.filter(valid) : []);

/** Remember that this board was just opened. Returns true when the list changed. */
export function noteOpened(settings, board, now = Date.now()) {
  if (!board || typeof board.id !== 'string' || !board.id) return false;
  const was = listOf(settings);
  const name = typeof board.name === 'string' ? board.name.slice(0, 200) : '';
  if (was[0] && was[0].id === board.id && was[0].name === name && now - was[0].at < 60000) return false;
  settings.recentBoards = [{ id: board.id, name, at: now }, ...was.filter((r) => r.id !== board.id)].slice(0, KEEP);
  return true;
}

/** Take a board off the list (its × button, or the board was deleted in GazBoard). */
export function forget(settings, id) {
  const was = listOf(settings);
  const now = was.filter((r) => r.id !== id);
  if (now.length === was.length && Array.isArray(settings.recentBoards)) return false;
  settings.recentBoards = now;
  return true;
}

/** The board was renamed while open: the list follows. */
export function rename(settings, id, name) {
  const r = listOf(settings).find((x) => x.id === id);
  if (!r || r.name === name) return false;
  r.name = String(name || '').slice(0, 200);
  return true;
}

/**
 * The list as it should be shown, matched against the boards that exist now:
 * [{ id, name, at, board }] where board is the live entry from the board list,
 * or null when the board is not here any more. A live board shows its current
 * name; a missing one the name it had.
 */
export function entries(settings, all, limit = SHOW) {
  const byId = new Map((all || []).map((b) => [b.id, b]));
  return listOf(settings).slice(0, limit).map((r) => {
    const board = byId.get(r.id) || null;
    return { id: r.id, name: (board && board.name) || r.name || '', at: r.at, board };
  });
}

/** "5 minutes ago", "yesterday", "3 days ago" - in the language the app is in. */
export function ago(at, lang, now = Date.now()) {
  const s = Math.round((at - now) / 1000);
  let fmt;
  try { fmt = new Intl.RelativeTimeFormat(lang || undefined, { numeric: 'auto' }); } catch { fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }); }
  const steps = [[60, 'second'], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400], [2629800, 'week', 604800], [31557600, 'month', 2629800], [Infinity, 'year', 31557600]];
  const a = Math.abs(s);
  if (a < 45) return fmt.format(0, 'second');
  for (const [limit, unit, div] of steps) if (a < limit) return fmt.format(Math.round(s / (div || 1)), unit);
  return '';
}
