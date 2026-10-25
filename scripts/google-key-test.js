// Checks the "start free with a Google key" path against a local stand-in for Google's API
// (no real key, nothing leaves the PC): the chat address, the Gemini model list and default,
// "Check key", one-off requests (titles, memory notes) and web search with Google grounding.
// Usage: node scripts/google-key-test.js
const http = require('http');
const { chatUrl, quickChat } = require('../src/chat-completions');
const models = require('../src/models');
const web = require('../src/web');

let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
const seen = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body });
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const authed = req.headers.authorization === 'Bearer AIzaGOOD' || req.headers['x-goog-api-key'] === 'AIzaGOOD';
    if (!authed) return json(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }]);
    if (req.url === '/v1beta/openai/models') {
      return json(200, { data: ['models/gemini-2.5-flash', 'models/gemini-2.5-pro', 'models/gemini-3.0-flash', 'models/gemini-3.0-flash-preview', 'models/text-embedding-004', 'models/gemini-2.5-flash-preview-tts', 'models/imagen-4'].map((id) => ({ id })) });
    }
    if (req.url === '/v1beta/openai/chat/completions') return json(200, { choices: [{ message: { content: 'Weekend trip ideas' } }] });
    if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(req.url)) {
      return json(200, { candidates: [{ content: { parts: [{ text: 'Mumbai will be sunny tomorrow, 31°C.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://weather.example/mumbai', title: 'Mumbai weather' } }] } }] });
    }
    json(404, { error: { message: 'not found' } });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = { apiKey: 'AIzaGOOD', baseURL: `${base}/v1beta/openai`, google: true };
  web.URLS.google = `${base}/v1beta`;
  try {
    check("Google's chat address has no extra /v1", chatUrl(opts.baseURL) === `${base}/v1beta/openai/chat/completions`);
    check('a gateway address still gets /v1', chatUrl('https://api.example.com') === 'https://api.example.com/v1/chat/completions');

    const list = await models.listModels(opts);
    const ids = list.map((m) => m.id);
    check('the model list shows only Gemini chat models', ids.length === 4 && ids.every((id) => /^gemini-/.test(id)) && !ids.some((id) => /tts|embedding/.test(id)), ids.join(', '));
    check('newest first, stable before preview', ids[0] === 'gemini-3.0-flash' && ids.indexOf('gemini-3.0-flash') < ids.indexOf('gemini-3.0-flash-preview'));
    check('Gemini models can use the PC through tools', list.every((m) => m.computer && m.kind === 'chat'));
    check('the default model is the newest stable Flash', models.defaultGoogleModel(list) === 'gemini-3.0-flash');

    let r = await models.checkKey(opts);
    check('"Check key" accepts a good key', r.ok, r.message);
    r = await models.checkKey({ ...opts, apiKey: 'AIzaBAD' });
    check('"Check key" explains a bad key', !r.ok && /didn't accept this key/.test(r.message), r.message);

    const title = await quickChat({ clientOptions: opts, model: 'gemini-3.0-flash', prompt: 'Title this chat' });
    const sent = JSON.parse(seen.find((s) => s.url.endsWith('/chat/completions')).body);
    check('one-off requests (titles, memory notes) work', title === 'Weekend trip ideas' && sent.model === 'gemini-3.0-flash');

    const s = await web.search('weather in Mumbai tomorrow', { clientOptions: opts, model: 'gemini-3.0-flash' });
    const g = seen.find((x) => /generateContent/.test(x.url));
    check('web search uses Google Search grounding', /google_search/.test(g.body) && g.url.includes('gemini-3.0-flash'));
    check('search returns the digest and its sources', /sunny/.test(s.content) && s.sources[0]?.url === 'https://weather.example/mumbai');
  } catch (e) {
    failed++;
    console.log('FAIL  test run:', e.stack || e.message);
  } finally {
    server.close();
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    setTimeout(() => process.exit(failed ? 1 : 0), 100);
  }
})();
