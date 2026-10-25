// Saved conversations: one JSON file per chat plus an index (titles, times, search text).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEARCH_CHARS = 6000;

class ChatStore {
  constructor(dir, legacyFile) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.indexFile = path.join(dir, 'index.json');
    this.index = { current: null, chats: [] };
    try {
      this.index = { current: null, chats: [], ...JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) };
    } catch {}
    // One-time import of the single conversation older versions kept.
    if (!this.index.chats.length && legacyFile && fs.existsSync(legacyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        if (data.messages?.length) {
          const id = this.newId();
          this.save(id, data, { title: titleFrom(data.messages) });
          this.index.current = id;
          this.writeIndex();
        }
        fs.renameSync(legacyFile, legacyFile + '.imported');
      } catch {}
    }
  }

  newId() {
    return `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  }

  file(id) {
    if (!/^[a-z0-9]+$/.test(id)) throw new Error('bad chat id');
    return path.join(this.dir, `${id}.json`);
  }

  writeIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index));
  }

  entry(id) {
    return this.index.chats.find((c) => c.id === id) || null;
  }

  // Newest first, pinned on top. Optional search across titles and message text.
  list(query = '') {
    const q = query.trim().toLowerCase();
    return this.index.chats
      .filter((c) => !q || c.title.toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated)
      .map(({ text, ...c }) => ({ ...c, match: q && !c.title.toLowerCase().includes(q) ? snippet(text, q) : null }));
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  save(id, data, meta = {}) {
    fs.writeFileSync(this.file(id), JSON.stringify(data));
    let e = this.entry(id);
    if (!e) {
      e = { id, title: meta.title || 'New chat', created: Date.now(), updated: Date.now(), pinned: false, model: null, auto: !meta.title };
      this.index.chats.push(e);
    }
    e.updated = Date.now();
    if (meta.model) e.model = meta.model;
    if (meta.title) e.title = meta.title;
    e.text = searchText(data.messages).slice(0, SEARCH_CHARS);
    e.count = (data.messages || []).filter((m) => m.role === 'user' && hasUserText(m)).length;
    this.writeIndex();
    return e;
  }

  setCurrent(id) {
    this.index.current = id;
    this.writeIndex();
  }

  rename(id, title, { auto = false } = {}) {
    const e = this.entry(id);
    if (!e) return;
    e.title = String(title).replace(/\s+/g, ' ').trim().slice(0, 80) || e.title;
    e.auto = auto;
    this.writeIndex();
  }

  pin(id, pinned) {
    const e = this.entry(id);
    if (e) {
      e.pinned = !!pinned;
      this.writeIndex();
    }
  }

  remove(id) {
    this.index.chats = this.index.chats.filter((c) => c.id !== id);
    if (this.index.current === id) this.index.current = null;
    this.writeIndex();
    fs.rmSync(this.file(id), { force: true });
  }

  // For the model: earlier chats about something, ranked by how many query words they
  // share, with the passages that matched (read from the full chat, not the index).
  search(query, { limit = 4, exclude = null } = {}) {
    const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
    if (!words.length) return [];
    const scored = [];
    for (const c of this.index.chats) {
      if (c.id === exclude) continue;
      const hay = `${c.title} ${c.title} ${c.text || ''}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        const n = hay.split(w).length - 1;
        if (n) score += 1 + Math.log(n);
      }
      if (score) scored.push({ c, score: score / Math.sqrt(words.length) });
    }
    scored.sort((a, b) => b.score - a.score || b.c.updated - a.c.updated);
    return scored.slice(0, limit).map(({ c }) => {
      const full = searchText(this.load(c.id)?.messages || []);
      return { id: c.id, title: c.title, updated: c.updated, excerpts: passages(full, words) };
    });
  }
}

// Up to three ~300-char windows around the densest query-word hits.
function passages(text, words) {
  const low = text.toLowerCase();
  const hits = [];
  for (const w of words) for (let i = low.indexOf(w); i >= 0 && hits.length < 200; i = low.indexOf(w, i + 1)) hits.push(i);
  hits.sort((a, b) => a - b);
  const out = [];
  let last = -1e9;
  for (const i of hits) {
    if (i - last < 300) continue;
    const s = Math.max(0, i - 120);
    out.push((s ? '…' : '') + text.slice(s, s + 300).trim() + '…');
    last = i;
    if (out.length === 3) break;
  }
  return out.length ? out : [text.slice(0, 300)];
}

const userTexts = (m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).filter((b) => b.type === 'text' && !b.text.startsWith('<context>') && !b.text.startsWith('<memory>') && !b.text.startsWith('<file ')).map((b) => b.text));
const hasUserText = (m) => userTexts(m).some((t) => t.trim());

function searchText(messages = []) {
  const parts = [];
  for (const m of messages) {
    if (m.role === 'user') parts.push(...userTexts(m));
    else if (Array.isArray(m.content)) parts.push(...m.content.filter((b) => b.type === 'text').map((b) => b.text));
  }
  return parts.join('\n').replace(/\s+/g, ' ');
}

function titleFrom(messages = []) {
  const first = messages.find((m) => m.role === 'user' && hasUserText(m));
  const t = first ? userTexts(first).join(' ').replace(/\s+/g, ' ').trim() : '';
  return t ? (t.length > 48 ? t.slice(0, 47) + '…' : t) : 'New chat';
}

function snippet(text = '', q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const s = Math.max(0, i - 40);
  return (s ? '…' : '') + text.slice(s, i + q.length + 60) + '…';
}

module.exports = { ChatStore, titleFrom };
