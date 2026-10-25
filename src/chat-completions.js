// Chat Completions adapter for models the gateway serves only through
// /v1/chat/completions (GPT, Gemini, Grok, DeepSeek, Qwen, ...).
// The conversation is stored in Messages-API shape, so it is converted on the way
// out and the streamed reply is converted back into text / tool_use blocks.

const crypto = require('crypto');

// Turn our Messages-shaped history into Chat Completions messages.
//  - toolNames: functions offered this request; other past tool calls become text
//  - vision: whether images may be sent
//  - extras: provider data to echo back per tool call (e.g. Gemini thought signatures)
function toChatMessages({ system, messages, toolNames, vision, extras }) {
  const out = [{ role: 'system', content: system }];
  const realCalls = new Set();
  const asBlocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c || []);

  for (const m of messages) {
    const blocks = asBlocks(m.content);
    if (m.role === 'assistant') {
      const text = [];
      const calls = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) text.push(b.text);
        else if (b.type === 'tool_use' && !b.toolset_name && toolNames.has(b.name)) {
          realCalls.add(b.id);
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, ...(extras[b.id] ? { extra_content: extras[b.id] } : {}) });
        } else if (b.type === 'tool_use') text.push(`[Used ${b.toolset_name ? b.toolset_name + '.' : ''}${b.name} ${JSON.stringify(b.input ?? {})}]`);
        else if (b.type === 'server_tool_use') text.push(`[Searched the web: ${JSON.stringify(b.input ?? {})}]`);
      }
      const msg = { role: 'assistant', content: text.join('\n\n') || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }

    // user turn: tool results first (they must follow the assistant's tool_calls), then the rest
    const parts = [];
    const toolImages = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        for (const x of Array.isArray(b.content) ? b.content : []) if (x.type === 'image') toolImages.push(x);
        const body = (b.is_error ? 'Error: ' : '') + (content || (toolImages.length ? '(image attached below)' : 'OK'));
        if (realCalls.has(b.tool_use_id)) out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: body });
        else parts.push({ type: 'text', text: `[Tool result] ${body}` });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        parts.push(imagePart(b, vision));
      } else if (b.type === 'document') {
        parts.push({ type: 'text', text: `[A PDF named "${b.title || 'document'}" was attached, but this model can't read PDFs here.]` });
      }
    }
    if (toolImages.length) {
      parts.push({ type: 'text', text: 'Image(s) returned by the tool:' });
      for (const img of toolImages) parts.push(imagePart(img, vision));
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

function imagePart(b, vision) {
  if (!vision || b.source?.type !== 'base64') return { type: 'text', text: '[An image was attached, but this model cannot see images.]' };
  return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
}

// Our tool definitions -> Chat Completions function tools.
function toChatTools(defs) {
  return defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

// Tool call ids end up in Messages-API history too, which only allows [A-Za-z0-9_-].
const safeId = (id) => (id && /^[\w-]+$/.test(id) ? id : `call_${crypto.randomBytes(9).toString('hex')}`);

// Stream one completion. Returns { content, stopReason, usage, model, extras }.
// Statuses worth another try: rate limits, gateway hiccups, overloaded providers.
const RETRY = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const wait = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// POST with up to 2 retries for temporary failures (nothing has streamed yet, so it's safe).
async function post(url, headers, body, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted || attempt >= 2) throw e;
      await wait(800 * (attempt + 1), signal);
      continue;
    }
    if (!RETRY.has(res.status) || attempt >= 2) return res;
    const after = Number(res.headers.get('retry-after'));
    await res.text().catch(() => '');
    await wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 8000) : 900 * (attempt + 1), signal);
    if (signal?.aborted) return res;
  }
}

// The Chat Completions address for a base URL. Gateways put it under /v1; Google's
// OpenAI-compatible endpoint (…/v1beta/openai) has it straight under the base, and so
// does a gateway that lives under /openai/v1.
function chatUrl(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (/\/openai(\/v1)?$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// One short request, no streaming or tools (chat titles, memory notes). Resolves the text.
async function quickChat({ clientOptions, model, system, prompt, maxTokens = 600, signal }) {
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${clientOptions.apiKey}`, 'x-api-key': clientOptions.apiKey };
  const body = { model, max_tokens: maxTokens, messages };
  const url = chatUrl(clientOptions.baseURL);
  let res = await post(url, headers, tokenField(body), signal);
  if (res.status === 400) {
    // The model wants the token limit under a different name: give it that.
    const text = await res.text();
    if (/max_completion_tokens/i.test(text) && body.max_tokens != null) {
      const { max_tokens, ...rest } = body;
      res = await post(url, headers, { ...rest, max_completion_tokens: max_tokens }, signal);
    } else {
      throw httpError(400, text);
    }
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, j.error?.message || JSON.stringify(j).slice(0, 200));
  return String(j.choices?.[0]?.message?.content || '');
}

// Newer OpenAI models (o1, o3, gpt-5) want the token limit under a new name and
// refuse "max_tokens" outright.
const tokenField = (body) => {
  if (body.max_tokens == null || !/^(o\d|gpt-5)/i.test(String(body.model || ''))) return body;
  const { max_tokens, ...rest } = body;
  return { ...rest, max_completion_tokens: max_tokens };
};

async function streamChat({ baseURL, apiKey, body, signal, onText, onReasoning, onToolCall }) {
  const url = chatUrl(baseURL);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };

  // Newer OpenAI models (o1, o3, gpt-5) want the token limit under a new name and
  // refuse "max_tokens" outright.
  const send = tokenField(body);

  let res = await post(url, headers, send, signal);
  if (res.status === 400) {
    // Some models reject optional fields; retry once with the bare minimum.
    const text = await res.text();
    if (/max_completion_tokens/i.test(text) && body.max_tokens != null) {
      // It wants the new name for the limit: give it that, not no limit.
      const { max_tokens, ...rest } = send;
      res = await post(url, headers, { ...rest, max_completion_tokens: body.max_tokens }, signal);
    } else if (/effort/i.test(text) && send.reasoning?.effort && send.reasoning.effort !== 'high') {
      // It does not know that effort (models differ): try the strongest one it has.
      res = await post(url, headers, { ...send, reasoning: { ...send.reasoning, effort: 'high' } }, signal);
    } else if (/max_tokens|stream_options|max_completion_tokens|reasoning/i.test(text)) {
      const { max_tokens, stream_options, reasoning, ...rest } = send;
      res = await post(url, headers, rest, signal);
    } else {
      throw httpError(400, text);
    }
  }
  if (!res.ok) throw httpError(res.status, await res.text());

  let text = '';
  let finish = null;
  let usage = null;
  let model = body.model;
  const calls = []; // by index: { id, name, args, extra }
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) throw httpError(ev.error.code || 500, JSON.stringify(ev.error));
      if (ev.model) model = ev.model;
      if (ev.usage) usage = ev.usage;
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.content) {
        text += d.content;
        onText?.(d.content);
      }
      const reasoning = d.reasoning_content || d.reasoning;
      if (typeof reasoning === 'string' && reasoning) onReasoning?.(reasoning);
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        const c = (calls[i] ||= { id: null, name: '', args: '', extra: null });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) {
          if (!c.name) onToolCall?.(i, tc.function.name);
          c.name = c.name || tc.function.name;
        }
        if (tc.function?.arguments) c.args += tc.function.arguments;
        if (tc.extra_content) c.extra = { ...(c.extra || {}), ...tc.extra_content };
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }

  const content = [];
  if (text) content.push({ type: 'text', text });
  const extras = {};
  for (const c of calls.filter(Boolean)) {
    const id = safeId(c.id);
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { __invalid_json: c.args.slice(0, 200) }; }
    content.push({ type: 'tool_use', id, name: c.name, input });
    if (c.extra) extras[id] = c.extra;
  }
  const hasCalls = content.some((b) => b.type === 'tool_use');
  return {
    content: content.length ? content : [{ type: 'text', text: '(no response)' }],
    stopReason: hasCalls ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0 },
    model,
    extras,
  };
}

function httpError(status, raw) {
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg = j.error?.message || j.message || raw;
  } catch {}
  const e = new Error(`${status}: ${String(msg).slice(0, 400)}`);
  e.status = status;
  return e;
}

module.exports = { toChatMessages, toChatTools, streamChat, chatUrl, quickChat };
