const { app, safeStorage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  model: 'claude-opus-5-5',
  effort: 'medium',
  hotkey: 'Control+Alt+Space', // Alt+Space is taken by ChatGPT, Gemini, Raycast and Windows' window menu
  stopHotkey: 'Control+Alt+Shift+Escape', // stops whatever Island is doing, whenever it is doing it
  launchAtLogin: false,
  alwaysShowIsland: true,
  webSearch: true,
  searchProvider: 'auto', // where web searches come from: auto, duckduckgo, tavily, brave, serper, exa, firecrawl, searxng, google, anthropic, openrouter
  searchUrl: '', // a SearXNG instance to search through
  searchKeysEnc: null, // keys for the search services, encrypted by Windows
  answerStyle: 'normal', // 'short' | 'normal' | 'detailed'
  customPrompt: '', // the user's own instructions, used in every chat
  customPromptMode: 'add', // 'add' (to Island's own prompt) | 'replace' (Island's personality and style)
  shellMode: 'ask', // 'ask' (on; asks per the permission mode) | 'off'
  computerUse: 'ask', // 'ask' (on) | 'off'
  permissionMode: 'ask', // 'ask' | 'auto' (safe things run) | 'bypass' (never ask)
  computerSpeed: 'fast', // 'fast' | 'normal' | 'careful'
  mcpAllowed: [], // connector tools the user chose to always allow
  islandPos: null, // { displayId, cx, y } once the user drags the island; null = top-centre
  panelSize: null, // { w, h } once the user resizes the panel; null = default width, auto height
  memoryOn: true,
  memoryAuto: true, // learn lasting facts from conversations in the background
  memoryConfirm: 'sensitive', // ask before saving: 'sensitive' (health, money, beliefs...) | 'always'
  chatSearch: true, // let the model search earlier chats
  voiceHotkey: 'Alt+Shift+M', // start/stop talking
  selectionHotkey: 'Alt+Shift+Space', // ask about the selected text in any app
  speakReplies: 'voice', // 'off' | 'voice' (after voice questions) | 'always'
  sttModel: 'gemini-3.5-flash-lite', // transcribes voice (via Chat Completions audio input); about twice as fast as flash with the same accuracy in tests
  visionModel: 'gemini-3.5-flash', // reads pictures of scanned PDF pages for models that can't see
  speechVoice: '', // Windows voice for spoken replies ('' = automatic: a voice for the language being spoken)
  sttProvider: 'gateway', // speech-to-text: 'gateway' | 'google' | 'openai' | 'groq' | 'mistral' | 'fireworks' | 'deepgram' | 'sarvam' | 'elevenlabs' | 'assembly' | 'azure' | 'custom' (see stt.js)
  liveSttProvider: 'same', // speech-to-text during a live conversation: 'same' (the one above) | any of the stt.js services
  voiceProvider: 'azure', // natural online voices: 'azure' | 'google' | 'elevenlabs' | 'sarvam' | 'speko' | 'openai' | 'groq' | 'cartesia' | 'deepgram' | 'minimax' | 'custom' (see online-voice.js)
  voiceChoices: {}, // per service, the voice the user picked in Settings (e.g. speko: { voice, via, name }); nothing means Automatic (see online-voice.js)
  customSpeech: { // the user's own speech services (any OpenAI-compatible server, cloud or local)
    stt: { base: '', model: '' }, // base URL + model for speech to text ('' = the server's default)
    tts: { base: '', model: '', voice: '', format: '' }, // plus voice and audio format for text to speech
  },
  speechOnline: 'fallback', // online voices (Azure Speech, needs its key): 'fallback' (when Windows has no voice for the language) | 'always' | 'off'
  azureSpeechRegion: '', // e.g. 'centralindia'
  azureSpeechKeyEnc: null,
  micDevice: '', // microphone deviceId ('' = Windows default)
  speechRate: 1, // -10..10
  teachVoice: true, // read lesson steps aloud
  livePatience: 'normal', // 'quick' | 'normal' | 'patient': pause before Island answers in live voice
  liveInterrupt: 'voice', // 'voice' (talk over it) | 'tap' (orb/Space/hotkey only) | 'off'
  apiBaseURL: '', // where the key is used: '' = automatic (Anthropic, or ANTHROPIC_BASE_URL); else a gateway address
  apiKeyEnc: null,
  apiProvider: '', // the AI account in use: '' = the main key and address above, else the name of a saved provider
  apiProviders: [], // more AI accounts ({ name, baseURL }) saved alongside: OpenRouter, Cerebras, a local server…
  apiProviderKeysEnc: {}, // each saved provider's key, encrypted by Windows like the main one
  theme: 'system', // 'system' (follow Windows) | 'light' | 'dark'
  textSize: 'normal', // 'normal' | 'large' | 'larger'
  uiLanguage: 'en', // interface language: 'en' | 'hi' (see renderer/i18n.js)
  studyMode: false, // hints first for homework questions, full solutions on request
};

const ANTHROPIC = 'https://api.anthropic.com';
// Anthropic's own keys look like sk-ant-...; anything else belongs to a gateway.
const isAnthropicKey = (k) => /^sk-ant-/.test(String(k || ''));
// Google AI Studio keys look like AIza...; they work with Gemini, which has a free tier.
const isGoogleKey = (k) => /^AIza[\w-]{30,}$/.test(String(k || '').trim());
const GOOGLE_OPENAI = 'https://generativelanguage.googleapis.com/v1beta/openai';

// "api.example.com", "https://api.example.com/v1/" -> "https://api.example.com"
function normalizeBase(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  // A trailing /v1 is dropped (the app adds it back where it belongs), except under
  // /openai, where it belongs to the address itself (Azure's new shape).
  if (!/\/openai\/v1$/i.test(u)) u = u.replace(/\/v1$/i, '');
  try { new URL(u); } catch { return ''; }
  return u;
}

const file = () => path.join(app.getPath('userData'), 'settings.json');
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, '')) };
    // The old default transcription model was saved into every settings file; move people who
    // never picked one themselves to the faster default.
    if (cache.sttModel === 'gemini-3.5-flash' && !cache.sttModelChosen) cache.sttModel = DEFAULTS.sttModel;
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

// `setx` writes to the registry, but processes started before it ran (or from an old
// terminal) don't inherit it, so read the persisted user/machine value directly too.
function persistedEnv(name) {
  const keys = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`).exec(out);
      if (m) return m[1].trim();
    } catch {}
  }
  return null;
}

let envKeyCache = { at: 0, value: null, baseURL: null };
function readEnvPair() {
  if (Date.now() - envKeyCache.at > 30000) {
    envKeyCache = { at: Date.now(), value: persistedEnv('ANTHROPIC_API_KEY'), baseURL: persistedEnv('ANTHROPIC_BASE_URL') };
  }
  return envKeyCache;
}
function envApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readEnvPair().value;
}
// The gateway URL that belongs with the environment key (null = Anthropic's API).
function envBaseURL() {
  return process.env.ANTHROPIC_BASE_URL || readEnvPair().baseURL || null;
}

// The key saved in Island, or null. It is encrypted by Windows.
function savedKey() {
  const s = load();
  if (!s.apiKeyEnc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64'));
  } catch {
    return null;
  }
}

// Which server the key goes to. The order is:
//   1. an address chosen in Island's settings
//   2. the address this PC's environment names (ANTHROPIC_BASE_URL)
//   3. Anthropic's own address
// The environment wins over the built-in Anthropic address, so a machine set up for a
// gateway does not quietly keep talking to Anthropic.
function getClientOptions() {
  const s = load();
  // A saved extra provider (OpenRouter, Cerebras, a local server…) is used whole: its own
  // address and its own key. Nothing here is filled in from the environment — that is the
  // main account's business.
  const active = (s.apiProviders || []).find((p) => p?.name && p.name === s.apiProvider);
  if (active) {
    const key = getProviderKey(active.name);
    const base = normalizeBase(active.baseURL);
    if (!key && !base) return null; // nothing to talk to yet for this provider
    const google = isGoogleKey(key);
    return { apiKey: key || '', baseURL: google ? GOOGLE_OPENAI : (base || ANTHROPIC), google };
  }
  const custom = normalizeBase(s.apiBaseURL);
  const envBase = normalizeBase(envBaseURL());
  const apiKey = savedKey() || envApiKey();
  // A server on this PC (Ollama, LM Studio, vLLM) often needs no key at all, so an
  // address on its own is enough to talk to it. Without an address there is nothing to
  // talk to yet, and the app asks for a key.
  if (!apiKey && !custom && !envBase) return null;
  const baseURL = custom || envBase || ANTHROPIC;
  // A Google AI Studio key talks to Gemini, through Google's OpenAI-compatible address.
  // A key saved before Island learned about Google still has to be recognised.
  const google = baseURL === GOOGLE_OPENAI || (!custom && !envBase && isGoogleKey(apiKey));
  return { apiKey: apiKey || '', baseURL: google ? GOOGLE_OPENAI : baseURL, google };
}

function getApiKey() {
  return getClientOptions()?.apiKey || null;
}

function setApiKey(key) {
  if (!key) return save({ apiKeyEnc: null });
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable; set ANTHROPIC_API_KEY instead.');
  return save({ apiKeyEnc: safeStorage.encryptString(key).toString('base64') });
}

// More AI accounts saved alongside the main one (Settings → Account → more providers),
// each an OpenAI-compatible (or Anthropic-compatible) address with its own encrypted key.
// `apiProvider` says which one is in use; '' means the main key and address above.
function getProviderKey(name) {
  const enc = (load().apiProviderKeysEnc || {})[name];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
function setProviderKey(name, key) {
  const keys = { ...(load().apiProviderKeysEnc || {}) };
  if (!key) delete keys[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is unavailable, so the key can't be stored safely.");
    keys[name] = safeStorage.encryptString(key).toString('base64');
  }
  return save({ apiProviderKeysEnc: keys });
}
function setProviderBase(name, baseURL) {
  const s = load();
  const list = (s.apiProviders || []).some((p) => p?.name === name)
    ? s.apiProviders.map((p) => (p?.name === name ? { ...p, baseURL } : p))
    : [...s.apiProviders, { name, baseURL }];
  return save({ apiProviders: list });
}

// Keys for speech services the user brings, encrypted by Windows like the API key.
// (Azure's used to live in azureSpeechKeyEnc. customStt/customTts are the keys for the
// user's own services, which are often local and keyless.)
const SPEECH_SERVICES = ['google', 'deepgram', 'sarvam', 'openai', 'groq', 'mistral', 'fireworks', 'elevenlabs', 'assembly', 'azure', 'speko', 'cartesia', 'minimax', 'customStt', 'customTts'];
function getSpeechKey(name) {
  const s = load();
  const enc = (s.speechKeysEnc || {})[name] || (name === 'azure' ? s.azureSpeechKeyEnc : null);
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
function setSpeechKey(name, key) {
  if (!SPEECH_SERVICES.includes(name)) throw new Error('Unknown speech service.');
  const keys = { ...(load().speechKeysEnc || {}) };
  if (!key) delete keys[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is unavailable, so the key can't be stored safely.");
    keys[name] = safeStorage.encryptString(key).toString('base64');
  }
  return save({ speechKeysEnc: keys, ...(name === 'azure' ? { azureSpeechKeyEnc: null } : {}) });
}
const getAzureKey = () => getSpeechKey('azure');
const setAzureKey = (key) => setSpeechKey('azure', key);

// The search services a key can be saved for. The key is encrypted by Windows, like the
// API key and the speech keys, and never reaches the interface: it only shows as "saved".
const SEARCH_SERVICES = ['duckduckgo', 'tavily', 'brave', 'serper', 'exa', 'firecrawl', 'searxng', 'google', 'anthropic', 'openrouter'];
function getSearchKey(name) {
  const enc = (load().searchKeysEnc || {})[name];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
function setSearchKey(name, key) {
  if (!SEARCH_SERVICES.includes(name)) throw new Error('Unknown search service.');
  const keys = { ...(load().searchKeysEnc || {}) };
  if (!key) delete keys[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is unavailable, so the key can't be stored safely.");
    keys[name] = safeStorage.encryptString(key).toString('base64');
  }
  return save({ searchKeysEnc: keys });
}

// What the renderer is allowed to see: never the key itself.
function publicView() {
  const { apiKeyEnc, azureSpeechKeyEnc, speechKeysEnc, searchKeysEnc, mcpSecrets, apiProviderKeysEnc, ...rest } = load(); // keys never reach the renderer
  const opts = getClientOptions();
  let apiHost = null;
  try { apiHost = opts ? new URL(opts.baseURL).host : null; } catch {}
  const envKey = envApiKey();
  const envBase = normalizeBase(envBaseURL());
  const providerOf = (name) => (load().apiProviders || []).find((p) => p?.name === name) || null;
  return {
    ...rest,
    appVersion: app.getVersion(),
    hasApiKey: !!opts?.apiKey,
    // A server may be set up without a key (Ollama, LM Studio on this PC), so this
    // says whether Island knows where to talk, not whether there is a key.
    hasServer: !!opts,
    keyFromEnv: !apiKeyEnc && !load().apiProvider && !!envKey,
    apiHost,
    // The address Island is really talking to right now.
    apiBaseURLInUse: opts ? opts.baseURL : '',
    keyIsAnthropic: opts ? isAnthropicKey(opts.apiKey) : null,
    keyIsGoogle: !!opts?.google,
    keyHint: opts?.apiKey ? `…${opts.apiKey.slice(-4)}` : '',
    // The two built-in addresses, so the account page can offer them by name.
    anthropicBaseURL: ANTHROPIC,
    googleBaseURL: GOOGLE_OPENAI,
    envBaseURL: envBase,
    // The environment's key, so the account page can offer to use it when it is not
    // the one Island is using. Only the last few characters are ever shown.
    envKeyHint: envKey ? `…${envKey.slice(-4)}` : '',
    envKeySet: !!envKey,
    envKeyDiffers: !!envKey && !!opts && envKey !== opts.apiKey,
    envBaseInUse: !!envBase && !!opts && envBase === opts.baseURL,
    // The saved extra AI accounts: their names and addresses, and whether a key is
    // in there (only the last few characters of it are ever shown).
    apiProviders: (load().apiProviders || [])
      .filter((p) => p?.name)
      .map((p) => {
        const k = getProviderKey(p.name);
        return { name: p.name, baseURL: p.baseURL || '', hasKey: !!k, keyHint: k ? `…${k.slice(-4)}` : '' };
      }),
    hasAzureKey: !!(azureSpeechKeyEnc || speechKeysEnc?.azure),
    speechKeys: Object.fromEntries(SPEECH_SERVICES.map((n) => [n, !!(speechKeysEnc?.[n] || (n === 'azure' && azureSpeechKeyEnc))])),
    // Which search service is in use, and which keys are saved for them.
    searchProvider: load().searchProvider || 'auto',
    searchUrl: load().searchUrl || '',
    searchKeys: Object.fromEntries(SEARCH_SERVICES.map((n) => [n, !!searchKeysEnc?.[n]])),
  };
}

module.exports = { load, save, getApiKey, getClientOptions, setApiKey, isGoogleKey, getSpeechKey, setSpeechKey, getAzureKey, setAzureKey, getSearchKey, setSearchKey, publicView, normalizeBase, isAnthropicKey, SPEECH_SERVICES, SEARCH_SERVICES, ANTHROPIC, GOOGLE_OPENAI, getProviderKey, setProviderKey, setProviderBase };
