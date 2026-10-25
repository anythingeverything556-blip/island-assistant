// Island's speech helper as a small native program (the PowerShell version idles at ~70 MB).
// Uses Windows' modern speech engine (Windows.Media.SpeechSynthesis), which sees every voice that
// comes with a Windows language pack. Built by scripts/build-helpers.js. Same protocol as the
// PowerShell script in src/tts.js:
//   in  "<id> voices"                           out "<id> ok <base64 of name\tlang|name\tlang...>"
//   in  "<id> say <voice> <speed> <lang> <text>"  (voice, lang and text base64, "-" for empty)
//   out "<id> ok <1|0>:<base64 WAV>"  1 = a voice for the language was found
using System;
using System.IO;
using System.Linq;
using System.Text;
using Windows.Foundation;
using Windows.Media.SpeechSynthesis;
using Windows.Storage.Streams;

static class TtsHelper {
  static string Dec(string b) { return b == "-" ? "" : Encoding.UTF8.GetString(Convert.FromBase64String(b)); }
  static string B64(byte[] b) { return Convert.ToBase64String(b); }

  static int Main() {
    var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
    var stdin = new StreamReader(Console.OpenStandardInput());
    var synth = new SpeechSynthesizer();
    var all = SpeechSynthesizer.AllVoices.ToList();
    var fallback = SpeechSynthesizer.DefaultVoice;
    stdout.WriteLine("ready");
    string line;
    while ((line = stdin.ReadLine()) != null) {
      var p = line.Split(' ');
      try {
        if (p[1] == "voices") {
          var v = string.Join("|", all.Select(x => x.DisplayName + "\t" + x.Language));
          stdout.WriteLine(p[0] + " ok " + B64(Encoding.UTF8.GetBytes(v)));
        } else if (p[1] == "say") {
          var name = System.Text.RegularExpressions.Regex.Replace(Dec(p[2]), " Desktop$", "");
          var lang = Dec(p[4]);
          var primary = lang.Split('-')[0];
          var chosen = all.FirstOrDefault(x => x.DisplayName == name) ?? fallback;
          var found = 1;
          if (lang.Length > 0 && !chosen.Language.StartsWith(primary, StringComparison.OrdinalIgnoreCase)) {
            // Another language than the chosen voice: the exact region first, then any region.
            var match = all.FirstOrDefault(x => x.Language == lang)
              ?? all.FirstOrDefault(x => x.Language.StartsWith(primary + "-", StringComparison.OrdinalIgnoreCase) || x.Language == primary);
            if (match != null) chosen = match; else found = 0;
          }
          synth.Voice = chosen;
          synth.Options.SpeakingRate = double.Parse(p[3], System.Globalization.CultureInfo.InvariantCulture);
          var wav = Speak(synth, Dec(p[5]));
          stdout.WriteLine(p[0] + " ok " + found + ":" + B64(wav));
        } else {
          throw new Exception("unknown command " + p[1]);
        }
      } catch (Exception e) {
        var msg = (e is AggregateException && e.InnerException != null ? e.InnerException : e).Message;
        stdout.WriteLine(p[0] + " err " + msg.Replace('\n', ' ').Replace('\r', ' '));
      }
    }
    return 0;
  }

  // Waits for a Windows async call by polling its status (plain .NET Framework can't await
  // WinRT calls without the developer reference pack).
  static T Wait<T>(IAsyncOperation<T> op) {
    while (op.Status == AsyncStatus.Started) System.Threading.Thread.Sleep(2);
    if (op.Status != AsyncStatus.Completed) throw new Exception(op.ErrorCode != null ? op.ErrorCode.Message : "speech was cancelled");
    return op.GetResults();
  }

  static byte[] Speak(SpeechSynthesizer synth, string text) {
    using (var stream = Wait(synth.SynthesizeTextToStreamAsync(text))) {
      var size = (uint)stream.Size;
      using (var reader = new DataReader(stream.GetInputStreamAt(0))) {
        Wait(reader.LoadAsync(size));
        var bytes = new byte[size];
        reader.ReadBytes(bytes);
        return bytes;
      }
    }
  }
}
