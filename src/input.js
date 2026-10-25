// Mouse/keyboard control for computer use. A long-lived PowerShell process compiles a
// small C# SendInput wrapper once at startup; each command afterwards takes ~1 ms.
// Coordinates are physical screen pixels (the helper is per-monitor DPI aware).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { idleReaper, HELPER_IDLE_MS } = require('./idle');
const { helperFailed, spawnHelper } = require('./helpers');

const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Inp {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);

  // ---- windows ----
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\\\') { b.Append('\\\\'); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }
  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  static string Proc(int pid) { try { return System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return "?"; } }
  static string WinJson(IntPtr h) {
    int pid; GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    return "{\\"id\\":" + h.ToInt64() + ",\\"pid\\":" + pid + ",\\"app\\":\\"" + Esc(Proc(pid)) + "\\",\\"title\\":\\"" + Esc(Title(h)) + "\\",\\"minimized\\":" + (IsIconic(h) ? "true" : "false") + ",\\"rect\\":[" + r.L + "," + r.T + "," + r.R + "," + r.B + "]}";
  }
  static string B64(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s)); }

  // ---- recording: a low-level mouse hook counts the user's wheel turns (only while on) ----
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w, l; public uint time; public POINT pt; }
  delegate IntPtr HookProc(int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static HookProc hookFn;
  static uint hookTid;
  static int wheelV, wheelH, wheelX, wheelY;
  static IntPtr OnMouse(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      int m = w.ToInt32();
      if (m == 0x020A || m == 0x020E) {
        var s = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
        int d = (short)(s.mouseData >> 16);
        if (m == 0x020A) Interlocked.Add(ref wheelV, d); else Interlocked.Add(ref wheelH, d);
        wheelX = s.pt.X; wheelY = s.pt.Y;
      }
    }
    return CallNextHookEx(IntPtr.Zero, n, w, l);
  }
  static void WatchWheel(bool on) {
    if (on && hookTid == 0) {
      var ready = new ManualResetEvent(false);
      var t = new Thread(() => {
        hookFn = OnMouse;
        hookTid = GetCurrentThreadId();
        IntPtr h = SetWindowsHookEx(14, hookFn, GetModuleHandle(null), 0);
        ready.Set();
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {}
        UnhookWindowsHookEx(h);
        hookTid = 0;
      });
      t.IsBackground = true;
      t.Start();
      ready.WaitOne(2000);
      Interlocked.Exchange(ref wheelV, 0); Interlocked.Exchange(ref wheelH, 0);
    } else if (!on && hookTid != 0) {
      PostThreadMessage(hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
    }
  }

  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} timeBeginPeriod(1); }

  static void Send(INPUT i) {
    // A blocked injection (an app running as administrator, a UAC prompt) must not pass
    // for a successful press.
    if (SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))) == 0) throw new Exception("Windows refused the input (the app in front may be running as administrator)");
  }
  static void Mouse(uint flags, uint data) { var i = new INPUT { type = 0 }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; Send(i); }

  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5 || vk == 0x2C;
  }
  static void Key(int vk, bool up) {
    var i = new INPUT { type = 1 };
    i.u.ki.wVk = (ushort)vk;
    i.u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
    i.u.ki.dwFlags = (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u);
    Send(i);
  }
  static void Unicode(char c) {
    var i = new INPUT { type = 1 };
    i.u.ki.wScan = c; i.u.ki.dwFlags = 4; Send(i);
    i.u.ki.dwFlags = 4 | 2; Send(i);
  }
  static int Vk(string tok) {
    if (tok.StartsWith("c")) { short s = VkKeyScan((char)int.Parse(tok.Substring(1))); if (s == -1) throw new Exception("no key for char " + tok); return s & 0xff; }
    return int.Parse(tok);
  }
  // A character that needs Shift (a "+" on a US layout, a "?", a capital letter): the
  // Shift state VkKeyScan returns must not be thrown away, or the app receives the
  // unshifted twin ("+" arrives as "=").
  static bool NeedsShift(string tok) {
    if (!tok.StartsWith("c")) return false;
    short s = VkKeyScan((char)int.Parse(tok.Substring(1)));
    if (s == -1) throw new Exception("no key for char " + tok);
    return (s >> 8) == 1;
  }
  // Keys and buttons Island is holding down right now, so they can be released if the
  // helper dies and nothing else is left holding them.
  static HashSet<int> held = new HashSet<int>();
  static HashSet<string> heldButtons = new HashSet<string>();
  static int shiftHeld = 0; // how many times we pressed Shift ourselves
  static void Press(string tok, bool up) {
    int vk = Vk(tok);
    bool shift = NeedsShift(tok);
    if (shift && !up) { if (shiftHeld == 0) Key(0x10, false); shiftHeld++; Thread.Sleep(6); }
    Key(vk, up);
    if (shift && up) { shiftHeld--; if (shiftHeld <= 0) { shiftHeld = 0; Key(0x10, true); } Thread.Sleep(6); }
  }
  static void ReleaseHeld() {
    foreach (int vk in held) { try { Key(vk, true); } catch {} }
    held.Clear();
    foreach (string b in heldButtons) { try { Mouse(Flag(b, true), 0); } catch {} }
    heldButtons.Clear();
    shiftHeld = 0;
  }
  static uint Flag(string btn, bool up) {
    if (btn == "right") return up ? 0x10u : 0x08u;
    if (btn == "middle") return up ? 0x40u : 0x20u;
    return up ? 0x04u : 0x02u;
  }

  public static string Exec(string[] p) {
    switch (p[1]) {
      case "fg": { IntPtr h = GetForegroundWindow(); return B64(h == IntPtr.Zero ? "null" : WinJson(h)); }
      case "waitmods": {
        // Wait until Shift/Ctrl/Alt/Win are physically released (or timeout ms).
        int ms = int.Parse(p[2]);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        int[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
        while (sw.ElapsedMilliseconds < ms) {
          bool any = false;
          foreach (int vk in mods) if ((GetAsyncKeyState(vk) & 0x8000) != 0) any = true;
          if (!any) return "1";
          Thread.Sleep(10);
        }
        return "0";
      }
      case "windows": {
        var list = new System.Collections.Generic.List<string>();
        EnumWindows((h, l) => {
          if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;      // visible, unowned
          if ((GetWindowLong(h, -20) & 0x80) != 0) return true;                         // skip tool windows
          int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
          if (Title(h).Length == 0) return true;
          list.Add(WinJson(h));
          return true;
        }, IntPtr.Zero);
        return B64("[" + string.Join(",", list.ToArray()) + "]");
      }
      case "focus": {
        IntPtr h = new IntPtr(long.Parse(p[2]));
        if (IsIconic(h)) ShowWindow(h, 9);
        // A synthetic Alt tap lifts Windows' foreground lock. Not while Alt is held down
        // by Island itself: the tap would release the key the agent is holding.
        if (!held.Contains(0x12)) { Key(0x12, false); Key(0x12, true); }
        SetForegroundWindow(h);
        BringWindowToTop(h);
        Thread.Sleep(150);
        return GetForegroundWindow() == h ? "1" : "0";
      }
      case "pos": { POINT pt; GetCursorPos(out pt); return pt.X + " " + pt.Y; }
      case "kstate": {
        // kstate <tok,tok,...> -> "<all held 1|0> <ms since the last keyboard/mouse input>"
        bool all = true;
        // 0x8000: held now; 0x0001: pressed since we last asked (catches taps between polls)
        foreach (string t in p[2].Split(',')) if ((GetAsyncKeyState(Vk(t)) & 0x8001) == 0) all = false;
        var li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref li);
        return (all ? "1" : "0") + " " + unchecked((uint)Environment.TickCount - li.dwTime);
      }
      case "wheelwatch": { WatchWheel(p[2] == "1"); return ""; }
      case "wheelread": {
        // "<vertical> <horizontal> <x> <y>": wheel turns (120 = one notch) since the last read
        return Interlocked.Exchange(ref wheelV, 0) + " " + Interlocked.Exchange(ref wheelH, 0) + " " + wheelX + " " + wheelY;
      }
      case "kdown": {
        // Keys held now or pressed since the last poll, as virtual-key codes (recording).
        var sb = new StringBuilder();
        for (int vk = 8; vk < 0xFF; vk++) {
          if (vk >= 0xA0 && vk <= 0xA5) continue; // left/right Shift/Ctrl/Alt: the plain codes say it
          if ((GetAsyncKeyState(vk) & 0x8001) == 0) continue;
          if (sb.Length > 0) sb.Append(',');
          sb.Append(vk);
        }
        return sb.Length > 0 ? sb.ToString() : "-";
      }
      case "mstate": {
        // x y left right middle (1 = held)
        POINT pt; GetCursorPos(out pt);
        // 0x8001: held now, or pressed since the last poll (so a quick click is never missed)
        return pt.X + " " + pt.Y + " " + ((GetAsyncKeyState(0x01) & 0x8001) != 0 ? "1" : "0") + " " + ((GetAsyncKeyState(0x02) & 0x8001) != 0 ? "1" : "0") + " " + ((GetAsyncKeyState(0x04) & 0x8001) != 0 ? "1" : "0");
      }
      case "move": {
        int x = int.Parse(p[2]), y = int.Parse(p[3]), ms = int.Parse(p[4]);
        POINT s; GetCursorPos(out s);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true) {
          double t = ms <= 0 ? 1 : Math.Min(1.0, sw.ElapsedMilliseconds / (double)ms);
          double e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
          SetCursorPos((int)Math.Round(s.X + (x - s.X) * e), (int)Math.Round(s.Y + (y - s.Y) * e));
          if (t >= 1) break;
          Thread.Sleep(6);
        }
        return "";
      }
      case "down": Mouse(Flag(p[2], false), 0); heldButtons.Add(p[2]); return "";
      case "up": Mouse(Flag(p[2], true), 0); heldButtons.Remove(p[2]); return "";
      case "click": {
        int n = int.Parse(p[3]);
        if (n < 1) n = 1;
        for (int k = 0; k < n; k++) { Mouse(Flag(p[2], false), 0); Thread.Sleep(25); Mouse(Flag(p[2], true), 0); if (k < n - 1) Thread.Sleep(70); }
        return "";
      }
      case "wheel": {
        int dx = int.Parse(p[2]), dy = int.Parse(p[3]);
        for (int k = 0; k < Math.Abs(dy); k++) { Mouse(0x0800, (uint)(dy > 0 ? 120 : -120)); Thread.Sleep(30); }
        for (int k = 0; k < Math.Abs(dx); k++) { Mouse(0x1000, (uint)(dx > 0 ? 120 : -120)); Thread.Sleep(30); }
        return "";
      }
      case "keys": {
        // keys <tap|down|up> <tok,tok,...> [repeat]
        string[] toks = p[3].Split(',');
        int rep = p.Length > 4 ? int.Parse(p[4]) : 1;
        if (rep < 1) rep = 1;
        for (int r = 0; r < rep; r++) {
          if (p[2] != "up") foreach (string t in toks) { Press(t, false); held.Add(Vk(t)); Thread.Sleep(12); }
          if (p[2] != "down") for (int k = toks.Length - 1; k >= 0; k--) { Press(toks[k], true); held.Remove(Vk(toks[k])); Thread.Sleep(12); }
          if (rep > 1) Thread.Sleep(40);
        }
        return "";
      }
      case "release": {
        // Release everything Island is holding (a held key or a held mouse button).
        ReleaseHeld();
        return "";
      }
      case "type": {
        int ms = int.Parse(p[2]);
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(p[3]));
        foreach (char c in text) {
          if (c == '\\r') continue;
          if (c == '\\n') { Key(0x0D, false); Key(0x0D, true); }
          else if (c == '\\t') { Key(0x09, false); Key(0x09, true); }
          else Unicode(c);
          if (ms > 0) Thread.Sleep(ms);
        }
        return "";
      }
    }
    throw new Exception("unknown command " + p[1]);
  }
}
`;

const SCRIPT = `
Add-Type -TypeDefinition @'
${CSHARP}
'@
[Inp]::Init()
$in = New-Object IO.StreamReader([Console]::OpenStandardInput())
$out = [Console]::Out
$out.WriteLine('ready'); $out.Flush()
while ($true) {
  $line = $in.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try { $r = [Inp]::Exec($p); $out.WriteLine($p[0] + ' ok ' + $r) }
  catch { $out.WriteLine($p[0] + ' err ' + ($_.Exception.InnerException, $_.Exception -ne $null)[0].Message.Replace([char]10, ' ')) }
  $out.Flush()
}
`;

// xdotool-style key names (what Claude uses) -> Windows virtual-key codes.
const NAMED = {
  ctrl: 0x11, control: 0x11, ctrl_l: 0x11, ctrl_r: 0x11, control_l: 0x11, control_r: 0x11,
  shift: 0x10, shift_l: 0x10, shift_r: 0x10,
  alt: 0x12, alt_l: 0x12, alt_r: 0x12, option: 0x12,
  super: 0x5b, super_l: 0x5b, super_r: 0x5b, win: 0x5b, win_l: 0x5b, win_r: 0x5b, lwin: 0x5b, rwin: 0x5b, windows: 0x5b, windows_key: 0x5b, winkey: 0x5b, meta: 0x5b, meta_l: 0x5b, cmd: 0x5b, command: 0x5b,
  return: 0x0d, enter: 0x0d, kp_enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  backspace: 0x08, back_space: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, page_up: 0x21, pageup: 0x21, prior: 0x21, page_down: 0x22, pagedown: 0x22, next: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, space: 0x20,
  caps_lock: 0x14, num_lock: 0x90, scroll_lock: 0x91, pause: 0x13, print: 0x2c, printscreen: 0x2c, menu: 0x5d, apps: 0x5d,
  xf86audioraisevolume: 0xaf, xf86audiolowervolume: 0xae, xf86audiomute: 0xad, xf86audioplay: 0xb3, xf86audionext: 0xb0, xf86audioprev: 0xb1,
};
const CHAR_NAMES = {
  minus: '-', plus: '+', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';',
  apostrophe: "'", bracketleft: '[', bracketright: ']', grave: '`', asterisk: '*', underscore: '_', quotedbl: '"',
};
const PRETTY = { 0x11: 'Ctrl', 0x10: 'Shift', 0x12: 'Alt', 0x5b: 'Win', 0x0d: 'Enter', 0x09: 'Tab', 0x1b: 'Esc', 0x08: 'Backspace', 0x2e: 'Del', 0x20: 'Space', 0x26: '↑', 0x28: '↓', 0x25: '←', 0x27: '→', 0x21: 'PgUp', 0x22: 'PgDn', 0x24: 'Home', 0x23: 'End' };

// "ctrl+shift+t" -> { tokens: ['17','16','84'], pretty: ['Ctrl','Shift','T'] }
//
// A token is either a virtual-key code (no Shift needed) or "c<code>", meaning "this
// character": the helper works out the key with VkKeyScan and presses Shift with it when
// the character needs it. That is what makes "+" send a plus and not an equals sign.
function splitCombo(combo) {
  const s = String(combo).trim();
  if (!s) return [];
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '+') { cur += ch; continue; }
    // A "+" ends the key name, unless it is the key itself: it is the key when nothing
    // came before it, or when another "+" follows ("+", "++", "ctrl++").
    const next = s[i + 1];
    if (cur === '' && (next === '+' || i === s.length - 1)) { cur = '+'; continue; }
    if (cur !== '') { parts.push(cur); cur = ''; }
  }
  if (cur) parts.push(cur);
  return parts;
}

function parseCombo(combo) {
  const parts = splitCombo(combo);
  if (!parts.length) throw new Error('empty key combination');
  const tokens = [];
  const pretty = [];
  for (const raw of parts) {
    const k = raw.toLowerCase();
    let vk = NAMED[k];
    if (vk === undefined && /^f([1-9]|1\d|2[0-4])$/.test(k)) vk = 0x6f + Number(k.slice(1));
    if (vk !== undefined) {
      tokens.push(String(vk));
      pretty.push(PRETTY[vk] || raw[0].toUpperCase() + raw.slice(1).replace(/_/g, ' '));
      continue;
    }
    const ch = CHAR_NAMES[k] ?? (raw.length === 1 ? raw : null);
    if (ch === null) throw new Error(`unknown key "${raw}"`);
    // Lowercase letters and digits are their own key, with no Shift. Everything else
    // (uppercase, punctuation) is resolved by the helper, which also applies the Shift
    // the character needs.
    if (/^[a-z0-9]$/.test(ch)) tokens.push(String(ch.toUpperCase().charCodeAt(0)));
    else tokens.push('c' + ch.charCodeAt(0));
    pretty.push(ch.toUpperCase());
  }
  return { tokens, pretty };
}

function createInput() {
  let child = null;
  let ready = null;
  let seq = 0;
  let buf = '';
  const waiting = new Map();
  let chain = Promise.resolve();
  // What Island is holding down right now, so it can let go if the helper dies.
  const heldKeys = new Set();
  const heldButtons = new Set();
  const reaper = idleReaper(HELPER_IDLE_MS, {
    busy: () => waiting.size > 0 || heldKeys.size > 0 || heldButtons.size > 0,
    stop: () => { try { child?.stdin.end(); child?.kill(); } catch {} },
  });

  // Run from a file: as an encoded command the script is close to Windows' ~32K
  // command-line limit. Named by content, so an updated script never reuses an old file.
  function scriptFile() {
    const file = path.join(os.tmpdir(), `island-input-${crypto.createHash('sha1').update(SCRIPT).digest('hex').slice(0, 12)}.ps1`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '\uFEFF' + SCRIPT, 'utf8');
    return file;
  }

  function start() {
    // The compiled helper (~12 MB) if it's there, else the same C# run through PowerShell (~70 MB).
    let exe;
    ({ child, exe } = spawnHelper('island-input.exe', { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile()] }));
    let readyOk, readyFail;
    ready = new Promise((resolve, reject) => {
      readyOk = resolve;
      readyFail = reject;
      const t = setTimeout(() => reject(new Error('input helper did not start')), 30000);
      waiting.set('ready', () => { clearTimeout(t); resolve(); });
    });
    ready.catch(() => {});
    // The program couldn't start (e.g. blocked by antivirus): carry on with PowerShell.
    child.on('error', (e) => {
      child = null;
      if (!exe) return readyFail(e);
      helperFailed('island-input.exe');
      start();
      ready.then(readyOk, readyFail);
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line === 'ready') { waiting.get('ready')?.(); waiting.delete('ready'); continue; }
        const [id, status, ...rest] = line.split(' ');
        const w = waiting.get(id);
        if (!w) continue;
        waiting.delete(id);
        status === 'ok' ? w.resolve(rest.join(' ')) : w.reject(new Error(rest.join(' ') || 'input error'));
      }
    });
    child.on('exit', () => {
      child = null;
      for (const [, w] of waiting) w.reject?.(new Error('input helper exited'));
      waiting.clear();
      // The helper died holding a key or a mouse button down. Let go of them, or the
      // user's keyboard and mouse stay stuck.
      if (heldKeys.size || heldButtons.size) {
        const keys = [...heldKeys];
        const buttons = [...heldButtons];
        heldKeys.clear();
        heldButtons.clear();
        try {
          start();
          ready.then(() => {
            if (keys.length) cmd('keys', 'up', keys.join(','), 1).catch(() => {});
            for (const b of buttons) cmd('up', b, 1).catch(() => {});
          }).catch(() => {});
        } catch {}
      }
    });
  }

  // Commands run strictly one at a time.
  function cmd(...args) {
    reaper.touch();
    const run = async () => {
      if (!child) start();
      await ready;
      const id = String(++seq);
      return new Promise((resolve, reject) => {
        // A helper that never answers must not block every later command for ever.
        const timer = setTimeout(() => {
          if (!waiting.has(id)) return;
          waiting.delete(id);
          reject(new Error('the input helper did not answer in time'));
        }, 20000);
        waiting.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        child.stdin.write(`${id} ${args.join(' ')}\n`);
      });
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  return {
    start: () => { if (!child) start(); reaper.touch(); },
    stop: () => {
      // Let go of anything held before the helper goes, so nothing stays stuck down.
      try { if (child) child.stdin.write(`${++seq} release\n`); } catch {}
      heldKeys.clear();
      heldButtons.clear();
      try { child?.stdin.end(); child?.kill(); } catch {}
    },
    async pos() {
      const [x, y] = (await cmd('pos')).split(' ').map(Number);
      return { x, y };
    },
    // Whether every key of a combination is held right now (the learner's own key presses).
    async keyState(tokens) {
      const [down, idle] = (await cmd('kstate', tokens.join(','))).split(' ').map(Number);
      return { down: down === 1, idle };
    },
    // Pointer position and whether the left button is held (the user's own clicks).
    async mouseState() {
      const [x, y, left, right, middle] = (await cmd('mstate')).split(' ').map(Number);
      return { x, y, down: left === 1, right: right === 1, middle: middle === 1 };
    },
    // Virtual-key codes held now (or tapped since the last call): the user's own keys.
    async keysDown() {
      const r = await cmd('kdown');
      return r === '-' ? [] : r.split(',').map(Number);
    },
    // Recording: count the user's mouse-wheel turns (a hook that is on only while recording).
    wheelWatch: (on) => cmd('wheelwatch', on ? 1 : 0),
    async wheelRead() {
      const [v, h, x, y] = (await cmd('wheelread')).split(' ').map(Number);
      return { v, h, x, y };
    },
    move: (x, y, ms) => cmd('move', Math.round(x), Math.round(y), Math.round(ms)),
    down: async (btn = 'left') => { const r = await cmd('down', btn); heldButtons.add(btn); return r; },
    up: async (btn = 'left') => { const r = await cmd('up', btn); heldButtons.delete(btn); return r; },
    click: (btn = 'left', count = 1) => cmd('click', btn, Math.max(1, Math.round(count))),
    wheel: (dx, dy) => cmd('wheel', dx, dy),
    keys: async (action, tokens, repeat = 1) => {
      const r = await cmd('keys', action, tokens.join(','), Math.max(1, Math.round(repeat)));
      // Remember what is being held, so it can be released if the helper dies.
      if (action === 'down') for (const t of tokens) heldKeys.add(t);
      else if (action === 'up') for (const t of tokens) heldKeys.delete(t);
      return r;
    },
    // Let go of every key and button Island is holding.
    async releaseAll() {
      if (!heldKeys.size && !heldButtons.size) return;
      const keys = [...heldKeys];
      const buttons = [...heldButtons];
      heldKeys.clear();
      heldButtons.clear();
      try {
        if (keys.length) await cmd('keys', 'up', keys.join(','), 1);
        for (const b of buttons) await cmd('up', b, 1);
      } catch {}
    },
    // What is being held right now (for the caller to check).
    held: () => ({ keys: [...heldKeys], buttons: [...heldButtons] }),
    type: (text, msPerChar) => cmd('type', Math.round(msPerChar), Buffer.from(text, 'utf8').toString('base64')),
    // { id, pid, app, title, minimized, rect } of the window receiving keystrokes
    async foreground() {
      return JSON.parse(Buffer.from(await cmd('fg'), 'base64').toString('utf8'));
    },
    // Top-level app windows, front to back.
    async windows() {
      return JSON.parse(Buffer.from(await cmd('windows'), 'base64').toString('utf8'));
    },
    async focus(id) {
      return (await cmd('focus', String(Math.trunc(Number(id))))) === '1';
    },
    // Resolves true once no modifier key is held (false on timeout).
    async waitModifiersReleased(ms = 1500) {
      return (await cmd('waitmods', Math.round(ms))) === '1';
    },
  };
}

module.exports = { createInput, parseCombo, CSHARP };
