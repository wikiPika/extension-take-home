(() => {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");

  startBtn.addEventListener("click", () => {
    status.textContent = "Start clicked (no-op)";
    console.log("Altera Recorder: start clicked");
  });

  stopBtn.addEventListener("click", () => {
    status.textContent = "Stop clicked (no-op)";
    console.log("Altera Recorder: stop clicked");
  });
})();

