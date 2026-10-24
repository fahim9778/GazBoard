'use strict';
/*
 * Store screenshots: the pictures for Google Play and F-Droid, made from the
 * real app at phone and tablet size. Run it, then copy what it writes in
 * test/store/ into fastlane/metadata/android/en-US/images/.
 *
 *   GAZBOARD_TEST=./test/store-shots.js npx electron . --smoke
 */
const path = require('node:path'), fs = require('node:fs/promises');
const OUT = path.join(__dirname, 'store');

async function run(win, app) {
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(`(async()=>{${c}})()`, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await fs.mkdir(OUT, { recursive: true });

  // a phone: 360 x 640 points at 3x is 1080 x 1920, touch first; a tablet: 1280 x 720 at 1.5x is 1920 x 1080
  const sizes = {
    phone: { w: 360, h: 640, dpr: 3, touch: true },
    tablet: { w: 1280, h: 720, dpr: 1.5, touch: true }
  };
  const which = (process.env.GAZBOARD_STORE_SIZES || 'phone,tablet').split(',');
  try { wc.debugger.attach('1.3'); } catch { /* already attached */ }
  for (const kind of which) {
    const s = sizes[kind];
    win.setContentSize(s.w, s.h);
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: s.dpr, mobile: kind === 'phone' });
    await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: s.touch, maxTouchPoints: 5 });
    await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: s.touch, configuration: kind === 'phone' ? 'mobile' : 'desktop' });
    wc.reload();
    await new Promise((r) => wc.once('did-finish-load', r));
    await sleep(2500);
    await js(`window.app.settings.theme = 'light'; window.app.applyTheme(); document.querySelectorAll('.hint').forEach((e) => e.remove());`);
    const shot = async (n) => {
      await js(`document.querySelectorAll('.toast, .hint').forEach((e) => e.remove()); const p = document.getElementById('zoomPill'); if (p) p.style.display = 'none';`);
      await sleep(250);
      const shotData = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(OUT, `${kind}-${n}.png`), Buffer.from(shotData.data, 'base64'));
    };
    await js(SCENE_HELPERS);
    for (const [name, code] of SCENES) {
      await js(code.replace(/__KIND__/g, kind));
      // a fresh board settles its camera a moment later; look again once it has
      await sleep(700);
      await js(`window.P.again && window.P.again();`);
      await sleep(500);
      await shot(name);
    }
  }
  console.log('store shots done');
  app.exit(0);
}

const SCENE_HELPERS = `
  window.P = {};
  P.rnd = (() => { let s = 11; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  P.bbox = (pts) => { let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for (const p of pts){x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);} return { x:x0, y:y0, w:x1-x0, h:y1-y0 }; };
  P.curve = (pts, jitter = 1.2) => { const out = []; const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
    for (let i = 0; i < pts.length - 1; i++) { const p0 = at(i-1), p1 = at(i), p2 = at(i+1), p3 = at(i+2);
      for (let t = 0; t < 1; t += 0.04) { const t2 = t*t, t3 = t2*t;
        const x = 0.5*((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3);
        const y = 0.5*((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3);
        out.push({ x: x + (P.rnd()-.5)*jitter, y: y + (P.rnd()-.5)*jitter, p: 0.5 + 0.22*Math.sin(t*4+i) }); } }
    const l = pts[pts.length-1]; out.push({ x: l[0], y: l[1], p: 0.5 }); return out; };
  P.arc = (cx, cy, rx, ry, from = 0, to = 6.5, jitter = 1.2) => { const out = []; for (let a = from; a <= to; a += 0.06) out.push({ x: cx + Math.cos(a) * rx + (P.rnd()-.5)*jitter, y: cy + Math.sin(a) * ry + (P.rnd()-.5)*jitter, p: 0.5 + 0.25*Math.sin(a*2) }); return out; };
  let n = 0;
  P.stroke = (pts, color, width, hl) => window.app.store.add({ id: 'k' + (n++), type: 'stroke', tool: hl ? 'highlighter' : 'pen', color, width, effect: 'none', opacity: hl ? 0.38 : 1, points: pts, rotation: 0, bbox: P.bbox(pts) });
  P.text = (x, y, w, s, size, color, font) => window.app.store.add({ id: 't' + (n++), type: 'text', x, y, w, h: size * 1.5, text: s, fontSize: size, color, align: 'left', valign: 'top', rotation: 0, font: font || 'hand', background: 'none' });
  P.note = (x, y, w, color, s) => window.app.store.add({ id: 'n' + (n++), type: 'note', x, y, w, h: w, color, text: s, rotation: 0, align: 'center', font: 'hand' });
  P.shape = (o) => window.app.store.add(Object.assign({ id: 's' + (n++), type: 'shape', rotation: 0, stroke: '#201f1e', fill: 'none', lineWidth: 2.5 }, o));
  P.reset = async (pattern, name, paper) => { const a = window.app; if (a.viewMode) a.toggleViewMode(false); a.pageStrip?.toggle(false); a.newBoard(true);
    a.store.setBackground({ pattern: pattern || 'none' }); if (paper) await a.setPageSize(paper, 'portrait');
    a.setTool('pen'); a.setSelection([]); if (name) { a.store.rename(name); document.getElementById('boardTitle').value = name; } };
  // look at this part of the world: as large as the screen allows, centred, the toolbars kept clear
  P.look = (b, pad = 0.04) => { P.again = () => P.look(b, pad); const sf = window.app.surface, W = sf.width, H = sf.height - (W < 600 ? 150 : 90), top = W < 600 ? 50 : 50;
    const z = Math.min(W / (b.w * (1 + pad * 2)), H / (b.h * (1 + pad * 2)));
    sf.cam.z = z; sf.cam.x = W / 2 - (b.x + b.w / 2) * z; sf.cam.y = top + H / 2 - (b.y + b.h / 2) * z; window.app.syncUI(); sf.invalidate(); };
  // a page on a phone: its full width, from the top; on a tablet the whole page
  P.lookPage = (s) => { const sf = window.app.surface; if (sf.width < 600) P.look({ x: s.x, y: s.y, w: s.w, h: s.w * (sf.height - 150) / sf.width }, 0); else P.look(s, 0.02); };
  P.sheet = async (i = 0) => (await import('app://board/js/core/pages.js')).pageRects(window.app.store.doc.pages)[i];
`;

const SCENES = [
  ['1-lecture', `
    const a = window.app; await P.reset('notebook', 'Shortest paths', 'a4');
    const s = await P.sheet(); const X = s.x + 120, Y = s.y + 130;
    P.text(X, Y, 560, 'Dijkstra — why greedy works', 34, '#201f1e');
    P.stroke(P.curve([[X, Y+52],[X+200, Y+49],[X+430, Y+53]]), '#e81123', 4);
    const V = { A:[X+60,Y+200], B:[X+250,Y+150], C:[X+250,Y+290], D:[X+460,Y+210] };
    for (const k in V) { const [x,y] = V[k]; P.stroke(P.arc(x, y, 30, 30), '#201f1e', 3); P.text(x - 9, y - 17, 40, k, 28, '#201f1e'); }
    const edge = (p, q, w, lx, ly) => { const [x1,y1] = V[p], [x2,y2] = V[q]; const d = Math.hypot(x2-x1, y2-y1), ux = (x2-x1)/d, uy = (y2-y1)/d;
      P.stroke(P.curve([[x1+ux*32, y1+uy*32],[x2-ux*32, y2-uy*32]]), '#0078d4', 3); P.text(lx, ly, 60, String(w), 24, '#0078d4'); };
    edge('A','B',4,X+130,Y+140); edge('A','C',2,X+120,Y+250); edge('B','D',5,X+360,Y+150); edge('C','D',8,X+370,Y+262); edge('C','B',1,X+258,Y+205);
    P.text(X, Y+370, 600, 'dist[v] = min(dist[v], dist[u] + w)', 25, '#6264a7', 'mono');
    P.stroke(P.curve([[X-4,Y+405],[X+260,Y+402],[X+520,Y+406]]), '#fff100', 24, true);
    P.note(X, Y+460, 180, '#ffd94a', 'relax every edge once');
    P.note(X+210, Y+460, 180, '#a4d4ff', 'no negative weights!');
    P.note(X+420, Y+460, 180, '#c8f0c8', 'O(E log V) with a heap');
    P.text(X, Y+690, 600, 'Q: what breaks with a negative edge?', 26, '#201f1e');
    // on a tablet, show the page strip down the side with a few more pages in it
    if (a.surface.width >= 600) { a.command('page.add'); a.command('page.add'); a.pageStrip.toggle(true); }
    P.lookPage(s);
  `],
  ['2-staff', `
    const a = window.app; await P.reset('staff', 'Music class', 'a4');
    const R = await import('app://board/js/core/render.js'); const L = R.staffLayout('staff', a.store.doc.background.spacing || 40);
    const s = await P.sheet(); const left = s.x + L.side + 70, top = s.y + L.top;
    P.text(s.x + L.side, top - 60, 500, 'Twinkle, twinkle, little star', 26, '#201f1e');
    // a treble-clef-ish swirl, then the tune: C C G G A A G
    const tune = [0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0];
    tune.forEach((step, i) => {
      const staff = Math.floor(i / 7), col = i % 7;
      const base = top + staff * L.period + L.height + L.gap;      // middle C sits a line below the staff
      const y = base - step * L.gap / 2, x = left + 40 + col * 62;
      P.shape({ kind: 'ellipse', x: x - 10, y: y - 7, w: 20, h: 14, stroke: '#201f1e', fill: '#201f1e', lineWidth: 2 });
      P.stroke(P.curve([[x + 9, y], [x + 9, y - 46]], 0.4), '#201f1e', 2.5);
      if (step === 0) P.stroke(P.curve([[x - 16, y], [x + 16, y]], 0.3), '#201f1e', 2);
      const words = ['Twin','kle','twin','kle','lit','tle','star','How','I','won','der','what','you','are'];
      P.text(x - 18, base + 26, 80, words[i], 18, '#605e5c');
    });
    for (let k = 0; k < 2; k++) P.stroke(P.curve([[left - 30, top + k * L.period - 10],[left - 18, top + k * L.period + L.height + 8],[left - 40, top + k * L.period + L.height/2],[left - 22, top + k * L.period + 20]], 0.6), '#201f1e', 3);
    P.stroke(P.curve([[left + 20, top + L.period * 2 + 30],[left + 260, top + L.period * 2 + 26],[left + 470, top + L.period * 2 + 31]]), '#fff100', 22, true);
    P.text(left + 20, top + L.period * 2 + 10, 460, 'Music staff and guitar tab paper', 22, '#201f1e');
    P.lookPage(s);
  `],
  ['3-tab', `
    const a = window.app; await P.reset('tab', 'Guitar · first riff', 'a4');
    const R = await import('app://board/js/core/render.js'); const L = R.staffLayout('tab', a.store.doc.background.spacing || 40);
    const s = await P.sheet(); const left = s.x + L.side + 70, top = s.y + L.top;
    P.text(s.x + L.side, top - 60, 500, 'Smoke riff — slow, then up to speed', 24, '#201f1e');
    const riff = [[3,0],[3,3],[3,5],[3,0],[3,3],[3,6],[3,5],[3,0],[3,3],[3,5],[3,3],[3,0]];
    riff.forEach(([string, fret], i) => { const row = Math.floor(i / 6), col = i % 6;
      P.text(left + 30 + col * 70, top + row * L.period + string * L.gap - 13, 40, String(fret), 22, '#0078d4', 'ui'); });
    P.note(s.x + s.w - 260, top + L.period * 2 + 20, 190, '#ffd94a', 'mute the low E with your palm');
    P.stroke(P.arc(left + 30 + 2 * 70 + 6, top + 3 * L.gap, 22, 18), '#e81123', 3);
    P.lookPage(s);
  `],
  ['4-plan', `
    const a = window.app; await P.reset('dots', 'Semester plan');
    P.text(20, 10, 400, 'Semester plan', 36, '#201f1e');
    P.stroke(P.curve([[22,58],[150,55],[260,59]]), '#e81123', 4);
    const notes = [['#ffd94a','wk 1–3 basics'],['#a4d4ff','wk 4–6 sorting'],['#c8f0c8','wk 7–9 greedy'],['#ffc0cb','wk 10–12 DP'],['#ffd94a','wk 13 graphs'],['#a4d4ff','a quiz each block']];
    notes.forEach(([c, t], i) => P.note(20 + (i % 2) * 190, 90 + Math.floor(i / 2) * 190, 170, c, t));
    P.look(window.app.store.contentBounds());
  `],
  ['5-view', `
    const a = window.app; await P.reset('grid', 'Revision — view only');
    P.shape({ kind: 'roundRect', x: 20, y: 80, w: 170, h: 80, fill: '#eaf3fb', stroke: '#0078d4' }); P.text(36, 104, 150, 'read input', 22, '#201f1e');
    P.shape({ kind: 'roundRect', x: 240, y: 80, w: 170, h: 80, fill: '#f3eefb', stroke: '#8764b8' }); P.text(256, 104, 150, 'sort it', 22, '#201f1e');
    P.shape({ kind: 'roundRect', x: 130, y: 230, w: 170, h: 80, fill: '#eafaea', stroke: '#107c10' }); P.text(146, 254, 150, 'greedy pick', 22, '#201f1e');
    P.shape({ kind: 'arrow', x: 192, y: 120, w: 46, h: 0, stroke: '#605e5c' });
    P.shape({ kind: 'arrow', x: 320, y: 162, w: -60, h: 66, stroke: '#605e5c' });
    P.note(20, 360, 180, '#ffd94a', 'View mode: Ctrl+Alt+V');
    P.note(230, 360, 180, '#a4d4ff', 'the highlight fades away');
    P.look(window.app.store.contentBounds());
    a.toggleViewMode(true);
    const S = a.surface.constructor; S.GHOST_HOLD = 600000;
    const pts = P.curve([[130, 312],[215, 316],[300, 311]]); a.surface.addGhost({ id: 'g', type: 'stroke', tool: 'highlighter', color: '#fff100', width: 24, effect: 'none', opacity: 0.38, points: pts, bbox: P.bbox(pts), rotation: 0 });
    a.surface.invalidate();
  `]
];

module.exports = { run };
