/* WebView2 host adapter. Electron's isolated preload API takes precedence. */
(() => {
  'use strict';
  if (window.api || !window.chrome?.webview) return;
  document.documentElement.classList.add('webview-host');
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  const send = (method, args = {}) => window.chrome.webview.postMessage({ method, args });
  const invoke = (method, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('앱 응답 시간이 초과되었습니다.')); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    window.chrome.webview.postMessage({ id, method, args });
  });
  window.chrome.webview.addEventListener('message', ({ data }) => {
    if (data.id && pending.has(data.id)) {
      const call = pending.get(data.id);
      pending.delete(data.id);
      clearTimeout(call.timeout);
      data.error ? call.reject(new Error(data.error)) : call.resolve(data.result);
    } else if (data.event) {
      (listeners.get(data.event) || []).forEach(fn => fn(data.payload));
    }
  });
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
  };
  window.api = Object.freeze({
    loadState: () => invoke('state:load'),
    saveState: state => send('state:save', { state }),
    setAlwaysOnTop: on => invoke('window:always-on-top', { on }),
    armTimer: (endsAt, title) => send('timer:arm', { endsAt, title }),
    disarmTimer: () => send('timer:disarm'),
    onElapsed: fn => on('timer:elapsed', fn),
    onResync: fn => on('timer:resync', fn),
    signalReady: () => send('renderer:ready'),
  });
})();
