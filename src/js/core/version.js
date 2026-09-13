// Version comparison for the update check.
//
// Deliberately small and deliberately strict: it understands the shape this
// project actually publishes - MAJOR.MINOR.PATCH with an optional -prerelease
// suffix - and refuses anything it does not recognise rather than guessing.
// An updater that mistakenly thinks a new version is available is a nuisance;
// one that mistakenly thinks 2.10.0 is older than 2.9.0 is worse, because it
// leaves people stranded on a broken build believing they are current.

/** Split "v2.10.1-beta.2" into { nums:[2,10,1], pre:'beta.2' }, or null. */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || null };
}

/**
 * Compare two prerelease suffixes the way semver says to.
 *
 * The suffix is split on dots and the pieces are compared one at a time. Two
 * numbers compare as numbers, so android.10 is later than android.2 - which a
 * plain text comparison gets backwards, and which matters here because every
 * Android build of one version differs only by that trailing number. A number
 * ranks below text when the two are side by side, and a suffix that runs out
 * of pieces first ranks lower, so beta ranks below beta.1.
 *
 * Returns a positive number when `a` is the later of the two.
 */
function comparePre(a, b) {
  const x = a.split('.'), y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny) return +x[i] - +y[i];
    if (nx !== ny) return nx ? -1 : 1;        // a number ranks below text
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Numeric parts compare as numbers, so 2.10.0 beats 2.9.0. A release beats a
 * prerelease of the same numbers (2.1.0 is newer than 2.1.0-beta.1), and a
 * prerelease never counts as an update over a release - nobody on a stable
 * build should be nudged onto a beta. Anything unparseable answers false.
 *
 * Two prereleases of the same version are compared rather than called equal.
 * That used to be a deliberate simplification, and it was wrong for Android:
 * every phone build carries the version it was cut from plus a build number,
 * so 2.6.6-android.1 and 2.6.6-android.2 are exactly the case the app needs to
 * tell apart, and calling them equal left people sitting on the older APK
 * being told they were current.
 */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] > b.nums[i]) return true;
    if (a.nums[i] < b.nums[i]) return false;
  }
  if (!a.pre && b.pre) return true;           // a release beats its prerelease
  if (a.pre && !b.pre) return false;          // and never the other way round
  if (a.pre && b.pre) return comparePre(a.pre, b.pre) > 0;
  return false;
}
