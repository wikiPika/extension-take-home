/* global chrome */

const storage = chrome.storage && chrome.storage.session ? chrome.storage.session : chrome.storage.local;

function pad2(n) { return String(n).padStart(2, "0"); }

function formatLocalTimestamp(d = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${y}-${m}-${dd}_${hh}${mm}${ss}`;
}

let inMemory = { recording: false, tabId: null, steps: [] };

async function setRecordingStarted(atIso, tabInfo, tabId) {
  inMemory.recording = true;
  inMemory.tabId = tabId || null;
  inMemory.steps = [];
  await storage.set({
    recording: true,
    startedAt: atIso,
    startUrl: tabInfo?.url || null,
    startOrigin: tabInfo?.origin || null,
    startTitle: tabInfo?.title || null,
    tabId: tabId || null
  });
}

async function clearRecording() {
  inMemory = { recording: false, tabId: null, steps: [] };
  await storage.set({ recording: false, tabId: null });
}

async function getStartedAt() {
  const { startedAt } = await storage.get({ startedAt: null });
  return startedAt;
}

async function getStartContext() {
  const { startUrl, startOrigin, startTitle, tabId } = await storage.get({ startUrl: null, startOrigin: null, startTitle: null, tabId: null });
  return { startUrl, startOrigin, startTitle, tabId };
}

async function getActiveTabInfo() {
  const isWebUrl = (u) => !!u && !u.startsWith('chrome-extension://') && !u.startsWith('chrome://') && !u.startsWith('devtools://');
  // Prefer the window where the action was clicked.
  const { lastClickedContext } = await (chrome.storage.session
    ? chrome.storage.session.get({ lastClickedContext: null })
    : chrome.storage.local.get({ lastClickedContext: null }));
  const winId = lastClickedContext?.windowId ?? null;
  if (winId != null) {
    try {
      const tabs = await chrome.tabs.query({ windowId: winId });
      // Pick active tab in that window, or first web tab
      const active = tabs.find((t) => t.active && isWebUrl(t.url || ''));
      const candidate = active || tabs.find((t) => isWebUrl(t.url || ''));
      if (candidate && isWebUrl(candidate.url || '')) {
        try { return { url: candidate.url, title: candidate.title || null, origin: new URL(candidate.url).origin }; } catch {}
      }
    } catch {}
  }
  // Next, try the specific tabId saved at click time
  if (lastClickedContext?.tabId) {
    try {
      const tab = await chrome.tabs.get(lastClickedContext.tabId);
      if (isWebUrl(tab?.url || '')) {
        try { return { url: tab.url, title: tab?.title || null, origin: new URL(tab.url).origin }; } catch {}
      }
    } catch {}
  }
  // Fallback: any active tab in any normal window
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    for (const w of wins) {
      const t = (w.tabs || []).find((t) => t.active && isWebUrl(t.url || '')) || (w.tabs || []).find((t) => isWebUrl(t.url || ''));
      if (t && isWebUrl(t.url || '')) {
        try { return { url: t.url, title: t.title || null, origin: new URL(t.url).origin }; } catch {}
      }
    }
  } catch {}
  // Last resort: current window active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isWebUrl(tab.url || '')) return null;
  try {
    const u = new URL(tab.url || "");
    return { url: tab.url || null, title: tab.title || null, origin: u.origin };
  } catch {
    return { url: tab.url || null, title: tab.title || null, origin: null };
  }
}

function buildTrace(startedAtIso, ctx) {
  const createdAtIso = new Date().toISOString();
  return {
    version: "1.0",
    createdAt: createdAtIso,
    startedAt: startedAtIso || createdAtIso,
    startUrl: ctx?.startUrl || null,
    startOrigin: ctx?.startOrigin || (ctx?.startUrl ? new URL(ctx.startUrl).origin : null),
    startTitle: ctx?.startTitle || null,
    baseUrl: ctx?.startOrigin || (ctx?.startUrl ? new URL(ctx.startUrl).origin : undefined),
    metadata: {
      userAgent: self.navigator ? self.navigator.userAgent : "",
    },
    steps: []
  };
}

function downloadJson(obj, filename) {
  const json = JSON.stringify(obj, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve({ ok: true, downloadId });
      }
    });
  });
}

async function openOrFocusPanel() {
  const url = chrome.runtime.getURL("panel.html");
  const { panelWindowId } = await (chrome.storage.session ? chrome.storage.session.get({ panelWindowId: null }) : chrome.storage.local.get({ panelWindowId: null }));
  async function create() {
    const win = await chrome.windows.create({ url, type: "popup", width: 420, height: 560, focused: true });
    const id = win?.id || null;
    if (id) {
      if (chrome.storage.session) await chrome.storage.session.set({ panelWindowId: id });
      else await chrome.storage.local.set({ panelWindowId: id });
    }
  }
  if (!panelWindowId) return create();
  try {
    const win = await chrome.windows.get(panelWindowId);
    if (win) {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    }
    return create();
  } catch {
    return create();
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    let ctx = null;
    if (tab && tab.id) {
      const url = tab.url || null;
      let origin = null;
      try { origin = url ? new URL(url).origin : null; } catch {}
      ctx = { tabId: tab.id, windowId: tab.windowId, url, title: tab.title || null, origin };
    }
    if (chrome.storage.session) await chrome.storage.session.set({ lastClickedContext: ctx });
    else await chrome.storage.local.set({ lastClickedContext: ctx });
  } catch {}
  openOrFocusPanel();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) return sendResponse({ ok: false, error: "No type" });
    if (message.type === "listTraces") {
      // Find recent downloads to traces/*.json; prefer those created by this extension (data: URL)
      const items = await chrome.downloads.search({ query: ["traces", ".json"], limit: 100 });
      const filtered = items
        .filter((it) => typeof it.filename === "string" && /[\\\/]traces[\\\/]([^\\\/]+\.json)$/.test(it.filename))
        .map((it) => {
          const m = it.filename.match(/[\\\/]traces[\\\/]([^\\\/]+\.json)$/);
          const display = m ? m[1] : it.filename.split(/[\\\/]/).pop();
          return {
            id: it.id,
            filename: it.filename,
            displayName: display,
            url: it.url,
            startTime: it.startTime,
            mime: it.mime,
          };
        })
        .sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
      return sendResponse({ ok: true, traces: filtered });
    }
    if (message.type === "loadTrace") {
      const id = message.id;
      if (typeof id !== "number") return sendResponse({ ok: false, error: "Missing id" });
      const [item] = await chrome.downloads.search({ id });
      if (!item) return sendResponse({ ok: false, error: "Trace not found" });
      const url = item.url || "";
      if (!url.startsWith("data:application/json")) {
        return sendResponse({ ok: false, error: "Can only load traces saved by this extension (data URL)." });
      }
      try {
        const comma = url.indexOf(",");
        const encoded = url.slice(comma + 1);
        const jsonStr = decodeURIComponent(encoded);
        const data = JSON.parse(jsonStr);
        return sendResponse({ ok: true, trace: data });
      } catch (e) {
        return sendResponse({ ok: false, error: `Failed to decode trace: ${e && e.message ? e.message : e}` });
      }
    }
    if (message.type === 'event') {
      // Append step coming from content script; attribute to sender.tab.id
      if (!inMemory.recording) return sendResponse({ ok: false, error: 'Not recording' });
      const tid = sender?.tab?.id;
      if (inMemory.tabId != null && tid != null && inMemory.tabId !== tid) {
        // Ignore events from other tabs/windows
        return sendResponse({ ok: false, error: 'Event from non-recorded tab' });
      }
      const step = message.step;
      if (step && typeof step.ts === 'number') {
        inMemory.steps.push(step);
      }
      return sendResponse({ ok: true });
    }
    if (message.type === "start") {
      const tabInfo = await getActiveTabInfo();
      // Determine target tab id (active in original window)
      let targetTabId = null;
      if (tabInfo) {
        try {
          const { lastClickedContext } = await (chrome.storage.session ? chrome.storage.session.get({ lastClickedContext: null }) : chrome.storage.local.get({ lastClickedContext: null }));
          if (lastClickedContext?.windowId != null) {
            const tabs = await chrome.tabs.query({ windowId: lastClickedContext.windowId });
            const active = tabs.find((t) => t.active && t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')) || tabs.find((t) => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
            if (active?.id) targetTabId = active.id;
          }
        } catch {}
      }
      if (targetTabId == null) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) targetTabId = tab.id;
      }
      // Inject content script and start
      const startedAtIso = new Date().toISOString();
      if (targetTabId != null) {
        await chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ["content.js"] });
        await chrome.tabs.sendMessage(targetTabId, { type: 'startRecording', startedAt: startedAtIso, initial: true }).catch(() => {});
      }
      await setRecordingStarted(startedAtIso, tabInfo, targetTabId);
      return sendResponse({ ok: true, status: "recording", site: tabInfo?.origin || tabInfo?.url || null });
    }
    if (message.type === "stop") {
      const startedAtIso = await getStartedAt();
      const ctx = await getStartContext();
      if (ctx?.tabId != null) {
        await chrome.tabs.sendMessage(ctx.tabId, { type: 'stopRecording' }).catch(() => {});
      }
      const trace = buildTrace(startedAtIso, ctx);
      trace.steps = inMemory.steps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const tsName = formatLocalTimestamp(new Date());
      const filename = `traces/${tsName}.json`;
      const res = await downloadJson(trace, filename);
      await clearRecording();
      return sendResponse({ ...res, filename });
    }
    if (message.type === 'playLoadedTrace') {
      const res = await playLoadedTrace();
      return sendResponse(res.ok ? { ok: true, message: `Playback started (${res.steps || 0} steps).` } : res);
    }
    if (message.type === 'replayProgress') {
      const p = message.payload;
      if (p && p.kind === 'state' && (p.state === 'finished' || p.state === 'stopped')) {
        if (inMemory.playback) inMemory.playback.running = false;
      }
      // Forward to panel views
      chrome.runtime.sendMessage({ type: 'replayProgress', payload: message.payload }).catch(() => {});
      return sendResponse({ ok: true });
    }
    if (message.type === 'replayPause') {
      const res = await controlPlayback('pause');
      return sendResponse(res);
    }
    if (message.type === 'replayResume') {
      const res = await controlPlayback('resume');
      return sendResponse(res);
    }
    if (message.type === 'replaySeek') {
      const ts = (typeof message.ts === 'number' && isFinite(message.ts)) ? message.ts : null;
      if (ts == null) return sendResponse({ ok: false, error: 'Invalid seek timestamp' });
      const res = await controlPlayback('seek', ts);
      return sendResponse(res);
    }
    if (message.type === 'replayStop') {
      const res = await controlPlayback('stop');
      inMemory.playback = { tabId: inMemory.playback?.tabId || null, running: false };
      return sendResponse(res);
    }
    return sendResponse({ ok: false, error: "Unknown type" });
  })();
  return true; // keep the message channel open for async response
});

async function ensureOnStartSite(trace, tabId) {
  try {
    const want = trace.startOrigin || trace.baseUrl;
    if (!want) return { ok: true };
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'Target tab not found' };
    const curUrl = tab.url || '';
    const curOrigin = (() => { try { return new URL(curUrl).origin; } catch { return null; } })();
    if (curOrigin === want) return { ok: true };
    if (trace.startUrl) {
      await chrome.tabs.update(tabId, { url: trace.startUrl });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error('Navigation timeout'));
        }, 20000);
        const listener = (id, info) => {
          if (id === tabId && info.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      return { ok: true };
    }
    return { ok: false, error: 'Trace origin mismatch and no startUrl.' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function playLoadedTrace() {
  const isWebUrl = (u) => !!u && !u.startsWith('chrome-extension://') && !u.startsWith('chrome://') && !u.startsWith('devtools://');
  // Try to use the original window's active tab
  const { lastClickedContext } = await (chrome.storage.session ? chrome.storage.session.get({ lastClickedContext: null }) : chrome.storage.local.get({ lastClickedContext: null }));
  let tid = null;
  if (lastClickedContext?.windowId != null) {
    try {
      const tabs = await chrome.tabs.query({ windowId: lastClickedContext.windowId });
      const active = tabs.find((t) => t.active && isWebUrl(t.url || '')) || tabs.find((t) => isWebUrl(t.url || ''));
      if (active?.id) tid = active.id;
    } catch {}
  }
  if (tid == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return { ok: false, error: 'No active tab' };
    tid = tab.id;
  }
  const { loadedTrace } = await (chrome.storage.session ? chrome.storage.session.get({ loadedTrace: null }) : chrome.storage.local.get({ loadedTrace: null }));
  if (!loadedTrace) return { ok: false, error: 'No loaded trace in session' };
  const siteOk = await ensureOnStartSite(loadedTrace, tid);
  if (!siteOk.ok) return siteOk;
  // Inject progress bridge and shared replayer into the content (isolated) world
  await chrome.scripting.executeScript({ target: { tabId: tid }, files: ["bridge.js"] });
  await chrome.scripting.executeScript({ target: { tabId: tid }, files: ["shared/replayer.js"] });
  // Mark playback context immediately so controls work
  inMemory.playback = { tabId: tid, running: true };
  // Kick off playback asynchronously (fire-and-forget) so the worker isn't blocked
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (trace) => {
      try {
        if (!window.AlteraReplayerControl) return { ok: false, error: 'Replayer not loaded in page context' };
        Promise.resolve(window.AlteraReplayerControl.play(trace, { speed: 1.0 }));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) ? e.message : String(e) };
      }
    },
    args: [loadedTrace]
  });
  return result || { ok: false, error: 'Unknown error during replay' };
}

async function controlPlayback(cmd, arg) {
  const tid = inMemory.playback?.tabId;
  if (!tid) return { ok: false, error: 'No playback tab' };
  const injArgs = (cmd === 'seek') ? [cmd, arg] : [cmd];
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (command, value) => {
      if (!window.AlteraReplayerControl) return { ok: false, error: 'Replayer not loaded' };
      if (command === 'pause') return window.AlteraReplayerControl.pause();
      if (command === 'resume') return window.AlteraReplayerControl.resume();
      if (command === 'seek') return window.AlteraReplayerControl.seek(value);
      if (command === 'stop') return window.AlteraReplayerControl.stop();
      return { ok: false, error: 'bad command' };
    },
    args: injArgs
  });
  return result || { ok: false, error: 'Unknown control error' };
}

// Re-inject recorder after full navigations in the recorded tab
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  try {
    if (!inMemory.recording) return;
    if (inMemory.tabId == null || tabId !== inMemory.tabId) return;
    if (info.status !== 'complete') return;
    const startedAtIso = await getStartedAt();
    // Re-inject and resume recording with the original startedAt to keep timestamps relative to start
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: 'startRecording', startedAt: startedAtIso, initial: false }).catch(() => {});
  } catch (_) {}
});
