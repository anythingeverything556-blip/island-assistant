// Text-to-speech with Windows' own voices. A long-lived PowerShell process keeps the
// speech engine loaded; each request returns WAV audio (base64) that the renderer plays
// itself, so the microphone's echo cancellation can hear and ignore it.
//
// It uses the modern engine (Windows.Media.SpeechSynthesis), which sees every voice that
// comes with a Windows language pack (Hindi's Kalpana and Hemant, Japanese, Spanish, …),
// not only the two English "Desktop" voices the old System.Speech engine knows. Each
// sentence is read by a voice for its language when one is installed.
const { spawn } = require('child_process');
const { idleReaper, HELPER_IDLE_MS } = require('./idle');
const { helperFailed, spawnHelper } = require('./helpers');
const { killTree } = require('./shell');

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$all = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices)
$default = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice
$in = New-Object IO.StreamReader([Console]::OpenStandardInput())
$out = [Console]::Out
$out.WriteLine('ready'); $out.Flush()
$dec = { param($b) if ($b -eq '-') { '' } else { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) } }
while ($true) {
  $line = $in.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    if ($p[1] -eq 'voices') {
      $v = ($all | ForEach-Object { $_.DisplayName + [char]9 + $_.Language }) -join '|'
      $out.WriteLine($p[0] + ' ok ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))
    } elseif ($p[1] -eq 'say') {
      # p: id say <voice name> <rate> <language> <text>
      $name = (& $dec $p[2]) -replace ' Desktop$', ''
      $lang = & $dec $p[4]
      $primary = $lang.Split('-')[0]
      $chosen = $all | Where-Object { $_.DisplayName -eq $name } | Select-Object -First 1
      if (-not $chosen) { $chosen = $default }
      $found = 1
      if ($lang -and -not $chosen.Language.StartsWith($primary, 'OrdinalIgnoreCase')) {
        # The text is in another language than the chosen voice: use a voice for it,
        # the exact region first (es-MX), then any region of the language (es-*).
        $match = @($all | Where-Object { $_.Language -eq $lang }) + @($all | Where-Object { $_.Language.StartsWith($primary + '-', 'OrdinalIgnoreCase') -or $_.Language -eq $primary })
        if ($match.Count) { $chosen = $match[0] } else { $found = 0 }
      }
      $synth.Voice = $chosen
      $synth.Options.SpeakingRate = [double]$p[3]
      $stream = Await ($synth.SynthesizeTextToStreamAsync((& $dec $p[5]))) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
      $size = [uint32]$stream.Size
      $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
      [void](Await ($reader.LoadAsync($size)) ([uint32]))
      $bytes = New-Object byte[] $size
      $reader.ReadBytes($bytes)
      $reader.Dispose(); $stream.Dispose()
      $out.WriteLine($p[0] + ' ok ' + $found + ':' + [Convert]::ToBase64String($bytes))
    } else { throw ('unknown command ' + $p[1]) }
  } catch { $out.WriteLine($p[0] + ' err ' + $_.Exception.Message.Replace([char]10, ' ').Replace([char]13, ' ')) }
  $out.Flush()
}
`;

// Which language a sentence is in, as a BCP-47 primary tag, or '' when it can't tell
// (then the chosen voice reads it). Scripts give most languages away; for text in Latin
// letters a few very common words separate the big European languages from English.
const SCRIPTS = [
  [/[ऀ-ॿ]/, 'hi'], [/[ঀ-৿]/, 'bn'], [/[਀-੿]/, 'pa'], [/[઀-૿]/, 'gu'],
  [/[஀-௿]/, 'ta'], [/[ఀ-౿]/, 'te'], [/[ಀ-೿]/, 'kn'], [/[ഀ-ൿ]/, 'ml'],
  [/[଀-୿]/, 'or'], [/[؀-ۿ]/, 'ar'], [/[֐-׿]/, 'he'], [/[฀-๿]/, 'th'],
  [/[぀-ヿ]/, 'ja'], [/[가-힯]/, 'ko'], [/[一-鿿]/, 'zh'], [/[Ѐ-ӿ]/, 'ru'],
  [/[Ͱ-Ͽ]/, 'el'],
];
const LATIN = {
  es: ['el', 'la', 'los', 'las', 'que', 'es', 'por', 'para', 'una', 'con', 'está', 'pero', 'muy', 'qué', 'cómo', 'sí', 'tu', 'tienes', 'hola'],
  fr: ['le', 'les', 'des', 'est', 'une', 'pour', 'pas', 'que', 'vous', 'avec', 'dans', 'c\'est', 'oui', 'je', 'tu', 'bonjour', 'très'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'mit', 'ein', 'eine', 'auf', 'für', 'ja', 'sehr', 'hallo', 'auch'],
  it: ['il', 'gli', 'che', 'è', 'per', 'una', 'non', 'sono', 'con', 'della', 'anche', 'ciao', 'molto', 'perché', 'sì'],
  pt: ['o', 'os', 'que', 'não', 'uma', 'para', 'com', 'você', 'está', 'muito', 'sim', 'olá', 'também', 'é'],
  nl: ['de', 'het', 'een', 'is', 'niet', 'ik', 'je', 'van', 'en', 'dat', 'met', 'ook', 'hallo', 'zijn'],
  id: ['yang', 'dan', 'ini', 'itu', 'tidak', 'saya', 'anda', 'dengan', 'untuk', 'ada', 'apa', 'bisa'],
  tr: ['bir', 've', 'bu', 'için', 'çok', 'değil', 'ne', 'evet', 'merhaba', 'nasıl', 'ben', 'sen'],
};
const EN = new Set(['the', 'is', 'are', 'and', 'you', 'to', 'of', 'it', 'that', 'this', 'what', 'for', 'with', 'your', 'can', 'have', 'i', 'a', 'in', 'on']);

function detectLanguage(text) {
  const s = String(text || '');
  // Japanese kana wins over the shared Chinese characters.
  if (/[぀-ヿ]/.test(s)) return 'ja';
  for (const [re, tag] of SCRIPTS) if (re.test(s)) return tag;
  const words = s.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.length < 3) return '';
  const en = words.filter((w) => EN.has(w)).length;
  let best = '', score = 0;
  for (const [tag, list] of Object.entries(LATIN)) {
    const set = new Set(list);
    const n = words.filter((w) => set.has(w)).length;
    if (n > score) { best = tag; score = n; }
  }
  // Needs clear evidence; otherwise leave it to the chosen (usually English) voice.
  return score >= 2 && score > en ? best : '';
}

// The language to read a sentence in. Its script is the surest sign (Devanagari is Hindi
// whatever the user spoke before); for Latin letters the language the user just spoke
// (from transcription) beats guessing from common words.
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
function languageOf(text, hint = '') {
  const s = String(text || '');
  const fromScript = /[^\x00-ɏ\s\d\p{P}\p{S}]/u.test(s) ? detectLanguage(s) : '';
  if (fromScript) return fromScript;
  const h = TAG.test(String(hint || '')) ? String(hint) : '';
  // English needs no switch: the chosen voice (English by default) reads it.
  if (h && !/^en\b/i.test(h)) return h;
  return h ? '' : detectLanguage(s);
}

// Languages Windows can download a voice for (Settings → Time & language → Speech), with
// the region it installs. Others (Bengali, Telugu, Urdu, …) need online voices.
const WINDOWS_VOICES = {
  ar: 'ar-SA', bg: 'bg-BG', ca: 'ca-ES', cs: 'cs-CZ', da: 'da-DK', de: 'de-DE', el: 'el-GR', en: 'en-US', es: 'es-ES',
  fi: 'fi-FI', fr: 'fr-FR', he: 'he-IL', hi: 'hi-IN', hr: 'hr-HR', hu: 'hu-HU', id: 'id-ID', it: 'it-IT', ja: 'ja-JP',
  ko: 'ko-KR', ms: 'ms-MY', nb: 'nb-NO', no: 'nb-NO', nl: 'nl-NL', pl: 'pl-PL', pt: 'pt-BR', ro: 'ro-RO', ru: 'ru-RU',
  sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE', ta: 'ta-IN', th: 'th-TH', tr: 'tr-TR', vi: 'vi-VN', zh: 'zh-CN',
};
const WINDOWS_REGIONS = new Set(['ar-EG', 'de-AT', 'de-CH', 'en-AU', 'en-CA', 'en-GB', 'en-IE', 'en-IN', 'es-MX', 'fr-CA', 'fr-CH', 'nl-BE', 'pt-PT', 'zh-HK', 'zh-TW']);
function windowsVoiceTag(lang) {
  const l = String(lang || '');
  const [p, r] = l.split('-');
  const exact = r ? `${p.toLowerCase()}-${r.toUpperCase()}` : '';
  if (exact && (WINDOWS_REGIONS.has(exact) || WINDOWS_VOICES[p.toLowerCase()] === exact)) return exact;
  return WINDOWS_VOICES[p?.toLowerCase()] || '';
}

// The voice install elevates and downloads from Windows Update, so it can run for a
// long time. Keep the handle: if Island quits meanwhile, the install has to die with
// it instead of going on in the background for ever.
let voiceInstall = null;
const VOICE_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function stopVoiceInstall() {
  const ps = voiceInstall;
  voiceInstall = null;
  if (ps?.pid) killTree(ps.pid);
}

// Installs Windows' own voice for a language (a Windows "feature on demand", downloaded
// from Windows Update). Windows asks the user for permission (UAC) first.
// Resolves { ok } or { ok: false, reason: 'declined' | 'unavailable' | 'failed' }.
function installVoice(lang) {
  const tag = windowsVoiceTag(lang);
  if (!tag) return Promise.resolve({ ok: false, reason: 'unavailable' });
  const inner = `try { Add-WindowsCapability -Online -Name 'Language.TextToSpeech~~~${tag}~0.0.1.0' -ErrorAction Stop | Out-Null; exit 0 } catch { exit 3 }`;
  const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');
  const outer = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${enc(inner)}'; exit $p.ExitCode } catch { exit 2 }`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc(outer)], { windowsHide: true, stdio: 'ignore' });
    voiceInstall = ps;
    const timer = setTimeout(() => { try { ps.kill(); } catch {} }, VOICE_INSTALL_TIMEOUT_MS);
    const done = (result) => { clearTimeout(timer); if (voiceInstall === ps) voiceInstall = null; resolve(result); };
    ps.on('error', () => done({ ok: false, reason: 'failed', tag }));
    ps.on('exit', (code) => done(code === 0 ? { ok: true, tag } : { ok: false, reason: code === 2 ? 'declined' : 'failed', tag }));
  });
}

// Settings' -10..10 speed (1 = normal) as a multiplier: Slower ×0.8, Normal ×1, Faster ×1.25, Fastest ×1.55.
const speedOf = (rate) => Math.pow(3, (Math.max(-10, Math.min(10, Number(rate) || 0)) - 1) / 10);

function createTts() {
  let child = null;
  let ready = null;
  let seq = 0;
  let buf = '';
  const waiting = new Map();
  let chain = Promise.resolve();
  const reaper = idleReaper(HELPER_IDLE_MS, { busy: () => waiting.size > 0, stop: () => { try { child?.stdin.end(); child?.kill(); } catch {} } });

  function start() {
    // The compiled helper (src/helpers/tts-helper.cs, ~40 MB) if it's there, else the same
    // engine through PowerShell (~70 MB). Both speak the same protocol.
    let exe;
    ({ child, exe } = spawnHelper('island-tts.exe', { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')] }));
    let readyOk, readyFail;
    ready = new Promise((resolve, reject) => {
      readyOk = resolve;
      readyFail = reject;
      const t = setTimeout(() => reject(new Error('speech engine did not start')), 30000);
      waiting.set('ready', () => { clearTimeout(t); resolve(); });
    });
    ready.catch(() => {});
    // The program couldn't start (e.g. blocked by antivirus): carry on with PowerShell.
    child.on('error', (e) => {
      child = null;
      if (!exe) return readyFail(e);
      helperFailed('island-tts.exe');
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
        const sp = line.indexOf(' ');
        const id = line.slice(0, sp);
        const rest = line.slice(sp + 1);
        const w = waiting.get(id);
        if (!w) continue;
        waiting.delete(id);
        rest.startsWith('ok') ? w.resolve(rest.slice(3)) : w.reject(new Error(rest.slice(4) || 'speech error'));
      }
    });
    child.on('exit', () => {
      child = null;
      for (const [, w] of waiting) w.reject?.(new Error('speech engine exited'));
      waiting.clear();
    });
  }

  const b64 = (s) => (s ? Buffer.from(String(s), 'utf8').toString('base64') : '-');
  function cmd(...args) {
    const run = async () => {
      if (!child) start();
      await ready;
      const id = String(++seq);
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(`${id} ${args.join(' ')}\n`);
      });
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  return {
    start: () => { if (!child) start(); reaper.touch(); },
    stop: () => { try { child?.stdin.end(); child?.kill(); } catch {} stopVoiceInstall(); },
    // [{ name, lang }]
    async voices() {
      return Buffer.from(await cmd('voices'), 'base64').toString('utf8').split('|').filter(Boolean).map((v) => {
        const [name, lang] = v.split('\t');
        return { name, lang: lang || '' };
      });
    },
    // rate: -10..10, the scale Settings uses (1 = normal). lang: the language to read it
    // in ('' = the chosen voice; undefined = work it out from the text). Resolves
    // { wav (base64), lang, missing } where missing = no Windows voice for that language.
    async say(text, { voice = '', rate = 1, lang } = {}) {
      const t = String(text).slice(0, 2000);
      if (lang === undefined) lang = detectLanguage(t);
      const r = await cmd('say', b64(voice), speedOf(rate).toFixed(2), b64(lang), b64(t));
      const found = r.slice(0, 1) === '1';
      return { wav: r.slice(2), lang, missing: lang && !found ? lang : '' };
    },
    // The engine reads the voice list when it starts; after installing one, start afresh.
    restart() { try { child?.stdin.end(); child?.kill(); } catch {} child = null; },
  };
}

module.exports = { createTts, detectLanguage, languageOf, windowsVoiceTag, installVoice, speedOf };
