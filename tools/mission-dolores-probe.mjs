// Mission Dolores museum probe: verifies clean-boot/code/art loading boundaries,
// then shoots the façade, nave, mounted galleries, rebuilt apse, and DOM book.
//   node tools/mission-dolores-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = process.env.SF_OUT ?? path.join(ROOT, ".data", "mission-dolores-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout " + url); }
class Cdp {
  #ws; #id = 1; #p = new Map(); onEvent = null;
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }
      else if (m.method && this.onEvent) this.onEvent(m.method, m.params);
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + expr); }
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.05)"); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); const f = path.join(OUT, name); writeFileSync(f, Buffer.from(s.data, "base64")); console.log("  saved", f); return f; }
async function assertVisibleRays(onFile, offFile) {
  // Ignore the HUD-heavy perimeter and compare the same interior pixels. This
  // catches both a disconnected composite and a runaway full-screen wash.
  const crop = { left: 330, top: 100, width: 900, height: 700 };
  const on = await sharp(onFile).extract(crop).removeAlpha().raw().toBuffer();
  const off = await sharp(offFile).extract(crop).removeAlpha().raw().toBuffer();
  let difference = 0;
  let changed = 0;
  for (let i = 0; i < on.length; i++) {
    const delta = Math.abs(on[i] - off[i]);
    difference += delta;
    if (delta > 12) changed++;
  }
  const meanAbs = difference / on.length;
  const changedFraction = changed / on.length;
  if (meanAbs < 0.4 || changedFraction < 0.01 || meanAbs > 30) {
    throw new Error(`painting-ray A/B outside visual bounds: meanAbs=${meanAbs.toFixed(2)}, changed=${(changedFraction * 100).toFixed(1)}%`);
  }
  console.log("[probe] ray A/B:", JSON.stringify({ meanAbs: +meanAbs.toFixed(2), changedPct: +(changedFraction * 100).toFixed(1) }));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort), SF_HMR: "0" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  const consoleErrors = [];
  const requestFailures = [];
  const CX = 1560, CZ = 3235;
  let phase = "boot";
  const phaseRequests = { boot: [], approach: [], interior: [], exit: [], reentry: [], apse: [], bookOpen: [], bookPage: [], bookPage2: [] };
  try {
    await waitHttp(SERVER_URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    c.onEvent = (method, params) => {
      if (method === "Runtime.exceptionThrown") consoleErrors.push(`[exception] ${params.exceptionDetails?.text ?? ""} ${params.exceptionDetails?.exception?.description ?? ""}`);
      if (method === "Runtime.consoleAPICalled" && params.type === "error") consoleErrors.push(`[console.error] ${(params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
      if (method === "Network.requestWillBeSent") phaseRequests[phase].push(params.request.url);
      if (method === "Network.loadingFailed" && !params.canceled) requestFailures.push(`${params.errorText ?? "failed"}: ${params.blockedReason ?? ""}`);
    };
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    await evaluate(c, "window.__sfManual(true)");
    // With the wall-clock loop stopped, explicitly drain deferred construction
    // until the late covered warmup can declare the render graph idle.
    for (let i = 0; i < 900 && !(await evaluate(c, "window.__sf.renderIdle()")); i++) {
      await tick(c);
      if (i % 12 === 0) await sleep(60);
    }
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 240000);
    await sleep(600);

    const featureCode = (urls) => urls.filter((url) => /\/src\/world\/missionDolores\/(?:index|ctx|shell|exhibits)\b/.test(url));
    const radialEntryRequests = (urls) => urls.filter((url) => new URL(url).pathname.endsWith("/src/render/radialLightShafts.ts"));
    const radialFeatureRequests = (urls) => urls.filter((url) => /(?:radialLightShafts|tsl\/display\/radialBlur|three_addons_tsl_display_radialBlur)/.test(new URL(url).pathname));
    const francisMedia = (urls) => urls.filter((url) => url.includes("/francis/"));
    const francisArtStems = (urls) => [...new Set(francisMedia(urls).map((url) => new URL(url).pathname.replace(/\.(ktx2|webp)$/, "")))].sort();
    if (featureCode(phaseRequests.boot).length || francisMedia(phaseRequests.boot).length || radialFeatureRequests(phaseRequests.boot).length) {
      throw new Error(`clean boot fetched Mission Dolores: ${[...featureCode(phaseRequests.boot), ...francisMedia(phaseRequests.boot), ...radialFeatureRequests(phaseRequests.boot)].join(", ")}`);
    }
    const bootRadial = await evaluate(c, "window.__sf.pipeline.radialLightState");
    if (bootRadial.active || bootRadial.loaded || bootRadial.renderedFrames !== 0) throw new Error(`clean boot radial state: ${JSON.stringify(bootRadial)}`);

    // freeze the world for deterministic shots, warm midday light
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(14.0);
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);

    // First-use code/shell gate, still far enough that no exhibit art is useful.
    phase = "approach";
    const approachY = await evaluate(c, "window.__sf.player.position.y");
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; p.position.set(${CX},${approachY},${CZ - 120}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},${approachY},${CZ - 120}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 35; i++) await tick(c);
    await waitEval(c, "Boolean(window.__sf.missionDolores && window.__sf.missionDolores.group.children.length)", 120000);
    if (francisMedia(phaseRequests.approach).length) {
      throw new Error(`distant shell activation fetched art: ${francisMedia(phaseRequests.approach).join(", ")}`);
    }
    if (radialFeatureRequests(phaseRequests.approach).length) {
      throw new Error(`approach loaded radial feature code: ${radialFeatureRequests(phaseRequests.approach).join(", ")}`);
    }
    const approachRadial = await evaluate(c, "({inside:window.__sf.missionDolores.isPlayerInInterior(window.__sf.player.position),state:window.__sf.pipeline.radialLightState})");
    if (approachRadial.inside || approachRadial.state.active || approachRadial.state.loaded || approachRadial.state.renderedFrames !== 0) {
      throw new Error(`approach radial state: ${JSON.stringify(approachRadial)}`);
    }

    const floorTop = await evaluate(c, "window.__sf.missionDolores.floorTop");
    console.log("[probe] museum floorTop:", floorTop);

    // teleport the player into the nave so terrain around the church streams
    phase = "interior";
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${floorTop}+1.6; p.position.set(${CX},y,${CZ - 20}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ - 20}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 70; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    await waitEval(c, "window.__sf.missionDolores.isPlayerInInterior(window.__sf.player.position) && window.__sf.pipeline.radialLightState.active && window.__sf.pipeline.radialLightState.loaded", 120000);
    await sleep(2500); // let plaque/rose textures finish loading
    for (let i = 0; i < 20; i++) await tick(c);
    await waitEval(c, "window.__sf.missionDolores.radialLightSource.scene.children.length > 0", 120000);
    const interiorStems = francisArtStems(phaseRequests.interior);
    if (!interiorStems.length || interiorStems.length >= 20) {
      throw new Error(`interior should load a nearby subset of art, got ${interiorStems.length}`);
    }
    console.log("[probe] waterfall:", JSON.stringify({
      cleanBootFrancis: francisMedia(phaseRequests.boot).length,
      approachFrancis: francisMedia(phaseRequests.approach).length,
      interiorArtStems: interiorStems.length,
      radialFeatureRequests: radialFeatureRequests(phaseRequests.interior).length
    }));
    console.log("[probe] isPlayerInside:", await evaluate(c, `window.__sf.missionDolores.isPlayerInside(window.__sf.player.position)`));
    if (radialEntryRequests(phaseRequests.interior).length !== 1) {
      throw new Error(`interior should request one radial entry module, got ${radialEntryRequests(phaseRequests.interior).length}`);
    }
    const interiorRadial = await evaluate(c, "window.__sf.pipeline.radialLightState");
    if (!interiorRadial.active || !interiorRadial.loaded || interiorRadial.renderedFrames <= 0) {
      throw new Error(`interior radial state: ${JSON.stringify(interiorRadial)}`);
    }

    const setCam = (px, py, pz, lx, ly, lz) => evaluate(c, `(()=>{const c=window.__sf.camera; c.position.set(${px},${py},${pz}); c.lookAt(${lx},${ly},${lz}); return 1;})()`);
    const F = floorTop;
    const frame = async (name, cam, look) => {
      await setCam(...cam, ...look);
      for (let k = 0; k < 3; k++) await tick(c);
      await setCam(...cam, ...look);
      await sleep(300);
      await shot(c, name);
    };

    // 1. façade + bell towers (from outside the entrance, local -z / world z<2976)
    await frame("md_1_facade.jpg", [CX, F + 7, CZ - 62], [CX, F + 9, CZ - 30]);
    // 2. 3/4 aerial of the whole basilica
    await frame("md_2_aerial.jpg", [CX + 46, F + 26, CZ - 52], [CX, F + 6, CZ - 4]);
    // 3. nave interior toward the altar/apse
    await frame("md_3_nave_altar.jpg", [CX, F + 2.6, CZ - 26], [CX, F + 3.5, CZ + 32]);
    // 4. nave interior looking back toward the rose window over the portal
    await frame("md_4_nave_rose.jpg", [CX, F + 3.2, CZ + 12], [CX, F + 8.5, CZ - 35]);
    // 5. side view down a colonnade aisle (west gallery) toward the altar
    await frame("md_5_west_aisle_rays_on.jpg", [CX - 10, F + 2.4, CZ - 24], [CX - 10, F + 2.6, CZ + 20]);
    const raysOnFrames = await evaluate(c, "window.__sf.pipeline.radialLightState.renderedFrames");
    await evaluate(c, "(()=>{const s=window.__sf;s.POSTFX_TUNING.values.museumRays=false;s.pipeline.applyRadialLightFx();return s.pipeline.radialLightState;})()");
    await frame("md_5_west_aisle_rays_off.jpg", [CX - 10, F + 2.4, CZ - 24], [CX - 10, F + 2.6, CZ + 20]);
    await assertVisibleRays(
      path.join(OUT, "md_5_west_aisle_rays_on.jpg"),
      path.join(OUT, "md_5_west_aisle_rays_off.jpg")
    );
    const raysOff = await evaluate(c, "window.__sf.pipeline.radialLightState");
    if (raysOff.active || raysOff.loaded || raysOff.renderedFrames !== raysOnFrames) {
      throw new Error(`disabled radial state: ${JSON.stringify(raysOff)}, expected frames=${raysOnFrames}`);
    }
    await evaluate(c, "(()=>{const s=window.__sf;s.POSTFX_TUNING.values.museumRays=true;s.pipeline.applyRadialLightFx();return s.pipeline.radialLightState;})()");
    await tick(c);
    await waitEval(c, "window.__sf.pipeline.radialLightState.active && window.__sf.pipeline.radialLightState.loaded", 120000);
    await tick(c);
    const raysRestored = await evaluate(c, "window.__sf.pipeline.radialLightState");
    if (!raysRestored.active || !raysRestored.loaded || raysRestored.renderedFrames <= raysOnFrames) {
      throw new Error(`restored radial state: ${JSON.stringify(raysRestored)}`);
    }
    // 8. upward at an angle (offset so lookAt isn't degenerate) — vault ceiling check
    await frame("md_8_ceiling.jpg", [CX - 5, F + 2, CZ - 10], [CX + 3, F + 13, CZ + 2]);

    // Crossing back through the entrance immediately drops/disposes the optional
    // graph; re-entry reuses the already fetched module without another request.
    phase = "exit";
    const beforeExitFrames = await evaluate(c, "window.__sf.pipeline.radialLightState.renderedFrames");
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${F}+1.6; p.position.set(${CX},y,${CZ - 35}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ - 35}],[0,0,0,1]); return 1;})()`);
    await tick(c);
    const exited = await evaluate(c, "({inside:window.__sf.missionDolores.isPlayerInInterior(window.__sf.player.position),state:window.__sf.pipeline.radialLightState})");
    await tick(c);
    const exitedStable = await evaluate(c, "window.__sf.pipeline.radialLightState");
    if (
      exited.inside ||
      exited.state.active ||
      exited.state.loaded ||
      exitedStable.active ||
      exitedStable.loaded ||
      exitedStable.renderedFrames !== exited.state.renderedFrames
    ) {
      throw new Error(`exit radial state: before=${beforeExitFrames}, first=${JSON.stringify(exited)}, stable=${JSON.stringify(exitedStable)}`);
    }
    if (radialFeatureRequests(phaseRequests.exit).length) throw new Error(`exit fetched radial code: ${radialFeatureRequests(phaseRequests.exit).join(", ")}`);

    phase = "reentry";
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${F}+1.6; p.position.set(${CX},y,${CZ - 20}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ - 20}],[0,0,0,1]); return 1;})()`);
    await tick(c);
    await waitEval(c, "window.__sf.missionDolores.isPlayerInInterior(window.__sf.player.position) && window.__sf.pipeline.radialLightState.active && window.__sf.pipeline.radialLightState.loaded", 120000);
    await tick(c);
    const reentered = await evaluate(c, "window.__sf.pipeline.radialLightState");
    if (reentered.renderedFrames <= exitedStable.renderedFrames) throw new Error(`re-entry did not resume radial frames: ${JSON.stringify(reentered)}`);
    if (radialFeatureRequests(phaseRequests.reentry).length) throw new Error(`re-entry refetched radial code: ${radialFeatureRequests(phaseRequests.reentry).join(", ")}`);

    // Walk the visitor into the sanctuary art wake radius, then inspect the
    // centered hierarchy and both curved-wall mounts at grazing angles.
    phase = "apse";
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${F}+1.6; p.position.set(${CX},y,${CZ + 18}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ + 18}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 24; i++) await tick(c);
    await sleep(1000);
    await frame("md_9_apse_center.jpg", [CX, F + 2.3, CZ + 17], [CX, F + 3.2, CZ + 34]);
    await frame("md_10_apse_west.jpg", [CX - 6.5, F + 2.5, CZ + 26], [CX, F + 3.2, CZ + 34]);
    await frame("md_11_apse_east.jpg", [CX + 6.5, F + 2.5, CZ + 26], [CX, F + 3.2, CZ + 34]);

    // 6. Open the DOM Canticle reader. It may request only the current spread.
    phase = "bookOpen";
    const opened = await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${F}+1.6; p.position.set(${CX},y,${CZ - 28}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ - 28}],[0,0,0,1]);
      s.camera.position.set(${CX}, y, ${CZ - 24}); s.camera.lookAt(${CX}, y, ${CZ + 10});
      s.missionDolores.tryInteract(p.position, 'walk', { message(){} }); return s.missionDolores.bookOpen; })()`);
    console.log("[probe] book opened:", opened, "museumBookOpen(render branch active):", await evaluate(c, `!!window.__sf.missionDolores.bookOpen`));
    for (let i = 0; i < 12; i++) await tick(c);
    await sleep(250);
    const bookOpenStems = francisArtStems(phaseRequests.bookOpen);
    if (bookOpenStems.length !== 1 || bookOpenStems[0] !== "/francis/art/canticle-cover") {
      throw new Error(`opening the Canticle should request only its cover art, got ${bookOpenStems.join(", ") || "nothing"}`);
    }
    console.log("[probe] bookdbg:", JSON.stringify(await evaluate(c, `(()=>{const s=window.__sf; const cam=s.camera; const found=[]; s.scene.traverse(o=>{ if(o.renderOrder>=990){ const wp=new s.THREE.Vector3(); o.getWorldPosition(wp); found.push({n:o.name||o.type, ro:o.renderOrder, vis:o.visible, wp:[+wp.x.toFixed(1),+wp.y.toFixed(1),+wp.z.toFixed(1)], mat:o.material&&o.material.type}); } }); const cp=cam.position; return {count:found.length, cam:[+cp.x.toFixed(1),+cp.y.toFixed(1),+cp.z.toFixed(1)], sample:found.slice(0,4)}; })()`)));
    await sleep(600);
    await shot(c, "md_6_book_cover.jpg");
    // Each page turn is its own waterfall phase: selecting one spread must
    // request exactly that spread, never the rest of the Canticle catalog.
    phase = "bookPage";
    await evaluate(c, `(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'})); return 1;})()`);
    for (let i = 0; i < 12; i++) await tick(c);
    await sleep(500);
    await shot(c, "md_7_book_page.jpg");
    const bookPageStems = francisArtStems(phaseRequests.bookPage);
    if (bookPageStems.length !== 1 || bookPageStems[0] !== "/francis/art/francis-portrait") {
      throw new Error(`first page turn should request only the Francis portrait, got ${bookPageStems.join(", ") || "nothing"}`);
    }

    phase = "bookPage2";
    await evaluate(c, `(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'})); return 1;})()`);
    for (let i = 0; i < 12; i++) await tick(c);
    await sleep(500);
    await shot(c, "md_7b_book_brother_sun.jpg");
    const bookPage2Stems = francisArtStems(phaseRequests.bookPage2);
    if (bookPage2Stems.length !== 1 || bookPage2Stems[0] !== "/francis/art/canticle-brother-sun") {
      throw new Error(`second page turn should request only Brother Sun, got ${bookPage2Stems.join(", ") || "nothing"}`);
    }

    console.log("[probe] console errors:", consoleErrors.length ? "\n  " + consoleErrors.slice(0, 20).join("\n  ") : "(none)");
    if (consoleErrors.length || requestFailures.length) throw new Error(`browser errors=${consoleErrors.length}, request failures=${requestFailures.length}`);
    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
