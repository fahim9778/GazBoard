// GazBoard - application shell and command surface.

import './platform/platform.js';
import { t, translatePage, currentLanguage } from './i18n.js';
import { loadInstalled, onFontsChanged, packFor, isInstalled, download as downloadFontPack, sizeLabel } from './fontpack.js';
import { Store, withAttached, withGroups, groupMembers, worldBounds, boundsOf, setConnectorBounds, emptyDoc } from './core/store.js';
import { useConnectorStore, connectorBounds, ROUTES, holds } from './core/connectors.js';
import { setBoardDirectory, setCurrentBoard, lookupBoard, onDirectoryChange, refLabel, refsAsWords, linkedRefs, allBoards, remapBoardIds } from './core/boardrefs.js';
import { exportBoards } from './board-export.js';
import { openBoardPicker } from './ui/boardpicker.js';
import { scaleObject, translateObject } from './core/transform.js';
import { Surface } from './core/surface.js';
import { Interaction } from './core/tools.js';
import { InkTrail } from './core/inktrail.js';
import { pick, ghost } from './core/hit.js';
import { uid, debounce, clamp, unionBox } from './core/util.js';
import { pageRects, stripBounds, pageIndexForBox, nearestPageIndex, offsetIntoRect, PAGE_GAP, todayStamp } from './core/pages.js';
import { isNewer } from './core/version.js';
import { emojiAspect, forgetEmojiMetrics, setDarkBoard } from './core/render.js';
import { objectRuns, runsToHtml, htmlToRuns, normalizeRuns, AUTO_INK } from './core/richtext.js';
import { folderOf, folderPath, folderList, createFolder, renameFolder, moveBoard } from './core/folders.js';
import { TextEditor } from './ui/textedit.js';
import { MathEditor } from './ui/mathedit.js';
import { mathReady, mathsReady, naturalSize, sizeOfBox, onMathArrived } from './core/maths.js';
import { initToolbar, syncToolbar } from './ui/toolbar.js';
import { initPresentBar, syncPresentBar } from './ui/present.js';
import { ClassTimer } from './ui/timer.js';
import { createPanels } from './ui/panels.js';
import { showContextMenu, updateSelectionBar } from './ui/contextmenu.js';
import { closePopover, popoverOpen, openPopover, h } from './ui/popover.js';
import { icon } from './ui/icons.js';
import { PENS, penById, rememberPen, heldPenId, FONTS } from './ui/palettes.js';
import { exportPng, exportSvg, exportPdf, saveBoardFile, openBoardFile, exportable } from './export.js';
import { boardThumb, boardPicture } from './ui/thumb.js';
import {
  pickAndInsertDocument, pickAndInsertImage, insertDocument,
  insertImagesFromPaths, insertImageFiles, clipboardFileName, dropOrigin, isImagePath, isDocPath
} from './insert.js';

export const DEFAULT_SETTINGS = {
  penColor: '#201f1e', penWidth: 4, penEffect: 'none', activePen: 'black',
  // Whether the look of the canvas - paper size, colour, pattern - is carried
  // to the NEXT new board. Boards already made are never touched by it.
  // `canvasDefaults` itself is deliberately absent, for the same reason `pens`
  // is: DEFAULT_SETTINGS is spread shallowly, so an object literal here would
  // be shared by every settings copy and the first change would write into the
  // defaults themselves, where Reset could never clear it.
  // OFF by default, deliberately. Turning it on changes what "New board" means,
  // and doing that to someone who once tried A4 months ago - handing them A4
  // for the rest of time without being asked - is not a favour. The switch sits
  // in the Canvas panel and adopts whatever is on screen the moment it is used.
  rememberCanvas: false,
  // 'system' follows the machine's own light/dark setting; 'light' and 'dark'
  // override it. System is the default because a whiteboard that quietly
  // matches the rest of the desktop is less surprising than one that picks.
  theme: 'system',
  // Deliberately absent: `pens`, the map of pens the user has recoloured.
  // DEFAULT_SETTINGS is spread shallowly, so an object literal here would be
  // THE SAME object in every settings copy - and the first recolouring would
  // write into the defaults themselves, where Reset could never clear it.
  // rememberPen() creates the map on first use; leaving it out is also what
  // makes Reset to defaults put every pen back to the colour it shipped with.
  highlighterColor: '#fff100', highlighterWidth: 20,
  eraserSize: 30, eraserMode: 'partial',
  pdfPaper: 'a4', pdfOrientation: '', pdfMargin: 'narrow', pdfMode: 'fit', pdfQuality: 2,
  noteColor: '#ffd94a', noteSize: 200, noteFont: 'hand',
  emojiChar: '\u2705', emojiSize: 96, emojiRecent: [],
  textColor: '#201f1e', textSize: 32, textFont: 'hand',
  shapeKind: 'rect', arrowRoute: 'straight', shapeStroke: '#201f1e', shapeFill: 'none', shapeLineWidth: 3, shapeDash: null,
  inkToShape: false, pressure: true, wheelZoom: false, returnToSelect: true, autosave: true,
  showGroupOutlines: true,
  edgePan: true, importQuality: 2, lowLatencyInk: false, inkTrail: false, boardsPage: true, mathSize: 36, officeImport: false, slidesFinalLook: true, patternSpacing: 40, pageDate: true, laserColor: '#ff2d2d',
  // My boards' folders: a catalogue on this device, never inside a board (core/folders.js)
  folders: [], boardFolders: {},
  /*
   * The letters under the tool icons.
   *
   * They are there so a shortcut gets FOUND - nobody memorises a sheet
   * mid-lesson, but they do notice a "P" under the pen. That reasoning needs a
   * keyboard to be worth anything. On a phone the letters are decoration on a
   * bar that has no room for decoration, so they start off; on a tablet with a
   * keyboard attached, or any machine with a real pointer, they start on.
   */
  showToolKeys: !(typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 760px)').matches),
  rightDragPans: true, hintsSeen: {},
  // null = never asked. Nothing reaches the network until this is true.
  updateCheck: null, lastUpdateCheck: 0, skippedVersion: null, updateAskedAt: 0,
  // 'auto': the mouse draws until a stylus turns up, then it pans and the pen
  // inks - decided fresh each session, never remembered. 'yes' and 'no' pin it.
  // See mouseInks().
  inkWithMouse: 'auto',
  // What you see while inking: 'nib' (drawn by us, so Windows cannot hide it
  // mid-stroke), 'arrow' or 'crosshair'. See inkPointerKind() in tools.js.
  inkPointer: 'nib',
  // Whether that nib also follows a FINGER. Off: a fingertip already covers
  // the spot, so the nib is hidden under the hand or sliding about on its own,
  // and a phone has no hover for it to belong to. On is for a touchscreen PC
  // whose owner wants it anyway. See showInkPointer() in tools.js.
  nibOnTouch: false,
  // A short two-note chime when a board starts arriving. On by default: the
  // thing it prevents is being halfway through a sentence when an "accept
  // this board?" dialog appears out of nowhere. See showReceiving().
  arrivalSound: true,
  // 'auto' | 'yes' | 'no' - see fingerInks(). Auto lets the hardware answer.
  inkWithFinger: 'auto',
  // Holding a stylus's side button while writing rubs out, the way it does in
  // Samsung's own apps. A pen's flip-over tail always erases and is not
  // affected by this. See effectiveTool() in tools.js.
  penButtonErases: true,
  // Sharing boards over the local network. Off, and off for everyone who
  // upgrades: nothing binds a port, announces itself or listens for anything
  // until this is switched on by hand. See initSync().
  sync: false,
  // What happens to a board once you have accepted it. True puts it in front of
  // you, which is what you want between your own two machines; false files it
  // in My boards and leaves you where you are, which is what you want when a
  // class is handing work in. Set from the checkbox on the arrival dialog as
  // readily as from Settings - the two are the same switch.
  syncOpenOnArrival: true,
  // Pictures go to the other device at board size (no longer than SEND_PICTURE_PX
  // on their long side) unless this is switched on. See picturesForSending().
  syncFullPictures: false
};

/** The longest side a picture is sent at, unless full size is asked for. Sharp on a board even zoomed in. */
const SEND_PICTURE_PX = 2000;

/**
 * One picture at sending size: no longer than SEND_PICTURE_PX on its long side,
 * and re-encoded if it is a very heavy file even at that size. Photos stay
 * JPEG; anything that may be see-through goes as WebP, which keeps that.
 * The original comes back unchanged if the new one would not be smaller, or
 * the picture cannot be read (an SVG, an animation, anything odd).
 */
async function shrinkPicture(src) {
  const m = /^data:(image\/(png|jpeg|jpg|webp));base64,/i.exec(src);
  if (!m) return src;
  const heavy = src.length > 1.5 * 1024 * 1024;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return src;
  const k = Math.min(1, SEND_PICTURE_PX / Math.max(w, h));
  if (k === 1 && !heavy) return src;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const jpeg = /jpe?g/i.test(m[2]);
  const out = c.toDataURL(jpeg ? 'image/jpeg' : 'image/webp', 0.86);
  // a browser that cannot write WebP hands back PNG, which may well be bigger: then keep the original
  return out.length < src.length && out.startsWith('data:image/') ? out : src;
}

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
  const name = String(base || t('Untitled board')).trim() || t('Untitled board');
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

  /** The most linked boards that may come along with one board sent over the network. */
  static MAX_LINKED = 50;

  /** How long a dismissed update question stays dismissed. */
  static ASK_AGAIN_AFTER = 7 * 24 * 60 * 60 * 1000;

  constructor() {
    // The words written into index.html itself, and the menu bar, in the
    // chosen language - before anything is built on top of them.
    translatePage();
    window.board?.setLanguage?.(currentLanguage());
    this.store = new Store();
    // arrows look up the things they hold on to on this board
    useConnectorStore(this.store);
    setConnectorBounds(connectorBounds);
    this.settings = this.loadSettings();
    // Before the Surface exists, so the very first frame is already the right
    // colour rather than a white flash that corrects itself a moment later.
    this.applyTheme();
    this.surface = new Surface(document.getElementById('c'), this.store, { lowLatency: !!this.settings.lowLatencyInk });
    this.surface.showGroupOutlines = this.settings.showGroupOutlines !== false;
    // Windows paints the last sliver of pen ink itself when this is on. Off
    // by default while it is an experiment; see inktrail.js.
    this.inkTrail = new InkTrail(this.surface.canvas);
    this.inkTrail.setEnabled(!!this.settings.inkTrail);
    this.tool = 'pen';
    this.clipboard = [];
    this.clipStamp = null;
    this.boardPoint = null;
    this.ruler = { visible: false, x: 0, y: 0, angle: 0, length: 900, thickness: 78, snap: true };
    this.textEditor = new TextEditor(this);
    this.mathEditor = new MathEditor(this);
    // Maths in text arrives a moment after the words around it: one repaint per frame catches it all up.
    let mathFrame = 0;
    onMathArrived(() => {
      if (mathFrame) return;
      mathFrame = requestAnimationFrame(() => { mathFrame = 0; this.surface?.repaintAll?.(); });
    });
    this.panels = createPanels(this);
    this.interaction = new Interaction(this);
    // Links to other boards show those boards' names and pictures: when the list changes, so do they.
    this.backStack = [];
    // Only a board that HAS links needs repainting - a full repaint on every
    // board switch would cost the pen its first stroke for nothing.
    onDirectoryChange(() => {
      if (this.store && linkedRefs(this.store.objects).length) this.surface?.repaintAll?.();
      this.syncBackPill();
    });

    initToolbar(this);
    // Presenting and the class timer. Neither is part of the board: both
    // belong to the lesson, so they live on the app and outlast a board switch.
    this.presenting = false;
    this.presentToolsPinned = false;
    initPresentBar(this);
    this.timer = new ClassTimer(document.getElementById('stage'), {
      box: this.settings.timerBox,
      onPlace: (box) => { this.settings.timerBox = box; this.saveSettings(); }
    });
    this.wireGlobalEvents();
    this.initDismissal();
    this.wireStore();
    this.initSync();
    // startupSettled tells the device tests (and anything else that needs to know) that
    // the board on screen is the one GazBoard opened on, not a stand-in about to be replaced.
    this.restoreLastBoard().finally(() => { this.startupSettled = true; });
    // Board text cannot wait the way emoji can: until its faces land, every
    // line on the board is measured in a stand-in font and wraps wrongly.
    this.loadBoardFonts();
    // A Chinese font downloaded on an earlier day is switched back on, and
    // the board repaints when one arrives or goes. See fontpack.js.
    onFontsChanged(() => { this.surface?.repaintAll?.(); this.panels?.fontsChanged?.(); });
    loadInstalled().finally(() => this.offerFontPack());
    // Emoji artwork can wait. Nothing on screen at start-up is an emoji, so
    // fetching and decoding half a megabyte of it while the board is still
    // restoring, wiring up and painting its first frame is work in the way of
    // work that matters. On a desktop the difference is invisible; on a slow
    // two-core machine it is the difference between a board that is ready and
    // one that is still busy.
    this.whenIdle(() => this.loadEmojiFont());
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
        // Two defaults were tried while 2.5.0 was being built and neither shipped:
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
      // Their own copies: the defaults' empty folder list must never be the
      // one that gets filed into.
      s.folders = Array.isArray(s.folders) ? s.folders.map((f) => ({ ...f })) : [];
      s.boardFolders = s.boardFolders && typeof s.boardFolders === 'object' ? { ...s.boardFolders } : {};
      return s;
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  saveSettings() {
    try { localStorage.setItem('gazboard.settings', JSON.stringify(this.settings)); } catch {}
    this.applyTheme();
    this.syncUI();
  }

  /**
   * Light or dark, and who decides.
   *
   * The choice lands in one place - a data-theme attribute on <html> - and the
   * stylesheet does the rest. Keeping it to one attribute means nothing else in
   * the app has to know a theme exists; a panel built tomorrow inherits it for
   * free because it is using the same variables everything else does.
   *
   * 'system' sets no attribute at all, leaving the CSS media query to answer.
   * That is deliberate: the machine can change its mind at sunset, and the page
   * should follow without anyone reopening the app.
   */
  applyTheme() {
    const want = this.settings.theme || 'system';
    const root = document.documentElement;
    if (want === 'light' || want === 'dark') root.dataset.theme = want;
    else delete root.dataset.theme;
    this.watchSystemTheme();
    // the board is painted on a canvas, which no stylesheet can reach
    setDarkBoard(this.darkMode);
    this.surface?.repaintAll?.();
    // the nib is a cursor, not a drawing - it has to be re-tinted by hand
    this.interaction?.refreshInkCursor?.();
    // the selection's colour dot shows default ink as drawn, which just changed
    if (this.surface?.selection?.size) { try { updateSelectionBar(this); } catch { /* no bar yet */ } }
    // and on a phone the status bar and navigation bar belong to Android, not
    // to this stylesheet - a dark board in a light frame is only half a theme
    try { window.board?.setTheme?.(want); } catch {}
  }

  /** Follow the machine's own setting while we are set to 'system'. */
  watchSystemTheme() {
    if (this._themeWatch) return;
    if (typeof matchMedia !== 'function') return;
    this._themeWatch = matchMedia('(prefers-color-scheme: dark)');
    this._themeWatch.addEventListener('change', () => {
      if ((this.settings.theme || 'system') !== 'system') return;
      setDarkBoard(this.darkMode);
      this.surface?.repaintAll?.();
      this.interaction?.refreshInkCursor?.();
      if (this.surface?.selection?.size) { try { updateSelectionBar(this); } catch { /* no bar yet */ } }
      this.syncUI();
    });
  }

  /** True when the board should be painted dark, whatever route got us there. */
  get darkMode() {
    const want = this.settings.theme || 'system';
    if (want === 'dark') return true;
    if (want === 'light') return false;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
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
    b.textContent = t('Saving…');
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
    await this.mathsReady();
    // a link to a board made since the list was last read would show as missing in the picture
    if (linkedRefs(this.store.objects).some((r) => !lookupBoard(r))) await this.refreshBoardDirectory();
    const pic = this.boardPictureFor(force);
    if (pic) doc.thumb = pic;
    await window.board.boards.save({ id: doc.id, json: JSON.stringify(doc) });
    this.unsavedNew = false;
    this._unsaved = false;
    this._lastSaveAt = performance.now();
    try { localStorage.setItem('gazboard.lastBoard', this.store.doc.id); } catch {}
    const b = document.getElementById('savedBadge');
    b.textContent = t('Saved');
  }

  /**
   * The little picture of this board that My boards shows.
   *
   * Drawing it costs a few milliseconds on a busy board, and autosave runs
   * often, so it is redrawn only when the board has changed AND the last one is
   * more than a few seconds old - or when a save was asked for, or the board
   * is a different one. In between, the last picture is saved again as it is,
   * so a save never drops it.
   */
  boardPictureFor(force = false) {
    const id = this.store.doc.id, rev = this.store.rev, now = Date.now();
    const p = this._pic;
    if (p && p.id === id && (p.rev === rev || (!force && now - p.at < 15000))) return p.url;
    const url = boardPicture(this.store.objects, this.store.doc.background);
    if (!url) return p && p.id === id ? p.url : null;
    this._pic = { id, rev, at: now, url };
    return url;
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
        ? t('One picture could not be found - its place is kept on the board')
        : t('{n} pictures could not be found - their places are kept on the board', { n: missing }), 'help', 6000);
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
     *
     * So does ink. Somebody who starts writing the moment the window appears
     * has made the board in front of them theirs; reopening the last board on
     * top of that, half a second later, would throw their first stroke away.
     */
    const rev0 = this.store.rev, doc0 = this.store.doc.id;
    const taken = () => this.boardOpenedExplicitly || this.store.rev !== rev0 || this.store.doc.id !== doc0 || !!this.interaction?.action;
    if (taken()) return;
    try {
      // Ask first, guess second. The main process knows a file was
      // double-clicked before this window even existed, so there is no need to
      // race it - if one is on its way, there is nothing here to decide.
      if ((await this.appInfo())?.pendingBoardFile) return;
      if (taken()) return;
      const res = await window.board.boards.resume();
      if (taken()) return;   // a file arrived, or somebody started writing, while we asked
      if (res && res.board) {
        await this.loadBoard(res.board, { silent: true, startup: true });
        if (res.reason === 'newest') this.toast(t('Reopened your most recent board'));
        return;
      }
    } catch (e) { console.warn('resume failed, falling back:', e); }

    // last resort: the old localStorage hint, then a fresh board
    const id = localStorage.getItem('gazboard.lastBoard') || localStorage.getItem('openboard.lastBoard');
    if (id) {
      const data = await window.board.boards.load(id);
      if (taken()) return;
      if (data) { await this.loadBoard(data, { silent: true, startup: true }); return; }
    }
    if (taken()) return;
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
  /**
   * Carry the look of this canvas to the next new board.
   *
   * Only what the person actually changed is kept, and only the LOOK of it:
   * paper size, colour, pattern. Nothing anyone has drawn travels, and no board
   * that already exists is touched - reaching back to change boards made last
   * week because of a choice made today would be the opposite of helpful.
   */
  rememberCanvas(patch) {
    if (!this.settings.rememberCanvas) return;
    const mine = this.settings.canvasDefaults || (this.settings.canvasDefaults = {});
    Object.assign(mine, patch);
    this.saveSettings();
  }

  /** Put the remembered look on a board that has just been made. */
  applyCanvasDefaults() {
    /*
     * The pattern spacing is a habit of the hand, not a look for one board:
     * whatever was chosen last is what every new board gets, whether or not
     * "Use this canvas for new boards" is on. Boards made before keep theirs.
     */
    const spacing = this.settings.patternSpacing;
    if (spacing && spacing !== 40) { this.store.doc.background.spacing = spacing; this.store.rev++; }
    // the same goes for the date at the top of notebook paper: switched off once, off for every new board
    if (this.settings.pageDate === false) { this.store.doc.background.pageDate = false; this.store.rev++; }
    const want = this.settings.rememberCanvas ? this.settings.canvasDefaults : null;
    if (!want) return;
    const bg = {};
    for (const k of ['color', 'pattern', 'patternColor']) if (want[k] != null) bg[k] = want[k];
    if (Object.keys(bg).length) {
      // straight onto the fresh document rather than through commit(): a board
      // one second old should not open with something already on its undo stack
      Object.assign(this.store.doc.background, bg);
      this.store.rev++;
    }
    if (want.paper && want.paper !== 'infinite') {
      // async, and it commits - which is right here: the sheet is a real change
      // to an empty board, and it is the last thing to happen to it
      this.setPageSize(want.paper, want.orientation || 'portrait');
    }
  }

  newBoard(silent = false) {
    this.store.reset();
    this.surface.selection.clear();
    this.applyCanvasDefaults();
    this.openAtActualSize();
    document.getElementById('boardTitle').value = this.store.doc.name;
    this.syncUI();
    this.surface.invalidate();
    if (!silent) this.toast(t('New board'));
    this.unsavedNew = true;
    document.getElementById('savedBadge').textContent = t('Saved');
    window.board.boards.setLast(this.store.doc.id);
    this.syncBackPill();
    this.syncLinkedFrom();
    this.refreshBoardDirectory();
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
    this.refreshBoardDirectory();          // links to it now say it is gone
    if (wasOpen) {
      this.textEditor.cancel();
      this.newBoard(true);          // silent: nobody asked for this board
      this.toast(t('Board deleted'));
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
    const base = data.name && data.name !== 'Untitled board' && data.name !== t('Untitled board')
      ? data.name
      : boardNameFromPath(data.origin) || t('Untitled board');

    const clash = list.find((b) => b.id === data.id);
    if (!clash) return { ...data, name: uniqueBoardName(base, list) };

    const answer = await this.choose(
      t('You already have this board'),
      t('“{name}” on this computer came from the same board as this file - most likely this file is a copy of it made on another machine. Keeping both leaves your copy untouched and opens the file alongside it. Replacing writes the file over your copy, and what is in your copy now would be gone.', { name: clash.name }),
      [{ id: 'both', label: t('Keep both'), primary: true },
       { id: 'replace', label: t('Replace my copy') }],
      { cancel: false });

    // Escape, or the dialog going away for any other reason, lands on the
    // answer that destroys nothing. Losing a board to a stray keypress is the
    // whole failure this exists to stop.
    if (answer === 'replace') {
      this.toast(t('Replaced your copy of “{name}”', { name: clash.name }));
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
    // `claimed` means the caller has already decided which board on this
    // machine this one is - the sync accept dialog does that itself, so that
    // arriving from another computer asks ONE question rather than two.
    if (!opts.startup && !opts.claimed && data && data.origin) data = await this.claimLocalBoard(data);
    this.textEditor.cancel();
    this.mathEditor?.close();
    // A board asked for by name is what the person wants to see: the My boards
    // page, if it is up, steps aside for it.
    if (!opts.startup && this.panels?.page) this.panels.close();
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
    if (!opts.silent) this.toast(t('Opened {name}', { name: this.store.doc.name }));
    if (!opts.noMigrationPrompt) this.checkStrayContent(data);
    this.refreshBoardDirectory();
    this.syncBackPill();
    // which boards link here: every other board is looked inside, so not while the app is still starting
    clearTimeout(this._linkedTimer);
    this._linkedTimer = setTimeout(() => this.syncLinkedFrom(), opts.startup ? 2500 : 250);
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
    const stray = this.offPageObjects({ edges: true });
    if (!stray.length) return;

    const answer = await this.choose(
      stray.length === 1 ? t('One thing sits outside the page') : t('{n} things sit outside the page', { n: stray.length }),
      t('Pages now hold their ink the way paper does, so anything outside the sheet is clipped. This board was made before that. You can bring it all onto the page, or leave it where it is.'),
      [{ id: 'fit', label: t('Bring it onto the page'), primary: true },
       { id: 'keep', label: t('Leave it where it is') }]
    );
    if (answer === 'fit') this.fitContentToPage();
    else this.toast(t('Left as it was — the stray parts sit off the paper'));
  }

  /* ---------------- tools & selection ---------------- */
  /** The tools that arm themselves and wait for you to drop something. */
  static PLACING = ['note', 'text', 'shape', 'emoji', 'table'];

  setTool(tool) {
    if (tool === 'pen' || tool === 'highlighter') this.lastInkTool = tool;
    if (this.tool === tool) return;
    /*
     * Reaching for a tool that drops something remembers what you were doing
     * before, so backing out can put it back rather than guessing.
     *
     * Select is the obvious guess and it is wrong half the time: someone
     * mid-sentence with the pen who reaches for a sticky note and changes
     * their mind wants the pen back, not a selection arrow. The other half
     * is equally wrong the other way. Remembering costs one field.
     */
    if (App.PLACING.includes(tool) && !App.PLACING.includes(this.tool)) this.toolBefore = this.tool;
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

  /**
   * Select these, and whatever they are grouped with.
   *
   * Every path into selection goes through here - a click, a marquee, a lasso,
   * a press-and-hold, a freshly created object - so widening to whole groups
   * in this one place is what makes grouping work everywhere at once, rather
   * than in the four places someone remembered to handle it.
   *
   * `whole: false` asks for exactly what was named, which is how a member gets
   * picked out from inside a group that has been opened for editing.
   */
  setSelection(ids, additive = false, { whole = true } = {}) {
    const sel = this.surface.selection;
    if (!additive) sel.clear();
    const wanted = whole ? withGroups(this.store, ids, this.openGroup) : ids;
    for (const id of wanted) if (this.store.has(id)) sel.add(id);
    // Stepping outside the opened group closes it again, so the next click on
    // it picks up the whole thing as usual.
    if (this.openGroup && ![...sel].some((id) => this.store.get(id)?.groupId === this.openGroup)) {
      this.openGroup = null;
    }
    if (!sel.size) this.multiSelect = false;
    this.syncUI();
    this.surface.invalidate();
  }

  /** Which group, if any, is currently opened for picking single members. */
  openGroup = null;

  /*
   * Picking several things with a finger.
   *
   * A mouse says "and this one too" by holding Ctrl. A finger has no Ctrl, and
   * the gestures that might stand in for it are all taken: a tap selects, a
   * press-and-hold picks up, two fingers move the board. So on a touchscreen
   * it is a mode instead - a button on the selection bar that says the next
   * taps are adding rather than replacing. A mode is a worse idea than a
   * modifier key in almost every case, but it is visible, it is reversible,
   * and it does not fight any gesture that already exists.
   *
   * It switches itself off when the selection empties, so it can never be left
   * on in a way that makes the next tap behave strangely.
   */
  multiSelect = false;

  setMultiSelect(on) {
    this.multiSelect = !!on;
    this.toast(this.multiSelect ? t('Tap things to add them to the selection') : t('Back to normal tapping'),
      this.multiSelect ? 'select' : 'check', 1600);
    this.syncUI();
  }

  /**
   * A tap or click has chosen this object: replace the selection, or extend it.
   *
   * `toggle` is what a modifier key or the add-to-selection mode asks for.
   * Returns 'added', 'removed' or 'replaced', because the caller needs to know
   * whether a drag should now be armed - taking something OUT of a selection
   * is not the beginning of moving what remains.
   */
  chooseObject(id, toggle = this.multiSelect) {
    if (!toggle) { this.setSelection([id]); return 'replaced'; }
    const ids = new Set(this.surface.selection);
    const family = withGroups(this.store, [id], this.openGroup);
    const alreadyIn = family.every((f) => ids.has(f));
    for (const f of family) alreadyIn ? ids.delete(f) : ids.add(f);
    this.setSelection([...ids], false, { whole: false });
    return alreadyIn ? 'removed' : 'added';
  }

  /** The groups represented in the current selection. */
  selectedGroups() {
    return new Set(this.selected.map((o) => o.groupId).filter(Boolean));
  }

  /**
   * Tie the selection together.
   *
   * Grouping something that is already grouped folds the lot into one new
   * group rather than nesting - a house made of a roof group and a wall group
   * becomes a house, and "ungroup" on it gives back the parts rather than two
   * mystery sub-groups nobody can see the edges of. Nesting is a thing people
   * ask for and then regret.
   */
  groupSelection() {
    const objs = this.selected.filter((o) => !o.locked);
    if (objs.length < 2) {
      this.toast(t('Select two or more things to group'), 'help');
      return false;
    }
    const gid = uid('g');
    /*
     * One name survives a regroup, several do not.
     *
     * Regrouping pieces that all came from Solar should still be Solar -
     * that is the "oops, undo that ungroup" case, and retyping the name would
     * be a small insult. But folding Solar and Wind together into one group
     * leaves no honest answer to what it is called, and picking whichever
     * happened to be first is a guess dressed up as a decision. So it comes
     * out unnamed, and asks to be told.
     */
    const names = new Set(objs.map((o) => o.groupName).filter(Boolean));
    const keep = names.size === 1 ? [...names][0] : null;
    this.store.updateMany(objs.map((o) => o.id), { groupId: gid, groupName: keep }, 'group');
    this.openGroup = null;
    this.setSelection(objs.map((o) => o.id));
    this.toast(t('{n} items grouped', { n: objs.length }), 'check');
    return true;
  }

  /**
   * Give the selected group a name.
   *
   * The name rides on the members beside the group id, which keeps a group one
   * idea rather than two: no separate table to keep in step, nothing to tidy
   * up when the last member is deleted, and a copied group keeps its name
   * because the name travelled with the pieces. Passing null asks; passing a
   * string sets it without asking, which is what the tests use.
   */
  async nameGroup(name) {
    const gids = [...this.selectedGroups()];
    if (gids.length !== 1) {
      this.toast(gids.length ? t('Select one group to name it') : t('Select a group first'), 'help');
      return false;
    }
    const ids = groupMembers(this.store, gids[0]);
    const current = this.store.get(ids[0])?.groupName || '';
    let next = name;
    if (next === undefined || next === null) {
      next = await this.askText(t('Name this group'),
        t('Shown on the group\u2019s outline, so a board full of parts says what each part is.'),
        { value: current, placeholder: t('Solar, Wind, Testing\u2026'), ok: t('Save') });
      if (next === null) return false;
    }
    this.store.updateMany(ids, { groupName: next || null }, next ? 'name group' : 'clear group name');
    this.surface.invalidate();
    this.toast(next ? t('Group named \u201c{name}\u201d', { name: next }) : t('Group name removed'), 'check');
    return true;
  }

  /** Undo the tying, for every group in the selection. */
  ungroupSelection() {
    const gids = this.selectedGroups();
    if (!gids.size) {
      this.toast(t('Nothing grouped is selected'), 'help');
      return false;
    }
    const ids = [];
    for (const gid of gids) ids.push(...groupMembers(this.store, gid));
    /*
     * The name goes with the tie.
     *
     * Leaving it behind meant a loose object still quietly remembered it was
     * once part of Solar, and grouping two of those later brought the old name
     * back from nowhere - a name nobody typed, on a group nobody called that.
     * A name describes a grouping; when the grouping ends, so does it.
     *
     * null rather than undefined: an undefined value can be dropped entirely
     * by a clone or a round trip through a file, and a patch that loses its
     * only key silently does nothing at all.
     */
    this.store.updateMany(ids, { groupId: null, groupName: null }, 'ungroup');
    this.openGroup = null;
    this.setSelection(ids);
    this.toast(gids.size > 1 ? t('{n} groups undone', { n: gids.size }) : t('Group undone'), 'check');
    return true;
  }

  /**
   * Open a group so one member can be worked on alone.
   *
   * Without this, a group is a cage: the roof of a grouped house could never
   * be recoloured without breaking the house apart first and remembering to
   * put it back together. Double-clicking steps inside; clicking anything
   * outside steps back out, which is handled in setSelection.
   */
  enterGroup(o) {
    if (!o?.groupId) return false;
    this.openGroup = o.groupId;
    this.setSelection([o.id], false, { whole: false });
    return true;
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
      // A cover only ever owns what was written on it, by coverFor()'s strict
      // rule. Locking one must not sweep up the ink around it as well.
      if (host.type === 'curtain') continue;
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
    const first = hosts.find((o) => o.type !== 'curtain');
    if (patch.length && first) this.store.updateMany(patch, { attachedTo: first.id }, 'attach to locked');
    return patch.length;
  }

  /** Explain the lock rather than silently doing nothing. */
  hintLocked(n = 1) {
    const now = Date.now();
    if (now - (this._lockHintAt || 0) < 2500) return;
    this._lockHintAt = now;
    this.toast(n > 1 ? t('{n} locked items were left alone', { n }) : t('This is locked — press the unlock button to edit it'), 'lock');
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
   * Does a FINGER draw, or move the board?
   *
   * The same question as mouseInks, asked of the other hand, and it has to be
   * asked because one finger cannot do both. Panning with two fingers is what
   * GazBoard did, and on a phone it is friction on the commonest movement
   * there is: you reposition the board far more often than you write on it.
   *
   * 'auto' answers it from the hardware, the way OneNote and Samsung Notes do.
   * No stylus has touched this screen, so there is nothing else to draw with -
   * the finger draws, and a phone with no pen works with nothing to find. An
   * S Pen has touched it, so the pen draws and the finger is free to move the
   * board underneath.
   *
   * Whatever the answer, a tap still selects and a press-and-hold still picks
   * things up: those are how a finger reaches an object, and losing them would
   * trade one kind of friction for a worse one.
   */
  get fingerInks() {
    const f = this.settings.inkWithFinger;
    if (f === 'yes') return true;
    if (f === 'no') return false;
    // 'auto'. Only a touch-first device answers this from the hardware: a
    // phone or a tablet, where the finger and the pen are the only two things
    // there are and one of them has to move the board. A laptop with a
    // touchscreen has a mouse for that already, and quietly changing what its
    // screen does the first time somebody picks up a stylus would break a
    // machine that was working.
    const touchFirst = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches;
    return !(touchFirst && this.penSeenThisSession);
  }

  /** The toolbar button: flip it, and the guess stops second-guessing you. */
  toggleFingerInk() {
    this.settings.inkWithFinger = this.fingerInks ? 'no' : 'yes';
    this.saveSettings();
    this.toast(this.fingerInks
      ? t('Your finger draws — two fingers move the board')
      : t('Your finger moves the board — draw with the pen'), 'pen', 2600);
    this.syncUI?.();
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
      this.toast(t('Stylus detected — the mouse now pans instead of drawing'), 'pen', 5000);
      this.surface.invalidate();
    }
  }

  /** Returns whether anything was actually changed, so a caller can tell. */
  applyToSelection(patch, onlyType) {
    const ids = this.selected.filter((o) => !onlyType || o.type === onlyType).map((o) => o.id);
    if (!ids.length) return false;
    this.store.updateMany(ids, patch, 'format');
    return true;
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

  /** Every maths box on this board, ready to draw in an export's colours. See core/maths.js. */
  mathsReady(objects = this.store.objects) {
    return mathsReady(objects).catch(() => {});
  }

  /** Open the maths editor on a box, or (with null) for a new box in the middle of the view. */
  beginMathEdit(obj) {
    this.textEditor.cancel?.();
    if (obj) { this.setSelection([obj.id]); this.mathEditor.open({ id: obj.id }); return; }
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    this.setSelection([]);
    this.mathEditor.open({ at: { x: view.x + view.w / 2, y: view.y + view.h / 2 } });
  }

  /**
   * What the maths editor hands back. A new box is made only if something was
   * typed; an edited box keeps its lettering size and its top-left corner, and
   * grows or shrinks to the new formula; an edited box emptied out goes, the
   * way an emptied text box does. Each is one undo step.
   */
  async commitMath(target, tex, original = '') {
    tex = String(tex || '').trim();
    const ink = (c) => c || '#201f1e';
    if (target.id) {
      const o = this.store.get(target.id);
      if (!o) return null;
      if (!tex) { this.store.remove([o.id], 'delete maths'); this.setSelection([]); return null; }
      if (tex === String(o.tex || '').trim()) return o;
      let size = null;
      try { size = sizeOfBox(o, await mathReady(o.tex, ink(o.color))); } catch { /* the old one never drew */ }
      const e = await mathReady(tex, ink(o.color));
      if (!this.store.get(o.id)) return null;
      const patch = { tex };
      if (e.status === 'ready') {
        const n = naturalSize(e, size || this.worldSize(this.settings.mathSize || 36));
        patch.w = n.w; patch.h = n.h;
      }
      this.store.update(o.id, patch, 'edit maths');
      this.setSelection([o.id]);
      this.surface.invalidate();
      return this.store.get(o.id);
    }
    if (!tex) return null;
    const color = '#201f1e';
    const e = await mathReady(tex, color);
    const size = this.worldSize(this.settings.mathSize || 36);
    const n = e.status === 'ready' ? naturalSize(e, size) : { w: size * 6, h: size * 2 };
    const at = target.at || { x: 0, y: 0 };
    const o = { id: uid('m'), type: 'math', tex, color, x: at.x - n.w / 2, y: at.y - n.h / 2, w: n.w, h: n.h, rotation: 0 };
    this.interaction?.placeOnPaper?.(o);
    this.store.add(o, 'maths');
    this.setTool('select');
    this.setSelection([o.id]);
    this.syncUI();
    return o;
  }

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

  /*
   * Stamp an emoji where the board was tapped.
   *
   * Square, because every emoji is drawn square and starting it that way means
   * the first thing anyone does with the handles is make it bigger rather than
   * un-squash it. Nothing opens afterwards - there is no text to type - so the
   * tool follows the same "return to select" setting that notes and text do,
   * and someone stamping a row of ticks can turn that off once and stay put.
   */
  addEmojiAt(wp, ch = this.settings.emojiChar) {
    const size = this.worldSize(this.settings.emojiSize);
    // Shaped like the character rather than square, so a long rocket lands
    // long and a wide sign lands wide. The longer side is the chosen size, so
    // every emoji lands about as big as the last regardless of its shape.
    const a = emojiAspect(ch);
    const w = a >= 1 ? size : size * a;
    const h = a >= 1 ? size / a : size;
    const o = {
      id: uid('e'), type: 'emoji', ch,
      x: wp.x - w / 2, y: wp.y - h / 2, w, h, rotation: 0
    };
    // Keeping it on the sheet is the interaction layer's job, and it may not
    // exist yet when a board is being rebuilt, so ask rather than assume.
    this.interaction?.placeOnPaper?.(o);
    this.store.add(o, 'emoji');
    this.rememberEmoji(ch);
    this.armToolRestore();
    if (this.settings.returnToSelect && this.tool !== 'select') this.setTool('select');
    this.setSelection([o.id]);
    this.syncUI();
    return o;
  }

  /** The last few used, newest first, so the picker can offer them back. */
  rememberEmoji(ch) {
    const s = this.settings;
    s.emojiChar = ch;
    s.emojiRecent = [ch, ...(s.emojiRecent || []).filter((c) => c !== ch)].slice(0, 16);
    this.saveSettings();
  }

  /**
   * How wide a new text box may grow before it wraps, starting at board x.
   *
   * The usual line length, but never past the right-hand edge of what is on
   * screen: on a phone a box tapped in near the middle used to run straight
   * off the side, and the words typed into it went with it.
   */
  textWrapWidthAt(x) {
    const sf = this.surface;
    const right = sf.cam.toWorld(sf.width - 16, 0).x;
    return Math.max(this.worldSize(120), Math.min(this.worldSize(360), right - x));
  }

  addTextAt(wp) {
    const fontSize = this.worldSize(this.settings.textSize);
    const wrapW = this.textWrapWidthAt(wp.x);
    const o = { id: uid('t'), type: 'text', x: wp.x, y: wp.y - fontSize, w: wrapW, wrapW, h: fontSize * 1.6, text: '', rotation: 0, color: this.settings.textColor, fontSize, align: 'left', valign: 'top', font: this.settings.textFont, background: 'none' };
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

  /* ================================================================= *
   *  Answer covers
   *
   *  A card laid over an answer, a label or the next step of a worked
   *  example, lifted with a tap when the class is ready for it. It is an
   *  object on the board like any other - it moves, resizes, locks and
   *  groups - with one extra fact about it: whether it has been lifted.
   *  Lifting is an ordinary change to the document, so undo puts the card
   *  straight back, and a board saved mid-lesson opens with the answers
   *  that were showing still showing.
   * ================================================================= */

  /* ================================================================= *
   *  Links to other boards
   *
   *  "@" in words, or on the board, picks another board; following the link
   *  opens it, and a pill at the top goes back. See core/boardrefs.js.
   * ================================================================= */

  /** Read the board list again, so links show today's names and pictures. */
  async refreshBoardDirectory() {
    let list;
    try { list = (await window.board.boards.list()) || []; } catch { return; }
    setBoardDirectory(list);
  }

  /** Where on the window a board point is - for putting a list beside it. */
  clientPointOf(wp) {
    const q = this.surface.cam.toScreen(wp.x, wp.y);
    const r = this.surface.canvas.getBoundingClientRect();
    return { x: q.x + r.left, y: q.y + r.top };
  }

  /**
   * Choose a board, and put a card for it on this one: where the pointer last
   * was when it is on the board, in the middle of the view otherwise.
   */
  pickBoardLink() {
    this.textEditor.commit();
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    const bp = this.boardPoint;
    const inView = bp && bp.x >= view.x && bp.x <= view.x + view.w && bp.y >= view.y && bp.y <= view.y + view.h;
    const at = inView ? { x: bp.x, y: bp.y } : { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    // opened straight away, so the next key typed lands in its search; the list catches up
    this.refreshBoardDirectory();
    const c = this.clientPointOf(at);
    this.boardPicker = openBoardPicker(this, {
      at: { x: c.x, y: c.y }, search: true,
      onPick: async (choice) => {
        const ref = choice.create ? await this.createLinkedBoard(choice.create) : choice;
        if (ref) this.addBoardLink(ref, at);
      }
    });
    return this.boardPicker;
  }

  /** Point a card at a different board, chosen from the same list. */
  relinkBoardCard(id) {
    const o = this.store.get(id);
    if (!o || o.type !== 'boardlink') return null;
    this.refreshBoardDirectory();
    const c = this.clientPointOf({ x: o.x + o.w / 2, y: o.y + o.h });
    this.boardPicker = openBoardPicker(this, {
      at: c, search: true,
      onPick: async (choice) => {
        const ref = choice.create ? await this.createLinkedBoard(choice.create) : choice;
        if (!ref || !this.store.get(id)) return;
        const board = { id: ref.id, name: ref.name };
        if (ref.page > 0) board.page = ref.page;
        this.store.update(id, { board }, 'link to a board');
        this.surface.invalidate();
        this.syncUI();
      }
    });
    return this.boardPicker;
  }

  /** A card for another board, centred on `at`, selected. */
  addBoardLink(ref, at = null) {
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    const p = at || { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    const w = this.worldSize(220), hh = this.worldSize(172);
    const board = { id: ref.id, name: ref.name };
    if (ref.page > 0) board.page = ref.page;
    const o = { id: uid('k'), type: 'boardlink', x: p.x - w / 2, y: p.y - hh / 2, w, h: hh, rotation: 0, board };
    this.store.add(o, 'link to a board');
    this.setSelection([o.id]);
    this.showHint('board-link-placed',
      t('A <b>click</b> with Select, or a tap while presenting, opens the board. <b>Ctrl+click</b> opens it with any tool.'));
    return o;
  }

  /**
   * A new, empty board for a link to point at - made on the side, without
   * leaving this one, in the same folder as this one.
   */
  async createLinkedBoard(name) {
    const doc = { ...emptyDoc(String(name || '').trim() || t('Untitled board')), objects: [] };
    delete doc.order;
    const want = this.settings.rememberCanvas ? this.settings.canvasDefaults : null;
    if (want) for (const k of ['color', 'pattern', 'patternColor']) if (want[k] != null) doc.background[k] = want[k];
    if (this.settings.patternSpacing && this.settings.patternSpacing !== 40) doc.background.spacing = this.settings.patternSpacing;
    try {
      await window.board.boards.save({ id: doc.id, json: JSON.stringify(doc), setLast: false });
    } catch {
      this.toast(t('Could not make the board'));
      return null;
    }
    const folder = folderOf(this.settings, this.store.doc.id);
    if (folder) { this.settings.boardFolders = { ...(this.settings.boardFolders || {}), [doc.id]: folder }; this.saveSettings(); }
    await this.refreshBoardDirectory();
    this.toast(t('Made a new board, “{name}”', { name: doc.name }));
    return { id: doc.id, name: doc.name, page: 0 };
  }

  /**
   * Follow a link. This board is saved first, and remembered, so the pill at
   * the top can bring you straight back to where you were.
   */
  async openBoardRef(ref) {
    if (!ref) return false;
    await this.refreshBoardDirectory();
    const target = lookupBoard(ref);
    if (!target) { this.toast(t('“{name}” is not on this computer', { name: ref.name || '?' })); return false; }
    if (target.id === this.store.doc.id) {
      if (ref.page > 0 && this.pageCount) this.goToPage(ref.page - 1);
      return true;
    }
    this.textEditor.commit();
    this.mathEditor?.close();
    const from = { id: this.store.doc.id, name: this.store.doc.name, camera: this.surface.cam.toJSON() };
    try { await this.persist(); } catch { /* the board stays open: nothing is lost by staying */ }
    let data = null;
    try { data = await window.board.boards.load(target.id); } catch { data = null; }
    if (!data) { this.toast(t('“{name}” is not on this computer', { name: ref.name || '?' })); return false; }
    this.backStack.push({ ...from, to: target.id });
    if (this.backStack.length > 30) this.backStack.shift();
    await this.loadBoard(data, { claimed: true });
    if (ref.page > 0) requestAnimationFrame(() => { if (this.pageCount) this.goToPage(ref.page - 1); });
    this.syncBackPill();
    return true;
  }

  /** Back to the board a link was followed from, looking where you were looking. */
  async goBack() {
    const b = this.backStack.pop();
    if (!b) { this.syncBackPill(); return false; }
    this.textEditor.commit();
    try { await this.persist(); } catch { /* as above */ }
    let data = null;
    try { data = await window.board.boards.load(b.id); } catch { data = null; }
    if (!data) { this.toast(t('“{name}” is not on this computer', { name: b.name || '?' })); this.syncBackPill(); return false; }
    await this.loadBoard({ ...data, camera: b.camera || data.camera }, { claimed: true, silent: true });
    this.toast(t('Back to {name}', { name: this.store.doc.name }));
    this.syncBackPill();
    return true;
  }

  /* ---- which boards link here ---- */

  /*
   * Each board's links, by board, as of the version last read. Finding which
   * boards point at this one means looking inside every other board, so each
   * is read once and then only again after it has changed.
   */
  async linkIndex() {
    let list = [];
    try { list = (await window.board.boards.list()) || []; } catch { return new Map(); }
    setBoardDirectory(list);
    const index = this._linkIndex || (this._linkIndex = new Map());
    const here = new Set(list.map((b) => b.id));
    for (const id of [...index.keys()]) if (!here.has(id)) index.delete(id);
    for (const b of list) {
      const was = index.get(b.id);
      if (was && was.modified === b.modified) continue;
      let refs = [];
      try { const data = await window.board.boards.load(b.id); refs = linkedRefs(data?.objects); } catch { refs = []; }
      index.set(b.id, { modified: b.modified, refs });
    }
    return index;
  }

  /** The boards with a link to the open one (or to `id`). The open board's own, unsaved links count too. */
  async boardsLinkingHere(id = this.store.doc.id) {
    const index = await this.linkIndex();
    const out = [];
    for (const b of allBoards()) {
      if (b.id === id) continue;
      const refs = b.id === this.store.doc.id ? linkedRefs(this.store.objects) : (index.get(b.id)?.refs || []);
      if (refs.some((r) => lookupBoard(r)?.id === id)) out.push(b);
    }
    return out.sort((p, q) => String(p.name).localeCompare(String(q.name), undefined, { numeric: true, sensitivity: 'base' }));
  }

  /** The "Linked from N" badge beside the board's name. */
  async syncLinkedFrom() {
    const el = document.getElementById('linkedFrom');
    if (!el) return;
    const id = this.store.doc.id;
    const ticket = (this._linkedTicket = (this._linkedTicket || 0) + 1);
    let from = [];
    try { from = await this.boardsLinkingHere(id); } catch { from = []; }
    if (ticket !== this._linkedTicket || id !== this.store.doc.id) return;      // a newer look has started
    this._linkedFrom = from;
    el.hidden = !from.length;
    if (!from.length) return;
    el.innerHTML = icon('link', 12);
    el.appendChild(h('span', {}, t('Linked from {n}', { n: from.length })));
    el.title = t('Boards with a link to this one');
    if (!el._wired) {
      el._wired = true;
      el.addEventListener('click', () => this.showLinkedFrom(el));
    }
  }

  showLinkedFrom(anchor) {
    const from = this._linkedFrom || [];
    const rows = from.map((b) => {
      const row = h('div', { class: 'bp-row' },
        h('div', { class: 'bp-thumb' }, b.thumb ? h('img', { src: b.thumb, alt: '' }) : null),
        h('div', { class: 'bp-text' }, h('div', { class: 'bp-name' }, b.name || t('Untitled board'))));
      row.addEventListener('click', () => { closePopover(); this.openBoardRef({ id: b.id, name: b.name }); });
      return row;
    });
    openPopover(anchor, h('div', { class: 'lf-pop' }, h('h4', {}, t('Boards with a link to this one')), ...rows),
      { key: 'linkedFrom', placement: 'bottom', align: 'start', className: 'bp-popover' });
  }

  /* ---- sending or saving a board that links to others ---- */

  /**
   * Every board reachable from `refs` by following links, nearest first,
   * not counting `except`. Each board is read once, however many links lead to it.
   */
  async boardsReachable(refs, except) {
    const out = [], seen = new Set([except]);
    let wave = refs;
    while (wave.length) {
      const next = [];
      for (const r of wave) {
        const b = lookupBoard(r);
        if (!b || seen.has(b.id)) continue;
        seen.add(b.id);
        out.push(b);
        try { const data = await window.board.boards.load(b.id); next.push(...linkedRefs(data?.objects)); } catch { /* unreadable: its own links are not followed */ }
      }
      wave = next;
    }
    return out;
  }

  /**
   * This board links to others: take them along?
   *
   * A link to a board the other person does not have goes nowhere, so before
   * a board leaves this computer - over the network or as a file - the boards
   * it links to are offered, ticked. The boards THEY link to can come too.
   * "Don't ask again" remembers the answer for this board.
   *
   * @param {'send'|'save'|'pdf'|'svg'} why
   * @returns {Promise<string[]|null>} the ids of the other boards to include (none = just this one), or null to stop
   */
  async askAboutLinkedBoards(why) {
    const id = this.store.doc.id;
    await this.refreshBoardDirectory();
    const direct = [];
    for (const r of linkedRefs(this.store.objects)) {
      const b = lookupBoard(r);
      if (b && b.id !== id && !direct.some((x) => x.id === b.id)) direct.push(b);
    }
    if (!direct.length) return [];
    const all = await this.boardsReachable(direct, id);
    const further = all.filter((b) => !direct.some((d) => d.id === b.id));
    const remembered = this.settings.linkShare?.[id];
    if (remembered === 'alone') return [];
    if (remembered === 'include') return direct.map((b) => b.id);
    if (remembered === 'all') return all.map((b) => b.id);

    return new Promise((resolve) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      const done = (v) => { this._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
      card.appendChild(h('h3', {}, direct.length === 1 ? t('This board links to another board') : t('This board links to {n} other boards', { n: direct.length })));
      card.appendChild(h('p', {}, why === 'send'
        ? t('Send them along, so the links work on the other computer.')
        : why === 'pdf'
          ? t('Put them in the PDF after this board, and a click on a link jumps to the board it names.')
          : why === 'svg'
            ? t('Put them in the picture under this board, and a click on a link shows the board it names.')
            : t('Save them with it, so the links work wherever it is opened. They go into one .zip file together.')));
      const ticks = direct.map((b) => {
        const box = h('input', { type: 'checkbox', checked: true });
        card.appendChild(h('label', { class: 'check-row' }, box, h('span', {}, b.name || t('Untitled board'))));
        return { b, box };
      });
      let deep = null;
      if (further.length) {
        deep = h('input', { type: 'checkbox' });
        card.appendChild(h('label', { class: 'check-row', style: 'margin-top:6px' }, deep,
          h('span', {}, further.length === 1 ? t('Also the 1 board they link to') : t('Also the {n} boards they link to', { n: further.length }))));
      }
      const never = h('input', { type: 'checkbox' });
      card.appendChild(h('label', { class: 'check-row', style: 'margin-top:6px;color:var(--text-2)' }, never, h('span', {}, t("Don't ask again for this board"))));
      const remember = (v) => {
        if (!never.checked) return;
        this.settings.linkShare = { ...(this.settings.linkShare || {}), [id]: v };
        this.saveSettings();
      };
      const row = h('div', { class: 'actions', style: 'flex-wrap:wrap;gap:8px' });
      row.appendChild(h('button', { class: 'btn', onclick: () => done(null) }, t('Cancel')));
      row.appendChild(h('button', { class: 'btn', onclick: () => { remember('alone'); done([]); } }, t('Just this board')));
      row.appendChild(h('button', { class: 'btn primary', onclick: () => {
        const ids = ticks.filter((x) => x.box.checked).map((x) => x.b.id);
        const withDeep = !!deep?.checked;
        if (withDeep) for (const b of further) ids.push(b.id);
        const allTicked = ticks.every((x) => x.box.checked);
        remember(withDeep && allTicked ? 'all' : allTicked ? 'include' : ids.length ? 'include' : 'alone');
        done(ids);
      } }, t('Include them')));
      card.appendChild(row);
      this.showOverlay(() => resolve(null));
    });
  }

  /** Save a copy - with the boards it links to, in one .zip, when asked for. */
  async saveBoardCopy() {
    const extra = await this.askAboutLinkedBoards('save');
    if (extra === null) return null;
    if (!extra.length) return saveBoardFile(this);
    try { return await exportBoards(this, [this.store.doc.id, ...extra]); }
    catch (e) { this.toast(e.message || String(e), 'help', 6000); return null; }
  }

  /** The "Back to ..." pill: there while you are on a board a link brought you to. */
  syncBackPill() {
    let el = document.getElementById('backPill');
    const top = this.backStack?.[this.backStack.length - 1];
    const show = !!top && top.to === this.store.doc.id;
    if (!el) {
      if (!show) return;
      el = h('button', { id: 'backPill', type: 'button' });
      el.addEventListener('click', () => this.goBack());
      (document.getElementById('stage') || document.body).appendChild(el);
    }
    if (show) {
      const name = refLabel({ id: top.id, name: top.name });
      el.replaceChildren(h('b', { 'aria-hidden': 'true' }, '←'), h('span', {}, t('Back to {name}', { name })));
      el.title = t('Back to {name}', { name });
    }
    el.classList.toggle('show', show);
  }

  /** Drop a cover in the middle of the view, selected, ready to be sized. */
  addCurtain() {
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    const w = this.worldSize(360), hh = this.worldSize(110);
    const o = {
      id: uid('cv'), type: 'curtain', x: view.x + view.w / 2 - w / 2, y: view.y + view.h / 2 - hh / 2,
      w, h: hh, rotation: 0, revealed: false
    };
    this.store.add(o, 'answer cover');
    this.setSelection([o.id]);
    this.setTool('select');
    this.showHint('curtain-placed',
      t('Drag the cover over whatever the class should not see yet. A <b>tap</b> with the pen, a finger or the laser lifts it; <b>undo</b> puts it back.'));
    return o;
  }

  /**
   * Everything written on these covers - their ink, and anything else that
   * was put down wholly on the card. See coverFor() in tools.js.
   */
  onCovers(ids) {
    const set = new Set(ids);
    return this.store.objects.filter((o) => o.attachedTo && set.has(o.attachedTo));
  }

  /**
   * Lift or lower covers, and what is written on them, as ONE change - so a
   * single undo puts back the card and its scribbles together.
   */
  setCovers(ids, revealed, label) {
    const ops = [];
    const set = (o, key, val) => {
      if ((o[key] ?? false) === val) return;
      ops.push({ t: 'set', id: o.id, before: { [key]: o[key] }, after: { [key]: val } });
    };
    for (const id of ids) { const c = this.store.get(id); if (c) set(c, 'revealed', revealed); }
    for (const o of this.onCovers(ids)) set(o, 'hidden', revealed);
    this.store.commit(label, ops);
  }

  /** Lift one cover. Returns false if there was nothing to lift. */
  revealCurtain(id) {
    const o = this.store.get(id);
    if (!o || o.type !== 'curtain' || o.revealed) return false;
    this.surface.fadeOut(o);
    for (const w of this.onCovers([id])) this.surface.fadeOut(w);
    this.setCovers([id], true, 'reveal');
    this.dropHidden();
    this.surface.invalidate();
    this.syncUI();
    return true;
  }

  /** Lift every cover in the selection, as one undo. */
  revealSelectedCurtains() {
    const ids = this.selected.filter((o) => o.type === 'curtain' && !o.revealed).map((o) => o.id);
    if (!ids.length) return 0;
    for (const id of ids) this.surface.fadeOut(this.store.get(id));
    for (const w of this.onCovers(ids)) this.surface.fadeOut(w);
    this.setCovers(ids, true, 'reveal');
    this.dropHidden();
    this.surface.invalidate();
    this.syncUI();
    return ids.length;
  }

  /** Nothing that has just gone out of sight can stay selected. */
  dropHidden() {
    const keep = this.selected.filter((o) => !ghost(o)).map((o) => o.id);
    if (keep.length !== this.surface.selection.size) this.setSelection(keep, false, { whole: false });
  }

  /** Put every lifted cover back, for the next class. One undo takes it back. */
  coverAllCurtains() {
    const ids = this.store.objects.filter((o) => o.type === 'curtain' && o.revealed).map((o) => o.id);
    if (!ids.length) {
      const any = this.store.objects.some((o) => o.type === 'curtain');
      this.toast(any ? t('Every answer is already covered') : t('This board has no answer covers'), 'help');
      return 0;
    }
    this.setCovers(ids, false, 'cover answers');
    this.surface.invalidate();
    this.syncUI();
    this.toast(ids.length === 1 ? t('One answer covered again') : t('{n} answers covered again', { n: ids.length }), 'curtain');
    return ids.length;
  }

  /**
   * Offer the Chinese font, once, to someone using the app in Chinese who has
   * not got it. Only offered: nothing is fetched until they press the button,
   * and saying nothing is an answer too - it is not asked again. Settings ›
   * Language always has the button for later.
   */
  async offerFontPack() {
    const pack = packFor(currentLanguage());
    if (!pack || window.board?.smoke) return;
    const asked = this.settings.fontOffered || {};
    if (asked[pack.id] || await isInstalled(pack.id)) return;
    this.settings.fontOffered = { ...asked, [pack.id]: true };
    this.saveSettings();
    this.toast(t('Download the Chinese font for the board ({size})? Chinese text will then look the same on every device.', { size: sizeLabel(pack) }),
      'update', 15000, { label: t('Download'), onClick: () => this.fetchFontPack(pack.id) });
  }

  /** Fetch a font pack, saying how it went. Used by the offer and by Settings. */
  async fetchFontPack(id, onProgress) {
    this.toast(t('Downloading the Chinese font…'), 'update', 2600);
    const r = await downloadFontPack(id, { onProgress });
    if (r.ok) this.toast(t('Chinese font installed — it works offline from now on'), 'check', 4000);
    else this.toast(t('Could not download the font: {error}. Settings › Language can add a copy you got another way.', { error: r.error }), 'help', 9000);
    return r;
  }

  /* ================================================================= *
   *  Presenting
   * ================================================================= */

  /**
   * The board, the whole screen, and nothing else.
   *
   * Full screen is asked for and not relied on: a browser can refuse it, an
   * Android WebView often does, and a test window must not be thrown into
   * it. Presenting works either way - it is the chrome going away that
   * matters, and the screen filling is a bonus where it is allowed.
   */
  startPresenting({ fullscreen = true } = {}) {
    if (this.presenting) return;
    this.presenting = true;
    this.presentToolsPinned = false;
    closePopover();
    if (this.panels.open) this.panels.close();
    this.commitTextEdit();
    document.body.classList.add('presenting');
    document.body.classList.remove('show-tools');
    this._presentFullscreen = false;
    const el = document.documentElement;
    if (fullscreen && !document.fullscreenElement && el.requestFullscreen) {
      try {
        const p = el.requestFullscreen();
        this._presentFullscreen = true;
        if (p && p.catch) p.catch(() => { this._presentFullscreen = false; });
      } catch { this._presentFullscreen = false; }
    }
    this.presentFit();
    // The bars have only just gone, so the window's final size lands a frame
    // or two later - and later still when full screen kicks in.
    requestAnimationFrame(() => requestAnimationFrame(() => this.presentFit()));
    this.syncUI();
    this.toast(this.pageCount > 1
      ? t('Presenting — Page Down for the next page, Esc to finish')
      : t('Presenting — Esc to finish'), 'present');
  }

  stopPresenting() {
    if (!this.presenting) return;
    this.presenting = false;
    this.presentToolsPinned = false;
    document.body.classList.remove('presenting', 'show-tools');
    if (this._presentFullscreen && document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    this._presentFullscreen = false;
    this.surface.resize(true);
    if (this.pageCount) this.fitToPage(this.currentPageIndex());
    this.syncUI();
  }

  /** Sit the page you are on in the (new, bigger) window. */
  presentFit() {
    this.surface.resize(true);
    if (this.pageCount) this.fitToPage(this.currentPageIndex());
    this.surface.invalidate();
    syncPresentBar(this);
  }

  /**
   * One page on or back. On an infinite canvas there are no pages, and the
   * keys simply do nothing - guessing at "the next screenful" of a board
   * nobody laid out in screenfuls would jump somewhere arbitrary.
   */
  presentStep(delta) {
    if (!this.pageCount) return false;
    const from = this.currentPageIndex();
    this.goToPage(from + delta);
    syncPresentBar(this);
    return this.currentPageIndex() !== from;
  }

  setPresentTools(on) {
    this.presentToolsPinned = !!on;
    document.body.classList.toggle('show-tools', !!on);
    syncPresentBar(this);
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
    const tbl = sel[0];
    const key = axis ? 'cols' : 'rows';
    const dim = axis ? 'w' : 'h';
    const was = Math.max(1, tbl[key] | 0);
    const now = was + delta;
    if (now < 1) { this.toast(axis ? t('A table needs a column') : t('A table needs a row')); return; }
    if (now > 40) { this.toast(t('That is as big as a table gets')); return; }

    const patch = { [key]: now, [dim]: Math.round(tbl[dim] / was * now) };
    if (delta < 0) {
      const cells = {};
      for (const [k, v] of Object.entries(tbl.cells || {})) {
        const rc = k.split(',').map(Number);
        if (rc[axis] < now) cells[k] = v;      // the dropped line takes its text with it
      }
      patch.cells = cells;
    }
    this.store.update(tbl.id, patch, delta > 0 ? (axis ? 'add column' : 'add row') : (axis ? 'remove column' : 'remove row'));
    this.surface.invalidate();
    this.syncUI();
  }

  applyTemplate(tpl) {
    // a canvas-size template only sets the page; it adds nothing to the board
    if (tpl.page) { this.setPageSize(tpl.page.paper, tpl.page.orientation); return; }
    const objs = tpl.build();
    if (!objs.length) { this.toast(t('Blank board')); return; }
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
    this.toast(t('{name} added', { name: tpl.name }));
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
      case 'edit.selectAll': this.setSelection(s.doc.order.filter((id) => !s.get(id)?.locked && !ghost(s.get(id)))); this.setTool('select'); break;
      case 'edit.copy': this.copy(); break;
      case 'edit.cut': this.copy(); if (sf.selection.size) { s.remove(withAttached(s, [...sf.selection])); sf.selection.clear(); } break;
      // Every way of asking to paste goes through the one rule. The Edit menu
      // used to call paste() straight, which knows only about board objects -
      // so Ctrl+V could hand back objects while something newer sat on the
      // machine's clipboard, and which of the two answered depended on whether
      // the menu accelerator or the page saw the key first.
      case 'edit.paste': return this.pasteAt(null);
      case 'edit.duplicate': this.duplicate(); break;
      case 'arrow.straight': case 'arrow.elbow': case 'arrow.curved': this.setArrowRoute(id.slice(6)); break;
      case 'edit.group': this.groupSelection(); break;
      case 'edit.ungroup': this.ungroupSelection(); break;
      case 'edit.nameGroup': this.nameGroup(); break;
      case 'edit.clear':
        this.confirm(t('Clear canvas?'), t('Everything on this board will be removed. You can undo this.'), t('Clear'))
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
          ? t('Locked — it stays put, and anything you draw on it travels with it.')
          : attached
            ? (attached === 1 ? t('Unlocked — 1 annotation will move with it') : t('Unlocked — {n} annotations will move with it', { n: attached }))
            : t('Unlocked'), lock ? 'lock' : 'unlock');
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
      case 'insert.math': this.beginMathEdit(null); break;
      case 'insert.document': pickAndInsertDocument(this); break;
      case 'insert.table': this.addTable(); break;
      case 'insert.curtain': this.addCurtain(); break;
      case 'insert.boardlink': this.pickBoardLink(); break;
      case 'board.back': this.goBack(); break;
      case 'curtain.reveal': this.revealSelectedCurtains(); break;
      case 'curtain.coverAll': this.coverAllCurtains(); break;
      case 'view.present': this.presenting ? this.stopPresenting() : this.startPresenting(); break;
      case 'view.stopPresenting': this.stopPresenting(); break;
      case 'timer.open': this.timer.toggle(); break;

      case 'export.png': this.checkOffPageBeforeExport().then((go) => go && exportPng(this, { scale: 2 })); break;
      case 'export.pngSelection': exportPng(this, { scale: 2, selectionOnly: true }); break;
      case 'edit.copyPicture': this.copyAsPicture(); break;
      case 'edit.copyText': this.copyText(); break;
      case 'export.svg': this.exportSvgWithLinks(); break;
      case 'export.pdf': this.exportPdfWithSetup(); break;
      case 'view.fitPage': this.fitToPage(this.currentPageIndex()); break;
      case 'view.fitAllPages': this.fitToAllPages(); break;
      case 'page.add': this.addPage(); break;
      case 'page.duplicate': this.duplicatePage(); break;
      case 'page.delete': this.deletePage(); break;
      case 'page.next': this.nextPage(); break;
      case 'page.prev': this.prevPage(); break;
      case 'page.fitContent': this.fitContentToPage(); break;
      case 'board.save': this.saveBoardCopy(); break;
      case 'board.open': openBoardFile(this); break;
      case 'board.new':
        this.confirm(t('New board?'), t('Your current board is saved automatically and stays in "My boards".'), t('Create'))
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
      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      this.toast(coarse
        ? t('Ruler on — drag the middle to move it, drag a blue knob at either end to turn it')
        : t('Ruler on — drag the grip in the middle to move it, scroll over it or drag a blue knob to turn it'));
    }
    this.surface.invalidate();
  }

  /* ---------------- clipboard ---------------- */

  /**
   * What the machine's clipboard holds right now, as one short string.
   *
   * Only the desktop can answer this; the web and Android builds have no way
   * to look without asking permission, and the answer would arrive too late to
   * be useful anyway. A null answer is a fine answer - it means paste falls
   * back to the older, more cautious rule below.
   */
  clipboardStamp() {
    try { return window.board?.clipboardSignature?.() ?? null; } catch { return null; }
  }

  /**
   * The machine's clipboard itself - what it holds, not just whether it moved.
   *
   * Asked only when somebody has actually chosen Paste, never in passing: on
   * the desktop this turns a picture into bytes, and on Android it is a round
   * trip to the app's native side. Null where the clipboard cannot be looked
   * at, which is an answer rather than a failure.
   */
  async clipboardNow() {
    try { return (await window.board?.clipboardRead?.()) ?? null; } catch { return null; }
  }

  /** A pasted line of text, as a box on the board. */
  addPastedText(text, at, html = '') {
    /*
     * Words pasted onto the board keep the look they had where they were
     * copied - bold, italic, underline, colour - exactly as they do when
     * pasted into a box that is being typed in. Only when the formatted copy
     * says nothing the plain one does not are the plain words used.
     */
    let runs = null;
    if (html) {
      const got = htmlToRuns(html);
      if (got.text.trim()) {
        text = got.text;
        // The box itself takes the board's own ink, so words that were plain
        // black where they came from stay black here - not whatever colour
        // GazBoard's text was last set to - and only real colours ride on runs.
        runs = normalizeRuns((got.runs || []).map((r) => (r.c === AUTO_INK ? { ...r, c: undefined } : r)));
        if (!runs) runs = [];
      }
    }
    const o = {
      id: uid('t'), type: 'text', x: at.x - this.worldSize(210), y: at.y - this.worldSize(30),
      w: this.worldSize(420),
      h: Math.max(this.worldSize(60), text.split('\n').length * this.worldSize(this.settings.textSize) * 1.3),
      text: text.trim(), rotation: 0, color: this.settings.textColor,
      fontSize: this.worldSize(this.settings.textSize),
      align: 'left', valign: 'top', font: this.settings.textFont, background: 'none'
    };
    // The runs describe the text exactly as it is stored, so it is not trimmed
    // out from under them (htmlToRuns has already dropped the loose ends).
    if (runs) {
      o.text = text;
      o.color = AUTO_INK;
      if (runs.length) o.runs = runs;
    }
    this.store.add(o, 'paste text');
    this.setSelection([o.id]);
    return o;
  }

  /**
   * Copy the selection.
   *
   * The objects are kept here rather than on the machine's clipboard, because
   * an object is an id, a position and a group and none of that survives being
   * turned into text. Nothing is written to the machine's clipboard at all -
   * copying on a board should not throw away the address or the phone number
   * somebody had waiting there.
   *
   * What IS taken is a fingerprint of the machine's clipboard as it stands
   * right now. Paste compares it: unchanged means nothing has been copied
   * anywhere since, so these objects are the most recent copy and are what was
   * meant. Changed means something else was copied afterwards and that is what
   * paste is for. Last copy wins, without either side destroying the other's.
   */
  /**
   * The selection plus the ink written on it.
   *
   * Ink drawn on a locked page or picture belongs to it: it moves when the
   * page moves. Copying, cutting or duplicating the page has to take that ink
   * along too, or the copy arrives bare and a cut leaves the writing floating
   * where the page used to be. Kept in board order, so the ink stays on top.
   */
  withRiders(objs) {
    const ids = new Set(withAttached(this.store, objs.map((o) => o.id)));
    // An arrow between two things that are both being copied is part of what
    // is being copied - a copied diagram that lost its arrows is half a copy.
    const gids = new Set();
    for (const id of ids) { const g = this.store.get(id)?.groupId; if (g) gids.add(g); }
    const inSet = (e) => !!e && ((e.id && ids.has(e.id)) || (e.group && gids.has(e.group)));
    for (const o of this.store.objects) {
      if (o?.type === 'connector' && !ids.has(o.id) && inSet(o.a) && inSet(o.b)) ids.add(o.id);
    }
    return this.store.doc.order.filter((id) => ids.has(id)).map((id) => this.store.get(id)).filter(Boolean);
  }

  /**
   * Copies of a batch of objects, moved by (dx, dy): groups become new groups
   * of their own (see regroup), and ink that was on a copied page is on the
   * copy of that page - not on the original. Ink copied without its page is
   * simply loose ink.
   */
  /**
   * A new arrow from `a` to `b` - each an end spec: { id } or { group } to hold
   * on to something, or just { x, y } for a free end. It wears the shape tool's
   * outline colour, thickness and dashes, and the route last chosen.
   */
  addConnector(a, b, { heads = 'end', route = this.settings.arrowRoute } = {}) {
    const s = this.settings;
    const o = {
      id: uid('c'), type: 'connector', route: ROUTES.includes(route) ? route : 'straight',
      a: { ...a }, b: { ...b }, heads,
      stroke: s.shapeStroke || '#201f1e', lineWidth: s.shapeLineWidth || 3, dash: s.shapeDash || null,
      x: 0, y: 0, w: 0, h: 0, rotation: 0
    };
    connectorBounds(o);
    this.store.add(o, 'arrow');
    return o;
  }

  /** Straight, elbow or curved, for the selected arrows - and for the next one drawn. */
  setArrowRoute(route) {
    if (!ROUTES.includes(route)) return;
    this.settings.arrowRoute = route;
    this.saveSettings();
    const arrows = this.selected.filter((o) => o.type === 'connector' && !o.locked);
    if (arrows.length) {
      this.store.updateMany(arrows.map((o) => o.id), { route }, 'arrow shape');
      this.surface.invalidate();
    }
    this.syncUI();
  }

  cloneBatch(objs, dx, dy) {
    const ids = new Map();
    const copies = objs.map((o) => { const c = this.cloneWithOffset(o, dx, dy); ids.set(o.id, c.id); return c; });
    for (const c of copies) {
      if (!c.attachedTo) continue;
      if (ids.has(c.attachedTo)) c.attachedTo = ids.get(c.attachedTo);
      else delete c.attachedTo;
    }
    const groupsBefore = copies.map((c) => c.groupId);
    this.regroup(copies);
    const groups = new Map();
    copies.forEach((c, i) => { if (groupsBefore[i]) groups.set(groupsBefore[i], c.groupId); });
    // A copied arrow holds on to the copies of what it held. An end whose
    // object was not copied lets go, and stays where the copy put it.
    for (const c of copies) {
      if (c.type !== 'connector') continue;
      for (const k of ['a', 'b']) {
        const e = c[k];
        if (!e) continue;
        if (e.id) { if (ids.has(e.id)) e.id = ids.get(e.id); else delete e.id; }
        if (e.group) { if (groups.has(e.group)) e.group = groups.get(e.group); else delete e.group; }
      }
    }
    return copies;
  }

  copy() {
    const objs = this.withRiders(this.selected);
    if (!objs.length) return;
    this.clipboard = objs.map((o) => structuredClone(o));
    this.clipStamp = this.clipboardStamp();
    // Where the clipboard cannot be read on the spot - Android, a browser -
    // ask properly and fill the fingerprint in a moment later. Pasting in the
    // meantime simply falls back to the objects, which is the safe direction.
    if (this.clipStamp == null) {
      this.clipboardNow().then((c) => { if (c?.signature != null) this.clipStamp = c.signature; });
    }
    this.toast(this.clipboard.length > 1 ? t('{n} items copied', { n: this.clipboard.length }) : t('{n} item copied', { n: this.clipboard.length }));
  }

  /**
   * The selection as a picture on the machine's clipboard, to paste into a
   * chat, a slide or an email. Drawn exactly as "Export selection as PNG"
   * draws it. Ctrl+C is untouched: it still keeps objects inside the board.
   */
  async copyAsPicture() {
    if (!this.surface.selection.size || !window.board?.clipboardWrite) return false;
    await this.mathsReady();
    let b = this.surface.selectionBounds();
    b = { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 };
    const s = Math.min(2, 8000 / Math.max(b.w, b.h));
    // a cut-out of the selection, not a sheet of paper: no ruling behind it
    const image = this.surface.renderTo(b, s, true, false).toDataURL('image/png');
    const ok = await window.board.clipboardWrite({ image });
    this.toast(ok ? t('Copied as a picture') : t('Could not copy to the clipboard'));
    return ok;
  }

  /** The words on the selected objects, in reading order, for Copy text. */
  selectedWords() {
    const objs = this.selected.filter((o) => ['text', 'note', 'shape', 'table'].includes(o.type) && !o.hidden);
    objs.sort((p, q) => (Math.abs(p.y - q.y) > 20 ? p.y - q.y : p.x - q.x));
    const plain = [], html = [];
    for (const o of objs) {
      if (o.type === 'table') {
        const rows = o.rows || 0, cols = o.cols || 0;
        const tr = [], tp = [];
        for (let r = 0; r < rows; r++) {
          const cells = [], cp = [];
          for (let c = 0; c < cols; c++) {
            const key = r + ',' + c, v = o.cells?.[key] || '';
            cp.push(refsAsWords(v).replace(/\n/g, ' '));
            cells.push(`<td>${runsToHtml(objectRuns(o, key), v, {})}</td>`);
          }
          tp.push(cp.join('\t')); tr.push(`<tr>${cells.join('')}</tr>`);
        }
        if (tp.some((l) => l.trim())) { plain.push(tp.join('\n')); html.push(`<table border="1" style="border-collapse:collapse">${tr.join('')}</table>`); }
        continue;
      }
      if (!o.text) continue;
      /*
       * The box's own colour goes along only when somebody chose it. The
       * default ink is "whatever reads on this board", which elsewhere means
       * the other app's own default - not black pinned in place.
       */
      const own = o.type === 'note' ? o.textColor : o.type === 'shape' ? o.textColor : o.color;
      const colour = own && own.toLowerCase() !== '#201f1e' ? own : null;
      plain.push(refsAsWords(o.text));
      html.push(`<p>${runsToHtml(objectRuns(o), o.text, { bold: !!o.bold, italic: !!o.italic, underline: !!o.underline, color: colour })}</p>`);
    }
    return { text: plain.join('\n\n'), html: html.join('') };
  }

  /** The words, formatting and all, on the machine's clipboard. */
  async copyText() {
    const { text, html } = this.selectedWords();
    if (!text || !window.board?.clipboardWrite) { this.toast(t('There are no words in what is selected')); return false; }
    const ok = await window.board.clipboardWrite({ text, html });
    this.toast(ok ? t('Copied the text') : t('Could not copy to the clipboard'));
    return ok;
  }

  /**
   * Were these objects copied more recently than anything else?
   *
   * Only ever true when there is a fingerprint to compare against AND it still
   * matches. Where no fingerprint could be taken this is false, and paste
   * behaves exactly as it did before any of this existed: a picture or text on
   * the machine's clipboard wins, and the objects are reached through the
   * board menu instead.
   */
  boardCopyIsNewest() {
    if (!this.clipboard.length || this.clipStamp == null) return false;
    const now = this.clipboardStamp();
    return now != null && now === this.clipStamp;
  }

  duplicate() {
    const objs = this.withRiders(this.selected);
    if (!objs.length) return;
    const copies = this.cloneBatch(objs, 28, 28);
    this.store.addMany(copies, 'duplicate');
    this.setSelection(copies.map((o) => o.id));
  }

  /*
   * Copies of a group are a group of their own.
   *
   * Keeping the original group name would quietly weld the copy to the
   * original: move the new house and the old one comes too, which looks like
   * the app has lost its mind. Each group name in the batch is swapped for a
   * fresh one, so the copy holds together exactly as the original did without
   * being tied to it. A copy of only PART of a group is still a group, which
   * is what someone who selected three of five things and pressed Ctrl+D
   * meant.
   */
  regroup(copies) {
    const map = new Map();
    for (const c of copies) {
      if (!c.groupId) continue;
      if (!map.has(c.groupId)) map.set(c.groupId, uid('g'));
      c.groupId = map.get(c.groupId);
    }
    return copies;
  }

  cloneWithOffset(o, dx, dy) {
    const c = structuredClone(o);
    c.id = uid(o.type[0]);
    if (c.type === 'stroke') {
      for (const p of c.points) { p.x += dx; p.y += dy; }
      c.bbox = { ...c.bbox, x: c.bbox.x + dx, y: c.bbox.y + dy };
    } else translateObject(c, dx, dy);
    delete c.locked;
    return c;
  }

  /**
   * Paste at a point - whatever was copied last, not whatever the board holds.
   *
   * Asking for a paste at a particular spot is still asking for a paste, so it
   * answers the same question Ctrl+V answers: which was copied more recently,
   * these objects or whatever is on the machine's clipboard? A phone has no
   * Ctrl+V at all, so if this preferred the board's own copy it would leave a
   * phone number copied in a browser with no way onto the board whatsoever -
   * which is worse than the problem this menu was added to solve.
   *
   * Objects arrive centred on the point, keeping their own arrangement; a line
   * of text or a picture arrives there too. Nothing is thrown away either way:
   * a board copy that loses to something newer is still sitting there for
   * afterwards.
   */
  /**
   * Where a paste should land when nobody said where.
   *
   * Ctrl+V has no point of its own, so it used to drop the copies a nudge away
   * from where they came from - which is duplicate, not paste, and on a second
   * board it is worse than that: the copies keep the coordinates they had on
   * the first one, so something copied from the far corner of one board lands
   * in the far corner of the next, miles from anything you are looking at.
   *
   * The pointer knows better. Wherever the mouse, stylus or finger last
   * touched the board is where a paste belongs, as long as that place is still
   * on screen - pan away and the old spot is meaningless, so the middle of
   * what you ARE looking at takes over.
   */
  pastePoint() {
    const view = this.surface.cam.viewport(this.surface.width, this.surface.height);
    const middle = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    const p = this.boardPoint;
    if (!p) return middle;
    const onScreen = p.x >= view.x && p.x <= view.x + view.w
      && p.y >= view.y && p.y <= view.y + view.h;
    return onScreen ? { x: p.x, y: p.y } : middle;
  }

  async pasteAt(wp) {
    if (!wp) wp = this.pastePoint();
    const held = this.clipboard.length;
    const now = await this.clipboardNow();
    const moved = !!now && now.signature != null && this.clipStamp != null
      && now.signature !== this.clipStamp;

    if (now && (moved || !held)) {
      const point = wp;
      if (now.image) {
        try {
          const blob = await (await fetch(now.image)).blob();
          await insertImageFiles(this, [new File([blob], clipboardFileName(blob.type || now.kind), { type: blob.type || now.kind || 'image/png' })], point);
          return;
        } catch { /* fall through to whatever else is there */ }
      }
      if (now.text && now.text.trim()) { this.addPastedText(now.text, point, now.html); return; }
    }

    if (!held) { this.toast(t('Nothing copied yet'), 'help'); return; }
    const box = this.clipboard.reduce((b, o) => unionBox(b, boundsOf(o)), null);
    if (!box) { this.paste(); return; }
    const copies = this.cloneBatch(this.clipboard, wp.x - (box.x + box.w / 2), wp.y - (box.y + box.h / 2));
    this.store.addMany(copies, 'paste');
    this.setSelection(copies.map((o) => o.id));
    this.clipboard = copies.map((o) => structuredClone(o));
  }

  paste() {
    if (!this.clipboard.length) return;
    const copies = this.cloneBatch(this.clipboard, 32, 32);
    this.store.addMany(copies, 'paste');
    this.setSelection(copies.map((o) => o.id));
    this.clipboard = copies.map((o) => structuredClone(o));
  }

  /**
   * The folder a board lives in, shown in front of its name in the top bar:
   * CSE221 / Lectures / Sorting. Only the name itself is editable - the path
   * is where the board is filed, and pressing it opens My boards right there.
   * A board at the top level shows its name alone, exactly as before.
   */
  syncBoardPath() {
    const title = document.getElementById('boardTitle');
    if (!title) return;
    let el = document.getElementById('boardPath');
    const path = folderPath(this.settings, folderOf(this.settings, this.store.doc.id));
    const text = path.map((f) => f.name).join(' / ');
    if (!text) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement('button');
      el.id = 'boardPath';
      el.className = 'board-path';
      el.addEventListener('click', () => {
        this.boardFolder = folderOf(this.settings, this.store.doc.id);
        if (this.panels.open) this.panels.close();
        this.panels.boards();
      });
      title.parentNode.insertBefore(el, title);
    }
    el.hidden = false;
    if (el.dataset.path !== text) {
      el.dataset.path = text;
      el.textContent = text + ' /';
      el.title = t('In {path} — open this folder', { path: text });
    }
  }

  /* ---------------- UI sync ---------------- */
  syncUI() {
    setCurrentBoard(this.store.doc.id, this.store.doc.name);
    this.syncBoardPath();
    syncToolbar(this);
    syncPresentBar(this);
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
    if (label) label.textContent = t('Page {n} of {total}', { n: i + 1, total: n });
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

    const close = h('button', { class: 'hint-x', title: t('Dismiss'), html: icon('close', 13) });
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
  /*
   * Close whatever is open, and say whether there was anything to close.
   *
   * The press that shuts a menu should only shut the menu. Handing that answer
   * back lets the gesture that follows know it was a dismissal rather than a
   * fresh instruction - see the shape and note tools, which otherwise drop an
   * object on the very tap that put the menu away.
   */
  hideMenus() { const was = popoverOpen(); closePopover(); return was; }

  /*
   * Getting rid of whatever is on top.
   *
   * Every layer used to look after itself, and most of them forgot. A dialog
   * could only be closed by finding its Close button - on the shortcuts list
   * that meant scrolling past forty rows to reach it - and the slide-in panel
   * ignored clicks on the board behind it. Escape and a click outside are what
   * anyone tries first, so they are wired once, here, for every layer.
   *
   * Order matters: the topmost thing goes first, and nothing underneath reacts.
   * Escape with a dialog up must not also clear your selection.
   */
  initDismissal() {
    const overlay = document.getElementById('overlay');

    if (overlay) {
      overlay.addEventListener('pointerdown', (e) => {
        // Only the dark backdrop. A click inside the card is someone using it.
        if (e.target !== overlay) return;
        e.preventDefault();
        this.dismissOverlay();
      });
    }

    // Capture, so this runs before the board's own key handling and can stop it.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.dismissOverlay()) { e.preventDefault(); e.stopPropagation(); return; }
      if (popoverOpen()) { closePopover(); e.preventDefault(); e.stopPropagation(); return; }
      if (this.panels.open) { this.panels.close(); e.preventDefault(); e.stopPropagation(); }
    }, true);

    document.addEventListener('pointerdown', (e) => {
      if (!this.panels.open) return;
      const el = e.target instanceof Element ? e.target : null;
      // The toolbar button that opened it toggles it shut by itself; closing
      // here as well would shut and immediately reopen the panel. A popover or
      // a dialog belongs to the panel, or sits above it, so neither counts as
      // outside.
      if (el && el.closest('#panel, #toolbar, #overlay, #ctxbar, .pop')) return;
      this.panels.close();
    }, true);
  }

  /**
   * Take the dialog off the screen and tell whoever opened it.
   *
   * The telling is the part that matters: choose() and confirm() are waiting on
   * a promise, and a dialog that vanished without answering would leave the
   * board waiting for ever. Whatever opened it decides what a dismissal MEANS,
   * and it is always the answer that changes nothing.
   */
  dismissOverlay() {
    const overlay = document.getElementById('overlay');
    if (!overlay || !overlay.classList.contains('show')) return false;
    // A progress bar is not a question. Escape cannot cancel the import behind
    // it, so taking it off the screen would only hide work that is still going.
    if (this._overlayLocked) return false;
    overlay.classList.remove('show');
    const onDismiss = this._overlayDismiss;
    this._overlayDismiss = null;
    if (onDismiss) onDismiss();
    return true;
  }

  /** Put a dialog up, saying what Escape and a click outside should mean. */
  showOverlay(onDismiss = null, { dismissible = true } = {}) {
    this._overlayDismiss = onDismiss;
    this._overlayLocked = !dismissible;
    document.getElementById('overlay').classList.add('show');
  }

  /* ---------------- notifications & dialogs ---------------- */
  /**
   * Put every setting back the way it shipped.
   *
   * Two things are deliberately left alone, because resetting them would do
   * something rather than merely undo something.
   *
   * Sharing stays as it is: switching it off would drop a class mid-lesson,
   * and switching it ON is not a thing a "reset" button has any business
   * doing to a person's network. Paired computers are not settings at all and
   * are never touched here - forgetting those has its own button, with its own
   * warning, because the other machine has to be told.
   *
   * The update check stays too. It is the one setting whose default is "never
   * asked", and answering it on somebody's behalf is not a default, it is a
   * decision about the network.
   */
  resetSettings() {
    const keep = {
      sync: this.settings.sync,
      updateCheck: this.settings.updateCheck,
      lastUpdateCheck: this.settings.lastUpdateCheck,
      skippedVersion: this.settings.skippedVersion,
      updateAskedAt: this.settings.updateAskedAt,
      hintsSeen: this.settings.hintsSeen,
      // Folders are where boards are filed, not a preference: a reset must
      // never empty the filing cabinet.
      folders: this.settings.folders,
      boardFolders: this.settings.boardFolders
    };
    this.settings = { ...DEFAULT_SETTINGS, ...keep };
    this.saveSettings();
    this.inkTrail?.setEnabled(!!this.settings.inkTrail);
    this.interaction.hideInkPointer();
    this.setTool(this.tool);
    this.surface.invalidate();
    this.syncUI();
  }

  /**
   * A board is arriving. Say so, quietly.
   *
   * The rule this is written around: somebody may be mid-sentence on the board
   * when a colleague hits Send. Nothing here may steal focus, cover the
   * canvas, move the toolbar, or cause a single repaint of the drawing.
   *
   * So it is one small ring on the top bar - a circle that fills as the board
   * comes in, with the sender's name beside it. It writes straight into two
   * DOM nodes and touches nothing else. The board name only appears at the
   * end, because until the whole thing has arrived and been unsealed there is
   * no way to know it: the title is inside the encrypted part, which is where
   * it belongs.
   */
  /**
   * Two soft notes, made on the spot rather than shipped as a file.
   *
   * Nothing is downloaded and nothing is bundled: it is a hundred milliseconds
   * of oscillator, so the app stays the same size and still works with no
   * network at all. Quiet on purpose - this is a nudge during a lesson, not an
   * alarm - and it fails silently, because a browser that has not been clicked
   * yet will refuse to make a sound and that must never break a transfer.
   */
  playArrivalChime() {
    if (this.settings.arrivalSound === false) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = this._audio || (this._audio = new Ctx());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      /*
       * Three rising notes rather than two, and a triangle wave rather than a
       * sine.
       *
       * A sine is the quietest shape there is: all its energy sits at one
       * frequency, so in a room with a projector fan and thirty students it
       * simply vanishes. A triangle carries a few harmonics, which is what
       * makes a sound carry - it is heard as clearer rather than harsher at
       * the same volume. Three notes also read as deliberate; two can pass for
       * a stray system beep.
       */
      [[659, 0], [880, 0.1], [1175, 0.2]].forEach(([hz, at]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = hz;
        // A gentle rise and fall. A square-edged blip reads as an error sound.
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.26, now + at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.32);
      });
    } catch { /* no audio on this machine, or not allowed yet */ }
  }

  showReceiving(info) {
    if (!info) return;
    const host = document.getElementById('rxBadge');
    if (!host) return;
    const ring = host.querySelector('.rx-ring');
    const label = host.querySelector('.rx-label');

    if (info.state === 'failed') { host.classList.remove('show'); return; }

    const pct = Math.max(0, Math.min(100, Math.round(info.percent || 0)));
    // The ring is a conic gradient, so moving it is one style write and the
    // compositor does the rest. No layout, no paint of anything else.
    if (ring) {
      ring.style.background =
        `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--stroke) 0deg)`;
      ring.setAttribute('aria-valuenow', String(pct));
    }
    if (label) {
      label.textContent = info.state === 'arrived'
        ? (info.board ? t('{board} — from {name}', { board: info.board, name: info.name }) : t('Board from {name}', { name: info.name }))
        : t('{name} — {pct}%', { name: info.name, pct });
    }
    /*
     * The heads-up, once per transfer.
     *
     * The complaint this answers: writing on the board, someone hits Send, and
     * the first you know of it is an "accept this board?" dialog landing over
     * your sentence. A ring that quietly fills in the corner is no use if you
     * are looking at the ink.
     *
     * So the badge announces itself - a brief pulse and two soft notes - and
     * then settles down to being a ring. Once, at the start, keyed on the
     * transfer id so a progress update never re-triggers it.
     */
    if (info.id && info.id !== this._rxAnnounced && info.state !== 'arrived') {
      this._rxAnnounced = info.id;
      host.classList.add('alert');
      setTimeout(() => host.classList.remove('alert'), 2600);
      this.playArrivalChime();
    }

    host.classList.add('show');
    host.title = info.state === 'arrived'
      ? t('A board has just arrived') : t('Receiving a board from {name}', { name: info.name });

    clearTimeout(this._rxHide);
    host.classList.toggle('done', info.state === 'arrived');
    if (info.state === 'arrived') {
      // Leave the finished name up long enough to read, then get out of the way.
      this._rxHide = setTimeout(() => host.classList.remove('show', 'done'), 4000);
    } else {
      // A sender that goes quiet - laptop shut, wifi dropped - must not leave a
      // ring stuck at 40% forever.
      this._rxHide = setTimeout(() => host.classList.remove('show'), 20000);
    }
  }

  /**
   * A passing note, optionally with something to do about it.
   *
   * `action` turns the note into an offer: {label, onClick}. It is for the case
   * where the app has just done exactly what was asked and the result still
   * needs a decision - telling someone their work is now off the paper is only
   * half a message if the fix is three menus away. The button does the thing
   * and the note goes.
   */
  toast(message, iconName = 'check', ms = 2600, action = null) {
    const host = document.getElementById('toasts');
    const el = h('div', { class: 'toast' }, h('span', { html: icon(iconName, 16), style: 'display:flex' }), h('span', {}, message));
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      el.style.opacity = '0'; el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    };
    if (action && action.label) {
      const b = h('button', { class: 'toast-action' }, action.label);
      b.addEventListener('click', () => { dismiss(); action.onClick?.(); });
      el.appendChild(b);
    }
    host.appendChild(el);
    setTimeout(dismiss, ms);
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
      this.rememberCanvas({ paper: 'infinite' });
      /*
       * An infinite canvas has no sheets, but the days its sheets were started
       * are kept: switching to infinite and back to paper must not make a page
       * begun on Monday say it was begun today.
       */
      const dates = this.pages.map((p) => p.date || null);
      const ops = [this.store.pagesOp([])];
      if (dates.length) ops.push({ t: 'doc', before: { pageDates: this.store.doc.pageDates }, after: { pageDates: dates } });
      if (this.pages.length) this.store.commit('infinite canvas', ops);
      this.toast(t('Infinite canvas'));
      this.surface.invalidate();
      this.syncUI();
      return;
    }

    const size = pageWorldSize(paperId, orientation);
    if (!size) return;
    // back from an infinite canvas that used to be paper: as many sheets as it had, so nothing is left off them
    const remembered = !this.pageCount && Array.isArray(this.store.doc.pageDates) ? this.store.doc.pageDates : [];
    const count = Math.max(1, this.pageCount || remembered.length);
    // a new size, not a new sheet: each page keeps the day it was started, and
    // a canvas that is only now becoming paper starts its first sheet today
    const was = this.pages;
    // coming back from an infinite canvas: the sheets it had keep their days
    const kept = remembered;
    const next = Array.from({ length: count }, (_, i) => {
      const p = { ...size };
      const date = was[i] ? was[i].date : (kept[i] || todayStamp());
      if (date) p.date = date;
      return p;
    });

    // objects ride their sheet to its new place in the strip
    const ops = [this.store.pagesOp(next)];
    if (this.pageCount) ops.push(...this.relayoutOps(this.pages, next));
    if (remembered.length) ops.push({ t: 'doc', before: { pageDates: remembered }, after: { pageDates: undefined } });

    this.settings.pageOrientation = orientation;
    this.settings.pagePaper = paperId;
    this.saveSettings();
    this.rememberCanvas({ paper: paperId, orientation });
    this.store.commit('page size', ops);
    this.fitToPage(Math.min(this.currentPageIndex(), count - 1));

    /*
     * An infinite canvas has no outside, so nothing on it was ever "off the
     * page". The moment it becomes a pad, work that was spread comfortably
     * across the desk can be sitting beyond the sheet - still there, still
     * safe, but not on the paper and not in the export. That is a surprise
     * worth naming at the moment it happens rather than leaving to be
     * discovered at print time, and the fix already exists, so the note
     * carries it: one press brings everything onto the page.
     */
    const stray = this.offPageObjects({ edges: true });
    const orient = orientation === 'portrait' ? t('portrait') : orientation === 'landscape' ? t('landscape') : orientation;
    const label = count > 1
      ? t('{paper} {orientation} — {count} pages', { paper: paperById(paperId).label, orientation: orient, count })
      : t('{paper} {orientation}', { paper: paperById(paperId).label, orientation: orient });
    if (stray.length) {
      this.toast(
        stray.length === 1
          ? t('{label} — 1 item sits off the paper', { label })
          : t('{label} — {n} items sit off the paper', { label, n: stray.length }),
        'template', 7000,
        { label: t('Fit onto the page'), onClick: () => this.fitContentToPage() }
      );
    } else this.toast(label);
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
    if (!this.pageCount) { this.toast(t('This board is an infinite canvas')); return false; }
    const at = clamp(index + 1, 0, this.pageCount);
    const like = this.pages[clamp(index, 0, this.pageCount - 1)];
    // a new sheet - a copy too - is written today, so it carries today's date
    const size = { w: like.w, h: like.h, date: todayStamp() };
    const next = this.pages.map((p) => ({ ...p }));
    next.splice(at, 0, size);

    // everything from `at` onwards shifts one place down the strip
    const ops = [...this.relayoutOps(this.pages, next, (i) => (i >= at ? i + 1 : i)), this.store.pagesOp(next)];

    const pageGroups = [];
    if (copyOf >= 0 && copyOf < this.pageCount) {
      const srcRect = pageRects(this.pages)[copyOf];
      const dstRect = pageRects(next)[at];
      for (const o of this.store.objects) {
        if (pageIndexForBox(this.pages, boundsOf(o)) !== copyOf) continue;
        const copy = structuredClone(o);
        copy.id = uid(o.type === 'stroke' ? 's' : 'o');
        delete copy.attachedTo;
        pageGroups.push(copy);
        translateObject(copy, dstRect.x - srcRect.x, dstRect.y - srcRect.y);
        ops.push({ t: 'add', obj: copy });
      }
    }

    this.regroup(pageGroups);
    this.store.commit(copyOf >= 0 ? 'duplicate page' : 'add page', ops);
    this.goToPage(at);
    this.toast(copyOf >= 0 ? t('Page {n} duplicated', { n: at + 1 }) : t('Page {n} of {total}', { n: at + 1, total: next.length }));
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
    if (this.pageCount <= 1) { this.toast(t('A pad needs at least one page')); return false; }
    if (index < 0 || index >= this.pageCount) return false;

    const doomed = this.store.objects.filter((o) => pageIndexForBox(this.pages, boundsOf(o)) === index);
    if (doomed.length) {
      const answer = await this.choose(
        t('Delete page {n}?', { n: index + 1 }),
        doomed.length === 1
          ? t('One thing is on it. Deleting the page deletes them too — one undo brings it all back.')
          : t('{n} things are on it. Deleting the page deletes them too — one undo brings it all back.', { n: doomed.length }),
        [{ id: 'delete', label: t('Delete the page'), primary: true }, { id: 'keep', label: t('Keep it') }]
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
    this.toast(t('Page deleted — {n} left', { n: next.length }));
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
  /**
   * What is not on the paper.
   *
   * On a pad the sheet is the edge of the world: whatever crosses it is cut
   * off, on screen and in every export alike, the way ink stops at the edge of
   * real paper. So writing that runs up to - or a little over - the edge is NOT
   * stray; the part beyond is simply gone, and asking about it (or worse,
   * offering to shrink and re-centre the whole page to "rescue" a pen's
   * thickness) is wrong. Only things that sit off every sheet altogether are
   * stray: they show on the desk but would vanish from an export.
   *
   * `{ edges: true }` also counts things that merely cross an edge. That is the
   * right question at exactly two moments - an infinite canvas being turned
   * into paper, and a board from before pages clipped - when the content was
   * placed with no edge in sight and cutting it off would be a surprise.
   */
  offPageObjects({ edges = false } = {}) {
    const pages = this.pages;
    if (!pages.length) return [];
    const rects = pageRects(pages);
    return this.store.objects.filter((o) => {
      const b = boundsOf(o);
      const i = pageIndexForBox(pages, b);
      if (i < 0) return true;
      if (!edges) return false;
      const r = rects[i];
      return b.x < r.x - 0.5 || b.y < r.y - 0.5 || b.x + b.w > r.x + r.w + 0.5 || b.y + b.h > r.y + r.h + 0.5;
    });
  }

  /**
   * Slide only the given stray things onto the sheet nearest each, shrinking
   * one only if it is bigger than the sheet. Nothing already on the paper is
   * moved - this must never re-centre someone's writing. One undo.
   */
  bringOntoPages(stray = this.offPageObjects(), margin = 24) {
    const pages = this.pages;
    if (!pages.length || !stray.length) return false;
    const rects = pageRects(pages);
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
    this.toast(stray.length === 1 ? t('Brought one thing back onto the paper') : t('Brought {n} things back onto the paper', { n: stray.length }));
    return true;
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
    if (!pages.length) { this.toast(t('This board has no page — it is an infinite canvas')); return false; }
    const rects = pageRects(pages);

    if (pages.length === 1) {
      const page = rects[0];
      const b = this.store.contentBounds();
      if (!b || !b.w || !b.h) { this.toast(t('Nothing on the board yet')); return false; }
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
      this.toast(scale < 1 ? t('Fitted to the page at {pct}%', { pct: Math.round(scale * 100) }) : t('Centred on the page'));
      return true;
    }

    const stray = this.offPageObjects({ edges: true });
    if (!stray.length) { this.toast(t('Everything is already on a page')); return false; }
    return this.bringOntoPages(stray, margin);
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
      n === 1 ? t('One thing is off the page') : t('{n} things are off the page', { n }),
      t('Exports cover the sheet, so anything outside it will be left out. You can move those things onto the page first - nothing already on the page moves - or export the sheet as it is.'),
      [{ id: 'fit', label: t('Move them onto the page'), primary: true },
       { id: 'crop', label: t('Export the sheet anyway') }]
    );
    if (answer === null) return false;
    if (answer === 'fit') this.bringOntoPages(off);
    return true;
  }

  /** SVG: the boards this one links to can go in too, under it. */
  async exportSvgWithLinks() {
    if (!(await this.checkOffPageBeforeExport())) return null;
    const linked = await this.askAboutLinkedBoards('svg');
    if (linked === null) return null;
    return exportSvg(this, { linked });
  }

  async exportPdfWithSetup() {
    if (!this.store.objects.length) { this.toast(t('Nothing on the board to export')); return null; }
    if (!(await this.checkOffPageBeforeExport())) return null;
    // the boards this one links to can go in too, after it
    const linked = await this.askAboutLinkedBoards('pdf');
    if (linked === null) return null;
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
    return exportPdf(this, { ...opts, linked });
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
    this.showOverlay(null, { dismissible: false });
    return {
      update: (frac, msg) => { bar.firstChild.style.width = Math.round(clamp(frac, 0, 1) * 100) + '%'; if (msg) label.textContent = msg; },
      close: () => { this._overlayLocked = false; overlay.classList.remove('show'); }
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
      // Clearing the handler first stops a dismissal firing on the way out and
      // resolving the same promise twice.
      const done = (v) => { this._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
      card.appendChild(h('h3', {}, title));
      card.appendChild(h('p', {}, text));
      const row = h('div', { class: 'actions', style: 'flex-wrap:wrap;gap:8px' });
      if (cancel) row.appendChild(h('button', { class: 'btn', onclick: () => done(null) }, t('Cancel')));
      for (const c of choices) {
        row.appendChild(h('button', { class: 'btn' + (c.primary ? ' primary' : ''), onclick: () => done(c.id) }, c.label));
      }
      card.appendChild(row);
      // Escape or a click outside means the answer that changes nothing.
      this.showOverlay(() => resolve(null));
    });
  }

  /**
   * Ask for a line of text. Resolves to the string, or null if they backed out.
   *
   * Built the same way as choose() rather than on the browser's prompt(),
   * which Electron refuses to show at all.
   */
  askText(title, text, { value = '', placeholder = '', ok = t('OK') } = {}) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      const done = (v) => { this._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
      card.appendChild(h('h3', {}, title));
      if (text) card.appendChild(h('p', {}, text));
      const input = h('input', {
        type: 'text', value, placeholder,
        style: 'width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;font-size:14px;'
          + 'border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text)'
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });
      card.appendChild(input);
      card.appendChild(h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => done(null) }, t('Cancel')),
        h('button', { class: 'btn primary', onclick: () => done(input.value.trim()) }, ok)));
      this.showOverlay(() => resolve(null));
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  confirm(title, text, confirmLabel = t('OK')) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      const done = (v) => { this._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
      card.appendChild(h('h3', {}, title));
      card.appendChild(h('p', {}, text));
      card.appendChild(h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => done(false) }, t('Cancel')),
        h('button', { class: 'btn primary', onclick: () => done(true) }, confirmLabel)));
      // A dialog that asks before doing something dismisses as "do not".
      this.showOverlay(() => resolve(false));
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
  static UPDATE_INTERVAL = 12 * 60 * 60 * 1000;

  /** Consent first if it has never been given, otherwise a quiet twice-a-day look. */
  async startUpdateFlow() {
    try {
      const info = await this.appInfo();
      if (info?.smoke) return;
      // an update put in place on the last restart: say so - or say it did not go in
      await this.reportUpdateNote();
      if (info?.isAndroid) {
        const finger = this.fingerInks ? t('Your <b>finger</b> draws too. ') : t('One <b>finger</b> moves the board. ');
        const mouse = typeof matchMedia === 'function' && matchMedia('(any-pointer: fine)').matches
          ? (this.mouseInks ? t('A connected <b>mouse</b> draws too. ') : t('A connected <b>mouse</b> moves the board. ')) : '';
        this.showHint('android-navigation',
          t('Move with <b>two fingers</b>; <b>pinch</b> to zoom. With <b>Pen</b> selected, draw with a <b>stylus</b>. {finger}{mouse}Hold an object to select it; tap <b>…</b> for more actions. Change drawing controls in <b>Settings</b>.', { finger, mouse }));
      } else {
        this.showHint('panning',
          t('Moving around: drag with the <b>middle mouse button</b>, hold <b>Space</b> and drag, or pick the <b>Pan</b> tool (<b>G</b>) from the toolbar. The right button drags too, and the scroll wheel works as usual.'));
      }
      if (this.settings.updateCheck === null || this.settings.updateCheck === undefined) {
        // Dismissing the question means "not now", and not now should last
        // longer than one launch. It used to come back every single time the app
        // opened until it got a click, which is nagging, and easy to mistake for
        // the app having forgotten an answer you did give.
        const asked = this.settings.updateAskedAt || 0;
        if (Date.now() - asked > App.ASK_AGAIN_AFTER) await this.askAboutUpdates();
      }
      else if (this.settings.updateCheck) await this.checkForUpdates({ silent: true });
      /*
       * GazBoard is often left open all day on a classroom PC. Look again now
       * and then while it runs - checkForUpdates itself keeps to twice a day,
       * so this is a reminder to look, not more looking.
       */
      if (!this._updateTimer) {
        this._updateTimer = setInterval(() => {
          if (this.settings.updateCheck) this.checkForUpdates({ silent: true }).catch(() => {});
        }, App.UPDATE_RECHECK);
      }
    } catch { /* an update check must never be able to break the app */ }
  }

  /** How often a long-running GazBoard reminds itself to look for updates (the look itself keeps to UPDATE_INTERVAL). */
  static UPDATE_RECHECK = 60 * 60 * 1000;

  /**
   * The download-and-install side of the bridge (updater.js), or null where
   * there is none - the web and Android builds. Behind a method so the suite
   * can answer for it.
   */
  updateBridge() { return window.board.updates || null; }

  /** 'install' when this copy can download an update and restart into it, otherwise 'page'. */
  async updateMode() {
    const b = this.updateBridge();
    if (!b) return { mode: 'page' };
    try { return (await b.mode()) || { mode: 'page' }; } catch { return { mode: 'page' }; }
  }

  /** After a restart into an update: "Updated to 4.6.0", or what to do if it did not go in. */
  async reportUpdateNote() {
    const b = this.updateBridge();
    if (!b || !b.note) return null;
    let n = null;
    try { n = await b.note(); } catch { n = null; }
    if (!n) return null;
    if (n.done) {
      this.toast(t('Updated to GazBoard {version}', { version: n.to }), 'update', 6000);
      return n;
    }
    const mine = (await this.appInfo())?.version || '';
    const answer = await this.choose(
      t('The update to {version} did not go in', { version: n.to }),
      n.kind === 'mac'
        ? t('GazBoard is still on {version}, and nothing was changed. macOS may have stopped GazBoard from replacing itself: in System Settings, open Privacy & Security, then App Management, and allow GazBoard. Or install it from the download page.', { version: mine })
        : t('GazBoard is still on {version}, and nothing was changed. You can install it from the download page instead.', { version: mine }),
      [{ id: 'open', label: t('Open the download page'), primary: true }, { id: 'close', label: t('Close') }],
      { cancel: false }
    );
    if (answer === 'open') await window.board.openReleases('https://github.com/fahim9778/GazBoard/releases/tag/v' + encodeURIComponent(n.to));
    return n;
  }

  /**
   * Download an update and restart into it, once the person has said so.
   * The download is checked before anything changes; the old version stays
   * until the new one is in place.
   * @returns {Promise<boolean>} whether it is downloaded and on its way in
   */
  async installUpdate(res) {
    const b = this.updateBridge();
    if (!b) return false;
    const mb = (n) => (n / 1048576).toFixed(1);
    const progress = this.showProgress(t('Downloading GazBoard {version}', { version: res.version }), t('Starting…'));
    if (!this._updateProgressHooked) {
      this._updateProgressHooked = true;
      b.onProgress((p) => { if (this._onUpdateProgress) this._onUpdateProgress(p || {}); });
    }
    this._onUpdateProgress = (p) => progress.update(p.frac || 0, p.total
      ? t('{got} of {total} MB', { got: mb(p.got || 0), total: mb(p.total) })
      : t('Downloading…'));
    let r;
    try { r = await b.download(res.version); } catch (e) { r = { ok: false, error: e && e.message }; }
    finally { this._onUpdateProgress = null; progress.close(); }
    if (!r || !r.ok) {
      const again = await this.choose(
        t('The update could not be downloaded'),
        t('{error}. Nothing was changed. You can download it from the release page instead.', { error: (r && r.error) || t('No connection') }),
        [{ id: 'open', label: t('Open the download page'), primary: true }, { id: 'close', label: t('Close') }],
        { cancel: false }
      );
      if (again === 'open') await window.board.openReleases(res.url);
      return false;
    }
    const when = await this.choose(
      t('GazBoard {version} is ready', { version: res.version }),
      t('Restart now to start using it - your boards are saved first. Or keep working, and it goes in when you close GazBoard.'),
      [{ id: 'now', label: t('Restart now'), primary: true }, { id: 'later', label: t('When I close GazBoard') }],
      { cancel: false }
    );
    if (when === 'now') {
      // everything on disk before anything is replaced
      try { this.textEditor.commit(); await this.persist(); } catch { /* the quit flush tries again */ }
      await b.install({ now: true });
    } else {
      await b.install({ now: false });
      this.toast(t('GazBoard {version} goes in when you close GazBoard', { version: res.version }), 'update', 6000);
    }
    return true;
  }

  /** Ask once, on the first launch that gets far enough to matter. */
  async askAboutUpdates() {
    if (this.settings.updateCheck !== null && this.settings.updateCheck !== undefined) return;
    const answer = await this.choose(
      t('Check for updates?'),
      t('GazBoard can ask GitHub at most twice a day whether a newer version has been released, and tell you if there is one. It never downloads or installs anything on its own, and nothing about you or your boards is ever sent. Everything else in the app stays offline either way.'),
      [{ id: 'yes', label: t('Yes, tell me about updates'), primary: true },
       { id: 'no', label: t('No, stay fully offline') }],
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
   * @param {boolean} opts.force    ignore the twice-a-day limit and any skip
   */
  async checkForUpdates({ silent = false, force = false } = {}) {
    if (!force) {
      if (!this.settings.updateCheck) return null;
      if (Date.now() - (this.settings.lastUpdateCheck || 0) < App.UPDATE_INTERVAL) return null;
    }
    const res = await this.fetchUpdate();

    /*
     * Only a real answer starts the clock.
     *
     * The stamp used to go down the moment the call came back, success or not.
     * So a laptop that happened to be on a train, or behind a hotel portal, or
     * simply off the network for the minute the app opened, spent the next
     * half-day believing it had already looked - and the news of a new version
     * arrived a day late for no reason anybody could see. A failed attempt is
     * not a look; leave the clock where it was and try again next launch.
     *
     * Nothing runs away as a result: the automatic check happens once per
     * launch, so "try again next time" is one more request when the app is
     * opened, not a retry loop.
     */
    if (res?.ok) {
      this.settings.lastUpdateCheck = Date.now();
      this.saveSettings();
    }

    if (!res || !res.ok) {
      if (!silent) this.toast(res?.error ? t('Could not check: {error}', { error: res.error }) : t('Could not check for updates'), 'help');
      return null;
    }
    const mine = (await this.appInfo())?.version || '0.0.0';
    if (!isNewer(res.version, mine)) {
      if (!silent) this.toast(t('You are on the latest version ({version})', { version: mine }));
      return null;
    }
    // a prerelease is never pushed at someone on a stable build
    if (res.prerelease && !force) return null;
    if (!force && this.settings.skippedVersion === res.version) return null;
    // "Later" lasts until GazBoard is next started: the hourly look must not ask again all afternoon
    if (!force && this._updateOffered === res.version) return null;
    this._updateOffered = res.version;

    const canInstall = (await this.updateMode()).mode === 'install';
    const answer = await this.choose(
      t('GazBoard {version} is available', { version: res.version }),
      canInstall
        ? t('You are running {version}. GazBoard can download it and restart into it — your boards and settings stay exactly as they are.', { version: mine })
        : t('You are running {version}. The download page opens in your browser — your boards and settings are untouched by installing over the top.', { version: mine }),
      [...(canInstall ? [{ id: 'install', label: t('Download and install'), primary: true }] : []),
       { id: 'open', label: t('Open the download page'), primary: !canInstall },
       { id: 'later', label: t('Later') },
       { id: 'skip', label: t('Skip {version}', { version: res.version }) }]
    );
    if (answer === 'install') await this.installUpdate(res);
    else if (answer === 'open') await window.board.openReleases(res.url);
    else if (answer === 'skip') { this.settings.skippedVersion = res.version; this.saveSettings(); }
    return res;
  }

  /**
   * The one network call in the app, behind a method of its own.
   *
   * Everything around it - consent, the gap between looks, what counts as
   * newer - is logic worth testing, and testing it meant either talking to
   * GitHub for real (a different answer every day, and none at all offline) or
   * not testing it. A seam here lets the tests answer for GitHub and leaves
   * the shipping path exactly one line long.
   */
  fetchUpdate() { return window.board.checkForUpdate(); }

  /** Cached app:info, so the version is not re-fetched on every call. */
  async appInfo() {
    if (!this._appInfo) this._appInfo = await window.board.info();
    return this._appInfo;
  }

  showShortcuts() {
    /*
     * A list of keys is no use to a phone with no keyboard, and worse than no
     * use if it is the only thing behind a menu item called "Keyboard
     * shortcuts". It is not removed outright, because plugging a keyboard into
     * a tablet is a normal thing to do and the keys all still work when you
     * do - so the sheet leads with the gestures that ARE available, and the
     * keys follow for whoever has them.
     */
    const noKeyboard = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 760px)').matches;
    const rows = [
      ...(noKeyboard ? [
        ['h', t('On this screen')],
        [t('Draw'), t('Pen, or your finger')],
        [t('Move the board'), t('One finger — or two, if your finger draws')],
        [t('Zoom'), t('Pinch with two fingers')],
        [t('Pick something up'), t('Press and hold it')],
        [t('Rub out'), t('The eraser, or the button on an S Pen')],
        ['h', t('With a keyboard attached')]
      ] : []),
      ['h', t('Tools')],
      [t('Select'), 'V'], [t('Lasso select'), 'L'], [t('Laser pointer'), 'X'], [t('Pan the canvas'), 'G'],
      [t('Pen (last colour used)'), 'P'], [t('Highlighter'), 'H'], [t('Eraser'), 'E'],
      [t('Sticky note'), 'N'], [t('Text'), 'T'], [t('Shape'), 'S'], [t('Ruler'), 'Ctrl+R'],
      ['h', t('Pens')],
      ...PENS.map((pen, i) => [pen.label, String(i + 1)]),
      ['h', t('Canvas')],
      [t('Pan'), t('Space + drag, or middle-drag')], [t('Zoom'), t('Ctrl + wheel, or pinch')],
      [t('Pan while drawing'), t('Hold any mouse button, or scroll')],
      [t('Auto-pan while drawing'), t('Run the pen into the edge of the window')],
      [t('Zoom in / out'), 'Ctrl + = / Ctrl + -'], [t('Reset zoom'), 'Ctrl+0'], [t('Fit to board'), 'Ctrl+Shift+F'],
      ['h', t('Editing')],
      [t('Undo / Redo'), 'Ctrl+Z / Ctrl+Y'], [t('Copy / Cut / Paste'), 'Ctrl+C / Ctrl+X / Ctrl+V'],
      [t('Duplicate'), 'Ctrl+D'], [t('Delete'), 'Delete'], [t('Select all'), 'Ctrl+A'],
      [t('Edit text of selection'), t('F2 or double-click')], [t('Nudge selection'), t('Arrow keys')],
      [t('Bring to front / Send to back'), 'Ctrl+Shift+] / Ctrl+Shift+['],
      [t('Constrain / square'), t('Hold Shift while drawing')],
      [t('Link to another board'), t('@ on the board, or in words')], [t('Follow a link with any tool'), 'Ctrl+click'],
      ['h', t('Teaching')],
      [t('Present'), 'F5'], [t('Stop presenting'), 'Esc'],
      [t('Next / previous page while presenting'), t('Page Down / Page Up, or the arrows')],
      [t('Lift an answer cover'), t('Tap it with the pen, a finger or the laser')],
      ['h', t('Files')],
      [t('New board'), 'Ctrl+N'], [t('Open board'), 'Ctrl+O'], [t('Save a copy'), 'Ctrl+S'],
      [t('Insert image or document'), t('Drag a file onto the canvas')]
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
    card.appendChild(h('h3', {}, t('Keyboard shortcuts')));
    card.appendChild(grid);
    card.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => this.dismissOverlay() }, t('Close'))));
    this.showOverlay();
  }

  async showAbout() {
    const i = await window.board.info();
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    card.innerHTML = '';
    card.appendChild(h('h3', { style: 'margin-bottom:2px' }, 'GazBoard ' + i.version));
    card.appendChild(h('p', {
      style: 'margin:0 0 14px;font-size:13px;color:var(--text-2);letter-spacing:.02em',
      html: t('by <b style="color:var(--accent)">theBoringCodes</b>')
    }));
    /*
     * This paragraph is a promise, so it has to keep being true.
     *
     * It said "runs entirely on this computer" full stop, which stopped being
     * the whole story the day sharing over the wifi arrived. Rather than drop
     * the claim - it is still the point of the app - it now says exactly where
     * the edge is, and that the edge is off until somebody moves it.
     */
    card.appendChild(h('p', { html:
      t('A free-form digital whiteboard for pen, sticky notes, shapes, text, images and documents.<br><br>Runs on this device — no account, no sign-in, no cloud. Boards save automatically here. Use My boards to reopen them, or Save a copy to keep a board file in a folder you choose.<br><br>The one exception is <b>sharing on your own network</b>, which is off until you switch it on in Settings. With it on, you can hand a board straight to another GazBoard on the same network — encrypted, device to device, never through anybody\'s server. Nothing is saved without you being asked first.') }));
    card.appendChild(h('div', {
      style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--stroke);font-size:12.5px;line-height:1.8;color:var(--text-2)',
      html:
        t('Developer &nbsp;<b style="color:var(--text)">MD. Fakhruddin Gazzali</b><br>Contact &nbsp;<a href="mailto:fahim9778@gmail.com" target="_blank" style="color:var(--accent)">fahim9778@gmail.com</a><br>Co-created with <span style="color:#e81123">&hearts;</span> by Claude Cowork &amp; GPT Sol, Astra') }));
    const platformDetails = i.electron
      ? (i.libreoffice
        ? t('Office import: <b>LibreOffice detected (high fidelity)</b>')
        : t('Office import: <b>built-in converter (install LibreOffice for higher fidelity)</b>')) +
        // Where it was found, so "it says not installed" can be answered without guessing.
        (i.sofficePath ? `<br><code style="font-size:11px;opacity:.75">${i.sofficePath}</code>` : '') +
        `<br>Electron ${i.electron} · Chromium ${i.chrome}`
      : i.isAndroid
        ? t('Runtime: <b>Android</b> · WebView editor<br>Persistence: <b>Private board and image files on this device</b>')
        : i.pwa
          ? t('Runtime: <b>Web / Progressive Web App</b> · Standalone App<br>Persistence: <b>IndexedDB Persistent Storage</b>')
          : t('Runtime: <b>Web / Progressive Web App</b> · Browser<br>Persistence: <b>IndexedDB Persistent Storage</b>');
    card.appendChild(h('div', {
      style: 'margin-top:12px;font-size:11.5px;color:var(--text-2);line-height:1.7',
      html: platformDetails
    }));
    // Next to the version number is where anyone looks for this.
    const check = h('button', { class: 'btn' }, t('Check for updates'));
    check.addEventListener('click', async () => {
      check.textContent = t('Checking…');
      check.setAttribute('disabled', '');
      this.dismissOverlay();
      await this.checkForUpdates({ force: true });
    });
    /*
     * Where the boards actually live, and a way in.
     *
     * "Your boards are files in a folder here" is a much better sentence when
     * the folder is one click away - it turns a reassurance into something the
     * person can check for themselves. The Boards panel has had this for a
     * while; About is where people go looking when they want to back the whole
     * lot up or move to another machine.
     */
    if (i.userData) {
      const where = h('div', {
        style: 'margin-top:12px;padding-top:12px;border-top:1px solid var(--stroke);'
          + 'font-size:11.5px;color:var(--text-2);line-height:1.7'
      }, h('div', {}, i.electron ? t('Your boards are saved on this computer at:') : t('Your boards are stored in:')),
      h('code', { style: 'font-size:11px;display:block;margin:4px 0 0;word-break:break-all' },
        i.userData + (i.electron ? '/boards' : '')));
      if (i.electron) {
        const openIt = h('button', { class: 'btn' }, t('Open that folder'));
        openIt.style.cssText += 'margin-top:8px;padding:4px 10px;font-size:12.5px';
        openIt.addEventListener('click', () => {
          // Older preloads have only showItem. Landing one folder up is worse
          // than the button doing nothing at all, but not by much.
          if (window.board.openBoardsFolder) window.board.openBoardsFolder();
          else window.board.showItem(i.userData + '/boards');
        });
        where.appendChild(openIt);
      } else if (i.isAndroid) {
        where.appendChild(h('p', {}, t('Uninstalling GazBoard or clearing its app storage deletes local boards. Save a copy exports the open board and its images to a location you choose. Export again to keep later edits.')));
        where.appendChild(h('button', { class: 'btn', onclick: () => {
          this.dismissOverlay();
          this.command('board.save');
        } }, t('Save a copy…')));
      }
      card.appendChild(where);
    }

    card.appendChild(h('div', { class: 'actions' },
      check,
      h('button', { class: 'btn primary', onclick: () => this.dismissOverlay() }, t('Close'))));
    this.showOverlay();
  }

  /* ---------------- global events ---------------- */
  /**
   * Fetch the bundled emoji artwork, then redraw anything already on the board.
   *
   * A font named only in CSS is loaded when some text needs it, and canvas
   * drawing does not count as needing it - so without this call the board
   * quietly keeps using the machine's own emoji forever. Asking for it here
   * starts the fetch; when it lands the cached measurements are wrong (they
   * describe the old artwork) so they go, and the board repaints.
   *
   * Every step is optional. An old engine with no document.fonts, a missing
   * file, a browser that refuses - all of them end with the board drawing
   * emoji exactly as it did before, which is a worse picture and not a broken
   * one.
   */
  /**
   * Run something once the machine has a spare moment, or shortly anyway.
   *
   * requestIdleCallback waits for a gap between the things the browser is
   * already doing; the timeout is there because on a busy machine that gap may
   * never come, and "later" has to mean later rather than never. Falls back to
   * a plain wait where idle callbacks do not exist.
   */
  whenIdle(fn, timeout = 1500) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout });
    else setTimeout(fn, timeout);
  }

  /**
   * Fetch the faces board text is written in, then redraw.
   *
   * Same trap as the emoji font below: canvas drawing does not count as a
   * page needing a font, so a face named only in CSS is never fetched for the
   * board, and every line keeps being measured in whatever the machine has.
   * That is the very difference between devices these files exist to remove.
   *
   * Every face and both weights are asked for, and the sample carries an
   * accented letter from outside plain Latin so the latin-ext file comes too -
   * a name like Łukasz on a board would otherwise fall back, one letter at a
   * time, to the machine's own font. The files are local, so this is quick;
   * the board repaints once when all of them are in.
   *
   * Resolves either way. A face that fails to load leaves the board drawing
   * in its fallback, which is how every board looked before this existed.
   */
  loadBoardFonts() {
    if (this._boardFonts) return this._boardFonts;
    const done = () => { this.surface?.repaintAll?.(); return true; };
    try {
      if (!document.fonts?.load) return (this._boardFonts = Promise.resolve(false));
      const sample = 'Aa \u0141\u0142';
      const asks = [];
      for (const f of FONTS) {
        for (const w of [400, 600]) asks.push(document.fonts.load(`${w} 16px "${f.family}"`, sample));
      }
      // Bangla and Arabic typed on a board come from these two (see app.css).
      // A canvas never asks for a font by itself, so they are asked for here.
      for (const [family, text] of [['GazBoard Noto Bengali', '\u0995\u0996'], ['GazBoard Noto Arabic', '\u0628\u062A']]) {
        for (const w of [400, 600]) asks.push(document.fonts.load(`${w} 16px "${family}"`, text));
      }
      this._boardFonts = Promise.allSettled(asks).then(done, done);
    } catch {
      this._boardFonts = Promise.resolve(false);
    }
    return this._boardFonts;
  }

  loadEmojiFont() {
    try {
      if (!document.fonts?.load) return;
      document.fonts.load('100px "GazBoard Emoji"', '\u2705').then(() => {
        forgetEmojiMetrics();
        this.surface.repaintAll();
      }).catch(() => {});
    } catch { /* no font loading here; the system emoji still draw */ }
  }

  wireGlobalEvents() {
    const titleEl = document.getElementById('boardTitle');
    titleEl.addEventListener('change', () => this.store.rename(titleEl.value.trim() || t('Untitled board')));
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
      this.loadBoard(data).catch(() => this.toast(t('Could not open that board')));
    });
    window.board.onWindowResized(() => {
      // the window changed shape - re-measure now and again after layout settles
      this.surface.resize();
      requestAnimationFrame(() => { this.surface.resize(); this.textEditor.reposition(); this.syncUI(); });
    });

    // Android's Share/Open with and Back actions meet the same import and
    // dismissal paths as the toolbar. No second editor or document model.
    window.addEventListener('gazboard:import-file', async ({ detail: path }) => {
      try {
        if (/\.(gazboard|openboard|json)$/i.test(path)) {
          this.boardOpenedExplicitly = true;
          const data = JSON.parse(new TextDecoder().decode(await window.board.readFile(path)));
          data.origin = window.board.fileOrigin(path);
          // Opening another file must not discard edits in the current board.
          this.commitTextEdit();
          await this.persist();
          await this.loadBoard(data, { asCopy: false });
        } else if (isImagePath(path)) await insertImagesFromPaths(this, [path]);
        else if (isDocPath(path)) await insertDocument(this, path);
        else this.toast(t('Choose a board, image, PDF, or supported document'), 'help');
      } catch (e) { this.toast(t('Could not open file: {error}', { error: e.message }), 'help'); }
    });
    window.addEventListener('gazboard:back', () => {
      if (document.getElementById('overlay')?.classList.contains('show')) { this.dismissOverlay(); return; }
      if (popoverOpen()) { closePopover(); return; }
      if (this.textEditor.active) { this.textEditor.commit(); return; }
      if (this.panels.open) { this.panels.close(); return; }
      if (this.surface.selection.size) { this.setSelection([]); return; }
      window.board.background?.();
    });

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') this.interaction.spaceDown = false; });
    window.addEventListener('blur', () => { this.interaction.spaceDown = false; });

    // paste from the system clipboard
    document.addEventListener('paste', async (e) => {
      if (this.textEditor.active) return;
      // Pasting into a box that takes typing - the maths editor, a sharing
      // code, a board name, a dialog's field - is that box's paste, not the board's.
      const el = e.target instanceof Element ? e.target : document.activeElement;
      if (el && (el.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]') || el.isContentEditable)) return;
      /*
       * Which is newer is settled FIRST, before anything on the clipboard is
       * looked at. Asking "is there a picture?" before "whose copy is newer?"
       * let a screenshot taken an hour ago beat two notes copied a second ago,
       * because a picture is a picture whenever it arrived.
       */
      if (this.boardCopyIsNewest()) {
        e.preventDefault();
        // Where the pointer is, not where the originals were. preventDefault
        // has already happened, so there is nothing left to race.
        this.pasteAt(this.pastePoint());
        return;
      }
      const items = [...(e.clipboardData?.items || [])];
      const imageItem = items.find((i) => i.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        await insertImageFiles(this, [file], this.pastePoint());
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim()) {
        e.preventDefault();
        this.addPastedText(text, this.pastePoint(), e.clipboardData?.getData('text/html'));
        return;
      }
      if (this.clipboard.length) { e.preventDefault(); this.pasteAt(this.pastePoint()); }
    });

    // drag & drop files
    const stage = document.getElementById('stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropFiles([...(e.dataTransfer?.files || [])], this.surface.toWorld(e));
    });

    window.addEventListener('resize', () => this.textEditor.reposition());
    // Going full screen, or turning a tablet round, while presenting: keep the
    // page filling the screen.
    window.addEventListener('resize', () => { if (this.presenting) this.presentFit(); this.timer?.place(); });
    /*
     * Leaving full screen by any route - Escape, F11, the system's own button -
     * ends presenting too. Staying in a chrome-less board inside an ordinary
     * window would look like the app had lost its toolbars.
     */
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.presenting && this._presentFullscreen) this.stopPresenting();
    });
    document.addEventListener('wheel', () => this.textEditor.reposition(), { passive: true });
    window.addEventListener('beforeunload', () => {
      if (this.settings.autosave) this.persist();
    });
  }

  /**
   * Files dropped on the board: pictures where they were dropped, documents
   * page by page, a board file opened. Anything else is named, never silently
   * skipped.
   *
   * The desktop app reads each file from where it lives on disk. A browser
   * cannot know that, so the web version takes the pictures it is handed and
   * points to Add for the rest.
   */
  async dropFiles(files, at) {
    if (!files.length) return;
    const pathOf = (f) => f.path || window.board.pathForFile?.(f) || '';
    const paths = files.map(pathOf);
    const name = (f) => f.name || '?';
    if (paths.every(Boolean)) {
      const boardFile = paths.find((p) => /\.(gazboard|openboard)$/i.test(p));
      const imgs = paths.filter(isImagePath);
      const docs = paths.filter(isDocPath);
      const other = files.filter((f, i) => !isImagePath(paths[i]) && !isDocPath(paths[i]) && paths[i] !== boardFile);
      if (imgs.length) await insertImagesFromPaths(this, imgs, at);
      for (const d of docs) await insertDocument(this, d);
      if (boardFile) window.dispatchEvent(new CustomEvent('gazboard:import-file', { detail: boardFile }));
      if (other.length) this.toast(t('Could not add {names} - drop a picture, a document or a board', { names: other.map(name).join(', ') }), 'help', 6000);
      return;
    }
    const pictures = files.filter((f) => String(f.type || '').startsWith('image/'));
    const rest = files.filter((f) => !pictures.includes(f));
    if (pictures.length) await insertImageFiles(this, pictures, at);
    if (rest.length) this.toast(t('Only pictures can be dropped here - add {names} with Add > Document', { names: rest.map(name).join(', ') }), 'help', 6000);
  }

  onKeyDown(e) {
    if (this.textEditor.active) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

    const mod = e.ctrlKey || e.metaKey;

    if (e.code === 'Space') { this.interaction.spaceDown = true; e.preventDefault(); return; }

    // F5 presents, as it does in every slide program; Shift+F5 too.
    if (e.key === 'F5') { e.preventDefault(); if (!this.presenting) this.command('view.present'); return; }

    /*
     * While presenting, the page keys and the arrows turn pages - which is also
     * what a presentation clicker sends. Arrows go back to nudging the moment
     * something is selected, because moving a thing you picked up is plainly
     * what they mean then. Space is left alone: it pans, and a teacher holding
     * it to drag the board must not be flung onto the next page.
     */
    if (this.presenting && !mod) {
      const step = { PageDown: 1, PageUp: -1, ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step && !(e.key.startsWith('Arrow') && this.surface.selection.size)) {
        e.preventDefault();
        this.presentStep(step);
        return;
      }
    }

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
      if (k === 'g') { e.preventDefault(); this.command(e.shiftKey ? 'edit.ungroup' : 'edit.group'); return; }
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
      case 'Escape': {
        /*
         * Escape means "never mind", and there are three things it can mean
         * that about, in the order they are most likely to be on your mind.
         *
         * A dialog, a popover or the panel is dealt with in initDismissal(),
         * which stops the event before it reaches here, so getting this far
         * means nothing is layered over the board.
         */
        // 1. Something is being drawn right now. Abandon it; nothing was ever
        //    added to the board, so there is nothing to undo afterwards.
        if (this.interaction?.cancelGesture?.()) return;
        // Presenting: Escape is how everyone expects to get out of it.
        if (this.presenting) { this.stopPresenting(); return; }
        // 2. A tool is armed and waiting to drop something - a note, a text
        //    box, a shape, an emoji. Changing your mind before the drop puts
        //    you back where you were, which is the pen if you were writing and
        //    Select if you were not.
        if (App.PLACING.includes(this.tool)) {
          this.setTool(this.toolBefore || 'select');
          this.syncUI();
          return;
        }
        // 3. Otherwise it is about whatever is selected.
        this.setSelection([]);
        return;
      }
      case 'F2': {
        const o = this.selected[0];
        if (o && ['note', 'text', 'shape', 'table'].includes(o.type)) this.beginTextEdit(o);
        else if (o && o.type === 'math' && !o.locked) this.beginMathEdit(o);
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
      const slot = PENS[Number(e.key) - 1];
      const pen = slot && penById(this.settings, slot.id);
      if (pen) {
        e.preventDefault();
        this.settings.activePen = pen.id;
        this.settings.penColor = pen.color;
        this.settings.penEffect = pen.effect;
        this.saveSettings();
        this.setTool('pen');
        this.syncUI();
        this.toast(pen.label, 'pen');
        return;
      }
    }

    // "@" on the board: a link to another board, where the pointer is
    if (e.key === '@' && !mod) { e.preventDefault(); this.command('insert.boardlink'); return; }

    const keyTool = { v: 'select', l: 'lasso', p: 'pen', h: 'highlighter', e: 'eraser', n: 'note', t: 'text', s: 'shape', x: 'laser', g: 'pan' }[e.key.toLowerCase()];
    if (keyTool) { this.setTool(keyTool); return; }
    if (e.key === '?') this.showShortcuts();
  }

  /* ================================================================= *
   *  Sharing boards over the local network
   *
   *  GazBoard is an offline app and stays one. This is the single place
   *  where it will talk to another machine, and it is off until somebody
   *  switches it on: with settings.sync false, nothing below opens a socket,
   *  answers a packet or announces that this computer exists. There is still
   *  no account, no server and nothing leaves the room - two GazBoards on the
   *  same wifi hand a board straight to each other.
   *
   *  Everything that arrives is a question, never an action. A board that
   *  turns up is shown to the person - name, size and a small picture of it -
   *  and nothing is written until they say yes.
   * ================================================================= */

  initSync() {
    // The web build has no sync at all; the preload that provides it is the
    // desktop one. Absent is normal, not an error.
    if (!window.board || !window.board.sync) return;
    this.syncPeers = [];
    this.syncStatus = null;
    this._incoming = [];
    this._incomingBusy = false;

    window.board.sync.onPeers((peers) => {
      this.syncPeers = Array.isArray(peers) ? peers : [];
      this.panels.syncChanged();
    });
    window.board.sync.onIncoming((msg) => this.queueIncomingBoard(msg));
    // Android: a board that reached the phone but could not be handed to the page. Never silently.
    window.board.sync.onIncomingFailed?.((info) => {
      this.toast(t('A board from {name} arrived but could not be opened here: {error}', { name: (info && info.name) || t('another computer'), error: (info && info.error) || '?' }), 'help', 12000);
    });
    if (window.board.sync.onReceiving) {
      window.board.sync.onReceiving((info) => { this._receivingAt = performance.now(); this.showReceiving(info); });
    }
    // Routed through a field rather than wired per send, because listeners
    // registered on a preload bridge cannot be taken off again.
    this._onSendBytes = null;
    if (window.board.sync.onSendProgress) {
      window.board.sync.onSendProgress((p) => { if (this._onSendBytes) this._onSendBytes(p); });
    }

    if (!this.settings.sync) return;
    // Switched on last time: bring it back up quietly. A failure here is worth
    // saying out loud, because the symptom otherwise is a device list that
    // simply never fills in.
    this.startSync().catch(() => {});
  }

  /**
   * Bring sharing up, and remember it if it will not come.
   *
   * The failure worth designing for is not a busy port - it is the service
   * failing to load at all, which is what a build missing a file does. The
   * panel asks the main process for its state, gets back an honest "not
   * running, no error" (because nothing ever started), and sits on "Starting…"
   * for ever. Keeping the reason here is what lets it say what went wrong
   * instead of pretending it is still trying.
   *
   * @returns {Promise<boolean>} whether it is now running
   */
  async startSync() {
    this.syncStartError = null;
    let st = null;
    try { st = await window.board.sync.start(); }
    catch (e) { st = { error: e && e.message ? e.message : String(e) }; }

    this.syncStatus = st;
    this.syncPeers = (st && st.peers) || [];
    if (st && st.running) { this.panels.syncChanged(); return true; }

    this.syncStartError = (st && st.error) || t('it did not start, and gave no reason');
    this.toast(t('Sharing on this network could not start: {error}', { error: this.syncStartError }), 'help', 8000);
    this.panels.syncChanged();
    return false;
  }

  /** Latest state from the main process, cached for the settings panel. */
  async refreshSyncStatus() {
    if (!window.board || !window.board.sync) return null;
    try {
      this.syncStatus = await window.board.sync.state();
      this.syncPeers = (this.syncStatus && this.syncStatus.peers) || [];
    } catch { this.syncStatus = null; }
    return this.syncStatus;
  }

  /**
   * Boards arrive one at a time, however many are sent at once.
   *
   * Thirty students pressing send together is the case this is for. Without a
   * queue the second dialog would paint over the first, and the first sender
   * would sit waiting on a question nobody can answer any more.
   */
  queueIncomingBoard(msg) {
    if (!msg || !msg.ticket) return;
    /*
     * Android asks again for every question still open when the editor
     * reloads, so the same board can be offered twice. One ticket, one
     * question: a second copy would be answered after the first and tell the
     * person the sender had "stopped waiting" when it had not.
     */
    this._tickets = this._tickets || new Set();
    if (this._tickets.has(msg.ticket)) return;
    this._tickets.add(msg.ticket);
    if (this._tickets.size > 500) this._tickets.delete(this._tickets.values().next().value);
    this._incoming.push(msg);
    if (!this._incomingBusy) this.drainIncomingBoards();
  }

  async drainIncomingBoards() {
    this._incomingBusy = true;
    try {
      while (this._incoming.length) {
        const msg = this._incoming.shift();
        try { await this.handleIncomingBoard(msg); }
        catch { try { window.board.sync.answer(msg.ticket, null); } catch {} }
      }
    } finally { this._incomingBusy = false; }
  }

  async handleIncomingBoard({ ticket, board, from }) {
    /*
     * The sending machine is holding a socket open waiting for this, and gives
     * up after five minutes. Somebody who wanders back to a dialog they left on
     * screen is therefore answering a question nobody is listening to any more,
     * which is allowed - it just means the answer lands nowhere. false says so.
     *
     * @returns {Promise<boolean>} whether anyone was still waiting for it
     */
    const reply = async (outcome) => {
      try { return await window.board.sync.answer(ticket, outcome); }
      catch { return false; }
    };
    if (!board || typeof board !== 'object' || !Array.isArray(board.objects)) { reply(null); return; }
    /*
     * Boards it links to can travel inside it, so one Save takes them all -
     * rather than one question per board, a dozen taps for a dozen links.
     */
    const who = (from && from.name) || t('another computer');
    const sentWith = Array.isArray(board.linkedBoards) ? board.linkedBoards.length : 0;
    // A sane class of linked boards is a handful; past the cap it is not a lesson, it is a flood.
    if (sentWith > App.MAX_LINKED) {
      await reply(null);
      this.toast(t('Turned down a board from {name}: it came with {n} linked boards, and no more than {max} are taken at once', { name: who, n: sentWith, max: App.MAX_LINKED }), 'help', 8000);
      return;
    }
    const linked = sentWith ? board.linkedBoards.filter((d) => d && typeof d === 'object' && Array.isArray(d.objects)) : [];
    if ('linkedBoards' in board) { board = { ...board }; delete board.linkedBoards; }
    /*
     * Where this copy came from, in the same slot a file's path goes in. That
     * is deliberate: it makes "the same board sent again" behave exactly like
     * "the same file opened again" - it updates the copy it made last time
     * instead of piling up a new board every lesson. See claimLocalBoard().
     */
    const origin = 'sync:' + ((from && from.deviceId) || 'unknown') + '/' + (board.id || 'board');

    let list = [];
    try { list = (await window.board.boards.list()) || []; } catch { list = []; }
    // Sent before from this machine, or a board here that shares its identity.
    const mine = list.find((b) => b.origin && b.origin === origin)
      || list.find((b) => b.id === board.id) || null;

    // which of the linked boards to keep: all of them, unless some are unticked in the question
    const keep = new Set(linked.map((_, i) => i));
    const answer = await this.askAboutIncomingBoard({ board, who, mine, waiting: this._incoming.length, linked, keep });
    if (!answer) {
      await reply(null);
      this.toast(t('Declined the board from {name}', { name: who }), 'help');
      return;
    }

    const base = board.name && board.name !== 'Untitled board' && board.name !== t('Untitled board')
      ? board.name
      : t('Board from {name}', { name: who });

    let data;
    if (mine && answer === 'replace') data = { ...board, origin, id: mine.id, name: base };
    else if (mine) data = { ...board, origin, id: uid('b'), name: uniqueBoardName(base, list), created: Date.now() };
    else data = { ...board, origin, name: uniqueBoardName(base, list) };

    /*
     * The boards that came with it are filed the same way: a board sent before
     * is replaced only if that was the answer (and never the one open right
     * now), otherwise kept beside the old copy. Any board given a new id here
     * takes the links pointing at it along, so every link still lands.
     */
    const idMap = new Map();
    if (data.id !== board.id) idMap.set(board.id, data.id);
    const linkedData = [];
    const filed = [{ doc: null, have: mine, replaced: !!mine && answer === 'replace' }];   // [0] is the board itself, set below
    const taken = [...list, { id: data.id, name: data.name }];
    const dev = (from && from.deviceId) || 'unknown';
    for (const lb of linked.filter((_, i) => keep.has(i))) {
      const lo = 'sync:' + dev + '/' + (lb.id || 'board');
      const have = list.find((b) => b.origin && b.origin === lo) || list.find((b) => b.id === lb.id) || null;
      const lbase = lb.name && lb.name !== 'Untitled board' ? lb.name : t('Board from {name}', { name: who });
      let d;
      if (have && answer === 'replace' && have.id !== this.store.doc.id) d = { ...lb, origin: lo, id: have.id, name: lbase };
      else if (have) d = { ...lb, origin: lo, id: uid('b'), name: uniqueBoardName(lbase, taken), created: Date.now() };
      else d = { ...lb, origin: lo, name: uniqueBoardName(lbase, taken) };
      if (lb.id && d.id !== lb.id) idMap.set(lb.id, d.id);
      taken.push({ id: d.id, name: d.name });
      linkedData.push(d);
      filed.push({ doc: d, have, replaced: !!have && d.id === have.id });
    }
    if (idMap.size) {
      data = { ...data, objects: remapBoardIds(data.objects, idMap) };
      for (let i = 0; i < linkedData.length; i++) linkedData[i] = { ...linkedData[i], objects: remapBoardIds(linkedData[i].objects, idMap) };
    }
    // what each replaced board was, so Undo can put it back
    const before = new Map();
    for (const f of filed) {
      const id = f.doc ? f.doc.id : data.id;
      if (f.replaced) { try { before.set(id, await window.board.boards.load(id)); } catch { /* nothing to put back */ } }
    }
    let linkedSaved = 0;
    for (let i = 0; i < linkedData.length; i++) {
      linkedData[i] = filed[i + 1].doc = { ...linkedData[i], objects: linkedData[i].objects };
      if (await this.saveIncomingBoard(linkedData[i], false)) linkedSaved++;
    }

    /*
     * Replacing the board that is open right now is not a preference - it MUST
     * be reloaded.
     *
     * The replacement is written to disk under the same id, but the editor is
     * still holding the old objects in memory. Leave it there and the next
     * autosave writes the old board straight back over the new one: the person
     * watches "Replace my copy" succeed and then silently undo itself, with the
     * sender's work gone and nothing to show what ate it. So this one case
     * ignores the setting entirely.
     */
    const replacingWhatIsOpen = !!mine && answer === 'replace' && this.store.doc.id === mine.id;

    /*
     * Otherwise the habit decides - except when more boards are queued behind
     * this one. Opening each of five arrivals in turn is four boards flashing
     * past on the way to the fifth, so a backlog files quietly and only the
     * last one lands on screen.
     */
    let open = replacingWhatIsOpen
      || (this.settings.syncOpenOnArrival !== false && this._incoming.length === 0);

    const saved = await this.saveIncomingBoard(data, open);
    if (!saved) {
      await reply(null);
      this.toast(t('Could not save the board from {name}', { name: who }), 'help', 6000);
      return;
    }
    filed[0].doc = data;
    // ";linked=n" tells a sender that knows about it that the linked boards came too (an older one ignores it)
    const delivered = await reply((answer === 'replace' ? 'replaced' : 'kept-both') + (linked.length ? ';linked=' + linkedSaved : ''));
    this.fileArrivals(filed, from);
    if (linkedData.length) this.refreshBoardDirectory();

    /*
     * Opening it must never hold up the boards queued behind it. Boards arrive
     * one question at a time, and a board that takes for ever to open (or
     * never does) used to leave every later arrival waiting unseen: the other
     * computer said "waiting for an answer" while this one had nothing on
     * screen to answer. It is already saved; the queue moves on regardless.
     */
    /*
     * Boards sent together come one after another: the sender waits for each
     * answer before sending the next. So "nothing else is waiting" is not yet
     * known when the first one is accepted - and opening each in turn yanked
     * the screen away three times, burying the next question under the board
     * just opened. Wait a moment: if another board knocks, this one is filed
     * and only the last of them opens.
     */
    if (open && !replacingWhatIsOpen) {
      const since = performance.now(), until = since + (this._nextBoardWaitMs ?? 2500);
      const another = () => this._incoming.length > 0 || (this._receivingAt || 0) > since;
      while (performance.now() < until && !another()) await new Promise((res) => setTimeout(res, 100));
      if (another()) open = false;
    }
    if (open) {
      await Promise.race([
        this.loadBoard(data, { claimed: true, silent: true }).catch(() => {}),
        new Promise((res) => setTimeout(res, this._openWaitMs ?? 15000))
      ]);
    }
    // The board is safely here either way. Whether the sender ever heard about
    // it is a separate fact, and worth saying: their screen will say declined.
    // Everything just filed can be taken back in one go: new boards removed, replaced ones put back.
    const undo = { label: t('Undo'), onClick: () => this.undoArrivals(filed, before, who) };
    const count = filed.length;
    if (!delivered) {
      this.toast(t('Kept “{board}”, but {name} had already stopped waiting - their screen will say it was declined', { board: data.name, name: who }), 'help', 10000, undo);
    } else if (replacingWhatIsOpen) {
      this.toast(t('“{board}” has been replaced with the copy from {name}', { board: data.name, name: who }), 'board', 10000, undo);
    } else if (count > 1) {
      this.toast(open
        ? t('Opened “{board}” and saved {n} boards from {name}', { board: data.name, n: count, name: who })
        : t('Saved {n} boards from {name} - in My boards', { n: count, name: who }), 'board', 10000, undo);
    } else {
      this.toast(open
        ? t('Opened “{board}” from {name}', { board: data.name, name: who })
        : t('Saved “{board}” - open it from Boards', { board: data.name }), 'board', 10000, undo);
    }
  }

  /**
   * The folder boards from one device are filed in: "From <its name>". One per
   * device, kept by the device's id, so renaming the device renames the folder
   * rather than starting another.
   */
  deviceFolder(from) {
    const s = this.settings;
    const dev = (from && from.deviceId) || 'unknown';
    const name = t('From {name}', { name: (from && from.name) || t('another computer') });
    const map = s.deviceFolders && typeof s.deviceFolders === 'object' ? s.deviceFolders : {};
    let id = map[dev];
    const f = id && folderList(s).find((x) => x.id === id);
    if (!f) { id = createFolder(s, name); s.deviceFolders = { ...map, [dev]: id }; }
    else if (f.name !== name) renameFolder(s, id, name);
    return id;
  }

  /*
   * Where arrivals are filed. A board that replaced one already here stays
   * wherever that one was; a second copy goes beside the first; anything new
   * goes in the sender's own folder, so a class sending in work never mixes
   * into the teacher's boards.
   */
  fileArrivals(filed, from) {
    const s = this.settings;
    let folder = null;
    for (const f of filed) {
      if (!f.doc || f.replaced) continue;
      const beside = f.have ? folderOf(s, f.have.id) : null;
      moveBoard(s, f.doc.id, beside || (folder = folder || this.deviceFolder(from)));
    }
    this.saveSettings();
    this.panels?.boardsChanged?.();
  }

  /** Take back what one arrival filed: new boards removed, replaced boards put back as they were. */
  async undoArrivals(filed, before, who) {
    let n = 0;
    for (const f of filed) {
      if (!f.doc) continue;
      const id = f.doc.id;
      const old = before.get(id);
      try {
        if (f.replaced && old) {
          await window.board.boards.save({ id, json: JSON.stringify(old), setLast: false });
          if (this.store.doc.id === id) await this.loadBoard(old, { claimed: true, silent: true });
        } else if (!f.replaced) {
          if (this.store.doc.id === id) await this.deleteBoard(id);
          else await window.board.boards.remove(id);
          moveBoard(this.settings, id, null);
        }
        n++;
      } catch { /* the rest still go */ }
    }
    this.saveSettings();
    this.refreshBoardDirectory();
    this.panels?.boardsChanged?.();
    this.toast(t('Took back what came from {name}', { name: who }), 'check');
    return n;
  }

  /**
   * Write an arriving board into this machine's own store.
   *
   * The pictures on it came inline, because the sending machine's assets
   * folder did not travel with it. Filing them here is what makes them
   * survive the board being closed and opened again - the same step the
   * editor takes on every save.
   */
  async saveIncomingBoard(data, open) {
    let doc = data;
    try { doc = await this.externaliseAssets(data); } catch { doc = data; }
    try {
      await window.board.boards.save({
        id: doc.id,
        json: JSON.stringify(doc),
        // Only a board somebody chose to open becomes the one that reopens
        // next time. Accepting a doodle in the background must not quietly
        // change what GazBoard shows on Monday morning.
        setLast: !!open
      });
      return true;
    } catch { return false; }
  }

  /**
   * Show what is arriving and wait for an answer.
   *
   * The picture is the point. "Untitled board, 41 items" tells a presenter
   * nothing about whether they want it on the projector behind them; a small
   * thumbnail tells them at a glance, without the room getting a good look
   * first. See ui/thumb.js for why it is that size.
   *
   * @returns {Promise<'open'|'save'|'both'|'replace'|null>} null means decline
   */
  askAboutIncomingBoard(args) {
    const { board, who, mine, waiting, linked = [], keep = new Set() } = args;
    return new Promise((outer) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      /*
       * The question must not be lost under another dialog.
       *
       * Every dialog shares one card. If something else opens while this
       * question is up - an update notice, a prompt from the board just
       * opened - it takes the card, this question's buttons are gone, and the
       * sender waits five minutes for an answer that can never be given while
       * every board behind it queues up unseen. So the question keeps an eye
       * on its card, and once the other dialog is finished, asks again.
       */
      let settled = false;
      const resolve = (v) => { if (settled) return; settled = true; clearInterval(watch); outer(v); };
      const done = (v) => { this._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };
      const watch = setInterval(() => {
        if (settled) { clearInterval(watch); return; }
        const ours = card.contains(heading);
        const up = overlay.classList.contains('show');
        if (ours && up) return;
        if (!up) {
          // our question is no longer on screen and nothing else is: put it back
          clearInterval(watch);
          settled = true;
          this.askAboutIncomingBoard(args).then(outer);
        }
      }, 400);

      const count = Array.isArray(board.objects) ? board.objects.length : 0;
      let kb = 0;
      try { kb = Math.max(1, Math.round(JSON.stringify(board).length / 1024)); } catch { kb = 0; }

      const heading = h('h3', {}, t('{name} is sending you a board', { name: who }));
      card.appendChild(heading);
      card.appendChild(h('div', { style: 'display:flex;gap:14px;align-items:flex-start;margin:0 0 12px' },
        boardThumb(board.objects, 168, 106),
        h('div', { style: 'font-size:13px;line-height:1.7;min-width:0;flex:1' },
          h('div', { style: 'font-weight:600;overflow-wrap:anywhere' }, board.name || t('Untitled board')),
          h('div', { style: 'color:var(--text-2)' },
            count === 1
              ? (kb ? t('{n} item · {kb} KB', { n: count, kb }) : t('{n} item', { n: count }))
              : (kb ? t('{n} items · {kb} KB', { n: count, kb }) : t('{n} items', { n: count }))),
          waiting
            ? h('div', { style: 'color:var(--text-2);margin-top:4px' },
              waiting === 1 ? t('One more is waiting behind this') : t('{n} more are waiting behind this', { n: waiting }))
            : null)));

      /*
       * The boards that come with it, each shown before anything is kept.
       *
       * One Save takes them all - but not unseen: a board tucked in among the
       * links is a picture here like the board itself, and any of them can be
       * unticked. A tap on a picture shows it larger, in place, so the
       * question never has to make way for a second window.
       */
      if (linked.length) {
        const note = h('div', { class: 'linked-note' });
        const head = h('div', { class: 'ln-head' });
        const count = h('span', { class: 'ln-count' });
        const all = h('button', { class: 'ln-all', type: 'button' });
        const grid = h('div', { class: 'ln-grid' });
        const view = h('div', { class: 'ln-view', hidden: true });
        const recount = () => {
          count.textContent = keep.size === linked.length
            ? (linked.length === 1 ? t('It comes with 1 board it links to') : t('It comes with {n} boards it links to', { n: linked.length }))
            : t('{n} of {total} linked boards will be saved', { n: keep.size, total: linked.length });
          all.textContent = keep.size === linked.length ? t('Untick all') : t('Tick all');
        };
        all.addEventListener('click', () => {
          const on = keep.size !== linked.length;
          linked.forEach((_, i) => (on ? keep.add(i) : keep.delete(i)));
          grid.querySelectorAll('input').forEach((x) => { x.checked = on; });
          recount();
        });
        linked.forEach((d, i) => {
          const tick = h('input', { type: 'checkbox', checked: true, 'aria-label': d.name || t('Untitled board') });
          tick.addEventListener('change', () => { tick.checked ? keep.add(i) : keep.delete(i); recount(); });
          const pic = h('button', { class: 'ln-pic', type: 'button', title: t('Look at it larger') }, boardThumb(d.objects, 112, 70));
          pic.addEventListener('click', () => {
            view.replaceChildren(
              h('button', { class: 'ln-back', type: 'button', onclick: () => { view.hidden = true; grid.hidden = false; } }, '‹ ' + t('All linked boards')),
              h('div', { class: 'ln-big' }, boardThumb(d.objects, 340, 200)),
              h('div', { class: 'ln-name' }, (d.name || t('Untitled board')) + ' · ' + t('{n} items', { n: (d.objects || []).length })));
            grid.hidden = true; view.hidden = false;
          });
          grid.appendChild(h('label', { class: 'ln-tile' }, pic, h('span', { class: 'ln-row' }, tick, h('span', { class: 'ln-tname' }, d.name || t('Untitled board')))));
        });
        head.append(count, all);
        note.append(head, grid, view, h('div', { class: 'ln-hint' }, t('Saving keeps the ticked ones - no need to answer for each one.')));
        recount();
        card.appendChild(note);
      }
      card.appendChild(h('p', {}, mine
        ? t('You already have “{name}”, which came from this same board. Keeping both leaves your copy untouched and files this one beside it. Replacing writes this over your copy, and anything you have added to yours since would be gone.', { name: mine.name })
        : t('Nothing is written until you choose.')));

      /*
       * Two questions were tangled together here, and untangling them is the
       * point of this checkbox.
       *
       * WHICH COPY is a decision about this particular board, and it belongs on
       * the buttons. WHETHER TO OPEN IT is a habit - your own two machines, you
       * want the board in front of you; a class handing in thirty doodles, you
       * do not want each one taking over the screen. Putting that on the
       * buttons meant four of them on the collision path, and leaving it off
       * meant "Keep both" filed the board somewhere you then had to go looking
       * for, which is how a board appears to vanish.
       *
       * So it is a checkbox that remembers. Set it once and every later arrival
       * follows it; Settings has the same switch for anyone who wants to find
       * it there.
       */
      const openBox = h('input', { type: 'checkbox' });
      openBox.checked = this.settings.syncOpenOnArrival !== false;
      openBox.style.cssText = 'width:15px;height:15px;margin:0;flex:none';
      openBox.addEventListener('change', () => {
        this.settings.syncOpenOnArrival = openBox.checked;
        this.saveSettings();
      });
      card.appendChild(h('label', {
        style: 'display:flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;'
          + 'padding:9px 11px;border:1px solid var(--stroke);border-radius:6px;margin:0 0 12px'
      }, openBox, h('span', {}, t('Open it straight away'),
        h('span', { style: 'display:block;font-size:11.5px;color:var(--text-2);margin-top:1px' },
          t('Off files it in My boards and leaves you where you are')))));

      const row = h('div', { class: 'actions', style: 'flex-wrap:wrap;gap:8px' });
      row.appendChild(h('button', { class: 'btn', onclick: () => done(null) }, t('Decline')));
      if (mine) {
        row.appendChild(h('button', { class: 'btn primary', onclick: () => done('both') }, t('Keep both')));
        row.appendChild(h('button', { class: 'btn', onclick: () => done('replace') }, t('Replace my copy')));
      } else {
        row.appendChild(h('button', { class: 'btn primary', onclick: () => done('save') }, t('Save it')));
      }
      card.appendChild(row);

      // Escape, or a click outside, declines. A board that lands on somebody's
      // machine because they brushed a key is exactly what this dialog exists
      // to prevent.
      this.showOverlay(() => resolve(null));
    });
  }

  /**
   * A dialog with one thing to type in.
   *
   * @returns {Promise<string|null>} what was typed, or null if it was dismissed
   */
  promptText(title, text, { placeholder = '', confirmLabel = t('OK'), uppercase = false, value = '' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('overlay');
      const card = document.getElementById('overlayCard');
      card.innerHTML = '';
      const done = (v) => { this._overlayDismiss = null; overlay.classList.remove('show'); resolve(v); };

      const input = h('input', {
        type: 'text', placeholder, value,
        style: 'width:100%;padding:9px 11px;font-size:15px;border:1px solid var(--stroke);'
          + 'border-radius:6px;background:var(--bg);color:var(--text);box-sizing:border-box'
          + (uppercase ? ';letter-spacing:3px;text-transform:uppercase;font-weight:600' : '')
      });
      const submit = () => { const v = input.value.trim(); if (v) done(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

      card.appendChild(h('h3', {}, title));
      if (text) card.appendChild(h('p', {}, text));
      card.appendChild(h('div', { style: 'margin:4px 0 6px' }, input));
      card.appendChild(h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => done(null) }, t('Cancel')),
        h('button', { class: 'btn primary', onclick: submit }, confirmLabel)));

      this.showOverlay(() => resolve(null));
      setTimeout(() => input.focus(), 30);
    });
  }

  /**
   * The commands, for when the app is not allowed to run them itself.
   *
   * A university lab machine may refuse elevation outright, and on one of those
   * the useful thing to hand somebody is not an apology - it is the two lines
   * their IT person needs, ready to copy.
   */
  async showFirewallHelp(reason, fw = null) {
    let cmds = [];
    try { cmds = (await window.board.sync.firewall.commands()) || []; } catch { cmds = []; }

    /*
     * Where to type them, in the words of the machine they will be typed on.
     *
     * This dialog said "run them in Windows PowerShell started as
     * Administrator" on every platform, so a Mac user asking how to open their
     * firewall was told to open PowerShell. The commands themselves were right
     * for their machine; only the sentence around them was written by somebody
     * who had one operating system in mind.
     */
    let info = fw;
    if (!info) { try { info = await window.board.sync.firewall.check(); } catch { info = null; } }
    const tool = info && info.tool;
    const onWindows = tool === 'Windows Firewall' || !tool;
    const onMac = tool === 'macOS firewall';
    const where = onWindows ? t('Windows PowerShell started as Administrator')
      : onMac ? t('Terminal - it will ask for your password')
        : t('a terminal - it will ask for your password');

    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    card.innerHTML = '';
    const done = () => { this._overlayDismiss = null; overlay.classList.remove('show'); };

    card.appendChild(h('h3', {}, t('Letting GazBoard through the firewall by hand')));
    card.appendChild(h('p', {}, reason === 'cancelled'
      ? t('Nothing was changed. If you would rather not give GazBoard permission to do this, these are the commands that do the same thing - run them in {where}.', { where })
      : reason === 'manual'
        // Asked for rather than arrived at. Nothing has failed, and saying it
        // has would be its own small lie - this is the person checking the
        // firewall themselves because GazBoard said all was well and it wasn't.
        ? t('GazBoard reads the rules on this computer, which is not the same as another computer proving it can get in - so it can report all is well when it is not. These commands open the way, and do no harm if it is already open. Run them in {where}.', { where })
        : t('GazBoard could not change the firewall on this computer, which usually means the machine is managed and will not allow it. These are the commands that do it - run them in {where}, or pass them to whoever looks after the machine.', { where })));

    const text = cmds.join('\n\n');
    card.appendChild(h('pre', {
      style: 'font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;'
        + 'background:var(--bg-2, rgba(127,127,127,.08));border:1px solid var(--stroke);'
        + 'border-radius:6px;padding:10px;max-height:190px;overflow:auto;margin:0 0 4px'
    }, text || t('There is no firewall on this computer that GazBoard knows how to open.')));

    card.appendChild(h('p', { style: 'font-size:12px;color:var(--text-2)' },
      onWindows
        ? t('They allow this one program to be reached on your own private and work networks, and nowhere else. If your network is marked Public in Windows, change it to Private first, or these will have no effect.')
        : onMac
          ? t('They add GazBoard to the list of apps allowed to accept incoming connections, and unblock it - being on that list is not the same as being allowed.')
          : t('They open the two ports GazBoard listens on, and nothing else.')));

    const row = h('div', { class: 'actions' });
    if (text) {
      row.appendChild(h('button', {
        class: 'btn',
        onclick: async () => {
          try { await navigator.clipboard.writeText(text); this.toast(t('Commands copied')); }
          catch { this.toast(t('Could not reach the clipboard - select the text instead'), 'help'); }
        }
      }, t('Copy')));
    }
    row.appendChild(h('button', { class: 'btn primary', onclick: done }, t('Close')));
    card.appendChild(row);
    this.showOverlay(done);
  }

  /**
   * Put a pairing code on the screen and keep a live one there.
   *
   * A code lasts five minutes, which is right for a classroom and wrong for a
   * dialog somebody leaves open while thirty people find the setting. When one
   * runs out this quietly starts another, so the number on the screen is
   * always the number that works. Closing the dialog ends pairing outright -
   * a code nobody can see must not still let a stranger in.
   */
  async showPairingCode() {
    if (!window.board || !window.board.sync) return;
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    let remember = false;
    let session = null;
    let timer = null;
    // Shown as the way out if this computer never appears in their list. Read
    // once: it cannot change while a dialog is open.
    let addrs = [];
    try { addrs = ((await window.board.sync.state()) || {}).addresses || []; } catch { addrs = []; }

    const stop = () => {
      clearInterval(timer);
      try { Promise.resolve(window.board.sync.cancelPairing()).catch(() => {}); } catch {}
      this._overlayDismiss = null;
      overlay.classList.remove('show');
      this.panels.syncChanged();
    };

    const draw = () => {
      card.innerHTML = '';
      card.appendChild(h('h3', {}, t('Pairing code')));
      card.appendChild(h('p', {},
        t('On the other computer, switch on sharing, find this computer in its list and press Pair. It will ask for this code.')));

      card.appendChild(h('div', {
        style: 'font-size:34px;font-weight:700;letter-spacing:6px;text-align:center;'
          + 'padding:14px 0;font-variant-numeric:tabular-nums'
      }, session ? session.code : '····'));

      const left = session ? Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)) : 0;
      card.appendChild(h('div', {
        id: 'pairCountdown',
        style: 'text-align:center;font-size:12.5px;color:var(--text-2);margin:-6px 0 14px'
      }, t('Good for another {time} - a fresh code appears here when it runs out', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })));

      // The list finds this computer by itself on most networks. On the ones
      // where it does not - a guest wifi that keeps its clients apart, a
      // firewall eating the announcement - there is no clue on screen about
      // what to do instead, and the person is left staring at an empty list.
      if (addrs.length) {
        card.appendChild(h('p', { style: 'font-size:12px;color:var(--text-2);margin:-6px 0 14px' },
          t('If this computer never appears in their list, they can add it by address instead: '),
          h('span', {
            style: 'font-family:ui-monospace,Consolas,monospace;font-weight:600;color:var(--text)'
          }, addrs.map((a) => a.address).join(t(' or ')))));
      }

      const opt = (value, label, hint) => {
        const b = h('button', {
          class: 'btn' + (remember === value ? ' primary' : ''),
          style: 'width:100%;text-align:left;margin-bottom:6px;padding:9px 12px;height:auto'
        }, h('div', {}, h('div', { style: 'font-weight:600' }, label),
          h('div', { style: 'font-size:11.5px;opacity:.8;font-weight:400;margin-top:2px' }, hint)));
        b.addEventListener('click', async () => {
          if (remember === value) return;
          remember = value;
          session = await window.board.sync.beginPairing({ remember });
          draw();
        });
        return b;
      };
      card.appendChild(opt(false, t('Just for now'),
        t('Whoever pairs with this code is forgotten when GazBoard closes. Right for a class or a meeting.')));
      card.appendChild(opt(true, t('Remember these computers'),
        t('They stay paired and can send you a board any time - and you will still be asked before anything is saved. Right for your own machines.')));

      card.appendChild(h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: stop }, t('Done'))));
    };

    try { session = await window.board.sync.beginPairing({ remember }); }
    catch { this.toast(t('Sharing is not running'), 'help'); return; }

    draw();
    this.showOverlay(stop);
    let tick = 0;
    timer = setInterval(() => {
      if (!session) return;
      /*
       * Somebody pairing WITH this machine changes its device list, and that
       * change happens down in the main process without a discovery packet to
       * announce it - so the panel behind this dialog would go on saying "not
       * paired yet" about a computer that just paired. Nudge it while the code
       * is up, which is exactly the window in which that can happen.
       */
      if (++tick % 3 === 0) this.panels.syncChanged();
      if (Date.now() > session.expiresAt - 1000) {
        window.board.sync.beginPairing({ remember }).then((s) => { session = s; draw(); }).catch(() => {});
        return;
      }
      const el = document.getElementById('pairCountdown');
      if (!el) { clearInterval(timer); return; }
      const left = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
      el.textContent = t('Good for another {time} - a fresh code appears here when it runs out', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    }, 1000);
  }

  /**
   * A progress dialog for a send, which can be got rid of.
   *
   * Two phases, and they matter separately. While bytes are moving there is a
   * real number to show. Once they have all gone the wait is on a PERSON at the
   * other machine looking at the "do you want this?" dialog, and pretending
   * that has a percentage would be a lie - so the bar fills, and the words
   * change to say who is being waited for.
   *
   * Dismissible on purpose: closing it hides the dialog and lets the transfer
   * carry on, with the result arriving as a toast. Somebody who has to sit and
   * watch a bar because there is no way out will resent the feature.
   */
  showSendProgress(who, boardName, totalBytes) {
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    card.innerHTML = '';
    card.appendChild(h('h3', {}, t('Sending to {name}', { name: who })));
    const label = h('p', {}, t('“{board}” — {size}', { board: boardName, size: mb(totalBytes) }));
    card.appendChild(label);
    const bar = h('div', { class: 'bar' }, h('i', {}));
    card.appendChild(bar);
    const note = h('p', { style: 'font-size:12px;color:var(--text-2);margin:8px 0 0' },
      t('You can close this — it carries on, and the answer will appear as a message.'));
    card.appendChild(note);
    let closed = false;
    let nudge = null;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(nudge);
      // only put the dialog away if it is still ours - not a question that has since taken the card
      if (card.contains(label)) { this._overlayDismiss = null; overlay.classList.remove('show'); }
    };
    card.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: close }, t('Close'))));
    this.showOverlay(close);
    return {
      update: (sent, total) => {
        if (closed) return;
        // Everything is out but nobody has answered: say where the question is waiting.
        if (sent >= total && !nudge) {
          nudge = setTimeout(() => {
            if (closed) return;
            note.textContent = t('Still waiting. The question is on {name}\'s screen - GazBoard has to be open there to answer it.', { name: who });
            note.style.color = 'var(--text)';
          }, 20000);
        }
        const frac = total ? clamp(sent / total, 0, 1) : 0;
        bar.firstChild.style.width = Math.round(frac * 100) + '%';
        label.textContent = sent >= total
          // Everything is out; from here it is somebody reading a dialog.
          ? t('Sent. Waiting for {name} to answer…', { name: who })
          : t('“{board}” — {sent} of {total}', { board: boardName, sent: mb(sent), total: mb(total) });
      },
      close
    };
  }

  /** Hand the board that is open right now to a paired device. */
  async sendCurrentBoardTo(peer) {
    if (!peer || !peer.deviceId) return false;
    const extra = await this.askAboutLinkedBoards('send');
    if (extra === null) return false;
    /*
     * The boards it links to go INSIDE it, so the other side answers once.
     * A device on an older version saves only the board itself and says
     * nothing about the rest - then they follow one at a time, as before. So
     * does a bundle too big for one transfer.
     */
    if (extra.length) {
      let main = null;
      try { main = exportable(this.store.toJSON({ app: 'GazBoard', version: 1 })); }
      catch { this.toast(t('Could not read this board to send it'), 'help', 6000); return false; }
      const others = [];
      for (const id of extra) {
        try { const d = await window.board.boards.load(id); if (d) others.push(exportable(await this.resolveAssets(d))); } catch { /* unreadable: left out */ }
      }
      // the other side takes no more than this many at once; the rest are left for another send
      if (others.length > App.MAX_LINKED) {
        this.toast(t('Only the first {max} linked boards go along - send the others separately', { max: App.MAX_LINKED }), 'help', 8000);
        others.length = App.MAX_LINKED;
      }
      const bundle = await this.picturesForSending({ ...main, linkedBoards: others });
      let bytes = 0;
      try { bytes = JSON.stringify(bundle).length; } catch { bytes = Infinity; }
      if (others.length && bytes <= 60 * 1024 * 1024) {
        const ok = await this.sendBoardDoc(peer, bundle, { shrunk: true });
        if (ok !== true) return false;
        if (/;linked=\d+/.test(this._lastSendOutcome || '')) return true;
        // an older device took the board alone: the linked boards follow one by one
        for (const d of others) { if ((await this.sendBoardDoc(peer, d)) === false) return false; }
        return true;
      }
    }
    // one at a time: the boards it links to first, so this one arrives last - and is the one that opens
    for (const id of extra) {
      let other = null;
      try { other = await window.board.boards.load(id); if (other) other = exportable(await this.resolveAssets(other)); } catch { other = null; }
      if (!other) continue;
      // one board turned down is that board's business; the rest still go
      const ok = await this.sendBoardDoc(peer, other);
      if (ok === false) return false;
    }
    let doc;
    try { doc = exportable(this.store.toJSON({ app: 'GazBoard', version: 1 })); }
    catch { this.toast(t('Could not read this board to send it'), 'help', 6000); return false; }

    return (await this.sendBoardDoc(peer, doc)) === true;
  }

  /** The one call that puts a board on the wire. */
  syncSend(peer, doc) { return window.board.sync.send(peer, doc); }

  /** Send one board, ready to go, and say how it went. */
  /**
   * The same board, with its pictures - and those of the boards travelling
   * inside it - made the size a board needs before they cross the network.
   *
   * A phone photo is 4000 pixels across and several megabytes; on a board it
   * is seen a few hundred pixels wide. Sending every one of those pixels made
   * a handful of linked boards weigh 30 MB, which a phone has to hold several
   * times over while it unpacks it - and it ran out of memory. Your own copy
   * is never touched: only what is sent is shrunk.
   */
  async picturesForSending(doc) {
    if (!doc || this.settings.syncFullPictures) return doc;
    const done = new Map();          // the same picture on several boards is shrunk once
    const shrink = async (src) => {
      if (done.has(src)) return done.get(src);
      const job = shrinkPicture(src).catch(() => src);
      done.set(src, job);
      return job;
    };
    const fix = async (objects) => {
      if (!Array.isArray(objects)) return objects;
      const out = [];
      for (const o of objects) {
        if (!o || o.type !== 'image' || typeof o.src !== 'string' || !o.src.startsWith('data:image/')) { out.push(o); continue; }
        const src = await shrink(o.src);
        if (src === o.src) { out.push(o); continue; }
        // a different picture now: the asset name belonged to the full-size one
        const { assetId, ...rest } = o;
        out.push({ ...rest, src });
      }
      return out;
    };
    const next = { ...doc, objects: await fix(doc.objects) };
    if (Array.isArray(doc.linkedBoards)) {
      next.linkedBoards = [];
      for (const d of doc.linkedBoards) next.linkedBoards.push(d && Array.isArray(d.objects) ? { ...d, objects: await fix(d.objects) } : d);
    }
    return next;
  }

  async sendBoardDoc(peer, doc, { shrunk = false } = {}) {
    if (!shrunk) doc = await this.picturesForSending(doc);
    // Pictures travel inside the board, because the other machine has no copy
    // of this one's assets folder. A board of imported pages can therefore be
    // large, and the far end refuses anything over 64 MB outright.
    let bytes = 0;
    try { bytes = JSON.stringify(doc).length; } catch { bytes = 0; }
    if (bytes > 60 * 1024 * 1024) {
      this.toast(t('This board is too big to send over the network - save a copy and carry it instead'), 'help', 8000);
      return false;
    }

    /*
     * A dialog rather than a toast, because a toast fades after four seconds
     * and a board of imported pages does not.
     *
     * On the wire a board is roughly 1.8x the size of the pictures on it - the
     * data: URLs are base64 once and the sealed envelope is base64 again - so
     * tens of megabytes over classroom wifi is a genuine wait, and a faded
     * toast makes it look like nothing happened. It can be dismissed: the send
     * carries on in the background and the outcome still arrives as a toast,
     * because trapping somebody behind a progress bar with no way out is worse
     * than not showing one.
     */
    const sending = this.showSendProgress(peer.name, doc.name || t('board'), bytes);
    this._onSendBytes = ({ sent, total }) => sending.update(sent, total);

    /*
     * "Receiving another board; try again shortly" is the other device still
     * finishing the board before this one - it takes one at a time. Sending a
     * board with the boards it links to sends several back to back, and the
     * next one can knock while the last is still being put away. That is a
     * wait, not a failure: try again for a while before saying so. A
     * phone on an older version takes one board at a time until its question
     * is answered, so in a classroom the wait can be a minute.
     */
    let r = null;
    this._lastSendOutcome = '';
    const giveUpAt = Date.now() + (this._busyRetryForMs ?? 90000);
    for (;;) {
      try { r = await this.syncSend(peer, doc); } catch (e) { r = { ok: false, error: e.message }; }
      if (r && r.ok) break;
      if (!/try again shortly|receiving another board/i.test(String(r && r.error))) break;
      if (Date.now() >= giveUpAt) break;
      await new Promise((res) => setTimeout(res, this._busyRetryMs ?? 2000));
    }
    this._onSendBytes = null;
    sending.close();
    if (!r || !r.ok) {
      this.toast(t('Could not send it: {error}', { error: (r && r.error) || t('no answer from that computer') }), 'help', 8000);
      return false;
    }
    if (!r.result || !r.result.accepted) {
      this.toast(t('{name} declined it', { name: peer.name }), 'help');
      return 'declined';
    }
    const outcome = String(r.result.outcome || '');
    this._lastSendOutcome = outcome;
    const came = Number((/;linked=(\d+)/.exec(outcome) || [])[1] || 0);
    this.toast(came
      ? (outcome.startsWith('replaced')
        ? t('{name} accepted it with {n} linked boards, replacing their copy', { name: peer.name, n: came })
        : t('{name} accepted it with {n} linked boards', { name: peer.name, n: came }))
      : outcome.startsWith('replaced')
        ? t('{name} accepted it, replacing their copy', { name: peer.name })
        : t('{name} accepted it', { name: peer.name }));
    return true;
  }
}

/*
 * Start once the page is there. Not simply "on DOMContentLoaded": the language
 * files load before this module runs (see i18n.js), and by the time they have,
 * that event may well have come and gone.
 */
// A flag, not `window.app`: the page has an element with id="app", and the
// browser hands that out as window.app until something replaces it.
let booted = false;
function boot() { if (booted) return; booted = true; window.app = new App(); }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();

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
