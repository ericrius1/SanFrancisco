// Close-up night capture for the Afterlight cosmic energy web.
//
// Reuses a running server (SF_PROBE_URL) or nothing else — launches headless
// Chrome with WebGPU, drives __sf.tick() manually (the MCP preview pane rAF-
// deadlocks this app), frames the celebrant ring + web up close at night, and
// captures ambient + full-energy stills. Also prints the FULL stack of any
// runtime exception so we can tell ours from pre-existing boot noise.
//
//   SF_PROBE_URL=http://localhost:5240 node tools/afterlight-web-shot.mjs
//
// Env: SF_TIME (default 22 = night), SF_SHOT_OUT (default .data/afterlight-web-shot)

import { spawn } from "node:child_process";
import { constants as fsConstants, mkdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_SHOT_OUT ?? ".data/afterlight-web-shot");
const URL_BASE = process.env.SF_PROBE_URL?.trim() || "http://localhost:5240";
const WIDTH = Number(process.env.SF_SHOT_WIDTH ?? 1600);
const HEIGHT = Number(process.env.SF_SHOT_HEIGHT ?? 900);
const TIME_OF_DAY = Number(process.env.SF_TIME ?? 22);
const CENTER = { x: 208, z: 2456 };
const PARTICIPANT = { x: CENTER.x + Math.cos(0.4) * 9.2, z: CENTER.z + Math.sin(0.4) * 9.2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function executable(cands) {
  for (const c of cands.filter(Boolean)) {
    if (c.includes(path.sep)) { try { await access(c, fsConstants.X_OK); return c; } catch { continue; } }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue; const full = path.join(dir, c);
      try { await access(full, fsConstants.X_OK); return full; } catch { /* keep looking */ }
    }
  }
  return null;
}
const findChrome = () => executable([
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome", "chromium"
]);
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res(a.port)); });
  });
}
async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch { /* poll */ }
    await sleep(200);
  }
  throw new Error("CDP endpoint never opened");
}

class Cdp {
  #ws; #id = 1; #pending = new Map(); #listeners = new Map();
  constructor(url) { this.#ws = new WebSocket(url); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.id) { const p = this.#pending.get(m.id); if (!p) return; this.#pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result ?? {}); return; }
      for (const l of this.#listeners.get(m.method) ?? []) l(m.params ?? {});
    });
  }
  on(method, l) { const a = this.#listeners.get(method) ?? []; a.push(l); this.#listeners.set(method, a); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#pending.set(id, { resolve: res, reject: rej })); }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function waitEval(cdp, expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await evaluate(cdp, expr)) return; } catch { /* ctx swap */ } await sleep(350); }
  throw new Error(`timeout waiting for ${label}`);
}
const tick = (cdp, dt) => evaluate(cdp, `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`);
async function settle(cdp, frames, dt = 1 / 30, gapMs = 16) { for (let i = 0; i < frames; i++) { await tick(cdp, dt); if (gapMs) await sleep(gapMs); } }

async function setCamera(cdp, eye, target) {
  await evaluate(cdp, `(()=>{const s=window.__sf,c=s.camera;window.__shotCam={eye:[${eye}],target:[${target}]};
    if(!window.__shotPatched){window.__shotPatched=true;s.chase.update=()=>{const p=window.__shotCam;c.position.set(...p.eye);c.up.set(0,1,0);c.lookAt(...p.target);c.updateMatrixWorld();};}
    c.position.set(${eye});c.up.set(0,1,0);c.lookAt(${target});c.updateMatrixWorld();return true;})()`);
}
async function capture(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const buf = Buffer.from(r.data, "base64");
  writeFileSync(path.join(OUT, `${name}.png`), buf);
  console.log(`[shot] ${name}.png (${Math.round(buf.length / 1024)} KiB)`);
}

async function performanceSnapshot(cdp) {
  return evaluate(cdp, `(async()=>{const s=window.__sf,a=s.afterlight,samples=[];for(let i=0;i<90;i++){const t=performance.now();s.tick(1/60);samples.push(performance.now()-t);await new Promise(r=>requestAnimationFrame(r));}samples.sort((x,y)=>x-y);let renderables=0,triangles=0,raymarched=0;a.root.traverse(o=>{if(!o.visible)return;if(o.isMesh||o.isPoints||o.isSprite){renderables++;const g=o.geometry;if(g){triangles+=(g.index?.count??g.attributes?.position?.count??0)/3;}const mats=Array.isArray(o.material)?o.material:[o.material];if(mats.some(m=>m?.fragmentNode))raymarched++;}});const info=s.renderer.info;return {frameCpuMs:{average:samples.reduce((sum,v)=>sum+v,0)/samples.length,p95:samples[Math.floor(samples.length*0.95)],max:samples.at(-1)},feature:{renderables,triangles:Math.round(triangles),raymarchedOrbs:raymarched,web:a.debugState().takeover.web},renderer:{calls:info.render.calls,triangles:info.render.triangles,geometries:info.memory.geometries,textures:info.memory.textures},viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};})()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await findChrome();
  if (!chrome) throw new Error("no chrome");
  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-web-shot-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const proc = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--enable-gpu", "--use-angle=metal",
    `--window-size=${WIDTH},${HEIGHT}`, "--force-device-scale-factor=1", "about:blank"
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.stderr.on("data", () => {});

  await waitForCdp(debugPort);
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const d = exceptionDetails;
    const where = d?.url ? `${d.url}:${d.lineNumber}:${d.columnNumber}` : "";
    console.log(`[shot] EXCEPTION: ${(d?.exception?.description || d?.text || "").split("\n").slice(0, 4).join(" | ")} @ ${where}`);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  const boot = new URL(URL_BASE);
  boot.searchParams.set("autostart", "1");
  boot.searchParams.set("fullfps", "1");
  boot.searchParams.set("profile", "1");
  boot.searchParams.set("j", `${CENTER.x},175,${CENTER.z},0,walk`);
  console.log(`[shot] navigating ${boot}`);
  await cdp.send("Page.navigate", { url: boot.toString() });

  await waitEval(cdp, "Boolean(window.__sf?.afterlight && window.__sf?.player && window.__sf?.renderer && window.__sf?.renderIdle && window.__sfManual)", 180000, "__sf");
  await evaluate(cdp, "window.__sf.afterlight.ready.then(()=>true)");
  await waitEval(cdp, "window.__sf.renderIdle()", 120000, "renderIdle");
  await evaluate(cdp, `window.__sfManual(true);const sky=window.__sf.sky;sky.cycleEnabled=false;sky.setTimeOfDay(${TIME_OF_DAY});document.body.classList.add('started');true`);

  // Wake the site: teleport to centre, then step out toward the camera so the
  // player doesn't stand inside the web.
  await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player,y=s.map.groundHeight(${CENTER.x},${CENTER.z});p.teleportTo({x:${CENTER.x},y:y+1.5,z:${CENTER.z},facing:0,mode:'walk'});return true;})()`);
  await settle(cdp, 20, 1 / 30, 20);
  const groundY = await evaluate(cdp, `window.__sf.map.groundTop(${CENTER.x},${CENTER.z})`);

  const eyeA = [CENTER.x - 7, groundY + 6.5, CENTER.z + 17];
  const eyeB = [CENTER.x + 3, groundY + 3.6, CENTER.z + 12.5];
  const tgt = [CENTER.x, groundY + 3.1, CENTER.z];

  // Ambient (idle) energy.
  await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player,y=s.map.groundHeight(${CENTER.x},${CENTER.z + 15});p.teleportTo({x:${CENTER.x},y:y+1.5,z:${CENTER.z + 15},facing:Math.PI,mode:'walk'});return true;})()`);
  await setCamera(cdp, eyeA, tgt);
  await settle(cdp, 60, 1 / 30, 16);
  await capture(cdp, "ambient-wide");
  await setCamera(cdp, eyeB, tgt);
  await settle(cdp, 30, 1 / 30, 16);
  await capture(cdp, "ambient-hero");

  // Claim the east participant and drive a deliberate mirrored two-hand pull.
  // This proves the avatar/halo side of the sculpture, not only its wide net.
  await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player,y=s.map.groundHeight(${PARTICIPANT.x},${PARTICIPANT.z});p.teleportTo({x:${PARTICIPANT.x},y:y+1.5,z:${PARTICIPANT.z},facing:Math.PI,mode:'walk'});return true;})()`);
  const takeoverEye = [PARTICIPANT.x + 4.6, groundY + 3.4, PARTICIPANT.z + 6.4];
  const takeoverTarget = [PARTICIPANT.x, groundY + 1.8, PARTICIPANT.z];
  await setCamera(cdp, takeoverEye, takeoverTarget);
  await settle(cdp, 18, 1 / 30, 14);
  await capture(cdp, "approach-prompt");
  await evaluate(cdp, `(()=>{const s=window.__sf,a=s.afterlight;a.tryInteract(s.player,s.hud);s.input.device='kb';s.input.mouseDX=155;s.input.mouseDY=-105;s.input.wheel=-95;return a.debugState();})()`);
  await settle(cdp, 42, 1 / 30, 14);
  await capture(cdp, "takeover-hero");
  await evaluate(cdp, "(()=>{const s=window.__sf;if(s.afterlight.controlsCaptured)s.afterlight.tryInteract(s.player,s.hud);return true;})()");

  // Full energy (finale surge — spins up whale + max web energy + arms high).
  await evaluate(cdp, "window.__sf.afterlight.debugComplete(window.__sf.hud); true");
  await setCamera(cdp, eyeA, tgt);
  await settle(cdp, 120, 1 / 30, 12);
  await capture(cdp, "full-wide");
  await setCamera(cdp, eyeB, tgt);
  await settle(cdp, 30, 1 / 30, 16);
  await capture(cdp, "full-hero");

  const performance = await performanceSnapshot(cdp);
  writeFileSync(path.join(OUT, "performance.json"), JSON.stringify(performance, null, 2));
  console.log(`[shot] performance ${JSON.stringify(performance)}`);

  console.log(`[shot] done → ${OUT}`);
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
}
main().catch((e) => { console.error("[shot] FAIL", e); process.exitCode = 1; });
