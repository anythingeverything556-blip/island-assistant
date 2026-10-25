// Tests the pluggable web-search providers in src/web.js against a local stand-in for each
// one: no real key, nothing leaves the PC. Every provider is pointed at the stand-in through
// the exported URLS object (SearXNG gets its address through the url option instead), and
// the stand-in records every request, so the test can check the key, the body, the URL and
// the results each service sent back.
// Usage: node scripts/search-providers-test.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const web = require('../src/web');

let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
const section = (name) => console.log(`\n${name}`);

// Every request the providers made: method, path, headers, body.
const seen = [];
const mark = () => seen.length;
const took = (from, who) => seen.slice(from).filter((s) => s.who === who);

// Run something that may fail and keep the error, so a broken service is a failed check
// and not a crashed test.
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e }; } };
const why = (r) => (r.ok ? '' : `${r.error?.name || 'Error'}: ${r.error?.message || r.error}`);

// What the stand-in answers for each service. The titles and urls are the ones the test
// looks for afterwards.
const PAYLOADS = {
  tavily: {
    answer: 'Tavily has the answer.',
    results: [{ title: 'Tavily page title', url: 'https://tavily.example/page', content: 'Tavily snippet about the topic.' }],
  },
  brave: {
    web: { results: [{ title: 'Brave page title', url: 'https://brave.example/page', description: 'Brave snippet about the topic.' }] },
  },
  serper: {
    organic: [{ title: 'Serper page title', link: 'https://serper.example/page', snippet: 'Serper snippet about the topic.' }],
  },
  exa: {
    results: [{ title: 'Exa page title', url: 'https://exa.example/page', highlights: ['Exa snippet about the topic.'] }],
  },
  firecrawl: {
    success: true,
    data: { web: [{ url: 'https://firecrawl.example/page', title: 'Firecrawl page title', description: 'Firecrawl snippet about the topic.' }] },
    web: [{ url: 'https://wrong.example/page', title: 'Wrong place title' }], // a decoy: the results must come from data.web
  },
  searxng: {
    answers: ['SearXNG has the answer.'],
    results: [{ title: 'SearXNG page title', url: 'https://searxng.example/page', content: 'SearXNG snippet about the topic.' }],
  },
  google: {
    candidates: [{
      content: { parts: [{ text: 'Google digest of the topic.' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://google.example/page', title: 'Google page title' } }] },
    }],
  },
};

// DuckDuckGo answers with a page of HTML, not with JSON.
const DDG_HTML = [
  '<html><body>',
  '<div class="result">',
  '<a class="result__a" href="https://duckduckgo.example/direct">DuckDuckGo direct title</a>',
  '<a class="result__snippet" href="https://duckduckgo.example/direct">DuckDuckGo snippet about the topic.</a>',
  '</div>',
  '<div class="result">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.example%2Fwrapped&rut=xyz">DuckDuckGo wrapped title</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.example%2Fwrapped">DuckDuckGo wrapped snippet.</a>',
  '</div>',
  '</body></html>',
].join('\n');

// The path decides what happens: /<mode>/<service>, and SearXNG adds /search of its own.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const mode = parts[0] || 'ok';
    const who = parts[1] || '';
    seen.push({ mode, who, method: req.method, path: req.url, pathname: url.pathname, query: url.searchParams, headers: req.headers, body });
    if (mode === 'hang') return; // never answers
    if (mode === '401' || mode === '402' || mode === '403' || mode === '429') {
      res.writeHead(Number(mode), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'the stand-in says no' }));
    }
    if (mode === '500') {
      res.writeHead(500, { 'content-type': 'text/html' });
      return res.end('<html>the stand-in is unwell</html>');
    }
    if (mode === 'bad') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"results": [ this is not json');
    }
    if (who === 'ddg') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(DDG_HTML);
    }
    const payload = PAYLOADS[who];
    if (!payload) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no such service' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

// The same two things every service has to do: hand back the page it found, and name that
// page in the digest so the model can cite it.
const checkResult = (label, r, title, url) => {
  check(`${label} gives the title and the url of the page it found`, r.sources?.[0]?.title === title && r.sources?.[0]?.url === url, JSON.stringify(r.sources?.[0] || {}));
  check(`${label} digest names the page so the model can cite it`, String(r.content || '').includes(title) && String(r.content || '').includes(url));
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Every provider now points at the stand-in. SearXNG has no entry in URLS: it comes
  // from the url option of the search call.
  web.URLS.tavily = `${base}/ok/tavily`;
  web.URLS.brave = `${base}/ok/brave`;
  web.URLS.serper = `${base}/ok/serper`;
  web.URLS.exa = `${base}/ok/exa`;
  web.URLS.firecrawl = `${base}/ok/firecrawl`;
  web.URLS.duckduckgo = `${base}/ok/ddg`;
  web.URLS.google = `${base}/ok/google`;
  const searxngUrl = `${base}/ok/searxng`;

  section('Tavily');
  {
    const from = mark();
    const r = await attempt(() => web.search('best coffee in berlin', { provider: 'tavily', keys: { tavily: 'tv-key' }, signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'tavily')[0];
    check('Tavily answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('Tavily', r.value, 'Tavily page title', 'https://tavily.example/page');
    check('Tavily sends the key as a bearer token', req?.headers.authorization === 'Bearer tv-key', req?.headers.authorization);
    const body = req ? JSON.parse(req.body || '{}') : {};
    check('Tavily is asked over POST with the query and its own options', req?.method === 'POST' && body.query === 'best coffee in berlin' && body.max_results === 8 && body.search_depth === 'basic' && body.include_answer === 'basic', JSON.stringify(body));
  }

  section('Brave Search');
  {
    const from = mark();
    const r = await attempt(() => web.search('brave query', { provider: 'brave', keys: { brave: 'br-key' }, signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'brave')[0];
    check('Brave answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('Brave', r.value, 'Brave page title', 'https://brave.example/page');
    check('Brave sends the key in the subscription token header', req?.headers['x-subscription-token'] === 'br-key', req?.headers['x-subscription-token']);
    check('Brave is asked over GET with the query in the url', req?.method === 'GET' && req?.query.get('q') === 'brave query' && req?.query.get('count') === '10', req?.path);
  }

  section('Serper');
  {
    const from = mark();
    const r = await attempt(() => web.search('serper query', { provider: 'serper', keys: { serper: 'sp-key' }, signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'serper')[0];
    check('Serper answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('Serper', r.value, 'Serper page title', 'https://serper.example/page');
    check('Serper sends the key in the api key header', req?.headers['x-api-key'] === 'sp-key', req?.headers['x-api-key']);
    const body = req ? JSON.parse(req.body || '{}') : {};
    check('Serper is asked over POST with the query and its own options', req?.method === 'POST' && body.q === 'serper query' && body.num === 10 && body.gl === 'in' && body.hl === 'en', JSON.stringify(body));
  }

  section('Exa');
  {
    const from = mark();
    const r = await attempt(() => web.search('exa query', { provider: 'exa', keys: { exa: 'ex-key' }, signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'exa')[0];
    check('Exa answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('Exa', r.value, 'Exa page title', 'https://exa.example/page');
    check('Exa sends the key in the api key header', req?.headers['x-api-key'] === 'ex-key', req?.headers['x-api-key']);
    const body = req ? JSON.parse(req.body || '{}') : {};
    check('Exa is asked over POST with the query and its own options', req?.method === 'POST' && body.query === 'exa query' && body.numResults === 8 && body.type === 'auto' && body.contents?.highlights === true, JSON.stringify(body));
  }

  section('Firecrawl');
  {
    const from = mark();
    const r = await attempt(() => web.search('firecrawl query', { provider: 'firecrawl', keys: { firecrawl: 'fc-key' }, signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'firecrawl')[0];
    check('Firecrawl answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('Firecrawl', r.value, 'Firecrawl page title', 'https://firecrawl.example/page');
    check('Firecrawl sends the key as a bearer token', req?.headers.authorization === 'Bearer fc-key', req?.headers.authorization);
    const body = req ? JSON.parse(req.body || '{}') : {};
    check('Firecrawl asks for exactly the fields it means to', req?.method === 'POST' && JSON.stringify(Object.keys(body).sort()) === '["highlights","limit","query","sources"]', JSON.stringify(body));
    check('Firecrawl asks for web sources only, with no highlights', body.query === 'firecrawl query' && body.limit > 0 && JSON.stringify(body.sources) === '["web"]' && body.highlights === false, JSON.stringify(body));
    check('Firecrawl results come out of data.web', r.ok && r.value.sources?.[0]?.url === 'https://firecrawl.example/page' && r.value.sources?.[0]?.url !== 'https://wrong.example/page');
  }

  section('SearXNG');
  {
    const from = mark();
    const r = await attempt(() => web.search('searxng query', { provider: 'searxng', url: searxngUrl, signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'searxng')[0];
    check('SearXNG answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('SearXNG', r.value, 'SearXNG page title', 'https://searxng.example/page');
    check('SearXNG is asked over GET for the json format', req?.method === 'GET' && req?.pathname === '/ok/searxng/search' && req?.query.get('format') === 'json' && req?.query.get('q') === 'searxng query', req?.path);
    check('SearXNG needs no key', !req?.headers.authorization && !req?.headers['x-api-key']);
  }

  section('DuckDuckGo');
  {
    const from = mark();
    const r = await attempt(() => web.search('duckduckgo query', { provider: 'duckduckgo', signal: AbortSignal.timeout(10000) }));
    const req = took(from, 'ddg')[0];
    check('DuckDuckGo answers with a digest and its sources', r.ok, why(r));
    if (r.ok) checkResult('DuckDuckGo', r.value, 'DuckDuckGo direct title', 'https://duckduckgo.example/direct');
    check('DuckDuckGo is asked over GET with the query in the url', req?.method === 'GET' && req?.query.get('q') === 'duckduckgo query', req?.path);
    check('DuckDuckGo unwraps its own redirect links', r.ok && r.value.sources?.[1]?.url === 'https://duckduckgo.example/wrapped', r.ok ? r.value.sources?.[1]?.url : '');
    check('DuckDuckGo needs no key', !req?.headers.authorization && !req?.headers['x-api-key']);
  }

  section('A service that says no');
  {
    web.URLS.tavily = `${base}/401/tavily`;
    const r = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('a 401 says the key was not accepted', !r.ok && /did not accept the key/i.test(r.error.message), why(r));
    web.URLS.tavily = `${base}/402/tavily`;
    const r2 = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('a 402 says there is no credit left', !r2.ok && /has no credit left/i.test(r2.error.message), why(r2));
    web.URLS.tavily = `${base}/429/tavily`;
    const r3 = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('a 429 says the service is busy', !r3.ok && /is busy right now/i.test(r3.error.message), why(r3));
    web.URLS.tavily = `${base}/403/tavily`;
    const r4 = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('a 403 says the key may not search', !r4.ok && /will not answer with this key/i.test(r4.error.message), why(r4));
    web.URLS.tavily = `${base}/500/tavily`;
    const r5 = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('any other error says the service did not answer, with the status', !r5.ok && /did not answer \(500\)/i.test(r5.error.message), why(r5));
  }

  section('A service that answers badly');
  {
    web.URLS.firecrawl = `${base}/bad/firecrawl`;
    const r = await attempt(() => web.search('x', { provider: 'firecrawl', keys: { firecrawl: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('a broken answer gives a clear error, not a crash', !r.ok && r.error instanceof Error && /firecrawl/i.test(r.error.message), why(r));
    web.URLS.tavily = `${base}/bad/tavily`;
    const r2 = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('a broken answer on a service with no such check is handled, not a crash', r2.ok ? /No results came back/i.test(r2.value.content) : false, why(r2) || r2.value?.content);
    web.URLS.duckduckgo = `${base}/bad/ddg`;
    const r3 = await attempt(() => web.search('x', { provider: 'duckduckgo', signal: AbortSignal.timeout(10000) }));
    check('a page with no results says so plainly', !r3.ok && /returned nothing/i.test(r3.error.message), why(r3));
  }

  section('A service that is not there');
  {
    // Take a port, let it go, then point a provider at it: nothing is listening.
    const gone = http.createServer();
    await new Promise((r) => gone.listen(0, '127.0.0.1', r));
    const deadPort = gone.address().port;
    await new Promise((r) => gone.close(r));
    web.URLS.tavily = `http://127.0.0.1:${deadPort}/ok/tavily`;
    const t0 = Date.now();
    const r = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(10000) }));
    const secs = (Date.now() - t0) / 1000;
    check('a service that is not there fails at once, it does not hang', !r.ok && secs < 5, `${secs.toFixed(1)}s`);
    const detail = `${r.error?.message || ''} ${r.error?.cause?.code || ''} ${r.error?.cause?.message || ''}`;
    check('the failure names the connection problem', !r.ok && /fetch failed|ECONNREFUSED|connect/i.test(detail), detail.trim());
  }

  section('The deadline');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web.js'), 'utf8');
    const m = /const SEARCH_TIMEOUT = (\d+)/.exec(src);
    check('every search has a 20 second deadline', !!m && Number(m[1]) === 20000, m ? `${m[1]} ms` : 'not found');
    check('the deadline is what cuts a request short', /AbortSignal\.timeout\(SEARCH_TIMEOUT\)/.test(src));
    // A service that never answers, cut off by the caller's deadline.
    web.URLS.tavily = `${base}/hang/tavily`;
    const t0 = Date.now();
    const r = await attempt(() => web.search('x', { provider: 'tavily', keys: { tavily: 'k' }, signal: AbortSignal.timeout(1500) }));
    const secs = (Date.now() - t0) / 1000;
    check('a service that never answers is cut off, it does not hang', !r.ok && secs < 6, `${secs.toFixed(1)}s`);
    check('the cut off is a timeout, not a crash', !r.ok && /abort|timeout/i.test(`${r.error?.name || ''} ${r.error?.message || ''}`), why(r));
  }

  section('The automatic choice');
  {
    web.URLS.tavily = `${base}/ok/tavily`;
    web.URLS.brave = `${base}/ok/brave`;
    web.URLS.duckduckgo = `${base}/ok/ddg`;

    let from = mark();
    let r = await attempt(() => web.search('auto with a tavily key', { provider: 'auto', keys: { tavily: 'tv-key' }, signal: AbortSignal.timeout(10000) }));
    check('auto uses the saved tavily key first', r.ok && took(from, 'tavily').length === 1 && took(from, 'brave').length === 0 && took(from, 'ddg').length === 0, why(r));
    check('auto returns the tavily result', r.ok && r.value.sources?.[0]?.url === 'https://tavily.example/page', r.ok ? r.value.sources?.[0]?.url : '');

    web.URLS.tavily = `${base}/401/tavily`;
    from = mark();
    r = await attempt(() => web.search('auto with a bad tavily key', { provider: 'auto', keys: { tavily: 'bad-key', brave: 'br-key' }, signal: AbortSignal.timeout(10000) }));
    check('auto falls through to the next saved key when tavily says no', r.ok && took(from, 'tavily').length === 1 && took(from, 'brave').length === 1 && took(from, 'ddg').length === 0, why(r));
    check('auto returns the brave result', r.ok && r.value.sources?.[0]?.url === 'https://brave.example/page', r.ok ? r.value.sources?.[0]?.url : '');

    from = mark();
    r = await attempt(() => web.search('auto with only a bad tavily key', { provider: 'auto', keys: { tavily: 'bad-key' }, signal: AbortSignal.timeout(10000) }));
    check('auto ends at duckduckgo when nothing else is left', r.ok && took(from, 'tavily').length === 1 && took(from, 'ddg').length === 1, why(r));
    check('auto returns the duckduckgo result', r.ok && r.value.sources?.[0]?.url === 'https://duckduckgo.example/direct', r.ok ? r.value.sources?.[0]?.url : '');

    from = mark();
    r = await attempt(() => web.search('auto with a searxng address', { provider: 'auto', keys: {}, url: searxngUrl, signal: AbortSignal.timeout(10000) }));
    check('auto uses the searxng address when one is set', r.ok && took(from, 'searxng').length === 1 && took(from, 'ddg').length === 0, why(r));
    check('auto returns the searxng result', r.ok && r.value.sources?.[0]?.url === 'https://searxng.example/page', r.ok ? r.value.sources?.[0]?.url : '');

    from = mark();
    r = await attempt(() => web.search('auto with nothing set', { provider: 'auto', keys: {}, signal: AbortSignal.timeout(10000) }));
    check('auto falls back to duckduckgo when nothing is set', r.ok && took(from, 'ddg').length === 1 && took(from, 'searxng').length === 0, why(r));
    check('auto returns the duckduckgo result', r.ok && r.value.sources?.[0]?.url === 'https://duckduckgo.example/direct', r.ok ? r.value.sources?.[0]?.url : '');

    from = mark();
    r = await attempt(() => web.search('auto with an ordinary base url', { provider: 'auto', keys: {}, clientOptions: { baseURL: 'https://api.example.com', apiKey: 'k' }, signal: AbortSignal.timeout(10000) }));
    check('auto does not mistake an ordinary base url for anthropic', r.ok && took(from, 'ddg').length === 1, why(r));

    from = mark();
    r = await attempt(() => web.search('auto with an ai service that searches', { provider: 'auto', keys: { tavily: 'tv-key' }, clientOptions: { google: true, apiKey: 'goog-key' }, signal: AbortSignal.timeout(10000) }));
    check('auto prefers the ai service own search when it has one', r.ok && took(from, 'google').length === 1 && took(from, 'tavily').length === 0, why(r));
    check('auto returns the google result', r.ok && r.value.sources?.[0]?.url === 'https://google.example/page', r.ok ? r.value.sources?.[0]?.url : '');
  }

  server.closeAllConnections();
  server.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})();
