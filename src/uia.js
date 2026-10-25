// Windows UI Automation helpers, used as hints next to screenshots (vision stays the way
// Island sees the screen):
//  - focused(): which control has keyboard focus, reported with every screenshot
//  - find():    the real control behind a lesson target, so the spotlight snaps to it and
//               a step naming something that isn't on screen can be caught
//  - at():      a control's state after the learner acted (e.g. Bold toggled on)
// Runs in its own long-lived PowerShell so a slow or hung app can never stall input.
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
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Runtime.InteropServices;

public static class U {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} }

  static string J(string s) {
    if (s == null) return "\\"\\"";
    var b = new StringBuilder("\\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\\\') { b.Append('\\\\'); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  // Like J, but keeps line breaks (typed text). Word ends paragraphs with \\r alone.
  static string JT(string s) {
    var b = new StringBuilder("\\"");
    char prev = ' ';
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\\\') { b.Append('\\\\'); b.Append(c); }
      else if (c == '\\n' && prev == '\\r') { }
      else if (c == '\\n' || c == '\\r' || c == '\\v') b.Append("\\\\n");
      else if (c == '\\t') b.Append("\\\\t");
      else if (c < 32) b.Append(' ');
      else b.Append(c);
      prev = c;
    }
    return b.Append('"').ToString();
  }

  static string El(AutomationElement e) {
    var c = e.Current;
    Rect r = c.BoundingRectangle;
    string toggle = "", expanded = "", selected = "", value = "";
    object p;
    try { if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) toggle = ((TogglePattern)p).Current.ToggleState.ToString(); } catch {}
    try { if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) expanded = ((ExpandCollapsePattern)p).Current.ExpandCollapseState.ToString(); } catch {}
    try { if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) selected = ((SelectionItemPattern)p).Current.IsSelected ? "true" : "false"; } catch {}
    bool hasValue = false;
    try { if (!c.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { value = ((ValuePattern)p).Current.Value; hasValue = true; } } catch {}
    try { if (!hasValue && !c.IsPassword && e.TryGetCurrentPattern(TextPattern.Pattern, out p)) { value = ((TextPattern)p).DocumentRange.GetText(120); hasValue = true; } } catch {}
    if (value != null && value.Length > 80) value = value.Substring(0, 80);
    string rect = r.IsEmpty ? "null" : "[" + (int)r.Left + "," + (int)r.Top + "," + (int)r.Right + "," + (int)r.Bottom + "]";
    return "{\\"name\\":" + J(c.Name) + ",\\"type\\":" + J(c.ControlType.ProgrammaticName.Replace("ControlType.", "")) + ",\\"rect\\":" + rect +
      ",\\"toggle\\":" + J(toggle) + ",\\"expanded\\":" + J(expanded) + ",\\"selected\\":" + J(selected) + ",\\"value\\":" + J(value) + ",\\"password\\":" + (c.IsPassword ? "true" : "false") + "}";
  }

  // ---- hit testing that looks past Island's own windows (its lesson card sits on top) ----

  static IntPtr TopWindowAt(int x, int y, int skipPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      if (pid == skipPid) return true;
      if ((GetWindowLong(h, -20) & 0x20) != 0) return true; // click-through overlays (WS_EX_TRANSPARENT)
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r; if (!GetWindowRect(h, out r) || x < r.L || x >= r.R || y < r.T || y >= r.B) return true;
      found = h;
      return false; // z-order: the first hit is the window on top
    }, IntPtr.Zero);
    return found;
  }

  static int Pid(AutomationElement e) { try { return e.Current.ProcessId; } catch { return -1; } }

  // The deepest control under (x, y) inside a window, by walking its tree.
  static AutomationElement Descend(AutomationElement root, int x, int y) {
    var walker = TreeWalker.ControlViewWalker;
    var pt = new Point(x, y);
    var cur = root;
    for (int depth = 0; depth < 40 && cur != null; depth++) {
      AutomationElement next = null;
      double best = double.MaxValue;
      int n = 0;
      try {
        for (var ch = walker.GetFirstChild(cur); ch != null && n < 400; ch = walker.GetNextSibling(ch), n++) {
          try {
            var c = ch.Current;
            Rect r = c.BoundingRectangle;
            if (r.IsEmpty || c.IsOffscreen || !r.Contains(pt)) continue;
            double area = r.Width * r.Height;
            if (area < best) { best = area; next = ch; }
          } catch {}
        }
      } catch {}
      if (next == null) break;
      cur = next;
    }
    return cur;
  }

  static AutomationElement Hit(int x, int y, int skipPid) {
    AutomationElement e = null;
    try { e = AutomationElement.FromPoint(new Point(x, y)); } catch {}
    if (e != null && Pid(e) != skipPid) return e;
    var h = TopWindowAt(x, y, skipPid);
    if (h == IntPtr.Zero) return null;
    try { return Descend(AutomationElement.FromHandle(h), x, y); } catch { return null; }
  }

  public static string Focus() {
    var e = AutomationElement.FocusedElement;
    return e == null ? "null" : El(e);
  }

  public static string At(int x, int y, int skipPid) {
    var e = Hit(x, y, skipPid);
    return e == null ? "null" : El(e);
  }

  // Like At, but browsers and web apps answer "the page" for any point: walk down to the
  // actual button or box there (recording what the user clicked).
  public static string AtDeep(int x, int y, int skipPid) {
    var e = Hit(x, y, skipPid);
    if (e == null) return "null";
    try {
      var ct = e.Current.ControlType;
      if (ct == ControlType.Document || ct == ControlType.Pane || ct == ControlType.Window || ct == ControlType.Group || ct == ControlType.Custom) {
        var d = Descend(e, x, y);
        if (d != null) e = d;
      }
    } catch {}
    // A bare text label inside a button or link: the button is what was clicked.
    try {
      var ct = e.Current.ControlType;
      if (ct == ControlType.Text || ct == ControlType.Image) {
        var p = TreeWalker.ControlViewWalker.GetParent(e);
        if (p != null) {
          var pt = p.Current.ControlType;
          if (pt == ControlType.Button || pt == ControlType.Hyperlink || pt == ControlType.MenuItem || pt == ControlType.ListItem || pt == ControlType.TabItem || pt == ControlType.TreeItem || pt == ControlType.CheckBox || pt == ControlType.RadioButton) e = p;
        }
      }
    } catch {}
    return El(e);
  }

  // ---- matching a lesson target to a real control ----

  static string Norm(string s) {
    s = (s ?? "").ToLowerInvariant().Replace("colour", "color");
    var b = new StringBuilder();
    foreach (char c in s) b.Append(char.IsLetterOrDigit(c) ? c : ' ');
    return string.Join(" ", b.ToString().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
  }

  // 100 same name; 80 one name starts the other at a word boundary; 60 one contains the
  // other and they are of similar length. Sharing a word or two is not a match: that is
  // how "Title 1" used to land on "Slide 1 of 1".
  static int Score(string name, string want) {
    string n = Norm(name), w = Norm(want);
    if (n.Length == 0 || w.Length == 0) return 0;
    if (n == w) return 100;
    if (n.StartsWith(w + " ") || w.StartsWith(n + " ")) return Math.Min(n.Length, w.Length) * 2 >= Math.Max(n.Length, w.Length) ? 80 : 0;
    string shortS = n.Length < w.Length ? n : w, longS = n.Length < w.Length ? w : n;
    if (shortS.Length >= 4 && longS.Contains(shortS) && shortS.Length * 2 >= longS.Length) return 60;
    return 0;
  }

  static double Dist(Rect r, int x, int y) {
    double dx = x < r.Left ? r.Left - x : x > r.Right ? x - r.Right : 0;
    double dy = y < r.Top ? r.Top - y : y > r.Bottom ? y - r.Bottom : 0;
    return Math.Sqrt(dx * dx + dy * dy);
  }

  // Best control for want near (x, y). A match must be close to where the model pointed
  // (maxDist; an exact name may be a little further), so a same-named control elsewhere
  // in the window never gets the spotlight.
  public static string Find(int x, int y, bool hasPoint, string want, int radius, double screenArea, int skipPid, int maxDist) {
    var seen = new HashSet<string>();
    var list = new List<AutomationElement>();
    var walker = TreeWalker.ControlViewWalker;
    Action<AutomationElement> add = (e) => {
      if (e == null || Pid(e) == skipPid) return;
      try { if (seen.Add(string.Join(",", e.GetRuntimeId()))) list.Add(e); } catch {}
    };
    Action<AutomationElement> addWithParents = (e) => {
      add(e);
      var p = e;
      for (int i = 0; i < 2 && p != null; i++) {
        try { p = walker.GetParent(p); } catch { p = null; }
        if (p == null || p == AutomationElement.RootElement) break;
        add(p);
      }
    };

    AutomationElement best = null;
    int bestScore = 0;
    double bestDist = 1e9, bestArea = 1e18;
    Action<AutomationElement> consider = (e) => {
      try {
        if (Pid(e) == skipPid) return;
        var c = e.Current;
        Rect r = c.BoundingRectangle;
        if (r.IsEmpty || r.Width < 2 || r.Height < 2 || c.IsOffscreen) return;
        double area = r.Width * r.Height;
        int s = want.Length > 0 ? Score(c.Name, want) : 50;
        if (s == 0) return;
        if (area > screenArea * 0.35 && s < 100) return; // a whole pane is not "the button"
        double d = hasPoint ? Dist(r, x, y) : 0;
        if (hasPoint && d > (s == 100 ? maxDist * 2 : maxDist)) return;
        if (s > bestScore || (s == bestScore && (d < bestDist - 4 || (Math.Abs(d - bestDist) <= 4 && area < bestArea)))) {
          best = e; bestScore = s; bestDist = d; bestArea = area;
        }
      } catch {}
    };

    IntPtr topH = IntPtr.Zero;
    if (hasPoint) {
      topH = TopWindowAt(x, y, skipPid);
      addWithParents(Hit(x, y, skipPid));
      foreach (var e in list.ToArray()) consider(e);
      bool done = want.Length == 0 || bestScore == 100;
      int step = Math.Max(8, radius / 3);
      for (int dy = -radius; dy <= radius && !done; dy += step) {
        for (int dx = -radius; dx <= radius; dx += step) {
          var e = Hit(x + dx, y + dy, skipPid);
          int before = list.Count;
          addWithParents(e);
          for (int i = before; i < list.Count; i++) consider(list[i]);
        }
      }
    } else {
      return FindApp(want, skipPid, screenArea);
    }

    AutomationElement top = null;
    try { if (topH != IntPtr.Zero) top = AutomationElement.FromHandle(topH); } catch {}
    if (want.Length > 0 && bestScore < 60 && top != null) {
      var variants = new HashSet<string> { want, want.Replace("colour", "color").Replace("Colour", "Color"), want.Replace("color", "colour").Replace("Color", "Colour") };
      foreach (var v in variants) {
        try {
          var cond = new PropertyCondition(AutomationElement.NameProperty, v, PropertyConditionFlags.IgnoreCase);
          foreach (AutomationElement e in top.FindAll(TreeScope.Descendants, cond)) { add(e); consider(e); }
        } catch {}
      }
    }
    if (want.Length > 0 && bestScore < 60 && top != null) {
      var queue = new Queue<AutomationElement>();
      queue.Enqueue(top);
      int visited = 0;
      var sw = System.Diagnostics.Stopwatch.StartNew();
      while (queue.Count > 0 && visited < 3000 && sw.ElapsedMilliseconds < 1200) {
        var e = queue.Dequeue();
        visited++;
        try {
          add(e);
          consider(e);
          for (var ch = walker.GetFirstChild(e); ch != null; ch = walker.GetNextSibling(ch)) queue.Enqueue(ch);
        } catch {}
      }
    }

    // A split button ("New Slide") is two parts; spotlight the main part, not the arrow.
    if (best != null) {
      try {
        for (var ch = walker.GetFirstChild(best); ch != null; ch = walker.GetNextSibling(ch)) {
          var c = ch.Current;
          Rect r = c.BoundingRectangle;
          if (!r.IsEmpty && !c.IsOffscreen && Score(c.Name, want.Length > 0 ? want : best.Current.Name) >= Math.Max(bestScore, 80) && r.Width * r.Height < bestArea) {
            best = ch; bestArea = r.Width * r.Height;
            break;
          }
        }
      } catch {}
    }

    // Named, button-sized things near the point, nearest first: what is really there.
    var near = new List<KeyValuePair<double, string>>();
    var names = new HashSet<string>();
    foreach (var e in list) {
      try {
        var c = e.Current;
        Rect r = c.BoundingRectangle;
        if (r.IsEmpty || c.IsOffscreen || string.IsNullOrWhiteSpace(c.Name) || r.Width * r.Height > screenArea * 0.1) continue;
        var ct = c.ControlType;
        if (ct == ControlType.Window || ct == ControlType.Pane || ct == ControlType.TitleBar || ct == ControlType.Group) continue;
        double d = hasPoint ? Dist(r, x, y) : 0;
        if (hasPoint && d > radius * 1.5) continue;
        string label = ct.ProgrammaticName.Replace("ControlType.", "") + " \\"" + c.Name.Trim() + "\\"";
        if (label.Length > 70 || !names.Add(label)) continue;
        near.Add(new KeyValuePair<double, string>(d, label));
      } catch {}
    }
    near.Sort((p, q) => p.Key.CompareTo(q.Key));
    var sb = new StringBuilder("[");
    for (int i = 0; i < near.Count && i < 14; i++) { if (i > 0) sb.Append(','); sb.Append(J(near[i].Value)); }
    sb.Append(']');
    return "{\\"match\\":" + (best == null ? "null" : El(best)) + ",\\"score\\":" + bestScore + ",\\"nearby\\":" + sb.ToString() + "}";
  }

  // ---- the app the learner is using: all its top-level windows (menus and popups are separate windows) ----

  static List<IntPtr> AppWindows(int skipPid) {
    int appPid = -1;
    IntPtr fg = GetForegroundWindow();
    if (fg != IntPtr.Zero) { int p; GetWindowThreadProcessId(fg, out p); if (p != skipPid) appPid = p; }
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int p; GetWindowThreadProcessId(h, out p);
      if (p == skipPid) return true;
      if ((GetWindowLong(h, -20) & 0x20) != 0) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      if (appPid == -1) appPid = p; // Island has focus: the topmost other window is the app
      if (p == appPid) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // A control by name anywhere in the app (no point to search around): menus that just
  // opened, a dialog, a button on a tab the learner just switched to.
  public static string FindApp(string want, int skipPid, double screenArea) {
    AutomationElement best = null;
    int bestScore = 0;
    double bestArea = 1e18;
    var walker = TreeWalker.ControlViewWalker;
    var variants = new HashSet<string> { want, want.Replace("colour", "color").Replace("Colour", "Color"), want.Replace("color", "colour").Replace("Color", "Colour") };
    var sw = System.Diagnostics.Stopwatch.StartNew();
    Action<AutomationElement> consider = (e) => {
      try {
        var c = e.Current;
        Rect r = c.BoundingRectangle;
        if (r.IsEmpty || r.Width < 2 || r.Height < 2 || c.IsOffscreen) return;
        int s = Score(c.Name, want);
        double area = r.Width * r.Height;
        if (s == 0 || (area > screenArea * 0.35 && s < 100)) return;
        if (s > bestScore || (s == bestScore && area < bestArea)) { best = e; bestScore = s; bestArea = area; }
      } catch {}
    };
    var tops = AppWindows(skipPid);
    foreach (var h in tops) {
      AutomationElement top;
      try { top = AutomationElement.FromHandle(h); } catch { continue; }
      foreach (var v in variants) {
        try {
          var cond = new PropertyCondition(AutomationElement.NameProperty, v, PropertyConditionFlags.IgnoreCase);
          foreach (AutomationElement e in top.FindAll(TreeScope.Descendants, cond)) consider(e);
        } catch {}
      }
      if (bestScore == 100 || sw.ElapsedMilliseconds > 1500) break;
    }
    if (bestScore < 60) {
      // looser names: a bounded walk of the app's windows
      foreach (var h in tops) {
        if (sw.ElapsedMilliseconds > 2000) break;
        AutomationElement top;
        try { top = AutomationElement.FromHandle(h); } catch { continue; }
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(top);
        int visited = 0;
        while (queue.Count > 0 && visited < 2500 && sw.ElapsedMilliseconds < 2000) {
          var e = queue.Dequeue();
          visited++;
          try {
            consider(e);
            for (var ch = walker.GetFirstChild(e); ch != null; ch = walker.GetNextSibling(ch)) queue.Enqueue(ch);
          } catch {}
        }
      }
    }
    return "{\\"match\\":" + (best == null ? "null" : El(best)) + ",\\"score\\":" + bestScore + "}";
  }

  public static string Foreground(int skipPid) {
    var tops = AppWindows(skipPid);
    if (tops.Count == 0) return "null";
    try {
      var e = AutomationElement.FromHandle(tops[0]);
      return "{\\"name\\":" + J(e.Current.Name) + "}";
    } catch { return "null"; }
  }

  // ---- precise clicks: a click that lands just beside a control goes onto it ----

  static bool Clickable(ControlType ct) {
    return ct == ControlType.Button || ct == ControlType.SplitButton || ct == ControlType.MenuItem || ct == ControlType.TabItem || ct == ControlType.ListItem ||
      ct == ControlType.CheckBox || ct == ControlType.RadioButton || ct == ControlType.Hyperlink || ct == ControlType.Edit || ct == ControlType.ComboBox ||
      ct == ControlType.TreeItem || ct == ControlType.DataItem;
  }

  public static string Snap(int x, int y, int radius, int skipPid, double screenArea) {
    var e = Hit(x, y, skipPid);
    if (e == null) return "{\\"moved\\":false}";
    try {
      var c = e.Current;
      Rect r = c.BoundingRectangle;
      double area = r.IsEmpty ? 0 : r.Width * r.Height;
      // On a control already: leave it. In a big content area (a slide, a canvas) too. A web
      // page is one big Document, and near-misses on its buttons land there, so pages do
      // snap, just within a tighter radius.
      if (Clickable(c.ControlType)) return "{\\"moved\\":false}";
      if (c.ControlType == ControlType.Document) radius = radius * 2 / 3;
      else if (area > screenArea * 0.15) return "{\\"moved\\":false}";
    } catch { return "{\\"moved\\":false}"; }
    AutomationElement best = null;
    double bestD = 1e9;
    Rect bestR = Rect.Empty;
    for (int ring = 1; ring <= 3; ring++) {
      int rr = radius * ring / 3;
      for (int k = 0; k < 8; k++) {
        double a = k * Math.PI / 4;
        var h = Hit(x + (int)(Math.Cos(a) * rr), y + (int)(Math.Sin(a) * rr), skipPid);
        if (h == null) continue;
        try {
          var c = h.Current;
          Rect r = c.BoundingRectangle;
          if (r.IsEmpty || c.IsOffscreen || !Clickable(c.ControlType) || r.Width * r.Height > screenArea * 0.02) continue;
          double d = Dist(r, x, y);
          if (d < bestD) { bestD = d; best = h; bestR = r; }
        } catch {}
      }
      if (best != null) break; // nearest ring wins
    }
    if (best == null || bestD > radius) return "{\\"moved\\":false}";
    string label = "";
    try { label = best.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") + " \\"" + best.Current.Name + "\\""; } catch {}
    // Land on the nearest point of the control, not on its middle: a click aimed 10px
    // beside a wide button must not jump to the far side of it.
    double nx = x < bestR.Left ? bestR.Left : (x > bestR.Right ? bestR.Right : x);
    double ny = y < bestR.Top ? bestR.Top : (y > bestR.Bottom ? bestR.Bottom : y);
    if (nx < bestR.Left) nx = bestR.Left; if (nx > bestR.Right) nx = bestR.Right;
    if (ny < bestR.Top) ny = bestR.Top; if (ny > bestR.Bottom) ny = bestR.Bottom;
    return "{\\"moved\\":true,\\"x\\":" + (int)nx + ",\\"y\\":" + (int)ny + ",\\"dist\\":" + (int)bestD + ",\\"label\\":" + J(label) + "}";
  }

  // What the learner is typing: the paragraph around the caret (Word, rich editors) or the
  // field's value (text boxes).
  public static string Caret() {
    var e = AutomationElement.FocusedElement;
    if (e == null) return "null";
    string text = null, src = "";
    object p;
    try {
      if (e.TryGetCurrentPattern(TextPattern.Pattern, out p)) {
        var tp = (TextPattern)p;
        var sel = tp.GetSelection();
        TextPatternRange r = sel != null && sel.Length > 0 ? sel[0].Clone() : tp.DocumentRange;
        r.ExpandToEnclosingUnit(TextUnit.Paragraph);
        text = r.GetText(400);
        src = "paragraph";
      }
    } catch {}
    if (text == null) {
      try { if (!e.Current.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { text = ((ValuePattern)p).Current.Value; src = "value"; } } catch {}
    }
    if (text == null) return "null";
    if (text.Length > 400) text = text.Substring(text.Length - 400);
    string name = "";
    try { name = e.Current.Name; } catch {}
    return "{\\"text\\":" + J(text) + ",\\"source\\":" + J(src) + ",\\"name\\":" + J(name) + "}";
  }

  // The focused control and ALL its text (a field's value, or a document's text), for
  // recording what the user typed. Password fields report no text.
  public static string Typed() {
    var e = AutomationElement.FocusedElement;
    if (e == null) return "null";
    string text = null;
    bool pw = false;
    object p;
    try { pw = e.Current.IsPassword; } catch {}
    if (!pw) {
      try { if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) text = ((ValuePattern)p).Current.Value; } catch {}
      if (text == null) { try { if (e.TryGetCurrentPattern(TextPattern.Pattern, out p)) text = ((TextPattern)p).DocumentRange.GetText(20000); } catch {} }
    }
    string name = "", type = "", rect = "null";
    int pid = -1;
    try {
      var c = e.Current;
      name = c.Name;
      pid = c.ProcessId;
      type = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
      Rect r = c.BoundingRectangle;
      if (!r.IsEmpty) rect = "[" + (int)r.Left + "," + (int)r.Top + "," + (int)r.Right + "," + (int)r.Bottom + "]";
    } catch {}
    return "{\\"name\\":" + J(name) + ",\\"type\\":" + J(type) + ",\\"pid\\":" + pid + ",\\"rect\\":" + rect + ",\\"password\\":" + (pw ? "true" : "false") + ",\\"text\\":" + (text == null ? "null" : JT(text)) + "}";
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  // How far down the page in front is scrolled, and how much of it shows:
  // { pct: 0..100 (-1 = can't scroll), view: % of the page visible }
  public static string ScrollInfo(int skipPid) {
    var root = AppRoot(skipPid, 0);
    if (root == null) return "null";
    AutomationElement doc = null;
    try { doc = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document)); } catch {}
    if (doc == null) {
      // A browser builds the page's tree only once something asks: ask again shortly.
      System.Threading.Thread.Sleep(400);
      try { doc = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document)); } catch {}
    }
    var walker = TreeWalker.ControlViewWalker;
    var cur = doc ?? root;
    for (int i = 0; i < 4 && cur != null; i++) {
      try {
        object p;
        if (cur.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) {
          var sp = (ScrollPattern)p;
          if (sp.Current.VerticallyScrollable) {
            return "{\\"pct\\":" + Math.Round(sp.Current.VerticalScrollPercent).ToString() + ",\\"view\\":" + Math.Round(sp.Current.VerticalViewSize).ToString() + "}";
          }
          return "{\\"pct\\":-1,\\"view\\":100}";
        }
      } catch {}
      try { cur = walker.GetParent(cur); } catch { cur = null; }
    }
    return "null";
  }

  // ---- words anywhere on the app's screen (web pages too), and a whole page's text ----

  // The app's main window: the front one, unless that is a small popup.
  static AutomationElement AppRoot(int skipPid, long hwnd) {
    if (hwnd != 0) { try { return AutomationElement.FromHandle(new IntPtr(hwnd)); } catch { return null; } }
    var tops = AppWindows(skipPid);
    IntPtr pick = IntPtr.Zero;
    long bestA = -1;
    for (int i = 0; i < tops.Count; i++) {
      RECT r; GetWindowRect(tops[i], out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (i == 0 && r.R - r.L > 300 && r.B - r.T > 200) { pick = tops[0]; break; }
      if (a > bestA) { bestA = a; pick = tops[i]; }
    }
    if (pick == IntPtr.Zero) return null;
    try { return AutomationElement.FromHandle(pick); } catch { return null; }
  }

  // Everything under root in reading order, with the few properties we need fetched in one go.
  // The taskbar on each screen.
  static List<IntPtr> TrayWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      var cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      string s = cls.ToString();
      if ((s == "Shell_TrayWnd" || s == "Shell_SecondaryTrayWnd") && IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static AutomationElementCollection AllUnder(AutomationElement root, bool retry) {
    var cr = new CacheRequest();
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.IsOffscreenProperty);
    AutomationElementCollection all;
    using (cr.Activate()) { all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition); }
    // Browsers build a page's tree only once something asks for it: ask again shortly.
    if (retry && all.Count < 40) {
      System.Threading.Thread.Sleep(700);
      using (cr.Activate()) { all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition); }
    }
    return all;
  }

  // Lowercase, punctuation as spaces; keeps Hindi vowel signs (marks), unlike Norm.
  static string NormT(string s) {
    var b = new StringBuilder();
    foreach (char c in (s ?? "").ToLowerInvariant()) {
      var cat = char.GetUnicodeCategory(c);
      b.Append(char.IsLetterOrDigit(c) || cat == System.Globalization.UnicodeCategory.NonSpacingMark || cat == System.Globalization.UnicodeCategory.SpacingCombiningMark ? c : ' ');
    }
    return string.Join(" ", b.ToString().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
  }

  static bool ScrollIntoView(AutomationElement e) {
    var walker = TreeWalker.ControlViewWalker;
    var cur = e;
    for (int i = 0; i < 4 && cur != null; i++) {
      try {
        object p;
        if (cur.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { ((ScrollItemPattern)p).ScrollIntoView(); return true; }
      } catch {}
      try { cur = walker.GetParent(cur); } catch { cur = null; }
    }
    return false;
  }

  public static string FindText(string want, int skipPid, bool scroll, double screenArea, long hwnd) {
    var root = AppRoot(skipPid, hwnd);
    string w = NormT(want);
    if (root == null || w.Length == 0) return "{\\"matches\\":[],\\"scrolled\\":false}";
    var all = AllUnder(root, true);
    var hits = new List<KeyValuePair<int, AutomationElement>>();
    var bar = new HashSet<AutomationElement>(); // matches on the taskbar (Start, Search, app buttons, tray)
    int order = 0;
    Action<AutomationElementCollection, bool> scan = (coll, isBar) => {
    foreach (AutomationElement e in coll) {
      order++;
      string name;
      try { name = e.Cached.Name; } catch { continue; }
      if (string.IsNullOrEmpty(name) || name.Length > 2000) continue;
      string n = NormT(name);
      int s;
      if (n == w) s = 100;
      else if ((" " + n + " ").Contains(" " + w + " ")) s = 80;
      else if (n.Contains(w)) s = 60;
      else continue;
      try {
        Rect r = e.Cached.BoundingRectangle;
        var ct = e.Cached.ControlType;
        if (ct == ControlType.Window || ct == ControlType.TitleBar || (!r.IsEmpty && r.Width * r.Height > screenArea * 0.4)) s -= 40; // the window title, not the word
        if (Clickable(ct)) s += 5;
        if (!e.Cached.IsOffscreen && !r.IsEmpty) s += 10;
      } catch {}
      hits.Add(new KeyValuePair<int, AutomationElement>(s * 100000 - order, e));
      if (isBar) bar.Add(e);
    }
    };
    scan(all, false);
    if (hits.Count == 0) {
      // Nothing yet: a browser may still be building the page's tree (it starts when first asked).
      System.Threading.Thread.Sleep(900);
      scan(AllUnder(root, true), false);
    }
    // The taskbar is its own window, never "the app in front": search it too.
    if (hwnd == 0) {
      foreach (var h in TrayWindows()) {
        try { scan(AllUnder(AutomationElement.FromHandle(h), false), true); } catch {}
      }
    }
    hits.Sort((a, b) => b.Key.CompareTo(a.Key));
    bool scrolled = false;
    if (scroll && hits.Count > 0 && !bar.Contains(hits[0].Value)) {
      var best = hits[0].Value;
      bool off = true;
      try { off = best.Current.IsOffscreen || best.Current.BoundingRectangle.IsEmpty; } catch {}
      if (off && ScrollIntoView(best)) { scrolled = true; System.Threading.Thread.Sleep(450); }
    }
    var sb = new StringBuilder("{\\"matches\\":[");
    for (int i = 0; i < hits.Count && i < 8; i++) {
      var e = hits[i].Value;
      string name = "", type = "", rect = "null";
      bool off = true;
      try {
        var c = (scrolled && i == 0) ? e.Current.Name : e.Cached.Name;
        name = c.Length > 160 ? c.Substring(0, 160) : c;
        type = e.Cached.ControlType.ProgrammaticName.Replace("ControlType.", "");
        Rect r = (scrolled && i == 0) ? e.Current.BoundingRectangle : e.Cached.BoundingRectangle;
        off = (scrolled && i == 0) ? e.Current.IsOffscreen : e.Cached.IsOffscreen;
        if (!r.IsEmpty) rect = "[" + (int)r.Left + "," + (int)r.Top + "," + (int)r.Right + "," + (int)r.Bottom + "]";
      } catch {}
      if (i > 0) sb.Append(',');
      sb.Append("{\\"name\\":" + J(name) + ",\\"type\\":" + J(type) + ",\\"rect\\":" + rect + ",\\"off\\":" + (off ? "true" : "false") + ",\\"bar\\":" + (bar.Contains(e) ? "true" : "false") + "}");
    }
    return sb.Append("],\\"scrolled\\":" + (scrolled ? "true" : "false") + "}").ToString();
  }

  public static string PageText(int skipPid, int maxChars, long hwnd) { return PageTextImpl(skipPid, maxChars, hwnd, true); }

  static string PageTextImpl(int skipPid, int maxChars, long hwnd, bool retry) {
    var root = AppRoot(skipPid, hwnd);
    if (root == null) return "null";
    string title = "";
    try { title = root.Current.Name; } catch {}
    var all = AllUnder(root, true);
    // A document that can give its text in one piece (Word, some browsers and PDF viewers).
    AutomationElement doc = null;
    double docA = 0;
    foreach (AutomationElement e in all) {
      try {
        if (e.Cached.ControlType != ControlType.Document) continue;
        Rect r = e.Cached.BoundingRectangle;
        double a = r.IsEmpty ? 1 : r.Width * r.Height;
        if (a > docA) { docA = a; doc = e; }
      } catch {}
    }
    string text = null, src = "";
    if (doc != null) {
      try { object p; if (doc.TryGetCurrentPattern(TextPattern.Pattern, out p)) { text = ((TextPattern)p).DocumentRange.GetText(maxChars); src = "document"; } } catch {}
    }
    if (text == null || text.Trim().Length < 60) {
      // Otherwise the words of everything on it, in reading order.
      var sb = new StringBuilder();
      string last = null;
      foreach (AutomationElement e in all) {
        try {
          var ct = e.Cached.ControlType;
          if (ct == ControlType.Window || ct == ControlType.Pane || ct == ControlType.TitleBar || ct == ControlType.ScrollBar || ct == ControlType.Thumb || ct == ControlType.Group || ct == ControlType.Custom || ct == ControlType.Document || ct == ControlType.ToolBar || ct == ControlType.MenuBar) continue;
          string n = (e.Cached.Name ?? "").Trim();
          if (n.Length == 0 || n == last) continue;
          last = n;
          if (ct == ControlType.Hyperlink) sb.Append("[link] ");
          else if (ct == ControlType.Button) sb.Append("[button] ");
          else if (ct == ControlType.Edit) sb.Append("[box] ");
          sb.Append(n).Append('\\n');
          if (sb.Length > maxChars) break;
        } catch {}
      }
      text = sb.ToString();
      src = "controls";
    }
    if (retry && text.Trim().Length < 60) { System.Threading.Thread.Sleep(900); return PageTextImpl(skipPid, maxChars, hwnd, false); } // a browser may still be building the page
    if (text.Length > maxChars) text = text.Substring(0, maxChars);
    return "{\\"title\\":" + J(title) + ",\\"source\\":" + J(src) + ",\\"text\\":" + JT(text) + "}";
  }

  // The app's visible top-level windows as [{h, cls}]. Cheap (no UI Automation), so it can
  // run while a menu is open: walking a menu's UI tree can make modern menus close.
  public static string Windows(int skipPid) {
    var sb = new StringBuilder("[");
    bool first = true;
    foreach (var h in AppWindows(skipPid)) {
      var cls = new StringBuilder(128);
      GetClassName(h, cls, 128);
      if (!first) sb.Append(',');
      first = false;
      int pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      sb.Append("{\\"h\\":" + h.ToInt64() + ",\\"cls\\":" + J(cls.ToString()) + ",\\"pid\\":" + pid + ",\\"area\\":" + ((long)(r.R - r.L) * (r.B - r.T)) + "}");
    }
    return sb.Append(']').ToString();
  }

  // A control by name inside specific windows only (a menu that just opened): small trees,
  // and the rest of the app is left alone.
  public static string FindIn(string want, string handles, double screenArea) {
    AutomationElement best = null;
    int bestScore = 0;
    double bestArea = 1e18;
    var walker = TreeWalker.ControlViewWalker;
    foreach (var hs in handles.Split(',')) {
      long hv;
      if (!long.TryParse(hs, out hv)) continue;
      AutomationElement top;
      try { top = AutomationElement.FromHandle(new IntPtr(hv)); } catch { continue; }
      var queue = new Queue<AutomationElement>();
      queue.Enqueue(top);
      int visited = 0;
      while (queue.Count > 0 && visited < 600) {
        var e = queue.Dequeue();
        visited++;
        try {
          var c = e.Current;
          Rect r = c.BoundingRectangle;
          int s = Score(c.Name, want);
          if (s > 0 && !r.IsEmpty && !c.IsOffscreen && r.Width * r.Height < screenArea * 0.35) {
            double area = r.Width * r.Height;
            if (s > bestScore || (s == bestScore && area < bestArea)) { best = e; bestScore = s; bestArea = area; }
          }
          for (var ch = walker.GetFirstChild(e); ch != null; ch = walker.GetNextSibling(ch)) queue.Enqueue(ch);
        } catch {}
      }
    }
    return "{\\"match\\":" + (best == null ? "null" : El(best)) + ",\\"score\\":" + bestScore + "}";
  }
}



`;

const SCRIPT = `
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
${CSHARP}
'@
[U]::Init()
$in = New-Object IO.StreamReader([Console]::OpenStandardInput())
$out = [Console]::Out
$out.WriteLine('ready'); $out.Flush()
while ($true) {
  $line = $in.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    $r = switch ($p[1]) {
      'focus' { [U]::Focus() }
      'at' { [U]::At([int]$p[2], [int]$p[3], [int]$p[4]) }
      'atdeep' { [U]::AtDeep([int]$p[2], [int]$p[3], [int]$p[4]) }
      'snap' { [U]::Snap([int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], [double]$p[6]) }
      'fgname' { [U]::Foreground([int]$p[2]) }
      'caret' { [U]::Caret() }
      'typed' { [U]::Typed() }
      'scrollinfo' { [U]::ScrollInfo([int]$p[2]) }
      'findtext' { $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])) | ConvertFrom-Json; [U]::FindText([string]$q.text, [int]$q.skipPid, [bool]$q.scroll, [double]$q.screenArea, [long]$q.hwnd) }
      'pagetext' { [U]::PageText([int]$p[2], [int]$p[3], [long]$p[4]) }
      'wins' { [U]::Windows([int]$p[2]) }
      'findin' { $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])) | ConvertFrom-Json; [U]::FindIn([string]$q.name, [string]$q.handles, [double]$q.screenArea) }
      'find' {
        $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])) | ConvertFrom-Json
        [U]::Find([int]$q.x, [int]$q.y, [bool]$q.hasPoint, [string]$q.name, [int]$q.radius, [double]$q.screenArea, [int]$q.skipPid, [int]$q.maxDist)
      }
    }
    $out.WriteLine($p[0] + ' ok ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($r)))
  } catch {
    $out.WriteLine($p[0] + ' err')
  }
  $out.Flush()
}
`;

function createUia() {
  let child = null;
  let ready = null;
  let seq = 0;
  let buf = '';
  const waiting = new Map();
  const reaper = idleReaper(HELPER_IDLE_MS, { busy: () => waiting.size > 0, stop: () => kill() });

  // The script is too long for a command line (Windows caps those at ~32K chars), so it
  // runs from a file, named by its content so a new version never reuses an old one.
  function scriptFile() {
    const file = path.join(os.tmpdir(), `island-uia-${crypto.createHash('sha1').update(SCRIPT).digest('hex').slice(0, 12)}.ps1`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '\uFEFF' + SCRIPT, 'utf8'); // BOM: PowerShell 5 reads it as UTF-8
    return file;
  }

  function start() {
    let readyOk;
    ready = new Promise((resolve) => { readyOk = resolve; waiting.set('ready', resolve); });
    // The compiled helper (~12 MB) if it's there, else the same C# run through PowerShell (~70 MB).
    let exe;
    try {
      ({ child, exe } = spawnHelper('island-uia.exe', { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile()] }));
    } catch {
      child = null; // hints are optional; computer use and lessons carry on without them
      waiting.get('ready')?.();
      waiting.delete('ready');
      return;
    }
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') { waiting.get('ready')?.(); waiting.delete('ready'); continue; }
        const [id, status, b64] = line.split(' ');
        const w = waiting.get(id);
        if (!w) continue;
        waiting.delete(id);
        try { w(status === 'ok' ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null); } catch { w(null); }
      }
    });
    // The program couldn't start (e.g. blocked by antivirus): carry on with PowerShell.
    child.on('error', () => {
      child = null;
      if (!exe) return readyOk();
      helperFailed('island-uia.exe');
      start();
      ready.then(readyOk);
    });
    child.on('exit', () => {
      child = null;
      for (const [, w] of waiting) w(null);
      waiting.clear();
    });
  }

  function kill() {
    try { child?.kill(); } catch {}
    child = null;
  }

  // One request; null on error or timeout (a hung app gets the helper restarted).
  async function ask(args, timeoutMs) {
    reaper.touch();
    if (!child) start();
    const ok = await Promise.race([ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]);
    if (!ok || !child) return null;
    const id = String(++seq);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        waiting.delete(id);
        kill();
        resolve(null);
      }, timeoutMs);
      waiting.set(id, (v) => { clearTimeout(t); resolve(v); });
      child.stdin.write(`${id} ${args}\n`);
    });
  }

  return {
    start: () => { if (!child) start(); reaper.touch(); },
    stop: kill,
    focused: () => ask('focus', 450),
    // a click just beside a control -> { moved, x, y, dist, label } (physical pixels)
    snap: (x, y, radius, screenArea) => ask(`snap ${Math.round(x)} ${Math.round(y)} ${Math.round(radius)} ${process.pid} ${Math.round(screenArea)}`, 1500),
    // the app's top-level windows [{ h, cls }]: a new one after a click = a menu or popup opened
    windows: () => ask(`wins ${process.pid}`, 800),
    // a control by name inside the given windows only (e.g. a menu that just opened)
    findIn: (name, handles, screenArea) => ask(`findin ${Buffer.from(JSON.stringify({ name: String(name).slice(0, 80), handles: handles.join(','), screenArea })).toString('base64')}`, 2000),
    // the text around the caret, as the learner types: { text, source }
    caret: () => ask('caret', 900),
    // the focused control with all its text: { name, type, rect, password, text | null }
    typed: () => ask('typed', 1200),
    // how far down the page in front is scrolled: { pct, view } (pct -1 = doesn't scroll)
    scrollInfo: () => ask(`scrollinfo ${process.pid}`, 1500),
    // a word or phrase anywhere in the front app (offscreen too); scroll: bring the best into view
    // -> { matches: [{ name, type, rect, off }], scrolled }
    findText: (text, screenArea, scroll = true, hwnd = 0) => ask(`findtext ${Buffer.from(JSON.stringify({ text: String(text).slice(0, 200), skipPid: process.pid, scroll, screenArea, hwnd: Number(hwnd) || 0 })).toString('base64')}`, 9000),
    // the front app's whole text (a web page below the fold too): { title, source, text }
    pageText: (maxChars = 20000, hwnd = 0) => ask(`pagetext ${process.pid} ${Math.round(maxChars)} ${Number(hwnd) || 0}`, 9000),
    // title of the app window the learner is in (looking past Island)
    appTitle: () => ask(`fgname ${process.pid}`, 800),
    at: (x, y) => ask(`at ${Math.round(x)} ${Math.round(y)} ${process.pid}`, 1500),
    // the actual control at a point, looking inside web pages too
    atDeep: (x, y) => ask(`atdeep ${Math.round(x)} ${Math.round(y)} ${process.pid}`, 2000),
    // { match: element | null, score, nearby: ['Button "Bold"', ...] }; coordinates are physical pixels
    // skipPid: Island's own windows (the lesson card) are looked past, never matched
    find: ({ x, y, name = '', radius = 60, maxDist = 120, screenArea }) =>
      ask(`find ${Buffer.from(JSON.stringify({ x: Math.round(x || 0), y: Math.round(y || 0), hasPoint: Number.isFinite(x), name: String(name).slice(0, 80), radius: Math.round(radius), maxDist: Math.round(maxDist), screenArea, skipPid: process.pid })).toString('base64')}`, 3000),
  };
}

// "Edit "Search" containing "airport"": a short line for the model.
function describeFocus(f) {
  if (!f || !f.type) return null;
  const name = String(f.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  let s = `${f.type}${name ? ` "${name}"` : ''}`;
  if (f.password) s += ' (password field)';
  else if (typeof f.value === 'string' && /edit|combobox|document|dataitem/i.test(f.type)) {
    const v = f.value.replace(/\s+/g, ' ');
    s += v ? ` containing "${v.length > 80 ? v.slice(0, 80) + '…' : v}"` : ' (empty)';
  }
  return s;
}

// A control's state in words: "Button "Bold", on" / "TabItem "Home", selected".
function describeElement(e) {
  if (!e || !e.type) return null;
  const parts = [`${e.type}${e.name ? ` "${String(e.name).trim().slice(0, 60)}"` : ''}`];
  if (e.toggle) parts.push(e.toggle === 'On' ? 'switched on' : e.toggle === 'Off' ? 'switched off' : e.toggle.toLowerCase());
  if (e.expanded && e.expanded !== 'LeafNode') parts.push(e.expanded === 'Expanded' ? 'open' : e.expanded === 'Collapsed' ? 'closed' : e.expanded.toLowerCase());
  if (e.selected === 'true') parts.push('selected');
  if (e.value) parts.push(`value "${String(e.value).slice(0, 60)}"`);
  return parts.join(', ');
}

module.exports = { createUia, describeFocus, describeElement, CSHARP };
