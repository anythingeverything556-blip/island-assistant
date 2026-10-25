// Executes Claude's computer-use actions (computer_toolset_20260801) on the real desktop,
// with a click-through overlay that shows the agent's cursor, clicks and typing.
const { BrowserWindow, screen, desktopCapturer, nativeImage } = require('electron');
const { describeFocus, describeElement } = require('./uia');
const path = require('path');
const { parseCombo } = require('./input');
const clip = require('./clip');
const { Recorder, describeStep } = require('./routines');
const ocr = require('./ocr');

const MAX_EDGE = 1366; // screenshot long edge; Claude's coordinates live in this space
const READ_ONLY = new Set(['screenshot', 'zoom', 'cursor_position', 'wait']);
const TAKEOVER_PX = 24;

// How quickly Island moves. Fast still shows every motion, just briskly, and long text
// is pasted (clipboard restored afterwards) instead of typed key by key.
const SPEEDS = {
  fast: { move: [90, 0.17, 320], type: [1400, 1, 9], paste: 80, settle: 1, settleMax: 1500 },
  normal: { move: [180, 0.33, 650], type: [3500, 3, 28], paste: 400, settle: 1.25, settleMax: 2200 },
  careful: { move: [260, 0.45, 900], type: [5000, 10, 35], paste: Infinity, settle: 1.7, settleMax: 3200 },
};
// Minimum wait after an action before checking that the screen has settled.
const SETTLE_MS = { type: 60, key: 140, hold_key: 100, left_click: 150, right_click: 150, middle_click: 150, double_click: 180, triple_click: 180, left_click_drag: 160, scroll: 200, mouse_move: 50, left_mouse_up: 140, launch_app: 700, open_url: 900, open_item: 500, focus_window: 100 };
// After these the screen rarely keeps changing, so one capture is enough.
const QUICK = new Set(['type', 'mouse_move', 'hold_key', 'left_mouse_down']);
// These can start a page load or open a window: allow more time to settle.
const SLOW = new Set(['open_url', 'launch_app', 'open_item', 'key', 'left_click', 'double_click', 'wait']);

class TakeoverError extends Error {}
class StoppedError extends Error {}
class BlankCaptureError extends Error {
  constructor() { super('The screenshot came back blank. Windows sometimes does this while a window is opening or a secure screen (like a UAC prompt) is showing; wait a moment and take another one.'); }
}
// A click refused because the screen changed under it; carries a fresh screenshot.
class StaleClickError extends Error {
  constructor(message, blocks) { super(message); this.blocks = blocks; }
}
const BLANK_NOTE = '[No screenshot this time: the screen capture came back blank (a window may still be opening, or Windows is showing a secure screen). Take a screenshot again before relying on what is on screen.]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function describe(name, i = {}) {
  const at = Array.isArray(i.coordinate) ? ` at ${Math.round(i.coordinate[0])}, ${Math.round(i.coordinate[1])}` : '';
  const mods = i.text && name !== 'type' && name !== 'key' && name !== 'hold_key' ? ` with ${i.text}` : '';
  const short = (s, n = 38) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  switch (name) {
    case 'screenshot': return 'Looking at the screen';
    case 'zoom': return 'Zooming in for detail';
    case 'cursor_position': return 'Checking cursor position';
    case 'left_click': return `Click${at}${mods}`;
    case 'right_click': return `Right-click${at}${mods}`;
    case 'middle_click': return `Middle-click${at}`;
    case 'double_click': return `Double-click${at}${mods}`;
    case 'triple_click': return `Triple-click${at}`;
    case 'left_click_drag': return 'Drag';
    case 'mouse_move': return `Move pointer${at}`;
    case 'left_mouse_down': return `Press mouse button${at}`;
    case 'left_mouse_up': return 'Release mouse button';
    case 'hold_click': return `Hold the ${i.button || 'left'} button${at} for ${i.duration ?? 1}s`;
    case 'scroll': return `Scroll ${i.scroll_direction || ''} ×${i.scroll_amount ?? ''}`;
    case 'type': return `Type “${short(String(i.text ?? '').replace(/\s+/g, ' '))}”`;
    case 'key': {
      try { return `Press ${parseCombo(i.text).pretty.join('+')}${i.repeat > 1 ? ` ×${i.repeat}` : ''}`; } catch { return `Press ${i.text}`; }
    }
    case 'hold_key': return `Hold ${i.text} for ${i.duration}s`;
    case 'wait': return `Wait ${i.duration}s`;
  }
  return name;
}

class Computer {
  constructor({ input, getIsland, getHotkey, getStopHotkey, uia, restoreFocus }) {
    this.input = input;
    this.uia = uia || null;
    this.restoreFocus = restoreFocus || null;
    this.getIsland = getIsland;
    this.getHotkey = getHotkey;
    // The key that stops Island, shown on the bar while it drives the computer.
    this.getStopHotkey = getStopHotkey || null;
    this.overlay = null;
    this.overlayReady = null;
    this.active = false;
    this.expected = null; // where we last put the cursor (physical px)
    this.heldButton = null; // the mouse button Island is holding down, if any
    this.staleAt = new Map(); // spots a click was refused at, and how often
    this.movingUntil = 0; // while set, the screen is taken to be always moving
    this.steps = 0;
    this.speed = SPEEDS.fast;
  }

  setSpeed(name) {
    this.speed = SPEEDS[name] || SPEEDS.fast;
  }

  geometry() {
    const d = screen.getDisplayMatching(this.getIsland().getBounds());
    const sf = d.scaleFactor;
    const physW = Math.round(d.size.width * sf);
    const physH = Math.round(d.size.height * sf);
    const k = Math.min(1, MAX_EDGE / Math.max(physW, physH));
    const shotW = Math.round(physW * k);
    const shotH = Math.round(physH * k);
    const origin = process.platform === 'win32' ? screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y }) : { x: d.bounds.x, y: d.bounds.y };
    return { d, sf, physW, physH, shotW, shotH, scale: shotW / physW, origin };
  }

  // screenshot space -> physical screen pixels
  toPhys(c, g) {
    c = numbers(c); // some models send "275, 206" instead of [275, 206]
    if (c && !Array.isArray(c) && typeof c === 'object' && 'x' in c) c = [Number(c.x), Number(c.y)];
    if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)) throw new Error('coordinate must be [x, y]');
    const [x, y] = c;
    if (x < 0 || y < 0 || x > g.shotW || y > g.shotH) throw new Error(`coordinate (${x}, ${y}) is outside the ${g.shotW}x${g.shotH} screen`);
    return { x: Math.round(g.origin.x + x / g.scale), y: Math.round(g.origin.y + y / g.scale) };
  }
  // physical -> overlay CSS px (DIP relative to the display)
  toOverlay(p, g) {
    return { x: (p.x - g.origin.x) / g.sf, y: (p.y - g.origin.y) / g.sf };
  }

  ov(msg) {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send('ov', msg);
  }

  // ---------- capture ----------

  async grab(g, size = { width: g.physW, height: g.physH }) {
    const island = this.getIsland();
    // Exclude our own windows from the capture (WDA_EXCLUDEFROMCAPTURE) instead of hiding them.
    island.setContentProtection(true);
    await sleep(this.active ? 0 : 50);
    try {
      // Windows sometimes hands back an empty frame (a window opening, a display change, a
      // secure screen); a moment later it's usually fine.
      for (let i = 0; ; i++) {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
        const src = sources.find((s) => s.display_id === String(g.d.id)) || sources[0];
        if (!src) throw new Error('No screen available to capture');
        if (!src.thumbnail.isEmpty() && src.thumbnail.getSize().width > 0) return src.thumbnail;
        if (i >= 3) throw new BlankCaptureError();
        await sleep(150 * (i + 1));
      }
    } finally {
      if (!this.active) island.setContentProtection(false);
    }
  }

  // One capture at screenshot size (the model's coordinate space).
  async frame(g = this.geometry()) {
    let img = await this.grab(g);
    if (img.getSize().width !== g.shotW) img = img.resize({ width: g.shotW, height: g.shotH, quality: 'best' });
    return img;
  }

  async screenshot() {
    const g = this.geometry();
    const img = await this.frame(g);
    return { base64: img.toJPEG(85).toString('base64'), mediaType: 'image/jpeg', width: g.shotW, height: g.shotH };
  }

  async zoom(region, g) {
    region = numbers(region);
    if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) throw new Error('region must be [x0, y0, x1, y1]');
    let [x0, y0, x1, y1] = region;
    x0 = clamp(x0, 0, g.shotW); x1 = clamp(x1, 0, g.shotW); y0 = clamp(y0, 0, g.shotH); y1 = clamp(y1, 0, g.shotH);
    if (x1 - x0 < 4 || y1 - y0 < 4) throw new Error('region is too small or inverted');
    const a = this.toPhys([x0, y0], g);
    const b = this.toPhys([x1, y1], g);
    const oa = this.toOverlay(a, g), ob = this.toOverlay(b, g);
    this.ov({ type: 'zoom', x: oa.x, y: oa.y, w: ob.x - oa.x, h: ob.y - oa.y });
    const full = await this.grab(g);
    const rect = { x: a.x - g.origin.x, y: a.y - g.origin.y, width: b.x - a.x, height: b.y - a.y };
    let img = full.crop(rect);
    const k = MAX_EDGE / Math.max(rect.width, rect.height);
    img = img.resize({ width: Math.round(rect.width * k), height: Math.round(rect.height * k), quality: 'best' });
    // The exact text in the area too (Windows text recognition): small print, numbers and
    // tables come back as characters, not just pixels.
    const lines = await ocr.recognize(img.toPNG()).then((r) => r.lines).catch(() => []);
    const text = lines.map((l) => l.text).join('\n').slice(0, 2500);
    const { width, height } = img.getSize();
    const png = width * height <= 1600 * 1000;
    return { base64: (png ? img.toPNG() : img.toJPEG(92)).toString('base64'), mediaType: png ? 'image/png' : 'image/jpeg', text };
  }

  // The screenshot the model sees after a batch of actions: taken once the screen has
  // stopped changing (page loads, menus opening, animations). Captures cost ~140 ms each,
  // so the settled frame itself becomes the screenshot instead of capturing again.
  async observeSettled(lastAction, signal) {
    const sp = this.speed;
    const g = this.geometry();
    await sleep(Math.round((SETTLE_MS[lastAction] ?? 200) * sp.settle));
    let img;
    try {
      img = await this.frame(g);
    } catch (e) {
      if (e instanceof BlankCaptureError) return this.blankObservation();
      throw e;
    }
    // A screen that never stops moving (a game, a video): waiting for it to settle only
    // wastes time, and every extra frame is another 140 ms. Take one frame and go.
    if (!QUICK.has(lastAction) && !(this.movingUntil && Date.now() < this.movingUntil)) {
      const t0 = Date.now();
      let prev = thumb(img);
      const max = SLOW.has(lastAction) ? sp.settleMax * 2 : sp.settleMax;
      let settled = false;
      while (Date.now() - t0 < max && !signal?.aborted) {
        await sleep(60);
        const next = await this.frame(g).catch(() => null);
        if (!next) break; // keep the last good frame
        img = next;
        const cur = thumb(img);
        if (changedFraction(prev, cur) < 0.004) { settled = true; break; }
        prev = cur;
      }
      // It never settled twice in a row: this screen is always moving. Stop waiting.
      if (!settled) {
        this.unsettled = (this.unsettled || 0) + 1;
        if (this.unsettled >= 2) this.movingUntil = Date.now() + 30000;
      } else this.unsettled = 0;
    }
    return this.toObservation(img);
  }

  // No usable screenshot: say so in text instead of sending an empty image (which the
  // model provider rejects, and which would then break every later request in the chat).
  async blankObservation() {
    const line = await this.focusLine().catch(() => '');
    return [{ type: 'text', text: BLANK_NOTE }, ...(line ? [{ type: 'text', text: line }] : [])];
  }

  // Screen captures don't include the mouse pointer; draw a small ring where it is so the
  // model can see whether a click landed where it meant.
  async markPointer(img) {
    const g = this.geometry();
    const p = await this.input.pos();
    const cx = Math.round((p.x - g.origin.x) * g.scale);
    const cy = Math.round((p.y - g.origin.y) * g.scale);
    const { width: w, height: h } = img.getSize();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return img;
    const bmp = Buffer.from(img.toBitmap());
    const put = (x, y, b, gg, r) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      bmp[i] = b; bmp[i + 1] = gg; bmp[i + 2] = r; bmp[i + 3] = 255;
    };
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        const d = Math.hypot(dx, dy);
        if (d >= 6.2 && d <= 8) put(cx + dx, cy + dy, 255, 40, 255); // magenta ring
        else if ((d > 8 && d <= 9.2) || (d >= 5.2 && d < 6.2)) put(cx + dx, cy + dy, 20, 0, 20); // dark edge for contrast
      }
    }
    put(cx, cy, 255, 40, 255);
    return nativeImage.createFromBitmap(bmp, { width: w, height: h });
  }

  // ---------- session ----------

  ensureOverlay(g) {
    if (this.overlay && !this.overlay.isDestroyed()) {
      const b = this.overlay.getBounds();
      const want = g.d.bounds;
      if (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height) this.overlay.setBounds(want);
      return this.overlayReady;
    }
    this.overlay = new BrowserWindow({
      ...g.d.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, sandbox: true },
    });
    this.overlay.setAlwaysOnTop(true, 'screen-saver');
    this.overlay.setIgnoreMouseEvents(true, { forward: true }); // forward: the teaching card notices hovering
    this.overlay.setContentProtection(true);
    this.overlay.setBounds(g.d.bounds);
    this.overlayReady = new Promise((r) => this.overlay.webContents.once('did-finish-load', r));
    this.overlay.loadFile(path.join(__dirname, 'overlay', 'index.html'));
    return this.overlayReady;
  }

  async begin() {
    if (this.active) return;
    const g = this.geometry();
    await this.ensureOverlay(g);
    this.active = true;
    this.steps = 0;
    this.expected = null;
    const island = this.getIsland();
    island.setContentProtection(true);
    island.setIgnoreMouseEvents(true, { forward: true });
    const cur = await this.input.pos().catch(() => null);
    const o = cur ? this.toOverlay(cur, g) : {};
    this.overlay.showInactive();
    island.moveTop();
    this.ov({ type: 'show', hotkey: this.getStopHotkey ? this.getStopHotkey() : this.getHotkey(), ...o });
  }

  async end() {
    if (!this.active) return;
    this.active = false;
    this.expected = null;
    await this.releaseButton();
    // The island's own panel was made click-through while the agent drove the mouse, so
    // that the agent's clicks reached the desktop. Give the panel back its clicks, or
    // the Stop button in it can never be pressed.
    try { this.getIsland().setIgnoreMouseEvents(false, { forward: true }); } catch {}
    this.ov({ type: 'hide' });
    this.getIsland().setContentProtection(false);
    await sleep(380);
    if (!this.active && !this.teaching && !this.recording && this.overlay && !this.overlay.isDestroyed()) this.overlay.hide();
  }

  // Let go of a mouse button that is still held down. Without this, a press that is
  // never released (the turn ended, the model made a mistake, the user took over) stays
  // held for ever, and every later click of the user turns into a drag.
  async releaseButton() {
    const btn = this.heldButton;
    this.heldButton = null;
    if (!btn) return;
    try {
      await this.input.up(btn);
      this.ov({ type: 'click', button: btn, count: 1 });
    } catch {}
  }

  // ---------- teaching ----------
  // Show one lesson step on the real screen (spotlight + coach card) and wait for the
  // learner: "I did it", a click on the highlighted spot, "Do it for me", or a question.
  async teach(p, signal, onShow) {
    const g = this.geometry();
    const point = Array.isArray(p.target) && p.target.length === 2 && p.target.every(Number.isFinite) ? this.toPhys([clamp(p.target[0], 0, g.shotW), clamp(p.target[1], 0, g.shotH)], g) : null;

    // Snap to the real control the step names, and catch steps about things that aren't
    // on screen before the learner ever sees them.
    let el = null;
    let found = null;
    const popups = await this.openPopups();
    if (this.uia && p.target_name && popups.length) {
      // A menu or dropdown is open (the previous step opened it): the item is in there.
      // Searching only inside it matters: walking the whole app's UI makes modern menus close.
      const r = await this.uia.findIn(p.target_name, popups.map((w) => w.h), g.physW * g.physH).catch(() => null);
      if (r?.match?.rect && r.score >= 40) found = r;
      else if (!point) found = { match: null, score: 0, nearby: [] };
    }
    if (this.uia && !found && (p.target_name || point)) {
      found = await this.uia.find({ x: point?.x, y: point?.y, name: p.target_name || '', radius: Math.round(70 * g.sf), maxDist: Math.round(110 * g.sf), screenArea: g.physW * g.physH }).catch(() => null);
    }
    {
      const m = found?.match;
      const small = m?.rect && (m.rect[2] - m.rect[0]) * (m.rect[3] - m.rect[1]) < g.physW * g.physH * 0.06;
      if (m?.rect && (p.target_name ? found.score >= 40 : small)) el = m;
    }
    const key = `${p.step}|${p.target_name || ''}`;
    // Bounce the step only when there ARE named controls around and none is the one named
    // (a wrong guess). Slide canvases and drawings often expose no names at all; there the
    // model's point is the best there is, so show it rather than loop.
    if (p.target_name && !el && (found?.nearby?.length || !point) && this.teachMiss !== key) {
      this.teachMiss = key; // a second try at the same step is shown anyway
      const zoom = point ? await this.zoomQuiet([p.target[0] - 180, p.target[1] - 110, p.target[0] + 180, p.target[1] + 110], g).catch(() => null) : null;
      return { action: 'not_found', nearby: found?.nearby || [], zoom, nowhere: !point };
    }
    this.teachMiss = null;

    await this.ensureOverlay(g);
    let spot = null;
    let hit = null; // physical-pixel area that counts as clicking the target
    if (el) {
      const [l, t, r, b] = el.rect;
      const a = this.toOverlay({ x: l, y: t }, g);
      const z = this.toOverlay({ x: r, y: b }, g);
      spot = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2, w: Math.max(26, z.x - a.x + 12), h: Math.max(26, z.y - a.y + 12), box: z.x - a.x > 60 || z.y - a.y > 40 };
    } else if (Array.isArray(p.target_box) && p.target_box.length === 4 && p.target_box.every(Number.isFinite)) {
      const [x0, y0, x1, y1] = p.target_box;
      const a = this.toOverlay(this.toPhys([clamp(Math.min(x0, x1), 0, g.shotW), clamp(Math.min(y0, y1), 0, g.shotH)], g), g);
      const b = this.toOverlay(this.toPhys([clamp(Math.max(x0, x1), 0, g.shotW), clamp(Math.max(y0, y1), 0, g.shotH)], g), g);
      spot = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: Math.max(24, b.x - a.x + 12), h: Math.max(24, b.y - a.y + 12), box: true };
    } else if (Array.isArray(p.target) && p.target.length === 2 && p.target.every(Number.isFinite)) {
      const o = this.toOverlay(this.toPhys([clamp(p.target[0], 0, g.shotW), clamp(p.target[1], 0, g.shotH)], g), g);
      spot = { x: o.x, y: o.y, w: 46, h: 46 };
    }
    if (spot) {
      const pad = 10;
      hit = { x0: g.origin.x + (spot.x - spot.w / 2 - pad) * g.sf, x1: g.origin.x + (spot.x + spot.w / 2 + pad) * g.sf, y0: g.origin.y + (spot.y - spot.h / 2 - pad) * g.sf, y1: g.origin.y + (spot.y + spot.h / 2 + pad) * g.sf };
    }
    // Named a control Windows couldn't confirm: show the point as a guess, not a certainty.
    if (spot && p.target_name && !el) spot.guess = true;
    this.teachEl = el;
    const wantText = p.expect?.type === 'text' && p.expect.text ? normText(p.expect.text) : null;
    const startText = wantText && this.uia ? (await this.uia.caret().catch(() => null))?.text || '' : '';
    this.teachBefore = p.expect?.type === 'screen_changes' ? thumb(await this.frame(g).catch(() => null) || nativeImage.createEmpty()) : null;
    this.teaching = true;
    if (!this.overlay.isVisible()) this.overlay.showInactive();
    // Popups the app has before the learner acts: a new one afterwards = a menu opened.
    const wins = (await this.uia?.windows().catch(() => null)) || [];
    this.teachWins = new Set(wins.map((w) => w.h));
    this.teachWinsPid = wins[0]?.pid ?? null;
    // Steps that open a menu: keep the card off the area where it drops down.
    const opensMenu = p.action === 'right_click' || ['opened', 'appears'].includes(p.expect?.type);
    this.ov({ type: 'teach', step: p.step, total: p.total, instruction: p.instruction, detail: p.detail || '', action: p.action || 'click', spot, practice: !!p.practice && !!spot, prefer: opensMenu ? ['above', 'left', 'right', 'below'] : null });
    onShow?.();
    // Practice: the learner tries alone; if they hesitate, show them where.
    const revealTimer = p.practice && spot ? setTimeout(() => this.ov({ type: 'teach-reveal', text: 'Take your time. Here it is: the glowing spot.' }), Math.max(4000, Number(p.practice_wait_ms) || 9000)) : null;

    return new Promise((resolve) => {
      let done = false;
      let poll = null;
      let keyPoll = null;
      let typePoll = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(revealTimer);
        clearInterval(poll);
        clearInterval(keyPoll);
        clearInterval(typePoll);
        this.teachWaiter = null;
        signal?.removeEventListener('abort', onAbort);
        if (this.overlay && !this.overlay.isDestroyed()) this.overlay.setFocusable(false);
        resolve(r);
      };
      const onAbort = () => finish({ action: 'stopped' });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.teachWaiter = (r) => r.action !== 'again' && finish(r);

      // Key steps: pressing the key (or every key of a combination) is the step.
      if (p.action === 'press_key' && p.key) {
        let tokens = null;
        try { tokens = parseCombo(p.key).tokens; } catch {}
        if (tokens) {
          let held = false;
          let busy = false;
          keyPoll = setInterval(async () => {
            if (busy || done) return;
            busy = true;
            try {
              const k = await this.input.keyState(tokens);
              if (k.down) held = true;
              else if (held) {
                clearInterval(keyPoll); // once: no more polls while the "Nice!" plays
                this.ov({ type: 'teach-good' });
                setTimeout(() => finish({ action: 'pressed' }), 250);
              }
            } catch {}
            busy = false;
          }, 30);
        }
      }

      // Typing steps: read what they type; move on when the words are there, point out a
      // typo when they pause with something close but not quite right.
      if (wantText && this.uia) {
        let lastText = startText;
        let changedAt = 0;
        let hinted = null;
        let busy = false;
        typePoll = setInterval(async () => {
          if (busy || done) return;
          busy = true;
          try {
            const txt = (await this.uia.caret())?.text || '';
            const typed = txt.startsWith(startText) ? txt.slice(startText.length) : txt;
            if (normText(typed).includes(wantText) || (normText(txt).includes(wantText) && !normText(startText).includes(wantText))) {
              clearInterval(typePoll);
              this.ov({ type: 'teach-good' });
              setTimeout(() => finish({ action: 'typed', typed: typed.trim().slice(0, 200) }), 300);
            } else {
              if (txt !== lastText) { lastText = txt; changedAt = Date.now(); }
              const t = typed.trim();
              if (changedAt && t && Date.now() - changedAt > 1800 && hinted !== txt) {
                hinted = txt;
                const tail = t.slice(-(p.expect.text.length + 8));
                this.ov({ type: 'teach-miss', text: similarity(normText(tail), wantText) > 0.55 ? `Almost! You typed “${tail}”. It should be “${p.expect.text}”.` : `I don't see “${p.expect.text}” yet. Click the glowing spot, then type it.` });
              }
            }
          } catch {}
          busy = false;
        }, 350);
      }
      // The learner's own click on the spot counts as doing the step.
      if (hit && ['click', 'double_click', 'right_click', 'type', undefined].includes(p.action)) {
        const inside = (m) => m.x >= hit.x0 && m.x <= hit.x1 && m.y >= hit.y0 && m.y <= hit.y1;
        // the button this step is about: a right-click step watches the right button
        const pressed = p.action === 'right_click' ? (m) => m.right : (m) => m.down;
        let wasDown = false;
        let downInside = false;
        let busy = false;
        poll = setInterval(async () => {
          if (busy) return;
          busy = true;
          try {
            const raw = await this.input.mouseState();
            const m = { ...raw, down: pressed(raw) };
            if (m.down && !wasDown) downInside = inside(m);
            if (!m.down && wasDown && !downInside && !this.overCard && Date.now() - (this.lastMiss || 0) > 1200) {
              this.lastMiss = Date.now();
              const other = await this.uia?.at(m.x, m.y).catch(() => null);
              const what = other?.name ? `${other.type === 'DataItem' ? 'cell' : ''} "${String(other.name).trim().slice(0, 40)}"`.trim() : null;
              this.ov({ type: 'teach-miss', text: what ? `Not quite: that was ${what}. Try the glowing spot.` : 'Not quite. Try the glowing spot.' });
            }
            if (!m.down && wasDown && downInside && inside(m)) {
              this.ov({ type: 'teach-good' });
              // let a double-click finish before looking
              setTimeout(() => finish({ action: 'clicked' }), p.action === 'double_click' ? 450 : 150);
            }
            wasDown = m.down;
          } catch {}
          busy = false;
        }, 40);
      }
    });
  }

  // Did the step do what the lesson expected? Checked from control state (fast, no model),
  // retried briefly because apps take a moment to update. -> { ok, saw }
  async checkExpect(e, signal) {
    const deadline = Date.now() + 1200; // apps update within a few hundred ms; don't keep the learner waiting
    let last = { ok: false, saw: 'nothing checked' };
    for (;;) {
      last = await this.checkOnce(e).catch((err) => ({ ok: false, saw: String(err.message || err) }));
      if (last.ok || Date.now() > deadline || signal?.aborted) return last;
      await sleep(200);
    }
  }

  async checkOnce(e) {
    const g = this.geometry();
    const area = g.physW * g.physH;
    const name = String(e.name || '').trim();
    const popups = await this.openPopups();
    const control = async () => {
      // the highlighted control itself if that's the one meant, else find it by name in the app
      const el = this.teachEl;
      if (el?.rect && (!name || String(el.name).toLowerCase() === name.toLowerCase())) {
        const now = await this.uia.at((el.rect[0] + el.rect[2]) / 2, (el.rect[1] + el.rect[3]) / 2);
        if (now && (!name || String(now.name).toLowerCase() === name.toLowerCase())) return now;
      }
      if (!name) return null;
      if (popups.length) return (await this.uia.findIn(name, popups.map((w) => w.h), area))?.match || null;
      return (await this.uia.find({ name, screenArea: area }))?.match || null;
    };
    // "Can't tell" is not "failed": a menu item closes with its menu once chosen, and many
    // controls can't report selection. Those pass as unconfirmed instead of looping.
    const gone = () => (/^(MenuItem|ListItem|TreeItem|Hyperlink)$/.test(this.teachEl?.type || '') ? { ok: true, inconclusive: true, saw: `${this.teachEl.type} "${this.teachEl.name}" closed after it was chosen (can't confirm the result)` } : null);
    const unknown = (c, what) => ({ ok: true, inconclusive: true, saw: `${describeElement(c)} can't report whether it is ${what}` });
    switch (e.type) {
      case 'toggled_on':
      case 'toggled_off': {
        const c = await control();
        if (!c) return gone() || { ok: false, saw: `no control named "${name}" found` };
        if (!c.toggle && !c.selected) return unknown(c, 'switched on');
        const want = e.type === 'toggled_on' ? 'On' : 'Off';
        return { ok: c.toggle === want || (want === 'On' && c.selected === 'true'), saw: describeElement(c) };
      }
      case 'selected': {
        const c = await control();
        if (!c) return gone() || { ok: false, saw: `no control named "${name}" found` };
        if (!c.toggle && !c.selected) return unknown(c, 'selected');
        return { ok: c.selected === 'true' || c.toggle === 'On', saw: describeElement(c) };
      }
      case 'opened': {
        // A menu or dropdown opens as a new popup window: that is the surest sign.
        if (popups.length) return { ok: true, saw: `a menu opened (${popups.map((w) => w.cls).join(', ')})` };
        const c = await control();
        if (c && !c.expanded) return unknown(c, 'open');
        return { ok: !!c && (c.expanded === 'Expanded' || c.expanded === 'PartiallyExpanded'), saw: c ? describeElement(c) : `no control named "${name}" found` };
      }
      case 'appears': {
        let c = null;
        if (name && popups.length) c = (await this.uia.findIn(name, popups.map((w) => w.h), area))?.match || null;
        if (name && !c && !popups.length) c = (await this.uia.find({ name, screenArea: area }))?.match || null;
        if (!c && popups.length && !name) return { ok: true, saw: 'a popup opened' };
        return { ok: !!c, saw: c ? `${describeElement(c)} is on screen` : `nothing named "${name}" is on screen` };
      }
      case 'disappears': {
        const c = name ? (popups.length ? (await this.uia.findIn(name, popups.map((w) => w.h), area))?.match : (await this.uia.find({ name, screenArea: area }))?.match) : null;
        return { ok: !c, saw: c ? `${describeElement(c)} is still on screen` : 'it is gone' };
      }
      case 'focused': {
        const f = await this.uia.focused();
        const ok = !!f && (!name || String(f.name || '').toLowerCase().includes(name.toLowerCase()));
        return { ok, saw: f ? `keyboard focus is on ${describeFocus(f)}` : 'unknown focus' };
      }
      case 'text': {
        const want = normText(e.text || '');
        const caret = await this.uia.caret().catch(() => null);
        if (want && caret?.text && normText(caret.text).includes(want)) return { ok: true, saw: `the text now reads “${caret.text.trim().slice(0, 80)}”` };
        const f = await this.uia.focused();
        const el = this.teachEl?.rect ? await this.uia.at((this.teachEl.rect[0] + this.teachEl.rect[2]) / 2, (this.teachEl.rect[1] + this.teachEl.rect[3]) / 2) : null;
        const vals = [f?.value, f?.name, el?.value, el?.name].filter(Boolean).map((v) => normText(v));
        return { ok: !!want && vals.some((v) => v.includes(want)), saw: caret?.text ? `the text reads “${caret.text.trim().slice(0, 80)}”` : f ? `focused: ${describeFocus(f)}` : 'no text found' };
      }
      case 'window_title': {
        const w = await this.uia.appTitle();
        return { ok: !!w?.name && w.name.toLowerCase().includes(String(e.text || '').toLowerCase()), saw: `window title "${w?.name || '?'}"` };
      }
      case 'screen_changes': {
        if (!this.teachBefore) return { ok: true, saw: 'not measured' };
        const now = thumb(await this.frame(g));
        const d = changedFraction(this.teachBefore, now);
        return { ok: d > 0.002, saw: d > 0.002 ? 'the screen changed' : 'nothing on screen changed' };
      }
    }
    return { ok: true, saw: 'no check' };
  }

  // What was highlighted and how it looks now (Bold switched on, a menu open, ...).
  async teachReport() {
    const el = this.teachEl;
    if (!el?.rect || !this.uia) return null;
    const cx = (el.rect[0] + el.rect[2]) / 2;
    const cy = (el.rect[1] + el.rect[3]) / 2;
    const now = await this.uia.at(cx, cy).catch(() => null);
    return { highlighted: describeElement(el), now: describeElement(now) };
  }

  // A closer look at an area for the model, without the visible zoom flash.
  async zoomQuiet(region, g = this.geometry()) {
    let [x0, y0, x1, y1] = region;
    x0 = clamp(x0, 0, g.shotW - 8); y0 = clamp(y0, 0, g.shotH - 8); x1 = clamp(x1, x0 + 8, g.shotW); y1 = clamp(y1, y0 + 8, g.shotH);
    const a = this.toPhys([x0, y0], g);
    const b = this.toPhys([x1, y1], g);
    const full = await this.grab(g);
    const rect = { x: a.x - g.origin.x, y: a.y - g.origin.y, width: b.x - a.x, height: b.y - a.y };
    const k = Math.min(3, 900 / Math.max(rect.width, rect.height));
    const img = full.crop(rect).resize({ width: Math.round(rect.width * k), height: Math.round(rect.height * k), quality: 'best' });
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.toJPEG(88).toString('base64') } };
  }

  // Menus, dropdowns and flyouts open as their own top-level windows. Which of the app's
  // windows are new since the step's card appeared (or look like menus)? No UI walking.
  async openPopups() {
    const now = (await this.uia?.windows().catch(() => null)) || [];
    const before = this.teachWins || new Set();
    const g = this.geometry();
    // "New since the step began" only means something within the same app, and menus are
    // small: a whole window that appears (or a different app in front) is not a menu.
    const sameApp = now.length && this.teachWinsPid === now[0].pid;
    return now.filter((w) => w.area < g.physW * g.physH * 0.5 && ((sameApp && before.size && !before.has(w.h)) || POPUP_CLASS.test(w.cls)));
  }

  teachRespond(r) {
    if (typeof r?.action === 'string' && r.action.startsWith('rec-')) return this.recWaiter?.(r);
    if (r?.action && r.action !== 'again') this.ov({ type: 'teach-wait' });
    if (this.teachFocusBack && r?.action && r.action !== 'again') {
      const id = this.teachFocusBack;
      this.teachFocusBack = null;
      if (this.overlay && !this.overlay.isDestroyed()) this.overlay.setFocusable(false);
      this.input.focus(id).catch(() => {});
    }
    this.teachWaiter?.(r || {});
  }

  teachHide() {
    if (!this.teaching) return;
    this.teaching = false;
    this.ov({ type: 'teach-hide' });
    setTimeout(() => {
      if (!this.active && !this.teaching && !this.recording && this.overlay && !this.overlay.isDestroyed()) this.overlay.hide();
    }, 400);
  }

  overlayIgnore(ignore) {
    this.overCard = !ignore; // the pointer is over the coach card: clicks there aren't misses
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.setIgnoreMouseEvents(!!ignore, { forward: true });
  }

  // Typing a question into the coach card needs keyboard focus for a moment; the app
  // the learner was in gets it back afterwards (see teachRespond).
  async overlayFocus() {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    const fg = await this.input.foreground().catch(() => null);
    if (fg && fg.pid !== process.pid) this.teachFocusBack = fg.id;
    this.overlay.setFocusable(true);
    this.overlay.focus();
  }

  pause(text) {
    this.ov({ type: 'paused', text });
    // The task is stopping: never leave a mouse button held down.
    this.releaseButton().catch(() => {});
  }

  // ---------- "Show Island how" ----------
  // Watch the user do a task: a small Recording card (bottom right) lists the steps as they
  // happen, until they press Done or Cancel. -> { outcome: 'done' | 'cancel', steps }
  async record({ hotkey, signal }) {
    const g = this.geometry();
    await this.ensureOverlay(g);
    this.recording = true;
    if (!this.overlay.isVisible()) this.overlay.showInactive();
    this.ov({ type: 'rec-start' });
    const island = this.getIsland();
    // Clicks on Island itself or on the card aren't part of the task.
    const isIgnored = (x, y) => {
      if (this.overCard) return true;
      if (!island.isVisible()) return false;
      const b = screen.dipToScreenRect(island, island.getBounds());
      return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    };
    const rec = new Recorder({ input: this.input, uia: this.uia, isIgnored, hotkey, onChange: (steps) => this.ov({ type: 'rec-steps', steps: steps.slice(-4).map(describeStep), count: steps.length }) });
    rec.start();
    const outcome = await new Promise((resolve) => {
      const onAbort = () => resolve('cancel');
      if (signal?.aborted) return resolve('cancel');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.recWaiter = (r) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(r.action === 'rec-done' ? 'done' : 'cancel');
      };
    });
    this.recWaiter = null;
    const steps = await rec.stop();
    this.recording = false;
    this.ov({ type: 'rec-stop' });
    if (this.overCard) this.overlayIgnore(true);
    setTimeout(() => {
      if (!this.active && !this.teaching && !this.recording && this.overlay && !this.overlay.isDestroyed()) this.overlay.hide();
    }, 400);
    return { outcome, steps };
  }

  // Where to scroll when no point was given: keep the pointer if it is already over the
  // content of the window in front, else the middle of that window (physical px, or null).
  async scrollSpot(g) {
    const [cur, fg] = await Promise.all([this.input.pos().catch(() => null), this.input.foreground().catch(() => null)]);
    const d = { x0: g.origin.x, y0: g.origin.y, x1: g.origin.x + g.physW, y1: g.origin.y + g.physH };
    let r = fg && fg.pid !== process.pid && !fg.minimized && fg.rect ? fg.rect : null;
    if (r) r = [Math.max(r[0], d.x0), Math.max(r[1], d.y0), Math.min(r[2], d.x1), Math.min(r[3], d.y1)];
    if (!r || r[2] - r[0] < 80 || r[3] - r[1] < 80) r = [d.x0, d.y0, d.x1, d.y1];
    const top = r[1] + Math.min(170 * g.sf, (r[3] - r[1]) * 0.25); // below title bar, tabs and address bar
    if (cur && cur.x > r[0] + 10 && cur.x < r[2] - 24 && cur.y > top && cur.y < r[3] - 10) return null;
    return { x: Math.round((r[0] + r[2]) / 2), y: Math.round(top + (r[3] - top) / 2) };
  }

  // Wheel turns at a physical point (routine replays).
  async scrollAt(p, dir, n, signal) {
    if (signal?.aborted) throw new StoppedError('Stopped by the user.');
    await this.checkTakeover();
    const g = this.geometry();
    if (p) await this.moveTo(p, g, 'Scrolling');
    this.ov({ type: 'scroll', dir });
    await this.input.wheel(dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? n : dir === 'down' ? -n : 0);
  }

  toShot(x, y, g) {
    return [Math.round((x - g.origin.x) * g.scale), Math.round((y - g.origin.y) * g.scale)];
  }

  // Words on screen with their boxes (screenshot space), read by Windows' text recognition.
  // The picture is enlarged first: small print reads much better that way. rect (physical
  // px): read only that part of the screen (e.g. the window in front).
  async ocrScreen(g = this.geometry(), rect = null) {
    let img = await this.grab(g);
    let off = { x: 0, y: 0 };
    if (rect) {
      const x0 = clamp(rect[0] - g.origin.x, 0, g.physW - 8), y0 = clamp(rect[1] - g.origin.y, 0, g.physH - 8);
      const x1 = clamp(rect[2] - g.origin.x, x0 + 8, g.physW), y1 = clamp(rect[3] - g.origin.y, y0 + 8, g.physH);
      img = img.crop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      off = { x: x0, y: y0 };
    }
    const { width, height } = img.getSize();
    const k = width < 2200 ? 2 : 1;
    const big = k > 1 ? img.resize({ width: width * k, height: height * k, quality: 'best' }) : img;
    const r = await ocr.recognize(big.toPNG());
    const map = (b) => b && [Math.round((b[0] / k + off.x) * g.scale), Math.round((b[1] / k + off.y) * g.scale), Math.round((b[2] / k + off.x) * g.scale), Math.round((b[3] / k + off.y) * g.scale)];
    return r.lines.map((l) => ({ text: l.text, box: map(l.box), words: l.words.map((w) => ({ text: w.text, box: map(w.box) })) }));
  }

  // A window by app name ("chrome", "Word") or part of its title -> { id, app, title, rect } | null
  async resolveWindow(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return null;
    const alias = { word: 'winword', powerpoint: 'powerpnt', edge: 'msedge', 'file explorer': 'explorer', outlook: 'olk' }[s] || s;
    const wins = ((await this.input.windows().catch(() => [])) || []).filter((w) => w.pid !== process.pid);
    return wins.find((w) => w.app.toLowerCase() === alias) || wins.find((w) => w.app.toLowerCase().startsWith(alias)) || wins.find((w) => w.title.toLowerCase().includes(s)) || (alias === 'outlook' ? wins.find((w) => w.app.toLowerCase() === 'outlook') : null) || null;
  }

  // Where a word or phrase is: first from the app itself (UI Automation; finds it further
  // down a page too and scrolls it into view), else read off the screen. Coordinates are in
  // screenshot space. window: which app/window to look in (brought to the front first).
  // -> { matches: [{ text, type, center, box, onScreen, how }], scrolled }
  async findOnScreen(text, { scroll = true, window: winQ = '' } = {}) {
    let hwnd = 0;
    if (winQ) {
      const w = await this.resolveWindow(winQ);
      if (!w) throw new Error(`No open window matches "${winQ}". Use list_windows to see what is open.`);
      await this.input.focus(w.id).catch(() => false);
      await sleep(250);
      hwnd = w.id;
    }
    const g = this.geometry();
    const area = g.physW * g.physH;
    const matches = [];
    let scrolled = false;
    const r = this.uia ? await this.uia.findText(text, area, scroll, hwnd).catch(() => null) : null;
    if (r) {
      scrolled = !!r.scrolled;
      for (const m of r.matches || []) {
        if (!m.rect) continue;
        const [x0, y0] = this.toShot(m.rect[0], m.rect[1], g);
        const [x1, y1] = this.toShot(m.rect[2], m.rect[3], g);
        const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
        const onScreen = !m.off && cx >= 0 && cy >= 0 && cx <= g.shotW && cy <= g.shotH;
        matches.push({ text: m.name, type: m.bar ? `${m.type} on the taskbar` : m.type, center: [cx, cy], box: [x0, y0, x1, y1], onScreen, how: m.bar ? 'taskbar' : 'app' });
      }
    }
    if (!matches.some((m) => m.onScreen)) {
      // Pictures, canvases and apps that don't share their text: read the screen.
      if (scrolled) await sleep(250);
      const lines = await this.ocrScreen(g).catch(() => []);
      for (const h of ocr.findPhrase(lines, text).slice(0, 6)) {
        matches.unshift({ text: h.text, type: 'text on screen', center: [Math.round((h.box[0] + h.box[2]) / 2), Math.round((h.box[1] + h.box[3]) / 2)], box: h.box, onScreen: true, how: 'read' });
      }
    }
    return { matches: matches.slice(0, 8), scrolled };
  }

  // The text of the window in front: the whole page or document when the app shares it,
  // otherwise (or with visibleOnly) what can be read off the screen.
  async screenText({ visibleOnly = false, window: winQ = '' } = {}) {
    let title = '';
    let target = null;
    if (winQ) {
      target = await this.resolveWindow(winQ);
      if (!target) throw new Error(`No open window matches "${winQ}". Use list_windows to see what is open.`);
    }
    if (!visibleOnly && this.uia) {
      const t = await this.uia.pageText(24000, target?.id || 0).catch(() => null);
      title = t?.title || target?.title || '';
      if (t?.text && t.text.trim().length >= 80) return { title, source: t.source === 'document' ? 'the document' : 'the window', text: t.text };
    }
    // Reading off the screen needs the window in view.
    if (target) { await this.input.focus(target.id).catch(() => false); await sleep(300); }
    const fg = await this.input.foreground().catch(() => null);
    const rect = fg && fg.pid !== process.pid && !fg.minimized && fg.rect && fg.rect[2] - fg.rect[0] > 80 ? fg.rect : null;
    const lines = await this.ocrScreen(this.geometry(), rect).catch((e) => { throw new Error(`Couldn't read the screen: ${e.message}`); });
    return { title: title || fg?.title || '', source: `text recognition of what is visible${rect ? ' in that window' : ' on screen'}`, text: lines.map((l) => l.text).join('\n') };
  }

  // A click at a physical point, with the visible cursor (routine replays).
  async clickAt(p, btn = 'left', count = 1, signal) {
    if (signal?.aborted) throw new StoppedError('Stopped by the user.');
    await this.checkTakeover();
    const g = this.geometry();
    await this.moveTo(p, g, count === 2 ? 'Double-clicking' : btn === 'right' ? 'Right-clicking' : 'Clicking');
    this.ov({ type: 'click', button: btn, count });
    await this.input.click(btn, count);
  }

  async dragBetween(a, b, signal) {
    if (signal?.aborted) throw new StoppedError('Stopped by the user.');
    await this.checkTakeover();
    const g = this.geometry();
    await this.moveTo(a, g, 'Dragging');
    await this.input.down('left');
    this.ov({ type: 'mousedown' });
    this.ov({ type: 'drag-start', ...this.toOverlay(a, g) });
    this.ov({ type: 'drag-move', ...this.toOverlay(b, g) });
    try {
      await this.moveTo(b, g, 'Dragging', true);
    } finally {
      await this.input.up('left');
      this.ov({ type: 'drag-end' });
    }
  }

  // Which window keystrokes will land in; reported with every screenshot.
  async focusLine() {
    try {
      const [f, ctl, sc] = await Promise.all([this.input.foreground(), this.uia ? this.uia.focused().catch(() => null) : null, this.uia ? this.uia.scrollInfo().catch(() => null) : null]);
      if (!f) return 'Focused window: none';
      if (f.pid === process.pid) return 'Focused window: Island (this assistant)';
      const k = describeFocus(ctl);
      return `Focused window: ${f.app} "${f.title}"${k ? `\nKeyboard focus: ${k}` : ''}${pageLine(sc)}`;
    } catch {
      return null;
    }
  }

  // Screenshot + focus line, as tool_result content blocks.
  async observe() {
    try {
      return this.toObservation(await this.frame());
    } catch (e) {
      if (e instanceof BlankCaptureError) return this.blankObservation();
      throw e;
    }
  }

  async toObservation(img) {
    if (!img || img.isEmpty()) return this.blankObservation();
    // What the model is now looking at: clicks are checked against it (see movedSinceShot).
    this.lastShot = { img, at: Date.now(), w: img.getSize().width };
    this.changedSinceShot = false;
    if (this.active || this.teaching) img = await this.markPointer(img).catch(() => img);
    const data = img.toJPEG(85).toString('base64');
    if (!data) return this.blankObservation();
    const line = await this.focusLine();
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
      ...(line ? [{ type: 'text', text: line }] : []),
    ];
  }

  async guardKeyboardTarget() {
    let f = await this.input.foreground().catch(() => null);
    if (f && f.pid === process.pid && this.restoreFocus) {
      // Usually the user just typed to Island: hand focus back to the app they were in.
      await this.restoreFocus();
      await sleep(250);
      f = await this.input.foreground().catch(() => null);
    }
    if (f && f.pid === process.pid) {
      throw new Error('Keyboard focus is on Island itself, so this would type into Island. Bring the target window forward with focus_window (or click inside it) first.');
    }
  }

  // ---------- actions ----------

  async checkTakeover() {
    if (!this.expected) return;
    const p = await this.input.pos();
    if (Math.hypot(p.x - this.expected.x, p.y - this.expected.y) > TAKEOVER_PX) {
      this.expected = null;
      throw new TakeoverError('Stopped: the user moved the mouse to take over.');
    }
  }

  async moveTo(p, g, label, slow = false) {
    const cur = await this.input.pos();
    const dist = Math.hypot(p.x - cur.x, p.y - cur.y) / g.sf;
    const [base, perPx, max] = this.speed.move;
    const ms = dist < 2 ? 0 : clamp(Math.round(base + dist * perPx), base, slow ? max * 1.4 : max) * (slow ? 1.4 : 1);
    this.ov({ type: 'move', ...this.toOverlay(p, g), ms, label });
    if (ms) await this.input.move(p.x, p.y, ms);
    this.expected = p;
    return ms;
  }

  async withModifiers(text, fn) {
    if (!text) return fn();
    const { tokens } = parseCombo(text);
    await this.input.keys('down', tokens);
    try {
      return await fn();
    } finally {
      await this.input.keys('up', tokens);
    }
  }

  async sleepAbortable(ms, signal) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (signal?.aborted) throw new StoppedError('Stopped by the user.');
      await sleep(Math.min(100, end - Date.now()));
    }
  }

  // Put long text in through the clipboard (Ctrl+V), then restore what was there.
  async paste(text) {
    let snap = null;
    try {
      snap = await clip.snapshot();
    } catch {
      return false;
    }
    try {
      await clip.writeText(text);
      this.ov({ type: 'type', text, msPerChar: 1 });
      await this.input.keys('tap', parseCombo('ctrl+v').tokens);
      await sleep(180); // let the app read the clipboard before it changes back
      this.ov({ type: 'type-done' });
      return true;
    } catch {
      return false;
    } finally {
      clip.restore(snap).catch(() => {});
    }
  }

  // Pages scroll, load and shift on their own. Has the spot about to be clicked changed since
  // the screenshot the model chose it from? -> the current frame if so, else null.
  async movedSinceShot(c, g) {
    const s = this.lastShot;
    if (!s || this.changedSinceShot || Date.now() - s.at > 120000 || s.w !== g.shotW) return null;
    const [x, y] = numbers(c);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // A screen that never stops moving (a game, a video): stop checking it. Otherwise the
    // same spot is refused over and over and the task can never get going.
    if (this.movingUntil && Date.now() < this.movingUntil) return null;
    // One free retry at a spot that was refused: the model is aiming at the same thing.
    const key = `${Math.round(x)},${Math.round(y)}`;
    const st = this.staleAt.get(key);
    if (st && Date.now() - st.t < 10000) return null;
    const now = await this.frame(g).catch(() => null);
    if (!now) return null;
    const box = { x: clamp(Math.round(x - 60), 0, g.shotW - 120), y: clamp(Math.round(y - 30), 0, g.shotH - 60), width: 120, height: 60 };
    if (changedFraction(s.img.crop(box).toBitmap(), now.crop(box).toBitmap()) < 0.06) return null; // text covers only part of the patch
    const rec = st || { count: 0, t: 0 };
    rec.count++;
    rec.t = Date.now();
    this.staleAt.set(key, rec);
    // Refused again and again: the screen is simply always moving. Let the clicks through.
    if (rec.count >= 3) this.movingUntil = Date.now() + 60000;
    return now;
  }

  // Returns tool_result content: a string or an array of content blocks.
  async run(name, input = {}, signal) {
    if (signal?.aborted) throw new StoppedError('Stopped by the user.');
    const g = this.geometry();
    if (name === 'type' || name === 'key' || name === 'hold_key') await this.guardKeyboardTarget();
    this.steps++;
    if (this.active && !this.replaying) this.ov({ type: 'step', text: `Step ${this.steps} · ${describe(name, input)}` });

    const image = (shot) => [{ type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.base64 } }];
    const clickLike = { left_click: ['left', 1, 'Clicking'], right_click: ['right', 1, 'Right-clicking'], middle_click: ['middle', 1, 'Clicking'], double_click: ['left', 2, 'Double-clicking'], triple_click: ['left', 3, 'Triple-clicking'] };

    if (clickLike[name]) {
      const [btn, count, label] = clickLike[name];
      let snapped = '';
      if (input.coordinate && this.active) {
        const now = await this.movedSinceShot(input.coordinate, g);
        if (now) throw new StaleClickError('Not clicked: the page moved or changed since your last screenshot (it scrolled, loaded more, or a popup appeared), so that spot now shows something else. Here is the screen as it is now: find your target again and click its new position.', await this.toObservation(now));
      }
      this.changedSinceShot = true;
      if (input.coordinate) {
        let p = this.toPhys(input.coordinate, g);
        const s = this.uia ? await this.uia.snap(p.x, p.y, Math.round(12 * g.sf), g.physW * g.physH).catch(() => null) : null;
        if (s?.moved) {
          p = { x: s.x, y: s.y };
          snapped = ` (your point was ${Math.round(s.dist * g.scale)}px beside ${s.label}, so the click went onto it)`;
        }
        await this.moveTo(p, g, label);
      }
      else this.ov({ type: 'act', text: label });
      await this.withModifiers(input.text, async () => {
        this.ov({ type: 'click', button: btn, count });
        await this.input.click(btn, count);
      });
      return 'OK' + snapped;
    }

    if (!READ_ONLY.has(name)) this.changedSinceShot = true;
    switch (name) {
      case 'screenshot':
        return this.observe();

      case 'zoom': {
        const z = await this.zoom(input.region, g);
        return [...image(z), ...(z.text?.trim() ? [{ type: 'text', text: `Text in this area, read by Windows (exact for normal-size print; tiny or stylised text may come out garbled, so trust what you see there):\n${z.text}` }] : [])];
      }

      case 'cursor_position': {
        const p = await this.input.pos();
        return `X=${Math.round((p.x - g.origin.x) * g.scale)}, Y=${Math.round((p.y - g.origin.y) * g.scale)}`;
      }

      case 'mouse_move':
        await this.moveTo(this.toPhys(input.coordinate, g), g, 'Moving');
        return 'OK';

      case 'left_mouse_down': {
        // Press and keep the button down. A coordinate is honoured (put the pointer
        // there first), so a hold can be aimed at a spot in one action.
        if (input.coordinate) {
          const p = this.toPhys(input.coordinate, g);
          await this.moveTo(p, g, 'Pressing and holding');
        }
        this.ov({ type: 'mousedown' });
        await this.input.down('left');
        this.heldButton = 'left';
        return 'OK (the button is held down; send left_mouse_up to let go)';
      }

      case 'left_mouse_up':
        this.ov({ type: 'click', button: 'left', count: 1 });
        this.heldButton = null;
        await this.input.up('left');
        return 'OK';

      case 'hold_click': {
        // Press a button and keep it down for a while, then let go.
        const btn = input.button === 'right' ? 'right' : input.button === 'middle' ? 'middle' : 'left';
        const seconds = clamp(Number(input.duration) || 1, 0, 300);
        if (input.coordinate) {
          const p = this.toPhys(input.coordinate, g);
          await this.moveTo(p, g, 'Holding');
        }
        this.ov({ type: 'mousedown' });
        await this.input.down(btn);
        this.heldButton = btn;
        try {
          await this.sleepAbortable(seconds * 1000, signal);
        } finally {
          this.heldButton = null;
          await this.input.up(btn);
          this.ov({ type: 'click', button: btn, count: 1 });
        }
        return `Held the ${btn} button down for ${seconds}s.`;
      }

      case 'left_click_drag': {
        const a = this.toPhys(input.start_coordinate, g);
        const b = this.toPhys(input.coordinate, g);
        await this.moveTo(a, g, 'Dragging');
        await this.withModifiers(input.text, async () => {
          await this.input.down('left');
          this.heldButton = 'left';
          this.ov({ type: 'mousedown' });
          this.ov({ type: 'drag-start', ...this.toOverlay(a, g) });
          this.ov({ type: 'drag-move', ...this.toOverlay(b, g) });
          try {
            await this.moveTo(b, g, 'Dragging', true);
          } finally {
            this.heldButton = null;
            await this.input.up('left');
            this.ov({ type: 'drag-end' });
          }
        });
        return 'OK';
      }

      case 'scroll': {
        const dir = input.scroll_direction;
        if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error('scroll_direction must be up, down, left or right');
        const n = clamp(Math.round(input.scroll_amount || 3), 1, 30);
        // The wheel scrolls whatever is under the pointer: with no point given, use the middle
        // of the window in front rather than wherever the pointer was (often a toolbar).
        const at = input.coordinate ? this.toPhys(input.coordinate, g) : await this.scrollSpot(g);
        if (at) await this.moveTo(at, g, 'Scrolling');
        const look = (img) => img.resize({ width: 480, quality: 'good' }).toBitmap(); // fine enough to see a thin scrollbar move
        const before = await this.frame(g).then(look).catch(() => null);
        await this.withModifiers(input.text, async () => {
          this.ov({ type: 'scroll', dir });
          await this.input.wheel(dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? n : dir === 'down' ? -n : 0);
        });
        await sleep(260);
        const after = before ? await this.frame(g).then(look).catch(() => null) : null;
        if (before && after && changedFraction(before, after) < 0.0006) {
          const end = { down: 'bottom', up: 'top', left: 'left edge', right: 'right edge' }[dir];
          return `The screen looks the same after scrolling: either the pointer is not over a part that scrolls, or it is already at the ${end}. Scroll with a coordinate in the middle of the page or list, press Page Down / End, or use find_on_screen to jump straight to the words you want.`;
        }
        return 'OK';
      }

      case 'type': {
        const text = String(input.text ?? '');
        if (!text) throw new Error('text is required');
        const [budget, lo, hi] = this.speed.type;
        if (text.length >= this.speed.paste && (await this.paste(text))) return 'OK (pasted)';
        const msPerChar = clamp(Math.round(budget / text.length), lo, hi);
        this.ov({ type: 'type', text, msPerChar });
        await this.input.type(text, msPerChar);
        this.ov({ type: 'type-done' });
        return 'OK';
      }

      case 'key': {
        const { tokens, pretty } = parseCombo(input.text);
        const repeat = clamp(Math.round(input.repeat || 1), 1, 100);
        this.ov({ type: 'keys', pretty: repeat > 1 ? [...pretty, `×${repeat}`] : pretty });
        // The repeats are done here rather than inside the helper, so the user can
        // still stop the task half way through.
        for (let i = 0; i < repeat; i++) {
          if (signal?.aborted) throw new StoppedError('Stopped by the user.');
          await this.input.keys('tap', tokens, 1);
          if (i < repeat - 1) await sleep(40);
        }
        return 'OK';
      }

      case 'hold_key': {
        const { tokens, pretty } = parseCombo(input.text);
        const wanted = Number(input.duration);
        const seconds = clamp(Number.isFinite(wanted) && wanted > 0 ? wanted : 1, 0, 300);
        this.ov({ type: 'keys', pretty });
        await this.input.keys('down', tokens);
        try {
          await this.sleepAbortable(seconds * 1000, signal);
        } finally {
          await this.input.keys('up', tokens);
        }
        return `Held ${pretty.join('+')} down for ${seconds}s.`;
      }

      case 'wait': {
        const s = clamp(Number(input.duration) || 1, 0, 300);
        this.ov({ type: 'act', text: `Waiting ${s}s` });
        await this.sleepAbortable(s * 1000, signal);
        return [{ type: 'text', text: `Waited ${s}s.` }, ...(await this.observeSettled('mouse_move', signal))];
      }
    }
    throw new Error(`Unsupported computer action: ${name}`);
  }
}

// The same actions, offered as an ordinary function to non-Claude models
// (Chat Completions has no built-in computer tool). Executed by Computer.run.
const CHAT_ACTIONS = ['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'hold_click', 'scroll', 'type', 'key', 'hold_key', 'wait', 'zoom', 'cursor_position'];

function chatToolDef(width, height) {
  const point = { type: 'array', items: { type: 'number' }, description: '[x, y] in screenshot pixels' };
  return {
    name: 'computer_action',
    description:
      `Use the user's Windows desktop. The screen is ${width}x${height} pixels (origin top-left); coordinates are pixels in the most recent screenshot. ` +
      'Actions: screenshot; left_click / right_click / middle_click / double_click / triple_click (coordinate; optional text = modifier keys like "ctrl" or "shift"); ' +
      'mouse_move (coordinate); left_click_drag (start_coordinate, coordinate); left_mouse_down / left_mouse_up (coordinate optional: the pointer is moved there first); hold_click (coordinate, duration in seconds, optional button) presses a mouse button and keeps it down for that long; scroll (scroll_direction, scroll_amount, coordinate = a point in the middle of the page or list to scroll; without it Island uses the middle of the window in front); ' +
      'type (text); key (text such as "ctrl+s", "Return", "alt+Tab"; optional repeat); hold_key (text, duration); wait (duration in seconds); ' +
      'zoom (region [x0, y0, x1, y1] to read small text); cursor_position. Start with a screenshot. After each batch of actions you get a fresh screenshot plus the focused window. ' +
      'To do several predictable steps in one call, pass actions: [{ action, ...params }, ...] instead of a single action (e.g. click a search box, type, press Return).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: CHAT_ACTIONS },
        coordinate: point,
        start_coordinate: point,
        text: { type: 'string', description: 'Text to type, key combination, or modifier keys to hold' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer', description: 'Wheel clicks' },
        duration: { type: 'number', description: 'Seconds' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Which mouse button to hold (default left)' },
        region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] in screenshot pixels' },
        repeat: { type: 'integer' },
        actions: { type: 'array', description: 'Several actions to run in order, each an object with its own "action" and parameters', items: { type: 'object' } },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

// computer_action({ action, ...params }) -> the action name and its params; with
// { actions: [...] } also a batch of the same.
function fromChatCall(input) {
  const { action, actions, ...rest } = input || {};
  if (Array.isArray(actions) && actions.length) {
    const batch = actions.slice(0, 20).map((a) => fromChatCall(a && typeof a === 'object' ? { ...a, actions: undefined } : {}));
    return { action: null, params: {}, batch };
  }
  const params = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, ['coordinate', 'start_coordinate', 'region'].includes(k) ? numbers(v) : v]));
  return { action: CHAT_ACTIONS.includes(action) ? action : null, params };
}

const thumb = (img) => img.resize({ width: 160, quality: 'good' }).toBitmap();

// "Page: you see 0-30% of it, more below": screenshots only show the visible part, and
// results under a big search form are easy to miss.
function pageLine(sc) {
  if (!sc || !(sc.pct >= 0) || !(sc.view > 0) || sc.view >= 98) return '';
  const view = Math.min(100, sc.view);
  const top = Math.round((sc.pct / 100) * (100 - view));
  const bottom = Math.min(100, Math.round(top + view));
  const more = bottom >= 99 ? 'This is the bottom of the page.' : top <= 1 ? 'There is more below: scroll down (or use find_on_screen / read_screen_text) before deciding something isn\'t there.' : 'There is more above and below.';
  return `\nPage: you see about ${top}-${bottom}% of it. ${more}`;
}

// "275, 206" or "[275,206]" -> [275, 206] (some models send coordinates as text)
function numbers(v) {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'string') {
    const nums = v.match(/-?\d+(\.\d+)?/g);
    if (nums) return nums.map(Number);
  }
  return v;
}

// Window classes of menus, dropdowns and flyouts (classic, Office, XAML, Chromium).
// (Only true menu classes count when they were already there; any window that is new since
// the step began counts too, which covers browsers' popups.)
const POPUP_CLASS = /^(#32768|Xaml_WindowedPopupClass|Net UI Tool Window( Layered)?|ComboLBox|DropDown)$/;

// Text compared the way a person would: case, curly quotes and spacing don't matter.
function normText(t) {
  return String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

// 0..1, how alike two short strings are (edit distance), for "almost" typing hints.
function similarity(a, b) {
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// Share of pixels that differ noticeably between two same-size BGRA bitmaps.
function changedFraction(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 48) changed++;
  }
  return changed / n;
}

module.exports = { Computer, TakeoverError, StoppedError, StaleClickError, describe, READ_ONLY, chatToolDef, fromChatCall };
