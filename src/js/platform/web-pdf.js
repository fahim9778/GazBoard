// Client-side PDF generator for the Web/PWA runtime.
// Converts canvas-rendered page bitmaps into a valid, standard PDF 1.4 document.

const MM_TO_PT = 72 / 25.4;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (typeof src === 'string' && !src.startsWith('data:') && !src.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load page image'));
    img.src = src;
  });
}

function imageToJpegBytes(img) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) {
        resolve({ width: canvas.width, height: canvas.height, bytes: new Uint8Array() });
        return;
      }
      blob.arrayBuffer().then((buf) => {
        resolve({
          width: canvas.width,
          height: canvas.height,
          bytes: new Uint8Array(buf)
        });
      });
    }, 'image/jpeg', 0.94);
  });
}

function parseLengthMm(styleStr, prop, fallbackMm) {
  if (!styleStr) return fallbackMm;
  const re = new RegExp(`${prop}:\\s*([\\d.]+)(mm|in|pt|px)?`, 'i');
  const m = re.exec(styleStr);
  if (!m) return fallbackMm;
  const val = parseFloat(m[1]);
  if (isNaN(val)) return fallbackMm;
  const unit = (m[2] || 'mm').toLowerCase();
  if (unit === 'mm') return val;
  if (unit === 'in') return val * 25.4;
  if (unit === 'pt') return (val / 72) * 25.4;
  if (unit === 'px') return (val / 96) * 25.4;
  return val;
}

/**
 * Generate a standard PDF 1.4 binary document containing the rendered page bitmaps.
 * @param {Object} payload { html, widthIn, heightIn }
 */
export async function generatePdfFromHtml(payload) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(payload.html || '', 'text/html');

    const defaultPageWmm = (payload.widthIn || 8.5) * 25.4;
    const defaultPageHmm = (payload.heightIn || 11) * 25.4;

    // Check for CSS @page size if defined in HTML/style
    let cssPageWmm = defaultPageWmm;
    let cssPageHmm = defaultPageHmm;
    if (typeof payload.html === 'string') {
      const pageMatch = /@page\s*\{\s*size:\s*([\d.]+)(mm|in|pt|px)?\s+([\d.]+)(mm|in|pt|px)?/i.exec(payload.html);
      if (pageMatch) {
        cssPageWmm = parseLengthMm(`w:${pageMatch[1]}${pageMatch[2] || 'mm'}`, 'w', defaultPageWmm);
        cssPageHmm = parseLengthMm(`h:${pageMatch[3]}${pageMatch[4] || 'mm'}`, 'h', defaultPageHmm);
      }
    }

    const sheetEls = doc.querySelectorAll ? Array.from(doc.querySelectorAll('.sheet')) : [];
    const rawItems = [];

    if (sheetEls.length > 0) {
      for (const sheet of sheetEls) {
        const sheetStyle = sheet.getAttribute ? (sheet.getAttribute('style') || '') : '';
        const pageWmm = parseLengthMm(sheetStyle, 'width', cssPageWmm);
        const pageHmm = parseLengthMm(sheetStyle, 'height', cssPageHmm);

        const imgEl = sheet.querySelector ? sheet.querySelector('img') : (sheet.querySelectorAll ? sheet.querySelectorAll('img')[0] : null);
        if (!imgEl) continue;
        const src = imgEl.getAttribute ? imgEl.getAttribute('src') : imgEl.src;
        if (!src) continue;

        const imgStyle = imgEl.getAttribute ? (imgEl.getAttribute('style') || '') : '';
        const imgWmm = parseLengthMm(imgStyle, 'width', pageWmm);
        const imgHmm = parseLengthMm(imgStyle, 'height', pageHmm);

        rawItems.push({ pageWmm, pageHmm, imgWmm, imgHmm, src });
      }
    } else if (doc.querySelectorAll) {
      const imgEls = Array.from(doc.querySelectorAll('img'));
      for (const imgEl of imgEls) {
        const src = imgEl.getAttribute ? imgEl.getAttribute('src') : imgEl.src;
        if (!src) continue;

        const imgStyle = imgEl.getAttribute ? (imgEl.getAttribute('style') || '') : '';
        const pageWmm = parseLengthMm(imgStyle, 'width', cssPageWmm);
        const pageHmm = parseLengthMm(imgStyle, 'height', cssPageHmm);
        const imgWmm = parseLengthMm(imgStyle, 'width', pageWmm);
        const imgHmm = parseLengthMm(imgStyle, 'height', pageHmm);

        rawItems.push({ pageWmm, pageHmm, imgWmm, imgHmm, src });
      }
    }

    if (!rawItems.length) {
      return { ok: false, error: 'No printable content found' };
    }

    const pageItems = [];
    for (const item of rawItems) {
      const loaded = await loadImage(item.src);
      const { width, height, bytes } = await imageToJpegBytes(loaded);

      const pageWPt = item.pageWmm * MM_TO_PT;
      const pageHPt = item.pageHmm * MM_TO_PT;
      const imgWPt = Math.min(item.imgWmm * MM_TO_PT, pageWPt);
      const imgHPt = Math.min(item.imgHmm * MM_TO_PT, pageHPt);

      // Centered on page geometry (HTML top-left flex centering maps to bottom-left PDF coordinates)
      const xPt = Math.max(0, (pageWPt - imgWPt) / 2);
      const yPt = Math.max(0, (pageHPt - imgHPt) / 2);

      pageItems.push({
        pageWPt,
        pageHPt,
        imgWPt,
        imgHPt,
        xPt,
        yPt,
        imgWidth: width,
        imgHeight: height,
        jpegBytes: bytes
      });
    }

    // Build standard PDF 1.4 binary structure
    const chunks = [];
    const offsets = [0]; // Object 0 is free

    function addString(str) {
      chunks.push(new TextEncoder().encode(str));
    }

    function addBytes(uint8) {
      chunks.push(uint8);
    }

    function currentOffset() {
      let len = 0;
      for (const c of chunks) len += c.byteLength;
      return len;
    }

    // Header
    addString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    const totalPages = pageItems.length;
    // Objects:
    // 1: Catalog
    // 2: Pages
    // For each page i (0 to totalPages-1):
    //   pageObj = 3 + i * 3
    //   contentObj = 3 + i * 3 + 1
    //   imageObj = 3 + i * 3 + 2

    const pageObjIds = [];
    for (let i = 0; i < totalPages; i++) {
      pageObjIds.push(3 + i * 3);
    }

    // 1 0 obj - Catalog
    offsets.push(currentOffset());
    addString('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    // 2 0 obj - Pages parent
    offsets.push(currentOffset());
    const kidsStr = pageObjIds.map((id) => `${id} 0 R`).join(' ');
    addString(`2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${totalPages} >>\nendobj\n`);

    // Add each page and its resources
    for (let i = 0; i < totalPages; i++) {
      const p = pageItems[i];
      const pageId = 3 + i * 3;
      const contentId = pageId + 1;
      const imageId = pageId + 2;

      // Page Object
      offsets.push(currentOffset());
      addString(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.pageWPt.toFixed(2)} ${p.pageHPt.toFixed(2)}] /Contents ${contentId} 0 R /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im1 ${imageId} 0 R >> >> >>\nendobj\n`);

      // Content Stream Object
      const streamContent = `q ${p.imgWPt.toFixed(2)} 0 0 ${p.imgHPt.toFixed(2)} ${p.xPt.toFixed(2)} ${p.yPt.toFixed(2)} cm /Im1 Do Q\n`;
      const streamLen = new TextEncoder().encode(streamContent).byteLength;
      offsets.push(currentOffset());
      addString(`${contentId} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}endstream\nendobj\n`);

      // Image XObject
      offsets.push(currentOffset());
      const imgHeader = `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.imgWidth} /Height ${p.imgHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`;
      addString(imgHeader);
      addBytes(p.jpegBytes);
      addString('\nendstream\nendobj\n');
    }

    // Cross-reference table
    const startXref = currentOffset();
    const totalObjs = 1 + totalPages * 3 + 2; // obj 0 + catalog + pages + 3*N
    addString(`xref\n0 ${totalObjs}\n`);
    addString('0000000000 65535 f \n');
    for (let i = 1; i < offsets.length; i++) {
      const offStr = String(offsets[i]).padStart(10, '0');
      addString(`${offStr} 00000 n \n`);
    }

    // Trailer
    addString(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);

    // Concatenate all chunks into a single ArrayBuffer
    let totalLen = 0;
    for (const c of chunks) totalLen += c.byteLength;
    const finalBuf = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      finalBuf.set(c, offset);
      offset += c.byteLength;
    }

    return { ok: true, data: finalBuf.buffer };
  } catch (e) {
    console.warn('[pdf] generatePdfFromHtml error:', e);
    return { ok: false, error: e.message || 'PDF generation failed' };
  }
}
