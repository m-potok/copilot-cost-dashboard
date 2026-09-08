(function (global) {
  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  global.dashboardApi = {
    getDefaultRoot: () => requestJson("/api/default-root"),
    pickRoot: () => requestJson("/api/pick-root", { method: "POST" }),
    getSessions: (root, signal) =>
      requestJson(`/api/sessions?root=${encodeURIComponent(root)}`, { signal }),
    getSessionsDelta: (root, signal) =>
      requestJson(`/api/sessions-delta?root=${encodeURIComponent(root)}`, { signal }),
    exportExcel: (root, aicValueEuro, signal) =>
      fetch("/api/export-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, aicValueEuro }),
        signal
      })
  };
}(window));
