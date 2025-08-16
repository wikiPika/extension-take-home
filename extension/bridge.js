// Bridge page window.postMessage events to the extension
(function () {
  try {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || !data.__altera) return;
      try { chrome.runtime.sendMessage({ type: 'replayProgress', payload: data }); } catch {}
    });
  } catch {}
})();

