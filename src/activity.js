// Activity log: what Island did on the PC, when, how it was allowed, and whether it
// worked, kept locally as JSON lines (%APPDATA%/island-assistant/activity/). The user can
// search it, export it, and undo the entries that carry undo information.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 8 * 1024 * 1024; // then the oldest half is dropped
const MAX_DETAIL = 600;

class ActivityLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'activity.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    this.items = [];
    this.byId = new Map();
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'undone') {
          const it = this.byId.get(e.id);
          if (it) it.undone = e.t;
        } else {
          this.items.push(e);
          this.byId.set(e.id, e);
        }
      }
    } catch {}
  }

  append(obj) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(obj) + '\n');
      if (fs.statSync(this.file).size > MAX_BYTES) this.compact();
    } catch {}
  }

  compact() {
    this.items = this.items.slice(Math.floor(this.items.length / 2));
    this.byId = new Map(this.items.map((e) => [e.id, e]));
    const lines = this.items.flatMap((e) => [JSON.stringify({ ...e, undone: undefined }), ...(e.undone ? [JSON.stringify({ type: 'undone', id: e.id, t: e.undone })] : [])]);
    fs.writeFileSync(this.file, lines.join('\n') + '\n');
  }

  // entry: { chatId, kind, name, summary, detail, ok, error, grant, undo }
  add(entry) {
    const e = {
      id: `a${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      t: Date.now(),
      ...entry,
      detail: entry.detail ? String(entry.detail).slice(0, MAX_DETAIL) : undefined,
      error: entry.error ? String(entry.error).slice(0, 300) : undefined,
    };
    this.items.push(e);
    this.byId.set(e.id, e);
    this.append(e);
    return e;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  markUndone(id) {
    const e = this.byId.get(id);
    if (!e) return;
    e.undone = Date.now();
    this.append({ type: 'undone', id, t: e.undone });
  }

  // Newest first. q matches summary/detail/name; kind filters.
  list({ q = '', kind = '', limit = 300 } = {}) {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.items[i];
      if (kind && e.kind !== kind) continue;
      if (needle && !`${e.summary} ${e.detail || ''} ${e.name}`.toLowerCase().includes(needle)) continue;
      out.push({ ...e, canUndo: !!e.undo && !e.undone });
    }
    return out;
  }

  // A readable text export of everything (for the user, or to attach to a bug report).
  exportText() {
    const lines = this.items.map((e) => {
      const when = new Date(e.t).toLocaleString();
      return `${when}  [${e.kind}] ${e.ok === false ? 'FAILED ' : ''}${e.summary}${e.grant ? `  (allowed: ${e.grant})` : ''}${e.undone ? '  (undone)' : ''}${e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : ''}${e.error ? `\n    error: ${e.error}` : ''}`;
    });
    return `Island activity log, exported ${new Date().toLocaleString()}\n\n${lines.join('\n')}\n`;
  }
}

module.exports = { ActivityLog };
