// Lightweight visit analytics: POSTs start / heartbeat (15s) / end to
// /api/analytics/*. Skipped on the admin dashboard and for headless automation
// (navigator.webdriver) so demo and CI runs don't register as visits.
const HEARTBEAT_MS = 15_000;
const VISITOR_KEY = "sf.analytics.visitorId";

if (location.pathname !== "/admin_view" && !navigator.webdriver) {
  const randomId = () => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return `${Date.now()}.${Math.random().toString(36).slice(2)}`;
  };

  const visitorId = (() => {
    try {
      let id = localStorage.getItem(VISITOR_KEY);
      if (!id) {
        id = randomId();
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch {
      return randomId();
    }
  })();

  const visitId = randomId();
  const startedAt = Date.now();
  let closed = false;

  const basePayload = () => ({
    visitId,
    visitorId,
    path: location.pathname + location.search,
    referrer: document.referrer,
    title: document.title,
    startedAt,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: window.screen ? `${window.screen.width}x${window.screen.height}` : "",
    userAgent: navigator.userAgent
  });

  const post = (type: "start" | "heartbeat" | "end", payload: Record<string, unknown>, keepalive = false) => {
    const body = JSON.stringify(payload);
    const url = `/api/analytics/${type}`;
    if (keepalive && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive
    }).catch(() => {});
  };

  post("start", basePayload());

  const heartbeat = (keepalive = false) => {
    if (closed) return;
    post("heartbeat", { visitId, visitorId, at: Date.now() }, keepalive);
  };

  const timer = window.setInterval(heartbeat, HEARTBEAT_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") heartbeat(true);
  });

  window.addEventListener("pagehide", () => {
    if (closed) return;
    closed = true;
    window.clearInterval(timer);
    post("end", { visitId, visitorId, at: Date.now() }, true);
  });
}
