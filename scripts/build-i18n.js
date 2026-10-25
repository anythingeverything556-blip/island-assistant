// Merges translation batches into the app's dictionary file src/renderer/i18n/<lang>.js.
// Usage: node scripts/build-i18n.js hi <batch.json> [batch.json...]
const fs = require('fs');
const path = require('path');

const [, , lang, ...files] = process.argv;
// Without this, a bare run wrote src/renderer/i18n/undefined.js.
if (!lang || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(lang) || !files.length) {
  console.error('Usage: node scripts/build-i18n.js <lang, e.g. hi> <batch.json> [batch.json...]');
  process.exit(1);
}
const out = path.join(__dirname, '..', 'src', 'renderer', 'i18n', `${lang}.js`);
// Keep what's already there, so later batches only add or improve entries.
let dict = {};
try { dict = JSON.parse(/window\.I18N\[[^\]]+\]\s*=\s*([\s\S]*?);\s*$/.exec(fs.readFileSync(out, 'utf8'))[1]); } catch { /* new file */ }
// Code-like: braces, semicolons, arrows or calls like foo(…), selectors and class lists
// (all lowercase, so a sentence that mentions "the glowing spot" still counts as text).
const isCode = (k) => /[{};=]|=>|\w\(|^[.#\[]/.test(k.replace(/\{\d+\}/g, '')) || /^[a-z0-9 _-]+$/.test(k) && /\b(btn|srow|msg|field|icon-btn|cmd|qrec|spot|space|acct|timer-row)\b/.test(k) || /^[\w-]+( [\w-]+)?$/.test(k) && /-/.test(k);
let added = 0, skipped = 0;
for (const f of files) {
  const batch = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  for (const [k, v] of Object.entries(batch)) {
    if (typeof v !== 'string' || !v.trim() || isCode(k) || v === k) { skipped++; continue; }
    // Placeholders must survive translation (plural-only ones may be dropped).
    const need = (k.match(/\{\d+\}/g) || []).filter((p) => !new RegExp(`\\w${p.replace(/[{}]/g, '\\$&')}`).test(k));
    if (need.some((p) => !v.includes(p))) { console.warn(`placeholder lost, skipped: ${k}`); skipped++; continue; }
    if (dict[k] !== v) added++;
    dict[k] = v;
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
const sorted = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(out, `// ${lang} translations of Island's interface (English text -> translation). {0}, {1}… are\n// numbers or names filled in at run time. Built by scripts/build-i18n.js; edit freely.\nwindow.I18N = window.I18N || {};\nwindow.I18N[${JSON.stringify(lang)}] = ${JSON.stringify(sorted, null, 1)};\n`);
console.log(`${Object.keys(sorted).length} entries in i18n/${lang}.js (${added} new or changed, ${skipped} skipped)`);
