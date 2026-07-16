// San Francisco multiplayer server: a single-room WebSocket presence relay +
// static file host for the built game (dist/).
//
// Design (matches the client in src/net/):
//  - Anyone can join, no accounts. The server assigns an id + a color hue.
//  - Clients own their physics (box3d runs in each browser); the server mostly
//    relays transforms. It does arbitrate the two pickleball player slots so
//    one browser owns at most one side, then relays the selected authority's
//    snapshots and the other owner's input.
//    This stays cheap and cheat-tolerant-by-design for a co-op sandbox.
//  - Clients send state at ~12 Hz; the server rebroadcasts one batched
//    snapshot per tick (12 Hz) with a server timestamp the clients use for
//    interpolation buffering.
//  - In-memory only: golf/pickleball late-join caches vanish on restart.
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
import { weatherNumber } from "./weather-utils.mjs";
import { starlinkGpPayload } from "./starlink.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 40);
const TICK_HZ = 12; // snapshot broadcast rate
const NAME_MAX = 20;
const CHAT_MAX = 200;
const PICKLEBALL_SLOTS = 2;
const PICKLEBALL_STATE_MAX = 96;
const PICKLEBALL_INPUT_MAX = 16;
const PICKLEBALL_VALUE_LIMIT = 1_000_000;
const RAKE_BATCH_MAX = 16;
const RAKE_HISTORY_MAX = 256;
const MSG_MAX_BYTES = 16384; // fits a WebRTC SDP offer (voice signaling); poses are ~100 B
const MSG_BUDGET_PER_SEC = 80; // state at 12 Hz + several simultaneous RTC negotiations; flooders get cut
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // no state for 5 min → drop
const WEATHER_TIMEOUT_MS = 4000;
const WEATHER_STALE_MS = 3 * 60 * 60 * 1000;
const WEATHER_MAX_BYTES = 5 * 1024 * 1024;
const WEATHER_USER_AGENT =
  process.env.SF_WEATHER_USER_AGENT ||
  "sanfrancisco-open-world/0.1 (live fog; set SF_WEATHER_USER_AGENT for operator contact)";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "..", "dist");

/* ---------------------------------------------------------- live fog weather */

const FOG_STATIONS = [
  { id: "KHAF", role: "coast" },
  { id: "KSFO", role: "southBay" },
  { id: "KOAK", role: "eastBay" }
];

// Stable NWS MTR grid points nearest Ocean Beach, downtown, and the east Bay.
// Avoiding a serial /points lookup keeps the whole adapter within one 4s budget.
const FOG_GRID_POINTS = [
  { role: "west", url: "https://api.weather.gov/gridpoints/MTR/81,105" },
  { role: "center", url: "https://api.weather.gov/gridpoints/MTR/85,105" },
  { role: "bay", url: "https://api.weather.gov/gridpoints/MTR/88,106" }
];

const weatherCache = new Map();
const weatherInflight = new Map();
let lastWeatherFailureLog = 0;

async function weatherJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/geo+json, application/json",
      "user-agent": WEATHER_USER_AGENT
    },
    redirect: "error",
    signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const declared = weatherNumber(response.headers.get("content-length"));
  if (declared !== null && declared > WEATHER_MAX_BYTES) throw new Error("weather response too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > WEATHER_MAX_BYTES) throw new Error("weather response too large");
  return JSON.parse(text);
}

async function cachedWeatherProvider(key, ttlMs, load) {
  const now = Date.now();
  const cached = weatherCache.get(key);
  if (cached && now - cached.at < ttlMs) return { ...cached, stale: false };
  const active = weatherInflight.get(key);
  if (active) return active;
  const pending = (async () => {
    try {
      const value = await load();
      const next = { value, at: Date.now() };
      weatherCache.set(key, next);
      return { ...next, stale: false };
    } catch (error) {
      if (cached && now - cached.at < WEATHER_STALE_MS) return { ...cached, stale: true };
      throw error;
    } finally {
      weatherInflight.delete(key);
    }
  })();
  weatherInflight.set(key, pending);
  return pending;
}

function parseVisibilityMiles(value) {
  if (typeof value === "string") {
    const normalized = value.trim().replace("+", "");
    const fraction = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(normalized);
    if (fraction) {
      value = Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]);
    } else {
      value = normalized;
    }
  }
  const miles = weatherNumber(value);
  return miles === null ? null : miles * 1609.344;
}

function normalizeMetar(row, spec) {
  const windKnots = weatherNumber(row.wspd);
  const obsSeconds = weatherNumber(row.obsTime);
  return {
    role: spec.role,
    id: spec.id,
    observedAt:
      obsSeconds === null
        ? typeof row.reportTime === "string" ? row.reportTime : null
        : new Date(obsSeconds * 1000).toISOString(),
    visibilityM: parseVisibilityMiles(row.visib),
    temperatureC: weatherNumber(row.temp),
    dewpointC: weatherNumber(row.dewp),
    windFromDeg: weatherNumber(row.wdir),
    windSpeedMps: windKnots === null ? null : windKnots * 0.514444,
    weather: typeof row.wxString === "string" ? row.wxString : null,
    clouds: Array.isArray(row.clouds)
      ? row.clouds.map((cloud) => {
          const feet = weatherNumber(cloud.base);
          return {
            cover: typeof cloud.cover === "string" ? cloud.cover : "",
            baseM: feet === null ? null : feet * 0.3048
          };
        })
      : []
  };
}

async function fetchFogMetars() {
  const ids = FOG_STATIONS.map(({ id }) => id).join(",");
  const rows = await weatherJson(
    `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`
  );
  if (!Array.isArray(rows)) throw new Error("unexpected METAR payload");
  const byId = new Map(rows.map((row) => [row.icaoId, row]));
  const stations = FOG_STATIONS.flatMap((spec) => {
    const row = byId.get(spec.id);
    return row ? [normalizeMetar(row, spec)] : [];
  });
  if (!stations.length) throw new Error("no METAR stations available");
  return stations;
}

function durationMs(isoDuration) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    isoDuration ?? ""
  );
  if (!match) return 0;
  return (
    Number(match[1] ?? 0) * 86400000 +
    Number(match[2] ?? 0) * 3600000 +
    Number(match[3] ?? 0) * 60000 +
    Number(match[4] ?? 0) * 1000
  );
}

function gridEntryAt(property, now = Date.now()) {
  if (!property || !Array.isArray(property.values)) return { value: null, validAt: null };
  let nearest = null;
  let nearestDistance = Infinity;
  for (const entry of property.values) {
    const [startRaw, durationRaw] = String(entry.validTime ?? "").split("/");
    const start = Date.parse(startRaw);
    if (!Number.isFinite(start)) continue;
    const selected = { value: weatherNumber(entry.value), validAt: new Date(start).toISOString() };
    const end = start + durationMs(durationRaw);
    if (now >= start && now < end) return selected;
    const distance = Math.abs(start - now);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = selected;
    }
  }
  return nearest ?? { value: null, validAt: null };
}

function windMps(property, value) {
  if (value === null) return null;
  const unit = String(property?.uom ?? property?.unitCode ?? "");
  if (/km_h-1|km\/h/i.test(unit)) return value / 3.6;
  if (/kn|knot/i.test(unit)) return value * 0.514444;
  return value;
}

async function fetchFogGrid() {
  const results = await Promise.allSettled(FOG_GRID_POINTS.map((point) => weatherJson(point.url)));
  const rows = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled") continue;
    const properties = result.value?.properties ?? {};
    const visibility = gridEntryAt(properties.visibility);
    const ceiling = gridEntryAt(properties.ceilingHeight);
    const humidity = gridEntryAt(properties.relativeHumidity);
    const skyCover = gridEntryAt(properties.skyCover);
    const windDirection = gridEntryAt(properties.windDirection);
    const windSpeed = gridEntryAt(properties.windSpeed);
    const relevant = [visibility.value, ceiling.value, humidity.value, skyCover.value];
    if (relevant.every((value) => value === null)) continue;
    rows.push({
      role: FOG_GRID_POINTS[i].role,
      issuedAt: typeof properties.updateTime === "string" ? properties.updateTime : null,
      validAt:
        visibility.validAt ?? ceiling.validAt ?? humidity.validAt ?? skyCover.validAt ?? null,
      visibilityM: visibility.value,
      ceilingM: ceiling.value,
      humidityPct: humidity.value,
      skyCoverPct: skyCover.value,
      windFromDeg: windDirection.value,
      windSpeedMps: windMps(properties.windSpeed, windSpeed.value)
    });
  }
  if (!rows.length) throw new Error("no usable NWS grid points available");
  return rows;
}

async function liveFogPayload() {
  const [metarResult, gridResult] = await Promise.allSettled([
    cachedWeatherProvider("fog-metars", 5 * 60 * 1000, fetchFogMetars),
    cachedWeatherProvider("fog-nws-grid", 30 * 60 * 1000, fetchFogGrid)
  ]);
  const generatedAt = new Date().toISOString();
  const metar = metarResult.status === "fulfilled" ? metarResult.value : null;
  const grid = gridResult.status === "fulfilled" ? gridResult.value : null;
  if (!metar && !grid) throw new Error("live fog providers unavailable");
  return {
    version: 1,
    generatedAt,
    stale: Boolean(metar?.stale || grid?.stale),
    sources: {
      metar: metar
        ? { ok: true, fetchedAt: new Date(metar.at).toISOString(), detail: metar.stale ? "cached" : "live" }
        : { ok: false, detail: String(metarResult.reason?.message ?? "unavailable") },
      nwsGrid: grid
        ? { ok: true, fetchedAt: new Date(grid.at).toISOString(), detail: grid.stale ? "cached" : "live" }
        : { ok: false, detail: String(gridResult.reason?.message ?? "unavailable") }
    },
    stations: metar?.value ?? [],
    grid: grid?.value ?? [],
    // NOAA's operational FLS data is NetCDF distributed through NCEI/CLASS,
    // not a request-path JSON feed. The contract is ready for a future scheduled
    // preprocessor; ordinary satellite RGB is not treated as a fog sensor.
    satellite: {
      available: false,
      detail: "awaiting preprocessed NOAA GOES Fog/Low Stratus mask",
      product: "NOAA GOES-R ABI-L2-GFLS"
    }
  };
}

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
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const COMPRESSIBLE_DYNAMIC = new Set([".html", ".js", ".css", ".json", ".bin", ".svg"]);
const WORLD_ASSET_PREFIXES = ["/data/", "/tiles/", "/models/", "/native-foliage/", "/buildinggen/", "/citygen/", "/audio/"];

const acceptsEncoding = (req, token) => String(req.headers["accept-encoding"] ?? "").includes(token);
const weakEtag = (st) => `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
const cacheControlFor = (urlPath) => {
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (/^\/native-foliage\/materials\/.+-[a-f0-9]{16}\.ktx2$/.test(urlPath)) {
    return "public, max-age=31536000, immutable";
  }
  if (urlPath.startsWith("/native-foliage/basis-r185/")) {
    return "public, max-age=31536000, immutable";
  }
  if (urlPath === "/native-foliage/manifest.json") return "no-cache";
  if (WORLD_ASSET_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) {
    return "public, max-age=86400, stale-while-revalidate=2592000";
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
  if (urlPath === "/api/weather/fog") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
      res.end();
      return;
    }
    try {
      const payload = await liveFogPayload();
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60, stale-while-revalidate=900",
        "content-length": Buffer.byteLength(body)
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch (error) {
      const now = Date.now();
      if (now - lastWeatherFailureLog > 60_000) {
        lastWeatherFailureLog = now;
        console.warn("[weather] live fog providers unavailable:", error);
      }
      const body = JSON.stringify({ ok: false, error: "live fog unavailable" });
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body)
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    }
    return;
  }
  if (urlPath === "/api/starlink") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
      res.end();
      return;
    }
    try {
      const payload = await starlinkGpPayload();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=600, stale-while-revalidate=7200",
        "x-starlink-source": payload.source,
        "x-starlink-count": String(payload.count),
        "x-starlink-stale": payload.stale ? "1" : "0",
        "content-length": Buffer.byteLength(payload.body)
      });
      if (req.method === "HEAD") res.end();
      else res.end(payload.body);
    } catch {
      const body = JSON.stringify({ ok: false, error: "starlink GP unavailable" });
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body)
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    }
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
/** id -> player presence plus latest reconnect-safe golf state (if any). */
const players = new Map();
/**
 * Pickleball wire: clients claim/release slot 0|1, the owner of slot 0 (or
 * slot 1 while 0 is empty) alone may publish bounded `state` arrays, and each
 * owner may send bounded slot `input` arrays to that authority. Server output
 * always stamps `id` and `authority`; `state` is cached for late joiners.
 */
const pickleball = { slots: Array(PICKLEBALL_SLOTS).fill(0), state: null };
// Sand strokes are an ordered, bounded in-memory session log. The server
// echoes each accepted batch to its sender too, so concurrent GPU fields apply
// exactly the same stroke order; late joiners replay the recent visible work.
const rakeSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const rakeHistory = [];
let rakeSequence = 0;

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
const BOARD_FX = ["vortex", "ripple", "kaleido"];
const BOARD_HUMS = ["hum", "crystal", "deep", "choir", "retro"];
const BOARD_DECK_COUNT = 8;
const BOARD_GLOW_COUNT = 8;
const BOARD_PITCH_COUNT = 5;
// surfboard customization — mirrors src/vehicles/surf/config.ts exactly.
// Lists, defaults, field ranges, and seed draw order are the current wire
// schema; unknown/legacy fields are intentionally ignored rather than migrated.
const SURFBOARD_SHAPES = ["shortboard", "fish", "longboard"];
const SURFBOARD_SURFACES = [
  "kelp-ribbons",
  "sunset-caustics",
  "fog-topography",
  "tidepool-terrazzo",
  "moon-jelly-dream",
  "golden-gate-bloom",
  "pacific-postcard"
];
const SURFBOARD_DECALS = ["none", "happy-sun", "sea-otter", "comet-shell"];
const SURFBOARD_COLOR_COUNT = 8;
const SCOOTER_BODIES = ["classic", "sport", "touring"];
const SCOOTER_SEATS = ["bench", "saddle", "petpad"];
const SCOOTER_SCREENS = ["none", "fly", "touring"];
const SCOOTER_CARGO = ["none", "rack", "basket", "topbox"];
const SCOOTER_PAINT_COUNT = 8;
const SCOOTER_TRIM_COUNT = 6;
const SCOOTER_SEAT_COUNT = 6;
// Stock-car customization — mirrors src/vehicles/car/config.ts. Generated art
// is referenced by enum only; clients keep image requests behind local gates.
const CAR_FORMS = ["coast-coupe", "apex-wedge", "trail-box", "mission-gt"];
const CAR_SURFACES = ["solid", "fogline-graphite", "sunset-terrazzo", "midnight-switchback"];
const CAR_DECALS = ["none", "coastal-gull", "bridge-flash", "poppy-rush"];
const CAR_WHEELS = ["split-five", "mesh-ten", "rally-eight"];
const CAR_PAINT_COUNT = 8;
const CAR_TRIM_COUNT = 6;
const CAR_INTERIOR_COUNT = 6;
const CAR_RIM_COUNT = 5;

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
// custom paint slot: anything that isn't a valid 0xRRGGBB means "no custom"
const hexOrNull = (value) => (Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : null);
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
  deckHex: null,
  trimHex: null,
  glowHex: null,
  surface: "aurora",
  surfaceScale: 52,
  surfaceWarp: 58,
  surfaceSeed: 1847,
  surfaceFlow: 24,
  surfaceFx: 45,
  surfaceFxKind: "vortex",
  plumeReach: 45,
  plumeShimmer: 50,
  plumeSparks: true,
  plumeGlow: 0,
  plumeHex: null,
  hum: "hum",
  pitch: 0,
  soundTone: 50,
  soundMotion: 50,
  soundThrust: 50,
  soundAir: 30
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
    surfaceFlow: Math.floor(roll() * 66),
    surfaceFx: 20 + Math.floor(roll() * 71),
    hum: pick(BOARD_HUMS, roll),
    pitch: Math.floor(roll() * BOARD_PITCH_COUNT) % BOARD_PITCH_COUNT,
    soundTone: 20 + Math.floor(roll() * 66),
    soundMotion: 12 + Math.floor(roll() * 77),
    soundThrust: 20 + Math.floor(roll() * 66),
    soundAir: 10 + Math.floor(roll() * 71),
    // appended AFTER the audio draws — keeps every earlier field's roll identical
    // to the client's config.ts (draw order = wire contract, change both)
    surfaceFxKind: pick(BOARD_FX, roll),
    plumeReach: 25 + Math.floor(roll() * 61),
    plumeShimmer: 20 + Math.floor(roll() * 66),
    plumeGlow: Math.floor(roll() * BOARD_GLOW_COUNT) % BOARD_GLOW_COUNT,
    plumeSparks: roll() > 0.35,
    // custom paint is an explicit player act — seeds never produce it
    deckHex: null,
    trimHex: null,
    glowHex: null,
    plumeHex: null
  };
};

const boardKey = (b) =>
  `${b.shape}|${b.fin}|${b.deck}|${b.trim}|${b.glow}|${b.deckHex}|${b.trimHex}|${b.glowHex}|${b.surface}|${b.surfaceScale}|${b.surfaceWarp}|${b.surfaceSeed}|${b.surfaceFlow}|${b.surfaceFx}|${b.surfaceFxKind}|${b.plumeReach}|${b.plumeShimmer}|${b.plumeSparks}|${b.plumeGlow}|${b.plumeHex}|${b.hum}|${b.pitch}|${b.soundTone}|${b.soundMotion}|${b.soundThrust}|${b.soundAir}`;

const isDefaultBoard = (b) => boardKey(b) === boardKey(DEFAULT_BOARD);

const sanitizeBoard = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  return {
    shape: oneOf(raw.shape, BOARD_SHAPES, DEFAULT_BOARD.shape),
    fin: oneOf(raw.fin, BOARD_FINS, DEFAULT_BOARD.fin),
    deck: intRange(raw.deck, BOARD_DECK_COUNT, DEFAULT_BOARD.deck),
    trim: intRange(raw.trim, BOARD_DECK_COUNT, DEFAULT_BOARD.trim),
    glow: intRange(raw.glow, BOARD_GLOW_COUNT, DEFAULT_BOARD.glow),
    deckHex: hexOrNull(raw.deckHex),
    trimHex: hexOrNull(raw.trimHex),
    glowHex: hexOrNull(raw.glowHex),
    surface: oneOf(raw.surface, BOARD_SURFACES, DEFAULT_BOARD.surface),
    surfaceScale: intRange(raw.surfaceScale, 101, DEFAULT_BOARD.surfaceScale),
    surfaceWarp: intRange(raw.surfaceWarp, 101, DEFAULT_BOARD.surfaceWarp),
    surfaceSeed: intRange(raw.surfaceSeed, 65536, DEFAULT_BOARD.surfaceSeed),
    surfaceFlow: intRange(raw.surfaceFlow, 101, DEFAULT_BOARD.surfaceFlow),
    surfaceFx: intRange(raw.surfaceFx, 101, DEFAULT_BOARD.surfaceFx),
    surfaceFxKind: oneOf(raw.surfaceFxKind, BOARD_FX, DEFAULT_BOARD.surfaceFxKind),
    plumeReach: intRange(raw.plumeReach, 101, DEFAULT_BOARD.plumeReach),
    plumeShimmer: intRange(raw.plumeShimmer, 101, DEFAULT_BOARD.plumeShimmer),
    plumeSparks: typeof raw.plumeSparks === "boolean" ? raw.plumeSparks : DEFAULT_BOARD.plumeSparks,
    plumeGlow: intRange(raw.plumeGlow, BOARD_GLOW_COUNT, DEFAULT_BOARD.plumeGlow),
    plumeHex: hexOrNull(raw.plumeHex),
    hum: oneOf(raw.hum, BOARD_HUMS, DEFAULT_BOARD.hum),
    pitch: intRange(raw.pitch, BOARD_PITCH_COUNT, DEFAULT_BOARD.pitch),
    soundTone: intRange(raw.soundTone, 101, DEFAULT_BOARD.soundTone),
    soundMotion: intRange(raw.soundMotion, 101, DEFAULT_BOARD.soundMotion),
    soundThrust: intRange(raw.soundThrust, 101, DEFAULT_BOARD.soundThrust),
    soundAir: intRange(raw.soundAir, 101, DEFAULT_BOARD.soundAir)
  };
};

const DEFAULT_SURFBOARD = {
  shape: "shortboard",
  base: 0,
  rail: 1,
  accent: 2,
  baseHex: null,
  railHex: null,
  accentHex: null,
  surface: "kelp-ribbons",
  textureZoom: 46,
  textureRotation: 50,
  textureOffsetX: 50,
  textureOffsetY: 50,
  surfaceMotion: 20,
  surfaceShimmer: 34,
  decal: "none",
  decalScale: 44,
  decalRotation: 50,
  decalX: 50,
  decalY: 35
};

// Identical FNV-1a/LCG draw order to surfboardFromSeed. Changing the order on
// either side would make independent clients disagree about the same player's
// seeded board, so keep this beside the strict sanitizer below.
const surfboardFromSeed = (seed) => {
  const roll = lcg(hashSeed(seed));
  const base = Math.floor(roll() * SURFBOARD_COLOR_COUNT) % SURFBOARD_COLOR_COUNT;
  let rail = Math.floor(roll() * SURFBOARD_COLOR_COUNT) % SURFBOARD_COLOR_COUNT;
  if (rail === base) rail = (rail + 3) % SURFBOARD_COLOR_COUNT;
  let accent = Math.floor(roll() * SURFBOARD_COLOR_COUNT) % SURFBOARD_COLOR_COUNT;
  if (accent === base || accent === rail) accent = (accent + 2) % SURFBOARD_COLOR_COUNT;
  return {
    shape: pick(SURFBOARD_SHAPES, roll),
    base,
    rail,
    accent,
    baseHex: null,
    railHex: null,
    accentHex: null,
    surface: pick(SURFBOARD_SURFACES, roll),
    textureZoom: 25 + Math.floor(roll() * 56),
    textureRotation: Math.floor(roll() * 101),
    textureOffsetX: 22 + Math.floor(roll() * 57),
    textureOffsetY: 22 + Math.floor(roll() * 57),
    surfaceMotion: 8 + Math.floor(roll() * 43),
    surfaceShimmer: 18 + Math.floor(roll() * 55),
    decal: pick(SURFBOARD_DECALS, roll),
    decalScale: 28 + Math.floor(roll() * 47),
    decalRotation: Math.floor(roll() * 101),
    decalX: 24 + Math.floor(roll() * 53),
    decalY: 20 + Math.floor(roll() * 61)
  };
};

const surfboardKey = (b) =>
  `${b.shape}|${b.base}|${b.rail}|${b.accent}|${b.baseHex}|${b.railHex}|${b.accentHex}|${b.surface}|${b.textureZoom}|${b.textureRotation}|${b.textureOffsetX}|${b.textureOffsetY}|${b.surfaceMotion}|${b.surfaceShimmer}|${b.decal}|${b.decalScale}|${b.decalRotation}|${b.decalX}|${b.decalY}`;

const isDefaultSurfboard = (b) => surfboardKey(b) === surfboardKey(DEFAULT_SURFBOARD);

const sanitizeSurfboard = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    shape: oneOf(raw.shape, SURFBOARD_SHAPES, DEFAULT_SURFBOARD.shape),
    base: intRange(raw.base, SURFBOARD_COLOR_COUNT, DEFAULT_SURFBOARD.base),
    rail: intRange(raw.rail, SURFBOARD_COLOR_COUNT, DEFAULT_SURFBOARD.rail),
    accent: intRange(raw.accent, SURFBOARD_COLOR_COUNT, DEFAULT_SURFBOARD.accent),
    baseHex: hexOrNull(raw.baseHex),
    railHex: hexOrNull(raw.railHex),
    accentHex: hexOrNull(raw.accentHex),
    surface: oneOf(raw.surface, SURFBOARD_SURFACES, DEFAULT_SURFBOARD.surface),
    textureZoom: intRange(raw.textureZoom, 101, DEFAULT_SURFBOARD.textureZoom),
    textureRotation: intRange(raw.textureRotation, 101, DEFAULT_SURFBOARD.textureRotation),
    textureOffsetX: intRange(raw.textureOffsetX, 101, DEFAULT_SURFBOARD.textureOffsetX),
    textureOffsetY: intRange(raw.textureOffsetY, 101, DEFAULT_SURFBOARD.textureOffsetY),
    surfaceMotion: intRange(raw.surfaceMotion, 101, DEFAULT_SURFBOARD.surfaceMotion),
    surfaceShimmer: intRange(raw.surfaceShimmer, 101, DEFAULT_SURFBOARD.surfaceShimmer),
    decal: oneOf(raw.decal, SURFBOARD_DECALS, DEFAULT_SURFBOARD.decal),
    decalScale: intRange(raw.decalScale, 101, DEFAULT_SURFBOARD.decalScale),
    decalRotation: intRange(raw.decalRotation, 101, DEFAULT_SURFBOARD.decalRotation),
    decalX: intRange(raw.decalX, 101, DEFAULT_SURFBOARD.decalX),
    decalY: intRange(raw.decalY, 101, DEFAULT_SURFBOARD.decalY)
  };
};

const DEFAULT_SCOOTER = {
  body: "classic", seat: "bench", screen: "fly", cargo: "rack",
  paint: 0, trim: 0, upholstery: 0,
  paintHex: null, trimHex: null, upholsteryHex: null, whitewalls: true
};

const scooterFromSeed = (seed) => {
  const roll = lcg(hashSeed(seed));
  return {
    body: pick(SCOOTER_BODIES, roll),
    seat: pick(SCOOTER_SEATS, roll),
    screen: pick(SCOOTER_SCREENS, roll),
    cargo: pick(SCOOTER_CARGO, roll),
    paint: Math.floor(roll() * SCOOTER_PAINT_COUNT) % SCOOTER_PAINT_COUNT,
    trim: Math.floor(roll() * SCOOTER_TRIM_COUNT) % SCOOTER_TRIM_COUNT,
    upholstery: Math.floor(roll() * SCOOTER_SEAT_COUNT) % SCOOTER_SEAT_COUNT,
    whitewalls: roll() > 0.35,
    paintHex: null,
    trimHex: null,
    upholsteryHex: null
  };
};

const scooterKey = (s) =>
  `${s.body}|${s.seat}|${s.screen}|${s.cargo}|${s.paint}|${s.trim}|${s.upholstery}|${s.paintHex}|${s.trimHex}|${s.upholsteryHex}|${s.whitewalls}`;
const isDefaultScooter = (s) => scooterKey(s) === scooterKey(DEFAULT_SCOOTER);
const sanitizeScooter = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  return {
    body: oneOf(raw.body, SCOOTER_BODIES, DEFAULT_SCOOTER.body),
    seat: oneOf(raw.seat, SCOOTER_SEATS, DEFAULT_SCOOTER.seat),
    screen: oneOf(raw.screen, SCOOTER_SCREENS, DEFAULT_SCOOTER.screen),
    cargo: oneOf(raw.cargo, SCOOTER_CARGO, DEFAULT_SCOOTER.cargo),
    paint: intRange(raw.paint, SCOOTER_PAINT_COUNT, DEFAULT_SCOOTER.paint),
    trim: intRange(raw.trim, SCOOTER_TRIM_COUNT, DEFAULT_SCOOTER.trim),
    upholstery: intRange(raw.upholstery, SCOOTER_SEAT_COUNT, DEFAULT_SCOOTER.upholstery),
    paintHex: hexOrNull(raw.paintHex),
    trimHex: hexOrNull(raw.trimHex),
    upholsteryHex: hexOrNull(raw.upholsteryHex),
    whitewalls: typeof raw.whitewalls === "boolean" ? raw.whitewalls : DEFAULT_SCOOTER.whitewalls
  };
};

const DEFAULT_CAR = {
  form: "coast-coupe",
  surface: "solid",
  decal: "none",
  wheel: "split-five",
  paint: 0,
  trim: 0,
  interior: 0,
  rim: 0,
  paintHex: null,
  trimHex: null,
  interiorHex: null,
  rimHex: null,
  surfaceScale: 48,
  decalScale: 50,
  decalPosition: 52,
  clearcoat: 72
};

// Identical seed draw order to the client config. Keep both sides in lockstep.
const carFromSeed = (seed) => {
  const roll = lcg(hashSeed(seed));
  return {
    form: pick(CAR_FORMS, roll),
    surface: pick(CAR_SURFACES, roll),
    decal: pick(CAR_DECALS, roll),
    wheel: pick(CAR_WHEELS, roll),
    paint: Math.floor(roll() * CAR_PAINT_COUNT) % CAR_PAINT_COUNT,
    trim: Math.floor(roll() * CAR_TRIM_COUNT) % CAR_TRIM_COUNT,
    interior: Math.floor(roll() * CAR_INTERIOR_COUNT) % CAR_INTERIOR_COUNT,
    rim: Math.floor(roll() * CAR_RIM_COUNT) % CAR_RIM_COUNT,
    paintHex: null,
    trimHex: null,
    interiorHex: null,
    rimHex: null,
    surfaceScale: 28 + Math.floor(roll() * 57),
    decalScale: 28 + Math.floor(roll() * 55),
    decalPosition: 20 + Math.floor(roll() * 61),
    clearcoat: 45 + Math.floor(roll() * 51)
  };
};

const carKey = (car) =>
  `${car.form}|${car.surface}|${car.decal}|${car.wheel}|${car.paint}|${car.trim}|${car.interior}|${car.rim}|${car.paintHex}|${car.trimHex}|${car.interiorHex}|${car.rimHex}|${car.surfaceScale}|${car.decalScale}|${car.decalPosition}|${car.clearcoat}`;
const isDefaultCar = (car) => carKey(car) === carKey(DEFAULT_CAR);
const sanitizeCar = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    form: oneOf(raw.form, CAR_FORMS, DEFAULT_CAR.form),
    surface: oneOf(raw.surface, CAR_SURFACES, DEFAULT_CAR.surface),
    decal: oneOf(raw.decal, CAR_DECALS, DEFAULT_CAR.decal),
    wheel: oneOf(raw.wheel, CAR_WHEELS, DEFAULT_CAR.wheel),
    paint: intRange(raw.paint, CAR_PAINT_COUNT, DEFAULT_CAR.paint),
    trim: intRange(raw.trim, CAR_TRIM_COUNT, DEFAULT_CAR.trim),
    interior: intRange(raw.interior, CAR_INTERIOR_COUNT, DEFAULT_CAR.interior),
    rim: intRange(raw.rim, CAR_RIM_COUNT, DEFAULT_CAR.rim),
    paintHex: hexOrNull(raw.paintHex),
    trimHex: hexOrNull(raw.trimHex),
    interiorHex: hexOrNull(raw.interiorHex),
    rimHex: hexOrNull(raw.rimHex),
    surfaceScale: intRange(raw.surfaceScale, 101, DEFAULT_CAR.surfaceScale),
    decalScale: intRange(raw.decalScale, 101, DEFAULT_CAR.decalScale),
    decalPosition: intRange(raw.decalPosition, 101, DEFAULT_CAR.decalPosition),
    clearcoat: intRange(raw.clearcoat, 101, DEFAULT_CAR.clearcoat)
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

const finite = (n, limit = 20000) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit;
const intBetween = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const pickleballAuthority = () => pickleball.slots[0] || pickleball.slots[1] || 0;
const pickleballNumbers = (d, maxLength) =>
  Array.isArray(d) &&
  d.length >= 1 &&
  d.length <= maxLength &&
  d.every((n) => finite(n, PICKLEBALL_VALUE_LIMIT))
    ? d.slice()
    : null;

const rakeRow = (row) => {
  if (!Array.isArray(row) || row.length !== 9) return null;
  if (!row.slice(0, 4).every((n) => finite(n, 20000))) return null;
  if (!row.slice(4, 8).every((n) => finite(n, 2))) return null;
  if (!finite(row[8], 2) || row[8] < 0) return null;
  return row.slice();
};

const rakeWelcome = () => ({
  session: rakeSession,
  stamps: rakeHistory.map((row) => row.slice())
});

const refreshPickleballAuthority = () => {
  const authority = pickleballAuthority();
  if (pickleball.state && pickleball.state.id !== authority) pickleball.state = null;
  return authority;
};

const pickleballWelcome = () => ({
  slots: pickleball.slots.slice(),
  authority: pickleballAuthority(),
  state: pickleball.state ? { id: pickleball.state.id, d: pickleball.state.d.slice() } : null
});

const golfPosition = (d, length) =>
  Array.isArray(d) &&
  d.length === length &&
  finite(d[0]) &&
  finite(d[1], 5000) &&
  finite(d[2]) &&
  d.every((n) => typeof n === "number" && Number.isFinite(n));

/** Shape-specific validation prevents arbitrary golf keys/fields becoming a
 *  server-reflected protocol. Scores remain deliberately owner-authoritative. */
const sanitizeGolf = (msg, id) => {
  const out = { t: "golf", id, k: msg.k };
  if (msg.k === "swing") {
    if (!golfPosition(msg.d, 6) || !msg.d.slice(3).every((n) => finite(n, 200))) return null;
    out.d = msg.d;
  } else if (msg.k === "b" || msg.k === "rest") {
    if (!golfPosition(msg.d, 3)) return null;
    out.d = msg.d;
  } else if (msg.k === "score") {
    if (!intBetween(msg.h, 1, 18) || !intBetween(msg.p, 3, 5) || !intBetween(msg.s, 1, 99) || !intBetween(msg.r, -200, 300)) return null;
    Object.assign(out, { h: msg.h, p: msg.p, s: msg.s, r: msg.r });
  } else if (msg.k === "state") {
    if (
      !golfPosition(msg.d, 5) ||
      !intBetween(msg.d[3], 0, 1) ||
      !intBetween(msg.d[4], 0, 1) ||
      !intBetween(msg.h, 1, 18) ||
      !intBetween(msg.p, 3, 5) ||
      !intBetween(msg.s, 0, 99) ||
      !intBetween(msg.r, -200, 300)
    )
      return null;
    Object.assign(out, { d: msg.d, h: msg.h, p: msg.p, s: msg.s, r: msg.r });
  } else if (msg.k !== "quit") {
    return null;
  }
  return out;
};

const releasePickleballOwner = (id) => {
  for (let slot = 0; slot < PICKLEBALL_SLOTS; slot++) {
    if (pickleball.slots[slot] !== id) continue;
    pickleball.slots[slot] = 0;
    const authority = refreshPickleballAuthority();
    broadcast({ t: "pickle", k: "release", slot, id, ok: true, authority });
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
    scooter: scooterFromSeed(id),
    surfboard: surfboardFromSeed(id),
    car: carFromSeed(id),
    alive: true,
    budget: MSG_BUDGET_PER_SEC,
    lastState: Date.now(),
    state: null,
    golf: null
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
      const customScooter = sanitizeScooter(msg.scooter);
      if (customScooter && !isDefaultScooter(customScooter)) p.scooter = customScooter;
      const customSurfboard = sanitizeSurfboard(msg.surfboard);
      if (customSurfboard && !isDefaultSurfboard(customSurfboard)) p.surfboard = customSurfboard;
      const customCar = sanitizeCar(msg.car);
      if (customCar && !isDefaultCar(customCar)) p.car = customCar;
      send(ws, {
        t: "welcome",
        id,
        hue: p.hue,
        name: p.name,
        players: [...players.values()]
          .filter((o) => o.id !== id)
          .map((o) => ({
            id: o.id,
            name: o.name,
            hue: o.hue,
            avatar: o.avatar,
            board: o.board,
            scooter: o.scooter,
            surfboard: o.surfboard,
            car: o.car,
            golf: o.golf
          })),
        pickle: pickleballWelcome(),
        sand: rakeWelcome()
      });
      broadcast(
        {
          t: "join",
          id,
          name: p.name,
          hue: p.hue,
          avatar: p.avatar,
          board: p.board,
          scooter: p.scooter,
          surfboard: p.surfboard,
          car: p.car
        },
        id
      );
      console.log(`[sf-server] join #${id} "${p.name}" (${players.size} online)`);
    } else if (msg.t === "s" && Array.isArray(msg.d) && (msg.d.length === 9 || msg.d.length === 10 || msg.d.length === 20)) {
      // Base pose is [mode,x,y,z,qx,qy,qz,qw,speed,ride?]. A held-rake
      // presence appends [engaged,dragging,contact xyz,pull xz,normal xyz].
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
    } else if (msg.t === "scooter") {
      const custom = sanitizeScooter(msg.scooter);
      p.scooter = custom && !isDefaultScooter(custom) ? custom : scooterFromSeed(id);
      broadcast({ t: "scooter", id, scooter: p.scooter }, id);
    } else if (msg.t === "surfboard") {
      // Current schema only: malformed/default data resets to this player's
      // deterministic seed instead of preserving or migrating old fields.
      const custom = sanitizeSurfboard(msg.surfboard);
      p.surfboard = custom && !isDefaultSurfboard(custom) ? custom : surfboardFromSeed(id);
      broadcast({ t: "surfboard", id, surfboard: p.surfboard }, id);
    } else if (msg.t === "car") {
      const custom = sanitizeCar(msg.car);
      p.car = custom && !isDefaultCar(custom) ? custom : carFromSeed(id);
      broadcast({ t: "car", id, car: p.car }, id);
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
    } else if (msg.t === "rake" && Array.isArray(msg.d) && msg.d.length >= 1 && msg.d.length <= RAKE_BATCH_MAX) {
      const rows = msg.d.map(rakeRow);
      if (rows.every(Boolean)) {
        const stamped = rows.map((row) => [++rakeSequence, ...row]);
        rakeHistory.push(...stamped);
        if (rakeHistory.length > RAKE_HISTORY_MAX) {
          rakeHistory.splice(0, rakeHistory.length - RAKE_HISTORY_MAX);
        }
        // No exceptId: the sender consumes the same authoritative echo as its
        // friends instead of applying an optimistic client-local order.
        broadcast({ t: "rake", id, session: rakeSession, d: stamped });
      }
    } else if (msg.t === "pickle" && typeof msg.k === "string") {
      // Ownership is the one competitive invariant the relay enforces. The
      // selected client still owns the full match simulation and physics.
      if ((msg.k === "claim" || msg.k === "release") && intBetween(msg.slot, 0, PICKLEBALL_SLOTS - 1)) {
        const slot = msg.slot;
        const owner = pickleball.slots[slot];
        if (msg.k === "claim") {
          const otherSlot = slot === 0 ? 1 : 0;
          if (owner === id) {
            const authority = refreshPickleballAuthority();
            broadcast({ t: "pickle", k: "claim", slot, id, ok: true, authority });
          } else if (owner !== 0) {
            send(ws, { t: "pickle", k: "claim", slot, id: owner, ok: false, authority: pickleballAuthority(), reason: "occupied" });
          } else if (pickleball.slots[otherSlot] === id) {
            send(ws, {
              t: "pickle",
              k: "claim",
              slot,
              id: 0,
              ok: false,
              authority: pickleballAuthority(),
              reason: "already-owns-slot"
            });
          } else {
            pickleball.slots[slot] = id;
            const authority = refreshPickleballAuthority();
            broadcast({ t: "pickle", k: "claim", slot, id, ok: true, authority });
          }
        } else if (owner === id) {
          pickleball.slots[slot] = 0;
          const authority = refreshPickleballAuthority();
          broadcast({ t: "pickle", k: "release", slot, id, ok: true, authority });
        } else {
          send(ws, { t: "pickle", k: "release", slot, id: owner, ok: false, authority: pickleballAuthority() });
        }
      } else if (msg.k === "state") {
        const d = pickleballNumbers(msg.d, PICKLEBALL_STATE_MAX);
        const authority = pickleballAuthority();
        if (d && authority === id) {
          pickleball.state = { id, d };
          broadcast({ t: "pickle", k: "state", id, authority, d }, id);
        }
      } else if (msg.k === "input" && intBetween(msg.slot, 0, PICKLEBALL_SLOTS - 1)) {
        const d = pickleballNumbers(msg.d, PICKLEBALL_INPUT_MAX);
        const authority = pickleballAuthority();
        if (d && pickleball.slots[msg.slot] === id && authority && authority !== id) {
          const target = players.get(authority);
          if (target) send(target.ws, { t: "pickle", k: "input", slot: msg.slot, id, authority, d });
        }
      }
    } else if (msg.t === "golf" && typeof msg.k === "string") {
      const out = sanitizeGolf(msg, id);
      if (out) {
        if (out.k === "state") p.golf = { d: out.d, h: out.h, p: out.p, s: out.s, r: out.r };
        else if (out.k === "quit") p.golf = null;
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
    releasePickleballOwner(id);
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
