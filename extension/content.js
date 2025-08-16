/* global chrome */
(() => {
  let recording = false;
  let t0 = 0;
  const debounces = new Map(); // element -> timeout

  const nowRel = () => Math.round(performance.now() - t0);

  function sendStep(step) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ type: 'event', step });
    } catch (e) {
      // ignore if service worker asleep; next event will wake it
    }
  }

  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([ #;?%&,.+*~\':"!^$\[\]()=>|\/])/g,'\\$1'); }

  function nthOfType(el) {
    const tag = el.tagName.toLowerCase();
    let i = 1;
    let sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName.toLowerCase() === tag) i++;
    }
    return `${tag}:nth-of-type(${i})`;
  }

  function buildCssPath(el) {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && depth < 5) {
      if (cur.id) { parts.unshift(`#${cssEscape(cur.id)}`); break; }
      const testid = cur.getAttribute('data-testid');
      if (testid) { parts.unshift(`[data-testid="${cssEscape(testid)}"]`); break; }
      const name = cur.getAttribute('name');
      if (name) { parts.unshift(`${cur.tagName.toLowerCase()}[name="${cssEscape(name)}"]`); break; }
      parts.unshift(nthOfType(cur));
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function selectorsFor(el) {
    const sels = [];
    if (!el || !el.tagName) return sels;
    if (el.id) sels.push({ type: 'css', value: `#${cssEscape(el.id)}` });
    const testid = el.getAttribute('data-testid');
    if (testid) sels.push({ type: 'css', value: `[data-testid="${cssEscape(testid)}"]` });
    const name = el.getAttribute('name');
    if (name) sels.push({ type: 'css', value: `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]` });
    sels.push({ type: 'css', value: buildCssPath(el) });
    if (el.textContent && el.textContent.trim()) sels.push({ type: 'text', value: el.textContent.trim().slice(0, 80) });
    return sels;
  }

  function onClick(ev) {
    if (!recording) return;
    const el = ev.target;
    const step = { type: 'click', selectors: selectorsFor(el), button: (ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left'), ts: nowRel() };
    sendStep(step);
  }

  function isTextInput(el) {
    return el && (
      (el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type)) ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    );
  }

  function onInput(ev) {
    if (!recording) return;
    const el = ev.target;
    if (!isTextInput(el)) return;
    if (el instanceof HTMLInputElement && el.type === 'password') return; // skip sensitive
    const key = el;
    clearTimeout(debounces.get(key));
    debounces.set(key, setTimeout(() => {
      const val = el instanceof HTMLElement && el.isContentEditable ? el.textContent : el.value;
      const step = { type: 'type', selectors: selectorsFor(el), text: String(val || ''), ts: nowRel() };
      sendStep(step);
    }, 250));
  }

  function onChange(ev) {
    if (!recording) return;
    const el = ev.target;
    if (el instanceof HTMLSelectElement) {
      const values = Array.from(el.selectedOptions).map((o) => o.value);
      const step = { type: 'select', selectors: selectorsFor(el), value: el.multiple ? values : (values[0] || ''), ts: nowRel() };
      sendStep(step);
      return;
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const step = { type: 'change', selectors: selectorsFor(el), value: el.checked, ts: nowRel() };
      sendStep(step);
      return;
    }
  }

  let lastWinScrollAt = 0;
  function onWindowScroll() {
    if (!recording) return;
    const now = performance.now();
    if (now - lastWinScrollAt < 300) return;
    lastWinScrollAt = now;
    sendStep({ type: 'scroll', target: 'window', x: window.scrollX, y: window.scrollY, ts: nowRel() });
  }

  function patchHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      sendStep({ type: 'navigate', url: location.href, ts: nowRel() });
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      sendStep({ type: 'navigate', url: location.href, ts: nowRel() });
      return ret;
    };
    window.addEventListener('popstate', () => sendStep({ type: 'navigate', url: location.href, ts: nowRel() }));
    window.addEventListener('hashchange', () => sendStep({ type: 'navigate', url: location.href, ts: nowRel() }));
  }

  function start() {
    if (recording) return;
    recording = true;
    t0 = performance.now();
    // Initial navigate step
    sendStep({ type: 'navigate', url: location.href, ts: 0 });
    window.addEventListener('click', onClick, true);
    window.addEventListener('input', onInput, true);
    window.addEventListener('change', onChange, true);
    window.addEventListener('scroll', onWindowScroll, true);
    patchHistory();
  }

  function stop() {
    if (!recording) return;
    recording = false;
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('input', onInput, true);
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('scroll', onWindowScroll, true);
    debounces.forEach((t) => clearTimeout(t));
    debounces.clear();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'startRecording') start();
    if (msg.type === 'stopRecording') stop();
  });
})();

