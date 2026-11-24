'use strict';
// Record a lesson on Android: the microphone, asked for properly and given to nothing else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, ...p.split('/')), 'utf8');

test('the app may use the microphone, and still installs on a tablet without one', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const got = {
    recordAudio: /<uses-permission android:name="android\.permission\.RECORD_AUDIO"\s*\/>/.test(manifest),
    micOptional: /<uses-feature android:name="android\.hardware\.microphone" android:required="false"\s*\/>/.test(manifest),
    noCamera: !/android\.permission\.CAMERA/.test(manifest)
  };
  assert.deepEqual(got, { recordAudio: true, micOptional: true, noCamera: true }, JSON.stringify(got));
});

test('the page gets the microphone only: only for GazBoard itself, and only after Android has asked the person', () => {
  const act = read('android/app/src/main/java/com/gazboard/app/MainActivity.kt');
  const start = act.indexOf('override fun onPermissionRequest(');
  const body = start > 0 ? act.slice(start, act.indexOf('override fun onPermissionRequestCanceled', start)) : '';
  const got = {
    found: start > 0,
    onlyMic: /request\.resources\.all \{ it == PermissionRequest\.RESOURCE_AUDIO_CAPTURE \}/.test(body),
    ownPageOnly: /request\.origin\.toString\(\)\.trimEnd\('\/'\) != ORIGIN/.test(body),
    deniesTheRest: /request\.deny\(\); return/.test(body),
    grantsOnlyMic: !/RESOURCE_VIDEO_CAPTURE/.test(act) && /grant\(arrayOf\(PermissionRequest\.RESOURCE_AUDIO_CAPTURE\)\)/.test(body),
    asksAndroid: /micLauncher\.launch\(Manifest\.permission\.RECORD_AUDIO\)/.test(body)
      && /registerForActivityResult\(ActivityResultContracts\.RequestPermission\(\)\)/.test(act),
    noAnswerIsNo: /if \(granted\) request\.grant\(arrayOf\(PermissionRequest\.RESOURCE_AUDIO_CAPTURE\)\) else request\.deny\(\)/.test(act)
  };
  assert.deepEqual(got, { found: true, onlyMic: true, ownPageOnly: true, deniesTheRest: true, grantsOnlyMic: true, asksAndroid: true, noAnswerIsNo: true },
    JSON.stringify(got));
});

test('the recorder is offered on Android, sized for a phone (half-hour parts), and pauses itself when the app is left', () => {
  const lesson = read('src/js/lesson.js');
  const avail = lesson.slice(lesson.indexOf('export function lessonAvailable'), lesson.indexOf('export function lessonBitrate'));
  const got = {
    notHiddenOnAndroid: !/platform === 'android'\) return false/.test(avail),
    stillNeedsEncoder: /typeof VideoEncoder === 'function'/.test(avail) && /getUserMedia/.test(avail),
    phoneSizes: /onAndroid\(\) \? \[1920, 1280\]/.test(lesson),
    halfHour: /PHONE_PART_MS = 30 \* 60 \* 1000/.test(lesson) && /onAndroid\(\) \? PHONE_PART_MS : LESSON_PART_MS/.test(lesson)
      && /at >= \(this\.limitMs \|\| lessonMaxMs\(\)\)/.test(lesson),
    fitsTheBridge: /PHONE_FILE_MAX = 1000 \* 1024 \* 1024/.test(lesson),
    pausesWhenHidden: /visibilitychange/.test(lesson) && /document\.hidden && onAndroid\(\) && this\.state === 'recording'\) this\.pause\(\)/.test(lesson),
    listenerRemoved: /removeEventListener\('visibilitychange', this\.onHide\)/.test(lesson)
  };
  assert.deepEqual(got, { notHiddenOnAndroid: true, stillNeedsEncoder: true, phoneSizes: true, halfHour: true, fitsTheBridge: true, pausesWhenHidden: true, listenerRemoved: true },
    JSON.stringify(got));
});

test('a big video goes out through the bridge as a file being saved: up to 1 GB, streamed, never read back in', () => {
  const adapter = read('src/js/platform/android-adapter.js');
  const files = read('android/app/src/main/java/com/gazboard/app/BridgeFiles.kt');
  const bridge = read('android/app/src/main/java/com/gazboard/app/NativeBridge.kt');
  const got = {
    savesAsSaving: /const token = await upload\(bytes, true\);\s*try \{ return await call\('fs:writeFile'/.test(adapter),
    askedOnlyThere: (adapter.match(/upload\([^)]*, true\)/g) || []).length === 1,
    oneGig: /MAX_SAVE_BYTES = 1024L \* 1024 \* 1024/.test(files),
    boardsStill128: /MAX_BYTES = 128 \* 1024 \* 1024/.test(files),
    streamedOut: /file\(token\)\.inputStream\(\)\.use \{ it\.copyTo\(out\) \}/.test(files),
    neverReadAsRequest: /parse\(app\.files\.readable\(argsFile\)\.readText\(\)\)/.test(bridge) && /takeIf \{ it\.complete && !it\.forSaving \}/.test(files),
    beginPassesFlag: /f\.begin\(obj\(\)\.long\("size", -1\), obj\(\)\.bool\("saving"\)\)/.test(bridge),
    checksSpace: /usableSpace > size/.test(files)
  };
  assert.deepEqual(got, { savesAsSaving: true, askedOnlyThere: true, oneGig: true, boardsStill128: true, streamedOut: true, neverReadAsRequest: true, beginPassesFlag: true, checksSpace: true },
    JSON.stringify(got));
});
