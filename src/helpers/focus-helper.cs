// Island's foreground-window tracker as a small native program (a PowerShell helper doing the
// same job idled at ~80 MB; this one at a few MB). Built by scripts/build-helpers.js with the
// C# compiler that ships with Windows. Talks over stdin/stdout, one line per message:
//   out  "fg <hwnd>"   the user switched to another app's window (never Island's own)
//   out  "full 1|0"    the window in front went full screen (video, game, slideshow) or left it
//   out  "lock 1|0"    Windows was locked (or unlocked) and the keyboard went nowhere
//   in   "set <hwnd>"  give that window the keyboard focus again
// Exits when stdin closes, i.e. when Island quits.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class FocusHelper {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, int f, int e);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MI { public int cb; public RECT Mon; public RECT Work; public int Flags; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MI i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  // A window covering its whole monitor, taskbar included.
  static bool Full(IntPtr h) {
    var sb = new StringBuilder(64);
    GetClassName(h, sb, 64);
    var c = sb.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return false; // the desktop
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    var mi = new MI();
    mi.cb = Marshal.SizeOf(typeof(MI));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.L <= mi.Mon.L && r.T <= mi.Mon.T && r.R >= mi.Mon.R && r.B >= mi.Mon.B;
  }

  // The lock screen: a window of the LockApp program, in front of everything.
  static bool Locked(IntPtr h) {
    var sb = new StringBuilder(64);
    GetClassName(h, sb, 64);
    var c = sb.ToString();
    if (c == "LockApp" || c == "Windows.UI.Core.CoreWindow") return true;
    var tb = new StringBuilder(128);
    GetWindowText(h, tb, 128);
    return tb.ToString().StartsWith("Windows Default Lock Screen");
  }

  static readonly object OutLock = new object();
  static void Say(string line) {
    lock (OutLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  static int Main(string[] args) {
    SetProcessDPIAware(); // real pixels, so window and monitor sizes compare exactly
    int own = args.Length > 0 ? int.Parse(args[0]) : 0;
    var done = new ManualResetEvent(false);

    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (!line.StartsWith("set ")) continue;
        long v;
        if (!long.TryParse(line.Substring(4), out v)) continue;
        var h = new IntPtr(v);
        if (IsWindow(h) && !IsIconic(h)) {
          // A synthetic Alt tap lifts Windows' foreground lock for SetForegroundWindow.
          keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0);
          SetForegroundWindow(h);
        }
      }
      done.Set();
    });
    reader.IsBackground = true;
    reader.Start();

    long last = 0;
    bool wasFull = false;
    bool wasLocked = false;
    while (!done.WaitOne(120)) {
      var fg = GetForegroundWindow();
      if (fg == IntPtr.Zero) continue;
      int pid;
      GetWindowThreadProcessId(fg, out pid);
      if (pid == own) continue;
      if (fg.ToInt64() != last) { last = fg.ToInt64(); Say("fg " + last); }
      bool full = Full(fg);
      if (full != wasFull) { wasFull = full; Say("full " + (full ? 1 : 0)); }
      bool locked = Locked(fg);
      if (locked != wasLocked) { wasLocked = locked; Say("lock " + (locked ? 1 : 0)); }
    }
    return 0;
  }
}
