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
import { readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrotliCompress, createGzip, constants as zlibConstants } from "node:zlib";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 40);
const TICK_HZ = 12; // snapshot broadcast rate
const NAME_MAX = 20;
const CHAT_MAX = 200;
const MSG_MAX_BYTES = 16384; // fits a WebRTC SDP offer (voice signaling); poses are ~100 B
const MSG_BUDGET_PER_SEC = 80; // state at 12 Hz + several simultaneous RTC negotiations; flooders get cut
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // no state for 5 min → drop

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "..", "dist");

/* --------------------------------------------- AI-cars "life" persistence */
// Every AI car is a PERSISTENT INDIVIDUAL that learns forever. The training
// leader (lowest-id client) round-robins one car's full brain+pose per ~1.5 s as
// a `brain` message. We keep the latest blob PER CAR ID in memory AND debounce-
// write the whole set to disk so a fresh leader (or a just-restarted server) can
// resume every individual via the `welcome` message. NOTE: on Railway the disk
// is EPHEMERAL across redeploys — a deploy wipes this file; the fleet then
// rebuilds from whichever connected client still has a localStorage set (or
// fresh). Acceptable.
const DATA_DIR = path.join(ROOT, "data");
const LIFE_FILE = path.join(DATA_DIR, "aicars-life.json");
// Exact param counts for the actor [9,12,2] and critic [9,12,1] nets:
//   actor : 9*12+12 + 12*2+2 = 146      critic : 9*12+12 + 12*1+1 = 133
// Hardcoded (server.mjs is plain JS — can't import the TS constant); blobs of
// any other shape are rejected so a peer can't poison the relayed fleet.
const ACTOR_LEN = 146;
const CRITIC_LEN = 133;
const MAX_CAR_ID = 47; // MAX_CARS 48 → ids 0..47
const W_MAX = 16; // hard weight bound (learner keeps ±8 internally)
const POS_MAX = 1e5; // sane world-coordinate bound (metres)
const CARS_ROW_LEN = 20; // netSync ROW_LEN: 8 header numbers + 12 hidden bytes
const CARS_ROWS_MAX = 56; // MAX_CARS (48) + slack
const LIFE_WRITE_DEBOUNCE_MS = 15000;

const lifeById = new Map(); // carId -> validated blob
let lifeBorn = 0; // epoch ms the persisted world was first born
let lifeWriteTimer = null;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const weightArray = (a, len) => Array.isArray(a) && a.length === len && a.every((n) => finite(n) && Math.abs(n) <= W_MAX);

// Strict per-blob validation (exact array lengths, finiteness, bounded fields).
const validBrain = (b) =>
  b &&
  typeof b === "object" &&
  b.v === 2 &&
  Number.isInteger(b.id) &&
  b.id >= 0 &&
  b.id <= MAX_CAR_ID &&
  weightArray(b.actor, ACTOR_LEN) &&
  weightArray(b.critic, CRITIC_LEN) &&
  finite(b.rhoBar) &&
  Math.abs(b.rhoBar) <= 1e3 &&
  finite(b.sigma) &&
  b.sigma > 0 &&
  b.sigma <= 1 &&
  finite(b.ageS) &&
  b.ageS >= 0 &&
  b.ageS <= 1e12 &&
  finite(b.odoM) &&
  b.odoM >= 0 &&
  b.odoM <= 1e12 &&
  finite(b.lessons) &&
  b.lessons >= 0 &&
  b.lessons <= 1e9 &&
  finite(b.bodyKind) &&
  b.bodyKind >= 0 &&
  b.bodyKind < 256 &&
  finite(b.paintHue) &&
  finite(b.x) &&
  Math.abs(b.x) <= POS_MAX &&
  finite(b.z) &&
  Math.abs(b.z) <= POS_MAX &&
  finite(b.heading);

const loadLife = () => {
  try {
    if (!existsSync(LIFE_FILE)) return;
    const parsed = JSON.parse(readFileSync(LIFE_FILE, "utf8"));
    if (!parsed || parsed.v !== 2 || !Array.isArray(parsed.cars)) return;
    let n = 0;
    for (const b of parsed.cars) if (validBrain(b)) { lifeById.set(b.id, b); n++; }
    lifeBorn = finite(parsed.born) ? parsed.born : Date.now();
    if (n) console.log(`[sf-server] loaded AI-cars life: ${n} cars (born ${new Date(lifeBorn).toISOString()})`);
  } catch (err) {
    console.warn("[sf-server] AI-cars life load failed:", err.message);
  }
};

const scheduleLifeWrite = () => {
  if (lifeWriteTimer) return; // already pending: coalesce
  lifeWriteTimer = setTimeout(async () => {
    lifeWriteTimer = null;
    if (lifeById.size === 0) return;
    try {
      await mkdir(DATA_DIR, { recursive: true });
      // atomic write: fully write a temp file, then rename over the target so a
      // crash mid-write can never leave a truncated / corrupt life file.
      const tmp = LIFE_FILE + ".tmp";
      await writeFile(tmp, JSON.stringify({ v: 2, born: lifeBorn || Date.now(), cars: [...lifeById.values()] }));
      await rename(tmp, LIFE_FILE);
    } catch (err) {
      console.warn("[sf-server] AI-cars life write failed:", err.message);
    }
  }, LIFE_WRITE_DEBOUNCE_MS);
  lifeWriteTimer.unref?.();
};

/** The current training leader = lowest connected id (cheap leader auth). */
const leaderId = () => {
  let min = Infinity;
  for (const pid of players.keys()) if (pid < min) min = pid;
  return min;
};

loadLife();

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

const COMPRESSIBLE_DYNAMIC = new Set([".html", ".js", ".css", ".json", ".bin", ".svg"]);
const WORLD_ASSET_PREFIXES = ["/data/", "/tiles/", "/models/", "/seedthree/", "/buildinggen/", "/citygen/", "/audio/"];

const acceptsEncoding = (req, token) => String(req.headers["accept-encoding"] ?? "").includes(token);
const weakEtag = (st) => `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
const cacheControlFor = (urlPath) => {
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (WORLD_ASSET_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) {
    return "public, max-age=3600, stale-while-revalidate=604800";
  }
  return "no-cache";
};

async function compressedVariant(req, filePath, ext, st) {
  if (acceptsEncoding(req, "br")) {
    const brPath = `${filePath}.br`;
    const br = await stat(brPath).catch(() => null);
    if (br?.isFile()) return { path: brPath, stat: br, encoding: "br", dynamic: null };
  }
  if (acceptsEncoding(req, "gzip")) {
    const gzPath = `${filePath}.gz`;
    const gz = await stat(gzPath).catch(() => null);
    if (gz?.isFile()) return { path: gzPath, stat: gz, encoding: "gzip", dynamic: null };
  }
  if (st.size < 1024 || !COMPRESSIBLE_DYNAMIC.has(ext)) {
    return { path: filePath, stat: st, encoding: null, dynamic: null };
  }
  if (acceptsEncoding(req, "br")) {
    return {
      path: filePath,
      stat: st,
      encoding: "br",
      dynamic: createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 4
        }
      })
    };
  }
  if (acceptsEncoding(req, "gzip")) {
    return { path: filePath, stat: st, encoding: "gzip", dynamic: createGzip({ level: 6 }) };
  }
  return { path: filePath, stat: st, encoding: null, dynamic: null };
}

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
    const etag = weakEtag(st);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, {
        "cache-control": cacheControlFor(urlPath),
        "etag": etag
      });
      res.end();
      return;
    }
    const body = await compressedVariant(req, filePath, ext, st);
    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": cacheControlFor(urlPath),
      "etag": etag,
      "last-modified": st.mtime.toUTCString(),
      "vary": "Accept-Encoding"
    };
    if (!body.dynamic) headers["content-length"] = body.stat.size;
    if (body.encoding) headers["content-encoding"] = body.encoding;
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(body.path);
    if (body.dynamic) stream.pipe(body.dynamic).pipe(res);
    else stream.pipe(res);
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
          .map((o) => ({ id: o.id, name: o.name, hue: o.hue, avatar: o.avatar })),
        // hand the whole saved AI-cars fleet to the newcomer so a future leader
        // resumes every individual's accumulated learning instead of fresh
        ...(lifeById.size ? { aicarsLife: { v: 2, born: lifeBorn || Date.now(), cars: [...lifeById.values()] } } : {})
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
    } else if (msg.t === "cars" && Array.isArray(msg.d) && msg.d.length >= 1 && msg.d.length <= CARS_ROWS_MAX) {
      // AI-cars snapshot from the training leader: rows [slot,kind,hue,x,y,z,
      // heading,speed, ...12 hidden bytes] — pure relay, ghosts interpolate
      if (msg.d.every((r) => Array.isArray(r) && r.length === CARS_ROW_LEN && r.every((n) => typeof n === "number" && Number.isFinite(n)))) {
        broadcast({ t: "cars", id, d: msg.d }, id);
      }
    } else if (msg.t === "brain") {
      // One AI car's brain+pose from the training leader. ONLY accept it from the
      // current lowest-id connected client (cheap leader auth — the server knows
      // every id) and only if it passes the strict per-blob validator. Store the
      // latest per car id, debounce-persist the set, and relay to everyone else
      // (non-leaders cache it for a future promotion).
      if (id === leaderId() && validBrain(msg.d)) {
        if (lifeById.size === 0 && !lifeBorn) lifeBorn = Date.now();
        lifeById.set(msg.d.id, msg.d);
        scheduleLifeWrite();
        broadcast({ t: "brain", from: id, d: msg.d }, id);
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
    } else if (msg.t === "chat" && typeof msg.text === "string") {
      // ephemeral text chat — strip controls, cap length, stamp name from roster
      // (never trust the client's claimed name). No persistence across reconnects.
      const text = String(msg.text)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, CHAT_MAX);
      if (text) broadcast({ t: "chat", id, name: p.name, text }, id);
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
// instead of killing the host process. `ws` re-emits the HTTP server's
// `error` onto the WebSocketServer — without a listener there, Node treats it
// as unhandled and crashes the whole Vite process.
const onListenError = (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[sf-server] port ${PORT} already in use — assuming a relay is already running`);
  } else {
    console.error("[sf-server]", err);
  }
};
server.on("error", onListenError);
wss.on("error", onListenError);

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
