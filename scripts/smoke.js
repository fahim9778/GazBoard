#!/usr/bin/env node
/*
 * Run the smoke suite on whatever machine you happen to be on.
 *
 * The suite needs a display. Linux build machines have none, so it is wrapped
 * in xvfb-run there - but xvfb-run is a Linux program, so hard-coding it into
 * the npm script made `npm test` fail on Windows and macOS, where there is a
 * display already and nothing to wrap. Contributors then had to know which of
 * several near-identical scripts was the one for their OS, which is not
 * something anyone should have to know.
 *
 * Each branch below is the exact command that platform is known to pass with.
 * Extra arguments are passed straight through:  npm test -- --headless
 */
'use strict';
const { spawnSync } = require('node:child_process');
const electron = require('electron');            // the binary, not the module
// --builtin stands in for GAZBOARD_DISABLE_LIBREOFFICE=1, because `VAR=1 cmd`
// is shell syntax that Windows does not have.
const argv = process.argv.slice(2);
const env = { ...process.env };
if (argv.includes('--builtin')) env.GAZBOARD_DISABLE_LIBREOFFICE = '1';
const extra = argv.filter((a) => a !== '--builtin');

const onLinux = process.platform === 'linux';
const headless = onLinux && !process.env.DISPLAY;   // a build machine, or a bare shell

// macOS runners have a window server of their own, and need no --no-sandbox
const args = ['.', '--smoke', ...(process.platform === 'darwin' ? [] : ['--no-sandbox']), ...extra];

const run = headless
  ? spawnSync('xvfb-run', ['-a', electron, ...args], { stdio: 'inherit', env })
  : spawnSync(electron, args, { stdio: 'inherit', env });

if (run.error && run.error.code === 'ENOENT' && headless) {
  console.error('\nxvfb-run is not installed. On Debian or Ubuntu:  sudo apt install xvfb');
  process.exit(1);
}
process.exit(run.status === null ? 1 : run.status);
