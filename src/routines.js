// "Show Island how": the user does a task once while Island watches, and Island can do it
// again later. Steps are kept as intent (which app, which control by its name and kind,
// what text), not as screen positions, so a replay finds each control again even after the
// window moved or the layout shifted. A step that can't be found stops the replay and the
// model carries on from the screen (and can resume the rest with from_step).
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- keys ----------

const MODS = new Set([0x10, 0x11, 0x12, 0x5b]);
const VK_NAME = { 8: 'backspace', 9: 'tab', 13: 'enter', 27: 'escape', 32: 'space', 33: 'page_up', 34: 'page_down', 35: 'end', 36: 'home', 37: 'left', 38: 'up', 39: 'right', 40: 'down', 45: 'insert', 46: 'delete', 0xba: 'semicolon', 0xbb: 'equal', 0xbc: 'comma', 0xbd: 'minus', 0xbe: 'period', 0xbf: 'slash', 0xc0: 'grave', 0xdb: 'bracketleft', 0xdc: 'backslash', 0xdd: 'bracketright', 0xde: 'apostrophe' };
const SHIFTED = { 0x30: ')', 0x31: '!', 0x32: '@', 0x33: '#', 0x34: '$', 0x35: '%', 0x36: '^', 0x37: '&', 0x38: '*', 0x39: '(', 0xba: ':', 0xbb: '+', 0xbc: '<', 0xbd: '_', 0xbe: '>', 0xbf: '?', 0xc0: '~', 0xdb: '{', 0xdc: '|', 0xdd: '}', 0xde: '"' };
const PLAIN_CH = { 0xba: ';', 0xbb: '=', 0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '`', 0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'", 32: ' ' };
// Keys that move around or act on their own (recorded even without Ctrl/Alt), unless the
// user is in a text box, where they are just editing (the text itself is recorded).
const NAV = new Set(['up', 'down', 'left', 'right', 'page_up', 'page_down', 'home', 'end', 'delete', 'backspace', 'space', 'insert']);
// Editing shortcuts inside a text box: the resulting text is what's recorded.
const TEXT_COMBOS = new Set(['ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y', 'ctrl+backspace', 'ctrl+delete', 'ctrl+left', 'ctrl+right', 'ctrl+home', 'ctrl+end', 'ctrl+b', 'ctrl+i', 'ctrl+u']);

function keyName(vk) {
  if (VK_NAME[vk]) return VK_NAME[vk];
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk).toLowerCase();
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x87) return `f${vk - 0x6f}`;
  return null;
}

function keyChar(vk, shift) {
  if (vk >= 0x41 && vk <= 0x5a) return shift ? String.fromCharCode(vk) : String.fromCharCode(vk).toLowerCase();
  if (shift && SHIFTED[vk]) return SHIFTED[vk];
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  return PLAIN_CH[vk] ?? null;
}

// "Alt+Space" (Electron accelerator) -> "alt+space"
function normCombo(accel) {
  return String(accel || '').toLowerCase().replace(/control|commandorcontrol|cmdorctrl/g, 'ctrl').replace(/super|meta|command/g, 'win').replace(/\s+/g, '');
}

// Text boxes where Enter/Tab are part of the text (a document) rather than "submit".
const isDocument = (type) => /^(Document|Custom|Pane|Group|DataItem)$/.test(type || '');
// Whole pages, panes and windows: their names (often the page title) change, so they are
// found again by where they were, not by name.
const CONTAINER = /^(Document|Pane|Window|Group|Custom)$/;

// ---------- recording ----------

class Recorder {
  // input, uia: Island's helpers. isIgnored(x, y): the point is on Island or its recording
  // card. onChange(steps): live list for the card. hotkey: Island's own shortcut (not recorded).
  constructor({ input, uia, isIgnored, onChange, hotkey }) {
    this.input = input;
    this.uia = uia;
    this.isIgnored = isIgnored || (() => false);
    this.onChange = onChange || (() => {});
    this.hotkey = normCombo(hotkey);
    this.steps = [];
    this.field = null;
    this.prevKeys = new Set();
    this.press = { left: null, right: null };
    this.running = false;
    this.blind = null; // keys typed where Windows can't tell us the text
  }

  start() {
    this.running = true;
    this.startedAt = Date.now();
    this.loops = [this.pointerLoop(), this.textLoop()];
  }

  async stop() {
    this.running = false;
    await Promise.all(this.loops || []).catch(() => {});
    this.flushField();
    this.flushBlind();
    return this.steps;
  }

  push(step) {
    step.t = Date.now() - this.startedAt;
    this.steps.push(step);
    if (this.steps.length > 200) this.steps.shift();
    this.onChange(this.steps);
  }

  // The window a click or key went to: app name, title, and its rectangle.
  async windowAt() {
    const fg = await this.input.foreground().catch(() => null);
    if (!fg || fg.pid === process.pid) return null;
    return { app: fg.app, title: fg.title, rect: fg.rect };
  }

  async pointerLoop() {
    // The first look also reports presses from before recording began: discard it.
    try {
      this.prevKeys = new Set((await this.input.keysDown()).map((vk) => (vk === 0x5c ? 0x5b : vk)));
      await this.input.mouseState();
      await this.input.wheelWatch?.(true);
    } catch {}
    let busy = false;
    while (this.running) {
      if (!busy) {
        busy = true;
        try {
          const m = await this.input.mouseState();
          await this.mouse('left', m.down, m);
          await this.mouse('right', m.right, m);
          await this.keys(await this.input.keysDown());
          if (this.input.wheelRead) await this.wheel(await this.input.wheelRead());
        } catch {}
        busy = false;
      }
      await sleep(35);
    }
    try { await this.input.wheelWatch?.(false); } catch {}
  }

  // Wheel turns since the last look -> a scroll step (joined with the one before when it
  // goes the same way). Touchpads send small turns: they add up to notches.
  async wheel(w) {
    if (!w) return;
    this.wheelRest = (this.wheelRest || 0) + (w.v || 0);
    const notches = Math.trunc(this.wheelRest / 120);
    if (!notches || this.isIgnored(w.x, w.y)) { if (this.isIgnored(w.x, w.y)) this.wheelRest = 0; return; }
    this.wheelRest -= notches * 120;
    const dir = notches > 0 ? 'up' : 'down';
    const n = Math.abs(notches);
    const last = this.steps[this.steps.length - 1];
    if (last?.action === 'scroll' && last.dir === dir && Date.now() - this.startedAt - last.t < 2500) {
      last.amount += n;
      last.t = Date.now() - this.startedAt;
      this.onChange(this.steps);
      return;
    }
    this.flushField();
    this.flushBlind();
    const [el, win] = await Promise.all([this.uia.atDeep(w.x, w.y).catch(() => null), this.windowAt()]);
    if (!win) return;
    this.push({ action: 'scroll', dir, amount: n, app: win.app, title: win.title, target: describeTarget(el, w.x, w.y), win: relTo(win.rect, w.x, w.y), abs: [w.x, w.y] });
  }

  async mouse(btn, down, m) {
    const p = this.press[btn];
    if (down && !p) {
      if (this.isIgnored(m.x, m.y)) { this.press[btn] = { ignored: true }; return; }
      // Look at what's under the pointer right away: a menu item is gone after the click.
      this.press[btn] = { x: m.x, y: m.y, at: Date.now(), el: this.uia.atDeep(m.x, m.y).catch(() => null), win: this.windowAt() };
      this.flushField();
      this.flushBlind();
    } else if (!down && p) {
      this.press[btn] = null;
      if (p.ignored) return;
      const [el0, win] = await Promise.all([p.el, p.win]);
      if (!win) return; // a click on Island itself
      const moved = Math.hypot(m.x - p.x, m.y - p.y);
      // "The page" or "the window" says little; the box that took focus right there says more.
      let el = el0;
      if (CONTAINER.test(el0?.type || '') && moved <= 14) {
        // (with some slack: a toolbar appearing or hiding can shift the page a little)
        const inside = (f) => f?.rect && f.pid !== process.pid && !CONTAINER.test(f.type) && p.x >= f.rect[0] - 8 && p.x <= f.rect[2] + 8 && p.y >= f.rect[1] - 36 && p.y <= f.rect[3] + 36;
        for (let k = 0; k < 3; k++) {
          const f = await this.uia.typed().catch(() => null);
          if (inside(f)) { el = f; break; }
          await sleep(120); // focus moves a moment after the click
        }
      }
      const target = describeTarget(el, p.x, p.y);
      const where = { app: win.app, title: win.title, win: relTo(win.rect, p.x, p.y), abs: [p.x, p.y] };
      if (btn === 'left' && moved > 14) {
        const to = await this.uia.atDeep(m.x, m.y).catch(() => null);
        this.push({ action: 'drag', ...where, target, to: { ...describeTarget(to, m.x, m.y), win: relTo(win.rect, m.x, m.y), abs: [m.x, m.y] } });
        return;
      }
      const last = this.steps[this.steps.length - 1];
      if (btn === 'left' && last?.action === 'click' && Date.now() - this.lastClickAt < 450 && Math.hypot(last.abs[0] - p.x, last.abs[1] - p.y) < 8) {
        last.action = 'double_click';
        this.onChange(this.steps);
        return;
      }
      this.lastClickAt = Date.now();
      this.push({ action: btn === 'right' ? 'right_click' : 'click', ...where, target });
    }
  }

  async keys(list) {
    const held = new Set(list.map((vk) => (vk === 0x5c ? 0x5b : vk)));
    const fresh = [...held].filter((k) => !this.prevKeys.has(k) && !MODS.has(k));
    this.prevKeys = held;
    for (const vk of fresh) {
      const name = keyName(vk);
      if (!name) continue;
      const ctrl = held.has(0x11), alt = held.has(0x12), win = held.has(0x5b), shift = held.has(0x10);
      const combo = [ctrl && 'ctrl', alt && 'alt', win && 'win', shift && 'shift', name].filter(Boolean).join('+');
      if (combo === this.hotkey) continue;
      const f = this.field;
      const inText = !!f && (f.text != null || f.password);
      if (f?.password && !ctrl && !alt && !win) {
        f.typedSecret = true;
        if (name !== 'enter' && name !== 'tab') continue;
      }
      const plain = !ctrl && !alt && !win;
      let record;
      if (plain) {
        if (name === 'enter' || name === 'tab') record = !(inText && isDocument(f.type));
        else if (name === 'escape' || /^f\d+$/.test(name)) record = true;
        else if (NAV.has(name) && name !== 'space') record = !inText;
        else {
          // An ordinary character. In a text box the text itself is recorded; elsewhere
          // (some web apps and games hide their text) keep the keys.
          if (!inText) {
            const ch = keyChar(vk, shift);
            if (ch) (this.blind ||= { text: '', win: await this.windowAt() }).text += ch;
          }
          continue;
        }
      } else {
        record = !(inText && TEXT_COMBOS.has(combo.replace('shift+', '')));
      }
      if (!record) continue;
      // Before Enter/Tab, read the box once more: the last letters may be newer than the
      // last look (unless the box was cleared by Enter, as chat boxes do).
      if (inText && f.text != null) {
        const now = await this.uia.typed().catch(() => null);
        if (now?.text && now.text.startsWith(f.last || '') && now.text.length > (f.last || '').length) f.last = now.text;
      }
      this.flushField();
      this.flushBlind();
      const last = this.steps[this.steps.length - 1];
      const keyCombo = combo.replace(/\bwin\b/, 'super');
      if (last?.action === 'key' && last.key === keyCombo && Date.now() - this.startedAt - last.t < 1500) {
        last.repeat = (last.repeat || 1) + 1;
        last.t = Date.now() - this.startedAt;
        this.onChange(this.steps);
        continue;
      }
      const w = await this.windowAt();
      this.push({ action: 'key', key: keyCombo, app: w?.app, title: w?.title });
    }
  }

  // What's typed is read from the focused text box itself, so autocorrect, pasting, Hindi
  // input methods and backspacing all come out as the final text.
  async textLoop() {
    while (this.running) {
      const f = await this.uia.typed().catch(() => null);
      if (f && f.pid !== process.pid && this.running) {
        const key = `${f.pid}|${f.type}|${f.name}|${f.rect ? `${Math.round(f.rect[0] / 40)},${Math.round(f.rect[1] / 40)}` : ''}`;
        if (!this.field || this.field.key !== key) {
          this.flushField();
          const win = await this.windowAt();
          this.field = { key, name: f.name, type: f.type, rect: f.rect, start: f.text, last: f.text, text: f.text, password: !!f.password, typedSecret: false, win };
        } else {
          this.field.last = f.text;
        }
      }
      await sleep(180);
    }
  }

  flushField() {
    const f = this.field;
    if (!f) return;
    const into = { name: f.name || '', type: f.type || '' };
    const where = f.win ? { app: f.win.app, title: f.win.title } : {};
    if (f.password && f.typedSecret) {
      this.push({ action: 'type', secret: true, into, ...where });
      f.typedSecret = false;
      return;
    }
    if (f.last == null || f.start == null || f.last === f.start) return;
    if (isDocument(f.type)) {
      // A document: only what was added (and where it ends matters less than what it is).
      let p = 0;
      while (p < f.start.length && p < f.last.length && f.start[p] === f.last[p]) p++;
      let s = 0;
      while (s < f.start.length - p && s < f.last.length - p && f.start[f.start.length - 1 - s] === f.last[f.last.length - 1 - s]) s++;
      const added = f.last.slice(p, f.last.length - s);
      if (added) this.push({ action: 'type', mode: 'insert', text: added, into, ...where });
    } else {
      this.push({ action: 'type', mode: 'replace', text: f.last, into, ...where });
    }
    f.start = f.last;
  }

  flushBlind() {
    const b = this.blind;
    this.blind = null;
    if (b?.text) this.push({ action: 'type', mode: 'keys', text: b.text, app: b.win?.app, title: b.win?.title });
  }
}

// Point as fractions of a rectangle [l, t, r, b].
function relTo(rect, x, y) {
  if (!rect || rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4) return null;
  return [+((x - rect[0]) / (rect[2] - rect[0])).toFixed(4), +((y - rect[1]) / (rect[3] - rect[1])).toFixed(4)];
}

function describeTarget(el, x, y) {
  if (!el) return { name: '', type: '' };
  return { name: String(el.name || '').trim().slice(0, 120), type: el.type || '', at: relTo(el.rect, x, y), size: el.rect ? [el.rect[2] - el.rect[0], el.rect[3] - el.rect[1]] : null };
}

// Recorded steps -> a clean routine: drop Island's own bits and empty noise.
function tidy(steps) {
  const out = [];
  for (const s of steps) {
    const { t, ...rest } = s;
    if (rest.action === 'type' && !rest.secret && !rest.text) continue;
    out.push(rest);
  }
  return out;
}

const q = (s, n = 50) => `"${String(s).replace(/\s+/g, ' ').trim().slice(0, n)}${String(s).length > n ? '…' : ''}"`;
const prettyKey = (k) => k.split('+').map((p) => (p === 'super' ? 'Win' : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1).replace('_', ' '))).join('+');
const APPS = { chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook', olk: 'Outlook', explorer: 'File Explorer', notepad: 'Notepad', 'ms-teams': 'Teams', whatsapp: 'WhatsApp', mspaint: 'Paint', calculatorapp: 'Calculator', systemsettings: 'Settings', acrobat: 'Acrobat', acrord32: 'Acrobat Reader' };
const appLabel = (s) => (s.app === 'ApplicationFrameHost' ? s.title || 'the app' : APPS[String(s.app).toLowerCase()] || String(s.app).charAt(0).toUpperCase() + String(s.app).slice(1));
const appName = (s) => (s.app ? ` in ${appLabel(s)}` : '');
const KIND = { Edit: 'box', Button: 'button', SplitButton: 'button', Hyperlink: 'link', MenuItem: 'menu item', TabItem: 'tab', ListItem: 'item', TreeItem: 'item', CheckBox: 'checkbox', RadioButton: 'option', ComboBox: 'dropdown', Document: 'page', DataItem: 'cell', Text: 'text', Image: 'picture', Pane: 'area', Window: 'window', MenuBar: 'menu bar' };

// One line per step, for people and the model.
function describeStep(s) {
  const what = (t) => {
    const kind = KIND[t?.type] || (t?.type ? t.type.toLowerCase() : '');
    if (t?.name) return `the ${q(t.name, 40)}${kind ? ` ${kind}` : ''}`;
    return kind ? `an unnamed ${kind}` : 'a spot';
  };
  switch (s.action) {
    case 'click': return `Click ${what(s.target)}${appName(s)}`;
    case 'double_click': return `Double-click ${what(s.target)}${appName(s)}`;
    case 'right_click': return `Right-click ${what(s.target)}${appName(s)}`;
    case 'drag': return `Drag ${what(s.target)} to ${what(s.to)}${appName(s)}`;
    case 'key': return `Press ${prettyKey(s.key)}${s.repeat > 1 ? ` ×${s.repeat}` : ''}`;
    case 'scroll': return `Scroll ${s.dir}${s.amount > 1 ? ` ×${s.amount}` : ''}${appName(s)}`;
    case 'type':
      if (s.secret) return `Type a password into ${what(s.into)} (not recorded: you'll be asked)`;
      return `Type ${q(s.text, 60)}${s.into?.name ? ` into ${what(s.into)}` : ''}`;
  }
  return s.action;
}

// ---------- the saved list ----------

function createRoutines(file) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')).routines || []; } catch {}
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify({ routines: list }, null, 1)); } catch {}
    api.onChange?.(list);
  };
  const find = (name) => {
    const n = String(name || '').trim().toLowerCase();
    return list.find((r) => r.name.toLowerCase() === n) || list.find((r) => r.name.toLowerCase().includes(n) && n.length >= 3);
  };
  const api = {
    list: () => list.slice(),
    get: find,
    add(r) {
      const old = list.findIndex((x) => x.name.toLowerCase() === r.name.toLowerCase());
      const entry = { name: r.name, description: r.description || '', steps: r.steps, created: new Date().toISOString(), runs: 0 };
      if (old >= 0) list[old] = entry;
      else list.push(entry);
      save();
      return entry;
    },
    remove(name) {
      const r = find(name);
      if (!r) return false;
      list = list.filter((x) => x !== r);
      save();
      return true;
    },
    ran(name) {
      const r = find(name);
      if (r) { r.runs = (r.runs || 0) + 1; r.lastRun = new Date().toISOString(); save(); }
    },
    onChange: null,
  };
  return api;
}

// ---------- replay ----------

const sameApp = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
// Taskbar, Start, desktop, tray: no titled window to bring forward; their spots are fixed.
const shellSpot = (s) => !s.title || /^(SearchHost|StartMenuExperienceHost|ShellExperienceHost|SearchApp)$/i.test(s.app || '');

// Bring the step's app forward (waiting a little: a previous step may be opening it).
async function ensureWindow(s, { input, signal }) {
  if (!s.app || shellSpot(s)) return { ok: true };
  const deadline = Date.now() + 5000;
  for (;;) {
    const fg = await input.foreground().catch(() => null);
    if (fg && sameApp(fg.app, s.app)) return { ok: true, win: fg };
    const wins = ((await input.windows().catch(() => [])) || []).filter((w) => sameApp(w.app, s.app));
    const pick = wins.find((w) => w.title === s.title) || wins.find((w) => s.title && w.title && (w.title.includes(s.title) || s.title.includes(w.title))) || wins[0];
    if (pick) {
      await input.focus(pick.id).catch(() => false);
      await sleep(250);
      const now = await input.foreground().catch(() => null);
      if (now && sameApp(now.app, s.app)) return { ok: true, win: now };
    }
    if (Date.now() > deadline || signal?.aborted) return { ok: false, reason: `${s.app === 'ApplicationFrameHost' ? s.title || 'the app' : s.app} isn't open` };
    await sleep(400);
  }
}

// Where a recorded control is now (physical px), by its name first and position second.
async function locate(t, s, { uia, input, geometry, signal, win }) {
  const g = geometry();
  const area = g.physW * g.physH;
  const fg = win || (await input.foreground().catch(() => null));
  const rel = t === s.target ? s.win : t.win;
  const abs = t === s.target ? s.abs : t.abs;
  const hint = !shellSpot(s) && rel && fg?.rect ? { x: fg.rect[0] + rel[0] * (fg.rect[2] - fg.rect[0]), y: fg.rect[1] + rel[1] * (fg.rect[3] - fg.rect[1]) } : abs ? { x: abs[0], y: abs[1] } : null;
  const pointIn = (m) => {
    const [l, tp, r, b] = m.rect;
    const w = r - l, h = b - tp;
    // Small controls: the middle. Big ones (a list, a page): the same spot inside it.
    const at = t.at && (w > 80 || h > 60) ? t.at : [0.5, 0.5];
    return { x: Math.round(l + clamp(at[0], 0.05, 0.95) * w), y: Math.round(tp + clamp(at[1], 0.05, 0.95) * h) };
  };
  const typeOk = (m) => !t.type || m.type === t.type;
  const good = (r) => r?.match?.rect && (r.score === 100 ? typeOk(r.match) || !t.type : r.score >= 80 && typeOk(r.match));
  const deadline = Date.now() + 6000;
  const start = Date.now();
  let triedScroll = false;
  for (;;) {
    if (t.name && !CONTAINER.test(t.type || '')) {
      let r = hint ? await uia.find({ x: hint.x, y: hint.y, name: t.name, radius: Math.round(90 * g.sf), maxDist: Math.round(260 * g.sf), screenArea: area }).catch(() => null) : null;
      if (!good(r)) r = await uia.find({ name: t.name, screenArea: area }).catch(() => null);
      if (good(r)) return { p: pointIn(r.match), how: 'name' };
      // Not in view: it may be further down the page. Let the app scroll it into view once.
      if (!triedScroll && Date.now() - start > 900 && uia.findText) {
        triedScroll = true;
        const f = await uia.findText(t.name, area, true).catch(() => null);
        const m = f?.matches?.[0];
        if (f?.scrolled && m?.rect && !m.off && typeOk(m) && String(m.name).trim().toLowerCase() === t.name.trim().toLowerCase()) return { p: pointIn(m), how: 'scrolled' };
        if (f?.scrolled) continue; // look again now that the page moved
      }
    } else if (hint) {
      // No name to go by (or a whole page/pane): the same spot in the window, if the same
      // kind of thing is there.
      const here = CONTAINER.test(t.type || '') ? await uia.at(hint.x, hint.y).catch(() => null) : await uia.atDeep(hint.x, hint.y).catch(() => null);
      if (here && (!t.type || here.type === t.type || (CONTAINER.test(t.type) && CONTAINER.test(here.type)))) return { p: { x: Math.round(hint.x), y: Math.round(hint.y) }, how: 'position' };
    }
    if (Date.now() > deadline || signal?.aborted) return null;
    await sleep(450);
  }
}

// Replays steps [from..]. computer: Island's Computer (moves the visible cursor, types).
// values: { stepNumber: text } to type instead of the recorded text.
// -> { done, total, log, stopped?: { step, reason } }
async function replay(routine, { computer, input, uia, signal, from = 1, values = {} }) {
  const steps = routine.steps || [];
  const total = steps.length;
  const log = [];
  const geometry = () => computer.geometry();
  for (let i = Math.max(1, from); i <= total; i++) {
    if (signal?.aborted) return { done: i - 1, total, log, stopped: { step: i, reason: 'stopped by the user' } };
    const s = steps[i - 1];
    const line = describeStep(s);
    computer.ov({ type: 'step', text: `Step ${i} of ${total} · ${line}` });
    const stop = (reason) => ({ done: i - 1, total, log, stopped: { step: i, reason, line } });
    const w = await ensureWindow(s, { input, signal });
    if (!w.ok) return stop(w.reason);
    if (s.action === 'click' || s.action === 'double_click' || s.action === 'right_click') {
      const at = await locate(s.target, s, { uia, input, geometry, signal, win: w.win });
      if (!at) return stop(`couldn't find ${s.target?.name ? `${s.target.type || 'control'} "${s.target.name}"` : 'the spot'} on screen`);
      await computer.clickAt(at.p, s.action === 'right_click' ? 'right' : 'left', s.action === 'double_click' ? 2 : 1, signal);
      log.push(`${i}. ${line}${at.how === 'position' ? ' (by position)' : ''}`);
      await sleep(350);
    } else if (s.action === 'drag') {
      const a = await locate(s.target, s, { uia, input, geometry, signal, win: w.win });
      const b = a && (await locate(s.to, s, { uia, input, geometry, signal, win: w.win }));
      if (!a || !b) return stop("couldn't find both ends of the drag");
      await computer.dragBetween(a.p, b.p, signal);
      log.push(`${i}. ${line}`);
      await sleep(350);
    } else if (s.action === 'type') {
      if (s.secret) return stop('this step is a password or other private entry, which Island never records');
      const text = values[i] ?? s.text;
      if (s.into?.name) {
        const f = await uia.typed().catch(() => null);
        if (!(f && f.name === s.into.name && (!s.into.type || f.type === s.into.type))) {
          const at = await locate(s.into, { ...s, target: s.into }, { uia, input, geometry, signal, win: w.win });
          if (!at) return stop(`couldn't find the box ${s.into.type || ''} "${s.into.name}" to type into`);
          await computer.clickAt(at.p, 'left', 1, signal);
          await sleep(250);
        }
      }
      if (s.mode === 'replace') {
        await computer.run('key', { text: 'ctrl+a' }, signal);
        if (text) await computer.run('type', { text }, signal);
        else await computer.run('key', { text: 'delete' }, signal);
      } else if (text) await computer.run('type', { text }, signal);
      const after = await uia.typed().catch(() => null);
      const seen = after?.text != null && text ? after.text.replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 200)) : null;
      log.push(`${i}. ${values[i] != null ? `Type ${q(text, 60)} (your new text)` : line}${seen === false ? " (couldn't confirm the text landed)" : ''}`);
    } else if (s.action === 'key') {
      await computer.run('key', { text: s.key, repeat: s.repeat || 1 }, signal);
      log.push(`${i}. ${line}`);
      await sleep(s.key === 'enter' ? 500 : 250);
    } else if (s.action === 'scroll') {
      // The same spot in the window. (Clicks after it find their control by name anyway,
      // scrolling to it if the page ended up somewhere else.)
      const r = w.win?.rect;
      const p = !shellSpot(s) && s.win && r ? { x: Math.round(r[0] + s.win[0] * (r[2] - r[0])), y: Math.round(r[1] + s.win[1] * (r[3] - r[1])) } : s.abs ? { x: s.abs[0], y: s.abs[1] } : null;
      await computer.scrollAt(p, s.dir, clamp(s.amount || 1, 1, 60), signal);
      log.push(`${i}. ${line}`);
      await sleep(400);
    }
  }
  return { done: total, total, log };
}

module.exports = { Recorder, createRoutines, replay, describeStep, tidy, normCombo, keyName };
