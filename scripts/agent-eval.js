// Island's task suite: everyday jobs given to Island in plain words, each run several times,
// with an honest success rate at the end. Each task works in a throwaway folder and is checked
// by looking at the result (the file exists, says the right thing...), not at Island's reply.
//
//   node scripts/agent-eval.js                 file and Island-tool tasks (no mouse or keyboard)
//   node scripts/agent-eval.js --pc            also tasks that use the mouse and keyboard; Island
//                                              takes over the screen, so don't use the PC meanwhile
//   options: --runs 3   --only rename,sum   --model claude-haiku-5-5
//
// Uses the API key from your environment or Island's settings and costs a few cents per run.
// Results: island-assistant/eval-results/<date>.json and a table on screen.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const RUNS = Number(opt('runs', 3));
const ONLY = opt('only', '') ? opt('only', '').split(',') : null;
const MODEL = opt('model', 'claude-haiku-5-5');
const USE_PC = argv.includes('--pc');
const TIMEOUT = Number(opt('timeout', 240)) * 1000;
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// ---------------------------------------------------------------- tasks
// setup(dir) prepares the folder; check(dir, api) returns true when the job was done right.
const TASKS = [
  { id: 'folder', ask: (d) => `Create a folder called "Reports" inside ${d}.`, check: (d) => fs.existsSync(path.join(d, 'Reports')) && fs.statSync(path.join(d, 'Reports')).isDirectory() },
  { id: 'write', ask: (d) => `Make a text file ${path.join(d, 'notes.txt')} that says: buy milk`, check: (d) => /buy milk/i.test(read(path.join(d, 'notes.txt')) || '') },
  { id: 'rename', setup: (d) => fs.writeFileSync(path.join(d, 'draft.txt'), 'hello'), ask: (d) => `Rename ${path.join(d, 'draft.txt')} to final.txt (same folder).`, check: (d) => fs.existsSync(path.join(d, 'final.txt')) && !fs.existsSync(path.join(d, 'draft.txt')) },
  { id: 'copy', setup: (d) => fs.writeFileSync(path.join(d, 'report.txt'), 'Q3 numbers'), ask: (d) => `Make a copy of ${path.join(d, 'report.txt')} called report-backup.txt in the same folder.`, check: (d) => read(path.join(d, 'report-backup.txt')) === 'Q3 numbers' && fs.existsSync(path.join(d, 'report.txt')) },
  { id: 'move', setup: (d) => { fs.mkdirSync(path.join(d, 'in')); for (const f of ['a.jpg', 'b.jpg', 'c.txt']) fs.writeFileSync(path.join(d, 'in', f), f); }, ask: (d) => `Move all the .jpg files from ${path.join(d, 'in')} into a new folder ${path.join(d, 'photos')}. Leave other files where they are.`, check: (d) => ['a.jpg', 'b.jpg'].every((f) => fs.existsSync(path.join(d, 'photos', f))) && fs.existsSync(path.join(d, 'in', 'c.txt')) && !fs.existsSync(path.join(d, 'in', 'a.jpg')) },
  { id: 'sum', setup: (d) => fs.writeFileSync(path.join(d, 'numbers.txt'), '12\n30\n7\n51\n'), ask: (d) => `Add up the numbers in ${path.join(d, 'numbers.txt')} and write only the total into ${path.join(d, 'sum.txt')}.`, check: (d) => (read(path.join(d, 'sum.txt')) || '').trim() === '100' },
  { id: 'count', setup: (d) => fs.writeFileSync(path.join(d, 'people.csv'), 'name,city\nAsha,Pune\nRavi,Delhi\nMeena,Jaipur\nArjun,Chennai\n'), ask: (d) => `How many people are listed in ${path.join(d, 'people.csv')} (not counting the header)? Write only the number into ${path.join(d, 'count.txt')}.`, check: (d) => (read(path.join(d, 'count.txt')) || '').trim() === '4' },
  { id: 'largest', setup: (d) => { fs.writeFileSync(path.join(d, 'small.bin'), Buffer.alloc(100)); fs.writeFileSync(path.join(d, 'big.bin'), Buffer.alloc(5000)); fs.writeFileSync(path.join(d, 'mid.bin'), Buffer.alloc(900)); }, ask: (d) => `Which file in ${d} is the largest? Write just its file name into ${path.join(d, 'answer.txt')}.`, check: (d) => /^big\.bin$/i.test((read(path.join(d, 'answer.txt')) || '').trim()) },
  { id: 'list', ask: (d) => `Create ${path.join(d, 'shopping.txt')} with three groceries, one per line: rice, dal, milk.`, check: (d) => { const l = (read(path.join(d, 'shopping.txt')) || '').toLowerCase().split(/\r?\n/).map((s) => s.trim()).filter(Boolean); return l.length === 3 && ['rice', 'dal', 'milk'].every((x) => l.some((y) => y.includes(x))); } },
  { id: 'delete', setup: (d) => fs.writeFileSync(path.join(d, 'old.log'), 'x'), ask: (d) => `Delete the file ${path.join(d, 'old.log')}.`, check: (d) => !fs.existsSync(path.join(d, 'old.log')) },
  { id: 'timer', ask: () => 'Start a 2 minute timer called Tea.', check: async (d, ev) => (await ev('api.getTimers()')).some((t) => /tea/i.test(t.label)) },
  { id: 'reminder', ask: () => 'Remind me in 45 minutes to drink water.', check: async (d, ev) => JSON.stringify(await ev('api.remindersList()')).toLowerCase().includes('water') },
  { id: 'notepad', pc: true, ask: (d) => `Open Notepad, type exactly: hello from island, then save it as ${path.join(d, 'np.txt')} and close Notepad.`, check: (d) => /hello from island/i.test(read(path.join(d, 'np.txt')) || '') },
  { id: 'calculator', pc: true, ask: (d) => `Use the Windows Calculator app to work out 12 times 34, then write only the result into ${path.join(d, 'calc.txt')}.`, check: (d) => (read(path.join(d, 'calc.txt')) || '').trim() === '408' },
];

// ---------------------------------------------------------------- talking to Island
async function attach() {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => /renderer\/index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0;
        const waiting = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
        return async (expression) => {
          const r = await new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
          if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
          return r.result?.result?.value;
        };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('could not attach to Island');
}

// One task, start to finish: new chat, ask, OK every question on screen (the folder is a
// throwaway one), wait for the reply, count steps.
async function runTask(ev, task, dir) {
  await ev(`(async () => { await api.reset({}); renderHistory([]); showChat(); return 1; })()`);
  const t0 = Date.now();
  await ev(`(() => { input.value = ${JSON.stringify(task.ask(dir))}; submit(); return 1; })()`);
  let steps = 0;
  let finished = false;
  for (let waited = 0; waited < TIMEOUT; waited += 500) {
    await sleep(500);
    const st = await ev(`(() => { const card = document.getElementById('prompt').firstElementChild; const ok = card?.querySelector('[data-a="1"], [data-a="yes"]'); if (ok) { ok.click(); return 'approved'; } return S.busy ? 'busy' : 'done'; })()`);
    if (st === 'approved') steps++;
    if (st === 'done' && waited > 1500) { finished = true; break; }
  }
  // Stuck: note what was on screen, then stop the reply so the next task starts clean.
  let stuck = null;
  if (!finished) {
    stuck = await ev(`(() => ({ activity: S.activity, prompt: document.getElementById('prompt').innerText.slice(0, 300), last: (thread.lastElementChild?.innerText || '').slice(-400) }))()`).catch(() => null);
    await ev('api.stop()').catch(() => {});
    for (let i = 0; i < 20 && (await ev('S.busy').catch(() => false)); i++) await sleep(500);
  }
  const seconds = (Date.now() - t0) / 1000;
  const tools = await ev(`api.history().then((h) => h.items.filter((i) => i.role === 'assistant').flatMap((i) => i.blocks).filter((b) => b.type === 'tool' || b.type === 'web').length)`);
  let ok = false;
  try { ok = !!(await task.check(dir, ev)); } catch { ok = false; }
  return { ok, seconds: Math.round(seconds * 10) / 10, tools, approvals: steps, ...(stuck ? { stuck } : {}) };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'island-eval-profile-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'island-eval-'));
  const tasks = TASKS.filter((t) => (USE_PC || !t.pc) && (!ONLY || ONLY.includes(t.id)));
  console.log(`Island task suite: ${tasks.length} tasks × ${RUNS} runs with ${MODEL}${USE_PC ? ' (including mouse and keyboard tasks)' : ''}\n`);
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, ISLAND_PROFILE_DIR: profile }, stdio: 'ignore' });
  const results = [];
  try {
    const ev = await attach();
    await sleep(2500);
    await ev(`(async () => { S.settings = await api.setSettings({ model: ${JSON.stringify(MODEL)}, computerUse: ${USE_PC ? "'ask'" : "'off'"}, memoryAuto: false, permissionMode: 'ask' }); return 1; })()`);
    for (const task of tasks) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const dir = fs.mkdtempSync(path.join(work, `${task.id}-`));
        task.setup?.(dir);
        const r = await runTask(ev, task, dir).catch((e) => ({ ok: false, error: e.message }));
        runs.push(r);
        process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${task.id} #${i + 1}  ${r.seconds ?? '-'} s, ${r.tools ?? '-'} steps${r.error ? `  (${r.error})` : ''}\n`);
        if (r.stuck) process.stdout.write(`      stuck: ${JSON.stringify(r.stuck)}\n`);
      }
      results.push({ id: task.id, pc: !!task.pc, runs });
    }
  } catch (e) {
    console.log('Could not run the suite:', e.message);
  } finally {
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    await sleep(1000);
    for (const d of [profile, work]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  if (!results.length) return;
  const all = results.flatMap((r) => r.runs);
  const passed = all.filter((r) => r.ok).length;
  const consistent = results.filter((r) => r.runs.every((x) => x.ok) || r.runs.every((x) => !x.ok)).length;
  console.log(`\n${'task'.padEnd(12)} passed   avg time`);
  for (const r of results) {
    const okRuns = r.runs.filter((x) => x.ok);
    const avg = r.runs.reduce((s, x) => s + (x.seconds || 0), 0) / r.runs.length;
    console.log(`${r.id.padEnd(12)} ${okRuns.length}/${r.runs.length}      ${avg.toFixed(1)} s`);
  }
  console.log(`\nSuccess: ${passed}/${all.length} runs (${Math.round((100 * passed) / all.length)}%). Same result every run: ${consistent}/${results.length} tasks.`);
  const outDir = path.join(ROOT, 'eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: MODEL, pc: USE_PC, runs: RUNS, results }, null, 2));
  console.log(`Saved ${path.relative(ROOT, file)}`);
})();
