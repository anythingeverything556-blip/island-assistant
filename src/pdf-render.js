// PDF pages -> pictures, using a hidden window (see pdfrender/). The window is made on
// first use and closed again after a minute of not being needed.
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

let win = null;
let ready = null;
let idle = null;
let nextId = 1;
const jobs = new Map();

ipcMain.on('pdf:done', (e, id, result) => {
  if (!win || e.sender !== win.webContents) return;
  jobs.get(id)?.(result);
  jobs.delete(id);
});

function open() {
  if (win && !win.isDestroyed()) return ready;
  win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { preload: path.join(__dirname, 'pdfrender', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  ready = new Promise((resolve, reject) => {
    const onReady = (e) => { if (e.sender === win.webContents) { ipcMain.removeListener('pdf:ready', onReady); resolve(); } };
    ipcMain.on('pdf:ready', onReady);
    win.webContents.once('did-fail-load', (_, code, desc) => reject(new Error(`PDF viewer failed to load: ${desc}`)));
    setTimeout(() => reject(new Error('PDF viewer took too long to start.')), 15000);
  });
  win.on('closed', () => {
    win = null;
    for (const done of jobs.values()) done({ error: 'The PDF viewer closed.' });
    jobs.clear();
  });
  win.loadFile(path.join(__dirname, 'pdfrender', 'index.html'));
  return ready;
}

// renderPages(buffer, [1, 2, 5], { maxEdge }) -> { pages, images: [{ page, width, height, base64 }] }
async function renderPages(buf, pages, { maxEdge = 1400, timeoutMs = 90000 } = {}) {
  clearTimeout(idle);
  await open();
  const id = nextId++;
  const result = await new Promise((resolve) => {
    jobs.set(id, resolve);
    win.webContents.send('pdf:job', { id, data: new Uint8Array(buf), pages, maxEdge });
    setTimeout(() => { if (jobs.has(id)) { jobs.delete(id); resolve({ error: 'Drawing the PDF pages took too long.' }); } }, timeoutMs);
  });
  idle = setTimeout(() => { if (!jobs.size) win?.destroy(); }, 60000);
  if (result?.error) throw new Error(result.error);
  return result;
}

module.exports = { renderPages };
