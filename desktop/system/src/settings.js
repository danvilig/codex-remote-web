(() => {
  if (window !== window.top) return;
  const expected = location.protocol === 'crw:' ? 'crw://localhost/index.html' : 'http://crw.localhost/index.html';
  if (location.href !== expected) return;
  Object.defineProperty(window, 'desktop', { value: Object.freeze({
    invoke(action, body) {
      return window.__TAURI_INTERNALS__.invoke('desktop_operation', { action, body: body ?? null });
    },
  }), writable: false, configurable: false });
})();
