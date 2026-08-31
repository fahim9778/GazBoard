// Client-side PDF generator for the Web/PWA runtime.
// Converts canvas-rendered page bitmaps into a valid, standard PDF 1.4 document.

const MM_TO_PT = 72 / 25.4;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
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

/**
 * Generate a standard PDF 1.4 binary document containing the rendered page bitmaps.
 * @param {Object} payload { html, widthIn, heightIn }
 */
export async function generatePdfFromHtml(payload) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(payload.html || '', 'text/html');
    const sheetEls = Array.from(doc.querySelectorAll('.sheet, body > div, img'));

    // Extract pages and dimensions
    const pageItems = [];
    const defaultWmm = (payload.widthIn || 8.5) * 25.4;
    const defaultHmm = (payload.heightIn || 11) * 25.4;

    const imgEls = Array.from(doc.querySelectorAll('img'));
    if (!imgEls.length) {
      return { ok: false, error: 'No printable content found' };
    }

    for (let i = 0; i < imgEls.length; i++) {
      const imgEl = imgEls[i];
      const src = imgEl.getAttribute('src');
      if (!src) continue;

      let wMm = defaultWmm;
      let hMm = defaultHmm;

      const style = imgEl.getAttribute('style') || '';
      const wMatch = /width:\s*([\d.]+)mm/.exec(style);
      const hMatch = /height:\s*([\d.]+)mm/.exec(style);
      if (wMatch) wMm = parseFloat(wMatch[1]);
      if (hMatch) hMm = parseFloat(hMatch[1]);

      const loaded = await loadImage(src);
      const { width, height, bytes } = await imageToJpegBytes(loaded);

      pageItems.push({
        wPt: wMm * MM_TO_PT,
        hPt: hMm * MM_TO_PT,
        imgWidth: width,
        imgHeight: height,
        jpegBytes: bytes
      });
    }

    if (!pageItems.length) {
      return { ok: false, error: 'Failed to extract pages from document' };
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
      addString(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.wPt.toFixed(2)} ${p.hPt.toFixed(2)}] /Contents ${contentId} 0 R /Resources << /XObject << /Im1 ${imageId} 0 R >> >> >>\nendobj\n`);

      // Content Stream Object
      const streamContent = `q ${p.wPt.toFixed(2)} 0 0 ${p.hPt.toFixed(2)} 0 0 cm /Im1 Do Q\n`;
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
