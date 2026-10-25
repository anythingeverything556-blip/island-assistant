const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfHost', {
  onJob: (cb) => ipcRenderer.on('pdf:job', (_, job) => cb(job)),
  done: (id, result) => ipcRenderer.send('pdf:done', id, result),
  ready: () => ipcRenderer.send('pdf:ready'),
});
