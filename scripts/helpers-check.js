// Runs the same read-only commands through each compiled helper and its PowerShell fallback
// and compares the answers, plus each one's memory. Nothing is clicked or typed.
// Usage: node scripts/helpers-check.js
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function helperProc(exe, script) {
  const file = script ? path.join(os.tmpdir(), `island-check-${path.basename(exe, '.exe')}.ps1`) : null;
  if (file) fs.writeFileSync(file, '﻿' + script, 'utf8');
  const child = file
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: ['pipe', 'pipe', 'ignore'] })
    : spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiting = new Map();
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === 'ready') { readyResolve(); continue; }
      const id = line.split(' ')[0];
      waiting.get(id)?.(line.slice(id.length + 1));
      waiting.delete(id);
    }
  });
  let seq = 0;
  return {
    child,
    ready: Promise.race([ready, new Promise((_, j) => setTimeout(() => j(new Error('no ready')), 30000))]),
    ask: (cmd) => new Promise((r) => { const id = String(++seq); waiting.set(id, r); child.stdin.write(`${id} ${cmd}\n`); setTimeout(() => r('(timeout)'), 8000); }),
    mb: () => Math.round(Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${child.pid}).WorkingSet64"`).toString()) / 1048576),
    close: () => { child.stdin.end(); if (file) setTimeout(() => fs.rmSync(file, { force: true }), 500); },
  };
}

const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
(async () => {
  let bad = 0;
  const { CSHARP: INPUT_CS } = require('../src/input.js');
  const { CSHARP: UIA_CS } = require('../src/uia.js');
  const inputScript = fs.readFileSync(path.join(ROOT, 'src', 'input.js'), 'utf8').match(/const SCRIPT = `([\s\S]*?)`;/)[1].replace('${CSHARP}', INPUT_CS);
  const uiaScript = fs.readFileSync(path.join(ROOT, 'src', 'uia.js'), 'utf8').match(/const SCRIPT = `([\s\S]*?)`;/)[1].replace('${CSHARP}', UIA_CS);
  const cases = [
    { name: 'input', exe: path.join(ROOT, 'helpers', 'island-input.exe'), script: inputScript, cmds: ['pos', 'foreground'], decode: (s) => s },
    { name: 'uia', exe: path.join(ROOT, 'helpers', 'island-uia.exe'), script: uiaScript, cmds: ['fgname 0', 'focus', 'scrollinfo 0'], decode: (s) => (s.startsWith('ok ') ? 'ok ' + b64(s.slice(3)).slice(0, 160) : s) },
  ];
  for (const c of cases) {
    const a = helperProc(c.exe);
    const b = helperProc(c.exe, c.script);
    try {
      await Promise.all([a.ready, b.ready]);
      for (const cmd of c.cmds) {
        const [ra, rb] = [c.decode(await a.ask(cmd)), c.decode(await b.ask(cmd))];
        const same = ra === rb;
        if (!same && !/^ok /.test(ra)) bad++;
        console.log(`${same ? 'SAME' : 'DIFF'}  ${c.name} ${cmd}\n      native:     ${ra}\n      powershell: ${rb}`);
      }
      console.log(`MEM   ${c.name}: native ${a.mb()} MB vs PowerShell ${b.mb()} MB`);
    } catch (e) {
      bad++;
      console.log(`FAIL  ${c.name}: ${e.message}`);
    } finally {
      a.close();
      b.close();
    }
  }
  setTimeout(() => process.exit(bad ? 1 : 0), 800);
})();
