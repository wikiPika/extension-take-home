/* global chrome */
(() => {
  let recording = false;
  let startedAtMs = 0; // epoch ms at recording start, consistent across navigations
  let recordedFirstNavigate = false;
  const debounces = new Map(); // element -> { timer, last }
  const TYPE_MIN_INTERVAL_MS = 1000;

  const nowRel = () => {
    if (!startedAtMs) return 0;
    return Math.max(0, Date.now() - startedAtMs);
  };

  function sendStep(step) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ type: "event", step });
    } catch (e) {
      // ignore if service worker asleep; next event will wake it
    }
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape
      ? CSS.escape(s)
      : String(s).replace(/([ #;?%&,.+*~\':"!^$\[\]()=>|\/])/g, "\\$1");
  }

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
      if (cur.id) {
        parts.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      const testid = cur.getAttribute("data-testid");
      if (testid) {
        parts.unshift(`[data-testid="${cssEscape(testid)}"]`);
        break;
      }
      const name = cur.getAttribute("name");
      if (name) {
        parts.unshift(
          `${cur.tagName.toLowerCase()}[name="${cssEscape(name)}"]`
        );
        break;
      }
      parts.unshift(nthOfType(cur));
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function nearestClickable(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (!(cur instanceof Element)) break;
      const tag = cur.tagName.toLowerCase();
      const role = cur.getAttribute('role');
      const isButtonish = tag === 'button' || (tag === 'a' && cur.hasAttribute('href')) || (tag === 'input' && ['button','submit','image'].includes(cur.getAttribute('type')||'')) || role === 'button' || cur.hasAttribute('data-testid');
      const hasHandler = !!(cur.onclick || cur.onmousedown || cur.onpointerdown || cur.getAttribute('onclick'));
      if (isButtonish || hasHandler) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function ariaName(el) {
    if (!el) return null;
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
      const txt = parts.map(n => (n && n.textContent) ? n.textContent : '').join(' ').trim();
      if (txt) return txt;
    }
    const title = el.getAttribute('title');
    if (title) return title.trim();
    return null;
  }

  function selectorsFor(el) {
    const sels = [];
    if (!el || !el.tagName) return sels;
    if (el.id) sels.push({ type: "css", value: `#${cssEscape(el.id)}` });
    const testid = el.getAttribute("data-testid");
    if (testid) {
      const escaped = cssEscape(testid);
      sels.push({ type: "css", value: `[data-testid="${escaped}"]` });
      sels.push({ type: "xpath", value: `//*[@data-testid="${escaped}"]` });
    }
    const name = el.getAttribute("name");
    if (name)
      sels.push({
        type: "css",
        value: `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`,
      });
    const aria = ariaName(el);
    if (aria) sels.push({ type: 'aria', value: aria });
    sels.push({ type: "css", value: buildCssPath(el) });
    if (el.textContent && el.textContent.trim())
      sels.push({ type: "text", value: el.textContent.trim().slice(0, 80) });
    return sels;
  }

  function onClick(ev) {
    if (!recording) return;
    const el = nearestClickable(ev.target);
    const rect = el.getBoundingClientRect();
    const step = {
      type: "click",
      selectors: selectorsFor(el),
      button: ev.button === 2 ? "right" : ev.button === 1 ? "middle" : "left",
      x: Math.round(ev.clientX - rect.left),
      y: Math.round(ev.clientY - rect.top),
      ts: nowRel(),
    };
    sendStep(step);
  }

  function isTextInput(el) {
    return (
      el &&
      ((el instanceof HTMLInputElement &&
        ["text", "search", "email", "url", "tel", "number"].includes(
          el.type
        )) ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable))
    );
  }

  function emitTypeForElement(el, { submit = false } = {}) {
    if (!isTextInput(el)) return;
    if (el instanceof HTMLInputElement && el.type === "password") return; // skip sensitive
    const val =
      el instanceof HTMLElement && el.isContentEditable
        ? el.textContent
        : el.value;
    const step = {
      type: "type",
      selectors: selectorsFor(el),
      text: String(val || ""),
      ts: nowRel(),
    };
    if (submit) step.submit = true;
    sendStep(step);
  }

  function onInput(ev) {
    if (!recording) return;
    const el = ev.target;
    if (!isTextInput(el)) return;
    if (el instanceof HTMLInputElement && el.type === "password") return; // skip sensitive
    const ent = debounces.get(el) || { timer: null, last: -Infinity };
    const now = nowRel();
    if (now - ent.last >= TYPE_MIN_INTERVAL_MS) {
      ent.last = now;
      if (ent.timer) {
        clearTimeout(ent.timer);
        ent.timer = null;
      }
      emitTypeForElement(el);
    } else if (!ent.timer) {
      const wait = TYPE_MIN_INTERVAL_MS - (now - ent.last);
      ent.timer = setTimeout(() => {
        ent.timer = null;
        ent.last = nowRel();
        emitTypeForElement(el);
      }, wait);
    }
    debounces.set(el, ent);
  }

  function onKeyDown(ev) {
    if (!recording) return;
    if (ev.key !== "Enter") return;
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const el = ev.target;
    // Treat Enter in single-line text inputs as submit intent; ignore textarea/contenteditable (newline)
    if (
      (el instanceof HTMLInputElement &&
        ["text", "search", "email", "url", "tel", "number"].includes(
          el.type
        )) ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    ) {
      // Flush/throttle bookkeeping and record a submit action for the form
      const ent = debounces.get(el);
      if (ent?.timer) {
        clearTimeout(ent.timer);
      }
      debounces.delete(el);
      const form = el.form || (el.closest && el.closest("form")) || null;
      if (form) {
        const step = {
          type: "submit",
          formSelectors: selectorsFor(form),
          selectors: selectorsFor(el),
          ts: nowRel(),
        };
        sendStep(step);
      } else {
        // No form: fall back to emitting a type with submit flag for JS handlers
        emitTypeForElement(el, { submit: true });
      }
    }
  }

  function onKeyPress(ev) {
    if (!recording) return;
    if (ev.key !== "Enter") return;
    const el = ev.target;
    if (
      (el instanceof HTMLInputElement &&
        ["text", "search", "email", "url", "tel", "number"].includes(
          el.type
        )) ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    ) {
      const form = el.form || (el.closest && el.closest("form")) || null;
      if (form) {
        const step = {
          type: "submit",
          formSelectors: selectorsFor(form),
          selectors: selectorsFor(el),
          ts: nowRel(),
        };
        sendStep(step);
      }
    }
  }

  function onKeyUp(ev) {
    if (!recording) return;
    if (ev.key !== "Enter") return;
    const el = ev.target;
    if (
      (el instanceof HTMLInputElement &&
        ["text", "search", "email", "url", "tel", "number"].includes(
          el.type
        )) ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    ) {
      const form = el.form || (el.closest && el.closest("form")) || null;
      if (form) {
        const step = {
          type: "submit",
          formSelectors: selectorsFor(form),
          selectors: selectorsFor(el),
          ts: nowRel(),
        };
        sendStep(step);
      }
    }
  }

  function onBeforeUnload() {
    try {
      if (!recording) return;
      const el = document.activeElement;
      if (
        el &&
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      ) {
        const form = el.form || (el.closest && el.closest("form")) || null;
        if (form) {
          const step = {
            type: "submit",
            formSelectors: selectorsFor(form),
            selectors: selectorsFor(el),
            ts: nowRel(),
          };
          // Best-effort: do not wait for response
          chrome.runtime.sendMessage({ type: "event", step });
        }
      }
    } catch (e) {}
  }

  function onSubmit(ev) {
    if (!recording) return;
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    // Record a submit step tied to the form and possible submitter
    const submitter =
      ev.submitter && form.contains(ev.submitter) ? ev.submitter : null;
    const payload = {
      type: "submit",
      formSelectors: selectorsFor(form),
      ts: nowRel(),
    };
    if (submitter) payload.submitterSelectors = selectorsFor(submitter);
    sendStep(payload);
  }

  function onChange(ev) {
    if (!recording) return;
    const el = ev.target;
    if (el instanceof HTMLSelectElement) {
      const values = Array.from(el.selectedOptions).map((o) => o.value);
      const step = {
        type: "select",
        selectors: selectorsFor(el),
        value: el.multiple ? values : values[0] || "",
        ts: nowRel(),
      };
      sendStep(step);
      return;
    }
    if (
      el instanceof HTMLInputElement &&
      (el.type === "checkbox" || el.type === "radio")
    ) {
      const step = {
        type: "change",
        selectors: selectorsFor(el),
        value: el.checked,
        ts: nowRel(),
      };
      sendStep(step);
      return;
    }
  }

  function onBlur(ev) {
    if (!recording) return;
    const el = ev.target;
    if (!isTextInput(el)) return;
    emitTypeForElement(el);
  }

  let lastWinScrollAt = 0;
  function onWindowScroll() {
    if (!recording) return;
    const now = performance.now();
    if (now - lastWinScrollAt < 300) return;
    lastWinScrollAt = now;
    sendStep({
      type: "scroll",
      target: "window",
      x: window.scrollX,
      y: window.scrollY,
      ts: nowRel(),
    });
  }

  function patchHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      if (!recordedFirstNavigate) {
        sendStep({ type: "navigate", url: location.href, ts: nowRel() });
        recordedFirstNavigate = true;
      }
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      if (!recordedFirstNavigate) {
        sendStep({ type: "navigate", url: location.href, ts: nowRel() });
        recordedFirstNavigate = true;
      }
      return ret;
    };
    function maybeSend() {
      if (!recordedFirstNavigate) {
        sendStep({ type: "navigate", url: location.href, ts: nowRel() });
        recordedFirstNavigate = true;
      }
    }
    window.addEventListener("popstate", maybeSend);
    window.addEventListener("hashchange", maybeSend);
  }

  function start(startedAt, isInitial) {
    if (recording) return;
    recording = true;
    if (typeof startedAt === "number") {
      startedAtMs = startedAt;
    } else if (typeof startedAt === "string") {
      const t = Date.parse(startedAt);
      if (!Number.isNaN(t)) startedAtMs = t;
    }
    if (!startedAtMs) startedAtMs = Date.now();
    // Only record the very first navigate at the beginning of the recording session
    if (isInitial) {
      sendStep({ type: "navigate", url: location.href, ts: nowRel() });
      recordedFirstNavigate = true;
    } else {
      // For reinjections after navigation, do not record more navigates
      recordedFirstNavigate = true;
    }
    window.addEventListener("click", onClick, true);
    window.addEventListener("input", onInput, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keypress", onKeyPress, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("beforeunload", onBeforeUnload, true);
    window.addEventListener("change", onChange, true);
    window.addEventListener("blur", onBlur, true);
    window.addEventListener("scroll", onWindowScroll, true);
    patchHistory();
  }

  function stop() {
    if (!recording) return;
    recording = false;
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("input", onInput, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keypress", onKeyPress, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("beforeunload", onBeforeUnload, true);
    window.removeEventListener("change", onChange, true);
    window.removeEventListener("blur", onBlur, true);
    window.removeEventListener("scroll", onWindowScroll, true);
    debounces.forEach((t) => clearTimeout(t));
    debounces.clear();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "startRecording") start(msg.startedAt, !!msg.initial);
    if (msg.type === "stopRecording") stop();
  });
})();
