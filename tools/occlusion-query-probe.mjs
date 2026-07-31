// Contract test for src/render/occlusionQueryPatch.ts.
//
// r185's WebGPU backend ends occlusion queries that were never opened, which
// invalidates the whole command buffer and silently DROPS that pass's submit.
// Two paths trip it (see the patch header for the full mechanism):
//   1. a pass that LISTS an `occlusionTest` object and then declines to draw it
//      — every shadow pass, because ShadowNode skips `castShadow === false`;
//   2. a context whose occlusion count falls back to 0 while three's per-context
//      `lastOcclusionObject` is still set — a gate proxy being disposed.
// Path 1 starved the piano god-ray light's shadow map: the frame washes out
// because GodraysNode raymarches a map that was never written. Path 2 drops a
// main beauty-pass frame and is independent of god rays.
//
// The probe drives both paths with a stand-in shaped exactly like the real gate
// proxy (src/render/occlusionGate.ts) and asserts: zero occlusion/command-buffer
// validation errors, and that occlusion queries still resolve correctly — a
// proxy in front of an opaque wall reads visible, one behind it reads occluded.
//
// It also pins the companion efficiency fix: the proxy lives on
// SHADOW_LAYERS.BEAUTY_ONLY and every stock shadow camera is pinned to the
// beauty world, so shadow passes must report occlusionQueryCount === 0 (no query
// set created and destroyed per frame for a pass that opens none) while the
// beauty pass still reports one.
//
//   node tools/occlusion-query-probe.mjs          # defaults to :5240
//   SF_PROBE_URL=http://localhost:5251 node tools/occlusion-query-probe.mjs
import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://localhost:5240";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}
async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  for (const c of candidates) if (await exists(c)) return c;
  throw new Error("Chrome not found");
}

/**
 * Adds a mesh with the real gate proxy's exact flags, sampling its verdict the
 * way the gate does. `place` is either a metre offset along the live camera's
 * forward axis or an explicit [x, y, z] — pass explicit coordinates after
 * moving the camera, since the free-cam pose only lands once a frame renders.
 * `layer` defaults to 31 (SHADOW_LAYERS.BEAUTY_ONLY), matching the real gate
 * proxy; pass 0 to model an occlusion-tested object that shadow cameras DO list,
 * which is what the patch has to absorb.
 */
const ADD_PROXY = `(name, place, layer = 31) => {
  const sf = window.__sf, THREE = sf.THREE;
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true });
  const m = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), mat);
  m.name = name;
  m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
  m.occlusionTest = true;
  m.layers.set(layer);
  if (Array.isArray(place)) {
    m.position.set(place[0], place[1], place[2]);
  } else {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sf.camera.quaternion);
    m.position.copy(sf.camera.position).addScaledVector(fwd, place);
  }
  const rec = { name, samples: 0, occluded: 0, visible: 0, unresolved: 0 };
  m.onAfterRender = () => {
    rec.samples++;
    const v = sf.renderer.isOccluded(m);
    if (v === true) rec.occluded++; else if (v === false) rec.visible++; else rec.unresolved++;
  };
  sf.scene.add(m);
  return { m, rec };
}`;

/** Records occlusionQueryCount per render pass so shadow-pass churn is visible. */
const WATCH_COUNTS = `() => {
  const backend = window.__sf.renderer.backend;
  if (window.__occCounts) return;
  const passes = new Map();
  window.__occCounts = {
    reset: () => passes.clear(),
    dump: () => [...passes.values()]
  };
  const orig = backend.beginRender.bind(backend);
  backend.beginRender = function (rc) {
    if (rc.occlusionQueryCount > 0) {
      const rt = rc.renderTarget;
      const tex = rt ? (Array.isArray(rt.textures) ? rt.textures[0] : rt.texture) : null;
      const kind = rt ? ((tex && tex.name) || 'render-target') : 'canvas';
      const key = kind + '|' + (rc.camera && rc.camera.type);
      const rec = passes.get(key) || { key, kind, camera: rc.camera && rc.camera.type, passes: 0, maxCount: 0 };
      rec.passes++;
      rec.maxCount = Math.max(rec.maxCount, rc.occlusionQueryCount);
      passes.set(key, rec);
    }
    return orig(rc);
  };
}`;

const DROP = `(handle) => {
  if (!handle) return;
  handle.m.onAfterRender = () => {};
  handle.m.removeFromParent();
  handle.m.geometry.dispose();
  handle.m.material.dispose();
}`;

async function main() {
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
  const failures = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let occErrors = 0;
    page.on("console", (m) => {
      if (m.type() === "error" && /occlusion quer|invalid due to a previous error/i.test(m.text())) occErrors++;
    });
    await page.addInitScript(
      `window.__addProxy = ${ADD_PROXY}; window.__dropProxy = ${DROP}; window.__watchCounts = ${WATCH_COUNTS};`
    );

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=beachPianist`, {
      waitUntil: "domcontentloaded", timeout: 90_000
    });
    await page.waitForFunction(
      () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player && window.__sf?.pipeline),
      null, { timeout: 240_000 }
    );
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 300_000 });
    await page.evaluate(() => window.__sf.sky.setTimeOfDay(9.0));
    await page.waitForFunction(
      () => window.__sf.pipeline.pianoGodRaysState?.active === true,
      null, { timeout: 180_000 }
    );
    await sleep(2000);
    console.log("god rays:", JSON.stringify(await page.evaluate(() => window.__sf.pipeline.pianoGodRaysState)));

    // --- a real-shaped (BEAUTY_ONLY) proxy must reach the beauty pass only.
    // Shadow passes listing it would mean a GPU query set created and destroyed
    // every frame for a pass that never opens a query.
    await page.evaluate(() => { window.__watchCounts(); window.__p = window.__addProxy("probe_proxy", 60); });
    await sleep(6000);
    const counts = await page.evaluate(() => window.__occCounts.dump());
    for (const c of counts) {
      console.log(`  pass carrying queries: ${c.kind} (${c.camera}) — ${c.passes} passes, max count ${c.maxCount}`);
    }
    const shadowPasses = counts.filter((c) => /shadow/i.test(c.kind));
    if (shadowPasses.length) {
      failures.push(
        "shadow passes still list occlusion queries (per-frame query-set churn): " +
        shadowPasses.map((c) => `${c.kind}x${c.passes}`).join(", ")
      );
    }
    if (!counts.some((c) => !/shadow/i.test(c.kind))) {
      failures.push("no beauty pass carried an occlusion query — the gate proxy is not being drawn at all");
    }
    console.log(`beauty-only proxy: ${shadowPasses.length} shadow passes carried queries (want 0)`);

    // --- path 1 safety net: an occlusion-tested object that shadow cameras DO
    // list (layer 0) must still not produce a stray end. This is what the patch
    // absorbs, and the only guard if something later lands back on layer 0.
    const errsBeforeShadow = occErrors;
    await page.evaluate(() => { window.__layer0 = window.__addProxy("probe_proxy_layer0", 60, 0); });
    await sleep(6000);
    const layer0Counts = await page.evaluate(() => window.__occCounts.dump());
    const listedByShadow = layer0Counts.some((c) => /shadow/i.test(c.kind));
    const shadowErrs = occErrors - errsBeforeShadow;
    console.log(`path 1 (layer-0 object listed by the god-ray shadow pass: ${listedByShadow}): ${shadowErrs} errors`);
    if (!listedByShadow) {
      failures.push("layer-0 control was not listed by any shadow pass — path 1 went untested");
    }
    if (shadowErrs > 0) failures.push(`god-ray shadow pass produced ${shadowErrs} occlusion validation errors`);
    await page.evaluate(() => { window.__dropProxy(window.__layer0); window.__layer0 = null; });
    await sleep(600);

    // --- path 2: the proxy leaving the render list, god rays on and off
    for (const rays of [true, false]) {
      if (!rays) {
        await page.evaluate(() => {
          // See the note at the re-enable below: the god rays are a chain stage
          // now, and their tunable group is reached through it.
          window.__sf.pipeline.postChain.stage("godrays").tuning.group.values.enabled = false;
          window.__sf.pipeline.applyPianoGodRaysFx();
        });
        await sleep(1500);
      }
      const before = occErrors;
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => { window.__dropProxy(window.__p); window.__p = null; });
        await sleep(600);
        await page.evaluate(() => { window.__p = window.__addProxy("probe_proxy", 60); });
        await sleep(600);
      }
      const cycleErrs = occErrors - before;
      console.log(`path 2 (proxy add/remove cycles, godRays=${rays}): ${cycleErrs} errors`);
      if (cycleErrs > 0) failures.push(`proxy add/remove with godRays=${rays} produced ${cycleErrs} errors`);
    }
    await page.evaluate(() => { window.__dropProxy(window.__p); window.__p = null; });

    // --- queries must still resolve: visible in front of a wall, occluded behind it
    await page.evaluate(() => {
      // `__sf.POSTFX_TUNING.values.pianistRays` is gone with render/postfx.ts;
      // the god rays own a chain stage and their group lives on it.
      // `applyPianoGodRaysFx()` stays — the runtime is level-triggered from the
      // frame driver, so this only removes a frame of latency (and clears the
      // one-shot build-failure latch).
      window.__sf.pipeline.postChain.stage("godrays").tuning.group.values.enabled = true;
      window.__sf.pipeline.applyPianoGodRaysFx();
    });
    await page.waitForFunction(
      () => window.__sf.pipeline.pianoGodRaysState?.active === true, null, { timeout: 120_000 }
    );
    await page.evaluate(() => {
      const sf = window.__sf, THREE = sf.THREE;
      const p = sf.player.position;
      const eye = [p.x, p.y + 3, p.z];
      const look = [p.x + 60, p.y + 160, p.z + 60]; // up into clear sky
      window.__sfFreeCam(eye, look);
      const from = new THREE.Vector3(...eye);
      const fwd = new THREE.Vector3(...look).sub(from).normalize();
      const wall = new THREE.Mesh(new THREE.BoxGeometry(60, 60, 2), new THREE.MeshBasicMaterial({ color: 0x223344 }));
      wall.name = "probe_wall";
      wall.frustumCulled = false; wall.castShadow = false; wall.receiveShadow = false;
      wall.position.copy(from).addScaledVector(fwd, 40);
      wall.lookAt(from);
      sf.scene.add(wall);
      window.__wall = wall;
      const at = (d) => from.clone().addScaledVector(fwd, d).toArray();
      window.__front = window.__addProxy("in-front-of-wall", at(20));
      window.__behind = window.__addProxy("behind-wall", at(70));
    });
    await sleep(5000);
    const resolve = await page.evaluate(() => {
      const cam = window.__sf.camera;
      const ndc = (m) => { const v = m.position.clone().project(cam); return [+v.x.toFixed(2), +v.y.toFixed(2)]; };
      return {
        front: { ...window.__front.rec, ndc: ndc(window.__front.m) },
        behind: { ...window.__behind.rec, ndc: ndc(window.__behind.m) }
      };
    });
    const f = resolve.front, b = resolve.behind;
    const framed = (p) => Math.abs(p[0]) < 0.9 && Math.abs(p[1]) < 0.9;
    console.log(`resolution: in-front visible ${f.visible}/${f.samples} ndc=${JSON.stringify(f.ndc)}; behind occluded ${b.occluded}/${b.samples} ndc=${JSON.stringify(b.ndc)}`);
    if (!framed(f.ndc) || !framed(b.ndc)) failures.push("resolution proxies were not framed on screen");
    else {
      if (!(f.samples > 60 && f.visible / f.samples > 0.8)) failures.push("proxy in front of the wall did not read visible");
      if (!(b.samples > 60 && b.occluded / b.samples > 0.8)) failures.push("proxy behind the wall did not read occluded");
    }

    console.log(`\ntotal occlusion/command-buffer validation errors: ${occErrors}`);
    if (failures.length) {
      console.error("FAIL:");
      for (const m of failures) console.error("  -", m);
      process.exitCode = 1;
    } else {
      console.log("PASS — no stray occlusion queries, and queries still resolve correctly.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
