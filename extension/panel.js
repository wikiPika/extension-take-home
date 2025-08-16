(() => {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const traceSelect = $("traceSelect");
  const refreshBtn = $("refreshBtn");
  const loadBtn = $("loadBtn");
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

  function refreshTraces() {
    chrome.runtime.sendMessage({ type: "listTraces" }, (res) => {
      if (chrome.runtime.lastError) {
        traceSummary.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      if (res && res.ok) {
        populateTraces(res.traces || []);
        traceSummary.textContent = `Found ${res.traces?.length || 0} trace(s).`;
      } else {
        traceSummary.textContent = `Failed to list traces: ${res && res.error ? res.error : 'unknown'}`;
      }
    });
  }

  refreshBtn.addEventListener("click", refreshTraces);

  loadBtn.addEventListener("click", () => {
    const id = Number(traceSelect.value);
    if (!id) {
      traceSummary.textContent = "Please select a trace first.";
      return;
    }
    chrome.runtime.sendMessage({ type: "loadTrace", id }, (res) => {
      if (chrome.runtime.lastError) {
        traceSummary.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      if (res && res.ok) {
        const summary = summarizeTrace(res.trace);
        traceSummary.textContent = summary;
        chrome.storage.session && chrome.storage.session.set({ loadedTrace: res.trace });
      } else {
        traceSummary.textContent = `Failed to load trace: ${res && res.error ? res.error : 'unknown'}`;
      }
    });
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
  refreshTraces();
})();

