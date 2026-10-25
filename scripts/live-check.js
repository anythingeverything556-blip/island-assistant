// Check the RUNNING Island: the stop shortcut, the stop button, and that the panel
// can be clicked again after a computer task.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInput, parseCombo } = require('../src/input');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'island-live-'));
const PORT = 9481;
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
  const exe = path.join(ROOT, 'dist', 'win-unpacked', 'Island.exe');
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`], { cwd: path.join(ROOT, 'dist', 'win-unpacked'), env: { ...process.env, ISLAND_PROFILE_DIR: PROFILE }, stdio: 'ignore' });
  try {
    const page = await cdp(PORT, (t) => /renderer\/index\.html/.test(t.url));
    await page.send('Runtime.enable');
    await sleep(4000);

    // 1. The shortcut the app actually registered.
    const s = await page.evaluate("api.getSettings()");
    console.log('registered:', JSON.stringify({ hotkey: s.activeHotkey, stop: s.activeExtras && s.activeExtras.stop, stopSaved: s.stopHotkey }));
    check('the open shortcut is registered', !!s.activeHotkey, String(s.activeHotkey));
    check('the stop shortcut is registered', s.activeExtras?.stop === s.stopHotkey, String(s.activeExtras?.stop));

    // 2. The stop button in the panel exists and is clickable.
    await page.evaluate("api.requestExpand({ view: 'settings' }); 1");
    await sleep(1500);
    const btn = await page.evaluate(`(() => {
      const b = document.getElementById('sendBtn');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { id: b.id, disabled: b.disabled, title: b.title, visible: r.width > 0, topIsButton: top === b || b.contains(top), coveredBy: top ? (top.id || top.className || top.tagName) : 'none' };
    })()`);
    console.log('the send/stop button:', JSON.stringify(btn));
    check('the send button is on screen and not covered', btn.visible && btn.topIsButton, JSON.stringify(btn));

    // 2b. A dedicated Stop button, shown while Island works.
    const stopBtn = await page.evaluate(`(() => {
      S.busy = true; updateSendBtn();
      const b = document.getElementById('stopBtn');
      if (!b) return { missing: true };
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const out = { hidden: b.hidden, visible: r.width > 0, topIsButton: top === b || b.contains(top), coveredBy: top ? (top.id || top.className || top.tagName) : 'none' };
      S.busy = false; updateSendBtn();
      return out;
    })()`);
    console.log('the dedicated stop button:', JSON.stringify(stopBtn));
    check('a Stop button appears while Island works, and can be clicked', !stopBtn.missing && !stopBtn.hidden && stopBtn.topIsButton, JSON.stringify(stopBtn));

    // 3. The Stop row in Settings -> Voice and keys.
    await page.evaluate("api.requestExpand({ view: 'settings' }); 1");
    await sleep(1500);
    await page.evaluate("(async () => { await showSettings('voicekeys'); await new Promise((r) => setTimeout(r, 800)); return 1; })()");
    const keys = await page.evaluate(`(() => {
      const el = document.getElementById('sStopHotkey');
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { value: el.value, visible: r.width > 0, topIsInput: top === el || el.contains(top) };
    })()`);
    console.log('the stop key box:', JSON.stringify(keys));
    check('the Stop shortcut is listed in Settings', !keys.missing && !!keys.value, JSON.stringify(keys));

    // 4. Press the stop key for real: the app must react.
    await page.evaluate("window.__stops = 0; api.onStopped(() => { window.__stops++; }); 1");
    const input = createInput();
    await input.keys('tap', parseCombo('ctrl+alt+shift+escape').tokens);
    await sleep(1200);
    const stops = await page.evaluate("window.__stops");
    check('the stop shortcut reaches the running app', stops > 0, `${stops} stop event(s)`);
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
