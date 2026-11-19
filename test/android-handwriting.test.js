'use strict';
// "Convert to text" on Android and Windows: the plumbing between the page and each recognizer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, ...p.split('/')), 'utf8');

test('Android: the page reaches ML Kit through ink:recognize and ink:download, and the app depends on it', () => {
  const adapter = read('src/js/platform/android-adapter.js');
  const bridge = read('android/app/src/main/java/com/gazboard/app/NativeBridge.kt');
  const gradle = read('android/app/build.gradle.kts');
  const reader = read('android/app/src/main/java/com/gazboard/app/HandwritingReader.kt');
  const got = {
    adapterRecognize: /recognizeInk: \(request\) => guarded\('ink:recognize', request\)/.test(adapter),
    adapterDownload: /downloadInkModel: \(request\) => guarded\('ink:download', request\)/.test(adapter),
    bridgeRecognize: /"ink:recognize" -> app\.handwriting\.recognize\(obj\(\)\)/.test(bridge),
    bridgeDownload: /"ink:download" -> app\.handwriting\.download\(obj\(\)\.str\("lang"\)\)/.test(bridge),
    dependency: /com\.google\.mlkit:digital-ink-recognition:/.test(gradle),
    asksBeforeDownloading: /"needs-model"/.test(reader) && /isModelDownloaded/.test(reader)
  };
  assert.deepEqual(got, { adapterRecognize: true, adapterDownload: true, bridgeRecognize: true, bridgeDownload: true, dependency: true, asksBeforeDownloading: true },
    JSON.stringify(got));
});

test('Windows: the recognizer script is well formed and asks for the right recognizer', () => {
  const main = read('main.js');
  const start = main.indexOf('const INK_SCRIPT = ');
  const end = main.indexOf('module.exports.INK_SCRIPT');
  assert.ok(start > 0 && end > start, `INK_SCRIPT not found in main.js (start ${start}, end ${end})`);
  const script = vm.runInNewContext(main.slice(start, end).replace('const INK_SCRIPT = ', '(') .replace(/;\s*$/, ')'));
  const got = {
    asTask: script.includes("ParameterType.Name -eq 'IAsyncOperation`1'"),
    picksByName: script.includes('SetDefaultRecognizer($pick)'),
    saysWhenMissing: script.includes("code = 'no-recognizer'"),
    perLine: script.includes('foreach ($line in @($req.lines))'),
    firstGuessOnly: script.includes('foreach ($cand in $r.GetTextCandidates()) { $words.Add([string]$cand); break }') && !script.includes('$c[0]'),
    noStrayBacktickEnd: !script.includes('String.raw')
  };
  assert.deepEqual(got, { asTask: true, picksByName: true, saysWhenMissing: true, perLine: true, firstGuessOnly: true, noStrayBacktickEnd: true },
    JSON.stringify(got) + '\n--- script ---\n' + script.slice(0, 600));
  const preload = read('preload.js');
  assert.match(preload, /recognizeInk: \(request\) => ipcRenderer\.invoke\('ink:recognize', request\)/, 'preload does not expose recognizeInk');
  assert.match(main, /ipcMain\.handle\('ink:recognize'/, 'main.js has no ink:recognize handler');
});
