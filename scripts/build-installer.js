// Build the Windows installer. Uses electron-builder's API rather than its command
// line, so it does not depend on how the script path reaches the arguments.
const { build, Platform } = require('electron-builder');

build({
  targets: Platform.WINDOWS.createTarget('nsis'),
  config: {
    win: { target: 'nsis' },
  },
})
  .then((files) => {
    console.log('built:', files.map((f) => f).join(', '));
  })
  .catch((e) => {
    console.error('build failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
