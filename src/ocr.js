// Windows' own text recognition (Windows.Media.Ocr): reads words off a picture of the
// screen, with their positions, for apps and pages that don't tell UI Automation their text
// (canvases, images, remote desktops, some PDF viewers). Runs offline; uses the OCR languages
// installed with Windows (English everywhere, Hindi if its language pack is installed).
const { runProcess } = require('./shell');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = `
param([string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($engine -eq $null) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
$res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$lines = foreach ($l in $res.Lines) {
  [pscustomobject]@{ t = $l.Text; w = @(foreach ($w in $l.Words) { $r = $w.BoundingRect; [pscustomobject]@{ t = $w.Text; b = @([int]$r.X, [int]$r.Y, [int]($r.X + $r.Width), [int]($r.Y + $r.Height)) } }) }
}
$stream.Dispose()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[pscustomobject]@{ lang = $engine.RecognizerLanguage.LanguageTag; lines = @($lines) } | ConvertTo-Json -Depth 5 -Compress
`;

function scriptFile() {
  const file = path.join(os.tmpdir(), `island-ocr-${crypto.createHash('sha1').update(SCRIPT).digest('hex').slice(0, 12)}.ps1`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '\uFEFF' + SCRIPT, 'utf8');
  return file;
}

// png: Buffer -> { lang, lines: [{ text, box: [x0, y0, x1, y1], words: [{ text, box }] }] }
// (pixels of the given picture). The picture is a temp file only while it is read.
async function recognize(png) {
  const img = path.join(os.tmpdir(), `island-ocr-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(img, png);
  try {
    const out = await new Promise((resolve, reject) => {
      runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile(), '-Path', img], { timeoutMs: 30000, maxBuffer: 16 * 1024 * 1024 })
        .then((r) => {
          if (r.code !== 0) reject(new Error(`Text recognition failed: ${String(r.stderr || (r.overflow ? 'the output was too large' : 'the script failed')).trim().split('\n')[0]}`));
          else resolve(r.stdout);
        }, reject);
    });
    const r = JSON.parse(out.trim() || '{}');
    const lines = (Array.isArray(r.lines) ? r.lines : r.lines ? [r.lines] : []).map((l) => {
      const words = (Array.isArray(l.w) ? l.w : l.w ? [l.w] : []).map((w) => ({ text: w.t, box: w.b }));
      const box = words.length ? [Math.min(...words.map((w) => w.box[0])), Math.min(...words.map((w) => w.box[1])), Math.max(...words.map((w) => w.box[2])), Math.max(...words.map((w) => w.box[3]))] : null;
      return { text: l.t, box, words };
    });
    return { lang: r.lang || '', lines };
  } finally {
    fs.promises.unlink(img).catch(() => {});
  }
}

// Lowercase words without punctuation (keeps Hindi vowel signs).
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();

// Where a phrase appears in OCR lines: the smallest run of words containing it.
function findPhrase(lines, phrase) {
  const want = norm(phrase);
  if (!want) return [];
  const hits = [];
  for (const l of lines) {
    if (!norm(l.text).includes(want)) continue;
    let best = null;
    for (let i = 0; i < l.words.length; i++) {
      let s = '';
      for (let j = i; j < l.words.length && j < i + 25; j++) {
        s = norm(`${s} ${l.words[j].text}`);
        if (s.includes(want)) {
          if (!best || j - i < best[1] - best[0]) best = [i, j];
          break;
        }
      }
    }
    const ws = best ? l.words.slice(best[0], best[1] + 1) : l.words;
    if (!ws.length) continue;
    hits.push({ text: l.text, box: [Math.min(...ws.map((w) => w.box[0])), Math.min(...ws.map((w) => w.box[1])), Math.max(...ws.map((w) => w.box[2])), Math.max(...ws.map((w) => w.box[3]))], exact: norm(ws.map((w) => w.text).join(' ')) === want });
  }
  return hits.sort((a, b) => b.exact - a.exact);
}

module.exports = { recognize, findPhrase, norm };
