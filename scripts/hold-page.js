// A separate app process that shows the test page and writes its state to a file,
// so the driving app sees a real "another application" on the screen.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[process.argv.length - 1];
const PAGE = path.join(__dirname, '..', '.shots', 'hold-test.html');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, title: 'hold test' });
  await win.loadFile(PAGE);
  win.focus();
  setInterval(async () => {
    try {
      const s = await win.webContents.executeJavaScript('window.__state || {}');
      fs.writeFileSync(OUT, JSON.stringify(s));
    } catch {}
  }, 150);
});
