// Tea-master (Iroh) hand/cup/costume probe. Boots headless, teleports to the
// Japanese Tea Garden, waits for Iroh to build, and screenshots the two-hand
// cup cradle, the costume, the steam, and the free-armed state after the tea is
// handed off. Also reads cupToLeftHand/cupToRightHand from debugState as the
// numeric grasp truth.
//
//   node tools/tea-master-probe.mjs
// Env: SF_PROBE_OUT (default .data/tea-master-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/tea-master-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5251";
const W = 1280, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tea garden guide home (see layout.ts GUIDE_HOME)
const HOME = { x: -2278.7, z: 2170.6 };

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}

class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { try { this.#ws.close(); } catch {} }
}
let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function ticks(c, n, dt) { for (let i = 0; i < n; i++) await tick(c, dt); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(40); } }

// The tea garden is a DEFERRED region: teleporting in re-arms the late render
// warmup, during which tick() early-returns without rendering OR running the
// cineHook. Ticking does not advance that async GPU warmup — only yielding the
// event loop does — so we sleep-poll renderIdle, THEN render real cine frames
// so both the camera AND the composited swapchain reflect the freecam view.
async function ensureLive(c, label = "") {
  for (let i = 0; i < 80; i++) {
    if (await ev(c, "!!window.__sf.renderIdle?.()")) return true;
    await tick(c, 1 / 60); // reach the warmup-trigger branch inside tick()
    await sleep(150); // let the async pipeline.warmup() settle
  }
  console.log(`[probe] WARN renderIdle never true ${label}`);
  return false;
}

async function shot(c, name) {
  await ensureLive(c, name);
  // Belt-and-suspenders: keep the garden subtree visible (the distance wake can
  // re-hide it between shots in the manual-tick flow).
  await ev(c, `(()=>{const g=window.__sf.scene.getObjectByName('japanese_tea_garden'); if(g){g.visible=true; g.traverseAncestors(a=>{a.visible=true;});} return true;})()`);
  // Real-dt frames: cineHook runs + swapchain composites (rAF inside frame()).
  await tick(c, 1 / 60);
  await tick(c, 1 / 60);
  await tick(c, 0);
  await sleep(150); // headless WebGPU present → compositor before capture
  const idle = await ev(c, "!!window.__sf.renderIdle?.()");
  const cam = await ev(c, `(()=>{const p=window.__sf.camera.position;return [p.x,p.y,p.z].map(x=>Math.round(x*10)/10);})()`);
  const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(s.data, "base64"));
  console.log(`[probe] shot ${name} idle=${idle} cam=${JSON.stringify(cam)}`);
}

/** Frame the camera in front of Iroh using his live cup position + facing from
 *  debugState (robust — no scene lookups). `dist` = m in front of the cup, `up`
 *  = m above the look target, `focusUp` raises the look target off the cup. */
async function frameOn(c, dist, up, focusUp = 0) {
  return ev(c, `(()=>{
    const d = window.__sf.japaneseTeaGarden.debugState().guide.iroh;
    const p = d.cupWorldPos, yaw = d.yaw;
    // rig faces local -Z; world front = (-sin(yaw), 0, -cos(yaw))
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const look = [p[0], p[1] + ${focusUp}, p[2]];
    const eye = [p[0] + fx * ${dist}, p[1] + ${up}, p[2] + fz * ${dist}];
    const has = typeof window.__sfFreeCam;
    if (has === 'function') window.__sfFreeCam(eye, look);
    const cam = window.__sf.camera.position;
    return JSON.stringify({ has, cupWorldPos: p, yaw: Math.round(yaw*100)/100, eye: eye.map(x=>Math.round(x)), camAfter: [cam.x,cam.y,cam.z].map(x=>Math.round(x)) });
  })()`);
}

async function irohState(c) {
  return ev(c, `(()=>{ const d = window.__sf.japaneseTeaGarden.debugState(); const i = d.guide.iroh; return {
    awake: d.awake, phase: d.guide.phase, action: i.action,
    cupL: Math.round(i.cupToLeftHand*1000)/1000,
    cupR: Math.round(i.cupToRightHand*1000)/1000,
    hasCup: i.hasCup, presentT: Math.round((i.presentT??-1)*100)/100, ikError: i.ikError,
    playerDist: Math.round(d.guide.playerDistance*10)/10
  }; })()`);
}

async function costumeContract(c) {
  return ev(c, `(()=>{
    const actor=window.__sf.scene.getObjectByName('tea_master_iroh');
    if(!actor)throw new Error('Iroh runtime actor missing');
    const required=[
      'iroh_stone_under_robe','iroh_navy_open_over_robe','iroh_navy_front_apron',
      'iroh_white_lotus_mantle','iroh_stone_bell_sleeve_L','iroh_stone_bell_sleeve_R',
      'iroh_wide_obi','tea_master_round_face'
    ];
    const heroMask=1<<10, result={};
    for(const name of required){
      const mesh=actor.getObjectByName(name);
      if(!mesh?.isMesh)throw new Error('Iroh runtime garment missing: '+name);
      const position=mesh.geometry?.attributes?.position;
      if(!position?.count)throw new Error('Iroh garment has no vertices: '+name);
      mesh.geometry.computeBoundingBox();
      const box=mesh.geometry.boundingBox;
      const bounds=[box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
      if(!bounds.every(Number.isFinite))throw new Error('Iroh garment has invalid bounds: '+name);
      if(mesh.castShadow&&(mesh.layers.mask&heroMask)===0)throw new Error('Iroh caster missing HERO_DYNAMIC layer: '+name);
      result[name]={vertices:position.count,heroShadow:!!(mesh.layers.mask&heroMask)};
    }
    return result;
  })()`);
}

async function resourceUrls(c) {
  return ev(c, `performance.getEntriesByType('resource').map(entry=>entry.name)`);
}

function teaFeatureUrls(urls) {
  return urls.filter((url) =>
    (
      url.includes("japaneseTeaGarden") ||
      url.includes("irohCostume") ||
      url.includes("teaMaster")
    ) && !url.includes("/layout.ts")
  );
}

async function dumpHands(c) {
  return ev(c, `(()=>{
    const s = window.__sf, T = s.THREE;
    const iroh = s.scene.getObjectByName('tea_master_iroh');
    if (!iroh) return 'no iroh';
    const find = (n) => { let f=null; iroh.traverse(o=>{ if(o.name===n && !f) f=o; }); return f; };
    const wp = (o) => { if(!o) return null; const v=new T.Vector3(); o.getWorldPosition(v); return v.toArray().map(x=>Math.round(x*100)/100); };
    const rot = (o) => o ? [o.rotation.x,o.rotation.y,o.rotation.z].map(x=>Math.round(x*100)/100) : null;
    const cup = find('tea_master_cup');
    return JSON.stringify({
      cup: wp(cup), cupVisible: cup ? cup.visible : null,
      handL: wp(find('hand-L')), handR: wp(find('hand-R')),
      armL: rot(find('hand-L')?.parent?.parent), foreL: rot(find('hand-L')?.parent),
      armLrot: rot(iroh.getObjectByName ? null : null)
    });
  })()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDevIfNeeded();

  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);

  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
      console.log("[page-exception]", pageErrors[pageErrors.length - 1]);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const msg = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(msg);
      console.log("[page-error]", msg);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await ev(c, `(()=>{performance.setResourceTimingBufferSize(5000);return true;})()`);

  console.log("[probe] waiting for __sf...");
  // The tea garden is a DEFERRED region: it does NOT exist at boot unless the
  // spawn happens to be beside it. So wait only for the app + manual hook here;
  // the garden is woken explicitly by teleporting next to it below.
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) {
    try { if (await ev(c, "!!(window.__sf && window.__sfManual && window.__sf.player)")) { ready = true; break; } } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("__sf never ready");
  // Then let the deferred render warmup clear (wall clock still running) so
  // tick() actually renders — otherwise screenshots capture a stale frame.
  for (let i = 0; i < 40; i++) { if (await ev(c, "!!window.__sf.renderIdle?.()")) break; await sleep(400); }
  await ev(c, "window.__sfManual(true)");
  await ev(c, "(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(15);return true;})()");
  await ev(c, `(()=>{Object.defineProperty(document,"hasFocus",{value:()=>true});
    window.__sf.hud?.setHidden?.(true);
    const loading=document.getElementById('loading'); if(loading)loading.style.display='none';
    return true;})()`);

  // The Tea Garden and Iroh must stay off a clean distant boot. This procedural
  // costume adds no media requests, but its code must still cross the existing
  // first-approach dynamic-import gate.
  const bootTeaRequests = teaFeatureUrls(await resourceUrls(c));
  if (bootTeaRequests.length) throw new Error(`Tea Garden loaded eagerly at boot: ${bootTeaRequests.join(", ")}`);
  await ev(c, `(()=>{performance.clearResourceTimings();return true;})()`);

  // Teleport ~3.4 m in front of Iroh so the garden wakes and he's in start range.
  await ev(c, `(()=>{const s=window.__sf;const x=${HOME.x},z=${HOME.z}+3.4;const y=s.map.effectiveGround(x,z)+1.2;s.player.teleportTo({x,y,z,facing:Math.PI,mode:"walk"});return true;})()`);
  // The tea garden is DEFERRED: being within 900 m of the entrance + one tick
  // fires wakeDeferredTeaGarden, then buildTeaGarden() runs async (module import
  // + vegetation.ready). Tick to trip the wake, sleep to let the async build
  // resolve, then poll until the site object is exposed on __sf.
  // `japaneseTeaGarden` (the JS object) is exposed BEFORE the group is added to
  // the scene: the deferred path scene.add()s only after compileAsync resolves.
  // Poll for actual scene membership so force-visible below can find the group.
  let built = false;
  for (let i = 0; i < 120; i++) {
    await tick(c, 1 / 30);
    if (await ev(c, "!!window.__sf.scene.getObjectByName('japanese_tea_garden')")) { built = true; break; }
    await sleep(250);
  }
  if (!built) throw new Error("tea garden never added to scene after teleport");
  const activationResources = await resourceUrls(c);
  const activationTeaRequests = teaFeatureUrls(activationResources);
  if (!activationTeaRequests.length) {
    throw new Error(`Tea Garden activation requested no feature modules; recent resources: ${activationResources.slice(-20).join(", ")}`);
  }
  console.log("[probe] tea garden in scene");
  // Headless manual-tick flow does not reliably run the garden's distance-driven
  // wake, so the garden group can stay visible=false (invisible) even standing
  // beside Iroh. Force the subtree visible + compiled so the render is honest.
  console.log("[probe] force-visible:", await ev(c, `(async()=>{
    const s = window.__sf;
    const g = s.scene.getObjectByName('japanese_tea_garden');
    if (!g) return 'no-garden';
    g.visible = true; g.traverseAncestors(a => { a.visible = true; });
    try { await s.renderer.compileAsync(g, s.camera, s.scene); } catch (e) { return 'compile-fail:' + e; }
    return 'ok visible=' + g.visible;
  })()`));
  // let the garden wake + Iroh build + poses settle, and any region warmup clear
  await settle(c, 40);
  await ticks(c, 90, 1 / 30);
  for (let i = 0; i < 60 && !(await ev(c, "window.__sf.renderIdle()")); i++) await tick(c, 1 / 30);
  console.log("[probe] state after wake:", JSON.stringify(await irohState(c)));
  console.log("[probe] costume contract:", JSON.stringify(await costumeContract(c)));

  // ---- idle: both hands cradle the bowl ----
  console.log("[frameOn grasp]", await frameOn(c, 1.0, 0.15, 0.02)); // grasp close-up on the cup
  await ticks(c, 20, 1 / 30);
  console.log("[cam after tick]", await ev(c, `(()=>{const p=window.__sf.camera.position;return JSON.stringify([p.x,p.y,p.z].map(x=>Math.round(x)));})()`));
  await shot(c, "grasp_close");
  console.log("[grasp idle]", JSON.stringify(await irohState(c)));
  console.log("[hands idle]", await dumpHands(c));

  await frameOn(c, 3.0, 0.7, -0.15); // full costume
  await shot(c, "costume_wide");
  await frameOn(c, 0.95, 0.5, 0.62); // face/beard/topknot
  await shot(c, "face_close");

  // ---- welcome → serve → handoff ----
  const started = await ev(c, `window.__sf.japaneseTeaGarden.interact(window.__sf.player.position, window.__sf.player.mode)`);
  console.log("[probe] interact(welcome) =>", started);
  await ticks(c, 45, 1 / 30);
  await frameOn(c, 1.15, 0.2, 0.05); // offering
  await shot(c, "welcome");
  console.log("[welcome]", JSON.stringify(await irohState(c)));

  // advance to the serve (offer) beat
  await ev(c, `window.__sf.japaneseTeaGarden.interact(window.__sf.player.position, window.__sf.player.mode)`);
  await ticks(c, 45, 1 / 30);
  await shot(c, "serve_offer");
  console.log("[serve]", JSON.stringify(await irohState(c)));
  console.log("[hands serve]", await dumpHands(c));

  // advance PAST serve → tea handed off → his arms free up
  await ev(c, `window.__sf.japaneseTeaGarden.interact(window.__sf.player.position, window.__sf.player.mode)`);
  await ticks(c, 60, 1 / 30);
  // This frame exists to inspect Iroh's free-arm silhouette; the dialogue card
  // otherwise covers his head, shoulder yoke and most of both sleeves.
  await ev(c, `(()=>{for(const el of document.querySelectorAll('.projected-dialogue'))el.style.visibility='hidden';return true;})()`);
  await frameOn(c, 3.0, 0.7, -0.1); // free-armed after handoff
  await shot(c, "handoff_freearm");
  console.log("[handoff]", JSON.stringify(await irohState(c)));

  const activationSet = new Set(activationTeaRequests);
  const subsequentTeaRequests = teaFeatureUrls(await resourceUrls(c)).filter((url) => !activationSet.has(url));
  if (subsequentTeaRequests.length) {
    throw new Error(`Iroh interactions fetched unexpected feature modules: ${subsequentTeaRequests.join(", ")}`);
  }
  console.log(`[probe] lazy requests boot=0 activation=${activationTeaRequests.length} subsequent=0`);

  console.log("[probe] page errors:", pageErrors.length);
  if (pageErrors.length) console.log(pageErrors.slice(0, 5).join("\n"));
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error("[probe] FAIL", e); cleanup(); process.exit(1); });
