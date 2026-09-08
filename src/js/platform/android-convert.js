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
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await board.convertReady({ widthMm, heightMm });
} catch (e) { await board.convertError({ message: e.message || 'Could not read document' }); }
