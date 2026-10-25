// Compiles Island's native helpers with the C# compiler that ships with Windows (.NET
// Framework 4.x), so building needs nothing extra installed. Output goes to helpers/, which the
// installer copies next to the app (see "extraResources" in package.json).
//   island-focus.exe  tracks the window in front (src/helpers/focus-helper.cs)
//   island-input.exe  mouse and keyboard for computer use (C# from src/input.js)
//   island-uia.exe    reads other apps' controls via UI Automation (C# from src/uia.js)
//   island-tts.exe    speaks with Windows' voices (src/helpers/tts-helper.cs)
// Each was a PowerShell process of ~70-80 MB; compiled they use about 12 MB. The C# for input
// and UIA stays in the .js files (also the PowerShell fallback); only the read loop is added here.
// Run: node scripts/build-helpers.js   (also runs before every installer build)
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'helpers');
const NET = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(NET, 'csc.exe');

// Same protocol as the PowerShell loops: "ready", then "<id> <cmd> ..." -> "<id> ok|err ...".
const INPUT_MAIN = `
static class InputMain {
  static int Main() {
    Inp.Init();
    var stdout = new System.IO.StreamWriter(System.Console.OpenStandardOutput()) { AutoFlush = true };
    var stdin = new System.IO.StreamReader(System.Console.OpenStandardInput());
    stdout.WriteLine("ready");
    string line;
    while ((line = stdin.ReadLine()) != null) {
      var p = line.Split(' ');
      try { stdout.WriteLine(p[0] + " ok " + Inp.Exec(p)); }
      catch (System.Exception e) { stdout.WriteLine(p[0] + " err " + (e.InnerException ?? e).Message.Replace('\\n', ' ')); }
    }
    return 0;
  }
}
`;

const UIA_MAIN = `
static class UiaMain {
  static System.Collections.Generic.Dictionary<string, object> Json(string b64) {
    var s = new System.Web.Script.Serialization.JavaScriptSerializer();
    return s.Deserialize<System.Collections.Generic.Dictionary<string, object>>(System.Text.Encoding.UTF8.GetString(System.Convert.FromBase64String(b64)));
  }
  static object Get(System.Collections.Generic.Dictionary<string, object> q, string k) { object v; return q.TryGetValue(k, out v) ? v : null; }
  static string S(System.Collections.Generic.Dictionary<string, object> q, string k) { var v = Get(q, k); return v == null ? "" : System.Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture); }
  static int I(System.Collections.Generic.Dictionary<string, object> q, string k) { var v = Get(q, k); return v == null ? 0 : System.Convert.ToInt32(v, System.Globalization.CultureInfo.InvariantCulture); }
  static long L(System.Collections.Generic.Dictionary<string, object> q, string k) { var v = Get(q, k); return v == null ? 0 : System.Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture); }
  static double D(System.Collections.Generic.Dictionary<string, object> q, string k) { var v = Get(q, k); return v == null ? 0 : System.Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); }
  static bool B(System.Collections.Generic.Dictionary<string, object> q, string k) { var v = Get(q, k); return v != null && System.Convert.ToBoolean(v); }
  static int N(string s) { return int.Parse(s, System.Globalization.CultureInfo.InvariantCulture); }

  static string Run(string[] p) {
    switch (p[1]) {
      case "focus": return U.Focus();
      case "at": return U.At(N(p[2]), N(p[3]), N(p[4]));
      case "atdeep": return U.AtDeep(N(p[2]), N(p[3]), N(p[4]));
      case "snap": return U.Snap(N(p[2]), N(p[3]), N(p[4]), N(p[5]), double.Parse(p[6], System.Globalization.CultureInfo.InvariantCulture));
      case "fgname": return U.Foreground(N(p[2]));
      case "caret": return U.Caret();
      case "typed": return U.Typed();
      case "scrollinfo": return U.ScrollInfo(N(p[2]));
      case "findtext": { var q = Json(p[2]); return U.FindText(S(q, "text"), I(q, "skipPid"), B(q, "scroll"), D(q, "screenArea"), L(q, "hwnd")); }
      case "pagetext": return U.PageText(N(p[2]), N(p[3]), long.Parse(p[4], System.Globalization.CultureInfo.InvariantCulture));
      case "wins": return U.Windows(N(p[2]));
      case "findin": { var q = Json(p[2]); return U.FindIn(S(q, "name"), S(q, "handles"), D(q, "screenArea")); }
      case "find": { var q = Json(p[2]); return U.Find(I(q, "x"), I(q, "y"), B(q, "hasPoint"), S(q, "name"), I(q, "radius"), D(q, "screenArea"), I(q, "skipPid"), I(q, "maxDist")); }
    }
    return null;
  }

  [System.STAThread]
  static int Main() {
    U.Init();
    var stdout = new System.IO.StreamWriter(System.Console.OpenStandardOutput()) { AutoFlush = true };
    var stdin = new System.IO.StreamReader(System.Console.OpenStandardInput());
    stdout.WriteLine("ready");
    string line;
    while ((line = stdin.ReadLine()) != null) {
      var p = line.Split(' ');
      try {
        var r = Run(p) ?? "";
        stdout.WriteLine(p[0] + " ok " + System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(r)));
      } catch { stdout.WriteLine(p[0] + " err"); }
    }
    return 0;
  }
}
`;

const HELPERS = [
  { exe: 'island-focus.exe', sources: [path.join(ROOT, 'src', 'helpers', 'focus-helper.cs')], refs: [] },
  { exe: 'island-tts.exe', sources: [path.join(ROOT, 'src', 'helpers', 'tts-helper.cs')], refs: [path.join(NET, 'System.Runtime.dll'), ...['Foundation', 'Media', 'Storage'].map((m) => path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata', `Windows.${m}.winmd`))] },
  { exe: 'island-input.exe', code: () => require('../src/input.js').CSHARP + INPUT_MAIN, refs: ['System.Drawing.dll', 'System.Windows.Forms.dll'] },
  { exe: 'island-uia.exe', code: () => require('../src/uia.js').CSHARP + UIA_MAIN, refs: ['System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', path.join(NET, 'WPF', 'UIAutomationClient.dll'), path.join(NET, 'WPF', 'UIAutomationTypes.dll'), path.join(NET, 'WPF', 'WindowsBase.dll')] },
];

if (!fs.existsSync(csc)) {
  console.error(`C# compiler not found at ${csc}; Island will fall back to its PowerShell helpers.`);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'island-helpers-'));
let failed = 0;
try {
  for (const h of HELPERS) {
    let sources = h.sources;
    if (h.code) {
      const file = path.join(tmp, h.exe.replace(/\.exe$/, '.cs'));
      fs.writeFileSync(file, h.code());
      sources = [file];
    }
    try {
      // winexe: no console window (and no conhost process); stdin/stdout still work as pipes.
      execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', ...h.refs.map((r) => `/r:${r}`), `/out:${path.join(OUT, h.exe)}`, ...sources], { stdio: 'pipe', encoding: 'utf8' });
      console.log(`built helpers/${h.exe}`);
    } catch (e) {
      failed++;
      console.error(`could not build ${h.exe} (Island will use its PowerShell fallback):\n${(e.stdout || e.message).split('\n').filter((l) => /error/i.test(l)).slice(0, 8).join('\n')}`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
