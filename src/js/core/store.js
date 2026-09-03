// Document model + operation log.
//
// Every mutation goes through an op ({t:'add'|'del'|'set'|'order'|'doc'}).
// Ops are (a) applied to the doc, (b) pushed onto the undo stack as a
// transaction, and (c) broadcast on the op channel. The op channel is the
// seam a future sync/collaboration layer plugs into: replaying a remote
// peer's ops through `applyRemote()` is all that is needed - nothing else
// in the app mutates the document directly.

import { uid, unionBox } from './util.js';
import { pagesFrom, pageRects } from './pages.js';

export const CLIENT_ID = uid('c');

export function emptyDoc(name = 'Untitled board') {
  return {
    id: uid('b'), name, schema: 2,
    created: Date.now(), modified: Date.now(),
    background: { color: '#ffffff', pattern: 'none', patternColor: '#c8c6c4' },
    pages: [],                     // [] = infinite canvas; [{w,h},…] = a strip of sheets
    camera: { x: 0, y: 0, z: 1 },
    objects: {},   // id -> object
    order: []      // z-order, back to front
  };
}

export class Store {
  constructor() {
    this.doc = emptyDoc();
    this.undoStack = [];
    this.redoStack = [];
    this.log = [];                 // append-only op log (for future sync)
    this._subs = new Set();
    this._opSubs = new Set();
    this._muted = 0;
    // Bumped on every mutation. The renderer uses it to tell whether a cached
    // frame is still good, which is cheaper and safer than comparing documents.
    this.rev = 0;
    this.maxUndo = 200;
    this.maxLog = 5000;
  }

  /* ---------------- subscriptions ---------------- */
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  onOp(fn) { this._opSubs.add(fn); return () => this._opSubs.delete(fn); }
  emit(reason = 'change') { if (this._muted) return; for (const f of this._subs) f(reason, this.doc); }

  /* ---------------- reading ---------------- */
  get objects() { return this.doc.order.map((id) => this.doc.objects[id]).filter(Boolean); }
  get(id) { return this.doc.objects[id]; }
  has(id) { return !!this.doc.objects[id]; }
  indexOf(id) { return this.doc.order.indexOf(id); }
  get count() { return this.doc.order.length; }

  contentBounds() {
    let b = null;
    for (const o of this.objects) b = unionBox(b, boundsOf(o));
    return b;
  }

  /* ---------------- op application ---------------- */
  _apply(op) {
    const d = this.doc;
    switch (op.t) {
      case 'add': {
        d.objects[op.obj.id] = op.obj;
        if (!d.order.includes(op.obj.id)) {
          if (op.index == null || op.index >= d.order.length) d.order.push(op.obj.id);
          else d.order.splice(op.index, 0, op.obj.id);
        }
        break;
      }
      case 'del': {
        delete d.objects[op.id];
        const i = d.order.indexOf(op.id);
        if (i >= 0) d.order.splice(i, 1);
        break;
      }
      case 'set': {
        const o = d.objects[op.id];
        if (o) Object.assign(o, op.after);
        break;
      }
      case 'order': d.order = op.after.slice(); break;
      case 'doc': Object.assign(d, op.after); break;
    }
    d.modified = Date.now();
    this.rev++;
  }

  _invert(op) {
    switch (op.t) {
      case 'add': return { t: 'del', id: op.obj.id };
      case 'del': return { t: 'add', obj: op.obj, index: op.index };
      case 'set': return { t: 'set', id: op.id, after: op.before, before: op.after };
      case 'order': return { t: 'order', after: op.before, before: op.after };
      case 'doc': return { t: 'doc', after: op.before, before: op.after };
    }
  }

  /** Run ops as one undoable transaction. */
  commit(label, ops) {
    ops = ops.filter(Boolean);
    if (!ops.length) return;
    const inverse = [];
    for (const op of ops) { inverse.unshift(this._invert(op)); this._apply(op); }
    this.undoStack.push({ label, ops, inverse });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
    for (const op of ops) {
      this.log.push({ ...op, c: CLIENT_ID, ts: Date.now() });
      for (const f of this._opSubs) f(op);
    }
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
    this.emit(label);
  }

  /**
   * Sync seam: take a full snapshot of the document and reset the op log.
   * A future collaboration layer exchanges one checkpoint per peer, then
   * streams the ops that follow it - `peer.load(checkpoint)` followed by
   * `peer.applyRemote(ops)` reproduces this board exactly.
   */
  checkpoint() {
    const snap = this.toJSON();
    this.log.length = 0;
    return snap;
  }

  /* ---------------- live-gesture scratch ----------------
   * rawInsert / rawRemove change the document WITHOUT logging an op or
   * touching the undo stack. They exist so a gesture (partial erase) can show
   * its result while it is in progress; the caller must rewind to the pristine
   * state and issue a real commit() when the gesture ends.               */
  rawInsert(obj, index) {
    this.rev++;
    this.doc.objects[obj.id] = obj;
    if (index == null || index >= this.doc.order.length) this.doc.order.push(obj.id);
    else this.doc.order.splice(index, 0, obj.id);
    return obj;
  }

  rawRemove(id) {
    this.rev++;
    delete this.doc.objects[id];
    const i = this.doc.order.indexOf(id);
    if (i >= 0) this.doc.order.splice(i, 1);
    return i;
  }

  /** Apply ops from a remote peer - no undo entry, no rebroadcast. */
  applyRemote(ops) { for (const op of ops) this._apply(op); this.emit('remote'); }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return false;
    for (const op of tx.inverse) this._apply(op);
    this.redoStack.push(tx);
    this.emit('undo');
    return true;
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return false;
    for (const op of tx.ops) this._apply(op);
    this.undoStack.push(tx);
    this.emit('redo');
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /* ---------------- convenience mutations ---------------- */
  add(obj, label = 'add') { this.commit(label, [{ t: 'add', obj }]); return obj; }
  addMany(objs, label = 'add') { this.commit(label, objs.map((obj) => ({ t: 'add', obj }))); return objs; }

  update(id, patch, label = 'update') {
    const o = this.get(id); if (!o) return;
    const before = {}; for (const k of Object.keys(patch)) before[k] = structuredCloneSafe(o[k]);
    this.commit(label, [{ t: 'set', id, before, after: structuredCloneSafe(patch) }]);
  }

  updateMany(ids, patchFn, label = 'update') {
    const ops = [];
    for (const id of ids) {
      const o = this.get(id); if (!o) continue;
      const patch = typeof patchFn === 'function' ? patchFn(o) : patchFn;
      if (!patch) continue;
      const before = {}; for (const k of Object.keys(patch)) before[k] = structuredCloneSafe(o[k]);
      ops.push({ t: 'set', id, before, after: structuredCloneSafe(patch) });
    }
    this.commit(label, ops);
  }

  remove(ids, label = 'delete') {
    const ops = [];
    for (const id of [].concat(ids)) {
      const o = this.get(id); if (!o) continue;
      ops.push({ t: 'del', id, obj: structuredCloneSafe(o), index: this.indexOf(id) });
    }
    this.commit(label, ops);
  }

  /** The first sheet, or null on an infinite board. */
  get page() { return this.doc.pages[0] || null; }
  get pages() { return this.doc.pages; }
  get pageCount() { return this.doc.pages.length; }
  get pageRects() { return pageRects(this.doc.pages); }

  /**
   * The board is infinite by default. Giving it pages draws sheets stacked top
   * to bottom from the origin; ink is then clipped to the paper, the way it is
   * on a real pad. An empty array puts the infinite canvas back.
   *
   * @param {Array<{w:number,h:number}>} pages  world units
   */
  setPages(pages, label = 'page size') {
    const before = this.doc.pages.map((p) => ({ ...p }));
    const after = (pages || []).map((p) => ({ w: p.w, h: p.h }));
    this.commit(label, [{ t: 'doc', before: { pages: before }, after: { pages: after } }]);
  }

  /** An op that swaps the page list - for callers batching page edits with object moves. */
  pagesOp(pages) {
    return { t: 'doc', before: { pages: this.doc.pages.map((p) => ({ ...p })) },
      after: { pages: (pages || []).map((p) => ({ w: p.w, h: p.h })) } };
  }

  setBackground(patch) {
    const before = { ...this.doc.background };
    this.commit('background', [{ t: 'doc', before: { background: before }, after: { background: { ...before, ...patch } } }]);
  }

  rename(name) {
    this.commit('rename', [{ t: 'doc', before: { name: this.doc.name }, after: { name } }]);
  }

  clear() {
    const ops = this.doc.order.slice().reverse().map((id) => ({ t: 'del', id, obj: structuredCloneSafe(this.doc.objects[id]), index: this.indexOf(id) }));
    this.commit('clear canvas', ops);
  }

  /* z-order */
  reorder(ids, mode) {
    const before = this.doc.order.slice();
    const set = new Set(ids);
    const moving = before.filter((id) => set.has(id));
    const rest = before.filter((id) => !set.has(id));
    let after;
    if (mode === 'front') after = [...rest, ...moving];
    else if (mode === 'back') after = [...moving, ...rest];
    else {
      after = before.slice();
      if (mode === 'forward') {
        for (let i = after.length - 2; i >= 0; i--) if (set.has(after[i]) && !set.has(after[i + 1])) { [after[i], after[i + 1]] = [after[i + 1], after[i]]; }
      } else {
        for (let i = 1; i < after.length; i++) if (set.has(after[i]) && !set.has(after[i - 1])) { [after[i], after[i - 1]] = [after[i - 1], after[i]]; }
      }
    }
    if (after.join() === before.join()) return;
    this.commit('reorder', [{ t: 'order', before, after }]);
  }

  /* ---------------- live drag helpers ---------------- *
   * Mutate objects freely between snapshot() and commitSnapshot() so the
   * whole gesture collapses into a single undo entry.                    */
  snapshot(ids) {
    const snap = new Map();
    for (const id of ids) { const o = this.get(id); if (o) snap.set(id, structuredCloneSafe(o)); }
    return snap;
  }

  commitSnapshot(label, snap) {
    const ops = [];
    for (const [id, before] of snap) {
      const now = this.get(id);
      if (!now) continue;
      const b = {}, a = {};
      let changed = false;
      for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) {
        if (JSON.stringify(before[k]) !== JSON.stringify(now[k])) { b[k] = before[k]; a[k] = structuredCloneSafe(now[k]); changed = true; }
      }
      if (changed) {
        Object.assign(now, before);          // rewind so commit() can re-apply cleanly
        ops.push({ t: 'set', id, before: b, after: a });
      }
    }
    this.commit(label, ops);
  }

  /* ---------------- serialisation ---------------- */

  toJSON(extra) {
    const d = this.doc;
    // `page` is written alongside `pages` so a board saved here still opens on
    // a build from before multi-page: it sees the first sheet and ignores the
    // rest, which beats falling back to an infinite canvas.
    // `origin` is the file this board was opened from. It belongs to THIS
    // machine and is stripped on the way out - see exportable() in export.js.
    // Left undefined when there is none, so it never appears in the JSON.
    return { id: d.id, name: d.name, schema: 2, created: d.created, modified: d.modified,
      origin: d.origin || undefined,
      background: d.background, pages: d.pages.map((p) => ({ ...p })), page: d.pages[0] || null,
      camera: d.camera, objects: d.order.map((id) => d.objects[id]).filter(Boolean), ...extra };
  }

  /** Start a brand new empty document. */
  reset(name) {
    this.doc = emptyDoc(name);
    this.rev++;
    this.undoStack.length = 0; this.redoStack.length = 0; this.log.length = 0;
    this.emit('load');
    return this.doc;
  }

  load(data) {
    const d = emptyDoc(data.name || 'Untitled board');
    d.id = data.id || d.id;
    d.created = data.created || Date.now();
    d.modified = data.modified || Date.now();
    if (data.origin) d.origin = data.origin;
    d.background = { ...d.background, ...(data.background || {}) };
    d.pages = pagesFrom(data);
    d.camera = data.camera || d.camera;
    const list = Array.isArray(data.objects) ? data.objects
      : Array.isArray(data.objectList) ? data.objectList
        : data.objects ? Object.values(data.objects) : [];
    for (const o of list) { d.objects[o.id] = o; d.order.push(o.id); }
    this.doc = d;
    this.rev++;
    this.undoStack.length = 0; this.redoStack.length = 0; this.log.length = 0;
    this.emit('load');
  }
}

function structuredCloneSafe(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/* --------------------------------------------------------------- *
 * Object geometry - shared by hit-testing, rendering and export.
 * --------------------------------------------------------------- */
export function boundsOf(o) {
  if (!o) return { x: 0, y: 0, w: 0, h: 0 };
  if (o.type === 'stroke') {
    const b = o.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const pad = (o.width || 4) / 2 + 1;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

/** Axis-aligned bounds after rotation. */
export function worldBounds(o) {
  const b = boundsOf(o);
  const r = o.rotation || 0;
  if (!r) return b;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const w = b.w * c + b.h * s, h = b.w * s + b.h * c;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function centerOf(o) { const b = boundsOf(o); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

/**
 * Ids of anything drawn onto `ids` while they were locked.
 *
 * Locking a page and annotating it is the normal way to mark up an import.
 * Whiteboard treats those annotations as part of the page: unlock it, move it,
 * and the notes travel with it. `attachedTo` records that, and every transform
 * expands its selection through here so the two never come apart.
 */
export function withAttached(store, ids) {
  const set = new Set(ids);
  for (const o of store.objects) if (o && o.attachedTo && set.has(o.attachedTo)) set.add(o.id);
  return [...set];
}
