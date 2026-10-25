// Clipboard helpers on Electron's async clipboard API (Electron 44+: read/write with
// ClipboardItem, readText/writeText return promises).
const { clipboard, ClipboardItem } = require('electron');

const readText = () => clipboard.readText();
const writeText = (text) => clipboard.writeText(String(text));

// First image on the clipboard as { mime, buffer }, or null.
async function readImage() {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) {
      const blob = await item.getType(type);
      return { mime: type, buffer: Buffer.from(await blob.arrayBuffer()) };
    }
  }
  return null;
}

// Everything on the clipboard, every format, so it can be put back exactly.
async function snapshot() {
  const out = [];
  for (const item of await clipboard.read()) {
    const record = {};
    for (const type of item.types) {
      try {
        record[type] = await item.getType(type);
      } catch {}
    }
    if (Object.keys(record).length) out.push(record);
  }
  return out;
}

async function restore(snap) {
  if (!snap?.length) return clipboard.clear();
  await clipboard.write(snap.map((record) => new ClipboardItem(record)));
}

module.exports = { readText, writeText, readImage, snapshot, restore };
