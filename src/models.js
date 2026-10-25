// Model catalogue (from the API's model list) and per-model request capabilities.
const Anthropic = require('@anthropic-ai/sdk');

// Gateway routers pick a model per request; they accept a plain Messages request
// (tools, computer use, web search) but not Claude-specific thinking/effort fields.
const ROUTERS = new Set(['auto', 'default', 'balanced', 'best', 'beta-auto']);

const FALLBACK_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'anthropic' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'anthropic' },
];

// What a request to this model may include.
function profile(id) {
  if (ROUTERS.has(id)) {
    return { kind: 'router', supported: true, thinking: false, effort: false, fallbacks: false, computer: true, web: 'basic' };
  }
  // Any Claude model, whatever it is called: "claude-opus-5-5", "claude-3-5-sonnet-20241022",
  // "claude-2.1". The name after "claude-" may be the family (opus, sonnet, haiku) or the
  // version first ("3-5-sonnet"), so both orders are read.
  const m = /^claude-(?:(opus|sonnet|haiku|fable|mythos|instant)-)?(\d+)(?:[.-](\d+))?/i.exec(String(id || ''));
  if (!m) {
    // Served via /v1/chat/completions; no Claude-only features (thinking, computer, server tools).
    return { kind: 'chat', supported: true, chat: true, thinking: false, effort: false, fallbacks: false, computer: false, web: null };
  }
  const family = (m[1] || '').toLowerCase();
  const ver = Number(m[2] || 0) + (m[3] ? Number(m[3]) / 10 : 0);
  const modern = ver >= 4.6;
  return {
    kind: 'claude',
    supported: true,
    thinking: modern, // adaptive thinking; older models would need budget_tokens
    effort: modern,
    fallbacks: ver >= 5,
    computer: ver >= 5, // computer_toolset_20260801
    web: modern && family !== 'haiku' ? 'dynamic' : 'basic',
  };
}

let cache = { at: 0, key: null, list: null };

// Gemini chat models from a Google AI Studio key (its OpenAI-compatible model list), newest
// first. Gemini sees images and calls tools, so it can use the PC through Island's tools.
const GOOGLE_FALLBACK = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'];
async function listGoogle(opts) {
  let ids = GOOGLE_FALLBACK;
  try {
    const res = await fetch(`${opts.baseURL.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${opts.apiKey}` }, signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    const found = (j.data || []).map((m) => String(m.id).replace(/^models\//, '')).filter((id) => /^gemini-/.test(id) && !/embedding|tts|image|live|audio|aqa|vision$/.test(id));
    if (found.length) ids = found;
  } catch { /* offline: the usual ones */ }
  const ver = (id) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] || 0);
  ids = [...new Set(ids)].sort((a, b) => ver(b) - ver(a) || /preview|exp/.test(a) - /preview|exp/.test(b) || a.length - b.length);
  const pretty = (id) => id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ').replace(/\b(flash|pro|lite|preview)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
  return decorate(ids.map((id) => ({ id, name: pretty(id), provider: 'google', caps: ['vision', 'tools'] })));
}

// The model to start with on a Google key: the newest stable Flash (fast, has a free tier).
function defaultGoogleModel(list) {
  return (list.find((m) => /^gemini-[\d.]+-flash$/.test(m.id)) || list[0])?.id || 'gemini-2.5-flash';
}

// A gateway's own model list, asked for the plain way.
//
// The Anthropic client always sends an "anthropic-version" header, and some gateways
// (OpenRouter among them) answer that with a different, much smaller list whose ids
// are rewritten ("anthropic/minimax/minimax-m3.1-flash:free[1m]") and whose names are
// empty. Asking without that header gives the real ids ("minimax/minimax-m3.1-flash:free")
// and the real names, so the plain route is tried first and the Anthropic one second.
async function listGateway(opts) {
  const base = String(opts.baseURL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { status: 0, list: [], shape: false };
  const url = /\/openai(\/v1)?$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${opts.apiKey}` }, signal: AbortSignal.timeout(15000) });
  } catch {
    return { status: 0, list: [] };
  }
  if (!res.ok) return { status: res.status, list: [], shape: false };
  const j = await res.json().catch(() => null);
  // Servers spell the list differently: {data:[…]}, a bare array, {models:[…]}, {result:{data:[…]}}.
  const data = Array.isArray(j) ? j
    : Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.models) ? j.models
    : Array.isArray(j?.items) ? j.items
    : Array.isArray(j?.result?.data) ? j.result.data
    : Array.isArray(j?.result?.models) ? j.result.models
    : null;
  if (!Array.isArray(data)) return { status: res.status, list: [], shape: false };
  return {
    status: res.status,
    shape: true, // the server answered with a list, even if it is empty
    list: data
      .filter((m) => m && (m.id || m.name || typeof m === 'string'))
      .map((m) => {
        if (typeof m === 'string') return { id: m, name: m, provider: 'other', caps: [], context: null, maxOutput: null, priceIn: null, priceOut: null };
        return {
          id: String(m.id || m.name),
          name: m.name || m.display_name || m.id,
          provider: m.provider || (String(m.id || '').includes('/') ? String(m.id).split('/')[0] : 'other'),
          caps: capsOf(m),
          context: m.context_length || m.context_window || m.max_input_tokens || null,
          maxOutput: m.max_completion_tokens || m.top_provider?.max_completion_tokens || m.max_output_tokens || m.max_tokens || null,
          priceIn: perMTok(m.pricing?.prompt ?? m.pricing?.in_usd_per_mtok),
          priceOut: perMTok(m.pricing?.completion ?? m.pricing?.out_usd_per_mtok),
        };
      }),
  };
}

// What a model can do, from the gateway's own description of it.
function capsOf(m) {
  const caps = [];
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const inMods = m.architecture?.input_modalities;
  if (params.includes('tools') || params.includes('tool_choice')) caps.push('tools');
  if (params.includes('reasoning') || params.includes('include_reasoning')) caps.push('reasoning');
  if (Array.isArray(inMods) ? inMods.includes('image') : params.includes('image') || params.includes('input_image')) caps.push('vision');
  return caps;
}

// Gateways quote the price per token; Island shows it per million tokens.
const perMTok = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n * 1e6 : null;
};

async function listModels(clientOptions) {
  if (!clientOptions) return decorate(FALLBACK_MODELS);
  const key = `${clientOptions.baseURL}|${clientOptions.apiKey.slice(-6)}`;
  if (cache.list && cache.key === key && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  if (clientOptions.google) {
    const list = await listGoogle(clientOptions);
    cache = { at: Date.now(), key, list };
    return list;
  }
  const isAnthropic = /^https:\/\/api\.anthropic\.com/i.test(clientOptions.baseURL);
  // A gateway (anything that is not Anthropic's own address): ask it directly first.
  if (!isAnthropic) {
    const raw = await listGateway(clientOptions).catch(() => null);
    if (raw?.list?.length) {
      const list = decorate(raw.list);
      cache = { at: Date.now(), key, list };
      return list;
    }
    // No models from the plain route: the Anthropic route is tried as well, for
    // servers that speak only that API (or that want the x-api-key header). If that
    // gives nothing either, this provider simply has no models for us - which is not
    // a reason to offer Anthropic's models.
  }
  try {
    const client = new Anthropic(clientOptions);
    const raw = [];
    for await (const m of client.models.list({ limit: 1000 })) raw.push(m);
    const list = decorate(
      raw.map((m) => ({
        id: m.id,
        name: m.display_name || m.name || m.id,
        provider: m.provider || (ROUTERS.has(m.id) ? 'router' : /^claude-/.test(m.id) ? 'anthropic' : 'other'),
        caps: m.caps || m.capabilities || null,
        context: m.context_window || m.max_input_tokens || null,
        maxOutput: m.max_output_tokens || m.max_tokens || null,
        priceIn: m.pricing?.in_usd_per_mtok ?? null,
        priceOut: m.pricing?.out_usd_per_mtok ?? null,
      }))
    );
    cache = { at: Date.now(), key, list };
    return list;
  } catch {
    // Anthropic's own models are only a sensible fallback for Anthropic's own address.
    const list = decorate(isAnthropic ? FALLBACK_MODELS : []);
    cache = { at: Date.now(), key, list };
    return list;
  }
}

const ROUTER_NAMES = { auto: 'Auto', default: 'Default', balanced: 'Balanced', best: 'Best', 'beta-auto': 'Beta auto' };

function decorate(list) {
  return list.map((m) => {
    const p = profile(m.id);
    const name = ROUTERS.has(m.id) ? `${ROUTER_NAMES[m.id] || m.id} router` : m.name;
    // Chat Completions models can drive the computer through a function tool if they see
    // images and call tools. A provider that lists no capabilities at all (Cerebras and
    // others) doesn't get to keep the computer away: the model is tried as is, and Island
    // steps down gracefully for the few things it can't do (see computerMode in agent.js).
    const computer = !!p.computer || (p.kind === 'chat' && (!m.caps || (m.caps.includes('vision') && m.caps.includes('tools'))));
    return { ...m, name, provider: ROUTERS.has(m.id) ? 'router' : m.provider, kind: p.kind, supported: p.supported, computer, effort: !!p.effort };
  });
}

// Listing data for one model (caps, output limit), if the list has been fetched.
function modelMeta(id) {
  return cache.list?.find((m) => m.id === id) || null;
}

// "Check key" in Settings: one small request, explained in plain words.
//
// Two styles of API are in the wild, and a provider may speak either or both:
// the Anthropic one (x-api-key + anthropic-version) and the OpenAI one
// (Authorization: Bearer). Both are tried, so a working key is never called broken.
async function checkKey(opts, model = '') {
  if (!opts) return { ok: false, message: 'No API key yet.' };
  let host = '';
  try { host = new URL(opts.baseURL).host; } catch { return { ok: false, message: "That API address doesn't look like a web address." }; }
  if (opts.google) {
    try {
      const res = await fetch(`${opts.baseURL.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${opts.apiKey}` }, signal: AbortSignal.timeout(15000) });
      if (res.ok) return { ok: true, host, message: 'Key works with Google AI Studio' };
      const j = await res.json().catch(() => ({}));
      const why = (Array.isArray(j) ? j[0] : j)?.error?.message || '';
      if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, host, status: res.status, message: `Google didn't accept this key. Copy it again from aistudio.google.com → Get API key.${why ? ` (${why.slice(0, 120)})` : ''}` };
      if (res.status === 429) return { ok: true, warn: true, host, status: 429, message: 'The key works, but the free limit is used up for now. It resets daily.' };
      return { ok: false, host, status: res.status, message: `Google said ${res.status}: ${why.slice(0, 160)}` };
    } catch {
      return { ok: false, host, message: "Couldn't reach Google. Check your internet connection." };
    }
  }
  const isAnthropic = /^https:\/\/api\.anthropic\.com/i.test(opts.baseURL);
  // Anthropic's own address speaks the Anthropic API; a gateway may speak either.
  const tries = isAnthropic ? [anthropicTry, plainTry] : [plainTry, anthropicTry];
  const results = [];
  for (const tryIt of tries) {
    const r = await tryIt(opts, host, model);
    results.push(r);
    if (r.ok) return r;
  }
  // Nothing worked: say the most likely reason (a real status beats "no answer").
  const withStatus = results.filter((r) => r.status && r.status !== 404);
  const best = withStatus[0] || results.find((r) => r.status) || results[0];
  return best;
}

// The Anthropic way: GET /v1/models with x-api-key.
async function anthropicTry(opts, host, model) {
  try {
    const page = await new Anthropic({ ...opts, timeout: 15000, maxRetries: 0 }).models.list({ limit: 5 });
    return { ok: true, host, message: `Key works with ${host}${page.data?.length ? '' : ' (no models listed)'}` };
  } catch (e) {
    const st = e?.status;
    // No model list here. A server that only speaks the Anthropic API still answers
    // /v1/messages, so the key is checked there (the smallest possible request).
    if (st === 404 && model) {
      try {
        await new Anthropic({ ...opts, timeout: 15000, maxRetries: 0 }).messages.create({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
        return { ok: true, host, message: `Key works with ${host}` };
      } catch (e2) {
        if (!e2?.status) return { ok: false, host, status: 0, message: `Couldn't reach ${host}. Check the API address and your internet connection.` };
      }
    }
    let message;
    if (st === 401 || st === 403) {
      message = `${host} rejected this key.` + (host === 'api.anthropic.com' && !/^sk-ant-/.test(opts.apiKey) ? " It isn't an Anthropic key (those start with sk-ant-), so it probably belongs to a gateway: put that gateway's address in API address." : ' Check that the key and API address belong together.');
    } else if (st === 402) message = `The key works with ${host}, but the account is out of credits.`;
    else if (st === 404) message = `${host} answered, but not like an Anthropic-compatible API. Check the API address.`;
    else if (!st) message = `Couldn't reach ${host}. Check the API address and your internet connection.`;
    else message = `${host} said ${st}: ${String(e.message || '').slice(0, 160)}`;
    return { ok: st === 402, warn: st === 402, host, status: st || null, message };
  }
}

// The OpenAI way: GET /v1/models with a Bearer token. Most providers that are not
// Anthropic answer here, so a working key is never called broken.
async function plainTry(opts, host) {
  const base = String(opts.baseURL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, host, status: 0, message: `Couldn't reach ${host}. Check the API address.` };
  const url = /\/openai(\/v1)?$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      const n = Array.isArray(j) ? j.length : Array.isArray(j?.data) ? j.data.length : Array.isArray(j?.models) ? j.models.length : 0;
      return { ok: true, host, message: `Key works with ${host}${n ? ` (${n} models)` : ''}` };
    }
    const j = await res.json().catch(() => ({}));
    const why = j?.error?.message || j?.message || '';
    if (res.status === 429) return { ok: true, warn: true, host, status: 429, message: `The key works with ${host}, but the free limit is used up for now.` };
    if (res.status === 401 || res.status === 403) return { ok: false, host, status: res.status, message: `${host} rejected this key. Check that the key and API address belong together.` };
    if (res.status === 404) return { ok: false, host, status: 404, message: `${host} has no model list at that address. Check the API address.` };
    return { ok: false, host, status: res.status, message: `${host} said ${res.status}: ${String(why).slice(0, 160)}` };
  } catch {
    return { ok: false, host, status: 0, message: `Couldn't reach ${host}. Check the API address and your internet connection.` };
  }
}

// Other listed copies of the same model from different providers ("deepseek-v4-flash" ->
// "deepseek-v4-flash-deepinfra", "-0731", ...), for when its usual provider is down.
function siblingModels(id) {
  const list = cache.list || [];
  const me = list.find((m) => m.id === id);
  const needs = (me?.caps || []).filter((c) => c === 'tools');
  return list
    .filter((m) => m.id !== id && m.id.startsWith(`${id}-`) && needs.every((c) => m.caps?.includes(c)))
    .sort((a, b) => /vision/.test(a.id) - /vision/.test(b.id) || a.id.length - b.id.length)
    .map((m) => m.id)
    .slice(0, 3);
}

// What a model id may contain. Gateways use slugs like "minimax/minimax-m2:free",
// "anthropic/claude-opus-latest" or "~openai/gpt-astra-latest", and some add a
// "[1m]" suffix for a longer context. Local servers use their own display names, with
// spaces and brackets: "Llama 3.2 3B Instruct (Q4_K_M)". So anything printable is
// allowed except the few characters that could break a request.
const MODEL_ID = /^[^\u0000-\u001f\u007f"'\\`{};<>]{1,200}$/;
const isValidModelId = (id) => MODEL_ID.test(String(id || '').trim());

// A model id is fine, but say which character is not, so it can be fixed.
function modelIdProblem(id) {
  const s = String(id || '').trim();
  if (!s) return 'the model id is empty';
  if (s.length > 200) return 'the model id is too long';
  const bad = [...new Set(s.split('').filter((c) => !MODEL_ID.test(c)))];
  return bad.length ? `the character${bad.length > 1 ? 's' : ''} ${bad.map((c) => `"${c}"`).join(', ')} cannot be in a model id` : null;
}

module.exports = { profile, listModels, modelMeta, checkKey, siblingModels, defaultGoogleModel, ROUTERS, isValidModelId, modelIdProblem };
