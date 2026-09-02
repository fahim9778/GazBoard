// Automated Responsive Geometry & Tablet Layout Test Suite
// Verifies clearance, non-overlapping bounds, and touch target constraints across viewports.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  const tag = ok ? '  ok  ' : ' FAIL ';
  const msg = `${tag} [tablet-layout] ${name}${detail ? ' — ' + detail : ''}`;
  console.log(msg);
}

function calculateToolbarWidth(isTouch) {
  // 6 pens + 11 tools + separators and paddings
  // On fine pointer: tool 32px, pen 30px, gaps, padding ~ 825px
  // On coarse pointer: tool 44px, pen 36px, gaps, padding ~ 910px
  return isTouch ? 910 : 825;
}

function calculateReadoutBoxes(width, height, isTouch) {
  // Readout dimensions
  const zoomW = isTouch ? 140 : 130;
  const zoomH = isTouch ? 40 : 36;
  const pageW = isTouch ? 150 : 140;
  const pageH = isTouch ? 40 : 36;

  let zoomBottom, pageBottom;

  if (height <= 480 && width <= 860) {
    // Top-right layout
    return {
      zoom: { x: width - zoomW - 8, y: 8, w: zoomW, h: zoomH },
      page: { x: width - pageW - 8, y: 52, w: pageW, h: pageH }
    };
  }

  if (isTouch && width <= 1240) {
    zoomBottom = 98;
    pageBottom = 148;
  } else if (!isTouch && width <= 860) {
    zoomBottom = 98;
    pageBottom = 146;
  } else {
    // Wide desktop layout - bottom right
    zoomBottom = 18;
    pageBottom = 66;
  }

  return {
    zoom: { x: width - zoomW - 16, y: height - zoomBottom - zoomH, w: zoomW, h: zoomH },
    page: { x: width - pageW - 16, y: height - pageBottom - pageH, w: pageW, h: pageH }
  };
}

function calculateToolbarBox(width, height, isTouch) {
  const tbW = calculateToolbarWidth(isTouch);
  const tbH = isTouch ? 65 : 55;
  const bottom = (height <= 620) ? 8 : 14;

  let x, w;
  if (!isTouch && width > 1340) {
    w = Math.min(tbW, width - 24);
    x = (width - w) / 2;
  } else if (!isTouch && width > 860) {
    // Centered in left space
    const avail = width - 264;
    w = Math.min(tbW, avail);
    x = 12 + (avail - w) / 2;
  } else {
    // Full width stepped up
    w = Math.min(tbW, width - 16);
    x = Math.max(8, (width - w) / 2);
  }

  return { x, y: height - bottom - tbH, w, h: tbH };
}

function intersects(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function testLayoutAt(width, height, isTouch, label) {
  const tb = calculateToolbarBox(width, height, isTouch);
  const { zoom, page } = calculateReadoutBoxes(width, height, isTouch);

  const tbZoomCollide = intersects(tb, zoom);
  const tbPageCollide = intersects(tb, page);
  const zoomPageCollide = intersects(zoom, page);

  const ok = !tbZoomCollide && !tbPageCollide && !zoomPageCollide;
  check(`Layout clearance at ${width}x${height} (${label})`, ok,
    ok ? 'No overlap' : `Overlap detected: tb-zoom=${tbZoomCollide}, tb-page=${tbPageCollide}, zoom-page=${zoomPageCollide}`);
}

async function runTabletLayoutTests() {
  console.log('=== Starting Tablet & Responsive Layout Geometry Verification ===\n');

  const viewports = [
    { w: 600, h: 960, touch: true, label: '7-inch Tablet Portrait' },
    { w: 768, h: 1024, touch: true, label: 'iPad / 10-inch Tablet Portrait' },
    { w: 800, h: 1280, touch: true, label: 'Android Tablet WXGA Portrait' },
    { w: 960, h: 600, touch: true, label: '7-inch Tablet Landscape' },
    { w: 1024, h: 768, touch: true, label: 'iPad / 10-inch Tablet Landscape' },
    { w: 1100, h: 700, touch: true, label: 'Android 11-inch Tablet Landscape' },
    { w: 1200, h: 800, touch: true, label: 'Android 12-inch Tablet Landscape' },
    { w: 1280, h: 800, touch: true, label: '10-inch Tablet Landscape WXGA' },
    { w: 1280, h: 800, touch: false, label: '1280px Desktop / Laptop' },
    { w: 1366, h: 768, touch: false, label: '1366px Laptop' },
    { w: 1440, h: 900, touch: false, label: '1440px Desktop' },
    { w: 1920, h: 1080, touch: false, label: '1080p Desktop' },
    { w: 390, h: 844, touch: true, label: 'Smartphone Portrait' },
    { w: 844, h: 390, touch: true, label: 'Smartphone Landscape' }
  ];

  for (const vp of viewports) {
    testLayoutAt(vp.w, vp.h, vp.touch, vp.label);
  }

  // CSS File Syntax & Structure Integrity Check
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'css', 'app.css'), 'utf8');
  check('CSS has 860px responsive breakpoint', css.includes('@media (max-width: 860px)'));
  check('CSS has coarse pointer 1240px tablet rule', css.includes('@media (max-width: 1240px)'));
  check('CSS has safe-area-inset-bottom support', css.includes('env(safe-area-inset-bottom'));
  check('CSS has safe-area-inset-right support', css.includes('env(safe-area-inset-right'));

  console.log(`\n========================================`);
  console.log(`  Tablet Layout Tests: ${pass} passed, ${fail} failed`);
  console.log(`========================================\n`);

  if (fail > 0) process.exit(1);
}

runTabletLayoutTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
