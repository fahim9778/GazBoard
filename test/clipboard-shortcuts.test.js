'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

let exposed = null;
const ipcHandlers = new Map();
const domHandlers = new Map();
let clipboardState = { formats: ['text/plain'], text: 'older system clipboard', image: Buffer.alloc(0) };

const fakeElectron = {
  contextBridge: {
    exposeInMainWorld(name, api) {
      if (name === 'board') exposed = api;
    }
  },
  ipcRenderer: {
    invoke: async () => null,
    send: () => {},
    on(channel, fn) { ipcHandlers.set(channel, fn); }
  },
  clipboard: {
    availableFormats: () => [...clipboardState.formats],
    readText: () => clipboardState.text,
    readImage: () => ({
      isEmpty: () => clipboardState.image.length === 0,
      toPNG: () => clipboardState.image
    })
  }
};

const originalLoad = Module._load;
const originalWindow = global.window;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

global.window = {
  addEventListener(type, fn) { domHandlers.set(type, fn); }
};

const preloadPath = path.resolve(__dirname, '..', 'preload.js');
delete require.cache[preloadPath];
require(preloadPath);

assert(exposed, 'preload must expose window.board');
const commands = [];
exposed.onMenu((id) => commands.push(id));

Module._load = originalLoad;
global.window = originalWindow;

const keydown = domHandlers.get('keydown');
assert(keydown, 'preload must install the clipboard shortcut guard');

function keyEvent(key, opts = {}) {
  let prevented = false;
  let stopped = false;
  const event = {
    key,
    ctrlKey: opts.ctrlKey !== false,
    metaKey: !!opts.metaKey,
    altKey: !!opts.altKey,
    target: opts.target || { tagName: 'CANVAS', isContentEditable: false },
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; }
  };
  keydown(event);
  return { prevented, stopped };
}

// A GazBoard copy must own the next paste while the OS clipboard is unchanged.
let e = keyEvent('c');
assert.deepStrictEqual(commands, ['edit.copy']);
assert(e.prevented && e.stopped, 'GazBoard copy must suppress the native copy path');

e = keyEvent('v');
assert.deepStrictEqual(commands, ['edit.copy', 'edit.paste']);
assert(e.prevented && e.stopped, 'GazBoard object paste must suppress the native paste path');

// The main-process accelerator may report the same keypress too. It must not
// turn one physical shortcut into two copy/paste operations.
const menuCommand = ipcHandlers.get('menu:command');
assert(menuCommand, 'preload must listen for application-menu commands');
menuCommand({}, 'edit.paste');
assert.deepStrictEqual(commands, ['edit.copy', 'edit.paste']);

// If another app changes the OS clipboard after the GazBoard copy, external
// text/image paste wins and the DOM paste handler is allowed to receive it.
clipboardState = { formats: ['text/plain'], text: 'copied outside GazBoard', image: Buffer.alloc(0) };
e = keyEvent('v');
assert.deepStrictEqual(commands, ['edit.copy', 'edit.paste']);
assert(!e.prevented && !e.stopped, 'changed OS clipboard must be left to native paste');

// Cmd works the same way as Ctrl, and Cut becomes the new internal clipboard.
clipboardState = { formats: ['text/plain'], text: 'still external', image: Buffer.alloc(0) };
e = keyEvent('x', { ctrlKey: false, metaKey: true });
assert.strictEqual(commands.at(-1), 'edit.cut');
assert(e.prevented && e.stopped);
e = keyEvent('v', { ctrlKey: false, metaKey: true });
assert.strictEqual(commands.at(-1), 'edit.paste');
assert(e.prevented && e.stopped);

// Image identity is based on the PNG bytes, not just dimensions/format. Two
// screenshots can be the same size while containing completely different data;
// the newer external image must still beat an older GazBoard object copy.
clipboardState = { formats: ['image/png'], text: '', image: Buffer.from([1, 2, 3, 4]) };
e = keyEvent('c');
assert.strictEqual(commands.at(-1), 'edit.copy');
assert(e.prevented && e.stopped);
const beforeChangedImagePaste = commands.length;
clipboardState = { formats: ['image/png'], text: '', image: Buffer.from([4, 3, 2, 1]) };
e = keyEvent('v');
assert.strictEqual(commands.length, beforeChangedImagePaste);
assert(!e.prevented && !e.stopped, 'different same-size image data must be left to native paste');

// Native text editing must retain the operating system's copy/paste behavior.
const beforeEditable = commands.length;
e = keyEvent('c', { target: { tagName: 'TEXTAREA', isContentEditable: false } });
assert.strictEqual(commands.length, beforeEditable);
assert(!e.prevented && !e.stopped);

console.log('clipboard-shortcuts: ok');
