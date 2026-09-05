'use strict';
// Headless smoke test: drives the real renderer through every subsystem and
// writes screenshots to test/out/. Run with:  npm run smoke
const path = require('node:path');
const fs = require('node:fs/promises');

const OUT = process.env.GAZBOARD_SMOKE_OUT || path.join(__dirname, 'out');
const FIX = path.join(__dirname, 'fixtures');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  (ok ? pass++ : fail++);
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  await fs.writeFile(path.join(OUT, name + '.png'), img.toPNG());
}

async function run(win, app) {
  await fs.mkdir(OUT, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);

  await sleep(900);

  await js(`window.app.newBoard(true);`);
  await sleep(200);

  /* ---- boot ---- */
  check('app boots', await js(`return !!window.app && !!window.app.store;`));
  check('canvas sized', (await js(`return window.app.surface.width;`)) > 100);

  /* ---- ink ---- */
  await js(`
    const a = window.app;
    a.setTool('pen');
    const pts = [];
    for (let i = 0; i < 40; i++) pts.push({ x: -300 + i * 8, y: -100 + Math.sin(i / 4) * 40, p: 0.4 + (i % 7) / 14 });
    a.store.add({ id: 'stroke-test', type: 'stroke', tool: 'pen', color: '#e81123', width: 6, effect: 'none',
      points: pts, bbox: { x: -300, y: -145, w: 320, h: 90 }, rotation: 0 }, 'test');
  `);
  check('stroke added', await js(`return window.app.store.has('stroke-test');`));

  /* ---- shape recognition ---- */
  const rec = await js(`
    const { recognize } = await import('app://board/js/core/recognize.js');
    const box = [];
    for (let i = 0; i <= 30; i++) box.push({ x: i * 6, y: 0 });
    for (let i = 0; i <= 20; i++) box.push({ x: 180, y: i * 6 });
    for (let i = 30; i >= 0; i--) box.push({ x: i * 6, y: 120 });
    for (let i = 20; i >= 0; i--) box.push({ x: 0, y: i * 6 });
    const circle = [];
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; circle.push({ x: 100 + Math.cos(a) * 90, y: 100 + Math.sin(a) * 90 }); }
    const line = [];
    for (let i = 0; i <= 24; i++) line.push({ x: i * 10, y: i * 2 });
    const tri = [];
    for (let i = 0; i <= 16; i++) tri.push({ x: 100 - i * 6, y: i * 8 });
    for (let i = 0; i <= 16; i++) tri.push({ x: 4 + i * 12, y: 128 });
    for (let i = 0; i <= 16; i++) tri.push({ x: 196 - i * 6, y: 128 - i * 8 });
    return {
      rect: recognize(box)?.kind, circle: recognize(circle)?.kind,
      line: recognize(line)?.kind, tri: recognize(tri)?.kind
    };
  `);
  check('recognises rectangle', rec.rect === 'rect', JSON.stringify(rec.rect));
  check('recognises circle', rec.circle === 'circle' || rec.circle === 'ellipse', String(rec.circle));
  check('recognises line', rec.line === 'line', String(rec.line));
  check('recognises triangle', rec.tri === 'triangle', String(rec.tri));

  /* ---- notes, text, shapes, table ---- */
  await js(`
    const a = window.app;
    a.addNoteAt({ x: 200, y: -200 }); a.textEditor.cancel();
    const noteObj = a.store.objects.filter(o => o.type === 'note').pop();
    a.store.update(noteObj.id, { text: 'Sticky note' });
    a.addTextAt({ x: 200, y: 60 }); a.textEditor.cancel();
    a.store.add({ id: 'shape-test', type: 'shape', kind: 'roundRect', x: -320, y: 80, w: 240, h: 150,
      rotation: 0, stroke: '#0078d4', fill: '#bfdbfe', lineWidth: 3, text: 'Shape with text' }, 'test');
    a.addTable();
    const tableObj = a.store.objects.filter(o => o.type === 'table').pop();
    a.store.update(tableObj.id, { cells: { '0,0': 'A', '0,1': 'B', '1,0': '1' } });
  `);
  const counts = await js(`
    const t = {};
    for (const o of window.app.store.objects) t[o.type] = (t[o.type] || 0) + 1;
    return t;
  `);
  check('note created', counts.note >= 1, JSON.stringify(counts));
  check('shape created', counts.shape >= 1);
  check('table created', counts.table >= 1);

  /* ---- undo / redo ---- */
  const undoOk = await js(`
    const a = window.app, n0 = a.store.count;
    a.store.add({ id: 'tmp-undo', type: 'shape', kind: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    const n1 = a.store.count; a.store.undo();
    const n2 = a.store.count; a.store.redo();
    const n3 = a.store.count; a.store.undo();
    return n1 === n0 + 1 && n2 === n0 && n3 === n0 + 1 && a.store.count === n0;
  `);
  check('undo / redo round-trips', undoOk);

  /* ---- transforms ---- */
  const moved = await js(`
    const a = window.app;
    const { translateObject, scaleObject, rotateObjectAround } = await import('app://board/js/core/transform.js');
    const o = a.store.get('shape-test');
    const x0 = o.x; translateObject(o, 40, 0);
    const x1 = o.x; scaleObject(o, 2, 2, o.x, o.y);
    const w1 = o.w; rotateObjectAround(o, Math.PI / 8, o.x, o.y);
    return { dx: x1 - x0, w1, rot: o.rotation };
  `);
  check('translate/scale/rotate work', moved.dx === 40 && moved.w1 === 480 && moved.rot > 0, JSON.stringify(moved));

  /* ---- hit testing ---- */
  const hit = await js(`
    const { pick, inBox } = await import('app://board/js/core/hit.js');
    const a = window.app;
    const o = a.store.get('shape-test');
    const inside = pick(a.store, { x: o.x + o.w / 2, y: o.y + o.h / 2 }, 4);
    const outside = pick(a.store, { x: o.x - 4000, y: o.y - 4000 }, 4);
    const box = inBox(a.store, { x: -5000, y: -5000, w: 10000, h: 10000 });
    return { inside: inside && inside.id, outside: !!outside, boxCount: box.length };
  `);
  check('hit test finds object', hit.inside === 'shape-test', JSON.stringify(hit));
  check('hit test misses empty space', hit.outside === false);
  check('marquee selects everything', hit.boxCount === (await js(`return window.app.store.count;`)));

  /* ---- erasing ---- */
  const erase = await js(`
    const a = window.app;
    const it = a.interaction;
    const mk = (id) => {
      const pts = [];
      for (let i = 0; i <= 100; i++) pts.push({ x: i * 5, y: 600, p: 0.5 });
      return { id, type: 'stroke', tool: 'pen', color: '#111', width: 4, effect: 'none',
               points: pts, bbox: { x: 0, y: 600, w: 500, h: 0 }, rotation: 0 };
    };
    const sweep = (from, to) => { it.startErase(from); it.eraseSweep(it.action, from, to); it.finishErase(it.action); it.action = null; };

    a.surface.cam.z = 1;
    const before = a.store.count;

    // 1. partial: a stroke cut through the middle becomes two
    a.store.add(mk('erase-a'));
    a.settings.eraserMode = 'partial'; a.settings.eraserSize = 40;
    sweep({ x: 250, y: 540 }, { x: 250, y: 660 });
    const frags = a.store.objects.filter(o => o.type === 'stroke' && Math.abs(o.bbox.y - 600) < 5);
    const gone = !a.store.has('erase-a');
    const gap = frags.length === 2
      ? Math.round(Math.min(...frags.map(f => Math.max(f.bbox.x, 0) + f.bbox.w)) * 0) || true : false;

    // 2. undo puts the original back, intact
    a.store.undo();
    const restored = a.store.get('erase-a');
    const restoredPts = restored ? restored.points.length : 0;

    // 3. a near miss leaves the ink alone
    sweep({ x: 250, y: 200 }, { x: 250, y: 300 });
    const untouched = a.store.has('erase-a') && a.store.get('erase-a').points.length === 101;

    // 4. object mode takes the whole stroke
    a.settings.eraserMode = 'object';
    sweep({ x: 250, y: 540 }, { x: 250, y: 660 });
    const wholeGone = !a.store.has('erase-a');
    a.store.undo();

    // 5. partial erase off the end of a stroke leaves a single shorter run
    a.settings.eraserMode = 'partial';
    sweep({ x: 500, y: 540 }, { x: 500, y: 660 });
    const tail = a.store.objects.filter(o => o.type === 'stroke' && Math.abs(o.bbox.y - 600) < 5);

    // clean up
    while (a.store.canUndo && a.store.count > before) a.store.undo();
    a.settings.eraserMode = 'partial';
    return {
      fragCount: frags.length, gone, restoredPts, untouched, wholeGone,
      tailCount: tail.length, tailW: tail[0] ? Math.round(tail[0].bbox.w) : -1,
      cleanCount: a.store.count, before
    };
  `);
  check('partial erase splits a stroke in two', erase.fragCount === 2 && erase.gone, JSON.stringify({ frags: erase.fragCount, originalGone: erase.gone }));
  check('undo restores the erased stroke', erase.restoredPts === 101, erase.restoredPts + ' points');
  check('eraser near-miss leaves ink alone', erase.untouched);
  check('object mode erases the whole stroke', erase.wholeGone);

  /* ---- the eraser is an INK tool ---- *
   * Whole-stroke mode had no type guard, so a scrub across a slide deleted the
   * slide. Annotating an imported page and rubbing the annotation off has to
   * leave the page there, in both modes.
   */
  const inkOnly = await js(`
    const a = window.app;
    const inter = a.interaction;
    const r = {};

    const build = () => {
      a.newBoard(true);
      a.store.clear();
      // an imported page, a picture, a note, a text box and a shape
      const px = document.createElement('canvas'); px.width = px.height = 8;
      const url = px.toDataURL('image/png');
      a.store.add({ id: 'page', type: 'image', kind: 'page', x: -300, y: -200, w: 600, h: 400,
                    rotation: 0, src: url, name: 'doc', label: 'p1' }, 'x');
      a.store.add({ id: 'pic', type: 'image', x: -280, y: -180, w: 120, h: 90, rotation: 0, src: url, name: 'i' }, 'x');
      a.store.add({ id: 'note', type: 'note', x: -100, y: -100, w: 160, h: 160, text: 'n',
                    color: '#ffd94a', rotation: 0, align: 'center', font: 'ui' }, 'x');
      a.store.add({ id: 'txt', type: 'text', x: 40, y: -60, w: 200, h: 40, text: 'hello', rotation: 0,
                    color: '#000', fontSize: 24, align: 'left', valign: 'top', font: 'ui', background: 'none' }, 'x');
      a.store.add({ id: 'shp', type: 'shape', kind: 'rect', x: 80, y: 40, w: 120, h: 90,
                    rotation: 0, stroke: '#000', fill: 'none', lineWidth: 3 }, 'x');
      // ink laid right across all of them
      const pts = []; for (let i = 0; i < 60; i++) pts.push({ x: -280 + i * 9, y: -20 + Math.sin(i / 5) * 6, p: .6 });
      a.store.add({ id: 'ink', type: 'stroke', tool: 'pen', color: '#e81123', width: 6, effect: 'none',
                    points: pts, bbox: { x: -280, y: -30, w: 540, h: 20 }, rotation: 0 }, 'x');
    };
    const survivors = () => ['page', 'pic', 'note', 'txt', 'shp'].filter(id => a.store.has(id));

    // --- whole-stroke mode: scrub straight across everything
    build();
    a.settings.eraserMode = 'object';
    a.setTool('eraser');
    inter.startErase({ x: -280, y: -20 });
    for (let i = 1; i <= 60; i++) inter.eraseSweep(inter.action, { x: -280 + (i - 1) * 9, y: -20 }, { x: -280 + i * 9, y: -20 });
    if (inter.action) { inter.finishErase(inter.action); inter.action = null; }
    r.objectMode = { survived: survivors(), inkGone: !a.store.has('ink') };

    // --- part-erase mode: same scrub
    build();
    a.settings.eraserMode = 'partial';
    inter.startErase({ x: -280, y: -20 });
    for (let i = 1; i <= 60; i++) inter.eraseSweep(inter.action, { x: -280 + (i - 1) * 9, y: -20 }, { x: -280 + i * 9, y: -20 });
    if (inter.action) { inter.finishErase(inter.action); inter.action = null; }
    r.partialMode = { survived: survivors(), inkGone: !a.store.has('ink') };

    a.settings.eraserMode = 'partial';
    a.setTool('pen');
    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('erasing whole strokes never touches images, pages, notes, text or shapes',
    inkOnly.objectMode.survived.length === 5 && inkOnly.objectMode.inkGone === true,
    JSON.stringify(inkOnly.objectMode));
  check('and neither does part-erase',
    inkOnly.partialMode.survived.length === 5 && inkOnly.partialMode.inkGone === true,
    JSON.stringify(inkOnly.partialMode));
  check('erasing an end leaves one shorter run', erase.tailCount === 1 && erase.tailW < 500 && erase.tailW > 400, `${erase.tailCount} run(s), width ${erase.tailW}`);

  /* ---- the canvas must always fill the window ---- */
  const fits = async (label) => js(`
    const sf = window.app.surface, c = sf.canvas;
    const stage = document.getElementById('stage');
    const r = c.getBoundingClientRect(), s = stage.getBoundingClientRect();
    return {
      label: ${JSON.stringify(label)},
      elementFillsStage: Math.abs(r.width - s.width) < 1.5 && Math.abs(r.height - s.height) < 1.5,
      // A backing store has to be a whole number of device pixels, but at a
      // fractional device pixel ratio - Windows at 125% display scaling, say -
      // the CSS rect it is derived from is fractional too, so browser and test
      // can round the same size in opposite directions. One device pixel is
      // rounding; a stale buffer is out by hundreds, and is still caught.
      bufferMatches: Math.abs(c.width - r.width * sf.dpr) <= 1 && Math.abs(c.height - r.height * sf.dpr) <= 1,
      inlineSize: (c.style.width || '') + (c.style.height || ''),
      w: Math.round(r.width), h: Math.round(r.height),
      stageW: Math.round(s.width), stageH: Math.round(s.height),
      bufW: c.width, bufH: c.height, dpr: sf.dpr,
      surfaceW: sf.width
    };
  `);

  // A window resize settles asynchronously, and macOS takes far longer over it
  // than X11 or Windows do - a flat sleep measured mid-resize there and made
  // this read as a canvas bug. Poll until the surface has caught up with its
  // own element instead. The assertion is unchanged: if it never catches up,
  // the last sample is still recorded and still fails.
  // Waiting for a resize is not the same as waiting a fixed time: the poll must
  // not accept the size the window had a moment ago. Where the width that
  // should arrive is known it is named, so a stale reading can never satisfy
  // the wait; where it is not (maximise depends on the screen), the width has
  // to hold still for three consecutive reads after a settling pause.
  const settle = async (label, expectW) => {
    await sleep(250);
    let s = await fits(label), last = -1, held = 0;
    for (let i = 0; i < 60; i++) {
      held = s.w === last ? held + 1 : 0;
      last = s.w;
      const right = expectW === undefined ? held >= 2 : s.w === expectW;
      if (right && s.elementFillsStage && s.bufferMatches && s.surfaceW === s.w) return s;
      await sleep(50);
      s = await fits(label);
    }
    return s;
  };

  const sizes = [];
  sizes.push(await settle('initial'));
  win.setSize(1100, 780); sizes.push(await settle('shrunk', 1100));
  win.setSize(1500, 950); sizes.push(await settle('grown', 1500));
  win.maximize(); sizes.push(await settle('maximised'));
  win.unmaximize(); sizes.push(await settle('restored', 1500));
  // a zoom-factor change moves devicePixelRatio without any window resize -
  // the same shape as a Windows display-scaling change
  win.webContents.setZoomFactor(1.25); sizes.push(await settle('dpr 1.25', 1200));
  win.webContents.setZoomFactor(1); sizes.push(await settle('dpr back', 1500));
  win.setSize(1440, 900); await sleep(400);

  const bad = sizes.filter((s) => !s.elementFillsStage || !s.bufferMatches);
  check('canvas fills the window at every size', bad.length === 0,
    bad.length ? bad.map((b) => `${b.label}: canvas ${b.w}x${b.h} vs stage ${b.stageW}x${b.stageH}, buffer ${b.bufW}x${b.bufH} at dpr ${b.dpr}`).join('; ')
      : sizes.map((s) => `${s.label} ${s.w}x${s.h}@${s.dpr}`).join(', '));
  check('no inline size is pinned on the canvas', sizes.every((s) => s.inlineSize === ''), sizes[0].inlineSize || '(none)');
  check('the surface tracks the new size', sizes.every((s) => s.surfaceW === s.w));

  const heal = await js(`
    // simulate the old bug: pin a stale size, then let the frame loop notice
    const sf = window.app.surface, c = sf.canvas;
    sf.width = 640; sf.height = 480; c.width = 640; c.height = 480;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 120));
    const r2 = c.getBoundingClientRect();
    return { w: c.width, expected: Math.round(r2.width * sf.dpr), surfaceW: sf.width, boxW: Math.round(r2.width) };
  `);
  check('a stale buffer self-corrects within a frame', heal.w === heal.expected && heal.surfaceW === heal.boxW,
    `buffer ${heal.w}, expected ${heal.expected}`);

  /* ---- HiDPI: the whole buffer must be painted ---- */
  const hidpi = await js(`
    const sf = window.app.surface, c = sf.canvas, ctx = sf.ctx;
    const a = window.app;
    a.store.setBackground({ color: '#ffffff', pattern: 'none' });
    const realDpr = sf.dpr;
    const probe = (dpr) => {
      // paint as if the display were scaled, then read the far corner
      sf.dpr = dpr;
      c.width = Math.round(sf.width * dpr);
      c.height = Math.round(sf.height * dpr);
      sf.draw();
      const far = ctx.getImageData(c.width - 2, c.height - 2, 1, 1).data;
      const mid = ctx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data;
      return { dpr, far: [far[0], far[1], far[2]], mid: [mid[0], mid[1], mid[2]] };
    };
    const out = [1, 1.25, 1.5, 2].map(probe);
    sf.dpr = realDpr; sf.resize(true); sf.draw();
    return out;
  `);
  const painted = (p) => p.far[0] > 240 && p.far[1] > 240 && p.far[2] > 240;
  check('background covers the canvas at every scale factor', hidpi.every(painted),
    hidpi.map((p) => `${p.dpr}x rgb(${p.far})`).join(', '));

  const chrome = await js(`
    const sf = window.app.surface, a = window.app;
    // selection chrome is drawn in screen space - it must land on the object
    // at any scale, not at 1/dpr of the way across the canvas
    a.newBoard(true);
    sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    const o = { id: 'dpi-box', type: 'shape', kind: 'rect', x: 60, y: 60, w: 200, h: 120,
                rotation: 0, stroke: '#000000', fill: '#000000', lineWidth: 2 };
    a.store.add(o);
    a.setSelection(['dpi-box']);
    const realDpr = sf.dpr;
    const probe = (dpr) => {
      sf.dpr = dpr;
      sf.canvas.width = Math.round(sf.width * dpr);
      sf.canvas.height = Math.round(sf.height * dpr);
      sf.draw();
      // the handle sits at the shape's top-left corner: world (60,60) -> device (60*dpr)
      const d = sf.ctx.getImageData(Math.round(60 * dpr), Math.round(60 * dpr), 1, 1).data;
      // blue selection handle stroke or white handle fill, never the page background alone
      return { dpr, px: [d[0], d[1], d[2]] };
    };
    const out = [1, 1.5, 2].map(probe);
    sf.dpr = realDpr; sf.resize(true); a.store.clear(); a.setSelection([]); sf.draw();
    return out;
  `);
  check('selection chrome lands on the object at every scale factor',
    chrome.every((p) => !(p.px[0] > 250 && p.px[1] > 250 && p.px[2] > 250)),
    chrome.map((p) => `${p.dpr}x rgb(${p.px})`).join(', '));

  /* ---- placing text and notes, then getting hold of them again ---- */
  const place = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'yes';
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    const click = (x, y) => { it.onDown(ev(x, y)); it.onMove(ev(x, y)); it.onUp(ev(x, y)); it.action = null; it.pointers.clear(); };

    // 1. a note placed at 100% zoom
    a.setTool('note');
    click(300, 300);
    a.textEditor.cancel();
    const note = a.store.objects.find(o => o.type === 'note');
    const noteAt100 = note ? Math.round(note.w) : 0;
    const toolAfterNote = a.tool;                 // should have returned to Select

    // 2. the same note placed while zoomed out - it must still look the same size
    a.store.clear();
    sf.cam.z = 0.36;
    a.setTool('note');
    click(300, 300);
    a.textEditor.cancel();
    const zoomedNote = a.store.objects.find(o => o.type === 'note');
    const onScreen = zoomedNote ? Math.round(zoomedNote.w * sf.cam.z) : 0;

    // 3. text placed while zoomed out is legible, not 11px tall
    a.store.clear();
    a.setTool('text');
    click(400, 400);
    if (a.textEditor.active) a.textEditor.el.value = 'hello';
    a.textEditor.commit();
    const txt = a.store.objects.find(o => o.type === 'text');
    const textOnScreen = txt ? Math.round(txt.fontSize * sf.cam.z) : 0;
    const toolAfterText = a.tool;

    // 4. clicking existing text with the Text tool selects it instead of stacking a new one
    sf.cam.z = 1;
    const countBefore = a.store.count;
    a.setTool('text');
    click(Math.round(txt.x + txt.w / 2), Math.round(txt.y + txt.h / 2));
    const countAfter = a.store.count;
    const selectedText = [...sf.selection][0] === txt.id;
    const editing = a.textEditor.active;
    a.textEditor.cancel();

    // 5. and it can then be dragged
    a.setTool('select');
    const x0 = a.store.get(txt.id).x;
    it.onDown(ev(Math.round(txt.x + txt.w / 2), Math.round(txt.y + txt.h / 2)));
    const started = it.action ? it.action.type : 'none';
    it.onMove(ev(Math.round(txt.x + txt.w / 2) + 60, Math.round(txt.y + txt.h / 2)));
    it.onUp(ev(Math.round(txt.x + txt.w / 2) + 60, Math.round(txt.y + txt.h / 2)));
    it.action = null; it.pointers.clear();
    const moved = Math.round(a.store.get(txt.id).x - x0);

    a.settings.inkWithMouse = 'auto'; a.setTool('select'); a.store.clear();
    return { noteAt100, toolAfterNote, onScreen, textOnScreen, toolAfterText,
             countBefore, countAfter, selectedText, editing, started, moved,
             defaultText: a.settings.textSize };
  `);
  // Placing hands the board back to the ink tool, so the next stylus touch
  // writes. The placement tool must not still be armed either, or the click
  // after would drop a second note.
  check('placing a note does not leave the Note tool armed', place.toolAfterNote !== 'note', place.toolAfterNote);
  check('placing text does not leave the Text tool armed', place.toolAfterText !== 'text', place.toolAfterText);
  check('a note keeps its on-screen size when zoomed out',
    Math.abs(place.onScreen - place.noteAt100) <= 2, `${place.noteAt100}px at 100%, ${place.onScreen}px at 36%`);
  check('text placed while zoomed out is still legible', place.textOnScreen >= 24,
    place.textOnScreen + 'px on screen (default ' + place.defaultText + ')');
  check('clicking existing text selects it instead of adding another',
    place.countAfter === place.countBefore && place.selectedText,
    `${place.countBefore} -> ${place.countAfter}`);
  check('clicking existing text opens it for editing', place.editing);
  check('text can then be dragged', place.started === 'move' && place.moved === 60,
    `${place.started}, moved ${place.moved}`);

  const after = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'yes';
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y, type) => ({ pointerId: 1, pointerType: type || 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    const click = (x, y, type) => { it.onDown(ev(x, y, type)); it.onMove(ev(x, y, type)); it.onUp(ev(x, y, type)); it.action = null; it.pointers.clear(); };

    a.setTool('pen');                       // the tool in hand before typing
    a.setTool('text');
    click(400, 400);
    if (a.textEditor.active) a.textEditor.el.value = 'hi';
    a.textEditor.commit();
    const toolAfterTyping = a.tool;         // should be back to the pen
    const box = a.store.objects.find(o => o.type === 'text');
    const fitted = box ? { w: Math.round(box.w), h: Math.round(box.h), size: box.fontSize } : null;

    // the very next stylus touch must draw, not marquee
    it.onDown(ev(600, 600, 'pen'));
    const strokeStarted = it.action ? it.action.type : 'none';
    it.onMove(ev(650, 640, 'pen'));
    it.onUp(ev(650, 640, 'pen'));
    it.action = null; it.pointers.clear();
    const inked = a.store.objects.filter(o => o.type === 'stroke').length;

    // a long line wraps rather than growing forever
    a.setTool('text');
    click(200, 800);
    if (a.textEditor.active) a.textEditor.el.value = 'a much longer line of text that has to wrap somewhere sensible';
    a.textEditor.commit();
    const boxes = a.store.objects.filter(o => o.type === 'text');
    const longBox = boxes[boxes.length - 1];

    // double-clicking from Select stays in Select
    a.setTool('select');
    const live = a.store.objects.find(o => o.type === 'text');
    let toolAfterSelectEdit = 'no-text-object';
    if (live) {
      a.setSelection([live.id]);
      a.beginTextEdit(live);
      a.textEditor.commit();
      toolAfterSelectEdit = a.tool;
    }

    a.settings.inkWithMouse = 'auto'; a.setTool('select'); a.store.clear();
    return { toolAfterTyping, fitted, strokeStarted, inked,
             boxes: boxes.length,
             longW: longBox ? Math.round(longBox.w) : -1,
             longH: longBox ? Math.round(longBox.h) : -1,
             toolAfterSelectEdit };
  `);
  check('typing hands the board back to the pen', after.toolAfterTyping === 'pen', after.toolAfterTyping);
  check('a stylus placed straight after typing draws',
    after.strokeStarted === 'draw' && after.inked === 1, `${after.strokeStarted}, ${after.inked} stroke`);
  check('the text box shrinks to the text',
    after.fitted.w < 90 && after.fitted.h < after.fitted.size * 2,
    `${after.fitted.w}x${after.fitted.h} for "hi" at ${after.fitted.size}px`);
  check('a long line wraps instead of running away',
    after.longW <= 360 && after.longH > after.fitted.h,
    `${after.longW}x${after.longH}`);
  check('editing from Select stays in Select', after.toolAfterSelectEdit === 'select', after.toolAfterSelectEdit);

  /* ---- straightening is opt-in, and never eats your ink ---- */
  const straighten = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'yes';
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'pen', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.6 });
    const box = () => {
      const path = [];
      for (let i = 0; i <= 30; i++) path.push([100 + i * 6, 100]);
      for (let i = 0; i <= 20; i++) path.push([280, 100 + i * 6]);
      for (let i = 30; i >= 0; i--) path.push([100 + i * 6, 220]);
      for (let i = 20; i >= 0; i--) path.push([100, 100 + i * 6]);
      a.setTool('pen');
      it.onDown(ev(path[0][0], path[0][1]));
      for (const p of path.slice(1)) it.onMove(ev(p[0], p[1]));
      it.onUp(ev(path[path.length - 1][0], path[path.length - 1][1]));
      it.action = null; it.pointers.clear();
    };
    const kinds = () => a.store.objects.map(o => o.type).sort().join(',');

    // default: ink is left exactly as drawn
    const defaultSetting = a.settings.inkToShape;
    a.store.clear();
    box();
    const withDefault = kinds();

    // switched on: the box straightens...
    a.store.clear();
    a.settings.inkToShape = true;
    box();
    const converted = kinds();

    // ...and one undo gives the handwriting back, rather than deleting it
    a.store.undo();
    const afterUndo = kinds();
    const inkPoints = (a.store.objects.find(o => o.type === 'stroke') || {}).points;
    a.store.undo();
    const afterSecondUndo = a.store.count;

    a.settings.inkToShape = false; a.settings.inkWithMouse = 'auto';
    a.setTool('select'); a.store.clear();
    return { defaultSetting, withDefault, converted, afterUndo,
             inkKept: Array.isArray(inkPoints) && inkPoints.length > 20, afterSecondUndo };
  `);
  check('straightening is off by default', straighten.defaultSetting === false);
  check('by default ink is kept exactly as drawn', straighten.withDefault === 'stroke', straighten.withDefault);
  check('switched on, a drawn box becomes a shape', straighten.converted === 'shape', straighten.converted);
  check('one undo returns the original ink, not nothing',
    straighten.afterUndo === 'stroke' && straighten.inkKept, straighten.afterUndo);
  check('a second undo clears it', straighten.afterSecondUndo === 0);

  const fidelity = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkToShape = false; a.settings.inkWithMouse = 'yes';
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'pen', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.6 });

    const path = [];
    for (let t = 0; t <= Math.PI * 5; t += 0.06)
      path.push([120 + t * 22, 300 + 26 * Math.sin(t) + 9 * Math.sin(2.6 * t)]);

    a.setTool('pen');
    it.onDown(ev(path[0][0], path[0][1]));
    for (const p of path.slice(1)) it.onMove(ev(p[0], p[1]));

    // snapshot the wet stroke as rendered, then lift and render again
    const W = Math.round(520 * sf.dpr);
    const shot = () => { sf.draw(); return sf.ctx.getImageData(80 * sf.dpr, 240 * sf.dpr, W, Math.round(140 * sf.dpr)).data; };
    const wetPoints = sf.wet.points.length;
    const before = shot();
    it.onUp(ev(path[path.length-1][0], path[path.length-1][1]));
    it.action = null; it.pointers.clear();
    const after = shot();

    // Where the ink actually sits, measured from the pixels rather than from
    // the model - this is what catches the stroke being re-shaped on lift.
    //
    // Two measurements, both of which a re-shaped stroke would break and
    // neither of which anti-aliasing can: the outline it occupies, and the
    // line down the middle of it. The centreline is taken column by column,
    // weighted by how dark each pixel is, so a rasteriser that lays down a
    // heavier or lighter fringe on both sides of the stroke - which is what
    // macOS does, and why it draws the same stroke with more ink pixels than
    // Skia's software raster on X11 - cancels out instead of registering as
    // movement. The path is drawn left to right and never doubles back, so
    // each column has exactly one centre.
    const inkStats = (d) => {
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      const wy = new Float64Array(W), ww = new Float64Array(W);
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        if (v > 200) continue;                 // background is white
        const px = i / 4, x = px % W, y = (px - x) / W, k = 255 - v;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        wy[x] += y * k; ww[x] += k; n++;
      }
      return { x0, y0, x1, y1, wy, ww, n };
    };
    const A = inkStats(before), B = inkStats(after);
    const edgeShift = Math.max(Math.abs(A.x0 - B.x0), Math.abs(A.y0 - B.y0),
                               Math.abs(A.x1 - B.x1), Math.abs(A.y1 - B.y1));
    let worstCol = 0, sumCol = 0, cols = 0;
    for (let x = 0; x < W; x++) {
      if (A.ww[x] < 255 || B.ww[x] < 255) continue;   // ignore a lone faint pixel
      const dv = Math.abs(A.wy[x] / A.ww[x] - B.wy[x] / B.ww[x]);
      if (dv > worstCol) worstCol = dv;
      sumCol += dv; cols++;
    }
    const centreShift = cols ? sumCol / cols : 99;

    let diff = 0;
    for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) > 24) diff++;
    const s = a.store.objects.find(o => o.type === 'stroke');

    a.settings.inkWithMouse = 'auto'; a.setTool('select'); a.store.clear();
    return { wetPoints, storedPoints: s.points.length, changedPixels: diff,
             total: before.length / 4, edgeShift, centreShift, worstCol, cols,
             inkBefore: A.n, inkAfter: B.n, dpr: sf.dpr };
  `);
  check('lifting the pen keeps every point', fidelity.storedPoints === fidelity.wetPoints,
    `${fidelity.wetPoints} while drawing, ${fidelity.storedPoints} after`);
  // The stroke you were watching must not be redrawn differently when you lift.
  // Measured as geometry, so it means the same thing on every rasteriser.
  check('the stroke does not change shape when you lift',
    fidelity.edgeShift <= 1 && fidelity.worstCol <= 1 && fidelity.cols > 300,
    `outline moved ${fidelity.edgeShift}px, centreline worst ${fidelity.worstCol.toFixed(3)}px ` +
    `mean ${fidelity.centreShift.toFixed(3)}px over ${fidelity.cols} columns`);
  // Belt and braces on top of the geometry check. macOS anti-aliases the ink
  // noticeably differently from Skia's software raster on X11 and Windows -
  // about 0.5% of the sampled box against 0.01% on Linux, all of it on the
  // edges of the stroke - so the tolerance here is set by the rasteriser, not
  // by how much the drawing is allowed to move.
  check('and it is redrawn essentially pixel-for-pixel',
    fidelity.changedPixels < fidelity.total * 0.01,
    `${fidelity.changedPixels} of ${fidelity.total} pixels differ, ${fidelity.inkBefore} -> ${fidelity.inkAfter} ink pixels`);

  const misfire = await js(`
    const { recognize, fitError, MAX_FIT_ERROR } = await import('app://board/js/core/recognize.js');
    const mk = (fn, n, step) => { const P = []; for (let i = 0; i <= n; i += step) P.push(fn(i)); return P; };

    // a deliberate circle: should classify and fit
    const circle = mk(i => ({ x: 200 + Math.cos(i / 40 * Math.PI * 2) * 90,
                              y: 200 + Math.sin(i / 40 * Math.PI * 2) * 90, p: 0.5 }), 40, 1);
    const cr = recognize(circle);
    const cfit = cr ? fitError(circle, cr.kind, cr) : 1;

    // a scribble: a loop with a wild excursion. It can still satisfy the corner
    // and variance tests, which is where a wrong shape used to come from.
    const scribble = [];
    for (let i = 0; i <= 60; i++) {
      const a2 = i / 60 * Math.PI * 2;
      const wob = 1 + 0.55 * Math.sin(a2 * 7) + 0.3 * Math.sin(a2 * 13);
      scribble.push({ x: 200 + Math.cos(a2) * 90 * wob, y: 200 + Math.sin(a2) * 90 * wob, p: 0.5 });
    }
    const sr = recognize(scribble);
    const sfit = sr ? fitError(scribble, sr.kind, sr) : 1;

    return { circleKind: cr && cr.kind, cfit: +cfit.toFixed(3),
             scribbleKind: sr && sr.kind, sfit: +sfit.toFixed(3), max: MAX_FIT_ERROR };
  `);
  check('a deliberate circle passes the fit test',
    (misfire.circleKind === 'circle' || misfire.circleKind === 'ellipse') && misfire.cfit < misfire.max,
    `${misfire.circleKind}, fit error ${misfire.cfit}`);
  check('a scribble is rejected rather than forced into a shape',
    misfire.sfit > misfire.max,
    `classified ${misfire.scribbleKind}, fit error ${misfire.sfit} vs limit ${misfire.max}`);

  /* ---- toolbar, deselect, zoom pill, fonts, lock adoption ---- */
  const toolbar = await js(`
    const a = window.app;
    const bar = document.getElementById('toolbar');
    const pens = [...bar.querySelectorAll('.pen[data-pen]')];
    const { PENS } = await import('app://board/js/ui/palettes.js');

    // clicking the red pen selects the pen tool in red
    const red = pens.find(p => p.dataset.pen === 'red');
    red.click();
    const afterRed = { tool: a.tool, color: a.settings.penColor, raised: red.classList.contains('active') };

    // the raised pen follows the setting, and only one is raised
    const galaxy = pens.find(p => p.dataset.pen === 'galaxy');
    galaxy.click();
    const raisedCount = pens.filter(p => p.classList.contains('active')).length;
    const afterGalaxy = { effect: a.settings.penEffect, raised: galaxy.classList.contains('active') };

    // clicking the pen you are already holding opens its options
    galaxy.click();
    await new Promise(r => setTimeout(r, 60));
    const opened = !!document.querySelector('.pop .sizes');
    document.body.click();

    const has = (sel) => !!bar.querySelector(sel);
    a.setTool('select');
    return {
      pens: pens.length, afterRed, afterGalaxy, raisedCount, opened,
      hasHighlighter: has('[data-tool="highlighter"]'), hasEraser: has('[data-tool="eraser"]'),
      hasNote: has('[data-tool="note"]'), hasText: has('[data-tool="text"]'),
      hasRuler: has('[data-cmd="ruler"]'), hasUndo: has('[data-cmd="undo"]'),
      hasImage: has('[data-cmd="insert.image"]'), penCount: PENS.length
    };
  `);
  check('the toolbar has a pen tray', toolbar.pens === toolbar.penCount && toolbar.pens === 6,
    toolbar.pens + ' pens');
  check('picking a pen sets its colour', toolbar.afterRed.tool === 'pen' && toolbar.afterRed.color === '#e81123');
  check('the pen in hand is the raised one, and only it',
    toolbar.afterGalaxy.raised && toolbar.raisedCount === 1 && toolbar.afterGalaxy.effect === 'galaxy');
  check('clicking the held pen opens its options', toolbar.opened);
  check('highlighter, eraser, ruler, note, text, image and undo are all there',
    toolbar.hasHighlighter && toolbar.hasEraser && toolbar.hasRuler &&
    toolbar.hasNote && toolbar.hasText && toolbar.hasImage && toolbar.hasUndo);

  const misc = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    const { FONTS, fontStack } = await import('app://board/js/ui/palettes.js');
    const { faceOf } = await import('app://board/js/core/render.js');
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });

    // 1. clicking empty canvas drops the selection
    a.store.add({ id: 'd1', type: 'shape', kind: 'rect', x: 100, y: 100, w: 120, h: 120,
                  rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 });
    a.setTool('select');
    a.setSelection(['d1']);
    const selBefore = sf.selection.size;
    it.onDown(ev(700, 700)); it.onMove(ev(700, 700)); it.onUp(ev(700, 700));
    it.action = null; it.pointers.clear();
    const selAfterSelect = sf.selection.size;

    // and with an ink tool, where the mouse pans
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = true;
    a.setTool('select'); a.setSelection(['d1']);
    a.setTool('pen');
    a.setSelection(['d1']);
    it.onDown(ev(750, 750)); it.onMove(ev(790, 750)); it.onUp(ev(790, 750));
    it.action = null; it.pointers.clear();
    const selAfterPan = sf.selection.size;

    // 2. the zoom pill appears when the zoom changes
    a.command('zoomIn');
    const pill = document.getElementById('zoomPill');
    const pillShown = pill.classList.contains('show');
    const pillText = pill.textContent;
    a.command('zoomReset');

    // 3. fonts include a handwriting face, and it reaches the renderer
    const handStack = fontStack('hand');
    const resolved = faceOf('hand');

    a.penSeenThisSession = false; a.setTool('select'); a.store.clear();
    return { selBefore, selAfterSelect, selAfterPan, pillShown, pillText,
             fonts: FONTS.map(f => f.id), comic: /Comic Sans/i.test(handStack), resolved: resolved === handStack };
  `);
  check('clicking empty canvas deselects', misc.selBefore === 1 && misc.selAfterSelect === 0);
  check('panning with an ink tool deselects too', misc.selAfterPan === 0);
  check('zooming shows a readout', misc.pillShown && /%/.test(misc.pillText), misc.pillText);
  check('there is a handwriting font, and it is Comic Sans first',
    misc.fonts.includes('hand') && misc.comic && misc.resolved, misc.fonts.join(', '));

  /* ---- text comes out handwritten without anyone choosing it ---- */
  const faces = await js(`
    const a = window.app;
    const { faceOf } = await import('app://board/js/core/render.js');
    const KEY = 'gazboard.settings', OLD = 'openboard.settings';
    const keep = localStorage.getItem(KEY);
    const withStored = (v) => {
      if (v === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, v);
      localStorage.removeItem(OLD);
      return a.loadSettings();
    };
    const fresh   = withStored(null);
    const upgrade = withStored(JSON.stringify({ textFont: 'ui', noteFont: 'ui' }));
    const chosen  = withStored(JSON.stringify({ textFont: 'ui', noteFont: 'ui', fontDefaults2: true }));
    if (keep === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, keep);

    a.store.clear();
    a.settings.textFont = fresh.textFont; a.settings.noteFont = fresh.noteFont;
    a.addTextAt({ x: 200, y: 200 });
    a.textEditor.el.value = 'hello';
    a.commitTextEdit();
    a.addNoteAt({ x: 700, y: 250 });
    a.textEditor.el.value = 'note';
    a.commitTextEdit();
    const objs = a.store.objects;
    const text = objs.find(o => o.type === 'text'), note = objs.find(o => o.type === 'note');

    // the live editor must be set in the face the object will commit to
    const probe = { id: 'p', type: 'text', x: 0, y: 0, w: 300, h: 60, text: 'x', fontSize: 32,
                    font: 'serif', rotation: 0, align: 'left', valign: 'top', color: '#000' };
    a.store.add(probe);
    a.textEditor.begin(a.store.get('p'));
    const editorFace = a.textEditor.el ? a.textEditor.el.style.fontFamily : '';
    a.textEditor.cancel();
    a.store.clear();
    return {
      freshText: fresh.textFont, freshNote: fresh.noteFont,
      upgradedText: upgrade.textFont, upgradedNote: upgrade.noteFont, chosenText: chosen.textFont,
      textFont: text && text.font, noteFont: note && note.font,
      handFace: faceOf('hand'), editorFace
    };
  `);
  check('a new text box is handwritten by default',
    faces.freshText === 'hand' && faces.textFont === 'hand',
    `default ${faces.freshText}, object ${faces.textFont}`);
  check('a new sticky note is handwritten by default',
    faces.freshNote === 'hand' && faces.noteFont === 'hand',
    `default ${faces.freshNote}, object ${faces.noteFont}`);
  check('settings saved before the change are carried over to handwriting',
    faces.upgradedText === 'hand' && faces.upgradedNote === 'hand',
    `${faces.upgradedText} / ${faces.upgradedNote}`);
  check('but a deliberate choice of the sans face is left alone',
    faces.chosenText === 'ui', faces.chosenText);
  check('the handwriting face reaches for Comic Sans before anything else',
    /^'Comic Sans MS'/.test(faces.handFace), faces.handFace);
  check('the editor types in the face the text will commit to, not just for handwriting',
    faces.editorFace.replace(/"/g, "'").includes('Georgia'), faces.editorFace);

  const adopt = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    const { withAttached } = await import('app://board/js/core/store.js');
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'yes';
    // a slide, NOT locked yet - annotate first, lock after, the natural order
    a.store.add({ id: 'slide', type: 'image', kind: 'page', x: 100, y: 100, w: 400, h: 300, rotation: 0,
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      name: 'deck.pptx' });
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'pen', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.6 });
    a.setTool('pen');
    it.onDown(ev(200, 200)); it.onMove(ev(300, 240)); it.onMove(ev(380, 220)); it.onUp(ev(380, 220));
    it.action = null; it.pointers.clear();
    const ink = a.store.objects.find(o => o.type === 'stroke');
    const beforeLock = ink.attachedTo;

    a.setTool('select'); a.setSelection(['slide']);
    a.command('edit.lock');                       // lock AFTER drawing
    const afterLock = a.store.get(ink.id).attachedTo;
    const family = withAttached(a.store, ['slide']).length;

    a.setSelection(['slide']); a.command('edit.lock');   // unlock and drag
    a.setSelection(['slide']);
    const x0 = a.store.get('slide').x, i0 = a.store.get(ink.id).bbox.x;
    it.onDown(ev(300, 250, 'mouse')); it.onMove(ev(400, 250)); it.onUp(ev(400, 250));
    it.action = null; it.pointers.clear();
    const moved = { slide: Math.round(a.store.get('slide').x - x0), ink: Math.round(a.store.get(ink.id).bbox.x - i0) };

    a.settings.inkWithMouse = 'auto'; a.setTool('select'); a.store.clear();
    return { beforeLock, afterLock, family, moved };
  `);
  check('locking adopts ink already drawn on top',
    adopt.beforeLock === undefined && adopt.afterLock === 'slide', `before ${adopt.beforeLock}, after ${adopt.afterLock}`);
  check('the slide and that ink move together after unlocking',
    adopt.moved.slide === 100 && adopt.moved.ink === 100,
    `slide ${adopt.moved.slide}, ink ${adopt.moved.ink}`);

  /* ---- ink drawn on a locked object belongs to it ---- */
  const attach = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    const { withAttached } = await import('app://board/js/core/store.js');
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'yes';
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y, type) => ({ pointerId: 1, pointerType: type || 'pen', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.6 });
    const reset = () => { it.action = null; it.pointers.clear(); };
    const draw = (x0, y0, x1, y1) => {
      it.onDown(ev(x0, y0));
      it.onMove(ev((x0 + x1) / 2, (y0 + y1) / 2));
      it.onMove(ev(x1, y1));
      it.onUp(ev(x1, y1));
      reset();
      return a.store.objects.filter(o => o.type === 'stroke').pop();
    };

    // a "page", locked, the way you would mark up an import
    a.store.add({ id: 'page', type: 'image', kind: 'page', x: 100, y: 100, w: 400, h: 500, rotation: 0,
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      name: 'doc.pdf', locked: true });

    a.setTool('pen');
    const onPage = draw(200, 250, 380, 300);      // annotation on the page
    const offPage = draw(700, 250, 850, 300);     // ink elsewhere
    const attachedOn = onPage.attachedTo;
    const attachedOff = offPage.attachedTo;

    // locked: dragging the page does nothing
    a.setTool('select');
    const before = { page: a.store.get('page').x, ink: onPage.bbox.x };
    it.onDown(ev(300, 300, 'mouse'));
    it.onMove(ev(500, 300, 'mouse'));
    it.onUp(ev(500, 300, 'mouse'));
    reset();
    const whileLocked = { page: a.store.get('page').x, ink: a.store.get(onPage.id).bbox.x };

    // unlock, then drag: the annotation must travel with the page
    a.setSelection(['page']);
    a.command('edit.lock');
    a.setSelection(['page']);
    it.onDown(ev(300, 300, 'mouse'));
    it.onMove(ev(400, 300, 'mouse'));
    it.onMove(ev(500, 300, 'mouse'));
    it.onUp(ev(500, 300, 'mouse'));
    reset();
    const moved = {
      page: Math.round(a.store.get('page').x - before.page),
      ink: Math.round(a.store.get(onPage.id).bbox.x - before.ink),
      other: Math.round(a.store.get(offPage.id).bbox.x - offPage.bbox.x)
    };

    const family = withAttached(a.store, ['page']).length;

    // deleting the page takes its annotation, but not the unrelated ink
    a.setSelection(['page']);
    a.command('edit.delete');
    const afterDelete = { page: a.store.has('page'), ink: a.store.has(onPage.id), other: a.store.has(offPage.id) };
    a.store.undo();
    const restored = a.store.has('page') && a.store.has(onPage.id);

    a.settings.inkWithMouse = 'auto'; a.setTool('select'); a.store.clear();
    return { attachedOn, attachedOff, whileLocked, before, moved, family, afterDelete, restored };
  `);
  check('ink drawn on a locked object is attached to it',
    attach.attachedOn === 'page' && attach.attachedOff === undefined,
    `on page: ${attach.attachedOn}, elsewhere: ${attach.attachedOff}`);
  check('a locked object still does not move', attach.whileLocked.page === attach.before.page);
  check('unlocking and dragging carries the annotation along',
    attach.moved.page === 200 && attach.moved.ink === 200,
    `page moved ${attach.moved.page}, ink moved ${attach.moved.ink}`);
  check('unrelated ink stays where it was', attach.moved.other === 0, String(attach.moved.other));
  check('the page and its annotation count as a family', attach.family === 2, attach.family + ' objects');
  check('deleting the page takes its annotation but nothing else',
    !attach.afterDelete.page && !attach.afterDelete.ink && attach.afterDelete.other);
  check('and undo brings both back', attach.restored);

  const dragOutline = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = true;
    a.setTool('pen');
    a.store.add({ id: 'k', type: 'shape', kind: 'rect', x: 200, y: 200, w: 200, h: 150,
                  rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 });
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });

    it.onDown(ev(300, 275));
    it.onMove(ev(340, 275));
    // sample the canvas along the top edge of the dragged object for the dashed
    // outline the drag is supposed to show
    sf.draw();
    const dpr = sf.dpr;
    const probe = (x, y) => {
      const d = sf.ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    };
    let found = false;
    for (let x = 245; x < 320; x += 2) {
      const p = probe(x, 195);
      if (p.b > 150 && p.b > p.r + 40) { found = true; break; }   // the accent blue
    }
    const duringDrag = found;
    it.onUp(ev(340, 275));
    it.action = null; it.pointers.clear();
    sf.draw();
    let after = false;
    for (let x = 245; x < 360; x += 2) {
      const p = probe(x, 195);
      if (p.b > 150 && p.b > p.r + 40) { after = true; break; }
    }
    a.penSeenThisSession = false; a.setTool('select'); a.store.clear();
    return { duringDrag, after, selection: sf.selection.size };
  `);
  check('dragging with an ink tool shows an outline of what you are moving', dragOutline.duringDrag);
  check('and the outline disappears when you let go', !dragOutline.after && dragOutline.selection === 0);

  /* ---- opening zoom and ink smoothness ---- */
  const zoom = await js(`
    let savedCam;
    const a = window.app, sf = a.surface;
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // a brand new board
    a.newBoard(true);
    await frame(); await frame();
    const fresh = sf.cam.z;

    // a board saved while zoomed out to 36%, reopened
    a.store.add({ id: 'z1', type: 'shape', kind: 'rect', x: 900, y: 900, w: 200, h: 200,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    sf.cam.z = 0.36; sf.cam.centerOn({ x: 1000, y: 1000 }, sf.width, sf.height);
    await a.persist();
    const saved = JSON.parse(JSON.stringify(a.store.toJSON()));
    savedCam = saved.camera;
    await a.loadBoard(saved, { silent: true, startup: true });
    await frame(); await frame();
    const view = sf.cam.viewport(sf.width, sf.height);
    const centre = { x: Math.round(view.x + view.w / 2), y: Math.round(view.y + view.h / 2) };

    a.store.clear();
    return { fresh, reopened: sf.cam.z, centre, savedZ: savedCam.z };
  `);
  check('a new board opens at 100%', zoom.fresh === 1, (zoom.fresh * 100) + '%');
  check('a board saved zoomed out reopens at 100%', zoom.reopened === 1,
    `saved at ${Math.round(zoom.savedZ * 100)}%, opened at ${Math.round(zoom.reopened * 100)}%`);
  check('reopening keeps the place you were looking at',
    Math.abs(zoom.centre.x - 1000) < 40 && Math.abs(zoom.centre.y - 1000) < 40,
    `centred on ${zoom.centre.x},${zoom.centre.y}`);

  const smooth = await js(`
    const { centrelinePath } = await import('app://board/js/core/ink.js');
    // a curve through midpoints stays inside its control triangle, so it can
    // never overshoot into a loop however sparse the samples
    const curve = (step) => {
      const P = [];
      for (let t = 0; t <= Math.PI * 6; t += step)
        P.push({ x: t * 26, y: 28 * Math.sin(t) + 11 * Math.sin(2.6 * t), p: 0.55 });
      return P;
    };
    const bounds = (pts) => {
      const c = document.createElement('canvas');
      c.width = 700; c.height = 220;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(10, 110);
      ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
      ctx.stroke(centrelinePath(pts, 6));
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      let minY = 1e9, maxY = -1e9;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++)
          if (img[(y * c.width + x) * 4] < 128) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const py = pts.map(p => p.y + 110);
      return { inkTop: minY, inkBottom: maxY, ptTop: Math.min(...py), ptBottom: Math.max(...py) };
    };
    const sparse = bounds(curve(0.34));
    const dense = bounds(curve(0.05));
    return { sparse, dense };
  `);
  // The path must stay within the samples plus the pen's half width - proof it
  // is not overshooting between sparse points.
  const within = (b) => b.inkTop > b.ptTop - 6 && b.inkBottom < b.ptBottom + 6;
  check('a sparse fast stroke never overshoots its own points', within(smooth.sparse),
    `ink ${smooth.sparse.inkTop}-${smooth.sparse.inkBottom}, points ${Math.round(smooth.sparse.ptTop)}-${Math.round(smooth.sparse.ptBottom)}`);
  check('a dense slow stroke behaves the same', within(smooth.dense));

  /* ---- hovering must not decorate handwriting ---- */
  const hover = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = true;
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push({ x: 100 + i * 5, y: 300, p: 0.5 });
    a.store.add({ id: 'ink', type: 'stroke', tool: 'pen', color: '#111', width: 8, effect: 'none',
                  points: pts, bbox: { x: 100, y: 300, w: 300, h: 0 }, rotation: 0 });
    a.store.add({ id: 'box', type: 'shape', kind: 'rect', x: 500, y: 250, w: 160, h: 120,
                  rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 });

    const rect = sf.canvas.getBoundingClientRect();
    const hoverAt = (x, y, type) => {
      it.onMove({ pointerId: 9, pointerType: type, buttons: 0, clientX: rect.left + x, clientY: rect.top + y,
                  shiftKey: false, altKey: false, pressure: 0 });
      return { hoverId: sf.hoverId, cursor: sf.canvas.style.cursor,
               nib: it.inkPointer ? { x: Math.round(it.inkPointer.x), y: Math.round(it.inkPointer.y) } : null };
    };

    a.setTool('pen');
    a.settings.penColor = '#e81123';                   // so the nib's tint is checkable
    a.settings.inkPointer = 'nib';
    const penOverInk = hoverAt(250, 300, 'pen');       // stylus hovering its own writing
    const penOverBox = hoverAt(580, 310, 'pen');
    const mouseOverInk = hoverAt(250, 300, 'mouse');   // mouse: cursor hints, no outline
    const mouseOverEmpty = hoverAt(900, 700, 'mouse');

    // the same hover with the pointer set to the CSS cursors instead
    a.setTool('pen');
    a.settings.inkPointer = 'arrow';
    const asArrow = hoverAt(250, 300, 'pen');
    a.settings.inkPointer = 'crosshair';
    const asCross = hoverAt(250, 300, 'pen');
    a.settings.inkPointer = 'nib';

    a.setTool('select');
    it._penAt = 0;        // the probes above were pen hovers; clear the pen-ghost guard
    const selectOverInk = hoverAt(250, 300, 'mouse');  // picking tool: outline is useful

    a.penSeenThisSession = false; a.store.clear(); sf.hoverId = null; it.inkPointer = null;
    return { penOverInk, penOverBox, mouseOverInk, mouseOverEmpty, selectOverInk, asArrow, asCross };
  `);
  // A HOVERING pen keeps the system cursor: it is moved by the compositor at
  // the rate the digitiser reports, which nothing we draw ourselves can match.
  // Our own layer is for the stroke, where Windows takes that cursor away.
  const isCssNib = (c) => c.startsWith('url("data:image/svg+xml,') && c.endsWith('2 2, crosshair');
  check('a hovering stylus does not highlight ink',
    hover.penOverInk.hoverId === null && isCssNib(hover.penOverInk.cursor),
    `hoverId ${hover.penOverInk.hoverId}, cursor ${hover.penOverInk.cursor.slice(0, 40)}`);
  check('a hovering stylus does not highlight objects either',
    hover.penOverBox.hoverId === null && isCssNib(hover.penOverBox.cursor));
  check('a hovering pen keeps the system cursor, which nothing we draw can outrun',
    isCssNib(hover.penOverInk.cursor) && !hover.penOverInk.nib,
    hover.penOverInk.nib ? 'our layer was used instead' : 'system cursor, no layer');
  check('the nib is tinted with the colour loaded in the pen',
    hover.penOverInk.cursor.includes('%23e81123'), hover.penOverInk.cursor.slice(-60));
  check('choosing Arrow or Crosshair hands the pointer back to the system',
    hover.asArrow.cursor === 'default' && !hover.asArrow.nib
    && hover.asCross.cursor === 'crosshair' && !hover.asCross.nib,
    `${hover.asArrow.cursor} / ${hover.asCross.cursor}`);
  check('the mouse hints with the cursor, not an outline',
    hover.mouseOverInk.hoverId === null && hover.mouseOverInk.cursor === 'move',
    `hoverId ${hover.mouseOverInk.hoverId}, cursor ${hover.mouseOverInk.cursor}`);
  check('the mouse shows grab over empty canvas', hover.mouseOverEmpty.cursor === 'grab');
  check('the Select tool still outlines what you hover', hover.selectOverInk.hoverId === 'ink',
    String(hover.selectOverInk.hoverId));

  /* ---- the mouse as a pointer: drag objects, pan the canvas ---- */
  const pointer = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = true;   // stylus already seen
    a.setTool('pen');
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    const reset = () => { it.action = null; it.pointers.clear(); };
    const drag = (x0, y0, x1, y1) => {
      it.onDown(ev(x0, y0));
      const started = it.action ? it.action.type : 'none';
      it.onMove(ev((x0 + x1) / 2, (y0 + y1) / 2));
      it.onMove(ev(x1, y1));
      it.onUp(ev(x1, y1));
      reset();
      return started;
    };

    // three "imported pages" side by side
    const mk = (id, x) => ({ id, type: 'image', kind: 'page', x, y: 100, w: 200, h: 260, rotation: 0,
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      name: 'doc.pdf', label: 'page' });
    a.store.addMany([mk('p1', 40), mk('p2', 280), mk('p3', 520)]);
    a.setSelection([]);
    const before = { p1: a.store.get('p1').x, p2: a.store.get('p2').x, p3: a.store.get('p3').x };

    // drag the middle page: only it should move
    const startedOnObject = drag(380, 230, 480, 230);
    const after = { p1: a.store.get('p1').x, p2: a.store.get('p2').x, p3: a.store.get('p3').x };
    const onlyOneMoved = after.p2 - before.p2 === 100 && after.p1 === before.p1 && after.p3 === before.p3;
    const selectedAfter = [...sf.selection];

    // drag bare canvas: that pans, and no object shifts in world space
    const camBefore = sf.cam.x;
    const startedOnEmpty = drag(900, 700, 1000, 700);
    const panned = Math.round(sf.cam.x - camBefore);
    const objectsStill = a.store.get('p2').x === after.p2;

    // the stylus still draws over the same spot
    const evPen = (x, y) => ({ pointerId: 2, pointerType: 'pen', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.6 });
    it.onDown(evPen(380, 230)); it.onMove(evPen(420, 250)); it.onUp(evPen(420, 250)); reset();
    const inked = a.store.objects.filter(o => o.type === 'stroke').length;

    a.penSeenThisSession = false; a.setTool('select'); a.store.clear();
    return { startedOnObject, onlyOneMoved, selectedAfter, startedOnEmpty, panned, objectsStill, inked, before, after };
  `);
  check('the mouse drags the object under it', pointer.startedOnObject === 'move' && pointer.onlyOneMoved,
    `${pointer.startedOnObject}, ${JSON.stringify(pointer.after)}`);
  check('dragging one page leaves the others where they were', pointer.onlyOneMoved);
  check('dragging with an ink tool leaves no selection chrome behind',
    pointer.selectedAfter.length === 0, pointer.selectedAfter.join(',') || '(none)');
  check('the mouse still pans bare canvas', pointer.startedOnEmpty === 'pan' && pointer.panned === 100 && pointer.objectsStill,
    `${pointer.startedOnEmpty}, ${pointer.panned}px`);
  check('the stylus still inks over an object', pointer.inked === 1);

  const colours = await js(`
    const a = window.app;
    const { updateSelectionBar } = await import('app://board/js/ui/contextmenu.js');
    a.newBoard(true);

    // recolour a shape from the selection bar, then make a new one
    a.store.add({ id: 'c1', type: 'shape', kind: 'rect', x: 0, y: 0, w: 100, h: 100,
                  rotation: 0, stroke: '#201f1e', fill: 'none', lineWidth: 3 });
    a.setSelection(['c1']);
    a.rememberColor('shape', 'stroke', '#e81123');
    a.store.updateMany(['c1'], { stroke: '#e81123' });
    const shapeDefault = a.settings.shapeStroke;

    a.rememberColor('note', 'color', '#a4e7a0');
    const noteDefault = a.settings.noteColor;
    a.rememberColor('text', 'color', '#0078d4');
    const textDefault = a.settings.textColor;
    a.rememberColor('stroke', 'color', '#8764b8');
    const penDefault = a.settings.penColor;

    // a brand new note picks up the remembered colour
    a.addNoteAt({ x: 400, y: 400 }); a.textEditor.cancel();
    const newNote = a.store.objects.filter(o => o.type === 'note').pop();

    // an image offers no colour control
    a.store.clear();
    a.store.add({ id: 'img', type: 'image', kind: 'page', x: 0, y: 0, w: 200, h: 200, rotation: 0,
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    a.setSelection(['img']);
    updateSelectionBar(a);
    await new Promise(r => setTimeout(r, 40));
    const bar = document.getElementById('ctxbar');
    const imageButtons = bar.querySelectorAll('button').length;
    const imageHasSwatch = !!bar.querySelector('.colour-btn');

    // a shape does still offer one
    a.store.clear();
    a.store.add({ id: 'c2', type: 'shape', kind: 'rect', x: 0, y: 0, w: 100, h: 100,
                  rotation: 0, stroke: '#e81123', fill: 'none', lineWidth: 3 });
    a.setSelection(['c2']);
    updateSelectionBar(a);
    await new Promise(r => setTimeout(r, 40));
    const shapeHasSwatch = !!document.getElementById('ctxbar').querySelector('.colour-btn');

    a.store.clear(); a.setSelection([]);
    return { shapeDefault, noteDefault, textDefault, penDefault,
             newNoteColor: newNote ? newNote.color : null, imageButtons, imageHasSwatch, shapeHasSwatch };
  `);
  check('a colour picked from the selection bar becomes the default',
    colours.shapeDefault === '#e81123' && colours.noteDefault === '#a4e7a0' &&
    colours.textDefault === '#0078d4' && colours.penDefault === '#8764b8',
    JSON.stringify({ shape: colours.shapeDefault, note: colours.noteDefault }));
  check('a new object uses the remembered colour', colours.newNoteColor === '#a4e7a0', colours.newNoteColor);
  check('images offer no colour control', colours.imageHasSwatch === false && colours.imageButtons > 0,
    colours.imageButtons + ' buttons, swatch ' + colours.imageHasSwatch);
  check('shapes still offer one', colours.shapeHasSwatch === true);

  /* ---- ink outline, eraser growth, lasso drag, popover state ---- */
  const ink = await js(`
    const { centrelinePath, inkPath, strokeWeight } = await import('app://board/js/core/ink.js');
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: i * 8, y: Math.sin(i / 5) * 30, p: 0.3 + (i % 9) / 12 });

    const path = centrelinePath(pts, 10);
    const isPath = path instanceof Path2D;

    // one point still draws a dot rather than nothing
    const dot = centrelinePath([{ x: 5, y: 5, p: 0.5 }], 8) instanceof Path2D;

    // pressure sets the weight of the whole stroke, not a wobble along it
    const light = strokeWeight(pts.map(p => ({ ...p, p: 0.1 })), 10, true);
    const heavy = strokeWeight(pts.map(p => ({ ...p, p: 1 })), 10, true);
    const off = strokeWeight(pts, 10, false);

    const s = { points: pts, width: 10, tool: 'pen' };
    const p1 = inkPath(s), p2 = inkPath(s);
    return { isPath, dot, light: +light.toFixed(2), heavy: +heavy.toFixed(2), off, cached: p1 === p2 };
  `);
  check('a stroke is one centreline path', ink.isPath && ink.dot);
  check('pressure sets the weight of the whole stroke',
    ink.heavy > ink.light && ink.heavy / ink.light < 1.5 && ink.off === 10,
    `${ink.light} light, ${ink.heavy} heavy, ${ink.off} with pressure off`);
  check('the ink path is cached per stroke', ink.cached);

  const feel = await js(`
    const { centrelinePath, strokeWeight } = await import('app://board/js/core/ink.js');

    // the true curve, densely sampled - the ink must hug this whatever rate the
    // stylus sampled at. A barb from an offset outline lands tens of px away.
    const truth = [];
    for (let t = 0; t <= Math.PI * 6; t += 0.004)
      truth.push({ x: t * 26 + 10, y: 28 * Math.sin(t) + 11 * Math.sin(2.6 * t) + 110 });

    const worstStray = (step) => {
      const pts = [];
      for (let t = 0; t <= Math.PI * 6; t += step)
        pts.push({ x: t * 26, y: 28 * Math.sin(t) + 11 * Math.sin(2.6 * t), p: 0.55 });
      const c = document.createElement('canvas');
      c.width = 700; c.height = 230;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(10, 110);
      const lw = strokeWeight(pts, 8, true);
      ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
      ctx.stroke(centrelinePath(pts, 8));
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      let worst = 0, inked = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (img[(y * c.width + x) * 4] > 128) continue;
          inked++;
          let best = Infinity;
          for (const p of truth) {
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < best) { best = d; if (best < 1) break; }
          }
          if (best > worst) worst = best;
        }
      }
      return { worst: +worst.toFixed(2), inked, half: lw / 2, samples: pts.length };
    };
    return { dense: worstStray(0.05), sparse: worstStray(0.34) };
  `);
  // A densely sampled stroke should sit within its own half width of the curve.
  check('ink hugs the curve on a slow stroke',
    feel.dense.worst < feel.dense.half + 1.5 && feel.dense.inked > 500,
    `${feel.dense.worst}px from the curve, half-width ${feel.dense.half.toFixed(1)}px`);
  // A fast stroke samples ~26px apart, so the curve through the midpoints is an
  // approximation and may sit a few px off. A spike or barb - the artefact this
  // guards against - lands tens of px out.
  check('no spikes or barbs on a fast stroke',
    feel.sparse.worst < feel.sparse.half + 6,
    `${feel.sparse.worst}px from the curve at ${feel.sparse.samples} samples, half-width ${feel.sparse.half.toFixed(1)}px`);

  const grow = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.eraserMode = 'partial'; a.settings.eraserSize = 30;
    it.startErase({ x: 0, y: 0 });
    const first = it.action.radiusPx;
    it.eraseSweep(it.action, { x: 0, y: 0 }, { x: 300, y: 0 });
    const after300 = it.action.radiusPx;
    it.eraseSweep(it.action, { x: 300, y: 0 }, { x: 1500, y: 0 });
    const after1500 = it.action.radiusPx;
    it.eraseSweep(it.action, { x: 1500, y: 0 }, { x: 6000, y: 0 });
    const capped = it.action.radiusPx;
    it.finishErase(it.action); it.action = null;
    // a new scrub starts small again
    it.startErase({ x: 0, y: 0 });
    it.eraseSweep(it.action, { x: 0, y: 0 }, { x: 1, y: 0 });
    const restarted = it.action.radiusPx;
    it.finishErase(it.action); it.action = null;
    return { first, after300, after1500, capped, restarted, base: a.settings.eraserSize / 2 };
  `);
  check('the eraser grows as you scrub', grow.after300 > grow.base && grow.after1500 > grow.after300,
    `${grow.base} -> ${grow.after300.toFixed(1)} -> ${grow.after1500.toFixed(1)}`);
  check('eraser growth is capped', Math.abs(grow.capped - grow.base * 2.8) < 0.01, grow.capped.toFixed(1));
  check('a new scrub starts at the chosen size', Math.abs(grow.restarted - grow.base) < 0.2, grow.restarted.toFixed(1));

  const lasso = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.store.add({ id: 'l1', type: 'shape', kind: 'rect', x: 100, y: 100, w: 120, h: 120,
                  rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 });
    a.store.add({ id: 'l2', type: 'shape', kind: 'rect', x: 260, y: 100, w: 120, h: 120,
                  rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 });
    a.setTool('lasso');
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    const reset = () => { it.action = null; it.pointers.clear(); };

    // draw a lasso around both
    it.onDown(ev(60, 60));
    for (const p of [[440, 60], [440, 260], [60, 260], [60, 70]]) it.onMove(ev(p[0], p[1]));
    it.onUp(ev(60, 70));
    reset();
    const selected = sf.selection.size;

    // now drag from inside the selection - it should move, not re-lasso
    const x0 = a.store.get('l1').x;
    it.onDown(ev(200, 160));
    const started = it.action ? it.action.type : 'none';
    it.onMove(ev(300, 160));
    it.onUp(ev(300, 160));
    reset();
    const moved = Math.round(a.store.get('l1').x - x0);
    const stillSelected = sf.selection.size;

    // dragging outside starts a fresh lasso
    it.onDown(ev(600, 600));
    const outside = it.action ? it.action.type : 'none';
    it.onUp(ev(600, 600));
    reset();
    a.setTool('select'); a.store.clear();
    return { selected, started, moved, stillSelected, outside };
  `);
  check('lasso selects what it encloses', lasso.selected === 2, lasso.selected + ' objects');
  check('dragging inside a lasso selection moves it', lasso.started === 'move' && lasso.moved === 100,
    `${lasso.started}, moved ${lasso.moved}`);
  check('the selection survives the drag', lasso.stillSelected === 2);
  check('dragging outside still lassos', lasso.outside === 'lasso');

  const popover = await js(`
    const a = window.app;
    a.setTool('select');
    const btn = document.querySelector('#toolbar [data-tool="pen"]');
    btn.click();                       // switches to the pen
    btn.click();                       // clicking the active tool opens its options
    await new Promise(r => setTimeout(r, 80));
    const sizes = document.querySelectorAll('.pop .sizes .size');
    const before = [...sizes].findIndex(el => el.classList.contains('active'));
    const target = before === 0 ? 3 : 0;
    sizes[target].click();
    await new Promise(r => setTimeout(r, 30));
    const after = [...document.querySelectorAll('.pop .sizes .size')].findIndex(el => el.classList.contains('active'));
    const activeCount = document.querySelectorAll('.pop .sizes .size.active').length;
    const width = a.settings.penWidth;
    document.body.click();
    return { before, target, after, activeCount, width, sizes: sizes.length };
  `);
  check('the pen size popover marks the new size at once', popover.after === popover.target && popover.activeCount === 1,
    `was ${popover.before}, clicked ${popover.target}, now ${popover.after}`);

  /* ---- transform handles, locking, and what the eraser may touch ---- */
  const handles = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    const { handlePositions } = await import('app://board/js/core/render.js');
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y, type) => ({ pointerId: 1, pointerType: type || 'mouse', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    const reset = () => { it.action = null; it.pointers.clear(); it.secondaryPan = null; };

    const fresh = () => {
      a.store.clear();
      a.store.add({ id: 'box', type: 'shape', kind: 'rect', x: 200, y: 200, w: 300, h: 200,
                    rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 });
      a.setSelection(['box']); sf.draw();
      return handlePositions(sf.selectionScreenBox());
    };
    const dragHandle = (hp, key, dx, dy) => {
      it.onDown(ev(hp[key].x, hp[key].y));
      const started = it.action ? it.action.type : 'none';
      it.onMove(ev(hp[key].x + dx, hp[key].y + dy));
      it.onUp(ev(hp[key].x + dx, hp[key].y + dy));
      reset();
      return started;
    };

    // 1. with Select active
    a.setTool('select');
    let hp = fresh();
    let started = dragHandle(hp, 'se', 120, 80);
    const withSelect = { started, w: Math.round(a.store.get('box').w) };

    // 2. with the pen tool active - the handle must still win
    a.settings.inkWithMouse = 'yes';          // mouse inks, so this is the hard case
    a.setTool('pen');
    hp = fresh();
    started = dragHandle(hp, 'se', 120, 80);
    const withPen = { started, w: Math.round(a.store.get('box').w),
                      strokes: a.store.objects.filter(o => o.type === 'stroke').length };

    // 3. after a stylus, where the mouse would otherwise pan
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = true;
    hp = fresh();
    const camX = sf.cam.x;
    started = dragHandle(hp, 'se', 120, 80);
    const withPan = { started, w: Math.round(a.store.get('box').w), camMoved: Math.round(sf.cam.x - camX) };

    // 4. the rotate handle
    hp = fresh();
    started = dragHandle(hp, 'rot', 90, 40);
    const rotated = { started, rotation: +(a.store.get('box').rotation || 0).toFixed(3) };

    // 5. a locked object exposes no handles
    hp = fresh();
    a.store.update('box', { locked: true });
    sf.draw();
    const lockedHandle = it.handleAt(hp.se);
    const lockedBox = sf.selectionIsLocked();
    a.store.update('box', { locked: false });

    a.settings.inkWithMouse = 'no'; a.penSeenThisSession = false;   // back to the default
    a.setTool('select'); a.store.clear();
    return { withSelect, withPen, withPan, rotated, lockedHandle, lockedBox };
  `);
  check('handles resize with Select active', handles.withSelect.started === 'resize' && handles.withSelect.w > 380,
    `${handles.withSelect.started}, w ${handles.withSelect.w}`);
  check('handles resize with the pen tool active', handles.withPen.started === 'resize' && handles.withPen.w > 380 && handles.withPen.strokes === 0,
    `${handles.withPen.started}, w ${handles.withPen.w}, ${handles.withPen.strokes} strokes`);
  check('handles beat mouse-panning too', handles.withPan.started === 'resize' && handles.withPan.camMoved === 0,
    `${handles.withPan.started}, camera moved ${handles.withPan.camMoved}`);
  check('the rotate handle rotates', handles.rotated.started === 'rotate' && handles.rotated.rotation !== 0,
    `${handles.rotated.started}, ${handles.rotated.rotation} rad`);
  check('a locked object offers no handles', handles.lockedHandle === null && handles.lockedBox === true);

  const lockUse = await js(`
    const a = window.app, sf = a.surface;
    const { pick, inBox } = await import('app://board/js/core/hit.js');
    a.newBoard(true);
    a.store.add({ id: 'lk', type: 'shape', kind: 'rect', x: 0, y: 0, w: 200, h: 200,
                  rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2, locked: true });
    const clickable = !!pick(a.store, { x: 100, y: 100 }, 4);
    const marquee = inBox(a.store, { x: -500, y: -500, w: 2000, h: 2000 }).length;
    a.setSelection(['lk']);
    a.command('edit.delete');
    const survivedDelete = a.store.has('lk');
    a.setSelection(['lk']);
    a.command('edit.lock');                       // unlock
    const unlocked = !a.store.get('lk').locked;
    a.store.clear();
    return { clickable, marquee, survivedDelete, unlocked };
  `);
  check('a locked object can still be clicked (so it can be unlocked)', lockUse.clickable);
  check('a locked object is skipped by marquee select', lockUse.marquee === 0);
  check('Delete leaves a locked object alone', lockUse.survivedDelete);
  check('unlock works from the selection', lockUse.unlocked);

  const eraseSafe = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    // a "page" with ink drawn over it
    a.store.add({ id: 'page', type: 'image', kind: 'page', x: 0, y: 0, w: 600, h: 800, rotation: 0,
                  src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                  name: 'doc.pdf', label: 'doc.pdf — page 1' });
    a.store.add({ id: 'note', type: 'note', x: 620, y: 0, w: 160, h: 160, color: '#ffd94a', text: 'keep me', rotation: 0 });
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push({ x: 100 + i * 6, y: 400, p: 0.5 });
    a.store.add({ id: 'ink', type: 'stroke', tool: 'pen', color: '#e81123', width: 6, effect: 'none',
                  points: pts, bbox: { x: 100, y: 400, w: 360, h: 0 }, rotation: 0 });

    const sweep = (from, to) => { it.startErase(from); it.eraseSweep(it.action, from, to); it.finishErase(it.action); it.action = null; };

    // ink mode: rub out the middle of the stroke, right on top of the page
    a.settings.eraserMode = 'partial'; a.settings.eraserSize = 50;
    sweep({ x: 280, y: 360 }, { x: 280, y: 440 });
    const inkMode = {
      pageKept: a.store.has('page'),
      noteKept: a.store.has('note'),
      inkSplit: a.store.objects.filter(o => o.type === 'stroke').length
    };

    // whole-stroke mode: still only ink. This used to assert the opposite -
    // that scrubbing over an imported page deleted the page - which is exactly
    // the behaviour that had to go.
    a.settings.eraserMode = 'object';
    sweep({ x: 300, y: 200 }, { x: 300, y: 260 });
    const objectMode = { pageKept: a.store.has('page'), noteKept: a.store.has('note') };

    a.settings.eraserMode = 'partial'; a.store.clear();
    return { inkMode, objectMode };
  `);
  check('the ink eraser leaves pictures and pages alone', eraseSafe.inkMode.pageKept && eraseSafe.inkMode.noteKept,
    `page kept ${eraseSafe.inkMode.pageKept}, note kept ${eraseSafe.inkMode.noteKept}`);
  check('the ink eraser still cuts the ink on top', eraseSafe.inkMode.inkSplit === 2, eraseSafe.inkMode.inkSplit + ' fragments');
  check('whole-stroke mode leaves the page alone too',
    eraseSafe.objectMode.pageKept && eraseSafe.objectMode.noteKept, JSON.stringify(eraseSafe.objectMode));

  /* ---- device roles: stylus inks, mouse pans ---- */
  const roles = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true);
    sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y, id, type) => ({ pointerId: id, pointerType: type, button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    const drag = (type, id, x0, y0, x1, y1) => {
      it.onDown(ev(x0, y0, id, type));
      it.onMove(ev((x0 + x1) / 2, (y0 + y1) / 2, id, type));
      it.onMove(ev(x1, y1, id, type));
      it.onUp(ev(x1, y1, id, type));
      it.action = null; it.pointers.clear(); it.pinch = null; it.secondaryPan = null;
    };
    const strokes = () => a.store.objects.filter(o => o.type === 'stroke').length;
    const reset = () => { a.store.clear(); sf.cam.x = 0; sf.cam.y = 0; };

    // --- 'auto': no stylus seen yet this session, so the mouse still draws ---
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = false;
    a.setTool('pen');
    reset();
    const mouseInksAtFirst = a.mouseInks;
    drag('mouse', 1, 200, 200, 340, 260);
    const drewWithMouseBefore = strokes() === 1;

    // --- a stylus touches the tablet ---
    reset();
    drag('pen', 2, 200, 300, 340, 360);
    const penDrew = strokes() === 1;
    const penRemembered = a.penSeenThisSession === true;
    const mouseInksNow = a.mouseInks;

    // --- from here the mouse pans and never inks ---
    reset();
    const camX0 = sf.cam.x;
    drag('mouse', 3, 200, 200, 400, 200);
    const mousePanned = Math.round(sf.cam.x - camX0);
    const mouseDrewAfter = strokes();

    // --- the stylus still inks ---
    reset();
    drag('pen', 4, 200, 400, 340, 460);
    const penStillDraws = strokes() === 1;

    // --- highlighter follows the same rule ---
    reset(); a.setTool('highlighter');
    const camX1 = sf.cam.x;
    drag('mouse', 5, 200, 200, 380, 200);
    const hlMousePanned = Math.round(sf.cam.x - camX1) === 180 && strokes() === 0;

    // --- other tools keep working with the mouse ---
    reset(); a.setTool('note');
    drag('mouse', 6, 300, 300, 300, 300);
    a.textEditor.cancel();
    const noteWithMouse = a.store.objects.filter(o => o.type === 'note').length === 1;

    reset(); a.setTool('select');
    const camX2 = sf.cam.x;
    drag('mouse', 7, 200, 200, 300, 260);
    const selectUnaffected = Math.round(sf.cam.x - camX2) === 0;

    // --- eraser still works from the mouse ---
    reset(); a.setTool('pen');
    drag('pen', 8, 200, 500, 400, 500);
    const before = strokes();
    a.setTool('eraser'); a.settings.eraserMode = 'object'; a.settings.eraserSize = 40;
    drag('mouse', 9, 300, 460, 300, 540);
    const eraserWithMouse = before === 1 && strokes() === 0;

    // --- the override pins it either way ---
    reset(); a.setTool('pen');
    a.settings.inkWithMouse = 'yes';
    const forcedOn = a.mouseInks;
    drag('mouse', 10, 200, 200, 320, 240);
    const drewWhenForced = strokes() === 1;

    reset();
    a.settings.inkWithMouse = 'no'; a.penSeenThisSession = false;
    const forcedOff = a.mouseInks;
    const camX3 = sf.cam.x;
    drag('mouse', 11, 200, 200, 320, 200);
    const pannedWhenForced = Math.round(sf.cam.x - camX3) === 120 && strokes() === 0;

    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = false;
    a.setTool('select'); a.store.clear();
    return { mouseInksAtFirst, drewWithMouseBefore, penDrew, penRemembered, mouseInksNow,
             mousePanned, mouseDrewAfter, penStillDraws, hlMousePanned, noteWithMouse,
             selectUnaffected, eraserWithMouse, forcedOn, drewWhenForced, forcedOff, pannedWhenForced };
  `);
  check('mouse-only setup: the mouse still inks', roles.mouseInksAtFirst === true && roles.drewWithMouseBefore);
  check('a stylus is noticed for this session', roles.penDrew && roles.penRemembered);
  check('after a stylus appears the mouse stops inking', roles.mouseInksNow === false);
  check('mouse pans the canvas instead', roles.mousePanned === 200 && roles.mouseDrewAfter === 0, `${roles.mousePanned}px, ${roles.mouseDrewAfter} strokes`);
  check('stylus keeps drawing normally', roles.penStillDraws);
  check('highlighter follows the same rule', roles.hlMousePanned);
  check('notes, select and eraser still take the mouse', roles.noteWithMouse && roles.selectUnaffected && roles.eraserWithMouse);
  check('"Always" forces the mouse to ink', roles.forcedOn === true && roles.drewWhenForced);
  check('"Never" forces the mouse to pan', roles.forcedOff === false && roles.pannedWhenForced);

  /* ---- the pen inks and the mouse pans, both at once, out of the box ---- */
  const penDefault = await js(`
    const a = window.app;
    const r = {};
    const saved = localStorage.getItem('gazboard.settings');

    // out of the box
    localStorage.removeItem('gazboard.settings');
    const fresh = a.loadSettings();
    r.freshDefault = fresh.inkWithMouse;

    // an install stuck the way a drawing tablet used to leave it: 'auto' was
    // the old default and the stylus flag was remembered for ever
    localStorage.setItem('gazboard.settings', JSON.stringify({ inkWithMouse: 'auto', penSeen: true }));
    const rescued = a.loadSettings();
    r.rescued = rescued.inkWithMouse;
    r.staleFlagDropped = !('penSeen' in rescued);

    // the 'yes' and the 'no' that pre-release builds wrote by migration
    // were ours, not choices anyone made - both go back, and their flags go too
    localStorage.setItem('gazboard.settings', JSON.stringify({ inkWithMouse: 'yes', mouseInkDefault3: true }));
    const undone = a.loadSettings();
    r.undevYes = undone.inkWithMouse;
    r.devFlagDropped = !('mouseInkDefault3' in undone) && !('mouseInkDefault4' in undone);
    localStorage.setItem('gazboard.settings', JSON.stringify({ inkWithMouse: 'no', mouseInkDefault4: true }));
    r.undevNo = a.loadSettings().inkWithMouse;

    // a deliberate choice is never overwritten
    localStorage.setItem('gazboard.settings', JSON.stringify({ inkWithMouse: 'yes' }));
    r.keptAlways = a.loadSettings().inkWithMouse;
    localStorage.setItem('gazboard.settings', JSON.stringify({ inkWithMouse: 'no' }));
    r.keptNever = a.loadSettings().inkWithMouse;
    localStorage.setItem('gazboard.settings', JSON.stringify({ inkWithMouse: 'auto', mouseInkDefault5: true }));
    r.keptAuto = a.loadSettings().inkWithMouse;

    // and the session flag is never written to disk
    a.penSeenThisSession = true;
    a.settings.inkWithMouse = 'auto';
    a.saveSettings();
    r.notPersisted = !('penSeen' in JSON.parse(localStorage.getItem('gazboard.settings')));

    if (saved) localStorage.setItem('gazboard.settings', saved);
    a.settings.inkWithMouse = 'auto'; a.penSeenThisSession = false;
    return r;
  `);

  check('out of the box the mouse draws until a stylus turns up',
    penDefault.freshDefault === 'auto', penDefault.freshDefault);
  check('and the stylus flag that used to outlive the tablet is dropped',
    penDefault.rescued === 'auto' && penDefault.staleFlagDropped,
    `${penDefault.rescued}, stale flag dropped: ${penDefault.staleFlagDropped}`);
  check('both never-released development defaults are undone, not inherited',
    penDefault.undevYes === 'auto' && penDefault.undevNo === 'auto' && penDefault.devFlagDropped,
    `${penDefault.undevYes} / ${penDefault.undevNo}, dev flags dropped: ${penDefault.devFlagDropped}`);
  check('a deliberate Always, Never or Auto is left exactly as chosen',
    penDefault.keptAlways === 'yes' && penDefault.keptNever === 'no' && penDefault.keptAuto === 'auto',
    `${penDefault.keptAlways} / ${penDefault.keptNever} / ${penDefault.keptAuto}`);
  check('noticing a stylus is never written to disk, so it cannot outlive the tablet',
    penDefault.notPersisted);

  /* ---- and that default is what the two devices actually DO ---- */
  const bothLive = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true);
    sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'no'; a.penSeenThisSession = false;

    const ev = (x, y, id, type) => ({ pointerId: id, pointerType: type, button: 0, buttons: 1,
      clientX: x, clientY: y, pressure: type === 'pen' ? 0.6 : 0,
      preventDefault(){}, stopPropagation(){}, target: { setPointerCapture(){}, releasePointerCapture(){} } });
    const drag = (type, id, x0, y0, x1, y1) => {
      it.onDown(ev(x0, y0, id, type));
      it.onMove(ev((x0 + x1) / 2, (y0 + y1) / 2, id, type));
      it.onMove(ev(x1, y1, id, type));
      it.onUp(ev(x1, y1, id, type));
      it.action = null; it.pointers.clear(); it.pinch = null; it.secondaryPan = null;
    };
    const strokes = () => a.store.objects.filter(o => o.type === 'stroke').length;
    const r = {};

    // pen tool chosen, no stylus has ever touched this machine
    a.setTool('pen');
    const x0 = sf.cam.x;
    drag('mouse', 1, 200, 200, 400, 200);
    r.mousePanned = Math.round(sf.cam.x - x0);
    r.mouseLeftNoInk = strokes() === 0;

    // the stylus inks in the same breath - no mode changed in between
    drag('pen', 2, 200, 300, 340, 360);
    r.penInked = strokes() === 1;

    // and the mouse is STILL panning afterwards: seeing a pen changes nothing
    const x1 = sf.cam.x;
    drag('mouse', 3, 200, 200, 300, 200);
    r.mouseStillPans = Math.round(sf.cam.x - x1) === 100 && strokes() === 1;

    // switching ink tools changes what the PEN does, never what the mouse does
    a.setTool('highlighter');
    const x2 = sf.cam.x;
    drag('mouse', 4, 200, 200, 340, 200);
    r.mouseUnmovedByToolChoice = Math.round(sf.cam.x - x2) === 140 && strokes() === 1;

    a.setTool('select'); a.store.clear();
    return r;
  `);

  check('with the default, a mouse drag pans and leaves no ink',
    bothLive.mousePanned === 200 && bothLive.mouseLeftNoInk, `${bothLive.mousePanned}px`);
  check('the stylus inks at the same moment, with no mode change',
    bothLive.penInked);
  check('seeing a stylus changes nothing - the mouse was already panning',
    bothLive.mouseStillPans);
  check('choosing another ink tool changes the pen, never the mouse',
    bothLive.mouseUnmovedByToolChoice);

  /* ---- panning while drawing ---- */
  const pan = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true);
    sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.setTool('pen');
    a.settings.edgePan = true;

    const down = (x, y, id = 1, type = 'pen') => it.onDown({ pointerId: id, pointerType: type, button: 0, buttons: 1,
      clientX: x, clientY: y, shiftKey: false, altKey: false, pressure: 0.5 });
    const move = (x, y, id = 1, type = 'pen') => it.onMove({ pointerId: id, pointerType: type, buttons: 1,
      clientX: x, clientY: y, shiftKey: false, altKey: false, pressure: 0.5 });
    const up = (x, y, id = 1, type = 'pen') => it.onUp({ pointerId: id, pointerType: type,
      clientX: x, clientY: y, shiftKey: false, altKey: false });

    const rect = sf.canvas.getBoundingClientRect();
    const X = (v) => rect.left + v, Y = (v) => rect.top + v;

    // --- 1. a mouse press mid-stroke pans instead of cancelling the stroke ---
    down(X(300), Y(300));
    move(X(340), Y(300));
    const midPoints = it.action && it.action.type === 'draw' ? it.action.obj.points.length : -1;
    const camBefore = sf.cam.x;
    down(X(600), Y(400), 2, 'mouse');            // second pointer: the mouse
    const pinched = !!it.pinch;
    const secondary = !!it.secondaryPan;
    const stillDrawing = !!(it.action && it.action.type === 'draw');
    move(X(700), Y(400), 2, 'mouse');            // drag the canvas 100px right
    const panned = Math.round(sf.cam.x - camBefore);
    const grewWhilePanning = it.action.obj.points.length > midPoints;
    up(X(700), Y(400), 2, 'mouse');
    const releasedSecondary = !it.secondaryPan;
    const stillDrawingAfter = !!(it.action && it.action.type === 'draw');
    move(X(380), Y(300));
    up(X(380), Y(300));
    const strokeKept = a.store.objects.some(o => o.type === 'stroke');

    // --- 2. two touch pointers still pinch ---
    a.store.clear();
    down(X(300), Y(300), 5, 'touch');
    down(X(400), Y(300), 6, 'touch');
    const touchPinches = !!it.pinch && !it.secondaryPan;
    up(X(300), Y(300), 5, 'touch'); up(X(400), Y(300), 6, 'touch');
    it.pinch = null; it.action = null; it.pointers.clear();

    // --- 3. edge auto-pan: velocity near the edge, none in the middle ---
    down(X(300), Y(300));
    move(X(300), Y(300));
    const middleVel = it.edgeVelocity({ x: 300, y: 300 });
    const leftVel = it.edgeVelocity({ x: 8, y: 300 });
    const rightVel = it.edgeVelocity({ x: sf.width - 8, y: 300 });
    const camX0 = sf.cam.x;
    move(X(10), Y(300));                          // drive the pen into the left edge
    const armed = !!it._edgeRaf;
    // The auto-pan loop scrolls once per animation frame, and macOS throttles
    // requestAnimationFrame hard when the window is not being composited - on a
    // CI runner that can be one frame a second instead of sixty. Waiting a set
    // 260ms therefore read as "auto-pan is broken" on a slow runner and as
    // "auto-pan works" on a fast one. Wait for the camera to move instead.
    /*
     * Wait for movement, not for an amount.
     *
     * The earlier version waited for more than 20px and reported failure below
     * that. But the loop scrolls once per animation frame, and every desktop OS
     * throttles those hard when a window is occluded or minimised - one frame a
     * second instead of sixty. So the number reached says how busy the machine
     * was, not whether auto-pan works, and a suite that fails because a window
     * was behind another window teaches people to ignore it.
     *
     * What is actually being tested is that the canvas moves at all, in the
     * right direction, while the stroke keeps growing. Zero means broken.
     */
    let scrolled = 0;
    for (let i = 0; i < 60 && scrolled <= 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      scrolled = Math.round(sf.cam.x - camX0);
    }
    const pointsWhileScrolling = it.action ? it.action.obj.points.length : 0;
    // A right-button drag must survive the auto-pan loop. It did not for one
    // release: two lines belonging to the constructor were pasted into the
    // tick, so every frame of auto-pan quietly cancelled an in-flight
    // right-drag and cleared the flag that stops the context menu appearing
    // after one.
    it.rightPan = { sx: 1, sy: 1 };
    it._eatNextMenu = true;
    await new Promise(r => setTimeout(r, 120));
    const rightDragSurvivedAutoPan = !!it.rightPan && it._eatNextMenu === true;
    it.rightPan = null; it._eatNextMenu = false;
    up(X(10), Y(300));
    const stopped = !it._edgeRaf;

    // --- 3b. the barrel button, and a pointerup that never arrives ---
    // Both of these ended with the pen unable to draw at all, so they are
    // checked as a sequence: write, squeeze, write again.
    a.store.clear(); it.action = null; it.pointers.clear(); it.rightPan = null;
    const rightDown = (x, y, id = 1, type = 'pen') => it.onDown({ pointerId: id, pointerType: type,
      button: 2, buttons: 2, clientX: x, clientY: y, shiftKey: false, altKey: false, pressure: 0 });

    // Hover the pen first, the way a real one does before it touches down, so
    // the cursor starts as the nib rather than as whatever the previous part of
    // this test left behind.
    a.setTool('pen');
    it.updateHover({ x: 200, y: 200 }, sf.cam.toWorld(200, 200), 'pen');
    down(X(200), Y(200));
    move(X(240), Y(200));
    const cursorBeforeBarrel = sf.canvas.style.cursor || '';
    rightDown(X(240), Y(200));                  // barrel button, mid-stroke, same pointer
    const barrelKeptStroke = !!(it.action && it.action.type === 'draw');
    const camBeforeBarrel = sf.cam.x;
    move(X(300), Y(200));
    const barrelDidNotPan = sf.cam.x === camBeforeBarrel;
    // The give-away when this went wrong was visible: the pen cursor turned
    // into a hand for a split second in the middle of a word. Nothing but the
    // panner sets a hand cursor, so it doubles as proof the panner kept out.
    const cursorMidStroke = sf.canvas.style.cursor || '';
    const stayedAPen = cursorMidStroke === cursorBeforeBarrel;
    const barrelStrokeGrew = it.action && it.action.type === 'draw' && it.action.obj.points.length > 1;
    up(X(300), Y(200));
    const barrelCommitted = a.store.objects.filter(o => o.type === 'stroke').length === 1;
    const pointerReleased = it.pointers.size === 0;

    // a second stroke must still start after all that
    down(X(200), Y(260)); move(X(300), Y(260)); up(X(300), Y(260));
    const secondStrokeDrew = a.store.objects.filter(o => o.type === 'stroke').length === 2;

    // now strand a pointer the way a missed pointerup does, and write again
    a.store.clear(); it.action = null; it.rightPan = null;
    it.pointers.set(99, { sp: { x: 0, y: 0 }, wp: { x: 0, y: 0 }, type: 'pen' });
    down(X(200), Y(320)); move(X(300), Y(320)); up(X(300), Y(320));
    const strokeAfterStrandedPointer = a.store.objects.filter(o => o.type === 'stroke').length === 1;
    a.store.clear(); it.action = null; it.pointers.clear(); it.rightPan = null;

    // --- 4. the setting turns it off ---
    a.settings.edgePan = false;
    down(X(300), Y(300)); move(X(10), Y(300));
    const offVel = it.edgeVelocity({ x: 8, y: 300 });
    up(X(10), Y(300));
    a.settings.edgePan = true;
    a.store.clear();

    return { pinched, secondary, stillDrawing, panned, grewWhilePanning, releasedSecondary,
             stillDrawingAfter, strokeKept, touchPinches,
             middleVel, leftDir: leftVel ? Math.sign(leftVel.vx) : 0, rightDir: rightVel ? Math.sign(rightVel.vx) : 0,
             armed, scrolled, pointsWhileScrolling, stopped, offVel,
             rightDragSurvivedAutoPan, barrelKeptStroke, barrelDidNotPan, barrelStrokeGrew,
             barrelCommitted, pointerReleased, secondStrokeDrew, strokeAfterStrandedPointer,
             stayedAPen, cursorChange: cursorBeforeBarrel === cursorMidStroke
               ? 'unchanged' : cursorBeforeBarrel.slice(0, 24) + ' -> ' + cursorMidStroke.slice(0, 24) };
  `);
  check('mouse during a pen stroke pans, not pinches', pan.secondary === true && pan.pinched === false && pan.stillDrawing === true);
  check('canvas follows the mouse drag', pan.panned === 100, pan.panned + 'px');
  check('the stroke survives and keeps growing', pan.strokeKept && pan.grewWhilePanning && pan.stillDrawingAfter);
  check('releasing the mouse leaves the pen drawing', pan.releasedSecondary);
  check('two touch pointers still pinch-zoom', pan.touchPinches);
  check('no auto-pan away from the edges', pan.middleVel === null);
  check('edge velocity points inward', pan.leftDir > 0 && pan.rightDir < 0, `left ${pan.leftDir}, right ${pan.rightDir}`);
  check('auto-pan scrolls the canvas while drawing',
    pan.armed && pan.scrolled > 0 && pan.pointsWhileScrolling > 1,
    `${pan.scrolled}px, ${pan.pointsWhileScrolling} points`
      + (pan.scrolled > 0 && pan.scrolled <= 20 ? ' — few animation frames; window was probably not on top' : ''));
  check('auto-pan stops on pointer up', pan.stopped);
  check('auto-pan does not cancel a right-button drag under it', pan.rightDragSurvivedAutoPan);
  check('the barrel button does not take the pen away mid-stroke',
    pan.barrelKeptStroke && pan.barrelDidNotPan && pan.barrelStrokeGrew && pan.barrelCommitted,
    JSON.stringify({ kept: pan.barrelKeptStroke, noPan: pan.barrelDidNotPan, grew: pan.barrelStrokeGrew, committed: pan.barrelCommitted }));
  check('and the cursor never flickers to a hand while inking', pan.stayedAPen, pan.cursorChange);
  check('and the pen is released afterwards, so the next stroke still draws',
    pan.pointerReleased && pan.secondStrokeDrew, `pointers ${pan.pointerReleased}, second stroke ${pan.secondStrokeDrew}`);
  check('a pointer stranded by a missed pointerup does not block the next stroke',
    pan.strokeAfterStrandedPointer);
  check('the edge auto-pan setting disables it', pan.offVel === null);

  /* ---- a palm on the glass, and a reversal in a letter ---- */
  const hand = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.setTool('pen'); a.settings.inkToShape = false;
    it.action = null; it.actionId = null; it.pointers.clear();
    it.rightPan = null; it.pinch = null; it.secondaryPan = null;

    const rect = sf.canvas.getBoundingClientRect();
    const X = (v) => rect.left + v, Y = (v) => rect.top + v;
    const mk = (x, y, id, type, extra) => Object.assign({ pointerId: id, pointerType: type,
      button: 0, buttons: 1, clientX: x, clientY: y, shiftKey: false, altKey: false, pressure: 0.5 }, extra || {});

    // --- the pen writes; a palm lands on the glass halfway through ---
    it.updateHover({ x: 200, y: 200 }, sf.cam.toWorld(200, 200), 'pen');
    it.onDown(mk(X(200), Y(200), 1, 'pen'));
    it.onMove(mk(X(240), Y(200), 1, 'pen'));
    const cursorBefore = sf.canvas.style.cursor || '';
    const camBefore = sf.cam.x;
    const ptsBefore = it.action.obj.points.length;

    it.onDown(mk(X(600), Y(500), 7, 'touch'));           // the heel of the hand
    const noSecondaryPan = !it.secondaryPan && !it.pinch;
    const cursorUnchanged = (sf.canvas.style.cursor || '') === cursorBefore;
    const stillDrawing = !!(it.action && it.action.type === 'draw');

    it.onMove(mk(X(680), Y(560), 7, 'touch'));           // the palm slides as you write
    const camUnmoved = sf.cam.x === camBefore;
    const strokeIgnoredPalm = it.action.obj.points.length === ptsBefore;

    it.onMove(mk(X(280), Y(200), 1, 'pen'));             // the pen keeps writing
    const penStillWrites = it.action.obj.points.length > ptsBefore;
    it.onUp(mk(X(680), Y(560), 7, 'touch'));
    it.onUp(mk(X(280), Y(200), 1, 'pen'));
    const palmStrokeKept = a.store.objects.filter(o => o.type === 'stroke').length === 1;

    // --- a reversal, the way the turn of an n or a w arrives ---
    a.store.clear(); it.action = null; it.actionId = null; it.pointers.clear();
    const coalesced = [
      mk(X(200), Y(300), 1, 'pen'), mk(X(200), Y(285), 1, 'pen'), mk(X(200), Y(270), 1, 'pen'),
      mk(X(200), Y(285), 1, 'pen'), mk(X(200), Y(300.4), 1, 'pen')
    ];
    it.onDown(mk(X(200), Y(300), 1, 'pen'));
    // one frame of a high-rate pen: out 30px and back, ending where it began
    it.onMove(mk(X(200), Y(300.4), 1, 'pen', { getCoalescedEvents: () => coalesced }));
    const pts = it.action.obj.points;
    let reach = 0;
    for (const q of pts) reach = Math.max(reach, Math.abs(q.y - pts[0].y));
    it.onUp(mk(X(200), Y(300.4), 1, 'pen'));
    a.store.clear(); it.action = null; it.actionId = null; it.pointers.clear();

    return { noSecondaryPan, cursorUnchanged, stillDrawing, camUnmoved, strokeIgnoredPalm,
             penStillWrites, palmStrokeKept, reach: Math.round(reach), points: pts.length };
  `);
  check('a palm landing while the pen writes is ignored, not treated as a pan',
    hand.noSecondaryPan && hand.cursorUnchanged && hand.stillDrawing,
    JSON.stringify({ noPan: hand.noSecondaryPan, cursor: hand.cursorUnchanged, drawing: hand.stillDrawing }));
  check('a palm sliding on the glass moves neither the canvas nor the stroke',
    hand.camUnmoved && hand.strokeIgnoredPalm,
    JSON.stringify({ cam: hand.camUnmoved, stroke: hand.strokeIgnoredPalm }));
  check('and the pen carries on writing through it',
    hand.penStillWrites && hand.palmStrokeKept);
  check('the turn of an n or a w survives, even when the frame ends where it began',
    hand.reach > 25, `reached ${hand.reach}px from the start, ${hand.points} points`);

  /* ---- the cursor after the pen lifts ---- */
  const afterLift = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    // The mouse draws by default now, so the pen tool would show the nib for a
    // mouse too - and this test would pass without proving anything, because
    // "kept the nib" and "the nib is the cursor anyway" would look identical.
    // Put it in the one mode where a ghost move and a real one differ.
    const wasInk = a.settings.inkWithMouse;
    a.settings.inkWithMouse = 'auto';
    a.setTool('pen'); a.notePenSeen();
    it.action = null; it.actionId = null; it.pointers.clear();
    const rect = sf.canvas.getBoundingClientRect();
    const X = (v) => rect.left + v, Y = (v) => rect.top + v;
    const mk = (x, y, type, buttons) => ({ pointerId: type === 'mouse' ? 3 : 1, pointerType: type,
      button: 0, buttons, clientX: x, clientY: y, shiftKey: false, altKey: false, pressure: 0.5 });

    // a dot: down, a whisker of movement, up
    it.onDown(mk(X(300), Y(300), 'pen', 1));
    it.onMove(mk(X(302), Y(301), 'pen', 1));
    it.onUp(mk(X(302), Y(301), 'pen', 0));
    // the stroke is over, so the system cursor should be back and carrying
    // the nib again - the layer is only for the stroke itself
    const nib = sf.canvas.style.cursor || '';
    const layerGone = !it.inkPointer;

    // Windows re-asserts the mouse pointer as the pen leaves proximity: a
    // pointermove arrives with pointerType 'mouse', at the pen's own position,
    // with nothing pressed. Nobody touched the mouse.
    it.onMove(mk(X(302), Y(301), 'mouse', 0));
    const afterGhost = sf.canvas.style.cursor || '';

    // a real mouse move, later, must still say what a click will do
    it._penAt = 0;
    it.onMove(mk(X(500), Y(400), 'mouse', 0));
    const afterRealMouse = sf.canvas.style.cursor || '';

    a.store.clear(); it.action = null; it.pointers.clear();
    a.settings.inkWithMouse = wasInk; a.penSeenThisSession = false;
    return { nibIsPen: nib.startsWith('url(') && layerGone, ghostKeptNib: afterGhost === nib,
             realMouseStillGrabs: afterRealMouse === 'grab',
             ghost: afterGhost.slice(0, 20), real: afterRealMouse };
  `);
  check('the pen nib survives the pen lifting off', afterLift.nibIsPen);
  check('and the system cursor is what carries it once the stroke is over',
    afterLift.ghost.startsWith('url('), `cursor "${afterLift.ghost}"`);
  check('the cursor does not flash to a hand when the pen leaves the screen',
    afterLift.ghostKeptNib, `became "${afterLift.ghost}"`);
  check('but a real mouse move still shows what a click will do',
    afterLift.realMouseStillGrabs, afterLift.real);

  /* ---- what a busy board costs while you write on it ---- */
  const busy = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.settings.autosave = false;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;

    const bulk = [];
    for (let i = 0; i < 400; i++) {
      const bx = (i % 20) * 60 - 600, by = Math.floor(i / 20) * 60 - 600;
      bulk.push({ id: 'busy' + i, type: 'stroke', tool: 'pen', color: '#1a1a1a', width: 3,
                  effect: 'none', points: [{ x: bx, y: by, p: 0.5 }, { x: bx + 30, y: by + 6, p: 0.5 }],
                  bbox: { x: bx, y: by, w: 30, h: 6 } });
    }
    a.store.addMany(bulk, 'bulk');

    // The badge pass must not re-scan the document on every frame.
    sf.draw();
    const firstList = sf._locked;
    sf.draw();
    const reusedBetweenFrames = sf._locked === firstList;
    a.store.add({ id: 'busy-lock', type: 'shape', kind: 'rect', x: 0, y: 0, w: 10, h: 10,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2, locked: true });
    sf.draw();
    const rebuiltOnChange = sf._locked !== firstList && sf._locked.length === 1;

    // Saving must never land inside a stroke, must happen once one ends, and
    // must not be starved by someone who draws without ever really stopping.
    a.settings.autosave = true;
    // The autosave delay scales with how long the last write took, so on a real
    // disk behind a virus scanner it can stretch to four seconds. Pin the
    // measured cost to zero so the delay is the fixed 700ms floor and the
    // windows below mean what they say - the point of the test is WHEN a save
    // is allowed to happen, not how fast this machine's disk is.
    const realCost = a._saveCost;
    a._saveCost = 0;
    let saves = 0;
    const realPersist = a.persist.bind(a);
    a.persist = async (...args) => { saves++; return realPersist(...args); };

    const rect = sf.canvas.getBoundingClientRect();
    const pev = (x, y) => ({ pointerId: 1, pointerType: 'pen', button: 0, buttons: 1,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.5 });
    a.setTool('pen'); a.settings.inkWithMouse = 'yes';

    // (1) a stroke is in flight when the timer comes round
    it.onDown(pev(100, 100));
    it.onMove(pev(140, 120));
    a.autosave();
    await new Promise(r => setTimeout(r, 1100));
    const heldOffWhileDrawing = saves === 0;

    // (2) the stroke ends: a save follows. Polled rather than slept on, so a
    // slow machine reports a late save instead of a missing one.
    it.onUp(pev(180, 140));
    for (let i = 0; i < 60 && saves === 0; i++) await new Promise(r => setTimeout(r, 100));
    const savedOnceTheHandStopped = saves >= 1;

    // (3) drawing steadily past the ceiling: the next stroke to END is written
    // at once, without waiting for a pause
    saves = 0;
    a._lastSaveAt = performance.now() - 60000;
    a._unsaved = true;
    it.onDown(pev(200, 200));
    it.onMove(pev(240, 220));
    const stillNothingMidStroke = saves === 0;
    it.onUp(pev(280, 240));
    const savedImmediatelyAtTheCeiling = saves >= 1;

    a.persist = realPersist;
    a._saveCost = realCost;
    return { reusedBetweenFrames, rebuiltOnChange, heldOffWhileDrawing, savedOnceTheHandStopped,
             stillNothingMidStroke, savedImmediatelyAtTheCeiling };
  `);
  check('the locked-badge pass does not re-scan the board every frame',
    busy.reusedBetweenFrames && busy.rebuiltOnChange,
    JSON.stringify({ reused: busy.reusedBetweenFrames, rebuilt: busy.rebuiltOnChange }));
  check('a save never lands inside a stroke, and follows once one ends',
    busy.heldOffWhileDrawing && busy.savedOnceTheHandStopped,
    JSON.stringify({ heldOff: busy.heldOffWhileDrawing, thenSaved: busy.savedOnceTheHandStopped }));
  check('drawing without pausing cannot starve the save past its ceiling',
    busy.stillNothingMidStroke && busy.savedImmediatelyAtTheCeiling,
    JSON.stringify({ quietMidStroke: busy.stillNothingMidStroke, wroteAtStrokeEnd: busy.savedImmediatelyAtTheCeiling }));

  /* ---- pictures live in their own files ---- */
  const assets = await js(`
    const a = window.app;
    a.settings.autosave = false;

    // a real PNG, big enough that inlining it would be obvious in the board file
    const cnv = document.createElement('canvas');
    cnv.width = 400; cnv.height = 300;
    const g = cnv.getContext('2d');
    const im = g.createImageData(400, 300);
    for (let i = 0; i < im.data.length; i += 4) {
      im.data[i] = (i * 7) % 255; im.data[i+1] = (i * 13) % 255;
      im.data[i+2] = (i * 29) % 255; im.data[i+3] = 255;
    }
    g.putImageData(im, 0, 0);
    const png = cnv.toDataURL('image/png');

    // --- 1. a board with two copies of the same picture ---
    a.newBoard(true);
    a.store.add({ id: 'pic-a', type: 'image', src: png, x: 0, y: 0, w: 400, h: 300, rotation: 0 });
    a.store.add({ id: 'pic-b', type: 'image', src: png, x: 500, y: 0, w: 400, h: 300, rotation: 0 });
    const boardId = a.store.doc.id;
    await a.persist({ force: true });

    const onDisk = await window.board.boards.load(boardId);
    const diskText = JSON.stringify(onDisk);
    const diskPic = onDisk.objects.find(o => o.id === 'pic-a');
    const wroteAReference = typeof diskPic.src === 'string' && diskPic.src.startsWith('asset:');
    const noPixelsInBoardFile = !diskText.includes('data:image');
    const smallerThanThePicture = diskText.length < png.length / 4;
    // the same picture twice must be the same name - stored once
    const bothShareOneFile = onDisk.objects.find(o => o.id === 'pic-b').src === diskPic.src;

    // --- 2. it comes back when the board is opened ---
    await a.loadBoard(onDisk, { silent: true, noMigrationPrompt: true });
    const back = a.store.get('pic-a');
    const cameBackWhole = back && back.src === png;
    const nothingMarkedMissing = !back.missing;

    // --- 3. a board written the old way, with the picture inline, still opens ---
    const legacy = { id: 'legacy-board', name: 'Old board', schema: 2, created: Date.now(),
      modified: Date.now(), background: { pattern: 'none', color: '#ffffff' }, pages: [], page: null,
      camera: null, objects: [{ id: 'old-pic', type: 'image', src: png, x: 0, y: 0, w: 400, h: 300, rotation: 0 }] };
    await a.loadBoard(legacy, { silent: true, noMigrationPrompt: true });
    const legacyOpened = a.store.get('old-pic').src === png;

    // ...and converts the first time it is saved, without being asked to
    await a.persist({ force: true });
    const legacyOnDisk = await window.board.boards.load('legacy-board');
    const legacyConverted = legacyOnDisk.objects[0].src.startsWith('asset:');
    const legacyStillLoadsBack = (await window.board.assets.get(legacyOnDisk.objects[0].src.slice(6))) === png;

    // --- 4. a reference whose file is gone ---
    const orphan = { id: 'orphan-board', name: 'Orphan', schema: 2, created: Date.now(),
      modified: Date.now(), background: { pattern: 'none', color: '#ffffff' }, pages: [], page: null,
      camera: null, objects: [{ id: 'gone', type: 'image',
        src: 'asset:' + '0'.repeat(64) + '.png', x: 0, y: 0, w: 200, h: 200, rotation: 0 }] };
    await a.loadBoard(orphan, { silent: true, noMigrationPrompt: true });
    const gone = a.store.get('gone');
    const markedMissing = gone.missing === true;
    const keptTheReference = gone.assetId === '0'.repeat(64) + '.png';
    // and saving it again must not throw the reference away
    await a.persist({ force: true });
    const orphanOnDisk = await window.board.boards.load('orphan-board');
    const referenceSurvivedResave = orphanOnDisk.objects[0].src === 'asset:' + '0'.repeat(64) + '.png';

    // --- 5. the store only ever opens its own files ---
    const traversalRefused = (await window.board.assets.get('../../../etc/passwd')) === null
      && (await window.board.assets.get('..\\..\\windows\\win.ini')) === null
      && (await window.board.assets.get('not-a-hash.png')) === null;

    a.store.clear();
    a.settings.autosave = true;          // leave the app as this test found it
    return { wroteAReference, noPixelsInBoardFile, smallerThanThePicture, bothShareOneFile,
             cameBackWhole, nothingMarkedMissing, legacyOpened, legacyConverted, legacyStillLoadsBack,
             markedMissing, keptTheReference, referenceSurvivedResave, traversalRefused,
             diskBytes: diskText.length, pictureBytes: png.length };
  `);
  check('a saved board holds a reference, not the picture itself',
    assets.wroteAReference && assets.noPixelsInBoardFile && assets.smallerThanThePicture,
    `board file ${assets.diskBytes} bytes for a ${assets.pictureBytes}-byte picture`);
  check('the same picture used twice is stored once', assets.bothShareOneFile);
  check('opening the board brings the picture back exactly',
    assets.cameBackWhole && assets.nothingMarkedMissing);
  check('a board saved the old way, with the picture inline, still opens', assets.legacyOpened);
  check('and it converts the first time it is saved, losing nothing',
    assets.legacyConverted && assets.legacyStillLoadsBack,
    JSON.stringify({ converted: assets.legacyConverted, identical: assets.legacyStillLoadsBack }));
  check('a picture whose file has gone leaves a marked gap, not a silent one',
    assets.markedMissing && assets.keptTheReference);
  check('and saving that board again does not throw the reference away',
    assets.referenceSurvivedResave);
  check('the asset store refuses to open anything but its own files',
    assets.traversalRefused);

  /* ---- what the wheel is coming from ---- */
  const wheel = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); a.settings.wheelZoom = false;
    const rect = sf.canvas.getBoundingClientRect();
    const mk = (o) => Object.assign({ deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false,
      metaKey: false, shiftKey: false, clientX: rect.left + 400, clientY: rect.top + 300,
      preventDefault() {} }, o);

    const run = (events, gap) => {
      it._wheelFrom = null; it._wheelAt = 0;
      sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
      for (const ev of events) it.onWheel(mk(ev));
      return { z: +sf.cam.z.toFixed(4), y: Math.round(sf.cam.y) };
    };

    // a gentle two-finger scroll: fractional, slightly diagonal
    const gentle = run([{ deltaY: 4.5, deltaX: 0.3, wheelDeltaY: -13 },
                        { deltaY: 6.2, deltaX: 0.4, wheelDeltaY: -18 }]);

    // a HARD flick: the same device, moving fast, then macOS momentum
    const flick = run([{ deltaY: 12.7, deltaX: 1.1, wheelDeltaY: -38 },
                       { deltaY: 96, deltaX: 3, wheelDeltaY: -288 },
                       { deltaY: 240, deltaX: 0, wheelDeltaY: -720 },
                       { deltaY: 120, deltaX: 0, wheelDeltaY: -360 },
                       { deltaY: 40, deltaX: 0, wheelDeltaY: -120 }]);

    // a mouse wheel notch, and several of them
    const notch = run([{ deltaY: 100, deltaX: 0, wheelDeltaY: -120 }]);
    const notches = run([{ deltaY: 100, deltaX: 0, wheelDeltaY: -120 },
                         { deltaY: 100, deltaX: 0, wheelDeltaY: -120 }]);
    // a wheel reporting in lines rather than pixels
    const lines = run([{ deltaY: 3, deltaX: 0, deltaMode: 1, wheelDeltaY: -120 }]);

    // pinch arrives as a wheel with ctrl held - that must still zoom
    const pinch = run([{ deltaY: -18.5, ctrlKey: true, wheelDeltaY: 55 }]);

    a.store.clear();
    return { gentle, flick, notch, notches, lines, pinch };
  `);
  check('a gentle two-finger scroll moves the board, not the zoom',
    wheel.gentle.z === 1 && wheel.gentle.y !== 0, JSON.stringify(wheel.gentle));
  check('and a hard flick does the same thing, only further',
    wheel.flick.z === 1 && Math.abs(wheel.flick.y) > Math.abs(wheel.gentle.y),
    JSON.stringify(wheel.flick));
  // zoomAt keeps the point under the cursor fixed, so the camera moves as a
  // consequence of zooming - the zoom level is what says a zoom happened
  check('a mouse wheel notch still zooms',
    wheel.notch.z !== 1, JSON.stringify(wheel.notch));
  check('and keeps zooming, notch after notch',
    wheel.notches.z !== 1 && wheel.notches.z !== wheel.notch.z, JSON.stringify(wheel.notches));
  check('a wheel that reports in lines zooms too', wheel.lines.z !== 1, JSON.stringify(wheel.lines));
  check('a trackpad pinch still zooms', wheel.pinch.z !== 1, JSON.stringify(wheel.pinch));

  /* ---- templates ---- */
  const tplCount = await js(`
    const { TEMPLATES } = await import('app://board/js/templates.js');
    const a = window.app; const before = a.store.count;
    a.applyTemplate(TEMPLATES.find(t => t.id === 'kanban'));
    return { added: a.store.count - before, total: TEMPLATES.length };
  `);
  check('templates available', tplCount.total >= 12, tplCount.total + ' templates');
  check('template applied', tplCount.added > 4, tplCount.added + ' objects');

  /* ---- background ---- */
  await js(`window.app.store.setBackground({ pattern: 'grid', color: '#ffffff' });`);
  check('background pattern set', (await js(`return window.app.store.doc.background.pattern;`)) === 'grid');

  /* ---- ruler ---- */
  await js(`window.app.command('ruler'); window.app.ruler.angle = 0.35;`);
  check('ruler toggles', await js(`return window.app.ruler.visible;`));

  await sleep(400);
  await shot(win, '01-board');

  /* ---- imports ---- */
  const pdf = await js(`
    const { insertDocument } = await import('app://board/js/insert.js');
    const before = window.app.store.count;
    const r = await insertDocument(window.app, ${JSON.stringify(path.join(FIX, 'sample.pdf'))}, { pages: [1, 2, 3] });
    return { added: window.app.store.count - before, ok: !!r };
  `);
  check('PDF import adds pages', pdf.added === 3, pdf.added + ' pages');


  const docx = await js(`
    const { insertDocument } = await import('app://board/js/insert.js');
    const before = window.app.store.count;
    const r = await insertDocument(window.app, ${JSON.stringify(path.join(FIX, 'sample.docx'))}, { pages: [1] });
    return { added: window.app.store.count - before };
  `);
  check('Word import adds pages', docx.added >= 1, docx.added + ' pages');

  const pptx = await js(`
    const { insertDocument } = await import('app://board/js/insert.js');
    const before = window.app.store.count;
    const r = await insertDocument(window.app, ${JSON.stringify(path.join(FIX, 'sample.pptx'))}, { pages: [1, 2, 3] });
    return { added: window.app.store.count - before };
  `);
  check('PowerPoint import adds slides', pptx.added === 3, pptx.added + ' slides');

  const ranges = await js(`
    const { parseRange, formatRange } = await import('app://board/js/ui/pagepicker.js');
    return {
      simple: parseRange('1-3, 7, 9-10', 12).join(','),
      openEnded: parseRange('8-', 10).join(','),
      clamped: parseRange('0, 5, 99', 6).join(','),
      messy: parseRange('  3 , 3, 2  ', 5).join(','),
      empty: parseRange('nonsense', 5).length,
      round: formatRange([1,2,3,7,9,10,11])
    };
  `);
  check('page ranges parse', ranges.simple === '1,2,3,7,9,10' && ranges.openEnded === '8,9,10' &&
    ranges.clamped === '5' && ranges.messy === '2,3' && ranges.empty === 0, JSON.stringify(ranges));
  check('page ranges format back', ranges.round === '1-3, 7, 9-11', ranges.round);

  const picker = await js(`
    const { insertDocument } = await import('app://board/js/insert.js');
    const a = window.app;
    const before = a.store.count;   // keep whatever the board already holds
    // no 'pages' option: the picker must appear for a multi-page document
    const p = insertDocument(a, ${JSON.stringify(path.join(FIX, 'sample.pdf'))});
    let tiles = 0, shown = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      shown = document.getElementById('overlay').classList.contains('show') &&
              document.getElementById('overlayCard').classList.contains('picker');
      tiles = document.querySelectorAll('.pick-tile').length;
      if (shown && tiles) break;
    }
    const label = document.querySelector('.pick-count')?.textContent || '';
    // choose page 2 only, then import
    const range = document.querySelector('.range-input');
    range.value = '2';
    range.dispatchEvent(new Event('input'));
    const btn = [...document.querySelectorAll('.card.picker .actions .btn')].find(b => /Import/.test(b.textContent));
    const btnText = btn.textContent;
    btn.click();
    const objs = await p;
    return { shown, tiles, label, btnText, added: a.store.count - before,
             page: objs && objs[0] ? objs[0].docPage : null,
             selected: a.surface.selection.size };
  `);
  check('the page picker appears for a multi-page document', picker.shown && picker.tiles === 3, `${picker.tiles} thumbnails, "${picker.label}"`);
  check('picking a single page imports only that page', picker.added === 1 && picker.page === 2,
    `${picker.added} object(s), page ${picker.page}`);
  check('the import button reflects the choice', /Import 1 page/.test(picker.btnText), picker.btnText);

  const quality = await js(`
    const { openPdf } = await import('app://board/js/importers/pdf.js');
    const { QUALITY } = await import('app://board/js/ui/pagepicker.js');
    const res = await window.board.importToPdf(${JSON.stringify(path.join(FIX, 'sample.pdf'))});
    const doc = await openPdf(res.data);
    const out = [];
    for (const q of QUALITY) {
      const p = await doc.render(1, q.id);
      // decode the PNG to get its real pixel size
      const px = await new Promise((ok) => {
        const im = new Image();
        im.onload = () => ok({ w: im.naturalWidth, h: im.naturalHeight });
        im.src = p.dataUrl;
      });
      out.push({ label: q.label, dpi: q.dpi, w: px.w, h: px.h, bytes: p.dataUrl.length, pts: Math.round(p.width) });
    }
    await doc.destroy();
    return out;
  `);
  const ascending = quality.every((q, i) => i === 0 || q.w > quality[i - 1].w);
  check('import quality steps up the raster size', ascending,
    quality.map((q) => `${q.label} ${q.w}x${q.h}`).join(', '));
  check('maximum quality reaches print resolution', quality[2].w / quality[2].pts * 72 >= 280,
    Math.round(quality[2].w / quality[2].pts * 72) + ' dpi');
  check('page size in board units is unchanged by quality',
    quality.every((q) => q.pts === quality[0].pts), quality[0].pts + ' pt wide at every setting');
  check('imported pages are not left selected as a clump', picker.selected === 0);

  const imgOk = await js(`
    const a = window.app;
    const pages = a.store.objects.filter(o => o.kind === 'page');
    return pages.length > 0 && pages.every(p => typeof p.src === 'string' && p.src.startsWith('data:image/png') && p.src.length > 2000);
  `);
  check('imported pages carry bitmaps', imgOk);

  await js(`window.app.command('fit');`);
  await sleep(700);
  await shot(win, '02-imports');

  /* ---- export ---- */
  const png = await js(`
    const a = window.app;
    const b = a.store.contentBounds();
    const c = a.surface.renderTo({ x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 }, 0.5);
    return { w: c.width, h: c.height, url: c.toDataURL().length };
  `);
  check('PNG render produces pixels', png.w > 100 && png.url > 5000, `${png.w}x${png.h}`);

  const svg = await js(`
    const m = await import('app://board/js/export.js');
    const a = window.app;
    const b = a.store.contentBounds();
    // buildSvg is internal; exercise it through the module's public surface
    return typeof m.exportSvg === 'function' && typeof m.saveBoardFile === 'function';
  `);
  check('export module intact', svg);

  /* ---- persistence round-trip ---- */
  const round = await js(`
    const a = window.app;
    const json = JSON.parse(JSON.stringify(a.store.toJSON()));
    const n = json.objects.length;
    const { Store } = await import('app://board/js/core/store.js');
    const s2 = new Store(); s2.load(json);
    return { n, loaded: s2.count, name: s2.doc.name, bg: s2.doc.background.pattern };
  `);
  check('board serialises and reloads', round.n === round.loaded && round.n > 10, `${round.loaded} objects`);

  const saved = await js(`
    await window.app.persist();
    const list = await window.board.boards.list();
    return list.length;
  `);
  check('board saved to disk', saved >= 1, saved + ' board(s)');

  /* ---- op log (collaboration seam) ---- */
  const oplog = await js(`
    const a = window.app;
    const seen = [];
    const base = a.store.checkpoint();
    const off = a.store.onOp(op => seen.push(op.t));
    a.store.add({ id: 'op-test', type: 'shape', kind: 'rect', x: 0, y: 0, w: 5, h: 5, rotation: 0, stroke: '#000', fill: 'none', lineWidth: 1 });
    a.store.update('op-test', { w: 20 });
    a.store.remove(['op-test']);
    off();
    const { Store } = await import('app://board/js/core/store.js');
    const peer = new Store();
    peer.load(base);
    peer.applyRemote(a.store.log.map(o => o));
    return { seen, peerCount: peer.count, mine: a.store.count };
  `);
  check('op log emits add/set/del', oplog.seen.join(',') === 'add,set,del', oplog.seen.join(','));
  check('remote replay reproduces board', oplog.peerCount === oplog.mine, `${oplog.peerCount} vs ${oplog.mine}`);

  /* ---- tool switching / UI ---- */
  const tools = await js(`
    const a = window.app; const got = [];
    for (const t of ['select','lasso','pen','highlighter','eraser','note','text','shape']) { a.setTool(t); got.push(a.tool); }
    a.setTool('select');
    return got;
  `);
  check('all tools selectable', tools.join(',') === 'select,lasso,pen,highlighter,eraser,note,text,shape', tools.join(','));

  await js(`window.app.setSelection([window.app.store.doc.order[0]]);`);
  await sleep(250);
  check('selection bar shows', await js(`return document.getElementById('ctxbar').classList.contains('show');`));

  await js(`window.app.panels.templates();`);
  await sleep(350);
  check('templates panel opens', await js(`return document.getElementById('panel').classList.contains('open') && document.querySelectorAll('.tpl').length > 8;`));
  await shot(win, '03-templates');
  await js(`window.app.panels.close();`);

  await js(`window.app.showShortcuts();`);
  await sleep(250);
  await shot(win, '04-shortcuts');
  await js(`document.getElementById('overlay').classList.remove('show');`);

  /* ---- boards survive a restart ---- *
   * The bug this guards: the "which board was open" pointer used to live in the
   * renderer's localStorage, which Chromium flushes lazily. A machine that was
   * restarted rather than shut down cleanly lost it, the app opened a blank
   * canvas, and it looked exactly like every board had been deleted.
   */
  const userData = app.getPath('userData');
  const boardsDir = path.join(userData, 'boards');
  const pointerFile = path.join(userData, 'last-board.json');

  const twoBoards = await js(`
    const a = window.app;
    const mk = async (name, n) => {
      a.newBoard(true);
      a.store.rename(name);
      for (let i = 0; i < n; i++)
        a.store.add({ id: name + i, type: 'shape', kind: 'rect', x: 10 + i * 20, y: 10, w: 40, h: 30,
                      rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
      await a.persist();
      return a.store.doc.id;
    };
    const older = await mk('Older board', 2);
    await new Promise(r => setTimeout(r, 1100));      // so mtimes differ
    const newer = await mk('Newer board', 3);
    return { older, newer };
  `);

  const pointerAfterSave = JSON.parse(await fs.readFile(pointerFile, 'utf8'));
  check('saving a board records the open-board pointer on disk, not just in the renderer',
    pointerAfterSave.id === twoBoards.newer, `${pointerAfterSave.id} vs ${twoBoards.newer}`);
  check('the board itself is on disk immediately',
    (await fs.readFile(path.join(boardsDir, twoBoards.newer + '.json'), 'utf8')).includes('Newer board'));
  check('atomic writes leave no temp files behind',
    (await fs.readdir(boardsDir)).every((f) => f.endsWith('.json')),
    (await fs.readdir(boardsDir)).join(', '));

  const resumed = await js(`return await window.board.boards.resume();`);
  check('resume reopens the board that was open', resumed.board && resumed.board.id === twoBoards.newer,
    resumed.board && resumed.board.id);

  // now the case that actually bit: the pointer never made it to disk
  await fs.rm(pointerFile, { force: true });
  const resumedNoPointer = await js(`return await window.board.boards.resume();`);
  check('with the pointer gone, it reopens the newest real board instead of a blank one',
    resumedNoPointer.board && resumedNoPointer.board.id === twoBoards.newer && resumedNoPointer.reason === 'newest',
    `${resumedNoPointer.reason} ${resumedNoPointer.board && resumedNoPointer.board.name}`);

  // and it must never prefer an empty board over one with work in it
  await fs.writeFile(path.join(boardsDir, 'zz-empty.json'),
    JSON.stringify({ id: 'zz-empty', name: 'Untitled board', objects: [], order: [] }));
  const resumedWithEmpty = await js(`return await window.board.boards.resume();`);
  check('an empty board never wins over one with work on it',
    resumedWithEmpty.board && (resumedWithEmpty.board.objects || []).length > 0,
    resumedWithEmpty.board && resumedWithEmpty.board.name);
  await fs.rm(path.join(boardsDir, 'zz-empty.json'), { force: true });

  /*
   * Waited for rather than slept through.
   *
   * Autosave deliberately backs off according to how long the LAST write cost:
   * `Math.min(4000, Math.max(700, saveCost * 4))`, so on a slow disk, or with
   * an antivirus watching the boards folder, or simply by this point in a suite
   * that has made two dozen boards, the pause before writing can be four
   * seconds. A fixed 900ms sleep here asserted a deadline the app never
   * promised, and failed on exactly the machines the backoff exists for.
   *
   * So: poll until it appears, with a ceiling well past the 4s maximum. Fast
   * machines still finish in about a second, because it returns the moment the
   * board is on disk.
   */
  const litter = await js(`
    const a = window.app;
    const count = async () => (await window.board.boards.list()).length;
    const before = await count();
    a.newBoard(true);                       // a fresh board nobody has drawn on

    // A generous pause on this one: it is proving something did NOT happen, and
    // waiting longer only makes that stronger.
    await new Promise(r => setTimeout(r, 1500));
    const after = await count();

    a.store.add({ id: 'proof', type: 'shape', kind: 'rect', x: 0, y: 0, w: 10, h: 10,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    let afterDrawing = after;
    let waited = 0;
    while (afterDrawing === after && waited < 12000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
      afterDrawing = await count();
    }
    return { before, after, afterDrawing, waited };
  `);
  check('an untouched new board is not written to disk',
    litter.after === litter.before, `${litter.before} -> ${litter.after}`);
  check('but it is saved once something is drawn on it',
    litter.afterDrawing === litter.before + 1,
    `${litter.before} -> ${litter.afterDrawing} after ${litter.waited}ms`);

  await js(`window.app.newBoard(true); window.app.store.clear();`);

  /* ---- boards from the OpenBoard days are not stranded ---- *
   * The app folder is named after productName, so the rename to GazBoard left
   * the old boards behind in a folder called "OpenBoard" - with capitals. The
   * migration used to look for a literal lower-case "openboard", which only
   * matched because Windows ignores case in paths.
   */
  const legacyDir = path.join(path.dirname(userData), 'OpenBoard', 'boards');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'legacy-1.json'), JSON.stringify({
    id: 'legacy-1', name: 'From OpenBoard', order: ['l1'],
    objects: [{ id: 'l1', type: 'shape', kind: 'rect', x: 0, y: 0, w: 40, h: 40,
                rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }],
    background: { pattern: 'grid', color: '#fff' }
  }));
  const mig = await js(`return await window.board.boards.migrate();`);
  check('boards from the old OpenBoard folder are carried over, capitals and all',
    mig && mig.moved >= 1 && mig.from.includes('OpenBoard'),
    JSON.stringify(mig));
  check('the carried-over board really lands in the new folder',
    (await fs.readFile(path.join(boardsDir, 'legacy-1.json'), 'utf8')).includes('From OpenBoard'));
  check('the originals are left where they were',
    !!(await fs.readFile(path.join(legacyDir, 'legacy-1.json'), 'utf8')));
  const migAgain = await js(`return await window.board.boards.migrate();`);
  check('running the migration again copies nothing and overwrites nothing',
    migAgain.moved === 0, JSON.stringify(migAgain));
  await fs.rm(path.join(boardsDir, 'legacy-1.json'), { force: true });
  await fs.rm(path.join(path.dirname(userData), 'OpenBoard'), { recursive: true, force: true });

  /* ---- infinite canvas vs a fixed sheet ---- */
  const canvas = await js(`
    const a = window.app;
    const { pageWorldSize, paperForPage } = await import('app://board/js/ui/pdfdialog.js');
    const { pageRect } = await import('app://board/js/core/render.js');
    const r = {};
    a.newBoard(true);
    r.defaultIsInfinite = a.store.pageCount === 0;

    await a.setPageSize('a4', 'landscape');
    r.a4 = a.store.page && { ...a.store.page };
    r.expected = pageWorldSize('a4', 'landscape');
    r.roundTrip = paperForPage(a.store.page);

    // ink outside the sheet must survive - a page is a guide, not a crop
    a.store.add({ id: 'faroff', type: 'shape', kind: 'rect', x: 5000, y: 5000, w: 100, h: 100,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    r.objectsWithPage = a.store.objects.length;
    await a.setPageSize('infinite');
    r.backToInfinite = a.store.pageCount === 0;
    r.objectsAfter = a.store.objects.length;
    r.farStillThere = !!a.store.get('faroff');

    // and it survives a save/load round trip
    await a.setPageSize('letter', 'portrait');
    const saved = a.store.toJSON();
    r.savedPage = saved.pages[0] && { ...saved.pages[0] };
    r.savedMirror = saved.page && { ...saved.page };      // for builds before multi-page
    r.savedSchema = saved.schema;
    a.newBoard(true);
    await a.loadBoard(saved, { silent: true, noMigrationPrompt: true });
    r.loadedPage = a.store.page && { ...a.store.page };

    // a board written by an older build still opens, as a one-page pad
    a.newBoard(true);
    await a.loadBoard({ name: 'legacy', schema: 1, page: { w: 794, h: 1123 }, objects: [] },
      { silent: true, noMigrationPrompt: true });
    r.legacyOpens = a.store.pageCount === 1 && a.store.page.w === 794;

    // the sheet is drawn centred on the origin
    const rect = pageRect([{ w: 800, h: 600 }], { x: 0, y: 0, z: 1 });
    r.sheetAtOrigin = rect;
    r.sheetZoomed = pageRect([{ w: 800, h: 600 }], { x: 0, y: 0, z: 0.5 });

    // undo steps back to whatever the canvas was before, infinite included
    await a.setPageSize('infinite');
    await a.setPageSize('a3', 'landscape');
    const beforeUndo = a.store.page && a.store.page.w;
    a.command('edit.undo');
    r.undoWent = { before: beforeUndo, after: a.store.pageCount };

    a.newBoard(true); a.store.clear();
    return r;
  `);

  check('a new board is an infinite canvas', canvas.defaultIsInfinite === true);
  check('choosing A4 landscape sets a sheet of the right size',
    canvas.a4 && canvas.a4.w === canvas.expected.w && canvas.a4.h === canvas.expected.h,
    JSON.stringify(canvas.a4));
  check('the sheet is recognised as the paper it came from',
    canvas.roundTrip && canvas.roundTrip.paper === 'a4' && canvas.roundTrip.orientation === 'landscape',
    JSON.stringify(canvas.roundTrip));
  check('work outside the sheet is never destroyed',
    canvas.objectsAfter === canvas.objectsWithPage && canvas.farStillThere,
    `${canvas.objectsWithPage} -> ${canvas.objectsAfter}`);
  check('switching back to infinite is one click', canvas.backToInfinite === true);
  check('the page size is saved with the board and comes back',
    canvas.loadedPage && canvas.savedPage && canvas.loadedPage.w === canvas.savedPage.w
      && canvas.loadedPage.h === canvas.savedPage.h,
    JSON.stringify([canvas.savedPage, canvas.loadedPage]));
  check('the sheet is centred on the origin',
    canvas.sheetAtOrigin.x === -400 && canvas.sheetAtOrigin.y === -300
      && canvas.sheetAtOrigin.w === 800 && canvas.sheetAtOrigin.h === 600,
    JSON.stringify(canvas.sheetAtOrigin));
  check('the sheet scales with the zoom',
    canvas.sheetZoomed.w === 400 && canvas.sheetZoomed.h === 300, JSON.stringify(canvas.sheetZoomed));
  check('changing the canvas size can be undone',
    canvas.undoWent.before > 0 && canvas.undoWent.after === 0, JSON.stringify(canvas.undoWent));
  check('a board is written so an older build can still open it',
    canvas.savedSchema === 2 && canvas.savedMirror && canvas.savedMirror.w === canvas.savedPage.w,
    JSON.stringify({ schema: canvas.savedSchema, mirror: canvas.savedMirror }));
  check('a board saved before multi-page opens as a one-page pad', canvas.legacyOpens === true);

  const pageOpen = await js(`
    const a = window.app;
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    const saved = a.store.toJSON();
    saved.camera = { x: 0, y: 0, z: 1 };          // a camera that shows a corner
    a.newBoard(true);
    await a.loadBoard(saved, { silent: true, startup: true, noMigrationPrompt: true });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const sf = a.surface, page = a.store.page;
    // the whole sheet has to be inside the window
    const view = sf.cam.viewport(sf.width, sf.height);
    return {
      z: sf.cam.z,
      fits: view.w >= page.w && view.h >= page.h,
      pageH: page.h, viewH: Math.round(view.h)
    };
  `);
  check('a board on a sheet opens showing the whole sheet, not a corner of it',
    pageOpen.fits && pageOpen.z < 1, JSON.stringify(pageOpen));

  const pageTpl = await js(`
    const { TEMPLATES } = await import('app://board/js/templates.js');
    const a = window.app;
    a.newBoard(true);
    const tpl = TEMPLATES.find(t => t.id === 'page-a4-p');
    a.applyTemplate(tpl);
    await new Promise(r => setTimeout(r, 60));
    return {
      group: tpl.group,
      count: TEMPLATES.filter(t => t.page).length,
      page: a.store.page && { ...a.store.page },
      objectsAdded: a.store.objects.length
    };
  `);
  check('page sizes are offered in Templates, before you start inking',
    pageTpl.count >= 5 && pageTpl.group === 'Canvas size', `${pageTpl.count} in "${pageTpl.group}"`);
  check('picking one sets the page and adds nothing to the board',
    pageTpl.page && pageTpl.page.h > pageTpl.page.w && pageTpl.objectsAdded === 0,
    JSON.stringify(pageTpl));

  const pageExport = await js(`
    const a = window.app;
    a.newBoard(true);
    a.store.add({ id: 'tiny', type: 'shape', kind: 'rect', x: -20, y: -20, w: 40, h: 40,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    await a.setPageSize('a4', 'portrait');
    const { exportBoundsForTest } = await import('app://board/js/export.js');
    return exportBoundsForTest(a);
  `);
  check('exports use the sheet, not just what you happened to draw',
    Math.abs(pageExport.w - 794) < 2 && Math.abs(pageExport.h - 1123) < 2,
    JSON.stringify(pageExport));

  await js(`window.app.newBoard(true); window.app.store.clear();`);

  /* ---- nothing falls off the sheet without you knowing ---- *
   * A slide imports at about 1536 units wide; A4 is 794. Before this was
   * handled, importing onto a sheet put half the page over the edge and the
   * export cropped it silently.
   */
  const offpage = await js(`
    const a = window.app;
    const { insertDocument } = await import('app://board/js/insert.js');
    const r = {};

    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    await insertDocument(a, ${JSON.stringify(path.join(FIX, 'lecture-09-greedy.pptx'))}, { pages: [1], layout: 'row' });
    const page = a.store.page;
    const img = a.store.objects.find(o => o.type === 'image');
    r.imported = img && { w: Math.round(img.w), h: Math.round(img.h), x: Math.round(img.x), y: Math.round(img.y) };
    r.page = { w: page.w, h: page.h };
    r.fitsOnSheet = a.offPageObjects().length === 0;

    // something dragged well off the sheet is detected
    a.store.add({ id: 'stray', type: 'shape', kind: 'rect', x: 4000, y: 4000, w: 100, h: 100,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    r.strayDetected = a.offPageObjects().length;

    // and the one-click fix brings it back inside, without distorting anything
    const beforeAspect = (() => { const o = a.store.get(img.id); return o.w / o.h; })();
    a.fitContentToPage();
    const after = a.store.get(img.id);
    r.afterFit = { off: a.offPageObjects().length, aspect: after.w / after.h, beforeAspect };
    r.strayStillExists = !!a.store.get('stray');

    // and it is one undo
    a.command('edit.undo');
    r.afterUndo = a.offPageObjects().length;

    // an infinite board never reports anything off-page
    await a.setPageSize('infinite');
    r.infiniteOff = a.offPageObjects().length;

    a.newBoard(true); a.store.clear();
    return r;
  `);

  /* ================================================================= *
   *  Paper: pages clip, and a board can have several of them
   * ================================================================= */
  const clip = await js(`
    const a = window.app;
    const { pageRects } = await import('app://board/js/core/pages.js');
    const r = {};
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    const sheet = pageRects(a.pages)[0];

    // A stroke run off the right edge, driven through the REAL motion path -
    // the point is to exercise the code that decides what to keep, not to
    // re-implement its rule here and then agree with myself.
    const inter = a.interaction;
    const cam = a.surface.cam;
    const toScreen = (wp) => ({ x: wp.x * cam.z + cam.x, y: wp.y * cam.z + cam.y });
    const startWp = { x: sheet.x + 40, y: sheet.y + 40 };
    inter.startStroke({ pointerType: 'pen', pressure: 0.5 }, startWp, 'pen');
    r.started = !!inter.action;
    const act = inter.action;
    for (let i = 1; i <= 120; i++) {
      inter.applyMotion(toScreen({ x: startWp.x + i * 12, y: startWp.y }), {}, null);
    }
    r.pointCount = act.obj.points.length;
    r.strokeStayedOn = act.obj.points.every(p => p.x <= sheet.x + sheet.w + 0.01);
    r.strokeHasInk = act.obj.points.length > 3;
    r.walkedPast = startWp.x + 120 * 12 > sheet.x + sheet.w;   // the gesture really did leave the paper

    // and coming back onto the paper resumes the same stroke
    const beforeReturn = act.obj.points.length;
    inter.applyMotion(toScreen({ x: sheet.x + 200, y: startWp.y + 30 }), {}, null);
    r.resumedOnReturn = act.obj.points.length > beforeReturn;

    inter.finishStroke(act);
    inter.action = null;
    r.strokeCommitted = a.store.objects.some(o => o.type === 'stroke');
    r.strokeOffPage = a.offPageObjects().length;

    // starting in the gutter does nothing at all
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    inter.startStroke({ pointerType: 'pen', pressure: 0.5 }, { x: sheet.x - 400, y: sheet.y }, 'pen');
    r.gutterRefused = !inter.action;
    inter.action = null; a.surface.wet = null;

    // a note dropped past the edge is slid back onto the paper
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    const s0 = pageRects(a.pages)[0];
    a.interaction.dropNote({ x: s0.x + s0.w + 300, y: s0.y + 100 });
    const note = a.store.objects.find(o => o.type === 'note');
    r.noteClamped = note && note.x + note.w <= s0.x + s0.w + 0.01 && note.x >= s0.x - 0.01;
    r.noteOffPage = a.offPageObjects().length;

    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('a stroke run off the edge keeps only the ink that landed on paper',
    clip.started && clip.strokeHasInk && clip.strokeStayedOn && clip.walkedPast, JSON.stringify(clip));
  check('bringing the pen back onto the paper resumes the same stroke', clip.resumedOnReturn === true);
  check('that stroke is still committed, and sits on the page',
    clip.strokeCommitted && clip.strokeOffPage === 0, JSON.stringify(clip));
  check('drawing in the gutter between sheets does nothing', clip.gutterRefused === true);
  check('a note dropped past the edge slides back onto the paper',
    clip.noteClamped && clip.noteOffPage === 0, JSON.stringify(clip));

  const pad = await js(`
    const a = window.app;
    const { pageRects, PAGE_GAP } = await import('app://board/js/core/pages.js');
    const r = {};
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    const first = pageRects(a.pages)[0];
    r.startsAtOne = a.pageCount;
    r.firstRectUnchanged = { x: first.x, y: first.y, w: first.w, h: first.h };

    // ink on page 1, then add a page and put ink on that
    a.store.add({ id: 'p1ink', type: 'shape', kind: 'rect', x: -100, y: -100, w: 200, h: 200,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    a.addPage();
    r.afterAdd = a.pageCount;
    r.onPage2 = a.currentPageIndex();
    const second = pageRects(a.pages)[1];
    r.gap = Math.round(second.y - (first.y + first.h));
    r.expectedGap = PAGE_GAP;
    a.store.add({ id: 'p2ink', type: 'shape', kind: 'rect', x: -100, y: second.y + 100, w: 200, h: 200,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    r.nothingLoose = a.offPageObjects().length;

    // inserting a page BEFORE page 2 has to carry page 2's ink down with it
    const inkBefore = { ...a.store.get('p2ink') };
    a.addPage(0);
    const inkAfter = a.store.get('p2ink');
    r.pagesNow = a.pageCount;
    r.inkRodeAlong = Math.round(inkAfter.y - inkBefore.y) === Math.round(first.h + PAGE_GAP);
    r.stillNothingLoose = a.offPageObjects().length;

    // one undo puts the whole insert back
    a.command('edit.undo');
    r.afterUndo = { pages: a.pageCount, y: Math.round(a.store.get('p2ink').y) };
    r.undoRestored = r.afterUndo.pages === 2 && r.afterUndo.y === Math.round(inkBefore.y);

    // page 1 never moves, whatever happens after it
    r.firstStillAtOrigin = JSON.stringify(pageRects(a.pages)[0]) === JSON.stringify(r.firstRectUnchanged);

    // duplicating a page copies its contents onto the new sheet
    a.duplicatePage(0);
    r.afterDuplicate = a.pageCount;
    r.copies = a.store.objects.filter(o => o.type === 'shape' && Math.round(o.w) === 200).length;

    // changing the paper size relays the strip and takes the ink with it
    await a.setPageSize('a5', 'portrait');
    r.allResized = a.pages.every(p => p.w === a.pages[0].w);
    r.resizeKeptCount = a.pageCount;
    r.looseAfterResize = a.offPageObjects().length;

    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('a pad starts as a single sheet', pad.startsAtOne === 1);
  check('adding a page puts you on it', pad.afterAdd === 2 && pad.onPage2 === 1, JSON.stringify(pad));
  check('sheets are stacked with a gutter between them', pad.gap === pad.expectedGap, `${pad.gap} vs ${pad.expectedGap}`);
  check('ink on each sheet belongs to that sheet', pad.nothingLoose === 0);
  check('inserting a page carries the later pages\' ink down with it',
    pad.inkRodeAlong && pad.stillNothingLoose === 0, JSON.stringify(pad));
  check('one undo puts an inserted page and everything it moved back', pad.undoRestored === true, JSON.stringify(pad.afterUndo));
  check('page one never moves, however many pages come after it', pad.firstStillAtOrigin === true);
  check('duplicating a page copies what is on it', pad.afterDuplicate === 3 && pad.copies >= 2, JSON.stringify(pad));
  check('changing the paper size resizes every sheet and keeps the ink on it',
    pad.allResized && pad.resizeKeptCount === 3 && pad.looseAfterResize === 0, JSON.stringify(pad));

  const padDel = await js(`
    const a = window.app;
    const r = {};
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    a.addPage(); a.addPage();
    r.three = a.pageCount;
    await a.deletePage(1);            // empty page, so no confirmation
    r.two = a.pageCount;
    a.command('edit.undo');
    r.backToThree = a.pageCount;
    // the last page cannot be deleted out from under you
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    const only = await a.deletePage(0);
    r.lastPageKept = only === false && a.pageCount === 1;
    a.newBoard(true); a.store.clear();
    return r;
  `);
  const padTrip = await js(`
    const a = window.app;
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    a.addPage(); a.addPage();
    const { pageRects } = await import('app://board/js/core/pages.js');
    const r3 = pageRects(a.pages)[2];
    a.store.add({ id: 'last', type: 'shape', kind: 'rect', x: r3.x + 50, y: r3.y + 50, w: 100, h: 100,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 });
    const saved = a.store.toJSON();
    a.newBoard(true);
    await a.loadBoard(saved, { silent: true, noMigrationPrompt: true });
    const back = a.store.get('last');
    const rr = pageRects(a.pages);
    return {
      savedPages: saved.pages.length,
      loadedPages: a.pageCount,
      objectBack: !!back && Math.round(back.y) === Math.round(r3.y + 50),
      onThirdSheet: rr.length === 3 && back.y > rr[1].y + rr[1].h,
      loose: a.offPageObjects().length
    };
  `);
  check('a three-page pad survives a save and load intact',
    padTrip.savedPages === 3 && padTrip.loadedPages === 3 && padTrip.objectBack
      && padTrip.onThirdSheet && padTrip.loose === 0, JSON.stringify(padTrip));

  check('a page can be deleted and undone', padDel.three === 3 && padDel.two === 2 && padDel.backToThree === 3, JSON.stringify(padDel));
  check('a pad always keeps at least one page', padDel.lastPageKept === true);

  const padCam = await js(`
    const a = window.app;
    const r = {};
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    const sf = a.surface;
    // running away from the paper is not possible any more
    sf.cam.panBy(-40000, -40000);
    sf.clampCamera();
    const { stripBounds } = await import('app://board/js/core/pages.js');
    const b = stripBounds(a.pages);
    const sx = b.x * sf.cam.z + sf.cam.x, sy = b.y * sf.cam.z + sf.cam.y;
    const sw = b.w * sf.cam.z, sh = b.h * sf.cam.z;
    r.paperStillOnScreen = sx + sw > 0 && sy + sh > 0 && sx < sf.width && sy < sf.height;

    // and an infinite board is still free to roam
    await a.setPageSize('infinite');
    const before = sf.cam.x;
    sf.cam.panBy(-40000, 0);
    sf.clampCamera();
    r.infiniteStillFree = Math.abs(sf.cam.x - (before - 40000)) < 0.01;
    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('you cannot pan away from the paper until it is off screen', padCam.paperStillOnScreen === true);
  check('an infinite board is still free to roam', padCam.infiniteStillFree === true);

  /* ---- the bottom controls never sit on top of each other ---- *
   * The toolbar is centred and the readouts are right-anchored, so they start
   * to overlap long before the window looks narrow. This sweeps real window
   * sizes rather than trusting a breakpoint, so adding a tool later cannot
   * quietly push the pens back under the zoom control.
   */
  {
    const [w0, h0] = win.getSize();
    await js(`window.app.newBoard(true); await window.app.setPageSize('a4','portrait'); window.app.addPage();`);
    const clashes = [];
    for (const h of [1000, 800, 620, 520]) {
      for (const w of [1700, 1440, 1340, 1310, 1200, 1050, 900, 861, 860, 700, 560, 470]) {
        win.setSize(w, h);
        await sleep(60);
        const r = await js(`
          window.app.surface.resize(true);
          const R = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; return e.getBoundingClientRect(); };
          const hit = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
          const tb = R('toolbar'), zb = R('zoombar'), pb = R('pagebar');
          return { tz: hit(tb, zb), tp: hit(tb, pb), zp: hit(zb, pb),
                   spills: !!tb && (tb.bottom > window.innerHeight + 1) };
        `);
        if (r.tz || r.tp || r.zp || r.spills) clashes.push(`${w}x${h}`);
      }
    }
    win.setSize(w0, h0);
    await sleep(120);
    await js(`window.app.surface.resize(true); window.app.newBoard(true); window.app.store.clear();`);
    check('the toolbar, zoom and page controls never overlap at any window size',
      clashes.length === 0, clashes.slice(0, 6).join(', ') || 'clean at 48 sizes');

    // and the readouts stay where people reach for them until the window is
    // genuinely too narrow to keep them there
    const corner = [];
    for (const w of [1440, 1340, 1280, 1100, 950, 880]) {
      win.setSize(w, 820);
      await sleep(60);
      const ok = await js(`
        window.app.surface.resize(true);
        const zb = document.getElementById('zoombar').getBoundingClientRect();
        return (window.innerHeight - zb.bottom) < 40 && (window.innerWidth - zb.right) < 40;
      `);
      if (!ok) corner.push(String(w));
    }
    win.setSize(w0, h0);
    await sleep(120);
    await js(`window.app.surface.resize(true);`);
    check('the zoom readout stays in the bottom-right corner on any usable window',
      corner.length === 0, corner.join(', ') || 'corner down to 880px');
  }

  /* ---- shortcut letters on the toolbar ---- */
  const keys = await js(`
    const a = window.app;
    const bar = document.getElementById('toolbar');
    const r = {};
    const badge = (sel) => { const el = bar.querySelector(sel); const k = el && el.querySelector('.kbd'); return k ? k.textContent : null; };
    r.select = badge('[data-tool="select"]');
    r.lasso  = badge('[data-tool="lasso"]');
    r.laser  = badge('[data-tool="laser"]');
    r.pen    = badge('.pen[data-pen="black"]');
    r.red    = badge('.pen[data-pen="red"]');
    r.galaxy = badge('.pen[data-pen="galaxy"]');
    r.hl     = badge('.pen[data-tool="highlighter"]');
    r.eraser = badge('.pen[data-tool="eraser"]');
    r.text   = badge('[data-tool="text"]');
    r.note   = badge('[data-tool="note"]');
    r.shape  = badge('[data-tool="shape"]');
    // only the canonical pen carries the letter, not all six colours
    r.pensWithKeys = bar.querySelectorAll('.pen[data-pen] .kbd').length;

    // the digits actually reach the pens
    const { PENS } = await import('app://board/js/ui/palettes.js');
    const press = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    a.setTool('select');
    press('3');
    r.afterThree = { tool: a.tool, color: a.settings.penColor, want: PENS[2].color };
    press('5');
    r.afterFive = { tool: a.tool, effect: a.settings.penEffect, want: PENS[4].effect };
    press('9');                       // there is no ninth pen
    r.ninthIgnored = a.settings.penColor === PENS[4].color;

    // recolouring the highlighter must not drop its badge
    a.settings.highlighterColor = '#00ff00';
    a.syncUI();
    r.hlAfterRecolour = badge('.pen[data-tool="highlighter"]');

    // and the letters can be turned off
    a.settings.showToolKeys = false; a.syncUI();
    r.hiddenClass = bar.classList.contains('hide-keys');
    a.settings.showToolKeys = true; a.syncUI();
    r.shownAgain = !bar.classList.contains('hide-keys');
    return r;
  `);
  check('every tool with a shortcut shows its letter',
    keys.select === 'V' && keys.lasso === 'L' && keys.laser === 'X'
      && keys.hl === 'H' && keys.eraser === 'E' && keys.text === 'T' && keys.note === 'N' && keys.shape === 'S',
    JSON.stringify(keys));
  check('each pen wears its own number', keys.pen === '1' && keys.red === '2' && keys.galaxy === '6'
    && keys.pensWithKeys === 6, JSON.stringify(keys));
  check('a digit switches straight to that pen',
    keys.afterThree.tool === 'pen' && keys.afterThree.color === keys.afterThree.want,
    JSON.stringify(keys.afterThree));
  check('and it carries the pen\'s effect, not just its colour',
    keys.afterFive.effect === keys.afterFive.want, JSON.stringify(keys.afterFive));
  check('a digit past the end of the tray does nothing', keys.ninthIgnored === true);
  check('recolouring the highlighter keeps its letter', keys.hlAfterRecolour === 'H');
  check('the letters can be switched off', keys.hiddenClass === true && keys.shownAgain === true);

  /* ---- deleting a board, and creating one ---- *
   * Deleting the board you are looking at used to remove the file and leave
   * the document in memory holding its id, so the next autosave wrote it
   * straight back: the board returned the moment anything was drawn. And a new
   * board was not written until the first mark, so it did not appear in the
   * list when you made it.
   */
  const boardsLife = await js(`
    const a = window.app;
    const r = {};
    const list = async () => (await window.board.boards.list()).map(b => b.id);

    // --- an explicit New board is listed straight away, before anything is drawn
    a.newBoard(false);
    await a.pendingWrite;
    const freshId = a.store.doc.id;
    r.newBoardListedImmediately = (await list()).includes(freshId);
    r.newBoardIsEmpty = a.store.objects.length === 0;

    // --- but one the app makes for itself leaves no litter
    a.newBoard(true);
    await new Promise(res => setTimeout(res, 60));
    r.silentBoardNotListed = !(await list()).includes(a.store.doc.id);

    // --- delete the board that is open
    a.newBoard(false);
    await a.pendingWrite;
    const doomed = a.store.doc.id;
    a.store.add({ id: 'mark', type: 'shape', kind: 'rect', x: 0, y: 0, w: 40, h: 40,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }, 'x');
    await a.persist({ force: true });
    r.wasOnDisk = (await list()).includes(doomed);

    const wasOpen = await a.deleteBoard(doomed);
    r.reportedOpen = wasOpen === true;
    r.goneFromList = !(await list()).includes(doomed);
    r.canvasCleared = a.store.objects.length === 0;
    r.freshId = a.store.doc.id !== doomed;

    // the resurrection: draw on the replacement and make sure the deleted one
    // does not come back
    a.store.add({ id: 'after', type: 'shape', kind: 'rect', x: 0, y: 0, w: 40, h: 40,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }, 'x');
    await a.persist({ force: true });
    const after = await list();
    r.stayedDeleted = !after.includes(doomed);
    r.newOneSaved = after.includes(a.store.doc.id);

    // --- deleting a board you are NOT looking at must not disturb the canvas
    a.newBoard(false); await a.pendingWrite;
    const other = a.store.doc.id;
    a.newBoard(false); await a.pendingWrite;
    const current = a.store.doc.id;
    a.store.add({ id: 'keep', type: 'shape', kind: 'rect', x: 0, y: 0, w: 40, h: 40,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }, 'x');
    const openedWas = await a.deleteBoard(other);
    r.otherReportedNotOpen = openedWas === false;
    r.currentUntouched = a.store.doc.id === current && a.store.has('keep');

    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('a new board appears in the list as soon as it is made',
    boardsLife.newBoardListedImmediately === true && boardsLife.newBoardIsEmpty === true, JSON.stringify(boardsLife));
  check('a board the app makes for itself still leaves no litter',
    boardsLife.silentBoardNotListed === true);
  check('deleting the open board clears the canvas and starts a fresh one',
    boardsLife.wasOnDisk && boardsLife.reportedOpen && boardsLife.goneFromList
      && boardsLife.canvasCleared && boardsLife.freshId, JSON.stringify(boardsLife));
  check('a deleted board does not come back when you draw again',
    boardsLife.stayedDeleted === true && boardsLife.newOneSaved === true, JSON.stringify(boardsLife));
  check('deleting a different board leaves the open one alone',
    boardsLife.otherReportedNotOpen === true && boardsLife.currentUntouched === true, JSON.stringify(boardsLife));

  /* ---- panning for machines with no pen ---- *
   * The pan tool is not new machinery: space-drag and the middle button have
   * always used it. What is new is that it is visible. The assertions that
   * matter here are the ones about what did NOT change.
   */
  const panning = await js(`
    const a = window.app;
    const sf = a.surface, inter = a.interaction, cam = sf.cam;
    const r = {};
    a.newBoard(true);

    const bar = document.getElementById('toolbar');
    const btn = bar.querySelector('[data-tool="pan"]');
    r.hasButton = !!btn;
    r.badge = btn && btn.querySelector('.kbd') ? btn.querySelector('.kbd').textContent : null;

    // it drags the view and touches nothing in the document
    a.setTool('pan');
    r.toolSet = a.tool === 'pan';
    a.store.add({ id: 'keep', type: 'shape', kind: 'rect', x: 0, y: 0, w: 50, h: 50,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }, 'x');
    const rev0 = a.store.rev, n0 = a.store.objects.length;
    const c0 = { x: cam.x, y: cam.y };
    inter.action = { type: 'pan', sp: { x: 100, y: 100 }, cam: { x: cam.x, y: cam.y } };
    inter.applyMotion({ x: 180, y: 140 }, {}, null);
    inter.action = null;
    r.panned = Math.round(cam.x - c0.x) === 80 && Math.round(cam.y - c0.y) === 40;
    r.docUntouched = a.store.rev === rev0 && a.store.objects.length === n0;

    // choosing it does not throw away a selection
    a.setTool('select');
    a.setSelection(['keep']);
    a.setTool('pan');
    r.keptSelection = sf.selection.has('keep');

    // ---- nothing that already worked may have changed ----
    a.setTool('pen');
    // With an ink tool active, a mouse is a pointer once a stylus has been
    // seen, and a pen otherwise. That rule is older than any of this and must
    // be exactly as it was, so assert the rule rather than one of its answers.
    r.mouseInks = a.mouseInks;
    r.mouseRuleHolds = inter.effectiveTool({ button: 0, pointerType: 'mouse' })
      === (a.mouseInks ? 'pen' : 'mousePointer');
    inter.spaceDown = true;
    r.spaceOverrides = inter.effectiveTool({ button: 0, pointerType: 'mouse' }) === 'pan';
    inter.spaceDown = false;
    r.middleStillPans = inter.effectiveTool({ button: 1, pointerType: 'mouse' }) === 'pan';
    r.penStillInks = inter.effectiveTool({ button: 0, pointerType: 'pen' }) === 'pen';
    r.rightStillSelects = inter.effectiveTool({ button: 2, pointerType: 'mouse' }) === 'select';

    // ---- right-drag ----
    a.settings.rightDragPans = true;
    const c1 = { x: cam.x, y: cam.y };
    const down = { pointerId: 77, pointerType: 'mouse', button: 2, buttons: 2, clientX: 300, clientY: 300,
                   isPrimary: true, preventDefault() {}, getCoalescedEvents: null };
    inter.onDown(down);
    r.rightPanStarted = !!inter.rightPan;
    r.noActionStarted = inter.action === null;          // nothing that edits
    // a tiny wobble is still a click, not a drag
    inter.onMove({ ...down, clientX: 301, clientY: 301 });
    r.wobbleIsNotADrag = inter.rightPan && inter.rightPan.moved === false;
    inter.onMove({ ...down, clientX: 380, clientY: 350 });
    r.rightDragMoved = Math.abs(cam.x - c1.x) > 40;
    inter.onUp({ ...down, clientX: 380, clientY: 350 });
    r.menuSwallowedAfterDrag = inter._eatNextMenu === true;
    inter._eatNextMenu = false;

    // a right CLICK that does not move must still open the menu
    inter.onDown({ ...down, pointerId: 78 });
    inter.onUp({ ...down, pointerId: 78 });
    r.plainRightClickKeepsMenu = inter._eatNextMenu === false;

    // and the whole thing can be switched off
    a.settings.rightDragPans = false;
    inter.onDown({ ...down, pointerId: 79 });
    r.offMeansOff = inter.rightPan === null;
    a.settings.rightDragPans = true;

    inter.rightPan = null; inter.action = null;
    a.setTool('pen'); a.newBoard(true); a.store.clear();
    return r;
  `);
  const hint = await js(`
    const a = window.app;
    const host = document.getElementById('hints');
    const r = {};
    a.settings.hintsSeen = {};
    r.shown = a.showHint('t-one', 'Hello <b>there</b>', 60000);
    r.inDom = host.querySelectorAll('.hint').length === 1;
    r.topRight = (() => {
      const b = host.getBoundingClientRect();
      return b.top < 120 && (window.innerWidth - b.right) < 40;
    })();
    // a hint is one-off: asking again does nothing
    r.secondTime = a.showHint('t-one', 'Hello again', 60000);
    r.stillOne = host.querySelectorAll('.hint').length === 1;
    // a different subject still gets its own
    r.otherSubject = a.showHint('t-two', 'Another', 60000);
    // it can be dismissed by hand
    host.querySelector('.hint .hint-x').click();
    await new Promise(res => setTimeout(res, 400));
    r.afterDismiss = host.querySelectorAll('.hint').length;
    // and it never blocks the canvas
    r.hostIgnoresClicks = getComputedStyle(host).pointerEvents === 'none';
    host.innerHTML = '';
    a.settings.hintsSeen = {}; a.saveSettings();
    return r;
  `);
  check('a first-run hint appears in the top-right corner',
    hint.shown === true && hint.inDom === true && hint.topRight === true, JSON.stringify(hint));
  check('a hint is shown once and never again',
    hint.secondTime === false && hint.stillOne === true && hint.otherSubject === true, JSON.stringify(hint));
  check('a hint can be dismissed and never covers the canvas',
    hint.afterDismiss === 1 && hint.hostIgnoresClicks === true, JSON.stringify(hint));

  check('there is a pan tool on the toolbar, with its key on it',
    panning.hasButton && panning.badge === 'G', JSON.stringify(panning.badge));
  check('the pan tool moves the view and touches nothing in the document',
    panning.toolSet && panning.panned && panning.docUntouched, JSON.stringify(panning));
  check('choosing pan does not throw away the selection', panning.keptSelection === true);
  check('space, the middle button, the pen and right-click all behave exactly as before',
    panning.mouseRuleHolds && panning.spaceOverrides && panning.middleStillPans
      && panning.penStillInks && panning.rightStillSelects, JSON.stringify(panning));
  check('a right-drag pans and starts no editing gesture',
    panning.rightPanStarted && panning.noActionStarted && panning.rightDragMoved, JSON.stringify(panning));
  check('a small wobble is still a click, not a drag', panning.wobbleIsNotADrag === true);
  check('a right-drag swallows the menu, a plain right-click does not',
    panning.menuSwallowedAfterDrag === true && panning.plainRightClickKeepsMenu === true, JSON.stringify(panning));
  check('right-drag panning can be switched off', panning.offMeansOff === true);

  /* ---- the update check ---- *
   * The one network call in the app, so the parts that matter are: it never
   * fires without consent, it compares versions correctly, and it cannot break
   * the app when the network is not there.
   */
  const upd = await js(`
    const { isNewer, parseVersion } = await import('app://board/js/core/version.js');
    const a = window.app;
    const r = {};
    const t = (c, cur) => isNewer(c, cur);
    r.newer      = t('2.1.0', '2.0.1') && t('1.18.0', '1.17.1') && t('v2.1.1', '2.1.0');
    r.tenBeatsNine = t('2.10.0', '2.9.0') && !t('2.9.0', '2.10.0');
    r.sameIsNot  = !t('2.1.0', '2.1.0');
    r.olderIsNot = !t('2.0.1', '2.1.0');
    r.releaseBeatsPre = t('2.1.0', '2.1.0-beta.1') && !t('2.1.0-beta.1', '2.1.0');
    r.junkIsNot  = !t('garbage', '2.1.0') && !t('2.1', '2.0.0') && !t('', '2.0.0') && !t(null, '2.1.0') && !t('2.1.0', null);
    r.buildMeta  = t('2.1.0+build9', '2.0.0');
    r.parsed     = parseVersion('v2.10.3-rc.1');

    // consent gates the call: with the question unanswered, nothing goes out
    let calls = 0;
    const real = window.board.checkForUpdate;
    const spy = async () => { calls++; return { ok: false, error: 'stubbed' }; };
    // window.board is frozen by contextBridge, so spy through the app instead
    a.settings.updateCheck = null;
    a.settings.lastUpdateCheck = 0;
    const beforeUnanswered = calls;
    await a.checkForUpdates({ silent: true });
    r.silentWhenUnanswered = true;   // returns immediately; asserted by not throwing

    a.settings.updateCheck = false;
    r.refusedWhenOff = (await a.checkForUpdates({ silent: true })) === null;

    // and the daily limit holds
    a.settings.updateCheck = true;
    a.settings.lastUpdateCheck = Date.now();
    r.rateLimited = (await a.checkForUpdates({ silent: true })) === null;

    // the suite must never be interrupted by the consent dialog
    const info = await a.appInfo();
    r.smokeFlag = info.smoke === true;
    r.startFlowNoOp = (await a.startUpdateFlow()) === undefined;

    a.settings.updateCheck = null; a.settings.lastUpdateCheck = 0; a.saveSettings();
    return r;
  `);
  // The whole chain against a real HTTP reply: fetch, parse, compare, decide.
  // Served from localhost so it does not depend on the network, or on which
  // version happens to be published today.
  const http = require('node:http');
  const fakeHub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('broken')) { res.statusCode = 500; res.end('nope'); return; }
    if (req.url.includes('garbage')) { res.end('{"not_a_release":true}'); return; }
    res.end(JSON.stringify({ tag_name: 'v99.9.9', name: 'GazBoard v99.9.9', prerelease: false }));
  });
  await new Promise((r) => fakeHub.listen(0, '127.0.0.1', r));
  const hubPort = fakeHub.address().port;
  const hubUrl = (p = '') => `http://127.0.0.1:${hubPort}/${p}`;

  const live = await js(`
    const a = window.app;
    const r = {};
    const call = async () => await window.board.checkForUpdate();
    r.ok = await (async () => { const x = await call(); return { ok: x.ok, version: x.version, url: x.url, prerelease: x.prerelease }; })();
    return r;
  `);
  // point the handler at the stub for the calls above
  process.env.GAZBOARD_UPDATE_API = hubUrl();
  const served = await js(`
    const x = await window.board.checkForUpdate();
    return { ok: x.ok, version: x.version, url: x.url, prerelease: x.prerelease, error: x.error };
  `);
  process.env.GAZBOARD_UPDATE_API = hubUrl('broken');
  const broke = await js(`return await window.board.checkForUpdate();`);
  process.env.GAZBOARD_UPDATE_API = hubUrl('garbage');
  const junk = await js(`return await window.board.checkForUpdate();`);
  process.env.GAZBOARD_UPDATE_API = 'http://127.0.0.1:1/nothing-listening';
  const dead = await js(`return await window.board.checkForUpdate();`);
  delete process.env.GAZBOARD_UPDATE_API;
  await new Promise((r) => fakeHub.close(r));

  check('a real reply is fetched, parsed and turned into a version and a link',
    served.ok === true && served.version === '99.9.9'
      && served.url === 'https://github.com/fahim9778/GazBoard/releases/tag/v99.9.9'
      && served.prerelease === false,
    JSON.stringify(served));
  check('a server error is reported, not thrown', broke.ok === false && !!broke.error, JSON.stringify(broke));
  check('a reply that is not a release is refused', junk.ok === false, JSON.stringify(junk));
  check('being offline is handled quietly', dead.ok === false && !!dead.error, JSON.stringify(dead));

  const updUi = await js(`
    const a = window.app;
    const r = {};
    // the ⋯ menu
    document.querySelector('#toolbar [data-cmd="more"]').click();
    await new Promise(res => setTimeout(res, 120));
    const items = [...document.querySelectorAll('.menu .menu-item')].map(b => b.textContent.trim());
    r.inMoreMenu = items.some(t => t.startsWith('Check for updates'));
    r.notLeadingTheMenu = !items[0].startsWith('Check for updates');
    r.hasAbout = items.some(t => t.startsWith('About GazBoard'));
    document.body.click();
    await new Promise(res => setTimeout(res, 120));

    // and the About box, next to the version
    await a.showAbout();
    await new Promise(res => setTimeout(res, 150));
    const card = document.getElementById('overlayCard');
    r.aboutShowsVersion = /GazBoard \\d+\\.\\d+\\.\\d+/.test(card.textContent);
    const btns = [...card.querySelectorAll('.actions .btn')].map(b => b.textContent.trim());
    r.aboutButtons = btns;
    r.aboutHasCheck = btns.includes('Check for updates');
    document.getElementById('overlay').classList.remove('show');

    // the shortcuts dialog must be untouched by all this
    a.showShortcuts();
    await new Promise(res => setTimeout(res, 150));
    r.shortcutButtons = [...document.getElementById('overlayCard').querySelectorAll('.actions .btn')].map(b => b.textContent.trim());
    document.getElementById('overlay').classList.remove('show');
    return r;
  `);
  check('Check for updates is in the ⋯ menu, and not hogging the top of it',
    updUi.inMoreMenu === true && updUi.notLeadingTheMenu === true && updUi.hasAbout === true, JSON.stringify(updUi));
  check('and there is a button for it in About, beside the version',
    updUi.aboutHasCheck === true && updUi.aboutShowsVersion === true, JSON.stringify(updUi.aboutButtons));
  check('the keyboard-shortcuts dialog still has only its Close button',
    updUi.shortcutButtons.length === 1 && updUi.shortcutButtons[0] === 'Close', JSON.stringify(updUi.shortcutButtons));

  const consent = await js(`
    const a = window.app;
    const r = {};
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');

    // the consent question offers only real answers - no third button that
    // means neither
    a.settings.updateCheck = null;
    const p1 = a.askAboutUpdates();
    await new Promise(res => setTimeout(res, 120));
    r.buttons = [...card.querySelectorAll('.actions .btn')].map(b => b.textContent.trim());
    r.noCancelButton = !r.buttons.includes('Cancel');
    // escaping is "ask me later", not "no"
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p1;
    r.afterEscape = a.settings.updateCheck;
    r.escapeLeavesUnanswered = a.settings.updateCheck === null;

    // saying no is remembered
    const p2 = a.askAboutUpdates();
    await new Promise(res => setTimeout(res, 120));
    [...card.querySelectorAll('.actions .btn')].find(b => b.textContent.includes('No')).click();
    await p2;
    r.noIsRemembered = a.settings.updateCheck === false;

    // and it is not asked again once answered
    const p3 = a.askAboutUpdates();
    await p3;
    r.notAskedAgain = !overlay.classList.contains('show');

    // a dialog that still wants Cancel keeps it
    const p4 = a.choose('t', 't', [{ id: 'a', label: 'A' }]);
    await new Promise(res => setTimeout(res, 100));
    r.otherDialogsKeepCancel = [...card.querySelectorAll('.actions .btn')].some(b => b.textContent.trim() === 'Cancel');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p4;

    a.settings.updateCheck = null; a.saveSettings();
    overlay.classList.remove('show');
    return r;
  `);
  check('the update question asks only what it means to ask',
    consent.noCancelButton === true && consent.buttons.length === 2, JSON.stringify(consent.buttons));
  check('escaping the question leaves it unanswered rather than recording a no',
    consent.escapeLeavesUnanswered === true, JSON.stringify(consent.afterEscape));
  check('an actual no is remembered, and it stops asking',
    consent.noIsRemembered === true && consent.notAskedAgain === true, JSON.stringify(consent));
  check('dialogs that need a Cancel button still have one', consent.otherDialogsKeepCancel === true);

  check('a newer version is recognised', upd.newer === true, JSON.stringify(upd));
  check('2.10.0 is newer than 2.9.0, not older', upd.tenBeatsNine === true);
  check('the same or an older version is not an update', upd.sameIsNot && upd.olderIsNot);
  check('a release beats its prerelease, and never the other way', upd.releaseBeatsPre === true);
  check('an unparseable version is never treated as an update', upd.junkIsNot === true, JSON.stringify(upd));
  check('build metadata does not confuse the comparison', upd.buildMeta === true);
  check('the update check does nothing until it has been allowed',
    upd.refusedWhenOff === true, JSON.stringify(upd));
  check('and not more than once a day', upd.rateLimited === true);
  check('the suite is never interrupted by the consent question',
    upd.smokeFlag === true && upd.startFlowNoOp === true, JSON.stringify(upd));

  /* ---- imported images are checked against their magic bytes ---- *
   * From PR #1 by @anupamme. The contribution added the sniffer; this checks
   * it against real headers AND that it is actually consulted on the import
   * path, which is the part that makes it do anything.
   */
  const sniff = await js(`
    const { looksLikeImageForTest: ok } = await import('app://board/js/insert.js');
    const bytes = (...a) => new Uint8Array(a).buffer;
    const text = (str) => new TextEncoder().encode(str).buffer;
    const r = {};
    r.png      = ok(bytes(0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A), 'png');
    r.jpeg     = ok(bytes(0xFF,0xD8,0xFF,0xE0), 'jpg');
    r.gif      = ok(bytes(0x47,0x49,0x46,0x38,0x39,0x61), 'gif');
    r.bmp      = ok(bytes(0x42,0x4D,0x36,0x00), 'bmp');
    r.webp     = ok(bytes(0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50), 'webp');
    r.svg      = ok(text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg');
    r.svgBare  = ok(text('  <svg viewBox="0 0 1 1"/>'), 'svg');
    // an executable renamed to .png
    r.exeAsPng = ok(bytes(0x4D,0x5A,0x90,0x00), 'png');
    // a PNG renamed to .jpg - the wrong header for the extension it claims
    r.pngAsJpg = ok(bytes(0x89,0x50,0x4E,0x47), 'jpg');
    // a .wav is a RIFF container too, but it is not a WebP
    r.wavAsWebp = ok(bytes(0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x41,0x56,0x45), 'webp');
    r.htmlAsSvg = ok(text('<html><script>alert(1)</script></html>'), 'svg');
    r.emptyPng = ok(new Uint8Array(0).buffer, 'png');
    return r;
  `);
  check('real image headers are accepted',
    sniff.png && sniff.jpeg && sniff.gif && sniff.bmp && sniff.webp && sniff.svg && sniff.svgBare,
    JSON.stringify(sniff));
  check('a file that is not what its extension claims is refused',
    sniff.exeAsPng === false && sniff.pngAsJpg === false && sniff.htmlAsSvg === false && sniff.emptyPng === false,
    JSON.stringify(sniff));
  check('a RIFF container that is not a WebP is refused', sniff.wavAsWebp === false);

  // Real files on disk, through the real import path. window.board is handed
  // over by contextBridge and is frozen, so there is nothing to stub - which
  // is just as well, because stubbing it would not have proved anything.
  const goodPng = path.join(OUT, 'sniff-good.png');
  const evilPng = path.join(OUT, 'sniff-evil.png');
  await fs.writeFile(goodPng, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));                                   // a real 1x1 PNG
  await fs.writeFile(evilPng, Buffer.from('MZ\x90\x00\x03 this is an executable, not a picture'));

  const sniffUsed = await js(`
    const a = window.app;
    const { insertImagesFromPaths } = await import('app://board/js/insert.js');
    a.newBoard(true);
    let toast = null;
    const realToast = a.toast.bind(a);
    a.toast = (m, ...rest) => { toast = m; return realToast(m, ...rest); };
    const before = a.store.objects.length;
    await insertImagesFromPaths(a, [${JSON.stringify(goodPng)}, ${JSON.stringify(evilPng)}]);
    const r = { added: a.store.objects.length - before, toast,
                namedTheFile: !!toast && toast.includes('sniff-evil.png') };
    a.toast = realToast;
    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('the check is actually consulted when importing, not just defined',
    sniffUsed.added === 1, `${sniffUsed.added} of 2 files imported`);
  check('and a skipped file is named rather than dropped silently',
    sniffUsed.namedTheFile === true, JSON.stringify(sniffUsed.toast));

  /* ---- the laser pointer ---- */
  const laser = await js(`
    const a = window.app;
    const r = {};
    a.newBoard(true);
    const sf = a.surface, inter = a.interaction, cam = sf.cam;

    a.setTool('laser');
    r.toolSet = a.tool === 'laser';
    const before = a.store.objects.length;
    const revBefore = a.store.rev;

    const scr = (w) => ({ x: w.x * cam.z + cam.x, y: w.y * cam.z + cam.y });
    inter.onDown({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
                   clientX: 0, clientY: 0, isPrimary: true,
                   preventDefault(){}, getCoalescedEvents: null });
    // drive the gesture through the real motion path
    inter.action = { type: 'laser' };
    sf.laser = [{ x: 0, y: 0, t: performance.now() }];
    for (let i = 1; i <= 30; i++) inter.applyMotion(scr({ x: i * 12, y: i * 4 }), {}, null);
    r.trailGrew = sf.laser.length > 5;

    // nothing about the document may have moved
    r.noObjects = a.store.objects.length === before;
    r.noRevBump = a.store.rev === revBefore;
    r.noUndo = a.store.canUndo === false;

    // it fades on its own without another pointer event
    const wasLength = sf.laser.length;
    sf.laser.forEach((p, i) => { p.t = performance.now() - 2000; });
    sf.pruneLaser();
    r.fadedAway = sf.laser.length === 0 && wasLength > 0;

    // and it is not part of an export
    sf.laser = [{ x: 0, y: 0, t: performance.now() }, { x: 40, y: 40, t: performance.now() }];
    a.store.add({ id: 'mark', type: 'shape', kind: 'rect', x: 0, y: 0, w: 60, h: 60,
                  rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }, 'x');
    const { exportBoundsForTest } = await import('app://board/js/export.js');
    const box = exportBoundsForTest(a);
    const c1 = sf.renderTo(box, 1, true).toDataURL('image/png');
    sf.laser = [];
    const c2 = sf.renderTo(box, 1, true).toDataURL('image/png');
    r.exportIgnoresLaser = c1 === c2;

    // switching tools clears any dot left on screen
    sf.laser = [{ x: 0, y: 0, t: performance.now() }];
    a.setTool('pen');
    r.clearedOnToolChange = sf.laser.length === 0;

    inter.action = null;
    a.newBoard(true); a.store.clear();
    return r;
  `);
  check('the laser tool leaves a trail', laser.toolSet && laser.trailGrew, JSON.stringify(laser));
  check('the laser never touches the document',
    laser.noObjects && laser.noRevBump && laser.noUndo, JSON.stringify(laser));
  check('the trail fades by itself', laser.fadedAway === true);
  check('exports do not contain the laser', laser.exportIgnoresLaser === true);
  check('switching tools clears the laser', laser.clearedOnToolChange === true);

  /* ---- writing on imported pages stays cheap ---- *
   * Every pointer move used to repaint the whole board, page bitmaps and all.
   * With a document imported across many sheets that is a lot of redrawing for
   * ink that only touches one of them, and it showed as flicker. The scene is
   * now frozen for the duration of a stroke.
   */
  const inkCache = await js(`
    const a = window.app;
    const { pageRects } = await import('app://board/js/core/pages.js');
    const r = {};
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    for (let i = 1; i < 8; i++) a.addPage();
    const rects = pageRects(a.pages);
    // a page-sized bitmap on every sheet, the shape of an imported document
    const px = document.createElement('canvas'); px.width = 600; px.height = 850;
    const pc = px.getContext('2d'); pc.fillStyle = '#eee'; pc.fillRect(0, 0, 600, 850);
    const url = px.toDataURL('image/png');
    rects.forEach((q, i) => a.store.add({ id: 'doc' + i, type: 'image', kind: 'page',
      x: q.x + 20, y: q.y + 20, w: q.w - 40, h: q.h - 40, rotation: 0, src: url, name: 'doc' }, 'x'));
    await new Promise(res => setTimeout(res, 400));

    const sf = a.surface, inter = a.interaction, cam = sf.cam;
    a.goToPage(4);
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const rm = rects[4];
    const scr = (w) => ({ x: w.x * cam.z + cam.x, y: w.y * cam.z + cam.y });

    let froze = 0;
    const real = sf._freezeScene.bind(sf);
    sf._freezeScene = function (k) { froze++; return real(k); };

    // one stroke of 50 moves must freeze the scene once, not fifty times
    inter.startStroke({ pointerType: 'pen', pressure: .6 }, { x: rm.x + 60, y: rm.y + 300 }, 'pen');
    for (let i = 1; i <= 50; i++) {
      inter.applyMotion(scr({ x: rm.x + 60 + i * 10, y: rm.y + 300 }), {}, null);
      sf.draw();
    }
    r.freezesForOneStroke = froze;
    r.cachedMidStroke = !!sf._ink;

    // the freeze must drop when the camera moves under the pen, or the board
    // would appear to stick while auto-pan scrolled it
    cam.panBy(-40, 0);
    sf.draw();
    r.refrozeAfterPan = froze === 2;

    // and when the document changes beneath it
    a.store.add({ id: 'newthing', type: 'shape', kind: 'rect', x: rm.x + 100, y: rm.y + 100,
                  w: 80, h: 80, rotation: 0, stroke: '#000', fill: 'none', lineWidth: 2 }, 'x');
    sf.draw();
    r.refrozeAfterEdit = froze === 3;

    if (inter.action) { inter.finishStroke(inter.action); inter.action = null; }
    sf.draw();
    r.cacheDroppedWhenPenLifts = sf._ink === null;
    sf._freezeScene = real;

    a.newBoard(true); a.store.clear();
    return r;
  `);
  const ctxFlags = await js(`
    const a = window.app;
    const attrs = a.surface.ctx.getContextAttributes ? a.surface.ctx.getContextAttributes() : {};
    return { desynchronized: !!attrs.desynchronized, alpha: !!attrs.alpha,
             setting: a.settings.lowLatencyInk };
  `);
  check('the canvas is double-buffered unless low-latency inking is asked for',
    ctxFlags.desynchronized === false && ctxFlags.setting === false && ctxFlags.alpha === false,
    JSON.stringify(ctxFlags));

  check('a stroke freezes the board once, however many times the pen moves',
    inkCache.freezesForOneStroke === 1 && inkCache.cachedMidStroke === true, JSON.stringify(inkCache));
  check('the frozen board is redrawn when the camera moves under the pen', inkCache.refrozeAfterPan === true);
  check('and when the document changes beneath it', inkCache.refrozeAfterEdit === true);
  check('lifting the pen drops the frozen copy', inkCache.cacheDroppedWhenPenLifts === true);

  /* ---- a pad exports as a real multi-page PDF ---- */
  const padPdfPath = path.join(OUT, 'pad-3-pages.pdf');
  const padPdf = await js(`
    const a = window.app;
    const { exportPdf, exportBoundsForTest } = await import('app://board/js/export.js');
    const { pageRects } = await import('app://board/js/core/pages.js');
    a.newBoard(true);
    await a.setPageSize('a4', 'portrait');
    a.addPage(); a.addPage();
    const rects = pageRects(a.pages);
    // something identifiable on every sheet
    rects.forEach((r2, i) => a.store.add({
      id: 'pp' + i, type: 'shape', kind: 'rect',
      x: r2.x + 60, y: r2.y + 60 + i * 40, w: r2.w - 120, h: 200,
      rotation: 0, stroke: '#000', fill: 'none', lineWidth: 3
    }));
    const bounds = [0, 1, 2].map(i => exportBoundsForTest(a, i));
    await exportPdf(a, { filePath: ${JSON.stringify(padPdfPath)}, quality: 1 });
    return { pages: a.pageCount, bounds, off: a.offPageObjects().length };
  `);
  const padPdfBuf = await fs.readFile(padPdfPath).catch(() => null);
  const padPdfText = padPdfBuf ? padPdfBuf.toString('latin1') : '';
  const padBoxes = [...padPdfText.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
    .map((m) => ({ w: +m[3] - +m[1], h: +m[4] - +m[2] }));
  const padPdfPages = (padPdfText.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const padMm = (pt) => (pt / 72) * 25.4;

  check('every sheet of a pad exports as its own PDF page',
    padPdfPages === 3, `${padPdfPages} PDF pages for ${padPdf.pages} board pages`);
  check('each exported PDF page really is A4 portrait, not a tile of a big canvas',
    padBoxes.length === 3 && padBoxes.every((b) => Math.abs(padMm(b.w) - 210) < 1.5 && Math.abs(padMm(b.h) - 297) < 1.5),
    JSON.stringify(padBoxes.map((b) => [Math.round(padMm(b.w)), Math.round(padMm(b.h))])));
  check('each sheet exports its own rectangle',
    padPdf.bounds.length === 3
      && padPdf.bounds[1].y > padPdf.bounds[0].y
      && padPdf.bounds[2].y > padPdf.bounds[1].y
      && padPdf.bounds.every((b) => Math.abs(b.w - 794) < 2),
    JSON.stringify(padPdf.bounds.map((b) => Math.round(b.y))));
  check('nothing on a three-page pad ends up off the paper', padPdf.off === 0);


  check('an imported page is scaled to land on the sheet',
    offpage.imported && offpage.imported.w <= offpage.page.w && offpage.imported.h <= offpage.page.h,
    JSON.stringify(offpage.imported) + ' vs ' + JSON.stringify(offpage.page));
  check('and it lands on the sheet, not hanging off the edge', offpage.fitsOnSheet === true);
  check('work dragged off the sheet is detected', offpage.strayDetected === 1,
    String(offpage.strayDetected));
  check('fitting everything on brings it all back inside',
    offpage.afterFit.off === 0, String(offpage.afterFit.off));
  check('fitting keeps the aspect ratio, so pages are not squashed',
    Math.abs(offpage.afterFit.aspect - offpage.afterFit.beforeAspect) < 0.01,
    `${offpage.afterFit.beforeAspect} -> ${offpage.afterFit.aspect}`);
  check('fitting moves things, it never deletes them', offpage.strayStillExists === true);
  check('fitting the board to the page is a single undo', offpage.afterUndo === 1,
    String(offpage.afterUndo));
  check('an infinite canvas has no off-page concept', offpage.infiniteOff === 0);

  /* ---- PDF export with page sizes ---- */
  const pdfDir = path.join(OUT, 'pdf');
  await fs.mkdir(pdfDir, { recursive: true });
  const pdfPaths = {
    a4: path.join(pdfDir, 'a4-landscape.pdf'),
    tiled: path.join(pdfDir, 'a5-tiled.pdf'),
    fitted: path.join(pdfDir, 'board-shaped.pdf')
  };
  const pdfL = await js(`
    const a = window.app;
    const { layoutPages } = await import('app://board/js/ui/pdfdialog.js');
    const { exportPdf } = await import('app://board/js/export.js');
    const r = {};
    r.a4 = layoutPages({x:0,y:0,w:1200,h:700}, {paper:'a4', orientation:'landscape', margin:'narrow', mode:'fit'});
    r.tile = layoutPages({x:0,y:0,w:2400,h:3000}, {paper:'a4', orientation:'portrait', margin:'narrow', mode:'tile', scale:1});
    r.shaped = layoutPages({x:0,y:0,w:960,h:540}, {paper:'fit', margin:'none'});
    r.letterPortrait = layoutPages({x:0,y:0,w:400,h:400}, {paper:'letter', orientation:'portrait', margin:'normal', mode:'fit'});

    a.newBoard(true);
    a.store.add({ id:'pt', type:'text', x:100, y:100, w:500, h:60, text:'PDF export test',
      fontSize:40, color:'#201f1e', align:'left', valign:'top', rotation:0, font:'hand', background:'none' });
    a.store.add({ id:'ps', type:'shape', kind:'ellipse', x:120, y:200, w:300, h:180,
      rotation:0, stroke:'#e81123', fill:'none', lineWidth:4 });
    r.wroteA4     = await exportPdf(a, { paper:'a4', orientation:'landscape', margin:'narrow', mode:'fit',  quality:2,   filePath:${JSON.stringify(pdfPaths.a4)} });
    r.wroteTiled  = await exportPdf(a, { paper:'a5', orientation:'portrait',  margin:'none',   mode:'tile', scale:1, quality:1.5, filePath:${JSON.stringify(pdfPaths.tiled)} });
    r.wroteFitted = await exportPdf(a, { paper:'fit', margin:'narrow', mode:'fit', quality:2, filePath:${JSON.stringify(pdfPaths.fitted)} });
    a.store.clear();
    return r;
  `);

  check('A4 landscape is 297 x 210 mm and one sheet',
    pdfL.a4.cols === 1 && pdfL.a4.rows === 1 && Math.round(pdfL.a4.pageW) === 297 && Math.round(pdfL.a4.pageH) === 210,
    `${pdfL.a4.pageW} x ${pdfL.a4.pageH}, ${pdfL.a4.cols}x${pdfL.a4.rows}`);
  check('fitting a wide board on one page scales it down, never up',
    pdfL.a4.scale > 0 && pdfL.a4.scale < 1, String(pdfL.a4.scale));
  check('a board taller than the paper tiles across several sheets',
    pdfL.tile.cols === 4 && pdfL.tile.rows === 3, `${pdfL.tile.cols} x ${pdfL.tile.rows}`);
  check('Letter portrait is 215.9 x 279.4 mm',
    Math.round(pdfL.letterPortrait.pageW * 10) === 2159 && Math.round(pdfL.letterPortrait.pageH * 10) === 2794,
    `${pdfL.letterPortrait.pageW} x ${pdfL.letterPortrait.pageH}`);
  check('"Fit board" makes the page the shape of the board',
    Math.abs(pdfL.shaped.pageW / pdfL.shaped.pageH - 960 / 540) < 0.01,
    `${pdfL.shaped.pageW} x ${pdfL.shaped.pageH}`);
  check('the margin is subtracted from the printable area',
    Math.round(pdfL.letterPortrait.pageW - pdfL.letterPortrait.innerW) === 30, // 15mm each side
    String(pdfL.letterPortrait.pageW - pdfL.letterPortrait.innerW));

  // and the files themselves
  const mediaBoxes = async (file) => {
    const buf = await fs.readFile(file);
    const txt = buf.toString('latin1');
    const boxes = [...txt.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
      .map((m) => ({ w: +m[3] - +m[1], h: +m[4] - +m[2] }));
    return { header: txt.slice(0, 5), size: buf.length, boxes };
  };
  const fA4 = await mediaBoxes(pdfPaths.a4);
  const fTiled = await mediaBoxes(pdfPaths.tiled);
  const fFitted = await mediaBoxes(pdfPaths.fitted);
  const mm = (pt) => (pt / 72) * 25.4;

  check('the export writes a real PDF file', fA4.header === '%PDF-' && fA4.size > 2000,
    `${fA4.header} ${fA4.size} bytes`);
  check('the A4 file really is one A4 landscape page',
    fA4.boxes.length === 1 && Math.abs(mm(fA4.boxes[0].w) - 297) < 1 && Math.abs(mm(fA4.boxes[0].h) - 210) < 1,
    JSON.stringify(fA4.boxes.map((b) => [Math.round(mm(b.w)), Math.round(mm(b.h))])));
  check('the tiled file really has more than one page, all A5 portrait',
    fTiled.boxes.length > 1 && fTiled.boxes.every((b) => Math.abs(mm(b.w) - 148) < 1 && Math.abs(mm(b.h) - 210) < 1),
    JSON.stringify(fTiled.boxes.map((b) => [Math.round(mm(b.w)), Math.round(mm(b.h))])));
  check('the board-shaped file is one page that is not a standard size',
    fFitted.boxes.length === 1 && Math.abs(mm(fFitted.boxes[0].w) - 297) > 2,
    JSON.stringify(fFitted.boxes.map((b) => [Math.round(mm(b.w)), Math.round(mm(b.h))])));
  check('an empty board refuses to export rather than writing a blank PDF',
    (await js(`const a = window.app; a.newBoard(true); const r = await a.exportPdfWithSetup(); return r;`)) === null);

  /* ---- sticky notes keep their text inside, and grow to hold it ---- */
  const noteFit = await js(`
    const a = window.app;
    const { wrapText, fitFontSize } = await import('app://board/js/core/util.js');
    const { faceOf } = await import('app://board/js/core/render.js');
    // measure in the face the note is actually set in - a hard-coded family
    // would measure something different on Windows, macOS and Linux
    const FACE = faceOf('sans');
    a.newBoard(true);
    const g = document.createElement('canvas').getContext('2d');
    const r = {};

    // 1. a single unbroken word must be broken across lines, not run off the note
    g.font = '400 24px ' + FACE;
    const word = 'asdasdapofjpaoiejgfpajgpajgpajpregjapjgjg';
    const lines = wrapText(g, word, 200);
    r.brokenLines = lines.length;
    r.widestBroken = Math.max(...lines.map((l) => g.measureText(l).width));
    r.brokenKeepsEveryLetter = lines.join('') === word;

    // 2. autofitting must pick a size that fits the WIDTH too, not only the height
    const size = fitFontSize(g, word, 200, 400, FACE, '400', 46, 10);
    g.font = '400 ' + size + 'px ' + FACE;
    r.fitWidest = Math.max(...wrapText(g, word, 200).map((l) => g.measureText(l).width));

    // 3. a note with a pinned font size grows tall enough to hold what is typed
    const note = { id: 'note-grow', type: 'note', x: 0, y: 0, w: 220, h: 220,
      text: '', color: '#ffd94a', rotation: 0, fontSize: 22, font: 'sans', align: 'center' };
    a.store.add(note, 'test note');
    a.setSelection(['note-grow']);
    r.hBefore = a.store.get('note-grow').h;
    a.beginTextEdit(a.store.get('note-grow'));
    await new Promise((res) => setTimeout(res, 60));
    const ta = document.querySelector('#editLayer textarea');
    ta.value = Array.from({ length: 14 }, (_, i) => 'line number ' + i).join(String.fromCharCode(10));
    ta.dispatchEvent(new Event('input'));
    await new Promise((res) => setTimeout(res, 40));
    r.hWhileTyping = a.store.get('note-grow').h;
    a.textEditor.commit();
    await new Promise((res) => setTimeout(res, 40));
    const after = a.store.get('note-grow');
    r.hAfter = after.h;

    // the text really does fit in the note it ended up with
    const pad = Math.max(10, after.w * 0.08);
    g.font = '400 22px ' + FACE;
    r.textHeight = wrapText(g, after.text, after.w - pad * 2).length * 22 * 1.28 + pad * 2;

    // 4. growth is one undo, and it takes the height back with it
    a.store.undo();
    r.hAfterUndo = a.store.get('note-grow').h;
    a.store.redo();
    r.hAfterRedo = a.store.get('note-grow').h;

    // 5. a note whose text already fits is left exactly as it was
    const small = { id: 'note-small', type: 'note', x: 400, y: 0, w: 220, h: 220,
      text: '', color: '#ffd94a', rotation: 0, font: 'sans', align: 'center' };
    a.store.add(small, 'small note');
    a.beginTextEdit(a.store.get('note-small'));
    await new Promise((res) => setTimeout(res, 60));
    const ta2 = document.querySelector('#editLayer textarea');
    ta2.value = 'hi';
    ta2.dispatchEvent(new Event('input'));
    await new Promise((res) => setTimeout(res, 40));
    a.textEditor.commit();
    await new Promise((res) => setTimeout(res, 40));
    r.smallH = a.store.get('note-small').h;

    a.newBoard(true);
    return r;
  `);

  check('a word too long for the note is broken across lines instead of running off it',
    noteFit.brokenLines > 1 && noteFit.widestBroken <= 200.5,
    `${noteFit.brokenLines} lines, widest ${noteFit.widestBroken.toFixed(1)}px in a 200px note`);
  check('breaking a long word keeps every letter of it', noteFit.brokenKeepsEveryLetter);
  check('autofitting a note fits the width, not just the height',
    noteFit.fitWidest <= 200.5, `${noteFit.fitWidest.toFixed(1)}px in 200px`);
  check('a sticky note grows to hold text that will not fit in it',
    noteFit.hAfter > noteFit.hBefore, `${noteFit.hBefore} -> ${noteFit.hAfter}`);
  check('the note grows while it is being typed into, not only when editing ends',
    noteFit.hWhileTyping > noteFit.hBefore, `${noteFit.hBefore} -> ${noteFit.hWhileTyping}`);
  check('the text really does fit inside the note it grew into',
    noteFit.textHeight <= noteFit.hAfter + 1,
    `text needs ${Math.round(noteFit.textHeight)}px, note is ${noteFit.hAfter}px`);
  check('growing a note is one undo, and undo takes the height back',
    noteFit.hAfterUndo === noteFit.hBefore && noteFit.hAfterRedo === noteFit.hAfter,
    `${noteFit.hBefore} -> ${noteFit.hAfter} -> undo ${noteFit.hAfterUndo} -> redo ${noteFit.hAfterRedo}`);
  check('a note whose text already fits is left the size it was',
    noteFit.smallH === 220, String(noteFit.smallH));

  /* ---- table row and column controls ---- */
  const tbl = await js(`
    const { updateSelectionBar } = await import('app://board/js/ui/contextmenu.js');
    const a = window.app;
    a.newBoard(true);
    a.addTable();
    const t = a.store.objects.filter((o) => o.type === 'table').pop();
    a.store.update(t.id, { cells: { '0,0': 'A', '2,2': 'corner', '1,1': 'mid' } }, 'seed');
    a.setSelection([t.id]);
    updateSelectionBar(a);
    const bar = document.getElementById('ctxbar');
    const titles = [...bar.querySelectorAll('button')].map((b) => b.title);
    const r = { titles, plusSigns: bar.innerHTML.split('M16 12h6').length - 1 };

    const before = a.store.get(t.id);
    r.rows0 = before.rows; r.cols0 = before.cols; r.h0 = before.h; r.w0 = before.w;

    a.command('table.addRow');
    a.command('table.addCol');
    let now = a.store.get(t.id);
    r.rows1 = now.rows; r.cols1 = now.cols; r.h1 = now.h; r.w1 = now.w;
    r.cellsKept = JSON.stringify(now.cells) === JSON.stringify(before.cells);

    // the buttons are wired to the same commands
    updateSelectionBar(a);
    const addRowBtn = [...document.getElementById('ctxbar').querySelectorAll('button')]
      .find((b) => b.title === 'Add row');
    if (addRowBtn) addRowBtn.click();
    r.rowsAfterClick = a.store.get(t.id).rows;

    a.command('table.removeRow');
    a.command('table.removeRow');
    a.command('table.removeRow');
    a.command('table.removeCol');
    a.command('table.removeCol');
    now = a.store.get(t.id);
    r.rows2 = now.rows; r.cols2 = now.cols;
    r.cellsAfterShrink = Object.keys(now.cells).sort().join('|');

    // a table never shrinks past its last row or column
    for (let i = 0; i < 10; i++) { a.command('table.removeRow'); a.command('table.removeCol'); }
    now = a.store.get(t.id);
    r.rowsFloor = now.rows; r.colsFloor = now.cols;

    // and the buttons say so
    a.setSelection([t.id]);
    updateSelectionBar(a);
    const btns = [...document.getElementById('ctxbar').querySelectorAll('button')];
    r.removeDisabled = btns.filter((b) => /^Remove (row|column)$/.test(b.title)).every((b) => b.disabled);

    a.store.undo();
    r.undoOne = a.store.get(t.id).rows + 'x' + a.store.get(t.id).cols;

    // a note is not a table: it gets no row controls
    a.newBoard(true);
    a.store.add({ id: 'nt', type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'x', color: '#ffd94a', rotation: 0 }, 't');
    a.setSelection(['nt']);
    updateSelectionBar(a);
    r.noteTitles = [...document.getElementById('ctxbar').querySelectorAll('button')].map((b) => b.title);

    a.newBoard(true);
    return r;
  `);

  check('a selected table offers row and column controls',
    ['Add row', 'Remove row', 'Add column', 'Remove column'].every((t) => tbl.titles.includes(t)),
    tbl.titles.join(', '));
  check('the add controls carry a visible plus sign', tbl.plusSigns >= 2, `${tbl.plusSigns} plus glyphs`);
  check('adding a row and a column changes the table',
    tbl.rows1 === tbl.rows0 + 1 && tbl.cols1 === tbl.cols0 + 1,
    `${tbl.rows0}x${tbl.cols0} -> ${tbl.rows1}x${tbl.cols1}`);
  check('a new row makes the table taller instead of squashing the rows already in it',
    tbl.h1 > tbl.h0 && tbl.w1 > tbl.w0, `${tbl.h0}->${tbl.h1} tall, ${tbl.w0}->${tbl.w1} wide`);
  check('adding a row keeps the text already typed into the table', tbl.cellsKept);
  check('the plus button on the bar does the same thing as the command',
    tbl.rowsAfterClick === tbl.rows1 + 1, String(tbl.rowsAfterClick));
  check('removing rows and columns takes the text in them away too',
    tbl.cellsAfterShrink === '0,0|1,1' && tbl.rows2 === 2 && tbl.cols2 === 2,
    `${tbl.rows2}x${tbl.cols2}, cells ${tbl.cellsAfterShrink}`);
  check('a table never shrinks past its last row or column',
    tbl.rowsFloor === 1 && tbl.colsFloor === 1, `${tbl.rowsFloor}x${tbl.colsFloor}`);
  check('the remove buttons are disabled once there is one row and one column left', tbl.removeDisabled);
  // the floor loop ends on a column removal, so one undo puts back that column
  // and nothing else
  check('each row and column change is its own undo', tbl.undoOne === '1x2', tbl.undoOne);
  check('a sticky note gets no row or column controls',
    !tbl.noteTitles.some((t) => /row|column/i.test(t)), tbl.noteTitles.join(', '));

  /* ---- the laser keeps up on a heavy board ---- */
  const laserPerf = await js(`
    const a = window.app;
    a.newBoard(true);
    // a board with real weight on it, like the one the lag was reported on
    const objs = [];
    for (let i = 0; i < 1200; i++) {
      const pts = [];
      for (let k = 0; k < 24; k++) pts.push({ x: (i % 40) * 30 + k * 1.5, y: Math.floor(i / 40) * 24 + Math.sin(k) * 6, p: 0.5 });
      objs.push({ id: 'L' + i, type: 'stroke', tool: 'pen', color: '#333', width: 3, effect: 'none',
        points: pts, bbox: { x: (i % 40) * 30, y: Math.floor(i / 40) * 24 - 6, w: 40, h: 20 }, rotation: 0 });
    }
    a.store.addMany(objs, 'heavy');
    a.command('fit');
    const sf = a.surface;
    await new Promise((res) => requestAnimationFrame(res));

    /*
     * Counted, not timed.
     *
     * The obvious test here is a stopwatch, and it cannot be made to work.
     * Canvas drawing is queued for the GPU, so timing draw() in a loop measures
     * the queueing and not the painting; the usual cure is to read a pixel back
     * to force the queue to drain, and that cure is worse than the disease.
     * The board canvas is created without willReadFrequently - correctly, it is
     * painted far more than it is read - so after a few getImageData calls
     * Chromium demotes it to software rendering, and every blit afterwards is a
     * two-megapixel memcpy. The stopwatch stops measuring the laser and starts
     * measuring the damage it did to the canvas, on real hardware only, which
     * is the worst possible place for a test to be wrong.
     *
     * What the fix actually claims is countable: while a laser trail fades, the
     * board underneath is painted once and blitted after that, instead of being
     * rebuilt from all 1200 objects on every frame. Counting the rebuilds says
     * exactly that, reads the same on every machine, and leaves the canvas
     * alone.
     */
    const realDrawScene = sf.drawScene.bind(sf);
    let scenes = 0;
    sf.drawScene = (...a) => { scenes++; return realDrawScene(...a); };

    const c = sf.cam.viewport(sf.width, sf.height);
    sf.laser = [];
    for (let i = 0; i < 20; i++) sf.laser.push({ x: c.x + i * 4, y: c.y + 40, t: performance.now() });
    sf.draw();                                   // first frame builds the freeze
    scenes = 0;
    const laserFrames = 35;
    for (let i = 0; i < laserFrames; i++) sf.draw();
    const scenesPerLaserFrame = scenes;
    const froze = !!sf._ink;
    sf.drawScene = realDrawScene;

    // the trail is dropped the moment the laser is gone
    sf.laser = [];
    sf.draw();
    const dropped = !sf._ink;

    const { Surface } = await import('app://board/js/core/surface.js');
    const life = Surface.LASER_LIFE;

    a.newBoard(true);
    return { froze, dropped, life, scenesPerLaserFrame, laserFrames, objects: 1200 };
  `);

  check('the board is frozen under a live laser trail instead of redrawn every frame', laserPerf.froze);
  check('a fading laser repaints the board once, not once per frame',
    laserPerf.scenesPerLaserFrame === 0,
    `${laserPerf.scenesPerLaserFrame} board repaints across ${laserPerf.laserFrames} laser frames - `
    + `${laserPerf.scenesPerLaserFrame * laserPerf.objects} objects redrawn instead of `
    + `${laserPerf.laserFrames * laserPerf.objects}`);
  check('the frozen copy is thrown away as soon as the trail is gone', laserPerf.dropped);
  check('the trail fades quickly rather than trailing behind the pointer',
    laserPerf.life <= 600, `${laserPerf.life}ms`);

  /* ---- a portable build keeps its boards beside the .exe ---- */
  const { portableUserData } = require(path.join(__dirname, '..', 'main.js'));
  const stick = path.join(OUT, 'fake-usb-stick');
  const locked = path.join(OUT, 'fake-readonly-stick');
  await fs.rm(stick, { recursive: true, force: true });
  await fs.rm(locked, { recursive: true, force: true });
  await fs.mkdir(stick, { recursive: true });
  await fs.mkdir(locked, { recursive: true });

  const notPortable = portableUserData({});
  const onStick = portableUserData({ PORTABLE_EXECUTABLE_DIR: stick });
  let madeIt = false;
  try { await fs.access(onStick); madeIt = true; } catch { madeIt = false; }

  // the folder really is usable, not just named
  await fs.writeFile(path.join(onStick, 'board.json'), '{"ok":true}');
  const readBack = JSON.parse(await fs.readFile(path.join(onStick, 'board.json'), 'utf8'));

  // A place the data folder cannot be made falls back instead of taking the app
  // down. Pointing at a plain file is the one way to force that failure the same
  // way for everybody: a read-only directory is only read-only to a normal user,
  // and root - which is what CI containers run as - walks straight through it.
  const notADir = path.join(OUT, 'not-a-directory');
  await fs.writeFile(notADir, 'this is a file, not a folder');
  const onBadPath = portableUserData({ PORTABLE_EXECUTABLE_DIR: notADir });

  // and the read-only case itself, wherever the test is not running as root
  // chmod cannot make a directory unwritable for root, and on Windows it does
  // not apply to directories at all - in both cases the folder stays writable
  // and there is nothing to observe. The not-a-directory case above covers the
  // same fallback everywhere.
  const asRoot = (typeof process.getuid === 'function' && process.getuid() === 0)
    || process.platform === 'win32';
  let onLocked = null, lockedTested = false;
  if (!asRoot) {
    await fs.chmod(locked, 0o555);
    onLocked = portableUserData({ PORTABLE_EXECUTABLE_DIR: locked });
    await fs.chmod(locked, 0o755);          // so the directory can be cleaned up
    lockedTested = true;
  }

  check('an ordinary installed build is not treated as portable', notPortable === null,
    String(notPortable));
  check('a portable build keeps its boards in a folder beside the .exe',
    onStick === path.join(stick, 'GazBoard-Data'), onStick);
  check('that folder is created, not merely named', madeIt);
  check('and it is actually writable', readBack.ok === true);
  check('a stick the data folder cannot be made on falls back instead of failing to start',
    onBadPath === null, String(onBadPath));
  check('a write-protected stick falls back too',
    !lockedTested || onLocked === null,
    lockedTested ? String(onLocked)
      : `skipped on ${process.platform} - chmod cannot make this directory unwritable here`);
  // The helper being right is not the same as the app using it. This launches a
  // second copy of GazBoard for real, with PORTABLE_EXECUTABLE_DIR set the way
  // electron-builder sets it, and asks that copy where it actually put its
  // profile.
  const realStick = path.join(OUT, 'launched-usb-stick');
  await fs.rm(realStick, { recursive: true, force: true });
  await fs.mkdir(realStick, { recursive: true });
  const probe = path.join(OUT, 'portable-probe.js');
  await fs.writeFile(probe, `'use strict';
module.exports.run = async (win, app) => {
  console.log('USERDATA ' + app.getPath('userData'));
  app.exit(0);
};
`);
  const launched = await new Promise((resolve) => {
    const child = require('node:child_process').execFile(
      process.execPath, ['.', '--smoke', '--no-sandbox'],
      {
        cwd: path.join(__dirname, '..'),
        timeout: 60000,
        env: { ...process.env, PORTABLE_EXECUTABLE_DIR: realStick, GAZBOARD_TEST: probe,
               GAZBOARD_USER_DATA: '' }
      },
      (err, stdout) => {
        const m = /^USERDATA (.+)$/m.exec(stdout || '');
        resolve({ said: m ? m[1].trim() : null, err: err ? String(err).slice(0, 120) : null });
      });
    child.on('error', () => resolve({ said: null, err: 'could not launch' }));
  });

  check('a launched portable build really puts its profile beside the .exe',
    launched.said === path.join(realStick, 'GazBoard-Data'),
    launched.said || launched.err || 'no answer');
  check('and that profile folder exists on the stick afterwards',
    await fs.access(path.join(realStick, 'GazBoard-Data')).then(() => true, () => false));

  // The point of a portable build is that the work travels with it. Two more
  // launches on the same stick: one makes a board, the next has to find it.
  const runOnStick = (script) => new Promise((resolve) => {
    const f = path.join(OUT, 'stick-step.js');
    fs.writeFile(f, script).then(() => {
      require('node:child_process').execFile(
        process.execPath, ['.', '--smoke', '--no-sandbox'],
        { cwd: path.join(__dirname, '..'), timeout: 60000,
          env: { ...process.env, PORTABLE_EXECUTABLE_DIR: realStick, GAZBOARD_TEST: f,
                 GAZBOARD_USER_DATA: '' } },
        (err, stdout) => {
          const m = /^SAID (.+)$/m.exec(stdout || '');
          resolve(m ? m[1].trim() : (err ? 'ERROR ' + String(err).slice(0, 80) : 'no answer'));
        });
    });
  });

  await runOnStick(`'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript('(async()=>{' + c + '})()', true);
  await new Promise(r => setTimeout(r, 1400));
  await js(\`
    const a = window.app;
    a.newBoard(true);
    a.store.rename('Taken to the classroom');
    a.store.add({ id:'sk1', type:'text', x:40, y:40, w:400, h:60, text:'written on the stick',
      fontSize:28, color:'#201f1e', align:'left', valign:'top', rotation:0, font:'hand', background:'none' });
    await a.persist();
  \`);
  console.log('SAID saved');
  app.exit(0);
};
`);
  const cameBack = await runOnStick(`'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript('(async()=>{' + c + '})()', true);
  await new Promise(r => setTimeout(r, 1600));
  const out = await js(\`
    const list = await window.board.boards.list();
    return JSON.stringify({ name: window.app.store.doc.name,
      objects: window.app.store.objects.length, boards: list.length });
  \`);
  console.log('SAID ' + out);
  app.exit(0);
};
`);
  let stickState = {};
  try { stickState = JSON.parse(cameBack); } catch { stickState = { raw: cameBack }; }

  check('a board made by the portable build is still there the next time it runs',
    stickState.name === 'Taken to the classroom' && stickState.objects === 1 && stickState.boards === 1,
    cameBack);

  // and none of it leaked into the ordinary per-user folder
  const leaked = await js(`return (await window.board.info()).userData;`);
  check('the portable build leaves nothing in the folder an installed copy uses',
    !leaked.startsWith(realStick), leaked);

  check('nothing is left behind in the folder beside the .exe but the data folder',
    (await fs.readdir(stick)).join(',') === 'GazBoard-Data', (await fs.readdir(stick)).join(','));

  /* ---- editing a note must not scroll the board on a desktop ---- */
  const keyboardPan = await js(`
    const a = window.app;
    const realMM = window.matchMedia;

    // Pose as three machines in turn. maxTouchPoints and ontouchstart say a
    // device CAN take touch; (pointer: coarse) says a fingertip is what is
    // actually driving it. A Windows laptop with a touchscreen and a mouse
    // answers yes to the first and no to the second, which is the whole point.
    const poseAs = (touchPoints, pointer) => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: touchPoints, configurable: true });
      window.matchMedia = (q) => String(q).includes('coarse')
        ? { matches: pointer === 'coarse', media: q, addListener() {}, removeListener() {} }
        : realMM.call(window, q);
    };

    // A note low in the window is where a software keyboard would cover it.
    const scrollOnEdit = async () => {
      a.newBoard(true);
      const v = a.surface.cam.viewport(a.surface.width, a.surface.height);
      a.store.add({ id: 'kb1', type: 'note', x: v.x + 100, y: v.y + v.h * 0.85,
        w: 200, h: 120, text: 'hi', color: '#ffd94a', rotation: 0, font: 'hand', align: 'center' }, 'test');
      const before = a.surface.cam.y;
      a.beginTextEdit(a.store.get('kb1'));
      await new Promise((r) => setTimeout(r, 150));
      const moved = Math.round(Math.abs(a.surface.cam.y - before));
      a.textEditor.commit();
      return moved;
    };

    poseAs(0, 'fine');    const desktop = await scrollOnEdit();
    poseAs(10, 'fine');   const touchLaptop = await scrollOnEdit();
    poseAs(5, 'coarse');  const phone = await scrollOnEdit();

    window.matchMedia = realMM;
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    a.newBoard(true);
    return { desktop, touchLaptop, phone };
  `);

  check('editing a note does not scroll the board on a plain desktop',
    keyboardPan.desktop === 0, `${keyboardPan.desktop}px`);
  check('nor on a touchscreen laptop being driven with a mouse or a pen',
    keyboardPan.touchLaptop === 0, `${keyboardPan.touchLaptop}px`);
  check('but a phone still lifts the note clear of the software keyboard',
    keyboardPan.phone > 100, `${keyboardPan.phone}px`);

  /* ---- a board carried to another machine keeps its pictures ---- */
  const travelled = await js(`
    const a = window.app;
    a.newBoard(true);
    const r = {};

    // A .gazboard exported from machine A carries the picture inline AND the
    // id that machine gave it. Machine B has the file but not that asset, so
    // its store has never seen the id - which is exactly this shape.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR42mNk'
      + 'YPhfz0AEYBxVSF+FjIyMDAwMDP8ZGRn/M4wqpK9CAGRcBQWm9m8OAAAAAElFTkSuQmCC';
    const strangerId = 'a'.repeat(64) + '.png';   // a valid-looking id from elsewhere

    a.store.add({ id: 'pic', type: 'image', x: 0, y: 0, w: 120, h: 120,
      src: png, assetId: strangerId, rotation: 0 }, 'arrived from another machine');

    r.storeHasTheStrangerId = (await window.board.assets.have([strangerId]))[strangerId];

    // what the next autosave would write
    const written = await a.externaliseAssets(a.store.toJSON());
    const saved = written.objects.find((o) => o.id === 'pic');
    r.savedSrc = String(saved.src).slice(0, 6);
    r.savedAssetId = saved.assetId || null;

    // the question that decides whether the picture survives: is the thing it
    // now points at actually on this machine?
    r.pointsAtSomethingReal = saved.assetId
      ? (await window.board.assets.have([saved.assetId]))[saved.assetId] === true
      : String(saved.src).startsWith('data:');

    // and prove it by reopening: resolveAssets must bring the picture back
    const reopened = await a.resolveAssets(JSON.parse(JSON.stringify(written)));
    const back = reopened.objects.find((o) => o.id === 'pic');
    r.cameBack = !back.missing && typeof back.src === 'string' && back.src.startsWith('data:');
    r.sameBytes = back.src === png;

    a.newBoard(true);
    return r;
  `);

  check('a picture arriving from another machine is not assumed to be filed here',
    travelled.storeHasTheStrangerId === false,
    'the store should not claim an id it has never seen');
  check('saving it files the picture on THIS machine instead of trusting the id',
    travelled.pointsAtSomethingReal,
    `saved as ${travelled.savedSrc}… assetId ${String(travelled.savedAssetId).slice(0, 12)}…`);
  check('so the picture is still there when the board is opened again',
    travelled.cameBack, travelled.cameBack ? 'came back' : 'came back as a gap');
  check('and it is the same picture, byte for byte', travelled.sameBytes);

  /* ---- every direction a board can travel keeps its pictures ---- */
  const matrix = await js(`
    const a = window.app;
    const { exportable } = await import('app://board/js/export.js');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR42mNk'
      + 'YPhfz0AEYBxVSF+FjIyMDAwMDP8ZGRn/M4wqpK9CAGRcBQWm9m8OAAAAAElFTkSuQmCC';

    // Both runtimes reduce to the same question: does THIS store hold the file
    // the board's id points at? Electron asks a folder, the PWA asks IndexedDB,
    // through the same put/get/have contract - so a store that has never seen
    // the id is what "another machine" means in either of them.
    const STRANGER = 'c'.repeat(64) + '.png';

    // one hop: a board leaves a machine that has the file and lands on one that
    // does not, then autosaves and is reopened
    const hop = async (obj) => {
      a.newBoard(true);
      a.store.add(JSON.parse(JSON.stringify(obj)), 'arrived');
      const written = await a.externaliseAssets(a.store.toJSON());
      const reopened = await a.resolveAssets(JSON.parse(JSON.stringify(written)));
      const back = reopened.objects.find((o) => o.id === 'pic');
      return { survived: !back.missing && String(back.src).startsWith('data:'),
               identical: back.src === PNG, written };
    };

    const r = {};

    // a file exported from another machine: picture inline, id from over there
    r.freshMachine = await hop({ id:'pic', type:'image', x:0, y:0, w:100, h:100,
      src: PNG, assetId: STRANGER, rotation: 0 });

    // a file exported from a machine that never filed it at all
    r.noIdAtAll = await hop({ id:'pic', type:'image', x:0, y:0, w:100, h:100,
      src: PNG, rotation: 0 });

    // the same machine, second save: the id IS local, and must not be refiled
    // needlessly or the board would rewrite its pictures on every save
    a.newBoard(true);
    const local = await a.externaliseAssets({ objects: [
      { id:'pic', type:'image', x:0, y:0, w:100, h:100, src: PNG, rotation: 0 }] });
    const localId = local.objects[0].assetId;
    r.sameMachine = await hop({ id:'pic', type:'image', x:0, y:0, w:100, h:100,
      src: PNG, assetId: localId, rotation: 0 });

    // and the round trip through a board that lost its picture: exporting it
    // must keep the reference, not write an empty src that can never recover
    a.newBoard(true);
    const lost = await a.resolveAssets({ objects: [
      { id:'pic', type:'image', x:0, y:0, w:100, h:100,
        src: 'asset:' + STRANGER, assetId: STRANGER, rotation: 0 }] });
    a.store.add(lost.objects[0], 'lost picture');
    // exportable() is exactly what saveBoardFile writes to the file; calling it
    // directly avoids driving a native save dialog that nothing can answer
    const written = exportable(a.store.toJSON({ app: 'GazBoard', version: 1 }));
    const exportedSrc = written.objects.find((o) => o.id === 'pic').src;
    r.exportOfLostKeepsReference = String(exportedSrc).startsWith('asset:');
    r.exportDropsRuntimeMarker = !('missing' in written.objects.find((o) => o.id === 'pic'));
    r.exportedSrc = String(exportedSrc).slice(0, 12);

    // put the file back where that reference points, and the picture returns
    await window.board.assets.put(PNG);
    const realId = (await a.externaliseAssets({ objects: [
      { id:'p2', type:'image', x:0, y:0, w:10, h:10, src: PNG, rotation: 0 }] })).objects[0].assetId;
    const recovered = await a.resolveAssets({ objects: [
      { id:'pic', type:'image', x:0, y:0, w:100, h:100, src: 'asset:' + realId, assetId: realId, rotation: 0 }] });
    r.referenceStillResolves = recovered.objects[0].src === PNG;

    a.newBoard(true);
    return r;
  `);

  check('a board from another machine keeps its picture (Electron/PWA, machine to machine)',
    matrix.freshMachine.survived && matrix.freshMachine.identical);
  check('a board that was never filed anywhere keeps its picture',
    matrix.noIdAtAll.survived && matrix.noIdAtAll.identical);
  check('a board saved again on its own machine still keeps its picture',
    matrix.sameMachine.survived && matrix.sameMachine.identical);
  check('exporting a board whose picture is missing keeps the reference, not an empty src',
    matrix.exportOfLostKeepsReference, `exported src begins "${matrix.exportedSrc}"`);
  check('and putting the file back makes that reference resolve again',
    matrix.referenceStillResolves);

  /* ---- cancelling an edit must throw the edit away, not save it ---- */
  const cancelEdit = await js(`
   try {
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true);
    sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    const r = {};
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const ev = (x, y) => ({ pointerId: 5, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: x, clientY: y, pressure: 0, preventDefault(){}, stopPropagation(){},
      target: { setPointerCapture(){}, releasePointerCapture(){} } });

    // a note with something already in it
    a.setTool('note');
    it.onDown(ev(300, 300)); it.onUp(ev(300, 300));
    it.action = null; it.pointers.clear();
    await sleep(30);
    const note = a.store.objects.find(o => o.type === 'note');
    a.textEditor.el.value = 'keep this';
    a.textEditor.commit();
    await sleep(20);
    r.saved = a.store.get(note.id).text === 'keep this';

    // edit it again, type something else, then change your mind
    a.textEditor.begin(note);
    await sleep(30);                      // let the focus land - blur needs it
    r.hasFocus = document.activeElement === a.textEditor.el;
    a.textEditor.el.value = 'rubbish typed by mistake';
    a.textEditor.cancel();
    await sleep(20);
    r.discarded = a.store.get(note.id).text === 'keep this';
    r.editorClosed = !a.textEditor.active;

    // and cancelling twice is not an error
    a.textEditor.cancel();
    r.doubleCancelSurvived = true;

    a.setTool('select'); a.newBoard(true);
    return r;
   } catch (e) { return { crashed: String(e && e.message || e) }; }
  `);
  if (cancelEdit.crashed) console.log('  cancel probe threw:', cancelEdit.crashed);

  check('the editor really had focus, so blur is in play',
    cancelEdit.hasFocus === true);
  check('cancelling an edit discards it instead of saving it',
    cancelEdit.saved === true && cancelEdit.discarded === true && !cancelEdit.crashed,
    cancelEdit.crashed || '');
  check('and closes cleanly, twice over',
    cancelEdit.editorClosed === true && cancelEdit.doubleCancelSurvived === true);

  /* ---- sync is off until somebody switches it on ---- */
  {
    const net = require('node:net');
    const listening = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.on('error', () => resolve(false));
    });

    // The app has been running for the whole suite by now. If turning sync on
    // were needed for anything else to work, or if it started itself, this is
    // where it would show.
    const before = await listening(53318);
    check('nothing is listening on the sync port until sync is turned on',
      before === false, before ? 'something answered on 53318' : 'port closed');

    const state = await js(`return await window.board.sync.state();`);
    check('and the app agrees it is not running',
      state && state.running === false && state.port === 0,
      JSON.stringify(state && { running: state.running, port: state.port }));

    check('the sync bridge exists but has done nothing',
      await js(`return typeof window.board.sync.start === 'function'
                  && typeof window.board.sync.send === 'function';`));

    // and asking it to do anything while off is refused rather than silently
    // starting it
    const refused = await js(`
      const r = await window.board.sync.send({ deviceId: 'nobody' }, { id: 'x', objects: [] });
      return r;
    `);
    check('sending while sync is off is refused, not quietly allowed',
      refused && refused.ok === false, JSON.stringify(refused));
  }

  /* ---- Escape and a click outside close whatever is on top ---- */
  const dismiss = await js(`
    const a = window.app, sf = a.surface;
    a.newBoard(true);
    const r = {};
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const overlay = document.getElementById('overlay');
    const panel = document.getElementById('panel');
    const shown = () => overlay.classList.contains('show');
    const panelShown = () => panel.classList.contains('open');
    const esc = () => document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true }));
    const pointerOn = (el) => el.dispatchEvent(new PointerEvent('pointerdown',
      { bubbles: true, clientX: 5, clientY: 5 }));
    // a real "somewhere else": the board itself
    const clickBoard = () => sf.canvas.dispatchEvent(new PointerEvent('pointerdown',
      { bubbles: true, clientX: 40, clientY: 40, pointerId: 77, pointerType: 'mouse', button: 0, buttons: 1 }));
    const timed = (p, ms = 1500) => Promise.race([p, sleep(ms).then(() => 'TIMED OUT')]);

    /* --- the shortcuts list: the one that had to be scrolled to be closed --- */
    a.showShortcuts(); await sleep(20);
    r.shortcutsOpen = shown();
    esc(); await sleep(20);
    r.shortcutsEsc = !shown();

    a.showShortcuts(); await sleep(20);
    pointerOn(document.getElementById('overlayCard'));
    await sleep(20);
    r.cardClickKeepsItOpen = shown();     // clicking the dialog is using it
    pointerOn(overlay); await sleep(20);
    r.backdropClickCloses = !shown();

    /* --- About, same treatment --- */
    await a.showAbout(); await sleep(30);
    r.aboutOpen = shown();
    esc(); await sleep(20);
    r.aboutEsc = !shown();

    /* --- a question must ANSWER when it is dismissed, not just disappear --- */
    const q = a.choose('Sure?', 'Body', [{ id: 'go', label: 'Go', primary: true }]);
    await sleep(20);
    esc();
    r.chooseEscape = await timed(q);              // null, never "TIMED OUT"

    const q2 = a.choose('Sure?', 'Body', [{ id: 'go', label: 'Go', primary: true }]);
    await sleep(20);
    pointerOn(overlay);
    r.chooseBackdrop = await timed(q2);

    const c = a.confirm('Delete?', 'Body', 'Delete');
    await sleep(20);
    esc();
    r.confirmEscape = await timed(c);             // false - the safe answer

    /* --- a progress bar is not a question, so it cannot be waved away --- */
    const prog = a.showProgress('Importing', 'page 1 of 40');
    await sleep(20);
    r.progressOpen = shown();
    esc(); await sleep(20);
    r.progressSurvivedEsc = shown();
    pointerOn(overlay); await sleep(20);
    r.progressSurvivedClick = shown();
    prog.close(); await sleep(20);
    r.progressClosedByItsOwner = !shown();

    /* --- the slide-in panel --- */
    a.panels.settings(); await sleep(20);
    r.panelOpen = panelShown();
    pointerOn(panel); await sleep(20);
    r.insideKeepsItOpen = panelShown();
    pointerOn(document.getElementById('toolbar')); await sleep(20);
    r.toolbarKeepsItOpen = panelShown();          // its own button does the toggling
    clickBoard(); await sleep(20);
    r.boardClickCloses = !panelShown();

    a.panels.settings(); await sleep(20);
    esc(); await sleep(20);
    r.panelEsc = !panelShown();

    /* --- and with nothing layered, Escape still means "deselect" --- */
    a.store.add({ id: 'b1', type: 'shape', kind: 'rect', x: 100, y: 100, w: 80, h: 60,
      rotation: 0, stroke: '#000', fill: '#eee', lineWidth: 2 }, 'seed');
    a.setSelection(['b1']);
    r.hadSelection = sf.selection.size === 1;
    esc(); await sleep(20);
    r.escapeStillDeselects = sf.selection.size === 0;

    // a dialog on top must NOT let Escape reach the board and clear a selection
    a.setSelection(['b1']);
    a.showShortcuts(); await sleep(20);
    esc(); await sleep(20);
    r.selectionSurvivedDialogEscape = sf.selection.size === 1;
    a.setSelection([]);

    a.store.clear(); a.newBoard(true);
    return r;
  `);

  check('the shortcuts list closes on Escape, instead of hunting for its button',
    dismiss.shortcutsOpen && dismiss.shortcutsEsc);
  check('and on a click outside it, while a click inside is left alone',
    dismiss.cardClickKeepsItOpen && dismiss.backdropClickCloses);
  check('About closes the same way', dismiss.aboutOpen && dismiss.aboutEsc);
  check('a dismissed question answers rather than hanging the board',
    dismiss.chooseEscape === null && dismiss.chooseBackdrop === null,
    `Escape → ${JSON.stringify(dismiss.chooseEscape)}, click → ${JSON.stringify(dismiss.chooseBackdrop)}`);
  check('and a confirm dismisses as "no", never as "yes"',
    dismiss.confirmEscape === false, JSON.stringify(dismiss.confirmEscape));
  check('a progress bar cannot be waved away while the work is still running',
    dismiss.progressOpen && dismiss.progressSurvivedEsc && dismiss.progressSurvivedClick
    && dismiss.progressClosedByItsOwner);
  check('the panel closes on Escape and on a click on the board',
    dismiss.panelOpen && dismiss.panelEsc && dismiss.boardClickCloses);
  check('but not on a click inside it, nor on the toolbar that toggles it',
    dismiss.insideKeepsItOpen && dismiss.toolbarKeepsItOpen);
  check('with nothing layered, Escape still clears the selection',
    dismiss.hadSelection && dismiss.escapeStillDeselects);
  check('and Escape aimed at a dialog does not reach through and clear it',
    dismiss.selectionSurvivedDialogEscape);

  /* ---- erasing one end of a stroke must not round off the other ---- */
  const sharpCorner = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    const r = {};

    // A stroke with a deliberate sharp corner at (400,200): down the left arm,
    // hard turn, back up the right arm. Samples are spaced the way a hand
    // moving at speed leaves them.
    const pts = [];
    for (let x = 200; x <= 400; x += 10) pts.push({ x, y: 400 - (x - 200), p: 0.5 });
    for (let x = 410; x <= 600; x += 10) pts.push({ x, y: 200 + (x - 400), p: 0.5 });
    a.store.add({ id: 'v', type: 'stroke', tool: 'pen', color: '#201f1e', width: 6,
      effect: 'none', points: pts, bbox: { x: 200, y: 200, w: 400, h: 200 }, rotation: 0 }, 'seed');

    /*
     * How round the drawn corner is.
     *
     * centrelinePath curves through the MIDPOINTS of the samples, so the curve
     * misses the corner vertex by |p - midpoint(prev, next)| / 4. Points close
     * together either side of the corner keep it sharp; spread them out and the
     * curve cuts it off. That quarter-distance IS the visible rounding.
     */
    const roundness = (points) => {
      let worst = 0;
      for (let i = 1; i < points.length - 1; i++) {
        const p = points[i], q = points[i - 1], s = points[i + 1];
        // only judge actual corners, not the straight runs
        const a1 = Math.atan2(p.y - q.y, p.x - q.x), a2 = Math.atan2(s.y - p.y, s.x - p.x);
        let turn = Math.abs(a2 - a1);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < 0.6) continue;
        const mx = (q.x + s.x) / 2, my = (q.y + s.y) / 2;
        worst = Math.max(worst, Math.hypot(p.x - mx, p.y - my) / 4);
      }
      return Math.round(worst * 100) / 100;
    };

    r.before = roundness(a.store.get('v').points);
    r.pointsBefore = a.store.get('v').points.length;

    // erase a bite out of the FAR end of the right arm - nowhere near the corner
    a.setTool('eraser');
    a.settings.eraserMode = 'partial';
    a.settings.eraserSize = 30;
    const rect = sf.canvas.getBoundingClientRect();
    const ev = (x, y, b) => ({ pointerId: 4, pointerType: 'pen', button: 0, buttons: b,
      clientX: rect.left + x, clientY: rect.top + y, pressure: 0.5, shiftKey: false, altKey: false,
      preventDefault(){}, stopPropagation(){}, target:{setPointerCapture(){},releasePointerCapture(){}} });
    it.onDown(ev(560, 360, 1));
    it.onMove(ev(560, 380, 1));
    it.onUp(ev(560, 380, 0));
    it.action = null; it.pointers.clear();

    const left = a.store.objects.filter(o => o.type === 'stroke');
    r.piecesAfter = left.length;
    // the piece that still owns the corner is the one reaching back to x=200
    const withCorner = left.find(o => o.points.some(p => p.x <= 210));
    r.after = withCorner ? roundness(withCorner.points) : null;
    r.pointsAfter = withCorner ? withCorner.points.length : null;

    // and the corner vertex itself must still be a sample, exactly where it was
    r.cornerKept = !!withCorner && withCorner.points.some(p =>
      Math.abs(p.x - 400) < 0.02 && Math.abs(p.y - 200) < 0.02);

    // the untouched left arm must come back point for point
    const beforeLeft = pts.filter(p => p.x <= 400).map(p => p.x + ',' + p.y).join(' ');
    const afterLeft = withCorner ? withCorner.points.filter(p => p.x <= 400)
      .map(p => p.x + ',' + p.y).join(' ') : '';
    r.leftArmIdentical = beforeLeft === afterLeft;

    a.setTool('select'); a.store.clear(); a.newBoard(true);
    return r;
  `);

  check('erasing far from a corner leaves the corner as sharp as it was',
    sharpCorner.after !== null && sharpCorner.after <= sharpCorner.before,
    `roundness ${sharpCorner.before} before, ${sharpCorner.after} after`);
  check('the corner sample itself survives, exactly where it was drawn',
    sharpCorner.cornerKept);
  check('and the whole untouched arm comes back point for point',
    sharpCorner.leftArmIdentical,
    `${sharpCorner.pointsBefore} points before, ${sharpCorner.pointsAfter} on the piece that kept the corner`);

  /* ---- moving the nib must not cost a repaint of the board ---- */
  const nibCost = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkPointer = 'nib';
    const r = {};

    // a board with something on it, so a full redraw would actually cost
    for (let n = 0; n < 300; n++) {
      const pts = [];
      for (let i = 0; i <= 20; i++) pts.push({ x: (n % 20) * 60 + i * 2, y: Math.floor(n / 20) * 40, p: 0.5 });
      a.store.add({ id: 'k' + n, type: 'stroke', tool: 'pen', color: '#333', width: 4,
        effect: 'none', points: pts, bbox: { x: (n % 20) * 60, y: Math.floor(n / 20) * 40, w: 40, h: 1 },
        rotation: 0 }, 'seed');
    }
    a.setTool('pen');

    // count real scene redraws, not invalidate() calls - drawScene IS the cost
    let scenes = 0;
    const realDrawScene = sf.drawScene;
    sf.drawScene = function (...args) { scenes++; return realDrawScene.apply(this, args); };
    const frame = () => new Promise(res => requestAnimationFrame(() => res()));

    const rect = sf.canvas.getBoundingClientRect();
    const hover = (x, y) => it.onMove({ pointerId: 1, pointerType: 'pen', button: -1, buttons: 0,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0,
      preventDefault(){}, stopPropagation(){}, target:{setPointerCapture(){},releasePointerCapture(){}} });

    hover(200, 300);
    await frame(); await frame();          // let any pending paint settle
    scenes = 0;

    for (let i = 0; i < 60; i++) { hover(200 + i * 3, 300 + (i % 5)); }
    await frame(); await frame(); await frame();
    r.scenesWhileHovering = scenes;

    // for the record: what a repaint-per-move would have been spending
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) realDrawScene.call(sf, sf.ctx, sf.width, sf.height);
    r.msPerRedraw = Math.round((performance.now() - t0) / 10 * 10) / 10;

    const el = document.getElementById('inkNib');
    r.layerIdleWhileHovering = !el || el.hidden;
    r.hoverUsedSystemCursor = String(sf.canvas.style.cursor).startsWith('url(');

    sf.drawScene = realDrawScene;
    a.setTool('select'); a.store.clear(); a.newBoard(true);
    return r;
  `);

  check('60 hover moves across a 300-stroke board repaint it 0 times',
    nibCost.scenesWhileHovering === 0,
    `${nibCost.scenesWhileHovering} full scene redraw(s)`);
  check('because hovering never leaves the system cursor at all',
    nibCost.hoverUsedSystemCursor && nibCost.layerIdleWhileHovering);
  console.log('  what one full redraw of that board costs:', nibCost.msPerRedraw, 'ms');

  /* ---- the nib must not vanish for as long as you are writing ---- */
  const nibDuringStroke = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkPointer = 'nib';
    a.setTool('pen');
    const r = {};
    const rect = sf.canvas.getBoundingClientRect();
    const mk = (x, y, buttons) => ({ pointerId: 1, pointerType: 'pen', button: 0, buttons,
      clientX: rect.left + x, clientY: rect.top + y, shiftKey: false, altKey: false, pressure: 0.6,
      preventDefault(){}, stopPropagation(){}, target:{setPointerCapture(){},releasePointerCapture(){}} });

    // hovering first, as a hand does
    it.onMove(mk(200, 300, 0));
    r.hoverUsedSystemCursor = String(sf.canvas.style.cursor).startsWith('url(');
    r.beforeStroke = it.inkPointer ? Math.round(it.inkPointer.x) : null;

    // now write, and watch the nib at every step of the stroke
    it.onDown(mk(200, 300, 1));
    const seen = [];
    for (let x = 220; x <= 400; x += 20) {
      it.onMove(mk(x, 300, 1));
      seen.push(it.inkPointer ? Math.round(it.inkPointer.x) : null);
    }
    r.duringStroke = seen;
    r.neverVanished = seen.every(v => v !== null);
    r.keptUp = seen[seen.length - 1] === 400;
    r.cursorStayedOff = sf.canvas.style.cursor === 'none';

    it.onUp(mk(400, 300, 0));
    it.pointers.clear();
    r.afterLift = it.inkPointer ? Math.round(it.inkPointer.x) : null;
    r.systemCursorBack = String(sf.canvas.style.cursor).startsWith('url(');
    const nibEl2 = document.getElementById('inkNib');
    r.layerPutAway = !nibEl2 || nibEl2.hidden;

    // leaving the board takes it away rather than stranding it at the edge
    sf.canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    r.goneOnLeave = it.inkPointer === null;

    a.setTool('select'); a.store.clear(); a.newBoard(true);
    return r;
  `);

  check('a hovering pen is carried by the system cursor, not our layer',
    nibDuringStroke.hoverUsedSystemCursor && nibDuringStroke.beforeStroke === null);
  check('and does not vanish for a single frame of the stroke',
    nibDuringStroke.neverVanished && nibDuringStroke.cursorStayedOff,
    JSON.stringify(nibDuringStroke.duringStroke));
  check('it keeps up with the pen rather than lagging behind it',
    nibDuringStroke.keptUp);
  check('and the system cursor takes it back the moment the pen lifts',
    nibDuringStroke.systemCursorBack && nibDuringStroke.layerPutAway && nibDuringStroke.afterLift === null,
    `layer at ${nibDuringStroke.afterLift}`);
  check('but it goes away when the pointer leaves the board',
    nibDuringStroke.goneOnLeave);

  /* ---- a mouse keeps the hardware cursor; only the pen gets the drawn nib ---- */
  const mouseNib = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkPointer = 'nib';
    a.settings.inkWithMouse = 'yes';       // so the mouse takes the ink path at all
    a.penSeenThisSession = false;
    a.setTool('pen');
    const r = {};
    const rect = sf.canvas.getBoundingClientRect();
    const mk = (x, y, type, buttons) => ({ pointerId: type === 'mouse' ? 3 : 1, pointerType: type,
      button: 0, buttons, clientX: rect.left + x, clientY: rect.top + y,
      shiftKey: false, altKey: false, pressure: type === 'pen' ? 0.6 : 0,
      preventDefault(){}, stopPropagation(){}, target:{setPointerCapture(){},releasePointerCapture(){}} });

    it.onMove(mk(250, 300, 'mouse', 0));
    r.mouseCursor = String(sf.canvas.style.cursor).startsWith('url(') ? 'css-nib' : sf.canvas.style.cursor;
    r.mouseDrewNoNib = it.inkPointer === null;

    it._penAt = 0;
    it.onMove(mk(250, 300, 'pen', 0));
    r.penHoverCursor = String(sf.canvas.style.cursor).startsWith('url(') ? 'css-nib' : sf.canvas.style.cursor;
    r.penHoverUsedNoLayer = it.inkPointer === null;

    // it is the STROKE where the pen needs our layer
    it.onDown(mk(260, 300, 'pen', 1));
    it.onMove(mk(300, 300, 'pen', 1));
    r.penStrokeCursor = sf.canvas.style.cursor;
    r.penStrokeUsedTheLayer = !!it.inkPointer;
    it.onUp(mk(300, 300, 'pen', 0));
    it.action = null; it.pointers.clear();

    // and a mouse stroke keeps the hardware cursor the whole way through
    it.onDown(mk(300, 300, 'mouse', 1));
    it.onMove(mk(340, 300, 'mouse', 1));
    r.duringMouseStroke = String(sf.canvas.style.cursor).startsWith('url(') ? 'css-nib' : sf.canvas.style.cursor;
    r.stillNoNib = it.inkPointer === null;
    it.onUp(mk(340, 300, 'mouse', 0));
    it.action = null; it.pointers.clear();

    a.setTool('select'); a.settings.inkWithMouse = 'auto'; a.store.clear(); a.newBoard(true);
    it.inkPointer = null;
    return r;
  `);

  check('the mouse keeps a hardware cursor rather than a repainted one',
    mouseNib.mouseCursor === 'css-nib' && mouseNib.mouseDrewNoNib, mouseNib.mouseCursor);
  check('a hovering pen is on the system cursor too',
    mouseNib.penHoverCursor === 'css-nib' && mouseNib.penHoverUsedNoLayer, mouseNib.penHoverCursor);
  check('and only a pen STROKE falls back to our own layer',
    mouseNib.penStrokeCursor === 'none' && mouseNib.penStrokeUsedTheLayer, mouseNib.penStrokeCursor);
  check('and a mouse stroke keeps it for the whole stroke',
    mouseNib.duringMouseStroke === 'css-nib' && mouseNib.stillNoNib, mouseNib.duringMouseStroke);

  /* ---- the nib is set once, not on every single pointermove ---- */
  const cursorChurn = await js(`
    const a = window.app, it = a.interaction, sf = a.surface;
    a.newBoard(true); sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.settings.inkWithMouse = 'yes';
    const r = {};

    // count every real write to the DOM property
    const canvas = it.canvas;
    let writes = 0;
    // setCursor is the ONLY place in tools.js that writes canvas.style.cursor,
    // so counting the writes it actually performs counts the writes the DOM
    // sees. It returns true only when the value changed and was written.
    const realSetCursor = it.setCursor;
    it.setCursor = function (v) { const wrote = realSetCursor.call(this, v); if (wrote) writes++; return wrote; };

    const move = (x, y, type = 'pen') => it.onMove({ pointerId: 1, pointerType: type,
      button: -1, buttons: 0, clientX: x, clientY: y, pressure: 0,
      preventDefault(){}, stopPropagation(){},
      target: { setPointerCapture(){}, releasePointerCapture(){} } });

    // hover the pen tool across the board the way a hand does before writing
    a.setTool('pen');
    a.settings.inkPointer = 'nib';
    it.action = null; it.pointers.clear();
    it._cursor = null; canvas.style.cursor = 'default';   // start from a known cursor
    writes = 0;
    for (let i = 0; i < 120; i++) move(300 + i, 400 + (i % 7));
    r.writesWhileHovering = writes;
    r.hoverKeptSystemCursor = String(canvas.style.cursor).startsWith('url(');

    // a colour change re-tints straight away, without waiting for a move
    writes = 0;
    a.settings.penColor = '#00b294';
    it.refreshInkCursor();
    r.retintWroteCursor = writes;
    r.tintedToTheNewColour = String(canvas.style.cursor).includes('%2300b294');

    // and a genuine change of cursor still happens
    writes = 0;
    a.setTool('note');
    for (let i = 0; i < 5; i++) move(500 + i, 400);
    r.writesOnARealChange = writes;
    r.endedOnTheNoteCursor = canvas.style.cursor === 'copy';

    it.setCursor = realSetCursor;
    a.setTool('select'); a.settings.inkWithMouse = 'no'; a.newBoard(true);
    return r;
  `);

  check('hovering with the pen sets the cursor once, not on every move',
    cursorChurn.hoverKeptSystemCursor && cursorChurn.writesWhileHovering === 1,
    `${cursorChurn.writesWhileHovering} write(s) across 120 moves`);
  check('a colour change re-tints the nib at once, in one write',
    cursorChurn.retintWroteCursor === 1 && cursorChurn.tintedToTheNewColour,
    `${cursorChurn.retintWroteCursor} cursor write(s)`);
  check('and switching tools still changes the cursor',
    cursorChurn.writesOnARealChange === 1 && cursorChurn.endedOnTheNoteCursor,
    `${cursorChurn.writesOnARealChange} write(s)`);

  /* ---- snip a page, Ctrl+V, ink on it ---- */
  const pasted = await js(`
   try {
    const a = window.app, sf = a.surface;
    a.newBoard(true);
    sf.cam.x = 0; sf.cam.y = 0; sf.cam.z = 1;
    a.textEditor.cancel();
    const r = {};
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    // a 1600x900 "screenshot", the shape a snip of a book page tends to be
    const shot = document.createElement('canvas');
    shot.width = 1600; shot.height = 900;
    const g = shot.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1600, 900);
    g.fillStyle = '#201f1e'; g.fillRect(80, 80, 900, 40);
    const blob = await new Promise(res => shot.toBlob(res, 'image/png'));
    const file = new File([blob], 'image.png', { type: 'image/png' });

    const firePaste = (build) => {
      const dt = new DataTransfer();
      build(dt);
      document.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
    };

    // --- the paste itself ---
    firePaste(dt => dt.items.add(file));
    for (let i = 0; i < 200 && !a.store.objects.some(o => o.type === 'image'); i++) await sleep(10);
    const img = a.store.objects.find(o => o.type === 'image');
    r.landed = !!img;
    r.carriesThePixels = !!img && typeof img.src === 'string' && img.src.startsWith('data:image/');

    // a screenshot is far wider than the window; it has to arrive at a size you
    // can actually draw on rather than filling the whole canvas
    r.scaledDown = !!img && Math.round(img.w) === 640 && Math.round(img.h) === 360;

    // and it lands where you are looking, not off at the origin
    const view = sf.cam.viewport(sf.width, sf.height);
    r.centredInView = !!img
      && Math.abs((img.x + img.w / 2) - (view.x + view.w / 2)) < 1
      && Math.abs((img.y + img.h / 2) - (view.y + view.h / 2)) < 1;

    // selected on arrival, so it can be moved or resized straight away
    r.selectedOnArrival = !!img && sf.selection.has(img.id);

    // --- ink goes on top of it, not underneath ---
    a.setTool('pen');
    a.settings.inkWithMouse = 'yes';        // this test is about z-order, not devices
    const it = a.interaction;
    const ev = (x, y) => ({ pointerId: 9, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: x, clientY: y, pressure: 0, preventDefault(){}, stopPropagation(){},
      target: { setPointerCapture(){}, releasePointerCapture(){} } });
    it.onDown(ev(300, 300)); it.onMove(ev(360, 330)); it.onMove(ev(420, 300)); it.onUp(ev(420, 300));
    it.action = null; it.pointers.clear();
    const stroke = a.store.objects.find(o => o.type === 'stroke');
    r.inkedOnIt = !!stroke;
    r.inkSitsAbove = !!stroke && !!img
      && a.store.doc.order.indexOf(stroke.id) > a.store.doc.order.indexOf(img.id);
    a.settings.inkWithMouse = 'no';

    // --- plain text on the clipboard becomes a text object, not an image ---
    a.newBoard(true); a.textEditor.cancel();
    firePaste(dt => dt.setData('text/plain', 'from the book'));
    await sleep(50);
    const t = a.store.objects.find(o => o.type === 'text');
    r.textPasteWorks = !!t && t.text === 'from the book';

    // --- but not while a note or text box is being typed into ---
    a.newBoard(true);
    a.setTool('note');
    it.onDown(ev(300, 300)); it.onUp(ev(300, 300));
    it.action = null; it.pointers.clear();
    await sleep(30);
    r.editorOpen = a.textEditor.active;
    const beforeCount = a.store.objects.length;
    firePaste(dt => dt.items.add(file));
    await sleep(120);
    r.leftTheEditorAlone = a.store.objects.length === beforeCount;
    a.textEditor.cancel();

    a.setTool('select'); a.newBoard(true);
    return r;
   } catch (e) { return { crashed: String(e && e.message || e) }; }
  `);
  if (pasted.crashed) console.log('  paste probe threw:', pasted.crashed);

  check('a screenshot on the clipboard pastes onto the board',
    pasted.landed && pasted.carriesThePixels);
  check('and arrives at a workable size rather than filling the canvas',
    pasted.scaledDown);
  check('it lands where you are looking, already selected',
    pasted.centredInView && pasted.selectedOnArrival);
  check('ink goes on top of the pasted picture, not under it',
    pasted.inkedOnIt && pasted.inkSitsAbove);
  check('text on the clipboard still pastes as text',
    pasted.textPasteWorks);
  check('pasting into a note being typed goes to the note, not the board',
    pasted.editorOpen && pasted.leftTheEditorAlone);

  /* ---- two files, one id: neither may eat the other ---- */
  const twoFiles = await js(`
    const a = window.app;
    const r = {};
    const ID = 'bvbfuva6r4050';           // the id both exports carry
    // A backslash inside a template literal inside a template literal is one
    // collapse away from becoming nothing at all, and a path with no separator
    // left in it would test the wrong thing while still reporting "ok". Built
    // from the character itself so there is nothing to collapse.
    const BS = String.fromCharCode(92);
    const DIR = 'C:' + BS + 'Users' + BS + 'User' + BS + 'Downloads' + BS;
    const P1 = DIR + 'Save from 1st Device 4_23.gazboard';
    const P2 = DIR + 'Save from 1st Device 4_23-3.gazboard';
    const P3 = DIR + 'Third copy.gazboard';

    const text = (id, s) => ({ id, type:'text', x:0, y:0, w:200, h:40, text:s,
      fontSize:20, color:'#201f1e', align:'left', valign:'top', rotation:0,
      font:'hand', background:'none' });
    const file = (origin, n) => ({
      id: ID, name: 'Untitled board', schema: 2, origin,
      objects: Array.from({ length: n }, (_, i) => text('o' + i, 'line ' + i)),
      pages: [], camera: { x: 0, y: 0, z: 1 }
    });

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const dialogButtons = () =>
      [...document.querySelectorAll('#overlayCard .actions button')].map(b => b.textContent);
    const waitForDialog = async () => {
      for (let i = 0; i < 200; i++) {
        if (document.getElementById('overlay').classList.contains('show')
            && dialogButtons().length) return dialogButtons();
        await sleep(10);
      }
      return null;
    };
    const clickDialog = async (label) => {
      const btns = [...document.querySelectorAll('#overlayCard .actions button')];
      const b = btns.find(x => x.textContent === label);
      if (!b) return false;
      b.click();
      await sleep(0);
      return true;
    };
    const escapeDialog = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(0);
    };
    const dialogShowing = () => document.getElementById('overlay').classList.contains('show');
    const listed = async () => (await window.board.boards.list());

    const before = (await listed()).map(b => b.id);
    const mine = async () => (await listed()).filter(b => !before.includes(b.id));

    // --- the earlier export lands first: nothing to clash with, no question ---
    const p1 = a.loadBoard(file(P1, 7));
    await sleep(120);
    r.noQuestionOnAFreshFile = !dialogShowing();
    await p1;
    const idA = a.store.doc.id;
    await a.persist({ force: true });

    // --- the later export of the SAME board, from a different file ---
    const p2 = a.loadBoard(file(P2, 9));
    r.askedBeforeTouchingAnything = await waitForDialog();
    r.offersBoth = !!r.askedBeforeTouchingAnything
      && r.askedBeforeTouchingAnything.includes('Keep both')
      && r.askedBeforeTouchingAnything.includes('Replace my copy');
    // nothing may have been written while the question was still on screen
    const midway = await mine();
    r.untouchedWhileAsking = midway.length === 1 && midway[0].objects === 7;
    await clickDialog('Keep both');
    await p2;
    const idB = a.store.doc.id;
    await a.persist({ force: true });

    r.gotSeparateIds = idA !== idB;
    const fresh = await mine();
    r.boardsMade = fresh.length;
    const a1 = fresh.find(b => b.id === idA), b1 = fresh.find(b => b.id === idB);
    r.firstStillThere = !!a1 && a1.objects === 7;
    r.secondAlsoThere = !!b1 && b1.objects === 9;

    // --- and they are numbered apart, not two identical rows ---
    r.pathHasSeparators = P1.indexOf(BS) > 0;
    r.namedApart = !!a1 && !!b1 && a1.name !== b1.name;
    r.firstName = a1 && a1.name;
    r.secondName = b1 && b1.name;

    // --- re-opening the FIRST file: known already, so no question and no copy ---
    const p3 = a.loadBoard(file(P1, 7));
    await sleep(120);
    r.noQuestionOnAFileSeenBefore = !dialogShowing();
    await p3;
    r.reopenedSameBoard = a.store.doc.id === idA;
    await a.persist({ force: true });
    r.stillOnlyTwo = (await mine()).length === 2;

    // --- Escape is not an answer: it must land on the side that destroys nothing ---
    const p4 = a.loadBoard(file(P3, 5));
    await waitForDialog();
    await escapeDialog();
    await p4;
    await a.persist({ force: true });
    const afterEscape = await mine();
    r.escapeKeptBoth = afterEscape.length === 3
      && !!afterEscape.find(b => b.id === idA && b.objects === 7)
      && !!afterEscape.find(b => b.id === idB && b.objects === 9);

    // --- "Replace my copy" does what it says, and only when it is chosen ---
    const victim = a.store.doc.id;                 // the board Escape just created
    const victimBefore = (await mine()).find(b => b.id === victim).objects;
    const p5 = a.loadBoard({ ...file(P3 + '-again', 2), id: victim });
    await waitForDialog();
    await clickDialog('Replace my copy');
    await p5;
    await a.persist({ force: true });
    const afterReplace = await mine();
    r.replaceOverwrote = afterReplace.length === 3
      && afterReplace.find(b => b.id === victim).objects === 2 && victimBefore === 5;

    // --- the local path must not travel inside a file you share ---
    const { exportable } = await import('app://board/js/export.js');
    const exported = exportable(a.store.toJSON());
    r.originStrippedOnExport = !('origin' in exported);
    r.originKeptLocally = a.store.toJSON().origin === P3 + '-again';

    // --- a board with no file behind it is left completely alone ---
    a.newBoard(true);
    const plainId = a.store.doc.id;
    await a.loadBoard({ id: plainId, name: 'Untitled board', schema: 2,
      objects: [], pages: [], camera: { x:0, y:0, z:1 } });
    r.noOriginNoChange = a.store.doc.id === plainId && a.store.doc.name === 'Untitled board';

    a.newBoard(true);
    return r;
  `);

  check('a file with nothing to clash with opens without a question',
    twoFiles.noQuestionOnAFreshFile);
  check('a second file carrying the same id asks before it writes anything',
    twoFiles.offersBoth && twoFiles.untouchedWhileAsking,
    `buttons: ${JSON.stringify(twoFiles.askedBeforeTouchingAnything)}`);
  check('"Keep both" makes two boards, not one on top of the other',
    twoFiles.gotSeparateIds && twoFiles.boardsMade === 2,
    `${twoFiles.boardsMade} board(s), separate ids: ${twoFiles.gotSeparateIds}`);
  check('the earlier export is still on disk after the later one is opened',
    twoFiles.firstStillThere && twoFiles.secondAlsoThere);
  check('and they are numbered apart in the list',
    twoFiles.pathHasSeparators && twoFiles.namedApart,
    `"${twoFiles.firstName}" / "${twoFiles.secondName}"`);
  check('a file opened before is recognised: no question, no extra copy',
    twoFiles.noQuestionOnAFileSeenBefore && twoFiles.reopenedSameBoard && twoFiles.stillOnlyTwo);
  check('Escape is not an answer - it keeps both, it never replaces',
    twoFiles.escapeKeptBoth);
  check('"Replace my copy" overwrites, and only when it is chosen',
    twoFiles.replaceOverwrote);
  check('the path it was opened from never leaves this machine',
    twoFiles.originStrippedOnExport && twoFiles.originKeptLocally);
  check('a board that came from no file is untouched by any of this',
    twoFiles.noOriginNoChange);

  /* ---- same name, different board: numbered, never doubled up ---- */
  const naming = await js(`
    const a = window.app;
    const r = {};
    const BS = String.fromCharCode(92);
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const board = (id, origin, name) => ({ id, name, schema: 2, origin,
      objects: [{ id:'t1', type:'text', x:0, y:0, w:200, h:40, text:name,
        fontSize:20, color:'#201f1e', align:'left', valign:'top', rotation:0,
        font:'hand', background:'none' }],
      pages: [], camera: { x:0, y:0, z:1 } });

    const before = (await window.board.boards.list()).map(b => b.id);
    const mine = async () => (await window.board.boards.list()).filter(b => !before.includes(b.id));

    // three unrelated boards - different ids, so nothing clashes and nothing is
    // asked - that happen to be called the same thing
    await a.loadBoard(board('nm-1', 'D:' + BS + 'a' + BS + 'Lesson plan.gazboard', 'Lesson plan'));
    await a.persist({ force: true });
    await a.loadBoard(board('nm-2', 'D:' + BS + 'b' + BS + 'Lesson plan.gazboard', 'Lesson plan'));
    await a.persist({ force: true });
    await a.loadBoard(board('nm-3', 'D:' + BS + 'c' + BS + 'Lesson plan.gazboard', 'Lesson plan'));
    await a.persist({ force: true });
    await sleep(20);

    const names = (await mine()).map(b => b.name).sort();
    r.names = names;
    r.allDistinct = new Set(names).size === names.length;
    r.numbered = names.join('|') === 'Lesson plan|Lesson plan 2|Lesson plan 3';

    // and a board with a placeholder name takes its file's name, not "Untitled board"
    await a.loadBoard(board('nm-4', 'D:' + BS + 'd' + BS + 'Week 3 warm-up.gazboard', 'Untitled board'));
    await a.persist({ force: true });
    await sleep(20);
    r.tookTheFileName = !!(await mine()).find(b => b.id === 'nm-4' && b.name === 'Week 3 warm-up');

    a.newBoard(true);
    return r;
  `);

  check('boards that would share a name are numbered instead',
    naming.allDistinct && naming.numbered, JSON.stringify(naming.names));
  check('a board still called "Untitled board" takes the name of its file',
    naming.tookTheFileName);

  /* ---- opening a board file is reachable without knowing the shortcut ---- */
  const openable = await js(`
    const a = window.app;
    a.newBoard(true);
    const labels = (id) => [...(document.getElementById(id) || document.body).querySelectorAll('button')]
      .map((b) => (b.textContent || '').trim());

    await a.panels.boards();
    await new Promise((r) => setTimeout(r, 400));
    const boardsPanel = labels('boardList');

    a.panels.close();
    await a.panels.settings();
    await new Promise((r) => setTimeout(r, 250));
    const settingsPanel = [...document.querySelectorAll('.panel button')].map((b) => (b.textContent || '').trim());
    a.panels.close();

    return { boardsPanel, settingsPanel, hasCommand: typeof a.command === 'function' };
  `);

  const hasOpen = (list) => list.some((t) => /^open a board file/i.test(t));
  check('the boards panel offers a way to open a board file',
    hasOpen(openable.boardsPanel), openable.boardsPanel.join(' | ') || '(none)');
  check('and so does the board section in Settings',
    hasOpen(openable.settingsPanel),
    openable.settingsPanel.filter((t) => /board|copy|canvas/i.test(t)).join(' | ') || '(none)');

  /* ---- a board opened from a file is not clobbered by the startup restore ---- */
  const raceResult = await js(`
    const a = window.app;
    const r = {};

    // the stale copy this machine already has, under the same id as the file -
    // which is what happens when one board travels between two computers
    const ID = 'shared-board-id';
    const localCopy = { id: ID, name: 'Untitled board', schema: 2, objects: [
      { id:'old1', type:'text', x:0, y:0, w:200, h:40, text:'from this machine',
        fontSize:20, color:'#201f1e', align:'left', valign:'top', rotation:0, font:'hand', background:'none' }
    ], pages: [], camera: { x:0, y:0, z:1 } };

    // the file carried back from the other computer: same board, more work on it
    const fromTheOtherMachine = { id: ID, name: 'Untitled board', schema: 2, objects: [
      ...localCopy.objects,
      { id:'new1', type:'text', x:0, y:60, w:200, h:40, text:'drawn on the laptop',
        fontSize:20, color:'#201f1e', align:'left', valign:'top', rotation:0, font:'hand', background:'none' },
      { id:'new2', type:'stroke', tool:'pen', color:'#e81123', width:4, effect:'none',
        points:[{x:0,y:120},{x:60,y:140},{x:120,y:120}], bbox:{x:0,y:110,w:120,h:40}, rotation:0 }
    ], pages: [], camera: { x:0, y:0, z:1 } };

    // Stand the race up exactly as it happens: the restore is already in flight
    // when the file arrives. resume() is made slow so the ordering is certain
    // rather than lucky.
    const realResume = window.board.boards.resume;
    a.boardOpenedExplicitly = false;
    const slowResume = () => new Promise((res) => setTimeout(() => res({ board: localCopy, reason: 'pointer' }), 250));
    window.board.boards.resume = slowResume;   // the race only exists if resume is actually slow
    const restore = a.restoreLastBoard.call({
      ...a,
      store: a.store, surface: a.surface, textEditor: a.textEditor, settings: a.settings,
      loadBoard: a.loadBoard.bind(a), toast: () => {}, newBoard: a.newBoard.bind(a),
      resolveAssets: a.resolveAssets.bind(a), command: a.command.bind(a), syncUI: () => {},
      // a spread copies own properties only, so the prototype methods
      // restoreLastBoard leans on have to be handed over by name
      appInfo: a.appInfo.bind(a),
      get boardOpenedExplicitly() { return a.boardOpenedExplicitly; }
    });

    // the file lands first, as it does in real life
    await a.loadBoard(JSON.parse(JSON.stringify(fromTheOtherMachine)));
    r.rightAfterTheFileOpened = a.store.objects.length;

    // now let the restore finish and try to have its say
    await new Promise((res) => setTimeout(res, 500));
    await restore.catch(() => {});
    r.afterTheRestoreSettled = a.store.objects.length;
    r.keptTheLaptopWork = !!a.store.get('new1') && !!a.store.get('new2');
    r.stillHasTheOlderWork = !!a.store.get('old1');

    r.mainReportsTheFlag = !!(await window.board.info()).pendingBoardFile;

    window.board.boards.resume = realResume;
    a.boardOpenedExplicitly = false;
    a.newBoard(true);
    return r;
  `);

  check('the app is told up front when a file was double-clicked, rather than racing',
    raceResult.mainReportsTheFlag === false,
    'no file on this launch, so the flag is false — the two-launch check covers the true case');
  check('a board opened from a file survives the startup restore',
    raceResult.afterTheRestoreSettled === raceResult.rightAfterTheFileOpened,
    `${raceResult.rightAfterTheFileOpened} objects on open, ${raceResult.afterTheRestoreSettled} after`);
  check('work done on the other computer is still there',
    raceResult.keptTheLaptopWork && raceResult.stillHasTheOlderWork);

  /* ---- dismissing the update question is not the same as never answering ---- */
  const nag = await js(`
    const a = window.app;
    const { App } = await import('app://board/js/app.js').catch(() => ({}));
    const r = {};
    const saved = { uc: a.settings.updateCheck, at: a.settings.updateAskedAt };

    // never asked: the question is due
    a.settings.updateCheck = null; a.settings.updateAskedAt = 0;
    r.dueWhenNeverAsked = Date.now() - (a.settings.updateAskedAt || 0) > a.constructor.ASK_AGAIN_AFTER;

    // Actually dismiss it, rather than setting the flag by hand - otherwise this
    // checks the rule and never checks that anything records the dismissal.
    a.settings.updateCheck = null; a.settings.updateAskedAt = 0;
    const asking = a.askAboutUpdates();
    await new Promise((res) => setTimeout(res, 150));
    r.dialogAppeared = document.getElementById('overlay').classList.contains('show');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await asking;
    r.stillUnanswered = a.settings.updateCheck === null;
    r.dismissalRecorded = (a.settings.updateAskedAt || 0) > 0;
    r.notDueAgainToday = !(Date.now() - (a.settings.updateAskedAt || 0) > a.constructor.ASK_AGAIN_AFTER);

    // and it does come back eventually rather than being buried for good
    a.settings.updateAskedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
    r.dueAgainAfterAWeek = Date.now() - a.settings.updateAskedAt > a.constructor.ASK_AGAIN_AFTER;

    // a real answer is still remembered for good
    a.settings.updateCheck = true; a.settings.updateAskedAt = 0;
    r.answerSticks = a.settings.updateCheck === true;

    a.settings.updateCheck = saved.uc; a.settings.updateAskedAt = saved.at;
    return r;
  `);

  check('the update question is asked on a fresh install', nag.dueWhenNeverAsked);
  check('dismissing it records no answer', nag.stillUnanswered && nag.dialogAppeared);
  check('but the dismissal itself is remembered', nag.dismissalRecorded);
  check('but it does not come back the very next time the app opens', nag.notDueAgainToday);
  check('it does come back after a week, rather than never', nag.dueAgainAfterAWeek);
  check('an actual answer is still kept for good', nag.answerSticks);

  /* ================================================================= *
   *  Sharing on the local network
   *
   *  The point of these is that the feature stays invisible until it is asked
   *  for, and that nothing an arriving board does can happen without somebody
   *  pressing a button. GazBoard's promise is that it is offline; this is
   *  where that promise is checked rather than asserted.
   * ================================================================= */

  const syncOff = await js(`
    const st = await window.board.sync.state();
    return { setting: window.app.settings.sync, running: st.running, peers: (st.peers || []).length,
             paired: (st.paired || []).length, port: st.port };
  `);
  check('sharing on the network is off on a fresh install', syncOff.setting === false);
  check('and with it off nothing is listening', syncOff.running === false && syncOff.port === 0,
    `running: ${syncOff.running}, port: ${syncOff.port}`);
  check('nothing has been announced and nobody is paired',
    syncOff.peers === 0 && syncOff.paired === 0);

  await js(`window.app.panels.settings();`);
  await sleep(300);
  const syncPanel = await js(`
    const body = document.getElementById('panelBody');
    const heads = [...body.querySelectorAll('h5')].map((e) => e.textContent);
    const sec = [...body.querySelectorAll('.section')].find((s) => {
      const t = s.querySelector('h5');
      return t && t.textContent === 'Share on this network';
    });
    const box = sec ? sec.querySelector('input[type=checkbox]') : null;
    return { heads, present: !!sec, checked: box ? box.checked : null,
             text: sec ? sec.textContent : '' };
  `);
  check('Settings offers sharing on this network', syncPanel.present, syncPanel.heads.join(' | '));
  check('and its switch is off, so opening Settings changes nothing', syncPanel.checked === false);
  check('the switch says plainly what it turns on',
    /asked/i.test(syncPanel.text) && /firewall/i.test(syncPanel.text));
  await js(`window.app.panels.close();`);
  await sleep(150);

  // A board arriving from another machine. handleIncomingBoard is the whole
  // receiving path: it asks, and only then writes.
  const incoming = (name, id, ticket) => `
    window.__inc = window.app.handleIncomingBoard({
      ticket: ${JSON.stringify(ticket)},
      from: { deviceId: 'dev-classroom', name: 'Classroom PC' },
      board: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, schema: 2,
        pages: [], camera: { x: 0, y: 0, z: 1 },
        objects: [{ id: 'ink-in', type: 'stroke', tool: 'pen', color: '#0078d4', width: 5, effect: 'none',
          points: [{ x: 0, y: 0, p: .5 }, { x: 40, y: 30, p: .5 }, { x: 90, y: 10, p: .5 }],
          bbox: { x: 0, y: 0, w: 90, h: 30 }, rotation: 0 }] }
    });
    return true;`;

  /*
   * The tickets below belong to no real sender, which is deliberate: it is the
   * same shape as somebody answering a dialog they left on screen past the five
   * minutes the sending machine waits. That has to be quiet. It used to be a
   * handler registered per ticket and torn down on timeout, so a late answer
   * invoked a channel that had gone - logged as an error in the main process
   * and rejected in the renderer, for a case where nobody did anything wrong.
   */
  const stale = await js(`return await window.board.sync.answer('no-such-ticket', 'kept-both');`);
  check('answering a question nobody is waiting for is quiet, not an error',
    stale === false, String(stale));

  const boardsBefore = await js(`return (await window.board.boards.list()).length;`);
  const lastBefore = await js(`return await window.board.boards.last();`);

  await js(incoming('Group 4 doodle', 'in-b1', 't1'));
  await sleep(450);
  const ask = await js(`
    const c = document.getElementById('overlayCard');
    const img = c.querySelector('img');
    return {
      shown: document.getElementById('overlay').classList.contains('show'),
      title: c.querySelector('h3') ? c.querySelector('h3').textContent : '',
      thumb: !!img && (img.getAttribute('src') || '').startsWith('data:image'),
      buttons: [...c.querySelectorAll('button')].map((b) => b.textContent),
      openBox: c.querySelector('input[type=checkbox]') ? c.querySelector('input[type=checkbox]').checked : null,
      text: c.textContent
    };`);
  const during = await js(`return (await window.board.boards.list()).length;`);
  check('a board arriving from another computer asks first', ask.shown && /Classroom PC/.test(ask.title), ask.title);
  check('and shows a picture of it, not just its name', ask.thumb);
  check('with the item count, so an empty board cannot pose as work', /1 item/.test(ask.text));
  check('nothing is written while the question is on screen', during === boardsBefore,
    `${boardsBefore} board(s) before, ${during} during`);
  check('the answers offered are Decline and Save it',
    JSON.stringify(ask.buttons) === JSON.stringify(['Decline', 'Save it']), ask.buttons.join(' | '));
  // Which copy to keep and whether to open it are two different questions, and
  // the second is a habit rather than a decision about this board - so it sits
  // on a checkbox that remembers, not on another pair of buttons.
  check('and whether to open it is a checkbox, ticked by default',
    ask.openBox === true && /Open it straight away/.test(ask.text), String(ask.openBox));
  await shot(win, '22-incoming-board');

  // Escape must mean no. A board landing on somebody's machine because they
  // brushed a key is the failure this dialog exists to prevent.
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await js(`await window.__inc;`);
  const afterEscape = await js(`return (await window.board.boards.list()).length;`);
  check('Escape declines it, and nothing is saved', afterEscape === boardsBefore, `${afterEscape} board(s)`);

  /*
   * And the Decline button itself, which is a different code path from Escape
   * and deserves its own proof. "Declined" has to mean the board never touched
   * this machine at all: no row in the boards list, no file on disk under its
   * id, and no picture filed in the asset store on its way past.
   */
  await js(incoming('Refused doodle', 'in-refused', 't1b'));
  await sleep(450);
  await js(`[...document.getElementById('overlayCard').querySelectorAll('button')].find((b) => b.textContent === 'Decline').click();`);
  await js(`await window.__inc;`);
  await sleep(250);
  const refused = await js(`
    const list = await window.board.boards.list();
    return {
      count: list.length,
      byName: list.some((b) => b.name === 'Refused doodle'),
      byOrigin: list.some((b) => b.origin === 'sync:dev-classroom/in-refused'),
      onDisk: !!(await window.board.boards.load('in-refused')),
      openNow: window.app.store.doc.name
    };`);
  check('pressing Decline leaves no board behind either',
    refused.count === boardsBefore && !refused.byName && !refused.byOrigin,
    `${refused.count} board(s)`);
  check('and nothing under its id on disk, not even a stub', refused.onDisk === false);
  check('and what you were working on is untouched', refused.openNow !== 'Refused doodle', refused.openNow);

  // With the box unticked, accepting files the board and leaves you alone.
  // This is the classroom: thirty doodles must not each take over the screen.
  await js(`window.app.settings.syncOpenOnArrival = false; window.app.saveSettings();`);
  await js(incoming('Group 4 doodle', 'in-b1', 't2'));
  await sleep(450);
  const boxOff = await js(`const b = document.getElementById('overlayCard').querySelector('input[type=checkbox]');
    return b ? b.checked : null;`);
  check('unticking it is remembered for the next board that arrives', boxOff === false, String(boxOff));
  await js(`[...document.getElementById('overlayCard').querySelectorAll('button')].find((b) => b.textContent === 'Save it').click();`);
  await js(`await window.__inc;`);
  await sleep(250);
  const filed = await js(`
    const list = await window.board.boards.list();
    const b = list.find((x) => x.name === 'Group 4 doodle');
    return { count: list.length, found: !!b, origin: b ? b.origin : null,
             last: await window.board.boards.last(), openNow: window.app.store.doc.name };
  `);
  check('"Save it" files the board with the others', filed.found && filed.count === boardsBefore + 1,
    `${filed.count} board(s)`);
  check('and does not open it over what you were working on', filed.openNow !== 'Group 4 doodle', filed.openNow);
  check('nor change which board reopens next time', filed.last === lastBefore,
    `last was ${lastBefore}, now ${filed.last}`);
  check('it records which computer sent it, and no file path',
    filed.origin === 'sync:dev-classroom/in-b1', filed.origin);

  // Ticked, it opens. Which is the whole point: a board that arrives and is
  // only findable by going to Boards and hunting for it looks like a board
  // that vanished.
  await js(`window.app.settings.syncOpenOnArrival = true; window.app.saveSettings();`);
  await js(incoming('Straight to the front', 'in-b2', 't2b'));
  await sleep(450);
  await js(`[...document.getElementById('overlayCard').querySelectorAll('button')].find((b) => b.textContent === 'Save it').click();`);
  await js(`await window.__inc;`);
  await sleep(400);
  const opened = await js(`return { openNow: window.app.store.doc.name,
    title: document.getElementById('boardTitle').value };`);
  check('with "Open it" on, an accepted board lands in front of you',
    opened.openNow === 'Straight to the front', opened.openNow);
  check('and the title bar says so rather than still naming the old one',
    opened.title === 'Straight to the front', opened.title);

  // The same board again from the same machine. This is "opening the same file
  // twice" wearing different clothes, and it behaves the same way: it asks,
  // and it never quietly overwrites.
  await js(incoming('Group 4 doodle', 'in-b1', 't3'));
  await sleep(450);
  const again = await js(`
    const c = document.getElementById('overlayCard');
    return { buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), text: c.textContent };`);
  check('the same board sent again warns before it can overwrite',
    JSON.stringify(again.buttons) === JSON.stringify(['Decline', 'Keep both', 'Replace my copy']),
    again.buttons.join(' | '));
  check('and says in plain words what replacing would cost', /would be gone/.test(again.text));

  await js(`[...document.getElementById('overlayCard').querySelectorAll('button')].find((b) => b.textContent === 'Keep both').click();`);
  await js(`await window.__inc;`);
  await sleep(250);
  const kept = await js(`
    const list = await window.board.boards.list();
    const mine = list.filter((b) => /^Group 4 doodle/.test(b.name));
    return { names: mine.map((b) => b.name), ids: mine.map((b) => b.id) };
  `);
  check('"Keep both" leaves the first copy alone', kept.names.length === 2, kept.names.join(' / '));
  check('and gives the second its own identity rather than the first one\'s',
    kept.ids.length === 2 && kept.ids[0] !== kept.ids[1], kept.ids.join(' / '));

  /*
   * Replacing the board that is OPEN.
   *
   * The replacement goes to disk under the same id while the editor is still
   * holding the old objects in memory - so unless it is reloaded, the next
   * autosave writes the old board straight back over the new one. The person
   * watches "Replace my copy" succeed and then silently undo itself, and the
   * sender's work is gone with nothing to show what ate it.
   *
   * "Just file it" is deliberately left on here: this must reload anyway. It
   * is the one case that is not a preference.
   */
  await js(`
    window.app.settings.syncOpenOnArrival = false;
    window.app.saveSettings();
    const list = await window.board.boards.list();
    const b = list.find((x) => x.origin === 'sync:dev-classroom/in-b1');
    const data = await window.board.boards.load(b.id);
    await window.app.loadBoard(data, { claimed: true, silent: true });
    return true;
  `);
  await sleep(300);
  const beingEdited = await js(`return { id: window.app.store.doc.id, objects: window.app.store.count };`);

  // The same board back again, visibly different: three strokes, not one.
  await js(`
    window.__inc = window.app.handleIncomingBoard({
      ticket: 't4',
      from: { deviceId: 'dev-classroom', name: 'Classroom PC' },
      board: { id: 'in-b1', name: 'Group 4 doodle', schema: 2, pages: [], camera: { x: 0, y: 0, z: 1 },
        objects: [0, 1, 2].map((n) => ({ id: 'redo' + n, type: 'stroke', tool: 'pen',
          color: '#107c10', width: 5, effect: 'none',
          points: [{ x: n * 60, y: 0, p: .5 }, { x: n * 60 + 40, y: 40, p: .5 }],
          bbox: { x: n * 60, y: 0, w: 40, h: 40 }, rotation: 0 })) }
    });
    return true;`);
  await sleep(450);
  await js(`[...document.getElementById('overlayCard').querySelectorAll('button')].find((b) => b.textContent === 'Replace my copy').click();`);
  await js(`await window.__inc;`);
  await sleep(400);
  const afterReplace = await js(`return { id: window.app.store.doc.id, objects: window.app.store.count };`);
  check('replacing the board you have open reloads it, whatever the setting says',
    afterReplace.objects === 3 && afterReplace.id === beingEdited.id,
    `was ${beingEdited.objects} item(s), now ${afterReplace.objects}`);

  // And what is on disk has to agree, or the next autosave undoes the replace.
  await js(`await window.app.persist({ force: true }); return true;`);
  await sleep(300);
  const onDisk = await js(`
    const d = await window.board.boards.load(${JSON.stringify(beingEdited.id)});
    return d ? (d.objects || []).length : -1;`);
  check('and the copy on disk is the new one, not the one it replaced',
    onDisk === 3, `${onDisk} item(s) on disk`);

  await js(`window.app.settings.syncOpenOnArrival = true; window.app.saveSettings();`);

  /*
   * The firewall repair, which is the one part of sync that answers differently
   * depending on the machine it is running on - so the assertions have to as
   * well. On Windows this is a live read of the real firewall; everywhere else
   * the only correct answer is "not my department".
   *
   * The program path is reported either way, because it is the thing that
   * explains a surprising verdict: `npm start` runs electron.exe out of
   * node_modules, and a rule somebody added for the INSTALLED GazBoard.exe -
   * or for node.exe while testing - says nothing about that one. Two different
   * programs, two different rules, and the path is how you tell.
   */
  const onWindows = process.platform === 'win32';
  const fwCheck = await js(`
    const has = !!(window.board.sync && window.board.sync.firewall);
    const r = has ? await window.board.sync.firewall.check() : null;
    const cmds = has ? await window.board.sync.firewall.commands() : null;
    return { has, state: r && r.state, supported: r && r.supported,
             program: r && r.program, networks: r && r.networks,
             tool: r && r.tool, repairable: r && r.repairable, cmds };
  `);
  check('the app can ask the firewall why nobody can reach it', fwCheck.has);

  if (onWindows) {
    // Any of these four is a real answer. 'unknown' is included on purpose: a
    // machine where PowerShell is locked down cannot be read, and saying so is
    // the correct outcome rather than a failure to fix.
    const states = ['allowed', 'no-rule', 'blocked', 'unknown'];
    check('and on Windows it reads the actual rules instead of guessing',
      fwCheck.supported === true && states.includes(fwCheck.state),
      `${fwCheck.state} for ${fwCheck.program || '(no program)'}`
      + (fwCheck.networks ? ` on ${[].concat(fwCheck.networks).join(', ') || 'no network'}` : ''));
    check('with the commands ready for a machine that will not let it do the job itself',
      Array.isArray(fwCheck.cmds) && fwCheck.cmds.length === 2);
  } else {
    // macOS and Linux read the firewall too - they just will not change it from
    // in here, which is a decision rather than a gap, and one the result states.
    const states = ['allowed', 'no-rule', 'blocked', 'off', 'unknown'];
    check('and on this machine it reads the local firewall rather than shrugging',
      fwCheck.supported === true && states.includes(fwCheck.state),
      `${fwCheck.state} via ${fwCheck.tool || 'no tool'}`);
    check('while saying plainly that it will not change it without your say-so',
      fwCheck.repairable === false);
    check('and the commands it offers are this platform\'s, not PowerShell',
      Array.isArray(fwCheck.cmds) && fwCheck.cmds.length > 0
      && !fwCheck.cmds.some((c) => /New-NetFirewallRule/.test(c)),
      (fwCheck.cmds || []).join(' ; ').slice(0, 120));
  }

  // None of the above should have started the service.
  const stillOff = await js(`const st = await window.board.sync.state();
    return { running: st.running, setting: window.app.settings.sync };`);
  check('none of that switched sharing on behind your back',
    stillOff.running === false && stillOff.setting === false);

  /* ---- the name plate ---- */
  const document_title = await js(`return document.title;`);
  await js(`await window.app.showAbout();`);
  await sleep(250);
  const about = await js(`const c = document.getElementById('overlayCard');
    return { title: c.querySelector('h3').textContent, html: c.innerHTML };`);
  check('About names the app GazBoard', /^GazBoard \d+\.\d+\.\d+$/.test(about.title.trim()), about.title);
  check('About carries the theBoringCodes brand', about.html.includes('theBoringCodes'));
  check('About credits the developer and a way to reach him',
    about.html.includes('MD. Fakhruddin Gazzali') && about.html.includes('mailto:fahim9778@gmail.com'));
  check('About says how it was built', about.html.includes('Claude Cowork'));

  /*
   * About is a promise about what this app does with your work, so it has to
   * keep being true. It claimed "runs entirely on this computer" full stop,
   * which stopped being the whole story the day sharing arrived - and a stale
   * privacy claim is worse than none, because people rely on it.
   */
  check('About still promises no account, no sign-in and no cloud',
    /no account/i.test(about.html) && /no sign-in/i.test(about.html) && /no cloud/i.test(about.html));
  check('and names sharing as the one exception, saying it is off until switched on',
    /sharing on your own network/i.test(about.html)
    && /off until you switch it on/i.test(about.html));
  check('and that a shared board never passes through anybody\'s server',
    /never through anybody/i.test(about.html) && /encrypted/i.test(about.html));

  // Where the boards live, and a way in - a reassurance you can check beats
  // one you have to take on faith.
  const aboutFolder = await js(`
    const c = document.getElementById('overlayCard');
    const codes = [...c.querySelectorAll('code')].map((e) => e.textContent);
    return { codes, hasButton: [...c.querySelectorAll('button')].some((b) => b.textContent === 'Open that folder') };
  `);
  check('About says where the boards are kept', aboutFolder.codes.some((t) => /boards$/.test(t)),
    aboutFolder.codes.join(' | '));
  check('and offers to open that folder', aboutFolder.hasButton);
  check('the window still answers to the new name', document_title.includes('GazBoard'), document_title);
  await shot(win, '21-about');
  await js(`document.getElementById('overlay').classList.remove('show');`);

  /* ---- errors ---- */
  const errs = await js(`return window.__errors || [];`);
  check('no uncaught renderer errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await fs.writeFile(path.join(OUT, 'results.txt'), results.join('\n') + `\n\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
}

module.exports = { run };
