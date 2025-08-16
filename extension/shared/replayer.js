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
        } else if (sel && sel.type === 'aria') {
          // Basic ARIA name lookup via aria-label/title text
          const target = String(sel.value || '').toLowerCase();
          const candidates = document.querySelectorAll('[aria-label], [title], button, [role="button"]');
          for (const c of candidates) {
            const name = (c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || '').trim().toLowerCase();
            if (name && (name === target || name.includes(target))) return c;
          }
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
      if (typeof step.x === 'number' && typeof step.y === 'number') {
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + step.x;
        const clientY = rect.top + step.y;
        const opts = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: (step.button === 'right' ? 2 : step.button === 'middle' ? 1 : 0) };
        el.dispatchEvent(new MouseEvent('mousemove', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      } else {
        el.click();
      }
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
      return;
    }
    if (type === 'submit') {
      // Prefer formSelectors, else derive from the element selectors
      let form = null;
      if (Array.isArray(step.formSelectors)) {
        form = findElement(step.formSelectors);
      }
      if (!form && Array.isArray(step.selectors)) {
        const el = findElement(step.selectors);
        if (el) form = el.closest('form');
      }
      if (!form) throw new Error('submit form not found');
      // If there was an explicit submitter, click it first to mimic user intent
      if (Array.isArray(step.submitterSelectors)) {
        const submitter = findElement(step.submitterSelectors);
        if (submitter && typeof submitter.click === 'function') {
          submitter.click();
        }
      }
      // Use requestSubmit to fire submit handlers, fallback to submit
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
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

  // Controller with pause/resume/seek and progress events via window.postMessage
  const ctrlState = {
    playing: false,
    paused: false,
    steps: [],
    baseTs: 0,
    endTs: 0,
    idx: 0,
    currentTs: 0,
    speed: 1,
    startWall: 0
  };

  function emit(kind, data) {
    try { window.postMessage({ __altera: true, kind, ...data }, '*'); } catch {}
  }

  async function playControlled(trace, options = {}) {
    const steps = Array.isArray(trace?.steps) ? trace.steps.slice() : [];
    if (!steps.length) return { ok: false, error: 'Empty steps' };
    steps.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    ctrlState.playing = true;
    ctrlState.paused = false;
    ctrlState.steps = steps;
    ctrlState.baseTs = steps[0].ts || 0;
    ctrlState.endTs = steps[steps.length - 1].ts || 0;
    ctrlState.idx = 0;
    ctrlState.currentTs = ctrlState.baseTs;
    ctrlState.speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1;
    ctrlState.startWall = performance.now();
    emit('state', { state: 'started', baseTs: ctrlState.baseTs, endTs: ctrlState.endTs });

    while (ctrlState.playing && ctrlState.idx < steps.length) {
      const step = steps[ctrlState.idx];
      const target = ctrlState.startWall + ((Math.max(0, (step.ts || 0) - ctrlState.baseTs)) / ctrlState.speed);
      while (ctrlState.playing) {
        if (ctrlState.paused) { await sleep(50); continue; }
        const now = performance.now();
        const wait = target - now;
        // Emit smooth progress ticks while waiting for next step
        const curTs = ctrlState.baseTs + Math.max(0, (now - ctrlState.startWall)) * ctrlState.speed;
        ctrlState.currentTs = Math.min(curTs, ctrlState.endTs);
        emit('progress', { ts: ctrlState.currentTs, idx: ctrlState.idx, endTs: ctrlState.endTs });
        if (wait > 5) { await sleep(Math.min(wait, 50)); continue; }
        break;
      }
      if (!ctrlState.playing) break;
      await performStep(step, { honorWait: false });
      ctrlState.currentTs = step.ts || ctrlState.currentTs;
      emit('progress', { ts: ctrlState.currentTs, idx: ctrlState.idx, endTs: ctrlState.endTs });
      ctrlState.idx += 1;
    }
    // Final progress to end
    emit('progress', { ts: ctrlState.endTs, idx: ctrlState.idx, endTs: ctrlState.endTs });
    const finished = ctrlState.idx >= steps.length;
    ctrlState.playing = false;
    emit('state', { state: finished ? 'finished' : 'stopped' });
    return { ok: true, steps: steps.length, finished };
  }

  function pause() {
    ctrlState.paused = true;
    emit('state', { state: 'paused' });
    return { ok: true };
  }
  function resume() {
    if (!ctrlState.playing) return { ok: false, error: 'not playing' };
    // align wall clock so next targets are in future from now
    ctrlState.startWall = performance.now() - ((Math.max(0, ctrlState.currentTs - ctrlState.baseTs)) / ctrlState.speed);
    ctrlState.paused = false;
    emit('state', { state: 'resumed' });
    return { ok: true };
  }
  function seek(ts) {
    if (!ctrlState.steps.length) return { ok: false, error: 'no steps' };
    const clamped = Math.max(ctrlState.baseTs, Math.min(ts, ctrlState.endTs));
    ctrlState.currentTs = clamped;
    // find the first step with ts >= clamped
    let i = 0;
    while (i < ctrlState.steps.length && (ctrlState.steps[i].ts || 0) < clamped) i++;
    ctrlState.idx = i;
    ctrlState.startWall = performance.now() - ((Math.max(0, ctrlState.currentTs - ctrlState.baseTs)) / ctrlState.speed);
    emit('progress', { ts: ctrlState.currentTs, idx: ctrlState.idx, endTs: ctrlState.endTs });
    return { ok: true };
  }
  function stop() {
    ctrlState.playing = false;
    ctrlState.paused = false;
    emit('state', { state: 'stopped' });
    return { ok: true };
  }

  window.AlteraReplayer = { replay };
  window.AlteraReplayerControl = { play: playControlled, pause, resume, seek, stop };
})();
