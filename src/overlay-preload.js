const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onEvent: (cb) => ipcRenderer.on('ov', (_, msg) => cb(msg)),
  // teaching: the learner's answer on the coach card, and mouse/keyboard handling for it
  teach: (r) => ipcRenderer.send('ov:teach', r),
  setIgnore: (ignore) => ipcRenderer.send('ov:ignore', !!ignore),
  wantFocus: () => ipcRenderer.send('ov:focus'),
  // the Stop button on the bar Island shows while it drives the computer
  stop: () => ipcRenderer.send('ov:stop'),
});
