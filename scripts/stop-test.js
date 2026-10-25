// Does the new stop shortcut register, and does it really stop Island?
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInput, parseCombo } = require('../src/input');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'island-stop-'));
const PORT = 9461;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };

async function cdp(port, match) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find(match);
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0;
        const waiting = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
        const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const evaluate = async (expression) => {
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluation failed');
          return r.result?.result?.value;
        };
        return { send, evaluate };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no attach');
}

(async () => {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, ISLAND_PROFILE_DIR: PROFILE }, stdio: 'ignore' });
  try {
    const page = await cdp(PORT, (t) => /renderer\/index\.html/.test(t.url));
    await page.send('Runtime.enable');
    await sleep(3500);
    await page.evaluate("window.__stopped = 0; api.onStopped(() => { window.__stopped++; }); 1");

    const s = await page.evaluate("api.getSettings()");
    console.log('settings:', JSON.stringify({ stopHotkey: s.stopHotkey, activeStop: s.activeExtras && s.activeExtras.stop, hotkey: s.activeHotkey }));
    // The app falls back to another combo when the saved one is taken by something else,
    // so the test presses the one that is really registered.
    const active = s.activeExtras?.stop || s.stopHotkey;
    check('the stop shortcut is set', !!active, active);
    check('the stop shortcut was registered (not taken by another app)', s.activeExtras?.stop === s.stopHotkey, String(s.activeExtras?.stop));

    // Press it for real.
    const input = createInput();
    const tokens = parseCombo(String(active).toLowerCase()).tokens;
    console.log('pressing', JSON.stringify(tokens));
    await input.keys('tap', tokens);
    await sleep(1200);
    const stopped = await page.evaluate("window.__stopped");
    check('pressing the stop shortcut reaches Island', stopped > 0, `${stopped} stop event(s)`);

    // And the Escape key stops a busy agent too.
    await page.evaluate("window.__stopped = 0; S.busy = true; 1");
    await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1");
    await sleep(600);
    const stopped2 = await page.evaluate("window.__stopped");
    check('Escape also stops Island while it is working', stopped2 > 0, `${stopped2} stop event(s)`);

    input.stop();
  } catch (e) {
    console.error('failed:', e.message);
    results.push(false);
  } finally {
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    await sleep(800);
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
