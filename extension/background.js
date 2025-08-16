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

async function setRecordingStarted(atIso, tabInfo) {
  await storage.set({
    recording: true,
    startedAt: atIso,
    startUrl: tabInfo?.url || null,
    startOrigin: tabInfo?.origin || null,
    startTitle: tabInfo?.title || null,
  });
}

async function clearRecording() {
  await storage.set({ recording: false });
}

async function getStartedAt() {
  const { startedAt } = await storage.get({ startedAt: null });
  return startedAt;
}

async function getStartContext() {
  const { startUrl, startOrigin, startTitle } = await storage.get({ startUrl: null, startOrigin: null, startTitle: null });
  return { startUrl, startOrigin, startTitle };
}

async function getActiveTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    if (message.type === "start") {
      const tabInfo = await getActiveTabInfo();
      await setRecordingStarted(new Date().toISOString(), tabInfo);
      return sendResponse({ ok: true, status: "recording", site: tabInfo?.origin || tabInfo?.url || null });
    }
    if (message.type === "stop") {
      const startedAtIso = await getStartedAt();
      const ctx = await getStartContext();
      const trace = buildTrace(startedAtIso, ctx);
      const tsName = formatLocalTimestamp(new Date());
      const filename = `traces/${tsName}.json`;
      const res = await downloadJson(trace, filename);
      await clearRecording();
      return sendResponse({ ...res, filename });
    }
    return sendResponse({ ok: false, error: "Unknown type" });
  })();
  return true; // keep the message channel open for async response
});
