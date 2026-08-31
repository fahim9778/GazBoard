// Browser file access, dialogs, and download bridges for the Web/PWA runtime.

const _sessionFiles = new Map();
let _tokenSeq = 0;

/** Register a File/Blob into the session file store and return its virtual path. */
export function registerSessionFile(file) {
  const token = `virt://session-${++_tokenSeq}/${encodeURIComponent(file.name || 'file')}`;
  _sessionFiles.set(token, file);
  return token;
}

/** Open a file picker dialog in the browser and return virtual file paths. */
export function openFileDialog(opts = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';

    if (opts.properties && opts.properties.includes('multiSelections')) {
      input.multiple = true;
    }

    // Build accept attribute from filters
    if (Array.isArray(opts.filters) && opts.filters.length) {
      const exts = [];
      for (const f of opts.filters) {
        if (Array.isArray(f.extensions)) {
          for (const ext of f.extensions) {
            exts.push(ext.startsWith('.') ? ext : `.${ext}`);
          }
        }
      }
      if (exts.length) input.accept = exts.join(',');
    }

    let resolved = false;
    const finish = (files) => {
      if (resolved) return;
      resolved = true;
      try { document.body.removeChild(input); } catch {}
      const paths = [];
      if (files && files.length) {
        for (let i = 0; i < files.length; i++) {
          paths.push(registerSessionFile(files[i]));
        }
      }
      resolve(paths);
    };

    input.addEventListener('change', () => {
      finish(input.files);
    });

    input.addEventListener('cancel', () => {
      finish([]);
    });

    // Fallback for browsers that do not fire cancel
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!resolved && (!input.files || input.files.length === 0)) {
          finish([]);
        }
      }, 1500);
    }, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Return default filename for save dialog in browser.
 * The actual file save happens in writeFile via browser download.
 */
export function saveFileDialog(opts = {}) {
  const name = opts.defaultPath || 'untitled';
  return Promise.resolve(name);
}

/** Read a virtual file path, Blob, or URL as an ArrayBuffer. */
export async function readVirtualFile(filePath) {
  if (!filePath) throw new Error('File path not provided');

  if (_sessionFiles.has(filePath)) {
    const file = _sessionFiles.get(filePath);
    if (file instanceof Blob || file instanceof File) {
      return await file.arrayBuffer();
    }
  }

  // Handle data: or blob: URLs
  if (typeof filePath === 'string' && (filePath.startsWith('data:') || filePath.startsWith('blob:'))) {
    const res = await fetch(filePath);
    return await res.arrayBuffer();
  }

  throw new Error(`File not found: ${filePath}`);
}

/** Trigger a browser file download for the exported data. */
export function writeVirtualFile(filePath, data) {
  return new Promise((resolve) => {
    try {
      const fileName = String(filePath || 'download').split(/[\\/]/).pop() || 'download';
      let blob;
      if (data instanceof Blob) {
        blob = data;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        blob = new Blob([data]);
      } else if (typeof data === 'string') {
        blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
      } else {
        blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try { document.body.removeChild(a); } catch {}
        URL.revokeObjectURL(url);
        resolve(true);
      }, 250);
    } catch (e) {
      console.warn('[files] writeVirtualFile error:', e);
      resolve(false);
    }
  });
}
