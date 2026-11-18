'use strict';
// Play's release checks on 5.1.3: deprecated bar-colour calls and resources that were never shrunk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'android', ...p.split('/')), 'utf8');

test('No Window status/navigation bar colour calls are left in the app code', () => {
  const dir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java');
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(kt|java)$/.test(f.name)) fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (/\b(statusBarColor|navigationBarColor|setStatusBarColor|setNavigationBarColor)\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${path.relative(dir, p)}:${i + 1}: ${line.trim()}`);
    }); } };
  walk(dir);
  assert.deepEqual(hits, [], `deprecated bar-colour calls still in the code:\n${hits.join('\n')}`);
});

test('The theme chrome is still painted: the window background follows the board theme', () => {
  const kt = read('app/src/main/java/com/gazboard/app/MainActivity.kt');
  const fn = kt.slice(kt.indexOf('fun applyChromeTheme'), kt.indexOf('fun shareFile'));
  assert.match(fn, /window\.decorView\.setBackgroundColor\(bar\)/, `applyChromeTheme no longer paints the window background:\n${fn}`);
  assert.match(fn, /isAppearanceLightStatusBars = !dark/, `the bar icons no longer follow the theme:\n${fn}`);
  assert.match(kt, /setDecorFitsSystemWindows\(window, false\)/, 'the page no longer draws edge to edge');
});

test('Both themes make the bars see-through with no contrast veil, and keep their own window colour', () => {
  for (const [file, bg] of [['app/src/main/res/values/styles.xml', '#F5F5F8'], ['app/src/main/res/values-night/themes.xml', '#1B1A19']]) {
    const x = read(file);
    const item = (n) => (x.match(new RegExp(`name="android:${n}"[^>]*>([^<]*)<`)) || [])[1];
    const got = { status: item('statusBarColor'), nav: item('navigationBarColor'), sc: item('enforceStatusBarContrast'), nc: item('enforceNavigationBarContrast'), bg: item('windowBackground') };
    assert.deepEqual(got, { status: '@android:color/transparent', nav: '@android:color/transparent', sc: 'false', nc: 'false', bg },
      `${file}: ${JSON.stringify(got)}`);
  }
});

test('Release builds shrink resources as well as code', () => {
  const g = read('app/build.gradle.kts');
  const rel = g.slice(g.indexOf('release {', g.indexOf('buildTypes')), g.indexOf('}', g.indexOf('release {', g.indexOf('buildTypes'))));
  assert.match(rel, /isMinifyEnabled = true/, `release block:\n${rel}`);
  assert.match(rel, /isShrinkResources = true/, `release block:\n${rel}`);
});
