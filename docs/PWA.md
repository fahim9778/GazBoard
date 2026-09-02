# GazBoard Dual-Runtime: Electron & Web/PWA Distribution

GazBoard supports a **dual-runtime architecture**:
1. **Desktop Electron Application**: The native desktop app with direct OS file system access, LibreOffice integration, and desktop installers.
2. **Browser / Progressive Web App (PWA)**: A production-grade web application that loads once online and runs completely offline with persistent local storage, background updates, client-side PDF/PNG/SVG/board export, and responsive support for desktop, Android phones, and tablets.

---

## 1. Dual-Runtime Architecture

```text
                           GazBoard Source
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       Electron Desktop Runtime          Browser/PWA Runtime
                 │                               │
        Electron Main Process           Service Worker (sw.js)
                 │                               │
       Preload (contextBridge)         Web Platform Adapter
                 │                               │
                 └───────────────┬───────────────┘
                                 ▼
                     Shared Application Logic
                     (Store, Surface, Inking,
                      Panels, Importers, UI)
```

The application's core logic communicates with the platform via the unified `window.board` API contract:
* In Electron, `preload.js` exposes `window.board` via `contextBridge.exposeInMainWorld()`.
* In Web/PWA, `src/js/platform/platform.js` automatically initializes `src/js/platform/web-adapter.js` using standard browser APIs (IndexedDB, Service Worker, File API, Web Crypto, client-side PDF generator).

---

## 2. Feature Parity & Capability Matrix

| Feature | Electron Desktop | Web (Online) | Web (Offline) | Implementation / Notes |
| :--- | :---: | :---: | :---: | :--- |
| **Whiteboard Canvas & Inking** | ✅ Full | ✅ Full | ✅ Full | Shared `Surface` and `Store` rendering |
| **Stylus Pressure Sensitivity** | ✅ Full | ✅ Full | ✅ Full | Pointer Events API (`e.pressure`) |
| **Board Document Persistence** | ✅ Full (Filesystem) | ✅ Full (IndexedDB) | ✅ Full (IndexedDB) | Autosaved to local storage |
| **Content-Addressed Assets** | ✅ Full (`assets/`) | ✅ Full (IndexedDB) | ✅ Full (IndexedDB) | SHA-256 content deduplication |
| **Export PNG / SVG** | ✅ Full | ✅ Full | ✅ Full | Direct client-side file download |
| **Export PDF** | ✅ Full (printToPDF) | ✅ Full (Client PDF 1.4) | ✅ Full (Client PDF 1.4) | Standalone client-side PDF generator |
| **Import PDF** | ✅ Full | ✅ Full | ✅ Full | PDF.js client-side rendering |
| **Import Images (PNG/JPG/SVG/WebP)** | ✅ Full | ✅ Full | ✅ Full | Drag & drop or file dialog |
| **Office Import (Word / PPTX)** | ✅ Full (LibreOffice / Built-in) | ⚠️ PDF recommended | ⚠️ PDF recommended | Word/PPTX directly rendered via PDF |
| **PWA Installability** | N/A | ✅ Full | ✅ Full | Web App Manifest (`standalone` mode) |
| **Automatic Updates** | ✅ Releases API | ✅ Background SW | N/A (Online only) | Atomic Service Worker update flow |

---

## 3. Development Commands

### Running Electron
```bash
# Start Electron in development
npm start

# Run Electron with devtools open
npm run dev

# Run Electron smoke tests headlessly
npm run smoke:builtin
```

### Running Web / PWA
```bash
# Start local PWA development server (http://localhost:8080)
npm run serve:web

# Build production static web distribution into dist-web/
npm run build:web

# Run Web/PWA automated tests
npm run test:web
```

---

## 4. Production Deployment

The web build in `dist-web/` consists entirely of static HTML, CSS, JavaScript, vendor libraries, and icons. It has **zero server-side runtime dependencies** and can be deployed to any static host with HTTPS:

### Cloudflare Pages / Vercel / Netlify / GitHub Pages
1. Build the production distribution:
   ```bash
   npm run build:web
   ```
2. Deploy the `dist-web/` directory as the static publish root.
3. Ensure HTTPS is enabled (required by browsers for Service Worker registration).

---

## 5. Offline Caching Strategy

The production Service Worker (`src/sw.js`) provides reliable offline operation:
1. **Pre-caching**:
   * Critical application shell files (`index.html`, `css/app.css`, all `js/` modules, vendor scripts, and icons) are precached during the `install` phase.
2. **Navigation Requests**:
   * Intercepts `mode: 'navigate'` requests. When online, revalidates `index.html`; when offline, immediately serves the cached `index.html` shell.
3. **Runtime Caching**:
   * Static assets (fonts, CMap files) requested at runtime are cached in `gazboard-runtime-v*` for subsequent offline visits.
4. **Update Manifest**:
   * Requests to `/version.json` bypass cache with `no-store` headers so updates are detected reliably whenever connectivity is available.

---

## 6. Storage & Data Persistence

* **IndexedDB Store (`gazboard_db`)**:
  * `boards`: Stores board JSON, modification timestamps, object counts, and thumbnails.
  * `assets`: Stores content-addressed pictures and slide bitmaps (`sha256(content).ext`).
  * `meta`: Stores `last-board` pointer and persistent storage status.
* **Durability**:
  * Calls `navigator.storage.persist()` on launch to prevent browser eviction.
  * Atomic database transactions ensure power cuts or browser crashes cannot produce corrupted board files.
  * Application updates never delete user databases.

---

## 7. Responsive Mobile & Tablet Support

* **Dynamic Viewport**: Uses `100dvh` and safe-area insets (`env(safe-area-inset-top)`, etc.) to handle browser navigation bars and display notches.
* **Touch Targets**: Minimum 44px touch targets on mobile devices (`pointer: coarse`).
* **Multi-Touch Inking**: Supports stylus pressure, pinch-to-zoom, and two-finger panning.
* **Virtual Keyboard**: Viewport handles input focus cleanly without breaking canvas layout.
