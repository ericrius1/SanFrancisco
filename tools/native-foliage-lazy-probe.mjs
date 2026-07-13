// End-to-end lazy-loading contract for the native Corona Heights foliage path.
//
// The probe deliberately boots at Ocean Beach, where no native tree system is
// relevant, then approaches Corona Heights. It audits request dispatches in
// three phases instead of relying on the browser cache view after the fact:
//
//   1. clean boot: no native tree runtime, worker, loader, manifest, or KTX2;
//   2. first approach: Corona's code boundary + shared worker/loader and only
//      the close coast-live-oak material set; distant Buena Vista stays on the
//      network-free geometric silhouette tier;
//   3. toggle + leave/re-enter: the existing patch is reused with no refetch.
//
// Usage:
//   SF_PROBE_URL=http://127.0.0.1:5243 \
//     node tools/native-foliage-lazy-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/native-foliage-lazy-probe");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const VIEWPORT = { width: 1280, height: 800 };
const CORONA = { x: 408, z: 2760, facing: -2.1 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function expectedCoronaActivationUris() {
  const response = await fetch(`${BASE_URL}/native-foliage/manifest.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Native foliage manifest returned ${response.status}`);
  const manifest = await response.json();
  const oak = manifest.materialSets?.["coast-live-oak"]?.textures;
  const uris = [
    // Corona's authored oak patch is close enough for the full material pack.
    oak?.leaf?.color?.uri,
    oak?.leaf?.surface?.uri,
    oak?.bark?.color?.uri,
    oak?.bark?.surface?.uri
  ];
  if (uris.some((uri) => typeof uri !== "string")) {
    throw new Error("Native foliage manifest has an incomplete Corona oak material set");
  }
  return new Set(uris);
}

function classify(url) {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {}
  const lower = `${pathname} ${url}`.toLowerCase();
  const base = pathname.split("/").at(-1) ?? "";
  const kinds = [];
  if (pathname.startsWith("/native-foliage/")) kinds.push("native-asset");
  if (pathname === "/native-foliage/manifest.json") kinds.push("manifest");
  if (pathname.endsWith(".ktx2")) kinds.push("ktx2");
  if (lower.includes("treecompile.worker")) {
    kinds.push("tree-worker");
  }
  if (lower.includes("ktx2loader")) kinds.push("ktx2-loader");
  if (lower.includes("basis_transcoder")) kinds.push("basis-transcoder");
  if (
    lower.includes("/src/world/coronaheights/vegetation.ts") ||
    /^vegetation-[\w-]+\.js$/i.test(base)
  ) {
    kinds.push("corona-runtime");
  }
  if (
    lower.includes("/src/world/vegetation/authoredtrees.ts") ||
    lower.includes("/src/world/vegetation/nativetree") ||
    lower.includes("/src/world/nativetreeforest/") ||
    lower.includes("/src/world/treecompiler/") ||
    /^authoredtrees-[\w-]+\.js$/i.test(base)
  ) {
    kinds.push("tree-runtime");
  }
  return { pathname, kinds: [...new Set(kinds)] };
}

function summarize(records) {
  const byKind = {};
  let transferredBytes = 0;
  for (const record of records) {
    transferredBytes += record.encodedBodySize ?? 0;
    for (const kind of record.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { requests: records.length, transferredBytes, byKind };
}

function publicRecord(record) {
  return {
    phase: record.phase,
    atMs: record.atMs,
    method: record.method,
    resourceType: record.resourceType,
    url: record.url,
    pathname: record.pathname,
    kinds: record.kinds,
    status: record.status ?? null,
    encodedBodySize: record.encodedBodySize ?? null,
    failure: record.failure ?? null
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
  // Read the server's actual content-addressed contract before opening the
  // isolated browser context. This does not populate the browser HTTP cache.
  const expectedActivation = await expectedCoronaActivationUris();
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

  const startedAt = performance.now();
  const records = [];
  const recordsByRequest = new Map();
  const inflight = new Map();
  const phaseActivityAt = new Map();
  const pageErrors = [];
  const consoleMessages = [];
  const checks = [];
  let sawViteClient = false;
  let phase = "boot";
  let page;

  const nowMs = () => Math.round(performance.now() - startedAt);
  const setPhase = (next) => {
    phase = next;
    phaseActivityAt.set(next, performance.now());
    console.log(`[native-foliage-lazy] phase: ${next}`);
  };
  const expect = (id, pass, detail) => checks.push({ id, pass, detail });
  const phaseRecords = (name) => records.filter((record) => record.phase === name);
  const hasKind = (record, kind) => record.kinds.includes(kind);

  async function waitForFeatureQuiet(name, idleMs = 1800, timeoutMs = 60_000) {
    const began = performance.now();
    while (performance.now() - began < timeoutMs) {
      const active = [...inflight.values()].filter((record) => record.phase === name).length;
      const lastActivity = phaseActivityAt.get(name) ?? began;
      if (active === 0 && performance.now() - lastActivity >= idleMs) return;
      await sleep(100);
    }
    const active = [...inflight.values()]
      .filter((record) => record.phase === name)
      .map((record) => record.pathname);
    throw new Error(`Timed out waiting for ${name} feature requests to settle: ${active.join(", ")}`);
  }

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push({ phase, atMs: nowMs(), message: String(error) }));
    page.on("console", (message) => {
      if (!['warning', 'error'].includes(message.type())) return;
      if (consoleMessages.length >= 250) return;
      consoleMessages.push({
        phase,
        atMs: nowMs(),
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
    });
    page.on("request", (request) => {
      if (request.url().includes("/@vite/client")) sawViteClient = true;
      const { pathname, kinds } = classify(request.url());
      if (kinds.length === 0) return;
      const record = {
        phase,
        atMs: nowMs(),
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
        pathname,
        kinds
      };
      records.push(record);
      recordsByRequest.set(request, record);
      inflight.set(request, record);
      phaseActivityAt.set(phase, performance.now());
    });
    page.on("response", async (response) => {
      const record = recordsByRequest.get(response.request());
      if (!record) return;
      record.status = response.status();
      const length = Number(response.headers()["content-length"] ?? 0);
      if (Number.isFinite(length)) record.encodedBodySize = length;
    });
    page.on("requestfinished", (request) => {
      const record = recordsByRequest.get(request);
      if (!record) return;
      inflight.delete(request);
      phaseActivityAt.set(record.phase, performance.now());
    });
    page.on("requestfailed", (request) => {
      const record = recordsByRequest.get(request);
      if (!record) return;
      record.failure = request.failure()?.errorText ?? "request failed";
      inflight.delete(request);
      phaseActivityAt.set(record.phase, performance.now());
    });

    setPhase("boot");
    const bootUrl = `${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=oceanBeach`;
    await page.goto(bootUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForFunction(
      () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player && window.__sf?.coronaHeights),
      null,
      { timeout: 180_000 }
    );
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 180_000 });
    await waitForFeatureQuiet("boot");
    const bootState = await page.evaluate(() => ({
      href: location.href,
      player: {
        x: Number(window.__sf.player.position.x.toFixed(1)),
        z: Number(window.__sf.player.position.z.toFixed(1))
      },
      coronaRoot: Boolean(window.__sf.scene.getObjectByName("corona_heights_unified_foliage")),
      teaGardenLoaded: Boolean(window.__sf.japaneseTeaGarden),
      renderIdle: window.__sf.renderIdle?.() === true
    }));
    const boot = phaseRecords("boot");
    expect("boot-no-native-assets", !boot.some((r) => hasKind(r, "native-asset")), summarize(boot));
    expect("boot-no-tree-worker", !boot.some((r) => hasKind(r, "tree-worker")), summarize(boot));
    expect("boot-no-ktx2-loader", !boot.some((r) => hasKind(r, "ktx2-loader")), summarize(boot));
    expect("boot-no-native-runtime", !boot.some((r) => hasKind(r, "tree-runtime") || hasKind(r, "corona-runtime")), summarize(boot));
    expect("boot-corona-remains-dormant", !bootState.coronaRoot, bootState);

    setPhase("activation");
    await page.evaluate((target) => {
      const sf = window.__sf;
      const nativeProbe = window.__nativeFoliageProbe = {
        group: null,
        prepareEnteredAt: null,
        prepareDoneAt: null,
        prepareError: null
      };
      const prepare = sf.coronaHeights.prepareFoliage;
      sf.coronaHeights.prepareFoliage = async (group) => {
        nativeProbe.group = group;
        nativeProbe.prepareEnteredAt = performance.now();
        try {
          await prepare?.(group);
          nativeProbe.prepareDoneAt = performance.now();
        } catch (error) {
          nativeProbe.prepareError = error instanceof Error ? error.stack ?? error.message : String(error);
          throw error;
        }
      };
      const y = sf.map.groundHeight(target.x, target.z);
      sf.player.teleportTo({ x: target.x, y: y + 1.6, z: target.z, facing: target.facing, mode: "walk" });
      sf.chase.yaw = target.facing;
      // Corona's owner gates foliage from the view focus (the shipping loop
      // passes camera.position). A headless teleport can leave the spring-arm
      // camera at its old coast pose for a long time, so drive that same gate
      // once with the arrival focus instead of timing the camera easing.
      sf.coronaHeights.update(1 / 60, performance.now() / 1000, target);
    }, CORONA);
    let patchReadyReached = true;
    try {
      await page.waitForFunction(
        () => Boolean(
          window.__nativeFoliageProbe?.prepareEnteredAt ||
          window.__sf.scene.getObjectByName("corona_heights_unified_foliage")?.parent
        ),
        null,
        { timeout: 45_000 }
      );
    } catch {
      patchReadyReached = false;
    }
    // Preserve an attached/not-attached result instead of discarding all
    // request evidence if WebGPU's optional precompile promise stalls.
    try {
      await page.waitForFunction(
        () => Boolean(window.__sf.scene.getObjectByName("corona_heights_unified_foliage")?.parent),
        null,
        { timeout: 15_000 }
      );
    } catch {}
    await page.evaluate(() => Promise.race([
      window.__sf.renderer.backend.device.queue.onSubmittedWorkDone(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]));
    await waitForFeatureQuiet("activation", 2200, 90_000);

    const activationState = await page.evaluate(() => {
      const sf = window.__sf;
      const nativeProbe = window.__nativeFoliageProbe;
      const attachedRoot = sf.scene.getObjectByName("corona_heights_unified_foliage");
      const root = attachedRoot ?? nativeProbe?.group ?? null;
      const treeRoot = root?.getObjectByName("corona_heights_trees");
      const rawStats = treeRoot?.userData?.nativeTreeStats;
      const treeStats = rawStats ? {
        designs: rawStats.designs,
        instances: rawStats.instances,
        chunks: rawStats.chunks,
        draws: rawStats.draws,
        farTriangles: rawStats.farTriangles,
        horizonTriangles: rawStats.horizonTriangles,
        prototypeBytes: rawStats.prototypeBytes,
        instanceBytes: rawStats.instanceBytes,
        nearActive: rawStats.nearActive?.() ?? null
      } : null;
      let meshes = 0;
      let instancedDraws = 0;
      let instances = 0;
      const textures = new Set();
      root?.traverse((object) => {
        if (!object.isMesh) return;
        meshes++;
        if (object.isInstancedMesh) {
          instancedDraws++;
          instances += object.count;
        }
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material) continue;
          for (const value of Object.values(material)) {
            if (value?.isTexture) textures.add(value.uuid);
          }
        }
      });
      const buffer = sf.renderer.getDrawingBufferSize(new sf.THREE.Vector2());
      const canvas = sf.renderer.domElement.getBoundingClientRect();
      return {
        rootUuid: root?.uuid ?? null,
        attached: Boolean(attachedRoot?.parent),
        prepare: {
          enteredAt: nativeProbe?.prepareEnteredAt ?? null,
          doneAt: nativeProbe?.prepareDoneAt ?? null,
          error: nativeProbe?.prepareError ?? null
        },
        rootCount: (() => {
          let count = 0;
          sf.scene.traverse((object) => {
            if (object.name === "corona_heights_unified_foliage") count++;
          });
          return count;
        })(),
        treeStats,
        scene: { meshes, instancedDraws, instances, materialTextures: textures.size },
        renderer: {
          calls: sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0,
          triangles: sf.renderer.info.render.triangles ?? 0,
          geometries: sf.renderer.info.memory?.geometries ?? null,
          textures: sf.renderer.info.memory?.textures ?? null
        },
        canvas: {
          cssWidth: Math.round(canvas.width),
          cssHeight: Math.round(canvas.height),
          bufferWidth: buffer.x,
          bufferHeight: buffer.y,
          dpr: devicePixelRatio
        }
      };
    });
    activationState.patchReadyReached = patchReadyReached;
    await page.screenshot({ path: path.join(OUT, "corona-loaded.png") });

    const activation = phaseRecords("activation");
    const activationKtx = activation.filter((r) => hasKind(r, "ktx2"));
    const activationKtxNames = activationKtx.map((r) => r.pathname.split("/").at(-1));
    const activationKtxSet = new Set(activationKtx.map((r) => r.pathname));
    const onlyRelevantSpecies = activationKtx.every((r) =>
      r.pathname.startsWith("/native-foliage/materials/coast-live-oak/")
    );
    const exactActivationSet = activationKtxSet.size === expectedActivation.size &&
      [...expectedActivation].every((uri) => activationKtxSet.has(uri));
    const contentAddressed = activationKtx.every((r) => /-[0-9a-f]{16}\.ktx2$/i.test(r.pathname));
    expect("activation-one-manifest", activation.filter((r) => hasKind(r, "manifest")).length === 1, summarize(activation));
    expect("activation-worker-is-separate", activation.some((r) => hasKind(r, "tree-worker")), summarize(activation));
    expect("activation-ktx2-loader-is-separate", activation.some((r) => hasKind(r, "ktx2-loader")), summarize(activation));
    expect("activation-corona-chunk-is-lazy", activation.some((r) => hasKind(r, "corona-runtime")), summarize(activation));
    expect("activation-tree-runtime-is-lazy", activation.some((r) => hasKind(r, "tree-runtime")), summarize(activation));
    expect("activation-only-relevant-assets", onlyRelevantSpecies && exactActivationSet && contentAddressed && activationKtx.length === expectedActivation.size, {
      expected: [...expectedActivation].sort(),
      actual: activationKtxNames.sort(),
      paths: activationKtx.map((r) => r.pathname)
    });
    expect("activation-distant-silhouettes-need-no-ktx2", !activationKtx.some((r) =>
      r.pathname.includes("/monterey-cypress/") || r.pathname.includes("/eucalyptus/")
    ), activationKtx.map(publicRecord));
    expect("activation-native-requests-succeeded", activation.every((r) => !r.failure && (r.status == null || r.status < 400)),
      activation.filter((r) => r.failure || (r.status != null && r.status >= 400)).map(publicRecord));
    expect("activation-created-one-native-patch", activationState.rootUuid !== null && activationState.rootCount <= 1 && activationState.treeStats?.instances === 9,
      activationState);
    expect("activation-prepare-completed", activationState.attached && activationState.prepare.doneAt !== null && activationState.prepare.error === null,
      activationState.prepare);

    setPhase("subsequent");
    const lifecycle = await page.evaluate((target) => {
      const sf = window.__sf;
      const root = sf.scene.getObjectByName("corona_heights_unified_foliage") ?? window.__nativeFoliageProbe?.group ?? null;
      const uuid = root?.uuid ?? null;
      sf.setFoliageVisible(false);
      sf.coronaHeights.update(1 / 60, 100, target);
      const offVisible = sf.coronaHeights.foliage.visible;
      sf.setFoliageVisible(true);
      sf.coronaHeights.update(1 / 60, 101, { x: -6000, z: -6000 });
      const farVisible = sf.coronaHeights.foliage.visible;
      sf.coronaHeights.update(1 / 60, 102, target);
      const backVisible = sf.coronaHeights.foliage.visible;
      const attachedAfter = sf.scene.getObjectByName("corona_heights_unified_foliage");
      const after = attachedAfter ?? window.__nativeFoliageProbe?.group ?? null;
      let rootCount = 0;
      sf.scene.traverse((object) => {
        if (object.name === "corona_heights_unified_foliage") rootCount++;
      });
      return {
        uuid,
        afterUuid: after?.uuid ?? null,
        rootCount,
        attached: Boolean(attachedAfter?.parent),
        offVisible,
        farVisible,
        backVisible
      };
    }, CORONA);
    await page.evaluate(() => Promise.race([
      window.__sf.renderer.backend.device.queue.onSubmittedWorkDone(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]));
    await waitForFeatureQuiet("subsequent", 2200, 30_000);
    const subsequent = phaseRecords("subsequent");
    expect("subsequent-zero-feature-refetch", subsequent.length === 0, subsequent.map(publicRecord));
    expect("subsequent-reuses-patch", lifecycle.uuid !== null && lifecycle.uuid === lifecycle.afterUuid && lifecycle.rootCount <= 1,
      lifecycle);
    expect("subsequent-toggle-and-reentry-state", !lifecycle.offVisible && !lifecycle.farVisible && lifecycle.backVisible, lifecycle);

    const featureFailures = records.filter((r) => r.failure || (r.status != null && r.status >= 400));
    expect("runtime-no-page-errors", pageErrors.length === 0, pageErrors);
    expect("runtime-no-console-errors", consoleMessages.filter((message) => message.type === "error").length === 0,
      consoleMessages.filter((message) => message.type === "error"));
    expect("runtime-no-feature-request-failures", featureFailures.length === 0, featureFailures.map(publicRecord));

    const result = {
      generatedAt: new Date().toISOString(),
      target: {
        baseUrl: BASE_URL,
        bootUrl,
        browser: await browser.version(),
        viewport: VIEWPORT,
        dpr: 1,
        serviceWorkers: "blocked",
        mode: sawViteClient ? "vite-dev" : "preview-or-production"
      },
      pass: checks.every((check) => check.pass),
      checks,
      phases: {
        boot: { state: bootState, summary: summarize(boot), requests: boot.map(publicRecord) },
        activation: { state: activationState, summary: summarize(activation), requests: activation.map(publicRecord) },
        subsequent: { state: lifecycle, summary: summarize(subsequent), requests: subsequent.map(publicRecord) }
      },
      pageErrors,
      consoleMessages,
      artifacts: { screenshot: path.join(OUT, "corona-loaded.png") }
    };
    await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

    for (const check of checks) {
      console.log(`[${check.pass ? "PASS" : "FAIL"}] ${check.id}`);
    }
    console.log(`[native-foliage-lazy] boot ${boot.length} tracked request(s)`);
    console.log(`[native-foliage-lazy] activation ${activationKtx.length} KTX2 map(s): ${activationKtxNames.join(", ")}`);
    console.log(`[native-foliage-lazy] subsequent ${subsequent.length} tracked request(s)`);
    console.log(`[native-foliage-lazy] report ${path.join(OUT, "result.json")}`);
    if (!result.pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[native-foliage-lazy] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
