// Reads documents into plain text, so every model can work with them: PDFs (text layer),
// Word / Excel / PowerPoint (.docx .xlsx .pptx), OpenDocument, RTF, HTML and text files.
// Office files are zip archives of XML; they're read with a small built-in zip reader.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_CHARS = 180_000; // ~45k tokens: plenty for a document, small enough for any model
const MAX_SHEET_ROWS = 2000;

const TEXT_EXT = new Set('txt md markdown json jsonl csv tsv log xml html htm css js mjs cjs ts tsx jsx py java kt kts c h cpp hpp cs go rs rb php sh ps1 bat cmd ini cfg conf toml yaml yml sql env gradle swift lua r vue svelte srt vtt tex bib properties'.split(' '));
const OFFICE_EXT = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'odt', 'ods', 'odp']);
const OLD_OFFICE = { doc: 'Word', xls: 'Excel', ppt: 'PowerPoint' };

const extOf = (name) => path.extname(String(name || '')).slice(1).toLowerCase();

// Can this file be read as a document? (images are handled separately)
function supported(name) {
  const e = extOf(name);
  return e === 'pdf' || e === 'rtf' || TEXT_EXT.has(e) || OFFICE_EXT.has(e);
}

// ---------------------------------------------------------------- zip

function readZip(buf) {
  // End of central directory record: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file is damaged or isn't really an Office file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    return (e.method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
  };
  return { names: [...entries.keys()], read };
}

// ---------------------------------------------------------------- XML helpers

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
// Text of all <tag>...</tag> runs inside a chunk of XML.
const runs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => unxml(m[1])).join('');
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function docxText(zip) {
  const parts = ['word/document.xml', ...zip.names.filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))];
  const out = [];
  for (const part of parts) {
    let xml = zip.read(part);
    if (!xml) continue;
    // Tables: one line per row, cells separated by " | ".
    xml = xml.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => `<w:p><w:t>${[...row.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((c) => runs(c[0], 'w:t').replace(/[<&]/g, ' ')).join(' | ')}</w:t></w:p>`);
    xml = xml.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>');
    for (const p of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) out.push(runs(p[0], 'w:t'));
  }
  return tidy(out.join('\n'));
}

function pptxText(zip) {
  const num = (n) => +(/(\d+)\.xml$/.exec(n)?.[1] || 0);
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  return tidy(slides.map((s, i) => {
    const xml = zip.read(s) || '';
    const paras = [...xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)].map((p) => runs(p[0], 'a:t')).filter(Boolean);
    const notes = zip.read(`ppt/notesSlides/notesSlide${num(s)}.xml`);
    const noteText = notes ? [...notes.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)].map((p) => runs(p[0], 'a:t')).filter((t) => t && !/^\d+$/.test(t)).join(' ') : '';
    return `--- Slide ${i + 1} ---\n${paras.join('\n')}${noteText ? `\n(Speaker notes: ${noteText})` : ''}`;
  }).join('\n\n'));
}

function colIndex(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] || 'A') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function xlsxText(zip) {
  const shared = [];
  const ss = zip.read('xl/sharedStrings.xml');
  if (ss) for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(runs(si[1], 't'));
  const wb = zip.read('xl/workbook.xml') || '';
  const rels = zip.read('xl/_rels/workbook.xml.rels') || '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml(/name="([^"]*)"/.exec(m[0])?.[1] || 'Sheet'), rid: /r:id="([^"]+)"/.exec(m[0])?.[1] }));
  const out = [];
  sheets.forEach((s, i) => {
    let t = target.get(s.rid) || `worksheets/sheet${i + 1}.xml`;
    t = t.replace(/^\/?xl\//, '');
    const xml = zip.read(`xl/${t}`);
    if (!xml) return;
    const lines = [];
    let rows = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (++rows > MAX_SHEET_ROWS) { lines.push(`… (more rows not shown)`); break; }
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (type === 's') v = shared[+v] ?? '';
        else if (type === 'inlineStr') v = runs(inner, 't');
        else if (type === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) v = unxml(v);
        const f = /<f>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        if (v === undefined && !f) continue;
        cells[ref ? colIndex(ref) : cells.length] = (v ?? '') + (f ? ` [=${unxml(f)}]` : '');
      }
      const rn = /r="(\d+)"/.exec(row[0])?.[1];
      if (cells.length) lines.push(`${rn ? `${rn}: ` : ''}${Array.from(cells, (x) => x ?? '').join('\t')}`);
    }
    out.push(`--- Sheet "${s.name}" ---\n${lines.join('\n') || '(empty)'}`);
  });
  return tidy(out.join('\n\n'));
}

function odfText(zip) {
  const xml = zip.read('content.xml') || '';
  return tidy(xml.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<\/(text:p|text:h|table:table-row)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<[^>]+>/g, '').split('\n').map(unxml).join('\n'));
}

function rtfText(s) {
  // Drop the header groups (fonts, colours, styles, document info) before reading the text.
  let prev;
  do { prev = s; s = s.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|\*)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, ''); } while (s !== prev);
  return tidy(s
    .replace(/\\par[d]?\b/g, '\n').replace(/\\tab\b/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(n < 0 ? +n + 65536 : +n))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').replace(/ {2,}/g, ' '));
}

function htmlText(s) {
  return tidy(unxml(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '')));
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

// ---------------------------------------------------------------- PDF

let unpdf = null;
async function pdfText(buf) {
  unpdf ||= require('unpdf');
  const doc = await unpdf.getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  const { totalPages, text } = await unpdf.extractText(doc, { mergePages: false });
  const pages = text.map((t, i) => `--- Page ${i + 1} ---\n${String(t || '').trim()}`);
  const chars = text.join('').replace(/\s+/g, '').length;
  // Pages with (almost) no selectable text are scans or pictures: they need looking at.
  const imagePages = text.map((t, i) => (String(t || '').replace(/\s+/g, '').length < 25 ? i + 1 : 0)).filter(Boolean);
  return { text: tidy(pages.join('\n\n')), pages: totalPages, pageTexts: text.map((t) => String(t || '').trim()), imagePages, scanned: chars < 20 * Math.max(1, totalPages) / 4 };
}

// ---------------------------------------------------------------- entry point

// -> { text, kind, pages?, scanned?, truncated }
async function extract(buf, name) {
  const e = extOf(name);
  if (OLD_OFFICE[e]) throw new Error(`"${name}" is an old ${OLD_OFFICE[e]} file (.${e}). Open it in ${OLD_OFFICE[e]} and use Save As → .${e}x, then attach that.`);
  let r;
  if (e === 'pdf') r = { kind: 'PDF', ...(await pdfText(buf)) };
  else if (OFFICE_EXT.has(e)) {
    const zip = readZip(buf);
    const kind = { docx: 'Word document', docm: 'Word document', xlsx: 'Excel workbook', xlsm: 'Excel workbook', pptx: 'PowerPoint deck', pptm: 'PowerPoint deck', odt: 'document', ods: 'spreadsheet', odp: 'presentation' }[e];
    const text = /^doc/.test(e) ? docxText(zip) : /^xls/.test(e) ? xlsxText(zip) : /^ppt/.test(e) ? pptxText(zip) : odfText(zip);
    r = { kind, text };
  } else if (e === 'rtf') r = { kind: 'RTF document', text: rtfText(decodeText(buf)) };
  else if (e === 'html' || e === 'htm') r = { kind: 'web page', text: htmlText(decodeText(buf)) };
  else if (TEXT_EXT.has(e) || !e) r = { kind: 'text file', text: decodeText(buf) };
  else throw new Error(`Island can't read .${e} files. It can read PDFs, Word, Excel, PowerPoint, text and code files, and images.`);
  r.truncated = r.text.length > MAX_CHARS;
  if (r.truncated) r.text = r.text.slice(0, MAX_CHARS) + '\n\n[… the rest of the file was cut off because it is very long]';
  return r;
}

// The block a model reads: the file's text wrapped with its name and what it is.
function asBlock(name, r) {
  const meta = [r.kind, r.pages ? `${r.pages} page${r.pages > 1 ? 's' : ''}` : '', r.truncated ? 'shortened' : ''].filter(Boolean).join(', ');
  const empty = !r.text.replace(/--- (Page|Slide|Sheet)[^\n]*---|\(empty\)|\s/g, '').length;
  const body = r.scanned && empty
    ? "[This PDF has no selectable text: it's probably a scan or photos of pages. Tell the user you can't read the words in it with this model; a Claude model can read scanned PDFs, or they can attach the pages as images.]"
    : empty ? '[No text found in this file. It may contain only pictures or be empty.]' : r.text;
  return `<file name="${String(name).replace(/"/g, '')}" type="${meta}">\n${body}\n</file>`;
}

async function readFile(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error(`${p} is a folder.`);
  if (st.size > 60 * 1024 * 1024) throw new Error(`${path.basename(p)} is larger than 60 MB.`);
  return extract(fs.readFileSync(p), path.basename(p));
}

module.exports = { extract, asBlock, readFile, supported, extOf, TEXT_EXT, OFFICE_EXT };
