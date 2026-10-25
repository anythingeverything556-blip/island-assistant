// PDFs for any model. Pages with real text are sent as text. Pages without it (scans,
// photos of paper, image-only forms) are drawn as pictures: models that can see get the
// pictures; models that can't get the words a vision model read off them.
const docs = require('./docs');
const { renderPages } = require('./pdf-render');

const MAX_DRAWN = 8; // pictures per PDF in one go; more can be asked for with read_file's pages

// "1-3, 7" -> [1, 2, 3, 7] (within 1..total)
function parsePages(spec, total) {
  if (!spec) return null;
  const out = new Set();
  for (const part of String(spec).split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && p <= total; p++) if (p >= 1) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

// -> array of content blocks (text, and images when the model can see them)
// opts: { vision, ocr(images) -> Map(page -> text) | null, pages: "1-3", asImages }
async function pdfBlocks(buf, name, { vision = false, ocr = null, pages = null, asImages = false } = {}) {
  const r = await docs.extract(buf, name);
  const total = r.pages || 0;
  const wanted = parsePages(pages, total);
  const inRange = (p) => !wanted || wanted.includes(p);
  // Which pages to look at: the ones without text, or the ones asked for as pictures.
  const need = asImages ? (wanted || Array.from({ length: total }, (_, i) => i + 1)) : (r.imagePages || []).filter(inRange);
  const draw = need.slice(0, MAX_DRAWN);
  const left = need.length - draw.length;
  const meta = `${r.kind}, ${total} page${total === 1 ? '' : 's'}${r.truncated ? ', shortened' : ''}`;

  let images = [];
  let drawError = '';
  if (draw.length) {
    try { images = (await renderPages(buf, draw)).images; } catch (e) { drawError = e.message; }
  }
  const drawn = new Set(images.map((i) => i.page));
  let read = new Map();
  if (images.length && !vision && ocr) {
    try { read = await ocr(images); } catch (e) { drawError = `couldn't read the page pictures (${e.message})`; }
  }

  // The text part: every page in range, with notes where a picture stands in.
  const sections = [];
  (r.pageTexts || []).forEach((t, i) => {
    const p = i + 1;
    if (!inRange(p)) return;
    let body = t;
    if (drawn.has(p) && vision) body = `${t ? `${t}\n` : ''}[This page ${t ? 'also ' : ''}comes as a picture below${t ? '' : ': it has no selectable text (a scan or image)'}.]`;
    else if (read.has(p)) body = `[No selectable text on this page, so it was read from a picture of it:]\n${read.get(p)}`;
    else if ((r.imagePages || []).includes(p)) body = '[No selectable text on this page (a scan or image).]';
    sections.push(`--- Page ${p} ---\n${body}`);
  });
  const notes = [];
  if (left > 0) notes.push(`[${left} more page${left > 1 ? 's' : ''} without text ${left > 1 ? "weren't" : "wasn't"} looked at yet. To see them, call read_file on this file with pages, e.g. "${need[MAX_DRAWN]}-${need[need.length - 1]}".]`);
  if (drawError) notes.push(`[Some pages couldn't be turned into pictures: ${drawError}]`);
  if (draw.length && !vision && !ocr) notes.push("[This model can't see pictures and no picture reader is set up, so pages without text couldn't be read. Suggest a model with Vision.]");
  let joined = sections.join('\n\n') || r.text;
  if (joined.length > 180_000) joined = joined.slice(0, 180_000) + '\n\n[… the rest of the file was cut off because it is very long]';
  const text = `<file name="${String(name).replace(/"/g, '')}" type="${meta}">\n${joined}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n</file>`;

  const blocks = [{ type: 'text', text }];
  if (vision) for (const img of images) {
    blocks.push({ type: 'text', text: `Page ${img.page} of "${name}":` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 } });
  }
  return blocks;
}

module.exports = { pdfBlocks, parsePages, MAX_DRAWN };
