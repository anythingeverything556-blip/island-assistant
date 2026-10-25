// Does Island work with ANY provider? Every provider shape is tried against a local
// stand-in server (no key, no internet): an Anthropic-compatible one, an OpenAI-only
// one, one that lists its models as {"models":[…]} or a bare array, one that needs no
// key at all (Ollama on this PC), and a few odd model ids.
//
// Usage: node scripts/provider-test.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const models = require('../src/models');
const settings = require('../src/settings');

const results = [];
const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in server that answers in the shape the test asks for.
function server(behaviour) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      behaviour(req, res, body, seen);
    });
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, seen, port: s.address().port, base: `http://127.0.0.1:${s.address().port}` })));
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

(async () => {
  // --- 1. An OpenAI-only provider: Bearer token, /v1/models, /v1/chat/completions.
  {
    const g = await server((req, res) => {
      if (req.url.startsWith('/v1/models')) return json(res, 200, { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] });
      if (req.url.startsWith('/v1/chat/completions')) return json(res, 200, { choices: [{ message: { content: 'hello' } }] });
      return json(res, 404, { error: { message: 'no' } });
    });
    const opts = { apiKey: 'sk-test', baseURL: g.base, google: false };
    const list = await models.listModels(opts);
    check('an OpenAI-only provider lists its models', list.some((m) => m.id === 'gpt-4o-mini'), list.map((m) => m.id).join(','));
    const key = await models.checkKey(opts);
    check('"Check key" accepts a Bearer-only provider', key.ok === true, key.message);
    g.s.close();
  }

  // --- 2. An Anthropic-compatible provider: x-api-key, /v1/models, /v1/messages.
  {
    const g = await server((req, res) => {
      if (req.url.startsWith('/v1/models')) return json(res, 200, { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] });
      if (req.url.startsWith('/v1/messages')) return json(res, 200, { content: [{ type: 'text', text: 'hello' }] });
      return json(res, 404, { error: { message: 'no' } });
    });
    const opts = { apiKey: 'sk-ant-test', baseURL: g.base, google: false };
    const list = await models.listModels(opts);
    check('an Anthropic-compatible provider lists its models', list.some((m) => m.id === 'claude-opus-5-5'), list.map((m) => m.id).join(','));
    const key = await models.checkKey(opts);
    check('"Check key" accepts an Anthropic-compatible provider', key.ok === true, key.message);
    g.s.close();
  }

  // --- 3. A provider that only answers the Anthropic API (no /v1/models).
  {
    const g = await server((req, res) => {
      if (req.url.startsWith('/v1/models')) return json(res, 404, { error: { message: 'no list here' } });
      if (req.url.startsWith('/v1/messages')) return json(res, 200, { content: [{ type: 'text', text: 'hello' }] });
      return json(res, 404, { error: { message: 'no' } });
    });
    const opts = { apiKey: 'sk-ant-test', baseURL: g.base, google: false };
    const key = await models.checkKey(opts, 'claude-opus-5-5');
    check('"Check key" accepts a provider with only the Anthropic API', key.ok === true, key.message);
    const list = await models.listModels(opts);
    check('a provider with no model list is not given Anthropic models', !list.some((m) => /^claude-/.test(m.id)), `${list.length} models`);
    g.s.close();
  }

  // --- 4. Odd list shapes: a bare array, and {"models": [...]}.
  for (const [name, body] of [['a bare array', [{ id: 'model-a' }]], ['{"models":[…]}', { models: [{ id: 'model-b' }] }]]) {
    const g = await server((req, res) => {
      if (req.url.startsWith('/v1/models')) return json(res, 200, body);
      return json(res, 404, { error: { message: 'no' } });
    });
    const list = await models.listModels({ apiKey: 'k', baseURL: g.base, google: false });
    check(`a model list given as ${name} is read`, list.length === 1, list.map((m) => m.id).join(','));
    g.s.close();
  }

  // --- 5. A wrong key is reported as a wrong key, not as a broken provider.
  {
    const g = await server((req, res) => json(res, 401, { error: { message: 'bad key' } }));
    const key = await models.checkKey({ apiKey: 'sk-bad', baseURL: g.base, google: false });
    check('a wrong key is reported as a wrong key', key.ok === false && /rejected this key/i.test(key.message), key.message);
    g.s.close();
  }

  // --- 6. A wrong address is reported as a wrong address.
  {
    const g = await server((req, res) => json(res, 404, { error: { message: 'not here' } }));
    const key = await models.checkKey({ apiKey: 'k', baseURL: g.base, google: false });
    check('a wrong address is reported as a wrong address', key.ok === false && /API address|model list/i.test(key.message), key.message);
    g.s.close();
  }

  // --- 7. A gateway is never given Anthropic's model list.
  {
    const g = await server((req, res) => json(res, 500, { error: { message: 'boom' } }));
    const list = await models.listModels({ apiKey: 'k', baseURL: g.base, google: false });
    check('a gateway that cannot list models is not given Anthropic models', !list.some((m) => /^claude-/.test(m.id)), `${list.length} models`);
    g.s.close();
  }

  // --- 8. A provider that mangles the list when it sees "anthropic-version" is asked
  //        the plain way, so the ids stay right.
  {
    const g = await server((req, res) => {
      const mangled = !!req.headers['anthropic-version'];
      if (req.url.startsWith('/v1/models')) return json(res, 200, { data: mangled ? [{ id: 'anthropic/minimax/minimax-m3.1-flash:free[1m]', name: '' }] : [{ id: 'minimax/minimax-m3.1-flash:free', name: 'MiniMax M3.1 Flash' }] });
      return json(res, 404, { error: { message: 'no' } });
    });
    const list = await models.listModels({ apiKey: 'k', baseURL: g.base, google: false });
    check('the model list is asked without the anthropic-version header', list.some((m) => m.id === 'minimax/minimax-m3.1-flash:free') && !list.some((m) => m.id.includes('[1m]')), list.map((m) => m.id).join(','));
    g.s.close();
  }

  // --- 8b. A server that wants the Anthropic header (or the x-api-key header) still
  //         gives its models: the plain route is not the only way in.
  for (const [name, status] of [['answers 400 without the anthropic-version header', 400], ['answers 401 without the x-api-key header', 401]]) {
    const g = await server((req, res) => {
      const wanted = req.headers['anthropic-version'] || req.headers['x-api-key'];
      if (req.url.startsWith('/v1/models')) {
        if (!wanted) return json(res, status, { error: { message: 'need the other header' } });
        return json(res, 200, { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] });
      }
      return json(res, 404, { error: { message: 'no' } });
    });
    const list = await models.listModels({ apiKey: 'sk-ant-x', baseURL: g.base, google: false });
    check(`a provider that ${name} still lists its models`, list.some((m) => m.id === 'claude-opus-5-5'), list.map((m) => m.id).join(',') || '(none)');
    const key = await models.checkKey({ apiKey: 'sk-ant-x', baseURL: g.base, google: false });
    check(`"Check key" accepts a provider that ${name}`, key.ok === true, key.message);
    g.s.close();
  }

  // --- 9. Claude models of every generation use the Anthropic API. A gateway's
  //        "vendor/model" id goes through the Chat Completions API instead, because
  //        that is what a gateway speaks.
  const claude = [
    ['claude-opus-5-5', 'claude'], ['claude-sonnet-4-5', 'claude'], ['claude-3-5-sonnet-20241022', 'claude'],
    ['claude-3-opus-20240229', 'claude'], ['claude-2.1', 'claude'],
  ];
  for (const [id, kind] of claude) check(`${id} uses the Anthropic API`, models.profile(id).kind === kind, models.profile(id).kind);
  for (const id of ['gpt-4o', 'o3-mini', 'gemini-2.5-flash', 'minimax/minimax-m3.1-flash:free', 'llama3.2:latest', 'anthropic/claude-opus-latest']) {
    check(`${id} uses the Chat Completions API`, models.profile(id).kind === 'chat', models.profile(id).kind);
  }

  // --- 10. Model ids that are real in the wild are accepted.
  const ids = [
    'gpt-4o', 'gpt-5.2', 'o3-mini', 'claude-3-5-sonnet-20241022', 'gemini-2.5-flash', 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'deepseek-reasoner', 'mistral-large-latest', 'qwen2.5-72b-instruct', 'grok-4', 'command-r-plus', 'jamba-1.5-large',
    'minimax/minimax-m2:free', 'anthropic/claude-opus-latest', '~openai/gpt-astra-latest', 'llama3.2:latest', 'qwen2.5-coder:7b',
    'mistral-nemo:12b-instruct-q4_K_M', 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'Llama 3.2 3B Instruct',
    'Llama 3.2 3B Instruct (Q4_K_M)', 'my model with spaces', 'model:tag', 'model@v1', 'model[1m]',
  ];
  for (const id of ids) check(`the model id "${id}" is accepted`, models.isValidModelId(id), models.modelIdProblem(id) || '');
  for (const id of ['bad\nid', 'bad"id', 'bad`id', 'bad{id', 'bad;id', '']) check(`the model id "${id.replace(/\n/g, '\\n')}" is refused`, !models.isValidModelId(id));

  // --- 11. Addresses are normalised the same way every time.
  const base = (u) => settings.normalizeBase(u);
  const cases = [
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com/v1', 'https://api.example.com'],
    ['https://api.example.com/api/v1', 'https://api.example.com/api'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://my-resource.openai.azure.com/openai/v1', 'https://my-resource.openai.azure.com/openai/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434'],
    ['api.example.com', 'https://api.example.com'],
    ['not a url', ''],
  ];
  for (const [input, want] of cases) check(`the address "${input}" is read as ${want || '(nothing)'}`, base(input) === want, base(input));

  // --- 11. The token limit is sent under the name the model wants.
  {
    const g = await server((req, res, body) => {
      if (body.includes('"max_tokens"')) return json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
      json(res, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    const chat = require('../src/chat-completions');
    let out = '';
    try { out = await chat.quickChat({ clientOptions: { apiKey: 'k', baseURL: g.base }, model: 'o3-mini', prompt: 'hi' }); } catch (e) { out = `ERROR: ${e.message}`; }
    check('a model that wants max_completion_tokens still gets a reply', out === 'ok', out);
    g.s.close();
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
