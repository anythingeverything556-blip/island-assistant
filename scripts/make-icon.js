// Packs Island's app icon ("Tide orb") into a Windows .ico from the hand-tuned PNGs in
// build/icon-src (each size drawn separately so the tide gap stays visible at 16 px). Writes
// build/icon.ico + build/icon.png for the installer and src/assets/icon.ico for the tray.
// Run: npm run icon
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-src');
const SIZES = [16, 24, 32, 48, 256];

// ICO with PNG-compressed images (supported since Windows Vista).
const images = SIZES.map((s) => ({ size: s, png: fs.readFileSync(path.join(SRC, `icon-${s}.png`)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
const dir = Buffer.alloc(16 * images.length);
let offset = 6 + dir.length;
images.forEach(({ size, png }, i) => {
  const e = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
  dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
  dir.writeUInt8(0, e + 2); // palette colours
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // colour planes
  dir.writeUInt16LE(32, e + 6); // bits per pixel
  dir.writeUInt32LE(png.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
const ico = Buffer.concat([header, dir, ...images.map((x) => x.png)]);

fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
fs.copyFileSync(path.join(SRC, 'icon-256.png'), path.join(ROOT, 'build', 'icon.png'));
fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'icon.ico'), ico);
console.log(`wrote build/icon.ico (${SIZES.join(', ')} px), build/icon.png and src/assets/icon.ico`);
