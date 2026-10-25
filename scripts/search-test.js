// Try each search service that needs no key, and check the shape of what comes back.
const web = require('../src/web');

(async () => {
  const results = [];
  const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };

  // DuckDuckGo: no key, so it must always work.
  try {
    const r = await web.search('population of spain', { provider: 'duckduckgo', signal: AbortSignal.timeout(25000) });
    const sources = r.sources || [];
    check('DuckDuckGo returns results', sources.length > 0, `${sources.length} sources`);
    check('DuckDuckGo sources have a title and a url', sources.every((s) => s.title && /^https?:/.test(s.url)), sources[0] ? `${sources[0].title} -> ${sources[0].url}` : 'none');
    check('DuckDuckGo returns a digest', String(r.content || '').length > 40);
    console.log('    first:', JSON.stringify(sources[0] || {}));
    console.log('    digest:', String(r.content).slice(0, 200).replace(/\n/g, ' '));
  } catch (e) {
    check('DuckDuckGo returns results', false, e.message);
  }

  // A service with no key must say so plainly, not crash.
  try {
    await web.search('test', { provider: 'tavily', keys: {}, signal: AbortSignal.timeout(10000) });
    check('a missing key is reported', false, 'no error');
  } catch (e) {
    check('a missing key is reported', /key/i.test(e.message), e.message);
  }

  // SearXNG with no address must say so too.
  try {
    await web.search('test', { provider: 'searxng', url: '', signal: AbortSignal.timeout(10000) });
    check('a missing SearXNG address is reported', false, 'no error');
  } catch (e) {
    check('a missing SearXNG address is reported', /searxng|address/i.test(e.message), e.message);
  }

  // The automatic choice with no keys at all must still find something.
  try {
    const r = await web.search('capital of france', { provider: 'auto', keys: {}, clientOptions: null, signal: AbortSignal.timeout(30000) });
    check('automatic finds something without any key', (r.sources || []).length > 0, `${(r.sources || []).length} sources`);
  } catch (e) {
    check('automatic finds something without any key', false, e.message);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
