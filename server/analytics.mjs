import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_VISITS = 2000;
const DEFAULT_ACTIVE_MS = 45_000;
const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 8192;

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const MAX_VISITS = toPositiveInt(process.env.ANALYTICS_MAX_VISITS, DEFAULT_MAX_VISITS);
const ACTIVE_MS = toPositiveInt(process.env.ANALYTICS_ACTIVE_MS, DEFAULT_ACTIVE_MS);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || "";

const cleanText = (value, max = 220) =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, max);

const cleanId = (value) => {
  const s = cleanText(value, 100);
  return /^[A-Za-z0-9_.:-]{6,100}$/.test(s) ? s : "";
};

const safeTime = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const durationFor = (visit, now) => {
  const end = visit.endedAt || (now - visit.lastSeenAt <= ACTIVE_MS ? now : visit.lastSeenAt);
  return Math.max(0, end - visit.startedAt);
};

const isActive = (visit, now) => !visit.endedAt && now - visit.lastSeenAt <= ACTIVE_MS;

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

const sendJson = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
};

const sendText = (res, status, body, contentType) => {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
};

const adminHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>San Francisco Analytics</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7f8;
        --panel: #ffffff;
        --text: #162127;
        --muted: #60727c;
        --line: #d8e0e4;
        --accent: #0f766e;
        --accent-soft: #d7f1ed;
        --warn: #9a5a00;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      h1 {
        margin: 0 0 4px;
        font-size: clamp(24px, 4vw, 34px);
        line-height: 1.05;
        letter-spacing: 0;
      }
      .sub {
        color: var(--muted);
        font-size: 14px;
      }
      button {
        border: 1px solid #0d5f59;
        background: var(--accent);
        color: #fff;
        border-radius: 6px;
        padding: 10px 14px;
        font: 700 14px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.65;
        cursor: wait;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(5, minmax(130px, 1fr));
        gap: 10px;
        margin: 0 0 18px;
      }
      .metric {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 13px 14px;
      }
      .metric .label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .metric .value {
        margin-top: 7px;
        font-size: 25px;
        line-height: 1.1;
        font-weight: 800;
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      table {
        width: 100%;
        min-width: 900px;
        border-collapse: collapse;
      }
      th, td {
        padding: 11px 12px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        font-size: 13px;
      }
      th {
        color: var(--muted);
        background: #eef3f5;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      tr:last-child td { border-bottom: 0; }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 700;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #9aa8ae;
      }
      .status.active .dot { background: #16803d; }
      .status.stale .dot { background: var(--warn); }
      .muted { color: var(--muted); }
      .empty {
        padding: 22px;
        color: var(--muted);
      }
      @media (max-width: 760px) {
        main { width: min(100vw - 20px, 1180px); padding-top: 18px; }
        header { align-items: stretch; flex-direction: column; }
        button { width: 100%; }
        .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Analytics</h1>
          <div class="sub" id="updated">Loading...</div>
        </div>
        <button id="refresh" type="button">Refresh</button>
      </header>
      <section class="metrics" aria-label="Summary">
        <div class="metric"><div class="label">Total visits</div><div class="value" id="m-visits">-</div></div>
        <div class="metric"><div class="label">Visitors</div><div class="value" id="m-visitors">-</div></div>
        <div class="metric"><div class="label">Active now</div><div class="value" id="m-active">-</div></div>
        <div class="metric"><div class="label">Last 24h</div><div class="value" id="m-24h">-</div></div>
        <div class="metric"><div class="label">Avg stay</div><div class="value" id="m-avg">-</div></div>
      </section>
      <section class="table-wrap" aria-label="Visits">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Visitor</th>
              <th>Started</th>
              <th>Last seen</th>
              <th>Stayed</th>
              <th>Path</th>
              <th>Device</th>
              <th>Referrer</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="empty" hidden>No visits tracked yet.</div>
      </section>
    </main>
    <script>
      const ids = ["m-visits", "m-visitors", "m-active", "m-24h", "m-avg"];
      const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
      const rows = document.getElementById("rows");
      const empty = document.getElementById("empty");
      const updated = document.getElementById("updated");
      const refresh = document.getElementById("refresh");

      const fmtInt = (n) => new Intl.NumberFormat().format(n || 0);
      const fmtTime = (iso) => iso ? new Date(iso).toLocaleString() : "-";
      const fmtDuration = (ms) => {
        const total = Math.max(0, Math.round((ms || 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h) return h + "h " + String(m).padStart(2, "0") + "m";
        if (m) return m + "m " + String(s).padStart(2, "0") + "s";
        return s + "s";
      };
      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[ch]);

      const statusHtml = (visit) => {
        const cls = visit.active ? "active" : (visit.endedAt ? "" : "stale");
        const label = visit.active ? "Active" : (visit.endedAt ? "Ended" : "Stale");
        return '<span class="status ' + cls + '"><span class="dot"></span>' + label + '</span>';
      };

      async function load() {
        refresh.disabled = true;
        try {
          const res = await fetch("/api/analytics/summary", { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          els["m-visits"].textContent = fmtInt(data.totals.totalVisits);
          els["m-visitors"].textContent = fmtInt(data.totals.uniqueVisitors);
          els["m-active"].textContent = fmtInt(data.totals.activeVisits);
          els["m-24h"].textContent = fmtInt(data.totals.visitsLast24h);
          els["m-avg"].textContent = fmtDuration(data.totals.averageDurationMs);
          updated.textContent = "Updated " + fmtTime(data.generatedAt) + " - " + data.tracking.storage;

          rows.innerHTML = data.visits.map((visit) => '<tr>' +
            '<td>' + statusHtml(visit) + '</td>' +
            '<td class="mono">' + esc(visit.visitorShortId) + '</td>' +
            '<td>' + fmtTime(visit.startedAt) + '</td>' +
            '<td>' + fmtTime(visit.lastSeenAt) + '</td>' +
            '<td><strong>' + fmtDuration(visit.durationMs) + '</strong></td>' +
            '<td class="mono">' + esc(visit.path || "/") + '</td>' +
            '<td>' + esc(visit.device || "") + '<div class="muted">' + esc(visit.viewport || "") + '</div></td>' +
            '<td class="muted">' + esc(visit.referrer || "-") + '</td>' +
          '</tr>').join("");
          empty.hidden = data.visits.length > 0;
        } catch (err) {
          updated.textContent = "Failed to load analytics: " + err.message;
        } finally {
          refresh.disabled = false;
        }
      }

      refresh.addEventListener("click", load);
      load();
      setInterval(load, 10000);
    </script>
  </body>
</html>`;

export const createAnalytics = (rootDir) => {
  const dataDir =
    process.env.ANALYTICS_DIR ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "analytics")
      : path.join(rootDir, "..", ".data"));
  const dataFile = path.join(dataDir, "analytics.json");
  const storageLabel = process.env.ANALYTICS_DIR
    ? "file storage from ANALYTICS_DIR"
    : process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? "file storage on Railway volume"
      : "local file storage";

  /** @type {Map<string, any>} */
  const visits = new Map();
  let flushTimer = null;
  let flushing = false;
  let flushAgain = false;

  const loadPromise = (async () => {
    try {
      const raw = await readFile(dataFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.schema !== SCHEMA_VERSION || !Array.isArray(parsed.visits)) return;
      for (const rawVisit of parsed.visits) {
        const id = cleanId(rawVisit.id);
        const visitorId = cleanId(rawVisit.visitorId);
        if (!id || !visitorId) continue;
        const now = Date.now();
        const startedAt = safeTime(rawVisit.startedAt, now);
        const lastSeenAt = safeTime(rawVisit.lastSeenAt, startedAt);
        const endedAt = rawVisit.endedAt ? safeTime(rawVisit.endedAt, lastSeenAt) : null;
        visits.set(id, {
          id,
          visitorId,
          path: cleanText(rawVisit.path, 300) || "/",
          referrer: cleanText(rawVisit.referrer, 500),
          title: cleanText(rawVisit.title, 160),
          userAgent: cleanText(rawVisit.userAgent, 500),
          language: cleanText(rawVisit.language, 32),
          timezone: cleanText(rawVisit.timezone, 80),
          viewport: cleanText(rawVisit.viewport, 40),
          screen: cleanText(rawVisit.screen, 40),
          startedAt,
          lastSeenAt,
          endedAt,
          heartbeats: Number.isInteger(rawVisit.heartbeats) ? rawVisit.heartbeats : 0
        });
      }
    } catch (err) {
      if (err?.code !== "ENOENT") console.warn("[sf-analytics] reset unreadable analytics store:", err.message);
    }
  })();

  const compactVisits = () => {
    if (visits.size <= MAX_VISITS) return;
    const newest = [...visits.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_VISITS);
    visits.clear();
    for (const visit of newest) visits.set(visit.id, visit);
  };

  const writeSnapshot = async () => {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      await mkdir(dataDir, { recursive: true });
      compactVisits();
      const body = JSON.stringify(
        {
          schema: SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          visits: [...visits.values()].sort((a, b) => b.startedAt - a.startedAt)
        },
        null,
        2
      );
      const tmpFile = `${dataFile}.tmp`;
      await writeFile(tmpFile, body);
      await rename(tmpFile, dataFile);
    } catch (err) {
      console.warn("[sf-analytics] failed to write analytics store:", err.message);
    } finally {
      flushing = false;
      if (flushAgain) {
        flushAgain = false;
        scheduleFlush();
      }
    }
  };

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void writeSnapshot();
    }, 1000);
    flushTimer.unref?.();
  }

  const flush = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await writeSnapshot();
  };

  const recordStart = (payload) => {
    const now = Date.now();
    const id = cleanId(payload.visitId) || randomUUID();
    const visitorId = cleanId(payload.visitorId) || randomUUID();
    const visit = {
      id,
      visitorId,
      path: cleanText(payload.path, 300) || "/",
      referrer: cleanText(payload.referrer, 500),
      title: cleanText(payload.title, 160),
      userAgent: cleanText(payload.userAgent, 500),
      language: cleanText(payload.language, 32),
      timezone: cleanText(payload.timezone, 80),
      viewport: cleanText(payload.viewport, 40),
      screen: cleanText(payload.screen, 40),
      startedAt: now,
      lastSeenAt: now,
      endedAt: null,
      heartbeats: 0
    };
    visits.set(id, visit);
    compactVisits();
    scheduleFlush();
    return visit;
  };

  const recordPing = (payload, end = false) => {
    const id = cleanId(payload.visitId);
    if (!id) return null;
    const visit = visits.get(id);
    if (!visit) return null;
    const now = Date.now();
    visit.lastSeenAt = now;
    visit.heartbeats += 1;
    if (end) visit.endedAt = now;
    scheduleFlush();
    return visit;
  };

  const snapshot = () => {
    const now = Date.now();
    const all = [...visits.values()].sort((a, b) => b.startedAt - a.startedAt);
    const visitsWithDuration = all.map((visit) => {
      const active = isActive(visit, now);
      const durationMs = durationFor(visit, now);
      return {
        id: visit.id,
        visitorShortId: visit.visitorId.slice(0, 8),
        startedAt: new Date(visit.startedAt).toISOString(),
        lastSeenAt: new Date(visit.lastSeenAt).toISOString(),
        endedAt: visit.endedAt ? new Date(visit.endedAt).toISOString() : null,
        active,
        durationMs,
        path: visit.path,
        referrer: visit.referrer,
        device: visit.userAgent ? visit.userAgent.replace(/\s+/g, " ").slice(0, 90) : "",
        viewport: visit.viewport,
        heartbeats: visit.heartbeats
      };
    });
    const completedDurations = visitsWithDuration
      .filter((visit) => visit.endedAt || !visit.active)
      .map((visit) => visit.durationMs);
    const avg =
      completedDurations.length > 0
        ? completedDurations.reduce((sum, ms) => sum + ms, 0) / completedDurations.length
        : 0;

    return {
      generatedAt: new Date(now).toISOString(),
      tracking: {
        activeWindowMs: ACTIVE_MS,
        heartbeatMs: HEARTBEAT_MS,
        maxVisits: MAX_VISITS,
        storage: storageLabel
      },
      totals: {
        totalVisits: visitsWithDuration.length,
        uniqueVisitors: new Set(all.map((visit) => visit.visitorId)).size,
        activeVisits: visitsWithDuration.filter((visit) => visit.active).length,
        visitsLast24h: all.filter((visit) => now - visit.startedAt <= 24 * 60 * 60 * 1000).length,
        averageDurationMs: Math.round(avg)
      },
      visits: visitsWithDuration.slice(0, 250)
    };
  };

  const authorized = (req) => {
    if (!ADMIN_PASSWORD) return true;
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Basic ")) return false;
    try {
      const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep < 0) return false;
      return decoded.slice(0, sep) === ADMIN_USER && decoded.slice(sep + 1) === ADMIN_PASSWORD;
    } catch {
      return false;
    }
  };

  const requireAdmin = (req, res) => {
    if (authorized(req)) return true;
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="San Francisco Analytics"',
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end("Authentication required");
    return false;
  };

  const routes = new Set([
    "/admin_view",
    "/api/analytics/start",
    "/api/analytics/heartbeat",
    "/api/analytics/end",
    "/api/analytics/summary"
  ]);

  const isRoute = (urlPath) => routes.has(urlPath);

  const handle = async (req, res, urlPath) => {
    await loadPromise;

    if (urlPath === "/admin_view" && (req.method === "GET" || req.method === "HEAD")) {
      if (!requireAdmin(req, res)) return true;
      sendText(res, 200, req.method === "HEAD" ? "" : adminHtml, "text/html; charset=utf-8");
      return true;
    }

    if (urlPath === "/api/analytics/summary" && req.method === "GET") {
      if (!requireAdmin(req, res)) return true;
      sendJson(res, 200, snapshot());
      return true;
    }

    if (!urlPath.startsWith("/api/analytics/")) return false;
    if (req.method !== "POST") {
      res.writeHead(405, { "allow": "POST" });
      res.end();
      return true;
    }

    try {
      const payload = await readJsonBody(req);
      if (urlPath === "/api/analytics/start") {
        recordStart(payload);
      } else if (urlPath === "/api/analytics/heartbeat") {
        recordPing(payload, false);
      } else if (urlPath === "/api/analytics/end") {
        recordPing(payload, true);
      } else {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
    } catch {
      sendJson(res, 400, { error: "invalid analytics payload" });
    }
    return true;
  };

  return { isRoute, handle, flush, snapshot };
};
