# GazBoard for Android

The Android app bundles the same Canvas 2D editor, document model, tools, fonts,
and importers as the desktop. Kotlin supplies Android storage, file pickers,
lifecycle integration, PDF output, and a desktop-compatible local network service.
It does not load the GazBoard website, require an account, or send boards to a server.

This branch is under development. The parity table below records the remaining
release work; it is not a claim that every desktop capability has shipped on Android.

## Build

Use JDK 17 and Android SDK 36. Open this `android` directory in Android Studio,
or run from it:

```sh
./gradlew :sync:test :app:assembleDebug :app:lintDebug
```

On Windows use `gradlew.bat`. The wrapper is Gradle 8.13, with the official
distribution SHA-256 pinned in `gradle-wrapper.properties`. The first build needs
network access to download build dependencies. The installed app works offline.

The installable development APK is `app/build/outputs/apk/debug/app-debug.apk`.
Install on a connected device with `adb install -r` followed by that path.

`assembleRelease` builds an optimized **unsigned** APK. Production signing belongs
to the repository owner's release credentials. No signing keys are committed, and
the workflow does not publish a release or upload anything to Google Play.

The `Android` Actions workflow builds both variants, runs the desktop and web
regression suites, runs protocol interoperability tests, and then runs emulator
tests. Its artifacts contain the APKs, lint reports, test reports, and an editor
screenshot when the device test succeeds.

## Sharing with the desktop

1. Connect both devices to the same local network and open GazBoard on each.
2. Open Sharing and turn local network sharing on. Android shows a persistent
   notification while the service is active.
3. Show a pairing code on either device and enter it on the other. Choose whether
   to remember the pairing or keep it for the session.
4. Send the open board. The receiver explicitly accepts, replaces, keeps another
   copy, or declines through the shared editor's existing dialog.

Discovery uses UDP 53319 and board transfer uses TCP 53318, matching desktop
protocol v1. If the normal TCP port is occupied, discovery advertises the actual
port. Android's address field also accepts `192.168.1.20:53320` for that case.

Manual address entry helps when discovery broadcasts are filtered. It cannot
overcome a router that blocks all traffic between its clients. There is no cloud
relay and no automatic firewall modification.

Stopping sharing closes the sockets and forgets session pairs. Remembered pairs
are encrypted with a key held by Android Keystore. Swiping the app away ends the
sharing session; there is no automatic service restart or boot receiver.

## Implementation map

| Area | Source |
| --- | --- |
| Shared editor and history | `../src/js/core`, `../src/js/app.js` |
| Renderer contract | `../src/js/platform/android-adapter.js` |
| Origin-restricted message handling | `app/.../NativeBridge.kt` |
| Android window, insets, Back, file intents | `app/.../MainActivity.kt` |
| Atomic board files and content-addressed images | `app/.../BoardStorage.kt` |
| File permissions and chunked temporary files | `app/.../BridgeFiles.kt` |
| Remembered device keys | `app/.../DeviceIdentity.kt` |
| Foreground sharing and arrival notifications | `app/.../SharingService.kt` |
| Desktop wire protocol and bounded TCP/UDP service | `sync/src/main/kotlin/com/gazboard/sync` |
| Isolated document layout and PDF drawing | `app/.../DocumentConverter.kt`, `../src/js/platform/android-convert.js` |

`app/...` in this table means `app/src/main/java/com/gazboard/app`.
The Android Gradle asset task copies `../src`; changes to a pen, selection tool,
renderer cache, page layout, or board schema therefore reach all platforms.

Only the bundled top-level HTTPS origin can call the bridge. File reads accept
handles issued after Android grants access, rather than arbitrary paths. The
document conversion WebView has a restricted bridge, blocks external resources,
and strips active document markup. Large messages use bounded chunks and
temporary file handles; they are not passed as one enormous JavaScript message.

## Parity and release gates

| Desktop capability | Android implementation | Verification / remaining work |
| --- | --- | --- |
| Pen, pressure, highlighter, partial/object erasing | Shared tools and renderer | Emulator pen/undo test; physical pressure and palm tests required |
| Selection, transforms, attachments, locking, layer order | Shared store and tools | Hardware interaction review required |
| Notes, text, shapes, tables, templates, ruler, laser | Shared editor | Phone/tablet UI review required |
| Infinite canvas and multiple pages | Shared camera and page model | Portrait, landscape, keyboard and split-screen review required |
| Undo/redo, autosave, board gallery, resume | Native atomic files under shared API | Emulator save/recreate test and storage tests |
| PNG, SVG, PDF and `.gazboard` export | Shared exporters plus Android file picker | File-provider and export verification |
| Image and PDF insertion, page selection | Shared import pipeline | Device document picker and rendering verification |
| DOCX and PPTX insertion | Shared readers plus Android PDF conversion | Document fixture and visual fidelity review |
| TXT insertion | Native conversion pipeline with plain text layout | Multipage conversion test |
| DOC, PPT, RTF, ODT, ODP, XLS, XLSX, ODS via LibreOffice | Not implemented in this branch | Requires a mobile document engine; PDF import is the current fallback |
| LAN pairing and encrypted board transfers | Native implementation of protocol v1 | Six JVM tests against actual desktop Node code pass |
| Multiple peers, remembered/session pairs, manual address | Native service plus shared sharing panel | JVM interop passes; physical multi-device classroom test required |
| Transfers while another app is foreground | Connected-device foreground service and notification | Notification, screen-off and vendor battery tests required |
| Desktop portable folder profile | Android app-private storage and explicit file export | Android storage is not a Windows portable profile |
| Windows/macOS/Linux firewall repair | Platform-specific desktop operation | Android uses network permissions and sharing controls |
| Desktop updater | Android-aware release check | Production signing and Android release process still required |

Required physical acceptance includes a phone and a stylus tablet, desktop-to-phone
and phone-to-desktop transfers, switching Wi-Fi networks, wrong codes, declined
transfers, forgotten devices, screen-off behavior, low storage, large image boards,
rotation during editing, and reopening after Android kills the process. JVM socket
tests establish protocol compatibility, not Wi-Fi driver or battery behavior.

## Tests

```sh
# From the repository root
node --test test/android-adapter.test.js
node test/sync.test.js
node test/tablet-layout.test.js
node scripts/build-web.js
node test/web-pwa.test.js

# From android, with Node available for the desktop peer process
./gradlew :sync:test

# With an Android emulator or physical device connected
./gradlew :app:connectedDebugAndroidTest
```

`InteropTest` starts the repository's actual `sync/node.js` in a child Node process.
It checks X25519/HKDF/HMAC/AES-GCM agreement, Unicode authenticated metadata, pairing
in both directions, image board round trips, declines, wrong-code throttling,
session termination, forged messages, body-size rejection, and address ranking.
The desktop transport itself is unchanged.

The Android adapter tests verify chunk boundaries, Unicode preservation, typed-array
offsets, cancellation, errors, and that flush acknowledgements follow persistence.
The emulator tests exercise the real bundled editor and native bridge, reopen saved
ink, check storage boundaries, and inspect converted PDF pages for visible content.
