// Buffer-destroyed storm attribution probe.
//
// Instruments GPUDevice.createBuffer / GPUBuffer.destroy / GPUQueue.submit
// BEFORE the app loads: every buffer gets a unique label, every destroy records
// a JS stack + frame index, and every submit runs inside a validation error
// scope so each error is attributed to (frame, submit, command-buffer labels,
// buffer identity, creating stack, destroying stack, frames-since-destroy).
//
// Scenario: M9 "leak roam" amplifier — settle, then 300 m hops every 2.5 s
// around downtown→embarcadero→bayfront→marina→goldenGate→palace, with
// ?m9norelease=1 to reproduce the storm.
//
//   node bufstorm-probe.mjs [--url http://127.0.0.1:PORT] [--norelease 0|1] [--seconds 210]
//
// Env: CHROME_BIN. Output: bufstorm-report-<tag>.json next to this file.
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE_URL = argOf("url", "http://127.0.0.1:5301");
const NORELEASE = argOf("norelease", "1") === "1";
const ROAM_SECONDS = Number(argOf("seconds", "210"));
const TAG = argOf("tag", NORELEASE ? "norelease" : "release");
const OUT = path.resolve(DIR, "..", ".data", `bufstorm-report-${TAG}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const c of candidates) {
    try { await access(c); return c; } catch {}
  }
  throw new Error("No Chrome found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 30_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return r.status;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${last?.message}`);
}

// ---- in-page GPU instrumentation (init script, runs before app code) --------
const INIT = `(() => {
  if (typeof GPUDevice === "undefined") return;
  const S = window.__bufstorm = {
    frame: 0, buffersCreated: 0, buffersDestroyed: 0, submits: 0,
    errorCount: 0, uncaptured: 0, errors: [],
    creates: new Map(), destroys: new Map(), device: null,
  };
  const loop = () => { S.frame++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const trim = (s) => (s || "").split("\\n").slice(1, 16).join("\\n");
  let nextId = 1;
  const origCreate = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (desc) {
    const id = nextId++;
    const base = (desc.label || "buf").replace(/#\\d+$/, "");
    try { desc.label = base + "#" + id; } catch {}
    const label = base + "#" + id;
    const buf = origCreate.call(this, desc);
    try { buf.label = label; } catch {}
    S.buffersCreated++;
    S.creates.set(label, {
      frame: S.frame, t: Math.round(performance.now()),
      size: desc.size, usage: desc.usage, stack: trim(new Error().stack),
    });
    if (S.creates.size > 30000) S.creates.delete(S.creates.keys().next().value);
    const origDestroy = buf.destroy.bind(buf);
    buf.destroy = () => {
      S.buffersDestroyed++;
      S.destroys.set(label, {
        frame: S.frame, t: Math.round(performance.now()), stack: trim(new Error().stack),
      });
      if (S.destroys.size > 30000) S.destroys.delete(S.destroys.keys().next().value);
      return origDestroy();
    };
    return buf;
  };
  const origReqDev = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await origReqDev.apply(this, a);
    S.device = d;
    try { d.addEventListener("uncapturederror", () => { S.uncaptured++; }); } catch {}
    return d;
  };
  const origSubmit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (cbs) {
    const frame = S.frame;
    const submitIndex = S.submits++;
    let labels = [];
    try { labels = Array.from(cbs, (c) => (c && c.label) || "?"); } catch {}
    const d = S.device;
    if (d) d.pushErrorScope("validation");
    const r = origSubmit.call(this, cbs);
    if (d) d.popErrorScope().then((err) => {
      if (!err) return;
      S.errorCount++;
      if (S.errors.length < 500) {
        const m = /\\[Buffer "([^"]+)"\\]/.exec(err.message);
        const label = m ? m[1] : null;
        S.errors.push({
          t: Math.round(performance.now()), frame, submitIndex,
          msg: String(err.message).slice(0, 400), label, cbLabels: labels,
          create: label ? S.creates.get(label) ?? null : null,
          destroy: label ? S.destroys.get(label) ?? null : null,
        });
      }
    }).catch(() => {});
    return r;
  };
})();`;

// M9 leak-roam anchor loop (spawnPoints coords)
const ANCHORS = [
  { x: 3900, z: 200 },    // downtown
  { x: 4340, z: -380 },   // embarcadero
  { x: 3000, z: -2600 },  // bayfront
  { x: -700, z: -2350 },  // marinaGreen
  { x: -2982, z: -2798 }, // goldenGate
  { x: -248, z: -1410 },  // palaceReverie
];
function roamWaypoints(stepMeters = 300) {
  const pts = [];
  const closed = [...ANCHORS, ANCHORS[0]];
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i], b = closed[i + 1];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(d / stepMeters));
    for (let k = 0; k < n; k++) {
      pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
  }
  return pts;
}

async function main() {
  const url = new URL(BASE_URL);
  url.searchParams.set("autostart", "1");
  url.searchParams.set("profile", "1");
  url.searchParams.set("fullfps", "1");
  url.searchParams.set("spawn", "downtown");
  if (NORELEASE) url.searchParams.set("m9norelease", "1");

  await waitHttp(BASE_URL);
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio",
    ],
  });
  const report = {
    tag: TAG, url: url.toString(), roamSeconds: ROAM_SECONDS,
    consoleErrors: [], pageErrors: [], samples: [], hops: 0,
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript(INIT);
    page.on("pageerror", (e) => report.pageErrors.push(String(e?.message ?? e)));
    page.on("console", (m) => {
      if (m.type() === "error" && report.consoleErrors.length < 200) report.consoleErrors.push(m.text().slice(0, 300));
    });
    console.log(`[bufstorm] goto ${url}`);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(
      () => window.__sf?.teleportToTarget && window.__sf?.renderIdle?.() === true,
      null, { timeout: 180_000, polling: "raf" },
    );
    console.log("[bufstorm] settled; roaming");
    const waypoints = roamWaypoints(300);
    const started = Date.now();
    let wp = 0, lastSample = 0;
    while ((Date.now() - started) / 1000 < ROAM_SECONDS) {
      const p = waypoints[wp % waypoints.length];
      wp++;
      await page.evaluate(([x, z]) => window.__sf.teleportToTarget(x, z, "bufstorm"), [p.x, p.z]);
      report.hops++;
      await sleep(2500);
      if (Date.now() - lastSample > 10_000) {
        lastSample = Date.now();
        const s = await page.evaluate(() => ({
          t: Math.round(performance.now()),
          frame: window.__bufstorm?.frame,
          errors: window.__bufstorm?.errorCount ?? -1,
          uncaptured: window.__bufstorm?.uncaptured ?? -1,
          created: window.__bufstorm?.buffersCreated,
          destroyed: window.__bufstorm?.buffersDestroyed,
          submits: window.__bufstorm?.submits,
          leak: window.__sf?.m9Leak?.() ?? null,
        }));
        report.samples.push(s);
        console.log(`[bufstorm] t=${Math.round((Date.now() - started) / 1000)}s hops=${report.hops} errors=${s.errors} uncap=${s.uncaptured} bufs=${s.created}/${s.destroyed}`);
      }
    }
    // Adversarial patch test: dispose three's SHARED sprite quad geometry
    // in-page (exactly what the buggy site disposals did). With the
    // attributeDisposePatch the backend entry is fully evicted, the next sprite
    // draw recreates a live buffer, and zero validation errors follow.
    const beforeDispose = await page.evaluate(() => window.__bufstorm.errorCount);
    await page.evaluate(() => {
      const sprite = new window.__sf.THREE.Sprite();
      sprite.geometry.dispose();
    });
    await sleep(6000);
    const afterDispose = await page.evaluate(() => window.__bufstorm.errorCount);
    report.spriteDisposeTest = { beforeDispose, afterDispose, delta: afterDispose - beforeDispose };
    console.log(`[bufstorm] sprite-dispose stress: +${afterDispose - beforeDispose} errors`);

    report.final = await page.evaluate(() => {
      const S = window.__bufstorm;
      return {
        frame: S.frame, submits: S.submits,
        buffersCreated: S.buffersCreated, buffersDestroyed: S.buffersDestroyed,
        errorCount: S.errorCount, uncaptured: S.uncaptured,
        errors: S.errors,
      };
    });
    console.log(`[bufstorm] DONE errors=${report.final.errorCount} uncaptured=${report.final.uncaptured}`);
  } finally {
    await browser.close().catch(() => {});
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 1));
  console.log(`[bufstorm] wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
