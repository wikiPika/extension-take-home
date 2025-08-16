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
  });

  playBtn.addEventListener("click", () => {
    traceSummary.textContent = "Playing trace...";
    chrome.runtime.sendMessage({ type: "playLoadedTrace" }, (res) => {
      if (chrome.runtime.lastError) {
        traceSummary.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      if (res && res.ok) {
        traceSummary.textContent = res.message || "Playback finished.";
      } else {
        traceSummary.textContent = `Failed to play: ${res && res.error ? res.error : 'unknown'}`;
      }
    });
  });

  // Initial load
  setPlayEnabled(false);
  refreshTraces();
})();
