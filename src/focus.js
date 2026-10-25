// Remembers which app window the user was in, so collapsing the island can hand
// keyboard focus straight back to it. A long-lived PowerShell helper polls the
// foreground window (compiled once at startup, so each check costs microseconds).
const { helperFailed, spawnHelper } = require('./helpers');

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class FW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public RECT Mon; public RECT Work; public int Flags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MI i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  // The lock screen: a window of the LockApp program, in front of everything.
  public static bool Locked(IntPtr h) {
    var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64);
    var c = sb.ToString();
    if (c == "LockApp" || c == "Windows.UI.Core.CoreWindow") return true;
    var tb = new System.Text.StringBuilder(128); GetWindowText(h, tb, 128);
    return tb.ToString().StartsWith("Windows Default Lock Screen");
  }
  // A window covering its whole monitor (taskbar included): a full-screen video, game or slideshow.
  public static bool Full(IntPtr h) {
    var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64);
    var c = sb.ToString(); if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return false;
    RECT r; if (!GetWindowRect(h, out r)) return false;
    var mi = new MI(); mi.cb = Marshal.SizeOf(typeof(MI));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.L <= mi.Mon.L && r.T <= mi.Mon.T && r.R >= mi.Mon.R && r.B >= mi.Mon.B;
  }
}
"@
$own = __OWN_PID__
$last = 0
$wasFull = $false
$wasLocked = $false
$in = New-Object IO.StreamReader([Console]::OpenStandardInput())  # Console.In's async read blocks on .NET Framework
$pending = $in.ReadLineAsync()
while ($true) {
  if ($pending.IsCompleted) {
    $line = $pending.Result
    if ($line -eq $null) { break }
    if ($line -like 'set *') {
      $h = [IntPtr][long]$line.Substring(4)
      if ([FW]::IsWindow($h) -and -not [FW]::IsIconic($h)) {
        # A synthetic Alt tap lifts Windows' foreground lock for SetForegroundWindow.
        [FW]::keybd_event(0x12, 0, 0, 0); [FW]::keybd_event(0x12, 0, 2, 0)
        [void][FW]::SetForegroundWindow($h)
      }
    }
    $pending = $in.ReadLineAsync()
  }
  $fg = [FW]::GetForegroundWindow()
  $p = 0; [void][FW]::GetWindowThreadProcessId($fg, [ref]$p)
  if ($fg -ne [IntPtr]::Zero -and $p -ne $own -and $fg.ToInt64() -ne $last) {
    $last = $fg.ToInt64()
    [Console]::Out.WriteLine("fg $last"); [Console]::Out.Flush()
  }
  if ($fg -ne [IntPtr]::Zero -and $p -ne $own) {
    $full = [FW]::Full($fg)
    if ($full -ne $wasFull) { $wasFull = $full; [Console]::Out.WriteLine("full " + [int]$full); [Console]::Out.Flush() }
    $locked = [FW]::Locked($fg)
    if ($locked -ne $wasLocked) { $wasLocked = $locked; [Console]::Out.WriteLine("lock " + [int]$locked); [Console]::Out.Flush() }
  }
  Start-Sleep -Milliseconds 120
}
`;

// onForeign(hwnd): another program's window has come to the front (its own, Island's
// own windows are excluded by the helper). The panel folds when this happens on the
// renderer's say-so: it knows about password fields and open questions.
// onFull(bool): the app in front went full screen (or left it).
// onLock(bool): Windows was locked (or unlocked). While it is locked, the keyboard and
// the mouse go nowhere, so Island should say so instead of clicking at a locked screen.
function createFocusTracker({ onFull, onLock, onForeign } = {}) {
  let child = null;
  let lastForeign = null;

  function start() {
    // The compiled helper (src/helpers/focus-helper.cs, ~12 MB) when it's there; otherwise the
    // same logic as a PowerShell script (~80 MB while running).
    const script = SCRIPT.replace('__OWN_PID__', String(process.pid));
    let exe;
    ({ child, exe } = spawnHelper('island-focus.exe', { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }, [String(process.pid)]));
    // The program couldn't start (e.g. blocked by antivirus): use the PowerShell version.
    child.on('error', () => {
      child = null;
      if (exe) { helperFailed('island-focus.exe'); start(); }
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('fg ')) { lastForeign = line.slice(3); onForeign?.(lastForeign); }
        else if (line.startsWith('full ')) onFull?.(line.slice(5) === '1');
        else if (line.startsWith('lock ')) onLock?.(line.slice(5) === '1');
      }
    });
    child.on('exit', () => { child = null; });
  }

  return {
    start,
    // Returns true if a previous window was asked to take focus.
    restore() {
      if (!child || !lastForeign) return false;
      child.stdin.write(`set ${lastForeign}\n`);
      return true;
    },
    stop() {
      try { child?.stdin.end(); child?.kill(); } catch {}
    },
  };
}

module.exports = { createFocusTracker };
