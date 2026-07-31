/**
 * Per-pass GPU milliseconds via WebGPU timestamp queries.
 *
 * Draw calls and triangles only see SUBMISSION cost; a regression that makes
 * existing draws more expensive (heavier TSL material, more overdraw, a fatter
 * compute dispatch) is invisible to them, and wall frame time can't catch it
 * headless because Chrome vsync-pins at 16.6 ms. Timestamp queries measure
 * actual GPU work per pass and ignore vsync entirely.
 *
 * WHY THIS WORKS WHEN grade-perf-probe SAID IT COULDN'T: the old attempt set
 * `renderer.trackTimestamp`, which does not exist on Renderer — it wrote a
 * dead expando and no queries were ever attached. The live switch is
 * `renderer.backend.trackTimestamp` (what diagnostics.ts flips for the
 * inspector); the backend lazily creates its query pool on the next pass, so
 * it CAN be enabled mid-session. Chrome exposes 'timestamp-query' only behind
 * --enable-dawn-features=allow_unsafe_apis (which also disables the 100 µs
 * timestamp quantization — measured 0% quantized values), and three requests
 * every adapter feature at device creation, so the flag alone is sufficient.
 *
 * Measured on run 1 (Ocean Beach, 1440×900): ~12.4 ms GPU/frame across ~40
 * passes, beauty ~3.0 ms, bloom high-pass + first blur ~4.4 ms,
 * ContactShadowComplement ~2.2 ms — plausible and internally consistent.
 *
 * ACCOUNTING CAVEATS baked into this probe:
 * - Under manual ticking neither info.frame nor info.render.frameCalls behaves
 *   per-frame, so pass uids can't be grouped by frame. Passes are grouped by
 *   LABEL, summed per batch, and divided by the batch's tick count — every
 *   sample is a per-frame MEAN over 8 frames.
 * - Same-session round-robin only. Cross-session comparison stays meaningless
 *   (±100% noise floor on this machine).
 *
 * VALIDATION GATES:
 *   1. Repeatability: per-label round medians agree on the heavy passes.
 *   2. Sanity: totals plausible, pass roster stable batch-to-batch.
 *   3. Attribution: bloom-off (values.bloom=false + pipeline.applyPostFx() —
 *      the flag alone is only read through that refresh) must REMOVE the bloom
 *      passes from the roster and leave beauty flat; halfres (pixelRatio/2)
 *      must scale fragment-bound passes ~4× down and leave the fixed-size
 *      hero shadow map flat. Config order rotates per round — run 2 showed a
 *      fixed order lets monotonic within-round drift masquerade as an effect
 *      (+0.8 ms on every pass of whichever config ran later).
 *      `foliage` (setFoliageVisible) is also available via SF_CONFIGS but is
 *      NOT in the default set: it does not gate bladeGrass groundcover and
 *      measured vacuous at the meadow (draw-call guard catches this).
 *
 *   node tools/perf-gpu-probe.mjs
 *
 * Env: SF_PROBE_URL (default: spawn a fresh vite on a free port), CHROME_BIN,
 *      SF_STOP (meadow|downtown|marina|spawn), SF_SPAWN (oceanBeach),
 *      SF_TIME (14.2), SF_ROUNDS (6), SF_BATCHES (3),
 *      SF_CONFIGS (base,bloom,halfres), SF_W/SF_H, SF_LABEL.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/perf-gpu");
const SPAWN = process.env.SF_SPAWN ?? "oceanBeach";
const STOP = process.env.SF_STOP ?? "meadow";
const TIME = Number(process.env.SF_TIME ?? 14.2);
const ROUNDS = Number(process.env.SF_ROUNDS ?? 6);
const BATCHES = Number(process.env.SF_BATCHES ?? 3);
const FRAMES_PER_BATCH = 8; // compile promises need microtasks between batches
const W = Number(process.env.SF_W ?? 1440);
const H = Number(process.env.SF_H ?? 900);
const CONFIGS = (process.env.SF_CONFIGS ?? "base,bloom,halfres").split(",").map((s) => s.trim()).filter(Boolean);
const LABEL = process.env.SF_LABEL ?? "perf-gpu";

// Same fixed stops as perf-breakdown-probe; "spawn" measures wherever ?spawn= put us.
const STOPS = {
  downtown: { x: 4117, z: 200, facing: Math.PI },
  meadow: { x: -2260, z: 2450, facing: 2.4 },
  marina: { x: -700, z: -2380, facing: 0.6 }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (!c.includes("/") || await exists(c)) return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}

async function startServer() {
  if (process.env.SF_PROBE_URL) {
    const base = process.env.SF_PROBE_URL.trim().replace(/\/$/, "");
    await waitHttp(base, 4000, "SF_PROBE_URL server");
    return { base, child: null };
  }
  const vitePort = await freePort();
  const relay = await freePort();
  const base = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] starting vite at ${base}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(base, 60_000, "vite");
  return { base, child };
}

// Other sessions squat ports; never trust a server without checking it serves
// THIS worktree's files.
async function assertServesThisWorktree(base) {
  const body = await (await fetch(`${base}/src/app/renderCore.ts`, { cache: "no-store" })).text();
  if (!body.includes("WebGPUOnlyRenderer")) {
    throw new Error(`${base} is not serving this worktree (renderCore.ts mismatch)`);
  }
}

const quantile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const median = (arr) => quantile(arr, 0.5);

async function main() {
  await mkdir(OUT, { recursive: true });
  const { base, child } = await startServer();
  await assertServesThisWorktree(base);

  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      // timestamp-query is gated behind Dawn's unsafe APIs; without this the
      // device simply lacks the feature.
      "--enable-dawn-features=allow_unsafe_apis",
      "--enable-gpu",
      "--use-angle=metal",
      "--mute-audio",
      "--hide-scrollbars"
    ]
  });

  try {
    const page = await (await browser.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: "block"
    })).newPage();

    const res = await page.goto(`${base}/?autostart=1&fullfps=1&spawn=${encodeURIComponent(SPAWN)}`, {
      waitUntil: "domcontentloaded", timeout: 30_000
    });
    if (res?.status() !== 200) throw new Error(`expected 200, got ${res?.status()}`);

    await page.waitForFunction(
      () => Boolean(window.__sf?.renderer && window.__sf?.pipeline && window.__sfManual),
      undefined, { timeout: 180_000 }
    );
    const waitSettled = () => page.waitForFunction(
      () => window.__sf.renderIdle() === true
        && window.__sf.worldArrival?.active === false
        && window.__sf.rings?.state() === "settled",
      undefined, { timeout: 180_000 }
    );
    await waitSettled();
    console.log("[probe] world settled");

    await page.evaluate(({ tod }) => {
      const sf = window.__sf;
      window.__sfManual(true);
      sf.sky.realTime = false;
      sf.sky.cycleEnabled = false;
      sf.sky.setTimeOfDay(tod);
      // PIN THE GOVERNOR. It scales the drawing buffer to defend frame rate;
      // with it live, per-pass GPU ms self-normalises exactly like frame time.
      sf.dynRes?.setEnabled?.(false);
    }, { tod: TIME });

    if (STOP !== "spawn") {
      const stop = STOPS[STOP];
      if (!stop) throw new Error(`unknown SF_STOP "${STOP}" (${Object.keys(STOPS).join("|")}|spawn)`);
      await page.evaluate(({ x, z, facing }) => {
        const sf = window.__sf;
        const gy = sf.map.groundHeight(x, z);
        sf.player.teleportTo({ x, y: gy + 1.6, z, facing, mode: "walk" });
      }, stop);
      // Teleport kicks off streaming; a fixed settle here is exactly the old
      // residency bug (meadow measured with or without grass by luck). Hand
      // the loop back to rAF so background admission can run, wait for idle,
      // then take it back.
      await page.evaluate(() => window.__sfManual(false));
      await waitSettled();
      await page.evaluate(({ tod, facing }) => {
        const sf = window.__sf;
        window.__sfManual(true);
        sf.sky.setTimeOfDay(tod); // re-assert after streaming — sky can drift during loads
        sf.chase.yaw = facing;
        sf.chase.pitch = 0.02;
      }, { tod: TIME, facing: stop.facing });
      console.log(`[probe] teleported to ${STOP}, world re-settled`);
    }

    await page.keyboard.press("Tab"); // drop HUD compositing from the plate

    const settleBatch = async (n = 1) => {
      for (let i = 0; i < n; i++) {
        await page.evaluate((f) => { for (let k = 0; k < f; k++) window.__sf.tick(1 / 30); }, FRAMES_PER_BATCH);
        await page.waitForTimeout(120);
      }
    };
    await settleBatch(14); // boom convergence + compile warm-up

    // ---- instrument ---------------------------------------------------------
    const setup = await page.evaluate(() => {
      const r = window.__sf.renderer;
      const backend = r.backend;
      const features = backend.device?.features;
      if (!features?.has("timestamp-query")) {
        return { ok: false, reason: "device lacks timestamp-query (Dawn unsafe-apis flag missing?)" };
      }
      backend.trackTimestamp = true;
      // The default inspector is an InspectorBase whose hooks are no-op stubs;
      // patch them in place to map each pass uid to a readable label. uid is
      // `r:<callOrdinal>:<ctxId>:f<frame>`; ordinal and frame are unstable
      // under manual ticking, so labels — not uids — are the aggregation key.
      const names = new Map();
      window.__gpuPassNames = names;
      const insp = r.inspector;
      const key = (uid) => String(uid).replace(/:f\d+$/, "");
      const str = (v) => (typeof v === "string" && v.length ? v : null);
      insp.beginRender = (uid, scene, camera, rt) => {
        const k = key(uid);
        if (names.has(k)) return;
        const sceneName = str(scene?.name) ?? str(scene?.type) ?? "?";
        const target = rt ? (str(rt.texture?.name) ?? str(rt.textures?.[0]?.name) ?? rt.constructor?.name ?? "rt") : "canvas";
        names.set(k, `${sceneName} → ${target}`);
      };
      insp.beginCompute = (uid, nodes) => {
        const k = key(uid);
        if (names.has(k)) return;
        const n = Array.isArray(nodes) ? nodes[0] : nodes;
        // Unnamed compute nodes all report nodeType "void"; suffix the stable
        // ctxId from the uid (c:<ord>:<ctxId>) so distinct dispatch groups
        // don't silently merge into one bucket. Named ones (setName) are clean.
        const named = str(n?.name);
        const fallback = `${str(n?.nodeType) ?? n?.constructor?.name ?? "?"}#${String(uid).split(":")[2] ?? "?"}`;
        names.set(k, `compute: ${named ?? fallback}`);
      };
      // Draw-call accumulator: info resets at the start of every render call,
      // so a plain read lands on whichever pass finished last. Wrap reset and
      // accumulate (same trick as the probe-harness notes).
      const acc = { draws: 0 };
      window.__gpuDrawAcc = acc;
      const originalReset = r.info.reset.bind(r.info);
      r.info.reset = () => { acc.draws += r.info.render.drawCalls; originalReset(); };
      return { ok: true, basePixelRatio: r.getPixelRatio() };
    });
    if (!setup.ok) throw new Error(`instrument setup failed: ${setup.reason}`);

    // One measured batch: tick N frames, resolve both pools, harvest per-uid
    // durations grouped by label, clear the pool map so memory stays flat.
    const measureBatch = () => page.evaluate(async (frames) => {
      const sf = window.__sf;
      const r = sf.renderer;
      const acc = window.__gpuDrawAcc;
      acc.draws = 0;
      for (let k = 0; k < frames; k++) sf.tick(1 / 30);
      await r.resolveTimestampsAsync("render");
      await r.resolveTimestampsAsync("compute");
      const names = window.__gpuPassNames;
      const key = (uid) => String(uid).replace(/:f\d+$/, "");
      const byLabel = {};
      let passEntries = 0;
      for (const type of ["render", "compute"]) {
        const pool = r.backend.timestampQueryPool[type];
        if (!pool) continue;
        for (const [uid, ms] of pool.timestamps) {
          const label = names.get(key(uid)) ?? key(uid);
          byLabel[label] = (byLabel[label] ?? 0) + ms;
          passEntries++;
        }
        pool.timestamps.clear();
      }
      // Per-frame means over the batch.
      for (const k of Object.keys(byLabel)) byLabel[k] /= frames;
      return { byLabel, passesPerFrame: passEntries / frames, drawsPerFrame: acc.draws / frames };
    }, FRAMES_PER_BATCH);

    // Warm the query pools and throw the first resolves away (tier-0 rule).
    await measureBatch();
    await page.waitForTimeout(120);
    await measureBatch();
    await page.waitForTimeout(120);

    // ---- measurement: rounds × interleaved configs --------------------------
    // Each config is an absolute world state so ordering can't leak state.
    const basePR = setup.basePixelRatio;
    const applyConfig = (cfg) => page.evaluate(({ c, pr }) => {
      const sf = window.__sf;
      sf.setFoliageVisible(c !== "foliage");
      // The bloom flag is only consulted through applyPostFx() — writing the
      // value alone changes nothing (run 2: every bloom pass kept running).
      sf.POSTFX_TUNING.values.bloom = c !== "bloom";
      sf.pipeline.applyPostFx();
      sf.renderer.setPixelRatio(c === "halfres" ? pr / 2 : pr);
      sf.renderer.setSize(window.innerWidth, window.innerHeight);
    }, { c: cfg, pr: basePR });

    // samples: config -> label -> round -> [per-frame-mean ms per batch]
    const samples = new Map(CONFIGS.map((c) => [c, new Map()]));
    const frameTotals = new Map(CONFIGS.map((c) => [c, []]));
    const draws = new Map(CONFIGS.map((c) => [c, []]));
    const passRoster = new Map(CONFIGS.map((c) => [c, []]));

    for (let round = 0; round < ROUNDS; round++) {
      // Rotate the order each round: monotonic drift within a round otherwise
      // biases whichever config always runs later (run 2's phantom +0.8 ms).
      const order = CONFIGS.map((_, i) => CONFIGS[(i + round) % CONFIGS.length]);
      for (const cfg of order) {
        await applyConfig(cfg);
        await settleBatch(2); // pipeline-variant swap can compile on first use
        for (let b = 0; b < BATCHES; b++) {
          const { byLabel, passesPerFrame, drawsPerFrame } = await measureBatch();
          await page.waitForTimeout(120);
          let total = 0;
          for (const [label, ms] of Object.entries(byLabel)) {
            total += ms;
            const keyMap = samples.get(cfg);
            if (!keyMap.has(label)) keyMap.set(label, Array.from({ length: ROUNDS }, () => []));
            keyMap.get(label)[round].push(ms);
          }
          frameTotals.get(cfg).push(total);
          draws.get(cfg).push(drawsPerFrame);
          passRoster.get(cfg).push(passesPerFrame);
        }
      }
      console.log(`[probe] round ${round + 1}/${ROUNDS} done`);
    }
    await applyConfig("base"); // leave the world as we found it

    // ---- report -------------------------------------------------------------
    const report = { label: LABEL, stop: STOP, spawn: SPAWN, time: TIME, rounds: ROUNDS, viewport: [W, H], configs: {} };

    for (const cfg of CONFIGS) {
      const rows = [];
      for (const [label, rounds] of samples.get(cfg)) {
        const all = rounds.flat();
        if (!all.length) continue;
        const roundMedians = rounds.map((r) => median(r)).filter((v) => Number.isFinite(v));
        const med = median(all);
        const spread = roundMedians.length > 1 && med > 0
          ? (Math.max(...roundMedians) - Math.min(...roundMedians)) / med
          : 0;
        rows.push({ label, med, p90: quantile(all, 0.9), n: all.length, roundMedians, spread });
      }
      rows.sort((a, b) => b.med - a.med);
      report.configs[cfg] = {
        rows,
        frameTotalMed: median(frameTotals.get(cfg)),
        drawsMed: median(draws.get(cfg)),
        passesPerFrameMed: median(passRoster.get(cfg))
      };
    }

    const baseCfg = report.configs[CONFIGS[0]];
    console.log(`\n${LABEL} — per-pass GPU ms (${STOP}, tod ${TIME}, ${ROUNDS} rounds × ${BATCHES} batches × ${FRAMES_PER_BATCH} frames, ${W}x${H})`);
    console.log(`  [${CONFIGS[0]}] GPU/frame ${baseCfg.frameTotalMed?.toFixed(3)} ms   draws/frame ${baseCfg.drawsMed?.toFixed(0)}   passes/frame ${baseCfg.passesPerFrameMed?.toFixed(1)}`);
    for (const row of baseCfg.rows) {
      if (row.med < 0.01) continue;
      const share = baseCfg.frameTotalMed ? ((row.med / baseCfg.frameTotalMed) * 100).toFixed(1).padStart(5) : "  ?";
      console.log(`  ${row.med.toFixed(3).padStart(8)} ms  p90 ${row.p90.toFixed(3).padStart(7)}  ${share}%  spread ${(row.spread * 100).toFixed(0).padStart(3)}%  ${row.label}`);
    }

    for (const cfg of CONFIGS.slice(1)) {
      const c = report.configs[cfg];
      const baseByLabel = new Map(baseCfg.rows.map((r) => [r.label, r]));
      const dTotal = c.frameTotalMed - baseCfg.frameTotalMed;
      const dDraws = c.drawsMed - baseCfg.drawsMed;
      console.log(`\n  [${cfg}] GPU/frame ${c.frameTotalMed?.toFixed(3)} ms (Δ ${dTotal >= 0 ? "+" : ""}${dTotal.toFixed(3)})   draws/frame ${c.drawsMed?.toFixed(0)} (Δ ${dDraws >= 0 ? "+" : ""}${dDraws.toFixed(0)})   passes/frame ${c.passesPerFrameMed?.toFixed(1)} (base ${baseCfg.passesPerFrameMed?.toFixed(1)})`);
      // Only content toggles are expected to move draw calls; halfres/bloom
      // change work per draw (bloom's variant swap moves them incidentally).
      if (cfg === "foliage" && Math.abs(dDraws) < 5) console.log(`  ⚠ draw calls barely moved — this toggle may be vacuous at this stop`);
      const labels = new Set([...c.rows.map((r) => r.label), ...baseCfg.rows.map((r) => r.label)]);
      const deltas = [];
      for (const label of labels) {
        const a = baseByLabel.get(label)?.med ?? 0;
        const b = c.rows.find((r) => r.label === label)?.med ?? 0;
        if (Math.abs(b - a) >= 0.05) deltas.push({ label, a, b, d: b - a });
      }
      deltas.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
      for (const { label, a, b, d } of deltas) {
        console.log(`    Δ ${d >= 0 ? "+" : ""}${d.toFixed(3)} ms  ${label}  (${a.toFixed(3)} → ${b.toFixed(3)})`);
      }
      if (!deltas.length) console.log(`    (no per-pass delta ≥ 0.05 ms)`);
    }

    const outFile = path.join(OUT, `${LABEL}-${STOP}.json`);
    await writeFile(outFile, JSON.stringify(report, null, 2));
    console.log(`\n[probe] wrote ${outFile}`);
  } finally {
    await browser.close();
    child?.kill("SIGTERM");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
