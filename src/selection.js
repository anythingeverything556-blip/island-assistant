// Grab the text selected in the foreground app: copy it with a synthetic Ctrl+C,
// then put the user's clipboard back exactly as it was.
const clip = require('./clip');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function grabSelection(input) {
  // The hotkey's own modifiers may still be held; otherwise the app sees Alt+Shift+Ctrl+C.
  await input.waitModifiersReleased(1500);
  const saved = await clip.snapshot().catch(() => null);
  const marker = `island-probe-${Date.now()}`;
  await clip.writeText(marker);
  let text = '';
  try {
    await input.keys('tap', ['17', '67']); // Ctrl+C
    for (let i = 0; i < 25; i++) {
      await sleep(20);
      const now = await clip.readText();
      if (now !== marker) {
        text = now;
        break;
      }
    }
  } finally {
    if (saved) await clip.restore(saved).catch(() => {});
  }
  return text;
}

module.exports = { grabSelection };
