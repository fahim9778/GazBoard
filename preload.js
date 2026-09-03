'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('board', {
  info: () => ipcRenderer.invoke('app:info'),

  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  // On the desktop the path names the file already; the web build has to work
  // one out from the File itself. See claimLocalBoard().
  fileOrigin: (p) => p,
  writeFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', { filePath, data }),
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openReleases: (url) => ipcRenderer.invoke('shell:openExternal', url),
  checkForUpdate: () => ipcRenderer.invoke('updates:check'),

  boards: {
    list: () => ipcRenderer.invoke('boards:list'),
    load: (id) => ipcRenderer.invoke('boards:load', id),
    save: (b) => ipcRenderer.invoke('boards:save', b),
    remove: (id) => ipcRenderer.invoke('boards:delete', id),
    last: () => ipcRenderer.invoke('boards:last'),
    setLast: (id) => ipcRenderer.invoke('boards:setLast', id),
    resume: () => ipcRenderer.invoke('boards:resume'),
    migrate: () => ipcRenderer.invoke('boards:migrate')
  },

  // Pictures and imported pages: stored once, by content, outside the board file.
  assets: {
    put: (dataUrl) => ipcRenderer.invoke('assets:put', dataUrl),
    get: (id) => ipcRenderer.invoke('assets:get', id),
    have: (ids) => ipcRenderer.invoke('assets:have', ids)
  },

  importToPdf: (filePath) => ipcRenderer.invoke('import:toPdf', filePath),
  exportPdf: (payload) => ipcRenderer.invoke('export:pdf', payload),

  onMenu: (cb) => ipcRenderer.on('menu:command', (_e, id) => cb(id)),
  onOpenFile: (cb) => ipcRenderer.on('board:open', (_e, data) => cb(data)),
  onWindowResized: (cb) => ipcRenderer.on('window:resized', () => cb()),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => { await cb(); ipcRenderer.send('app:flushed'); }),

  // used only by the hidden conversion window
  convertReady: (msg) => ipcRenderer.send('convert:ready', msg),
  convertError: (msg) => ipcRenderer.send('convert:error', msg)
});
