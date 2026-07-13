// Production-only three-phase network contract for dynamically authored sites.
//
// The authored-site chunks intentionally retain Vite's generic `index-<hash>.js`
// names. Before launching Chrome this probe reads dist/index.html, excludes its
// main entry, then identifies the Corona Heights and Lands End chunks from
// stable strings in their compiled contents. That keeps the assertions tied to
// the exact local production build without baking a content hash into this file.
//
// Phases:
//   1. clean boot at distant Ocean Beach: neither authored-site chunk/asset;
//   2. force Corona through __sf.ensureOptionalWorldSite: Corona only, ready;
//   3. force Lands End: only the newly requested Lands End feature, no Corona
//      refetch.
//
// Usage (serve this worktree's dist directory first):
//   SF_PROBE_URL=http://127.0.0.1:5240 \
//     node tools/optional-site-lazy-probe.mjs

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const ASSETS = path.join(DIST, "assets");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/optional-site-lazy-probe");
const RESULT_PATH = path.join(OUT, "result.json");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const VIEWPORT = { width: 1280, height: 800 };
const FEATURE_IDLE_MS = 1_500;
const FEATURE_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEATURE_SPECS = {
  corona: {
    label: "Corona Heights",
    // Both strings live in the park's top-level dynamic chunk. The separately
    // gated foliage chunk contains neither pair in full and is not mistaken for
    // the authored-site entry.
    markers: ["corona_heights_park", "corona_summit_chert_crags"],
    relatedMarkers: ["corona_heights_unified_foliage"]
  },
  landsEnd: {
    label: "Lands End",
    markers: ["landsEnd.labyrinth", "landsEnd.keeper"],
    relatedMarkers: []
  }
};

const MEDIA_REFERENCE = /["'`](\/?(?:assets\/|[^"'`?#\s]+\/)[^"'`?#\s]+\.(?:avif|bin|glb|gltf|jpeg|jpg|json|ktx2|mp3|ogg|png|svg|wasm|wav|webp|woff2?))(?:\?[^"'`]*)?["'`]/gi;

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

function normalizeAssetReference(reference) {
  const relative = reference.startsWith("assets/") ? `/${reference}` : reference;
  try {
    return new URL(relative, "http://probe.invalid/").pathname;
  } catch {
    return null;
  }
}

function extractMediaReferences(source) {
  const references = new Set();
  for (const match of source.matchAll(MEDIA_REFERENCE)) {
    const pathname = normalizeAssetReference(match[1]);
    if (pathname) references.add(pathname);
  }
  return references;
}

function contentHashedChunk(name) {
  return /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.js$/.test(name);
}

async function discoverProductionFeatures() {
  const indexHtml = await readFile(path.join(DIST, "index.html"), "utf8");
  const entrySources = [...indexHtml.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/gi)]
    .map((match) => match[1]);
  // Handle src-before-type formatting too, while preserving a single result.
  for (const match of indexHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*\btype=["']module["'][^>]*>/gi)) {
    if (!entrySources.includes(match[1])) entrySources.push(match[1]);
  }
  if (entrySources.length !== 1) {
    throw new Error(`Expected one production module entry in dist/index.html; found ${entrySources.length}`);
  }
  const mainEntry = path.posix.basename(new URL(entrySources[0], "http://probe.invalid/").pathname);
  if (!contentHashedChunk(mainEntry)) {
    throw new Error(`Production entry is not content-hashed: ${mainEntry}`);
  }

  const names = (await readdir(ASSETS, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js") && entry.name !== mainEntry)
    .map((entry) => entry.name)
    .sort();
  const sources = new Map();
  for (const name of names) sources.set(name, await readFile(path.join(ASSETS, name), "utf8"));

  const discover = (spec) => {
    const primary = names.filter((name) => spec.markers.every((marker) => sources.get(name).includes(marker)));
    if (primary.length !== 1) {
      throw new Error(`${spec.label}: expected one compiled feature chunk; found ${primary.length}: ${primary.join(", ")}`);
    }
    if (!contentHashedChunk(primary[0])) {
      throw new Error(`${spec.label}: compiled feature chunk is not content-hashed: ${primary[0]}`);
    }
    const related = names.filter((name) =>
      name !== primary[0] && spec.relatedMarkers.some((marker) => sources.get(name).includes(marker))
    );
    const media = new Set();
    for (const name of [primary[0], ...related]) {
      for (const reference of extractMediaReferences(sources.get(name))) media.add(reference);
    }
    return { primary, related, media: [...media].sort() };
  };

  const corona = discover(FEATURE_SPECS.corona);
  const landsEnd = discover(FEATURE_SPECS.landsEnd);
  const overlap = corona.primary.filter((name) => landsEnd.primary.includes(name));
  if (overlap.length > 0) throw new Error(`Feature discovery overlapped: ${overlap.join(", ")}`);

  return {
    distIndex: path.join(DIST, "index.html"),
    mainEntry,
    scannedChunks: names.length,
    corona,
    landsEnd
  };
}

function makeClassifier(discovery) {
  const coronaPrimary = new Set(discovery.corona.primary);
  const coronaRelated = new Set(discovery.corona.related);
  const coronaMedia = new Set(discovery.corona.media);
  const landsPrimary = new Set(discovery.landsEnd.primary);
  const landsRelated = new Set(discovery.landsEnd.related);
  const landsMedia = new Set(discovery.landsEnd.media);

  return (url) => {
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {}
    const basename = path.posix.basename(pathname);
    const kinds = [];
    if (basename === discovery.mainEntry) kinds.push("main-entry");
    if (coronaPrimary.has(basename)) kinds.push("corona-chunk");
    if (coronaRelated.has(basename)) kinds.push("corona-related-chunk");
    if (coronaMedia.has(pathname)) kinds.push("corona-asset");
    if (landsPrimary.has(basename)) kinds.push("lands-end-chunk");
    if (landsRelated.has(basename)) kinds.push("lands-end-related-chunk");
    if (landsMedia.has(pathname)) kinds.push("lands-end-asset");
    if (pathname.includes("/@vite/client") || pathname.includes("/@react-refresh") || pathname.endsWith("/src/main.ts")) {
      kinds.push("vite-dev-runtime");
    }
    return { pathname, basename, kinds: [...new Set(kinds)] };
  };
}

function isFeatureRecord(record) {
  return record.kinds.some((kind) => kind.startsWith("corona-") || kind.startsWith("lands-end-"));
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
    featureRequests: records.filter(isFeatureRecord).length,
    encodedBodySize,
    byKind
  };
}

async function siteState(page) {
  return page.evaluate(() => {
    const sf = window.__sf;
    const sites = Object.fromEntries(
      ["corona", "lands-end"].map((id) => {
        const site = sf.optionalWorldSites.find((candidate) => candidate.id === id);
        return [id, site ? {
          state: site.state,
          forced: site.forced,
          x: site.x,
          z: site.z,
          distance: Math.hypot(sf.player.position.x - site.x, sf.player.position.z - site.z)
        } : null];
      })
    );
    return {
      player: { x: sf.player.position.x, z: sf.player.position.z },
      sites,
      coronaReady: Boolean(sf.coronaHeights),
      landsEndReady: Boolean(sf.landsEnd),
      coronaAttached: Boolean(sf.scene.getObjectByName("corona_heights_park")?.parent),
      landsEndAttached: Boolean(sf.scene.getObjectByName("landsEnd")?.parent),
      renderIdle: sf.renderIdle?.() === true
    };
  });
}

async function ensureSite(page, id) {
  const outcome = await page.evaluate(async ({ id, timeoutMs }) => {
    const ensure = window.__sf?.ensureOptionalWorldSite;
    if (typeof ensure !== "function") throw new Error("window.__sf.ensureOptionalWorldSite is unavailable");
    let timer;
    try {
      await Promise.race([
        ensure(id),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out ensuring ${id}`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    const site = window.__sf.optionalWorldSites.find((candidate) => candidate.id === id);
    return site ? { state: site.state, forced: site.forced } : null;
  }, { id, timeoutMs: FEATURE_TIMEOUT_MS });
  if (outcome?.state !== "ready") {
    throw new Error(`${id} did not reach ready after ensureOptionalWorldSite: ${JSON.stringify(outcome)}`);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const discovery = await discoverProductionFeatures();
  const classify = makeClassifier(discovery);
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
  let phase = "boot";
  let bootUrl;

  const expect = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  const nowMs = () => Math.round(performance.now() - startedAt);
  const setPhase = (next) => {
    phase = next;
    activityAt.set(next, performance.now());
    console.log(`[optional-site-lazy] phase: ${next}`);
  };
  const phaseRecords = (name) => records.filter((record) => record.phase === name);
  const hasKind = (record, kind) => record.kinds.includes(kind);

  async function waitForFeatureQuiet(name, idleMs = FEATURE_IDLE_MS, timeoutMs = 30_000) {
    const began = performance.now();
    while (performance.now() - began < timeoutMs) {
      const active = [...inflight.values()].filter((record) => record.phase === name && isFeatureRecord(record));
      const lastActivity = activityAt.get(name) ?? began;
      if (active.length === 0 && performance.now() - lastActivity >= idleMs) return;
      await sleep(100);
    }
    const active = [...inflight.values()]
      .filter((record) => record.phase === name && isFeatureRecord(record))
      .map((record) => record.pathname);
    throw new Error(`Timed out waiting for ${name} feature requests to settle: ${active.join(", ")}`);
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
      if (!["warning", "error"].includes(message.type()) || consoleMessages.length >= 250) return;
      consoleMessages.push({
        phase,
        atMs: nowMs(),
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
    });
    page.on("request", (request) => {
      const { pathname, basename, kinds } = classify(request.url());
      const record = {
        phase,
        atMs: nowMs(),
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
        pathname,
        basename,
        kinds
      };
      records.push(record);
      recordsByRequest.set(request, record);
      inflight.set(request, record);
      if (isFeatureRecord(record)) activityAt.set(phase, performance.now());
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
      if (isFeatureRecord(record)) activityAt.set(record.phase, performance.now());
    });
    page.on("requestfailed", (request) => {
      const record = recordsByRequest.get(request);
      if (!record) return;
      record.failure = request.failure()?.errorText ?? "request failed";
      inflight.delete(request);
      if (isFeatureRecord(record)) activityAt.set(record.phase, performance.now());
    });

    setPhase("boot");
    bootUrl = `${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=oceanBeach`;
    await page.goto(bootUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForFunction(
      () => Boolean(
        navigator.gpu &&
        window.__sf?.renderer?.backend?.device &&
        window.__sf?.player &&
        typeof window.__sf?.ensureOptionalWorldSite === "function"
      ),
      null,
      { timeout: 180_000 }
    );
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 180_000 });
    await waitForFeatureQuiet("boot");
    const bootState = await siteState(page);
    const boot = phaseRecords("boot");
    expect("production-local-entry-requested", boot.some((record) => hasKind(record, "main-entry")), {
      expected: discovery.mainEntry,
      requestedJs: boot.filter((record) => record.resourceType === "script").map((record) => record.basename)
    });
    expect("production-no-vite-runtime", !records.some((record) => hasKind(record, "vite-dev-runtime")),
      records.filter((record) => hasKind(record, "vite-dev-runtime")).map(publicRecord));
    expect("boot-far-from-authored-sites", Object.values(bootState.sites).every((site) => site && site.distance > 1_500), bootState);
    expect("boot-sites-remain-dormant", Object.values(bootState.sites).every((site) => site?.state === "dormant"), bootState);
    expect("boot-no-corona-chunk-or-asset", !boot.some((record) => record.kinds.some((kind) => kind.startsWith("corona-"))),
      boot.filter(isFeatureRecord).map(publicRecord));
    expect("boot-no-lands-end-chunk-or-asset", !boot.some((record) => record.kinds.some((kind) => kind.startsWith("lands-end-"))),
      boot.filter(isFeatureRecord).map(publicRecord));
    expect("boot-no-authored-site-root", !bootState.coronaReady && !bootState.landsEndReady &&
      !bootState.coronaAttached && !bootState.landsEndAttached, bootState);

    setPhase("corona");
    await ensureSite(page, "corona");
    await page.waitForFunction(() => Boolean(window.__sf.coronaHeights), null, { timeout: FEATURE_TIMEOUT_MS });
    await waitForFeatureQuiet("corona");
    const coronaState = await siteState(page);
    const corona = phaseRecords("corona");
    const coronaPrimaryRequests = corona.filter((record) => hasKind(record, "corona-chunk"));
    const coronaRequestedPrimary = [...new Set(coronaPrimaryRequests.map((record) => record.basename))].sort();
    expect("corona-reaches-ready", coronaState.sites.corona?.state === "ready" && coronaState.coronaReady &&
      coronaState.coronaAttached, coronaState);
    expect("corona-loads-discovered-feature-chunk-once",
      JSON.stringify(coronaRequestedPrimary) === JSON.stringify(discovery.corona.primary) && coronaPrimaryRequests.length === 1,
      { expected: discovery.corona.primary, requested: coronaPrimaryRequests.map(publicRecord) });
    expect("corona-activation-does-not-load-lands-end",
      !corona.some((record) => record.kinds.some((kind) => kind.startsWith("lands-end-"))),
      corona.filter(isFeatureRecord).map(publicRecord));
    expect("corona-activation-loads-only-corona-entry",
      corona.filter(isFeatureRecord).length === 1 && coronaPrimaryRequests.length === 1,
      corona.filter(isFeatureRecord).map(publicRecord));

    setPhase("lands-end");
    await ensureSite(page, "lands-end");
    await page.waitForFunction(() => Boolean(window.__sf.landsEnd), null, { timeout: FEATURE_TIMEOUT_MS });
    await waitForFeatureQuiet("lands-end");
    const landsEndState = await siteState(page);
    const landsEnd = phaseRecords("lands-end");
    const landsPrimaryRequests = landsEnd.filter((record) => hasKind(record, "lands-end-chunk"));
    const landsRequestedPrimary = [...new Set(landsPrimaryRequests.map((record) => record.basename))].sort();
    expect("lands-end-reaches-ready", landsEndState.sites["lands-end"]?.state === "ready" &&
      landsEndState.landsEndReady && landsEndState.landsEndAttached, landsEndState);
    expect("lands-end-loads-only-new-discovered-chunk",
      JSON.stringify(landsRequestedPrimary) === JSON.stringify(discovery.landsEnd.primary) &&
      landsPrimaryRequests.length === 1 &&
      landsEnd.filter(isFeatureRecord).length === 1,
      { expected: discovery.landsEnd.primary, requested: landsEnd.filter(isFeatureRecord).map(publicRecord) });
    expect("lands-end-does-not-refetch-corona",
      !landsEnd.some((record) => record.kinds.some((kind) => kind.startsWith("corona-"))),
      landsEnd.filter(isFeatureRecord).map(publicRecord));
    expect("corona-remains-ready-after-lands-end", landsEndState.sites.corona?.state === "ready" &&
      landsEndState.coronaReady && landsEndState.coronaAttached, landsEndState);

    const featureFailures = records.filter((record) =>
      isFeatureRecord(record) && (record.failure || (record.status != null && record.status >= 400))
    );
    expect("runtime-webgpu-device-present", await page.evaluate(() => Boolean(
      navigator.gpu && window.__sf?.renderer?.backend?.device
    )), { policy: "WebGPU-only" });
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
      discovery,
      pass: checks.every((check) => check.pass),
      checks,
      phases: {
        boot: { state: bootState, summary: summarize(boot), requests: boot.map(publicRecord) },
        corona: { state: coronaState, summary: summarize(corona), requests: corona.map(publicRecord) },
        landsEnd: { state: landsEndState, summary: summarize(landsEnd), requests: landsEnd.map(publicRecord) }
      },
      pageErrors,
      consoleMessages,
      serviceWorkers
    };
    await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);

    console.log(`[optional-site-lazy] entry ${discovery.mainEntry}`);
    console.log(`[optional-site-lazy] Corona chunk ${discovery.corona.primary.join(", ")}`);
    console.log(`[optional-site-lazy] Lands End chunk ${discovery.landsEnd.primary.join(", ")}`);
    for (const check of checks) console.log(`[${check.pass ? "PASS" : "FAIL"}] ${check.id}`);
    console.log(`[optional-site-lazy] boot ${summarize(boot).featureRequests} feature request(s)`);
    console.log(`[optional-site-lazy] Corona ${summarize(corona).featureRequests} feature request(s)`);
    console.log(`[optional-site-lazy] Lands End ${summarize(landsEnd).featureRequests} feature request(s)`);
    console.log(`[optional-site-lazy] report ${RESULT_PATH}`);
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
  console.error(`[optional-site-lazy] ${message}`);
  console.error(`[optional-site-lazy] report ${RESULT_PATH}`);
  process.exitCode = 1;
});
