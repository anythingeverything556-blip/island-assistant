// Island's eyes for hard pictures: a strong vision model looks at a sharp, enlarged image
// and answers a precise question (charts, photos, forms, scans, small print, screens).
// Used by look_closely, and to describe pictures for models that can't see.
//
// The instructions for the picture reader live here (VISION_RULES), including its one
// exception: it doesn't transcribe or solve CAPTCHAs.
const { nativeImage } = require('electron');
const crypto = require('crypto');
const { profile } = require('./models');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VISION_RULES = (w, h) => `You are the eyes of Island, a desktop assistant. You get one or more pictures (screenshots, photos, charts, scanned documents, forms) and a question about them. Answer precisely; another AI acts on your answer, so accuracy matters more than style.

How to look
- Read text exactly as printed: same spelling, capitals, numbers, currency signs, dates and punctuation. Never guess a character: write [unclear] for anything you can't read with confidence.
- Charts and graphs: say the chart type, title, axes and units, then every labelled value you can read (as "label: value" lines), then the overall trend. Estimate unlabelled values only if asked, and say they are estimates.
- Tables: one row per line with " | " between cells, header row first. Forms: "Field: value" lines, and say which fields are empty or marked as errors.
- Screens and apps: name the app or website, what is open, the important buttons, links, fields and messages, and any error or warning word for word.
- Photos and objects: what is shown, the important details (brands, labels, prices, quantities, colours, condition), and anything unusual.
- Handwriting, stamps, signatures, logos and low-quality areas: describe them; transcribe only what you can read.
- Positions: whenever you mention something the user or the assistant may need to click, read or find, add its centre as @[x,y] in pixels of the first image (it is ${w}x${h}; x to the right, y down). Be exact: aim at the middle of the text or control.
- Say plainly when something is small, blurry, cut off or ambiguous, and how sure you are.
- Answer the question first, then the supporting details. No preamble.
`;

// A picture made easy to read: small ones enlarged (fine print and icons read much better),
// big ones limited to what vision models take in. -> { data, mediaType, width, height, k }
function prepare(img, { maxEdge = 2000, minEdge = 1100 } = {}) {
  let { width, height } = img.getSize();
  const long = Math.max(width, height);
  let k = 1;
  if (long < minEdge) k = Math.min(3, minEdge / long);
  else if (long > maxEdge) k = maxEdge / long;
  if (k !== 1) {
    img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' });
    ({ width, height } = img.getSize());
  }
  // PNG keeps text edges crisp; JPEG for big photos so the request stays small.
  const png = width * height <= 1600 * 1000;
  const data = (png ? img.toPNG() : img.toJPEG(92)).toString('base64');
  return { data, mediaType: png ? 'image/png' : 'image/jpeg', width, height, k };
}

async function chatCall(opts, model, content, signal) {
  const url = require('./chat-completions').chatUrl(opts.baseURL);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}`, 'x-api-key': opts.apiKey },
        body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'user', content }] }),
        signal: signal || AbortSignal.timeout(90000),
      });
    } catch (e) {
      if (attempt < 2 && !signal?.aborted) { await sleep(800 * (attempt + 1)); continue; }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(900 * (attempt + 1)); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${model}: ${j.error?.message || res.status}`); e.status = res.status; throw e; }
    return String(j.choices?.[0]?.message?.content || '').trim();
  }
}

async function claudeCall(opts, model, blocks, signal) {
  const Anthropic = require('@anthropic-ai/sdk');
  const r = await new Anthropic({ ...opts, maxRetries: 2, timeout: 90000 }).messages.create({ model, max_tokens: 4000, messages: [{ role: 'user', content: blocks }] }, { signal });
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// images: [{ data, mediaType, width, height }] (from prepare). Tries the picture-reader model,
// then the main model if that one can see. -> { text, model }
async function analyze({ images, question, opts, model, fallbackModel, signal }) {
  if (!opts) throw new Error('No API key yet, so pictures can\'t be read.');
  const rules = VISION_RULES(images[0].width, images[0].height);
  const tried = [];
  for (const m of [model, fallbackModel].filter((x, i, a) => x && a.indexOf(x) === i)) {
    try {
      let text;
      if (profile(m).kind === 'chat') {
        const content = [{ type: 'text', text: `${rules}\n\nQuestion: ${question}` }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))];
        text = await chatCall(opts, m, content, signal);
      } else {
        const blocks = [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text: `${rules}\n\nQuestion: ${question}` }];
        text = await claudeCall(opts, m, blocks, signal);
      }
      if (text) return { text, model: m };
      tried.push(`${m}: empty answer`);
    } catch (e) {
      if (signal?.aborted) throw e;
      tried.push(String(e.message || e).slice(0, 160));
    }
  }
  throw new Error(`Couldn't read the picture (${tried.join('; ')}). Check the "Picture reader" model in Settings > Model.`);
}

// "@[412,96]" (image pixels) -> "(x, y)" in another space, e.g. the screenshot the model clicks in.
function mapPoints(text, map) {
  return String(text).replace(/@\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g, (_, x, y) => {
    const p = map(Number(x), Number(y));
    return p ? `(${p[0]}, ${p[1]})` : '';
  });
}

// Pictures for models that can't see: each described once, then remembered.
const described = new Map(); // sha1 -> text
async function describe({ data, mediaType, opts, model, fallbackModel, signal }) {
  const key = crypto.createHash('sha1').update(data).digest('hex');
  if (described.has(key)) return described.get(key);
  const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  if (img.isEmpty()) return '[A picture was attached, but it could not be opened.]';
  const p = prepare(img);
  const r = await analyze({ images: [p], opts, model, fallbackModel, signal, question: 'Describe this picture completely for someone who cannot see it, so they can answer any question about it: transcribe all text exactly, give every value in charts and tables, describe screens, photos and anything important. Leave out the @[x,y] positions.' });
  const text = `[Picture (${mediaType}), described by ${r.model} because this model can't see images:]\n${r.text.replace(/@\[[^\]]*\]/g, '')}`;
  described.set(key, text);
  if (described.size > 200) described.delete(described.keys().next().value);
  return text;
}

module.exports = { prepare, analyze, mapPoints, describe, VISION_RULES };
