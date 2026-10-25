// Checks every speech service Island can use with the user's own key, against a local stand-in
// server that answers the way each service documents (no real keys, nothing leaves the PC):
// speech-to-text from Google, OpenAI, Groq, Mistral, Fireworks, Deepgram, ElevenLabs Scribe,
// AssemblyAI, Azure and the user's own server; Deepgram live streaming over WebSocket; natural
// voices from Google, ElevenLabs, Sarvam, Speko, OpenAI, Groq, Cartesia, Deepgram, MiniMax and
// the user's own server. Usage: node scripts/speech-services-test.js
const http = require('http');
const crypto = require('crypto');
const stt = require('../src/stt');
const voice = require('../src/online-voice');

const seen = [];
let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
const hit = (pathStart) => seen.filter((s) => s.path === pathStart || s.path.startsWith(`${pathStart}/`)).pop();
const allHits = (pathStart) => seen.filter((s) => s.path === pathStart || s.path.startsWith(`${pathStart}/`));
const wav = (secs = 0.3) => {
  const pcm = Buffer.alloc(Math.round(16000 * secs) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
const PCM = Buffer.alloc(4800); // 0.1 s of 24 kHz mono silence, what most raw-PCM voices send
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(480)]);
const WAVE = wav();
const formField = (body, name) => { const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`).exec(body.toString('latin1')); return m ? m[1] : ''; };

const server = http.createServer((req, res) => {
  let body = [];
  req.on('data', (d) => body.push(d));
  req.on('end', () => {
    body = Buffer.concat(body);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    seen.push({ path: p, query: url.search, headers: req.headers, body, method: req.method });
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const rawAudio = (type = 'audio/wav', buf = WAVE) => { res.writeHead(200, { 'content-type': type }); res.end(buf); };
    const jbody = () => { try { return JSON.parse(body.toString()); } catch { return {}; } };

    // ---------------- speech to text ----------------
    if (p === '/google/chat/completions') {
      if (req.headers.authorization !== 'Bearer G-KEY') return json(401, { error: { message: 'API key not valid' } });
      return json(200, { choices: [{ message: { content: 'hi-IN | नमस्ते दोस्त' } }] });
    }
    if (p === '/deepgram') return json(200, { results: { channels: [{ detected_language: 'hi', alternatives: [{ transcript: 'नमस्ते' }] }] } });
    if (p === '/sarvam-stt') return json(200, { transcript: 'नमस्ते सर्वम', language_code: 'hi-IN' });
    if (p === '/oai-stt/audio/transcriptions') {
      const model = formField(body, 'model');
      if (!/gpt-4o-mini-transcribe|whisper-1|gpt-4o-transcribe/.test(model)) return json(400, { error: { message: `wrong model: ${model}` } });
      return json(200, { text: 'Hello there, my friend', language: 'en' });
    }
    if (p === '/groq-stt/audio/transcriptions') {
      if (formField(body, 'model') !== 'whisper-large-v3-turbo') return json(400, { error: { message: 'wrong model' } });
      return json(200, { text: 'Hello from Groq' });
    }
    if (p === '/mistral-stt/audio/transcriptions') {
      if (formField(body, 'model') !== 'voxtral-mini-latest') return json(400, { error: { message: 'wrong model' } });
      return json(200, { text: 'Bonjour bonjour', language: 'fr' });
    }
    if (p === '/fw-stt/audio/transcriptions') {
      if (formField(body, 'model') !== 'whisper-v3-turbo') return json(400, { error: { message: 'wrong model' } });
      return json(200, { text: 'Hello from Fireworks' });
    }
    if (p === '/elve/audio-to-text') {
      if (req.headers['xi-api-key'] !== 'E-STT-KEY') return json(401, { detail: { message: 'bad key' } });
      if (formField(body, 'model_id') !== 'scribe_v1') return json(400, { error: { message: 'wrong model' } });
      return json(200, { text: 'Hello from Scribe', language_code: 'eng' });
    }
    if (p === '/asm/v2/upload') {
      if (req.headers.authorization !== 'ASMKEY') return json(401, { error: { message: 'bad key' } });
      if (!/octet-stream/.test(req.headers['content-type'] || '') || !body.length) return json(400, { error: { message: 'no audio' } });
      return json(200, { upload_url: `http://${req.headers.host}/asm-file` });
    }
    if (p === '/asm/v2/transcript') {
      const parsed = jbody();
      if (parsed.audio_url !== `http://${req.headers.host}/asm-file`) return json(400, { error: { message: 'wrong audio url' } });
      return json(200, { id: 'job1' });
    }
    if (p === '/asm/v2/transcript/job1') return json(200, { status: 'completed', text: 'Thanks for waiting, friend', language_code: 'en' });
    if (p === '/az/speechtotext/transcriptions:transcribe') {
      if (req.headers['ocp-apim-subscription-key'] !== 'AZKEY') return json(401, { error: { message: 'access denied' } });
      if (!/"locales":\["en-IN","hi-IN"/.test(body.toString('latin1')) || !/name="audio"/.test(body.toString('latin1'))) return json(400, { error: { message: 'missing audio or locales' } });
      return json(200, { combinedPhrases: [{ text: 'Azure heard this' }], phrases: [{ locale: 'en-IN', text: 'Azure heard this' }] });
    }
    if (p === '/az-bad/speechtotext/transcriptions:transcribe') return json(401, { error: { message: 'access denied' } });
    // The user's own server, in several shapes.
    if (p === '/cust1/v1/audio/transcriptions') {
      if (formField(body, 'model') !== 'whisper-1') return json(400, { error: { message: 'wrong model' } });
      return json(200, { text: 'local server answer' });
    }
    if (p === '/cust2/audio/transcriptions') return json(404, { error: { message: 'nope' } });
    if (p === '/cust2/v1/audio/transcriptions') return json(200, { text: 'probe worked' });
    if (p === '/cust3/v1/audio/transcriptions') {
      if (/multipart\/form-data/.test(req.headers['content-type'] || '')) return json(415, { error: { message: 'send JSON please' } });
      if (jbody().model !== 'whisper-1' || !/^data:audio\/wav;base64,/.test(jbody().file || '')) return json(400, { error: { message: 'bad json' } });
      return json(200, { displayText: 'json body worked' });
    }
    if (p === '/cust4/v1/audio/transcriptions') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('plain text answer works'); }
    if (p === '/badcust/v1/audio/transcriptions') return json(401, { error: { message: 'nope' } });
    if (p === '/cust5/transcribe') return json(200, { text: 'explicit endpoint used' });

    // ---------------- natural voices ----------------
    if (p === '/gtts/voices') return json(200, { voices: [{ name: 'hi-IN-Standard-A', languageCodes: ['hi-IN'] }, { name: 'hi-IN-Chirp3-HD-Kore', languageCodes: ['hi-IN'] }, { name: 'en-US-Neural2-C', languageCodes: ['en-US'] }] });
    if (p === '/gtts/text:synthesize') return json(200, { audioContent: wav().toString('base64') });
    if (p.startsWith('/eleven/')) { res.writeHead(200, { 'content-type': 'audio/pcm' }); return res.end(PCM); }
    if (p === '/sarvam-tts') return json(200, { audios: [wav().toString('base64')] });
    if (p === '/speko-tts') {
      if (req.headers.authorization !== 'Bearer SPEKO-KEY') return json(401, { error: { message: 'authentication_failed' } });
      if (!req.headers['idempotency-key']) return json(400, { error: { message: 'Idempotency-Key is required' } });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'speko-model': 'cartesia:sonic-3.5' });
      return res.end(PCM);
    }
    if (p === '/oai/audio/speech') {
      const b = jbody();
      if (b.model !== 'gpt-4o-mini-tts' || b.voice !== 'alloy' || b.response_format !== 'wav' || b.input !== 'Hello Island' || b.speed !== 1.5) return json(400, { error: { message: `unexpected body ${JSON.stringify(b)}` } });
      return rawAudio('audio/wav');
    }
    if (p === '/oai400/audio/speech') {
      if (jbody().speed) return json(400, { error: { message: 'speed is not supported on this account yet' } });
      return rawAudio('audio/wav');
    }
    if (p === '/groq-tts/audio/speech') {
      const b = jbody();
      if (b.model !== 'playai-tts' || b.voice !== 'Celeste-PlayAI' || b.input !== 'Hello Island' || 'speed' in b) return json(400, { error: { message: `unexpected body ${JSON.stringify(b)}` } });
      return rawAudio('audio/mpeg', MP3);
    }
    if (p === '/cartesia-bad/v1/voices') return json(401, { detail: 'invalid token' });
    if (p === '/cartesia/v1/voices') {
      if (req.headers.authorization !== 'Bearer CART-KEY' || req.headers['x-api-key'] !== 'CART-KEY' || req.headers['cartesia-version'] !== '2026-08-14') return json(401, { detail: 'bad auth' });
      return json(200, { data: [{ id: 'v-en', name: 'Nova', languages: ['en'] }, { id: 'v-hi', name: 'Kavya', languages: ['hi'] }, { id: 'v-def', name: 'Default', is_default: true, languages: ['en'] }] });
    }
    if (p === '/cartesia/tts/bytes') {
      const b = jbody();
      if (b.model_id !== 'sonic-2' || b.transcript !== 'नमस्ते दोस्त' && b.transcript !== 'Bonjour' || !['v-en', 'v-hi', 'v-def'].includes(b.voice_id)) return json(400, { detail: `unexpected body ${JSON.stringify(b)}` });
      if (b.output_format?.container !== 'raw' || b.output_format?.encoding !== 'pcm_s16le' || b.output_format?.sample_rate !== 24000) return json(400, { detail: 'wrong output format' });
      return rawAudio('application/octet-stream', PCM);
    }
    if (p === '/dg-speak') {
      const model = /model=([\w-]+)/.exec(url.search)?.[1];
      if (!/aura-(2-thalia-en|asteria-es)/.test(model)) return json(400, { err_msg: 'unknown model' });
      if (req.headers.authorization !== 'Token DG-TTS-KEY') return json(401, { err_msg: 'bad key' });
      if (jbody().text !== 'Hello Island') return json(400, { err_msg: 'wrong text' });
      return rawAudio('application/octet-stream', PCM);
    }
    if (p === '/mm/v1/t2a_v2') {
      const b = jbody();
      const zh = b.voice_setting?.voice_id === 'Chinese (Mandarin)_Lyrical_Voice';
      if (b.model !== 'speech-2.8-hd' || !(zh || b.voice_setting?.voice_id === 'English_Graceful_Lady')) return json(400, { base_resp: { status_code: 2013, status_msg: 'wrong params' } });
      if (b.audio_setting?.format !== 'wav' || b.audio_setting?.sample_rate !== 24000) return json(400, { base_resp: { status_code: 2013, status_msg: 'wrong audio setting' } });
      return json(200, { data: { audio: WAVE.toString('hex') }, base_resp: { status_code: 0 } });
    }
    if (p === '/mmerr/v1/t2a_v2') return json(200, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } });
    // The user's own voice server, in several shapes.
    if (p === '/ctts/v1/audio/speech') {
      const b = jbody();
      if (b.model !== 'kokoro' || b.input !== 'Hello Island' || b.voice !== 'alloy' || b.response_format !== 'mp3' || b.speed !== 1.2) return json(400, { error: { message: `unexpected body ${JSON.stringify(b)}` } });
      if (req.headers.authorization) return json(400, { error: { message: 'no key wanted here' } });
      return rawAudio('audio/wav');
    }
    if (p === '/ctts2/audio/speech') return json(404, { error: { message: 'nope' } });
    if (p === '/ctts2/v1/audio/speech') return json(200, { b64_json: wav().toString('base64') });
    if (p === '/ctts3/audio/speech' || p === '/ctts3/v1/audio/speech') return json(404, { error: { message: 'nope' } });
    if (p === '/ctts3/tts') return rawAudio('audio/wav'); // LocalAI-style address
    if (p === '/cttsH/v1/audio/speech') return json(200, { data: { audio: wav().toString('hex') } });
    if (p === '/cttsD/v1/audio/speech') return json(200, { audio: `data:audio/wav;base64,${wav().toString('base64')}` });
    if (p === '/cttsU/v1/audio/speech') return json(200, { url: `http://${req.headers.host}/dl/wavfile` });
    if (p === '/dl/wavfile') return rawAudio('audio/wav');
    if (p === '/cttsR/v1/audio/speech') {
      if (jbody().speed) return json(400, { error: { message: 'speed is not supported' } });
      return rawAudio('audio/wav');
    }
    if (p === '/cttsF/v1/audio/speech') {
      if (jbody().response_format) return json(400, { error: { message: 'that format is not supported here' } });
      return rawAudio('audio/wav');
    }
    json(404, { error: { message: 'not found' } });
  });
});

// A tiny WebSocket endpoint behaving like Deepgram's /v1/listen.
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  seen.push({ path: 'ws', query: req.url, protocols });
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: token\r\n\r\n`);
  const send = (obj) => {
    const p = Buffer.from(JSON.stringify(obj));
    const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
    socket.write(Buffer.concat([head, p]));
  };
  let buf = Buffer.alloc(0);
  let audioBytes = 0;
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4);
      const data = Buffer.from(buf.slice(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
      buf = buf.slice(off + 4 + len);
      if (op === 2) {
        audioBytes += data.length;
        if (audioBytes === data.length) send({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'नमस्ते,', languages: ['hi'] }] } });
      } else if (op === 1) {
        const m = JSON.parse(data.toString());
        if (m.type === 'Finalize') send({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: `आप कैसे हैं? (${audioBytes} bytes)`, languages: ['hi'] }] } });
        if (m.type === 'CloseStream') socket.end(Buffer.from([0x88, 0]));
      } else if (op === 8) socket.end();
    }
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(stt.URLS, { google: `${base}/google`, deepgram: `${base}/deepgram`, deepgramWs: `${base.replace('http', 'ws')}/listen`, sarvam: `${base}/sarvam-stt` });
  Object.assign(voice.URLS, { google: `${base}/gtts`, elevenlabs: `${base}/eleven`, sarvam: `${base}/sarvam-tts`, speko: `${base}/speko-tts`, deepgram: `${base}/dg-speak` });
  const b64 = wav().toString('base64');
  try {
    // Speech to text: the two built-ins that need no key of their own
    let r = await stt.transcribe('google', b64, { key: 'G-KEY', model: 'gemini-3.5-flash-lite' });
    check('Google transcribes and reports the language', r.text === 'नमस्ते दोस्त' && r.lang === 'hi-IN', JSON.stringify(r));
    let err = await stt.transcribe('google', b64, { key: 'WRONG' }).catch((e) => e.message);
    check('a wrong Google key gets a plain message', /didn't accept the key/.test(err), err);
    r = await stt.transcribe('deepgram', b64, { key: 'D-KEY' });
    const dg = hit('/deepgram');
    check('Deepgram transcribes', r.text === 'नमस्ते' && r.lang === 'hi', JSON.stringify(r));
    check('Deepgram request uses its token header and WAV', dg.headers.authorization === 'Token D-KEY' && dg.headers['content-type'] === 'audio/wav' && /model=nova-3/.test(dg.query));
    r = await stt.transcribe('sarvam', b64, { key: 'S-KEY' });
    const sv = hit('/sarvam-stt');
    check('Sarvam transcribes', r.text === 'नमस्ते सर्वम' && r.lang === 'hi-IN', JSON.stringify(r));
    check('Sarvam request is a form upload with its key header', sv.headers['api-subscription-key'] === 'S-KEY' && /multipart\/form-data/.test(sv.headers['content-type']) && /saarika/.test(sv.body.toString('latin1')));
    err = await stt.transcribe('deepgram', b64, {}).catch((e) => e.message);
    check('a missing key says where to add it', /Settings → Voice, Speech services/.test(err), err);

    // Speech to text: the OpenAI-style transcription services
    r = await stt.transcribe('openai', b64, { key: 'OKEY', base: `${base}/oai-stt` });
    check('OpenAI transcribes with its own default model and reads the language', r.text === 'Hello there, my friend' && r.lang === 'en', JSON.stringify(r));
    check('OpenAI ask carries the key as a bearer token with the file', hit('/oai-stt/audio/transcriptions').headers.authorization === 'Bearer OKEY');
    r = await stt.transcribe('openai', b64, { key: 'OKEY', model: 'whisper-1', base: `${base}/oai-stt` });
    check('a model that fits the family is the one that is asked for', formField(hit('/oai-stt/audio/transcriptions').body, 'model') === 'whisper-1');
    r = await stt.transcribe('openai', b64, { key: 'OKEY', model: 'claude-3', base: `${base}/oai-stt` });
    check('a model from another family is replaced by the default', formField(hit('/oai-stt/audio/transcriptions').body, 'model') === 'gpt-4o-mini-transcribe');
    r = await stt.transcribe('groq', b64, { key: 'GROQKEY', base: `${base}/groq-stt` });
    check('Groq transcribes with whisper-large-v3-turbo', r.text === 'Hello from Groq', JSON.stringify(r));
    r = await stt.transcribe('mistral', b64, { key: 'MKEY', base: `${base}/mistral-stt` });
    check('Mistral Voxtral transcribes and reports its language', r.text === 'Bonjour bonjour' && r.lang === 'fr', JSON.stringify(r));
    r = await stt.transcribe('fireworks', b64, { key: 'FWKEY', base: `${base}/fw-stt` });
    check('Fireworks whisper-v3-turbo transcribes', r.text === 'Hello from Fireworks', JSON.stringify(r));
    r = await stt.transcribe('elevenlabs', b64, { key: 'E-STT-KEY', base: `${base}/elve/audio-to-text` });
    check('ElevenLabs Scribe transcribes', r.text === 'Hello from Scribe' && r.lang === 'eng', JSON.stringify(r));
    const el = hit('/elve/audio-to-text');
    check('Scribe asks with xi-api-key and model_id', el.headers['xi-api-key'] === 'E-STT-KEY' && formField(el.body, 'model_id') === 'scribe_v1');
    check('modelFor swaps out foreign models and keeps family ones', stt.modelFor('openai', 'whisper-1') === 'whisper-1' && stt.modelFor('openai', 'claude-3') === 'gpt-4o-mini-transcribe' && stt.modelFor('groq', '') === 'whisper-large-v3-turbo' && stt.modelFor('mistral', 'voxtral-small-latest') === 'voxtral-small-latest' && stt.modelFor('fireworks', 'x') === 'whisper-v3-turbo');

    // Speech to text: AssemblyAI (upload, start, poll)
    r = await stt.transcribe('assembly', b64, { key: 'ASMKEY', base: `${base}/asm` });
    check('AssemblyAI transcribes after its queue', r.text === 'Thanks for waiting, friend' && r.lang === 'en', JSON.stringify(r));
    check('AssemblyAI uploads the recording raw and starts the job with it', /octet-stream/.test(hit('/asm/v2/upload').headers['content-type']) && hit('/asm/v2/upload').body.length === wav().length);
    err = await stt.transcribe('assembly', b64, {}).catch((e) => e.message);
    check('AssemblyAI without a key points at the settings', /Settings → Voice, Speech services/.test(err), err);

    // Speech to text: Azure's fast transcription
    r = await stt.transcribe('azure', b64, { key: 'AZKEY', base: `${base}/az` });
    check('Azure fast transcription works and reports the locale', r.text === 'Azure heard this' && r.lang === 'en-IN', JSON.stringify(r));
    const az = hit('/az/speechtotext/transcriptions:transcribe');
    check('Azure asks with its key header, ten candidate locales and the file', az.headers['ocp-apim-subscription-key'] === 'AZKEY' && /"locales":\["en-IN","hi-IN"/.test(az.body.toString('latin1')) && stt.AZ_LOCALES.length === 10);
    err = await stt.transcribe('azure', b64, { key: 'WRONG', base: `${base}/az-bad` }).catch((e) => e.message);
    check('a wrong Azure key gets a plain message', /didn't accept the Speech key/.test(err), err);
    err = await stt.transcribe('azure', b64, { key: 'AZKEY', region: 'not a region!' }).catch((e) => e.message);
    check('a malformed region is caught before any request', /region looks wrong/.test(err), err);

    // Speech to text: the user's own server, in its many shapes
    r = await stt.transcribe('custom', b64, { custom: { base: `${base}/cust1/v1` } });
    check('a local server with /v1 in the base transcribes with no key and the default model', r.text === 'local server answer', JSON.stringify(r));
    r = await stt.transcribe('custom', b64, { custom: { base: `${base}/cust2` } });
    check('a base without /v1 is probed until the right address answers', r.text === 'probe worked', JSON.stringify(r));
    r = await stt.transcribe('custom', b64, { custom: { base: `${base}/cust3/v1` } });
    check('a server that only takes JSON gets the same file inline', r.text === 'json body worked', JSON.stringify(r));
    r = await stt.transcribe('custom', b64, { custom: { base: `${base}/cust4` } });
    check('a plain-text answer is used as the words', r.text === 'plain text answer works', JSON.stringify(r));
    r = await stt.transcribe('custom', b64, { custom: { base: `${base}/cust5/transcribe` } });
    check('an address that names a transcription endpoint is used as it is', r.text === 'explicit endpoint used', JSON.stringify(r));
    check('no key is sent for a keyless local server', !hit('/cust1/v1/audio/transcriptions').headers.authorization);
    err = await stt.transcribe('custom', b64, { key: 'K', custom: { base: `${base}/badcust/v1` } }).catch((e) => e.message);
    check('a wrong custom key gets a plain message', /Your speech-to-text service didn't accept the key/.test(err), err);
    err = await stt.transcribe('custom', b64, { custom: {} }).catch((e) => e.message);
    check('a custom service without a base URL says what to fill in', /Add the base URL for your own speech-to-text service/.test(err), err);

    // Live streaming
    let endpoints = 0;
    const st = stt.createStream({ key: 'D-KEY', endpointMs: 450, onEndpoint: () => endpoints++ });
    for (let i = 0; i < 10; i++) st.send(new Int16Array(1600).buffer); // 1 s of audio, some before the socket opens
    await new Promise((x) => setTimeout(x, 300));
    const t0 = Date.now();
    r = await st.finish();
    const ws = seen.find((s) => s.path === 'ws');
    check('streaming joins the words heard so far with the final ones', r.text === 'नमस्ते, आप कैसे हैं? (32000 bytes)' && r.lang === 'hi', JSON.stringify(r));
    check('all audio arrived, including what was sent before connecting', /32000 bytes/.test(r.text));
    check('streaming asks for 16 kHz PCM, multilingual, with the key as subprotocol', /encoding=linear16/.test(ws.query) && /sample_rate=16000/.test(ws.query) && /language=multi/.test(ws.query) && ws.protocols.includes('token') && ws.protocols.includes('D-KEY'));
    check('finishing takes only the final flush', Date.now() - t0 < 500, `${Date.now() - t0} ms`);
    check("Deepgram's end-of-turn signal reaches Island, with the patience setting", endpoints === 1 && /endpointing=450/.test(ws.query), `${endpoints} signal(s)`);

    // Natural voices: the ones that were here before
    let v = await voice.say('नमस्ते', { provider: 'google', lang: 'hi', key: 'GC-KEY' });
    check('Google picks its most natural Hindi voice', v.voice === 'hi-IN-Chirp3-HD-Kore' && Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF', v.voice);
    v = await voice.say('Hello', { provider: 'elevenlabs', lang: 'en-US', key: 'E-KEY', speed: 1.1 });
    const el2 = hit('/eleven');
    const elBody = JSON.parse(el2.body.toString());
    check('ElevenLabs audio is wrapped as WAV', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF' && Buffer.from(v.wav, 'base64').length === 4844);
    check('ElevenLabs request uses Flash, its key header and the language', el2.headers['xi-api-key'] === 'E-KEY' && elBody.model_id === 'eleven_flash_v2_5' && elBody.language_code === 'en' && /pcm_24000/.test(el2.query));
    v = await voice.say('नमस्ते', { provider: 'sarvam', lang: 'hi', key: 'S-KEY' });
    const st2 = JSON.parse(hit('/sarvam-tts').body.toString());
    check('Sarvam speaks Hindi with Bulbul', st2.target_language_code === 'hi-IN' && /bulbul/.test(st2.model) && !!v.wav);
    check('Sarvam is skipped for languages it has no voice for', !voice.canSpeak('sarvam', 'ja') && voice.canSpeak('sarvam', 'ta-IN'));
    v = await voice.say('Hello', { provider: 'speko', lang: 'en-US', key: 'SPEKO-KEY' });
    const sk = hit('/speko-tts');
    const skBody = JSON.parse(sk.body.toString());
    check('Speko audio is wrapped as WAV', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF' && !!v.wav);
    check('Speko is told the language and asked for plain PCM', skBody.input === 'Hello' && skBody.language === 'en' && skBody.audio.encoding === 'pcm_s16le' && skBody.audio.sample_rate_hz === 24000, JSON.stringify(skBody));
    check('Speko request carries the key and an idempotency key', sk.headers.authorization === 'Bearer SPEKO-KEY' && !!sk.headers['idempotency-key']);
    check('Speko says which voice it used', /Speko/.test(v.voice), v.voice);
    let err2 = '';
    try { await voice.say('Hello', { provider: 'speko', key: 'WRONG' }); } catch (e) { err2 = e.message; }
    check('a wrong Speko key gets a plain message', /didn't accept the key/.test(err2), err2);

    // Natural voices: the new services
    v = await voice.say('Hello Island', { provider: 'openai', lang: 'en-US', key: 'OKEY-TTS', base: `${base}/oai`, speed: 1.5 });
    check('OpenAI gpt-4o-mini-tts speaks, raw WAV straight through', Buffer.from(v.wav, 'base64').equals(WAVE) && v.voice === 'OpenAI Alloy', v.voice);
    err2 = '';
    let v2 = null;
    try { v2 = await voice.say('Hello Island', { provider: 'openai', lang: 'en-US', key: 'OKEY-TTS', base: `${base}/oai400`, speed: 1.5 }); } catch (e) { err2 = e.message; }
    check('OpenAI without the speed knob still speaks (same call once more without it)', allHits('/oai400/audio/speech').length === 2 && v2 && Buffer.from(v2.wav, 'base64').slice(0, 4).toString() === 'RIFF' && !err2, err2 || '');
    v = await voice.say('Hello Island', { provider: 'groq', lang: 'en-US', key: 'GROQ-TTS', base: `${base}/groq-tts` });
    check('Groq PlayAI speaks English (an mp3 the player knows)', Buffer.from(v.wav, 'base64').slice(0, 3).toString() === 'ID3' && v.voice === 'Groq Celeste', v.voice);
    check('Groq voice is English only, so other languages use Windows instead', voice.canSpeak('groq', 'en') && !voice.canSpeak('groq', 'hi'));
    v = await voice.say('Hello Island', { provider: 'deepgram', lang: 'en-US', key: 'DG-TTS-KEY' });
    check('Deepgram Aura speaks English over a plain PCM stream', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF' && /aura-2-thalia-en/.test(v.voice), v.voice);
    v = await voice.say('Hello Island', { provider: 'deepgram', lang: 'es-419', key: 'DG-TTS-KEY' });
    check('Deepgram Aura Spanish uses its Spanish voice', /aura-asteria-es/.test(v.voice) && voice.canSpeak('deepgram', 'es-MX') && !voice.canSpeak('deepgram', 'ja'), v.voice);
    v = await voice.say('Hello Island', { provider: 'minimax', lang: 'en-US', key: 'MMKEY', base: `${base}/mm` });
    check('MiniMax speaks English through its ready voice (hex unpacked back to WAV)', Buffer.from(v.wav, 'base64').equals(WAVE) && /English/.test(v.voice), v.voice);
    v = await voice.say('你好朋友', { provider: 'minimax', lang: 'zh-CN', key: 'MMKEY', base: `${base}/mm` });
    check('MiniMax speaks Chinese through its ready voice', Buffer.from(v.wav, 'base64').equals(WAVE) && /Chinese/.test(v.voice), v.voice);
    err2 = '';
    try { await voice.say('Hello', { provider: 'cartesia', lang: 'en-US', key: 'WRONG', base: `${base}/cartesia-bad` }); } catch (e) { err2 = e.message; }
    check('a wrong Cartesia key gets a plain message', /didn't accept the key/.test(err2), err2);
    v = await voice.say('नमस्ते दोस्त', { provider: 'cartesia', lang: 'hi-IN', key: 'CART-KEY', base: `${base}/cartesia` });
    check('Cartesia Sonic-2 speaks with a ready Hindi voice picked from the account', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF' && /Kavya/.test(v.voice), v.voice);
    check('Cartesia asks for plain 24 kHz PCM with its version header', (() => { const c = hit('/cartesia/tts/bytes'); return /pcm_s16le/.test(c.body.toString()) && c.headers['cartesia-version'] === '2026-08-14' && c.headers['x-api-key'] === 'CART-KEY'; })());
    v = await voice.say('Bonjour', { provider: 'cartesia', lang: 'fr-FR', key: 'CART-KEY', base: `${base}/cartesia` });
    check('Cartesia without a French voice falls back to its default voice', /Default/.test(v.voice), v.voice);
    check('the voice list is fetched once and kept', allHits('/cartesia/v1/voices').length === 1);
    check('MiniMax is Chinese, English and Japanese only', voice.canSpeak('minimax', 'zh') && voice.canSpeak('minimax', 'ja') && !voice.canSpeak('minimax', 'hi'));
    err2 = '';
    try { await voice.say('Hello', { provider: 'minimax', lang: 'en-US', key: 'WRONG-MM', base: `${base}/mmerr` }); } catch (e) { err2 = e.message; }
    check('MiniMax says a wrong key plainly even in a 200 answer', /didn't accept the key/.test(err2), err2);
    check('OpenAI, Cartesia and the custom service speak any language', voice.canSpeak('openai', 'zu-ZA') && voice.canSpeak('cartesia', 'de-DE') && voice.canSpeak('custom', 'mr-IN'));

    // Natural voices: the user's own server, in its many shapes
    v = await voice.say('Hello Island', { provider: 'custom', speed: 1.2, custom: { base: `${base}/ctts/v1`, format: 'mp3' } });
    check('a local voice server speaks with mp3 asked for and raw WAV straight through', Buffer.from(v.wav, 'base64').equals(WAVE), v.voice || '');
    const ctts = hit('/ctts/v1/audio/speech');
    check('the local ask carries no key, the model input voice format and the speed', !ctts.headers.authorization && JSON.parse(ctts.body.toString()).response_format === 'mp3' && JSON.parse(ctts.body.toString()).speed === 1.2 && JSON.parse(ctts.body.toString()).model === 'kokoro');
    v = await voice.say('Hello Island', { provider: 'custom', custom: { base: `${base}/ctts2` } });
    check('a base without /v1 is probed, and b64_json answers are read', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    v = await voice.say('Hello Island', { provider: 'custom', custom: { base: `${base}/ctts3` } });
    check('a LocalAI-style /tts address is found after the OpenAI shapes miss', hit('/ctts3/tts') && Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    v = await voice.say('Hello Island', { provider: 'custom', custom: { base: `${base}/cttsH/v1` } });
    check('a MiniMax-style hex answer is unpacked', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    v = await voice.say('Hello Island', { provider: 'custom', custom: { base: `${base}/cttsD/v1` } });
    check('a data link inside JSON is cut to the audio', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    v = await voice.say('Hello Island', { provider: 'custom', custom: { base: `${base}/cttsU/v1` } });
    check('a download address inside JSON is followed', Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    v = await voice.say('Hello Island', { provider: 'custom', speed: 1.4, custom: { base: `${base}/cttsR/v1` } });
    check('a server without the speed knob gets the same call once more without it', allHits('/cttsR/v1/audio/speech').length === 2 && Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    v = await voice.say('Hello Island', { provider: 'custom', custom: { base: `${base}/cttsF/v1`, format: 'ogg' } });
    check('a server without that format gets the same call once more without it', allHits('/cttsF/v1/audio/speech').length === 2 && Buffer.from(v.wav, 'base64').slice(0, 4).toString() === 'RIFF');
    err2 = '';
    try { await voice.say('Hello', { provider: 'custom', custom: {} }); } catch (e) { err2 = e.message; }
    check('a custom voice without a base URL says what to fill in', /Add the base URL for your own text-to-speech/.test(err2), err2);
    err2 = '';
    try { await voice.say('Hello', { provider: 'custom', custom: { base: 'http://127.0.0.1:9/v1' } }); } catch (e) { err2 = e.message; }
    check('a custom voice that cannot be reached says so plainly', /couldn't be reached/.test(err2), err2);

    // The provider lists the settings rows show
    check('the speech to text row lists twelve choices, with Add your own last', stt.PROVIDERS.length === 12 && ['gateway', 'google', 'openai', 'groq', 'mistral', 'fireworks', 'deepgram', 'sarvam', 'elevenlabs', 'assembly', 'azure', 'custom'].every((x) => stt.PROVIDERS.includes(x)));
    check('the natural voice row lists eleven choices, with Add your own last', voice.PROVIDERS.length === 11 && ['azure', 'google', 'elevenlabs', 'sarvam', 'speko', 'openai', 'groq', 'cartesia', 'deepgram', 'minimax', 'custom'].every((x) => voice.PROVIDERS.includes(x)));
  } catch (e) {
    failed++;
    console.log('FAIL  test run:', e.stack || e.message);
  } finally {
    server.close();
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
})();
