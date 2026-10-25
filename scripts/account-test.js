// Temporary verification: the four reported problems, checked against a real running app.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'island-verify-'));
const PORT = 9421;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function typeReal(page, text) {
  for (const ch of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: 'Key' + ch.toUpperCase() });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase() });
    await sleep(15);
  }
}
const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`); };

(async () => {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = {
    ...process.env,
    ISLAND_PROFILE_DIR: PROFILE,
    ANTHROPIC_API_KEY: 'sk-or-v1-ENVIRONMENTKEY0000000000000000000000000000000000000000',
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/',
  };
  const app = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    const page = await cdp(PORT, (t) => /renderer\/index\.html/.test(t.url));
    await page.send('Runtime.enable');
    await sleep(2500);
    await page.evaluate("api.setApiKey('sk-or-v1-SAVEDKEY0000000000000000000000000000000000000000').catch(() => 0)");
    await sleep(1000);
    await page.evaluate("(async () => { await showSettings('ai'); await new Promise((r) => setTimeout(r, 700)); return 1; })()");

    // --- 1. typing into the API key and Base URL fields ---
    await page.evaluate("document.getElementById('sKey').focus(); 1");
    await sleep(200);
    await typeReal(page, 'sk-or-v1-HANDTYPED');
    const keyVal = await page.evaluate("document.getElementById('sKey').value");
    check('can type into the API key field', keyVal === 'sk-or-v1-HANDTYPED', JSON.stringify(keyVal));

    await page.evaluate("document.getElementById('sBase').value=''; document.getElementById('sBase').focus(); 1");
    await sleep(200);
    await typeReal(page, 'https://example.test/v1');
    const baseVal = await page.evaluate("document.getElementById('sBase').value");
    check('can type into the Base URL field', baseVal === 'https://example.test/v1', JSON.stringify(baseVal));

    // the memory box had the same fault
    await page.evaluate("(async () => { await showSettings('memory'); await new Promise((r) => setTimeout(r, 600)); return 1; })()");
    await page.evaluate("document.getElementById('sMemInput').focus(); 1");
    await sleep(200);
    await typeReal(page, 'hello memory');
    const memVal = await page.evaluate("document.getElementById('sMemInput').value");
    check('can type into the memory box', memVal === 'hello memory', JSON.stringify(memVal));

    // --- 2. the environment decides the address ---
    await page.evaluate("(async () => { await showSettings('ai'); await new Promise((r) => setTimeout(r, 700)); return 1; })()");
    const s2 = await page.evaluate("api.getSettings()");
    check('uses the address from ANTHROPIC_BASE_URL', s2.apiBaseURLInUse === 'https://openrouter.ai/api', s2.apiBaseURLInUse);
    check('the address is not doubled up (/api//v1)', !/\/api\/\//.test(s2.apiBaseURLInUse), s2.apiBaseURLInUse);
    check('the environment is reported to the account page', !!s2.envBaseURL && s2.envBaseURL === 'https://openrouter.ai/api', s2.envBaseURL);
    check('the environment key is offered', s2.envKeySet === true && s2.envKeyDiffers === true, `hint ${s2.envKeyHint}`);

    // --- 3 & 4. the model list: real ids, real names, logos ---
    const models = await page.evaluate("api.listModels().then((l) => (l || []).map((m) => ({ id: m.id, name: m.name, provider: m.provider, caps: m.caps, context: m.context })))");
    check('the model list has many models', models.length > 100, `${models.length} models`);
    // The old list came back as "anthropic/minimax/minimax-m3.1-flash:free[1m]":
    // a vendor prefix in front of the real one and a "[1m]" suffix.
    const mangled = models.filter((m) => /\[\d+m\]/.test(m.id) || m.id.split('/').length > 2);
    check('no rewritten model ids', mangled.length === 0, mangled.slice(0, 3).map((m) => m.id).join(', '));
    const named = models.filter((m) => m.name && m.name !== m.id);
    check('models have real names', named.length > models.length * 0.8, `${named.length}/${models.length}`);
    const minimax = models.find((m) => /^minimax\//.test(m.id));
    check('MiniMax is listed with its real id', !!minimax, minimax ? minimax.id : 'not found');
    const logo = await page.evaluate(`(() => {
      const m = ${JSON.stringify(minimax ? minimax.id : 'minimax/minimax-m3')};
      const f = familyOf(m);
      return { name: f.name, logo: f.logo, hasSvg: !!(window.LOGOS && window.LOGOS[f.logo]) };
    })()`);
    check('MiniMax gets a logo', logo.hasSvg === true, JSON.stringify(logo));
    const logoInfo = await page.evaluate(`(() => {
      const out = {};
      for (const id of ['anthropic/claude-opus-4.5','openai/gpt-5','google/gemini-2.5-pro','nvidia/nemotron-3.5-super','x-ai/grok-4','meta-llama/llama-3.3-70b','moonshotai/kimi-k2','z-ai/glm-4.6','minimax/minimax-m3','deepseek/deepseek-v4.1-flash','qwen/qwen3-235b','mistralai/mistral-large','openrouter/auto','bytedance/seed-1.6','microsoft/phi-4','cohere/command-r','perplexity/sonar-pro','amazon/nova-pro','~anthropic/claude-opus-latest']) {
        const f = familyOf(id);
        out[id] = f.name + (f.logo ? ' [logo]' : ' [no logo]');
      }
      return out;
    })()`);
    const noLogo = Object.entries(logoInfo).filter(([, v]) => v.includes('no logo'));
    check('every common provider gets a logo', noLogo.length === 0, noLogo.map(([k, v]) => k).join(', '));
    console.log('      families:', JSON.stringify(logoInfo, null, 0));

    // --- 3b. the model id validator accepts those ids ---
    const ids = Object.keys(logoInfo);
    const accepted = await page.evaluate(`(async () => {
      const out = [];
      for (const id of ${JSON.stringify(ids)}) {
        try { await api.setSettings({ model: id }); out.push([id, true]); }
        catch (e) { out.push([id, String(e.message).slice(0, 90)]); }
      }
      return out;
    })()`);
    const rejected = accepted.filter(([, ok]) => ok !== true);
    check('the model picker accepts every provider id', rejected.length === 0, rejected.map(([id, e]) => id + ' -> ' + e).join(' | '));
  } catch (e) {
    console.error('verification failed:', e.message);
    results.push(false);
  } finally {
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    await sleep(800);
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
