/* Renders what the agent is doing: cursor glides, clicks, typing, keys, scrolls. */
const $ = (id) => document.getElementById(id);
const cursor = $('cursor');
let pos = { x: -100, y: -100 };
let hideKeysTimer = 0;
let typingTimer = 0;

function swapText(el, text) {
  if (el.textContent === (text || '')) return;
  el.textContent = text || '';
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
}

function setAct(text) {
  swapText($('act'), text);
}

let ghostTimer = 0;
function moveTo(x, y, ms) {
  cursor.style.transitionDuration = `${ms}ms`;
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  // The glow follows a little behind and fades once the cursor arrives.
  const ghost = $('ghost');
  ghost.style.transitionDuration = `${Math.round(ms * 1.35)}ms, 300ms`;
  ghost.style.transform = `translate(${x}px, ${y}px)`;
  if (ms > 0) {
    ghost.classList.add('moving');
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => ghost.classList.remove('moving'), ms * 1.2);
  }
  pos = { x, y };
}

function ripple(x, y, cls = '') {
  const r = document.createElement('div');
  r.className = 'ripple ' + cls;
  r.style.left = x + 'px';
  r.style.top = y + 'px';
  document.body.appendChild(r);
  setTimeout(() => r.remove(), 700);
}

function press() {
  cursor.classList.add('press');
  setTimeout(() => cursor.classList.remove('press'), 140);
}

function showKeys(pretty) {
  clearTimeout(hideKeysTimer);
  hideTyping();
  const box = $('keys');
  box.innerHTML = pretty.map((k, i) => `${i ? '<span>+</span>' : ''}<kbd class="hit" style="animation-delay:${i * 40}ms, ${250 + i * 40}ms">${escapeHtml(k)}</kbd>`).join('');
  hideKeysTimer = setTimeout(() => (box.innerHTML = ''), 1400);
}

function startTyping(text, msPerChar) {
  clearTimeout(typingTimer);
  $('keys').innerHTML = '';
  const el = $('typed');
  el.textContent = '';
  $('typing').classList.add('show');
  let i = 0;
  const step = () => {
    // Several chars per frame when typing fast, so the bubble keeps pace with the helper.
    const per = Math.max(1, Math.round(16 / Math.max(msPerChar, 1)));
    i = Math.min(text.length, i + per);
    const shown = text.slice(0, i);
    el.textContent = shown.length > 140 ? '…' + shown.slice(-140) : shown;
    if (i < text.length) typingTimer = setTimeout(step, Math.max(msPerChar, 16));
  };
  step();
}

function hideTyping() {
  clearTimeout(typingTimer);
  $('typing').classList.remove('show');
}

function scrollFx(x, y, dir) {
  const s = document.createElement('div');
  s.className = 'scroll ' + dir;
  s.style.left = x + 'px';
  s.style.top = y + 'px';
  s.innerHTML = '<i></i><i></i><i></i>';
  document.body.appendChild(s);
  setTimeout(() => s.remove(), 1300);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The living orb in the "Island is using your PC" bar (same shader as the panel).
const hudOrb = window.Orb ? Orb.mount(document.querySelector('.hud .orb'), 32, 'working') : null;

window.overlayApi.onEvent((m) => {
  switch (m.type) {
    case 'show':
      document.body.classList.add('on', 'acting');
      document.body.classList.remove('paused');
      hudOrb?.set('working');
      if (m.hotkey) {
        // The whole key in one piece: the stop key has four parts, and it must say
        // exactly what to press.
        $('hk').textContent = String(m.hotkey).replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win').replace(/\+/g, '+');
      }
      if (m.x !== undefined) {
        cursor.style.transitionDuration = '0ms';
        moveTo(m.x, m.y, 0);
        agentX = m.x;
        agentY = m.y;
      }
      break;
    case 'hide':
      document.body.classList.remove('acting');
      if (!document.body.classList.contains('teaching')) document.body.classList.remove('on');
      hideTyping();
      setAct('');
      break;
    case 'paused':
      document.body.classList.add('paused');
      hudOrb?.set('done');
      $('hudStep').textContent = m.text || 'Paused';
      break;
    case 'step':
      swapText($('hudStep'), m.text);
      break;
    case 'act':
      setAct(m.text);
      break;
    case 'move':
      if (m.label !== undefined) setAct(m.label);
      hideTyping();
      moveTo(m.x, m.y, m.ms);
      agentX = m.x;
      agentY = m.y;
      break;
    case 'click': {
      press();
      const n = m.count || 1;
      for (let k = 0; k < n; k++) setTimeout(() => ripple(pos.x, pos.y, m.button === 'right' ? 'right' : ''), k * 110);
      ripple(pos.x, pos.y, 'fill');
      break;
    }
    case 'mousedown':
      press();
      ripple(pos.x, pos.y, 'fill');
      break;
    case 'drag-start':
      $('trailLine').setAttribute('x1', m.x);
      $('trailLine').setAttribute('y1', m.y);
      $('trailLine').setAttribute('x2', m.x);
      $('trailLine').setAttribute('y2', m.y);
      $('trail').classList.add('show');
      break;
    case 'drag-move':
      $('trailLine').setAttribute('x2', m.x);
      $('trailLine').setAttribute('y2', m.y);
      break;
    case 'drag-end':
      setTimeout(() => $('trail').classList.remove('show'), 400);
      break;
    case 'type':
      setAct('Typing');
      startTyping(m.text, m.msPerChar);
      break;
    case 'type-done':
      setTimeout(hideTyping, 900);
      break;
    case 'keys':
      setAct('Pressing keys');
      showKeys(m.pretty);
      break;
    case 'scroll':
      setAct(`Scrolling ${m.dir}`);
      scrollFx(m.x ?? pos.x, m.y ?? pos.y, m.dir);
      break;
    case 'teach':
      showTeach(m);
      break;
    case 'teach-good':
      teachGood();
      break;
    case 'teach-reveal':
      revealSpot(m.text);
      break;
    case 'teach-miss': {
      if (hiddenSpot) { revealSpot(m.text); break; }
      const hint = $('cHint');
      hint.textContent = m.text;
      hint.classList.remove('miss');
      void hint.offsetWidth;
      hint.classList.add('miss');
      const card = $('coach');
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
      const spot = $('spot');
      if (spotRect) {
        spot.className = 'spot';
        void spot.offsetWidth;
        spot.className = 'spot show pop' + (spotRect.box ? ' box' : '') + (spotRect.guess ? ' guess' : '');
      }
      break;
    }
    case 'teach-wait':
      $('coach').classList.add('waiting');
      break;
    case 'teach-hide':
      hideTeach();
      break;
    case 'rec-start':
      document.body.classList.add('on', 'recording');
      $('rSteps').innerHTML = '';
      $('rCount').textContent = '';
      $('rec').classList.add('show');
      break;
    case 'rec-steps':
      $('rCount').textContent = `${m.count} step${m.count === 1 ? '' : 's'}`;
      $('rSteps').innerHTML = m.steps.map((s, i) => `<li><i>${m.count - m.steps.length + 1 + i}</i>${escapeHtml(s)}</li>`).join('');
      break;
    case 'rec-stop':
      $('rec').classList.remove('show');
      document.body.classList.remove('recording');
      if (!document.body.classList.contains('acting') && !document.body.classList.contains('teaching')) document.body.classList.remove('on');
      break;
    case 'zoom': {
      const z = document.createElement('div');
      z.className = 'zoombox';
      Object.assign(z.style, { left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px' });
      document.body.appendChild(z);
      setTimeout(() => z.remove(), 950);
      break;
    }
  }
});

// ---------- teaching ----------
// A spotlight on the thing to click, an arrow, and a big, plain coach card. The window
// ignores the mouse everywhere except over the card, so the real app stays clickable.

let spotRect = null;
let hiddenSpot = false; // practice mode: the spot exists but isn't shown yet
let prefer = null; // e.g. ['above', 'left', ...] for steps that open a menu below the target
let overCard = false;
// Where Island's own cursor is, so the Stop button never steals its clicks.
let agentX = null, agentY = null;
const HINTS = {
  click: 'Or simply click the glowing spot. I\'ll notice.',
  double_click: 'Double-click means two quick clicks, one right after the other.',
  right_click: 'Right-click means pressing the button on the right side of your mouse.',
  type: 'Click the glowing spot first, then type. Press “I did it” when you\'re done.',
  drag: 'Hold the left mouse button down, move the mouse, then let go.',
  look: 'Just have a look, then press “I did it”.',
};

function md(text) {
  return escapeHtml(text || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

function showTeach(m) {
  document.body.classList.add('on', 'teaching');
  const coach = $('coach');
  coach.classList.remove('waiting', 'asking');
  // Practice: the learner tries on their own; the spot appears only if they get stuck.
  hiddenSpot = !!m.practice && !!m.spot;
  coach.classList.toggle('practice', !!m.practice);
  $('cStep').textContent = `${m.practice ? 'Practice round, step' : 'Step'} ${m.total ? `${m.step} of ${m.total}` : m.step}`;
  $('cBar').style.width = m.total ? `${Math.min(100, (100 * (m.step - 1)) / m.total)}%` : '0%';
  $('cText').innerHTML = md(m.instruction);
  $('cDetail').innerHTML = md(m.detail);
  $('cHint').textContent = hiddenSpot ? 'Try it yourself. If you get stuck, I\'ll show you where.' : m.spot?.guess ? 'I\'m not sure this is the right spot. If you don\'t see it there, press Ask and tell me what you see.' : m.spot ? HINTS[m.action] || HINTS.click : '';
  $('cHint').classList.remove('miss');
  $('cAskText').value = '';
  spotRect = m.spot || null;
  prefer = Array.isArray(m.prefer) ? m.prefer : null;
  drawSpot();
  coach.classList.remove('show');
  requestAnimationFrame(() => {
    placeCoach();
    coach.classList.add('show');
  });
}

function drawSpot() {
  const spot = $('spot');
  if (spotRect && !hiddenSpot) {
    Object.assign(spot.style, { left: spotRect.x - spotRect.w / 2 + 'px', top: spotRect.y - spotRect.h / 2 + 'px', width: spotRect.w + 'px', height: spotRect.h + 'px' });
    spot.className = 'spot';
    void spot.offsetWidth;
    spot.className = 'spot show pop' + (spotRect.box ? ' box' : '') + (spotRect.guess ? ' guess' : '');
  } else spot.className = 'spot';
}

// Practice: show where it is after all (they hesitated or clicked the wrong thing).
function revealSpot(text) {
  if (!hiddenSpot) return;
  hiddenSpot = false;
  drawSpot();
  placeCoach();
  const hint = $('cHint');
  hint.textContent = text || 'Here it is: the glowing spot.';
  hint.classList.remove('miss');
  void hint.offsetWidth;
  hint.classList.add('miss');
}

// Card beside the spot: below, above, right or left, whichever fits without covering
// it (or covers it least); the arrow sits between the card and the spot.
function placeCoach() {
  const coach = $('coach');
  const arrow = $('tArrow');
  const W = innerWidth, H = innerHeight;
  const cw = coach.offsetWidth, ch = coach.offsetHeight;
  const M = 16;
  if (!spotRect || hiddenSpot) {
    coach.style.left = (W - cw) / 2 + 'px';
    coach.style.top = Math.max(M, H - ch - 110) + 'px';
    arrow.classList.remove('show');
    return;
  }
  const { x, y, w, h } = spotRect;
  const gap = 74;
  const clampX = (v) => Math.min(Math.max(M, v), W - cw - M);
  const clampY = (v) => Math.min(Math.max(M, v), H - ch - M);
  const options = [
    { side: 'below', left: clampX(x - cw / 2), top: y + h / 2 + gap },
    { side: 'above', left: clampX(x - cw / 2), top: y - h / 2 - gap - ch },
    { side: 'right', left: x + w / 2 + gap, top: clampY(y - ch / 2) },
    { side: 'left', left: x - w / 2 - gap - cw, top: clampY(y - ch / 2) },
  ];
  const overlap = (o) => {
    const ox = Math.max(0, Math.min(o.left + cw, x + w / 2 + 12) - Math.max(o.left, x - w / 2 - 12));
    const oy = Math.max(0, Math.min(o.top + ch, y + h / 2 + 12) - Math.max(o.top, y - h / 2 - 12));
    return ox * oy;
  };
  const fits = (o) => o.left >= M && o.top >= M && o.left + cw <= W - M && o.top + ch <= H - M;
  if (prefer) options.sort((p, q) => prefer.indexOf(p.side) - prefer.indexOf(q.side));
  let best = options.find(fits);
  if (!best) {
    // nothing fits cleanly: keep it on screen and cover as little of the target as possible
    best = options.map((o) => ({ ...o, left: clampX(o.left), top: clampY(o.top) })).sort((p, q) => overlap(p) - overlap(q))[0];
  }
  coach.style.left = best.left + 'px';
  coach.style.top = best.top + 'px';
  const ARROW = { below: [x - 20, y + h / 2 + 10, 180], above: [x - 20, y - h / 2 - 58, 0], right: [x + w / 2 + 14, y - 24, 90], left: [x - w / 2 - 54, y - 24, -90] }[best.side];
  arrow.style.left = ARROW[0] + 'px';
  arrow.style.top = ARROW[1] + 'px';
  arrow.style.rotate = ARROW[2] + 'deg';
  arrow.classList.toggle('show', fits(best) || overlap(best) === 0);
}

function teachGood() {
  const g = $('good');
  if (spotRect) {
    g.style.left = spotRect.x + 'px';
    g.style.top = spotRect.y - spotRect.h / 2 - 10 + 'px';
    g.classList.remove('show');
    void g.offsetWidth;
    g.classList.add('show');
  }
  $('coach').classList.add('waiting');
}

function hideTeach() {
  document.body.classList.remove('teaching');
  if (!document.body.classList.contains('acting')) document.body.classList.remove('on');
  $('coach').classList.remove('show', 'waiting', 'asking');
  $('spot').className = 'spot';
  $('tArrow').classList.remove('show');
  spotRect = null;
  if (overCard) {
    overCard = false;
    window.overlayApi.setIgnore(true);
  }
}

$('cBtns').addEventListener('click', (e) => {
  const b = e.target.closest('.c-btn');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'again') {
    const spot = $('spot');
    if (spotRect) {
      spot.className = 'spot';
      void spot.offsetWidth;
      spot.className = 'spot show pop' + (spotRect.box ? ' box' : '') + (spotRect.guess ? ' guess' : '');
    }
    window.overlayApi.teach({ action: 'again' });
    return;
  }
  if (a === 'ask') {
    $('coach').classList.add('asking');
    window.overlayApi.wantFocus();
    setTimeout(() => $('cAskText').focus(), 60);
    return;
  }
  $('coach').classList.add('waiting');
  window.overlayApi.teach({ action: a });
});

$('cAskText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = $('cAskText').value.trim();
    if (!text) return;
    $('coach').classList.add('waiting');
    window.overlayApi.teach({ action: 'question', text });
  } else if (e.key === 'Escape') $('coach').classList.remove('asking');
});

$('rBtns').addEventListener('click', (e) => {
  const b = e.target.closest('.c-btn');
  if (b) window.overlayApi.teach({ action: b.dataset.a });
});

// The Stop button on the bar Island shows while it drives the computer.
$('hudStop')?.addEventListener('click', (e) => {
  e.stopPropagation();
  window.overlayApi.stop();
});

// Where Island's own cursor is, so the Stop button never steals its clicks.

// Catch the mouse only while it's over the card, or over the Stop button.
document.addEventListener('mousemove', (e) => {
  const overCardNow = !!(e.target.closest && e.target.closest('.coach.show, .rec.show'));
  const onStop = !!(e.target.closest && e.target.closest('.hud-btn'));
  // If Island's own cursor is right there, keep out of the way: it would click the
  // Stop button by accident and stop itself.
  const nearAgent = agentX !== null && Math.hypot(e.clientX - agentX, e.clientY - agentY) < 26;
  const over = overCardNow || (onStop && !nearAgent);
  if (over === overCard) return;
  overCard = over;
  window.overlayApi.setIgnore(!over);
});
addEventListener('resize', () => document.body.classList.contains('teaching') && placeCoach());
