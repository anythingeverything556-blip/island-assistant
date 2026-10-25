// Does Stop kill the whole process tree, or only the PowerShell it started?
// A Conifer installer kept downloading for 34 minutes after the user pressed
// Stop: the direct powershell.exe died, but the curl.exe it had spawned lived on.
// The command under test therefore starts a powershell.exe of its own and then
// sits still, so we can look for that grandchild after the stop.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHELL = path.join(ROOT, 'src', 'shell.js');
const NODE_PID = process.pid;
const PROMPT_MS = 12000; // a stop may take this long, but never the script's own runtime
const GONE_MS = 6000; // how long we give a killed tree to disappear

const results = [];
const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 10);

// The command under test. It starts a powershell.exe that sleeps for a long
// time, with the marker in its command line, and then waits. -WindowStyle
// Hidden is not optional: the user hates console windows flashing up.
function makeScript(marker, grandSleep, parentSleep) {
  return [
    `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','Start-Sleep ${grandSleep} # ${marker}' -WindowStyle Hidden`,
    `Start-Sleep ${parentSleep}`,
  ].join('; ');
}

// Every running process that mentions the marker, plus every process this test
// started. The query builds the marker from two halves, so the query's own
// command line cannot match itself.
function listProcesses(marker) {
  const half = Math.ceil(marker.length / 2);
  const q = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`
    + `$m='${marker.slice(0, half)}'+'${marker.slice(half)}';$rows=@();`
    + `foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {`
    + `if ($p.ProcessId -eq $PID) { continue };`
    + `$cl=[string]$p.CommandLine;`
    + `if ($cl -like ('*'+$m+'*') -or $cl -like '*-EncodedCommand*' -or $p.ParentProcessId -eq ${NODE_PID}) {`
    + `$rows += [pscustomobject]@{ pid=$p.ProcessId; ppid=$p.ParentProcessId; name=$p.Name; cmd=$cl } } };`
    + `$rows | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { windowsHide: true, encoding: 'utf8' });
  const text = (out || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// The direct child is the powershell.exe we started: either its command line
// holds the marker, or it hides the script in -EncodedCommand, or it is simply
// our child process. The grandchild is the one the command started itself.
function split(marker, rows) {
  const direct = [];
  const grand = [];
  for (const r of rows) {
    const cmd = String(r.cmd || '');
    const literal = cmd.includes(marker);
    let encoded = '';
    const enc = cmd.match(/-EncodedCommand\s+(\S+)/i);
    if (enc) { try { encoded = Buffer.from(enc[1], 'base64').toString('utf16le'); } catch {} }
    const mine = literal || encoded.includes(marker);
    const childOfNode = Number(r.ppid) === NODE_PID;
    if (!mine && !childOfNode) continue;
    if (mine && !childOfNode) grand.push(r);
    else direct.push(r);
  }
  return { direct, grand };
}

function findGrandchild(marker) {
  return split(marker, listProcesses(marker)).grand;
}

async function waitForGrandchild(marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = findGrandchild(marker);
    if (found.length) return found[0];
    await sleep(300);
  }
  return null;
}

async function waitForGone(marker, kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let left = [];
  while (Date.now() < deadline) {
    left = split(marker, listProcesses(marker))[kind];
    if (!left.length) return { gone: true, left: [] };
    await sleep(300);
  }
  return { gone: false, left };
}

// Wait for the promise, but never longer than the script's own runtime.
async function settle(promise, maxMs) {
  const t = Date.now();
  const r = await Promise.race([
    promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    sleep(maxMs).then(() => ({ timeout: true })),
  ]);
  return { ...r, ms: Date.now() - t };
}

function killTreeOf(pid) {
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

(async () => {
  // The new shell.js may still be on its way, so give it a few minutes.
  if (!fs.existsSync(SHELL)) {
    console.log('src/shell.js is not there yet, waiting for it...');
    const deadline = Date.now() + 4 * 60 * 1000;
    while (!fs.existsSync(SHELL) && Date.now() < deadline) {
      console.log(`  still waiting (${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s left)...`);
      await sleep(10000);
    }
  }
  if (!fs.existsSync(SHELL)) {
    console.error('src/shell.js does not exist yet, so there is nothing to test.');
    results.push(false);
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(1);
  }
  let shell = null;
  for (let i = 0; i < 5 && !shell; i++) {
    try { shell = require(SHELL); } catch (e) { console.log(`  src/shell.js cannot be loaded yet (${e.message}), retrying...`); await sleep(2000); }
  }
  if (!shell || typeof shell.runPowerShell !== 'function') {
    console.error('src/shell.js does not export runPowerShell, so there is nothing to test.');
    results.push(false);
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(1);
  }
  const { runPowerShell } = shell;
  console.log('testing', path.relative(ROOT, SHELL), '\n');

  const markers = [];
  try {
    // 1. CONTROL: no stop at all, so the grandchild must be visible while the
    //    command works. This proves the lookup works, so a later failure is
    //    really a leak and not a blind spot.
    const c = `island-kill-test-${rand()}-control`;
    markers.push(c);
    const control = runPowerShell(makeScript(c, 12, 15), { timeoutMs: 25000 });
    const seen = await waitForGrandchild(c, 8000);
    check('control: the grandchild is running while the command works', !!seen, seen ? `pid ${seen.pid}` : 'never seen');
    if (seen) console.log('    grandchild:', seen.cmd);
    const controlResult = await settle(control, 30000);
    check('control: the command finishes on its own', controlResult.ok && controlResult.v && controlResult.v.timedOut === false, controlResult.ok ? `code ${controlResult.v && controlResult.v.code}` : 'did not settle');

    // 2. ABORT: the user presses Stop once the grandchild is running.
    const a = `island-kill-test-${rand()}-abort`;
    markers.push(a);
    const abort = new AbortController();
    const aborted = runPowerShell(makeScript(a, 300, 300), { timeoutMs: 60000, signal: abort.signal });
    const seenAbort = await waitForGrandchild(a, 8000);
    check('abort: the grandchild was running before the stop', !!seenAbort, seenAbort ? `pid ${seenAbort.pid}` : 'never seen');
    abort.abort();
    const abortedResult = await settle(aborted, PROMPT_MS);
    check('abort: the command stops right away', abortedResult.ok && abortedResult.ms < PROMPT_MS, abortedResult.ok ? `${abortedResult.ms}ms` : (abortedResult.timeout ? 'still running after ' + PROMPT_MS + 'ms' : String(abortedResult.e && abortedResult.e.message)));
    const abortGrand = await waitForGone(a, 'grand', GONE_MS);
    check('abort: the grandchild is gone after the stop', abortGrand.gone, abortGrand.gone ? 'nothing left behind' : `pid ${abortGrand.left[0].pid} still running`);
    const abortDirect = await waitForGone(a, 'direct', GONE_MS);
    check('abort: the direct child powershell.exe is gone after the stop', abortDirect.gone, abortDirect.gone ? 'nothing left behind' : `pid ${abortDirect.left[0].pid} still running`);

    // 3. TIMEOUT: the command runs too long, so the timeout has to stop the
    //    whole tree and not just the powershell.exe it started.
    const t = `island-kill-test-${rand()}-timeout`;
    markers.push(t);
    const timed = runPowerShell(makeScript(t, 300, 300), { timeoutMs: 1500 });
    const timedResult = await settle(timed, PROMPT_MS);
    check('timeout: the command stops when the time is up', timedResult.ok && timedResult.ms < PROMPT_MS, timedResult.ok ? `${timedResult.ms}ms` : (timedResult.timeout ? 'still running after ' + PROMPT_MS + 'ms' : String(timedResult.e && timedResult.e.message)));
    const timedGrand = await waitForGone(t, 'grand', GONE_MS);
    check('timeout: the grandchild is gone after the timeout', timedGrand.gone, timedGrand.gone ? 'nothing left behind' : `pid ${timedGrand.left[0].pid} still running`);
    const timedDirect = await waitForGone(t, 'direct', GONE_MS);
    check('timeout: the direct child powershell.exe is gone after the timeout', timedDirect.gone, timedDirect.gone ? 'nothing left behind' : `pid ${timedDirect.left[0].pid} still running`);
  } catch (e) {
    console.error('failed:', e.message);
    results.push(false);
  } finally {
    // A failing run must not leave anything running on the user's machine.
    for (const marker of markers) {
      for (const r of split(marker, listProcesses(marker)).grand.concat(split(marker, listProcesses(marker)).direct)) {
        killTreeOf(r.pid);
      }
    }
    if (typeof shell.killAllActive === 'function') { try { await shell.killAllActive(); } catch {} }
    await sleep(500);
    const left = [];
    for (const marker of markers) {
      const s = split(marker, listProcesses(marker));
      left.push(...s.grand, ...s.direct);
    }
    check('cleanup: no marker process is left behind', left.length === 0, left.length ? `${left.length} still running` : 'the machine is clean');
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
