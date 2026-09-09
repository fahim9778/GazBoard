import { createAndroidAdapter } from './android-adapter.js';
import { pptxToSlides } from '../importers/pptx.js';

const board = createAndroidAdapter();
const query = new URLSearchParams(location.search);

// DOCX hyperlinks and embedded HTML are document content. Keep formatting,
// while dropping active elements and any resource outside the imported file.
function sanitize(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const node of parsed.querySelectorAll('script, iframe, object, embed, form, input, button, link, meta, base, style')) node.remove();
  for (const node of parsed.body.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || ['href', 'srcset', 'action', 'formaction'].includes(attr.name)
        || (attr.name === 'src' && !/^data:image\//i.test(attr.value))) node.removeAttribute(attr.name);
    }
  }
  return parsed.body.innerHTML;
}

try {
  const buffer = await board.readFile(query.get('file'));
  const root = document.getElementById('root');
  const kind = query.get('kind');
  let widthMm = 210, heightMm = 297;
  if (kind === 'docx') {
    const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer }, {
      convertImage: window.mammoth.images.imgElement((img) => img.read('base64')
        .then((data) => ({ src: `data:${img.contentType};base64,${data}` })))
    });
    root.innerHTML = `<div class="doc">${sanitize(result.value)}</div>`;
  } else if (kind === 'pptx') {
    const { widthPx, heightPx, slides } = await pptxToSlides(buffer);
    root.innerHTML = sanitize(slides.join(''));
    for (const slide of root.querySelectorAll('.slide')) {
      slide.style.width = widthPx + 'px';
      slide.style.height = (heightPx - 1) + 'px';
    }
    widthMm = widthPx / 96 * 25.4;
    heightMm = heightPx / 96 * 25.4;
  } else if (kind === 'txt') {
    const doc = document.createElement('div');
    doc.className = 'doc';
    const text = document.createElement('pre');
    text.textContent = new TextDecoder().decode(buffer);
    doc.appendChild(text);
    root.appendChild(doc);
  } else throw new Error('Unsupported document type');
  const style = document.createElement('style');
  style.textContent = `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;
  document.head.appendChild(style);
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.complete ? null
    : new Promise((resolve) => { img.onload = img.onerror = resolve; })));
  const widthPx = widthMm / 25.4 * 96, heightPx = heightMm / 25.4 * 96;
  root.style.cssText = `width:${widthPx}px;height:${heightPx}px;overflow:hidden;position:relative`;
  let pages;
  if (kind === 'pptx') {
    const slides = [...root.querySelectorAll('.slide')];
    pages = slides.length;
    window.gazboardConvertPage = (index) => {
      slides.forEach((slide, i) => { slide.style.display = i === index ? 'block' : 'none'; });
      window.scrollTo(0, 0);
    };
  } else {
    // Fixed-height CSS columns paginate using the browser's own text layout.
    // One column per page, with the original 20 mm Word margins on each side.
    const doc = root.querySelector('.doc');
    const margin = 20 / 25.4 * 96;
    doc.style.cssText = `padding:0;margin:${margin}px;width:${widthPx - 2 * margin}px;`
      + `height:${heightPx - 2 * margin}px;column-width:${widthPx - 2 * margin}px;`
      + `column-gap:${2 * margin}px;column-fill:auto;overflow:visible`;
    /*
     * Round, do not ceil.
     *
     * With column-fill:auto and a fixed height the layout always produces a
     * WHOLE number of columns, so this division is an integer in exact
     * arithmetic. But scrollWidth comes back as a whole number of pixels, and
     * that rounding pushes the result a hair either side of the integer -
     * measured at 3.0000992 for three columns and 7.000347 for seven. Ceiling
     * turned each of those into one page too many, and the extra page had
     * nothing on it: "Converted page 3 is blank".
     *
     * Rounding to nearest recovers the integer the layout actually produced,
     * from either side.
     */
    pages = Math.max(1, Math.round((doc.scrollWidth + 2 * margin) / widthPx));
    window.gazboardConvertPage = (index) => {
      doc.style.transform = `translateX(${-index * widthPx}px)`;
      window.scrollTo(0, 0);
    };
  }
  window.gazboardConvertPage(0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await board.convertReady({ widthMm, heightMm, pages });
} catch (e) { await board.convertError({ message: e.message || 'Could not read document' }); }
