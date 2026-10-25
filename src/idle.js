// Shuts a helper process down after a while without use, so Island doesn't keep idle
// PowerShell helpers (~70 MB each) alive all day. touch() on every use; the helper
// starts again by itself on the next request.
function idleReaper(ms, { busy, stop }) {
  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (busy() ? arm() : stop()), ms);
    timer.unref?.();
  };
  return { touch: arm, cancel: () => clearTimeout(timer) };
}

module.exports = { idleReaper, HELPER_IDLE_MS: 3 * 60 * 1000 };
