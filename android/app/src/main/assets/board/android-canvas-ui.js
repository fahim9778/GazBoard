// Android WebView acknowledgement for asynchronous canvas-size changes.
//
// The shared editor remains the source of truth and rerenders the whole Canvas
// panel when setPageSize() finishes. Android can spend a visible beat in that
// async work, so acknowledge the tapped size immediately in the WebView.
(() => {
  window.__gazboardAndroidCanvasUi = true;

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('#panelBody .bg-sizes .btn')
      : null;
    const row = button?.parentElement;
    if (!button || !row) return;

    const buttons = [...row.querySelectorAll(':scope > .btn')];
    const labels = buttons.map((candidate) => candidate.textContent.trim());
    if (!labels.includes('Infinite') || !labels.includes('A4')) return;

    for (const candidate of buttons) {
      const selected = candidate === button;
      candidate.classList.toggle('primary', selected);
      candidate.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }, true);
})();
