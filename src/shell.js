'use strict';
/**
 * Running PowerShell for the agent, and stopping it properly.
 *
 * Island runs PowerShell for the things no other tool can do. Stopping it used to be a
 * bare child.kill(), which on Windows is TerminateProcess on that one pid: when the user
 * pressed Stop during a Conifer install, the direct powershell.exe died but the curl.exe
 * the installer had spawned kept downloading for 34 minutes. So every stop here kills the
 * whole tree (taskkill /T /F), the same way the MCP manager kills its servers.
 */

const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

const KILL_TIMEOUT_MS = 5000; // how long taskkill gets before we stop waiting for it

// Every powershell.exe Island started and has not reaped yet, so quitting leaves nothing behind.
const liveChildren = new Set();

/** Is this pid still running? EPERM means it is alive, we just may not signal it. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Kill a whole process tree. A bare child.kill() only reaches the direct child on Windows,
 * so whatever it started (curl.exe) survives; taskkill /T /F takes the tree with it.
 * Never rejects.
 */
function killTree(pid) {
  return new Promise((resolve) => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return resolve();
    if (!isAlive(n)) return resolve();
    if (IS_WIN) {
      execFile('taskkill', ['/pid', String(n), '/T', '/F'], { windowsHide: true, timeout: KILL_TIMEOUT_MS }, () => resolve());
      return;
    }
    // Elsewhere the group is what matters, but it only exists if the child was detached.
    try { process.kill(-n, 'SIGKILL'); } catch {}
    try { process.kill(n, 'SIGKILL'); } catch {}
    resolve();
  });
}

/**
 * Run a program and resolve with { code, stdout, stderr, timedOut }. Never rejects.
 *
 * Tracked like runPowerShell, so it is tree-killed when Island quits. maxBuffer 0 means
 * no limit; a bigger output than that kills the child instead of growing without end.
 */
function runProcess(cmd, args, { timeoutMs = 60000, signal, maxBuffer = 0, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let exited = false;

    liveChildren.add(child);

    const kill = () => {
      killTree(child.pid).then(() => {
        // Backstop: if taskkill itself failed the direct child would live on and this
        // promise would never resolve. By now the tree is gone, so killing it is safe.
        try { if (!exited) child.kill(); } catch {}
      });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort); // long runs must not pile up listeners
      liveChildren.delete(child);
      resolve(result);
    };

    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (maxBuffer && stdout.length > maxBuffer) { overflow = true; kill(); }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', () => { exited = true; });
    child.on('error', (e) => finish({ code: -1, stdout, stderr: String(e), timedOut, overflow }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, overflow }));

    // The caller had already stopped before we even started: kill the child now instead
    // of letting it run to the end.
    if (signal?.aborted) kill();
  });
}

/**
 * Run a PowerShell script and resolve with { code, stdout, stderr, timedOut }. Never rejects.
 *
 * A stop (timeout or abort) kills the whole tree, not just the direct child, so an
 * installer that started curl.exe does not leave it running behind the app.
 */
function runPowerShell(script, { timeoutMs = 60000, signal } = {}) {
  const full = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue";' + script;
  return runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')],
    { timeoutMs, signal }
  );
}

/**
 * Kill everything the agent started, tree and all. Island calls this when it quits so
 * nothing it launched outlives the app. Never rejects.
 */
function killAllActive() {
  const kids = [...liveChildren];
  return Promise.all(kids.map((child) => killTree(child.pid))).then(() => undefined).catch(() => {});
}

module.exports = { runPowerShell, runProcess, killTree, killAllActive, IS_WIN };
