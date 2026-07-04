// San Francisco multiplayer server: a single-room WebSocket presence relay +
// static file host for the built game (dist/).
//
// Design (matches the client in src/net/):
//  - Anyone can join, no accounts. The server assigns an id + a color hue.
//  - Clients own their physics (box3d runs in each browser); the server only
//    relays transforms. That makes it cheap, cheat-tolerant-by-design (this is
//    a co-op sandbox, nothing competitive to protect), and stateless.
//  - Clients send state at ~12 Hz; the server rebroadcasts one batched
//    snapshot per tick (12 Hz) with a server timestamp the clients use for
//    interpolation buffering.
//  - In-memory only: restart = empty world, players just reconnect.
//
// Run: node server/server.mjs            (PORT / HOST env to override)
// Prod: npm run build && node server/server.mjs  → serves dist/ + /ws
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 40);
const TICK_HZ = 12; // snapshot broadcast rate
const NAME_MAX = 20;
const MSG_MAX_BYTES = 16384; // fits a WebRTC SDP offer (voice signaling); poses are ~100 B
const MSG_BUDGET_PER_SEC = 80; // state at 12 Hz + several simultaneous RTC negotiations; flooders get cut
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // no state for 5 min → drop

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "..", "dist");

const getUrlPath = (url = "/") => {
  try {
    return decodeURIComponent(url.split("?")[0]).replace(/\/{2,}/g, "/") || "/";
  } catch {
    return "/";
  }
};

/* ------------------------------------------------------------- static host */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const server = http.createServer(async (req, res) => {
  const urlPath = getUrlPath(req.url);

  if (urlPath === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: players.size }));
    return;
  }
  if (!existsSync(DIST)) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("No dist/ build found — run `npm run build`. (WebSocket endpoint /ws is live.)");
    return;
  }
  // static files from dist/, path-traversal safe, SPA-less (one page)
  let filePath = path.normalize(path.join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    let st = await stat(filePath).catch(() => null);
    if (st?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      st = await stat(filePath).catch(() => null);
    }
    if (!st) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // content-hashed assets cache forever; html/data revalidate
    const immutable = urlPath.startsWith("/assets/");
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache"
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500);
    res.end();
  }
});

/* --------------------------------------------------------------- ws relay */

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MSG_MAX_BYTES });

let nextId = 1;
/** id -> { ws, id, name, hue, alive, budget, lastState, state: [mode,x,y,z,qx,qy,qz,qw,speed] | null } */
const players = new Map();

const ADJ = [
  "Foggy",
  "Golden",
  "Sunny",
  "Salty",
  "Breezy",
  "Misty",
  "Neon",
  "Mellow",
  "Turbo",
  "Lucky",
  "Cosmic",
  "Pacific",
  "Sparkly",
  "Painted",
  "Wiggly",
  "Zippy"
];
const NOUN = [
  "Otter",
  "Pelican",
  "Sea Lion",
  "Gull",
  "Coyote",
  "Crab",
  "Surfer",
  "Sourdough",
  "Redwood",
  "Cable Car",
  "Fog Horn",
  "Bison",
  "Skater",
  "Firework",
  "Trolley",
  "Sea Star"
];
const FUN_NAME_FALLBACK = /^[\p{N}\s._\-'.]+$/u;
const AVATAR_HATS = ["none", "cap", "beanie", "visor", "crown"];
const AVATAR_HAIR = ["short", "bob", "mohawk", "buzz", "long"];
const AVATAR_OUTFITS = ["jacket", "hoodie", "tee", "overalls", "dress"];
const SKIN_COUNT = 6;
const COLOR_COUNT = 8;

const makeFunName = () => `${ADJ[(Math.random() * ADJ.length) | 0]} ${NOUN[(Math.random() * NOUN.length) | 0]}`;

const needsFunName = (name) => name.length === 0 || name.length < 3 || FUN_NAME_FALLBACK.test(name);

const sanitizeName = (raw) => {
  const s = String(raw ?? "")
    .replace(/[^\p{L}\p{N} _\-'.]/gu, "")
    .trim()
    .slice(0, NAME_MAX);
  return needsFunName(s) ? makeFunName() : s;
};

const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);
const intRange = (value, max, fallback) => (Number.isInteger(value) && value >= 0 && value < max ? value : fallback);
const DEFAULT_AVATAR = { skin: 1, hair: "short", hat: "cap", outfit: "jacket", color: 0, accent: 3 };

const hashSeed = (seed) => {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const lcg = (seed) => {
  let s = seed || 0x9e3779b9;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
};

const pick = (items, roll) => items[Math.floor(roll() * items.length) % items.length];

const avatarFromSeed = (seed) => {
  const roll = lcg(hashSeed(seed));
  const color = Math.floor(roll() * COLOR_COUNT) % COLOR_COUNT;
  let accent = Math.floor(roll() * COLOR_COUNT) % COLOR_COUNT;
  if (accent === color) accent = (accent + 3) % COLOR_COUNT;
  return {
    skin: Math.floor(roll() * SKIN_COUNT) % SKIN_COUNT,
    hair: pick(AVATAR_HAIR, roll),
    hat: pick(AVATAR_HATS, roll),
    outfit: pick(AVATAR_OUTFITS, roll),
    color,
    accent
  };
};

const avatarKey = (traits) =>
  `${traits.skin}|${traits.hair}|${traits.hat}|${traits.outfit}|${traits.color}|${traits.accent}`;

const isDefaultAvatar = (traits) => avatarKey(traits) === avatarKey(DEFAULT_AVATAR);

const sanitizeAvatar = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  return {
    skin: intRange(raw.skin, SKIN_COUNT, DEFAULT_AVATAR.skin),
    hair: oneOf(raw.hair, AVATAR_HAIR, DEFAULT_AVATAR.hair),
    hat: oneOf(raw.hat, AVATAR_HATS, DEFAULT_AVATAR.hat),
    outfit: oneOf(raw.outfit, AVATAR_OUTFITS, DEFAULT_AVATAR.outfit),
    color: intRange(raw.color, COLOR_COUNT, DEFAULT_AVATAR.color),
    accent: intRange(raw.accent, COLOR_COUNT, DEFAULT_AVATAR.accent)
  };
};

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

const broadcast = (obj, exceptId = 0) => {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
};

wss.on("connection", (ws) => {
  if (players.size >= MAX_PLAYERS) {
    send(ws, { t: "full" });
    ws.close(1013, "server full"); // 1013 = try again later
    return;
  }
  const id = nextId++;
  // golden-angle hue spacing: consecutive joiners get maximally distinct colors
  const p = {
    ws,
    id,
    name: makeFunName(),
    hue: Math.round((id * 137.508) % 360),
    avatar: avatarFromSeed(id),
    alive: true,
    budget: MSG_BUDGET_PER_SEC,
    lastState: Date.now(),
    state: null
  };
  players.set(id, p);

  ws.on("pong", () => (p.alive = true));

  ws.on("message", (buf) => {
    if (--p.budget < 0) return; // over rate budget: drop silently, refilled each second
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.t === "hi") {
      p.name = sanitizeName(msg.name);
      const custom = sanitizeAvatar(msg.avatar);
      if (custom && !isDefaultAvatar(custom)) p.avatar = custom;
      send(ws, {
        t: "welcome",
        id,
        hue: p.hue,
        name: p.name,
        players: [...players.values()]
          .filter((o) => o.id !== id)
          .map((o) => ({ id: o.id, name: o.name, hue: o.hue, avatar: o.avatar }))
      });
      broadcast({ t: "join", id, name: p.name, hue: p.hue, avatar: p.avatar }, id);
      console.log(`[sf-server] join #${id} "${p.name}" (${players.size} online)`);
    } else if (msg.t === "s" && Array.isArray(msg.d) && (msg.d.length === 9 || msg.d.length === 10)) {
      // [modeIndex, x, y, z, qx, qy, qz, qw, speed, ride?] — validate finite numbers
      if (msg.d.every((n) => typeof n === "number" && Number.isFinite(n))) {
        p.state = msg.d;
        p.lastState = Date.now();
      }
    } else if (msg.t === "name") {
      p.name = sanitizeName(msg.name);
      broadcast({ t: "name", id, name: p.name }, id);
    } else if (msg.t === "avatar") {
      // mirror the "hi" guard: a cleared/default avatar falls back to the per-id
      // seed, never to null — so a player can never blank out into the default look
      const custom = sanitizeAvatar(msg.avatar);
      p.avatar = custom && !isDefaultAvatar(custom) ? custom : avatarFromSeed(id);
      broadcast({ t: "avatar", id, avatar: p.avatar }, id);
    } else if (msg.t === "paint" && Array.isArray(msg.d) && msg.d.length === 7) {
      // paintball shot: [x,y,z,vx,vy,vz,rgb] — pure relay, every client
      // simulates the flight and splats locally
      if (msg.d.every((n) => typeof n === "number" && Number.isFinite(n))) {
        broadcast({ t: "paint", id, d: msg.d }, id);
      }
    } else if (msg.t === "fw" && Array.isArray(msg.d) && msg.d.length >= 1 && msg.d.length <= 64) {
      // fireworks volley: rows [ox,oy,oz,tx,ty,tz,flightTime,palette,size] —
      // pure relay, every client replays the launches locally
      if (msg.d.every((r) => Array.isArray(r) && r.length === 9 && r.every((n) => typeof n === "number" && Number.isFinite(n)))) {
        broadcast({ t: "fw", id, d: msg.d }, id);
      }
    } else if (msg.t === "note" && Array.isArray(msg.d) && msg.d.length === 2) {
      // museum instrument note: [instrument, key] — pure relay, every client
      // renders the flash/dome ripple and synthesizes the tone locally
      if (msg.d.every((n) => Number.isInteger(n) && n >= 0 && n < 16)) {
        broadcast({ t: "note", id, d: msg.d }, id);
      }
    } else if (msg.t === "rtc" && typeof msg.to === "number") {
      // voice-chat signaling (SDP offers/answers + ICE candidates): targeted
      // relay to one peer, sender id stamped server-side so it can't be forged
      const target = players.get(msg.to);
      if (target) send(target.ws, { t: "rtc", from: id, payload: msg.payload });
    }
  });

  const drop = () => {
    if (!players.has(id)) return;
    players.delete(id);
    broadcast({ t: "leave", id });
    console.log(`[sf-server] leave #${id} (${players.size} online)`);
  };
  ws.on("close", drop);
  ws.on("error", drop);
});

// snapshot tick: one batched packet with everyone's latest state
setInterval(() => {
  if (players.size === 0) return;
  const ps = [];
  for (const p of players.values()) {
    if (p.state) ps.push([p.id, ...p.state]);
  }
  if (ps.length === 0) return;
  broadcast({ t: "snap", ts: Date.now(), ps });
}, 1000 / TICK_HZ);

// rate-budget refill (1 s cadence)
setInterval(() => {
  for (const p of players.values()) p.budget = MSG_BUDGET_PER_SEC;
}, 1000);

// heartbeat: ping every 15 s, drop sockets that missed a pong or idled out
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (now - p.lastState > IDLE_TIMEOUT_MS || !p.alive) {
      p.ws.terminate(); // close event handles cleanup + broadcast
      continue;
    }
    p.alive = false;
    p.ws.ping();
  }
}, 15000);

// vite's relay plugin imports this file at dev boot; if another relay already
// owns the port (second vite, manual `npm run server`), warn and stand down
// instead of killing the host process
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[sf-server] port ${PORT} already in use — assuming a relay is already running`);
  } else {
    console.error("[sf-server]", err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[sf-server] http://${HOST}:${PORT}  (ws: /ws, static: ${existsSync(DIST) ? "dist/" : "none — dev mode"})`);
});

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[sf-server] ${sig} — closing`);
    for (const p of players.values()) p.ws.close(1001, "server shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
