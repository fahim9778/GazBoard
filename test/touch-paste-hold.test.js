'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const mod = await import(pathToFileURL(path.resolve(__dirname, '..', 'src/js/ui/blank-paste-gesture.js')).href);
  const { installBlankPasteGesture, BLANK_PASTE_TIMING } = mod;

  function harness({ platform = '', hit = null } = {}) {
    const handlers = new Map();
    const scheduled = new Map();
    let nextTimer = 1;
    let now = 1000;
    const canvas = { tagName: 'CANVAS' };
    const events = [];
    const app = {
      tool: 'select',
      surface: {
        canvas,
        toWorld: ({ clientX, clientY }) => ({ x: clientX, y: clientY })
      },
      pickAt: () => hit,
      interaction: { cancelGesture() { events.push('cancel'); return true; } },
      setSelection(ids) { events.push(['selection', ids]); }
    };
    const host = {
      addEventListener(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      }
    };
    const fire = (type, e) => {
      for (const fn of handlers.get(type) || []) fn(e);
    };
    const schedule = (fn, ms) => {
      const id = nextTimer++;
      scheduled.set(id, { fn, ms, cancelled: false });
      return id;
    };
    const cancelSchedule = (id) => { if (scheduled.has(id)) scheduled.get(id).cancelled = true; };
    const runTimers = () => {
      for (const task of [...scheduled.values()]) if (!task.cancelled) task.fn();
      scheduled.clear();
    };
    installBlankPasteGesture({
      host,
      documentRoot: () => ({ dataset: { platform } }),
      getApp: () => app,
      showMenu: (_app, e) => events.push(['menu', e.clientX, e.clientY, e.pointerType]),
      schedule,
      cancelSchedule,
      clock: () => now
    });
    return { app, canvas, events, scheduled, fire, runTimers, setNow: (value) => { now = value; } };
  }

  // Select is intentionally used here: the gesture must not depend on the
  // active tool or on Interaction having chosen a particular action type.
  let h = harness();
  h.fire('pointerdown', { pointerType: 'touch', button: 0, pointerId: 1, clientX: 120, clientY: 240, target: h.canvas });
  assert.strictEqual([...h.scheduled.values()][0].ms, BLANK_PASTE_TIMING.touch);
  h.runTimers();
  assert.deepStrictEqual(h.events, ['cancel', ['selection', []], ['menu', 120, 240, 'touch']]);

  // A stylus gets the longer writing-friendly delay, and Windows' own
  // press-and-hold contextmenu is suppressed while GazBoard's hold is armed.
  h = harness();
  h.fire('pointerdown', { pointerType: 'pen', button: 0, pointerId: 2, clientX: 90, clientY: 70, target: h.canvas });
  assert.strictEqual([...h.scheduled.values()][0].ms, BLANK_PASTE_TIMING.pen);
  let prevented = false, stopped = false;
  h.fire('contextmenu', {
    clientX: 90, clientY: 70,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; }
  });
  assert.ok(prevented && stopped, 'native pen context menu must not race the GazBoard hold');
  h.runTimers();
  assert.deepStrictEqual(h.events.at(-1), ['menu', 90, 70, 'pen']);

  // Movement turns the gesture back into ordinary pan/draw/select work.
  h = harness();
  h.fire('pointerdown', { pointerType: 'touch', button: 0, pointerId: 3, clientX: 10, clientY: 10, target: h.canvas });
  h.fire('pointermove', { pointerId: 3, clientX: 10 + BLANK_PASTE_TIMING.slop + 1, clientY: 10 });
  h.runTimers();
  assert.deepStrictEqual(h.events, []);

  // Objects keep their existing long-press select/move behavior.
  h = harness({ hit: { id: 'note-1' } });
  h.fire('pointerdown', { pointerType: 'touch', button: 0, pointerId: 4, clientX: 30, clientY: 30, target: h.canvas });
  assert.strictEqual(h.scheduled.size, 0);

  // Android already owns this gesture in its adapter; the desktop helper must
  // not install a second competing hold there.
  h = harness({ platform: 'android' });
  h.fire('pointerdown', { pointerType: 'pen', button: 0, pointerId: 5, clientX: 20, clientY: 20, target: h.canvas });
  assert.strictEqual(h.scheduled.size, 0);

  console.log('touch-paste-hold: ok');
})().catch((e) => { console.error(e); process.exit(1); });
