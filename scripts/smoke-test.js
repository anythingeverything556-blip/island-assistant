// Smoke test: starts Island with a throwaway profile, opens every main screen, and fails
// on page errors, broken screens or idle memory over budget. No extra dependencies: it
// drives the app over Chromium's DevTools protocol, like the design tools do.
// Usage: npm run test:smoke   (uses the API key from your environment if there is one)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'island-smoke-'));
const RENDERER_PORT = 9351;
const MAIN_PORT = 9352;
const IDLE_BUDGET_MB = 380; // Island's own processes plus its helpers, after start-up (about 350 MB today; the goal is under 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};

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
        const errors = [];
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
          if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
          if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(d.params.entry.text);
        };
        const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const evaluate = async (expression) => {
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluation failed');
          return r.result?.result?.value;
        };
        return { ws, send, evaluate, errors };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`nothing to attach to on port ${port}`);
}

function islandMemoryMB(rootPid) {
  // Island's processes and the PowerShell helpers it started.
  const out = execSync(`powershell -NoProfile -Command "$all = Get-CimInstance Win32_Process; $ids = @(${rootPid}); do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Select-Object -Unique) } while ($ids.Count -ne $n); ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum"`).toString();
  return Math.round(Number(out.trim()) / 1048576);
}

(async () => {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electron, ['.', `--remote-debugging-port=${RENDERER_PORT}`, `--inspect=${MAIN_PORT}`], { cwd: ROOT, env: { ...process.env, ISLAND_PROFILE_DIR: PROFILE }, stdio: 'ignore' });
  let code = 1;
  try {
    const page = await cdp(RENDERER_PORT, (t) => /renderer\/index\.html/.test(t.url));
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    const main = await cdp(MAIN_PORT, () => true);
    const inMain = (js) => main.evaluate(`(async () => { const E = process.mainModule.require('electron'); const ipc = (c, p) => E.ipcMain.emit(c, {}, p); const W = E.BrowserWindow.getAllWindows().find((w) => /renderer\\/index/.test(w.webContents.getURL())); return (${js}); })()`);
    await sleep(2500);

    check('app starts and the pill renders', await page.evaluate("!!document.querySelector('.island.collapsed')"));
    await sleep(9000); // let start-up settle, then measure what Island costs while just sitting there
    // A brand-new profile starts each connector once to learn its tools; wait until they sleep.
    for (let i = 0; i < 40; i++) {
      const awake = await page.evaluate("api.mcpStatus().then((list) => list.filter((s) => s.state === 'connected' || s.state === 'connecting').length)");
      if (!awake) break;
      await sleep(2000);
    }
    const idleMb = islandMemoryMB(app.pid);
    check(`idle memory within ${IDLE_BUDGET_MB} MB`, idleMb <= IDLE_BUDGET_MB, `${idleMb} MB including helpers`);

    await inMain("(ipc('island:request-expand', {}), 1)");
    await sleep(900);
    check('panel expands', await page.evaluate("document.querySelector('.island').classList.contains('expanded')"));

    for (const tab of ['general', 'ai', 'privacy', 'connectors', 'voicekeys']) {
      const n = await page.evaluate(`(async () => { await showSettings('${tab}'); await new Promise((r) => setTimeout(r, 400)); return document.querySelector('#setMain').innerText.length; })()`);
      check(`settings "${tab}" renders`, n > 80, `${n} chars`);
    }
    check('privacy shows "What leaves your PC"', await page.evaluate("document.querySelector('#setMain') && (showSettings('privacy'), new Promise((r) => setTimeout(() => r(/What leaves your PC/.test(document.querySelector('#setMain').innerText)), 500)))"));

    const chats = await page.evaluate("(async () => { await showChats(); await new Promise((r) => setTimeout(r, 400)); return !document.getElementById('chatsView').hidden; })()");
    check('chats list opens', chats);
    const picker = await page.evaluate("(async () => { showChat(); openPicker(); await new Promise((r) => setTimeout(r, 500)); const ok = !document.getElementById('picker').hidden; closePicker(); return ok; })()");
    check('model picker opens', picker);

    await inMain("(ipc('island:full-toggle'), 1)");
    await sleep(800);
    check('full screen turns on', await page.evaluate("document.querySelector('.island').classList.contains('full')"));
    await inMain("(ipc('island:full-toggle'), 1)");
    await sleep(800);
    check('full screen turns off', await page.evaluate("!document.querySelector('.island').classList.contains('full')"));

    check('screen-reader status region exists', await page.evaluate("document.getElementById('srStatus')?.getAttribute('role') === 'status'"));
    check('conversation is a log for screen readers', await page.evaluate("document.getElementById('thread').getAttribute('role') === 'log'"));

    await inMain("(ipc('island:request-collapse'), 1)");
    await sleep(1200);
    check('panel folds back to the pill', await page.evaluate("document.querySelector('.island').classList.contains('collapsed')"));

    // After use, connectors and helpers run until they time out: reported, not judged.
    console.log(`INFO  memory right after use: ${islandMemoryMB(app.pid)} MB (connectors and helpers stop after a few idle minutes)`);

    const errs = page.errors.filter((e) => !/Autofill|DevTools|favicon/i.test(e || ''));
    check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 300));
    code = results.every((r) => r.ok) ? 0 : 1;
  } catch (e) {
    console.log('FAIL  test run:', e.message);
  } finally {
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    await sleep(1000);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(code);
  }
})();
