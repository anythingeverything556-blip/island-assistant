// Test the real action layer (src/computer.js): the test page runs in another app
// process, so this is exactly what Island sees when it drives a browser.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createInput } = require('../src/input');
const { createUia } = require('../src/uia');
const { Computer } = require('../src/computer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };
const STATE_FILE = path.join(__dirname, '..', '.shots', 'hold-state.json');

app.whenReady().then(async () => {
  // The page process writes its state to this file; start from a clean one.
  try { fs.unlinkSync(STATE_FILE); } catch {}
  const island = new BrowserWindow({ show: false, width: 300, height: 120 });
  const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const page = spawn(electron, [path.join(__dirname, 'hold-page.js'), STATE_FILE], { stdio: 'ignore' });

  // Wait for the page app to be up and reporting.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    try { fs.readFileSync(STATE_FILE, 'utf8'); ready = true; } catch {}
  }
  if (!ready) { console.log('the test page app did not start'); app.exit(1); return; }
  await sleep(1200);

  const input = createInput();
  const uia = createUia();
  const computer = new Computer({ input, uia, getIsland: () => island, getHotkey: () => 'Control+Alt+Space', getStopHotkey: () => 'Control+Alt+Shift+Escape' });
  const state = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
  const reset = async () => { await sleep(400); };

  await computer.begin();
  await sleep(600);

  // Where the button is, in screenshot coordinates.
  const g = computer.geometry();
  const rect = await (async () => {
    const w = await input.windows();
    const target = w.find((x) => /hold test/i.test(x.title));
    if (!target) return null;
    return target.rect;
  })();
  if (!rect) { console.log('the test page window was not found'); app.exit(1); return; }
  const physX = Math.round((rect[0] + rect[2]) / 2);
  const physY = Math.round((rect[1] + rect[3]) / 2);
  const shot = [(physX - g.origin.x) * g.scale, (physY - g.origin.y) * g.scale];
  console.log(`button at screen ${physX},${physY} -> screenshot ${shot.map(Math.round)}`);

  // The page must be the window in front, or the clicks and keys go elsewhere.
  // (Do this after begin(), which shows the overlay.)
  const wins = await input.windows().catch(() => []);
  const pageWin = wins.find((w) => /hold test/i.test(w.title));
  console.log('the page window:', pageWin ? `${pageWin.id} "${pageWin.title}"` : 'not found');
  if (pageWin) {
    await input.focus(pageWin.id);
    await sleep(1200);
  }
  const fg = await input.foreground().catch(() => null);
  console.log('foreground before the press:', fg ? `${fg.app} "${fg.title}"` : 'none');

  // 1. left_mouse_down with a coordinate moves the pointer there and presses.
  await computer.run('left_mouse_down', { coordinate: shot });

  // The bar Island shows while it drives the computer must name the stop key.
  const ov = BrowserWindow.getAllWindows().find((w) => /overlay/.test(w.webContents.getURL()));
  const hud = ov ? await ov.webContents.executeJavaScript("document.getElementById('hk') ? document.getElementById('hk').textContent : ''") : '';
  const hudStop = ov ? await ov.webContents.executeJavaScript("!!document.getElementById('hudStop')") : false;
  console.log('the overlay bar says:', JSON.stringify(hud));
  check('the overlay bar names the stop key', /Ctrl\+Alt\+Shift\+Esc/.test(String(hud)), String(hud));
  check('the overlay bar has a Stop button', hudStop === true, String(hudStop));
  await sleep(700);
  const p = await input.pos();
  check('left_mouse_down moves the pointer to the coordinate', Math.hypot(p.x - physX, p.y - physY) < 40, `pointer at ${Math.round(p.x)},${Math.round(p.y)}`);
  check('the button is held down', computer.heldButton === 'left', String(computer.heldButton));
  const held1 = state();
  check('the page sees the button held', held1.down === true, JSON.stringify(held1));

  // 2. Ending the task must let go of it, and must give the panel its clicks back.
  let ignoreCalls = [];
  const realIgnore = island.setIgnoreMouseEvents.bind(island);
  island.setIgnoreMouseEvents = (v, o) => { ignoreCalls.push(v); return realIgnore(v, o); };
  await computer.end();
  await sleep(600);
  check('ending the task releases the button', state().up === true, JSON.stringify(state()));
  check('the button is no longer marked as held', computer.heldButton === null, String(computer.heldButton));
  check('the island panel gets its clicks back after the task', ignoreCalls[ignoreCalls.length - 1] === false, JSON.stringify(ignoreCalls));

  // 3. hold_click: press and keep it down for a while.
  await computer.begin();
  await sleep(500);
  const before3 = state().up ? 1 : 0;
  await computer.run('hold_click', { coordinate: shot, duration: 3 });
  await sleep(400);
  check('hold_click holds the button for the whole time', state().ms > 2900, state().ms + 'ms');

  // 4. hold_key for 2 seconds.
  await computer.run('hold_key', { text: '9', duration: 2 });
  await sleep(400);
  check('hold_key holds the key for the whole time', state().ms > 1900, state().ms + 'ms');

  // 5. key with repeat 12.
  await sleep(400); // let the state file catch up with the hold_key above
  const keysBefore = state().keys || 0;
  await computer.run('key', { text: '9', repeat: 12 });
  await sleep(400);
  check('key with repeat 12 gives 12 presses', (state().keys || 0) - keysBefore === 12, `${(state().keys || 0) - keysBefore} presses`);

  // 6. An interrupted repeat stops at once.
  const keysBefore2 = state().keys || 0;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 400);
  try { await computer.run('key', { text: '9', repeat: 100 }, ctl.signal); } catch (e) { /* expected */ }
  await sleep(400);
  check('an interrupted repeat stops early', (state().keys || 0) - keysBefore2 < 100, `${(state().keys || 0) - keysBefore2} presses before the stop`);

  // 7. The plus sign reaches the page as a plus sign.
  await computer.run('key', { text: '+' });
  await sleep(400);
  check('"+" reaches the page as a plus sign', state().last === '+', JSON.stringify(state().last));

  await computer.end();
  input.stop();
  uia.stop();
  try { page.kill(); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  app.exit(results.every(Boolean) ? 0 : 1);
});
