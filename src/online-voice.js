// Online voices: natural voices from a service the user brings a key for. Used when Windows
// has no voice for a language, or always if the user prefers it. Only the sentence being
// spoken is sent, straight to that service.
//   azure       Microsoft Azure Speech, 140+ languages (key + region)
//   google      Google Cloud Text-to-Speech (a Google Cloud key with that API turned on)
//   elevenlabs  ElevenLabs Flash, very natural, 30+ languages
//   sarvam      Sarvam Bulbul, natural Hindi and other Indian languages (and Indian English)
//   speko       Speko, which picks a good voice for the language out of 40+ voice models
//   openai      OpenAI's gpt-4o-mini-tts, multilingual
//   groq        Groq's PlayAI voices, English only (free tier)
//   cartesia    Cartesia Sonic-2, very fast and natural, 15+ languages
//   deepgram    Deepgram Aura, plain clear voices, English and Spanish
//   minimax     MiniMax speech-2.8, Chinese, English and Japanese
//   custom      the user's own server: any OpenAI-compatible speech address, cloud or on
//               this PC (Speaches/Kokoro, LocalAI…), where no key is often needed
const PROVIDERS = ['azure', 'google', 'elevenlabs', 'sarvam', 'speko', 'openai', 'groq', 'cartesia', 'deepgram', 'minimax', 'custom'];
// Endpoints, overridable for tests.
const URLS = {
  google: 'https://texttospeech.googleapis.com/v1',
  elevenlabs: 'https://api.elevenlabs.io/v1/text-to-speech',
  elevenApi: 'https://api.elevenlabs.io/v1', // the account's own voices, for the voice picker
  sarvam: 'https://api.sarvam.ai/text-to-speech',
  speko: 'https://router.speko.dev/v1/tts/speech',
  spekoApi: 'https://api.speko.dev', // the voice catalog, and speaking a voice the user picked
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  cartesia: 'https://api.cartesia.ai',
  deepgram: 'https://api.deepgram.com/v1/speak',
  minimax: 'https://api.minimax.io',
};

// Fixed voice lists: services whose voices are the same for everyone. Services whose voices
// belong to the account (Azure, Google, ElevenLabs, Speko's catalog, the user's own server)
// are fetched live below. lang lists the language tags the voice speaks; [] = any language.
const STATIC = {
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']
    .map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), lang: [] })),
  groq: [{ id: 'Celeste-PlayAI', name: 'Celeste', lang: [] }],
  deepgram: [
    { id: 'aura-2-thalia-en', name: 'Thalia', lang: ['en'] },
    { id: 'aura-2-andromeda-en', name: 'Andromeda', lang: ['en'] },
    { id: 'aura-2-helios-en', name: 'Helios', lang: ['en'] },
    { id: 'aura-2-apollo-en', name: 'Apollo', lang: ['en'] },
    { id: 'aura-asteria-es', name: 'Asteria', lang: ['es'] },
  ],
  minimax: [
    { id: 'English_Graceful_Lady', name: 'Graceful Lady', lang: ['en'] },
    { id: 'Chinese (Mandarin)_Lyrical_Voice', name: 'Lyrical Voice', lang: ['zh'] },
    { id: 'Japanese_Whisper_Belle', name: 'Whisper Belle', lang: ['ja'] },
  ],
  sarvam: ['anushka', 'abhilash', 'manisha', 'harshit', 'harshita', 'kavya', 'karan', 'kunal', 'nikita', 'vidyut', 'aarya', 'amol', 'neha']
    .map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), lang: [] })), // speakers work for every Indian language
};

const cache = new Map(); // region -> { at, list }

// In tests, URLS.azure points at a stand-in server instead of the regional ones.
const endpoint = (region, p) => {
  const host = URLS.azure ? String(URLS.azure).replace(/\/+$/, '') : `https://${region}.tts.speech.microsoft.com`;
  return `${host}/cognitiveservices/${p}`;
};

function checkRegion(region) {
  const r = String(region || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9]{3,30}$/.test(r)) throw new Error('The Speech region looks wrong. It is a short name like centralindia or eastus, shown next to the key in the Azure portal.');
  return r;
}

// The account's voices (kept for a day). base replaces the usual regional address,
// so tests can point at a stand-in server; fresh asks Azure again right away.
async function voices(region, key, baseArg = '', fresh = false) {
  region = checkRegion(region);
  const c = cache.get(region);
  if (c && !fresh && Date.now() - c.at < 24 * 3600 * 1000) return c.list;
  const url = baseArg ? `${String(baseArg).replace(/\/+$/, '')}/voices/list` : endpoint(region, 'voices/list');
  const res = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': key } });
  if (res.status === 401 || res.status === 403) throw new Error("Azure didn't accept the Speech key. Check the key and that its region matches.");
  if (!res.ok) throw new Error(`Azure Speech answered ${res.status}.`);
  const list = await res.json();
  cache.set(region, { at: Date.now(), list });
  return list;
}

// The best voice for a language: the exact region (hi-IN), then any region of it, then a
// "multilingual" voice, which can speak many languages.
function pick(list, lang) {
  const tag = String(lang || 'en-US');
  const primary = tag.split('-')[0].toLowerCase();
  const neural = list.filter((v) => /neural/i.test(v.VoiceType || 'Neural') && (v.Status || 'GA') !== 'Deprecated');
  const byLocale = (l) => neural.filter((v) => String(v.Locale).toLowerCase() === l.toLowerCase());
  return (
    byLocale(tag)[0] ||
    neural.find((v) => String(v.Locale).toLowerCase().split('-')[0] === primary) ||
    neural.find((v) => (v.SecondaryLocaleList || []).some((l) => l.toLowerCase().startsWith(primary))) ||
    neural.find((v) => /Multilingual/i.test(v.ShortName))
  );
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// Resolves base64 WAV (24 kHz mono).
async function sayAzure(text, { lang = '', speed = 1, region, key, pick: choice }) {
  if (!key) throw new Error('No Azure Speech key.');
  region = checkRegion(region);
  const all = await voices(region, key);
  let v = pick(all, lang || 'en-US');
  // A voice the user picked is used for the language it actually speaks; anything else
  // falls back to the automatic pick, so a Hindi sentence never gets a German voice.
  if (choice?.voice) {
    const primary = String(lang || 'en-US').split('-')[0].toLowerCase();
    const mine = all.find((x) => x.ShortName === choice.voice);
    const speaks = mine && [String(mine.Locale), ...(mine.SecondaryLocaleList || [])]
      .some((l) => String(l).toLowerCase().split('-')[0] === primary);
    if (speaks) v = mine;
  }
  if (!v) throw new Error(`Azure has no voice for ${lang || 'this language'}.`);
  const pct = Math.round((speed - 1) * 100);
  let body = `<prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${xml(String(text).slice(0, 2000))}</prosody>`;
  // A multilingual voice standing in for a missing language is told which one to speak
  // when the region is known (it also recognises the language from the text by itself).
  const other = lang && !String(v.Locale).toLowerCase().startsWith(lang.split('-')[0].toLowerCase());
  if (other && lang.includes('-') && /Multilingual/i.test(v.ShortName)) body = `<lang xml:lang="${xml(lang)}">${body}</lang>`;
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(v.Locale)}"><voice name="${xml(v.ShortName)}">${body}</voice></speak>`;
  const res = await fetch(endpoint(region, 'v1'), {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'Island' },
    body: ssml,
  });
  if (res.status === 401 || res.status === 403) throw new Error("Azure didn't accept the Speech key. Check the key and that its region matches.");
  if (res.status === 429) throw new Error('Azure Speech is busy or the free monthly allowance is used up.');
  if (!res.ok) throw new Error(`Azure Speech answered ${res.status}.`);
  return { wav: Buffer.from(await res.arrayBuffer()).toString('base64'), voice: v.ShortName };
}

// Raw 16-bit mono PCM -> WAV (what the renderer plays).
function wavFromPcm(pcm, rate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

function httpError(who, status, why) {
  if (status === 401 || status === 403) return new Error(`${who} didn't accept the key. Check it in Settings → Voice, Speech services.`);
  if (status === 402 || status === 429) return new Error(`${who} is busy, or the account is out of credit or over its free limit.`);
  return new Error(`${who} answered ${status}${why ? `: ${String(why).slice(0, 120)}` : ''}.`);
}

// What a service said went wrong, out of a body that may be plain text or JSON under any
// of the names services use for it.
function whyOfText(raw) {
  try {
    const j = JSON.parse(raw);
    return j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || (typeof j.detail === 'string' ? j.detail : '') || j.detail?.message || j.err_msg || j.base_resp?.status_msg || '';
  } catch {
    return String(raw || '').slice(0, 160);
  }
}
async function errText(res) {
  let raw = '';
  try { raw = await res.text(); } catch { /* already unreadable */ }
  return whyOfText(raw);
}

// ---- Google Cloud Text-to-Speech: the most natural voice it has for the language.
// The voice list is cached for a day and shared with the picker in Settings → Voice.
let googleVoices = null; // { at, list }
async function googleVoiceList(key, fresh = false) {
  if (!googleVoices || fresh || Date.now() - googleVoices.at > 24 * 3600 * 1000) {
    const res = await fetch(`${URLS.google}/voices?key=${encodeURIComponent(key)}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError('Google Text-to-Speech', res.status, j.error?.message);
    googleVoices = { at: Date.now(), list: j.voices || [] };
  }
  return googleVoices.list;
}
async function sayGoogle(text, { lang = '', speed = 1, key, pick: choice }) {
  const gvoices = await googleVoiceList(key);
  const want = (lang || 'en-US').toLowerCase();
  const primary = want.split('-')[0];
  const rank = (v) => (/Chirp3-HD/.test(v.name) ? 0 : /Chirp-HD|Neural2/.test(v.name) ? 1 : /Wavenet/.test(v.name) ? 2 : 3);
  const of = (test) => gvoices.filter((v) => (v.languageCodes || []).some((c) => test(c.toLowerCase()))).sort((a, b) => rank(a) - rank(b));
  let v = of((c) => c === want)[0] || of((c) => c.split('-')[0] === primary)[0];
  // A chosen voice speaks here only for its own language; anything else stays automatic.
  if (choice?.voice) {
    const mine = gvoices.find((x) => x.name === choice.voice);
    if (mine && (mine.languageCodes || []).some((c) => c.toLowerCase().split('-')[0] === primary)) v = mine;
  }
  if (!v) throw new Error(`Google has no voice for ${lang}.`);
  const res = await fetch(`${URLS.google}/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text: String(text).slice(0, 2000) },
      voice: { languageCode: v.languageCodes[0], name: v.name },
      audioConfig: { audioEncoding: 'LINEAR16', ...(Math.abs(speed - 1) > 0.02 ? { speakingRate: Number(speed.toFixed(2)) } : {}) },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('Google Text-to-Speech', res.status, j.error?.message);
  return { wav: j.audioContent, voice: v.name }; // LINEAR16 comes with a WAV header
}

// ---- ElevenLabs Flash: one multilingual voice for every language it speaks. Any voice
// from the account (or Rachel, a default every account has) — chosen voices are honored
// for every language, because the multilingual models speak them all.
const ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel", a default voice every account has
async function sayElevenLabs(text, { lang = '', speed = 1, key, pick: choice }) {
  const vid = choice?.voice || ELEVEN_VOICE;
  const res = await fetch(`${URLS.elevenlabs}/${vid}?output_format=pcm_24000`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: String(text).slice(0, 2000),
      model_id: 'eleven_flash_v2_5',
      ...(lang ? { language_code: lang.split('-')[0] } : {}),
      voice_settings: { speed: Math.max(0.7, Math.min(1.2, speed)) },
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw httpError('ElevenLabs', res.status, j.detail?.message || j.detail);
  }
  return {
    wav: wavFromPcm(Buffer.from(await res.arrayBuffer()), 24000).toString('base64'),
    voice: `ElevenLabs ${choice?.name || choice?.voice || 'Rachel'}`.slice(0, 60),
  };
}

// ---- Sarvam Bulbul: Indian languages and Indian English only.
const SARVAM_LANGS = { hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN', gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', or: 'od-IN', od: 'od-IN', en: 'en-IN' };
async function saySarvam(text, { lang = '', speed = 1, key, pick: choice }) {
  const code = SARVAM_LANGS[(lang || 'en').split('-')[0].toLowerCase()];
  if (!code) throw new Error(`Sarvam has no voice for ${lang}.`);
  // The Bulbul speakers work for every Indian language, so a chosen one is always followed.
  const res = await fetch(URLS.sarvam, {
    method: 'POST',
    headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: String(text).slice(0, 1500), target_language_code: code, speaker: choice?.voice || 'anushka', model: 'bulbul:v2', pace: Math.max(0.5, Math.min(2, speed)) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('Sarvam', res.status, j.error?.message || j.message);
  return { wav: j.audios?.[0], voice: `Sarvam Bulbul (${choice?.name || choice?.voice || code})` };
}

// ---- Speko: one request, and Speko picks a good voice for the language out of the
// 40+ voice models it can reach. Their router gives back plain 24 kHz PCM, which is
// what the player wants. Every new account gets $10 of credit to try them with.
const SPEKO_RATE = 24000;
async function saySpeko(text, { lang = '', speed = 1, key }) {
  const res = await fetch(URLS.speko, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      // Their router wants one of these on every request.
      'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    },
    body: JSON.stringify({
      routing: { mode: 'auto', objective: 'balanced' },
      input: String(text).slice(0, 2000),
      ...(lang ? { language: String(lang).split('-')[0].toLowerCase() } : {}),
      audio: { encoding: 'pcm_s16le', sample_rate_hz: SPEKO_RATE, channels: 1 },
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const why = j?.error?.message || j?.error || j?.message;
    if (res.status === 401 || res.status === 403) {
      throw new Error("Speko didn't accept the key. Check it in Settings → Voice and keys.");
    }
    if (res.status === 402) throw new Error('Speko has no credit left. Add some in your Speko account.');
    if (res.status === 429) throw new Error('Speko is busy right now. Try again in a moment.');
    throw new Error(`Speko answered ${res.status}${why ? `: ${String(why).slice(0, 120)}` : ''}.`);
  }
  const voice = res.headers.get('speko-model') || res.headers.get('speko-provider') || 'Speko';
  return { wav: wavFromPcm(Buffer.from(await res.arrayBuffer()), SPEKO_RATE).toString('base64'), voice: `Speko (${voice})` };
}

// ---- Speko with a chosen voice: the documented synthesize endpoint, telling Speko which
// voice (and which provider's voice it is) to use. The answer's shape is in the Type header
// (plain PCM with a rate, an MP3, …), so it is read like that instead of assuming anything.
// BCP-47 the way their API wants it: lowercase language, optional uppercase region.
function spekoLangTag(lang) {
  const m = /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z0-9]{2,8}))?/.exec(String(lang || '').trim());
  if (!m || m[1].length !== 2) return 'en-US';
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
}
async function spekoError(res) {
  const j = await res.json().catch(() => ({}));
  const why = j?.error?.message || j?.error || j?.message || '';
  if (res.status === 401 || res.status === 403) return new Error("Speko didn't accept the key. Check it in Settings → Voice and keys.");
  if (res.status === 402) return new Error('Speko has no credit left. Add some in your Speko account.');
  if (res.status === 429) return new Error('Speko is busy right now. Try again in a moment.');
  return new Error(`Speko answered ${res.status}${why ? `: ${String(why).slice(0, 120)}` : ''}.`);
}
async function saySpekoPick(text, { lang = '', speed = 1, key, pick: choice }) {
  const res = await fetch(`${URLS.spekoApi}/v1/synthesize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: String(text).slice(0, 20000),
      intent: { language: spekoLangTag(lang) },
      voice: choice.voice,
      ...(Math.abs(speed - 1) > 0.02 ? { speed: Number(Math.max(0.5, Math.min(2, speed)).toFixed(2)) } : {}),
      // Pin the voice to the provider it belongs to (Fish Audio, Cartesia…), so the router
      // can not swap it for a different one.
      ...(choice.via ? { constraints: { allowedProviders: { tts: [choice.via] } } } : {}),
    }),
  });
  if (!res.ok) throw await spekoError(res);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Speko answered with no audio.');
  const type = `${res.headers.get('content-type') || ''} ${res.headers.get('x-speko-audio-format') || ''}`.toLowerCase();
  const rate = Number((/rate=(\d+)/.exec(type) || [])[1]) || SPEKO_RATE;
  const wav = /pcm|\/l16|audio\/wave/.test(type) ? wavFromPcm(buf, rate) : buf; // MP3/WAV go straight to the player
  return { wav: wav.toString('base64'), voice: `Speko (${choice.name || choice.via || choice.voice})` };
}

// ---- OpenAI: gpt-4o-mini-tts speaks the language it is handed, natural and quick.
async function sayOpenai(text, { lang = '', speed = 1, key, base, pick: choice }) {
  const b = String(base || URLS.openai).replace(/\/+$/, '');
  const body = {
    model: 'gpt-4o-mini-tts',
    input: String(text).slice(0, 2000),
    voice: choice?.voice || 'alloy',
    response_format: 'wav',
    ...(Math.abs(speed - 1) > 0.02 ? { speed: Number(Math.max(0.5, Math.min(1.5, speed)).toFixed(2)) } : {}),
  };
  const post = (mesh) => fetch(`${b}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...mesh }),
  });
  let res = await post({});
  // The speed knob isn't on every account's plan yet; that is not a reason to keep quiet.
  if (res.status === 400 && body.speed) {
    const again = await post({ speed: undefined });
    if (again.ok) res = again;
  }
  if (!res.ok) throw httpError('OpenAI', res.status, await errText(res));
  return { wav: Buffer.from(await res.arrayBuffer()).toString('base64'), voice: `OpenAI ${choice ? (choice.name || choice.voice) : 'Alloy'}` };
}

// ---- Groq PlayAI: natural English voices on a generous free tier.
async function sayGroq(text, { lang = '', speed = 1, key, base, pick: choice }) {
  const b = String(base || URLS.groq).replace(/\/+$/, '');
  const res = await fetch(`${b}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'playai-tts', input: String(text).slice(0, 2000), voice: choice?.voice || 'Celeste-PlayAI' }),
  });
  if (!res.ok) throw httpError('Groq', res.status, await errText(res));
  return {
    wav: Buffer.from(await res.arrayBuffer()).toString('base64'),
    voice: `Groq ${choice ? (choice.name || String(choice.voice).replace(/-PlayAI$/, '')) : 'Celeste'}`,
  };
}

// ---- Cartesia Sonic-2: asks for plain 24 kHz PCM, the shape the player likes, and picks
// a ready voice for the language out of the account's list.
const CARTESIA = { version: '2026-08-14', rate: 24000 };
const cartesiaBase = () => URLS.cartesia;
let cartesiaCache = null;
// The account's voice list, kept between the automatic pick and the picker in Settings.
async function fetchCartesiaList(key, baseArg, fresh = false) {
  const b = String(baseArg || cartesiaBase()).replace(/\/+$/, '');
  if (cartesiaCache?.list?.length && !fresh) return cartesiaCache.list;
  const res = await fetch(`${b}/v1/voices`, { headers: { authorization: `Bearer ${key}`, 'X-API-Key': key, 'Cartesia-Version': CARTESIA.version } });
  if (!res.ok) throw httpError('Cartesia', res.status, await errText(res));
  const j = await res.json().catch(() => ({}));
  const list = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : []);
  if (list.length) cartesiaCache = { list };
  return list;
}
async function pickCartesia(lang, key, baseArg) {
  const list = await fetchCartesiaList(key, baseArg);
  const want = String(lang || 'en-US').toLowerCase();
  const primary = want.split('-')[0];
  const langs = (v) => (Array.isArray(v.languages) ? v.languages.map((l) => String(l).toLowerCase()) : [String(v.language || '').toLowerCase()]);
  return (
    list.find((v) => langs(v).includes(want)) ||
    list.find((v) => langs(v).some((l) => l.split('-')[0] === primary)) ||
    list.find((v) => v.is_default) ||
    list[0]
  );
}
async function sayCartesia(text, { lang = '', speed = 1, key, base, pick: choice }) {
  const b = String(base || cartesiaBase()).replace(/\/+$/, '');
  const v = choice?.voice ? { id: choice.voice, name: choice.name || choice.voice } : await pickCartesia(lang, key, base);
  if (!v?.id) throw new Error('Cartesia answered with no usable voices.');
  const res = await fetch(`${b}/tts/bytes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'X-API-Key': key, 'Cartesia-Version': CARTESIA.version, 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: 'sonic-2',
      transcript: String(text).slice(0, 2000),
      voice_id: v.id,
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: CARTESIA.rate },
    }),
  });
  if (!res.ok) throw httpError('Cartesia', res.status, await errText(res));
  return { wav: wavFromPcm(Buffer.from(await res.arrayBuffer()), CARTESIA.rate).toString('base64'), voice: `Cartesia ${v.name || String(v.id).slice(0, 10)}` };
}

// ---- Deepgram Aura: clear, prompt voices, English and Spanish. A chosen voice is used
// only for the language its model speaks (the language is the end of its id).
const DEEPGRAM_VOICES = { en: 'aura-2-thalia-en', es: 'aura-asteria-es' };
const sayDeepgram = async (text, { lang = '', speed = 1, key, base, pick: choice }) => {
  const primary = (lang || 'en').split('-')[0].toLowerCase();
  let model = DEEPGRAM_VOICES[primary] || DEEPGRAM_VOICES.en;
  if (choice?.voice && /^aura-[a-z0-9.]+-(en|es)$/.test(choice.voice) && choice.voice.endsWith(`-${primary}`)) model = choice.voice;
  const q = new URLSearchParams({ model, encoding: 'linear16', sample_rate: '24000', container: 'none' });
  const res = await fetch(`${String(base || URLS.deepgram).replace(/\/+$/, '')}?${q}`, {
    method: 'POST',
    headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: String(text).slice(0, 2000) }),
  });
  if (!res.ok) throw httpError('Deepgram', res.status, await errText(res));
  return { wav: wavFromPcm(Buffer.from(await res.arrayBuffer()), 24000).toString('base64'), voice: `Deepgram ${model}` };
};

// ---- MiniMax speech-2.8: Chinese, English and Japanese have ready voices; the answer
// comes back as hex inside JSON, which Island unpacks itself.
const MINIMAX_VOICES = { zh: 'Chinese (Mandarin)_Lyrical_Voice', en: 'English_Graceful_Lady', ja: 'Japanese_Whisper_Belle' };
async function sayMinimax(text, { lang = '', speed = 1, key, base, pick: choice }) {
  const primary = (lang || 'en').split('-')[0].toLowerCase();
  let voiceId = MINIMAX_VOICES[primary] || MINIMAX_VOICES.en;
  // A chosen voice is used for the language it speaks (Chinese, English or Japanese); a
  // voice that doesn't fit stays automatic, so English never comes out in a Mandarin voice.
  const mine = choice?.voice && STATIC.minimax.find((v) => v.id === choice.voice);
  if (mine && mine.lang.includes(primary)) voiceId = mine.id;
  const res = await fetch(`${String(base || URLS.minimax).replace(/\/+$/, '')}/v1/t2a_v2`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'speech-2.8-hd',
      text: String(text).slice(0, 2000),
      stream: false,
      language_boost: 'auto',
      voice_setting: { voice_id: voiceId, vol: 1, pitch: 0, ...(Math.abs(speed - 1) > 0.02 ? { speed: Number(Math.max(0.5, Math.min(2, speed)).toFixed(2)) } : {}) },
      audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 },
    }),
  }).catch((e) => Promise.reject(new Error(`MiniMax couldn't be reached (${String(e.message || e).slice(0, 120)}).`)));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('MiniMax', res.status, j.base_resp?.status_msg || '');
  if (j.base_resp && Number(j.base_resp.status_code) !== 0) {
    const code = Number(j.base_resp.status_code);
    const why = j.base_resp.status_msg || String(code);
    if (code === 1004) throw new Error("MiniMax didn't accept the key. Check it in Settings → Voice, Speech services.");
    if (code === 1002 || code === 1039) throw new Error('MiniMax is busy, or the rate limit is used up. Try again in a moment.');
    if (code === 1001) throw new Error('MiniMax ran out of time preparing the speech. Try again in a moment.');
    if (code === 1000 && /credit|balance|quota/i.test(why)) throw new Error('Your MiniMax account has no credit left. Add some in your MiniMax account.');
    throw new Error(`MiniMax couldn't speak that: ${why}.`);
  }
  const hex = String(j.data?.audio || '');
  if (!hex) throw new Error('MiniMax answered without audio.');
  return { wav: Buffer.from(hex, 'hex').toString('base64'), voice: `MiniMax ${voiceId}` };
}

// ---- The user's own voice service: any OpenAI-compatible speech address, cloud or on
// this PC — with a key, or with no key at all (Speaches/Kokoro, LocalAI, LM-Studio-style
// servers). The answer may be raw audio (Wav, MP3, OGG — the player knows these without
// help), JSON with the audio as base64 or hex (MiniMax-style), a data link, or a download
// address inside JSON. Picky servers get the same call twice more, once without speed and
// once without the format, so a random custom service still works instead of failing.
async function sayCustom(text, { lang: _lang, speed = 1, key, custom = {}, pick: choice } = {}) {
  const base = String(custom.base || '').trim();
  if (!base) throw new Error('Add the base URL for your own text-to-speech service in Settings → Voice, Natural voice, "Add your own".');
  const u = base.replace(/\/+$/, '');
  const explicit = /audio\/speech|\/speech|\/tts|t2a|\/speak|synthes/i.test(u);
  const endpoints = explicit ? [u] : [`${u}/audio/speech`, `${u}/v1/audio/speech`, `${u}/tts`];
  const wantFormat = String(custom.format || '').trim().toLowerCase();
  const model = String(custom.model || '').trim() || 'kokoro';
  // A voice picked from the server's list wins over what the Voice box says by hand.
  const voice = String(choice?.voice || custom.voice || '').trim() || 'alloy';
  const speedOn = Math.abs(speed - 1) > 0.02 ? Number(Math.max(0.5, Math.min(1.5, speed)).toFixed(2)) : 0;
  let lastFail = null;
  for (const ep of endpoints) {
    const body = {
      model,
      input: String(text).slice(0, 2000),
      voice,
      ...(wantFormat ? { response_format: wantFormat } : {}),
      ...(speedOn ? { speed: speedOn } : {}),
    };
    const post = (mesh) => fetch(ep, {
      method: 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...mesh }),
    }).catch((e) => Promise.reject(new Error(`Your voice service couldn't be reached (${String(e.message || e).slice(0, 120)}).`)));
    let res = await post({});
    if (res.status === 400 && body.speed) res = await post({ speed: undefined });
    if (res.status === 400 && body.response_format) res = await post({ speed: undefined, response_format: undefined });
    if (res.status === 404 || res.status === 405) {
      lastFail = new Error(`Your voice service has nothing at ${ep}. Check the base URL (and whether it ends in /v1).`);
      continue;
    }
    if (res.ok) {
      const out = await audioFromAnswer(res);
      if (out) return { wav: out.wav, voice: 'Your own voice service' };
      lastFail = new Error('Your voice service answered with no audio. Is that address a speech one?');
      continue;
    }
    lastFail = new Error(`Your voice service answered ${res.status}: ${whyOfText(await res.text()) || 'unknown error'}`);
  }
  throw lastFail || new Error("Your voice service couldn't be reached.");
}

// Pull the audio out of whatever an answer is. Raw bytes go straight through (PCM gets a
// Wav wrapper); JSON is searched for the audio under the names services use — base64 or
// hex, with or without a data link — and a bare download address is fetched.
async function audioFromAnswer(res) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('json')) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { wav: (/pcm|none|raw/.test(type) ? wavFromPcm(buf, 24000) : buf).toString('base64'), voice: '' };
  }
  const j = await res.json().catch(() => ({}));
  let hit = null;
  for (const k of ['audio', 'audioContent', 'audio_content', 'b64_json', 'audio_data', 'base64', 'content']) {
    for (const at of [j, j?.data]) {
      const v = at?.[k];
      if (typeof v === 'string' && v) { hit = v; break; }
    }
    if (hit) break;
  }
  const link = !hit ? (j.url || j.audio_url || j.audioUrl || j.data?.url || '') : '';
  if (link) {
    if (!/^https?:\/\//i.test(link)) throw new Error('The voice service points at a download address Island can not use.');
    const dl = await fetch(link).catch(() => null);
    if (!dl || !dl.ok) throw new Error('The voice service answered with an address that didn\'t work.');
    const buf = Buffer.from(await dl.arrayBuffer());
    return buf.length ? { wav: buf.toString('base64'), voice: '' } : null;
  }
  if (!hit) return null;
  const s = String(hit).replace(/^data:[^,]+,/, '');
  const buf = /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length > 40 ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return buf.length ? { wav: buf.toString('base64'), voice: '' } : null;
}

function canSpeak(provider, lang) {
  const p = String(lang || 'en').split('-')[0].toLowerCase();
  if (provider === 'sarvam') return !!SARVAM_LANGS[p];
  if (provider === 'groq') return p === 'en';
  if (provider === 'deepgram') return p === 'en' || p === 'es';
  if (provider === 'minimax') return ['zh', 'en', 'ja'].includes(p);
  return true;
}

// provider: one of PROVIDERS. Resolves { wav (base64), voice }. ("custom" needs a key of
// its own name "customTts" in Island's settings, or no key at all for a local server.)
// pick: a voice the user chose in Settings → Voice ({ voice, via, name }), honored by each
// service when it actually speaks the language of the sentence — otherwise the automatic
// voice stays, so no service is asked for a language it can't say.
async function say(text, { provider = 'azure', lang = '', speed = 1, key, region, custom, base, pick } = {}) {
  const choice = pick?.voice ? { voice: String(pick.voice), via: String(pick.via || ''), name: String(pick.name || '') } : null;
  if (provider === 'custom') return sayCustom(text, { lang, speed, key, custom, base, pick: choice });
  if (!key) throw new Error('No key for the online voice.');
  if (provider === 'google') return sayGoogle(text, { lang, speed, key, pick: choice });
  if (provider === 'elevenlabs') return sayElevenLabs(text, { lang, speed, key, pick: choice });
  if (provider === 'sarvam') return saySarvam(text, { lang, speed, key, pick: choice });
  if (provider === 'speko') return choice?.voice ? saySpekoPick(text, { lang, speed, key, pick: choice }) : saySpeko(text, { lang, speed, key });
  if (provider === 'openai') return sayOpenai(text, { lang, speed, key, base, pick: choice });
  if (provider === 'groq') return sayGroq(text, { lang, speed, key, base, pick: choice });
  if (provider === 'cartesia') return sayCartesia(text, { lang, speed, key, base, pick: choice });
  if (provider === 'deepgram') return sayDeepgram(text, { lang, speed, key, base, pick: choice });
  if (provider === 'minimax') return sayMinimax(text, { lang, speed, key, base, pick: choice });
  return sayAzure(text, { lang, speed, region, key, pick: choice });
}

// ---- Voice lists: what each service can speak with, for the picker in Settings → Voice.
// Account lists (Azure, Google, ElevenLabs, Cartesia, Speko's catalog, the user's own
// server) are fetched and cached for a day, keyed with the key/region/address that got
// them — so a new key shows the new account's voices by itself, and fresh asks again now.
// The shape everywhere: { voices: [{ id, name, lang: [tags], via? }], sources?: [{ key, name }] }
// "via" names the provider whose voice this is inside an aggregator (Speko → Fish Audio…).
const listCache = new Map(); // `${provider}|${key}|${region}|${base}` -> { at, out }
// en_US and EN-us are the same language as en-US for choosing, whatever a server calls it.
const sanitizeLang = (s) => String(s || '').toLowerCase().replace(/_/g, '-');

async function fetchVoiceList(provider, { key, region, base, custom, fresh }) {
  if (provider === 'azure') {
    if (!key) throw new Error('Add your Azure key to see the voices. Island keeps Automatic meanwhile.');
    if (!region) throw new Error('Add the Azure Speech region too, to see the voices. Island keeps Automatic meanwhile.');
    const all = await voices(region, key, base, fresh);
    return {
      voices: all
        .filter((v) => (v.Status || 'GA') !== 'Deprecated' && /Neural/i.test(v.VoiceType || 'Neural'))
        .map((v) => ({ id: v.ShortName, name: v.DisplayName || v.ShortName, lang: [String(v.Locale).toLowerCase(), ...(v.SecondaryLocaleList || []).map((s) => String(s).toLowerCase())] })),
    };
  }
  if (provider === 'google') {
    if (!key) throw new Error('Add your Google key to see the voices. Island keeps Automatic meanwhile.');
    const all = await googleVoiceList(key, fresh);
    return { voices: all.map((v) => ({ id: v.name, name: v.name, lang: (v.languageCodes || []).map((c) => String(c).toLowerCase()) })) };
  }
  if (provider === 'elevenlabs') {
    if (!key) throw new Error('Add your ElevenLabs key to see the voices. Island keeps Automatic meanwhile.');
    const res = await fetch(`${URLS.elevenApi}/voices`, { headers: { 'xi-api-key': key } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError('ElevenLabs', res.status, typeof j.detail === 'string' ? j.detail : (j.detail?.message || j.message));
    const arr = Array.isArray(j?.voices) ? j.voices : [];
    return { voices: arr.map((v) => ({ id: String(v.voice_id || v.id || ''), name: String(v.name || ''), lang: [] })).filter((v) => v.id) };
  }
  if (provider === 'cartesia') {
    if (!key) throw new Error('Add your Cartesia key to see the voices. Island keeps Automatic meanwhile.');
    const all = await fetchCartesiaList(key, base, fresh);
    return {
      voices: all
        .map((v) => ({ id: String(v.id || ''), name: String(v.name || ''), lang: (v.languages || []).map(sanitizeLang) }))
        .filter((v) => v.id),
    };
  }
  if (provider === 'speko') {
    if (!key) throw new Error('Add your Speko key to see the voices. Island keeps Automatic meanwhile.');
    const res = await fetch(`${URLS.spekoApi}/v1/voices`, { headers: { authorization: `Bearer ${key}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw await spekoError(res);
    return {
      // Aggregators group voices by the provider that actually says them (vendor), and the
      // catalog comes with that provider list for the "voice source" choice in the settings.
      voices: (Array.isArray(j?.voices) ? j.voices : [])
        .map((v) => ({
          id: String(v.id || v.voice_id || ''),
          name: String(v.name || v.display_name || ''),
          via: String(v.vendor || v.provider || ''),
          lang: (v.languages || v.languageCodes || []).map(sanitizeLang),
        }))
        .filter((v) => v.id),
      sources: (Array.isArray(j?.providers) ? j.providers : [])
        .map((p) => ({ key: String(p.key || p.id || ''), name: String(p.name || p.key || ''), live: !!p.voicesFetchedLive }))
        .filter((p) => p.key),
    };
  }
  if (provider === 'custom') {
    const b = String((custom && custom.base) || base || '').trim();
    if (!b) throw new Error('Add the base URL for your own voice service, to see its voices. Island keeps Automatic meanwhile.');
    const u = b.replace(/\/+$/, '');
    const headers = { ...(key ? { authorization: `Bearer ${key}` } : {}) };
    let lastFail = null;
    for (const ep of [`${u}/voices`, `${u}/v1/voices`]) {
      let res;
      try { res = await fetch(ep, { headers }); } catch (e) {
        lastFail = new Error(`Your voice service couldn't be reached (${String(e.message || e).slice(0, 120)}).`);
        continue;
      }
      if (!res.ok) {
        lastFail = new Error(`Your voice service answered ${res.status} at ${ep}.`);
        continue;
      }
      const j = await res.json().catch(() => null);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : (Array.isArray(j?.voices) ? j.voices : []));
      const mapped = arr
        .map((v) => ({
          id: String(v?.id || v?.voice_id || v?.name || ''),
          name: String(v?.name || v?.id || v?.voice_id || ''),
          lang: (v?.languages || v?.languageCodes || (v?.language ? [v.language] : [])).map(sanitizeLang),
        }))
        .filter((v) => v.id);
      if (mapped.length) return { voices: mapped };
      lastFail = new Error('Your voice service has no voice list. Type a voice by hand, or keep Automatic.');
    }
    throw lastFail || new Error('Your voice service has no voice list. Type a voice by hand, or keep Automatic.');
  }
  throw new Error('That service has no voice list. Island keeps Automatic meanwhile.');
}

async function listVoices(provider, { key = '', region = '', base = '', custom, fresh = false } = {}) {
  if (STATIC[provider]) return { voices: STATIC[provider].map((v) => ({ ...v })) };
  // The user's own server is identified by its own address, carried in `custom`.
  const ck = `${provider}|${key}|${region}|${provider === 'custom' ? String(custom?.base || base || '') : base}`;
  const c = listCache.get(ck);
  if (c && !fresh && Date.now() - c.at < 24 * 3600 * 1000) return c.out;
  const out = await fetchVoiceList(provider, { key, region, base, custom, fresh });
  listCache.set(ck, { at: Date.now(), out });
  return out;
}

module.exports = { say, canSpeak, voices, pick, checkRegion, ssmlEscape: xml, URLS, PROVIDERS, audioFromAnswer, pickCartesia, sayCustom, sayOpenai, sayGroq, sayDeepgram, sayMinimax, sayCartesia, listVoices };
