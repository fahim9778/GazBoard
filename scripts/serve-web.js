#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = path.join(__dirname, '..');
const SERVE_DIR = fs.existsSync(path.join(ROOT, 'dist-web'))
  ? path.join(ROOT, 'dist-web')
  : path.join(ROOT, 'src');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.pfb': 'application/x-font-type1',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.gazboard': 'application/json',
  '.openboard': 'application/json'
};

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsed.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    let filePath = path.normalize(path.join(SERVE_DIR, pathname));
    if (!filePath.startsWith(SERVE_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch {
      // SPA Fallback for client-side navigation
      if (req.headers.accept && req.headers.accept.includes('text/html')) {
        filePath = path.join(SERVE_DIR, 'index.html');
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const data = await fsp.readFile(filePath);

    const headers = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Service-Worker-Allowed': '/'
    };

    // No-cache for version.json and sw.js
    if (pathname.endsWith('version.json') || pathname.endsWith('sw.js')) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }

    res.writeHead(200, headers);
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`500 Internal Server Error: ${err.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  GazBoard PWA Server running at: http://localhost:${PORT}`);
  console.log(`  Serving files from: ${SERVE_DIR}`);
  console.log(`======================================================\n`);
});

if (process.send) {
  process.send('ready');
}
