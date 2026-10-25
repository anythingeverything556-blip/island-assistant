// Real Office files from what the model writes: .xlsx (formatted, with working formulas),
// .docx (from Markdown, which models write naturally) and .pptx (slides, tables, charts).
// Each file is read back after saving, so Island can say what's really in it.
const fs = require('fs');
const path = require('path');

const MONEY = () => (/Calcutta|Kolkata|Asia\/(Calcutta|Kolkata)/.test(Intl.DateTimeFormat().resolvedOptions().timeZone) ? '₹' : '$');

// A free name next to the requested one: never overwrite the user's files.
function freePath(p, ext) {
  let out = path.extname(p).toLowerCase() === ext ? p : `${p.replace(/\.[^.\\/]+$/, '')}${ext}`;
  if (!fs.existsSync(out)) return out;
  const base = out.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) if (!fs.existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  throw new Error('Too many files with that name.');
}

// ---------------------------------------------------------------- Excel

const FORMATS = {
  number: '#,##0.##', integer: '#,##0', percent: '0.0%', date: 'dd mmm yyyy', text: '@',
  currency: (sym) => `"${sym}"#,##0.00`,
};

function cellValue(v, format) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('=')) return { formula: s.slice(1) };
    if (format === 'date' && !isNaN(Date.parse(s))) return new Date(s);
    // "₹1,200.50", "45%", "3,000" typed as text by the model: store as numbers.
    if (format !== 'text' && /^[-+]?[₹$€£]?\s?[\d,]+(\.\d+)?%?$/.test(s) && /\d/.test(s)) {
      const n = Number(s.replace(/[₹$€£,\s%]/g, ''));
      if (Number.isFinite(n)) return s.endsWith('%') ? n / 100 : n;
    }
    return s;
  }
  return v;
}

async function createSpreadsheet(file, { sheets = [], currency } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Island';
  // Currency: as asked, else the symbol used in the data ("₹390"), else from the PC's time zone.
  const inData = JSON.stringify(sheets).match(/[₹$€£]/)?.[0];
  const sym = currency || inData || MONEY();
  if (!sheets.length) throw new Error('Give at least one sheet with rows.');
  for (const sh of sheets.slice(0, 20)) {
    const ws = wb.addWorksheet(String(sh.name || `Sheet${wb.worksheets.length + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    const cols = Array.isArray(sh.columns) ? sh.columns : [];
    const rows = (Array.isArray(sh.rows) ? sh.rows : []).slice(0, 50000);
    const width = Math.max(cols.length, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
    const fmtOf = (i) => cols[i]?.format || null;
    let r0 = 1;
    if (sh.title) {
      ws.getCell(1, 1).value = String(sh.title);
      ws.getCell(1, 1).font = { bold: true, size: 14 };
      r0 = 3;
    }
    if (cols.length) {
      const hr = ws.getRow(r0);
      cols.forEach((c, i) => {
        const cell = hr.getCell(i + 1);
        cell.value = String(c.header ?? c.name ?? c ?? '');
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5D62' } };
        cell.alignment = { vertical: 'middle' };
      });
    }
    const first = cols.length ? r0 + 1 : r0;
    rows.forEach((r, ri) => {
      const row = ws.getRow(first + ri);
      (Array.isArray(r) ? r : [r]).forEach((v, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = cellValue(v, fmtOf(ci));
      });
    });
    const last = first + rows.length - 1;
    // A totals row. totals: true sums every amount-like column (numbers and formulas, but not
    // rates, prices or percentages); totals: ["Amount", "Qty"] sums just those columns.
    if (Array.isArray(sh.total_columns) && sh.total_columns.length) sh.totals = sh.total_columns;
    if (sh.totals && rows.length) {
      const tr = ws.getRow(last + 1);
      tr.getCell(1).value = 'Total';
      const named = Array.isArray(sh.totals) ? sh.totals.map((h) => String(h).toLowerCase()) : null;
      for (let ci = 1; ci < width; ci++) {
        const f = fmtOf(ci);
        const head = String(cols[ci]?.header ?? '').toLowerCase();
        const vals = rows.map((r) => (Array.isArray(r) ? cellValue(r[ci], f) : null)).filter((v) => v !== null && v !== '');
        const numeric = vals.length && vals.every((v) => typeof v === 'number' || (v && typeof v === 'object' && 'formula' in v));
        const want = named ? named.includes(head) : numeric && f !== 'percent' && f !== 'date' && !/\b(rate|price|unit|per|%|percent|no\.?|number|id|year)\b/.test(head);
        if (want) {
          const L = ws.getColumn(ci + 1).letter;
          tr.getCell(ci + 1).value = { formula: `SUM(${L}${first}:${L}${last})` };
        }
      }
      tr.font = { bold: true };
      tr.eachCell((c) => (c.border = { top: { style: 'thin' } }));
    }
    // Number formats and widths.
    for (let ci = 0; ci < width; ci++) {
      const col = ws.getColumn(ci + 1);
      const f = fmtOf(ci);
      if (f) col.numFmt = f === 'currency' ? FORMATS.currency(sym) : FORMATS[f] || undefined;
      const lens = [String(cols[ci]?.header ?? '').length, ...rows.slice(0, 500).map((r) => (Array.isArray(r) && r[ci] !== undefined && r[ci] !== null ? String(r[ci]).length : 0))];
      // Formulas and money show their computed value, which is wider than the text typed.
      const computed = f === 'currency' || rows.some((r) => Array.isArray(r) && typeof r[ci] === 'string' && r[ci].trim().startsWith('='));
      col.width = cols[ci]?.width || Math.min(60, Math.max(computed ? 15 : 8, Math.max(...lens) + 2));
    }
    if (cols.length && sh.freeze_header !== false) ws.views = [{ state: 'frozen', ySplit: r0 }];
    if (cols.length && rows.length) ws.autoFilter = { from: { row: r0, column: 1 }, to: { row: last, column: width } };
  }
  await wb.xlsx.writeFile(file);
  return { sheets: wb.worksheets.map((w) => `${w.name} (${w.actualRowCount} rows)`) };
}

// ---------------------------------------------------------------- Word (from Markdown)

function inlineRuns(d, text, base = {}) {
  // **bold**, *italic* / _italic_, `code`
  const out = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g;
  let at = 0;
  for (const m of String(text).matchAll(re)) {
    if (m.index > at) out.push(new d.TextRun({ ...base, text: text.slice(at, m.index) }));
    const t = m[0];
    if (/^(\*\*|__)/.test(t)) out.push(new d.TextRun({ ...base, text: t.slice(2, -2), bold: true }));
    else if (t.startsWith('`')) out.push(new d.TextRun({ ...base, text: t.slice(1, -1), font: 'Consolas' }));
    else out.push(new d.TextRun({ ...base, text: t.slice(1, -1), italics: true }));
    at = m.index + t.length;
  }
  if (at < text.length) out.push(new d.TextRun({ ...base, text: text.slice(at) }));
  return out.length ? out : [new d.TextRun({ ...base, text: '' })];
}

async function createDocument(file, { title, markdown = '', large = false } = {}) {
  const d = require('docx');
  const { marked } = require('marked');
  const children = [];
  if (title) children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: inlineRuns(d, String(title)) }));
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4];
  const listItems = (tok, numbered, level = 0) => {
    for (const item of tok.items) {
      const textTok = item.tokens.find((t) => t.type === 'text' || t.type === 'paragraph');
      children.push(new d.Paragraph({ children: inlineRuns(d, textTok ? textTok.text : item.text), spacing: { after: large ? 220 : 60 }, ...(numbered ? { numbering: { reference: 'num', level } } : { bullet: { level } }) }));
      for (const sub of item.tokens.filter((t) => t.type === 'list')) listItems(sub, sub.ordered, Math.min(level + 1, 3));
    }
  };
  for (const tok of marked.lexer(String(markdown))) {
    if (tok.type === 'heading') children.push(new d.Paragraph({ heading: HEAD[Math.min(tok.depth, 4) - 1], children: inlineRuns(d, tok.text) }));
    else if (tok.type === 'paragraph' || tok.type === 'text') children.push(new d.Paragraph({ children: inlineRuns(d, tok.text), spacing: { after: 120 } }));
    else if (tok.type === 'list') listItems(tok, tok.ordered);
    else if (tok.type === 'table') {
      const cell = (txt, header) => new d.TableCell({ children: [new d.Paragraph({ children: inlineRuns(d, txt, header ? { bold: true } : {}) })], ...(header ? { shading: { fill: 'DCE8E8' } } : {}) });
      children.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: [
        new d.TableRow({ tableHeader: true, children: tok.header.map((h) => cell(h.text, true)) }),
        ...tok.rows.map((r) => new d.TableRow({ children: r.map((c) => cell(c.text, false)) })),
      ] }));
      children.push(new d.Paragraph({ text: '' }));
    } else if (tok.type === 'code') children.push(...tok.text.split('\n').map((l) => new d.Paragraph({ children: [new d.TextRun({ text: l, font: 'Consolas', size: 20 })] })));
    else if (tok.type === 'blockquote') children.push(new d.Paragraph({ children: inlineRuns(d, tok.text, { italics: true }), indent: { left: 400 } }));
    else if (tok.type === 'hr') children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
  }
  const doc = new d.Document({
    creator: 'Island',
    // Large print for step cards people keep beside the PC (18 pt).
    styles: { default: { document: { run: { font: 'Calibri', size: large ? 36 : 23 } } } },
    numbering: { config: [{ reference: 'num', levels: [0, 1, 2, 3].map((level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children }],
  });
  fs.writeFileSync(file, await d.Packer.toBuffer(doc));
  return { paragraphs: children.length };
}

// ---------------------------------------------------------------- PowerPoint

const THEMES = {
  light: { bg: 'FFFFFF', title: '1F3B40', text: '333333', accent: '2F5D62' },
  dark: { bg: '14232A', title: 'EDE8DC', text: 'D5D2C8', accent: '62EAD3' },
  blue: { bg: 'F3F7FB', title: '0B3D91', text: '233142', accent: '1F6FEB' },
};

async function createPresentation(file, { title, subtitle, theme = 'light', slides = [] } = {}) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  const T = THEMES[theme] || THEMES.light;
  const bg = { color: T.bg };
  if (title) {
    const s = pptx.addSlide();
    s.background = bg;
    s.addText(String(title), { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: T.title, fontFace: 'Calibri' });
    if (subtitle) s.addText(String(subtitle), { x: 0.8, y: 3.9, w: 11.7, h: 0.8, fontSize: 20, color: T.text, fontFace: 'Calibri' });
    s.addShape(pptx.ShapeType.rect, { x: 0.8, y: 2.25, w: 1.2, h: 0.08, fill: { color: T.accent } });
  }
  for (const sl of slides.slice(0, 60)) {
    const s = pptx.addSlide();
    s.background = bg;
    s.addText(String(sl.title || ''), { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 30, bold: true, color: T.title, fontFace: 'Calibri' });
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.22, w: 0.9, h: 0.06, fill: { color: T.accent } });
    const body = { x: 0.6, y: 1.5, w: 12.1, h: 5.5 };
    const half = { ...body, w: 5.9 };
    const right = { ...body, x: 6.8, w: 5.9 };
    const bulletBox = (items, box) => s.addText((items || []).map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })), { ...box, fontSize: 20, color: T.text, fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 8 });
    const hasVisual = sl.table || sl.chart || sl.image;
    if (sl.bullets?.length) bulletBox(sl.bullets, hasVisual ? half : body);
    else if (sl.text) s.addText(String(sl.text), { ...(hasVisual ? half : body), fontSize: 20, color: T.text, fontFace: 'Calibri', valign: 'top' });
    const vbox = sl.bullets?.length || sl.text ? right : body;
    if (sl.table?.header) {
      const rows = [sl.table.header.map((h) => ({ text: String(h), options: { bold: true, color: 'FFFFFF', fill: { color: T.accent } } })), ...(sl.table.rows || []).map((r) => r.map((c) => ({ text: String(c ?? '') })))];
      s.addTable(rows, { ...vbox, h: undefined, fontSize: 14, color: T.text, border: { type: 'solid', color: 'CCCCCC', pt: 0.5 } });
    } else if (sl.chart?.labels?.length) {
      const type = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie, doughnut: pptx.ChartType.doughnut }[sl.chart.type] || pptx.ChartType.bar;
      const data = (sl.chart.series || []).map((se) => ({ name: String(se.name || ''), labels: sl.chart.labels.map(String), values: (se.values || []).map(Number) }));
      s.addChart(type, data, { ...vbox, showLegend: data.length > 1 || type === pptx.ChartType.pie, legendPos: 'b', chartColors: [T.accent, 'F2B45A', '8FA5A7', 'B9A6FF', 'FF6B6B'], dataLabelColor: T.text, catAxisLabelColor: T.text, valAxisLabelColor: T.text, showValue: type === pptx.ChartType.pie });
    } else if (sl.image && fs.existsSync(sl.image)) {
      s.addImage({ path: sl.image, ...vbox, sizing: { type: 'contain', w: vbox.w, h: vbox.h } });
    }
    if (sl.notes) s.addNotes(String(sl.notes));
  }
  await pptx.writeFile({ fileName: file });
  return { slides: (title ? 1 : 0) + Math.min(slides.length, 60) };
}

module.exports = { createSpreadsheet, createDocument, createPresentation, freePath };
