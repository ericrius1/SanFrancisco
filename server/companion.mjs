// Companion-app event hub: presence notifications for the iOS companion app
// (and any other subscriber). Deliberately transport-agnostic and portable —
// this module owns everything companion-related so a future backend switch
// only has to re-mount `handleHttp` + call `announceJoin`/`announceLeave`.
//
// Surfaces (all under /companion/, mounted by server.mjs):
//  - GET  /companion/config   → JSON descriptor of this backend (the iOS app
//                               resolves its endpoints from this, never from
//                               hardcoded paths)
//  - GET  /companion/events   → SSE stream: hello (roster), join, leave, ping
//  - POST /companion/register → APNs device-token registration {token}
//  - POST /companion/unregister → remove a token
//
// APNs push is optional: it activates only when APNS_TEAM_ID / APNS_KEY_ID /
// APNS_P8 (or APNS_P8_BASE64) / APNS_TOPIC env vars are set. Without them the
// register endpoint still accepts tokens (returns push:false) and the SSE feed
// carries everything, so the app degrades gracefully.
//
// In-memory only, matching the relay's design: device tokens vanish on restart
// and the app re-registers on every launch.
import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import http2 from "node:http2";

const SSE_MAX_CLIENTS = 64;
const SSE_PING_MS = 25_000;
const REGISTER_MAX_BYTES = 4096;
const TOKEN_MAX = 512;
const TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;
const APNS_JWT_REFRESH_MS = 45 * 60 * 1000; // Apple allows 20-60 min; refresh at 45
const PUSHES_PER_MIN_MAX = 60; // join-storm guard

const escapeSse = (s) => String(s).replace(/(\r\n|\r|\n)/g, " ");

/* ------------------------------------------------------------------- APNs */

// Minimal token-based (p8) APNs sender over node:http2 — no dependencies.
function createApnsSender() {
  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const topic = process.env.APNS_TOPIC; // app bundle id
  let p8 = process.env.APNS_P8 || "";
  if (!p8 && process.env.APNS_P8_BASE64) {
    try {
      p8 = Buffer.from(process.env.APNS_P8_BASE64, "base64").toString("utf8");
    } catch {
      p8 = "";
    }
  }
  p8 = p8.replace(/\\n/g, "\n").trim();
  if (!teamId || !keyId || !topic || !p8.includes("BEGIN PRIVATE KEY")) return null;

  const host =
    (process.env.APNS_ENV || "production") === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";

  let jwt = "";
  let jwtIssuedAt = 0;
  const bearerToken = () => {
    const now = Date.now();
    if (jwt && now - jwtIssuedAt < APNS_JWT_REFRESH_MS) return jwt;
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned = `${b64url({ alg: "ES256", kid: keyId })}.${b64url({
      iss: teamId,
      iat: Math.floor(now / 1000)
    })}`;
    const signature = createSign("SHA256")
      .update(unsigned)
      .sign({ key: p8, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    jwt = `${unsigned}.${signature}`;
    jwtIssuedAt = now;
    return jwt;
  };

  let session = null;
  const getSession = () => {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(host);
    session.on("error", () => {
      session = null;
    });
    session.setTimeout(60_000, () => session?.close());
    return session;
  };

  /** Send one alert push. Resolves "ok" | "drop" (bad token) | "fail". */
  const push = (deviceToken, payload) =>
    new Promise((resolve) => {
      let req;
      try {
        req = getSession().request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${bearerToken()}`,
          "apns-topic": topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + 600)
        });
      } catch {
        resolve("fail");
        return;
      }
      let status = 0;
      let body = "";
      req.setTimeout(10_000, () => req.close());
      req.on("response", (headers) => {
        status = headers[":status"] || 0;
      });
      req.on("data", (chunk) => {
        if (body.length < 1024) body += chunk;
      });
      req.on("end", () => {
        if (status === 200) resolve("ok");
        else if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body))
          resolve("drop");
        else resolve("fail");
      });
      req.on("error", () => resolve("fail"));
      req.end(JSON.stringify(payload));
    });

  return { push, host, topic };
}

/* -------------------------------------------------------------------- hub */

/**
 * @param {{ getPlayers: () => Map<number, {id:number, name:string}>, publicBaseUrl?: string }} opts
 */
export function createCompanionHub(opts) {
  const { getPlayers } = opts;
  const apns = createApnsSender();
  if (apns) console.log(`[companion] APNs push enabled (${apns.host}, topic ${apns.topic})`);

  /** @type {Set<import("node:http").ServerResponse>} */
  const sseClients = new Set();
  /** @type {Map<string, {addedAt: number}>} */
  const deviceTokens = new Map();
  let pushWindowStart = 0;
  let pushesInWindow = 0;

  const roster = () =>
    [...getPlayers().values()].map((p) => ({ id: p.id, name: p.name }));

  const sseSend = (event, data) => {
    if (sseClients.size === 0) return;
    const frame = `event: ${escapeSse(event)}\ndata: ${escapeSse(JSON.stringify(data))}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const pingTimer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  }, SSE_PING_MS);
  pingTimer.unref();

  const pushAll = async (payload) => {
    if (!apns || deviceTokens.size === 0) return;
    const now = Date.now();
    if (now - pushWindowStart > 60_000) {
      pushWindowStart = now;
      pushesInWindow = 0;
    }
    if (pushesInWindow >= PUSHES_PER_MIN_MAX) return;
    pushesInWindow++;
    const results = await Promise.all(
      [...deviceTokens.keys()].map(async (token) => ({ token, r: await apns.push(token, payload) }))
    );
    for (const { token, r } of results) {
      if (r === "drop") deviceTokens.delete(token);
    }
  };

  const announceJoin = (p) => {
    const players = roster();
    sseSend("join", { type: "join", id: p.id, name: p.name, players, ts: Date.now() });
    void pushAll({
      aps: {
        alert: { title: "San Francisco", body: `${p.name} entered the world` },
        sound: "default"
      },
      event: "join",
      name: p.name,
      online: players.length
    });
  };

  const announceLeave = (p) => {
    sseSend("leave", { type: "leave", id: p.id, name: p.name, players: roster(), ts: Date.now() });
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > REGISTER_MAX_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });

  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
  };

  /** Route /companion/* requests. Returns true when handled. */
  const handleHttp = async (req, res, urlPath) => {
    if (urlPath === "/companion/config") {
      // The iOS app treats this (or the copy in the repo's companion/config.json)
      // as the source of truth for where and how to listen — change the backend,
      // update the config, ship no app update.
      json(res, 200, {
        v: 1,
        world: "San Francisco",
        events: { kind: "sse", path: "/companion/events" },
        register: { path: "/companion/register" },
        push: { available: Boolean(apns) }
      });
      return true;
    }
    if (urlPath === "/companion/events") {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET", "cache-control": "no-store" });
        res.end();
        return true;
      }
      if (sseClients.size >= SSE_MAX_CLIENTS) {
        json(res, 503, { ok: false, error: "too many listeners" });
        return true;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      res.write(`event: hello\ndata: ${escapeSse(
        JSON.stringify({ type: "hello", players: roster(), ts: Date.now() })
      )}\n\n`);
      sseClients.add(res);
      const bye = () => sseClients.delete(res);
      res.on("close", bye);
      res.on("error", bye);
      return true;
    }
    if (urlPath === "/companion/register" || urlPath === "/companion/unregister") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "cache-control": "no-store" });
        res.end();
        return true;
      }
      const raw = await readBody(req);
      let msg;
      try {
        msg = JSON.parse(raw ?? "");
      } catch {
        json(res, 400, { ok: false, error: "bad json" });
        return true;
      }
      const token = typeof msg?.token === "string" ? msg.token.trim() : "";
      if (!TOKEN_RE.test(token) || token.length > TOKEN_MAX) {
        json(res, 400, { ok: false, error: "bad token" });
        return true;
      }
      if (urlPath === "/companion/unregister") {
        deviceTokens.delete(token.toLowerCase());
        json(res, 200, { ok: true });
        return true;
      }
      if (deviceTokens.size >= 1000 && !deviceTokens.has(token.toLowerCase())) {
        json(res, 503, { ok: false, error: "registry full" });
        return true;
      }
      deviceTokens.set(token.toLowerCase(), { addedAt: Date.now() });
      json(res, 200, { ok: true, push: Boolean(apns) });
      return true;
    }
    return false;
  };

  return { handleHttp, announceJoin, announceLeave, sseClientCount: () => sseClients.size };
}
