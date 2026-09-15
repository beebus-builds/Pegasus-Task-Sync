// Pegasus Free Logger - background service worker
// Does the Apps Script POST from extension origin (host_permissions bypass CORS).
// Content script origin is pegasus.pairlab.ai, so direct fetch fails with
// "Failed to fetch" on the script.google.com -> script.googleusercontent.com redirect.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "PFL_PROXY_POST") {
      try {
        const res = await fetch(msg.url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(msg.payload),
          redirect: "follow"
        });
        const text = await res.text().catch(() => "");
        sendResponse({ ok: res.ok, status: res.status, body: text.slice(0, 1000) });
      } catch (e) {
        sendResponse({ ok: false, status: 0, body: "fetch failed: " + String(e && e.message || e) });
      }
    } else if (msg && msg.type === "PFL_BADGE_UPDATE") {
      const count = Number(msg.count) || 0;
      const text = count > 99 ? "99+" : String(count);
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color: "#111827" });
      chrome.action.setTitle({ title: `My Tasks: ${count}` });
      sendResponse({ ok: true });
    }
  })();
  return true;
});
