'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// These fixtures use notes and strokes, whose hit tests use geometry only.
global.document = { createElement: () => ({ getContext: () => ({}) }) };

async function setup({ tool = 'pen', z = 1, editing = false, fingerInks = true } = {}) {
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
    canvas: { addEventListener() {}, setPointerCapture() {} },
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

for (const [type, fingerInks] of [['touch', true], ['touch', false], ['pen', true]]) {
  test(`Holding ${type}, finger ink ${fingerInks}, opens object actions while keeping the pen`, async (t) => {
    const { app, interaction, pointer, store, surface } = await setup({ fingerInks });
    surface.selection.clear();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const before = store.count;
    interaction.onDown(pointer(type, 150, 150));
    t.mock.timers.tick(451);
    assert.equal(app.menuShown, true);
    assert.equal(app.tool, 'pen');
    assert.equal(interaction.action.type, 'move');
    interaction.onUp(pointer(type, 150, 150, 0));
    assert.equal(store.count, before);
    assert.deepEqual([...surface.selection], ['selected']);
    assert.equal(surface.wet, null);
  });
}
