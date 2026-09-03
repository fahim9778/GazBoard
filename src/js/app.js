// GazBoard - application shell and command surface.

import './platform/platform.js';
import { Store, withAttached, worldBounds, boundsOf } from './core/store.js';
import { scaleObject, translateObject } from './core/transform.js';
import { Surface } from './core/surface.js';
import { Interaction } from './core/tools.js';
import { pick } from './core/hit.js';
import { uid, debounce, clamp, unionBox } from './core/util.js';
import { pageRects, stripBounds, pageIndexForBox, nearestPageIndex, offsetIntoRect, PAGE_GAP } from './core/pages.js';
import { isNewer } from './core/version.js';
import { TextEditor } from './ui/textedit.js';
import { initToolbar, syncToolbar } from './ui/toolbar.js';
import { createPanels } from './ui/panels.js';
import { showContextMenu, updateSelectionBar } from './ui/contextmenu.js';
import { closePopover, h } from './ui/popover.js';
import { icon } from './ui/icons.js';
import { PENS } from './ui/palettes.js';
import { exportPng, exportSvg, exportPdf, saveBoardFile, openBoardFile } from './export.js';
import {
  pickAndInsertDocument, pickAndInsertImage, insertDocument,
  insertImagesFromPaths, insertImageFiles, dropOrigin, isImagePath, isDocPath
} from './insert.js';

const DEFAULT_SETTINGS = {
  penColor: '#201f1e', penWidth: 4, penEffect: 'none',
  highlighterColor: '#fff100', highlighterWidth: 20,
  eraserSize: 30, eraserMode: 'partial',
  pdfPaper: 'a4', pdfOrientation: '', pdfMargin: 'narrow', pdfMode: 'fit', pdfQuality: 2,
  noteColor: '#ffd94a', noteSize: 200, noteFont: 'hand',
  textColor: '#201f1e', textSize: 32, textFont: 'hand',
  shapeKind: 'rect', shapeStroke: '#201f1e', shapeFill: 'none', shapeLineWidth: 3, shapeDash: null,
  inkToShape: false, pressure: true, wheelZoom: false, returnToSelect: true, autosave: true,
  edgePan: true, importQuality: 2, lowLatencyInk: false, laserColor: '#ff2d2d', showToolKeys: true,
  rightDragPans: true, hintsSeen: {},
  // null = never asked. Nothing reaches the network until this is true.
  updateCheck: null, lastUpdateCheck: 0, skippedVersion: null, updateAskedAt: 0,
  // 'auto': the mouse draws until a stylus turns up, then it pans and the pen
  // inks - decided fresh each session, never remembered. 'yes' and 'no' pin it.
  // See mouseInks().
  inkWithMouse: 'auto',
  // What you see while inking: 'nib' (drawn by us, so Windows cannot hide it
  // mid-stroke), 'arrow' or 'crosshair'. See inkPointerKind() in tools.js.
  inkPointer: 'nib'
};

/**
 * The file's own name, with its extension and folders taken off, for use as a
 * board name. Handles both separators: the path comes from whichever OS is
 * running, and a Windows path reaching a POSIX build is not worth a crash.
 */
function boardNameFromPath(p) {
  if (!p || typeof p !== 'string') return null;
  const base = p.split(/[\\/]/).pop() || '';
  const name = base.replace(/\.(gazboard|openboard|json)$/i, '').trim();
  return name || null;
}

/**
 * A board name nothing else on this machine is already using.
 *
 * Two boards called the same thing is exactly how a copy carried back from
 * another computer went unnoticed while it overwrote the original. The first
 * one keeps the plain name; the next is " 2", the way every file manager has
 * numbered a second copy for thirty years.
 */
function uniqueBoardName(base, list) {
  const name = String(base || 'Untitled board').trim() || 'Untitled board';
  const taken = new Set((list || []).map((b) => String(b && b.name || '')));
  if (!taken.has(name)) return name;
  for (let n = 2; n < 1000; n++) {
    if (!taken.has(name + ' ' + n)) return name + ' ' + n;
  }
  return name + ' ' + Date.now();     // a thousand copies is somebody else's problem
}

class App {
  /*
   * The longest the board may go unwritten while someone is actively drawing.
   * Not a save interval: nothing is written ON this schedule. It is the point
   * after which the next stroke to finish is written straight away, so what a
   * crash could cost is bounded by the clock rather than by whether the user
   * happened to pause for long enough.
   */
  static SAVE_CEILING = 20000;

  /** How long a dismissed update question stays dismissed. */
  static ASK_AGAIN_AFTER = 7 * 24 * 60 * 60 * 1000;

  constructor() {
    this.store = new Store();
    this.settings = this.loadSettings();
    this.surface = new Surface(document.getElementById('c'), this.store, { lowLatency: !!this.settings.lowLatencyInk });
    this.tool = 'pen';
    this.clipboard = [];
    this.ruler = { visible: false, x: 0, y: 0, angle: 0, length: 900, thickness: 78, snap: true };
    this.textEditor = new TextEditor(this);
    this.panels = createPanels(this);
    this.interaction = new Interaction(this);

    initToolbar(this);
    this.wireGlobalEvents();
    this.wireStore();
    this.restoreLastBoard();
    // after the board is up, never before: the first thing anyone sees should
    // be their work, not a question
    setTimeout(() => this.startUpdateFlow(), 2500);
    this.setTool('pen');
    this.syncUI();
  }

  /* ---------------- settings ---------------- */
  loadSettings() {
    try {
      const raw = localStorage.getItem('gazboard.settings') || localStorage.getItem('openboard.settings') || '{}';
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      if (s.eraserMode === 'stroke') s.eraserMode = 'object';   // pre-1.1 name
      // Text and notes were set in the sans face up to 1.13. Handwriting is the
      // default now; carry anyone who never touched the picker across to it, and
      // leave a deliberate choice of 'ui' alone once it has been made.
      /*
       * 'auto' used to be the default, and it remembered for ever that a stylus
       * had once been seen - so a desktop with a drawing tablet would silently
       * stop drawing with the mouse the moment the tablet was unplugged, with
       * nothing on screen to explain it. `penSeen` is that stale flag; it is
       * dropped here and never written again.
       */
      if (!s.mouseInkDefault5) {
        // Two defaults were tried during 2.4.3 development and neither shipped:
        // a flat 'yes', then a flat 'no'. Both were ours rather than anyone's
        // choice, so both go back to 'auto'. A 'yes' or 'no' somebody picked by
        // hand is left exactly as it is; the flags are what tell them apart.
        const ours = s.inkWithMouse === undefined
          || (s.inkWithMouse === 'yes' && s.mouseInkDefault3 === true)
          || (s.inkWithMouse === 'no' && s.mouseInkDefault4 === true);
        if (ours) s.inkWithMouse = 'auto';
        delete s.penSeen;
        delete s.mouseInkDefault3;
        delete s.mouseInkDefault4;
        s.mouseInkDefault5 = true;
      }

      if (!s.fontDefaults2) {
        if (s.textFont === 'ui') s.textFont = 'hand';
        if (s.noteFont === 'ui') s.noteFont = 'hand';
        s.fontDefaults2 = true;
      }
      return s;
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  saveSettings() {
    try { localStorage.setItem('gazboard.settings', JSON.stringify(this.settings)); } catch {}
    this.syncUI();
  }

  /* ---------------- board lifecycle ---------------- */
  wireStore() {
    this.unsavedNew = true;          // until a board is loaded or something is drawn
    this._saveCost = 0;              // how long the last write actually took
    this._lastSaveAt = 0;            // when it finished
    this._unsaved = false;           // is there anything worth writing?

    /*
     * When the board gets written out.
     *
     * Writing costs real time, and it grows with the board - a few kilobytes is
     * free, one carrying imported pages and photographs is a couple of hundred
     * milliseconds. That time is spent on the same thread that watches the pen,
     * so a save landing mid-stroke takes a bite out of the ink.
     *
     * So: never during a stroke, ever. Instead the save is taken at the moment
     * a stroke ENDS. You cannot write without lifting the pen - strokes finish
     * several times a sentence - so there is always a moment to use, and it is
     * never inside one.
     *
     * Two things ask for a write. Stopping for a moment triggers one, after a
     * pause taken from what the last save actually cost rather than a number
     * picked in advance. And SAVE_CEILING puts a floor under how much can be
     * lost when someone draws steadily and never really stops: once that long
     * has passed, the very next stroke to end is written immediately.
     */
    this.autosave = () => {
      clearTimeout(this._saveTimer);
      const wait = Math.min(4000, Math.max(700, this._saveCost * 4));
      this._saveTimer = setTimeout(() => {
        if (this.gestureInFlight()) return;   // the stroke ending will come back for this
        this.runSave();
      }, wait);
    };

    this.store.subscribe(() => {
      this.surface.invalidate();
      this.syncUI();
      if (!this.settings.autosave) return;
      this._unsaved = true;
      if (!(this.unsavedNew && !this.store.objects.length)) this.markDirty();
      this.autosave();                                  // persist() decides whether to write
    });
  }

  /** True while a pointer gesture is mid-flight. Reads one flag; never the board. */
  gestureInFlight() { return !!(this.interaction && this.interaction.action); }

  /** Write now, and remember what it cost so the next pause can be sized to it. */
  runSave() {
    clearTimeout(this._saveTimer);
    const t = performance.now();
    return Promise.resolve(this.persist()).finally(() => {
      this._saveCost = performance.now() - t;
      this._lastSaveAt = performance.now();
    });
  }

  /**
   * A gesture just finished - the one moment a save is guaranteed not to
   * interrupt anything. Take it if the board has gone unwritten for longer
   * than the ceiling; otherwise leave it to the ordinary pause.
   */
  onGestureEnd() {
    if (!this.settings.autosave || !this._unsaved) return;
    if (performance.now() - this._lastSaveAt > App.SAVE_CEILING) this.runSave();
    else this.autosave();
  }

  markDirty() {
    const b = document.getElementById('savedBadge');
    b.textContent = 'Saving…';
  }

  /**
   * Write the current board out.
   *
   * A brand new board that has never had anything put on it is deliberately
   * skipped: saving it on sight left a fresh "Untitled board" behind on every
   * single launch. `force` is for an explicit "save" the user asked for.
   */
  async persist({ force = false } = {}) {
    if (!force && this.unsavedNew && !this.store.objects.length) return;
    this.store.doc.camera = this.surface.cam.toJSON();
    // boards.save writes the file and records the "last open" pointer in one go,
    // both through the main process, so both are on disk immediately
    /*
     * The board is serialised HERE and sent as text.
     *
     * Sending the object instead meant the structured clone that crosses to the
     * main process had to walk every point of every stroke and copy every
     * embedded picture - on a board with a few imported pages that was ~130ms
     * of blocking work on top of ~50ms to stringify it, all of it on the thread
     * that handles the pen. Strokes went missing in that window. A string is
     * copied wholesale, and the main process no longer has to re-serialise what
     * it is only going to write out.
     */
    const doc = await this.externaliseAssets(this.store.toJSON());
    await window.board.boards.save({ id: doc.id, json: JSON.stringify(doc) });
    this.unsavedNew = false;
    this._unsaved = false;
    this._lastSaveAt = performance.now();
    try { localStorage.setItem('gazboard.lastBoard', this.store.doc.id); } catch {}
    const b = document.getElementById('savedBadge');
    b.textContent = 'Saved';
  }

  /**
   * Move pictures out of the board and leave a reference behind.
   *
   * The objects in memory are NOT changed - they keep their data: URL, so
   * everything that draws, exports or prints carries on exactly as before.
   * Only the copy being written to disk is slimmed down. On a board carrying
   * imported pages that is the difference between writing tens of megabytes on
   * every save and writing a few hundred kilobytes.
   *
   * A picture is only handed to the store once; after that the object
   * remembers its name. If the store cannot take it - for any reason at all -
   * the picture stays inline exactly as it always did, so a failure here
   * degrades to the old behaviour and can never lose an image.
   */
  async externaliseAssets(doc) {
    if (!doc || !Array.isArray(doc.objects) || !window.board.assets) return doc;

    /*
     * An assetId proves the picture was filed once, SOMEWHERE. It does not
     * prove it is filed HERE.
     *
     * A .gazboard carried to another machine arrives with the picture still
     * inline AND the id it was given on the machine it came from - but that
     * machine's assets folder did not travel with it. Believing the id would
     * write a reference to a file this machine has never had: the picture
     * draws for the rest of the session, from the data still in memory, and
     * is gone the next time the board is opened. Silently, and only on the
     * second machine, which is what made it hard to see.
     *
     * So ask the store what it actually holds before trusting any id.
     */
    const claimed = [];
    for (const o of doc.objects) {
      if (o && o.type === 'image' && o.assetId
          && typeof o.src === 'string' && o.src.startsWith('data:')) claimed.push(o.assetId);
    }
    let here = {};
    if (claimed.length) {
      try { here = (await window.board.assets.have(claimed)) || {}; } catch { here = {}; }
    }

    const objects = [];
    for (const o of doc.objects) {
      if (!o || o.type !== 'image') { objects.push(o); continue; }
      const inline = typeof o.src === 'string' && o.src.startsWith('data:');
      if (!inline) {
        /*
         * Not a picture we are holding: either already a reference, or one
         * whose file has gone missing and is being shown as a gap. Either way
         * it must be written back POINTING AT THE SAME FILE. Writing what is
         * in `src` would save the empty placeholder over the reference and
         * turn a picture that is merely misplaced into one that is lost.
         */
        if (o.assetId) {
          const { missing, ...rest } = o;      // a runtime marker, not board data
          objects.push({ ...rest, src: 'asset:' + o.assetId, assetId: o.assetId });
        } else objects.push(o);
        continue;
      }
      let id = o.assetId;
      if (!id || here[id] !== true) {
        let r = null;
        try { r = await window.board.assets.put(o.src); } catch { r = null; }
        if (r && r.id) {
          id = r.id;
          const live = this.store.get(o.id);   // remember it, so the next save is cheap
          if (live) live.assetId = id;
        } else if (id && here[id] !== true) {
          // the store would not take it and does not already have it: keep the
          // picture inline rather than point at a file that is not there
          id = null;
        }
      }
      objects.push(id ? { ...o, src: 'asset:' + id, assetId: id } : o);
    }
    return { ...doc, objects };
  }

  /**
   * Put the pictures back when a board is opened.
   *
   * A board written before this existed carries its pictures inline and is
   * loaded untouched - it converts the first time it is saved, not on sight.
   * A reference whose file has gone (copied to another machine without the
   * assets folder, say) becomes a visible gap rather than a silent one, and
   * the reference is KEPT: put the file back and the picture returns.
   */
  async resolveAssets(data) {
    if (!data || !Array.isArray(data.objects) || !window.board.assets) return data;
    const objects = [];
    let missing = 0;
    for (const o of data.objects) {
      const ref = o && o.type === 'image' && typeof o.src === 'string' && o.src.startsWith('asset:');
      if (!ref) { objects.push(o); continue; }
      const id = o.src.slice(6);
      let url = null;
      try { url = await window.board.assets.get(id); } catch { url = null; }
      if (url) objects.push({ ...o, src: url, assetId: id });
      else { missing++; objects.push({ ...o, src: '', assetId: id, missing: true }); }
    }
    if (missing) {
      this.toast(missing === 1
        ? 'One picture could not be found - its place is kept on the board'
        : missing + ' pictures could not be found - their places are kept on the board', 'help', 6000);
    }
    return { ...data, objects };
  }

  /**
   * Open whatever the user was last working on.
   *
   * The main process picks it: the recorded pointer first, then the most
   * recently touched board that has anything on it. A blank canvas is only ever
   * the answer when there genuinely are no boards - anything else and someone
   * who restarted their PC would be staring at an empty screen with their work
   * sitting on disk a folder away.
   */
  async restoreLastBoard() {
    /*
     * Double-clicking a .gazboard file starts the app AND asks it to restore
     * whatever was open last, and those two race. The file arrives first and
     * appears on screen; a moment later the resume finishes and quietly loads
     * the local board over the top - resetting the zoom to 100%, which is the
     * only visible sign that anything happened.
     *
     * On one machine that looks like a flicker. Carry a board between two
     * computers and it looks like your work has been thrown away: the file and
     * the local board share an id, so what lands on top is the older copy this
     * machine already had. The work is still in the file, but nothing on screen
     * says so.
     *
     * An explicit request always wins over a guess about what to reopen.
     */
    if (this.boardOpenedExplicitly) return;
    try {
      // Ask first, guess second. The main process knows a file was
      // double-clicked before this window even existed, so there is no need to
      // race it - if one is on its way, there is nothing here to decide.
      if ((await this.appInfo())?.pendingBoardFile) return;
      if (this.boardOpenedExplicitly) return;
      const res = await window.board.boards.resume();
      if (this.boardOpenedExplicitly) return;   // a file arrived while we asked
      if (res && res.board) {
        await this.loadBoard(res.board, { silent: true, startup: true });
        if (res.reason === 'newest') this.toast('Reopened your most recent board');
        return;
      }
    } catch (e) { console.warn('resume failed, falling back:', e); }

    // last resort: the old localStorage hint, then a fresh board
    const id = localStorage.getItem('gazboard.lastBoard') || localStorage.getItem('openboard.lastBoard');
    if (id) {
      const data = await window.board.boards.load(id);
      if (this.boardOpenedExplicitly) return;
      if (data) { await this.loadBoard(data, { silent: true, startup: true }); return; }
    }
    if (this.boardOpenedExplicitly) return;
    this.newBoard(true);
  }

  /**
   * Open at 100%, looking at wherever the board was last centred.
   *
   * Restoring a saved zoom meant re-opening at whatever odd level the last
   * action left behind - after fitting a document to the screen, that is
   * something like 36%, and the app looks broken before you have touched it.
   * Runs after the first layout, because the viewport size is needed to centre.
   */
  openAtActualSize(focus) {
    const settle = () => {
      const sf = this.surface;
      if (!sf.width || !sf.height) { requestAnimationFrame(settle); return; }
      // A pad that acquired its pages while this was waiting for the first
      // layout gets fitted instead: 100% of an A4 sheet is a corner of a page,
      // and landing there straight after choosing a paper size looks broken.
      if (!focus && this.pageCount) { this.fitToPage(this.currentPageIndex()); return; }
      const view = sf.cam.viewport(sf.width, sf.height);
      const at = focus || { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      sf.cam.z = 1;
      sf.cam.centerOn(at, sf.width, sf.height);
      this.syncZoom();
      sf.invalidate();
    };
    requestAnimationFrame(settle);
  }

  /**
   * Start a blank board.
   *
   * `silent` separates the two reasons this happens, and they want opposite
   * things. Silent means the app decided - first launch with nothing to
   * restore, or the board under you was just deleted - and an empty board that
   * nobody asked for must not be written to disk, or every launch would leave
   * an "Untitled board" behind. Not silent means someone clicked New board,
   * which is a deliberate act: that board is written straight away so it
   * appears in the Boards list immediately, instead of materialising later when
   * the first mark happens to be made.
   */
  newBoard(silent = false) {
    this.store.reset();
    this.surface.selection.clear();
    this.openAtActualSize();
    document.getElementById('boardTitle').value = this.store.doc.name;
    this.syncUI();
    this.surface.invalidate();
    if (!silent) this.toast('New board');
    this.unsavedNew = true;
    document.getElementById('savedBadge').textContent = 'Saved';
    window.board.boards.setLast(this.store.doc.id);
    // kept so callers (and the suite) can wait for the board to be on disk
    this.pendingWrite = silent ? Promise.resolve() : this.persist({ force: true });
  }

  /**
   * Delete a board, and never leave the deleted one open.
   *
   * Removing the file is not enough on its own: if the board being deleted is
   * the one on screen, the document in memory still carries its id, so the
   * next autosave writes it straight back and it returns from the dead the
   * moment anything is drawn. Whatever was open has to be replaced by a fresh,
   * empty board with a new id.
   *
   * @returns {boolean} whether the board that was deleted was the open one
   */
  async deleteBoard(id) {
    const wasOpen = id === this.store.doc.id;
    await window.board.boards.remove(id);
    if (wasOpen) {
      this.textEditor.cancel();
      this.newBoard(true);          // silent: nobody asked for this board
      this.toast('Board deleted');
    }
    return wasOpen;
  }

  /**
   * Work out which local board a file opened from disk belongs to.
   *
   * An exported .gazboard keeps the id of the board it was exported FROM, and
   * the local board store is keyed on that id. So two different files - a copy
   * carried back from another machine, an earlier save kept as a checkpoint,
   * two exports taken minutes apart - all carry the same id and all claim the
   * same slot. Opening one wrote it over the other, and the board that had
   * been there was simply gone. Nothing said so, and with every board called
   * "Untitled board" there was nothing on screen to tell them apart either.
   *
   * The file's id is therefore treated as where the board came FROM, not as
   * who it IS on this machine:
   *
   *   - a file opened here before keeps the local board it was given, so
   *     editing a file on disk goes on updating the same board, as expected;
   *   - a file whose id is already taken by some OTHER file gets a fresh local
   *     id, so the two live side by side instead of one eating the other;
   *   - a file whose id is free keeps it, which is the ordinary case and the
   *     one that has always worked.
   *
   * `origin` never leaves this machine: exportable() strips it.
   */
  async claimLocalBoard(data) {
    let list = [];
    try { list = (await window.board.boards.list()) || []; } catch { return data; }

    // Opened here before: it keeps the board it was given, so editing a file on
    // disk goes on updating the same board. No question, no second copy.
    const seenBefore = list.find((b) => b.origin && b.origin === data.origin);
    if (seenBefore) return { ...data, id: seenBefore.id };

    // A board that never got past the placeholder name is named after its file.
    // Two rows reading "Untitled board" is how this went unnoticed for so long.
    const base = data.name && data.name !== 'Untitled board'
      ? data.name
      : boardNameFromPath(data.origin) || 'Untitled board';

    const clash = list.find((b) => b.id === data.id);
    if (!clash) return { ...data, name: uniqueBoardName(base, list) };

    const answer = await this.choose(
      'You already have this board',
      `“${clash.name}” on this computer came from the same board as this file - `
      + 'most likely this file is a copy of it made on another machine. Keeping both '
      + 'leaves your copy untouched and opens the file alongside it. Replacing writes '
      + 'the file over your copy, and what is in your copy now would be gone.',
      [{ id: 'both', label: 'Keep both', primary: true },
       { id: 'replace', label: 'Replace my copy' }],
      { cancel: false });

    // Escape, or the dialog going away for any other reason, lands on the
    // answer that destroys nothing. Losing a board to a stray keypress is the
    // whole failure this exists to stop.
    if (answer === 'replace') {
      this.toast('Replaced your copy of “' + clash.name + '”');
      return data;
    }
    return { ...data, id: uid('b'), name: uniqueBoardName(base, list), created: Date.now() };
  }

  async loadBoard(data, opts = {}) {
    // Anything that is not the startup restore is somebody asking for a
    // particular board - from a file dialog, a drag onto the window, or a
    // double-click in Explorer. Whatever the startup restore was about to
    // reopen, it does not get to land on top of that.
    if (!opts.startup) this.boardOpenedExplicitly = true;
    // A board arriving from a file has to be given its own place to live before
    // anything is written, or the first autosave lands on somebody else's board.
    if (!opts.startup && data && data.origin) data = await this.claimLocalBoard(data);
    this.textEditor.cancel();
    data = await this.resolveAssets(data);
    this.store.load(data);
    this.unsavedNew = false;
    this.surface.selection.clear();
    if (data.camera) this.surface.cam.load(data.camera);
    else this.command('fit');
    // Opening a board starts at 100%, keeping the place you were looking at.
    // A board on a fixed sheet is the exception: 100% of an A4 page is taller
    // than most windows, so you would open looking at a corner of it. Fit the
    // sheet instead, the way any document editor opens a page.
    if (opts.startup) {
      if (this.store.doc.pages.length) requestAnimationFrame(() => this.fitToPage(0));
      else this.openAtActualSize();
    }
    document.getElementById('boardTitle').value = this.store.doc.name;
    this.syncUI();
    this.surface.invalidate();
    localStorage.setItem('gazboard.lastBoard', this.store.doc.id);
    if (!opts.silent) this.toast('Opened ' + this.store.doc.name);
    if (!opts.noMigrationPrompt) this.checkStrayContent(data);
  }

  /**
   * Ask about content that sits outside the paper.
   *
   * Boards saved before pages clipped their contents can have ink hanging off
   * the sheet. Now that the paper is a real boundary that ink would be hidden,
   * so the board is never touched without asking - and answering "keep" leaves
   * it visible on the desk rather than quietly swallowing it.
   *
   * Only boards written by an older build are asked about: anything saved
   * since cannot have stray content in the first place.
   */
  async checkStrayContent(data) {
    if ((data?.schema ?? 1) >= 2) return;
    if (!this.pageCount) return;
    const stray = this.offPageObjects();
    if (!stray.length) return;

    const answer = await this.choose(
      stray.length === 1 ? 'One thing sits outside the page' : `${stray.length} things sit outside the page`,
      'Pages now hold their ink the way paper does, so anything outside the sheet is clipped. This board was made before that. You can bring it all onto the page, or leave it where it is.',
      [{ id: 'fit', label: 'Bring it onto the page', primary: true },
       { id: 'keep', label: 'Leave it where it is' }]
    );
    if (answer === 'fit') this.fitContentToPage();
    else this.toast('Left as it was — the stray parts sit off the paper');
  }

  /* ---------------- tools & selection ---------------- */
  setTool(tool) {
    if (tool === 'pen' || tool === 'highlighter') this.lastInkTool = tool;
    if (this.tool === tool) return;
    this.textEditor.commit();
    this.tool = tool;
    // a pen nib left behind by the tool it belonged to is just a stray picture
    if (tool !== 'pen' && tool !== 'highlighter') this.interaction.hideInkPointer();
    if (tool !== 'laser') this.surface.laser.length = 0;   // no stale dot left behind
    // panning is a view change, not an edit - it must not throw a selection away
    if (tool !== 'select' && tool !== 'lasso' && tool !== 'pan') this.setSelection([]);
    this.syncUI();
    this.surface.invalidate();
  }

  setSelection(ids, additive = false) {
    const sel = this.surface.selection;
    if (!additive) sel.clear();
    for (const id of ids) if (this.store.has(id)) sel.add(id);
    this.syncUI();
    this.surface.invalidate();
  }

  get selected() { return [...this.surface.selection].map((id) => this.store.get(id)).filter(Boolean); }
  get selection() { return this.surface.selection; }

  /**
   * Locking claims whatever is already drawn on top.
   *
   * Attachment used to be decided only as ink was drawn, so the natural order -
   * import a slide, annotate it, then lock it - produced nothing to carry. Now
   * either order works.
   */
  adoptOverlapping(hosts) {
    const patch = [];
    for (const host of hosts) {
      const hb = worldBounds(host);
      const hostIndex = this.store.indexOf(host.id);
      for (const o of this.store.objects) {
        if (o === host || o.locked || o.attachedTo) continue;
        if (this.store.indexOf(o.id) < hostIndex) continue;      // must sit above it
        const b = worldBounds(o);
        const ox = Math.max(0, Math.min(b.x + b.w, hb.x + hb.w) - Math.max(b.x, hb.x));
        const oy = Math.max(0, Math.min(b.y + b.h, hb.y + hb.h) - Math.max(b.y, hb.y));
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const centreIn = cx >= hb.x && cx <= hb.x + hb.w && cy >= hb.y && cy <= hb.y + hb.h;
        if ((ox * oy) / Math.max(1, b.w * b.h) > 0.6 || (centreIn && ox > 0 && oy > 0)) patch.push(o.id);
      }
    }
    if (patch.length) this.store.updateMany(patch, { attachedTo: hosts[0].id }, 'attach to locked');
    return patch.length;
  }

  /** Explain the lock rather than silently doing nothing. */
  hintLocked(n = 1) {
    const now = Date.now();
    if (now - (this._lockHintAt || 0) < 2500) return;
    this._lockHintAt = now;
    this.toast(n > 1 ? `${n} locked items were left alone` : 'This is locked — press the unlock button to edit it', 'lock');
  }

  pickAt(wp) { return pick(this.store, wp, 8 / this.surface.cam.z); }

  /**
   * Convert an on-screen size into board units at the current zoom.
   *
   * Sizes in the toolbar are what you see: a 32px text box placed while zoomed
   * out to 36% would otherwise land as 32 board units and appear 11px tall.
   */
  worldSize(screenPx) { return screenPx / (this.surface.cam.z || 1); }

  /**
   * Does the mouse draw, or does it only pan?
   *
   * By default it only pans. The two devices never do the same job: the pen
   * inks, the mouse moves the canvas and drags objects, and both are live at
   * the same moment - no mode, no detection, no switching. Choosing an ink tool
   * changes what the PEN does; it never changes what the mouse does. This is
   * what Whiteboard does, and it is what makes a pen and a mouse usable
   * together without either one being put away first.
   *
   * The previous default decided for itself: the first time a stylus touched
   * the tablet the mouse switched to panning for good, remembered across
   * sessions. That was a trap - unplug the tablet and the pen tool silently
   * stopped working. Deciding once, up front, and saying so in Settings beats
   * deciding cleverly and being wrong in silence.
   *
   * "Always" is the opt-in for anyone drawing with a mouse and nothing else;
   * "Auto" keeps the old guess for anyone who deliberately wants it, and is no
   * longer remembered between sessions.
   */
  get mouseInks() {
    const m = this.settings.inkWithMouse;
    if (m === 'yes') return true;
    if (m === 'no') return false;
    return !this.penSeenThisSession;         // 'auto' - the default
  }

  /**
   * Called the first time a stylus touches the tablet.
   *
   * Only 'auto' cares, and only for this session: a tablet that is plugged in
   * today may be gone tomorrow, and a preference that outlives the hardware it
   * was inferred from is a preference nobody chose. The toast fires on the
   * transition alone - under the default the mouse was already panning, and
   * announcing a change that did not happen is worse than saying nothing.
   */
  notePenSeen() {
    if (this.penSeenThisSession) return;
    const wasInking = this.mouseInks;
    this.penSeenThisSession = true;
    if (wasInking && !this.mouseInks) {
      this.toast('Stylus detected — the mouse now pans instead of drawing', 'pen', 5000);
      this.surface.invalidate();
    }
  }

  /**
   * Remember a colour chosen from the selection bar as the default for the
   * next object of that kind - otherwise every new shape came back black.
   */
  rememberColor(type, key, value) {
    const map = {
      'stroke:color': 'penColor',
      'note:color': 'noteColor',
      'text:color': 'textColor',
      'table:color': 'textColor',
      'shape:stroke': 'shapeStroke',
      'shape:fill': 'shapeFill'
    };
    const setting = map[`${type}:${key}`];
    if (!setting) return;
    this.settings[setting] = value;
    if (setting === 'penColor') this.settings.penEffect = 'none';
    this.saveSettings();
  }

  applyToSelection(patch, onlyType) {
    const ids = this.selected.filter((o) => !onlyType || o.type === onlyType).map((o) => o.id);
    if (ids.length) this.store.updateMany(ids, patch, 'format');
  }

  /** Bring a set of objects into view without selecting them. */
  frameObjects(objs) {
    if (!objs || !objs.length) return;
    let b = null;
    for (const o of objs) {
      const ob = { x: o.x, y: o.y, w: o.w, h: o.h };
      b = b ? {
        x: Math.min(b.x, ob.x), y: Math.min(b.y, ob.y),
        w: Math.max(b.x + b.w, ob.x + ob.w) - Math.min(b.x, ob.x),
        h: Math.max(b.y + b.h, ob.y + ob.h) - Math.min(b.y, ob.y)
      } : ob;
    }
    this.surface.cam.fit(b, this.surface.width, this.surface.height, 90);
    this.syncZoom();
    this.surface.invalidate();
  }

  frameSelection() {
    const b = this.surface.selectionBounds();
    if (!b) return;
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    const fits = b.w < view.w * 0.9 && b.h < view.h * 0.9 &&
      b.x > view.x && b.y > view.y && b.x + b.w < view.x + view.w && b.y + b.h < view.y + view.h;
    if (!fits) this.surface.cam.fit(b, this.surface.width, this.surface.height, 100);
    this.syncZoom();
    this.surface.invalidate();
  }

  beginTextEdit(obj, cell) { this.textEditor.begin(obj, cell); this.syncUI(); }

  /**
   * After typing, hand the board back to the pen.
   *
   * Placing text left you in Select, so the next thing you did with the stylus
   * was drag a marquee instead of writing. Only placement flows arm this - a
   * double-click edit from Select stays in Select.
   */
  armToolRestore() { this.restoreToolAfterEdit = this.lastInkTool || 'pen'; }

  afterTextEdit() {
    const tool = this.restoreToolAfterEdit;
    this.restoreToolAfterEdit = null;
    if (tool) { this.setSelection([]); this.setTool(tool); }
  }
  beginTableEdit(obj, wp) {
    const c = clamp(Math.floor((wp.x - obj.x) / (obj.w / obj.cols)), 0, obj.cols - 1);
    const r = clamp(Math.floor((wp.y - obj.y) / (obj.h / obj.rows)), 0, obj.rows - 1);
    this.textEditor.begin(obj, `${r},${c}`);
  }
  commitTextEdit() { this.textEditor.commit(); }

  addNoteAt(wp) {
    const size = this.worldSize(this.settings.noteSize);
    const o = { id: uid('n'), type: 'note', x: wp.x - size / 2, y: wp.y - size / 2, w: size, h: size, color: this.settings.noteColor, text: '', rotation: 0, align: 'center', font: this.settings.noteFont };
    this.store.add(o, 'note');
    this.armToolRestore();
    if (this.tool !== 'select') this.setTool('select');
    this.setSelection([o.id]);
    this.beginTextEdit(o);
  }

  addTextAt(wp) {
    const fontSize = this.worldSize(this.settings.textSize);
    const o = { id: uid('t'), type: 'text', x: wp.x, y: wp.y - fontSize, w: this.worldSize(360), h: fontSize * 1.6, text: '', rotation: 0, color: this.settings.textColor, fontSize, align: 'left', valign: 'top', font: this.settings.textFont, background: 'none' };
    this.store.add(o, 'text');
    this.armToolRestore();
    if (this.tool !== 'select') this.setTool('select');
    this.setSelection([o.id]);
    this.beginTextEdit(o);
  }

  addTable() {
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    const w = 640, hh = 360;
    const o = {
      id: uid('tb'), type: 'table', x: view.x + view.w / 2 - w / 2, y: view.y + view.h / 2 - hh / 2,
      w, h: hh, rows: 3, cols: 3, rotation: 0, stroke: '#605e5c', fill: '#ffffff', lineWidth: 2,
      headerRow: true, headerColor: '#f3f2f1', cells: {}
    };
    this.store.add(o, 'table');
    this.setSelection([o.id]);
    this.setTool('select');
  }

  /**
   * Add or remove a row (axis 0) or a column (axis 1) of the selected table.
   *
   * The table grows and shrinks by one row/column's worth of size, so the rows
   * already in it keep the height they had rather than being squeezed to make
   * room. Text in a row or column that goes away goes with it.
   */
  resizeTable(axis, delta) {
    const sel = [...this.surface.selection].map((id) => this.store.get(id)).filter(Boolean);
    if (sel.length !== 1 || sel[0].type !== 'table' || sel[0].locked) return;
    const t = sel[0];
    const key = axis ? 'cols' : 'rows';
    const dim = axis ? 'w' : 'h';
    const was = Math.max(1, t[key] | 0);
    const now = was + delta;
    if (now < 1) { this.toast(axis ? 'A table needs a column' : 'A table needs a row'); return; }
    if (now > 40) { this.toast('That is as big as a table gets'); return; }

    const patch = { [key]: now, [dim]: Math.round(t[dim] / was * now) };
    if (delta < 0) {
      const cells = {};
      for (const [k, v] of Object.entries(t.cells || {})) {
        const rc = k.split(',').map(Number);
        if (rc[axis] < now) cells[k] = v;      // the dropped line takes its text with it
      }
      patch.cells = cells;
    }
    this.store.update(t.id, patch, delta > 0 ? (axis ? 'add column' : 'add row') : (axis ? 'remove column' : 'remove row'));
    this.surface.invalidate();
    this.syncUI();
  }

  applyTemplate(tpl) {
    // a canvas-size template only sets the page; it adds nothing to the board
    if (tpl.page) { this.setPageSize(tpl.page.paper, tpl.page.orientation); return; }
    const objs = tpl.build();
    if (!objs.length) { this.toast('Blank board'); return; }
    if (this.store.count) {
      let box = null;
      for (const o of objs) {
        const b = { x: o.x, y: o.y, w: Math.abs(o.w), h: Math.abs(o.h) };
        box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x), h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y) } : b;
      }
      const target = dropOrigin(this, box.w, box.h);
      const dx = target.x - box.x, dy = target.y - box.y;
      for (const o of objs) { o.x += dx; o.y += dy; }
    }
    this.store.addMany(objs, 'template: ' + tpl.name);
    this.setSelection([]);
    const b = this.store.contentBounds();
    this.surface.cam.fit(b, this.surface.width, this.surface.height);
    this.syncZoom();
    this.surface.invalidate();
    this.toast(tpl.name + ' added');
  }

  /* ---------------- commands ---------------- */
  command(id) {
    const s = this.store, sf = this.surface;
    switch (id) {
      case 'undo': case 'edit.undo': this.textEditor.commit(); s.undo(); this.pruneSelection(); break;
      case 'redo': case 'edit.redo': this.textEditor.commit(); s.redo(); this.pruneSelection(); break;

      case 'edit.delete': {
        const free = withAttached(s, this.selected.filter((o) => !o.locked).map((o) => o.id))
          .filter((id) => !s.get(id)?.locked);
        const held = this.selection.size - free.length;
        if (free.length) s.remove(free);
        if (held) this.hintLocked(held);
        sf.selection.clear();
        break;
      }
      case 'edit.selectAll': this.setSelection(s.doc.order.filter((id) => !s.get(id)?.locked)); this.setTool('select'); break;
      case 'edit.copy': this.copy(); break;
      case 'edit.cut': this.copy(); if (sf.selection.size) { s.remove([...sf.selection]); sf.selection.clear(); } break;
      case 'edit.paste': this.paste(); break;
      case 'edit.duplicate': this.duplicate(); break;
      case 'edit.clear':
        this.confirm('Clear canvas?', 'Everything on this board will be removed. You can undo this.', 'Clear')
          .then((ok) => { if (ok) { s.clear(); sf.selection.clear(); } });
        break;
      case 'edit.lock': {
        const objs = this.selected;
        if (!objs.length) break;
        const lock = !objs.every((o) => o.locked);
        s.updateMany(objs.map((o) => o.id), { locked: lock }, lock ? 'lock' : 'unlock');
        if (lock) this.adoptOverlapping(objs);
        const attached = withAttached(s, objs.map((o) => o.id)).length - objs.length;
        this.toast(lock
          ? 'Locked — it stays put, and anything you draw on it travels with it.'
          : attached
            ? `Unlocked — ${attached} annotation${attached === 1 ? '' : 's'} will move with it`
            : 'Unlocked', lock ? 'lock' : 'unlock');
        break;
      }
      case 'table.addRow': this.resizeTable(0, +1); break;
      case 'table.removeRow': this.resizeTable(0, -1); break;
      case 'table.addCol': this.resizeTable(1, +1); break;
      case 'table.removeCol': this.resizeTable(1, -1); break;

      case 'order.front': s.reorder([...sf.selection], 'front'); break;
      case 'order.back': s.reorder([...sf.selection], 'back'); break;
      case 'order.forward': s.reorder([...sf.selection], 'forward'); break;
      case 'order.backward': s.reorder([...sf.selection], 'backward'); break;

      case 'zoomIn': case 'view.zoomIn': sf.cam.zoomAt(sf.width / 2, sf.height / 2, 1.2); this.afterCamera(); break;
      case 'zoomOut': case 'view.zoomOut': sf.cam.zoomAt(sf.width / 2, sf.height / 2, 1 / 1.2); this.afterCamera(); break;
      case 'zoomReset': case 'view.zoomReset': sf.cam.setZoom(1, sf.width / 2, sf.height / 2); this.afterCamera(); break;
      case 'fit': case 'view.fit': {
        const b = s.contentBounds();
        if (b) sf.cam.fit(b, sf.width, sf.height);
        else { sf.cam.z = 1; sf.cam.x = sf.width / 2; sf.cam.y = sf.height / 2; }
        this.afterCamera();
        break;
      }
      case 'ruler': case 'view.ruler': this.toggleRuler(); break;
      case 'view.background': this.panels.background(); break;

      case 'insert.image': pickAndInsertImage(this); break;
      case 'insert.document': pickAndInsertDocument(this); break;
      case 'insert.table': this.addTable(); break;

      case 'export.png': this.checkOffPageBeforeExport().then((go) => go && exportPng(this, { scale: 2 })); break;
      case 'export.pngSelection': exportPng(this, { scale: 2, selectionOnly: true }); break;
      case 'export.svg': this.checkOffPageBeforeExport().then((go) => go && exportSvg(this)); break;
      case 'export.pdf': this.exportPdfWithSetup(); break;
      case 'view.fitPage': this.fitToPage(this.currentPageIndex()); break;
      case 'view.fitAllPages': this.fitToAllPages(); break;
      case 'page.add': this.addPage(); break;
      case 'page.duplicate': this.duplicatePage(); break;
      case 'page.delete': this.deletePage(); break;
      case 'page.next': this.nextPage(); break;
      case 'page.prev': this.prevPage(); break;
      case 'page.fitContent': this.fitContentToPage(); break;
      case 'board.save': saveBoardFile(this); break;
      case 'board.open': openBoardFile(this); break;
      case 'board.new':
        this.confirm('New board?', 'Your current board is saved automatically and stays in "My boards".', 'Create')
          .then((ok) => { if (ok) this.newBoard(); });
        break;
      case 'help.shortcuts': this.showShortcuts(); break;
      case 'help.about': this.showAbout(); break;
      case 'help.checkUpdates': this.checkForUpdates({ force: true, silent: false }); break;
      default: break;
    }
    this.syncUI();
    this.surface.invalidate();
  }

  afterCamera() { this.surface.clampCamera(); this.syncZoom(); this.textEditor.reposition(); this.surface.invalidate(); }

  pruneSelection() {
    for (const id of [...this.surface.selection]) if (!this.store.has(id)) this.surface.selection.delete(id);
  }

  toggleRuler() {
    const r = this.ruler;
    r.visible = !r.visible;
    if (r.visible) {
      const v = this.surface.cam.viewport(this.surface.width, this.surface.height);
      r.x = v.x + v.w / 2;
      r.y = v.y + v.h / 2;
      r.length = Math.min(1200, v.w * 0.7);
      r.thickness = 78 / this.surface.cam.z;
      this.toast('Ruler on — drag to move, scroll over it to rotate');
    }
    this.surface.invalidate();
  }

  /* ---------------- clipboard ---------------- */
  copy() {
    this.clipboard = this.selected.map((o) => structuredClone(o));
    if (this.clipboard.length) this.toast(`${this.clipboard.length} item${this.clipboard.length > 1 ? 's' : ''} copied`);
  }

  duplicate() {
    const objs = this.selected;
    if (!objs.length) return;
    const copies = objs.map((o) => this.cloneWithOffset(o, 28, 28));
    this.store.addMany(copies, 'duplicate');
    this.setSelection(copies.map((o) => o.id));
  }

  cloneWithOffset(o, dx, dy) {
    const c = structuredClone(o);
    c.id = uid(o.type[0]);
    if (c.type === 'stroke') {
      for (const p of c.points) { p.x += dx; p.y += dy; }
      c.bbox = { ...c.bbox, x: c.bbox.x + dx, y: c.bbox.y + dy };
    } else { c.x += dx; c.y += dy; }
    delete c.locked;
    return c;
  }

  paste() {
    if (!this.clipboard.length) return;
    const copies = this.clipboard.map((o) => this.cloneWithOffset(o, 32, 32));
    this.store.addMany(copies, 'paste');
    this.setSelection(copies.map((o) => o.id));
    this.clipboard = copies.map((o) => structuredClone(o));
  }

  /* ---------------- UI sync ---------------- */
  syncUI() {
    syncToolbar(this);
    updateSelectionBar(this);
    this.syncZoom();
    this.interaction?.refreshInkCursor?.();
  }

  syncZoom() {
    const pct = Math.round(this.surface.cam.z * 100);
    const el = document.getElementById('zoomLabel');
    if (el) el.textContent = pct + '%';
    // the page readout follows the camera, not the document, so it has to be
    // refreshed here as well as in syncUI - otherwise scrolling from page 1 to
    // page 2 leaves the navigator insisting you are still on page 1
    this.syncPageLabel();
    if (pct !== this._lastZoomPct) {
      if (this._lastZoomPct !== undefined) this.flashZoom(pct);
      this._lastZoomPct = pct;
    }
  }

  syncPageLabel() {
    const bar = document.getElementById('pagebar');
    if (!bar) return;
    const n = this.pageCount;
    bar.hidden = n === 0;
    if (!n) return;
    const i = this.currentPageIndex();
    const label = document.getElementById('pageLabel');
    if (label) label.textContent = `Page ${i + 1} of ${n}`;
    bar.querySelector('[data-page="prev"]').disabled = i <= 0;
    bar.querySelector('[data-page="next"]').disabled = i >= n - 1;
  }

  /**
   * A one-off tip in the top-right corner.
   *
   * Shown once per subject and never again - a hint that keeps reappearing is
   * an advert. It is passive: it steals no focus, blocks nothing, and closes
   * itself. `id` is what makes it one-off, so give each tip its own.
   */
  showHint(id, html, ms = 11000) {
    const host = document.getElementById('hints');
    if (!host) return false;
    const seen = this.settings.hintsSeen || (this.settings.hintsSeen = {});
    if (seen[id]) return false;

    const close = h('button', { class: 'hint-x', title: 'Dismiss', html: icon('close', 13) });
    const el = h('div', { class: 'hint' }, h('div', { html }), close);
    const go = () => {
      if (!el.isConnected) return;
      el.classList.add('go');
      setTimeout(() => el.remove(), 320);
    };
    const remember = () => { seen[id] = true; this.saveSettings(); };
    close.addEventListener('click', () => { remember(); go(); });
    host.appendChild(el);
    // seeing it counts, whether or not it is dismissed by hand
    remember();
    setTimeout(go, ms);
    return true;
  }

  /** A big centred readout while zooming, the way Whiteboard shows it. */
  flashZoom(pct) {
    const pill = document.getElementById('zoomPill');
    if (!pill) return;
    pill.textContent = pct + '%';
    pill.classList.add('show');
    clearTimeout(this._zoomPillTimer);
    this._zoomPillTimer = setTimeout(() => pill.classList.remove('show'), 850);
  }

  showContextMenu(e) { showContextMenu(this, e); }
  hideMenus() { closePopover(); }

  /* ---------------- notifications & dialogs ---------------- */
  toast(message, iconName = 'check', ms = 2600) {
    const host = document.getElementById('toasts');
    const el = h('div', { class: 'toast' }, h('span', { html: icon(iconName, 16), style: 'display:flex' }), h('span', {}, message));
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, ms);
  }

  /* ================================================================= *
   *  Pages
   *
   *  A board is either an infinite canvas or a pad: a strip of sheets laid
   *  out top to bottom in the same world coordinates. Everything below works
   *  in terms of that strip; nothing else in the app needed to learn about
   *  pages, because a page is just a rectangle.
   * ================================================================= */

  get pages() { return this.store.doc.pages; }
  get pageCount() { return this.store.doc.pages.length; }

  /** Which sheet the view is looking at, by what is in the middle of the window. */
  currentPageIndex() {
    const pages = this.pages;
    if (!pages.length) return -1;
    const sf = this.surface;
    const c = sf.cam.toWorld(sf.width / 2, sf.height / 2);
    return nearestPageIndex(pages, c.x, c.y);
  }

  /**
   * Set the paper size for the whole pad.
   *
   * Sizes apply to every sheet, the way a pad is all one size - and because
   * the strip is laid out from the sheet heights, changing the size relays it
   * and moves the ink on later pages with it, so page 3 stays page 3.
   *
   * @param {string} paperId  a PAPER id, or 'infinite'
   */
  async setPageSize(paperId, orientation = 'portrait') {
    const { pageWorldSize, paperById } = await import('./ui/pdfdialog.js');

    if (paperId === 'infinite' || !paperId) {
      this.store.setPages([], 'infinite canvas');
      this.toast('Infinite canvas');
      this.surface.invalidate();
      this.syncUI();
      return;
    }

    const size = pageWorldSize(paperId, orientation);
    if (!size) return;
    const count = Math.max(1, this.pageCount);
    const next = Array.from({ length: count }, () => ({ ...size }));

    // objects ride their sheet to its new place in the strip
    const ops = [this.store.pagesOp(next)];
    if (this.pageCount) ops.push(...this.relayoutOps(this.pages, next));

    this.settings.pageOrientation = orientation;
    this.settings.pagePaper = paperId;
    this.saveSettings();
    this.store.commit('page size', ops);
    this.fitToPage(Math.min(this.currentPageIndex(), count - 1));
    this.toast(`${paperById(paperId).label} ${orientation}${count > 1 ? ` — ${count} pages` : ''}`);
    this.surface.invalidate();
    this.syncUI();
  }

  /**
   * `set` ops that carry each sheet's contents from an old layout to a new one.
   *
   * Sheets are positioned by their index, so inserting, deleting or resizing a
   * page moves every page after it. The ink has to move with it or page 3's
   * notes would end up in page 2's gutter.
   *
   * @param {Array} from  the page list the objects are currently placed against
   * @param {Array} to    the page list they should end up on
   * @param {Function} map  old index -> new index, or -1 to leave an object be
   */
  relayoutOps(from, to, map = (i) => i) {
    const a = pageRects(from), b = pageRects(to);
    const ops = [];
    for (const o of this.store.objects) {
      const i = pageIndexForBox(from, boundsOf(o));
      if (i < 0) continue;                       // loose content stays put
      const j = map(i);
      if (j < 0 || j >= b.length || !a[i]) continue;
      const dx = b[j].x - a[i].x, dy = b[j].y - a[i].y;
      if (!dx && !dy) continue;
      const copy = structuredClone(o);
      translateObject(copy, dx, dy);
      ops.push(o.type === 'stroke'
        ? { t: 'set', id: o.id, before: { points: structuredClone(o.points), bbox: { ...o.bbox } }, after: { points: copy.points, bbox: copy.bbox } }
        : { t: 'set', id: o.id, before: { x: o.x, y: o.y }, after: { x: copy.x, y: copy.y } });
    }
    return ops;
  }

  /** Add a sheet after `index` (default: after the one you are looking at). */
  addPage(index = this.currentPageIndex(), { copyOf = -1 } = {}) {
    if (!this.pageCount) { this.toast('This board is an infinite canvas'); return false; }
    const at = clamp(index + 1, 0, this.pageCount);
    const size = { ...this.pages[clamp(index, 0, this.pageCount - 1)] };
    const next = this.pages.map((p) => ({ ...p }));
    next.splice(at, 0, size);

    // everything from `at` onwards shifts one place down the strip
    const ops = [...this.relayoutOps(this.pages, next, (i) => (i >= at ? i + 1 : i)), this.store.pagesOp(next)];

    if (copyOf >= 0 && copyOf < this.pageCount) {
      const srcRect = pageRects(this.pages)[copyOf];
      const dstRect = pageRects(next)[at];
      for (const o of this.store.objects) {
        if (pageIndexForBox(this.pages, boundsOf(o)) !== copyOf) continue;
        const copy = structuredClone(o);
        copy.id = uid(o.type === 'stroke' ? 's' : 'o');
        delete copy.attachedTo;
        translateObject(copy, dstRect.x - srcRect.x, dstRect.y - srcRect.y);
        ops.push({ t: 'add', obj: copy });
      }
    }

    this.store.commit(copyOf >= 0 ? 'duplicate page' : 'add page', ops);
    this.goToPage(at);
    this.toast(copyOf >= 0 ? `Page ${at + 1} duplicated` : `Page ${at + 1} of ${next.length}`);
    return true;
  }

  duplicatePage(index = this.currentPageIndex()) { return this.addPage(index, { copyOf: index }); }

  /**
   * Remove a sheet and everything on it.
   *
   * Deleting a page throws away work, so it asks first when the page is not
   * empty - and the whole thing (the objects, the page, and moving every later
   * page up) is one transaction, so a single undo brings the page back intact.
   */
  async deletePage(index = this.currentPageIndex()) {
    if (this.pageCount <= 1) { this.toast('A pad needs at least one page'); return false; }
    if (index < 0 || index >= this.pageCount) return false;

    const doomed = this.store.objects.filter((o) => pageIndexForBox(this.pages, boundsOf(o)) === index);
    if (doomed.length) {
      const answer = await this.choose(
        `Delete page ${index + 1}?`,
        `${doomed.length === 1 ? 'One thing is' : doomed.length + ' things are'} on it. Deleting the page deletes them too — one undo brings it all back.`,
        [{ id: 'delete', label: 'Delete the page', primary: true }, { id: 'keep', label: 'Keep it' }]
      );
      if (answer !== 'delete') return false;
    }

    const next = this.pages.map((p) => ({ ...p }));
    next.splice(index, 1);
    const ops = [
      ...doomed.map((o) => ({ t: 'del', id: o.id, obj: structuredClone(o), index: this.store.indexOf(o.id) })),
      ...this.relayoutOps(this.pages, next, (i) => (i === index ? -1 : i > index ? i - 1 : i)),
      this.store.pagesOp(next)
    ];
    this.store.commit('delete page', ops);
    this.setSelection([]);
    this.goToPage(Math.min(index, next.length - 1));
    this.toast(`Page deleted — ${next.length} left`);
    return true;
  }

  goToPage(index) {
    if (!this.pageCount) return;
    const i = clamp(index, 0, this.pageCount - 1);
    this.fitToPage(i);
    this.syncUI();
  }

  nextPage() { this.goToPage(this.currentPageIndex() + 1); }
  prevPage() { this.goToPage(this.currentPageIndex() - 1); }

  /** Everything that is not fully inside some sheet. Empty on an infinite board. */
  offPageObjects() {
    const pages = this.pages;
    if (!pages.length) return [];
    const rects = pageRects(pages);
    return this.store.objects.filter((o) => {
      const b = boundsOf(o);
      const i = pageIndexForBox(pages, b);
      if (i < 0) return true;
      const r = rects[i];
      return b.x < r.x - 0.5 || b.y < r.y - 0.5 || b.x + b.w > r.x + r.w + 0.5 || b.y + b.h > r.y + r.h + 0.5;
    });
  }

  /**
   * Bring stray content back onto the paper.
   *
   * On a single sheet that means shrinking and centring the whole board, which
   * is what someone means by "fit it on the page". On a pad it means nudging
   * each stray thing onto the sheet it is nearest, because squashing pages two
   * and three onto page one is nobody's idea of fitting. Either way it is one
   * commit, so one undo puts it all back.
   *
   * @returns {boolean} false when there was nothing to do
   */
  fitContentToPage(margin = 24) {
    const pages = this.pages;
    if (!pages.length) { this.toast('This board has no page — it is an infinite canvas'); return false; }
    const rects = pageRects(pages);

    if (pages.length === 1) {
      const page = rects[0];
      const b = this.store.contentBounds();
      if (!b || !b.w || !b.h) { this.toast('Nothing on the board yet'); return false; }
      const availW = page.w - margin * 2, availH = page.h - margin * 2;
      const scale = Math.min(availW / b.w, availH / b.h, 1);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const tx = page.x + page.w / 2, ty = page.y + page.h / 2;

      this.store.updateMany(this.store.objects.map((o) => o.id), (o) => {
        const copy = structuredClone(o);
        scaleObject(copy, scale, scale, cx, cy);       // about the content's own centre
        translateObject(copy, tx - cx, ty - cy);       // then centre that on the sheet
        return patchFor(o, copy);
      }, 'fit to page');
      this.setSelection([]);
      this.fitToPage(0);
      this.toast(scale < 1 ? `Fitted to the page at ${Math.round(scale * 100)}%` : 'Centred on the page');
      return true;
    }

    const stray = this.offPageObjects();
    if (!stray.length) { this.toast('Everything is already on a page'); return false; }
    this.store.updateMany(stray.map((o) => o.id), (o) => {
      const b = boundsOf(o);
      let i = pageIndexForBox(pages, b);
      if (i < 0) i = nearestPageIndex(pages, b.x + b.w / 2, b.y + b.h / 2);
      const r = { x: rects[i].x + margin, y: rects[i].y + margin, w: rects[i].w - margin * 2, h: rects[i].h - margin * 2 };
      const copy = structuredClone(o);
      const s = Math.min(r.w / b.w, r.h / b.h, 1);
      if (s < 1) scaleObject(copy, s, s, b.x + b.w / 2, b.y + b.h / 2);
      const { dx, dy } = offsetIntoRect(boundsOf(copy), r);
      translateObject(copy, dx, dy);
      return patchFor(o, copy);
    }, 'fit to pages');
    this.setSelection([]);
    this.toast(`Brought ${stray.length === 1 ? 'one thing' : stray.length + ' things'} back onto the paper`);
    return true;
  }

  /** Sit one sheet in the window, with a little room around it. */
  fitToPage(index = 0) {
    const rects = pageRects(this.pages);
    if (!rects.length) return;
    const r = rects[clamp(index, 0, rects.length - 1)];
    const sf = this.surface;
    const box = { x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 };
    if (sf.width && sf.height) sf.cam.fit(box, sf.width, sf.height);
    sf.clampCamera();
    this.syncZoom();
    sf.invalidate();
  }

  /** Sit the whole pad in the window. */
  fitToAllPages() {
    const b = stripBounds(this.pages);
    if (!b) return;
    const sf = this.surface;
    if (sf.width && sf.height) sf.cam.fit({ x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 }, sf.width, sf.height);
    sf.clampCamera();
    this.syncZoom();
    sf.invalidate();
  }

  /** Ask for page setup, remember the answer, then export. */
  /**
   * Warn before an export silently crops.
   *
   * With a page set, exports cover the sheet - so anything off the sheet is
   * dropped. Losing part of a board to a crop nobody mentioned is exactly the
   * sort of thing people only notice after they have handed the PDF out.
   *
   * @returns {Promise<boolean>} false to abandon the export
   */
  async checkOffPageBeforeExport() {
    const off = this.offPageObjects();
    if (!off.length) return true;
    const n = off.length;
    const answer = await this.choose(
      n === 1 ? 'One thing is off the page' : `${n} things are off the page`,
      'Exports cover the sheet, so anything outside it will be left out. You can shrink the board to fit first, or export the sheet as it is.',
      [{ id: 'fit', label: 'Fit everything on', primary: true },
       { id: 'crop', label: 'Export the sheet anyway' }]
    );
    if (answer === null) return false;
    if (answer === 'fit') this.fitContentToPage();
    return true;
  }

  async exportPdfWithSetup() {
    if (!this.store.objects.length) { this.toast('Nothing on the board to export'); return null; }
    if (!(await this.checkOffPageBeforeExport())) return null;
    const { choosePageSetup, paperForPage } = await import('./ui/pdfdialog.js');
    const page = this.store.page;
    let box;
    if (page && page.w && page.h) {
      box = { x: -page.w / 2, y: -page.h / 2, w: page.w, h: page.h };
      // the board already has a paper size - start the dialog on it
      const match = paperForPage(page);
      if (match) {
        this.settings.pdfPaper = match.paper;
        this.settings.pdfOrientation = match.orientation;
        this.settings.pdfMode = 'fit';
      }
    } else {
      const b = this.store.contentBounds();
      box = { x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 };
    }
    const opts = await choosePageSetup(this, box);
    if (!opts) return null;
    Object.assign(this.settings, {
      pdfPaper: opts.paper, pdfOrientation: opts.orientation, pdfMargin: opts.margin,
      pdfMode: opts.mode, pdfQuality: opts.quality
    });
    this.saveSettings();
    return exportPdf(this, opts);
  }

  showProgress(title, text) {
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    card.innerHTML = '';
    const label = h('p', {}, text || '');
    const bar = h('div', { class: 'bar' }, h('i', {}));
    card.appendChild(h('h3', {}, title));
    card.appendChild(label);
    card.appendChild(bar);
    overlay.classList.add('show');
    return {
      update: (frac, msg) => { bar.firstChild.style.width = Math.round(clamp(frac, 0, 1) * 100) + '%'; if (msg) label.textContent = msg; },
      close: () => overlay.classList.remove('show')
    };
  }

  /**
   * A confirm with more than two ways out.
   * @param {{id:string,label:string,primary?:boolean}[]} choices
   * @returns {Promise<string|null>} the chosen id, or null if cancelled
   */
  /**
   * @param {object} opts
   * @param {boolean} opts.cancel  show a Cancel button (default true). Turn it
   *   off for a question whose own answers already cover every outcome - a
   *   third button that means neither yes nor no just invites a null the
   *   caller then has to guess the meaning of.
   */
  choose(title, text, choices, { cancel = true } = {}) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      const done = (v) => { overlay.classList.remove('show'); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      card.appendChild(h('h3', {}, title));
      card.appendChild(h('p', {}, text));
      const row = h('div', { class: 'actions', style: 'flex-wrap:wrap;gap:8px' });
      if (cancel) row.appendChild(h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'));
      for (const c of choices) {
        row.appendChild(h('button', { class: 'btn' + (c.primary ? ' primary' : ''), onclick: () => done(c.id) }, c.label));
      }
      card.appendChild(row);
      overlay.classList.add('show');
    });
  }

  confirm(title, text, confirmLabel = 'OK') {
    return new Promise((resolve) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      const done = (v) => { overlay.classList.remove('show'); resolve(v); };
      card.appendChild(h('h3', {}, title));
      card.appendChild(h('p', {}, text));
      card.appendChild(h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => done(true) }, confirmLabel)));
      overlay.classList.add('show');
    });
  }

  /* ================================================================= *
   *  Updates
   *
   *  GazBoard has no account, no telemetry and no cloud, and an update check
   *  is the single exception - so it is the single thing the app asks
   *  permission for. Until that question is answered, nothing is sent
   *  anywhere. The check itself only reads: it fetches the newest release tag
   *  from a public endpoint and compares it with this build's version. It
   *  never downloads or installs anything; the most it will do is offer to
   *  open the releases page in your browser.
   * ================================================================= */
  static UPDATE_INTERVAL = 24 * 60 * 60 * 1000;

  /** Consent first if it has never been given, otherwise a quiet daily look. */
  async startUpdateFlow() {
    try {
      if ((await this.appInfo())?.smoke) return;
      this.showHint('panning',
        'Moving around: drag with the <b>middle mouse button</b>, hold <b>Space</b> and drag, '
        + 'or pick the <b>Pan</b> tool (<b>G</b>) from the toolbar. The right button drags too, '
        + 'and the scroll wheel works as usual.');
      if (this.settings.updateCheck === null || this.settings.updateCheck === undefined) {
        // Dismissing the question means "not now", and not now should last
        // longer than one launch. It used to come back every single time the app
        // opened until it got a click, which is nagging, and easy to mistake for
        // the app having forgotten an answer you did give.
        const asked = this.settings.updateAskedAt || 0;
        if (Date.now() - asked > App.ASK_AGAIN_AFTER) await this.askAboutUpdates();
      }
      else if (this.settings.updateCheck) await this.checkForUpdates({ silent: true });
    } catch { /* an update check must never be able to break the app */ }
  }

  /** Ask once, on the first launch that gets far enough to matter. */
  async askAboutUpdates() {
    if (this.settings.updateCheck !== null && this.settings.updateCheck !== undefined) return;
    const answer = await this.choose(
      'Check for updates?',
      'GazBoard can ask GitHub once a day whether a newer version has been released, and tell you if there is one. It never downloads or installs anything on its own, and nothing about you or your boards is ever sent. Everything else in the app stays offline either way.',
      [{ id: 'yes', label: 'Yes, tell me about updates', primary: true },
       { id: 'no', label: 'No, stay fully offline' }],
      { cancel: false }
    );
    // Escape, or anything that is not a real answer, means "not now" - leave
    // the question unanswered so it is asked again rather than silently
    // recording a no that can never be revisited.
    if (answer !== 'yes' && answer !== 'no') {
      this.settings.updateAskedAt = Date.now();   // asked, not answered
      this.saveSettings();
      return;
    }
    this.settings.updateCheck = answer === 'yes';
    this.saveSettings();
    if (answer === 'yes') this.checkForUpdates({ silent: true });
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.silent   say nothing when already up to date
   * @param {boolean} opts.force    ignore the once-a-day limit and any skip
   */
  async checkForUpdates({ silent = false, force = false } = {}) {
    if (!force) {
      if (!this.settings.updateCheck) return null;
      if (Date.now() - (this.settings.lastUpdateCheck || 0) < App.UPDATE_INTERVAL) return null;
    }
    const res = await window.board.checkForUpdate();
    this.settings.lastUpdateCheck = Date.now();
    this.saveSettings();

    if (!res || !res.ok) {
      if (!silent) this.toast(res?.error ? `Could not check: ${res.error}` : 'Could not check for updates', 'help');
      return null;
    }
    const mine = (await this.appInfo())?.version || '0.0.0';
    if (!isNewer(res.version, mine)) {
      if (!silent) this.toast(`You are on the latest version (${mine})`);
      return null;
    }
    // a prerelease is never pushed at someone on a stable build
    if (res.prerelease && !force) return null;
    if (!force && this.settings.skippedVersion === res.version) return null;

    const answer = await this.choose(
      `GazBoard ${res.version} is available`,
      `You are running ${mine}. The download page opens in your browser — your boards and settings are untouched by installing over the top.`,
      [{ id: 'open', label: 'Open the download page', primary: true },
       { id: 'later', label: 'Later' },
       { id: 'skip', label: `Skip ${res.version}` }]
    );
    if (answer === 'open') await window.board.openReleases(res.url);
    else if (answer === 'skip') { this.settings.skippedVersion = res.version; this.saveSettings(); }
    return res;
  }

  /** Cached app:info, so the version is not re-fetched on every call. */
  async appInfo() {
    if (!this._appInfo) this._appInfo = await window.board.info();
    return this._appInfo;
  }

  showShortcuts() {
    const rows = [
      ['h', 'Tools'],
      ['Select', 'V'], ['Lasso select', 'L'], ['Laser pointer', 'X'], ['Pan the canvas', 'G'],
      ['Pen (last colour used)', 'P'], ['Highlighter', 'H'], ['Eraser', 'E'],
      ['Sticky note', 'N'], ['Text', 'T'], ['Shape', 'S'], ['Ruler', 'Ctrl+R'],
      ['h', 'Pens'],
      ...PENS.map((pen, i) => [pen.label, String(i + 1)]),
      ['h', 'Canvas'],
      ['Pan', 'Space + drag, or middle-drag'], ['Zoom', 'Ctrl + wheel, or pinch'],
      ['Pan while drawing', 'Hold any mouse button, or scroll'],
      ['Auto-pan while drawing', 'Run the pen into the edge of the window'],
      ['Zoom in / out', 'Ctrl + = / Ctrl + -'], ['Reset zoom', 'Ctrl+0'], ['Fit to board', 'Ctrl+Shift+F'],
      ['h', 'Editing'],
      ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'], ['Copy / Cut / Paste', 'Ctrl+C / Ctrl+X / Ctrl+V'],
      ['Duplicate', 'Ctrl+D'], ['Delete', 'Delete'], ['Select all', 'Ctrl+A'],
      ['Edit text of selection', 'F2 or double-click'], ['Nudge selection', 'Arrow keys'],
      ['Bring to front / Send to back', 'Ctrl+Shift+] / Ctrl+Shift+['],
      ['Constrain / square', 'Hold Shift while drawing'],
      ['h', 'Files'],
      ['New board', 'Ctrl+N'], ['Open board', 'Ctrl+O'], ['Save a copy', 'Ctrl+S'],
      ['Insert image or document', 'Drag a file onto the canvas']
    ];
    const grid = h('div', { class: 'sc-grid' });
    for (const [a, b] of rows) {
      if (a === 'h') { grid.appendChild(h('h5', {}, b)); continue; }
      grid.appendChild(h('span', {}, a));
      grid.appendChild(h('kbd', {}, b));
    }
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    card.innerHTML = '';
    card.appendChild(h('h3', {}, 'Keyboard shortcuts'));
    card.appendChild(grid);
    card.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => overlay.classList.remove('show') }, 'Close')));
    overlay.classList.add('show');
  }

  async showAbout() {
    const i = await window.board.info();
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    card.innerHTML = '';
    card.appendChild(h('h3', { style: 'margin-bottom:2px' }, 'GazBoard ' + i.version));
    card.appendChild(h('p', {
      style: 'margin:0 0 14px;font-size:13px;color:var(--text-2);letter-spacing:.02em',
      html: 'by <b style="color:var(--accent)">theBoringCodes</b>'
    }));
    card.appendChild(h('p', { html:
      `A free-form digital whiteboard for pen, sticky notes, shapes, text, images and documents.` +
      `<br><br>Runs entirely on this computer — no account, no sign-in, no cloud.` }));
    card.appendChild(h('div', {
      style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12.5px;line-height:1.8;color:var(--text-2)',
      html:
        `Developer &nbsp;<b style="color:var(--text)">MD. Fakhruddin Gazzali</b><br>` +
        `Contact &nbsp;<a href="mailto:fahim9778@gmail.com" target="_blank" style="color:var(--accent)">fahim9778@gmail.com</a><br>` +
        `Created with <span style="color:#e81123">&hearts;</span> with Claude Cowork` }));
    const platformDetails = i.electron
      ? `Office import: <b>${i.libreoffice ? 'LibreOffice detected (high fidelity)' : 'built-in converter (install LibreOffice for higher fidelity)'}</b><br>Electron ${i.electron} · Chromium ${i.chrome}`
      : `Runtime: <b>Web / Progressive Web App</b> · ${i.pwa ? 'Standalone App' : 'Browser'}<br>Persistence: <b>IndexedDB Persistent Storage</b>`;
    card.appendChild(h('div', {
      style: 'margin-top:12px;font-size:11.5px;color:var(--text-2);line-height:1.7',
      html: platformDetails
    }));
    // Next to the version number is where anyone looks for this.
    const check = h('button', { class: 'btn' }, 'Check for updates');
    check.addEventListener('click', async () => {
      check.textContent = 'Checking…';
      check.setAttribute('disabled', '');
      overlay.classList.remove('show');
      await this.checkForUpdates({ force: true });
    });
    card.appendChild(h('div', { class: 'actions' },
      check,
      h('button', { class: 'btn primary', onclick: () => overlay.classList.remove('show') }, 'Close')));
    overlay.classList.add('show');
  }

  /* ---------------- global events ---------------- */
  wireGlobalEvents() {
    const titleEl = document.getElementById('boardTitle');
    titleEl.addEventListener('change', () => this.store.rename(titleEl.value.trim() || 'Untitled board'));
    titleEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') titleEl.blur(); });

    window.board.onMenu((id) => this.command(id));

    // The main process asks for a flush before it quits; write out anything the
    // autosave debounce is still sitting on.
    window.board.onFlush(async () => {
      try {
        this.textEditor.commit();
        await this.persist();
      } catch (e) { console.warn('flush failed:', e); }
    });

    // Losing focus is the cheapest moment to make sure work is on disk - it is
    // what happens just before someone alt-tabs away and shuts the machine down.
    window.addEventListener('blur', () => {
      if (this.settings.autosave) this.persist();
    });
    window.board.onOpenFile((data) => {
      // Set before the await, not after: restoreLastBoard is in flight and must
      // see this the moment the file arrives, not once it has finished loading.
      this.boardOpenedExplicitly = true;
      // fire-and-forget from the main process: nothing is waiting on it, so a
      // failure has to be reported here rather than escaping as a rejection
      this.loadBoard(data).catch(() => this.toast('Could not open that board'));
    });
    window.board.onWindowResized(() => {
      // the window changed shape - re-measure now and again after layout settles
      this.surface.resize();
      requestAnimationFrame(() => { this.surface.resize(); this.textEditor.reposition(); this.syncUI(); });
    });

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') this.interaction.spaceDown = false; });
    window.addEventListener('blur', () => { this.interaction.spaceDown = false; });

    // paste from the system clipboard
    document.addEventListener('paste', async (e) => {
      if (this.textEditor.active) return;
      const items = [...(e.clipboardData?.items || [])];
      const imageItem = items.find((i) => i.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
        await insertImageFiles(this, [file], { x: view.x + view.w / 2, y: view.y + view.h / 2 });
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim()) {
        e.preventDefault();
        const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
        const o = {
          id: uid('t'), type: 'text', x: view.x + view.w / 2 - 200, y: view.y + view.h / 2 - 40,
          w: this.worldSize(420), h: Math.max(this.worldSize(60), text.split('\n').length * this.worldSize(this.settings.textSize) * 1.3),
          text: text.trim(), rotation: 0, color: this.settings.textColor, fontSize: this.worldSize(this.settings.textSize),
          align: 'left', valign: 'top', font: this.settings.textFont, background: 'none'
        };
        this.store.add(o, 'paste text');
        this.setSelection([o.id]);
        return;
      }
      if (this.clipboard.length) { e.preventDefault(); this.paste(); }
    });

    // drag & drop files
    const stage = document.getElementById('stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    stage.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      const at = this.surface.toWorld(e);
      const paths = files.map((f) => f.path).filter(Boolean);
      if (paths.length) {
        const imgs = paths.filter(isImagePath);
        const docs = paths.filter(isDocPath);
        if (imgs.length) await insertImagesFromPaths(this, imgs);
        for (const d of docs) await insertDocument(this, d);
        if (!imgs.length && !docs.length) this.toast('Unsupported file type');
      } else {
        await insertImageFiles(this, files, at);
      }
    });

    window.addEventListener('resize', () => this.textEditor.reposition());
    document.addEventListener('wheel', () => this.textEditor.reposition(), { passive: true });
    window.addEventListener('beforeunload', () => {
      if (this.settings.autosave) this.persist();
    });
  }

  onKeyDown(e) {
    if (this.textEditor.active) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const mod = e.ctrlKey || e.metaKey;

    if (e.code === 'Space') { this.interaction.spaceDown = true; e.preventDefault(); return; }

    if (this.pageCount) {
      if (e.key === 'PageDown') { e.preventDefault(); this.command('page.next'); return; }
      if (e.key === 'PageUp') { e.preventDefault(); this.command('page.prev'); return; }
      if (e.key === 'Home' && !mod) { e.preventDefault(); this.goToPage(0); return; }
      if (e.key === 'End' && !mod) { e.preventDefault(); this.goToPage(this.pageCount - 1); return; }
    }

    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.command('undo'); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); this.command('redo'); return; }
      if (k === 'a') { e.preventDefault(); this.command('edit.selectAll'); return; }
      if (k === 'c') { this.command('edit.copy'); return; }
      if (k === 'x') { this.command('edit.cut'); return; }
      if (k === 'd') { e.preventDefault(); this.command('edit.duplicate'); return; }
      if (k === 's') { e.preventDefault(); this.command('board.save'); return; }
      if (k === 'o') { e.preventDefault(); this.command('board.open'); return; }
      if (k === 'n') { e.preventDefault(); this.command('board.new'); return; }
      if (k === 'r') { e.preventDefault(); this.command('ruler'); return; }
      if (k === '0') { e.preventDefault(); this.command('zoomReset'); return; }
      if (k === '=' || k === '+') { e.preventDefault(); this.command('zoomIn'); return; }
      if (k === '-') { e.preventDefault(); this.command('zoomOut'); return; }
      if (k === 'f' && e.shiftKey) { e.preventDefault(); this.command('fit'); return; }
      if (k === ']') { e.preventDefault(); this.command(e.shiftKey ? 'order.front' : 'order.forward'); return; }
      if (k === '[') { e.preventDefault(); this.command(e.shiftKey ? 'order.back' : 'order.backward'); return; }
      return;
    }

    switch (e.key) {
      case 'Delete': case 'Backspace': e.preventDefault(); this.command('edit.delete'); return;
      case 'Escape':
        if (this.panels.open) this.panels.close();
        else { closePopover(); this.setSelection([]); }
        return;
      case 'F2': {
        const o = this.selected[0];
        if (o && ['note', 'text', 'shape', 'table'].includes(o.type)) this.beginTextEdit(o);
        return;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!this.surface.selection.size) return;
        e.preventDefault();
        const step = (e.shiftKey ? 20 : 2) / this.surface.cam.z;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const ids = withAttached(this.store, [...this.surface.selection])
          .filter((id) => !this.store.get(id)?.locked);
        if (!ids.length) { this.hintLocked(); return; }
        const snap = this.store.snapshot(ids);
        for (const id of ids) {
          const o = this.store.get(id);
          if (!o) continue;
          if (o.type === 'stroke') { for (const p of o.points) { p.x += dx; p.y += dy; } o.bbox.x += dx; o.bbox.y += dy; }
          else { o.x += dx; o.y += dy; }
        }
        this.store.commitSnapshot('nudge', snap);
        return;
      }
    }

    // 1-6 reach straight for a pen from the tray. Switching colour mid-sentence
    // is the commonest thing anyone does while teaching, and doing it by number
    // beats travelling to the toolbar with the mouse.
    if (e.key >= '1' && e.key <= '9') {
      const pen = PENS[Number(e.key) - 1];
      if (pen) {
        e.preventDefault();
        this.settings.penColor = pen.color;
        this.settings.penEffect = pen.effect;
        this.saveSettings();
        this.setTool('pen');
        this.syncUI();
        this.toast(pen.label, 'pen');
        return;
      }
    }

    const keyTool = { v: 'select', l: 'lasso', p: 'pen', h: 'highlighter', e: 'eraser', n: 'note', t: 'text', s: 'shape', x: 'laser', g: 'pan' }[e.key.toLowerCase()];
    if (keyTool) { this.setTool(keyTool); return; }
    if (e.key === '?') this.showShortcuts();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});

/**
 * The `set` payload that moves an object from `o` to `copy`.
 *
 * Strokes carry their geometry in points+bbox and everything else in x/y/w/h;
 * sending the wrong pair leaves an object that renders in one place and hit
 * tests in another.
 */
function patchFor(o, copy) {
  if (o.type === 'stroke') {
    const patch = { points: copy.points, bbox: copy.bbox, width: copy.width };
    return patch;
  }
  const patch = { x: copy.x, y: copy.y, w: copy.w, h: copy.h };
  if (copy.fontSize !== undefined) patch.fontSize = copy.fontSize;
  if (copy.lineWidth !== undefined) patch.lineWidth = copy.lineWidth;
  if (copy.autoSize !== undefined) patch.autoSize = copy.autoSize;
  return patch;
}
