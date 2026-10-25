// Checks the voice choices: the lists of voices each service offers (for the picker in
// Settings → Voice) and speaking a voice the user picked, against a local stand-in server
// that answers the way each service documents (no real keys, nothing leaves the PC).
// Static lists for OpenAI, Groq, Deepgram, MiniMax and Sarvam; live lists for Azure,
// Google, ElevenLabs, Cartesia, Speko (its catalog groups voices by provider, Fish Audio
// style) and the user's own server. Usage: node scripts/voice-choices-test.js
const http = require('http');
const voice = require('../src/online-voice');

const seen = [];
let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
const hit = (pathStart) => seen.filter((s) => s.path === pathStart || s.path.startsWith(`${pathStart}/`)).pop();
const hits = (pathStart) => seen.filter((s) => s.path === pathStart || s.path.startsWith(`${pathStart}/`)).length;
const WAVE = (() => {
  const h = Buffer.alloc(44); const pcm = Buffer.alloc(1600);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
})();
const PCM = Buffer.alloc(3200); // silence, what raw-PCM voices send
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]);
const wavRate = (b64) => Buffer.from(b64, 'base64').readUInt32LE(24);
const mp3kept = (b64) => Buffer.from(b64, 'base64').slice(0, 3).toString() === 'ID3';

const server = http.createServer((req, res) => {
  let body = [];
  req.on('data', (d) => body.push(d));
  req.on('end', () => {
    body = Buffer.concat(body);
    const p = new URL(req.url, 'http://x').pathname;
    seen.push({ path: p, url: req.url, headers: req.headers, body, method: req.method });
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const raw = (type = 'application/octet-stream', buf = WAVE) => { res.writeHead(200, { 'content-type': type }); res.end(buf); };
    const jbody = () => { try { return JSON.parse(body.toString()); } catch { return {}; } };

    // ----- Speak routes (speaking a voice the user picked) -----
    if (p === '/speko/v1/synthesize') {
      const b = jbody();
      if (req.headers.authorization !== 'Bearer SPEKO-KEY') return json(401, { error: { message: 'authentication_failed' } });
      if (b.voice === 'gone') return json(422, { error: { message: 'voice_not_allowed', code: 'voice_not_allowed' } });
      if (!b.voice || typeof b.text !== 'string' || !b.intent?.language) return json(400, { error: { message: 'voice, text and intent.language are required' } });
      if (b.voice === 'fish-1') {
        res.writeHead(200, { 'content-type': 'audio/pcm;rate=16000', 'x-speko-audio-format': 'pcm/16000' });
        return res.end(PCM);
      }
      return raw('audio/mpeg', MP3);
    }
    if (p === '/elv/EL-PICK' || p === '/elv/21m00Tcm4TlvDq8ikWAM') {
      if (req.headers['xi-api-key'] !== 'EL-KEY') return json(401, { detail: 'bad key' });
      return raw('audio/pcm', PCM);
    }
    if (p === '/cart/tts/bytes') {
      if (jbody().voice_id !== 'c9') return json(400, { error: { message: `unexpected voice ${jbody().voice_id}` } });
      return raw('application/octet-stream', PCM);
    }
    if (p === '/cust-v/audio/speech') return raw('audio/wav');
    if (p === '/azsay/cognitiveservices/v1') {
      if (req.headers['ocp-apim-subscription-key'] !== 'AZKEY') return json(401, { error: { message: 'access denied' } });
      return raw();
    }
    if (p === '/oai/audio/speech') {
      if (jbody().voice === 'verse') return raw('audio/wav');
      return json(400, { error: { message: `expected the picked voice, got ${jbody().voice}` } });
    }
    if (p === '/groq/audio/speech') {
      if (jbody().voice !== 'Celeste-PlayAI') return json(400, { error: { message: `unexpected voice ${jbody().voice}` } });
      return raw('audio/mpeg', MP3);
    }
    if (p === '/dg') return raw('audio/wav');

    // ----- Voice list routes (what the picker shows) -----
    if (p === '/speko/v1/voices') {
      if (!['Bearer SPEKO-KEY', 'Bearer OTHER-SPEKO-KEY'].includes(req.headers.authorization)) return json(401, { error: { message: 'authentication_failed' } });
      return json(200, {
        voices: [
          { vendor: 'fish-audio', id: 'fish-1', name: 'Fiona' },
          { vendor: 'fish-audio', id: 'fish-2', name: 'Fern' },
          { vendor: 'cartesia', id: 'cart-1', name: 'Carla', languages: ['en-US'] },
          { vendor: 'elevenlabs', id: 'no-name', name: '' },
        ],
        providers: [
          { key: 'fish-audio', name: 'Fish Audio', voicesFetchedLive: false, source: 'MANAGED' },
          { key: 'cartesia', name: 'Cartesia', voicesFetchedLive: true, source: 'BYOK' },
          { key: 'openai', source: 'MANAGED' },
        ],
      });
    }
    if (p === '/speko-bad/v1/voices') return json(401, { error: { message: 'authentication_failed' } });
    if (p === '/gtts/voices') return json(200, { voices: [{ name: 'hi-IN-Standard-A', languageCodes: ['hi-IN'] }, { name: 'en-US-Neural2-C', languageCodes: ['en-US'] }] });
    if (p === '/gtts/text:synthesize') {
      const b = jbody();
      if (b.voice?.name !== 'en-US-Neural2-C' && b.voice?.name !== 'hi-IN-Standard-A') return json(400, { error: { message: `unexpected voice ${b.voice?.name}` } });
      return json(200, { audioContent: WAVE.toString('base64') });
    }
    if (p === '/elv-api/voices') {
      if (!['EL-KEY', 'OTHER-EL-KEY'].includes(req.headers['xi-api-key'])) return json(401, { detail: { message: 'invalid_api_key' } });
      return json(200, { voices: [{ voice_id: 'EL-PICK', name: 'Petra' }, { voice_id: 'EL-OTHER', name: 'Olga' }] });
    }
    if (p === '/azv/voices/list') {
      if (req.headers['ocp-apim-subscription-key'] !== 'AZKEY') return json(401, { error: { message: 'access denied' } });
      return json(200, [
        { ShortName: 'az-en-A', DisplayName: 'Alia', Locale: 'en-US', VoiceType: 'Neural' },
        { ShortName: 'az-es-B', DisplayName: 'Bruno', Locale: 'es-ES', VoiceType: 'Neural' },
      ]);
    }
    if (p === '/cart/v1/voices') return json(200, { data: [{ id: 'cart-auto', name: 'Auto one', languages: ['en'] }] });
    if (p === '/cust-v/voices') return json(200, { voices: [{ id: 'myvoice', name: 'My Voice', languages: ['en_US'] }, { id: 'second', name: 'Second' }] });
    if (p === '/cust-v/v1/voices') return json(200, []); // the bare /voices answers first
    return json(404, { error: { message: `unrouted: ${p}` } });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const qs = (pathStart) => new URL(hit(pathStart).url, 'http://x').searchParams;
  voice.URLS.google = `${base}/gtts`;
  voice.URLS.elevenlabs = `${base}/elv`;
  voice.URLS.elevenApi = `${base}/elv-api`;
  voice.URLS.speko = `${base}/speko-legacy`;
  voice.URLS.spekoApi = `${base}/speko`;
  voice.URLS.azure = `${base}/azsay`;
  voice.URLS.cartesia = `${base}/cart`;
  voice.URLS.openai = `${base}/oai`;
  voice.URLS.groq = `${base}/groq`;
  voice.URLS.deepgram = `${base}/dg`;

  // ---------------- static lists ----------------
  const openai = await voice.listVoices('openai');
  check('OpenAI lists its known voices with any language', openai.voices.length === 11 && openai.voices.some((v) => v.id === 'verse') && openai.voices.some((v) => v.id === 'ballad') && openai.voices.every((v) => Array.isArray(v.lang) && v.lang.length === 0), `${openai.voices.length} voices`);
  check('static lists ignore fresh and keys', (await voice.listVoices('openai', { fresh: true })).voices.length === 11);
  const deepgram = await voice.listVoices('deepgram');
  check('Deepgram lists its aura voices with their languages', deepgram.voices.length === 5 && deepgram.voices.find((v) => v.id === 'aura-2-thalia-en').lang.includes('en') && deepgram.voices.find((v) => v.id === 'aura-asteria-es').lang.includes('es'), deepgram.voices.map((v) => v.id).join(','));
  const sarvam = await voice.listVoices('sarvam');
  check('Sarvam lists the Bulbul speakers', sarvam.voices.length === 13 && sarvam.voices[0].id === 'anushka' && sarvam.voices.some((v) => v.id === 'kavya'));
  const minimax = await voice.listVoices('minimax');
  check('MiniMax lists Chinese, English and Japanese voices', minimax.voices.length === 3 && minimax.voices.every((v) => ['zh', 'en', 'ja'].some((l) => v.lang.includes(l))));
  const groq = await voice.listVoices('groq');
  check('Groq lists its PlayAI voice', groq.voices.map((v) => v.id).includes('Celeste-PlayAI'));

  // ---------------- speko: the catalog and its sources ----------------
  const speko = await voice.listVoices('speko', { key: 'SPEKO-KEY' });
  check('Speko lists catalog voices with their provider', speko.voices.length === 4 && speko.voices[0].id === 'fish-1' && speko.voices[0].via === 'fish-audio');
  check('Speko lists the voice sources, with names for the picker', speko.sources.length === 3 && speko.sources[0].key === 'fish-audio' && speko.sources[0].name === 'Fish Audio' && speko.sources[2].name === 'openai');
  check('the Speko catalog is fetched once and kept', hits('/speko/v1/voices') === 1);
  await voice.listVoices('speko', { key: 'SPEKO-KEY' });
  await voice.listVoices('speko', { key: 'SPEKO-KEY', fresh: true });
  check('an update asks again only when fresh is set', hits('/speko/v1/voices') === 2);
  await voice.listVoices('speko', { key: 'OTHER-SPEKO-KEY' });
  check('a new key fetches the new account by itself', hits('/speko/v1/voices') === 3);
  try { await voice.listVoices('speko', { key: '' }); check('a missing key says what to do', false); } catch (e) { check('a missing key says what to do', /Add your Speko key/.test(e.message), e.message); }
  try {
    voice.URLS.spekoApi = `${base}/speko-bad`;
    await voice.listVoices('speko', { key: 'BAD' });
    check('a wrong Speko key gets a plain message', false);
  } catch (e) {
    check('a wrong Speko key gets a plain message', e.message === "Speko didn't accept the key. Check it in Settings → Voice and keys.", e.message);
  } finally {
    voice.URLS.spekoApi = `${base}/speko`;
  }

  // ---------------- speaking a picked voice: speko ----------------
  let r = await voice.say('Hello Island', { provider: 'speko', lang: 'en-US', key: 'SPEKO-KEY', pick: { voice: 'fish-1', via: 'fish-audio', name: 'Fiona' } });
  const sp = JSON.parse(hit('/speko/v1/synthesize').body.toString());
  check('a picked Speko voice goes through the synthesize endpoint, with its vendor pinned', sp.voice === 'fish-1' && JSON.stringify(sp.constraints.allowedProviders.tts) === '["fish-audio"]' && sp.intent.language === 'en-US' && sp.text === 'Hello Island' && {}.toString.call(sp) === '[object Object]');
  check('a picked Speko voice skips the legacy automatic endpoint', hits('/speko-legacy') === 0);
  check('Speko reads the rate out of the audio type and wraps WAV', r && wavRate(r.wav) === 16000, `rate ${r ? '16kHz' : 'no return'}`);
  check('the label says which voice is used', r.voice === 'Speko (Fiona)', r.voice);
  r = await voice.say('Hello', { provider: 'speko', lang: 'hi-IN', key: 'SPEKO-KEY', pick: { voice: 'fish-2', via: 'fish-audio' } });
  check('an MP3 answer from Speko passes through as mp3, unwrapped', mp3kept(r.wav), 'mp3 kept');
  check('the intent keeps BCP-47 shape for the language', JSON.parse(hit('/speko/v1/synthesize').body.toString()).intent.language === 'hi-IN');
  r = await voice.say('Hello', { provider: 'speko', lang: 'mr-IN', key: 'SPEKO-KEY', pick: { voice: 'fish-1', via: '' } });
  check('a pick with no source works (no vendor pin)', (() => { const b = JSON.parse(hit('/speko/v1/synthesize').body.toString()); return b.voice === 'fish-1' && !b.constraints; })());
  try { await voice.say('Hello', { provider: 'speko', lang: 'en', key: 'SPEKO-KEY', pick: { voice: 'gone', via: 'x' } }); check('an unusable Speko pick says why', false); } catch (e) { check('an unusable Speko pick says why', /voice_not_allowed/.test(e.message), e.message); }
  r = await voice.say('Hello', { provider: 'speko', lang: 'en-US', key: 'SPEKO-KEY', speed: 0.9, pick: { voice: 'fish-1', via: 'fish-audio' } });
  check('speed is passed inside the 0.5–2 bounds', JSON.parse(hit('/speko/v1/synthesize').body.toString()).speed === 0.9);

  // ---------------- elevenlabs ----------------
  const elv = await voice.listVoices('elevenlabs', { key: 'EL-KEY' });
  check('ElevenLabs lists the account voices', elv.voices.length === 2 && elv.voices[0].id === 'EL-PICK' && elv.voices[0].name === 'Petra' && elv.voices.every((v) => v.lang.length === 0));
  await voice.listVoices('elevenlabs', { key: 'OTHER-EL-KEY' });
  check('a new ElevenLabs key means a new list, by itself', hits('/elv-api/voices') === 2);
  r = await voice.say('Hello', { provider: 'elevenlabs', lang: 'en-US', key: 'EL-KEY', pick: { voice: 'EL-PICK', name: 'Petra' } });
  check('a picked ElevenLabs voice is asked for by id', hit('/elv').path === '/elv/EL-PICK' && r.voice === 'ElevenLabs Petra', r.voice);

  // ---------------- google ----------------
  const g = await voice.listVoices('google', { key: 'G-KEY' });
  check('Google lists the project voices with their languages', g.voices.length === 2 && g.voices.find((v) => v.id === 'hi-IN-Standard-A').lang.includes('hi-in'));
  r = await voice.say('Hello', { provider: 'google', lang: 'en-US', key: 'G-KEY', pick: { voice: 'hi-IN-Standard-A', name: 'Standard A' } });
  check('a Google pick for another language falls back to the automatic voice', JSON.parse(hit('/gtts/text:synthesize').body.toString()).voice.name === 'en-US-Neural2-C', r.voice);
  r = await voice.say('Hello', { provider: 'google', lang: 'en-US', key: 'G-KEY', pick: { voice: 'en-US-Neural2-C', name: 'Neural2 C' } });
  check('a Google pick that fits the language is used', JSON.parse(hit('/gtts/text:synthesize').body.toString()).voice.name === 'en-US-Neural2-C' && hits('/gtts/text:synthesize') === 2, r.voice);

  // ---------------- azure ----------------
  const az = await voice.listVoices('azure', { key: 'AZKEY', region: 'azregion', base: `${base}/azv` });
  check('Azure lists its voices with locale and display name', az.voices.length === 2 && az.voices[0].id === 'az-en-A' && az.voices[0].name === 'Alia' && az.voices[0].lang.includes('en-us'), JSON.stringify(az.voices));
  r = await voice.say('Hello', { provider: 'azure', lang: 'es-MX', key: 'AZKEY', region: 'azregion', pick: { voice: 'az-es-B', name: 'Bruno' } });
  check('a picked Azure voice for its language is used', /voice name="az-es-B"/.test(String(hit('/azsay/cognitiveservices/v1').body)), r.voice);
  r = await voice.say('Hello', { provider: 'azure', lang: 'en-US', key: 'AZKEY', region: 'azregion', pick: { voice: 'az-es-B', name: 'Bruno' } });
  check('an Azure pick for another language falls back to automatic', /voice name="az-en-A"/.test(String(hit('/azsay/cognitiveservices/v1').body)), r.voice);

  // ---------------- cartesia ----------------
  const cart = await voice.listVoices('cartesia', { key: 'CART-KEY', base: `${base}/cart` });
  check('Cartesia lists the account voices', cart.voices.length === 1 && cart.voices[0].id === 'cart-auto');
  r = await voice.say('Hello Island', { provider: 'cartesia', lang: 'hi-IN', key: 'CART-KEY', pick: { voice: 'c9', name: 'Nine' } });
  check('a picked Cartesia voice is sent with no list fetch', JSON.parse(hit('/cart/tts/bytes').body.toString()).voice_id === 'c9' && hits('/cart/v1/voices') === 1 && r.voice === 'Cartesia Nine', r.voice);

  // ---------------- the user's own server ----------------
  const cust = await voice.listVoices('custom', { custom: { base: `${base}/cust-v` } });
  check("the own server's voices are probed, with en_US read as en-us", cust.voices.length === 2 && cust.voices[0].lang.includes('en-us') && cust.voices[0].name === 'My Voice');
  check('the probe stops at the first voice address that answers with voices', hits('/cust-v/v1/voices') === 0);
  try { await voice.listVoices('custom', {}); check('no base URL says what to do', false); } catch (e) { check('no base URL says what to do', /base URL/.test(e.message), e.message); }

  // ---------------- speaking with the pick, per provider ----------------
  r = await voice.sayCustom('Hello', { custom: { base: `${base}/cust-v`, voice: 'ignored-voice' }, pick: { voice: 'myvoice', name: 'My Voice' } });
  check('a picked custom voice overrides the Voice box field', JSON.parse(hit('/cust-v/audio/speech').body.toString()).voice === 'myvoice' && JSON.parse(hit('/cust-v/audio/speech').body.toString()).model === 'kokoro', r.voice);
  r = await voice.sayCustom('Hello', { custom: { base: `${base}/cust-v`, voice: '' } });
  check('no pick keeps the typed voice, or alloy', JSON.parse(hit('/cust-v/audio/speech').body.toString()).voice === 'alloy');
  r = await voice.say('Hello', { provider: 'openai', lang: 'en-US', key: 'O-KEY', pick: { voice: 'verse', name: 'Verse' } });
  check('a picked OpenAI voice is sent', JSON.parse(hit('/oai/audio/speech').body.toString()).voice === 'verse' && r.voice === 'OpenAI Verse', r.voice);
  r = await voice.say('Hello', { provider: 'deepgram', lang: 'es-MX', key: 'D-KEY', pick: { voice: 'aura-asteria-es', name: 'Asteria' } });
  check('a picked Deepgram voice for its language is used', qs('/dg').get('model') === 'aura-asteria-es', r.voice);
  r = await voice.say('Hello', { provider: 'deepgram', lang: 'en-US', key: 'D-KEY', pick: { voice: 'aura-asteria-es', name: 'Asteria' } });
  check('a Deepgram pick for another language falls back to automatic', qs('/dg').get('model') === 'aura-2-thalia-en', r.voice);
  r = await voice.say('Hello', { provider: 'groq', lang: 'en-US', key: 'Q-KEY', pick: { voice: 'Celeste-PlayAI', name: 'Celeste' } });
  check('a picked Groq voice is sent', JSON.parse(hit('/groq/audio/speech').body.toString()).voice === 'Celeste-PlayAI' && r.voice === 'Groq Celeste', r.voice);

  server.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
