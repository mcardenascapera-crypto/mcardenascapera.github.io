/**
 * analytics-client.js
 * Drop this <script src="analytics-client.js"> into your PWA index.html
 * OR paste the contents into the bottom of your <script> block.
 *
 * Config: set window.ANALYTICS_URL before this script loads, e.g.:
 *   <script>window.ANALYTICS_URL = "https://your-server.com";</script>
 */

(function () {
  const BASE = (window.ANALYTICS_URL || "").replace(/\/$/, "");
  if (!BASE) return;  // analytics disabled if no URL set

  // ── Session ID (persisted across page loads) ──────────────────
  const SESSION_KEY = "eng_kids_session";
  let sessionId = localStorage.getItem(SESSION_KEY);

  async function initSession() {
    if (!sessionId) {
      try {
        const r = await fetch(BASE + "/api/session/new");
        const d = await r.json();
        sessionId = d.session_id;
        localStorage.setItem(SESSION_KEY, sessionId);
      } catch { return; }
    }
  }

  // ── Event queue (batched every 5s to reduce requests) ─────────
  let queue = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 5000);
  }

  async function flush() {
    flushTimer = null;
    if (!sessionId || queue.length === 0) return;
    const batch = queue.splice(0, 50);
    const deviceHint = navigator.userAgent.slice(0, 120);
    try {
      await fetch(BASE + "/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, device_hint: deviceHint, events: batch }),
        // keepalive lets the request finish even if page is closing
        keepalive: true,
      });
    } catch {
      // Silently fail — never block the UI
    }
  }

  // ── Public API ─────────────────────────────────────────────────
  window.track = function (type, extra = {}) {
    queue.push({ type, ts: Date.now(), ...extra });
    scheduleFlush();
  };

  // Flush remaining events when tab closes
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);

  // ── Boot ──────────────────────────────────────────────────────
  initSession().then(() => {
    window.track("session_start");
  });
})();
