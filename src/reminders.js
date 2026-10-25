// Reminders that survive restarts and can repeat ("every day at 8 am: take my tablets").
// Saved in the data folder; each fires a Windows notification and an in-island message
// (spoken aloud if the user wants). Missed ones (PC was off) fire once when Island starts.
const fs = require('fs');
const path = require('path');

const REPEATS = ['none', 'hourly', 'daily', 'weekdays', 'weekly'];
const MAX_DELAY = 2 ** 31 - 1; // setTimeout limit (~24.8 days)

// "08:00", "2026-10-17 08:00", "2026-10-17T08:00", "in 20 minutes" (relative handled by caller)
function parseWhen(s, now = new Date()) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(t);
  if (m) {
    let h = +m[1];
    if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    const d = new Date(now);
    d.setHours(h, +m[2], 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0); // local time
  const d = new Date(t);
  return isNaN(d) ? null : d;
}

function nextAfter(r, from) {
  const d = new Date(r.at);
  const step = () => {
    if (r.repeat === 'hourly') d.setHours(d.getHours() + 1);
    else if (r.repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (r.repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (r.repeat === 'weekdays') do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  };
  do step(); while (d <= from);
  return d;
}

function createReminders(file, { onFire }) {
  let list = [];
  let timer = null;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')).reminders || []; } catch {}
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reminders: list }, null, 2));
  };
  const schedule = () => {
    clearTimeout(timer);
    const now = Date.now();
    const next = list.reduce((a, r) => (!a || Date.parse(r.at) < Date.parse(a.at) ? r : a), null);
    if (!next) return;
    timer = setTimeout(tick, Math.min(MAX_DELAY, Math.max(0, Date.parse(next.at) - now)));
    timer.unref?.();
  };
  function tick() {
    const now = new Date();
    const due = list.filter((r) => Date.parse(r.at) <= now.getTime() + 500);
    for (const r of due) {
      const late = now - Date.parse(r.at);
      // Missed while the PC was off: say it once (if not ancient), then move on.
      if (late < 12 * 3600 * 1000) onFire({ ...r, late: late > 120000 });
      if (r.repeat && r.repeat !== 'none') r.at = nextAfter(r, now).toISOString();
      else list = list.filter((x) => x !== r);
    }
    save();
    schedule();
    api.onChange?.();
  }
  const api = {
    add({ text, at, repeat = 'none', speak = true }) {
      const when = at instanceof Date ? at : parseWhen(at);
      if (!when) throw new Error(`Couldn't understand the time "${at}". Use a time like "08:00" or a date and time like "2026-10-17 08:00".`);
      if (!REPEATS.includes(repeat)) repeat = 'none';
      if (repeat === 'none' && when <= new Date()) throw new Error('That time has already passed.');
      const r = { id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: String(text || 'Reminder').slice(0, 200), at: when.toISOString(), repeat, speak: speak !== false };
      // A repeating reminder whose first time already passed today starts at the next one.
      if (when <= new Date()) r.at = nextAfter(r, new Date()).toISOString();
      list.push(r);
      save();
      schedule();
      api.onChange?.();
      return r;
    },
    remove(id) {
      const before = list.length;
      list = list.filter((r) => r.id !== id);
      if (list.length === before) return false;
      save();
      schedule();
      api.onChange?.();
      return true;
    },
    list: () => list.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    start() { tick(); },
    onChange: null,
  };
  return api;
}

// "Every day at 8:00 AM", "Tomorrow at 9:30 AM", "Mon 14 Oct at 5:00 PM"
function describe(r) {
  const d = new Date(r.at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (r.repeat === 'daily') return `every day at ${time}`;
  if (r.repeat === 'weekdays') return `weekdays at ${time}`;
  if (r.repeat === 'weekly') return `every ${d.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
  if (r.repeat === 'hourly') return `every hour (next ${time})`;
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'today' : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} at ${time}`;
}

module.exports = { createReminders, parseWhen, describe, REPEATS };
