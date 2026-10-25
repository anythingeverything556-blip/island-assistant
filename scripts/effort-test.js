// Does the effort setting reach the model, in the words that model uses?
// Every case runs against a local stand-in server (no key, nothing leaves the PC).
//
// Usage: node scripts/effort-test.js
const http = require('http');
const path = require('path');
const { Agent } = require('../src/agent');
const chat = require('../src/chat-completions');

const results = [];
const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = [];
const server = http.createServer((req, res) => {
  let body = [];
  req.on('data', (d) => body.push(d));
  req.on('end', () => {
    body = Buffer.concat(body);
    seen.push({ path: req.url, body: body.toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The chat path: the effort goes out as a reasoning effort, named for a gateway.
  const send = (body) => {
    seen.length = 0;
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        let b = [];
        req.on('data', (d) => b.push(d));
        req.on('end', () => {
          seen.push({ path: req.url, body: Buffer.concat(b).toString() });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });
      });
      s.listen(0, '127.0.0.1', async () => {
        const url = `http://127.0.0.1:${s.address().port}/v1/chat/completions`;
        const orig = global.fetch;
        global.fetch = async (u, o) => orig(u, o);
        try {
          await chat.streamChat({ baseURL: `http://127.0.0.1:${s.address().port}`, apiKey: 'k', body, signal: undefined, onText: () => {} });
        } catch (e) { /* the stand-in answers */ }
        global.fetch = orig;
        s.close();
        resolve(JSON.parse(seen[0].body));
      });
    });
  };

  for (const [setting, want] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']]) {
    const b = await send({ model: 'some/reasoning-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: setting } });
    check(`a gateway gets "${want}" for ${setting}`, b.reasoning?.effort === want, JSON.stringify(b.reasoning));
  }

  // A model that does not know the effort: Island asks again with the strongest one.
  let attempts = 0;
  const picky = http.createServer((req, res) => {
    let b = [];
    req.on('data', (d) => b.push(d));
    req.on('end', () => {
      attempts++;
      const body = JSON.parse(Buffer.concat(b).toString());
      if (body.reasoning?.effort === 'xhigh') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "Invalid value for 'effort': 'xhigh' is not supported. Use 'low', 'medium' or 'high'." } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((r) => picky.listen(0, '127.0.0.1', r));
  const pickyBase = `http://127.0.0.1:${picky.address().port}`;
  let got = null;
  try {
    await chat.streamChat({ baseURL: pickyBase, apiKey: 'k', body: { model: 'some/model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'xhigh' } }, signal: undefined, onText: () => {} });
  } catch (e) { got = e.message; }
  check('a model that does not know the effort is asked again with "high"', attempts === 2, `${attempts} attempts, ${got || 'no error'}`);
  picky.close();

  // The agent's own mapping: the app's five steps, named the way each model names them.
  const agent = new Agent({ store: { index: { current: null }, newId: () => 'c1', load: () => null }, getSettings: () => ({}), getClientOptions: () => null, emit: () => {}, toolCtx: {} });
  for (const [setting, want] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'xhigh']]) {
    const n = agent.thinkEffort({ effort: setting }, ['reasoning']);
    check(`a reasoning model is told "${want}" for ${setting}`, n.reasoning?.effort === want, JSON.stringify(n));
  }
  const plain = agent.thinkEffort({ effort: 'high' }, ['tools', 'vision']);
  check('a model that cannot think is not given a reasoning effort', !plain.reasoning, JSON.stringify(plain));
  const unknown = agent.thinkEffort({ effort: 'high' }, null);
  check('a model that does not say is given the effort anyway', unknown.reasoning?.effort === 'high', JSON.stringify(unknown));

  server.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
