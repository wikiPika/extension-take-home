// Minimal in-page replayer that understands the trace schema.
// Exposed as window.AlteraReplayer.replay(trace, options)
(function () {
  if (window.AlteraReplayer) return; // idempotent

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findByText(root, text) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_ELEMENT, null);
    const norm = (s) => String(s || "").trim();
    const target = norm(text).toLowerCase();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const tx = norm(node.textContent).toLowerCase();
      if (tx.includes(target)) return node;
    }
    return null;
  }

  function findElement(selectors) {
    if (!selectors || !selectors.length) return null;
    for (const sel of selectors) {
      try {
        if (typeof sel === 'string') {
          const el = document.querySelector(sel);
          if (el) return el;
          continue;
        }
        if (sel && sel.type === 'css') {
          const el = document.querySelector(sel.value);
          if (el) return el;
        } else if (sel && sel.type === 'text') {
          const el = findByText(document, sel.value);
          if (el) return el;
        } else if (sel && sel.type === 'xpath') {
          const result = document.evaluate(sel.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (result.singleNodeValue) return result.singleNodeValue;
        }
        // aria locators not implemented yet
      } catch (e) {
        // ignore selector errors
      }
    }
    return null;
  }

  async function waitForSelector(selector, { state = 'visible', timeout = 10000 } = {}) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const el = typeof selector === 'string' ? document.querySelector(selector) : findElement([selector]);
      if (el) {
        if (state === 'visible') {
          if (isVisible(el)) return el;
        } else if (state === 'attached') {
          return el;
        } else if (state === 'hidden') {
          // wait for not visible
          if (!isVisible(el)) return el;
        } else {
          return el;
        }
      }
      await sleep(100);
    }
    throw new Error(`Timeout waiting for selector (${typeof selector === 'string' ? selector : JSON.stringify(selector)})`);
  }

  async function performStep(step, opts = {}) {
    const type = step.type;
    if (type === 'navigate') {
      // Navigation is handled by the extension; noop here.
      return 'noop:navigate';
    }
    if (type === 'wait') {
      const f = step.for || {};
      if ('ms' in f) {
        if (opts.honorWait !== false) {
          return sleep(Number(f.ms));
        }
        return;
      }
      if ('selector' in f) return waitForSelector(f.selector, { state: f.state || 'visible' });
      if ('url' in f) {
        const start = performance.now();
        while (performance.now() - start < 10000) {
          if (location.href.includes(f.url)) return true;
          await sleep(100);
        }
        throw new Error('Timeout waiting for url');
      }
      if ('networkIdle' in f) {
        // Best-effort: just wait a bit
        return sleep(500);
      }
      return;
    }
    if (type === 'scroll') {
      if (step.target === 'window') {
        window.scrollTo(step.x || 0, step.y || 0);
      } else if (step.target === 'element') {
        const el = findElement(step.selectors);
        if (!el) throw new Error('scroll target not found');
        el.scrollTo(step.x || 0, step.y || 0);
      }
      return;
    }
    if (type === 'click') {
      const el = findElement(step.selectors);
      if (!el) throw new Error('click target not found');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return;
    }
    if (type === 'type') {
      const el = findElement(step.selectors);
      if (!el) throw new Error('type target not found');
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.value = step.text || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        el.textContent = step.text || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (step.submit) {
        const form = el.closest('form');
        if (form) form.submit();
      }
      return;
    }
    if (type === 'change' || type === 'select') {
      const el = findElement(step.selectors);
      if (!el) throw new Error(`${type} target not found`);
      if (el instanceof HTMLSelectElement) {
        if (Array.isArray(step.value)) {
          for (const opt of el.options) opt.selected = step.value.includes(opt.value);
        } else {
          el.value = String(step.value);
        }
      } else if (el instanceof HTMLInputElement) {
        el.value = String(step.value);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    console.warn('Unknown step type', type);
  }

  async function replay(trace, options = {}) {
    const steps = Array.isArray(trace?.steps) ? trace.steps.slice() : [];
    if (!steps.length) return { ok: false, error: 'Empty steps' };
    // Run in ts order
    steps.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const baseTs = steps[0].ts || 0;
    const realTime = options.realTime !== false; // default true
    const speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1.0;
    if (realTime) {
      const startWall = performance.now();
      for (const step of steps) {
        const target = startWall + ((Math.max(0, (step.ts || 0) - baseTs)) / speed);
        const now = performance.now();
        const wait = target - now;
        if (wait > 0) await sleep(wait);
        await performStep(step, { honorWait: false });
      }
    } else {
      let prevTs = baseTs;
      const maxCap = options.maxWaitBetweenSteps;
      for (const step of steps) {
        let delay = Math.max(0, (step.ts || 0) - prevTs);
        if (Number.isFinite(maxCap)) delay = Math.min(delay, maxCap);
        if (delay) await sleep(delay);
        await performStep(step, { honorWait: true });
        prevTs = step.ts || prevTs;
      }
    }
    return { ok: true, steps: steps.length };
  }

  window.AlteraReplayer = { replay };
})();
