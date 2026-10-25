// Pulls every piece of interface text out of the renderer and overlay sources, for the
// translation files in src/renderer/i18n/. Plain strings become exact entries; template
// strings with simple ${...} parts become patterns with {0}, {1}... placeholders.
// Usage: node scripts/extract-strings.js > strings.json   (prints JSON: { exact: [], patterns: [] })
//        node scripts/extract-strings.js --missing hi      (only text hi.js doesn't translate yet)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const FILES = ['renderer/app.js', 'renderer/index.html', 'overlay/overlay.js', 'overlay/index.html'];

const exact = new Set();
const patterns = new Set();

// Text that a person reads: has letters, isn't an id, class, path, URL, key name or code.
function looksLikeText(s) {
  const t = s.trim();
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false;
  if (/^(https?:|file:|data:|mailto:|ms-settings:)/.test(t)) return false;
  if (/^[a-z0-9_\-.:/#\[\]=()'"*>+~,]+$/.test(t) && !/\s/.test(t)) return false; // ids, classes, selectors
  if (/^[A-Z_]{2,}$/.test(t)) return false; // CONSTANTS
  if (/[{};]|=>|\bfunction\b|\bconst\b|\breturn\b|\.\w+\(|\$\(|querySelector|innerHTML|classList/.test(t)) return false; // code
  if (/^(Control|Ctrl|Alt|Shift|Super|Win)\+/.test(t)) return false; // shortcuts
  if (/^[\w.-]+\.(js|css|png|svg|json|exe|ps1|wav|html)$/i.test(t)) return false; // file names
  if (!/\s/.test(t) && !/^[A-Z][a-z]/.test(t) && !/[^\x00-\x7F]/.test(t)) return false; // lone lowercase words are usually keys
  return true;
}

function addText(raw) {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (looksLikeText(t)) exact.add(t);
}

// Split HTML-ish text into the readable pieces between tags (and attribute values people read).
function fromHtml(html) {
  for (const m of html.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]+)"/g)) addText(m[1]);
  html.replace(/<[^>]*>/g, '\u0000').split('\u0000').forEach((seg) => seg.split(/&\w+;/).forEach(addText));
}

function fromTemplate(body) {
  // ${...} with nested braces
  const parts = [];
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < body.length && depth) { if (body[j] === '{') depth++; else if (body[j] === '}') depth--; j++; }
      parts.push(body.slice(i + 2, j - 1));
      out += `\u0001${parts.length - 1}\u0001`;
      i = j;
    } else out += body[i++];
  }
  if (/</.test(out)) {
    parts.forEach(fromCode); // strings inside ${…} (like a ? 'Allow' : 'Delete') are text too
    // HTML template: translate the plain text runs between tags and interpolations.
    for (const m of out.matchAll(/\b(?:title|placeholder|aria-label)="([^"\u0001]+)"/g)) addText(m[1]);
    out.replace(/<[^>]*>/g, '\u0000').split(/[\u0000]/).forEach((seg) => {
      if (!seg.includes('\u0001')) return seg.split(/&\w+;/).forEach(addText);
      const p = seg.replace(/\u0001(\d+)\u0001/g, (_, n) => `{${n}}`).replace(/\s+/g, ' ').trim();
      if (looksLikeText(p.replace(/\{\d+\}/g, 'X')) && /[A-Za-z]{3}/.test(p.replace(/\{\d+\}/g, ''))) patterns.add(renumber(p));
    });
    return;
  }
  if (!parts.length) return addText(out);
  parts.forEach(fromCode);
  const p = out.replace(/\u0001(\d+)\u0001/g, (_, n) => `{${n}}`).replace(/\s+/g, ' ').trim();
  if (looksLikeText(p.replace(/\{\d+\}/g, 'X')) && /[A-Za-z]{3}/.test(p.replace(/\{\d+\}/g, ''))) patterns.add(renumber(p));
}

// {3} ... {5} -> {0} ... {1}
function renumber(p) {
  const map = new Map();
  return p.replace(/\{(\d+)\}/g, (_, n) => { if (!map.has(n)) map.set(n, map.size); return `{${map.get(n)}}`; });
}

// Every string literal in a piece of code.
function fromCode(code) {
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    if (m[3] !== undefined) fromTemplate(m[3].replace(/\\`/g, '`'));
    else {
      const s = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
      if (/<\w/.test(s)) fromHtml(s);
      else addText(s);
    }
  }
}

for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (rel.endsWith('.html')) {
    fromHtml(src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''));
    continue;
  }
  fromCode(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
}

const out = { exact: [...exact].sort(), patterns: [...patterns].sort() };
// --missing <lang>: only what that language's dictionary doesn't have yet (ready to translate).
const mi = process.argv.indexOf('--missing');
if (mi > 0) {
  const lang = process.argv[mi + 1];
  global.window = {};
  require(path.join(ROOT, 'renderer', 'i18n', `${lang}.js`));
  const have = window.I18N[lang];
  out.exact = out.exact.filter((s) => !have[s]);
  out.patterns = out.patterns.filter((s) => !have[s]);
}
process.stdout.write(JSON.stringify(out, null, 1));
console.error(`${out.exact.length} exact strings, ${out.patterns.length} patterns`);
