#!/bin/sh
# Proves a board survives the machine going down.
#
# Launch 1 makes a board and is SIGKILLed - no clean quit, no chance to flush,
# which is what a PC restart does to a running app. Launch 2 must reopen it.
set -e
cd "$(dirname "$0")/.."
PROFILE="${PROFILE:-/tmp/gazboard-restart-test}"
rm -rf "$PROFILE"
rm -rf "${PROFILE}-custom"
rm -rf "${PROFILE}-custom-missing"

cat > /tmp/gb-restart-1.js <<'JS'
'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  await new Promise(r => setTimeout(r, 1200));
  const customDir = app.getPath('userData') + '-custom';
  const out = await js(`
    const a = window.app;
    const changed = await window.board.storage.apply({ path: ${JSON.stringify(customDir)}, mode: 'empty' });
    if (!changed.ok) throw new Error(changed.error);
    a.newBoard(true);
    a.store.rename('Work in progress');
    a.store.add({ id:'w1', type:'text', x:80, y:80, w:420, h:60, text:'three hours of notes',
      fontSize:32, color:'#201f1e', align:'left', valign:'top', rotation:0, font:'hand', background:'none' });
    await a.persist();
    return a.store.doc.id;
  `);
  console.log('CREATED ' + out);
  process.kill(process.pid, 'SIGKILL');     // the power goes out
};
JS

cat > /tmp/gb-restart-2.js <<'JS'
'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  await new Promise(r => setTimeout(r, 1600));
  const out = await js(`
    const a = window.app;
    const list = await window.board.boards.list();
    const storage = await window.board.storage.get();
    return { name: a.store.doc.name, objects: a.store.objects.length, boards: list.length, storage: storage.current };
  `);
  console.log('REOPENED ' + JSON.stringify(out));
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = path.join(app.getPath('userData'), 'storage-location.json');
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, boardsDir: app.getPath('userData') + '-custom-missing' }));
  app.exit(0);
};
JS

cat > /tmp/gb-restart-3.js <<'JS'
'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  await new Promise(r => setTimeout(r, 1600));
  const storage = await js(`return await window.board.storage.get();`);
  const warning = await js(`const e=document.getElementById('storageWarning'); return { hidden:e.hidden, text:e.textContent };`);
  const settings = await js(`window.app.panels.settings(); await new Promise(r=>setTimeout(r,150)); const s=[...document.querySelectorAll('.section')].find(e=>e.querySelector('h5')?.textContent==='Storage'); return { reset:!![...(s?.querySelectorAll('button')||[])].find(b=>b.textContent.includes('Reset to default')) };`);
  const fs = require('node:fs');
  const path = require('node:path');
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'storage-location.json'), 'utf8'));
  const missing = app.getPath('userData') + '-custom-missing';
  const reset = await js(`return await window.board.storage.reset({ mode:'use-as-is' });`);
  const afterReset = await js(`return await window.board.storage.get();`);
  console.log('FALLBACK ' + JSON.stringify({ storage, warning, settings, saved: saved.boardsDir, missingExists: fs.existsSync(missing), reset, afterReset }));
  app.exit(0);
};
JS

echo "launch 1 - make a board, then kill the process"
GAZBOARD_USER_DATA="$PROFILE" GAZBOARD_TEST=/tmp/gb-restart-1.js \
  xvfb-run -a npx electron . --smoke --no-sandbox 2>/dev/null | grep '^CREATED' || true

echo "launch 2 - it must come back"
RESULT=$(GAZBOARD_USER_DATA="$PROFILE" GAZBOARD_TEST=/tmp/gb-restart-2.js \
  xvfb-run -a npx electron . --smoke --no-sandbox 2>/dev/null | grep '^REOPENED' || true)
echo "$RESULT"

echo "$RESULT" | grep -q '"name":"Work in progress"' || { echo "FAIL: the board did not come back"; exit 1; }
echo "$RESULT" | grep -q '"objects":1' || { echo "FAIL: the board came back empty"; exit 1; }
echo "$RESULT" | grep -q '"boards":1' || { echo "FAIL: junk boards were left behind"; exit 1; }
echo "$RESULT" | grep -Fq "\"storage\":\"${PROFILE}-custom\"" || { echo "FAIL: custom storage setting did not survive restart"; exit 1; }
echo "launch 3 - missing custom folder falls back without changing the saved location"
FALLBACK=$(GAZBOARD_USER_DATA="$PROFILE" GAZBOARD_TEST_STORAGE_FALLBACK=default GAZBOARD_TEST=/tmp/gb-restart-3.js \
  xvfb-run -a pnpm exec electron . --smoke --no-sandbox 2>/dev/null | grep '^FALLBACK' || true)
echo "$FALLBACK"
echo "$FALLBACK" | grep -Fq "\"current\":\"${PROFILE}/boards\"" || { echo "FAIL: fallback did not use the default boards folder"; exit 1; }
echo "$FALLBACK" | grep -Fq '"isCustom":true' || { echo "FAIL: the saved custom folder was not retained"; exit 1; }
echo "$FALLBACK" | grep -Fq '"status":"fallback"' || { echo "FAIL: the app did not report fallback status"; exit 1; }
echo "$FALLBACK" | grep -Fq '"hidden":false' || { echo "FAIL: the fallback warning was not visible"; exit 1; }
echo "$FALLBACK" | grep -Fq '"reset":true' || { echo "FAIL: Settings did not offer reset on the fallback profile"; exit 1; }
echo "$FALLBACK" | grep -Fq "\"saved\":\"${PROFILE}-custom-missing\"" || { echo "FAIL: the unavailable path was erased from settings"; exit 1; }
echo "$FALLBACK" | grep -Fq '"missingExists":false' || { echo "FAIL: startup created the unavailable folder"; exit 1; }
echo "$FALLBACK" | grep -Fq '"isCustom":false' || { echo "FAIL: explicit reset did not clear the unavailable storage setting"; exit 1; }
echo "PASS - the board survived restart and an unavailable storage folder kept its setting"
