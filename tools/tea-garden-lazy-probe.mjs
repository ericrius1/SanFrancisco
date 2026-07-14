// Production-only lazy-loading waterfall for the Japanese Tea Garden.
//
// The feature entry is emitted as a generic content-hashed `index-*.js`. This
// probe discovers that exact chunk from stable compiled object names after
// excluding the main entry declared by dist/index.html. It also discovers the
// feature's gallery art, drum-bridge texture choices, dynamic dialogue style,
// and selected native-tree material maps from the compiled chunk + local native
// foliage manifest. No production hash or texture content hash is hard-coded.
//
// Phases:
//   1. distant neutral-city boot: zero Tea Garden chunk, style, or selected media;
//   2. first approach through window.__sf.teleportToTarget: one feature chunk,
//      one selected variant per required texture/art slot, then ready/attached;
//   3. a safe foliage off/on + update reuses the resident feature with no
//      catalog request, code/style refetch, or selected-media refetch.
//
// Usage (serve this worktree's dist directory first):
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/tea-garden-lazy-probe.mjs

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const DIST_ASSETS = path.join(DIST, "assets");
const PUBLIC = path.join(ROOT, "public");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/tea-garden-lazy-probe");
const RESULT_PATH = path.join(OUT, "result.json");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const VIEWPORT = { width: 1280, height: 800 };
const TEA_ENTRANCE = { x: -2248.8, z: 2187.2 };
const FEATURE_IDLE_MS = 2_000;
const FEATURE_TIMEOUT_MS = 180_000;
const DESTINATION_ESSENTIAL_BUDGET_MS = 8_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEA_CHUNK_MARKERS = [
  "japanese_tea_garden_architecture",
  "dry_landscape_gpu_granular_sand",
  "tea_garden_unified_webgpu_shallow_water_surface"
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function contentHashedAsset(name, extension) {
  return new RegExp(`^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\\.${extension}$`).test(name);
}

async function listPublicUrls(relativeDirectory) {
  const root = path.join(PUBLIC, relativeDirectory);
  const urls = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) urls.push(`/${path.relative(PUBLIC, absolute).split(path.sep).join("/")}`);
    }
  };
  await visit(root);
  return urls.sort();
}

function parseModuleEntries(indexHtml) {
  const entries = [];
  for (const script of indexHtml.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = script[1];
    if (!/\btype=["']module["']/i.test(attrs)) continue;
    const src = attrs.match(/\bsrc=["']([^"']+\.js)["']/i)?.[1];
    if (src && !entries.includes(src)) entries.push(src);
  }
  return entries;
}

function extractNativeTreeSelections(source, manifest) {
  const selections = new Map();
  for (const match of source.matchAll(/species:"([^"]+)"[\s\S]{0,320}?sink:/g)) {
    const species = match[1];
    if (!manifest.materialSets?.[species]) continue;
    const variant = match[0].match(/leafColorVariant:"([^"]+)"/)?.[1] ?? null;
    const previous = selections.get(species);
    if (previous !== undefined && previous !== variant) {
      throw new Error(`Tea Garden compiled chunk selects conflicting ${species} variants`);
    }
    selections.set(species, variant);
  }
  if (selections.size === 0) throw new Error("No Tea Garden native-tree selections found in compiled chunk");

  const logical = [];
  for (const [species, variant] of [...selections.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const material = manifest.materialSets[species];
    const leafColor = variant
      ? material.textures.leaf.colorVariants?.[variant] ?? material.textures.leaf.color
      : material.textures.leaf.color;
    if (variant && !material.textures.leaf.colorVariants?.[variant]) {
      throw new Error(`Native foliage manifest is missing ${species}/${variant}`);
    }
    const roles = [
      ["leaf-color", leafColor],
      ["leaf-surface", material.textures.leaf.surface],
      ["bark-color", material.textures.bark.color],
      ["bark-surface", material.textures.bark.surface]
    ];
    for (const [role, entry] of roles) {
      if (typeof entry?.uri !== "string") throw new Error(`Native foliage manifest is missing ${species}/${role}`);
      logical.push({ id: `${species}:${role}`, species, variant, variants: [entry.uri] });
    }
  }
  return { selections: Object.fromEntries(selections), logical };
}

async function discoverProductionContract() {
  const indexPath = path.join(DIST, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  const entries = parseModuleEntries(indexHtml);
  if (entries.length !== 1) throw new Error(`Expected one production module entry; found ${entries.length}`);
  const mainEntry = path.posix.basename(new URL(entries[0], "http://probe.invalid/").pathname);
  if (!contentHashedAsset(mainEntry, "js")) throw new Error(`Main entry is not content-hashed: ${mainEntry}`);

  const files = await readdir(DIST_ASSETS, { withFileTypes: true });
  const jsNames = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js") && entry.name !== mainEntry)
    .map((entry) => entry.name)
    .sort();
  const jsSources = new Map();
  for (const name of jsNames) jsSources.set(name, await readFile(path.join(DIST_ASSETS, name), "utf8"));
  const teaChunks = jsNames.filter((name) => TEA_CHUNK_MARKERS.every((marker) => jsSources.get(name).includes(marker)));
  if (teaChunks.length !== 1) {
    throw new Error(`Expected one compiled Tea Garden chunk; found ${teaChunks.length}: ${teaChunks.join(", ")}`);
  }
  const teaChunk = teaChunks[0];
  if (!contentHashedAsset(teaChunk, "js")) throw new Error(`Tea Garden chunk is not content-hashed: ${teaChunk}`);
  const teaSource = jsSources.get(teaChunk);
  // The Tea Garden sits inside Golden Gate Park, but its first activation must
  // not wake the broader Wildlands/golf/Afterlight owner merely because their
  // proximity bounds overlap. Discover those content hashes from stable
  // compiled markers instead of hard-coding build output names.
  const unrelatedRegionChunks = jsNames.filter((name) => {
    const source = jsSources.get(name);
    return source.includes("wildlands_grass") ||
      source.includes("GOLF_SITE_PADS") ||
      source.includes("inAfterlightGroundcoverClear");
  });
  if (unrelatedRegionChunks.length < 3) {
    throw new Error(
      `Could not discover the deferred Wildlands/golf/Afterlight chunks: ` +
      unrelatedRegionChunks.join(", ")
    );
  }

  const cssNames = files.filter((entry) => entry.isFile() && entry.name.endsWith(".css")).map((entry) => entry.name).sort();
  const teaStyles = [];
  for (const name of cssNames) {
    const css = await readFile(path.join(DIST_ASSETS, name), "utf8");
    if (css.includes(".projected-dialogue{") && css.includes(".projected-dialogue__panel")) teaStyles.push(name);
  }
  if (teaStyles.length !== 1) {
    throw new Error(`Expected one compiled projected-dialogue style; found ${teaStyles.length}: ${teaStyles.join(", ")}`);
  }
  if (!contentHashedAsset(teaStyles[0], "css")) {
    throw new Error(`Tea Garden projected-dialogue style is not content-hashed: ${teaStyles[0]}`);
  }

  const art = [...new Set(teaSource.match(/\/art\/tea-house\/[A-Za-z0-9._-]+\.webp/g) ?? [])].sort();
  const drumRoot = teaSource.match(/\/japanese-tea-garden\/drum-bridge/)?.[0];
  const drumStems = [...new Set(
    teaSource.match(/(?:painted|worn)-timber-(?:basecolor|normal)/g) ?? []
  )].sort();
  if (art.length === 0 || !drumRoot || drumStems.length === 0) {
    throw new Error(`Incomplete compiled Tea Garden media contract (art=${art.length}, drum=${drumStems.length})`);
  }

  const [artCatalog, teaCatalog] = await Promise.all([
    listPublicUrls("art/tea-house"),
    listPublicUrls("japanese-tea-garden")
  ]);
  for (const url of art) {
    if (!artCatalog.includes(url)) throw new Error(`Compiled Tea Garden art is missing from public/: ${url}`);
  }
  const directLogical = art.map((url) => ({ id: path.posix.basename(url), kind: "art", variants: [url] }));
  for (const stem of drumStems) {
    const variants = ["ktx2", "webp"]
      .map((extension) => `${drumRoot}/${stem}.${extension}`)
      .filter((url) => teaCatalog.includes(url));
    if (variants.length === 0) throw new Error(`No public texture variant exists for ${drumRoot}/${stem}`);
    directLogical.push({ id: `drum:${stem}`, kind: "drum-texture", variants });
  }

  const nativeManifestPath = path.join(PUBLIC, "native-foliage/manifest.json");
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, "utf8"));
  const native = extractNativeTreeSelections(teaSource, nativeManifest);
  const selectedNativeUrls = native.logical.flatMap((entry) => entry.variants);
  for (const url of selectedNativeUrls) {
    if (!await exists(path.join(PUBLIC, url.slice(1)))) throw new Error(`Selected native texture is missing: ${url}`);
  }

  return {
    distIndex: indexPath,
    mainEntry,
    scannedChunks: jsNames.length,
    teaChunk,
    teaStyles,
    unrelatedRegionChunks,
    directLogical,
    directCatalog: [...new Set([...artCatalog, ...teaCatalog])].sort(),
    nativeSelections: native.selections,
    nativeLogical: native.logical,
    nativeManifest: "/native-foliage/manifest.json"
  };
}

function makeClassifier(contract) {
  const teaStyles = new Set(contract.teaStyles);
  const unrelatedRegionChunks = new Set(contract.unrelatedRegionChunks);
  const directExpected = new Map();
  for (const logical of contract.directLogical) {
    for (const variant of logical.variants) directExpected.set(variant, logical);
  }
  const directCatalog = new Set(contract.directCatalog);
  const nativeSelected = new Map();
  for (const logical of contract.nativeLogical) nativeSelected.set(logical.variants[0], logical);
  const teaSpecies = new Set(Object.keys(contract.nativeSelections));

  return (url) => {
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {}
    const basename = path.posix.basename(pathname);
    const kinds = [];
    let logicalId = null;
    if (basename === contract.mainEntry) kinds.push("main-entry");
    if (basename === contract.teaChunk) kinds.push("tea-feature-chunk");
    if (teaStyles.has(basename)) kinds.push("tea-feature-style");
    if (unrelatedRegionChunks.has(basename)) kinds.push("unrelated-region-chunk");

    const direct = directExpected.get(pathname);
    if (direct) {
      kinds.push(direct.kind === "art" ? "tea-art" : "tea-drum-texture");
      logicalId = direct.id;
    } else if (directCatalog.has(pathname) || pathname.startsWith("/art/tea-house/") || pathname.startsWith("/japanese-tea-garden/")) {
      kinds.push("tea-direct-unexpected");
    }

    const native = nativeSelected.get(pathname);
    if (native) {
      kinds.push("tea-native-selected-texture");
      logicalId = native.id;
    } else if (pathname.startsWith("/native-foliage/materials/")) {
      const species = pathname.split("/")[3] ?? "";
      kinds.push(teaSpecies.has(species) ? "tea-native-unselected-variant" : "shared-native-texture");
    } else if (pathname === contract.nativeManifest) {
      kinds.push("native-manifest");
    } else if (pathname.startsWith("/native-foliage/")) {
      kinds.push("native-runtime");
    }

    if (pathname.includes("/@vite/client") || pathname.includes("/@react-refresh") || pathname.endsWith("/src/main.ts")) {
      kinds.push("vite-dev-runtime");
    }
    return { pathname, basename, logicalId, kinds: [...new Set(kinds)] };
  };
}

function isTeaRecord(record) {
  return record.kinds.some((kind) => kind.startsWith("tea-"));
}

function isTrackedRecord(record) {
  return isTeaRecord(record) ||
    record.kinds.includes("native-manifest") ||
    record.kinds.includes("native-runtime") ||
    record.kinds.includes("unrelated-region-chunk");
}

function publicRecord(record) {
  return {
    phase: record.phase,
    atMs: record.atMs,
    method: record.method,
    resourceType: record.resourceType,
    url: record.url,
    pathname: record.pathname,
    basename: record.basename,
    logicalId: record.logicalId,
    kinds: record.kinds,
    status: record.status ?? null,
    encodedBodySize: record.encodedBodySize ?? null,
    failure: record.failure ?? null
  };
}

function summarize(records) {
  const byKind = {};
  let encodedBodySize = 0;
  for (const record of records) {
    encodedBodySize += record.encodedBodySize ?? 0;
    for (const kind of record.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return {
    requests: records.length,
    teaRequests: records.filter(isTeaRecord).length,
    trackedRequests: records.filter(isTrackedRecord).length,
    encodedBodySize,
    byKind
  };
}

function selectionAudit(records, logicalEntries) {
  return logicalEntries.map((logical) => {
    const matches = records.filter((record) => record.logicalId === logical.id);
    return {
      id: logical.id,
      kind: logical.kind ?? "native-texture",
      allowedVariants: logical.variants,
      pass: matches.length === 1 && !matches[0].failure &&
        matches[0].status != null && matches[0].status >= 200 && matches[0].status < 400,
      requests: matches.map(publicRecord)
    };
  });
}

function optionalNativePackAudit(records, logicalEntries) {
  const bySpecies = new Map();
  for (const logical of logicalEntries) {
    const entries = bySpecies.get(logical.species);
    if (entries) entries.push(logical);
    else bySpecies.set(logical.species, [logical]);
  }
  return [...bySpecies.entries()].map(([species, entries]) => {
    const slots = selectionAudit(records, entries);
    const requestCount = slots.reduce((sum, slot) => sum + slot.requests.length, 0);
    return {
      species,
      selectedAtApproach: requestCount > 0,
      // NativeTreeForest starts a complete four-map pack only for a species
      // that actually enters close detail. Distant Tea Garden specimens stay
      // on their network-free silhouette tier and correctly request nothing.
      pass: requestCount === 0 || slots.every((slot) => slot.pass),
      slots
    };
  });
}

async function worldState(page) {
  return page.evaluate(({ entrance }) => {
    const sf = window.__sf;
    const site = sf.japaneseTeaGarden;
    return {
      player: { x: sf.player.position.x, y: sf.player.position.y, z: sf.player.position.z },
      entranceDistance: Math.hypot(sf.player.position.x - entrance.x, sf.player.position.z - entrance.z),
      worldArrival: sf.worldArrival?.snapshot ?? null,
      renderer: {
        backend: sf.renderer.backend?.constructor?.name ?? null,
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        hasDevice: Boolean(sf.renderer.backend?.device)
      },
      sitePresent: Boolean(site),
      siteAttached: Boolean(site?.group?.parent === sf.scene),
      siteState: site?.debugState?.() ?? null,
      teaGardenTiming: sf.lazyRegionTimings?.["tea-garden"] ?? null,
      teaGardenBuildingSwap: sf.teaGardenBuildingSwapState?.() ?? null,
      wildlandsPresent: Boolean(sf.wildlands),
      adjacentGardenPresent: Boolean(sf.garden),
      renderIdle: sf.renderIdle?.() === true
    };
  }, { entrance: TEA_ENTRANCE });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const contract = await discoverProductionContract();
  const classify = makeClassifier(contract);
  await waitHttp(BASE_URL);
  const executablePath = await findChrome();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });

  const checks = [];
  const records = [];
  const recordsByRequest = new Map();
  const inflight = new Map();
  const activityAt = new Map();
  const pageErrors = [];
  const consoleMessages = [];
  const serviceWorkers = [];
  const startedAt = performance.now();
  const phaseStartedAt = new Map();
  const milestones = {};
  let phase = "boot";
  let bootUrl;

  const expect = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  const nowMs = () => Math.round(performance.now() - startedAt);
  const setPhase = (next) => {
    phase = next;
    phaseStartedAt.set(next, nowMs());
    activityAt.set(next, performance.now());
    console.log(`[tea-garden-lazy] phase: ${next}`);
  };
  const phaseRecords = (name) => records.filter((record) => record.phase === name);
  const hasKind = (record, kind) => record.kinds.includes(kind);

  async function waitForTrackedQuiet(name, idleMs = FEATURE_IDLE_MS, timeoutMs = 60_000) {
    const began = performance.now();
    while (performance.now() - began < timeoutMs) {
      const active = [...inflight.values()].filter((record) => record.phase === name && isTrackedRecord(record));
      const lastActivity = activityAt.get(name) ?? began;
      if (active.length === 0 && performance.now() - lastActivity >= idleMs) return;
      await sleep(100);
    }
    const active = [...inflight.values()]
      .filter((record) => record.phase === name && isTrackedRecord(record))
      .map((record) => record.pathname);
    throw new Error(`Timed out waiting for ${name} Tea Garden requests to settle: ${active.join(", ")}`);
  }

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    context.on("serviceworker", (worker) => serviceWorkers.push(worker.url()));
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push({ phase, atMs: nowMs(), message: String(error) }));
    page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type()) || consoleMessages.length >= 300) return;
      consoleMessages.push({
        phase,
        atMs: nowMs(),
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
    });
    page.on("request", (request) => {
      const { pathname, basename, logicalId, kinds } = classify(request.url());
      const record = {
        phase,
        atMs: nowMs(),
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
        pathname,
        basename,
        logicalId,
        kinds
      };
      records.push(record);
      recordsByRequest.set(request, record);
      inflight.set(request, record);
      if (isTrackedRecord(record)) activityAt.set(phase, performance.now());
    });
    page.on("response", async (response) => {
      const record = recordsByRequest.get(response.request());
      if (!record) return;
      record.status = response.status();
      const headers = await response.allHeaders().catch(() => ({}));
      const length = Number(headers["content-length"] ?? 0);
      if (Number.isFinite(length)) record.encodedBodySize = length;
    });
    page.on("requestfinished", (request) => {
      const record = recordsByRequest.get(request);
      if (!record) return;
      inflight.delete(request);
      if (isTrackedRecord(record)) activityAt.set(record.phase, performance.now());
    });
    page.on("requestfailed", (request) => {
      const record = recordsByRequest.get(request);
      if (!record) return;
      record.failure = request.failure()?.errorText ?? "request failed";
      inflight.delete(request);
      if (isTrackedRecord(record)) activityAt.set(record.phase, performance.now());
    });

    setPhase("boot");
    // This deep-link point is on the ordinary city terrain but outside every
    // optional park/native-tree and floating-island approach radius. Using an
    // explicit invite pose also prevents persisted spawn settings from turning
    // a supposedly clean boot into an accidental near-site boot.
    bootUrl = `${BASE_URL}/?autostart=1&fullfps=1&profile=1&j=2000,100,4000,0,walk&via=lazy-probe`;
    await page.goto(bootUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForFunction(
      () => Boolean(
        navigator.gpu &&
        window.__sf?.renderer?.backend?.device &&
        window.__sf?.player &&
        typeof window.__sf?.teleportToTarget === "function"
      ),
      null,
      { timeout: FEATURE_TIMEOUT_MS }
    );
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: FEATURE_TIMEOUT_MS });
    await waitForTrackedQuiet("boot");
    const bootState = await worldState(page);
    const boot = phaseRecords("boot");
    expect("production-local-entry-requested", boot.some((record) => hasKind(record, "main-entry")), {
      expected: contract.mainEntry,
      requestedScripts: boot.filter((record) => record.resourceType === "script").map((record) => record.basename)
    });
    expect("production-no-vite-runtime", !records.some((record) => hasKind(record, "vite-dev-runtime")),
      records.filter((record) => hasKind(record, "vite-dev-runtime")).map(publicRecord));
    expect("boot-webgpu-only", bootState.renderer.webgpu && bootState.renderer.hasDevice, bootState.renderer);
    expect("boot-is-far-from-tea-garden", bootState.entranceDistance > 2_000, bootState);
    expect("boot-no-tea-garden-chunk-style-or-media", !boot.some(isTeaRecord),
      boot.filter(isTeaRecord).map(publicRecord));
    expect("boot-no-overlapping-park-or-activity-chunk",
      !boot.some((record) => hasKind(record, "unrelated-region-chunk")),
      boot.filter((record) => hasKind(record, "unrelated-region-chunk")).map(publicRecord));
    expect("boot-no-tea-garden-instance", !bootState.sitePresent && !bootState.siteAttached, bootState);
    expect("boot-no-wildlands-instance", !bootState.wildlandsPresent, bootState);
    expect("boot-keeps-baked-tea-garden-fallback", Boolean(
      bootState.teaGardenBuildingSwap &&
      !bootState.teaGardenBuildingSwap.claimed &&
      bootState.teaGardenBuildingSwap.buildings.every((building) => !building.suppressed)
    ), bootState.teaGardenBuildingSwap);

    setPhase("activation");
    const activationStartedAt = nowMs();
    const markWhen = async (id, predicate, argument = null) => {
      await page.waitForFunction(predicate, argument, { timeout: FEATURE_TIMEOUT_MS });
      milestones[id] = nowMs() - activationStartedAt;
    };
    const activationMilestones = [
      markWhen("arrivalCommittedMs", ({ entrance }) => {
        const sf = window.__sf;
        return !sf.worldArrival?.active &&
          Math.hypot(sf.player.position.x - entrance.x, sf.player.position.z - entrance.z) < 250;
      }, { entrance: TEA_ENTRANCE }),
      markWhen("siteConstructedMs", () => Boolean(window.__sf?.japaneseTeaGarden)),
      markWhen("teaHouseVisibleMs", () => {
        const sf = window.__sf;
        const object = sf?.scene?.getObjectByName("japanese_tea_garden_tea_house");
        if (!object) return false;
        for (let current = object; current; current = current.parent) if (!current.visible) return false;
        return true;
      }),
      markWhen("hiroVisibleMs", () => {
        const sf = window.__sf;
        const object = sf?.scene?.getObjectByName("tea_master_hiro");
        if (!object) return false;
        for (let current = object; current; current = current.parent) if (!current.visible) return false;
        return true;
      }),
      markWhen("groundcoverVisibleMs", () => {
        const sf = window.__sf;
        const object = sf?.scene?.getObjectByName("tea_garden_moss_grass");
        if (!object) return false;
        for (let current = object; current; current = current.parent) if (!current.visible) return false;
        return true;
      })
    ];
    await page.evaluate(({ entrance }) => {
      window.__sf.teleportToTarget(entrance.x, entrance.z, "Japanese Tea Garden");
    }, { entrance: TEA_ENTRANCE });
    await page.waitForFunction(
      ({ entrance }) => {
        const sf = window.__sf;
        return !sf.worldArrival?.active &&
          Math.hypot(sf.player.position.x - entrance.x, sf.player.position.z - entrance.z) < 250;
      },
      { entrance: TEA_ENTRANCE },
      { timeout: FEATURE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => Boolean(
        window.__sf?.japaneseTeaGarden?.debugState?.().awake &&
        window.__sf.japaneseTeaGarden.group.parent === window.__sf.scene
      ),
      null,
      { timeout: FEATURE_TIMEOUT_MS }
    );
    await page.evaluate(async ({ timeoutMs }) => {
      const site = window.__sf.japaneseTeaGarden;
      let timer;
      try {
        await Promise.race([
          site.ready,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Timed out waiting for Japanese Tea Garden ready")), timeoutMs);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }, { timeoutMs: FEATURE_TIMEOUT_MS });
    milestones.siteReadyMs = nowMs() - activationStartedAt;
    await page.evaluate(async () => {
      await Promise.race([
        window.__sf.renderer.backend.device.queue.onSubmittedWorkDone(),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
    });
    milestones.queueSettledMs = nowMs() - activationStartedAt;
    await Promise.all(activationMilestones);
    await waitForTrackedQuiet("activation", FEATURE_IDLE_MS, FEATURE_TIMEOUT_MS);
    const activationState = await worldState(page);
    const activation = phaseRecords("activation");
    const chunkRequests = activation.filter((record) => hasKind(record, "tea-feature-chunk"));
    const styleRequests = activation.filter((record) => hasKind(record, "tea-feature-style"));
    const directAudit = selectionAudit(activation, contract.directLogical);
    const nativeAudit = optionalNativePackAudit(activation, contract.nativeLogical);
    expect("activation-debug-teleport-committed", activationState.entranceDistance < 250 &&
      !activationState.worldArrival?.active, activationState);
    expect("activation-tea-garden-ready-attached-awake", activationState.sitePresent &&
      activationState.siteAttached && activationState.siteState?.awake, activationState);
    expect("activation-does-not-construct-overlapping-wildlands", !activationState.wildlandsPresent,
      activationState);
    expect("activation-atomically-claims-baked-fallback", Boolean(
      activationState.teaGardenBuildingSwap?.claimed &&
      activationState.teaGardenBuildingSwap.buildings.every((building) => building.suppressed) &&
      activationState.teaGardenTiming?.events.some((event) => event.phase === "baked-swap")
    ), {
      swap: activationState.teaGardenBuildingSwap,
      timing: activationState.teaGardenTiming
    });
    expect("activation-destination-essentials-visible-within-budget", [
      milestones.teaHouseVisibleMs,
      milestones.hiroVisibleMs,
      milestones.groundcoverVisibleMs
    ].every((elapsed) => elapsed <= DESTINATION_ESSENTIAL_BUDGET_MS), {
      budgetMs: DESTINATION_ESSENTIAL_BUDGET_MS,
      teaHouseVisibleMs: milestones.teaHouseVisibleMs,
      hiroVisibleMs: milestones.hiroVisibleMs,
      groundcoverVisibleMs: milestones.groundcoverVisibleMs,
      arrivalCommittedMs: milestones.arrivalCommittedMs
    });
    expect("activation-webgpu-only", activationState.renderer.webgpu && activationState.renderer.hasDevice,
      activationState.renderer);
    expect("activation-loads-one-discovered-feature-chunk", chunkRequests.length === 1,
      { expected: contract.teaChunk, requests: chunkRequests.map(publicRecord) });
    expect("activation-loads-one-discovered-feature-style", styleRequests.length === 1,
      { expected: contract.teaStyles, requests: styleRequests.map(publicRecord) });
    expect("activation-isolates-tea-from-wildlands-golf-and-afterlight",
      !activation.some((record) => hasKind(record, "unrelated-region-chunk")), {
        deferredChunks: contract.unrelatedRegionChunks,
        requests: activation
          .filter((record) => hasKind(record, "unrelated-region-chunk"))
          .map(publicRecord)
      });
    expect("activation-loads-one-selected-direct-variant-per-slot", directAudit.every((entry) => entry.pass), directAudit);
    expect("activation-loads-only-complete-nearby-native-packs", nativeAudit.every((entry) => entry.pass), nativeAudit);
    const manifestRequests = [...boot, ...activation].filter((record) => hasKind(record, "native-manifest"));
    expect("native-manifest-remains-a-shared-singleton", manifestRequests.length <= 1,
      manifestRequests.map(publicRecord));
    expect("activation-no-direct-catalog-overfetch",
      !activation.some((record) => hasKind(record, "tea-direct-unexpected")),
      activation.filter((record) => hasKind(record, "tea-direct-unexpected")).map(publicRecord));
    expect("activation-no-unselected-tea-tree-variant",
      !activation.some((record) => hasKind(record, "tea-native-unselected-variant")),
      activation.filter((record) => hasKind(record, "tea-native-unselected-variant")).map(publicRecord));

    await page.evaluate(async () => {
      const sf = window.__sf;
      sf.sky.cycleEnabled = false;
      sf.sky.setTimeOfDay(13.5);
      const house = sf.scene.getObjectByName("japanese_tea_garden_tea_house");
      if (house && typeof window.__sfFreeCam === "function") {
        const bounds = new sf.THREE.Box3().setFromObject(house);
        const center = bounds.getCenter(new sf.THREE.Vector3());
        window.__sfFreeCam(
          [center.x + 22, center.y + 8, center.z + 24],
          [center.x, center.y + 1.5, center.z]
        );
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.race([
        sf.renderer.backend.device.queue.onSubmittedWorkDone(),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
    });
    const activationScreenshot = path.join(OUT, "activation.png");
    await page.screenshot({ path: activationScreenshot });

    setPhase("subsequent");
    const actionState = await page.evaluate(async () => {
      const sf = window.__sf;
      const site = sf.japaneseTeaGarden;
      const before = site.debugState();
      site.setFoliageVisible(false);
      const hidden = site.debugState();
      site.setFoliageVisible(true);
      site.update(1 / 60, performance.now() / 1000, sf.player.renderPosition, sf.camera, sf.player.mode);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.race([
        sf.renderer.backend.device.queue.onSubmittedWorkDone(),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
      return { before, hidden, after: site.debugState() };
    });
    await waitForTrackedQuiet("subsequent");
    const subsequent = phaseRecords("subsequent");
    expect("subsequent-safe-action-restores-foliage", actionState.hidden.foliageVisible === false &&
      actionState.after.foliageVisible === true && actionState.after.awake, actionState);
    expect("subsequent-zero-tea-code-style-media-refetch", !subsequent.some(isTeaRecord),
      subsequent.filter(isTeaRecord).map(publicRecord));
    expect("subsequent-zero-native-manifest-refetch",
      !subsequent.some((record) => hasKind(record, "native-manifest")),
      subsequent.filter((record) => hasKind(record, "native-manifest")).map(publicRecord));
    expect("subsequent-keeps-overlapping-region-owner-deferred",
      !subsequent.some((record) => hasKind(record, "unrelated-region-chunk")),
      subsequent.filter((record) => hasKind(record, "unrelated-region-chunk")).map(publicRecord));

    const featureFailures = records.filter((record) =>
      isTrackedRecord(record) && (record.failure || (record.status != null && record.status >= 400))
    );
    expect("runtime-service-workers-blocked", serviceWorkers.length === 0, serviceWorkers);
    expect("runtime-no-page-errors", pageErrors.length === 0, pageErrors);
    expect("runtime-no-console-errors", consoleMessages.every((message) => message.type !== "error"),
      consoleMessages.filter((message) => message.type === "error"));
    expect("runtime-no-feature-request-failures", featureFailures.length === 0, featureFailures.map(publicRecord));

    const result = {
      generatedAt: new Date().toISOString(),
      target: {
        root: ROOT,
        baseUrl: BASE_URL,
        bootUrl,
        browser: await browser.version(),
        viewport: VIEWPORT,
        dpr: 1,
        rendererPolicy: "WebGPU-only",
        serviceWorkers: "blocked",
        mode: "production-preview"
      },
      contract,
      pass: checks.every((check) => check.pass),
      checks,
      phases: {
        boot: { state: bootState, summary: summarize(boot), requests: boot.map(publicRecord) },
        activation: {
          state: activationState,
          directSelectionAudit: directAudit,
          nativeSelectionAudit: nativeAudit,
          summary: summarize(activation),
          requests: activation.map(publicRecord)
        },
        subsequent: { state: actionState, summary: summarize(subsequent), requests: subsequent.map(publicRecord) }
      },
      timings: {
        phaseStartedAtMs: Object.fromEntries(phaseStartedAt),
        activation: {
          ...milestones,
          firstTeaRequestMs: Math.min(...activation.filter(isTeaRecord)
            .map((record) => record.atMs - activationStartedAt)),
          firstFeatureChunkRequestMs: Math.min(...chunkRequests
            .map((record) => record.atMs - activationStartedAt)),
          runtimeTrace: activationState.teaGardenTiming
        }
      },
      artifacts: { activationScreenshot },
      pageErrors,
      consoleMessages,
      serviceWorkers
    };
    await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);

    console.log(`[tea-garden-lazy] entry ${contract.mainEntry}`);
    console.log(`[tea-garden-lazy] Tea Garden chunk ${contract.teaChunk}`);
    console.log(`[tea-garden-lazy] direct slots ${contract.directLogical.length}, native slots ${contract.nativeLogical.length}`);
    for (const check of checks) console.log(`[${check.pass ? "PASS" : "FAIL"}] ${check.id}`);
    console.log(`[tea-garden-lazy] boot ${summarize(boot).teaRequests} Tea request(s)`);
    console.log(`[tea-garden-lazy] activation ${summarize(activation).teaRequests} Tea request(s)`);
    console.log(`[tea-garden-lazy] subsequent ${summarize(subsequent).teaRequests} Tea request(s)`);
    console.log(`[tea-garden-lazy] activation timings ${JSON.stringify(result.timings.activation)}`);
    console.log(`[tea-garden-lazy] report ${RESULT_PATH}`);
    if (!result.pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await mkdir(OUT, { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    target: { root: ROOT, baseUrl: BASE_URL },
    pass: false,
    fatal: message
  }, null, 2)}\n`).catch(() => {});
  console.error(`[tea-garden-lazy] ${message}`);
  console.error(`[tea-garden-lazy] report ${RESULT_PATH}`);
  process.exitCode = 1;
});
