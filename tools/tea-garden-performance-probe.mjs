// Production-only Tea Garden performance ablation.
//
// The probe uses the shipping covered-arrival path, waits for the destination
// to settle, then measures reversible render/update ablations between control
// runs. GPU queue fences make the result useful for WebGPU regressions instead
// of merely measuring JavaScript submission speed.
//
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/tea-garden-performance-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/tea-garden-performance");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const VIEWPORT = {
  width: Number(process.env.SF_W ?? 1440),
  height: Number(process.env.SF_H ?? 900)
};
const DPR = Number(process.env.SF_DPR ?? 1);
const WARM_FRAMES = Math.max(8, Number(process.env.SF_WARM ?? 24));
const MEASURE_FRAMES = Math.max(20, Number(process.env.SF_MEASURE ?? 60));
const DESTINATION = { x: -2280, z: 2195 };

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
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitForArrival(page) {
  const generation = await page.evaluate(() => window.__sf.worldArrival.snapshot.generation);
  await page.evaluate(({ x, z }) => window.__sf.teleportToTarget(x, z, "tea performance probe"), DESTINATION);
  await page.waitForFunction(
    ({ generation, destination }) => {
      const sf = window.__sf;
      const arrival = sf?.worldArrival?.snapshot;
      return Boolean(
        arrival &&
        arrival.generation > generation &&
        arrival.state === "idle" &&
        !sf.player.worldArrivalHeld &&
        sf.japaneseTeaGarden?.group?.parent === sf.scene &&
        Math.hypot(sf.player.position.x - destination.x, sf.player.position.z - destination.z) < 50
      );
    },
    { generation, destination: DESTINATION },
    { timeout: 180_000 }
  );
}

async function settle(page) {
  await page.waitForFunction(
    () => window.__sf.lazyRegionTimings?.["tea-garden"]?.events?.some(
      (event) => event.phase === "optional-ready"
    ),
    null,
    { timeout: 300_000 }
  );
  await page.evaluate(async () => {
    const sf = window.__sf;
    const device = sf.renderer.backend.device;
    window.__sfManual?.(true);
    sf.sky.cycleEnabled = false;
    sf.sky.setTimeOfDay(14);
    sf.renderer.setPixelRatio(1);
    sf.renderer.setSize(window.innerWidth, window.innerHeight);
    for (let batch = 0; batch < 18; batch++) {
      for (let frame = 0; frame < 20; frame++) sf.tick(1 / 60);
      await device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  });
}

async function installHarness(page) {
  await page.evaluate(() => {
    const sf = window.__sf;
    const garden = sf.japaneseTeaGarden;
    const find = (name) => sf.scene.getObjectByName(name);
    const originalUpdate = garden.update.bind(garden);
    const originalShadowEnabled = sf.renderer.shadowMap.enabled;
    const originalDpr = sf.renderer.getPixelRatio();
    const roots = {
      garden: garden.group,
      architecture: find("japanese_tea_garden_architecture"),
      vegetation: find("japanese_tea_garden_vegetation"),
      shrubs: find("japanese_tea_garden_shrubs"),
      trees: find("japanese_tea_garden_trees"),
      grass: find("japanese_tea_garden_grass")
    };
    window.__teaPerf = {
      roots,
      reset() {
        garden.update = originalUpdate;
        sf.renderer.shadowMap.enabled = originalShadowEnabled;
        sf.renderer.setPixelRatio(originalDpr);
        sf.renderer.setSize(window.innerWidth, window.innerHeight);
        for (const root of Object.values(roots)) if (root) root.visible = true;
      },
      apply(kind) {
        this.reset();
        if (kind === "no-shadows") sf.renderer.shadowMap.enabled = false;
        else if (kind === "no-garden-render") roots.garden.visible = false;
        else if (kind === "no-architecture" && roots.architecture) roots.architecture.visible = false;
        else if (kind === "no-vegetation" && roots.vegetation) roots.vegetation.visible = false;
        else if (kind === "no-shrubs" && roots.shrubs) roots.shrubs.visible = false;
        else if (kind === "no-trees" && roots.trees) roots.trees.visible = false;
        else if (kind === "no-grass" && roots.grass) roots.grass.visible = false;
        else if (kind === "no-garden-update") garden.update = () => {};
        else if (kind === "half-pixels") {
          sf.renderer.setPixelRatio(Math.max(0.5, originalDpr * Math.SQRT1_2));
          sf.renderer.setSize(window.innerWidth, window.innerHeight);
        }
      }
    };
  });
}

async function measure(page, kind) {
  return page.evaluate(async ({ kind, warmFrames, measureFrames }) => {
    const sf = window.__sf;
    const device = sf.renderer.backend.device;
    window.__teaPerf.apply(kind);
    for (let frame = 0; frame < warmFrames; frame++) {
      sf.tick(1 / 60);
      await device.queue.onSubmittedWorkDone();
    }
    const cpu = [];
    const total = [];
    for (let frame = 0; frame < measureFrames; frame++) {
      const start = performance.now();
      sf.tick(1 / 60);
      const submitted = performance.now();
      await device.queue.onSubmittedWorkDone();
      cpu.push(submitted - start);
      total.push(performance.now() - start);
    }
    const stats = (values) => {
      const ordered = [...values].sort((a, b) => a - b);
      const percentile = (p) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
      return {
        p50: +percentile(0.5).toFixed(2),
        p90: +percentile(0.9).toFixed(2),
        mean: +(ordered.reduce((sum, value) => sum + value, 0) / ordered.length).toFixed(2)
      };
    };
    const drawingBuffer = sf.renderer.getDrawingBufferSize(new sf.THREE.Vector2());
    return {
      kind,
      cpu: stats(cpu),
      total: stats(total),
      drawingBuffer: drawingBuffer.toArray(),
      memory: { ...sf.renderer.info.memory },
      tea: sf.japaneseTeaGarden.debugState()
    };
  }, { kind, warmFrames: WARM_FRAMES, measureFrames: MEASURE_FRAMES });
}

async function census(page) {
  return page.evaluate(() => {
    const sf = window.__sf;
    const root = sf.japaneseTeaGarden.group;
    const groups = new Map();
    const visibleInHierarchy = (object) => {
      for (let current = object; current; current = current.parent) if (!current.visible) return false;
      return true;
    };
    root.traverse((object) => {
      if (!object.isMesh || !visibleInHierarchy(object)) return;
      const geometry = object.geometry;
      const instances = object.isInstancedMesh ? object.count : 1;
      const triangles = ((geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3) * instances;
      let owner = object;
      while (owner.parent && owner.parent !== root) owner = owner.parent;
      const key = owner.name || "unnamed";
      const entry = groups.get(key) ?? { meshes: 0, instances: 0, triangles: 0 };
      entry.meshes++;
      entry.instances += instances;
      entry.triangles += triangles;
      groups.set(key, entry);
    });
    return Object.fromEntries(
      [...groups.entries()].map(([key, value]) => [key, { ...value, triangles: Math.round(value.triangles) }])
    );
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const errors = [];
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      "--use-angle=metal",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(() => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player), null, {
      timeout: 180_000
    });
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 180_000 });
    await waitForArrival(page);
    await settle(page);
    await installHarness(page);
    const sceneCensus = await census(page);
    const order = [
      "control-a",
      "no-shadows",
      "control-b",
      "no-garden-update",
      "no-garden-render",
      "no-architecture",
      "no-vegetation",
      "no-shrubs",
      "no-trees",
      "no-grass",
      "half-pixels",
      "control-c"
    ];
    const rows = [];
    for (const label of order) {
      const kind = label.startsWith("control-") ? "control" : label;
      const row = { label, ...await measure(page, kind) };
      rows.push(row);
      console.log(
        `[tea-perf] ${label.padEnd(18)} frame ${row.total.p50.toFixed(2)} / ${row.total.p90.toFixed(2)} ms  ` +
        `cpu ${row.cpu.p50.toFixed(2)} ms  ${row.drawingBuffer.join("×")}`
      );
    }
    await page.evaluate(() => window.__teaPerf.reset());
    const result = {
      generatedAt: new Date().toISOString(),
      target: { baseUrl: BASE_URL, viewport: VIEWPORT, dpr: DPR },
      frames: { warm: WARM_FRAMES, measure: MEASURE_FRAMES },
      sceneCensus,
      rows,
      errors
    };
    await writeFile(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
    if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[tea-perf] FAIL", error);
  process.exitCode = 1;
});
