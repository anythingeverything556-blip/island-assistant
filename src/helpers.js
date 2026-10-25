// Where Island's compiled helper programs live (built by scripts/build-helpers.js): next to the
// app when installed, or in helpers/ during development. null when missing or when one failed
// to start (antivirus can block or quarantine a new program), in which case each caller runs
// the same code as a PowerShell script instead.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const broken = new Set();

function helperExe(name) {
  if (broken.has(name)) return null;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'helpers', name),
    path.join(__dirname, '..', 'helpers', name),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// A helper program couldn't start: use the PowerShell fallback from now on.
function helperFailed(name) {
  broken.add(name);
}

// Starts the compiled helper `name`, or `fallback` ({ cmd, args }) when it's missing or Windows
// refuses to run it right away (a damaged or blocked file throws instead of emitting 'error').
// Returns { child, exe } where exe is the program's path, or null for the fallback.
function spawnHelper(name, fallback, args = []) {
  const opts = { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] };
  const exe = helperExe(name);
  if (exe) {
    try {
      return { child: spawn(exe, args, opts), exe };
    } catch {
      helperFailed(name);
    }
  }
  return { child: spawn(fallback.cmd, fallback.args, opts), exe: null };
}

module.exports = { helperExe, helperFailed, spawnHelper };
