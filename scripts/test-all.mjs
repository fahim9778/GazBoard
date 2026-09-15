#!/usr/bin/env node
/*
 * Run every suite, then say what happened.
 *
 * These used to be chained with &&, which stops at the first suite that fails.
 * That is right for a build and wrong for a person: one red assertion in the
 * smoke suite hid the LAN, web and tablet suites entirely, so finding out
 * whether anything else broke meant another full run. Each suite is run to
 * completion here and the exit code is decided at the end, so one run answers
 * the whole question.
 *
 * A suite that fails still fails the command - nothing is being forgiven, it
 * is only being reported together.
 */
import { spawnSync } from 'node:child_process';

const SUITES = [
  ['Desktop (Electron)', 'smoke'],
  ['LAN sync', 'test:sync'],
  ['Web and PWA', 'test:web'],
  ['Tablet layout', 'test:tablet'],
  ['Android', 'test:android']
];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];

for (const [label, script] of SUITES) {
  console.log(`\n=== ${label} (npm run ${script}) ===\n`);
  const run = spawnSync(npm, ['run', '--silent', script], { stdio: 'inherit', shell: process.platform === 'win32' });
  results.push({ label, script, code: run.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n========================================');
for (const r of results) console.log(`  ${r.code === 0 ? 'pass' : 'FAIL'}  ${r.label}`);
console.log('========================================');
if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} suites failed: ` +
    failed.map((r) => `npm run ${r.script}`).join(', '));
  console.log('Scroll up for the assertions - each one prints the values it saw.\n');
} else {
  console.log(`\nAll ${results.length} suites passed.\n`);
}
process.exit(failed.length ? 1 : 0);
