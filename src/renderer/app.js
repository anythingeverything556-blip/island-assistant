/* global ICONS, TOOL_ICONS, marked, DOMPurify */
const $ = (id) => document.getElementById(id);
const island = $('island');
const panelInner = $('panelInner');
const input = $('input');
const thread = $('thread');
const body = $('body');
const api = window.islandApi;

marked.setOptions({ gfm: true, breaks: false });

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Plain words for how hard the model thinks.
const EFFORT_LABEL = { low: 'Quick', medium: 'Balanced', high: 'Thorough', xhigh: 'Very thorough', max: 'Maximum' };

const S = {
  expanded: false,
  busy: false,
  state: 'idle',
  attachments: [],
  attachScreen: false,
  settings: {},
  timers: [],
  stats: { cpu: 0, mem: 0 },
  view: 'chat',
  live: null, // { el, blocks: Map }
  activity: '', // short live text for the pill
  readySnippet: '',
  flash: null,
  promptHistory: (() => {
    try { return JSON.parse(localStorage.getItem('island.prompts')) || []; } catch { return []; }
  })(),
  promptIdx: -1,
  pickerOpen: false,
  approvalsPending: 0,
  expandedAt: 0,
};

// Island can talk once it knows where to talk: a key, or a server that needs none
// (Ollama, LM Studio on this PC).
const aiReady = () => !!(S.settings.hasApiKey || S.settings.hasServer);

// ---------------------------------------------------------------- icons on static buttons
$('screenBtn').innerHTML = ICONS.screen;
$('attachBtn').innerHTML = ICONS.attach;
$('sendBtn').innerHTML = ICONS.send;
$('sendBtn').dataset.icon = 'send';
$('newBtn').innerHTML = ICONS.plus;
$('settingsBtn').innerHTML = ICONS.gear;

// Full screen: the panel fills the screen (F11 or the footer button); again to go back.
function renderFullBtn(on) {
  const b = $('fullBtn');
  b.innerHTML = on ? ICONS.minimize : ICONS.maximize;
  b.title = on ? 'Back to the small window (F11)' : 'Full screen (F11)';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
}
renderFullBtn(false);
$('fullBtn').onclick = () => api.toggleFull();
api.onFull((on) => {
  // Snap to the new size instead of animating inside a window that has already changed.
  island.classList.add('reframing');
  island.classList.toggle('full', on);
  renderFullBtn(on);
  requestAnimationFrame(() => requestAnimationFrame(() => island.classList.remove('reframing')));
});

// ---------------------------------------------------------------- expand / collapse

// Panel size: width always comes from main; height is either fixed (the user resized
// it) or auto-fit to content up to the space available below the island.
let maxPanelH = 692;
let fixedPanelH = null;
let lastSize = 0;
function fitHeight() {
  if (!S.expanded) return;
  if (fixedPanelH) {
    panelInner.style.height = fixedPanelH + 'px';
    island.style.height = fixedPanelH + 'px';
    return;
  }
  panelInner.style.height = '';
  const h = Math.min(panelInner.offsetHeight, maxPanelH);
  island.style.height = h + 'px';
  if (h !== lastSize) {
    lastSize = h;
    api.setSize(h);
  }
}
new ResizeObserver(fitHeight).observe(panelInner);

function setPanelWidth(w) {
  island.style.setProperty('--pw', w + 'px');
}

api.onSpace(({ maxHeight, width, fixedHeight }) => {
  maxPanelH = maxHeight;
  fixedPanelH = fixedHeight;
  setPanelWidth(width);
  panelInner.style.maxHeight = (fixedHeight || maxHeight) + 'px';
  lastSize = 0;
  requestAnimationFrame(fitHeight);
});

// Live updates while the user drags a resize handle.
api.onPanelSize(({ w, h }) => {
  fixedPanelH = h;
  setPanelWidth(w);
  panelInner.style.maxHeight = h + 'px';
  fitHeight();
});

document.querySelectorAll('.rz').forEach((handle) => {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !S.expanded) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    island.classList.add('resizing');
    api.resizeStart(handle.dataset.edge);
  });
  const end = () => {
    if (!island.classList.contains('resizing')) return;
    island.classList.remove('resizing');
    api.resizeEnd();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    api.resetSize();
    toast('Size reset');
  });
});

function applyExpand(opts = {}) {
  const wasExpanded = S.expanded;
  S.expanded = true;
  S.expandedAt = Date.now();
  island.classList.remove('collapsed', 'peek', 'closing');
  island.classList.add('expanded');
  // Compact = the island opened only to ask something; the full panel stays out of the way.
  setCompact(!!opts.compact && !wasExpanded);
  if (!wasExpanded && !opts.compact) {
    island.classList.add('opening');
    island.classList.remove('settled');
    clearTimeout(applyExpand.t);
    applyExpand.t = setTimeout(() => island.classList.remove('opening'), 800);
    clearTimeout(applyExpand.s);
    applyExpand.s = setTimeout(() => S.expanded && island.classList.add('settled'), 700);
  } else if (!wasExpanded) {
    clearTimeout(applyExpand.s);
    applyExpand.s = setTimeout(() => S.expanded && island.classList.add('settled'), 700);
  }
  lastSize = 0;
  fitHeight();
  if (!wasExpanded) window.ORBS?.composer.wake();
  if (S.state === 'ready' || S.state === 'error') setState('idle');
  if (opts.reset) newChat(false);
  if (opts.view === 'settings' || !aiReady()) showSettings(aiReady() ? undefined : 'ai');
  if (opts.selection) useSelection(opts.selection);
  if (!opts.compact) setTimeout(() => input.focus(), 60);
  renderEmpty();
}

function setCompact(on) {
  island.classList.toggle('compact', on);
  lastSize = 0;
  requestAnimationFrame(fitHeight);
}

// ---------------------------------------------------------------- ask about the selection

const QUICK_ACTIONS = [
  ['Explain', 'Explain this simply.'],
  ['Summarize', 'Summarize this in a few bullet points.'],
  ['Translate', 'Translate this into English (or into Hindi if it is already English).'],
  ['Improve', 'Rewrite this to be clearer and better written. Give only the improved text in a code block so I can copy it.'],
  ['Reply', 'Draft a short, friendly reply to this. Give only the reply in a code block so I can copy it.'],
  ['Fix code', 'Find bugs in this code and give the corrected version.'],
];

function useSelection(sel) {
  S.attachments = S.attachments.filter((a) => !a.fromSelection);
  const where = sel.app || 'another app';
  if (sel.text && sel.text.trim()) {
    S.attachments.push({ kind: 'text', fromSelection: true, name: `Selected text from ${where}`, text: sel.text + (sel.truncated ? '\n…[selection truncated]' : '') });
    const box = $('quick');
    box.innerHTML = QUICK_ACTIONS.map(([label], i) => `<button class="qa" data-i="${i}">${label}</button>`).join('');
    box.querySelectorAll('.qa').forEach((b) => (b.onclick = () => {
      input.value = QUICK_ACTIONS[+b.dataset.i][1];
      submit();
    }));
    box.hidden = false;
    input.placeholder = 'Ask about the selected text…';
  } else {
    if (sel.app) S.attachments.push({ kind: 'text', fromSelection: true, name: `Window: ${(sel.title || where).slice(0, 60)}`, text: `The user was in ${sel.app}: "${sel.title || ''}" (nothing was selected).` });
    toast('Nothing was selected; ask about the window instead');
  }
  showChat();
  renderChips();
  updateSendBtn();
}

function clearQuick() {
  $('quick').hidden = true;
  $('quick').innerHTML = '';
}

function collapse() {
  if (!S.expanded) return;
  S.expanded = false;
  closeSlash();
  closePicker();
  island.classList.add('closing', 'collapsed');
  island.classList.remove('expanded', 'settled');
  island.style.height = '';
  setTimeout(() => {
    island.classList.remove('closing');
    api.collapsed();
  }, 240);
  updatePill();
}

api.onExpand((opts) => {
  applyExpand(opts);
  flushNotice();
});

// Readiness is only checked when the user asks (Settings > General). No warning banner:
// a problem shows, with its exact reason, when a message is actually sent.
function renderHealth(h) {
  if (h) S.health = h;
  $('healthBanner').hidden = true;
}
api.onHealth(renderHealth);
// One-off messages from Island itself (e.g. "your shortcut was taken, now it's X").
function flushNotice() {
  if (!S.pendingNotice || !S.expanded) return;
  const text = S.pendingNotice;
  S.pendingNotice = null;
  showChat();
  addNote(text, false);
}
api.onStopped(() => {
  // The stop key or the Stop button was used: say so straight away.
  toast('Stopped');
});

api.onNotice(({ text } = {}) => {
  if (!text || S.noticeSeen === text) return;
  S.noticeSeen = text;
  S.pendingNotice = text;
  flushNotice();
});
// A newer Island is out (from GitHub Releases): a note with a download button, once.
api.onUpdate(({ version, url }) => {
  const el = addNote(`Island ${version} is available. You have ${S.settings.appVersion || 'an older version'}.`, false);
  if (!el) return;
  const row = document.createElement('div');
  row.className = 'note-acts';
  row.innerHTML = `<button class="btn mint">${ICONS.download}<span>Download Island ${escapeHtml(version)}</span></button>`;
  row.querySelector('button').onclick = () => api.openExternal(url);
  el.appendChild(row);
});
api.onCollapse(collapse);
// Clicked out of Island (or switched to another app): fold, unless a question is
// waiting. This also covers the panel being shown without focus — the window's own
// blur event never fires then, so the tracker's "another app is in front" joins in.
const foldOnOutside = () => {
  if (!S.expanded || S.pickerOpen || S.approvalsPending) return;
  // Pasting an API key means going to copy it elsewhere: while a key (or base URL)
  // field is in use, stay open. All other settings fields fold away like the rest.
  if (S.view === 'settings' && document.activeElement?.matches('input[type="password"], .key-row input, .acct-f input')) return;
  collapse();
};
api.onBlur(foldOnOutside);
// "Another app came to front" from the tracker. This backs up the blur above (blur
// says nothing when the panel was shown without being clicked into). A just-expanded
// panel gets a moment's grace: bringing Island up can itself flip the foreground, and
// folding it again two ticks later would look like a refusal to open.
api.onForeign(() => {
  if (Date.now() - (S.expandedAt || 0) < 1500) return;
  foldOnOutside();
});

// Click-through: only the island itself catches the mouse while collapsed.
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  if (S.expanded || drag) return;
  const over = island.contains(e.target);
  if (over === !ignoring) return;
  ignoring = !over;
  api.setIgnoreMouse(ignoring);
});
island.addEventListener('mouseenter', () => !S.expanded && island.classList.add('peek'));
island.addEventListener('mouseleave', () => !drag && island.classList.remove('peek'));
island.addEventListener('click', () => {
  if (suppressClick) return;
  if (!S.expanded) api.requestExpand();
});
document.addEventListener('mousedown', (e) => {
  if (S.expanded && !island.contains(e.target)) api.requestCollapse();
});

// ---------------------------------------------------------------- dragging the island
// Grab the pill (collapsed) or the grip / orb / empty footer (expanded) and move it.

// The main process moves the window by following the real cursor; the renderer only
// decides when a press becomes a drag and when it ends.
let drag = null;
let suppressClick = false;

function startDrag(e) {
  if (e.button !== 0) return;
  if (e.target.closest('button, textarea, input, select, a, .popover')) return;
  drag = { x: e.clientX, y: e.clientY, moved: false };
  e.currentTarget.setPointerCapture(e.pointerId);
}
document.addEventListener('pointermove', (e) => {
  if (!drag || drag.moved) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
  drag.moved = true;
  api.dragStart();
  island.classList.add('moving');
});
function endDrag() {
  if (!drag) return;
  if (drag.moved) {
    api.dragEnd();
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
  }
  drag = null;
  island.classList.remove('moving');
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);
$('grip').addEventListener('pointerdown', startDrag);
island.querySelector('.pill').addEventListener('pointerdown', startDrag);
island.querySelector('.composer .orb').addEventListener('pointerdown', startDrag);
// The living orb: one in the message box (also the drag handle), one in the collapsed
// pill, one in the compact "needs you" header, and the big one in live voice.
window.ORBS = {
  composer: Orb.mount(island.querySelector('.composer .orb'), 30),
  pill: Orb.mount(island.querySelector('.pill .orb'), 26),
  compact: Orb.mount(island.querySelector('.compact-head .orb'), 22),
  live: Orb.mount($('lvOrb'), 168, 'thinking'),
};
island.querySelector('.footer').addEventListener('pointerdown', (e) => e.target.classList.contains('spacer') && startDrag(e));
$('grip').addEventListener('dblclick', () => api.resetPosition());
api.onMoved(({ home }) => home && toast('Snapped back to top-center'));

// Where the island sits inside its window. Usually 24 px in from every edge (room for the
// glow), less next to the taskbar or a screen edge so the glow never covers them.
api.onFrame(({ left, top, right, bottom, cx, ack }) => {
  const s = island.style;
  s.setProperty('--ol', left + 'px');
  s.setProperty('--ot', top + 'px');
  s.setProperty('--or', right + 'px');
  s.setProperty('--ob', bottom + 'px');
  s.setProperty('--cx', cx + 'px');
  // Main hid the window while it changed size; show it once this frame is on screen.
  if (ack) requestAnimationFrame(() => requestAnimationFrame(() => api.frameApplied()));
});

// Which edges the island hangs from; it grows and shrinks toward them.
let anchorV = 'top';
api.onAnchor(({ v, h }) => {
  anchorV = v;
  island.classList.toggle('av-bottom', v === 'bottom');
  island.classList.toggle('ah-left', h === 'left');
  island.classList.toggle('ah-right', h === 'right');
});

function toast(text) {
  // Lives outside the island (which clips its contents), on the side with room.
  const r = island.getBoundingClientRect();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  t.style.left = r.left + r.width / 2 + 'px';
  // Open panel: just above the footer (or a waiting card, or the "Latest" button), never on top of them.
  const end = S.expanded && ($('jumpBtn').hidden ? island.querySelector($('prompt').childElementCount ? '#prompt' : '.footer') : $('jumpBtn'))?.getBoundingClientRect();
  t.style.top = (S.expanded ? (end?.top || r.bottom - 64) - (end ? 42 : 44) : anchorV === 'bottom' ? r.top - 36 : r.bottom + 8) + 'px';
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 1800);
  setTimeout(() => t.remove(), 2200);
}

// ---------------------------------------------------------------- state + pill

// "hi-IN" -> "Hindi (India)"
function langName(tag) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag; } catch { return tag || ''; }
}

// Tell screen readers something once (a hidden polite status region). Clearing first makes
// the same words announce again if they repeat.
function announce(text) {
  const box = $('srStatus');
  if (!box) return;
  box.textContent = '';
  setTimeout(() => (box.textContent = text), 60);
}

// How long the last live reply took, stage by stage (shown in Settings → Voice and keys).
Voice.Speaker.onPlay(() => {
  const t = LIVE.t;
  if (!LIVE.on || !t || t.audio) return;
  t.audio = performance.now();
  const s = (a, b) => Math.max(0, (b - a) / 1000).toFixed(1);
  S.voiceTiming = { total: s(t.end, t.audio), stt: s(t.end, t.stt || t.end), think: s(t.stt || t.end, t.text || t.audio), voice: s(t.text || t.audio, t.audio) };
  console.info('[voice timing]', S.voiceTiming);
});

// Transcription gives { text, lang } ("hi-IN"); older builds gave just the text.
const heard = (r) => (typeof r === 'string' ? { text: r, lang: '' } : { text: r?.text || '', lang: r?.lang || '' });

// Spoken replies in a language no voice could read: say so once per language, with a
// way to fix it (install Windows' voice for it, or use online voices).
const voiceMissingSeen = new Set();
Voice.Speaker.onMissing(({ missing: lang, canInstall, onlineError }) => {
  const base = lang.split('-')[0];
  if (voiceMissingSeen.has(base)) return;
  voiceMissingSeen.add(base);
  const name = langName(base);
  const why = onlineError ? ` The online voice didn't work either: ${onlineError}` : '';
  const el = addNote(canInstall
    ? `This PC has no ${name} voice, so Island can't read ${name} aloud yet.${why} Windows can add one (a free download from Microsoft; Windows asks for your OK).`
    : `Windows has no ${name} voice to download, so Island can't read ${name} aloud with it.${why} A natural voice from Azure, Google, ElevenLabs or Sarvam can: add your own key in Settings → Voice and keys.`, false);
  if (!el) return;
  if (S.view === 'live') toast(`No ${name} voice yet. The chat shows how to add one`);
  const row = document.createElement('div');
  row.className = 'note-acts';
  row.innerHTML = (canInstall ? `<button class="btn mint" data-a="install">${ICONS.download}<span>Add the ${escapeHtml(name)} voice</span></button>` : '') + `<button class="btn ghost" data-a="online">${ICONS.globe}<span>Online voices</span></button>`;
  el.appendChild(row);
  row.querySelector('[data-a="online"]').onclick = () => showSettings('voicekeys', 'voiceOnline');
  row.querySelector('[data-a="install"]')?.addEventListener('click', (e) => installVoiceFor(base, e.currentTarget));
});

// Windows' own voice for a language: a download Windows asks permission for.
async function installVoiceFor(lang, btn) {
  const name = langName(lang);
  const label = btn?.querySelector('span');
  if (btn) btn.disabled = true;
  if (label) label.textContent = `Adding the ${name} voice… (this can take a few minutes)`;
  const r = await api.voiceInstall(lang).catch(() => ({ ok: false, reason: 'failed' }));
  if (r.ok) {
    voiceMissingSeen.delete(lang);
    if (label) label.textContent = `${name} voice added`;
    toast(`${name} voice added`);
  } else {
    if (btn) btn.disabled = false;
    if (label) label.textContent = r.reason === 'declined' ? 'Windows was not allowed to add it. Try again' : `Couldn't add it. Try again, or use Online voices`;
  }
  return r;
}

function setState(s) {
  S.state = s;
  island.dataset.state = s;
  if (window.ORBS) {
    const o = Orb.fromIsland(s);
    ORBS.composer.set(o);
    ORBS.pill.set(o);
    ORBS.compact.set(o);
  }
  updatePill();
}

const fmtClock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtCountdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

function updatePill() {
  const prim = $('pillPrimary');
  const sec = $('pillSecondary');
  const now = new Date();
  const timer = S.timers[0];
  let p = fmtClock(now);
  let s = `CPU ${S.stats.cpu}%, memory ${S.stats.mem}%`;
  let activity = false;
  let shimmer = false;

  if (S.state === 'approval' && S.teach?.waiting) {
    p = 'Your turn';
    s = S.activity;
    activity = true;
  } else if (S.state === 'approval') {
    p = 'Approval needed';
    s = S.activity || 'Click to review';
    activity = true;
  } else if (window.__livePhase) {
    p = LIVE.share ? 'Live, sharing screen' : 'Live';
    s = S.activity || '';
    activity = true;
  } else if (S.state === 'listening') {
    p = 'Listening…';
    s = 'Speak now. Pause to send, Esc to cancel';
    activity = true;
  } else if (V.busy) {
    p = 'Transcribing';
    s = '…';
    activity = true;
    shimmer = true;
  } else if (S.busy) {
    p = S.state === 'control' ? 'Using your computer' : S.state === 'tool' ? 'Working' : 'Thinking';
    s = S.activity || '…';
    if (S.plan) {
      const { steps } = S.plan;
      const i = steps.findIndex((x) => x.status !== 'done');
      if (i >= 0) s = `Step ${i + 1} of ${steps.length}: ${steps[i].title}`;
    }
    activity = true;
    shimmer = true;
  } else if (S.flash) {
    p = S.flash.title;
    s = S.flash.sub;
    activity = true;
  } else if (S.state === 'ready') {
    p = 'Reply ready';
    s = S.readySnippet;
    activity = true;
  } else if (S.state === 'error') {
    p = 'Something went wrong';
    s = 'Click to see details';
    activity = true;
  } else if (timer) {
    p = fmtCountdown(timer.endsAt - Date.now());
    s = timer.label + (S.timers.length > 1 ? ` and ${S.timers.length - 1} more` : '');
    activity = true;
  }

  setText(prim, p);
  setText(sec, s);
  prim.classList.toggle('shimmer', shimmer);
  island.classList.toggle('activity', activity && !S.expanded);
  island.classList.toggle('has-timer', !!timer && !S.busy);
  island.classList.toggle('has-plan', !!S.plan && S.busy && !timer);
  if (timer) {
    const frac = Math.max(0, (timer.endsAt - Date.now()) / (timer.total * 1000));
    document.querySelector('#timerRing .prog').style.strokeDashoffset = String(50.27 * (1 - frac));
  }
}

// Change text with a small rise, but only when the words change (not every tick of a clock).
function setText(el, text) {
  if (el.textContent === text) return;
  const old = el.textContent;
  el.textContent = text;
  // Counting clocks/timers and streaming snippets change constantly; animate real changes only.
  if (!old || /^\d/.test(text) || S.busy && el.id === 'pillSecondary') return;
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
}

setInterval(() => {
  updatePill();
  renderTimersList();
}, 1000);

api.onStats((st) => {
  S.stats = st;
  $('cpuBar').style.height = st.cpu + '%';
  $('memBar').style.height = st.mem + '%';
  $('cpuBar').parentElement.classList.toggle('hot', st.cpu > 85);
  $('memBar').parentElement.classList.toggle('hot', st.mem > 90);
});

api.onTimers((t) => {
  S.timers = t.sort((a, b) => a.endsAt - b.endsAt);
  updatePill();
  renderTimersList();
});
api.getTimers().then((t) => { S.timers = t; updatePill(); });

api.onTimerDone(({ label }) => {
  S.flash = { title: `${label} — done`, sub: 'Timer finished' };
  island.dataset.state = 'ready';
  updatePill();
  setTimeout(() => {
    S.flash = null;
    if (S.state === 'idle') island.dataset.state = 'idle';
    updatePill();
  }, 8000);
});

// ---------------------------------------------------------------- empty state

// Home screen: a short command list. Groups say what kind of help each row is.
const SUGGESTIONS = [
  { group: 'Do it for me', icon: 'cursor', title: 'Write a to-do list in Notepad', sub: 'Island opens Notepad and types it', prompt: 'Open Notepad, start a new blank tab, and type a short, upbeat to-do list for today with 5 items. Don\'t save it.' },
  { group: 'Do it for me', icon: 'music', title: 'Play some lo-fi music', sub: 'Finds and starts it on YouTube', prompt: 'Open YouTube in my browser, search for lo-fi beats to focus to, and start playing one.' },
  { group: 'Learn with me', icon: 'school', title: 'Teach me Excel, step by step', sub: 'You click, Island shows you where', prompt: "Open Excel with a blank workbook and teach me the basics step by step. I've barely used it, so explain it simply. Let me do each step myself." },
  { group: 'Learn with me', icon: 'bulb', title: 'Show me how to do something', sub: 'Say what you want to learn', prompt: 'I want to learn how to ' },
  { group: 'Learn with me', icon: 'circleDot', title: 'Show Island how', sub: 'Do a task once, Island repeats it later', prompt: 'I want to show you how I do a task, so you can do it for me next time. It is: ' },
  { group: 'Ask', icon: 'screen', title: 'Explain my screen', sub: 'What am I looking at?', prompt: "What's on my screen? Explain it briefly and point out anything I should act on.", screen: true },
  { group: 'Ask', icon: 'globe', title: 'Translate my screen', sub: 'Into Hindi, or English if it is Hindi', prompt: "Translate the main text on my screen into simple Hindi (if it is already in Hindi, into simple English). Keep the meaning exact and explain any official or technical words.", screen: true },
  { group: 'Ask', icon: 'cpu', title: 'Fix my PC', sub: 'Slow, full, Wi-Fi or printer trouble', prompt: "Give my PC a check-up and tell me in simple words what's wrong and how to fix it." },
  { group: 'Ask', icon: 'globe', title: "Today's tech news", sub: 'Top five stories with sources', prompt: 'What are the top 5 tech news stories today? One line each, with sources.' },
  { group: 'Ask', icon: 'timer', title: 'Start a 25-minute focus timer', sub: 'Counts down in the island', prompt: 'Start a 25 minute focus timer labelled "Focus".' },
];

const keyLabel = (accel) => (accel || '').replace(/Control/g, 'Ctrl').split('+').map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('');

// How often each home suggestion was used, kept on this PC only, so "Picked for you"
// can lead with what this person actually does.
const USE_KEY = 'island.suggestionUse';
const suggestionUse = () => { try { return JSON.parse(localStorage.getItem(USE_KEY) || '{}'); } catch { return {}; } };
function noteSuggestionUse(title) {
  const u = suggestionUse();
  u[title] = { n: (u[title]?.n || 0) + 1, at: Date.now() };
  localStorage.setItem(USE_KEY, JSON.stringify(u));
}
// Without any history, lean on the time of day.
function timeDefaults(h) {
  if (h >= 5 && h < 12) return ["Today's tech news", 'Explain my screen', 'Teach me Excel, step by step'];
  if (h >= 12 && h < 18) return ['Explain my screen', 'Translate my screen', 'Fix my PC'];
  return ['Play some lo-fi music', 'Explain my screen', 'Start a 25-minute focus timer'];
}
function pickedForYou() {
  const use = suggestionUse();
  const picked = [];
  const last = S.promptHistory[S.promptHistory.length - 1];
  if (last) picked.push({ icon: 'history', title: last.length > 60 ? `${last.slice(0, 58)}…` : last, why: 'Ask again: you asked this last time', refill: last });
  const used = SUGGESTIONS.filter((x) => use[x.title]?.n).sort((a, b) => use[b.title].n - use[a.title].n || use[b.title].at - use[a.title].at);
  for (const x of used) if (picked.length < 3) picked.push({ ...x, why: use[x.title].n > 1 ? `You've used this ${use[x.title].n} times` : 'You used this recently' });
  for (const t of timeDefaults(new Date().getHours())) {
    if (picked.length >= 3) break;
    const x = SUGGESTIONS.find((s) => s.title === t);
    if (x && !picked.some((p) => p.title === x.title)) picked.push({ ...x, why: x.sub });
  }
  return picked;
}

function runSuggestion(r) {
  if (!r.refill && SUGGESTIONS.some((s) => s.title === r.title)) noteSuggestionUse(r.title);
  if (r.refill) {
    input.value = r.refill;
    autosize();
    updateSendBtn();
    return input.focus();
  }
  if (r.screen) S.attachScreen = true;
  input.value = r.prompt;
  // An open-ended starter waits for the user to finish the sentence.
  if (/\s$/.test(r.prompt)) {
    autosize();
    updateSendBtn();
    return input.focus();
  }
  submit();
}

function suggestionRow(r, { picked = false } = {}) {
  const el = document.createElement(r.prompt || r.run || r.refill ? 'button' : 'div');
  el.className = (picked ? 'pick' : 'cmd') + (r.prompt || r.run || r.refill ? '' : ' static');
  el.innerHTML = picked
    ? `<span class="pick-i">${ICONS[r.icon]}</span><span class="pick-t"><b></b><span></span></span>${ICONS.chevronRight}`
    : `<span class="cmd-i">${ICONS[r.icon]}</span><span class="cmd-t"><b></b><span></span></span><span class="cmd-k">${r.keys ? keyLabel(r.keys) : ''}</span>`;
  el.querySelector('b').textContent = r.title;
  el.querySelector(picked ? '.pick-t span' : '.cmd-t span').textContent = (picked ? r.why : r.sub) || '';
  if (r.prompt || r.refill) el.onclick = () => runSuggestion(r);
  else if (r.run) el.onclick = r.run;
  return el;
}

function renderEmpty() {
  const hasThread = thread.children.length > 0;
  $('empty').hidden = hasThread || S.view !== 'chat';
  thread.hidden = S.view !== 'chat';
  if (hasThread) return;
  const h = new Date().getHours();
  const part = h < 5 ? 'Working late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('greeting').innerHTML = `${part}<small>${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</small>`;

  const box = $('suggestions');
  box.innerHTML = '<div class="cmd-h">Picked for you</div>';
  for (const r of pickedForYou()) box.appendChild(suggestionRow(r, { picked: true }));

  // Everything else stays one click away, folded so the home screen stays short.
  const more = document.createElement('button');
  more.className = 'more-ideas' + (S.moreOpen ? ' open' : '');
  more.innerHTML = `<span>${S.moreOpen ? 'Fewer ideas' : 'More things Island can do'}</span>${ICONS.chevron}`;
  more.onclick = () => {
    S.moreOpen = !S.moreOpen;
    renderEmpty();
    fitHeight();
  };
  box.appendChild(more);
  if (S.moreOpen) {
    const all = document.createElement('div');
    all.className = 'more-list';
    const s = S.settings;
    const anywhere = [
      { icon: 'mic', title: 'Talk to Island', keys: s.voiceHotkey, run: () => startListening() },
      { icon: 'text', title: 'Ask about selected text', keys: s.selectionHotkey, sub: 'Select text in any app first' },
      { icon: 'command', title: 'Open or hide Island', keys: s.activeHotkey || s.hotkey },
    ].filter((r) => r.keys);
    const groups = [...new Set(SUGGESTIONS.map((x) => x.group))].map((g) => [g, SUGGESTIONS.filter((x) => x.group === g)]);
    groups.push(['Anywhere on your PC', anywhere]);
    for (const [name, rows] of groups) {
      if (!rows.length) continue;
      all.insertAdjacentHTML('beforeend', `<div class="cmd-h">${escapeHtml(name)}</div>`);
      for (const r of rows) all.appendChild(suggestionRow(r));
    }
    const priv = document.createElement('button');
    priv.className = 'link-row';
    priv.innerHTML = `${ICONS.incognito}<span>Start a private chat</span><small>Not saved, no memory</small>`;
    priv.onclick = () => newChat(true, { incognito: true });
    all.appendChild(priv);
    box.appendChild(all);
  }
  renderRecent();
  renderTimersList();
  if (S.view === 'chat') body.scrollTop = 0; // home always starts at the greeting
}

// Older questions live in "More things Island can do"; the last one is already picked.
function renderRecent() {
  const box = $('recent');
  box.innerHTML = '';
  if (!S.moreOpen) return;
  const items = S.promptHistory.slice(-4, -1).reverse();
  if (items.length) box.innerHTML = '<div class="cmd-h">You asked earlier</div>';
  for (const p of items) {
    const row = document.createElement('button');
    row.className = 'cmd past';
    row.title = 'Put this back in the box to edit or resend';
    row.innerHTML = `<span class="cmd-i">${ICONS.history}</span><span class="cmd-t"><b></b></span>`;
    row.querySelector('b').textContent = p;
    row.onclick = () => {
      input.value = p;
      autosize();
      updateSendBtn();
      input.focus();
    };
    box.appendChild(row);
  }
}

// Rotating example prompts in the empty composer.
const PLACEHOLDERS = [
  'Ask anything, or type / for commands',
  'Try: open my last download',
  'Try: play lo-fi on YouTube in my Chrome',
  'Try: what’s using all my RAM?',
  'Try: summarize this page (Ctrl+Shift+S)',
  'Try: remind me in 20 minutes to stretch',
];
let phIdx = 0;
setInterval(() => {
  if (!S.expanded || input.value || document.activeElement === input && S.busy || S.incognito) return;
  phIdx = (phIdx + 1) % PLACEHOLDERS.length;
  input.classList.add('ph-swap');
  setTimeout(() => {
    input.placeholder = PLACEHOLDERS[phIdx];
    input.classList.remove('ph-swap');
  }, 180);
}, 4500);

// "Latest" button when scrolled away from the bottom of a conversation.
body.addEventListener('scroll', () => {
  $('jumpBtn').hidden = S.view !== 'chat' || body.scrollHeight - body.scrollTop - body.clientHeight < 140;
});
$('jumpBtn').onclick = () => body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });

function renderTimersList() {
  const box = $('timersList');
  if (!S.expanded || thread.children.length) return;
  const reminders = (S.reminders || []).slice(0, 4);
  // Called every second: when the list itself hasn't changed, only tick the countdowns
  // (rebuilding would replay the rows' entrance animation each second).
  const sig = [...S.timers.map((t) => t.id), ...reminders.map((r) => r.id + r.when)].join('|');
  if (box.dataset.sig === sig && box.childElementCount) {
    box.querySelectorAll('.timer-row[data-id]').forEach((row) => {
      const t = S.timers.find((x) => x.id === row.dataset.id);
      if (t) row.querySelector('.t').textContent = `${fmtCountdown(t.endsAt - Date.now())} left`;
    });
    return;
  }
  box.dataset.sig = sig;
  box.innerHTML = '';
  if (S.timers.length || reminders.length) box.insertAdjacentHTML('beforeend', `<div class="cmd-h">${S.timers.length ? 'Running now' : 'Coming up'}</div>`);
  for (const t of S.timers) {
    const row = document.createElement('div');
    row.className = 'timer-row';
    row.dataset.id = t.id;
    row.innerHTML = `<span class="tr-i">${ICONS.timer}</span><span class="tr-t"><b class="l"></b><span class="t">${fmtCountdown(t.endsAt - Date.now())} left</span></span><button class="btn ghost">Stop</button>`;
    row.querySelector('.l').textContent = t.label || 'Timer';
    row.querySelector('button').onclick = () => api.cancelTimer(t.id);
    box.appendChild(row);
  }
  // Upcoming reminders (saved, can repeat).
  for (const r of reminders) {
    const row = document.createElement('div');
    row.className = 'timer-row reminder';
    row.innerHTML = `<span class="tr-i">${ICONS.bell}</span><span class="tr-t"><b class="l"></b><span class="t"></span></span><button class="btn ghost">Remove</button>`;
    row.querySelector('.t').textContent = r.when;
    row.querySelector('.l').textContent = r.text;
    row.querySelector('button').onclick = async () => {
      S.reminders = await api.removeReminder(r.id);
      renderTimersList();
      toast('Reminder removed');
    };
    box.appendChild(row);
  }
}

api.remindersList().then((list) => { S.reminders = list; renderTimersList(); }).catch(() => {});
api.onReminders((list) => { S.reminders = list; renderTimersList(); });
// A reminder is due: show it on the island and read it aloud.
api.onReminder(({ text, late, speak }) => {
  S.flash = { title: `⏰ ${text}`, sub: late ? 'Missed while the PC was off' : 'Reminder' };
  island.dataset.state = 'ready';
  updatePill();
  if (speak) Voice.Speaker.say(`Reminder: ${text}`);
  setTimeout(() => {
    S.flash = null;
    if (S.state === 'idle') island.dataset.state = 'idle';
    updatePill();
  }, 20000);
});

// ---------------------------------------------------------------- composer

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 168) + 'px';
  input.style.overflowY = input.scrollHeight > 168 ? 'auto' : 'hidden';
}
input.addEventListener('input', () => {
  autosize();
  updateSlash();
  updateSendBtn();
});

function updateSendBtn() {
  const b = $('sendBtn');
  b.classList.toggle('stop', S.busy);
  // Swap the icon only when it changes (send <-> stop): rebuilding it on every keystroke
  // replayed its pop animation, which made the button flicker while typing.
  const icon = S.busy ? 'stop' : 'send';
  if (b.dataset.icon !== icon) {
    b.dataset.icon = icon;
    b.innerHTML = ICONS[icon];
  }
  const stopKey = keyLabel(S.settings?.stopHotkey || 'Ctrl+Alt+Shift+Esc');
  b.title = S.busy ? `Stop what Island is doing (Esc, or ${stopKey})` : 'Send (Enter)';
  b.disabled = !S.busy && !input.value.trim() && !S.attachments.length && !S.attachScreen;
  $('screenBtn').classList.toggle('on', S.attachScreen);
  // A plain Stop button, so stopping is one click and not a small icon to recognise.
  const sb = $('stopBtn');
  if (sb) {
    sb.hidden = !S.busy;
    if (S.busy) sb.title = `Stop what Island is doing (Esc, or ${stopKey})`;
  }
}

$('sendBtn').onclick = () => (S.busy ? api.stop() : submit());
$('stopBtn').onclick = () => api.stop();
$('screenBtn').onclick = () => toggleScreen();
$('attachBtn').onclick = () => {
  S.pickerOpen = true;
  $('fileInput').click();
};
window.addEventListener('focus', () => setTimeout(() => (S.pickerOpen = false), 300));
$('fileInput').onchange = async (e) => {
  S.pickerOpen = false;
  for (const f of e.target.files) await addFile(f);
  e.target.value = '';
  input.focus();
};
$('newBtn').onclick = () => newChat(true);
$('incogBtn').innerHTML = ICONS.incognito;
$('incogTag').innerHTML = `${ICONS.incognito}<span>Private</span>`;
$('incogBanner').innerHTML = `${ICONS.incognito}<div><b>Private chat</b><span>Not saved to your chats, and Island won't use or add to its memory. It's gone when you start a new chat or close Island.</span></div>`;
$('incogBtn').onclick = () => newChat(true, { incognito: !S.incognito });
$('settingsBtn').onclick = () => (S.view === 'settings' ? showChat() : showSettings());
$('modelChip').onclick = (e) => {
  e.stopPropagation();
  openPicker();
};
$('agentBtn').onclick = async () => {
  S.settings = await api.setSettings({ computerUse: S.settings.computerUse === 'off' ? 'ask' : 'off' });
  renderAgentBtn();
  input.focus();
};

function renderAgentBtn() {
  const on = S.settings.computerUse !== 'off';
  const cur = S.models?.find((m) => m.id === S.settings.model);
  const capable = !cur || cur.computer;
  const b = $('agentBtn');
  b.classList.toggle('on', on && capable);
  b.classList.toggle('na', on && !capable);
  b.setAttribute('aria-checked', String(on && capable));
  b.setAttribute('aria-label', 'Can use my PC');
  b.innerHTML = `<span class="sw" aria-hidden="true"><i></i></span><b>Can use my PC</b>`;
  b.title = !capable ? `${cur.name} can't use your computer. Pick a model that can see images, or a router.` : on ? 'Island can use your mouse and keyboard. Click to turn off.' : 'Island only chats and uses its tools. Click to let it use your PC.';
}

// ---------------------------------------------------------------- model picker

// What a model id may contain. Gateways use slugs like "minimax/minimax-m2:free",
// "anthropic/claude-opus-latest" or "~openai/gpt-astra-latest". The same rule is in
// src/models.js (MODEL_ID) for the main process.
const MODEL_ID_RE = /^[^\u0000-\u001f\u007f"'\\`{};<>]{1,200}$/;

// Model families: display name and the provider logo (see logos.js).
// These patterns are matched against the model name on its own ("claude-opus-4-5").
const FAMILIES = [
  [/^(auto|default|balanced|best|beta-auto)$/, 'Routers', 'router'],
  [/^claude-/, 'Anthropic', 'claude'],
  [/^(gpt-|o\d|chatgpt|gpt4|gpt-oss)/, 'OpenAI', 'openai'],
  [/^gemini/, 'Google', 'gemini'],
  [/^gemma/, 'Google', 'gemma'],
  [/^grok/, 'xAI', 'grok'],
  [/^deepseek/, 'DeepSeek', 'deepseek'],
  [/^qwen/, 'Qwen', 'qwen'],
  [/^kimi/, 'Moonshot', 'kimi'],
  [/^glm/, 'Zhipu', 'zhipu'],
  [/^(mistral|ministral|codestral|magistral|devstral|pixtral)/i, 'Mistral', 'mistral'],
  [/^(llama|muse)/, 'Meta', 'meta'],
  [/^hermes/, 'Nous Research', 'nousresearch'],
  [/^command/, 'Cohere', 'cohere'],
  [/^minimax/, 'MiniMax', 'minimax'],
  [/^nemotron/, 'NVIDIA', 'nvidia'],
  [/^(phi|wizardlm)/, 'Microsoft', 'microsoft'],
  [/^granite/, 'IBM', 'ibm'],
  [/^hunyuan/, 'Tencent', 'hunyuan'],
  [/^(doubao|seed)/, 'ByteDance', 'doubao'],
  [/^ernie/, 'Baidu', 'baidu'],
  [/^mimo/, 'Xiaomi', 'xiaomimimo'],
  [/^step/, 'StepFun', 'stepfun'],
  [/^solar/, 'Upstage', 'upstage'],
  [/^reka/, 'Reka', 'reka'],
  [/^mercury/, 'Inception', 'inception'],
  [/^laguna/, 'Poolside', 'poolside'],
  [/^ling/, 'Ant Group', 'antgroup'],
  [/^ember/, 'Fireworks', 'fireworks'],
  [/^inkling/, 'Together', 'together'],
  [/^mytho/, 'Community', 'huggingface'],
  [/^sonar/, 'Perplexity', 'perplexity'],
  // Writer has no brand logo in the set - keep the letter.
  [/^palmyra/, 'Writer', null],
  [/^nova/, 'Amazon', 'nova'],
  [/^(jamba|cody)/, 'AI21', 'ai21'],
  [/^(baichuan|baichuan2|swan)/, 'Baichuan', 'baichuan'],
  [/^(lfm|liquid)/, 'Liquid AI', 'liquid'],
  [/^sakana/, 'Sakana AI', 'sakana'],
  [/^morph/, 'Morph', 'morph'],
  [/^(dbrx|databricks)/i, 'Databricks', 'databricks'],
  [/^(internlm)/, 'Shanghai AI Lab', 'internlm'],
  [/^yi-/, '01.AI', 'yi'],
  [/^longcat/, 'Meituan', 'longcat'],
  [/^(cog|hunyuan-cog)/, 'Zhipu', 'zhipu'],

  // More leaf names, appended so nothing above can shadow them.
  [/^dall-?e/, 'OpenAI', 'openai'],
  [/^sora/, 'OpenAI', 'openai'],
  [/^whisper/, 'OpenAI', 'openai'],
  [/^veo/, 'Google', 'google'],
  [/^imagen/, 'Google', 'google'],
  [/^flux/, 'Black Forest Labs', 'bfl'],
  [/^(stable-?diffusion|sdxl)/, 'Stability', 'stability'],
  [/^wan/, 'Alibaba', 'alibaba'],
  [/^kolors/, 'Kwai', 'kolors'],
  [/^aya-/, 'Cohere', 'cohere'],
  [/^abacus/, 'Nous Research', 'nousresearch'],
  [/^orca/, 'Microsoft', 'microsoft'],
  [/^rwkv/, 'RWKV', 'rwkv'],
  [/^(olmo|tulu)/, 'Ai2', 'ai2'],
  [/^smollm/, 'Hugging Face', 'huggingface'],
];

// Gateways list models as "provider/model" ("minimax/minimax-m2", "x-ai/grok-4",
// "meta-llama/llama-3.3-70b"). This is the vendor part of such a slug, with the
// logo to show for it.
// Gateways list models as "provider/model" ("minimax/minimax-m2", "x-ai/grok-4",
// "meta-llama/llama-3.3-70b"). This is the vendor part of such a slug, with the
// logo to show for it. The logo key is a key of window.LOGOS (scripts/build-assets.js);
// null means "no logo", so the app falls back to the first letter.
const PROVIDERS = {

  // 0
  "01ai": ["01.AI", "zeroone"], "01-ai": ["01.AI", "zeroone"], "01.ai": ["01.AI", "zeroone"],

  // a
  anthropic: ["Anthropic", "anthropic"], alibaba: ["Alibaba", "alibaba"], amazon: ["Amazon", "amazon"],
  ai21: ["AI21", "ai21"], ai21labs: ["AI21", "ai21"], aionlabs: ["Aion Labs", "aionlabs"],
  "aion-labs": ["Aion Labs", "aionlabs"], arcee: ["Arcee", "arcee"], arceeai: ["Arcee", "arcee"],
  "arcee-ai": ["Arcee", "arcee-ai"],
  anthracite: ["Anthracite", "huggingface"], "anthracite-org": ["Anthracite", "huggingface"], amazonnova: ["Amazon", "amazon"], aihubmix: ["AiHubMix", "aihubmix"],
  // No logo exists for these, so they show their first letter.
  moondream: ["Moondream", null], recursive: ["Recursive", null], reflection: ["Reflection", null],
  typesafe: ["TypeSafe", null], undi95: ["Undi95", null],
  adobe: ["Adobe", "adobe"], adobefirefly: ["AdobeFirefly", "adobefirefly"],
  agentvoice: ["AgentVoice", "agentvoice"], agnesai: ["Agnes AI", "agnesai"], ai2: ["Ai2", "ai2"],
  ai302: ["302.AI", "ai302"], ai360: ["AI360", "ai360"], aimass: ["AiMass", "aimass"],
  airjelly: ["AirJelly", "airjelly"], aistudio: ["Google AI Studio", "aistudio"],
  akashchat: ["AkashChat", "akashchat"], alephalpha: ["AlephAlpha", "alephalpha"],
  alibabacloud: ["Alibaba Cloud", "alibabacloud"], amdradeoncloud: ["AMD Radeon Cloud", "amdradeoncloud"],
  amp: ["Amp", "amp"], anspire: ["Anspire", "anspire"], antgroup: ["AntGroup", "antgroup"],
  antigravity: ["Antigravity", "antigravity"], anyscale: ["Anyscale", "anyscale"], apertis: ["Apertis", "apertis"],
  apple: ["Apple", "apple"], askverdict: ["AskVerdict", "askverdict"], assemblyai: ["AssemblyAI", "assemblyai"],
  atlascloud: ["Atlas Cloud", "atlascloud"], automatic: ["Automatic", "automatic"], aws: ["AWS", "aws"],
  aya: ["Aya", "aya"], azure: ["Azure", "azure"], azureai: ["AzureAI", "azureai"], aihub: ["AiHubMix", "aihub"],
  ace: ["Ace", "ace"], agui: ["AG-UI", "agui"],

  // b
  bytedance: ["ByteDance", "bytedance"], "bytedance-seed": ["ByteDance", "bytedance"], baidu: ["Baidu", "baidu"],
  baichuan: ["Baichuan", "baichuan"], baai: ["BAAI", "baai"], baiducloud: ["BaiduCloud", "baiducloud"],
  bailian: ["BaiLian", "bailian"], baseten: ["Baseten", "baseten"], bedrock: ["Bedrock", "bedrock"],
  bfl: ["Black Forest Labs", "bfl"], bilibili: ["bilibili", "bilibili"],
  bilibiliindex: ["bilibili index", "bilibiliindex"], bing: ["Bing", "bing"], bocha: ["Bocha", "bocha"],
  brave: ["Brave", "brave"], briaai: ["BRIA AI", "briaai"], browserless: ["Browserless", "browserless"],
  burncloud: ["BurnCloud", "burncloud"],

  // c
  cohere: ["Cohere", "cohere"], cerebras: ["Cerebras", "cerebras"], cognition: ["Cognition", "cognition"],
  // No brand logo for Cognitive Computations in the set - keep the letter.
  cognitivecomputations: ["Cognitive Computations", null],
  celestoai: ["CelestoAI", "celestoai"], centml: ["CentML", "centml"], chatglm: ["ChatGLM", "chatglm"],
  chutes: ["Chutes", "chutes"], civitai: ["Civitai", "civitai"], claude: ["Claude", "claude"],
  claudecode: ["Claude Code", "claudecode"], cline: ["Cline", "cline"], clipdrop: ["Clipdrop", "clipdrop"],
  cloudflare: ["Cloudflare", "cloudflare"], codebuddy: ["CodeBuddy", "codebuddy"],
  codeflicker: ["CodeFlicker", "codeflicker"], codegeex: ["CodeGeeX", "codegeex"], codex: ["Codex", "codex"],
  cogvideo: ["CogVideo", "cogvideo"], cogview: ["CogView", "cogview"], colab: ["Colab", "colab"],
  cometapi: ["CometAPI", "cometapi"], commanda: ["CommandA", "commanda"],
  commandcode: ["Command Code", "commandcode"], copilot: ["Copilot", "copilot"],
  copilotkit: ["CopilotKit", "copilotkit"], coqui: ["Coqui", "coqui"], coze: ["Coze", "coze"],
  crewai: ["CrewAI", "crewai"], crusoe: ["Crusoe", "crusoe"], cursor: ["Cursor", "cursor"],
  cybercut: ["CyberCut", "cybercut"], capcut: ["CapCut", "capcut"], cherrystudio: ["CherryStudio", "cherrystudio"],
  comfyui: ["ComfyUI", "comfyui"],

  // d
  deepseek: ["DeepSeek", "deepseek"], databricks: ["Databricks", "databricks"],
  deepinfra: ["DeepInfra", "deepinfra"], dots: ["Dots Studio", "dotsstudio"],
  "dots-studio": ["Dots Studio", "dotsstudio"], dalle: ["DALL-E", "dalle"], dbrx: ["DBRX", "dbrx"],
  decart: ["Decart", "decart"], deepai: ["DeepAI", "deepai"], deepcogito: ["Deep Cogito", "deepcogito"],
  deepl: ["DeepL", "deepl"], deepmind: ["DeepMind", "deepmind"], devin: ["Devin", "devin"], dify: ["Dify", "dify"],
  digitalocean: ["DigitalOcean", "digitalocean"], doc2x: ["Doc2X", "doc2x"], docsearch: ["DocSearch", "docsearch"],
  dolphin: ["Dolphin", "dolphin"], dotsstudio: ["Dots Studio", "dotsstudio"], doubao: ["Doubao", "doubao"],
  dreammachine: ["DreamMachine", "dreammachine"],

  // e
  elevenlabs: ["ElevenLabs", "elevenlabs"], elorian: ["Elorian", "huggingface"], elevenx: ["11x", "elevenx"],
  essentialai: ["Essential AI", "essentialai"], exa: ["Exa", "exa"],

  // f
  fireworks: ["Fireworks", "fireworks"], fal: ["Fal", "fal"], fastgpt: ["FastGPT", "fastgpt"],
  featherless: ["Featherless", "featherless"], firecrawl: ["Firecrawl", "firecrawl"],
  fishaudio: ["FishAudio", "fishaudio"], flora: ["Flora", "flora"], flowith: ["Flowith", "flowith"],
  flux: ["Flux", "flux"], friendli: ["Friendli", "friendli"], figma: ["Figma", "figma"],

  // g
  google: ["Google", "gemini"], gemini: ["Google", "gemini"], gemma: ["Google", "gemma"], grok: ["xAI", "xai"],
  gryphe: ["Gryphe", "huggingface"], geminicli: ["Gemini CLI", "geminicli"], giteeai: ["GiteeAI", "giteeai"],
  github: ["GitHub", "github"], githubcopilot: ["GitHub Copilot", "githubcopilot"], glama: ["Glama", "glama"],
  glif: ["Glif", "glif"], glmv: ["GLM-V", "glmv"], gmicloud: ["GmiCloud", "gmicloud"],
  googlecloud: ["Google Cloud", "googlecloud"], goose: ["Goose", "goose"], gradio: ["Gradio", "gradio"],
  greptile: ["Greptile", "greptile"], groq: ["Groq", "groq"], "google-gemini": ["Google", "gemini"],

  // h
  huggingface: ["Hugging Face", "huggingface"], hyperbolic: ["Hyperbolic", "hyperbolic"],
  hailuo: ["Hailuo", "hailuo"], haiper: ["Haiper", "haiper"], happyhorse: ["Hedra", "happyhorse"],
  hedra: ["Hedra", "hedra"], hermesagent: ["Hermes Agent", "hermesagent"], higress: ["Higress", "higress"],
  huawei: ["Huawei", "huawei"], huaweicloud: ["Huawei Cloud", "huaweicloud"], hunyuan: ["Hunyuan", "hunyuan"],

  // i
  ibm: ["IBM", "ibm"], "ibm-granite": ["IBM", "ibm"], inception: ["Inception", "inception"],
  internlm: ["Shanghai AI Lab", "internlm"], inclusionai: ["InclusionAI", "antgroup"],
  inference: ["Inference", "inference"], "inference-net": ["Inference", "inference"],
  ideogram: ["Ideogram", "ideogram"], iflytekcloud: ["iFlyTek Cloud", "iflytekcloud"],
  inceptron: ["Inceptron", "inceptron"], infermatic: ["Infermatic", "infermatic"],
  infinigence: ["Infinigence", "infinigence"], inflection: ["Inflection", "inflection"], ionet: ["IoNet", "ionet"],

  // j
  jina: ["Jina", "jina"], jimeng: ["Jimeng", "jimeng"], junie: ["Junie", "junie"],

  // k
  kimi: ["Moonshot", "moonshot"], kagi: ["Kagi", "kagi"], kilocode: ["Kilo Code", "kilocode"],
  kiro: ["Kiro", "kiro"], kling: ["Kling", "kling"], kluster: ["Kluster", "kluster"], kolors: ["Kolors", "kolors"],
  krea: ["Krea", "krea"], kwaikat: ["KwaiKAT", "kwaikat"], kwaipilot: ["Kwaipilot", "kwaipilot"],

  // l
  liquid: ["Liquid AI", "liquid"], liquidai: ["Liquid AI", "liquid"], liquidl2: ["Liquid AI", "liquid"],
  lambda: ["Lambda", "lambda"], langchain: ["LangChain", "langchain"], langfuse: ["Langfuse", "langfuse"],
  langgraph: ["LangGraph", "langgraph"], langsmith: ["LangSmith", "langsmith"], leptonai: ["LeptonAI", "leptonai"],
  lg: ["LG AI", "lg"], lightricks: ["Lightricks", "lightricks"], livekit: ["LiveKit", "livekit"],
  llamaindex: ["LlamaIndex", "llamaindex"], llava: ["LLaVA", "llava"], llmapi: ["LLM API", "llmapi"],
  lmstudio: ["LM Studio", "lmstudio"], lobehub: ["LobeHub", "lobehub"], longcat: ["LongCat", "longcat"],
  lovable: ["Lovable", "lovable"], lovart: ["Lovart", "lovart"], luma: ["Luma", "luma"],

  // m
  moonshotai: ["Moonshot", "moonshot"], mistralai: ["Mistral", "mistral"], mistral: ["Mistral", "mistral"],
  meta: ["Meta", "meta"], "meta-llama": ["Meta", "meta"], microsoft: ["Microsoft", "microsoft"],
  minimax: ["MiniMax", "minimax"], morph: ["Morph", "morph"], meituan: ["Meituan", "longcat"],
  moonshot: ["Moonshot", "moonshot"], meituanlongcat: ["Meituan", "longcat"], morphllm: ["Morph", "morph"],
  mancer: ["Mancer", "huggingface"], magic: ["Magic", "magic"], make: ["Make", "make"], manus: ["Manus", "manus"],
  mastra: ["Mastra", "mastra"], mcpso: ["MCP.so", "mcpso"], menlo: ["MENLO", "menlo"], meshy: ["Meshy", "meshy"],
  mcp: ["Model Context Protocol", "mcp"], mytho: ["Mytho", "huggingface"],
  metaai: ["Meta AI", "metaai"], metagpt: ["MetaGPT", "metagpt"], midjourney: ["Midjourney", "midjourney"],
  modelscope: ["ModelScope", "modelscope"], monica: ["Monica", "monica"], moxt: ["Moxt", "moxt"],
  myshell: ["MyShell", "myshell"], "meituan-longcat": ["Meituan", "longcat"],

  // n
  nvidia: ["NVIDIA", "nvidia"], nousresearch: ["Nous Research", "nous"], novita: ["Novita", "novita"],
  nex: ["Nex", "huggingface"], "nex-agi": ["Nex", "huggingface"], n8n: ["n8n", "n8n"],
  nanobanana: ["NanoBanana", "nanobanana"], nebius: ["Nebius", "nebius"], newapi: ["New API", "newapi"],
  nextbit: ["Nextbit", "nextbit"], notebooklm: ["NotebookLM", "notebooklm"], nova: ["Nova", "nova"],
  novelai: ["NovelAI", "novelai"], nplcloud: ["NPLCloud", "nplcloud"], notion: ["Notion", "notion"],

  // o
  openai: ["OpenAI", "openai"], openrouter: ["OpenRouter", "openrouter"], opencode: ["OpenCode", "opencode"],
  ollama: ["Ollama", "ollama"], openchat: ["OpenChat", "openchat"], openclaw: ["OpenClaw", "openclaw"],
  openhands: ["OpenHands", "openhands"], openhuman: ["OpenHuman", "openhuman"],
  openwebui: ["OpenWebUI", "openwebui"], "openrouter-free": ["OpenRouter", "openrouter"],
  obsidian: ["Obsidian", "obsidian"],
  openrouterauto: ["OpenRouter", "openrouter"], "openrouter-auto": ["OpenRouter", "openrouter"],
  "openai-codex": ["OpenAI", "codex"],

  // p
  perplexity: ["Perplexity", "perplexity"], poolside: ["Poolside", "poolside"],
  // No brand logo for Perstolia in the set - keep the letter.
  perstolia: ["Perstolia", null],
  // No brand logo for Prism ML in the set - keep the letter.
  prism: ["Prism ML", null],
  "prism-ml": ["Prism ML", null],
  perception: ["Perception", "huggingface"], perceptron: ["Perceptron", "perceptron"], palm: ["PaLM", "palm"],
  parasail: ["Parasail", "parasail"], phala: ["Phala", "phala"], phidata: ["Phidata", "phidata"],
  phind: ["Phind", "phind"], pi: ["Pi", "pi"], pika: ["Pika", "pika"], pixverse: ["PixVerse", "pixverse"],
  player2: ["Player2", "player2"], poe: ["Poe", "poe"], pollinations: ["Pollinations", "pollinations"],
  ppio: ["PPIO", "ppio"], prunaai: ["PrunaAI", "prunaai"], pydanticai: ["PydanticAI", "pydanticai"],

  // q
  qwen: ["Qwen", "qwen"], qingyan: ["Qingyan", "qingyan"], qiniu: ["Qiniu", "qiniu"], qoder: ["Qoder", "qoder"],

  // r
  rekaai: ["Reka", "reka"], reka: ["Reka", "reka"], relace: ["Relace", "relace"], railway: ["Railway", "railway"],
  recraft: ["Recraft", "recraft"], replicate: ["Replicate", "replicate"], replit: ["Replit", "replit"],
  reve: ["Reve", "reve"], roocode: ["RooCode", "roocode"], runway: ["Runway", "runway"], rwkv: ["RWKV", "rwkv"],
  rsshub: ["RSSHub", "rsshub"],

  // s
  stepfun: ["StepFun", "stepfun"], sakana: ["Sakana AI", "sakana"], sambanova: ["SambaNova", "sambanova"],
  "shanghai-ai": ["Shanghai AI Lab", "internlm"], snowflake: ["Snowflake", "snowflake"],
  siliconflow: ["SiliconFlow", "siliconcloud"], "silicon-cloud": ["SiliconFlow", "siliconcloud"],
  sao10k: ["SAO10K", "huggingface"], scales: ["ScaleDown", "huggingface"], scaledown: ["ScaleDown", "huggingface"],
  search1api: ["Search1API", "search1api"], searchapi: ["SearchApi", "searchapi"], searxng: ["SearXNG", "searxng"],
  sensenova: ["SenseNova", "sensenova"], siliconcloud: ["SiliconCloud", "siliconcloud"],
  skywork: ["Skywork", "skywork"], slock: ["Slock", "slock"], smithery: ["Smithery", "smithery"],
  sophnet: ["SophNet", "sophnet"], sora: ["Sora", "sora"], spark: ["Spark", "spark"],
  speedai: ["SpeedAI", "speedai"], stability: ["Stability", "stability"], statecloud: ["StateCloud", "statecloud"],
  straico: ["Straico", "straico"], streamlake: ["StreamLake", "streamlake"], submodel: ["SubModel", "submodel"],
  suno: ["Suno", "suno"], sync: ["Sync", "sync"], sillytavern: ["SillyTavern", "sillytavern"],

  // t
  tencent: ["Tencent", "tencent"], together: ["Together", "together"], thedrummer: ["The Drummer", "huggingface"],
  // No brand logo for Thinking Machines in the set - keep the letter.
  thinkingmachines: ["Thinking Machines", null],
  targon: ["Targon", "targon"], tavily: ["Tavily", "tavily"], tencentcloud: ["Tencent Cloud", "tencentcloud"],
  tiangong: ["Tiangong", "tiangong"], tii: ["Technology Innovation Institute", "tii"],
  topazlabs: ["TopazLabs", "topazlabs"], trae: ["TRAE", "trae"], tripo: ["Tripo", "tripo"],
  turix: ["TuriX", "turix"],

  // u
  upstage: ["Upstage", "upstage"], unsloth: ["Unsloth", "unsloth"], unbiased: ["Unbiased", "huggingface"],
  udio: ["Udio", "udio"], unionalpha: ["UnionAlpha", "unionalpha"], unstructured: ["Unstructured", "unstructured"],

  // v
  vision: ["Community", "huggingface"], v0: ["V0", "v0"], vectorizerai: ["Vectorizer.AI", "vectorizerai"],
  venice: ["Venice", "venice"], vercel: ["Vercel", "vercel"], vertexai: ["VertexAI", "vertexai"],
  vidu: ["Vidu", "vidu"], viggle: ["Viggle", "viggle"], vllm: ["vLLM", "vllm"],
  volcengine: ["Volcengine", "volcengine"], voyage: ["Voyage", "voyage"],

  // w
  // Writer has no brand logo in the set - keep the letter.
  writer: ["Writer", null],
  wafer: ["Wafer", "wafer"],
  wandb: ["Weights & Biases", "wandb"], wavespeed: ["WaveSpeed", "wavespeed"], wenxin: ["Wenxin", "wenxin"],
  windsurf: ["Windsurf", "windsurf"], workersai: ["WorkersAI", "workersai"],
  worldrouter: ["WorldRouter", "worldrouter"],

  // x
  xai: ["xAI", "xai"], xiaomi: ["Xiaomi", "xiaomi"], xingchen: ["XingChen", "huggingface"],
  "xingchen-agi": ["XingChen", "huggingface"], xiaomimimo: ["Xiaomi MiMo", "xiaomimimo"],
  xinference: ["Xinference", "xinference"], xpay: ["Xpay", "xpay"], xuanyuan: ["Xuanyuan", "xuanyuan"],
  "x-ai": ["xAI", "x-ai"],

  // y
  yi: ["01.AI", "yi"], yandex: ["Yandex", "yandex"], youmind: ["YouMind", "youmind"],
  yuanbao: ["Yuanbao", "yuanbao"],

  // z
  zai: ["Zhipu", "zhipu"], "z-ai": ["Zhipu", "zhipu"], zapier: ["Zapier", "zapier"], zeabur: ["Zeabur", "zeabur"],
  zencoder: ["Zencoder", "zencoder"], zenmux: ["ZenMux", "zenmux"], zeroone: ["01.AI", "zeroone"],
  zhipu: ["Zhipu", "zhipu"],
};

const titleCase = (s) => String(s || '').split(/[-_.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function familyOf(id) {
  const s = String(id || '');
  const parts = s.split('/').filter(Boolean);
  // A leading "~" marks a gateway's "always the newest" alias: ~anthropic/claude-opus-latest.
  const provider = (parts.length > 1 ? parts[0] : '').replace(/^~/, '').toLowerCase();
  const leaf = parts.length ? parts[parts.length - 1] : s;
  // The model name on its own is the best clue: claude-opus-4-5, grok-4, nemotron-3.5.
  for (const [re, name, logo] of FAMILIES) if (re.test(leaf)) return { name, logo, letter: name[0] };
  // Otherwise the vendor that owns it.
  const p = PROVIDERS[provider];
  if (p) return { name: p[0], logo: p[1], letter: p[0][0] };
  if (provider && provider.length > 1) {
    const name = titleCase(provider);
    return { name, logo: null, letter: name[0] };
  }
  return { name: 'Other', logo: null, letter: (leaf[0] || '?').toUpperCase() };
}
const FAMILY_ORDER = [...new Set(FAMILIES.map((f) => f[1]))].concat('Other');

// A small square with the provider's logo (or its initial when there is none).
function logoTile(id) {
  const f = id ? familyOf(id) : null;
  if (!f) return '<span class="pv">•</span>';
  if (f.logo === 'router') return `<span class="pv router">${ICONS.route}</span>`;
  const svg = f.logo && window.LOGOS?.[f.logo];
  return `<span class="pv" title="${escapeHtml(f.name)}">${svg || escapeHtml(f.letter)}</span>`;
}

const PICK_FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'agent', label: 'Agent', test: (m) => m.computer },
  { id: 'claude', label: 'Claude', test: (m) => m.kind !== 'chat' || /claude/i.test(m.id) },
  { id: 'vision', label: 'Vision', test: (m) => m.caps?.includes('vision') },
  { id: 'reasoning', label: 'Reasoning', test: (m) => m.caps?.includes('reasoning') },
];
const P = { open: false, filter: 'all', q: '', sel: 0, items: [], all: false, limit: 0 };

// A short, plain description from what the model can do (shown instead of its id).
function modelBlurb(m) {
  const can = [m.computer && 'can use your PC', m.caps?.includes('vision') && 'sees pictures', m.caps?.includes('reasoning') && 'thinks step by step'].filter(Boolean);
  const cost = m.priceIn == null ? '' : m.priceIn < 1 ? 'low cost' : m.priceIn > 5 ? 'higher cost' : '';
  const parts = [...can, cost].filter(Boolean);
  const s = parts.length ? parts.join(', ') : 'Chat only';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Recommended: Auto, the current model, and two strong Claude models.
function recommendedModels(models) {
  const pick = [];
  const add = (m) => m && m.supported && !pick.includes(m) && pick.push(m);
  add(models.find((m) => m.id === 'auto'));
  add(models.find((m) => m.id === S.settings.model));
  const claude = models.filter((m) => /claude/i.test(m.id) && m.supported).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const m of claude) if (pick.length < 4) add(m);
  return pick;
}

async function loadModels() {
  if (!S.models) {
    S.models = await api.listModels().catch(() => []);
    renderModelChip();
    renderAgentBtn();
  }
  return S.models;
}

// The model Island starts with is one of Anthropic's own ids. A gateway may not have
// it, and then every message fails with "model not found". When that is the case,
// pick one of the models the provider does have and say so.
async function fitModelToProvider() {
  const list = S.models || [];
  const current = S.settings?.model || '';
  if (!list.length || !current) return;
  if (list.some((m) => m.id === current)) return; // the current model is one of theirs
  if (!/^claude-/.test(current)) return; // a model id typed by hand: leave it alone
  const alt = list.find((m) => m.supported && /claude/i.test(m.id)) || list.find((m) => m.supported);
  if (!alt) return;
  try {
    S.settings = await api.setSettings({ model: alt.id });
    renderModelChip();
    renderAgentBtn();
    toast(`Switched to ${alt.name}: your provider doesn't have ${current}.`);
  } catch {}
}

// After an account changes (a key pasted, a base URL saved, a provider picked): fetch
// that provider's models once, redraw everything that shows them (model chip, agent
// toggle), and move to a model the provider actually has. Without this the model list
// and its logos only catch up after Island restarts.
async function refreshModels() {
  S.models = null;
  S.models = await api.listModels().catch(() => null);
  renderModelChip();
  renderAgentBtn();
  await fitModelToProvider();
}

async function openPicker() {
  P.open = true;
  P.q = '';
  P.sel = 0;
  P.all = false;
  if (!fixedPanelH) panelInner.style.minHeight = Math.min(520, maxPanelH) + 'px'; // give the list room
  island.classList.add('picking');
  $('picker').hidden = false;
  $('pickerInput').value = '';
  $('pickerList').innerHTML = '<div class="picker-empty">Loading models…</div>';
  $('picker').querySelector('.ps-ic').innerHTML = ICONS.search;
  setTimeout(() => $('pickerInput').focus(), 30);
  await loadModels();
  renderPicker();
}

function closePicker() {
  if (!P.open) return;
  P.open = false;
  panelInner.style.minHeight = '';
  island.classList.remove('picking');
  $('picker').hidden = true;
  input.focus();
}

function fmtCtx(n) {
  if (!n) return '';
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}
function fmtPrice(m) {
  if (m.priceIn == null) return '';
  const f = (v) => `$${+Number(v).toFixed(2)}`;
  return `${f(m.priceIn)}/${f(m.priceOut)}`;
}

function renderPicker() {
  const models = S.models || [];
  const q = P.q.trim().toLowerCase();
  const filter = PICK_FILTERS.find((f) => f.id === P.filter);
  const matches = (m) => !q || `${m.id} ${m.name} ${m.provider} ${familyOf(m.id).name}`.toLowerCase().includes(q);
  // Start short: a few recommended models; the full list (with filters) is one click away.
  const short = !q && !P.all;
  $('pickerFilters').hidden = short;

  $('pickerFilters').innerHTML = PICK_FILTERS.map((f) => `<button class="pf${f.id === P.filter ? ' on' : ''}" data-f="${f.id}">${f.label}<i>${models.filter((m) => f.test(m) && matches(m)).length}</i></button>`).join('');
  $('pickerFilters').querySelectorAll('.pf').forEach((b) => (b.onclick = () => {
    P.filter = b.dataset.f;
    P.sel = 0;
    renderPicker();
    $('pickerInput').focus();
  }));

  const shown = short ? recommendedModels(models) : models.filter((m) => filter.test(m) && matches(m));
  const groups = new Map();
  if (short) groups.set('Recommended', shown);
  else for (const m of shown) {
    const fam = familyOf(m.id).name;
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(m);
  }
  const order = short ? ['Recommended'] : [...groups.keys()].sort((a, b) => FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b));

  P.items = [];
  const parts = [];
  const exact = models.some((m) => m.id.toLowerCase() === q);
  // A big gateway can list hundreds of models. Drawing them all at once makes the
  // list slow to open, so the first page is shown and the rest waits for a click.
  const LIMIT = P.limit || 150;
  let drawn = 0;
  let hidden = 0;
  for (const fam of order) {
    const list = short ? groups.get(fam) : groups.get(fam).sort((a, b) => b.supported - a.supported || a.name.localeCompare(b.name));
    if (!list.length) continue;
    parts.push(short ? `<div class="pg-h">${escapeHtml(fam)}</div>` : `<div class="pg-h">${logoTile(list[0].id)}${escapeHtml(fam)} <i>${list.length}</i></div>`);
    for (const m of list) {
      if (drawn >= LIMIT) { hidden++; continue; }
      drawn++;
      const i = P.items.push({ model: m }) - 1;
      const meta = short ? '' : [fmtCtx(m.context) && `<span title="How much it can read at once">${fmtCtx(m.context)}</span>`, fmtPrice(m) && `<span title="Price per million tokens, input/output">${fmtPrice(m)}</span>`].filter(Boolean).join('');
      const cur = m.id === S.settings.model;
      const blurb = m.id === 'auto' ? 'Island picks a good model for each request' : modelBlurb(m);
      parts.push(
        `<button class="pi${cur ? ' cur' : ''}${m.supported ? '' : ' na'}" data-i="${i}" title="${m.supported ? escapeHtml(m.id) : 'Not supported yet: this model needs the Chat Completions API, which Island doesn\'t use'}">` +
          logoTile(m.id) +
          `<span class="pm"><b>${escapeHtml(m.name)}</b><span>${escapeHtml(blurb)}${m.provider && m.provider !== 'router' && m.provider !== 'anthropic' ? `<i>via ${escapeHtml(m.provider)}</i>` : ''}</span></span>` +
          `<span class="meta">${meta}</span><span class="ck">${cur ? ICONS.check : ''}</span></button>`
      );
    }
  }
  if (short) parts.push(`<button class="more-ideas pick-all" id="pickAll"><span>See all ${models.length} models</span>${ICONS.chevron}</button>`);
  else if (hidden) parts.push(`<button class="more-ideas pick-all" id="pickMore"><span>Show ${hidden} more</span>${ICONS.chevron}</button>`);
  // Last: use the typed text as a model id (for models the gateway doesn't list).
  // The same rule the main process uses, so a custom id is never rejected afterwards.
  if (q && !exact && MODEL_ID_RE.test(P.q.trim())) {
    const i = P.items.push({ custom: P.q.trim() }) - 1;
    parts.push(`<div class="pg-h">Custom</div><button class="pi custom" data-i="${i}"><span class="pv">#</span><span class="pm"><b>Use “${escapeHtml(P.q.trim())}” as the model id</b><span>for models that aren't in the list</span></span></button>`);
  }
  $('pickerList').innerHTML = parts.join('') || `<div class="picker-empty">${P.all && !P.items.length ? `This service did not list any models. Type the model id below to use one.` : `No models match “${escapeHtml(P.q)}”.`}</div>`;
  $('pickAll')?.addEventListener('click', () => {
    P.all = true;
    renderPicker();
    $('pickerInput').focus();
  });
  $('pickMore')?.addEventListener('click', () => {
    P.limit = (P.limit || LIMIT) + 200;
    renderPicker();
    $('pickerInput').focus();
  });
  $('pickerList').querySelectorAll('.pi').forEach((b) => {
    b.onclick = () => choosePicker(+b.dataset.i);
    b.onmousemove = () => {
      if (P.sel !== +b.dataset.i) {
        P.sel = +b.dataset.i;
        markPickerSel(false);
      }
    };
  });
  P.sel = Math.min(P.sel, Math.max(0, P.items.length - 1));
  markPickerSel(true);

  const cur = models.find((m) => m.id === S.settings.model);
  // Every model gets the row. One that cannot think harder says so in the tooltip
  // instead of taking the row away.
  const canThink = !cur || cur.effort || !cur.caps || cur.caps.includes('reasoning');
  $('pickerFoot').innerHTML =
    `<span class="pf-l">How hard should it think?</span><div class="seg"${canThink ? '' : ' title="This model thinks the same amount every time."'}>${EFFORTS.map((e) => `<button data-e="${e}" title="${EFFORT_LABEL[e] || e}" class="${e === S.settings.effort ? 'on' : ''}">${e}</button>`).join('')}</div>`;
  $('pickerFoot').querySelectorAll('[data-e]').forEach((b) => (b.onclick = async () => {
    S.settings = await api.setSettings({ effort: b.dataset.e });
    renderModelChip();
    renderPicker();
  }));
}

function markPickerSel(scroll) {
  $('pickerList').querySelectorAll('.pi').forEach((b) => b.classList.toggle('sel', +b.dataset.i === P.sel));
  if (scroll) $('pickerList').querySelector('.pi.sel')?.scrollIntoView({ block: 'nearest' });
}

async function choosePicker(i) {
  const it = P.items[i];
  if (!it) return;
  if (it.model && !it.model.supported) {
    toast('Not supported yet: needs the Chat Completions API');
    return;
  }
  const id = it.custom || it.model.id;
  try {
    S.settings = await api.setSettings({ model: id });
  } catch (e) {
    toast(cleanIpcError(e));
    return;
  }
  renderModelChip();
  renderAgentBtn();
  closePicker();
  toast(`Model: ${it.model?.name || id}`);
  if (S.view === 'settings') showSettings();
}

$('pickerInput').addEventListener('input', (e) => {
  P.q = e.target.value;
  P.sel = 0;
  renderPicker();
});
$('pickerInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = P.items.length;
    if (!n) return;
    P.sel = (P.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    markPickerSel(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choosePicker(P.sel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePicker();
  }
});
document.addEventListener('mousedown', (e) => {
  if (P.open && !e.target.closest('#picker, #modelChip, .model-btn')) closePicker();
});

function toggleScreen() {
  S.attachScreen = !S.attachScreen;
  renderChips();
  updateSendBtn();
  input.focus();
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  const chip = (html, onRemove) => {
    const c = document.createElement('div');
    c.className = 'chip';
    c.innerHTML = html + `<button title="Remove">${ICONS.close}</button>`;
    c.querySelector('button').onclick = onRemove;
    box.appendChild(c);
  };
  if (S.attachScreen) chip(`${ICONS.screen}<span>Screen (captured on send)</span>`, () => toggleScreen());
  S.attachments.forEach((a, i) => {
    const preview = a.kind === 'image' ? `<img src="data:${a.mediaType};base64,${a.base64}">` : ICONS.file;
    chip(`${preview}<span>${escapeHtml(a.name)}</span>`, () => {
      S.attachments.splice(i, 1);
      renderChips();
      updateSendBtn();
    });
  });
}

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|kt|kts|c|h|cpp|hpp|cs|go|rs|rb|php|sh|ps1|bat|cmd|ini|cfg|conf|toml|ya?ml|sql|env|gradle|swift|lua|r|vue|svelte|srt|vtt|tex|properties)$/i;
// Read into text by Island itself (main process), so every model can use them.
const DOC_EXT = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|rtf)$/i;
const OLD_OFFICE = /\.(doc|xls|ppt)$/i;
const CAN_ATTACH = 'pictures, PDFs, Word, Excel, PowerPoint, text and code files';

// One file -> an attachment the main process understands (throws a friendly error otherwise).
async function readAttachment(file) {
  if (file.type.startsWith('image/')) {
    const { base64, mediaType } = await downscaleImage(file);
    return { kind: 'image', name: file.name || 'pasted image', base64, mediaType };
  }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 30 * 1024 * 1024) throw new Error(`${file.name} is larger than 30 MB`);
    return { kind: 'pdf', name: file.name, base64: await readBase64(file) };
  }
  if (DOC_EXT.test(file.name)) {
    if (file.size > 30 * 1024 * 1024) throw new Error(`${file.name} is larger than 30 MB`);
    return { kind: 'file', name: file.name, base64: await readBase64(file) };
  }
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
    if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} is larger than 2 MB`);
    return { kind: 'text', name: file.name, text: await file.text() };
  }
  if (OLD_OFFICE.test(file.name)) throw new Error(`${file.name} is an old Office file. Open it and use Save As → .${file.name.split('.').pop().toLowerCase()}x, then attach that`);
  throw new Error(`Can't attach ${file.name}. Island can read ${CAN_ATTACH}`);
}

async function addFile(file) {
  try {
    S.attachments.push(await readAttachment(file));
  } catch (e) {
    addNote(String(e.message || e), true);
  }
  renderChips();
  updateSendBtn();
}

function readBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function downscaleImage(file) {
  const bmp = await createImageBitmap(file);
  const max = 1568;
  if (bmp.width <= max && bmp.height <= max && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) && file.size < 4.5 * 1024 * 1024) {
    return { base64: await readBase64(file), mediaType: file.type };
  }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return { base64: c.toDataURL('image/jpeg', 0.88).split(',')[1], mediaType: 'image/jpeg' };
}

input.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await addFile(f);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (S.expanded && ++dragDepth === 1) island.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; island.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  island.classList.remove('dragging');
  for (const f of e.dataTransfer.files) await addFile(f);
});

// ---------------------------------------------------------------- slash commands

const COMMANDS = [
  { cmd: '/live', desc: 'Talk with Island hands-free', run: () => { input.value = ''; startLiveMode(); } },
  { cmd: '/translate', desc: 'Translate what is on your screen (Hindi ↔ English)', run: (rest) => { S.attachScreen = true; input.value = rest ? `Translate the text on my screen into ${rest}. Keep the meaning exact.` : 'Translate the main text on my screen into simple Hindi (if it is already in Hindi, into simple English). Keep the meaning exact.'; submit(); } },
  { cmd: '/screen', desc: 'Ask about what is on your screen', run: (rest) => { S.attachScreen = true; input.value = rest || ''; submit(); } },
  { cmd: '/record', desc: 'Show Island a task once so it can do it later', run: (rest) => { input.value = rest ? `I want to show you how I do this so you can do it for me next time. Record it as "${rest}".` : 'I want to show you how I do a task, so you can do it for me next time. It is: '; if (rest) submit(); else input.focus(); } },
  { cmd: '/routines', desc: 'Tasks you have shown Island', run: () => { input.value = 'Which routines have I shown you? List them briefly.'; submit(); } },
  { cmd: '/clip', desc: 'Ask about your clipboard', run: (rest) => { input.value = `Use my clipboard. ${rest || 'What is it and what should I do with it?'}`; submit(); } },
  { cmd: '/timer', desc: 'Set a timer, e.g. /timer 10m tea', run: (rest) => { input.value = `Set a timer: ${rest || '5 minutes'}`; submit(); } },
  { cmd: '/new', desc: 'Start a new chat', run: () => newChat(true) },
  { cmd: '/incognito', desc: 'New chat that is not saved and uses no memory', run: () => newChat(true, { incognito: true }) },
  { cmd: '/settings', desc: 'Model, hotkey, API key…', run: () => { input.value = ''; showSettings(); } },
];
let slashSel = 0;

function slashMatches() {
  const v = input.value;
  if (!v.startsWith('/') || v.includes(' ') || v.includes('\n')) return [];
  return COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase()));
}

function updateSlash() {
  const box = $('slash');
  const m = slashMatches();
  if (!m.length) return closeSlash();
  slashSel = Math.min(slashSel, m.length - 1);
  box.innerHTML = m.map((c, i) => `<div class="slash-item${i === slashSel ? ' sel' : ''}" data-i="${i}"><b>${c.cmd}</b><span>${c.desc}</span></div>`).join('');
  box.querySelectorAll('.slash-item').forEach((el) => (el.onmousedown = (e) => { e.preventDefault(); pickSlash(m[+el.dataset.i]); }));
  box.classList.add('open');
}
function closeSlash() { $('slash').classList.remove('open'); slashSel = 0; }
function pickSlash(c) {
  input.value = c.cmd + ' ';
  closeSlash();
  if (c.cmd === '/new' || c.cmd === '/settings') runSlash();
  input.focus();
}
function runSlash() {
  const [cmd, ...rest] = input.value.trim().split(/\s+/);
  const c = COMMANDS.find((x) => x.cmd === cmd.toLowerCase());
  if (!c) return false;
  input.value = '';
  autosize();
  c.run(rest.join(' '));
  return true;
}

// ---------------------------------------------------------------- keyboard

input.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    return cycleMode();
  }
  const sl = $('slash').classList.contains('open') ? slashMatches() : [];
  if (sl.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + sl.length) % sl.length;
    return updateSlash();
  }
  if (sl.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
    e.preventDefault();
    return pickSlash(sl[slashSel]);
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    return submit();
  }
  if (e.key === 'ArrowUp' && !input.value && S.promptHistory.length) {
    e.preventDefault();
    S.promptIdx = Math.min(S.promptIdx + 1, S.promptHistory.length - 1);
    input.value = S.promptHistory[S.promptHistory.length - 1 - S.promptIdx];
    autosize();
    updateSendBtn();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    // While Island is working, Escape stops it. That is what people expect, and the
    // stop button says so.
    if (S.busy) { api.stop(); return; }
    if (V.on) return stopListening('cancel');
    if (LIVE.on && S.view === 'live') return endLiveMode();
    Voice.hush();
    if (P.open) return closePicker();
    if ($('slash').classList.contains('open')) return closeSlash();
    if (S.view === 'settings' && !recordingHotkey) return showChat();
    if (S.view === 'chats') return showChat();
    if (!recordingHotkey) api.requestCollapse();
  } else if (e.key === 'F11') {
    e.preventDefault();
    api.toggleFull();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    LIVE.on ? endLiveMode() : startLiveMode();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    S.view === 'chats' ? showChat() : showChats();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    P.open ? closePicker() : openPicker();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat(true, { incognito: e.shiftKey });
  } else if (e.ctrlKey && e.key === ',') {
    e.preventDefault();
    showSettings();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    toggleScreen();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    input.focus();
  }
});

// ---------------------------------------------------------------- sending

async function submit(opts = {}) {
  if (S.busy) return;
  if (input.value.trim().startsWith('/') && runSlash()) return;
  const text = input.value.trim();
  if (!text && !S.attachments.length && !S.attachScreen) return;
  S.turnSpoken = !!opts.spoken;
  Voice.hush();

  // Spoken turns carry the language transcription heard; the reply and its voice follow it.
  const spokenLang = opts.spoken ? S.spokenLang || '' : '';
  Voice.Speaker.setLang(spokenLang);
  const payload = { text, attachments: S.attachments, attachScreen: S.attachScreen, live: !!opts.live, sharing: !!opts.sharing, spokenLang, carry: !!opts.carry };
  if (text && !S.incognito) {
    S.promptHistory = [...S.promptHistory.filter((p) => p !== text), text].slice(-50);
    localStorage.setItem('island.prompts', JSON.stringify(S.promptHistory));
  }
  S.promptIdx = -1;
  if (!opts.live) showChat();
  renderUser({ text, spoken: opts.spoken, images: S.attachments.filter((a) => a.kind === 'image').map((a) => `data:${a.mediaType};base64,${a.base64}`), files: S.attachments.filter((a) => a.kind !== 'image').map((a) => a.name), screen: S.attachScreen }).classList.add('enter');
  input.value = '';
  input.placeholder = PLACEHOLDERS[0];
  S.attachments = [];
  S.attachScreen = false;
  clearQuick();
  autosize();
  renderChips();
  renderEmpty();

  S.busy = true;
  S.activity = payload.attachScreen ? 'Capturing screen' : 'Thinking';
  setState('thinking');
  updateSendBtn();
  startLive();
  try {
    await api.send(payload);
  } catch (e) {
    finishTurn();
    addNote(cleanIpcError(e), true);
  }
}

function cleanIpcError(e) {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------------------------------------------------------- voice

const V = { on: false, busy: false, level: 0 };

function setWave(level) {
  V.level = level;
  for (const id of ['pillWave', 'fieldWave']) {
    $(id).querySelectorAll('i').forEach((bar, i, all) => {
      const mid = (all.length - 1) / 2;
      const shape = 1 - Math.abs(i - mid) / (mid + 1);
      const jitter = 0.65 + Math.random() * 0.35;
      bar.style.transform = `scaleY(${Math.max(0.12, Math.min(1, level * shape * 1.6 * jitter))})`;
    });
  }
}

// A microphone problem, explained where the user will see it (a toast is too short).
function micProblem(text) {
  toast('Microphone problem: see the note');
  if (LIVE.on) {
    LIVE.you = text;
    renderLiveCaptions();
  } else {
    showChat();
    addNote(text, true);
  }
}

async function startListening() {
  if (V.on || V.busy || S.busy) return;
  Voice.hush();
  try {
    await Voice.start({
      onLevel: setWave,
      onAutoStop: (reason) => stopListening(reason),
    });
  } catch (e) {
    micProblem(Voice.micError(e));
    return;
  }
  V.on = true;
  island.classList.add('listening');
  $('micBtn').classList.add('rec');
  S.activity = 'Listening';
  setState('listening');
}

async function stopListening(reason) {
  if (!V.on) return;
  V.on = false;
  V.busy = true;
  island.classList.remove('listening');
  $('micBtn').classList.remove('rec');
  setWave(0);
  try {
    const clip = await Voice.stop();
    if (reason === 'cancel') {
      setState('idle');
      return;
    }
    if (!clip?.speech || clip.seconds < 0.3) {
      setState('idle');
      if (clip && clip.peak < 0.0015) micProblem(`Island didn't get any sound from “${clip.label}”. Check that it isn't muted (some headsets and laptops have a mute key), or pick another microphone in Settings → Voice and press Test.`);
      else toast("Didn't hear anything. Try again a little closer to the mic");
      return;
    }
    S.activity = 'Transcribing';
    setState('thinking');
    const { text, lang } = heard(await api.transcribe(clip.wav));
    S.spokenLang = lang;
    if (!text) {
      setState('idle');
      toast("Couldn't make that out; try again");
      return;
    }
    setState('idle');
    input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
    autosize();
    submit({ spoken: true });
  } catch (e) {
    setState(S.expanded ? 'idle' : 'error');
    toast(cleanIpcError(e).slice(0, 80));
  } finally {
    V.busy = false;
  }
}

function toggleListening() {
  if (LIVE.on) return liveInterrupt();
  V.on ? stopListening() : startListening();
}

api.onVoiceToggle(toggleListening);
$('micBtn').onclick = toggleListening;
$('micBtn').innerHTML = ICONS.mic;

// ---------------------------------------------------------------- live conversation
// Hands-free back-and-forth: listen until you pause, transcribe, answer, speak the
// answer sentence by sentence as it streams, then listen again. Talking while Island
// speaks interrupts it.

const LIVE = { on: false, phase: 'off', you: '', ai: '', buf: '', turnDone: true, muted: false, micLevel: 0, raf: 0, share: false };
const LIVE_LABEL = {
  listening: 'Listening',
  hearing: 'Hearing you',
  transcribing: 'Got it',
  thinking: 'Thinking',
  speaking: 'Speaking. Talk to interrupt',
  muted: 'Microphone off',
};
// How long a pause ends your turn, and what may interrupt Island while it talks.
const LIVE_PAUSE = { quick: 0.6, normal: 0.9, patient: 1.6 };
const liveInterruptMode = () => S.settings.liveInterrupt || 'voice'; // 'voice' | 'tap' | 'off'
function speakingLabel() {
  return { voice: 'Speaking. Talk to interrupt', tap: 'Speaking. Tap the orb to interrupt', off: 'Speaking' }[liveInterruptMode()];
}
// "Look at this", "what's on my screen", "can you see"...: this turn needs a look.
const LOOK_WORDS = /\b(look(ing)? at|on (my|the) screen|my screen|can you see|see this|what('s| is) this|this (page|window|error|picture|image|thing)|right here)\b/i;

function setLivePhase(p) {
  const changed = LIVE.phase !== p;
  LIVE.phase = p;
  window.__livePhase = LIVE.on ? p : null;
  $('liveView').dataset.phase = p;
  const ph = $('lvPhase');
  ph.textContent = p === 'speaking' ? speakingLabel() : LIVE_LABEL[p] || '';
  if (changed) {
    ph.classList.remove('swap');
    void ph.offsetWidth;
    ph.classList.add('swap');
  }
  setState(p === 'thinking' || p === 'transcribing' ? 'thinking' : p === 'speaking' ? 'control' : 'listening');
  // Live orb: calm while waiting for you, brighter while thinking, livelier while talking;
  // the voice level (yours or Island's) is added on top every frame.
  ORBS.live.set(p === 'speaking' ? 'working' : 'thinking');
  S.activity = (LIVE.share ? 'Sharing screen. ' : '') + (LIVE_LABEL[p] || '');
  updatePill();
}

function renderLiveCaptions() {
  $('lvYou').textContent = LIVE.you;
  $('lvAi').textContent = Voice.plainForSpeech(LIVE.ai);
}

async function startLiveMode() {
  if (LIVE.on) return;
  if (S.busy) return toast('Wait for the current reply first');
  if (V.on) await stopListening('cancel');
  Voice.hush();
  try {
    await Voice.Live.open({
      onLevel: (l) => (LIVE.micLevel = l),
      onSpeechStart: () => {
        liveStreamBegin();
        if (LIVE.phase === 'listening') setLivePhase('hearing');
      },
      onCapture: liveStreamAudio,
      onUtterance: liveUtterance,
      onBargeIn: () => {
        liveStreamBegin();
        Voice.Speaker.stop();
        if (S.busy) api.stop();
        LIVE.turnDone = true;
        setLivePhase('hearing');
      },
      onSilentMic: (label) => micProblem(`Island isn't getting any sound from “${label}”. Check that it isn't muted, or pick another microphone in Settings → Voice and press Test.`),
    });
    Voice.Live.setPause(LIVE_PAUSE[S.settings.livePatience] || LIVE_PAUSE.normal);
  } catch (e) {
    micProblem(Voice.micError(e));
    return;
  }
  LIVE.on = true;
  LIVE.muted = false;
  LIVE.you = '';
  LIVE.ai = '';
  renderLiveCaptions();
  $('liveBtn').classList.add('on');
  showLiveView();
  Voice.Live.arm();
  setLivePhase('listening');
  const tick = () => {
    if (!LIVE.on) return;
    const level = LIVE.phase === 'speaking' ? Voice.Speaker.level() : LIVE.micLevel;
    ORBS.live.voice(level);
    LIVE.raf = requestAnimationFrame(tick);
  };
  tick();
}

async function endLiveMode() {
  if (!LIVE.on) return;
  LIVE.on = false;
  setLiveShare(false);
  window.__livePhase = null;
  cancelAnimationFrame(LIVE.raf);
  Voice.Speaker.stop();
  await Voice.Live.close();
  $('liveBtn').classList.remove('on');
  setState(S.busy ? 'thinking' : 'idle');
  showChat();
}

function liveListenAgain() {
  if (!LIVE.on || LIVE.phase === 'hearing') return;
  Voice.Live.bargeIn(false);
  if (LIVE.muted) return setLivePhase('muted');
  Voice.Live.arm();
  setLivePhase('listening');
}

// Streaming transcription (Deepgram): audio goes out from the moment you start talking, so
// when you stop only the last fraction of a second is left to transcribe. The live
// conversation follows its own transcription service when one is picked (Settings → Voice,
// Live conversation); Deepgram is the only one that can stream, everyone else batches.
function liveSttProvider() {
  const v = S.settings.liveSttProvider;
  return v && v !== 'same' ? v : (S.settings.sttProvider || 'gateway');
}
function liveStreamBegin() {
  if (liveSttProvider() !== 'deepgram') { LIVE.stream = null; return; }
  const s = (LIVE.stream = { ok: null, queue: [], ready: null });
  s.ready = api.sttStreamStart().then((ok) => {
    s.ok = !!ok;
    if (ok) for (const b of s.queue.splice(0)) api.sttStreamAudio(b);
    s.queue = [];
    return s.ok;
  }).catch(() => (s.ok = false));
}
// Deepgram heard the end of your sentence: answer now rather than after Island's own pause.
api.onSttEndpoint(() => { if (LIVE.on && LIVE.stream?.ok) Voice.Live.endTurn(); });
function liveStreamAudio(buf) {
  const s = LIVE.stream;
  if (!s || s.ok === false) return;
  if (s.ok) api.sttStreamAudio(buf);
  else s.queue.push(buf);
}
// The streamed transcript, or null to fall back to sending the whole clip.
async function liveStreamText() {
  const s = LIVE.stream;
  LIVE.stream = null;
  if (!s || !(await s.ready)) return null;
  try {
    const r = await api.sttStreamFinish();
    return r?.text ? r : null;
  } catch {
    return null;
  }
}

async function liveUtterance(wav, seconds) {
  if (!LIVE.on) return;
  if (seconds < 0.45) {
    if (LIVE.stream) { LIVE.stream = null; api.sttStreamAbort(); }
    return liveListenAgain();
  }
  // Timing of this turn, from the moment Island decided you'd finished speaking.
  LIVE.t = { end: performance.now() };
  Voice.Speaker.earcon();
  setLivePhase('transcribing');
  let text = '';
  let failed = '';
  try {
    const streamed = await liveStreamText();
    ({ text, lang: S.spokenLang } = streamed || heard(await api.transcribe(wav, { live: true })));
  } catch (e) {
    failed = cleanIpcError(e);
  }
  if (!LIVE.on) return;
  if (LIVE.t) LIVE.t.stt = performance.now();
  if (!text) {
    // Say why instead of silently going back to "Listening".
    LIVE.you = failed ? `Couldn't turn that into text: ${failed.slice(0, 140)}` : "Didn't catch that. Try again.";
    renderLiveCaptions();
    return liveListenAgain();
  }
  // A spoken reply to a question Island asked answers that question.
  if (Q.cur?.kind === 'question') {
    LIVE.you = text;
    renderLiveCaptions();
    $('prompt').firstElementChild?.liveAnswer?.(text);
    setLivePhase('thinking');
    return;
  }
  LIVE.you = text;
  LIVE.ai = '';
  LIVE.buf = '';
  LIVE.turnDone = false;
  renderLiveCaptions();
  setLivePhase('thinking');
  input.value = text;
  // Sharing: every turn sees the screen as it is now. Otherwise only when asked to look.
  if (LIVE.share || LOOK_WORDS.test(text)) S.attachScreen = true;
  submit({ spoken: true, live: true, sharing: LIVE.share });
}

// Speak complete sentences as soon as they stream in.
function liveFeed(t) {
  if (LIVE.t && !LIVE.t.text) LIVE.t.text = performance.now();
  LIVE.ai += t;
  LIVE.buf += t;
  renderLiveCaptions();
  let m;
  // Sentence ends: . ! ? … and the Hindi danda (। ॥) before a space, or the CJK full stops,
  // which have no space after them.
  while ((m = /^([\s\S]*?(?:[.!?…।॥]["')\]”’]*(?=\s)|[。！？]["」』）]*))(\s*)/.exec(LIVE.buf)) || (m = /^([^\n]*\S)\n+/.exec(LIVE.buf))) {
    const sentence = m[1];
    LIVE.buf = LIVE.buf.slice(m[0].length);
    if (sentence.trim().length > 1) liveSay(sentence);
  }
  // Nothing said yet and a long first sentence still streaming: start at its first comma
  // instead of waiting for the full stop (the opening words are what end the silence).
  if (!LIVE.t?.said && LIVE.buf.length > 60) {
    const c = /^([\s\S]{25,}?[,،、;:])\s/.exec(LIVE.buf);
    if (c) {
      LIVE.buf = LIVE.buf.slice(c[0].length);
      liveSay(c[1]);
    }
  }
}

function liveSay(sentence) {
  if (LIVE.t) LIVE.t.said = true;
  Voice.Speaker.say(sentence);
  if (LIVE.phase !== 'speaking' && LIVE.phase !== 'hearing') {
    setLivePhase('speaking');
    // Talking over Island interrupts it only in "voice" mode; coughs and background noise
    // can't cut it off in the other modes.
    Voice.Live.bargeIn(liveInterruptMode() === 'voice');
  }
}

// Interrupt Island (tap the orb, Space in the live view, or the talk hotkey): stop
// speaking or thinking and listen. Works in every interrupt mode except "off" (voice).
function liveInterrupt() {
  if (!LIVE.on) return false;
  if (LIVE.phase === 'speaking' || LIVE.phase === 'thinking' || LIVE.phase === 'transcribing') {
    Voice.Speaker.stop();
    if (S.busy) api.stop();
    LIVE.turnDone = true;
    LIVE.phase = 'interrupted';
    liveListenAgain();
    return true;
  }
  if (LIVE.phase === 'muted') {
    $('lvMute').click();
    return true;
  }
  return false;
}

// Let Island see the screen during the conversation; folds the island away so the
// screen is actually visible, and says so clearly while it lasts.
function setLiveShare(on) {
  LIVE.share = !!on;
  $('lvShare').classList.toggle('on', LIVE.share);
  $('lvShare').title = LIVE.share ? 'Stop sharing your screen' : 'Share your screen: Island sees it each time you speak';
  $('lvShareBadge').hidden = !LIVE.share;
  island.classList.toggle('live-sharing', LIVE.share);
  if (LIVE.on) setLivePhase(LIVE.phase);
}

function liveTurnEnded() {
  if (LIVE.buf.trim()) liveSay(LIVE.buf);
  LIVE.buf = '';
  LIVE.turnDone = true;
  if (!Voice.Speaker.busy()) liveListenAgain();
}

Voice.Speaker.onState((speaking) => {
  if (!speaking && LIVE.on && LIVE.turnDone) liveListenAgain();
});

function showLiveView() {
  closePicker();
  S.view = 'live';
  $('jumpBtn').hidden = true;
  $('settings').hidden = true;
  $('chatsView').hidden = true;
  $('empty').hidden = true;
  thread.hidden = true;
  $('liveView').hidden = false;
}

$('liveBtn').innerHTML = ICONS.live;
$('liveBtn').onclick = () => (LIVE.on ? (S.view === 'live' ? endLiveMode() : showLiveView()) : startLiveMode());
$('lvEnd').onclick = () => endLiveMode();
$('lvShare').innerHTML = ICONS.screen;
$('lvShare').onclick = () => {
  setLiveShare(!LIVE.share);
  toast(LIVE.share ? 'Island can see your screen while you talk' : 'Stopped sharing your screen');
  if (LIVE.share) setTimeout(() => api.requestCollapse(), 700);
};
$('lvFold').innerHTML = ICONS.chevron;
$('lvFold').onclick = () => api.requestCollapse(); // keeps talking; click the pill to come back
$('lvOrb').onclick = () => liveInterrupt();
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && S.view === 'live' && LIVE.on && document.activeElement === document.body) {
    e.preventDefault();
    liveInterrupt();
  }
});
$('lvMute').innerHTML = ICONS.mic;
$('lvMute').onclick = () => {
  LIVE.muted = !LIVE.muted;
  $('lvMute').innerHTML = LIVE.muted ? ICONS.micOff : ICONS.mic;
  $('lvMute').classList.toggle('off', LIVE.muted);
  if (LIVE.muted) {
    Voice.Live.disarm();
    Voice.Live.bargeIn(false);
    if (LIVE.phase === 'listening' || LIVE.phase === 'hearing') setLivePhase('muted');
  } else if (LIVE.phase === 'muted') liveListenAgain();
};

function newChat(focus, { incognito = false } = {}) {
  if (S.busy) api.stop();
  api.reset({ incognito });
  setIncognito(incognito);
  thread.innerHTML = '';
  S.live = null;
  $('usage').textContent = '';
  showChat();
  if (focus) input.focus();
}

// Incognito: the chat isn't saved and memory is neither used nor added to.
function setIncognito(on) {
  S.incognito = !!on;
  document.body.classList.toggle('incognito', S.incognito);
  $('incogTag').hidden = !S.incognito;
  $('incogBtn').classList.toggle('on', S.incognito);
  $('incogBanner').hidden = !S.incognito;
  input.placeholder = S.incognito ? 'Private chat: ask anything, nothing is kept' : PLACEHOLDERS[phIdx];
}

// ---------------------------------------------------------------- rendering

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function nearBottom() {
  return body.scrollHeight - body.scrollTop - body.clientHeight < 90;
}
function stick(wasNear) {
  if (wasNear) body.scrollTop = body.scrollHeight;
}

function renderUser({ text, images = [], files = [], screen, spoken, index, at }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user' + (spoken ? ' spoken' : '');
  wrap.dataset.text = text || '';
  const el = document.createElement('div');
  el.className = 'bubble';
  const att = [];
  images.forEach((src) => att.push(`<img src="${src}">`));
  if (screen) att.push(`<span class="f">Screen</span>`);
  files.forEach((f) => att.push(`<span class="f">${escapeHtml(f)}</span>`));
  el.innerHTML = (att.length ? `<div class="att">${att.join('')}</div>` : '') + (spoken ? `<span class="said">${ICONS.mic}</span>` : '') + escapeHtml(text || '');
  wrap.appendChild(el);
  wrap.appendChild(userActions(wrap));
  setMsgIndex(wrap, index, at ?? (index === undefined ? Date.now() : null));
  thread.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
  return wrap;
}

// ---------------------------------------------------------------- message actions
// Like Claude's: under your message the time, Copy, Edit, Retry and Branch; under Island's
// reply Copy and Retry. Edit and Retry cut the chat back to that message and send it again;
// Branch copies the chat up to that reply into a new chat.

function timeAgo(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', ...(new Date(at).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
setInterval(() => thread.querySelectorAll('.msg-time[data-at]').forEach((t) => (t.textContent = timeAgo(Number(t.dataset.at)))), 30000);

// Where the message sits in the chat (needed by Edit, Retry and Branch), and when it was sent.
function setMsgIndex(el, index, at) {
  if (index !== undefined && index !== null) el.dataset.index = index;
  const t = el.querySelector('.msg-time');
  if (at) { t.dataset.at = at; t.textContent = timeAgo(at); t.title = new Date(at).toLocaleString(); }
}

function userActions(wrap) {
  const row = document.createElement('div');
  row.className = 'msg-acts';
  row.innerHTML = `<span class="msg-time"></span>
    <button data-a="copy" title="Copy" aria-label="Copy message">${ICONS.copy}</button>
    <button data-a="edit" title="Edit and send again" aria-label="Edit message">${ICONS.edit}</button>
    <button data-a="retry" title="Retry: send this again for a new reply" aria-label="Retry">${ICONS.retry}</button>
    <button data-a="branch" title="Branch: continue from here in a new chat" aria-label="Branch into a new chat">${ICONS.branch}</button>`;
  row.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const index = wrap.dataset.index === undefined ? null : Number(wrap.dataset.index);
    const a = b.dataset.a;
    if (a === 'copy') {
      navigator.clipboard.writeText(wrap.dataset.text || '');
      b.innerHTML = ICONS.check;
      setTimeout(() => (b.innerHTML = ICONS.copy), 1200);
      return;
    }
    if (index === null) return toast('One moment, still saving this message');
    if (a === 'edit') editMessage(wrap, index);
    else if (a === 'retry') resend(index, wrap.dataset.text || '');
    else if (a === 'branch') branchFrom(index);
  });
  return row;
}

// Cut the chat back to message `index` and send `text` in its place (attachments are kept).
async function resend(index, text) {
  if (S.busy) return toast('Wait for the reply to finish, or stop it first');
  try {
    const { items } = await api.rewind(index);
    renderHistory(items);
    input.value = text;
    autosize();
    submit({ carry: true });
  } catch (e) {
    toast(cleanIpcError(e).slice(0, 90));
  }
}

// Edit in place: the bubble becomes a text box with Cancel and Send.
function editMessage(wrap, index) {
  if (S.busy) return toast('Wait for the reply to finish, or stop it first');
  if (wrap.classList.contains('editing')) return;
  wrap.classList.add('editing');
  const box = document.createElement('div');
  box.className = 'msg-edit';
  box.innerHTML = `<textarea class="field" rows="3" spellcheck="true"></textarea><div class="msg-edit-btns"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn mint" data-a="send">Send</button></div>`;
  const ta = box.querySelector('textarea');
  ta.value = wrap.dataset.text || '';
  wrap.appendChild(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const close = () => { box.remove(); wrap.classList.remove('editing'); };
  const send = () => { const t = ta.value.trim(); close(); if (t) resend(index, t); };
  box.querySelector('[data-a="cancel"]').onclick = close;
  box.querySelector('[data-a="send"]').onclick = send;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
}

async function branchFrom(index) {
  if (S.busy) return toast('Wait for the reply to finish, or stop it first');
  try {
    const { items } = await api.branchChat(index);
    renderHistory(items);
    toast('Branched into a new chat');
  } catch (e) {
    toast(cleanIpcError(e).slice(0, 90));
  }
}

// Messages sent this session learn their place in the chat once the reply is saved.
async function syncMsgIndices() {
  const { items } = await api.history().catch(() => ({ items: [] }));
  const users = items.filter((it) => it.role === 'user');
  const els = thread.querySelectorAll('.msg.user');
  if (users.length !== els.length) return;
  els.forEach((el, i) => setMsgIndex(el, users[i].index, users[i].at || Number(el.querySelector('.msg-time')?.dataset.at) || null));
}

// Em dashes read as "AI wrote this" and many people dislike them; models keep using them
// even when told not to. Turn them into commas in prose (code is left alone).
function tidyProse(md) {
  return String(md).split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => {
    if (i % 2) return part; // code
    return part
      .replace(/(\S)[ \t]*—[ \t]*(?=\S)/g, '$1, ')
      .replace(/,\s*,/g, ',')
      .replace(/,\s*([.!?:;])/g, '$1');
  }).join('');
}

function renderMarkdown(el, raw, streaming) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(tidyProse(raw)));
  el.querySelectorAll('pre').forEach((pre) => {
    const b = document.createElement('button');
    b.className = 'copy';
    b.textContent = 'Copy';
    b.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
      b.textContent = 'Copied';
      b.classList.add('done');
      setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
    };
    pre.appendChild(b);
  });
  if (streaming) (el.lastElementChild || el).insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
}

// Links in the app (a reply, or a service's page in the settings) open in the browser,
// never inside Island's own window.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  api.openExternal(a.getAttribute('href'));
});

function makeThinking(text, done, seconds) {
  const d = document.createElement('details');
  d.className = 'thinking';
  d.innerHTML = `<summary>${ICONS.brain}<span></span></summary><div class="tbody"></div>`;
  d.querySelector('.tbody').textContent = text || '';
  setThinkingLabel(d, done, seconds);
  return d;
}
function setThinkingLabel(d, done, seconds) {
  const s = d.querySelector('summary span');
  s.textContent = done ? (seconds ? `Thought for ${seconds}s` : 'Thought process') : 'Thinking…';
  s.classList.toggle('shimmer', !done);
}

// Tools whose call is drawn as something else (a plan card, a question card, a result card).
const QUIET_TOOLS = new Set(['update_plan', 'ask_user', 'hand_over', 'finish_task']);

// End-of-task result: what Island checked, so "done" means done.
const RESULT_LOOK = { done: ['circleCheck', 'Done', 'ok'], partly: ['alert', 'Partly done', 'warn'], failed: ['x', "Couldn't finish", 'bad'] };
function makeResult({ status, checked, summary }) {
  const [icon, label, cls] = RESULT_LOOK[status] || RESULT_LOOK.partly;
  const el = document.createElement('div');
  el.className = `task-result ${cls}`;
  el.innerHTML = `<span class="tr-ic">${ICONS[icon]}</span><div class="tr-b"><b></b><span class="tr-s"></span><span class="tr-c"></span></div>`;
  el.querySelector('b').textContent = label;
  el.querySelector('.tr-s').textContent = summary || '';
  el.querySelector('.tr-c').textContent = checked ? `Checked: ${checked}` : '';
  return el;
}

function makeTool({ id, name, summary, status = 'pending', undoId = null }) {
  const el = document.createElement('div');
  const mcp = /^mcp__/.test(name);
  el.className = 'tool' + (mcp ? ' mcp' : '');
  el.dataset.id = id;
  const icon = mcp ? ICONS.plug : ICONS[TOOL_ICONS[name]] || ICONS.circleDot;
  el.innerHTML = `<div class="tool-row"><span class="ti">${icon}</span><span class="ts"></span>${mcp ? '<span class="badge">MCP</span>' : ''}<span class="tm"></span><span class="st"></span></div><div class="sources"></div><div class="tool-detail"></div>`;
  el.querySelector('.ts').textContent = summary || name;
  el.querySelector('.tool-row').onclick = () => el.querySelector('.tool-detail').childElementCount && el.classList.toggle('open');
  setToolStatus(el, status);
  if (undoId) addUndo(el, undoId);
  return el;
}

// An "Undo" button on a tool row whose change can be reversed (files, folders).
function addUndo(el, undoId) {
  if (el.querySelector('.undo-btn')) return;
  const b = document.createElement('button');
  b.className = 'undo-btn';
  b.innerHTML = `${ICONS.undo}<span>Undo</span>`;
  b.title = 'Reverse this change';
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try {
      const r = await api.activityUndo(undoId);
      toast(r.message.slice(0, 90));
      b.innerHTML = `${ICONS.check}<span>Undone</span>`;
      b.classList.add('done');
    } catch (err) {
      toast(cleanIpcError(err).slice(0, 90));
      b.disabled = false;
    }
  };
  el.querySelector('.tool-row').insertBefore(b, el.querySelector('.tool-row .tm'));
}
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
function setToolStatus(el, status, ms) {
  el.classList.remove('done', 'error', 'running');
  el.classList.add(status);
  el.querySelector('.st').innerHTML = status === 'done' ? ICONS.check : status === 'error' ? ICONS.x : '<div class="spinner"></div>';
  const tm = el.querySelector('.tm');
  if (tm && ms != null) tm.textContent = fmtMs(ms);
}
function setSources(el, sources = [], error) {
  const box = el.querySelector('.sources');
  box.innerHTML = '';
  if (error) {
    setToolStatus(el, 'error');
    el.querySelector('.ts').textContent += ` — ${error}`;
    return;
  }
  for (const s of sources) {
    const a = document.createElement('a');
    a.href = s.url;
    a.title = s.title || s.url;
    try { a.textContent = new URL(s.url).hostname.replace(/^www\./, ''); } catch { a.textContent = s.url; }
    box.appendChild(a);
  }
}
// Every page an answer drew on, in one numbered list at its end (each search step still shows
// its own). Only pages Island actually got back are listed, never ones the model just named.
function addSourcesPanel(el) {
  el.querySelector(':scope > .src-panel')?.remove();
  const seen = new Map();
  for (const a of el.querySelectorAll('.sources a')) if (!seen.has(a.href)) seen.set(a.href, a.title || a.textContent);
  if (!seen.size) return;
  const box = document.createElement('div');
  box.className = 'src-panel';
  box.innerHTML = `<b>${ICONS.globe}<span>Sources</span></b><ol></ol>`;
  for (const [href, title] of seen) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = href;
    a.textContent = title;
    const host = document.createElement('span');
    try { host.textContent = new URL(href).hostname.replace(/^www\./, ''); } catch { host.textContent = ''; }
    li.append(a, host);
    box.querySelector('ol').appendChild(li);
  }
  el.appendChild(box);
}

function webSummary(name, inputObj) {
  if (name === 'web_search') return inputObj?.query ? `Searched “${inputObj.query}”` : 'Searching the web';
  if (name === 'web_fetch') {
    try { return `Read ${new URL(inputObj.url).hostname.replace(/^www\./, '')}`; } catch { return 'Reading page'; }
  }
  return name;
}

// ---------------------------------------------------------------- computer-use timeline

function makeGroup() {
  const g = document.createElement('div');
  g.className = 'cgroup running';
  g.innerHTML = `<div class="cg-head"><span class="cg-ic">${ICONS.cursor}</span><b>Using your computer</b><span class="cg-count"></span><span class="spacer"></span><span class="st"><div class="spinner"></div></span><span class="cg-chev">${ICONS.chevron}</span></div>
    <div class="cg-screen"><img alt="Latest screenshot" /><span class="live"><i></i>Live</span></div>
    <div class="cg-steps"></div>`;
  g.querySelector('.cg-head').onclick = () => g.classList.toggle('folded');
  g.querySelector('.cg-screen').onclick = () => g.classList.toggle('big');
  return g;
}

function groupFor(container) {
  const last = container.lastElementChild;
  if (last?.classList.contains('cgroup')) return last;
  const g = makeGroup();
  container.appendChild(g);
  return g;
}

function addStep(group, { id, name, summary, status = 'pending' }) {
  const s = document.createElement('div');
  s.dataset.id = id;
  s.dataset.name = name;
  s.innerHTML = `<span class="si">${ICONS[STEP_ICONS[name]] || ICONS.cursor}</span><span class="sl"></span><span class="tm"></span><span class="st"></span>`;
  s.querySelector('.sl').textContent = summary;
  setStepStatus(s, status);
  const list = group.querySelector('.cg-steps');
  list.appendChild(s);
  list.scrollTop = list.scrollHeight;
  const n = group.querySelectorAll('.cstep').length;
  group.querySelector('.cg-count').textContent = `${n} step${n === 1 ? '' : 's'}`;
  return s;
}

function addGroupNote(group, text = '') {
  const n = document.createElement('div');
  n.className = 'cnote';
  n.textContent = text;
  const list = group.querySelector('.cg-steps');
  list.appendChild(n);
  list.scrollTop = list.scrollHeight;
  return n;
}

function setStepStatus(s, status, ms) {
  s.className = `cstep ${status}`;
  s.querySelector('.st').innerHTML = status === 'done' ? ICONS.check : status === 'error' ? ICONS.x : '<i class="beat"></i>';
  if (ms != null) s.querySelector('.tm').textContent = fmtMs(ms);
}

// ---------------------------------------------------------------- plan
// The model's checklist for a multi-step task (update_plan). One card per turn,
// updated in place; the pill shows the same progress as dots.

function makePlan(steps) {
  const el = document.createElement('div');
  el.className = 'plan';
  el.innerHTML = `<div class="plan-h">${ICONS.plan}<span>Plan</span><span class="n"></span></div><div class="plan-bar"><i></i></div><div class="plan-list"></div>`;
  updatePlanEl(el, steps);
  return el;
}

function updatePlanEl(el, steps) {
  const done = steps.filter((s) => s.status === 'done').length;
  el.querySelector('.n').textContent = `${done}/${steps.length}`;
  el.querySelector('.plan-bar i').style.width = `${steps.length ? (100 * done) / steps.length : 0}%`;
  const list = el.querySelector('.plan-list');
  steps.forEach((st, i) => {
    let row = list.children[i];
    if (!row) {
      row = document.createElement('div');
      row.innerHTML = '<span class="pc"></span><span></span>';
      row.style.animation = 'slide-in 0.4s var(--spring) both';
      list.appendChild(row);
    }
    const cls = `plan-i ${st.status || 'pending'}`;
    if (row.className !== cls) {
      row.className = cls;
      row.querySelector('.pc').innerHTML = st.status === 'done' ? ICONS.check : '';
    }
    row.lastElementChild.textContent = st.title;
  });
  while (list.children.length > steps.length) list.lastElementChild.remove();
}

function renderPillPlan() {
  const box = $('pillPlan');
  const steps = S.plan?.steps || [];
  box.innerHTML = steps.slice(0, 10).map((s) => `<i class="${s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : ''}"></i>`).join('');
  updatePill();
}

function onPlan(steps) {
  S.plan = { steps };
  const L = S.live;
  if (L) {
    if (!L.planEl) {
      L.planEl = makePlan(steps);
      L.el.appendChild(L.planEl);
      addPlanApproval(L.planEl);
    } else updatePlanEl(L.planEl, steps);
  }
  renderPillPlan();
}

// "OK all steps": Island carries out this plan without asking at each step. It still asks
// before deleting anything, before commands that remove or switch things off, and after
// it has read a web page or connector result (which could hide instructions).
function addPlanApproval(planEl) {
  if ((S.settings.permissionMode || 'ask') === 'bypass') return;
  const b = document.createElement('button');
  b.className = 'btn ghost plan-ok';
  b.innerHTML = `${ICONS.check}<span>OK all steps</span>`;
  b.title = 'Let Island do this plan without asking at each step. It still asks before deleting anything.';
  b.onclick = async () => {
    b.disabled = true;
    await api.approvePlan().catch(() => {});
    b.innerHTML = `${ICONS.check}<span>Approved: Island won't ask at each step</span>`;
    b.classList.add('done');
    // A question for a step of this plan already on screen: answer it too, if the plan's OK
    // covers it (Island marks those; never deletes or commands that remove things).
    const card = $('prompt').firstElementChild;
    if (card && Q.cur?.planOk) card.querySelector('[data-a="1"]')?.click();
  };
  planEl.appendChild(b);
}

// Lesson steps are read aloud (slowly enough to follow) unless turned off.
function speakTeach() {
  const t = S.teach;
  if (!t || S.settings.teachVoice === false) return;
  Voice.Speaker.stop();
  for (const part of [t.instruction, t.detail]) {
    const plain = Voice.plainForSpeech(part || '');
    if (plain.trim()) Voice.Speaker.say(plain);
  }
}

// "Remembered …" chips under a reply, with undo.
function addMemNote(items) {
  for (const m of items) {
    const n = document.createElement('div');
    n.className = 'note mem enter';
    n.innerHTML = `${ICONS.brain}<span></span>${m.updated ? '' : '<button>Undo</button>'}`;
    n.querySelector('span').textContent = `${m.updated ? 'Updated memory' : 'Remembered'}: ${m.text}`;
    if (!m.updated) n.querySelector('button').onclick = async () => {
      await api.memoryRemove(m.id);
      n.remove();
      toast('Forgotten');
    };
    (thread.lastElementChild?.classList.contains('assistant') ? thread.lastElementChild : thread).appendChild(n);
  }
  stick(nearBottom());
}

// "Used 2 memories" under a reply: tap to see which, and forget any that are wrong.
function addMemUsed(items, el) {
  el = el || [...thread.querySelectorAll('.msg.assistant')].pop();
  if (!el || !items?.length) return;
  el.querySelector(':scope > .memused')?.remove();
  const box = document.createElement('div');
  box.className = 'memused';
  box.innerHTML = `<button class="mu-chip" title="Memories Island used for this reply">${ICONS.brain}<span>Used ${items.length === 1 ? '1 memory' : `${items.length} memories`}</span>${ICONS.chevron}</button><div class="mu-list"></div>`;
  const list = box.querySelector('.mu-list');
  const count = () => list.children.length;
  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'mu-row';
    row.innerHTML = `<span class="mi">${ICONS[(MEM_CATS[m.category] || MEM_CATS.fact)[0]]}</span><span class="mu-t"></span><button class="btn link" title="Forget this memory">Forget</button>`;
    row.querySelector('.mu-t').textContent = m.text;
    row.querySelector('button').onclick = async () => {
      await api.memoryRemove(m.id);
      row.remove();
      toast('Forgotten');
      if (!count()) box.remove();
      else box.querySelector('.mu-chip span').textContent = `Used ${count() === 1 ? '1 memory' : `${count()} memories`}`;
    };
    list.appendChild(row);
  }
  box.querySelector('.mu-chip').onclick = () => box.classList.toggle('open');
  el.appendChild(box);
}

// Sensitive facts learned in the background wait here for a yes.
function addMemSuggest(items) {
  for (const m of items) {
    const n = document.createElement('div');
    n.className = 'note mem ask enter';
    n.innerHTML = `${ICONS.shield}<span></span><button class="ms-yes">Save</button><button class="ms-no">No</button>`;
    n.querySelector('span').textContent = `${m.id ? 'Update memory' : 'Remember'}${m.sensitive ? ` (${m.sensitive})` : ''}? ${m.text}`;
    n.title = m.sensitive ? `This looks like ${m.sensitive}, so Island asks before keeping it.` : 'You chose to OK each memory.';
    n.querySelector('.ms-yes').onclick = async () => {
      try {
        if (m.id) await api.memoryUpdate(m.id, { text: m.text });
        else await api.memoryAdd(m.text, m.category);
        n.innerHTML = `${ICONS.brain}<span>Remembered</span>`;
        setTimeout(() => n.remove(), 1600);
      } catch (e) {
        toast(cleanIpcError(e).slice(0, 90));
      }
    };
    n.querySelector('.ms-no').onclick = () => n.remove();
    (thread.lastElementChild?.classList.contains('assistant') ? thread.lastElementChild : thread).appendChild(n);
  }
  stick(nearBottom());
}

function setGroupShot(group, src) {
  group.querySelector('.cg-screen img').src = src;
  group.classList.add('has-shot');
}

function finishGroups(container) {
  container.querySelectorAll('.cgroup.running').forEach((g) => {
    g.classList.remove('running');
    g.querySelectorAll('.cstep.pending, .cstep.running').forEach((s) => setStepStatus(s, 'error'));
    const err = g.querySelector('.cstep.error');
    g.classList.toggle('error', !!err);
    g.querySelector('.cg-head .st').innerHTML = err ? ICONS.x : ICONS.check;
  });
}

function addNote(text, err) {
  const n = document.createElement('div');
  n.className = 'note' + (err ? ' err' : '');
  n.textContent = text;
  (S.live?.el || thread).appendChild(n);
  if (S.view === 'live') {
    if (err) toast(text.slice(0, 90));
    return n;
  }
  showChat();
  stick(true);
  return n;
}

// History from disk
async function loadHistory() {
  const { items, incognito } = await api.history();
  setIncognito(incognito);
  renderHistory(items);
}

function renderHistory(items) {
  thread.innerHTML = '';
  S.live = null;

  for (const it of items) {
    if (it.role === 'user') {
      renderUser(it);
      continue;
    }
    const el = makeAssistantEl();
    for (const b of it.blocks) {
      if (b.type === 'thinking') {
        const group = el.lastElementChild?.classList.contains('cgroup') ? el.lastElementChild.querySelector('.cg-steps') : el;
        group.appendChild(makeThinking(b.text, true));
      } else if (b.type === 'text') {
        const md = document.createElement('div');
        md.className = 'md';
        renderMarkdown(md, b.text, false);
        el.appendChild(md);
      } else if (b.type === 'tool' && b.toolset === 'computer') addStep(groupFor(el), b);
      else if (b.type === 'plan') {
        const old = el.querySelector(':scope > .plan');
        if (old) updatePlanEl(old, b.steps);
        else el.appendChild(makePlan(b.steps));
      } else if (b.type === 'asked') {
        const n = document.createElement('div');
        n.className = 'qrec';
        n.innerHTML = `${ICONS.question}<span><b></b> <span></span></span>`;
        n.querySelector('b').textContent = b.question;
        n.querySelector('span span').textContent = b.answer || '';
        el.appendChild(n);
      } else if (b.type === 'result') el.appendChild(makeResult(b));
      else if (b.type === 'tool') el.appendChild(makeTool({ ...b }));
      else if (b.type === 'web') {
        const t = makeTool({ id: b.id, name: b.name, summary: webSummary(b.name, b.input), status: 'done' });
        setSources(t, b.sources);
        el.appendChild(t);
      }
    }
    finishGroups(el);
    addSourcesPanel(el);
    thread.appendChild(el);
    if (it.memUsed?.length) addMemUsed(it.memUsed, el);
  }
  // A whole saved chat appears at once; animating every block of it would stutter.
  for (const n of thread.children) n.classList.add('no-anim');
  renderEmpty();
  body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------- live agent stream

function startLive() {
  const el = makeAssistantEl();
  thread.appendChild(el);
  S.live = { el, blocks: new Map(), thinkStart: new Map(), pendingRender: new Set(), raf: 0 };
}

// Assistant turn container: a small header (name + copy) and the content blocks.
function makeAssistantEl() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<span class="mini-orb"></span><span>Island</span><button class="msg-copy" title="Copy reply" aria-label="Copy reply">${ICONS.copy}</button><button class="msg-copy msg-retry" title="Retry: ask again for a new reply" aria-label="Retry">${ICONS.retry}</button>`;
  head.querySelector('.msg-copy').onclick = (e) => {
    const text = [...el.querySelectorAll(':scope > .md')].map((m) => m.innerText.replace(/\nCopy$/gm, '')).join('\n\n').trim();
    navigator.clipboard.writeText(text);
    e.currentTarget.innerHTML = ICONS.check;
    setTimeout(() => (head.querySelector('.msg-copy').innerHTML = ICONS.copy), 1200);
  };
  // Retry the question this reply answers (its user message comes just before it).
  head.querySelector('.msg-retry').onclick = () => {
    let u = el.previousElementSibling;
    while (u && !u.classList.contains('user')) u = u.previousElementSibling;
    if (u?.dataset.index) resend(Number(u.dataset.index), u.dataset.text || '');
  };
  el.appendChild(head);
  return el;
}

function liveBlock(key) {
  return S.live?.blocks.get(key);
}

function scheduleRender(key) {
  const L = S.live;
  L.pendingRender.add(key);
  if (L.raf) return;
  // Re-parsing the whole reply is the expensive part; ~20 times a second reads as smooth.
  L.raf = setTimeout(() => {
    const wasNear = nearBottom();
    for (const k of L.pendingRender) {
      const b = L.blocks.get(k);
      if (b?.type === 'text') renderMarkdown(b.el, b.raw, true);
    }
    L.pendingRender.clear();
    L.raf = 0;
    stick(wasNear);
  }, 50);
}

function finalizeThinking(except) {
  for (const [k, b] of S.live?.blocks || []) {
    if (b.type !== 'thinking' || b.done || k === except) continue;
    b.done = true;
    if (!b.raw.trim()) {
      b.el.remove();
      continue;
    }
    if (!b.note) setThinkingLabel(b.el, true, Math.max(1, Math.round((Date.now() - b.start) / 1000)));
  }
}

function finalizeText() {
  // A frame queued by the last text chunk would redraw the streaming cursor after this.
  if (S.live?.raf) {
    clearTimeout(S.live.raf);
    S.live.raf = 0;
    S.live.pendingRender.clear();
  }
  for (const [, b] of S.live?.blocks || []) if (b.type === 'text') renderMarkdown(b.el, b.raw, false);
}

function findTool(id) {
  return thread.querySelector(`.tool[data-id="${CSS.escape(id)}"], .cstep[data-id="${CSS.escape(id)}"]`);
}

api.onAgentEvent((ev) => {
  if (ev.kind === 'chats') return renderChats(); // list changed (saved / auto-titled)
  if (ev.kind === 'memory-auto') return addMemNote(ev.items || []); // after the turn, from background extraction
  if (ev.kind === 'memory-suggest') return addMemSuggest(ev.items || []);
  if (ev.kind === 'memory-used') return addMemUsed(ev.items || [], S.live?.el);
  if (ev.kind === 'teach-again') return speakTeach(); // "Show me again" on the coach card
  if (ev.kind === 'task-result') {
    const host = S.live?.el || [...thread.querySelectorAll('.msg.assistant')].pop();
    if (host) {
      host.querySelector(':scope > .task-result')?.remove();
      const r = makeResult(ev);
      r.classList.add('enter');
      host.appendChild(r);
      stick(nearBottom());
    }
    if (LIVE.on && ev.status !== 'done') Voice.Speaker.say(ev.status === 'failed' ? "I couldn't finish that." : 'I only got part of that done.');
    return;
  }
  if (LIVE.on) {
    if (ev.kind === 'text') liveFeed(ev.text);
    else if (ev.kind === 'done' || ev.kind === 'error' || ev.kind === 'refusal') {
      if (ev.kind !== 'done') LIVE.ai = ev.kind === 'error' ? ev.message : 'That request was declined.';
      renderLiveCaptions();
      liveTurnEnded();
    }
  }
  if (!S.live && ev.kind !== 'done' && ev.kind !== 'error') startLive();
  const L = S.live;
  const wasNear = nearBottom();

  switch (ev.kind) {
    case 'turn-start':
      break;

    case 'block-start': {
      finalizeThinking(ev.key);
      const inGroup = L.el.lastElementChild?.classList.contains('cgroup');
      if (ev.type === 'text') {
        // A reply that quotes its sources arrives in pieces (plain, cited, plain…); a piece
        // right after another one carries on the same paragraph instead of starting a new one.
        const prev = [...L.blocks.values()].pop();
        if (prev?.type === 'text' && prev.el === L.el.lastElementChild) {
          L.blocks.set(ev.key, prev);
          break;
        }
        const el = document.createElement('div');
        el.className = 'md';
        L.el.appendChild(el);
        L.blocks.set(ev.key, { type: 'text', el, raw: '' });
        S.activity = 'Writing';
        setState('thinking');
      } else if (ev.type === 'thinking') {
        // Reasoning stays folded away ("Thought for 3s"), also between computer steps, so it
        // never reads as something Island is telling the user.
        const el = makeThinking('', false);
        (inGroup ? L.el.lastElementChild.querySelector('.cg-steps') : L.el).appendChild(el);
        L.blocks.set(ev.key, { type: 'thinking', el, raw: '', start: Date.now(), note: false });
        S.activity = 'Thinking';
        if (S.state !== 'control') setState('thinking');
      } else if (ev.type === 'tool_use' && ev.toolset === 'computer') {
        const el = addStep(groupFor(L.el), { id: ev.id, name: ev.name, summary: 'Planning…' });
        L.blocks.set(ev.key, { type: 'tool', el });
      } else if (ev.type === 'tool_use' && QUIET_TOOLS.has(ev.name)) {
        L.blocks.set(ev.key, { type: 'quiet' }); // drawn as a plan card / question card instead
      } else if (ev.type === 'tool_use') {
        const el = makeTool({ id: ev.id, name: ev.name, summary: 'Preparing…' });
        L.el.appendChild(el);
        L.blocks.set(ev.key, { type: 'tool', el });
      } else if (ev.type === 'server_tool_use') {
        const el = makeTool({ id: ev.id, name: ev.name, summary: ev.name === 'web_fetch' ? 'Reading page' : 'Searching the web' });
        L.el.appendChild(el);
        L.blocks.set(ev.key, { type: 'tool', el });
        S.activity = ev.name === 'web_fetch' ? 'Reading a page' : 'Searching the web';
        setState('tool');
      }
      break;
    }

    case 'text': {
      const b = liveBlock(ev.key);
      if (!b) break;
      b.raw += ev.text;
      S.activity = b.raw.replace(/\s+/g, ' ').slice(-60);
      updatePill();
      scheduleRender(ev.key);
      break;
    }

    case 'thinking': {
      const b = liveBlock(ev.key);
      if (!b) break;
      b.raw += ev.text;
      if (b.note) b.el.textContent = b.raw.trim();
      else b.el.querySelector('.tbody').textContent = b.raw;
      const lastLine = b.raw.trim().split('\n').pop();
      if (lastLine) S.activity = lastLine.slice(0, 70);
      updatePill();
      break;
    }

    case 'tool-call': {
      const t = findTool(ev.id);
      if (t) (t.querySelector('.ts') || t.querySelector('.sl')).textContent = ev.summary;
      break;
    }

    case 'server-tool': {
      const t = findTool(ev.id);
      if (t) t.querySelector('.ts').textContent = webSummary(ev.name, ev.input);
      break;
    }

    case 'server-tool-result': {
      const t = findTool(ev.toolUseId);
      if (t) {
        setToolStatus(t, ev.error ? 'error' : 'done');
        setSources(t, ev.sources, ev.error);
      }
      setState('thinking');
      break;
    }

    case 'tool-status': {
      const t = findTool(ev.id);
      if (!t) break;
      if (ev.toolset === 'computer') {
        t.querySelector('.sl').textContent = ev.summary;
        setStepStatus(t, ev.status, ev.ms);
        if (ev.preview && ev.status === 'error') t.title = ev.preview;
        if (ev.image) setGroupShot(t.closest('.cgroup'), ev.image);
        if (ev.status === 'running') {
          S.activity = ev.summary;
          if (S.state !== 'approval') setState('control');
        }
        break;
      }
      t.querySelector('.ts').textContent = ev.summary;
      setToolStatus(t, ev.status, ev.ms);
      if (ev.undoId) addUndo(t, ev.undoId);
      if (ev.sources?.length) setSources(t, ev.sources);
      if (ev.status === 'running') {
        S.activity = ev.summary;
        if (S.state !== 'approval') setState('tool');
      } else {
        const det = t.querySelector('.tool-detail');
        det.innerHTML = '';
        if (ev.image) {
          const img = document.createElement('img');
          img.src = ev.image;
          det.appendChild(img);
        }
        if (ev.preview) {
          const pre = document.createElement('pre');
          pre.textContent = ev.preview;
          det.appendChild(pre);
        }
        if (S.state === 'tool') setState('thinking');
      }
      break;
    }

    case 'note':
      addNote(ev.text);
      break;

    case 'plan':
      onPlan(ev.steps || []);
      break;

    case 'teach': // a lesson step is on screen, waiting for the learner
      S.teach = { ...ev, waiting: true };
      S.activity = `Step ${ev.step}${ev.total ? ` of ${ev.total}` : ''}: ${Voice.plainForSpeech(ev.instruction)}`;
      setState('approval');
      speakTeach();
      break;

    case 'teach-answered':
      if (S.teach) S.teach.waiting = false;
      if (S.settings.teachVoice !== false) Voice.Speaker.stop();
      S.activity = 'Checking your screen';
      setState('thinking');
      break;

    case 'refusal':
      addNote(`The model declined this request${ev.category ? ` (${ev.category})` : ''}. Try rephrasing it.`, true);
      if (ev.rolledBack) markRolledBack();
      finishTurn('idle');
      break;

    case 'error':
      addNote(ev.message, true);
      if (ev.rolledBack) markRolledBack();
      finishTurn(S.expanded ? 'idle' : 'error');
      break;

    case 'done': {
      if (ev.aborted) addNote('Stopped.');
      if (ev.rolledBack) markRolledBack();
      const last = L ? [...L.blocks.values()].filter((b) => b.type === 'text').pop() : null;
      S.readySnippet = last ? last.raw.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) : '';
      if (ev.usage) $('usage').textContent = `${fmtK(ev.usage.input)} in, ${fmtK(ev.usage.output)} out${ev.usage.cacheRead ? `, ${fmtK(ev.usage.cacheRead)} cached` : ''}`;
      // Read the answer aloud: after voice questions by default, or always if chosen.
      // (Live mode has already spoken it sentence by sentence.)
      const speakMode = S.settings.speakReplies || 'voice';
      if (!LIVE.on && !ev.aborted && last?.raw && (speakMode === 'always' || (speakMode === 'voice' && S.turnSpoken))) Voice.speak(last.raw);
      // Screen readers: the streaming bubble stays quiet; the finished answer is read once.
      if (!ev.aborted && last?.raw) announce(`Island: ${Voice.plainForSpeech(last.raw).slice(0, 1500)}`);
      syncMsgIndices(); // Edit / Retry / Branch need each message's place in the saved chat
      finishTurn(S.expanded || ev.aborted ? 'idle' : 'ready');
      break;
    }
  }
  stick(wasNear);
});

function markRolledBack() {
  const users = thread.querySelectorAll('.msg.user');
  users[users.length - 1]?.classList.add('rolled-back');
}

function finishTurn(state = 'idle') {
  if (S.live) {
    finalizeThinking();
    finalizeText();
    finishGroups(S.live.el);
    addSourcesPanel(S.live.el);
    if (S.live.el.childElementCount <= 1) S.live.el.remove(); // header only
  }
  S.live = null;
  S.busy = false;
  S.activity = '';
  if (S.plan) {
    S.plan = null;
    renderPillPlan();
  }
  S.teach = null;
  if (LIVE.on) setLivePhase(LIVE.phase); // the live conversation owns the status light
  else setState(state);
  updateSendBtn();
}

const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));

// ---------------------------------------------------------------- prompts (questions + approvals)
// Everything Island needs from you arrives here: questions from the model (ask_user),
// and permission to run a command, use the mouse and keyboard, or call an MCP tool.
// Cards rise from the bottom of the panel; if the island was folded away it opens as
// a compact card that shows only the question, then folds back once you answer.

const Q = { queue: [], cur: null };

api.onPrompt((p) => enqueuePrompt(p));
api.onPromptCancel(({ id }) => {
  Q.queue = Q.queue.filter((p) => p.id !== id);
  if (Q.cur?.id === id) closePrompt(null, { cancelled: true });
  syncPendingCount();
});

function syncPendingCount() {
  S.approvalsPending = Q.queue.length + (Q.cur ? 1 : 0);
  island.classList.toggle('has-prompt', !!S.approvalsPending);
}

function enqueuePrompt(p) {
  Q.queue.push(p);
  syncPendingCount();
  if (LIVE.on) Voice.Speaker.say(p.kind === 'question' ? spokenQuestion(p) : p.kind === 'control' ? 'I need your OK on screen before I use the mouse and keyboard.' : p.kind === 'handover' ? `Your turn. ${p.reason || ''}. Press Done when you're finished.` : 'I need your OK on screen first.');
  if (!Q.cur) showNextPrompt();
  else renderPromptCount();
}

function spokenQuestion(p) {
  const opts = (p.options || []).map((o) => o.label);
  return p.question + (opts.length ? ` You can say ${opts.slice(0, -1).join(', ')}${opts.length > 1 ? ' or ' : ''}${opts[opts.length - 1]}.` : '');
}

function renderPromptCount() {
  const n = Q.queue.length;
  const el = $('prompt').querySelector('.pc-count');
  if (el) el.textContent = n ? `+${n} more` : '';
}

function showNextPrompt() {
  Q.cur = Q.queue.shift() || null;
  syncPendingCount();
  const dock = $('prompt');
  if (!Q.cur) {
    dock.innerHTML = '';
    // Opened only to ask: fold back so the user (or the agent) can get on with it.
    if (island.classList.contains('compact')) {
      setCompact(false);
      api.requestCollapse();
    }
    if (S.state === 'approval') setState(S.busy ? 'thinking' : 'idle');
    return;
  }
  const p = Q.cur;
  const card = p.kind === 'question' ? questionCard(p) : approvalCard(p);
  // Asked because the turn read a web page or connector result (which could hide instructions).
  if (p.tainted) card.querySelector('.pc-btns')?.insertAdjacentHTML('beforebegin', consequence('globe', 'Island read a web page or connector result just now, so it checks with you before acting, even on things it would normally just do.'));
  dock.innerHTML = '';
  dock.appendChild(card);
  renderPromptCount();
  S.activity = p.kind === 'question' ? p.question.slice(0, 80) : p.reason || p.summary || 'Needs your OK';
  setState('approval');
  if (S.view === 'live' && p.kind !== 'question') showChat();
  requestAnimationFrame(() => (card.querySelector('textarea, .pc-opt, .btn.mint, .btn.go, .btn.bio') || card).focus({ preventScroll: true }));
}

// Answer the current prompt, leave a short record in the chat, show the next one.
function closePrompt(response, { record, cancelled } = {}) {
  const p = Q.cur;
  if (!p) return;
  const card = $('prompt').firstElementChild;
  if (!cancelled) {
    if (p.local) p.resolve(response);
    else api.respondPrompt(p.id, response);
    if (record) addRecord(record.text, record.ok !== false);
  }
  Q.cur = null;
  syncPendingCount();
  // After the closing animation, show what's next, unless a new question already arrived and
  // took the dock meanwhile (showing "next" then would wipe it, and Island would wait forever).
  const next = () => { if (!Q.cur) showNextPrompt(); };
  if (card) {
    card.classList.add('leaving');
    setTimeout(next, 220);
  } else next();
}

function addRecord(html, ok) {
  const n = document.createElement('div');
  n.className = 'qrec enter' + (ok ? '' : ' no');
  n.innerHTML = `${ok ? ICONS.circleCheck : ICONS.x}<span>${html}</span>`;
  (S.live?.el || thread).appendChild(n);
  if (S.view === 'chat') stick(true);
}

// Every question and permission card has the same shape: icon, what Island wants, why,
// the details, what will happen (and whether it can be undone), then Not now / the action.
function cardShell({ icon, kicker, why = '', tone = 'amber' }) {
  const card = document.createElement('div');
  card.className = 'pcard' + (tone === 'bio' ? ' bio' : '');
  card.tabIndex = -1;
  // A decision Island is waiting for: screen readers hear it as a dialog, with its question.
  const id = 'pc' + Math.random().toString(36).slice(2, 8);
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-labelledby', id + 'k');
  card.setAttribute('aria-describedby', id + 'w');
  card.innerHTML = `<div class="pc-top"><span class="pc-ic" aria-hidden="true">${ICONS[icon]}</span><div class="pc-head"><b class="pc-kicker" id="${id}k"></b><span class="pc-why" id="${id}w"></span></div><span class="pc-count"></span></div>`;
  card.querySelector('.pc-kicker').textContent = kicker;
  const w = card.querySelector('.pc-why');
  w.textContent = why;
  w.hidden = !why;
  return card;
}
const consequence = (icon, text, warn) => `<div class="pc-undo${warn ? ' warn' : ''}">${ICONS[icon]}<span>${text}</span></div>`;

function questionCard(p) {
  const card = cardShell({ icon: 'question', kicker: p.title || 'Island has a question' });
  const multi = !!p.multiSelect;
  const opts = p.options || [];
  const allowText = p.allowText !== false;
  const files = [];
  const chosen = new Set();
  card.insertAdjacentHTML('beforeend', `<div class="pc-q"></div>${p.detail ? '<div class="pc-sub"></div>' : ''}
    ${opts.length ? `<div class="pc-opts">${opts.map((o, i) => `<button class="pc-opt" data-i="${i}">${multi ? `<span class="bx">${ICONS.check}</span>` : `<kbd>${i + 1}</kbd>`}<span class="ot"><b></b>${o.description ? '<span></span>' : ''}</span></button>`).join('')}</div>` : ''}
    ${allowText ? `<div class="pc-answer"><textarea rows="1" placeholder="${escapeHtml(p.placeholder || (opts.length ? 'Or type your own answer…' : 'Type your answer…'))}"></textarea><button class="icon-btn small" data-a="attach" title="Attach a file">${ICONS.attach}</button></div>` : ''}
    <div class="pc-files"></div>
    <div class="pc-btns"><button class="btn link" data-a="skip">Skip</button><span class="grow"></span>${multi || allowText ? `<button class="btn mint" data-a="send">${ICONS.send}<span>Send</span></button>` : ''}</div>`);
  card.querySelector('.pc-q').innerHTML = DOMPurify.sanitize(marked.parse(p.question || ''));
  if (p.detail) card.querySelector('.pc-sub').textContent = p.detail;
  card.querySelectorAll('.pc-opt').forEach((b) => {
    const o = opts[+b.dataset.i];
    b.querySelector('b').textContent = o.label;
    if (o.description) b.querySelector('.ot span').textContent = o.description;
  });
  const ta = card.querySelector('textarea');
  const sendBtn = card.querySelector('[data-a=send]');

  const submit = (answerText) => {
    const text = (answerText ?? ta?.value ?? '').trim();
    const selected = opts.filter((_, i) => chosen.has(i)).map((o) => o.label);
    if (!text && !selected.length && !files.length) return ta?.focus();
    const shown = [selected.join(', '), text, files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    closePrompt({ answer: text, selected, files }, { record: { text: `<b>${escapeHtml(p.question.slice(0, 90))}</b> ${escapeHtml(shown)}` } });
  };
  card.querySelectorAll('.pc-opt').forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.i;
      if (!multi) {
        chosen.clear();
        chosen.add(i);
        return submit('');
      }
      chosen.has(i) ? chosen.delete(i) : chosen.add(i);
      b.classList.toggle('on', chosen.has(i));
    };
  });
  if (ta) {
    ta.oninput = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    };
    ta.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };
  }
  card.addEventListener('keydown', (e) => {
    if (e.target === ta || multi) return;
    const n = Number(e.key);
    if (n >= 1 && n <= opts.length) card.querySelector(`.pc-opt[data-i="${n - 1}"]`).click();
  });
  if (sendBtn) sendBtn.onclick = () => submit();
  card.querySelector('[data-a=skip]').onclick = () => closePrompt({ skipped: true }, { record: { text: `<b>${escapeHtml(p.question.slice(0, 90))}</b> skipped`, ok: false } });
  const attach = card.querySelector('[data-a=attach]');
  if (attach) {
    attach.onclick = () => {
      const fi = document.createElement('input');
      fi.type = 'file';
      fi.multiple = true;
      S.pickerOpen = true;
      fi.onchange = async () => {
        S.pickerOpen = false;
        for (const f of fi.files) {
          try {
            files.push(await readAttachment(f));
          } catch (e) {
            toast(String(e.message || e).slice(0, 80));
          }
        }
        const box = card.querySelector('.pc-files');
        box.innerHTML = files.map((f) => `<span class="chip">${f.kind === 'image' ? ICONS.image : ICONS.file}<span>${escapeHtml(f.name)}</span></span>`).join('');
      };
      fi.click();
    };
    if (p.requestFiles) attach.classList.add('on');
  }
  card.liveAnswer = (text) => submit(text); // spoken answers in Live mode
  return card;
}

function approvalCard(p) {
  const hk = (S.settings.activeHotkey || S.settings.hotkey || 'Alt+Space').replace('Control', 'Ctrl');
  if (p.kind === 'control') {
    const card = cardShell({ icon: 'cursor', kicker: 'Let Island use your mouse and keyboard?', why: p.summary ? `For this task. First step: ${p.summary}` : 'For this task only.', tone: 'bio' });
    card.insertAdjacentHTML('beforeend', `<ul class="perks">
        <li>${ICONS.eye}<span>You'll see Island's cursor, clicks and typing on screen</span></li>
        <li>${ICONS.shield}<span>Island asks before sending, buying, or deleting anything</span></li>
      </ul>
      ${consequence('hand', `Move your mouse or press <kbd>${escapeHtml(hk)}</kbd> at any time and Island stops straight away.`)}
      <div class="pc-btns"><button class="btn link" data-a="auto">Always allow</button><span class="grow"></span><button class="btn ghost" data-a="0">Not now</button><button class="btn mint" data-a="1">Allow for this task</button></div>`);
    card.querySelector('[data-a="1"]').onclick = () => closePrompt({ approved: true }, { record: { text: 'Island has control for this task' } });
    card.querySelector('[data-a="0"]').onclick = () => closePrompt({ approved: false }, { record: { text: 'Control declined', ok: false } });
    card.querySelector('[data-a=auto]').onclick = async () => {
      await setMode('auto');
      closePrompt({ approved: true }, { record: { text: 'Island has control. It now asks only before changes' } });
    };
    return card;
  }
  if (p.kind === 'file') {
    const del = p.op === 'delete';
    const n = (p.paths || []).length;
    // Whole sentences (not "Delete" + "this file"), so translations read naturally.
    const kicker = del ? (n === 1 ? 'Delete this file?' : n ? `Delete these ${n} files?` : 'Delete these?') : (n === 1 ? 'Change this file?' : n ? `Change these ${n} files?` : 'Change these?');
    const card = cardShell({ icon: del ? 'trash' : 'folder', kicker, why: p.summary || '' });
    card.insertAdjacentHTML('beforeend', `<ul class="pc-paths"></ul>${consequence('undo', del ? 'They go to the Recycle Bin, so you can get them back. You can also undo this from the chat or the activity list.' : 'You can undo this from the chat or the activity list.')}<div class="pc-btns"><span class="grow"></span><button class="btn ghost" data-a="0">Not now</button><button class="btn ${del ? 'danger' : 'mint'}" data-a="1">${del ? (n > 1 ? `Delete ${n} files` : 'Delete') : 'Allow'}</button></div>`);
    card.querySelector('.pc-paths').innerHTML = (p.paths || []).map((x) => `<li>${ICONS.file}<span>${escapeHtml(x)}</span></li>`).join('');
    card.querySelector('[data-a="1"]').onclick = () => closePrompt({ approved: true }, { record: { text: `Allowed: <b>${escapeHtml(p.summary || '')}</b>` } });
    card.querySelector('[data-a="0"]').onclick = () => closePrompt({ approved: false }, { record: { text: 'File change declined', ok: false } });
    return card;
  }
  if (p.kind === 'shell') {
    const card = cardShell({ icon: 'terminal', kicker: 'Run this PowerShell command?', why: p.reason || '' });
    card.insertAdjacentHTML('beforeend', `<pre></pre>${p.readOnly ? consequence('shield', 'Only reads information. Nothing on your PC changes.') : consequence('alert', "This command may change things on your PC, and Island can't undo it for you.", true)}<div class="pc-btns"><span class="grow"></span><button class="btn ghost" data-a="0">Not now</button><button class="btn ${p.readOnly ? 'mint' : 'go'}" data-a="1">${ICONS.play}<span>Run command</span></button></div>`);
    card.querySelector('pre').textContent = p.command;
    card.querySelector('[data-a="1"]').onclick = () => closePrompt({ approved: true }, { record: { text: `Ran: <b>${escapeHtml((p.reason || p.command).slice(0, 90))}</b>` } });
    card.querySelector('[data-a="0"]').onclick = () => closePrompt({ approved: false }, { record: { text: 'Command denied', ok: false } });
    return card;
  }
  if (p.kind === 'mcp') {
    const card = cardShell({ icon: 'plug', kicker: `Use “${p.title || p.tool}” from ${p.server}?`, why: p.description || `A tool from the ${p.server} connector.` });
    card.insertAdjacentHTML('beforeend', `${p.args ? '<pre></pre>' : ''}${p.warning ? consequence('shieldAlert', '', true) : ''}<div class="pc-btns">${p.warning ? '' : '<button class="btn link" data-a="always">Always allow this tool</button>'}<span class="grow"></span><button class="btn ghost" data-a="0">Not now</button><button class="btn mint" data-a="1">Allow</button></div>`);
    if (p.warning) card.querySelector('.pc-undo.warn span').textContent = p.warning;
    if (p.args) card.querySelector('pre').textContent = p.args;
    const rec = (ok) => ({ text: `${ok ? 'Allowed' : 'Denied'} <b>${escapeHtml(p.server)}: ${escapeHtml(p.title || p.tool)}</b>`, ok });
    card.querySelector('[data-a="1"]').onclick = () => closePrompt({ approved: true }, { record: rec(true) });
    card.querySelector('[data-a=always]')?.addEventListener('click', () => closePrompt({ approved: true, always: true }, { record: rec(true) }));
    card.querySelector('[data-a="0"]').onclick = () => closePrompt({ approved: false }, { record: rec(false) });
    return card;
  }
  if (p.kind === 'handover') {
    const card = cardShell({ icon: 'hand', kicker: 'Your turn', why: p.reason || 'Island needs you for this step.', tone: 'bio' });
    card.insertAdjacentHTML('beforeend', `<div class="ho-steps"></div>
      ${consequence('eyeOff', "Island isn't looking at your screen or typing while you do this.")}
      <input class="field ho-note" placeholder="Anything Island should know? (optional)" spellcheck="false" />
      <div class="pc-btns"><button class="btn link" data-a="cancel">Stop the task</button><span class="grow"></span><button class="btn ghost" data-a="0">I'd rather not</button><button class="btn mint" data-a="1">${ICONS.play}<span>Done, continue</span></button></div>`);
    card.querySelector('.ho-steps').textContent = p.steps || '';
    const note = () => card.querySelector('.ho-note').value.trim();
    card.querySelector('.ho-note').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') card.querySelector('[data-a="1"]').click(); };
    card.querySelector('[data-a="1"]').onclick = () => closePrompt({ done: true, note: note() }, { record: { text: `You did: <b>${escapeHtml((p.reason || 'your step').slice(0, 90))}</b>` } });
    card.querySelector('[data-a="0"]').onclick = () => closePrompt({ done: false, note: note() }, { record: { text: 'Skipped your step', ok: false } });
    card.querySelector('[data-a=cancel]').onclick = () => closePrompt({ cancel: true }, { record: { text: 'Task stopped', ok: false } });
    return card;
  }
  if (p.kind === 'memory') {
    const card = cardShell({ icon: 'brain', kicker: 'Remember this for next time?', why: p.sensitive ? `It's about ${p.sensitive}, so Island asks first.` : 'You chose to OK each memory.', tone: 'bio' });
    card.insertAdjacentHTML('beforeend', `<input class="field pc-mem" spellcheck="false" />${consequence('lock', `It stays on this PC${p.space ? ', in your <b></b> space' : ''}. You can see or delete memories any time in Settings → Privacy and control.`)}<div class="pc-btns"><span class="grow"></span><button class="btn ghost" data-a="0">Don't remember</button><button class="btn mint" data-a="1">Remember</button></div>`);
    const field = card.querySelector('.pc-mem');
    field.value = p.text || '';
    if (p.space) card.querySelector('.pc-undo b').textContent = p.space;
    const yes = () => closePrompt({ approved: true, text: field.value.trim() || p.text }, { record: { text: `Remembered: <b>${escapeHtml((field.value.trim() || p.text).slice(0, 90))}</b>` } });
    field.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') yes(); };
    card.querySelector('[data-a="1"]').onclick = yes;
    card.querySelector('[data-a="0"]').onclick = () => closePrompt({ approved: false }, { record: { text: 'Not saved to memory', ok: false } });
    return card;
  }
  // local confirmation (e.g. turning on Bypass)
  const card = cardShell({ icon: p.icon || 'alert', kicker: p.title, why: p.body || '' });
  card.insertAdjacentHTML('beforeend', `<div class="pc-btns"><span class="grow"></span><button class="btn ghost" data-a="0">Cancel</button><button class="btn ${p.danger ? 'danger' : 'mint'}" data-a="1"></button></div>`);
  card.querySelector('[data-a="1"]').textContent = p.okLabel || 'OK';
  card.querySelector('[data-a="1"]').onclick = () => closePrompt(true);
  card.querySelector('[data-a="0"]').onclick = () => closePrompt(false);
  return card;
}

function localConfirm(opts) {
  return new Promise((resolve) => enqueuePrompt({ ...opts, kind: 'confirm', local: true, id: `local-${Date.now()}`, resolve }));
}

$('compactOpen').onclick = () => {
  setCompact(false);
  showChat();
  stick(true);
};

// (Files picked as an answer to a question use readAttachment above: same rules as the composer.)

// ---------------------------------------------------------------- permission mode

const MODES = {
  ask: { icon: 'shield', label: 'Asks first', title: 'Ask first', desc: 'Island asks before it runs commands, takes control of the mouse and keyboard, or uses connector tools.' },
  auto: { icon: 'zap', label: 'Asks before changes', title: 'Ask before changes', desc: 'Reading, looking and safe commands just run. Island still asks before anything that changes your files or system.' },
  bypass: { icon: 'shieldAlert', label: 'Never asks', title: 'Never ask', desc: 'Island never asks. Every command and tool runs immediately. Use only for tasks you trust.' },
};
const MODE_ORDER = ['ask', 'auto', 'bypass'];

function renderModeChip() {
  const mode = MODES[S.settings.permissionMode] ? S.settings.permissionMode : 'ask';
  const m = MODES[mode];
  const b = $('modeChip');
  b.dataset.mode = mode;
  b.innerHTML = `<span>${m.label}</span>${ICONS.chevron}`;
  b.title = `${m.title}: ${m.desc}\nClick or press Shift+Tab to change`;
}

async function setMode(mode, { confirm = true } = {}) {
  if (mode === 'bypass' && confirm && S.settings.permissionMode !== 'bypass') {
    const ok = await localConfirm({ title: 'Let Island act without asking?', icon: 'shieldAlert', body: 'Island will run PowerShell commands, use your mouse and keyboard, and call connector tools without asking. It still refuses to type passwords or payment details.', okLabel: 'Never ask', danger: true });
    if (!ok) return;
  }
  S.settings = await api.setSettings({ permissionMode: mode });
  renderModeChip();
  const chip = $('modeChip');
  chip.classList.remove('bump');
  void chip.offsetWidth;
  chip.classList.add('bump');
  toast(`${MODES[mode].title} mode`);
  if (S.view === 'settings') showSettings(SET.tab);
}

function cycleMode() {
  const cur = MODE_ORDER.indexOf(S.settings.permissionMode);
  setMode(MODE_ORDER[(Math.max(0, cur) + 1) % MODE_ORDER.length]);
}
$('modeChip').onclick = cycleMode;

// ---------------------------------------------------------------- settings view

let recordingHotkey = false;

function showChat() {
  S.view = 'chat';
  $('settings').hidden = true;
  $('liveView').hidden = true;
  $('chatsView').hidden = true;
  renderEmpty();
}

// ---------------------------------------------------------------- saved chats

const C = { q: '', confirmDelete: null };

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function groupOf(c) {
  if (c.pinned) return 'Pinned';
  const d = new Date(c.updated);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (d >= today) return 'Today';
  if (d >= today - day) return 'Yesterday';
  if (d >= today - 7 * day) return 'Previous 7 days';
  return 'Older';
}

async function showChats() {
  closePicker();
  S.view = 'chats';
  $('jumpBtn').hidden = true;
  $('settings').hidden = true;
  $('liveView').hidden = true;
  $('empty').hidden = true;
  thread.hidden = true;
  const box = $('chatsView');
  box.hidden = false;
  if (!box.querySelector('.chats-head')) {
    box.innerHTML = `<div class="chats-head"><h2>Your chats</h2><button class="btn mint" id="chatsNew">${ICONS.plus}<span>New chat</span></button></div>
      <div class="picker-search chats-search"><span class="ps-ic">${ICONS.search}</span><input id="chatsSearch" placeholder="Search your chats" spellcheck="false" /></div>
      <div class="chats-list" id="chatsList"></div>`;
    $('chatsNew').onclick = () => newChat(true);
    $('chatsSearch').oninput = (e) => {
      C.q = e.target.value;
      renderChats();
    };
    $('chatsSearch').onkeydown = (e) => {
      if (e.key === 'Enter') box.querySelector('.chat-row')?.click();
    };
  }
  $('chatsSearch').value = C.q;
  await renderChats();
  setTimeout(() => $('chatsSearch')?.focus(), 30);
}

async function renderChats() {
  if (S.view !== 'chats') return;
  const { chats, current } = await api.chatsList(C.q);
  const list = $('chatsList');
  if (!chats.length) {
    list.innerHTML = `<div class="picker-empty">${C.q ? `No chats match “${escapeHtml(C.q)}”.` : 'No saved chats yet. Ask something and it will show up here.'}</div>`;
    return;
  }
  list.innerHTML = '';
  let group = null;
  for (const c of chats) {
    const g = groupOf(c);
    if (g !== group) {
      group = g;
      list.insertAdjacentHTML('beforeend', `<div class="pg-h">${g}</div>`);
    }
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === current ? ' cur' : '');
    row.innerHTML = `
      <span class="cm"><b class="ct"></b><span class="cs"></span></span>
      <span class="ca">
        <button class="icon-btn small${c.pinned ? ' on' : ''}" data-a="pin" title="${c.pinned ? 'Unpin' : 'Pin'}">${ICONS.pin}</button>
        <button class="icon-btn small" data-a="rename" title="Rename">${ICONS.edit}</button>
        <button class="icon-btn small" data-a="delete" title="Delete">${ICONS.trash}</button>
      </span>`;
    row.querySelector('.ct').textContent = c.title;
    row.querySelector('.cs').textContent = c.match || `${ago(c.updated)}, ${c.count || 0} message${c.count === 1 ? '' : 's'}`;
    row.onclick = (e) => {
      if (e.target.closest('.ca')) return;
      openChat(c.id);
    };
    row.querySelector('[data-a=pin]').onclick = async () => {
      await api.chatsPin(c.id, !c.pinned);
      renderChats();
    };
    row.querySelector('[data-a=rename]').onclick = () => {
      const t = row.querySelector('.ct');
      const inputEl = document.createElement('input');
      inputEl.className = 'field chat-rename';
      inputEl.value = c.title;
      t.replaceWith(inputEl);
      inputEl.focus();
      inputEl.select();
      const done = async (save) => {
        if (save && inputEl.value.trim()) await api.chatsRename(c.id, inputEl.value.trim());
        renderChats();
      };
      inputEl.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      };
      inputEl.onblur = () => done(true);
    };
    const del = row.querySelector('[data-a=delete]');
    if (C.confirmDelete === c.id) {
      del.classList.add('danger');
      del.title = 'Click again to delete';
      del.innerHTML = `${ICONS.trash}<span>Delete?</span>`;
    }
    del.onclick = async () => {
      if (C.confirmDelete !== c.id) {
        C.confirmDelete = c.id;
        setTimeout(() => { if (C.confirmDelete === c.id) { C.confirmDelete = null; renderChats(); } }, 3000);
        return renderChats();
      }
      C.confirmDelete = null;
      try {
        const r = await api.chatsDelete(c.id);
        if (c.id === current) {
          thread.innerHTML = '';
          $('usage').textContent = '';
        }
        toast('Chat deleted');
      } catch (e) {
        toast(cleanIpcError(e));
      }
      renderChats();
    };
    list.appendChild(row);
  }
}

async function openChat(id) {
  try {
    const { items } = await api.chatsOpen(id);
    setIncognito(false);
    $('usage').textContent = '';
    renderHistory(items);
    showChat();
    input.focus();
  } catch (e) {
    toast(cleanIpcError(e));
  }
}

$('chatsBtn').innerHTML = ICONS.history;
$('chatsBtn').onclick = () => (S.view === 'chats' ? showChat() : showChats());
// Close Island completely: agent, helper processes and shortcuts all stop with the app.
$('quitBtn').innerHTML = ICONS.power;
$('quitBtn').onclick = () => api.quitApp();

function modelInfo(id) {
  const m = S.models?.find((x) => x.id === id);
  return { name: m?.name || id, fam: familyOf(id), m };
}

function renderModelChip() {
  const { name, m } = modelInfo(S.settings.model);
  const effort = !m || m.effort ? `<span class="ef" title="${EFFORT_LABEL[S.settings.effort] || S.settings.effort}">${escapeHtml(S.settings.effort || 'medium')}</span>` : '';
  $('modelChip').innerHTML = `${logoTile(S.settings.model)}<span class="nm">${escapeHtml(name)}</span>${effort}${ICONS.chevron}`;
}

// ---------------------------------------------------------------- settings (tabbed)

const SET = { tab: 'general', memQ: '', memCat: 'all', mcpOpen: new Set() };
// Five tabs. Each new tab is built from the older sections (see SETTINGS_TABS below).
const SET_TABS = [
  ['general', 'sliders', 'General'],
  ['ai', 'cpu', 'AI and model'],
  ['privacy', 'shield', 'Privacy and control'],
  ['connectors', 'plug', 'Connectors'],
  ['voicekeys', 'type', 'Voice and keys'],
];
// Older section names still used around the app -> the tab that now holds them.
const TAB_ALIAS = { account: 'ai', model: 'ai', prompt: 'ai', agent: 'privacy', memory: 'privacy', activity: 'privacy', voice: 'voicekeys', shortcuts: 'voicekeys' };
const TAB_SECTIONS = { ai: ['account', 'model', 'search', 'prompt'], privacy: ['agent', 'memory', 'activity', 'data'], voicekeys: ['voice', 'shortcuts'] };
const ACT_KINDS = [['', 'All'], ['command', 'Commands'], ['file', 'Files'], ['app', 'Apps & pages'], ['computer', 'Clicks & typing'], ['connector', 'Connectors'], ['web', 'Web'], ['read', 'Reading']];
const ACT_ICON = { command: 'terminal', file: 'folder', app: 'app', computer: 'cursor', connector: 'plug', web: 'globe', read: 'eye', clipboard: 'clipboard', other: 'circleDot' };
const MEM_CATS = { profile: ['user', 'About you'], preference: ['star', 'Preferences'], project: ['briefcase', 'Projects'], instruction: ['scrollText', 'Instructions'], fact: ['bulb', 'Facts'] };
const hotkeyLabel = (v) => (v || 'Not set').replace(/Control/g, 'Ctrl');

// focus: an element id to scroll to once the tab is drawn (e.g. 'voiceOnline').
async function showSettings(tab, focus) {
  const prevTab = SET.tab;
  const wasOpen = S.view === 'settings';
  if (tab) SET.tab = TAB_ALIAS[tab] || tab;
  if (!SET_TABS.some(([id]) => id === SET.tab)) SET.tab = 'general';
  // Re-rendering the same tab (after a change inside it) keeps your place on the page.
  const keepScroll = wasOpen && prevTab === SET.tab ? body.scrollTop : 0;
  closePicker();
  S.view = 'settings';
  $('jumpBtn').hidden = true;
  S.settings = await api.getSettings();
  $('empty').hidden = true;
  $('chatsView').hidden = true;
  $('liveView').hidden = true;
  thread.hidden = true;
  const box = $('settings');
  const first = box.hidden;
  box.hidden = false;
  if (first) box.classList.add('view-in'), setTimeout(() => box.classList.remove('view-in'), 300);
  box.innerHTML = `<nav class="set-nav"><h2>Settings</h2>${SET_TABS.map(([id, icon, label]) => `<button class="set-tab${id === SET.tab ? ' on' : ''}" data-tab="${id}" title="${label}">${ICONS[icon]}<span>${label}</span>${id === 'ai' && !aiReady() ? '<i class="dot"></i>' : ''}</button>`).join('')}</nav><div class="set-main" id="setMain"></div>`;
  box.querySelectorAll('.set-tab').forEach((b) => (b.onclick = () => showSettings(b.dataset.tab)));
  const main = $('setMain');
  if (wasOpen && prevTab === SET.tab) main.classList.add('quiet'); // no entrance animation on refresh
  const sections = TAB_SECTIONS[SET.tab];
  if (sections) {
    const label = SET_TABS.find(([id]) => id === SET.tab)[2];
    main.innerHTML = `<h2 class="set-page">${label}</h2>${sections.map((s) => `<section class="set-sec" id="sec-${s}"></section>`).join('')}`;
    for (const s of sections) await SETTINGS_TABS[s]($(`sec-${s}`));
  } else {
    await SETTINGS_TABS[SET.tab](main);
  }
  body.scrollTop = keepScroll;
  if (focus) $(focus)?.scrollIntoView({ block: 'start', behavior: 'smooth' });}

async function setSetting(patch) {
  try {
    S.settings = await api.setSettings(patch);
  } catch (e) {
    toast(cleanIpcError(e).slice(0, 90));
    S.settings = await api.getSettings();
  }
  renderModelChip();
  renderAgentBtn();
  renderModeChip();
  applyTextSize();
  return S.settings;
}

const head = (title, desc, extra = '') => `<div class="set-title">${title}<span class="grow"></span>${extra}</div>${desc ? `<p class="set-desc">${desc}</p>` : ''}`;
const row = (label, sub, control) => `<div class="srow"><div class="lbl"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</div>${control}</div>`;
const seg = (id, opts, cls = '') => `<div class="seg${cls ? ` ${cls}` : ''}" id="${id}">${opts.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div>`;
function wireSeg(id, key, value, cast = String) {
  const el = $(id);
  if (!el) return;
  el.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', String(b.dataset.v) === String(value));
    b.onclick = async () => {
      await setSetting({ [key]: cast(b.dataset.v) });
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
}
function wireToggle(id, key, on, after) {
  const el = $(id);
  el.classList.toggle('on', !!on);
  el.onclick = async () => {
    const s = await setSetting({ [key]: !el.classList.contains('on') });
    el.classList.toggle('on', !!s[key]);
    after?.(s);
  };
}

async function renderActivity() {
  const list = $('actList');
  if (!list) return;
  const items = await api.activityList(SET.actQ || '', SET.actKind || '');
  if (!items.length) {
    list.innerHTML = `<div class="mem-empty">${SET.actQ || SET.actKind ? 'Nothing matches.' : 'Nothing yet. Every command, click, file change and connector call Island makes on your PC shows up here.'}</div>`;
    return;
  }
  list.innerHTML = '';
  let day = null;
  for (const e of items) {
    const d = new Date(e.t);
    const label = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    if (label !== day) {
      day = label;
      list.insertAdjacentHTML('beforeend', `<div class="pg-h">${label}</div>`);
    }
    const row = document.createElement('div');
    row.className = 'act' + (e.ok === false ? ' failed' : '') + (e.undone ? ' undone' : '');
    row.innerHTML = `<span class="act-ic">${ICONS[ACT_ICON[e.kind]] || ICONS.circleDot}</span><div class="act-b"><div class="act-t"></div><div class="act-m"><span>${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>${e.grant ? `<span class="cap">${escapeHtml(e.grant)}</span>` : ''}${e.ok === false ? '<span class="cap bad">failed</span>' : ''}${e.undone ? '<span class="cap">undone</span>' : ''}</div>${e.detail || e.error ? '<pre class="act-d"></pre>' : ''}</div>`;
    row.querySelector('.act-t').textContent = e.summary;
    if (e.detail || e.error) row.querySelector('.act-d').textContent = [e.detail, e.error && `error: ${e.error}`].filter(Boolean).join('\n');
    row.onclick = (ev) => { if (!ev.target.closest('button')) row.classList.toggle('open'); };
    if (e.canUndo) {
      row.appendChild(document.createElement('span'));
      const tmp = document.createElement('div');
      tmp.innerHTML = '<div class="tool-row"><span class="tm"></span></div>';
      addUndo(tmp, e.id);
      const btn = tmp.querySelector('.undo-btn');
      btn.addEventListener('click', () => setTimeout(renderActivity, 400));
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

const SETTINGS_TABS = {
  async activity(main) {
    main.innerHTML = head('Activity', 'Everything Island did on your PC: what, when, how it was allowed, and whether it worked. File changes can be undone here.', `<button class="btn ghost" id="actExport">${ICONS.download}<span>Export</span></button>`) +
      `<div class="mem-tools"><div class="picker-search" style="flex:1 1 180px;height:34px"><span class="ps-ic">${ICONS.search}</span><input id="actQ" placeholder="Search activity" spellcheck="false" /></div></div>
      <div class="cats" id="actKinds">${ACT_KINDS.map(([k, l]) => `<button class="cat" data-k="${k}">${l}</button>`).join('')}</div>
      <div class="act-list" id="actList"></div>`;
    $('actQ').value = SET.actQ || '';
    let tmr = 0;
    $('actQ').oninput = (e) => {
      SET.actQ = e.target.value;
      clearTimeout(tmr);
      tmr = setTimeout(renderActivity, 150);
    };
    $('actKinds').querySelectorAll('.cat').forEach((b) => {
      b.classList.toggle('on', b.dataset.k === (SET.actKind || ''));
      b.onclick = () => {
        SET.actKind = b.dataset.k;
        $('actKinds').querySelectorAll('.cat').forEach((x) => x.classList.toggle('on', x === b));
        renderActivity();
      };
    });
    $('actExport').onclick = async () => toast(`Saved ${(await api.activityExport()).split(/[\\/]/).pop()}`);
    await renderActivity();
  },

  // Plain facts about where data goes, so nobody has to guess.
  async data(main) {
    const st = S.settings;
    const host = escapeHtml(st.apiHost || 'your AI provider');
    const info = await api.searchServices().catch(() => ({}));
    const picked = st.searchProvider || 'auto';
    const searchWhere = picked === 'auto' ? 'Automatic' : (info[picked]?.name || picked);
    const item = (icon, title, text) => `<li>${ICONS[icon]}<div><b>${title}</b><span>${text}</span></div></li>`;
    main.innerHTML = head('What leaves your PC', 'Island runs on your computer. These are the only things it sends anywhere, and only when you use them.') +
      `<ul class="data-list">
        ${item('send', `Your messages go to ${host}`, 'What you type or say, files and pictures you attach, and a screenshot when you share your screen. That service answers with an AI model.')}
        ${item('mic', 'Your voice', `Recordings are turned into text by the same service (${escapeHtml(st.sttModel || 'gemini-3.5-flash-lite')}). Island doesn't keep the audio.`)}
        ${item('volume', 'Spoken replies', st.hasAzureKey ? 'Read aloud by Windows, or by Microsoft Azure for languages Windows has no voice for. Only the sentence being read is sent.' : 'Read aloud by Windows on this PC. Nothing is sent.')}
        ${item('globe', 'Web searches', `When Island looks something up, the words you searched for go to ${escapeHtml(searchWhere)}, which sends back the pages it found. You pick the service in Settings → AI and model → Web search.`)}
        ${item('plug', 'Connectors', 'Only the connectors you added, and only when Island uses one.')}
      </ul>
      <div class="sgroup-h">Stays on this PC</div>
      <ul class="data-list">
        ${item('history', 'Chats, memory and activity', 'Saved in your Windows user folder. Private chats aren\'t saved at all. You can delete any of it in Chats, Memory and Activity.')}
        ${item('key', 'Your API keys', 'Encrypted by Windows. Island never shows them on screen.')}
      </ul>
      <p class="set-desc">AI answers can be wrong. Check anything important, especially about health, money or the law.</p>`;
  },

  async account(main) {
    const st = S.settings;
    // Where the key goes: Google (free Gemini), Anthropic directly, or a gateway / custom URL.
    // Someone without a key starts on Google: it's free and needs no card.
    const gatewayNow = !!st.apiBaseURL || (st.hasApiKey && st.keyIsAnthropic === false && !st.keyIsGoogle);
    let source = SET.keySource || (st.keyIsGoogle || !st.hasApiKey ? 'google' : gatewayNow ? 'gateway' : 'anthropic');
    // A server on this PC may need no key at all, so being able to talk is what counts.
    const connected = st.hasApiKey || st.hasServer;
    const keyless = connected && !st.hasApiKey;
    // The address Island is really talking to: the one saved here, else the one this
    // PC's environment names, else Anthropic's own.
    const baseInUse = st.apiBaseURLInUse || '';
    const baseFromEnv = !!st.envBaseURL && st.envBaseURL === baseInUse;
    main.innerHTML = head('Your AI account', connected ? '' : 'Island needs an AI account to think. Paste your key below.') +
      `<div class="acct${connected ? ' ok' : ''}">
        <div class="acct-h"><span class="acct-ic">${ICONS.key}</span><div class="acct-t"><b>AI account</b><span id="acctSub">${connected ? (keyless ? `Talking to <b>${escapeHtml(st.apiHost || 'your server')}</b>. It did not need a key, so there is none to save.` : `Connected to <b>${escapeHtml(st.apiHost || 'api.anthropic.com')}</b> · key ${escapeHtml(st.keyHint || '')}${st.keyFromEnv ? ' (from your environment)' : ''}`) : 'Paste a key so Island can think. It stays on this PC, encrypted by Windows.'}</span></div><span class="acct-pill" id="acctPill">${connected ? `${ICONS.check}Connected` : 'Not connected'}</span></div>
        <div class="acct-q">Where is your key from?</div>
        <div class="acct-src" id="acctSrc">
          <button data-v="google"><span class="pv">${window.LOGOS?.google || window.LOGOS?.gemini || ICONS.sparkle}</span><span><b>Google (free)</b><small>Gemini, with a free key from Google</small></span></button>
          <button data-v="anthropic">${logoTile('claude-opus-5-5')}<span><b>Anthropic</b><small>Keys that start with sk-ant-</small></span></button>
          <button data-v="gateway"><span class="pv">${ICONS.globe}</span><span><b>Gateway or custom URL</b><small>Any Anthropic-compatible service</small></span></button>
        </div>
        <div id="acctGoogle" class="acct-steps">
          <ol><li>Open Google AI Studio and sign in with your Google account.</li><li>Press “Create API key”, then “Copy”.</li><li>Come back here, press “Paste”, then “Connect”.</li></ol>
          <button class="btn ghost" id="acctGetGoogle">${ICONS.open}<span>Get a free key</span></button>
          <div class="acct-hint">Free to use within Google's daily limits. Google may use free-tier chats to improve its models; see its terms.</div>
        </div>
        <label class="acct-l" for="sKey">API key</label>
        <div class="acct-f"><input class="field" id="sKey" type="password" placeholder="${connected ? 'Saved. Paste a new key to replace it' : 'Paste your key here'}" autocomplete="off" spellcheck="false" /><button class="icon-btn small" id="sKeyEye" title="Show the key">${ICONS.eye}</button><button class="btn ghost" id="sKeyPaste">${ICONS.clipboard}<span>Paste</span></button>${connected && !st.keyFromEnv ? '<button class="btn ghost" id="sKeyClear" title="Forget the key saved in Island">Remove</button>' : ''}</div>
        <div id="acctBase">
          <label class="acct-l" for="sBase">Base URL</label>
          <div class="acct-f"><input class="field" id="sBase" placeholder="${escapeHtml(st.envBaseURL || 'https://api.your-provider.com')}" spellcheck="false" autocomplete="off" /></div>
          <div class="acct-hint">The address your provider gave you, like <code>https://api.conifer.build</code>. Island adds <code>/v1/…</code> itself.${baseFromEnv ? ` Right now Island is using <code>${escapeHtml(st.envBaseURL)}</code> from this PC's environment (<code>ANTHROPIC_BASE_URL</code>).` : ''}</div>
          <div class="acct-preset" id="baseChips"></div>
        </div>
        <div id="acctEnv"></div>
        <div class="acct-b"><span class="acct-msg" id="sKeyCheck"></span><span class="grow"></span><button class="btn ghost" id="sKeyTest"${connected ? '' : ' disabled'}>Test</button><button class="btn mint" id="sKeySave">${connected ? 'Save' : 'Connect'}</button></div>
        <div class="srow stack" id="provNote"></div>
      </div>
      <div class="sgroup-h">More AI providers</div>
      <div class="sgroup">
        <div class="srow"><div class="lbl"><span>Save other AI accounts beside the main one — OpenRouter, Cerebras, a local server, anything that works like a gateway. Island uses whichever you pick, so everything (chat, computer use, search) goes through it. Keys stay encrypted by Windows.</span></div></div>
        <div class="srow stack" id="provActive"></div>
        <div class="srow stack" id="provBox"></div>
        <div class="srow stack"><div class="key-row"><button class="btn ghost" id="provAdd">${ICONS.plus}<span>Add a provider</span></button></div></div>
      </div>`;
    const setSource = (v) => {
      source = v;
      SET.keySource = v;
      $('acctSrc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      $('acctBase').hidden = v !== 'gateway';
      $('acctGoogle').hidden = v !== 'google';
    };
    $('acctGetGoogle').onclick = () => api.openExternal('https://aistudio.google.com/apikey');
    setSource(source);
    $('acctSrc').querySelectorAll('button').forEach((b) => (b.onclick = () => setSource(b.dataset.v)));
    // Base URL quick fill: the known gateway addresses save a typo-prone step.
    $('baseChips').innerHTML = '<span class="acct-hint">Quick fill:</span>' + [
      ['Cerebras', 'https://api.cerebras.ai'],
      ['OpenRouter', 'https://openrouter.ai/api/v1'],
      ['Groq (OpenAI-style)', 'https://api.groq.com/openai'],
      ['Together', 'https://api.together.xyz'],
      ['Fireworks', 'https://api.fireworks.ai/inference/v1'],
      ['Mistral', 'https://api.mistral.ai'],
      ['LM Studio (this PC)', 'http://127.0.0.1:1234'],
      ['Ollama (this PC)', 'http://127.0.0.1:11434'],
    ].map(([n, b]) => `<button class="btn ghost" data-base="${escapeHtml(b)}">${escapeHtml(n)}</button>`).join('');
    $('baseChips').querySelectorAll('button[data-base]').forEach((b) => (b.onclick = () => {
      $('sBase').value = b.dataset.base;
      msg(`Address filled in (${b.textContent.trim()}). Now paste the key and press Save.`, '');
    }));
    // When an extra provider is in use, the boxes above are still the main account's —
    // say so, so a pasted key doesn't go to the wrong place.
    if (st.apiProvider) $('provNote').innerHTML = `<div class="acct-hint">Island is currently using the <b>${escapeHtml(st.apiProvider)}</b> provider below. The key and address here belong to the main account; pick it under “AI account in use” below to go back to it.</div>`;
    // Show the address Island is using, so it can be read and corrected in one place.
    // The two built-in addresses are not repeated here: they are what the other two
    // sources stand for.
    const builtIn = [st.anthropicBaseURL, st.googleBaseURL].filter(Boolean);
    const savedCustom = st.apiBaseURL && !builtIn.includes(st.apiBaseURL) ? st.apiBaseURL : '';
    $('sBase').value = source === 'gateway' ? (savedCustom || st.envBaseURL || '') : savedCustom;
    // What this PC's environment offers, and a way to take it.
    const envBox = $('acctEnv');
    const envRows = [];
    if (st.envKeySet && st.envKeyDiffers) {
      envRows.push(`<div class="acct-hint">This PC's environment has another key (<code>${escapeHtml(st.envKeyHint)}</code>). <button class="btn ghost" id="acctUseEnvKey">Use it</button></div>`);
    }
    if (st.envBaseURL && st.envBaseURL !== st.apiBaseURLInUse) {
      envRows.push(`<div class="acct-hint">This PC's environment names another address (<code>${escapeHtml(st.envBaseURL)}</code>). <button class="btn ghost" id="acctUseEnvBase">Use it</button></div>`);
    }
    if (envRows.length) {
      envBox.innerHTML = `<div class="acct-q">From your environment</div>${envRows.join('')}`;
      $('acctUseEnvKey')?.addEventListener('click', async () => {
        try {
          // Forget the key saved in Island, so the one in the environment is used.
          await api.setApiKey('', st.apiBaseURLInUse || '');
          SET.keySource = null;
          await showSettings('ai');
          refreshModels().catch(() => {});
        } catch (e) { toast(cleanIpcError(e)); }
      });
      $('acctUseEnvBase')?.addEventListener('click', async () => {
        try {
          await api.setApiKey(undefined, st.envBaseURL);
          SET.keySource = null;
          await showSettings('ai');
          refreshModels().catch(() => {});
        } catch (e) { toast(cleanIpcError(e)); }
      });
    }
    const msg = (text, kind = '') => {
      const out = $('sKeyCheck');
      out.className = `acct-msg ${kind}`;
      out.innerHTML = kind === 'busy' ? `<span class="spinner"></span>${escapeHtml(text)}` : escapeHtml(text);
    };
    const check = async () => {
      msg('Checking…', 'busy');
      const r = await api.checkKey().catch((e) => ({ ok: false, message: cleanIpcError(e) }));
      msg(r.message, r.ok && !r.warn ? 'good' : r.warn ? 'warn' : 'bad');
      if (r.ok) await refreshModels();
      return r;
    };
    $('sKeyEye').onclick = () => {
      const k = $('sKey');
      k.type = k.type === 'password' ? 'text' : 'password';
      $('sKeyEye').innerHTML = k.type === 'password' ? ICONS.eye : ICONS.eyeOff;
    };
    $('sKeyPaste').onclick = async () => {
      const t = String((await api.clipboardText().catch(() => '')) || '').trim();
      if (!t) return msg('The clipboard is empty. Copy your key first.', 'bad');
      $('sKey').value = t;
      // Recognise the key: Google's start with AIza, Anthropic's with sk-ant-, others are a gateway's.
      if (/^AIza/.test(t)) setSource('google');
      else if (/^sk-ant-/.test(t)) setSource('anthropic');
      else if (source !== 'gateway') setSource('gateway');
      msg('Pasted. Now press ' + ($('sKeySave').textContent.trim()) + '.');
    };
    // The address each source stands for. Naming it explicitly means the choice made
    // here always wins over an address that happens to be set in the environment.
    const sourceBase = () => (source === 'anthropic' ? (st.anthropicBaseURL || '') : source === 'google' ? (st.googleBaseURL || '') : $('sBase').value.trim());
    $('sKeySave').onclick = async () => {
      const key = $('sKey').value.trim();
      const base = sourceBase();
      if (!key && !connected) return msg('Paste your API key first.', 'bad');
      if (source === 'gateway' && !base && !st.envBaseURL) return msg('Enter the base URL your provider gave you.', 'bad');
      if (key && source === 'anthropic' && !/^sk-ant-/.test(key)) return msg("That isn't an Anthropic key (they start with sk-ant-). Choose “Gateway or custom URL” and add its address.", 'bad');
      if (key && source === 'google' && !/^AIza/.test(key)) return msg("That isn't a Google key (they start with AIza). Press “Get a free key” to make one.", 'bad');
      try {
        await api.setApiKey(key || undefined, base);
      } catch (e) {
        return msg(cleanIpcError(e), 'bad');
      }
      SET.keySource = null;
      await showSettings('ai');
      // The key and address are already in: fetch that provider's models and logos now,
      // even if the test below trips (a slow server shouldn't hide the new model list).
      refreshModels().catch(() => {});
      check();
    };
    $('sKeyClear')?.addEventListener('click', async () => {
      try {
        // Forget the key saved here, so the one in this PC's environment is used.
        await api.setApiKey('', st.apiBaseURLInUse || '');
      } catch (e) {
        return msg(cleanIpcError(e), 'bad');
      }
      SET.keySource = null;
      await showSettings('ai');
      refreshModels().catch(() => {});
    });
    // Block-bodied on purpose: an expression-bodied handler that evaluates to false
    // (a key that is not Enter) cancels the keydown, and then the browser types
    // nothing at all into the field.
    for (const id of ['sKey', 'sBase']) $(id).onkeydown = (e) => { if (e.key === 'Enter') $('sKeySave').click(); };
    $('sKeyTest').onclick = check;
    // ---------------- more AI providers ----------------
    const useProvider = async (name) => {
      try {
        S.settings = await setSetting({ apiProvider: name });
        await showSettings('ai');
        await refreshModels();
      } catch (e) { toast(cleanIpcError(e)); }
    };
    const renderProviders = () => {
      const list = (S.settings.apiProviders || []).filter((p) => p?.name);
      const activeBox = $('provActive');
      const active = S.settings.apiProvider || '';
      if (!list.length) {
        activeBox.innerHTML = '';
        activeBox.hidden = true;
      } else {
        activeBox.hidden = false;
        activeBox.innerHTML = `<div class="lbl"><b>AI account in use</b><span>Chat, computer use and search all go through this one. Switching keeps every provider saved, so you can come back to it in a click.</span></div>
          <select class="field" id="provInUse" style="width:280px">${['', ...list.map((p) => p.name)].map((n) => `<option value="${escapeHtml(n)}">${n === '' ? `Main account (${escapeHtml(S.settings.apiHost || 'no address yet')})` : escapeHtml(n)}${n === active ? ' — in use' : ''}</option>`).join('')}</select>`;
        $('provInUse').value = active;
        $('provInUse').onchange = (e) => useProvider(e.target.value || '');
      }
      const box = $('provBox');
      box.innerHTML = list.map((p) => `
        <div class="prov-g${active === p.name ? ' on' : ''}" data-was="${escapeHtml(p.name)}">
          <div class="key-row"><input class="field prov-name" spellcheck="false" autocomplete="off" value="${escapeHtml(p.name)}" /><span class="grow"></span>${active === p.name ? `<span class="prov-pill">${ICONS.check}<span>In use</span></span>` : '<button class="btn ghost" data-a="use"><span>Use</span></button>'}<button class="btn ghost" data-a="del" title="Removes it, and forgets its key"><span>Remove</span></button></div>
          <div class="key-row"><input class="field prov-base" spellcheck="false" autocomplete="off" value="${escapeHtml(p.baseURL || '')}" placeholder="Base URL, e.g. https://api.cerebras.ai or https://openrouter.ai/api/v1" style="flex:1 1 230px" /><button class="btn ghost" data-a="test"><span>Test</span></button></div>
          <div class="key-row"><input class="field prov-key" type="password" autocomplete="off" spellcheck="false" placeholder="${p.hasKey ? `Key saved ${p.keyHint}. Paste to replace` : 'Paste the key for this provider'}" style="flex:1 1 200px" /><button class="btn mint" data-a="save"><span>Save</span></button></div>
          <span class="key-msg"></span>
        </div>`).join('');
      for (const row of box.querySelectorAll('.prov-g')) {
        const was = row.dataset.was;
        const msgEl = row.querySelector('.key-msg');
        const say = (text) => { msgEl.textContent = text; };
        const nameOf = () => row.querySelector('.prov-name').value.trim() || was;
        row.querySelector('[data-a="use"]')?.addEventListener('click', () => useProvider(was));
        row.querySelector('[data-a="del"]').onclick = async () => {
          try {
            S.settings = await setSetting({ apiProviders: (S.settings.apiProviders || []).filter((x) => x?.name !== was) });
            toast(`${was} removed`);
            await showSettings('ai');
            // If it was in use, the main account steps back in: refresh what follows it.
            refreshModels().catch(() => {});
          } catch (e) { say(cleanIpcError(e)); }
        };
        row.querySelector('[data-a="save"]').onclick = async () => {
          const name = nameOf();
          const base = row.querySelector('.prov-base').value.trim();
          const key = row.querySelector('.prov-key').value.trim();
          if (!name) return say('Name it first, for example Cerebras or OpenRouter.');
          if (base && !/^https?:\/\//i.test(base) && !/^[\w.-]+\.\w{2,}/.test(base)) return say("That API address doesn't look like a web address.");
          try {
            // The name and address travel through settings; a renamed provider brings
            // its encrypted key along (main does the move when it sees `was`).
            const nextList = (S.settings.apiProviders || []).map((x) => (x?.name === was ? { name, baseURL: base, ...(name !== was ? { was } : {}) } : { ...x }));
            S.settings = await setSetting({ apiProviders: nextList });
            if (key) {
              S.settings = await api.setApiKey(key, undefined, name);
              row.querySelector('.prov-key').value = '';
            }
            toast(`Saved ${name}`);
            await showSettings('ai');
            // A saved provider is immediately usable: its key and address decide what
            // Island talks to, so the model list and logos follow without a restart.
            refreshModels().catch(() => {});
          } catch (e) { say(cleanIpcError(e)); }
        };
        row.querySelector('[data-a="test"]').onclick = async () => {
          say('Checking…');
          try {
            const r = await api.checkKey({ provider: was });
            say(r.message);
          } catch (e) { say(cleanIpcError(e)); }
        };
      }
    };
    const addProvider = async () => {
      // A row ready to fill in; the name can be changed right there.
      const all = S.settings.apiProviders || [];
      const names = new Set(all.map((p) => p?.name));
      let n = all.length;
      let name = `Provider ${n + 1}`;
      while (names.has(name)) name = `Provider ${++n}`;
      try {
        S.settings = await setSetting({ apiProviders: [...all, { name, baseURL: '' }] });
        await showSettings('ai');
        const row = $('provBox').querySelector(`.prov-g[data-was="${CSS.escape(name)}"]`);
        row?.querySelector('.prov-name')?.select();
      } catch (e) { toast(cleanIpcError(e)); }
    };
    $('provAdd').onclick = addProvider;
    renderProviders();
  },

  // General: how Island looks and behaves on your screen.
  async general(main) {
    const st = S.settings;
    main.innerHTML = head('General', 'How Island looks and how it sits on your screen.') +
      `<div class="sgroup-h">Look</div>
      <div class="sgroup">
        <div class="srow stack"><div class="lbl"><b>Language</b><span>Island's buttons and messages. Answers follow the language you write or speak in.</span></div>${seg('sUiLang', [['en', 'English'], ['hi', 'हिन्दी']])}</div>
        <div class="srow stack"><div class="lbl"><b>Text size</b><span>Bigger text is easier to read. Everything in Island grows with it.</span></div>${seg('sTextSize', [['normal', 'Normal'], ['large', 'Large'], ['larger', 'Larger']])}</div>
        <div class="srow stack"><div class="lbl"><b>Colours</b></div>${seg('sTheme', [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']])}</div>
      </div>
      <div class="sgroup-h">Behaviour</div>
      <div class="sgroup">
        ${row('Show Island when idle', 'Off means it only appears when you press the shortcut', '<button class="toggle" id="sAlways"></button>')}
        ${row('Start with Windows', null, '<button class="toggle" id="sLogin"></button>')}
        ${row('Position and size', 'Drag the grip to move it; drag an edge or corner to resize. Double-click either to reset.', '<button class="btn ghost" id="sResetPos">Reset position</button><button class="btn ghost" id="sResetSize">Reset size</button>')}
        ${row('Is Island ready?', '<span id="sHealthOut">Checks your AI account, that answers come back, and screen access.</span>', `<button class="btn ghost" id="sHealth">${ICONS.circleCheck}<span>Check now</span></button>`)}
      </div>`;
    wireSeg('sTextSize', 'textSize', st.textSize || 'normal');
    wireSeg('sUiLang', 'uiLanguage', st.uiLanguage || 'en');
    // Hindi applies at once; going back to English redraws the page.
    $('sUiLang').addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v || v === I18n.get()) return;
      setTimeout(() => (v === 'en' ? api.reloadUi() : I18n.set(v)), 120);
    });
    wireSeg('sTheme', 'theme', st.theme || 'system');
    $('sHealth').onclick = async () => {
      const out = $('sHealthOut');
      $('sHealth').disabled = true;
      out.innerHTML = '<span class="spinner"></span> Checking …';
      const h = await api.healthCheck(true).catch((e) => ({ ok: false, items: [{ ok: false, text: cleanIpcError(e) }] }));
      renderHealth(h);
      out.innerHTML = h.items.map((i) => `<span class="${i.ok ? 'status-ok' : 'status-bad'}">${i.ok ? '✓' : '✕'} ${escapeHtml(i.text)}</span>`).join('<br>');
      $('sHealth').disabled = false;
    };
    $('sResetPos').onclick = () => api.resetPosition();
    $('sResetSize').onclick = () => {
      api.resetSize();
      toast('Size reset');
    };
    wireToggle('sAlways', 'alwaysShowIsland', st.alwaysShowIsland);
    wireToggle('sLogin', 'launchAtLogin', st.launchAtLogin);
  },

  async model(main) {
    const st = S.settings;
    main.innerHTML = head('Model', 'Which model answers, and how hard it thinks.') +
      `<div class="sgroup">
        ${row('Model', `${escapeHtml(modelInfo(st.model).name)} <span style="font-family:var(--mono);font-size:11px">${escapeHtml(st.model)}</span>`, `<button class="btn ghost model-btn" id="sModel">${logoTile(st.model)}<span>Choose…</span></button>`)}
        ${row('Effort', 'How hard the model should think. Higher means deeper thinking, slower replies and more tokens. Models call this different things, and Island uses the name each one knows', seg('sEffort', EFFORTS.map((e) => [e, e])))}
        ${row('Answer length', 'How much Island writes. Short gives just the answer', seg('sAnswer', [['short', 'Short'], ['normal', 'Normal'], ['detailed', 'Detailed']]))}
        ${row('Study mode', 'For homework and exam questions, Island gives a hint or the first step and lets you try, then the full solution when you ask', '<button class="toggle" id="sStudy"></button>')}
        ${row('Picture reader', 'The vision model Island uses to look closely at charts, photos, forms and small print, and to read pictures for models that can\'t see', '<input class="field" id="sVisionModel" style="width:180px" spellcheck="false" />')}
      </div>`;
    $('sModel').onclick = (e) => {
      e.stopPropagation();
      openPicker();
    };
    wireSeg('sEffort', 'effort', st.effort);

    wireSeg('sAnswer', 'answerStyle', st.answerStyle || 'normal');
    wireToggle('sStudy', 'studyMode', !!st.studyMode);
    $('sVisionModel').value = st.visionModel || 'gemini-3.5-flash';
    $('sVisionModel').onchange = (e) => { if (e.target.value.trim()) setSetting({ visionModel: e.target.value.trim() }); };
  },

  // Web search: where the searches come from, and the keys for them.
  async search(main) {
    const st = S.settings;
    const info = await api.searchServices().catch(() => ({}));
    const ORDER = ['auto', 'tavily', 'brave', 'serper', 'exa', 'firecrawl', 'searxng', 'google', 'anthropic', 'openrouter', 'duckduckgo'];
    const NAMES = { auto: 'Automatic', duckduckgo: 'DuckDuckGo', searxng: 'SearXNG (your own)' };
    const HOW = {
      auto: 'Your AI service searches when it can. Otherwise a key you saved below, or DuckDuckGo.',
      duckduckgo: 'No key needed and always on, but the weakest of these for current news.',
      searxng: 'Your own SearXNG instance. Nothing goes to anyone else.',
    };
    const current = st.searchProvider || 'auto';
    const keyFor = (id) => st.searchKeys?.[id];
    // The service's own logo, or its first letter when it has none.
    const logoOf = (id, svc) => {
      if (id === 'auto') return `<span class="srch-l" aria-hidden="true">${ICONS.globe}</span>`;
      const svg = svc.logo && window.LOGOS?.[svc.logo];
      return `<span class="srch-l" aria-hidden="true">${svg || escapeHtml((svc.name || NAMES[id] || id)[0].toUpperCase())}</span>`;
    };

    main.innerHTML = head('Web search', 'Island can look things up on the web when a question needs facts that may have changed.') +
      `<div class="sgroup">
        ${row('Let Island search the web', 'Island looks things up when the answer may be out of date, and reads the pages it finds', '<button class="toggle" id="sWeb"></button>')}
      </div>
      <div class="srch-sec">
        <div class="srch-h" id="srchH">Where the search comes from</div>
        <div class="srch-list" id="searchList" role="radiogroup" aria-labelledby="srchH"></div>
      </div>
      <p class="set-desc">Island sends the words you searched for to the service you pick, and that service sends back the pages it found. Your API keys stay on this PC, encrypted by Windows.</p>`;

    const list = $('searchList');
    list.classList.toggle('off', !st.webSearch);
    wireToggle('sWeb', 'webSearch', st.webSearch, (s) => list.classList.toggle('off', !s.webSearch));
    const rows = ORDER.map((id) => {
      const svc = info[id] || {};
      const name = svc.name || NAMES[id] || id;
      const how = svc.how || HOW[id] || '';
      const needsKey = svc.key === true;
      const needsUrl = svc.url === true;
      const have = keyFor(id);
      const on = current === id;
      const extra = needsUrl
        ? `<div class="key-row"><input class="field" type="text" placeholder="http://localhost:8080" spellcheck="false" aria-label="Your SearXNG address" value="${escapeHtml(st.searchUrl || '')}" /><button class="btn ghost" data-a="url" aria-label="Save the SearXNG address">Save</button></div>`
        : needsKey
          ? `<div class="key-row"><input class="field" type="password" autocomplete="off" spellcheck="false" placeholder="${have ? 'Key saved. Paste a new one to replace it' : 'Paste your key'}" aria-label="${escapeHtml(name)} key" />${have ? `<button class="btn ghost" data-a="del" aria-label="Remove the ${escapeHtml(name)} key">Remove</button>` : ''}<button class="btn ghost" data-a="save" aria-label="Save the ${escapeHtml(name)} key">Save</button></div>`
          : '';
      const test = id === 'auto' || id === 'duckduckgo' || needsKey || needsUrl
        ? `<button class="btn ghost" data-a="test" aria-label="Test ${escapeHtml(name)}">Test</button>`
        : '';
      return `<div class="srch${on ? ' on' : ''}" data-id="${id}">
        <input type="radio" id="srch-${id}" name="srchService" value="${id}" ${on ? 'checked' : ''} aria-labelledby="srch-t-${id}" aria-describedby="srch-b-${id}" />
        ${logoOf(id, svc)}
        <span class="srch-t" id="srch-t-${id}">${escapeHtml(name)}${have ? '<i class="srch-ok">key saved</i>' : ''}</span>
        <span class="srch-b" id="srch-b-${id}">${how}</span>
        <span class="srch-x">${extra}${test}<span class="srch-msg" role="status"></span></span>
      </div>`;
    });
    list.innerHTML = rows.join('');

    const setProvider = async (id) => {
      S.settings = await api.setSettings({ searchProvider: id });
      list.querySelectorAll('.srch').forEach((r) => r.classList.toggle('on', r.dataset.id === id));
      toast(`Web search: ${info[id]?.name || NAMES[id] || id}`);
      announce(`Web search is now ${info[id]?.name || NAMES[id] || id}.`);
    };
    list.querySelectorAll('.srch').forEach((r) => {
      const id = r.dataset.id;
      const msg = r.querySelector('.srch-msg');
      const radio = r.querySelector('input[type=radio]');
      const say = (text, kind = '') => {
        // The message sits in a role="status" box, so a screen reader reads it out.
        msg.textContent = text;
        msg.className = `srch-msg ${kind}`.trim();
      };
      // Put a card back in view after the page is redrawn. The scroll is set directly:
      // the layout has just changed, so a smooth scroll would land in the wrong place.
      const showCard = (which) => {
        const box = $('body');
        const t = document.getElementById(`srch-t-${which}`);
        if (!box || !t) return;
        box.scrollTop += t.getBoundingClientRect().top - box.getBoundingClientRect().top;
      };
      radio.onchange = () => setProvider(id);
      // Clicking anywhere on the card picks the service, except on the buttons and the field.
      r.addEventListener('click', (e) => {
        if (e.target === radio || e.target.closest('button, input, a')) return;
        if (radio.checked) return;
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));
      });
      r.querySelector('[data-a=save]')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const field = r.querySelector('input.field');
        const key = field.value.trim();
        if (!key) return field.focus();
        try {
          S.settings = await api.searchKey({ service: id, key });
          field.value = '';
          toast('Key saved.');
          announce(`${name} key saved.`);
          // Back to the same card (the page is redrawn), and the keyboard follows it.
          await showSettings('ai');
          showCard(id);
          document.querySelector(`#srch-${id}`)?.focus({ preventScroll: true });
        } catch (err) { say(cleanIpcError(err), 'bad'); }
      });
      r.querySelector('input.field')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        (r.querySelector('[data-a=save]') || r.querySelector('[data-a=url]'))?.click();
      });
      r.querySelector('[data-a=del]')?.addEventListener('click', async (e) => {
        e.preventDefault();
        S.settings = await api.searchKey({ service: id, key: '' });
        toast('Key removed.');
        announce(`${name} key removed.`);
        await showSettings('ai');
        showCard(id);
        document.querySelector(`#srch-${id}`)?.focus({ preventScroll: true });
      });
      r.querySelector('[data-a=url]')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const field = r.querySelector('input.field');
        try {
          S.settings = await api.searchKey({ service: id, url: field.value.trim() });
          say('Address saved.', 'good');
        } catch (err) { say(cleanIpcError(err), 'bad'); }
      });
      r.querySelector('[data-a=test]')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const btn = r.querySelector('[data-a=test]');
        btn.disabled = true;
        say('Searching…', 'busy');
        try {
          const res = await api.searchTest({ service: id, query: 'population of Spain 2024' });
          const first = res.sources?.[0];
          const what = first?.title || (res.text || '').split('\n')[0].slice(0, 80);
          say(`It works: ${what || 'no results came back'}`, 'good');
        } catch (err) {
          say(cleanIpcError(err), 'bad');
        } finally {
          btn.disabled = false;
        }
      });
    });
  },

  async agent(main) {
    const st = S.settings;
    const mode = MODES[st.permissionMode] ? st.permissionMode : 'ask';
    main.innerHTML = head('What Island may do on its own', 'You can also change this with the line under “Can use my PC” at the bottom, or Shift+Tab in the message box.') +
      `<div class="modes">${MODE_ORDER.map((m) => `<button class="mode${m === mode ? ' on' : ''}" data-mode="${m}">${ICONS[MODES[m].icon]}<b>${MODES[m].title}</b><span>${MODES[m].desc}</span><i class="ck">${ICONS.check}</i></button>`).join('')}</div>
      ${mode === 'bypass' ? `<div class="warnbox">${ICONS.alert}<span>Island now runs commands and tools without asking. It still won't type passwords or payment details, and your shortcut still stops it.</span></div>` : ''}
      <div class="sgroup-h">Using your PC</div>
      <div class="sgroup">
        ${row('Mouse and keyboard', 'Lets Island click, type and scroll in your apps. Same as the “Can use my PC” switch.', seg('sComputer', [['ask', 'On'], ['off', 'Off']]))}
        ${row('Speed', 'Fast moves and types quickly, waits only until the screen settles, and thinks less between simple steps', seg('sSpeed', [['fast', 'Fast'], ['normal', 'Normal'], ['careful', 'Careful']]))}
        ${row('PowerShell', 'Run commands on your PC (asks first unless the mode allows it)', seg('sShell', [['ask', 'On'], ['off', 'Off']]))}
      </div>
      <div class="sgroup-h">Connector tools you always allow</div>
      <div class="sgroup"><div class="allow-list" id="sAllowed"></div></div>`;
    main.querySelectorAll('.mode').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
    wireSeg('sComputer', 'computerUse', st.computerUse);
    wireSeg('sSpeed', 'computerSpeed', st.computerSpeed || 'fast');
    wireSeg('sShell', 'shellMode', st.shellMode);
    const allowed = st.mcpAllowed || [];
    $('sAllowed').innerHTML = allowed.map((t, i) => `<span class="chip">${ICONS.plug}<span>${escapeHtml(t.replace(/^mcp__/, '').replace('__', ': '))}</span><button data-i="${i}" title="Stop always allowing">${ICONS.close}</button></span>`).join('');
    $('sAllowed').querySelectorAll('button').forEach((b) => (b.onclick = async () => {
      await setSetting({ mcpAllowed: allowed.filter((_, i) => i !== +b.dataset.i) });
      showSettings('agent');
    }));
  },

  async memory(main) {
    const st = S.settings;
    const [items, sp] = await Promise.all([api.memoryList(), api.memorySpaces()]);
    const counts = {};
    for (const m of items) counts[m.category || 'fact'] = (counts[m.category || 'fact'] || 0) + 1;
    const active = sp.spaces.find((s) => s.active) || sp.spaces[0];
    main.innerHTML = head('Memory', 'What Island knows about you across chats. It uses these quietly when they help, shows which ones under each reply, and you can edit or remove anything.', `<button class="btn ghost" id="sMemImport" title="Import memories from a file (Island export, or a list like ChatGPT's memories)">${ICONS.upload}<span>Import</span></button><button class="btn ghost" id="sMemExport" title="Save all your memories to a file">${ICONS.download}<span>Export</span></button>`) +
      `<div class="sgroup">
        ${row('Remember things about me', 'Use and save memories in new chats', '<button class="toggle" id="sMemOn"></button>')}
        ${row('Learn automatically', 'After each reply, quietly save lasting facts you mention (you can undo each one)', '<button class="toggle" id="sMemAuto"></button>')}
        ${row('Ask before saving', 'Personal topics (health, money, beliefs, relationships, addresses) always need your OK', seg('sMemConfirm', [['sensitive', 'Personal things'], ['always', 'Everything']]))}
        ${row('Search past chats', 'Let Island look through your earlier conversations when you refer to them', '<button class="toggle" id="sChatSearch"></button>')}
      </div>
      <div class="sgroup-h">Memory spaces <span class="cap">New chats use the selected space; the others stay out of them</span></div>
      <div class="spaces" id="sSpaces">${sp.spaces.map((s) => `<button class="space${s.active ? ' on' : ''}" data-id="${escapeHtml(s.id)}">${ICONS[/work|office|job/i.test(s.name) ? 'briefcase' : /school|study|class/i.test(s.name) ? 'school' : s.id === 'personal' ? 'user' : 'layers']}<span></span><i>${s.count}</i></button>`).join('')}<button class="space add" id="sSpaceAdd" title="New memory space">${ICONS.plus}<span>New space</span></button>
        <span class="grow"></span><button class="icon-btn small" id="sSpaceRename" title="Rename this space">${ICONS.edit}</button><button class="icon-btn small" id="sSpaceDel" title="${sp.spaces.length > 1 ? 'Delete this space and its memories' : 'Forget everything in this space'}">${ICONS.trash}</button></div>
      <div class="sgroup-h">Saved memories</div>
      <div class="mem-tools"><div class="picker-search" style="flex:1 1 180px;height:34px"><span class="ps-ic">${ICONS.search}</span><input id="sMemQ" placeholder="Search memories" spellcheck="false" /></div></div>
      <div class="cats" id="sMemCats"><button class="cat" data-c="all">All<i>${items.length}</i></button>${Object.entries(MEM_CATS).map(([c, [, l]]) => `<button class="cat" data-c="${c}">${l}<i>${counts[c] || 0}</i></button>`).join('')}</div>
      <div class="mem-list" id="sMemList"></div>
      <div class="mem-add"><input class="field" id="sMemInput" placeholder="Add a memory, e.g. “Studies class 11 chemistry”" /><select class="field" id="sMemCat">${Object.entries(MEM_CATS).map(([c, [, l]]) => `<option value="${c}">${l}</option>`).join('')}<option value="" selected>Auto category</option></select><button class="btn mint" id="sMemAdd">${ICONS.plus}<span>Add</span></button></div>`;
    wireToggle('sMemOn', 'memoryOn', st.memoryOn !== false);
    wireToggle('sMemAuto', 'memoryAuto', st.memoryAuto !== false);
    wireSeg('sMemConfirm', 'memoryConfirm', st.memoryConfirm || 'sensitive');
    wireToggle('sChatSearch', 'chatSearch', st.chatSearch !== false);
    $('sSpaces').querySelectorAll('.space[data-id]').forEach((b) => {
      b.querySelector('span').textContent = sp.spaces.find((s) => s.id === b.dataset.id)?.name || b.dataset.id;
      b.onclick = async () => {
        if (b.classList.contains('on')) return;
        await api.memorySpaceSet(b.dataset.id);
        toast(`New chats now use “${b.querySelector('span').textContent}”`);
        showSettings('memory');
      };
    });
    // Small inline name field instead of a browser prompt (which Electron doesn't support).
    const nameField = (anchor, value, done) => {
      const f = document.createElement('input');
      f.className = 'field space-name';
      f.value = value;
      f.placeholder = 'Name, e.g. Work';
      anchor.replaceWith(f);
      f.focus();
      f.select();
      let fired = false;
      const finish = (ok) => { if (fired) return; fired = true; ok && f.value.trim() ? done(f.value.trim()) : showSettings('memory'); };
      f.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
      f.onblur = () => finish(true);
    };
    $('sSpaceAdd').onclick = () => nameField($('sSpaceAdd'), '', async (name) => {
      try {
        await api.memorySpaceAdd(name);
        toast(`Made “${name}”. New chats use it`);
      } catch (e) { toast(cleanIpcError(e).slice(0, 90)); }
      showSettings('memory');
    });
    $('sSpaceRename').onclick = () => nameField($('sSpaces').querySelector('.space.on'), active.name, async (name) => {
      await api.memorySpaceRename(active.id, name);
      showSettings('memory');
    });
    $('sSpaceDel').onclick = async () => {
      const last = sp.spaces.length === 1;
      const ok = await localConfirm({
        icon: 'trash', danger: true,
        title: last ? `Forget everything in “${active.name}”?` : `Delete the “${active.name}” space?`,
        body: `${active.count ? `Its ${active.count === 1 ? 'memory' : `${active.count} memories`} will be deleted for good.` : 'It has no memories.'} Export first if you might want ${active.count === 1 ? 'it' : 'them'} back.`,
        okLabel: last ? 'Forget all' : 'Delete space',
      });
      if (!ok) return;
      await api.memorySpaceRemove(active.id);
      toast(last ? 'Forgotten' : 'Space deleted');
      showSettings('memory');
    };
    $('sMemExport').onclick = async () => {
      try {
        const f = await api.memoryExport();
        if (f) toast('Exported');
      } catch (e) { toast(cleanIpcError(e).slice(0, 90)); }
    };
    $('sMemImport').onclick = async () => {
      try {
        const r = await api.memoryImport();
        if (!r) return;
        toast(`Imported ${r.added} new${r.merged ? `, updated ${r.merged}` : ''}${r.skipped ? `, skipped ${r.skipped}` : ''}`);
        showSettings('memory');
      } catch (e) { toast(cleanIpcError(e).slice(0, 90)); }
    };
    $('sMemQ').value = SET.memQ;
    $('sMemQ').oninput = (e) => {
      SET.memQ = e.target.value;
      renderMemories(items);
    };
    $('sMemCats').querySelectorAll('.cat').forEach((b) => {
      b.classList.toggle('on', b.dataset.c === SET.memCat);
      b.onclick = () => {
        SET.memCat = b.dataset.c;
        $('sMemCats').querySelectorAll('.cat').forEach((x) => x.classList.toggle('on', x === b));
        renderMemories(items);
      };
    });
    const add = async () => {
      const v = $('sMemInput').value.trim();
      if (!v) return;
      try {
        await api.memoryAdd(v, $('sMemCat').value || undefined);
        toast('Saved. New chats will know it');
        showSettings('memory');
      } catch (e) {
        toast(cleanIpcError(e).slice(0, 90));
      }
    };
    $('sMemAdd').onclick = add;
    $('sMemInput').onkeydown = (e) => { if (e.key === 'Enter') add(); };
    renderMemories(items);
  },

  async connectors(main) {
    main.innerHTML = head('Connectors', 'Give Island extra skills: your files, Excel, a browser it can drive, Notion and more. One click to add; nothing to install.', `<button class="btn ghost" id="mcpReload" title="Reconnect all">${ICONS.refresh}</button>`) +
      `<div class="sgroup-h">Add a connector</div>
      <div class="cat-grid" id="mcpCatalog"></div>
      <div class="tiny" id="mcpRuntime"></div>
      <div class="sgroup-h">Your connectors</div>
      <div id="mcpList"></div>
      <div class="sgroup-h">Advanced: add any MCP server</div>
      <div class="sgroup">
        <div class="srv-add"><input class="field" id="mcpName" placeholder="Name, e.g. files" spellcheck="false" /><input class="field" id="mcpCmd" placeholder="Command or URL, e.g. npx -y @modelcontextprotocol/server-filesystem C:\\Users" spellcheck="false" /><button class="btn mint" id="mcpAdd">${ICONS.plus}<span>Add</span></button></div>
        <div class="tiny">Local servers run as a command; remote ones use an <code>https://…/mcp</code> URL. Island asks before using a connector tool unless it's marked read-only (in Auto mode) or you choose “Always allow”.</div>
        <div class="srow"><div class="lbl"><b>More options</b><span>Edit the JSON config (env vars, headers), or bring over servers from Claude Desktop</span></div><button class="btn ghost" id="mcpImport">${ICONS.download}<span>Import from Claude Desktop</span></button><button class="btn ghost" id="mcpFile">${ICONS.file}<span>Open config</span></button></div>
      </div>`;
    $('mcpReload').onclick = async () => {
      toast('Reconnecting…');
      renderMcp(await api.mcpReload());
    };
    $('mcpImport').onclick = async () => {
      const n = await api.mcpImport();
      toast(n ? `Imported ${n} server${n > 1 ? 's' : ''}` : 'No new servers found in Claude Desktop');
      renderMcp(await api.mcpStatus());
    };
    $('mcpFile').onclick = () => api.mcpOpenConfig();
    $('mcpAdd').onclick = async () => {
      const name = $('mcpName').value.trim();
      const cmd = $('mcpCmd').value.trim();
      if (!name || !cmd) return toast('Give it a name and a command or URL');
      try {
        renderMcp(await api.mcpAdd(name, parseServerLine(cmd)));
        $('mcpName').value = '';
        $('mcpCmd').value = '';
      } catch (e) {
        toast(cleanIpcError(e).slice(0, 90));
      }
    };
    const [status, cat] = await Promise.all([api.mcpStatus(), api.mcpCatalog()]);
    renderMcp(status);
    SET.catalog = cat.items;
    renderCatalog(status);
    $('mcpRuntime').innerHTML = `Connectors run on ${escapeHtml(cat.runtime)}. Keys you enter are encrypted by Windows and never written to the config file.`;
  },

  async voice(main) {
    const st = S.settings;
    main.innerHTML = head('Voice', 'Talking to Island, and how it talks back. Press Ctrl+Shift+L (or the waveform button) for a hands-free live conversation.') +
      `<div class="sgroup-h">Microphone</div>
      <div class="mic-card">
        <div class="mic-row"><select class="field" id="sMic"><option value="">Windows default microphone</option></select><button class="btn mint" id="sMicTest">${ICONS.mic}<span>Test</span></button></div>
        <div class="mic-meter" id="sMicMeter"><i></i></div>
        <div class="mic-msg" id="sMicMsg">Press Test and say something. The bar should move when you talk.</div>
      </div>
      <div class="sgroup-h">Spoken replies</div>
      <div class="sgroup">
        ${row('Speak replies', 'Read answers aloud with a Windows voice', seg('sSpeak', [['off', 'Off'], ['voice', 'After voice'], ['always', 'Always']]))}
        ${row('Voice', 'Island switches to a voice for the language it is speaking when Windows has one', '<select class="field" id="sVoice" style="width:190px"><option value="">Automatic</option></select><button class="btn ghost" id="sVoiceTry">' + ICONS.play + '<span>Try</span></button>')}
        ${row('Speaking speed', 'How fast the voice talks', seg('sRate', [['-1', 'Slower'], ['1', 'Normal'], ['3', 'Faster'], ['5', 'Fastest']]))}
        ${row('Read lesson steps aloud', 'When Island teaches you something, it says each step out loud', '<button class="toggle" id="sTeachVoice"></button>')}
      </div>
      <div class="sgroup-h">Voices for other languages</div>
      <div class="sgroup">
        ${row('Add a Windows voice', 'Free from Microsoft and works offline once added. Windows asks for your OK, then downloads it', '<select class="field" id="sAddLang" style="width:190px"></select><button class="btn ghost" id="sAddLangBtn">' + ICONS.download + '<span>Add</span></button>')}
      </div>
      <div class="sgroup-h" id="voiceOnline">Speech services (your own keys)</div>
      <div class="sgroup">
        <div class="srow"><div class="lbl"><span>Island works without these. Add a key from a speech service you choose for faster or more natural voice. Keys are encrypted by Windows and only sent to that service.</span></div></div>
        ${row('Speech to text', 'Turns what you say into text', seg('sSttProv', [['gateway', 'AI gateway'], ['google', 'Google'], ['openai', 'OpenAI'], ['groq', 'Groq'], ['mistral', 'Mistral'], ['fireworks', 'Fireworks'], ['deepgram', 'Deepgram'], ['sarvam', 'Sarvam'], ['elevenlabs', 'ElevenLabs'], ['assembly', 'Assembly'], ['azure', 'Azure'], ['custom', 'Add your own']], 'wrap'))}
        <div class="srow stack" id="sSttBox"></div>
        ${row('Natural voice', 'Used when Windows has no voice for the language, or always', seg('sVoiceProv', [['azure', 'Azure'], ['google', 'Google'], ['elevenlabs', 'ElevenLabs'], ['sarvam', 'Sarvam'], ['speko', 'Speko'], ['openai', 'OpenAI'], ['groq', 'Groq'], ['cartesia', 'Cartesia'], ['deepgram', 'Deepgram'], ['minimax', 'MiniMax'], ['custom', 'Add your own']], 'wrap'))}
        <div class="srow stack" id="sVoiceBox"></div>
        ${row('Use the natural voice', 'When Windows has no voice for the language, or for every sentence', seg('sOnline', [['fallback', 'When needed'], ['always', 'Always'], ['off', 'Off']]))}
        ${row('Check', '<span id="sAzMsg">Plays a sentence with the natural voice</span>', '<button class="btn ghost" id="sAzTryEn">' + ICONS.play + '<span>English</span></button><button class="btn ghost" id="sAzTryHi">' + ICONS.play + '<span>हिन्दी</span></button>')}
      </div>
      <div class="sgroup-h">Live conversation</div>
      <div class="sgroup">
        ${row('Patience', 'How long you can pause before Island answers. Patient suits slower, thoughtful speech', seg('sPatience', [['quick', 'Quick'], ['normal', 'Normal'], ['patient', 'Patient']]))}
        ${row('Interrupting Island', 'Voice: talk over it. Tap: tap the orb, press Space or your talk hotkey, so coughs and noise never cut it off', seg('sInterrupt', [['voice', 'Voice'], ['tap', 'Tap only'], ['off', 'Off']]))}
        ${row('Live transcription', 'Which service turns your speech into text during a hands-free conversation', seg('sLiveStt', [['same', 'Same as above'], ['gateway', 'AI gateway'], ['google', 'Google'], ['openai', 'OpenAI'], ['groq', 'Groq'], ['mistral', 'Mistral'], ['fireworks', 'Fireworks'], ['deepgram', 'Deepgram'], ['sarvam', 'Sarvam'], ['elevenlabs', 'ElevenLabs'], ['assembly', 'Assembly'], ['azure', 'Azure'], ['custom', 'Add your own']], 'wrap'))}
        <div class="srow stack" id="sLiveSttBox"></div>
        ${row('Transcription model', 'Turns your speech into text (needs audio input, e.g. gemini-3.5-flash-lite)', '<input class="field" id="sStt" style="width:180px" spellcheck="false" />')}
        ${row('Response time', S.voiceTiming ? `Last live reply: ${S.voiceTiming.total} s after you stopped talking (understanding ${S.voiceTiming.stt} s, thinking ${S.voiceTiming.think} s, voice ${S.voiceTiming.voice} s)` : 'Shown here after your next live conversation', '')}
      </div>`;
    wireSeg('sSpeak', 'speakReplies', st.speakReplies || 'voice');
    wireSeg('sRate', 'speechRate', st.speechRate ?? 1, Number);
    wireToggle('sTeachVoice', 'teachVoice', st.teachVoice !== false);
    wireSeg('sPatience', 'livePatience', st.livePatience || 'normal');
    wireSeg('sInterrupt', 'liveInterrupt', st.liveInterrupt || 'voice');
    for (const id of ['sPatience', 'sInterrupt']) $(id).addEventListener('click', () => setTimeout(() => LIVE.on && Voice.Live.setPause(LIVE_PAUSE[S.settings.livePatience] || LIVE_PAUSE.normal), 50));
    $('sVoice').onchange = (e) => setSetting({ speechVoice: e.target.value });
    $('sVoiceTry').onclick = () => Voice.speak("Hi, I'm Island. This is how I sound.");
    api.ttsVoices().then((list) => {
      for (const v of list || []) $('sVoice')?.add(new Option(`${v.name.replace(/^Microsoft /, '')} · ${langName(v.lang)}`, v.name));
      if ($('sVoice')) $('sVoice').value = (S.settings.speechVoice || '').replace(/ Desktop$/, '');
    }).catch(() => {});
    $('sStt').value = st.sttModel || 'gemini-3.5-flash-lite';
    $('sStt').onchange = (e) => { if (e.target.value.trim()) setSetting({ sttModel: e.target.value.trim() }); };

    // Windows voices for other languages: the ones Windows can download (mirrors
    // WINDOWS_VOICES in tts.js), marked when already on this PC.
    const ADDABLE = ['ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'th', 'tr', 'vi', 'zh'];
    api.ttsVoices().catch(() => []).then((list) => {
      const have = new Set((list || []).map((v) => v.lang.split('-')[0]));
      const sel = $('sAddLang');
      if (!sel) return;
      const opts = ADDABLE.map((l) => [l, langName(l)]).sort((a, b) => a[1].localeCompare(b[1]));
      for (const [l, n] of opts) sel.add(new Option(have.has(l) ? `${n} (on this PC)` : n, l));
      sel.value = opts.find(([l]) => !have.has(l))?.[0] || 'hi';
    });
    $('sAddLangBtn').onclick = (e) => installVoiceFor($('sAddLang').value, e.currentTarget).then((r) => { if (r.ok) setTimeout(() => showSettings('voicekeys'), 1500); });

    // Speech services the user brings a key for.
    const SERVICE_INFO = {
      google: { name: 'Google', how: 'Free key at <b>aistudio.google.com</b> → Get API key (has a free tier). For Google voices, also turn on “Cloud Text-to-Speech API” for that key’s project in console.cloud.google.com.' },
      deepgram: { name: 'Deepgram', how: 'Key at <b>console.deepgram.com</b> (new accounts get free credit). Transcribes while you talk, so live replies come faster, and speaks clear English and Spanish voices.' },
      sarvam: { name: 'Sarvam', how: 'Key at <b>dashboard.sarvam.ai</b> (new accounts get free credit). Best for Hindi, Hinglish and other Indian languages, for listening as well as speaking.' },
      elevenlabs: { name: 'ElevenLabs', how: 'Key at <b>elevenlabs.io</b> → Profile → API keys (free monthly allowance). Very natural voice in 30+ languages, and the Scribe transcriber.' },
      azure: { name: 'Azure', how: 'In <b>portal.azure.com</b>, create a “Speech” resource and copy Key 1 and its Region (free tier: 500,000 characters a month). Works for speech to text and natural voices, 140+ languages.' },
      speko: { name: 'Speko', how: 'Key at <b>speko.ai</b> → Dashboard → API keys. Every new account gets <b>$10 of credit</b> to try the voice models with, and there are 40+ voice models behind one key (ElevenLabs, Cartesia, Deepgram, Google, Sarvam-style Indian voices and more). Island lets Speko pick the best voice for the language. <a href="https://docs.speko.ai/" target="_blank" rel="noreferrer">The docs</a>.' },
      openai: { name: 'OpenAI', how: 'Key at <b>platform.openai.com</b> → API keys. Transcribes with gpt-4o-mini-transcribe and speaks with gpt-4o-mini-tts, which follows the language it is given. Costs a little per minute.' },
      groq: { name: 'Groq', how: 'Key at <b>console.groq.com</b> (a generous free tier). Whisper-large-v3-turbo turns speech into text; the PlayAI voice speaks English.' },
      mistral: { name: 'Mistral', how: 'Key at <b>console.mistral.ai</b> (has a free tier). Voxtral turns speech into text.' },
      fireworks: { name: 'Fireworks', how: 'Key at <b>fireworks.ai</b> → API keys. Whisper-v3-turbo turns speech into text, very fast.' },
      assembly: { name: 'AssemblyAI', how: 'Key at <b>assemblyai.com</b> (free tier, no card). Very accurate full sentences; the file goes through their queue, so it can take a few seconds more.' },
      cartesia: { name: 'Cartesia', how: 'Key at <b>cartesia.io</b> (free tier). Sonic-2 speaks fast and natural voices in 15+ languages, and Island picks a ready voice for each language.' },
      minimax: { name: 'MiniMax', how: 'Key at <b>platform.minimax.io</b> → Account Management keys (cheap, and free credit is sometimes on offer). speech-2.8 speaks through ready voices in Chinese, English and Japanese.' },
      custom: { name: 'Add your own', how: 'Any OpenAI-compatible server — a cloud service’s base URL, or one on this PC (Speaches, Kokoro, LocalAI, anything that answers the same way). A local server usually needs no key: leave the key box empty.' },
    };
    const keyForm = (box, service, extra = '') => {
      const info = SERVICE_INFO[service];
      const have = S.settings.speechKeys?.[service];
      box.innerHTML = `<span class="d">${info.how}</span><div class="key-row"><input class="field" type="password" autocomplete="off" spellcheck="false" placeholder="${have ? `${info.name} key saved. Paste to replace` : `Paste your ${info.name} key`}" /><button class="btn ghost" data-a="save">Save</button>${have ? '<button class="btn ghost" data-a="del">Remove</button>' : ''}</div>${extra}<span class="key-msg"></span>`;
      const field = box.querySelector('input.field');
      const msg = box.querySelector('.key-msg');
      box.querySelector('[data-a="save"]').onclick = async () => {
        const key = field.value.trim();
        if (!key) return field.focus();
        try {
          S.settings = await api.speechKey({ service, key, region: box.querySelector('.region')?.value.trim() || undefined });
          field.value = '';
          toast(`${info.name} key saved`);
          showSettings('voicekeys', 'voiceOnline');
        } catch (err) { msg.textContent = cleanIpcError(err); }
      };
      box.querySelector('[data-a="del"]')?.addEventListener('click', async () => {
        S.settings = await api.speechKey({ service, key: '' });
        showSettings('voicekeys', 'voiceOnline');
      });
      return msg;
    };
    // The user's own speech service: base URL + model (+ voice + format for speech), and
    // an optional key (a local server usually needs none). Fields save as they change.
    const ownForm = (box, kind) => {
      const isStt = kind === 'stt';
      const cfg = S.settings.customSpeech?.[kind] || {};
      const esc = (v) => escapeHtml(String(v || ''));
      box.innerHTML = `<span class="d">Any OpenAI-compatible server — a cloud service's base URL, or one on this PC (Speaches, Kokoro, LocalAI, anything that answers the same way). A local server usually needs no key: leave the key box empty. Island tries the address as given, then with /v1 added, and reads the answer whatever shape it comes in.</span>
<div class="key-row"><input class="field own-base" spellcheck="false" autocomplete="off" placeholder="Base URL, e.g. http://127.0.0.1:8000 or https://api.example.com/v1" value="${esc(cfg.base)}" style="flex:1 1 230px" />${isStt ? '' : '<input class="field own-voice" spellcheck="false" autocomplete="off" placeholder="Voice, e.g. alloy" value="' + esc(cfg.voice) + '" style="width:110px" />'}<input class="field own-model" spellcheck="false" autocomplete="off" placeholder="Model${isStt ? ' (optional)' : ''}, e.g. ${isStt ? 'whisper-1' : 'kokoro'}" value="${esc(cfg.model)}" style="width:150px" />${isStt ? '' : '<input class="field own-format" spellcheck="false" autocomplete="off" placeholder="Format mp3/wav" value="' + esc(cfg.format) + '" style="width:110px" />'}</div>
<div class="key-row"><input class="field" type="password" autocomplete="off" spellcheck="false" placeholder="${S.settings.speechKeys?.[isStt ? 'customStt' : 'customTts'] ? 'Key saved. Paste to replace' : 'Key (leave empty for a local server)'}" style="flex:1 1 200px" /><button class="btn ghost" data-a="keysave">Save</button>${S.settings.speechKeys?.[isStt ? 'customStt' : 'customTts'] ? '<button class="btn ghost" data-a="keydel">Remove</button>' : ''}<button class="btn ghost" data-a="try">${ICONS.check}<span>Check</span></button></div>
<span class="key-msg"></span>`;
      const msg = box.querySelector('.key-msg');
      const patch = async () => {
        const cur = S.settings.customSpeech || {};
        const next = { ...cur, [kind]: { ...cur[kind] } };
        next[kind].base = box.querySelector('.own-base').value.trim();
        next[kind].model = box.querySelector('.own-model').value.trim();
        if (!isStt) {
          next[kind].voice = box.querySelector('.own-voice').value.trim();
          next[kind].format = box.querySelector('.own-format').value.trim();
        }
        try { S.settings = await setSetting({ customSpeech: next }); } catch (err) { msg.textContent = cleanIpcError(err); }
      };
      for (const sel of ['.own-base', '.own-model', '.own-voice', '.own-format']) box.querySelector(sel)?.addEventListener('change', patch);
      const kfield = box.querySelector('input[type="password"]');
      box.querySelector('[data-a="keysave"]').onclick = async () => {
        const key = kfield.value.trim();
        if (!key) return kfield.focus();
        try { S.settings = await api.speechKey({ service: isStt ? 'customStt' : 'customTts', key }); kfield.value = ''; toast('Key saved'); showSettings('voicekeys', 'voiceOnline'); } catch (err) { msg.textContent = cleanIpcError(err); }
      };
      box.querySelector('[data-a="keydel"]')?.addEventListener('click', async () => {
        S.settings = await api.speechKey({ service: isStt ? 'customStt' : 'customTts', key: '' });
        showSettings('voicekeys', 'voiceOnline');
      });
      box.querySelector('[data-a="try"]').onclick = async () => {
        msg.textContent = 'Checking…';
        try {
          if (isStt) await api.speechSttTest();
          else await api.speechVoiceTest('en-US');
          msg.textContent = 'Your service works.';
        } catch (err) { msg.textContent = cleanIpcError(err); }
      };
    };
    const renderStt = () => {
      const p = S.settings.sttProvider || 'gateway';
      const box = $('sSttBox');
      if (p === 'gateway') {
        box.innerHTML = `<span class="d">Uses the transcription model below through your AI gateway. If your key is an Anthropic key, pick Google here instead: its free key works for anyone.</span>`;
        return;
      }
      if (p === 'custom') return ownForm(box, 'stt');
      const extra = p === 'azure' ? `<input class="field region" spellcheck="false" autocomplete="off" placeholder="Region, e.g. centralindia" value="${escapeHtml(S.settings.azureSpeechRegion || '')}" />` : '';
      const msg = keyForm(box, p, `${extra}<button class="btn ghost" data-a="test">${ICONS.check}<span>Check key</span></button>`);
      box.querySelector('.region')?.addEventListener('change', async (e) => { try { S.settings = await api.speechKey({ region: e.target.value.trim() }); } catch (err) { toast(cleanIpcError(err).slice(0, 80)); } });
      box.querySelector('[data-a="test"]').onclick = async () => {
        msg.textContent = 'Checking…';
        try { await api.speechSttTest(); msg.textContent = `${SERVICE_INFO[p].name} works.`; } catch (err) { msg.textContent = cleanIpcError(err); }
      };
    };
    // Voice pickers: every natural-voice service gets a dropdown of the voices it offers,
    // so one can be chosen instead of Island picking — and Speko's catalog comes with the
    // provider each voice belongs to (Fish Audio, Cartesia…), so a voice source can be
    // chosen there too. Lists are kept in the main process against the key that fetched
    // them: a new key shows that account's voices by itself, and Refresh asks again now.
    // (A picked voice says sentences in the languages it speaks; anything else still gets
    // a voice that fits.)
    const attachVoicePick = (box, p) => {
      const cur = S.settings.voiceChoices?.[p] || null;
      box.insertAdjacentHTML('beforeend', `<span class="d vpick-d"></span><div class="key-row"><select class="field vpick" spellcheck="false"></select>${p === 'speko' ? '<select class="field vsrc" style="flex:0 0 auto;width:140px"></select>' : ''}<button class="btn ghost vrefresh" title="Reads the voice list again, from the key saved now">${ICONS.refresh}<span>Refresh</span></button></div><span class="key-msg vmsg"></span>`);
      const sel = box.querySelector('.vpick');
      const srcSel = box.querySelector('.vsrc');
      const msg = box.querySelector('.vmsg');
      const pickD = box.querySelector('.vpick-d');
      if (pickD) pickD.innerHTML = p === 'speko'
        ? 'Voices the catalog carries, said by the provider each one belongs to (Fish Audio, Cartesia…). Automatic keeps Island choosing one that fits the language.'
        : p === 'custom' ? 'Voices your server lists — a pick here overrides the Voice field above while it is set. Automatic keeps that field.'
        : `Voices ${SERVICE_INFO[p].name} can say with. Automatic keeps Island choosing one that fits the language.`;
      const wantLang = (S.settings.uiLanguage || 'en').toLowerCase().split('-')[0];
      let got = null; // the fetched { voices, sources }
      const save = async (v) => {
        const next = { ...(S.settings.voiceChoices || {}) };
        if (v) next[p] = v; else delete next[p];
        try { S.settings = await setSetting({ voiceChoices: next }); } catch (err) { msg.textContent = cleanIpcError(err); }
      };
      const refill = (via) => {
        const list = ((got?.voices) || []).filter((v) => !via || v.via === via);
        const names = new Map((got?.sources || []).map((s) => [s.key, s.name]));
        const fam = (v) => (v.lang || []).some((c) => String(c).toLowerCase().split('-')[0] === wantLang);
        const ordered = [...list].sort((a, b) => (fam(b) - fam(a)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
        // The value carries the voice, and for an aggregator also the provider it belongs to.
        const val = (v) => (v.via ? `${v.id}\u001f${v.via}\u001f${v.name || ''}` : v.id);
        const label = (v) => (v.name ? `${v.name}${v.via && names.get(v.via) ? ` — ${names.get(v.via)}` : ''}` : v.id);
        sel.innerHTML = '<option value="">Automatic</option>' + ordered.map((v) => `<option value="${escapeHtml(val(v))}">${escapeHtml(label(v))}</option>`).join('');
        const curVal = cur ? (cur.via ? `${cur.voice}\u001f${cur.via}\u001f${cur.name || ''}` : cur.voice) : '';
        const have = new Set([...sel.options].map((o) => o.value));
        if (cur && have.has(curVal)) sel.value = curVal;
        else if (cur && have.has(cur.voice)) { sel.value = cur.voice; msg.textContent = ''; }
        else if (cur) { sel.value = ''; msg.textContent = 'The picked voice is not in this list any more. Refresh, or pick another.'; }
        else sel.value = '';
      };
      const load = async (fresh = false) => {
        msg.textContent = 'Getting the list of voices…';
        try {
          got = await api.voiceList({ provider: p, fresh });
          msg.textContent = '';
          if (srcSel) {
            srcSel.innerHTML = '<option value="">Any voice source</option>' + (got.sources || []).map((s) => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.name)}</option>`).join('');
            srcSel.value = (got.sources || []).some((s) => s.key === (S.settings.voiceChoices?.[p]?.via)) ? S.settings.voiceChoices[p].via : '';
          }
          refill(srcSel?.value || '');
        } catch (err) {
          got = null;
          if (srcSel) srcSel.innerHTML = '<option value="">Any voice source</option>';
          srcSel && (srcSel.value = '');
          refill('');
          msg.textContent = cleanIpcError(err);
        }
      };
      refill('');
      load(false);
      sel.onchange = async () => {
        const [voice, via, name] = sel.value.split('\u001f');
        const v = sel.value ? { voice, via: via || '', name: name || '' } : null;
        await save(v);
        if (v && srcSel && (got?.sources || []).some((s) => s.key === v.via)) srcSel.value = v.via;
        toast(v ? 'Voice set. Sentences say it when its language fits.' : 'Voice set back to automatic.');
      };
      srcSel?.addEventListener('change', () => refill(srcSel.value));
      box.querySelector('.vrefresh').onclick = () => load(true);
      return load; // handed to the region box: changing the region refetches the list
    };
    const renderVoice = () => {
      const p = S.settings.voiceProvider || 'azure';
      const box = $('sVoiceBox');
      if (p === 'custom') {
        ownForm(box, 'tts');
        attachVoicePick(box, p);
        return;
      }
      keyForm(box, p, p === 'azure' ? `<input class="field region" spellcheck="false" autocomplete="off" placeholder="Region, e.g. centralindia" value="${escapeHtml(S.settings.azureSpeechRegion || '')}" />` : '');
      const refreshVoices = attachVoicePick(box, p);
      box.querySelector('.region')?.addEventListener('change', async (e) => {
        try {
          S.settings = await api.speechKey({ region: e.target.value.trim() });
          refreshVoices?.(true);
        } catch (err) { toast(cleanIpcError(err).slice(0, 80)); }
      });
    };
    // Live conversation: which service transcribes the speech there. "Same as above"
    // follows the Speech to text row; anything else uses its own service (and Deepgram's
    // streaming still applies, so replies come faster with it).
    const renderLiveStt = () => {
      const v = S.settings.liveSttProvider || 'same';
      const dict = S.settings.sttProvider || 'gateway';
      const box = $('sLiveSttBox');
      if (!box) return;
      if (v === 'same' || v === dict) {
        box.innerHTML = `<span class="d">${v === 'same' ? 'Uses the same service as Speech to text above.' : 'This is the service above already, so its key was checked there.'}</span>`;
        return;
      }
      box.innerHTML = `<span class="d">Dictation keeps the service above, and the live conversation uses this one instead.${v === 'deepgram' ? ' Deepgram also transcribes while you talk, so replies come faster.' : ''}</span><div class="key-row"><button class="btn ghost" data-a="livetest">${ICONS.check}<span>Check this service</span></button></div><span class="key-msg"></span>`;
      box.querySelector('[data-a="livetest"]').onclick = async () => {
        const msg = box.querySelector('.key-msg');
        msg.textContent = 'Checking…';
        try { await api.speechSttTest({ live: true }); msg.textContent = `${SERVICE_INFO[v]?.name || (v === 'gateway' ? 'Your AI gateway' : 'The service')} works live too.`; } catch (err) { msg.textContent = cleanIpcError(err); }
      };
    };
    wireSeg('sSttProv', 'sttProvider', st.sttProvider || 'gateway');
    wireSeg('sVoiceProv', 'voiceProvider', st.voiceProvider || 'azure');
    wireSeg('sLiveStt', 'liveSttProvider', st.liveSttProvider || 'same');
    $('sSttProv').addEventListener('click', () => setTimeout(() => { renderStt(); renderLiveStt(); }, 60));
    $('sVoiceProv').addEventListener('click', () => setTimeout(renderVoice, 60));
    $('sLiveStt').addEventListener('click', () => setTimeout(renderLiveStt, 60));
    renderStt();
    renderVoice();
    renderLiveStt();
    wireSeg('sOnline', 'speechOnline', st.speechOnline || 'fallback');
    const azTry = async (lang) => {
      const msg = $('sAzMsg');
      msg.textContent = `Asking ${SERVICE_INFO[S.settings.voiceProvider || 'azure'].name}…`;
      try {
        const r = await api.speechVoiceTest(lang);
        msg.textContent = `Working. This is ${r.voice}.`;
        const ctx = new AudioContext();
        const src = ctx.createBufferSource();
        src.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(r.wav), (ch) => ch.charCodeAt(0)).buffer);
        src.connect(ctx.destination);
        src.onended = () => ctx.close();
        src.start();
      } catch (err) {
        msg.textContent = cleanIpcError(err);
      }
    };
    $('sAzTryEn').onclick = () => azTry('en-US');
    $('sAzTryHi').onclick = () => azTry('hi');

    // Microphone: pick one, and check Island can actually hear it.
    const fillMics = async () => {
      const sel = $('sMic');
      if (!sel) return;
      const mics = await Voice.listMics();
      sel.length = 1;
      for (const m of mics.filter((m) => m.id)) sel.add(new Option(m.label, m.id));
      sel.value = mics.some((m) => m.id === st.micDevice) ? st.micDevice : '';
      // The panel may have been closed while the list was loading.
      const note = $('sMicMsg');
      if (!mics.length && note) note.textContent = 'No microphone found on this PC. Plug one in (or a headset), then press Test.';
    };
    fillMics();
    // Plugging in (or pulling out) a headset updates the list straight away.
    navigator.mediaDevices.ondevicechange = async () => {
      if (!$('sMic')) return;
      const had = $('sMic').length;
      await fillMics();
      const note = $('sMicMsg');
      if (note && $('sMic').length > had && !$('sMicTest').disabled) { note.className = 'mic-msg'; note.textContent = 'Microphone found. Press Test and say something.'; }
    };
    $('sMic').onchange = async (e) => {
      await setSetting({ micDevice: e.target.value });
      Voice.setDevice(e.target.value);
    };
    $('sMicTest').onclick = async () => {
      const btn = $('sMicTest'), out = $('sMicMsg'), bar = $('sMicMeter').firstElementChild;
      btn.disabled = true;
      out.className = 'mic-msg';
      out.textContent = 'Listening… say “Hello Island”.';
      $('sMicMeter').classList.add('on');
      try {
        const r = await Voice.testMic($('sMic').value, (l) => (bar.style.transform = `scaleX(${Math.max(0.02, l).toFixed(3)})`));
        if (r.heard) { out.className = 'mic-msg good'; out.textContent = `Island can hear you through “${r.label}”.`; }
        else if (r.peak < 0.0015) { out.className = 'mic-msg bad'; out.textContent = `No sound at all from “${r.label}”. It may be muted (check the mute key or switch), or this is the wrong microphone: pick another above.`; }
        else { out.className = 'mic-msg warn'; out.textContent = `Very quiet. Island barely hears “${r.label}”. Move closer, or raise the microphone level in Windows Sound settings.`; }
        fillMics(); // names appear once the mic has been used
      } catch (e) {
        out.className = 'mic-msg bad';
        out.textContent = Voice.micError(e);
      }
      bar.style.transform = 'scaleX(0)';
      $('sMicMeter').classList.remove('on');
      btn.disabled = false;
    };
  },

  // Custom instructions: the user's own system prompt, added to Island's or replacing its
  // personality. Saved with the Save button (not on every keystroke).
  async prompt(main) {
    const st = S.settings;
    const MAX = 8000;
    const EXAMPLES = [
      ['Reply in Hindi', 'Always reply in simple Hindi (Devanagari), even when I write in English.'],
      ['Patient teacher', 'Explain things like a patient teacher: simple words, one idea at a time, and a short example.'],
      ['Brief & technical', 'I am a developer. Be brief and technical; skip the basics.'],
      ['About me', 'About me: I am a student in Class 12, preparing for exams. Keep that in mind when you help.'],
      ['Bullet points', 'Answer in short bullet points whenever possible.'],
    ];
    const MODES = {
      add: 'Your instructions are added to Island\'s own. Island stays itself and follows what you write here in every chat.',
      replace: 'Your instructions replace Island\'s personality and writing style, so you decide who it is and how it talks. How its tools work and its safety rules always stay on.',
    };
    main.innerHTML = head('Custom instructions', 'Your own system prompt: tell Island how to talk, what to know about you, and what to focus on. Used in every new message.') +
      `<div class="acct cp">
        <div class="cp-top">${seg('sPromptMode', [['add', 'Add to Island\'s'], ['replace', 'Replace its personality']])}<span class="grow"></span><span class="cp-state" id="cpState"></span></div>
        <p class="cp-mode" id="cpMode"></p>
        <textarea class="field cp-text" id="cpText" maxlength="${MAX}" spellcheck="true" placeholder="For example:&#10;You are my study buddy. Reply in simple Hinglish.&#10;Keep answers short unless I ask for detail.&#10;I use Excel a lot at work, so give Excel examples."></textarea>
        <div class="cp-ex"><span>Try:</span>${EXAMPLES.map(([l], i) => `<button class="cp-chip" data-i="${i}">${ICONS.plus}${escapeHtml(l)}</button>`).join('')}</div>
        <div class="acct-b"><span class="cp-count" id="cpCount"></span><span class="grow"></span><button class="btn link" id="cpClear">Clear</button><button class="btn mint" id="cpSave">Save</button></div>
      </div>
      <p class="acct-hint" style="margin-top:10px">Tip: start a new chat after changing these, so earlier replies don't steer the tone. Island's safety rules (asking before sending, paying or deleting; ignoring instructions hidden in web pages) always apply.</p>`;
    const ta = $('cpText');
    let mode = st.customPromptMode === 'replace' ? 'replace' : 'add';
    let saved = { text: st.customPrompt || '', mode };
    ta.value = saved.text;
    const sync = () => {
      const n = ta.value.length;
      $('cpCount').textContent = `${n.toLocaleString()} / ${MAX.toLocaleString()}`;
      $('cpCount').classList.toggle('warn', n > MAX * 0.9);
      $('cpMode').textContent = MODES[mode];
      $('sPromptMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
      const dirty = ta.value !== saved.text || mode !== saved.mode;
      $('cpSave').disabled = !dirty;
      $('cpClear').hidden = !ta.value;
      const st2 = $('cpState');
      st2.className = 'cp-state' + (dirty ? ' dirty' : saved.text.trim() ? ' on' : '');
      st2.textContent = dirty ? 'Not saved' : saved.text.trim() ? (saved.mode === 'replace' ? 'On · replacing' : 'On') : 'Off';
    };
    $('sPromptMode').querySelectorAll('button').forEach((b) => (b.onclick = () => { mode = b.dataset.v; sync(); }));
    ta.oninput = sync;
    ta.onkeydown = (e) => { if (e.key === 's' && e.ctrlKey) { e.preventDefault(); $('cpSave').click(); } };
    main.querySelectorAll('.cp-chip').forEach((b) => (b.onclick = () => {
      const line = EXAMPLES[+b.dataset.i][1];
      if (ta.value.includes(line)) return;
      ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : '') + line;
      ta.focus();
      sync();
    }));
    $('cpClear').onclick = () => { ta.value = ''; ta.focus(); sync(); };
    $('cpSave').onclick = async () => {
      const text = ta.value.trim();
      await setSetting({ customPrompt: text, customPromptMode: mode });
      ta.value = text;
      saved = { text, mode };
      sync();
      toast(text ? 'Instructions saved. They apply from your next message.' : 'Custom instructions turned off');
    };
    sync();
  },

  async shortcuts(main) {
    main.innerHTML = head('Shortcuts', 'Click a box, then press the new key combination. Esc cancels; Backspace clears an optional one.') +
      `<div class="sgroup">
        ${row('Open or hide Island', 'Tip: Alt+Space is also used by ChatGPT, Gemini, Raycast and Windows itself; if two apps want the same keys, one of them silently stops working', '<input class="field hotkey-field" id="sHotkey" data-key="hotkey" readonly />')}
        ${row('Stop', 'Stops Island whatever it is doing: thinking, using your computer, or waiting for you. It has its own key, so it can never be confused with opening the island', '<input class="field hotkey-field" id="sStopHotkey" data-key="stopHotkey" readonly />')}
        ${row('Talk', 'Press, speak, pause: it sends itself. Press again to send now.', '<input class="field hotkey-field" id="sVoiceHotkey" data-key="voiceHotkey" readonly />')}
        ${row('Ask about selection', 'Select text in any app, press this, then pick an action or ask', '<input class="field hotkey-field" id="sSelHotkey" data-key="selectionHotkey" readonly />')}
      </div>
      <div class="sgroup-h">Inside Island</div>
      <div class="sgroup">
        ${[['Send', 'Enter'], ['Stop', 'Esc'], ['New line', 'Shift+Enter'], ['Switch permission mode', 'Shift+Tab'], ['Choose model', 'Ctrl+M'], ['Chats', 'Ctrl+H'], ['New chat', 'Ctrl+N'], ['Include screen', 'Ctrl+Shift+S'], ['Live conversation', 'Ctrl+Shift+L'], ['Settings', 'Ctrl+,']].map(([l, k]) => row(l, '', `<span>${keyLabel(k)}</span>`)).join('')}
      </div>`;
    const sync = () => {
      const s = S.settings;
      $('sHotkey').value = hotkeyLabel(s.activeHotkey || s.hotkey);
      $('sStopHotkey').value = hotkeyLabel(s.activeExtras?.stop || s.stopHotkey) + (s.stopHotkey && s.activeExtras && !s.activeExtras.stop ? ' (taken)' : '');
      $('sVoiceHotkey').value = hotkeyLabel(s.voiceHotkey) + (s.voiceHotkey && s.activeExtras && !s.activeExtras.voice ? ' (taken)' : '');
      $('sSelHotkey').value = hotkeyLabel(s.selectionHotkey) + (s.selectionHotkey && s.activeExtras && !s.activeExtras.selection ? ' (taken)' : '');
    };
    main.querySelectorAll('.hotkey-field').forEach((hk) => {
      hk.onfocus = () => { recordingHotkey = true; hk.classList.add('rec'); hk.value = 'Press keys…'; };
      hk.onblur = () => { recordingHotkey = false; hk.classList.remove('rec'); sync(); };
      hk.onkeydown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return hk.blur();
        if (e.key === 'Backspace' && hk.dataset.key !== 'hotkey') {
          recordingHotkey = false;
          return setSetting({ [hk.dataset.key]: '' }).then(() => hk.blur());
        }
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
        const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
        if (!mods.length) return;
        const key = e.code === 'Space' ? 'Space' : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        recordingHotkey = false;
        hk.classList.remove('rec');
        setSetting({ [hk.dataset.key]: [...mods, key].join('+') }).then(() => hk.blur());
      };
    });
    sync();
  },
};

// "npx -y pkg arg" -> { command, args }; a URL -> { url }. Quotes group words.
function parseServerLine(line) {
  if (/^https?:\/\//i.test(line)) return { url: line };
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g).map((p) => p.replace(/^["']|["']$/g, ''));
  return { command: parts[0], args: parts.slice(1) };
}

function renderMemories(items) {
  const list = $('sMemList');
  if (!list) return;
  const q = SET.memQ.trim().toLowerCase();
  const shown = items.filter((m) => (SET.memCat === 'all' || (m.category || 'fact') === SET.memCat) && (!q || `${m.text} ${(m.tags || []).join(' ')}`.toLowerCase().includes(q)));
  list.innerHTML = shown.length ? '' : `<div class="mem-empty">${items.length ? 'Nothing matches.' : 'Nothing yet. Tell Island things like “remember that I study class 11 chemistry”, or just chat: it learns as you go.'}</div>`;
  for (const m of shown) {
    const [icon, catLabel] = MEM_CATS[m.category] || MEM_CATS.fact;
    const el = document.createElement('div');
    el.className = 'mem' + (m.pinned ? ' pinned' : '');
    el.innerHTML = `<span class="mi">${ICONS[icon]}</span><div class="mem-b"><div class="mem-t"></div><div class="mem-m"><span>${catLabel}</span><span class="${m.source === 'auto' ? 'src-auto' : ''}">${m.source === 'auto' ? 'learned automatically' : m.source === 'assistant' ? 'saved by Island' : 'added by you'}</span><span>${ago(new Date(m.updated || m.at).getTime())}</span>${m.uses ? `<span>used ${m.uses}×</span>` : ''}${m.chat ? '<button class="mem-from" data-a="from" title="Open the chat this was learned in">From this chat</button>' : ''}</div></div>
      <span class="acts"><button class="icon-btn small${m.pinned ? ' on' : ''}" data-a="pin" title="${m.pinned ? 'Unpin' : 'Pin: always include'}">${ICONS.pin}</button><button class="icon-btn small" data-a="edit" title="Edit">${ICONS.edit}</button><button class="icon-btn small" data-a="del" title="Forget">${ICONS.trash}</button></span>`;
    el.querySelector('.mem-t').textContent = m.text;
    el.title = m.id;
    // Where it came from: open that chat (it may have been deleted since).
    el.querySelector('[data-a=from]')?.addEventListener('click', async () => {
      try {
        const r = await api.chatsOpen(m.chat);
        renderHistory(r.items);
        showChat();
      } catch {
        toast('That chat was deleted, so its source is gone');
      }
    });
    el.querySelector('[data-a=pin]').onclick = async () => {
      await api.memoryUpdate(m.id, { pinned: !m.pinned });
      showSettings('memory');
    };
    el.querySelector('[data-a=del]').onclick = async () => {
      await api.memoryRemove(m.id);
      el.style.transition = 'opacity .2s, transform .3s var(--ease)';
      el.style.opacity = '0';
      el.style.transform = 'translateX(12px)';
      setTimeout(() => showSettings('memory'), 220);
    };
    el.querySelector('[data-a=edit]').onclick = () => {
      const t = el.querySelector('.mem-t');
      const ed = document.createElement('input');
      ed.className = 'field mem-edit';
      ed.value = m.text;
      t.replaceWith(ed);
      ed.focus();
      const done = async (save) => {
        if (save && ed.value.trim() && ed.value.trim() !== m.text) {
          try {
            await api.memoryUpdate(m.id, { text: ed.value.trim() });
          } catch (e) {
            toast(cleanIpcError(e).slice(0, 90));
          }
        }
        showSettings('memory');
      };
      ed.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      };
      ed.onblur = () => done(true);
    };
    list.appendChild(el);
  }
}

// One-click connectors. Cards needing a folder or a key open a small form first.
function renderCatalog(servers) {
  const box = $('mcpCatalog');
  if (!box || !SET.catalog) return;
  const names = new Set((servers || []).map((s) => s.name));
  box.innerHTML = '';
  for (const item of SET.catalog) {
    const added = [...names].some((n) => n === item.id || n.startsWith(item.id + '-'));
    const card = document.createElement('div');
    card.className = 'cat-card';
    const brand = item.logo && window.LOGOS?.[item.logo];
    const icon = brand ? `<span class="cc-ic cc-logo">${brand}</span>` : `<span class="cc-ic">${ICONS[item.icon] || ICONS.plug}</span>`;
    card.innerHTML = `<div class="cc-top">${icon}<div class="cc-m"><b></b>${item.dev ? '<span class="cap">for developers</span>' : ''}</div></div><p></p><div class="cc-form"></div><div class="cc-btns"><button class="btn ${added ? 'ghost' : 'mint'}" data-a="add">${added ? ICONS.check + '<span>Added</span>' : ICONS.plus + '<span>Add</span>'}</button></div>`;
    card.querySelector('b').textContent = item.name;
    card.querySelector('p').textContent = item.blurb;
    const form = card.querySelector('.cc-form');
    const values = {};
    const connect = async () => {
      const btn = card.querySelector('[data-a=add]');
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div><span>Connecting…</span>';
      try {
        const st = await api.mcpAddCatalog(item.id, values);
        renderMcp(st);
        renderCatalog(st);
        const s = st.find((x) => x.name === item.id || x.name.startsWith(item.id + '-'));
        toast(s?.state === 'connected' ? `${item.name} is ready (${s.tools.length} tools)` : s?.state === 'error' ? `${item.name}: ${(s.error || 'could not connect').slice(0, 70)}` : `Adding ${item.name}… the first start downloads it`);
      } catch (e) {
        toast(cleanIpcError(e).slice(0, 90));
        btn.disabled = false;
        btn.innerHTML = `${ICONS.plus}<span>Add</span>`;
      }
    };
    card.querySelector('[data-a=add]').onclick = () => {
      if (added) return;
      if (!(item.needs || []).length) return connect();
      if (form.childElementCount) return;
      for (const need of item.needs) {
        const row = document.createElement('div');
        row.className = 'cc-need';
        if (need.type === 'folders') {
          row.innerHTML = `<label></label><div class="cc-folders"></div><button class="btn ghost">${ICONS.folderOpen}<span>Choose folders…</span></button>`;
          row.querySelector('button').onclick = async () => {
            S.pickerOpen = true;
            const picked = await api.pickFolders().finally(() => (S.pickerOpen = false));
            if (!picked.length) return;
            values[need.key] = picked;
            row.querySelector('.cc-folders').innerHTML = picked.map((f) => `<span class="chip">${ICONS.folder}<span>${escapeHtml(f)}</span></span>`).join('');
          };
        } else {
          row.innerHTML = `<label></label><input class="field" type="password" autocomplete="off" spellcheck="false" />${need.help ? '<span class="tiny"></span>' : ''}`;
          row.querySelector('input').oninput = (e) => { values[need.key] = e.target.value; };
          if (need.help) row.querySelector('.tiny').textContent = need.help;
        }
        row.querySelector('label').textContent = need.label;
        form.appendChild(row);
      }
      const go = document.createElement('button');
      go.className = 'btn mint';
      go.innerHTML = `${ICONS.plug}<span>Connect</span>`;
      go.onclick = connect;
      card.querySelector('.cc-btns').replaceChildren(go);
    };
    box.appendChild(card);
  }
}

function renderMcp(servers) {
  renderCatalog(servers);
  const list = $('mcpList');
  if (!list) return;
  if (!servers.length) {
    list.innerHTML = `<div class="sgroup"><div class="mem-empty">No connectors yet. Add an MCP server below, or import the ones you set up in Claude Desktop.</div></div>`;
    return;
  }
  list.innerHTML = '';
  for (const s of servers) {
    const el = document.createElement('div');
    el.className = 'srv' + (SET.mcpOpen.has(s.name) ? ' open' : '');
    const where = s.type === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ');
    const nTools = `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`;
    const stateText = { connected: `${nTools} · running`, sleeping: `${nTools} · starts when used`, connecting: 'Starting…', error: 'Error', disabled: 'Off' }[s.state] || s.state;
    el.innerHTML = `<div class="srv-h"><span class="srv-ic">${s.type === 'http' ? ICONS.globe : ICONS.server}</span><div class="srv-m"><b><i class="sdot ${s.state}"></i><span></span><span class="cap">${stateText}</span></b><span></span></div>
      <button class="toggle${s.enabled ? ' on' : ''}" data-a="toggle" title="${s.enabled ? 'Turn off' : 'Turn on'}"></button><button class="icon-btn small" data-a="del" title="Remove">${ICONS.trash}</button></div>
      ${s.state === 'error' && s.error ? '<div class="srv-err"></div>' : ''}
      <div class="srv-tools">${s.tools.map((t) => `<div class="srv-tool"><b></b><span></span></div>`).join('') || '<div class="srv-tool">No tools</div>'}</div>`;
    el.querySelector('.srv-m b span').textContent = s.name;
    el.querySelector('.srv-m > span').textContent = where || '';
    if (s.state === 'error' && s.error) el.querySelector('.srv-err').textContent = s.error + (s.stderr ? `\n\n${s.stderr.slice(-600)}` : '');
    el.querySelectorAll('.srv-tool').forEach((r, i) => {
      if (!s.tools[i]) return;
      r.querySelector('b').textContent = s.tools[i].name;
      r.querySelector('span').textContent = (s.tools[i].description || '').slice(0, 140);
    });
    el.querySelector('.srv-h').onclick = (e) => {
      if (e.target.closest('button')) return;
      SET.mcpOpen.has(s.name) ? SET.mcpOpen.delete(s.name) : SET.mcpOpen.add(s.name);
      el.classList.toggle('open');
    };
    el.querySelector('[data-a=toggle]').onclick = async () => renderMcp(await api.mcpToggle(s.name, !s.enabled));
    const del = el.querySelector('[data-a=del]');
    del.onclick = async () => {
      if (!del.classList.contains('danger')) {
        del.classList.add('danger');
        del.innerHTML = `${ICONS.trash}<span>Remove?</span>`;
        del.style.width = 'auto';
        del.style.padding = '0 9px';
        del.style.gap = '5px';
        del.style.display = 'inline-flex';
        del.style.background = 'var(--red)';
        del.style.color = '#fff';
        setTimeout(() => renderMcp(servers), 3000);
        return;
      }
      renderMcp(await api.mcpRemove(s.name));
    };
    list.appendChild(el);
  }
}

api.onMcp((servers) => S.view === 'settings' && SET.tab === 'connectors' && renderMcp(servers));
api.onMemory((items) => S.view === 'settings' && SET.tab === 'privacy' && renderMemories(items));

// Text size (Settings → General): scales everything inside the panel; the panel's height
// follows because fitHeight measures the scaled content.
const TEXT_ZOOM = { normal: 1, large: 1.1, larger: 1.2 };
function applyTextSize() {
  document.documentElement.style.setProperty('--ui-zoom', TEXT_ZOOM[S.settings.textSize] || 1);
  lastSize = 0;
  requestAnimationFrame(fitHeight);
}

api.onSettings((s) => {
  S.settings = { ...S.settings, ...s };
  renderModelChip();
  renderAgentBtn();
  renderModeChip();
  applyTextSize();
});

// ---------------------------------------------------------------- boot

(async function boot() {
  S.settings = await api.getSettings();
  I18n.set(S.settings.uiLanguage || 'en');
  applyTextSize();
  Voice.setDevice(S.settings.micDevice);
  renderModelChip();
  renderAgentBtn();
  renderModeChip();
  setState('idle');
  updateSendBtn();
  await loadHistory();
  loadModels(); // fills in the model chip's display name
  if (!aiReady()) {
    S.flash = { title: 'Island is ready', sub: 'Click to add your API key' };
    updatePill();
    setTimeout(() => { S.flash = null; updatePill(); }, 12000);
  }
})();
