// Long-term memory: lasting facts, preferences and standing instructions Island keeps
// about the user across conversations (similar to ChatGPT / Claude memory).
//
// Stored as JSON in the app's data folder:
//   { version: 2, nextId, active, spaces: [{ id, name }],
//     items: [{ id, text, category, tags, source, pinned, space, at, updated, uses, lastUsed }] }
//
// Spaces keep separate sets of memories (e.g. Personal and Work). Everything below works on
// the active space only; the others are untouched until the user switches.
//
// How it is used:
// - coreBlock(): the most important memories, frozen into the system prompt per conversation.
// - recallBlock(userText): other memories relevant to the current message (BM25 search),
//   appended to the per-turn context so the prompt prefix stays cacheable.
// - extract()/applyExtracted(): optional automatic memory via a small model after a turn.
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['profile', 'preference', 'project', 'instruction', 'fact'];
const SOURCES = ['user', 'assistant', 'auto'];
const MAX_TEXT = 400;
const MAX_TAGS = 8;
const CORE_BUDGET = 2500; // characters of memory lines in the system prompt
const SAVE_DEBOUNCE_MS = 1000; // use-tracking writes at most once per second
const MIN_RELEVANT_SCORE = 1.0; // base BM25 score a memory needs to be auto-recalled
const NEAR_DUP_JACCARD = 0.75;

// ---------------------------------------------------------------------------
// Text helpers: tokenizing, stemming, similarity
// ---------------------------------------------------------------------------

// Words that carry no meaning for matching. "user" is here because memories are written
// in third person ("User prefers...") and would otherwise match everything.
const STOPWORDS = new Set(
  ('a an the and or but if then so of to in on at by for with from as into about over under is are was were be been being ' +
    'am do does did doing have has had having i me my mine myself you your yours we our us he him his she her they them their ' +
    'it its this that these those there here what which who whom whose when where why how all any some no not nor only own ' +
    'same too very can could will would shall should may might must just also than such each other more most few s t d ll m re ve ' +
    'user users please hi hello hey ok okay thanks thank yes yeah im dont doesnt didnt cant wont isnt arent').split(/\s+/)
);

// Generic verbs that appear in many memories ("Uses...", "Prefers..."). They still count,
// but weakly, so "can I use Excel?" doesn't recall every "Uses X" memory.
// (Stemmed lazily below, since stem() is defined after this.)
const WEAK_WORDS = ['use', 'like', 'prefer', 'want', 'need', 'get', 'make', 'help', 'know', 'thing', 'time', 'always', 'never', 'usually', 'often'];
let WEAK = null;
const isWeak = (term) => (WEAK || (WEAK = new Set(WEAK_WORDS.map(stem)))).has(term);
const WEAK_WEIGHT = 0.3;

// Crude English suffix stripping. It only has to be consistent between queries and
// memories, not linguistically correct ("profile"/"profiles" -> "profil", "using"/"uses" -> "us").
function stem(word) {
  let w = word;
  if (w.length <= 2 || /\d/.test(w) || !/^[a-z]+$/.test(w)) return w; // leave numbers / non-Latin alone
  if (w.length > 4 && /(ies|ied)$/.test(w)) return w.slice(0, -3) + 'y';
  // -ing/-ed only when a vowel remains (Porter's rule), so "thing", "string", "shed" stay intact.
  if (w.length > 4 && w.endsWith('ing') && /[aeiouy]/.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));
  else if (w.length > 3 && w.endsWith('ed') && !w.endsWith('eed') && /[aeiouy]/.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
  else if (/(ches|shes|sses|xes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length >= 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function undouble(w) {
  // running -> runn -> run, preferred -> preferr -> prefer; keep ll/ss/zz (called, missed).
  return /([b-df-hj-kmnp-rtv-y])\1$/.test(w) ? w.slice(0, -1) : w;
}

// Lowercase, split on anything that isn't a letter/number/combining mark (keeps Hindi etc.),
// drop stopwords and 1-letter tokens, stem.
function tokenize(text) {
  const out = [];
  for (const raw of String(text || '').normalize('NFKC').toLowerCase().replace(/['’]/g, '').split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function normalizeForCompare(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function cleanText(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT).replace(/\s+\S*$/, '').trim() || t.slice(0, MAX_TEXT);
  return t;
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) tags = typeof tags === 'string' ? tags.split(',') : [];
  const out = [];
  for (const t of tags) {
    const c = String(t || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, MAX_TAGS);
}

// ---------------------------------------------------------------------------
// Secret filter. Errs on the side of refusing: a memory file is plain JSON on disk and
// ends up in prompts, so it must never hold credentials, codes, or payment / ID numbers.
// ---------------------------------------------------------------------------

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'an API key'], // sk-ant-api03-..., sk-proj-...
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}/, 'an access token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'an access token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an access key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'an API key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, 'a login token'],
  [/\b(?:api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token|bearer|private[ _-]?key|seed phrase|recovery phrase|mnemonic)\b\s*(?:is|was|[:=])\s*\S{6,}/i, 'an API key or token'],
  // "my password is hunter2", "wifi password: abc", "password for my gmail is x" -- but not "uses a password manager".
  [/\b(?:password|passwd|passcode|pwd|passphrase)s?(?:\s+(?:for|of|to|on|in)(?:\s+[^\s:=]+){1,3})?\s*(?:\bis\b|\bwas\b|[:=])\s*\S+/i, 'a password'],
  [/\bpin(?:\s?code|\s?number)?\b\W{0,5}(?:is\s+|was\s+)?\d{4,6}\b/i, 'a PIN'],
  [/\b(?:otp|2fa|mfa|totp|one[- ]time (?:password|code|pin)|verification code|security code|auth(?:entication)? code|login code|confirmation code|backup codes?|recovery codes?)\b[^.\n]{0,30}?\b\d{4,8}\b/i, 'a one-time code'],
  [/\b\d{4,8}\b[^.\n]{0,20}?\b(?:otp|2fa|verification code|one[- ]time (?:password|code))\b/i, 'a one-time code'],
  [/\bcodes?\b\s*(?:is|was|are|[:=])\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,10}\b/i, 'a code'],
  [/\b(?:cvv2?|cvc2?|card verification|security number)\b\D{0,12}\d{3,4}\b/i, 'card details'],
  [/\b(?:bank|account|acct|a\/c|iban|routing)\b[^.\n]{0,25}?\d{6,}/i, 'a bank account number'],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/, 'a bank account number (IBAN)'],
  [/\b\d{3}-\d{2}-\d{4}\b/, 'an ID number'], // US SSN
  [/(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}(?![\d -]*\d)/, 'an ID number'], // Aadhaar-style 4-4-4 grouping
  [/\b[A-Z]{5}\d{4}[A-Z]\b/, 'an ID number'], // Indian PAN
  [/\b(?:ssn|social security|aadhaa?r|passport|pan card|pan number|driving licen[cs]e|drivers? licen[cs]e|national id|voter id|tax id)\b[^.\n]{0,25}?\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}\b/i, 'an ID number'],
];

// Returns a short description of what secret-looking thing the text contains, or null.
function detectSecret(text) {
  const t = String(text || '');
  for (const [re, what] of SECRET_RULES) if (re.test(t)) return what;
  // Card numbers: 13-19 digits, optionally grouped with spaces/dashes (phone numbers are shorter).
  for (const m of t.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits >= 13 && digits <= 19) return 'a card number';
  }
  // Long random-looking tokens (keys, hashes, base64 blobs).
  for (const raw of t.split(/[\s/\\?&,;"'()<>[\]{}]+/)) {
    const tok = raw.replace(/^[^A-Za-z0-9+]+|[^A-Za-z0-9=]+$/g, '');
    if (!/^[A-Za-z0-9+/=_.-]+$/.test(tok)) continue;
    const hasDigit = /\d/.test(tok), hasLetter = /[A-Za-z]/.test(tok);
    if (/^[a-f0-9]{32,}$/i.test(tok)) return 'a key or hash';
    if (tok.length >= 32 && hasDigit && hasLetter) return 'a key or token';
    if (tok.length >= 24 && hasDigit && /[a-z]/.test(tok) && /[A-Z]/.test(tok)) return 'a key or token';
  }
  return null;
}

function secretError(what) {
  return new Error(`That looks like it contains ${what}. For your safety, Island doesn't keep passwords, keys, codes, or payment and ID numbers in memory.`);
}

// Personal topics Island may only remember with the user's OK (it asks first). Unlike
// secrets these are allowed, but they shouldn't be saved quietly.
const SENSITIVE_RULES = [
  [/\b(diagnos\w*|disease|disorder|illness|chronic|diabet\w*|asthma|cancer|tumou?r|hiv|aids|epilep\w*|adhd|autis\w*|depress\w*|anxiety|bipolar|schizo\w*|ptsd|ocd|therap(y|ist)|psychiatr\w*|medicat\w*|prescri\w*|pregnan\w*|miscarr\w*|disabilit\w*|surgery|allerg\w*|blood pressure|insulin|mental health|eating disorder|rehab|addict\w*)\b/i, 'health'],
  [/\b(religio\w*|muslim|islam\w*|christian\w*|catholic|protestant|hindu\w*|sikh\w*|jewish|judaism|buddhis\w*|jain\w*|atheis\w*|agnostic|church|mosque|temple|synagogue|prays?\b|fasting for)\b/i, 'religion'],
  [/\b(votes? for|voted for|vote for|supports? the \w+ party|party member|republican|democrat|liberal party|conservative party|labour party|bjp|congress party|aap\b|communis\w*|socialis\w*|left[- ]wing|right[- ]wing|politic\w* views?)\b/i, 'political views'],
  [/\b(gay|lesbian|bisexual|transgender|trans (man|woman)|queer|lgbt\w*|non[- ]binary|sexual orientation|sexuality|asexual)\b/i, 'sexuality or gender identity'],
  [/\b(caste|ethnicit\w*|race is|racial)\b/i, 'ethnicity'],
  [/\b(salary|earns?\s+\S*\d\S*|income|net worth|debt|loan|owes|credit score|bankrupt\w*|in the red|savings of)\b/i, 'money'],
  [/\b(lives at|home address|house (no|number)|flat (no|number)|apartment \d|street \d|\d+\s+\w+\s+(street|st|road|rd|avenue|ave|lane|ln)\b)/i, 'an address'],
  [/\b(divorc\w*|affair|breakup|broke up|criminal record|arrested|convicted|jail|prison|immigration status|undocumented|visa status)\b/i, 'private life events'],
];

// Which sensitive topic a memory touches ('health', 'religion', ...), or null.
function detectSensitive(text) {
  const t = String(text || '');
  for (const [re, what] of SENSITIVE_RULES) if (re.test(t)) return what;
  return null;
}

// Did the user plainly ask Island to remember something in this message?
function askedToRemember(text) {
  return /\b(remember|memori[sz]e|save (this|that|it)|note (this|that|it) down|keep in mind|don'?t forget|make a note)\b/i.test(String(text || ''));
}

const slug = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'space';

// ---------------------------------------------------------------------------
// Category guessing: used when no category is given (old-format items, the legacy
// add(text, source) signature). Falls back to 'fact'.
// ---------------------------------------------------------------------------

function guessCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/^(always|never|don'?t|do not|please|when(ever)?\b|reply|respond|answer|call (me|them|him|her)|address|speak|talk to|keep (answers|replies|responses))\b/.test(t) ||
      /\b(wants|asked|asks|expects) (you|the assistant|island) to\b/.test(t) || /\b(always|never) (reply|respond|answer|use|ask|write|speak)\b/.test(t)) return 'instruction';
  if (/\b(working on|project|building|deadline|due (on|by)|exams?|preparing for|goal|plans? to|assignment|thesis|startup|launch(ing)?)\b/.test(t)) return 'project';
  if (/\b(name is|goes by|years old|born|birthday|lives in|based in|is from|student|studies|studying|class \d+|grade \d+|school|college|university|works (as|at|for)|job|profession|engineer|developer|teacher|doctor|laptop|phone|desktop pc|computer|device|speaks|native language)\b/.test(t)) return 'profile';
  if (/\b(prefers?|likes?|loves?|dislikes?|hates?|favou?rite|enjoys?|uses|usually|style|tone|short answers|chrome profile|browser|editor|theme)\b/.test(t)) return 'preference';
  return 'fact';
}

// Pulls the first balanced {...} JSON object out of model output (tolerates code fences/prose).
function parseJsonLoose(s) {
  const text = String(s || '').replace(/```(?:json)?/gi, '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

const formatItem = (m) => `- [${m.id}] (${m.category}) ${m.text}`;
const copy = (m) => ({ ...m, tags: m.tags.slice() });
const daysSince = (iso) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 86400000) : Infinity);

// Short synchronous pause for retrying a rename that Windows (antivirus, indexer) briefly blocks.
function pause(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin: this only runs on rare rename conflicts */ }
}

// ---------------------------------------------------------------------------
// Memory store
// ---------------------------------------------------------------------------

class Memory {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.spaces = [{ id: 'personal', name: 'Personal' }];
    this.active = 'personal';
    this.nextId = 1;
    this._timer = null;
    this._dirty = false;
    this._load();
  }

  // Memories in the active space: what every lookup, prompt block and edit works on.
  _scope() {
    return this.items.filter((m) => m.space === this.active);
  }

  // ---- persistence --------------------------------------------------------

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // no file yet
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Don't silently overwrite a damaged file with an empty one: set it aside.
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      return;
    }
    const list = Array.isArray(data?.items) ? data.items : [];
    const legacy = data?.version !== 2;
    const seen = new Set();
    let maxId = 0;
    const needId = [];
    for (const it of list) {
      const m = this._normalize(it, legacy);
      if (!m) continue;
      const n = /^m(\d+)$/.test(m.id) ? Number(m.id.slice(1)) : 0;
      if (!n || seen.has(m.id)) needId.push(m);
      else { seen.add(m.id); maxId = Math.max(maxId, n); }
      this.items.push(m);
    }
    this.nextId = Math.max(Number(data?.nextId) || 0, maxId + 1);
    for (const m of needId) m.id = `m${this.nextId++}`;
    const spaces = (Array.isArray(data?.spaces) ? data.spaces : []).filter((s) => s && typeof s.id === 'string' && s.id).map((s) => ({ id: s.id, name: String(s.name || s.id).slice(0, 30) }));
    if (spaces.length) this.spaces = spaces;
    // Every memory needs a space that exists (old files had none: they're "Personal").
    for (const m of this.items) if (!this.spaces.some((s) => s.id === m.space)) this.spaces.push({ id: m.space, name: m.space });
    if (this.spaces.some((s) => s.id === data?.active)) this.active = data.active;
    else this.active = this.spaces[0].id;
    if (legacy && list.length) {
      // One-time migration from { items:[{id,text,source,at}] }: keep a backup, then rewrite as v2.
      try { if (!fs.existsSync(`${this.file}.v1.bak`)) fs.copyFileSync(this.file, `${this.file}.v1.bak`); } catch {}
      try { this._write(); } catch {}
    }
  }

  // Coerces a stored item (old or new format) into the v2 shape; null if unusable.
  _normalize(it, legacy) {
    if (!it || typeof it !== 'object') return null;
    const text = cleanText(it.text);
    if (!text) return null;
    const at = typeof it.at === 'string' && !isNaN(Date.parse(it.at)) ? it.at : new Date().toISOString();
    return {
      id: typeof it.id === 'string' ? it.id : '',
      text,
      category: CATEGORIES.includes(it.category) ? it.category : legacy ? guessCategory(text) : 'fact',
      tags: cleanTags(it.tags),
      source: SOURCES.includes(it.source) ? it.source : 'user',
      pinned: it.pinned === true,
      space: typeof it.space === 'string' && it.space ? it.space : 'personal',
      at,
      updated: typeof it.updated === 'string' && !isNaN(Date.parse(it.updated)) ? it.updated : at,
      uses: Number.isFinite(it.uses) && it.uses > 0 ? Math.floor(it.uses) : 0,
      lastUsed: typeof it.lastUsed === 'string' ? it.lastUsed : null,
      chat: typeof it.chat === 'string' ? it.chat : null, // the chat it was learned in, if any
    };
  }

  // Atomic write: write a temp file next to the real one, then rename over it, so a crash
  // mid-write can never leave a half-written memory.json.
  _write() {
    const data = JSON.stringify({ version: 2, nextId: this.nextId, active: this.active, spaces: this.spaces, items: this.items }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    let err;
    for (let i = 0; i < 5; i++) {
      try { fs.renameSync(tmp, this.file); err = null; break; } catch (e) { err = e; pause(25 * (i + 1)); }
    }
    if (err) {
      // Rename kept failing (file locked): fall back to a direct write rather than losing data.
      fs.writeFileSync(this.file, data);
      try { fs.unlinkSync(tmp); } catch {}
    }
    this._dirty = false;
  }

  // Flushes immediately (also flushes any pending debounced use-tracking write).
  save() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._write();
  }

  // Use-tracking changes are cheap to lose, so they are batched: at most one write per second.
  _saveSoon() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) { try { this._write(); } catch {} }
    }, SAVE_DEBOUNCE_MS);
    this._timer.unref?.(); // never keep the process alive just for this
  }

  // ---- basic CRUD ---------------------------------------------------------

  _find(id) {
    return this._scope().find((m) => m.id === String(id || '').trim());
  }

  get(id) {
    const m = this._find(id);
    return m ? copy(m) : null;
  }

  // Pinned first, then most recently updated.
  list() {
    return this._scope()
      .sort((a, b) => (b.pinned - a.pinned) || (Date.parse(b.updated) - Date.parse(a.updated)))
      .map(copy);
  }

  // add(text, 'user') still works; new form: add(text, { source, category, tags, pinned }).
  add(text, opts = {}) {
    if (typeof opts === 'string') opts = { source: opts };
    opts = opts || {};
    const clean = cleanText(text);
    if (!clean) throw new Error('Nothing to remember.');
    const secret = detectSecret(clean);
    if (secret) throw secretError(secret);
    const category = CATEGORIES.includes(opts.category) ? opts.category : null;
    const tags = cleanTags(opts.tags);
    const now = new Date().toISOString();

    // Exact duplicate (case/whitespace-insensitive): return the existing memory unchanged.
    const lower = clean.toLowerCase();
    const exact = this._scope().find((m) => m.text.toLowerCase() === lower);
    if (exact) {
      if (opts.pinned === true && !exact.pinned) { exact.pinned = true; exact.updated = now; this.save(); }
      return { ...copy(exact), duplicate: true };
    }

    // Near duplicate: refresh the existing memory instead of piling up variants.
    const near = this._nearDuplicate(clean);
    if (near) {
      const { item, newer } = near;
      if (newer) item.text = clean; // keep the newer wording (or the more detailed one, see _nearDuplicate)
      if (category) item.category = category;
      if (tags.length) item.tags = cleanTags([...item.tags, ...tags]);
      if (opts.pinned === true) item.pinned = true;
      item.updated = now;
      this.save();
      return { ...copy(item), merged: true };
    }

    const item = {
      id: `m${this.nextId++}`,
      text: clean,
      category: category || guessCategory(clean),
      tags,
      source: SOURCES.includes(opts.source) ? opts.source : 'user',
      pinned: opts.pinned === true,
      space: this.active,
      at: now,
      updated: now,
      uses: 0,
      lastUsed: null,
      chat: typeof opts.chat === 'string' ? opts.chat : null,
    };
    this.items.push(item);
    this.save();
    return copy(item);
  }

  // Finds a memory that says (nearly) the same thing. Returns { item, newer } where newer
  // says whether the incoming text should replace the stored one.
  _nearDuplicate(text, skipId) {
    const toks = tokenize(text);
    const norm = ` ${normalizeForCompare(text)} `;
    let best = null;
    for (const m of this._scope()) {
      if (m.id === skipId) continue;
      const mt = tokenize(m.text);
      const sim = jaccard(toks, mt);
      if (sim >= NEAR_DUP_JACCARD && (!best || sim > best.sim)) best = { item: m, sim, newer: true };
      if (best?.sim === 1) continue;
      // Containment ("Prefers short answers" vs "Prefers short answers in English"). Require the
      // shorter one to have 2+ content words so tiny memories don't swallow unrelated ones.
      const mnorm = ` ${normalizeForCompare(m.text)} `;
      const shorterToks = Math.min(new Set(toks).size, new Set(mt).size);
      if (shorterToks >= 2 && (norm.includes(mnorm) || mnorm.includes(norm)) && !best) {
        // Keep whichever is more detailed: a shorter restatement shouldn't erase details.
        best = { item: m, sim: 0.75, newer: norm.length >= mnorm.length };
      }
    }
    return best;
  }

  // patch: { text?, category?, tags?, pinned? }. Validates like add(). Returns the item or null.
  update(id, patch = {}) {
    const m = this._find(id);
    if (!m) return null;
    patch = patch || {};
    if (patch.text !== undefined) {
      const clean = cleanText(patch.text);
      if (!clean) throw new Error('A memory needs some text.');
      const secret = detectSecret(clean);
      if (secret) throw secretError(secret);
      m.text = clean;
    }
    if (patch.category !== undefined) {
      if (!CATEGORIES.includes(patch.category)) throw new Error(`Category must be one of: ${CATEGORIES.join(', ')}.`);
      m.category = patch.category;
    }
    if (patch.tags !== undefined) m.tags = cleanTags(patch.tags);
    if (patch.pinned !== undefined) m.pinned = !!patch.pinned;
    m.updated = new Date().toISOString();
    this.save();
    return copy(m);
  }

  remove(id) {
    const m = this._find(id);
    if (!m) return false;
    this.items = this.items.filter((x) => x !== m);
    this.save();
    return true;
  }

  pin(id, pinned = true) {
    return this.update(id, { pinned: !!pinned });
  }

  stats() {
    const scope = this._scope();
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    for (const m of scope) byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    return { total: scope.length, byCategory, pinned: scope.filter((m) => m.pinned).length };
  }

  // ---- spaces -------------------------------------------------------------

  spaceList() {
    return this.spaces.map((s) => ({ ...s, count: this.items.filter((m) => m.space === s.id).length, active: s.id === this.active }));
  }

  spaceName(id = this.active) {
    return this.spaces.find((s) => s.id === id)?.name || id;
  }

  setActive(id) {
    if (!this.spaces.some((s) => s.id === id)) throw new Error('That memory space no longer exists.');
    this.active = id;
    this.save();
  }

  addSpace(name) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!name) throw new Error('Give the space a name.');
    if (this.spaces.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a space called "${name}".`);
    let id = slug(name);
    for (let i = 2; this.spaces.some((s) => s.id === id); i++) id = `${slug(name)}-${i}`;
    this.spaces.push({ id, name });
    this.save();
    return id;
  }

  renameSpace(id, name) {
    const s = this.spaces.find((x) => x.id === id);
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!s || !name) return;
    s.name = name;
    this.save();
  }

  // Deletes a space and the memories in it. The last space can only be emptied.
  removeSpace(id) {
    if (!this.spaces.some((s) => s.id === id)) return;
    this.items = this.items.filter((m) => m.space !== id);
    if (this.spaces.length > 1) {
      this.spaces = this.spaces.filter((s) => s.id !== id);
      if (this.active === id) this.active = this.spaces[0].id;
    }
    this.save();
  }

  // ---- export / import ----------------------------------------------------

  // Everything, all spaces, as a portable JSON object.
  exportData() {
    return {
      app: 'Island Assistant',
      kind: 'memory',
      version: 2,
      exported: new Date().toISOString(),
      spaces: this.spaces.map((s) => ({ ...s })),
      items: this.items.map(({ id, text, category, tags, source, pinned, space, at, updated }) => ({ id, text, category, tags, source, pinned, space, at, updated })),
    };
  }

  // A readable list, one section per space.
  exportMarkdown() {
    const out = [`# What Island remembers`, '', `Exported ${new Date().toLocaleString()}`];
    for (const s of this.spaces) {
      const items = this.items.filter((m) => m.space === s.id);
      out.push('', `## ${s.name}`, '');
      if (!items.length) out.push('_Nothing saved._');
      for (const m of items) out.push(`- ${m.text}${m.pinned ? ' (pinned)' : ''} _[${m.category}]_`);
    }
    return out.join('\n') + '\n';
  }

  // Takes an Island export (JSON) or a plain list (one memory per line, "- " bullets fine:
  // e.g. memories copied out of ChatGPT). Everything goes through add(), so secrets are
  // refused and duplicates merged. Returns counts.
  importText(raw) {
    const text = String(raw || '').replace(/^﻿/, '');
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const result = { added: 0, merged: 0, skipped: 0, spaces: 0 };
    const back = this.active;
    const one = (t, opts) => {
      try {
        const r = this.add(t, opts);
        if (r.duplicate) result.skipped++;
        else if (r.merged) result.merged++;
        else result.added++;
      } catch { result.skipped++; }
    };
    try {
      if (data && Array.isArray(data.items)) {
        // Map the file's spaces onto ours by name, creating missing ones.
        const map = new Map();
        for (const s of Array.isArray(data.spaces) ? data.spaces : []) {
          if (!s?.id) continue;
          const name = String(s.name || s.id).slice(0, 30);
          let mine = this.spaces.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === s.id);
          if (!mine) { this.addSpace(name); mine = this.spaces[this.spaces.length - 1]; result.spaces++; }
          map.set(s.id, mine.id);
        }
        for (const it of data.items) {
          if (!it || typeof it.text !== 'string') { result.skipped++; continue; }
          this.active = map.get(it.space) || back;
          one(it.text, { source: SOURCES.includes(it.source) ? it.source : 'user', category: it.category, tags: it.tags, pinned: it.pinned === true });
        }
      } else if (Array.isArray(data)) {
        for (const t of data) typeof t === 'string' ? one(t, { source: 'user' }) : t?.text ? one(t.text, { source: 'user', category: t.category }) : result.skipped++;
      } else {
        for (const line of text.split(/\r?\n/)) {
          const t = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\s+_\[[a-z]+\]_\s*$/, '').replace(/\s+\(pinned\)$/, '').trim();
          if (!t || /^#/.test(t) || /^_.*_$/.test(t) || /^Exported /.test(t)) continue;
          one(t, { source: 'user' });
        }
      }
    } finally {
      this.active = back;
      this.save();
    }
    return result;
  }

  // ---- search -------------------------------------------------------------

  // BM25 over text + tags + category. Returns items with a final score (base * small boosts)
  // and the raw BM25 score in _base (used for the relevance threshold).
  _rank(query, { category } = {}) {
    const qTerms = [...new Set(tokenize(query))].slice(0, 64);
    if (!qTerms.length) return [];
    const docs = this._scope()
      .filter((m) => !category || m.category === category)
      .map((m) => ({ m, toks: tokenize(`${m.text} ${m.tags.join(' ')} ${m.category}`) }));
    if (!docs.length) return [];
    const N = docs.length;
    const avgLen = docs.reduce((s, d) => s + d.toks.length, 0) / N || 1;
    const df = new Map();
    for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
    // Smoothed IDF: pretend there are 10 extra documents without the term, so a tiny memory
    // store still gives sensible weights (with 2 memories, plain IDF makes every match ~0).
    const idf = (t) => {
      const n = df.get(t) || 0;
      return Math.log(1 + (N + 10 - n + 0.5) / (n + 0.5));
    };
    const k1 = 1.2, b = 0.75;
    const out = [];
    for (const d of docs) {
      const tf = new Map();
      for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
      let base = 0;
      for (const q of qTerms) {
        const f = tf.get(q);
        if (!f) continue;
        const w = isWeak(q) ? WEAK_WEIGHT : 1;
        base += w * idf(q) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.toks.length) / avgLen)));
      }
      if (base <= 0) continue;
      const m = d.m;
      // Small nudges only: pinned, recently used, frequently used.
      const boost = 1 + (m.pinned ? 0.15 : 0) + 0.1 * Math.exp(-daysSince(m.lastUsed) / 30) + 0.05 * Math.min(1, Math.log1p(m.uses) / Math.log(20));
      out.push({ m, base, score: base * boost });
    }
    return out.sort((a, b2) => b2.score - a.score);
  }

  search(query, { limit = 8, category } = {}) {
    return this._rank(query, { category })
      .slice(0, Math.max(0, limit))
      .map(({ m, score }) => ({ ...copy(m), score: Math.round(score * 1000) / 1000 }));
  }

  // Memories worth surfacing for a user message. Marks them used (debounced save).
  relevant(text, { limit = 6, exclude = [], minScore = MIN_RELEVANT_SCORE } = {}) {
    const skip = new Set(exclude || []);
    const hits = this._rank(text)
      .filter(({ m, base }) => !skip.has(m.id) && base >= minScore)
      .slice(0, Math.max(0, limit));
    if (!hits.length) return [];
    const now = new Date().toISOString();
    for (const { m } of hits) { m.uses++; m.lastUsed = now; }
    this._saveSoon();
    return hits.map(({ m, score }) => ({ ...copy(m), score: Math.round(score * 1000) / 1000 }));
  }

  // Memories a message plausibly draws on, for the "used memory" chip: the ones auto-recalled
  // for it plus core memories it's about. No use-tracking side effects.
  bearingOn(text, { only, limit = 6, minScore = MIN_RELEVANT_SCORE } = {}) {
    const keep = only ? new Set(only) : null;
    return this._rank(text)
      .filter(({ m, base }) => base >= minScore && (!keep || keep.has(m.id)))
      .slice(0, limit)
      .map(({ m }) => copy(m));
  }

  // ---- prompt blocks ------------------------------------------------------

  // Picks the memories that go into the system prompt: every pinned, instruction and profile
  // memory, then the most used / most recent preferences, within CORE_BUDGET characters.
  _core() {
    const scope = this._scope();
    const byUpdated = (a, b) => Date.parse(b.updated) - Date.parse(a.updated);
    const prefScore = (m) => Math.log1p(m.uses) + Math.exp(-daysSince(m.lastUsed || m.updated) / 30);
    const pinned = scope.filter((m) => m.pinned).sort(byUpdated);
    const instr = scope.filter((m) => !m.pinned && m.category === 'instruction').sort(byUpdated);
    const profile = scope.filter((m) => !m.pinned && m.category === 'profile').sort(byUpdated);
    const prefs = scope.filter((m) => !m.pinned && m.category === 'preference').sort((a, b) => prefScore(b) - prefScore(a) || byUpdated(a, b));
    const chosen = [];
    let used = 0;
    for (const m of [...pinned, ...instr, ...profile, ...prefs]) {
      const len = formatItem(m).length + 1;
      if (used + len > CORE_BUDGET) continue; // skip what doesn't fit; shorter ones may still fit
      chosen.push(m);
      used += len;
    }
    return chosen;
  }

  coreIds() {
    return this._core().map((m) => m.id);
  }

  // The block appended to the system prompt (frozen per conversation by the caller).
  coreBlock() {
    const core = this._core();
    const total = this._scope().length;
    const rest = total - core.length;
    let body;
    if (!total) body = "You don't remember anything about the user yet.";
    else {
      body = core.length ? `What you remember about the user:\n${core.map(formatItem).join('\n')}` : '';
      if (rest > 0) body += `${body ? '\n' : ''}${rest} more ${rest === 1 ? 'memory is' : 'memories are'} stored; relevant ones appear in each message's <memory> block, and you can search them with recall_memory.`;
    }
    return `

Memory
You have a long-term memory about the user that carries across chats.
- Use what you remember silently and naturally, the way a friend who knows them would. Don't recite memories, announce that you remembered something, or mention the memory system unless the user asks what you remember.
- Call remember when the user shares something lasting about themselves (who they are, studies or job, devices, the apps, accounts and browser profiles they use, how they like answers, ongoing projects and deadlines) or asks you to remember something. One fact per call, short and in third person (e.g. "Uses the Work Chrome profile"), with the best category: profile, preference, project, instruction (standing rules for you) or fact. Don't save one-off task details or things you said yourself.
- If something you remember changed or is slightly wrong, call update_memory with its id instead of adding a duplicate. Call forget when the user asks you to forget something or a memory is wrong or no longer true.
- Not every memory is listed here. When the user refers to something from the past ("like last time", "my project", "the profile I use") and it isn't below or in the <memory> block, call recall_memory to search.
- If a memory conflicts with what the user says now, trust the user and update the memory.
- Never store passwords, keys, codes, payment, bank or ID numbers. Sensitive details (health, religion, politics, sexuality, money, addresses and similar) need the user's OK: Island asks them when you call remember, so only call it when they'd likely want it kept.
${this.spaces.length > 1 ? `- This chat uses the user's "${this.spaceName()}" memory space; memories in their other spaces aren't available here.\n` : ''}${body}`;
  }

  // Backward-compatible name used by agent.js.
  promptBlock() {
    return this.coreBlock();
  }

  // Per-turn block for the user's <context>: memories relevant to this message that aren't
  // already in the frozen core block. '' when nothing is relevant.
  recallBlock(userText, { exclude = [], limit = 6 } = {}) {
    const hits = this.relevant(userText, { exclude, limit });
    if (!hits.length) return '';
    return `<memory>Possibly relevant things you remember:\n${hits.map(formatItem).join('\n')}\n</memory>`;
  }

  // ---- automatic memory ---------------------------------------------------

  // Asks a small model which durable facts about the user this exchange revealed.
  // Returns a proposal { add: [{ text, category }], update: [{ id, text }] } (not applied).
  // Throws on API/network errors; returns empty arrays if the reply can't be parsed.
  async extract({ userText, assistantText = '', clientOptions, model = '', signal } = {}) {
    const empty = { add: [], update: [] };
    if (!clientOptions || !String(userText || '').trim()) return empty;
    const Anthropic = require('@anthropic-ai/sdk'); // lazy: only needed when auto-memory runs
    const client = new Anthropic(clientOptions);
    // The same model and the same API the chat used, so this works on a gateway too
    // (a hard-coded Claude id would not exist there).
    const modelId = model || clientOptions.model || 'claude-haiku-5-5';
    const viaChat = !!clientOptions.google || require('./models').profile(modelId).kind !== 'claude';

    // Existing memories (most relevant first) so the model can avoid duplicates and target updates.
    const relevantIds = new Set(this._rank(userText).map(({ m }) => m.id));
    const ordered = [...this._scope().filter((m) => relevantIds.has(m.id)), ...this.list().filter((m) => !relevantIds.has(m.id))];
    const lines = [];
    let size = 0;
    for (const m of ordered) {
      const line = formatItem(m);
      if (size + line.length > 6000) break;
      lines.push(line);
      size += line.length + 1;
    }

    const system = `You maintain the long-term memory of a personal AI assistant used by one person (the user). After each exchange you decide whether the user revealed anything durable about themselves that will still be useful in future, unrelated conversations.

Worth saving (categories):
- profile: who the user is - name, age, class/school, job, location, languages, devices they own.
- preference: lasting likes and dislikes and how they want things done - answer length/style/language, the apps, tools, browsers and browser profiles they use.
- project: ongoing work, goals, exams, deadlines that matter beyond today.
- instruction: standing instructions for the assistant ("always...", "never...", "when I ..., do ...").
- fact: other lasting facts about the user's life.

Do NOT save:
- The current task, one-off questions or requests, or details only relevant right now.
- General knowledge, or anything the assistant said, suggested or did. Only what the user stated or clearly confirmed.
- Guesses or inferences the user didn't actually state.
- Passwords, API keys, codes, OTPs, card/bank details, ID numbers, exact home addresses.
- Sensitive details (health, religion, politics, sexuality, ethnicity, finances) unless the user explicitly asks to remember them.
- Anything an existing memory already covers. If the user corrects or changes something an existing memory says, return an "update" with that memory's id and the full corrected text instead of an "add".

Be conservative: most exchanges contain nothing worth saving, and then you return empty arrays. If the user explicitly asks to remember something (and it isn't a secret), save it.

Write each memory as one short, self-contained sentence in third person without a subject prefix, under 200 characters, one fact per item. Examples: "Is a class 11 student", "Uses the Work Chrome profile", "Prefers short answers", "Wants replies in Hindi when writing in Hindi".

Reply with JSON only, no prose or code fences:
{"add":[{"text":"...","category":"profile|preference|project|instruction|fact"}],"update":[{"id":"m3","text":"..."}]}`;

    const content = `<existing_memories>
${lines.join('\n') || '(none)'}
</existing_memories>

<exchange>
<user>
${String(userText).slice(0, 4000)}
</user>
<assistant>
${String(assistantText || '').slice(0, 2000)}
</assistant>
</exchange>

Return the JSON now.`;

    const res = viaChat
      // A Google key or a chat model: the same notes over its OpenAI-compatible endpoint.
      ? { content: [{ type: 'text', text: await require('./chat-completions').quickChat({ clientOptions, model: modelId, system, prompt: content, maxTokens: 600, signal }) }] }
      : await client.messages.create(
        { model: modelId, max_tokens: 600, system, messages: [{ role: 'user', content }] },
        signal ? { signal } : undefined
      );
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseJsonLoose(text);
    if (!parsed || typeof parsed !== 'object') return empty;

    // Normalize: drop malformed entries, cap the count, keep ids that actually exist.
    const add = (Array.isArray(parsed.add) ? parsed.add : [])
      .filter((a) => a && typeof a.text === 'string' && a.text.trim())
      .slice(0, 6)
      .map((a) => ({ text: cleanText(a.text), category: CATEGORIES.includes(a.category) ? a.category : guessCategory(a.text) }));
    const update = (Array.isArray(parsed.update) ? parsed.update : [])
      .filter((u) => u && typeof u.text === 'string' && u.text.trim() && this._find(u.id))
      .slice(0, 6)
      .map((u) => ({ id: String(u.id).trim(), text: cleanText(u.text) }));
    return { add, update };
  }

  // Applies a proposal from extract() through add()/update(), so the secret filter and
  // dedupe still apply. Invalid entries are skipped silently. Entries hold(text) says need
  // the user's OK first are returned in `held` instead of being saved.
  applyExtracted(proposal, { hold, chat } = {}) {
    const added = [], updated = [], held = [];
    // Adds first, against the memories the model actually saw, then updates.
    for (const a of proposal?.add || []) {
      try {
        if (!a?.text || detectSecret(a.text)) continue;
        if (hold?.(a.text)) {
          if (!this._scope().some((m) => m.text.toLowerCase() === cleanText(a.text).toLowerCase())) held.push({ text: cleanText(a.text), category: a.category });
          continue;
        }
        const r = this.add(a?.text, { source: 'auto', category: a?.category, chat });
        if (r.duplicate) continue;
        const merged = r.merged;
        delete r.merged;
        if (!merged) added.push(r);
        else if (!added.some((x) => x.id === r.id) && !updated.some((x) => x.id === r.id)) updated.push(r);
      } catch {}
    }
    for (const u of proposal?.update || []) {
      try {
        const cur = this._find(u?.id);
        const text = cleanText(u?.text).toLowerCase();
        // Skip no-op updates and ones that would just duplicate another memory.
        if (!cur || !text || text === cur.text.toLowerCase() || this._scope().some((m) => m.text.toLowerCase() === text)) continue;
        if (detectSecret(u.text)) continue;
        if (hold?.(u.text)) { held.push({ id: cur.id, text: cleanText(u.text), category: cur.category, old: cur.text }); continue; }
        const r = this.update(u.id, { text: u.text });
        if (!r) continue;
        const i = updated.findIndex((x) => x.id === r.id);
        if (i >= 0) updated[i] = r; else updated.push(r);
      } catch {}
    }
    return { added, updated, held };
  }
}

module.exports = { Memory, CATEGORIES, detectSecret, detectSensitive, askedToRemember, guessCategory, tokenize, stem, parseJsonLoose };
