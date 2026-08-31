#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist-web');

async function copyRecursive(src, dest) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src);
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

async function build() {
  console.log('=== Building GazBoard Web/PWA Production Distribution ===');
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version || '2.4.0';

  // 1. Clean output directory
  console.log(`Cleaning output directory: ${OUT}`);
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  // 2. Copy source assets
  console.log('Copying static assets, scripts, vendors and stylesheets...');
  await copyRecursive(SRC, OUT);

  // 3. Generate version.json
  const buildInfo = {
    name: 'GazBoard',
    version: version,
    buildTime: new Date().toISOString(),
    buildId: `${version}-pwa-${Date.now().toString(36)}`,
    environment: 'production'
  };

  await fsp.writeFile(path.join(OUT, 'version.json'), JSON.stringify(buildInfo, null, 2));

  // 4. Verify precache assets in sw.js exist
  const swContent = await fsp.readFile(path.join(OUT, 'sw.js'), 'utf8');
  const match = /const PRECACHE_ASSETS = (\[[\s\S]*?\]);/.exec(swContent);
  if (match) {
    const assets = eval(match[1]);
    let missing = 0;
    for (const rel of assets) {
      if (rel === './' || rel === '.') continue;
      const clean = rel.replace(/^\.\//, '');
      const full = path.join(OUT, clean);
      if (!fs.existsSync(full)) {
        console.warn(`[warning] Precached asset missing from build: ${rel}`);
        missing++;
      }
    }
    if (missing === 0) {
      console.log(`Verified ${assets.length} precached assets in Service Worker.`);
    }
  }

  // 5. Compute stats
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        fileCount++;
        totalBytes += (await fsp.stat(p)).size;
      }
    }
  }
  await walk(OUT);

  console.log(`\nBuild Complete!`);
  console.log(`- Target: ${OUT}`);
  console.log(`- Files: ${fileCount}`);
  console.log(`- Total Size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`- PWA Version: ${version}`);
  console.log(`\nTo test locally, run: npm run serve:web`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
