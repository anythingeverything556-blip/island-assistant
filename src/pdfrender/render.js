// Draws chosen PDF pages onto a canvas and hands them back as JPEGs. Runs in a hidden,
// sandboxed window, because the browser already has a canvas (no native modules needed).
import * as pdfjs from '../../node_modules/unpdf/dist/pdfjs.mjs';

const toBase64 = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
};

async function render({ data, pages, maxEdge = 1400, quality = 0.82 }) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  try {
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // Big enough to read small print, small enough for a model to take many pages.
      const scale = Math.min(3, maxEdge / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // scans and forms assume white paper
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      out.push({ page: n, width: canvas.width, height: canvas.height, base64: await toBase64(blob) });
      page.cleanup();
    }
    return { pages: doc.numPages, images: out };
  } finally {
    await task.destroy?.();
  }
}

window.pdfHost.onJob(async (job) => {
  try {
    window.pdfHost.done(job.id, await render(job));
  } catch (e) {
    window.pdfHost.done(job.id, { error: String(e?.message || e) });
  }
});
window.pdfHost.ready();
