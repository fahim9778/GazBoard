'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// These fixtures use notes and strokes, whose hit tests use geometry only.
global.document = { createElement: () => ({ getContext: () => ({}) }) };

async function setup({ tool = 'pen', z = 1, editing = false, fingerInks = true, android = false } = {}) {
  document.documentElement = { dataset: { platform: android ? 'android' : 'electron' } };
  const [{ Interaction }, { Store, boundsOf }, { Camera }, { unionBox }] = await Promise.all([
    import('../src/js/core/tools.js'), import('../src/js/core/store.js'),
    import('../src/js/core/camera.js'), import('../src/js/core/util.js')
  ]);
  const store = new Store();
  for (const [id, x] of [['selected', 100], ['other', 300]]) {
    store.add({ id, type: 'note', x, y: 100, w: 100, h: 100,
      color: '#ffd94a', text: id, rotation: 0 });
  }
  const cam = new Camera();
  cam.z = z;
  const surface = {
    canvas: { style: {}, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      setPointerCapture() {}, releasePointerCapture() {} },
    cam, w: 2000, h: 2000, overlays: [], selection: new Set(['selected']), wet: null,
    screenPoint: (e) => ({ x: e.clientX, y: e.clientY }),
    selectionBounds: () => [...surface.selection].reduce((b, id) => unionBox(b, boundsOf(store.get(id))), null),
    selectionScreenBox: () => {
      const b = surface.selectionBounds();
      return b && { ...cam.toScreen(b.x, b.y), w: b.w * cam.z, h: b.h * cam.z };
    },
    selectionIsLocked: () => [...surface.selection].some((id) => store.get(id).locked),
    invalidate() {}, clampCamera() {}
  };
  const app = {
    surface, store, tool: editing ? 'select' : tool, mouseInks: true, fingerInks,
    ruler: { visible: false }, textEditor: { active: editing },
    settings: { pressure: true, penColor: '#111111', penWidth: 3, penEffect: 'none',
      highlighterColor: '#ffff00', highlighterWidth: 20, inkToShape: false },
    hideMenus() {}, notePenSeen() {}, syncUI() {}, onGestureEnd() {}, showHint() {}, hintLocked() {}, toast() {},
    syncZoom() {}, afterCamera() {}, trackCanvasMove() {},
    showContextMenu() { app.menuShown = true; },
    setSelection(ids) { surface.selection.clear(); for (const id of ids) surface.selection.add(id); },
    setTool(value) { app.tool = value; },
    armToolRestore() {},
    beginTextEdit(obj) { app.textEditor = { active: true, target: obj }; },
    commitTextEdit() {
      if (!app.textEditor.active) return;
      app.textEditor.active = false;
      // TextEditor's afterTextEdit callback clears the selection and restores ink.
      app.setSelection([]);
      app.tool = tool;
    }
  };
  const interaction = new Interaction(app);
  // Rendering a cursor needs a DOM; leave the actual gesture and store paths intact.
  interaction.showInkPointer = () => {};
  const pointer = (type, x = 500, y = 300, buttons = 1) => ({
    pointerId: 1, pointerType: type, button: 0, buttons, pressure: .5,
    clientX: x * z, clientY: y * z
  });
  const tap = (type, x, y) => {
    interaction.onDown(pointer(type, x, y));
    interaction.onUp(pointer(type, x, y, 0));
  };
  return { app, surface, store, interaction, pointer, tap };
}

for (const type of ['pen', 'touch', 'mouse']) {
  for (const tool of ['pen', 'highlighter']) {
    test(`${type} tap outside a selection dismisses it without ink or undo (${tool})`, async () => {
      const { surface, store, tap } = await setup({ tool });
      const before = store.count, undo = store.undoStack.length;
      tap(type);
      assert.equal(store.count, before);
      assert.equal(store.undoStack.length, undo);
      assert.equal(surface.selection.size, 0);
      assert.equal(surface.wet, null);
      // Dismissal consumes just that tap: an intentional full stop still works.
      tap(type);
      assert.equal(store.count, before + 1);
    });

    test(`${type} tap that finishes text editing does not become ${tool} ink`, async () => {
      const { app, surface, store, tap } = await setup({ tool, editing: true });
      const before = store.count, undo = store.undoStack.length;
      tap(type);
      assert.equal(app.textEditor.active, false);
      assert.equal(app.tool, tool);
      assert.equal(store.count, before);
      assert.equal(store.undoStack.length, undo);
      assert.equal(surface.selection.size, 0);
      assert.equal(surface.wet, null);
    });
  }
}

for (const z of [.5, 1, 2]) {
  test(`Tap slop is measured on screen at ${z}x; a real stroke still draws`, async () => {
    const { store, surface, interaction, pointer } = await setup({ z });
    const before = store.count;
    interaction.onDown(pointer('pen'));
    interaction.applyMotion({ x: 500 * z + 3, y: 300 * z });
    interaction.onUp(pointer('pen', 500 + 3 / z, 300, 0));
    assert.equal(store.count, before);
    assert.equal(surface.selection.size, 0);

    surface.selection.add('selected');
    interaction.onDown(pointer('pen'));
    interaction.applyMotion({ x: 500 * z + 12, y: 300 * z });
    interaction.onUp(pointer('pen', 500 + 12 / z, 300, 0));
    assert.equal(store.count, before + 1);
    assert.ok(store.objects.at(-1).bbox.w * z > 4);
  });
}

test('A stylus can still dot the selected object; tapping another object only dismisses', async () => {
  const { store, surface, tap } = await setup();
  const before = store.count;
  tap('pen', 150, 150);
  assert.equal(store.count, before + 1);
  tap('pen', 350, 150);
  assert.equal(store.count, before + 1);
  assert.equal(surface.selection.size, 0);
});

test('A finger can still tap another note to edit it without ink', async () => {
  const { app, store, tap } = await setup();
  const before = store.count;
  tap('touch', 350, 150);
  assert.equal(store.count, before);
  assert.equal(app.textEditor.target.id, 'other');
});

test('Finger panning still dismisses the selection without ink', async () => {
  const { store, surface, interaction, pointer } = await setup({ fingerInks: false });
  const before = store.count;
  interaction.onDown(pointer('touch'));
  assert.equal(interaction.action.type, 'pan');
  interaction.applyMotion({ x: 525, y: 320 });
  interaction.onUp(pointer('touch', 525, 320, 0));
  assert.deepEqual({ x: surface.cam.x, y: surface.cam.y }, { x: 25, y: 20 });
  assert.equal(store.count, before);
  assert.equal(surface.selection.size, 0);
});

test('Visible selection handles keep their resize gesture with the pen chosen', async () => {
  const { interaction, pointer, store } = await setup();
  const before = store.count;
  interaction.onDown(pointer('pen', 200, 200));
  assert.equal(interaction.action.type, 'resize');
  interaction.onUp(pointer('pen', 200, 200, 0));
  assert.equal(store.count, before);
});

test('A handle survives committing an active text edit and owns the resize', async () => {
  const { app, interaction, pointer, store } = await setup({ editing: true });
  interaction.onDown(pointer('touch', 200, 200));
  assert.equal(app.textEditor.active, false);
  assert.equal(interaction.action.type, 'resize');
  assert.equal(interaction.actionId, 1);
  interaction.applyMotion({ x: 240, y: 240 });
  interaction.onUp(pointer('touch', 240, 240, 0));
  assert.equal(store.get('selected').w, 140);
  assert.equal(store.get('selected').h, 140);
});

// A desktop stylus is excluded on purpose: a pen resting still is somebody
// lining up a letter. On Android the pen has no other way to reach an object.
for (const android of [false, true]) for (const type of ['touch', 'pen']) for (const fingerInks of [true, false]) {
  const wait = type === 'pen' ? 701 : 451;   // a stylus waits longer than a finger
  test(`Holding ${type} for ${wait}ms, finger ink ${fingerInks}, selects with Android ${android} menu behavior`, async (t) => {
    const { app, interaction, pointer, store, surface } = await setup({ fingerInks, android });
    surface.selection.clear();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const before = store.count, undo = store.undoStack.length;
    interaction.onDown(pointer(type, 150, 150));
    t.mock.timers.tick(wait - 200);
    // A stylus is still writing at this point - its hold is the longer one.
    if (type === 'pen') assert.equal(interaction.action.type, 'draw');
    t.mock.timers.tick(200);
    assert.equal(!!app.menuShown, !android);
    assert.equal(app.tool, 'pen');
    assert.equal(interaction.action.type, 'move');
    interaction.onUp(pointer(type, 150, 150, 0));
    assert.equal(store.count, before);
    assert.equal(store.undoStack.length, undo);
    assert.deepEqual([...surface.selection], ['selected']);
    assert.equal(surface.wet, null);
  });
}

for (const tool of ['pen', 'highlighter']) for (const fingerInks of [true, false]) {
  test(`Moving the stylus cancels hold selection during ${tool} ink (finger ink ${fingerInks})`, async (t) => {
    const { app, interaction, pointer, store, surface } = await setup({ tool, fingerInks });
    surface.selection.clear();
    const before = store.count, undo = store.undoStack.length;
    const note = structuredClone(store.get('selected'));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    interaction.onDown(pointer('pen', 150, 150));
    interaction.onMove(pointer('pen', 170, 165));
    t.mock.timers.tick(1000);           // pausing mid-stroke must not select
    assert.notEqual(app.menuShown, true);
    assert.equal(app.tool, tool);
    assert.equal(interaction.action.type, 'draw');
    assert.ok(surface.wet);
    assert.equal(surface.selection.size, 0);
    interaction.onUp(pointer('pen', 170, 165, 0));
    assert.equal(store.count, before + 1);
    assert.equal(store.undoStack.length, undo + 1);
    const stroke = store.objects.at(-1);
    assert.equal(stroke.type, 'stroke');
    assert.equal(stroke.tool, tool);
    assert.ok(stroke.points.length > 1 && stroke.bbox.w > 4);
    assert.deepEqual(store.get('selected'), note);
    assert.equal(surface.selection.size, 0);
    assert.equal(surface.wet, null);
  });
}

test('A palm lifting does not cancel the stylus hold selection', async (t) => {
  const { app, interaction, pointer, store, surface } = await setup({ android: true });
  surface.selection.clear();
  const before = store.count;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  interaction.onDown(pointer('pen', 150, 150));
  interaction.onDown({ ...pointer('touch', 500, 300), pointerId: 2 });
  interaction.onUp({ ...pointer('touch', 500, 300, 0), pointerId: 2 });
  t.mock.timers.tick(701);
  assert.deepEqual([...surface.selection], ['selected']);
  interaction.onUp(pointer('pen', 150, 150, 0));
  assert.equal(store.count, before);
  assert.equal(surface.wet, null);
});

for (const type of ['touch', 'pen', 'mouse']) {
  test(`Android suppresses the delayed ${type} context menu after release`, async () => {
    const { app, interaction, surface } = await setup({ android: true });
    interaction._lastDownType = type;
    interaction.action = null;
    let prevented = false;
    surface.canvas.listeners.contextmenu({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.notEqual(app.menuShown, true);
  });
}

/*
 * A second finger landing mid-gesture used to jam the board.
 *
 * Both of the lifts that end a pinch leave onUp through an early return, so
 * nothing cleared the name of the finger that had owned the gesture before the
 * pinch began. The board was then listening to a finger that was no longer on
 * the glass: pressing the ruler took the press and moved nothing, and it stayed
 * that way until you drew something, because drawing is the one path that names
 * a new owner. Which is exactly how it was reported - "can't move the ruler
 * unless I draw something first".
 */
function withRuler(app) {
  app.ruler = { visible: true, x: 300, y: 300, angle: 0, length: 900, thickness: 78, snap: true };
}

const finger = (id, x, y, buttons = 1) => ({ pointerId: id, pointerType: 'touch',
  button: 0, buttons, pressure: 0.5, clientX: x, clientY: y });

test('a pinch that interrupts a press does not leave the board owned by a lifted finger', async (t) => {
  const { app, interaction } = await setup({ android: true });
  withRuler(app);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  interaction.onDown(finger(1, 150, 150));       // finger A presses an object
  interaction.onDown(finger(2, 900, 700));       // finger B arrives: pinch
  t.mock.timers.tick(900);
  interaction.onUp(finger(2, 900, 700, 0));
  interaction.onUp(finger(1, 150, 150, 0));
  assert.equal(interaction.action, null);
  assert.equal(interaction.actionId, null, 'the lifted finger must not still own the board');
});

test('and the ruler still moves straight afterwards, with nothing drawn in between', async (t) => {
  const { app, surface, interaction } = await setup({ android: true });
  withRuler(app);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  interaction.onDown(finger(1, 150, 150));
  interaction.onDown(finger(2, 900, 700));
  t.mock.timers.tick(900);
  interaction.onUp(finger(2, 900, 700, 0));
  interaction.onUp(finger(1, 150, 150, 0));

  const grip = surface.cam.toScreen(app.ruler.x, app.ruler.y + app.ruler.thickness / 2);
  assert.equal(interaction.rulerZone(grip), 'move');
  interaction.onDown(finger(3, grip.x, grip.y));
  assert.equal(interaction.action.type, 'rulerMove');
  assert.equal(interaction.actionId, 3, 'the ruler owns the finger that grabbed it');
  interaction.onMove(finger(3, grip.x + 120, grip.y + 60));
  assert.equal(Math.round(app.ruler.x), 420);
  assert.equal(Math.round(app.ruler.y), 360);
  interaction.onUp(finger(3, grip.x + 120, grip.y + 60, 0));
  assert.equal(interaction.action, null);
});

test('a palm on the glass neither drags the ruler nor ends the drag', async (t) => {
  const { app, surface, interaction } = await setup({ android: true });
  withRuler(app);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const grip = surface.cam.toScreen(app.ruler.x, app.ruler.y + app.ruler.thickness / 2);
  interaction.onDown(finger(1, grip.x, grip.y));
  interaction.onMove(finger(1, grip.x + 60, grip.y));
  const after = { x: app.ruler.x, y: app.ruler.y };
  interaction.onMove(finger(9, grip.x + 400, grip.y + 400));   // a palm, elsewhere
  assert.deepEqual({ x: app.ruler.x, y: app.ruler.y }, after, 'the palm must not move it');
  interaction.onUp(finger(9, grip.x + 400, grip.y + 400, 0));
  assert.equal(interaction.action?.type, 'rulerMove', 'the palm lifting must not end the drag');
  interaction.onMove(finger(1, grip.x + 120, grip.y + 60));
  assert.equal(Math.round(app.ruler.x), 420);
  interaction.onUp(finger(1, grip.x + 120, grip.y + 60, 0));
  assert.equal(interaction.action, null);
});


/*
 * The invariant behind all of this: when the last finger leaves the glass,
 * nothing is in flight.
 *
 * Every jam in this area has been the same shape - some gesture, or just the
 * NAME of the finger that owned one, outliving the finger itself, after which
 * the board accepts presses and ignores them. Rather than chase the orderings
 * one at a time, shuffle them: three fingers, presses, moves, lifts and
 * cancels in every order, on and off the ruler, with the press-and-hold timer
 * going off in the middle. However the shuffle comes out, the board has to be
 * idle once everybody has let go.
 */
test('no ordering of presses, lifts and pinches leaves the board holding a gesture', async () => {
  const { app, interaction } = await setup({ android: true });
  app.ruler = { visible: true, x: 300, y: 300, angle: 0, length: 900, thickness: 78, snap: true };
  interaction.setCursor = () => {};
  interaction.updateHover = () => {};

  // Fire the hold timer almost at once so it takes part in the shuffle.
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms > 5 ? 1 : ms, ...rest);
  const settle = () => new Promise((r) => realTimeout(r, 4));

  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pickOne = (a) => a[Math.floor(rnd() * a.length)];
  const ev = (p, buttons) => ({ pointerId: p.id, pointerType: p.type, button: 0,
    buttons, pressure: buttons ? 0.5 : 0, clientX: p.x, clientY: p.y });

  try {
    for (let trial = 0; trial < 400; trial++) {
      interaction.action = null; interaction.actionId = null;
      interaction.pinch = null; interaction.secondaryPan = null;
      interaction.pointers.clear(); interaction.cancelHold();
      const down = [];
      let id = 1;
      for (let step = 0; step < 3 + Math.floor(rnd() * 6); step++) {
        const what = pickOne(['down', 'down', 'move', 'up', 'up', 'cancel']);
        if (what === 'down' && down.length < 3) {
          // 300,340 and 340,300 are on the ruler; the rest is bare board.
          const p = { id: id++, type: pickOne(['touch', 'touch', 'pen']),
            x: pickOne([300, 340, 700, 1300]), y: pickOne([300, 340, 700, 1300]) };
          down.push(p);
          interaction.onDown(ev(p, 1));
        } else if (what === 'move' && down.length) {
          const p = pickOne(down); p.x += 40; p.y += 25;
          interaction.onMove(ev(p, 1));
        } else if (down.length) {
          if (rnd() < 0.4) await settle();
          interaction.onUp(ev(down.splice(Math.floor(rnd() * down.length), 1)[0], 0));
        }
      }
      await settle();
      for (const p of down.splice(0)) interaction.onUp(ev(p, 0));

      const left = { action: interaction.action?.type ?? null, actionId: interaction.actionId,
        pinch: !!interaction.pinch, pan: !!interaction.secondaryPan, pointers: interaction.pointers.size };
      assert.deepEqual(left, { action: null, actionId: null, pinch: false, pan: false, pointers: 0 },
        `trial ${trial} left something behind`);
    }
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});
