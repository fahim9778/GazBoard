// The pretend AppImages the suite updates between (test/smoke.js, updater section). appimage-update.zsync was made from
// pair().fresh by the real zsyncmake 0.6.2 - the tool the release workflow uses - so the suite checks GazBoard's reading of
// that format against the real thing, not against itself. Change these numbers and the .zsync has to be made again:
//   node test/fixtures/appimage-update.js /tmp && zsyncmake -u GazBoard-99.0.0.AppImage -o test/fixtures/appimage-update.zsync /tmp/GazBoard-99.0.0.AppImage
// the same pretend AppImages the suite builds: seeded, so the .zsync made from them by the real zsyncmake can be a fixture
function bytes(seed, n) { const b = Buffer.alloc(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; } return b; }
function pair() {
  const old = bytes(7, 2_000_000);
  const fresh = Buffer.concat([old.subarray(0, 300_000), bytes(11, 4_321), old.subarray(300_000, 1_200_000), old.subarray(1_250_000), bytes(13, 20_000)]);
  return { old, fresh };
}
module.exports = { bytes, pair };
if (require.main === module) { const { old, fresh } = pair(); require('fs').writeFileSync(process.argv[2] + '/old.AppImage', old); require('fs').writeFileSync(process.argv[2] + '/GazBoard-99.0.0.AppImage', fresh); }
