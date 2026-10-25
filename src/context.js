// Keeps each request under the gateway's size limit. In a long computer-use chat the
// bulk is old screenshots (~150 KB each), which the model no longer needs: only the
// most recent ones are sent; older ones become a short note. The saved chat keeps
// everything. The cutoff moves in steps, so the request prefix (and the prompt cache)
// only changes every few screenshots instead of on every one.

const NORMAL = { keepShots: 3, step: 4, maxBytes: 5_000_000 };
const CHAT = { keepShots: 2, step: 2, maxBytes: 2_500_000 }; // models without image caching
const STRICT = { keepShots: 1, step: 1, maxBytes: 1_500_000 }; // after the gateway said "too large"
const NO_IMAGES = { keepShots: 0, step: 1, maxBytes: 0, noImages: true }; // after a provider rejected an image

// What base64 image data starts with, per format: a cheap check that it's a real picture.
const MAGIC = { 'image/jpeg': '/9j/', 'image/png': 'iVBORw0KGgo', 'image/gif': 'R0lGOD', 'image/webp': 'UklGR' };
function validImage(source) {
  if (!source || source.type !== 'base64') return true; // URLs etc. are the provider's business
  const data = source.data;
  const magic = MAGIC[source.media_type];
  return typeof data === 'string' && data.length >= 64 && !!magic && data.startsWith(magic);
}

// Images that can't be sent (empty or broken captures, wrong type) become a note, so one
// bad screenshot can't make every later request in the chat fail.
function sanitize(messages) {
  let out = null;
  messages.forEach((m, mi) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return;
    let content = null;
    m.content.forEach((b, bi) => {
      let nb = b;
      if (b.type === 'image' && !validImage(b.source)) nb = { type: 'text', text: '[an image here could not be read and was left out]' };
      else if (b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c.type === 'image' && !validImage(c.source))) {
        nb = { ...b, content: b.content.map((c) => (c.type === 'image' && !validImage(c.source) ? { type: 'text', text: '[the screenshot here came back blank]' } : c)) };
      }
      if (nb !== b) (content ||= m.content.slice())[bi] = nb;
    });
    if (content) (out ||= messages.slice())[mi] = { ...m, content };
  });
  return out || messages;
}

function prune(messages, opts = NORMAL) {
  messages = sanitize(messages);
  const { keepShots, step, maxBytes } = opts;
  const last = messages.length - 1;
  const shots = []; // images inside tool results, oldest first
  const attachments = []; // images/PDFs the user attached, oldest first
  messages.forEach((m, mi) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return;
    m.content.forEach((b, bi) => {
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        b.content.forEach((c, ci) => c.type === 'image' && shots.push({ mi, bi, ci, size: c.source?.data?.length || 0 }));
      } else if ((b.type === 'image' || b.type === 'document') && b.source?.type === 'base64') {
        attachments.push({ mi, bi, kind: b.type, size: b.source.data?.length || 0 });
      }
    });
  });

  const drop = new Set(shots.slice(0, Math.floor(Math.max(0, shots.length - keepShots) / step) * step));
  if (opts.noImages) for (const r of [...shots, ...attachments.filter((a) => a.kind === 'image')]) drop.add(r);
  // Still too big: drop more of the oldest screenshots (never the newest), then earlier attachments.
  let total = [...shots, ...attachments].filter((r) => !drop.has(r)).reduce((s, r) => s + r.size, 0);
  for (const r of [...shots.slice(0, -1), ...attachments.filter((a) => a.mi < last)]) {
    if (total <= maxBytes) break;
    if (drop.has(r)) continue;
    drop.add(r);
    total -= r.size;
  }
  if (!drop.size) return messages;

  // Copy only what changes; the stored history stays intact.
  const out = messages.slice();
  const msgCopy = new Map();
  const blockCopy = new Map();
  for (const r of drop) {
    let m = msgCopy.get(r.mi);
    if (!m) {
      m = { ...messages[r.mi], content: messages[r.mi].content.slice() };
      msgCopy.set(r.mi, m);
      out[r.mi] = m;
    }
    if (r.ci !== undefined) {
      const key = `${r.mi}:${r.bi}`;
      let b = blockCopy.get(key);
      if (!b) {
        b = { ...m.content[r.bi], content: m.content[r.bi].content.slice() };
        blockCopy.set(key, b);
        m.content[r.bi] = b;
      }
      b.content[r.ci] = { type: 'text', text: opts.noImages ? '[screenshot left out: the model provider rejected an image in this chat]' : '[older screenshot left out to keep the request small]' };
    } else {
      m.content[r.bi] = { type: 'text', text: `[an earlier ${r.kind === 'document' ? 'PDF' : 'image'} attachment was left out ${opts.noImages ? 'because the model provider rejected an image' : 'to keep the request small'}]` };
    }
  }
  return out;
}

// The provider refusing an image it couldn't decode ("Expected a valid JPEG, PNG...").
function imageRejected(err) {
  const status = err?.status;
  const msg = String(err?.message || err || '');
  return (status === 400 || status === 422 || !status) && /valid (jpe?g|png|gif|webp|image)|image_url|invalid image|image (data|format|content)|could not (process|decode) image|unsupported image|image.{0,40}(invalid|corrupt|decode)/i.test(msg);
}

// The gateway (or API) refusing a request for its size.
function tooLarge(err) {
  const status = err?.status;
  const msg = String(err?.message || err || '');
  return status === 413 || /request (entity )?too large|payload too large|too large|exceeds.*(size|limit)|maximum.*size/i.test(msg) && (status === 422 || status === 400 || status === 413 || !status);
}

module.exports = { prune, sanitize, validImage, tooLarge, imageRejected, NORMAL, CHAT, STRICT, NO_IMAGES };
