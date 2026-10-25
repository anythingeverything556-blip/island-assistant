// Every logo the model picker can ask for must exist, or a company shows up as a
// letter instead of its mark. This checks the two tables in the renderer against the
// generated logos file.
//
// Usage: node scripts/logos-test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, ok, i = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  (' + i + ')' : ''}`); };

// The logos that ship, as a set of keys.
const logosSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'logos.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(logosSrc, sandbox);
const logos = sandbox.window.LOGOS || {};
check('the logos file loads', Object.keys(logos).length > 0, `${Object.keys(logos).length} logos`);

// The two tables in the renderer.
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const grab = (name) => {
  const m = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\];|\\{[\\s\\S]*?\\n\\};)`).exec(appSrc);
  if (!m) throw new Error(`could not find ${name} in app.js`);
  // Wrapped in brackets so it is read as a value, not as a block of code.
  return vm.runInNewContext(`(${m[1].replace(/;\s*$/, '')})`);
};
const FAMILIES = grab('FAMILIES');
const PROVIDERS = grab('PROVIDERS');

const missing = [];
for (const [re, name, logo] of FAMILIES) {
  // 'router' is one of the app's own icons, not a company logo.
  if (logo && logo !== 'router' && !logos[logo]) missing.push(`family ${name} -> ${logo}`);
}
for (const [slug, [name, logo]] of Object.entries(PROVIDERS)) {
  if (logo && logo !== 'router' && !logos[logo]) missing.push(`provider ${slug} (${name}) -> ${logo}`);
}
check('every logo the picker asks for exists', missing.length === 0, missing.slice(0, 8).join('; '));

// The families and providers with no logo at all (a letter is shown for these).
const noLogo = [...FAMILIES.filter((f) => !f[2]).map((f) => f[1]), ...Object.entries(PROVIDERS).filter(([, v]) => !v[1]).map(([k]) => k)];
console.log(`      (no logo, so a letter is shown: ${noLogo.join(', ') || 'none'})`);

// Every logo in the file is a real svg.
const bad = Object.entries(logos).filter(([, svg]) => typeof svg !== 'string' || !svg.startsWith('<svg') || !svg.includes('viewBox'));
check('every logo is a real svg', bad.length === 0, bad.map(([k]) => k).join(', '));

// A logo whose main shape is white disappears on the light theme. The share of the
// drawing that is white tells us: a logo is mostly white when the white paths are
// longer than the coloured ones put together.
const whiteHeavy = [];
for (const [key, svg] of Object.entries(logos)) {
  if (/fill="currentColor"/.test(svg)) continue;
  let white = 0;
  let colour = 0;
  for (const m of svg.matchAll(/<path[^>]*d="([^"]*)"[^>]*fill="([^"]*)"/g)) {
    const isWhite = /^#(f{3}|f{6})$|white$/i.test(m[2].trim());
    if (isWhite) white += m[1].length;
    else colour += m[1].length;
  }
  if (white && white > colour) whiteHeavy.push(`${key} (white ${Math.round((white / (white + colour)) * 100)}%)`);
}
check('no logo is mostly white (it would vanish on a light background)', whiteHeavy.length === 0, whiteHeavy.join(', '));

// Every family pattern is anchored, so it cannot match a name in the middle of another.
const loose = FAMILIES.filter(([re]) => !re.source.startsWith('^'));
check('every family pattern is anchored', loose.length === 0, loose.map(([re]) => re.source).join(', '));

// A model id must get a family, and a company must get a logo.
const samples = [
  'claude-opus-5-5', 'gpt-4o', 'o3-mini', 'gemini-2.5-flash', 'gemma-3-27b', 'grok-4', 'deepseek-v3',
  'qwen3-235b', 'kimi-k2', 'glm-4.6', 'mistral-large', 'llama-3.3-70b', 'command-a-03-2025', 'minimax-m2',
  'nemotron-4', 'phi-4', 'granite-3', 'hunyuan-a13b', 'doubao-seed-1.6', 'ernie-4.5', 'mimo-7b', 'step-3',
  'solar-10.7b', 'reka-core', 'mercury-1', 'laguna-3', 'ling-2.5', 'ember-3', 'inkling-2', 'sonar-pro',
  'jamba-1.5-large', 'baichuan-4', 'lfm2-1.2b', 'sakana-e-1', 'morph-v3', 'dbrx-instruct', 'internlm3',
  'yi-large', 'longcat-flash', 'nova-pro-v1', 'palmyra-x5', 'mytho-max', 'hermes-3-llama',
  'anthropic/claude-opus-latest', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b', 'x-ai/grok-4',
  'minimax/minimax-m2:free', 'deepseek/deepseek-v3', 'qwen/qwen3-235b', 'moonshotai/kimi-k2',
  'z-ai/glm-4.6', 'bytedance-seed/1.6', 'inclusionai/ling-2.5', 'meituan-longcat/flash',
];
const familyOf = (id) => {
  const parts = String(id || '').split('/').filter(Boolean);
  const provider = (parts.length > 1 ? parts[0] : '').replace(/^~/, '').toLowerCase();
  const leaf = parts.length ? parts[parts.length - 1] : String(id || '');
  for (const [re, name, logo] of FAMILIES) if (re.test(leaf)) return { name, logo };
  const p = PROVIDERS[provider];
  if (p) return { name: p[0], logo: p[1] };
  if (provider && provider.length > 1) return { name: provider, logo: null };
  return { name: 'Other', logo: null };
};
const noMatch = samples.filter((id) => familyOf(id).name === 'Other');
check('every well-known model gets a company', noMatch.length === 0, noMatch.join(', '));
const noLogo2 = samples.filter((id) => familyOf(id).logo && !logos[familyOf(id).logo]);
check('every well-known model gets a logo that exists', noLogo2.length === 0, noLogo2.map((id) => `${id} -> ${familyOf(id).logo}`).join(', '));

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
