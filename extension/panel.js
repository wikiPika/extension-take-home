(() => {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const traceSelect = $("traceSelect");
  const refreshBtn = $("refreshBtn");
  const clearBtn = $("clearBtn");
  const traceSummary = $("traceSummary");
  const playBtn = $("playBtn");
  const timelineWrap = document.getElementById('timelineWrap');
  const timeline = document.getElementById('timeline');
  const timelineTime = document.getElementById('timelineTime');
  const eventDetails = document.getElementById('eventDetails');

  let loadedTrace = null;
  let isPlaying = false;
  let isPaused = false;
  let tipEl = null;
  let lineEl = null;
  const timelineHeight = 360;
  const paddingTop = 10;
  const paddingBottom = 10;
  const playbackStateEl = document.getElementById('playbackState');
  let baseTs = 0;
  let endTs = 0;

  startBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "start" }, (res) => {
      if (chrome.runtime.lastError) {
        status.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      if (res && res.ok) {
        status.textContent = `Recording started${res.site ? ` @ ${res.site}` : ''}`;
      } else {
        status.textContent = `Failed to start: ${res && res.error ? res.error : "unknown"}`;
      }
    });
  });

  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "stop" }, (res) => {
      if (chrome.runtime.lastError) {
        status.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      if (res && res.ok) {
        status.textContent = `Trace saved to ${res.filename}`;
        // Auto-refresh traces and select the new one
        const downloadId = res.downloadId;
        const filename = res.filename;
        refreshTraces((traces) => {
          let match = null;
          if (typeof downloadId === 'number') {
            match = (traces || []).find((t) => t.id === downloadId);
          }
          if (!match && filename) {
            match = (traces || []).find((t) => t.displayName === filename.split('/').pop());
          }
          if (match) {
            traceSelect.value = String(match.id);
            loadSelectedTrace();
          }
        });
      } else {
        status.textContent = `Failed to save: ${res && res.error ? res.error : "unknown"}`;
      }
    });
  });

  function populateTraces(list) {
    while (traceSelect.options.length > 1) traceSelect.remove(1);
    for (const it of list) {
      const opt = document.createElement("option");
      opt.value = String(it.id);
      opt.textContent = it.displayName || it.filename || `#${it.id}`;
      traceSelect.appendChild(opt);
    }
  }

  function summarizeTrace(trace) {
    if (!trace || !Array.isArray(trace.steps)) return "Invalid trace";
    const counts = {};
    for (const s of trace.steps) {
      const t = s.type || "unknown";
      counts[t] = (counts[t] || 0) + 1;
    }
    const parts = [
      `Site: ${trace.startOrigin || trace.baseUrl || '(unknown)'}`,
      `Steps: ${trace.steps.length}`
    ];
    for (const t of Object.keys(counts).sort()) parts.push(`- ${t}: ${counts[t]}`);
    return parts.join("\n");
  }

  function formatSeconds(ms) { return `${(ms / 1000).toFixed(2)}s`; }

  function clearTimeline() {
    if (timeline) timeline.innerHTML = '';
    // Remove any scrubber elements if parented elsewhere
    if (lineEl && lineEl.parentNode) lineEl.parentNode.removeChild(lineEl);
    if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
    lineEl = null; tipEl = null;
    if (timelineTime) timelineTime.textContent = '0.00s';
    if (eventDetails) eventDetails.textContent = 'Hover over an event to inspect details.';
    if (timelineWrap) timelineWrap.style.display = 'none';
  }

  function renderTimeline(trace) {
    clearTimeline();
    if (!trace || !Array.isArray(trace.steps) || trace.steps.length === 0) return;
    const steps = trace.steps.slice().sort((a,b)=>(a.ts||0)-(b.ts||0));
    baseTs = steps[0].ts || 0;
    endTs = steps[steps.length-1].ts || 0;
    if (timelineWrap) timelineWrap.style.display = '';
    // Scrubber line + tip
    lineEl = document.createElement('div');
    lineEl.className = 'scrubber-line';
    lineEl.style.top = `${paddingTop}px`;
    lineEl.style.height = '0px';
    tipEl = document.createElement('div');
    tipEl.className = 'scrubber-tip';
    tipEl.style.top = `${paddingTop}px`;
    timeline.appendChild(lineEl);
    timeline.appendChild(tipEl);
    const H = timelineHeight - paddingTop - paddingBottom;
    const dur = Math.max(1, endTs - baseTs);
    const pxPerMs = H / dur;
    function tsToTop(ts) { return paddingTop + Math.max(0, Math.min(H, (ts - baseTs) * pxPerMs)); }
    function topToTs(px) { return baseTs + Math.max(0, Math.min(H, (px - paddingTop))) / pxPerMs; }
    // Render events
    steps.forEach((s) => {
      const y = tsToTop(s.ts || 0);
      const item = document.createElement('div');
      item.className = 'event-item';
      item.style.top = `${y}px`;
      const dot = document.createElement('div');
      dot.className = 'event-dot';
      const label = document.createElement('div');
      label.className = 'event-label';
      label.textContent = s.type;
      const show = () => { eventDetails.textContent = `${s.type} @ ${formatSeconds((s.ts||0)-baseTs)}\n` + JSON.stringify(s, null, 2); };
      item.addEventListener('mouseenter', show);
      label.addEventListener('mouseenter', show);
      dot.addEventListener('mouseenter', show);
      item.appendChild(dot);
      item.appendChild(label);
      timeline.appendChild(item);
    });
    // Dragging when paused
    let dragging = false;
    let offset = 0;
    tipEl.addEventListener('mousedown', (e) => {
      if (!isPaused) return;
      const rect = timeline.getBoundingClientRect();
      offset = e.clientY - rect.top - tipEl.offsetTop;
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = timeline.getBoundingClientRect();
      const raw = e.clientY - rect.top - offset;
      const top = Math.max(paddingTop, Math.min(paddingTop + H, raw));
      tipEl.style.top = `${top}px`;
      lineEl.style.height = `${top - paddingTop}px`;
      timelineTime.textContent = formatSeconds(topToTs(top) - baseTs);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const top = parseFloat(tipEl.style.top);
      const ts = topToTs(top);
      chrome.runtime.sendMessage({ type: 'replaySeek', ts });
    });
    // Save helper
    timeline._tsToTop = tsToTop;
  }

  function refreshTraces(onDone) {
    chrome.runtime.sendMessage({ type: "listTraces" }, (res) => {
      if (chrome.runtime.lastError) {
        traceSummary.textContent = `Error: ${chrome.runtime.lastError.message}`;
        if (onDone) onDone([]);
        return;
      }
      if (res && res.ok) {
        populateTraces(res.traces || []);
        traceSummary.textContent = `Found ${res.traces?.length || 0} trace(s).`;
        if (onDone) onDone(res.traces || []);
      } else {
        traceSummary.textContent = `Failed to list traces: ${res && res.error ? res.error : 'unknown'}`;
        if (onDone) onDone([]);
      }
    });
  }

  refreshBtn.addEventListener("click", refreshTraces);

  function setPlayEnabled(enabled) {
    if (enabled) {
      playBtn.removeAttribute('disabled');
    } else {
      playBtn.setAttribute('disabled', 'true');
    }
  }

  function loadSelectedTrace() {
    const id = Number(traceSelect.value);
    if (!id) {
      setPlayEnabled(false);
      return;
    }
    chrome.runtime.sendMessage({ type: "loadTrace", id }, (res) => {
      if (chrome.runtime.lastError) {
        traceSummary.textContent = `Error: ${chrome.runtime.lastError.message}`;
        setPlayEnabled(false);
        return;
      }
      if (res && res.ok) {
        const summary = summarizeTrace(res.trace);
        traceSummary.textContent = summary;
        loadedTrace = res.trace;
        renderTimeline(loadedTrace);
        if (chrome.storage.session) chrome.storage.session.set({ loadedTrace: res.trace });
        else chrome.storage.local.set({ loadedTrace: res.trace });
        setPlayEnabled(true);
      } else {
        traceSummary.textContent = `Failed to load trace: ${res && res.error ? res.error : 'unknown'}`;
        setPlayEnabled(false);
      }
    });
  }

  traceSelect.addEventListener('change', loadSelectedTrace);

  clearBtn.addEventListener('click', () => {
    // Clear loaded trace and UI
    if (chrome.storage.session) chrome.storage.session.remove('loadedTrace');
    else chrome.storage.local.remove('loadedTrace');
    traceSelect.value = '';
    traceSummary.textContent = 'Cleared loaded trace.';
    setPlayEnabled(false);
    clearTimeline();
  });

  function setPlayPauseUI() {
    playBtn.textContent = (isPlaying && !isPaused) ? 'Pause' : 'Play';
    if (playbackStateEl) playbackStateEl.textContent = isPlaying ? (isPaused ? 'paused' : 'playing') : 'stopped';
  }
  playBtn.addEventListener("click", () => {
    if (!isPlaying || isPaused) {
      const msg = (!isPlaying) ? { type: 'playLoadedTrace' } : { type: 'replayResume' };
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          traceSummary.textContent = `Error: ${chrome.runtime.lastError.message}`;
          return;
        }
        if (res && res.ok) { isPlaying = true; isPaused = false; setPlayPauseUI(); }
        else { traceSummary.textContent = `Failed to play: ${res && res.error ? res.error : 'unknown'}`; }
      });
    } else {
      chrome.runtime.sendMessage({ type: 'replayPause' }, (res) => {
        if (res && res.ok) { isPaused = true; setPlayPauseUI(); }
      });
    }
  });

  // Listen for progress
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'replayProgress') return;
    const p = msg.payload;
    if (!p) return;
    if (p.kind === 'state') {
      if (p.state === 'started' || p.state === 'resumed') { isPlaying = true; isPaused = false; }
      else if (p.state === 'paused') { isPaused = true; }
      else if (p.state === 'finished' || p.state === 'stopped') { isPlaying = false; isPaused = false; }
      setPlayPauseUI();
    } else if (p.kind === 'progress') {
      if (tipEl && lineEl && timeline._tsToTop) {
        const top = timeline._tsToTop(p.ts || 0);
        tipEl.style.top = `${top}px`;
        lineEl.style.height = `${top - paddingTop}px`;
        timelineTime.textContent = formatSeconds((p.ts || 0) - (baseTs || 0));
      }
    }
  });

  // Initial load
  setPlayEnabled(false);
  setPlayPauseUI();
  clearTimeline();
  refreshTraces();
})();
