// Fly the GeoFS plane using Island's own computer-action layer (src/computer.js),
// so this exercises the real code path a model would use.
const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createInput } = require('../src/input');
const { createUia } = require('../src/uia');
const { Computer } = require('../src/computer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(__dirname, '..', '.shots');
const URL_GEO = 'https://www.geo-fs.com/geofs.php';

function screen(name) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $b.Size)
$bmp.Save("${path.join(SHOTS, name)}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  console.log('  shot ->', name);
}
function crop(name, x, y, w, h, scale) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile("${path.join(SHOTS, name)}")
$crop = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, ${w}, ${h})), (New-Object System.Drawing.Rectangle(${x}, ${y}, ${w}, ${h})), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$big = New-Object System.Drawing.Bitmap(${Math.round(w * scale)}, ${Math.round(h * scale)})
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($crop, 0, 0, ${Math.round(w * scale)}, ${Math.round(h * scale)})
$g2.Dispose()
$big.Save("${path.join(SHOTS, name.replace('.png', '-zoom.png'))}", [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $crop.Dispose(); $src.Dispose()
`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  console.log('  zoom ->', name.replace('.png', '-zoom.png'));
}

app.whenReady().then(async () => {
  const island = new BrowserWindow({ show: false, width: 300, height: 120 });
  const input = createInput();
  const uia = createUia();

  // 1. Open the game in a Brave window.
  let wins = await input.windows().catch(() => []);
  let geo = wins.find((w) => w.app === 'brave' && /geofs/i.test(w.title));
  if (!geo) {
    const brave = wins.find((w) => w.app === 'brave');
    await input.focus(brave.id);
    await sleep(900);
    await input.keys('tap', [17, 84]); // ctrl+t
    await sleep(900);
    await input.type(URL_GEO, 12);
    await sleep(400);
    await input.keys('tap', [13]); // enter
    console.log('opening GeoFS...');
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const fg = await input.foreground().catch(() => null);
      if (fg && /geofs/i.test(fg.title)) break;
    }
    await sleep(7000);
  }
  wins = await input.windows().catch(() => []);
  geo = wins.find((w) => w.app === 'brave' && /geofs/i.test(w.title));
  if (!geo) { console.log('GeoFS did not open'); app.exit(1); return; }
  console.log('GeoFS window:', geo.id, JSON.stringify(geo.title), JSON.stringify(geo.rect));
  await input.focus(geo.id);
  await sleep(1200);

  // 2. The computer layer, with the real action set.
  const computer = new Computer({ input, uia, getIsland: () => island, getHotkey: () => 'Ctrl+Alt+Space', getStopHotkey: () => 'Ctrl+Alt+Shift+Esc' });
  await computer.begin();
  await sleep(800);

  const g = computer.geometry();
  // The game canvas: the middle of the window, where the plane is.
  const cx = Math.round((geo.rect[0] + geo.rect[2]) / 2);
  const cy = Math.round((geo.rect[1] + geo.rect[3]) / 2);
  const toShot = (px, py) => [(px - g.origin.x) * g.scale, (py - g.origin.y) * g.scale];

  console.log('\n--- step 1: full throttle (the "9" key) ---');
  await computer.run('key', { text: '9' });
  await sleep(2500);
  screen('fly-a-throttle.png');
  crop('fly-a-throttle.png', 60, 530, 500, 145, 2.2);

  console.log('\n--- step 2: wait for speed, then pull the stick back ---');
  await sleep(4000);
  screen('fly-b-speed.png');
  // Pull the stick: the mouse down from the middle of the canvas.
  const from = toShot(cx, cy);
  const to = toShot(cx, cy + 110);
  await computer.run('mouse_move', { coordinate: from });
  await sleep(400);
  await computer.run('mouse_move', { coordinate: to });
  await sleep(2500);
  screen('fly-c-rotate.png');
  crop('fly-c-rotate.png', 60, 530, 500, 145, 2.2);

  console.log('\n--- step 3: climb ---');
  await sleep(6000);
  screen('fly-d-climb.png');
  crop('fly-d-climb.png', 60, 530, 500, 145, 2.2);
  screen('fly-e-full.png');

  await computer.end();
  input.stop();
  uia.stop();
  app.exit(0);
});
