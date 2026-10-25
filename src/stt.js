// Speech-to-text from a service the user chooses. Every one works the same way for
// Island: it receives a 16 kHz mono WAV clip and answers with words and, where it can
// tell, the language (a BCP-47 tag, '' when unknown).
//   gateway     the AI gateway's audio-capable chat model (no extra key)
//   google      Gemini with a Google AI Studio key (free tier), same request format as the gateway
//   openai      OpenAI's transcribe endpoint (gpt-4o-mini-transcribe by default)
//   groq        Fastest cheap whisper (generous free tier)
//   mistral     Voxtral (has a free tier)
//   fireworks   whisper-v3-turbo on Fireworks' audio service
//   deepgram    Deepgram Nova-3; also streams, so live replies don't wait for transcription
//   sarvam      Sarvam Saarika, strongest on Hindi and other Indian languages
//   elevenlabs  ElevenLabs Scribe, strong on many languages
//   assembly    AssemblyAI, slower (a file goes through their queue) but very accurate
//   azure       Azure Speech's fast transcription, synchronous, with language picking
//   custom      the user's own server: any OpenAI-compatible transcription endpoint,
//               cloud or on this PC (Speaches, LocalAI…), where no key is often needed

const SYSTEM = 'You transcribe speech in any language. Output the language of the speech as a BCP-47 tag (like en-US, hi-IN, es-MX, ja-JP, bn-IN), then " | ", then the exact words spoken with normal punctuation, in the language and script they were spoken in (Hindi in Devanagari, Japanese in Japanese characters). If the speaker mixes Hindi and English, use hi-IN and write the Hindi words in Devanagari and the English words in English. Example: hi-IN | नमस्ते, आज का weather कैसा है? If there is no speech, output nothing.';

const PROVIDERS = ['gateway', 'google', 'openai', 'groq', 'mistral', 'fireworks', 'deepgram', 'sarvam', 'elevenlabs', 'assembly', 'azure', 'custom'];
const NAMES = {
  gateway: 'your AI gateway', google: 'Google', openai: 'OpenAI', groq: 'Groq', mistral: 'Mistral', fireworks: 'Fireworks',
  deepgram: 'Deepgram', sarvam: 'Sarvam', elevenlabs: 'ElevenLabs', assembly: 'AssemblyAI', azure: 'Azure', custom: 'Your speech-to-text service',
};
// The model each service gets when the user has not picked one that fits it (models with
// different names than this family downright, see modelFor()).
const DEFAULT_MODELS = { openai: 'gpt-4o-mini-transcribe', groq: 'whisper-large-v3-turbo', mistral: 'voxtral-mini-latest', fireworks: 'whisper-v3-turbo', custom: 'whisper-1' };
const FITTING = { openai: /^(gpt-4o.*transcribe|whisper)/, groq: /^whisper/, mistral: /^voxtral/, fireworks: /^whisper/ };
// Endpoints, overridable for tests. (Azure's address is built from its region, so
// transcribe() takes a base override instead.)
const URLS = {
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepgram: 'https://api.deepgram.com/v1/listen',
  deepgramWs: 'wss://api.deepgram.com/v1/listen',
  sarvam: 'https://api.sarvam.ai/speech-to-text',
  elevenStt: 'https://api.elevenlabs.io/v1/audio-to-text',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  fireworks: 'https://audio-prod.us-virginia-1.direct.fireworks.ai/v1',
  assembly: 'https://api.assemblyai.com',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plain words for the usual failures, naming the service whose key it is.
function keyError(provider, status, why) {
  const who = NAMES[provider];
  if (status === 401 || status === 403) return new Error(`${who} didn't accept the key for speech-to-text. Check it in Settings → Voice, Speech services.`);
  if (status === 402 || /insufficient|balance|credit|quota/i.test(why || '')) return new Error(`Your ${who} account is out of credit or over its free limit, so Island can't turn speech into text.`);
  if (status === 429) return new Error(`${who} is busy or the free limit is used up. Try again in a moment.`);
  return new Error(`${who} couldn't transcribe that (${status}): ${String(why || 'unknown error').slice(0, 160)}`);
}

// What the service said went wrong, from a body that may be JSON ({error: {message}},
// { message }, { detail }) or already plain text.
function whyOf(raw) {
  try {
    const j = JSON.parse(raw);
    return j.error?.message || j.message || (typeof j.error === 'string' ? j.error : '') || (typeof j.detail === 'string' ? j.detail : '') || j.detail?.message || '';
  } catch {
    return String(raw || '').slice(0, 200);
  }
}

// "hi-IN | नमस्ते" -> { lang: 'hi-IN', text: 'नमस्ते' }
function splitTagged(raw) {
  const m = /^\s*([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\s*\|\s*([\s\S]*)$/.exec(String(raw || '').trim());
  return m ? { text: m[2].trim(), lang: m[1] } : { text: String(raw || '').trim(), lang: '' };
}

// The model to ask for: what the user picked, when its name belongs to this service's
// family, otherwise the service's own default.
function modelFor(provider, picked) {
  const fit = FITTING[provider];
  if (!fit) return DEFAULT_MODELS[provider];
  return fit.test(String(picked || '')) ? picked : DEFAULT_MODELS[provider];
}

// Azure speaks about regions like "centralindia"; anything else names no resource.
function checkRegion(region) {
  const r = String(region || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9]{3,30}$/.test(r)) throw new Error('The Speech region looks wrong. It is a short name like centralindia or eastus, shown next to the key in the Azure portal.');
  return r;
}

// Chat Completions with input_audio: the gateway, or Google's OpenAI-compatible endpoint.
async function viaChat({ base, key, model, wavB64, provider }) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${base.replace(/\/+$/, '')}${provider === 'google' ? '' : '/v1'}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-api-key': key },
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: [{ type: 'text', text: 'Transcribe this recording.' }, { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } }] },
        ],
      }),
    }).catch((e) => (attempt < 2 ? null : Promise.reject(e)));
    // Temporary trouble: try again (twice) before giving up.
    if ((res && !(res.status === 429 || res.status >= 500)) || attempt >= 2) break;
    await sleep(800 * (attempt + 1));
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = j.error?.message || (Array.isArray(j) && j[0]?.error?.message) || '';
    if (provider === 'gateway') {
      if (res.status === 402 || /insufficient|balance is 0|add credits/i.test(why)) throw new Error("Your AI account is out of credits, so Island can't turn speech into text. Add credits to the account your key belongs to, then try again.");
      if (res.status === 401 || res.status === 403) throw new Error('Your API key was rejected when turning speech into text. Check it in Settings → AI and model.');
    }
    if (res.status === 404 || (/model/i.test(why) && res.status === 400)) throw new Error(`The transcription model "${model}" isn't available on ${NAMES[provider]}. Pick another in Settings → Voice (it must accept audio).`);
    throw keyError(provider, res.status, why);
  }
  return splitTagged(j.choices?.[0]?.message?.content);
}

// The words a transcription answer carries. Services answer with plain text, or JSON
// whose text sits under any of several names (OpenAI's "text", AssemblyAI's "text",
// Deepgram-style copies use their own…). Returns { text, lang }.
async function readAnswer(res, provider) {
  const raw = await res.text();
  const type = res.headers.get('content-type') || '';
  let j = null;
  try { j = JSON.parse(raw); } catch { /* plain text */ }
  if (j && typeof j === 'object') {
    for (const k of ['text', 'transcription', 'transcript', 'displayText', 'DisplayText', 'result', 'output']) {
      if (typeof j[k] === 'string') return { text: j[k].trim(), lang: j.language_code || j.languageCode || j.detected_language || j.language || '' };
    }
    if (typeof j.data?.text === 'string') return { text: j.data.text.trim(), lang: j.language_code || j.languageCode || '' };
    if (typeof j.result?.text === 'string') return { text: j.result.text.trim(), lang: j.language_code || '' };
    if (Array.isArray(j.segments) && typeof j.segments[0]?.text === 'string') return { text: j.segments.map((s) => s.text).join(' ').trim(), lang: j.language || '' };
    return { text: '', lang: '' };
  }
  return { text: provider === 'gateway' || provider === 'google' ? splitTagged(raw).text : raw.trim(), lang: '' };
}

// ---- The OpenAI-style "audio file in, words out" call: multipart first, then the same
// data as JSON with the file inline (a data link), for a server that only takes one or the
// other. A guessed address without /v1 is tried at its second form before Island gives up,
// and the clearest failure is what the user gets to read.
async function viaFile({ endpoints, key, model, wavB64, who, headerName = 'authorization', extraForm = {}, language, jsonFallback = false }) {
  const bytes = Buffer.from(wavB64, 'base64');
  const headers = !key ? {} : headerName === 'xi-api-key' ? { 'xi-api-key': key } : { authorization: `Bearer ${key}` };
  const attempt = async (ep, asForm) => {
    if (asForm) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav');
      if (model) form.append('model', String(model));
      if (language) form.append('language', String(language));
      for (const [k, v] of Object.entries(extraForm)) if (v != null && v !== '') form.append(k, String(v));
      return fetch(ep, { method: 'POST', headers, body: form });
    }
    return fetch(ep, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...(model ? { model } : {}), file: `data:audio/wav;base64,${wavB64}`, ...extraForm }) });
  };
  const misses = [];
  const note = (fail, ep) => misses.push(fail === 'dead' ? new Error(`${who} has no transcription address at ${ep}. Check the base URL (and whether it ends in /v1).`) : fail === 'empty' ? new Error(`${who} answered without any words. Is that endpoint a transcription one?`) : fail);
  for (const ep of endpoints) {
    for (const asForm of [true, ...(jsonFallback ? [false] : [])]) {
      let res;
      try {
        res = await attempt(ep, asForm);
      } catch (e) {
        misses.push(new Error(`${who} couldn't be reached (${String(e.message || e).slice(0, 120)}).`));
        continue;
      }
      if (res.ok) {
        const got = await readAnswer(res, 'custom');
        if (got.text !== '' || !jsonFallback) return got;
        note('empty', ep);
        continue;
      }
      const fail = keyError('custom', res.status, whyOf(await res.text()) || res.statusText);
      if (res.status === 404 || res.status === 405) { note('dead', ep); continue; }
      if (!jsonFallback || asForm === false) throw fail;
      // A 400-style answer often means this server only takes the other shape; the same
      // data goes out once more as JSON before Island gives up.
      misses.push(fail);
    }
  }
  throw misses.find((m) => /has no transcription address/.test(m.message)) || misses[0] || new Error(`${who} couldn't be reached.`);
}

async function viaUpload(provider, { key, model, wavB64, base }) {
  const b = String(base || URLS[provider]).replace(/\/+$/, '');
  const got = await viaFile({ endpoints: [`${b}/audio/transcriptions`], key, model: modelFor(provider, model), wavB64, who: NAMES[provider] });
  // These services say the language with their answer when they know it.
  return got;
}

// ElevenLabs Scribe: the file goes to their own address, with the model under a different name.
async function viaElevenStt({ key, wavB64, base }) {
  return viaFile({ endpoints: [String(base || URLS.elevenStt).replace(/\/+$/, '')], key, model: null, wavB64, who: 'ElevenLabs', headerName: 'xi-api-key', extraForm: { model_id: 'scribe_v1' } });
}

// AssemblyAI: the file is uploaded on its own first, then a transcription job is started
// and polled until their queue finishes with it (a few seconds).
async function viaAssembly({ key, wavB64, base }) {
  const b = String(base || URLS.assembly).replace(/\/+$/, '');
  const headers = { authorization: key };
  if (!key) throw keyError('assembly', 401, '');
  const up = await fetch(`${b}/v2/upload`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: Buffer.from(wavB64, 'base64') }).catch((e) => Promise.reject(new Error(`AssemblyAI couldn't be reached (${String(e.message || e).slice(0, 120)}).`)));
  const uj = await up.json().catch(() => ({}));
  if (!up.ok || !uj.upload_url) throw keyError('assembly', up.status, uj.error || uj.message || '');
  const started = await fetch(`${b}/v2/transcript`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: uj.upload_url, language_detection: true }),
  });
  const tj = await started.json().catch(() => ({}));
  if (!started.ok) throw keyError('assembly', started.status, tj.error || tj.message || '');
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const r = await fetch(`${b}/v2/transcript/${tj.id}`, { headers });
    const j = await r.json().catch(() => ({}));
    if (j.status === 'completed') return { text: String(j.text || '').trim(), lang: j.language_code || '' };
    if (j.status === 'error') throw keyError('assembly', 500, j.error || 'the recording could not be processed');
  }
  throw new Error('AssemblyAI is still working on the recording; try again in a moment.');
}

// Azure's fast transcription: one synchronous call — the recording goes in, the words
// come out. Ten candidate languages go with it, and the answer says which one it heard.
const AZ_LOCALES = ['en-IN', 'hi-IN', 'en-US', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'ja-JP', 'ar-SA'];
async function viaAzure({ key, wavB64, region, base }) {
  if (!key) throw keyError('azure', 401, '');
  const api = String(base || '').replace(/\/+$/, '') || `https://${checkRegion(region)}.api.cognitive.microsoft.com`;
  const form = new FormData();
  form.append('audio', new Blob([Buffer.from(wavB64, 'base64')], { type: 'audio/wav' }), 'speech.wav');
  form.append('definition', JSON.stringify({ locales: [...AZ_LOCALES] }));
  const res = await fetch(`${api}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key }, body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Azure didn't accept the Speech key, or the region doesn't match it. Both are next to each other in the Azure portal.");
    if (res.status === 402 || res.status === 429) throw new Error('Azure Speech is busy, or the free monthly allowance is used up.');
    throw new Error(`Azure couldn't transcribe that (${res.status}): ${String(j.error?.message || res.statusText).slice(0, 160)}`);
  }
  const text = (j.combinedPhrases || []).map((c) => c.text || '').join(' ').trim();
  const lang = (j.phrases || []).find((p) => p.locale)?.locale || '';
  return { text, lang };
}

// The user's own service: any OpenAI-compatible transcription address. Works with a key,
// with no key (a server on this PC: Speaches, LocalAI, anything that answers the same
// way), with /v1 in the address or without, with multipart or JSON in, text or JSON out.
async function viaCustom({ key, wavB64, custom = {} }) {
  const base = String(custom.base || '').trim();
  if (!base) throw new Error('Add the base URL for your own speech-to-text service in Settings → Voice, Speech to text, "Add your own".');
  const u = base.replace(/\/+$/, '');
  // An address that already ends at the endpoint is used as it is; otherwise /audio/transcriptions,
  // first with and then without /v1, is tried.
  const explicit = /transcriptions?|transcribe|listen|speech-to-text|audio-to-text|\/asr/i.test(u);
  const endpoints = explicit ? [u] : [`${u}/audio/transcriptions`, `${u}/v1/audio/transcriptions`];
  const got = await viaFile({ endpoints, key, model: custom.model || 'whisper-1', wavB64, who: 'Your speech-to-text service', jsonFallback: true });
  return got;
}

async function viaDeepgram({ key, wavB64 }) {
  const res = await fetch(`${URLS.deepgram}?model=nova-3&detect_language=true&smart_format=true&punctuate=true`, {
    method: 'POST',
    headers: { authorization: `Token ${key}`, 'content-type': 'audio/wav' },
    body: Buffer.from(wavB64, 'base64'),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw keyError('deepgram', res.status, j.err_msg || j.message);
  const ch = j.results?.channels?.[0];
  return { text: (ch?.alternatives?.[0]?.transcript || '').trim(), lang: ch?.detected_language || '' };
}

async function viaSarvam({ key, wavB64 }) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(wavB64, 'base64')], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', 'saarika:v2.5');
  form.append('language_code', 'unknown'); // let Sarvam work out which language it is
  const res = await fetch(URLS.sarvam, { method: 'POST', headers: { 'api-subscription-key': key }, body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw keyError('sarvam', res.status, j.error?.message || j.message);
  return { text: (j.transcript || '').trim(), lang: j.language_code || '' };
}

// provider: one of PROVIDERS. opts: { key, gateway: { baseURL, apiKey }, model, custom,
// region, base (tests only: stand in for the service's own address) }.
async function transcribe(provider, wavB64, opts = {}) {
  if (provider === 'gateway' || !PROVIDERS.includes(provider)) {
    if (!opts.gateway) throw new Error('Add an API key first.');
    return viaChat({ base: opts.gateway.baseURL, key: opts.gateway.apiKey, model: opts.model || 'gemini-3.5-flash-lite', wavB64, provider: 'gateway' });
  }
  const key = opts.key;
  if (provider === 'google') {
    if (!key) throw new Error('Add your Google key in Settings → Voice, or switch speech-to-text back to your AI gateway.');
    return viaChat({ base: opts.base || URLS.google, key: opts.key, model: /^gemini/.test(opts.model || '') ? opts.model : 'gemini-2.5-flash-lite', wavB64, provider });
  }
  if (provider === 'custom') return viaCustom({ key, wavB64, custom: opts.custom });
  if (!key) throw new Error(`Add your ${NAMES[provider]} key in Settings → Voice, Speech services, or switch speech-to-text back to your AI gateway.`);
  if (provider === 'deepgram') return viaDeepgram({ key: opts.key, wavB64 });
  if (provider === 'sarvam') return viaSarvam({ key: opts.key, wavB64 });
  if (provider === 'elevenlabs') return viaElevenStt({ key: opts.key, wavB64, base: opts.base });
  if (provider === 'assembly') return viaAssembly({ key: opts.key, wavB64, base: opts.base });
  if (provider === 'azure') return viaAzure({ key: opts.key, wavB64, region: opts.region, base: opts.base });
  if (provider === 'openai' || provider === 'groq' || provider === 'mistral' || provider === 'fireworks') {
    return viaUpload(provider, { key: opts.key, model: opts.model, wavB64, base: opts.base || URLS[provider] });
  }
  throw new Error(`Unknown speech-to-text service "${provider}".`);
}

// ---------------------------------------------------------------- streaming (Deepgram)

// Transcribes while the user is still talking: 16 kHz 16-bit mono PCM goes in as it's
// recorded, and finish() only waits for the last fraction of a second instead of the whole
// clip. Audio sent before the connection opens is queued.
// endpointMs: how much silence Deepgram waits for before saying the turn is over; then
// onEndpoint() fires, so Island can answer without waiting for its own pause timer.
function createStream({ key, url = URLS.deepgramWs, endpointMs = 400, onEndpoint }) {
  const q = new URLSearchParams({ model: 'nova-3', language: 'multi', encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: String(endpointMs) });
  const ws = new WebSocket(`${url}?${q}`, ['token', key]);
  ws.binaryType = 'arraybuffer';
  const pending = [];
  const finals = [];
  let lang = '';
  let open = false;
  let failed = null;
  let flushed = null;
  ws.onopen = () => {
    open = true;
    for (const b of pending.splice(0)) ws.send(b);
  };
  ws.onerror = () => { failed = failed || new Error('Could not reach Deepgram for live transcription.'); flushed?.(); };
  ws.onclose = (e) => {
    if (!failed && !flushed) failed = new Error(e.code === 1008 || e.code === 4001 ? "Deepgram didn't accept the key." : `Deepgram closed the connection (${e.code}).`);
    flushed?.();
  };
  ws.onmessage = (m) => {
    let j;
    try { j = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
    if (j.type !== 'Results') return;
    const alt = j.channel?.alternatives?.[0];
    if (j.is_final && alt?.transcript) {
      finals.push(alt.transcript);
      if (!lang && alt.languages?.length) lang = alt.languages[0];
    }
    // Deepgram heard the end of the sentence (and there were words): the turn is over.
    if (j.speech_final && finals.length && !j.from_finalize) onEndpoint?.();
    if (j.from_finalize) flushed?.();
  };
  return {
    send(pcm) {
      if (failed) return;
      const b = Buffer.from(pcm);
      if (open) ws.send(b);
      else pending.push(b);
    },
    // Ask for everything still in flight, then close. Resolves { text, lang }.
    async finish(timeoutMs = 2500) {
      if (failed) throw failed;
      const done = new Promise((r) => (flushed = r));
      const send = () => { try { ws.send(JSON.stringify({ type: 'Finalize' })); } catch { /* closed */ } };
      if (open) send();
      else ws.addEventListener('open', send, { once: true });
      await Promise.race([done, sleep(timeoutMs)]);
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* already closed */ }
      setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 500);
      if (failed && !finals.length) throw failed;
      return { text: finals.join(' ').replace(/\s+/g, ' ').trim(), lang };
    },
    abort() { try { ws.close(); } catch { /* ignore */ } },
  };
}

module.exports = { transcribe, createStream, PROVIDERS, NAMES, URLS, splitTagged, modelFor, readAnswer, checkRegion, AZ_LOCALES };
