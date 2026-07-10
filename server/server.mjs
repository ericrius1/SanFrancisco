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

// hoverboard customization — mirrors src/vehicles/board/config.ts (lists,
// defaults, AND the seed draw order are part of the wire contract)
const BOARD_SHAPES = ["classic", "dart", "manta", "saucer", "twintip"];
const BOARD_FINS = ["none", "twin", "spoiler", "halo"];
const BOARD_SURFACES = ["aurora", "topo", "terrazzo", "circuit", "plasma"];
const BOARD_SURFACE_EFFECTS = ["clean", "grain", "scanlines", "prism"];
const BOARD_HUMS = ["hum", "crystal", "deep", "choir", "retro"];
const BOARD_DECK_COUNT = 8;
const BOARD_GLOW_COUNT = 8;
const BOARD_PITCH_COUNT = 5;

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

const DEFAULT_BOARD = {
  shape: "classic",
  fin: "none",
  deck: 0,
  trim: 5,
  glow: 0,
  surface: "aurora",
  surfaceScale: 52,
  surfaceWarp: 58,
  surfaceSeed: 1847,
  surfaceContrast: 58,
  surfaceEffect: "grain",
  surfaceEffectAmount: 28,
  surfaceFlow: 24,
  surfaceReaction: 52,
  hum: "hum",
  pitch: 0,
  soundTone: 50,
  soundMotion: 50
};

// identical algorithm + draw order to boardFromSeed in src/vehicles/board/config.ts
const boardFromSeed = (seed) => {
  const roll = lcg(hashSeed(seed));
  const deck = Math.floor(roll() * BOARD_DECK_COUNT) % BOARD_DECK_COUNT;
  let trim = Math.floor(roll() * BOARD_DECK_COUNT) % BOARD_DECK_COUNT;
  if (trim === deck) trim = (trim + 3) % BOARD_DECK_COUNT;
  return {
    deck,
    trim,
    glow: Math.floor(roll() * BOARD_GLOW_COUNT) % BOARD_GLOW_COUNT,
    shape: pick(BOARD_SHAPES, roll),
    fin: pick(BOARD_FINS, roll),
    surface: pick(BOARD_SURFACES, roll),
    surfaceScale: 22 + Math.floor(roll() * 67),
    surfaceWarp: 18 + Math.floor(roll() * 73),
    surfaceSeed: Math.floor(roll() * 65536),
    surfaceContrast: 28 + Math.floor(roll() * 61),
    surfaceEffect: pick(BOARD_SURFACE_EFFECTS, roll),
    surfaceEffectAmount: 15 + Math.floor(roll() * 76),
    surfaceFlow: Math.floor(roll() * 66),
    surfaceReaction: 20 + Math.floor(roll() * 71),
    hum: pick(BOARD_HUMS, roll),
    pitch: Math.floor(roll() * BOARD_PITCH_COUNT) % BOARD_PITCH_COUNT,
    soundTone: 20 + Math.floor(roll() * 66),
    soundMotion: 12 + Math.floor(roll() * 77)
  };
};

const boardKey = (b) =>
  `${b.shape}|${b.fin}|${b.deck}|${b.trim}|${b.glow}|${b.surface}|${b.surfaceScale}|${b.surfaceWarp}|${b.surfaceSeed}|${b.surfaceContrast}|${b.surfaceEffect}|${b.surfaceEffectAmount}|${b.surfaceFlow}|${b.surfaceReaction}|${b.hum}|${b.pitch}|${b.soundTone}|${b.soundMotion}`;

const isDefaultBoard = (b) => boardKey(b) === boardKey(DEFAULT_BOARD);

const sanitizeBoard = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  return {
    shape: oneOf(raw.shape, BOARD_SHAPES, DEFAULT_BOARD.shape),
    fin: oneOf(raw.fin, BOARD_FINS, DEFAULT_BOARD.fin),
    deck: intRange(raw.deck, BOARD_DECK_COUNT, DEFAULT_BOARD.deck),
    trim: intRange(raw.trim, BOARD_DECK_COUNT, DEFAULT_BOARD.trim),
    glow: intRange(raw.glow, BOARD_GLOW_COUNT, DEFAULT_BOARD.glow),
    surface: oneOf(raw.surface, BOARD_SURFACES, DEFAULT_BOARD.surface),
    surfaceScale: intRange(raw.surfaceScale, 101, DEFAULT_BOARD.surfaceScale),
    surfaceWarp: intRange(raw.surfaceWarp, 101, DEFAULT_BOARD.surfaceWarp),
    surfaceSeed: intRange(raw.surfaceSeed, 65536, DEFAULT_BOARD.surfaceSeed),
    surfaceContrast: intRange(raw.surfaceContrast, 101, DEFAULT_BOARD.surfaceContrast),
    surfaceEffect: oneOf(raw.surfaceEffect, BOARD_SURFACE_EFFECTS, DEFAULT_BOARD.surfaceEffect),
    surfaceEffectAmount: intRange(raw.surfaceEffectAmount, 101, DEFAULT_BOARD.surfaceEffectAmount),
    surfaceFlow: intRange(raw.surfaceFlow, 101, DEFAULT_BOARD.surfaceFlow),
    surfaceReaction: intRange(raw.surfaceReaction, 101, DEFAULT_BOARD.surfaceReaction),
    hum: oneOf(raw.hum, BOARD_HUMS, DEFAULT_BOARD.hum),
    pitch: intRange(raw.pitch, BOARD_PITCH_COUNT, DEFAULT_BOARD.pitch),
    soundTone: intRange(raw.soundTone, 101, DEFAULT_BOARD.soundTone),
    soundMotion: intRange(raw.soundMotion, 101, DEFAULT_BOARD.soundMotion)
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
    board: boardFromSeed(id),
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
      const customBoard = sanitizeBoard(msg.board);
      if (customBoard && !isDefaultBoard(customBoard)) p.board = customBoard;
      send(ws, {
        t: "welcome",
        id,
        hue: p.hue,
        name: p.name,
        players: [...players.values()]
          .filter((o) => o.id !== id)
          .map((o) => ({ id: o.id, name: o.name, hue: o.hue, avatar: o.avatar, board: o.board }))
      });
      broadcast({ t: "join", id, name: p.name, hue: p.hue, avatar: p.avatar, board: p.board }, id);
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
    } else if (msg.t === "board") {
      // same guard as avatars: default/garbage falls back to the per-id seed
      const custom = sanitizeBoard(msg.board);
      p.board = custom && !isDefaultBoard(custom) ? custom : boardFromSeed(id);
      broadcast({ t: "board", id, board: p.board }, id);
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
    } else if (msg.t === "golf" && typeof msg.k === "string" && msg.k.length <= 8) {
      // golf events: swing / ball snapshot / rest / score / quit. The owner's
      // client simulates its own ball; this is a pure relay of whitelisted
      // fields (d = up to 8 finite numbers, h/p/s/r = finite numbers).
      const d = msg.d;
      const dOk =
        d === undefined ||
        (Array.isArray(d) && d.length <= 8 && d.every((n) => typeof n === "number" && Number.isFinite(n)));
      const numsOk = ["h", "p", "s", "r"].every(
        (key) => msg[key] === undefined || (typeof msg[key] === "number" && Number.isFinite(msg[key]))
      );
      if (dOk && numsOk) {
        const out = { t: "golf", id, k: msg.k };
        if (d !== undefined) out.d = d;
        for (const key of ["h", "p", "s", "r"]) if (msg[key] !== undefined) out[key] = msg[key];
        broadcast(out, id);
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
