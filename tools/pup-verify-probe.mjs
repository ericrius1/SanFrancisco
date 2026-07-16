// Verification + progress-capture probe for Biscuit, the RL pup on Marina Green.
// Boots the app in headless Chrome (WebGPU/metal) on its OWN vite port, walks the
// player to the pen (waking the lazy site), asserts the pup is alive and driven by
// the current training checkpoint, and screenshots it (wide + close).
//
//   node tools/pup-verify-probe.mjs [--out DIR] [--label NAME]
//
// Used both for one-shot verification and by the overnight hourly progress loop
// (--out .data/creature-nursery --label hour-03).
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argOf = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const OUT = path.resolve(ROOT, argOf("out", ".data/pup-verify"));
const LABEL = argOf("label", "pup");
const PORT = 5237;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const W = 1280, H = 720, DT = 1 / 30;
const PEN = { x: -650, z: -1640 }; // keep in sync with src/gameplay/pup/meta.ts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue; return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}: ${url}`); }
async function startDev() {
  // stale-vite trap: never reuse an existing server on this port — kill and start fresh
  try { execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  console.log(`[probe] starting Vite ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) { if (this.onEvent) this.onEvent(m); return; } const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {}); });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() { try { activeCdp?.close(); } catch {} try { chromeProc?.kill(); } catch {} try { ownedDev?.kill(); } catch {} }
process.on("exit", cleanup);
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(DT)); await sleep(20); } }
async function freeCamAt(c, ex, ey, ez, tx, ty, tz) {
  await ev(c, `window.__sfFreeCam([${ex},${ey},${ez}],[${tx},${ty},${tz}])`);
  for (let i = 0; i < 120; i++) { await tick(c, 0); const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`); if (Math.hypot(p[0] - ex, p[1] - ey, p[2] - ez) < 0.06) return; await sleep(30); }
  console.log("[probe] warn: free camera never fully acquired");
}
async function shoot(c, name) { const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true }); const file = path.join(OUT, `${name}.jpg`); writeFileSync(file, Buffer.from(shot.data, "base64")); console.log(`[probe] shot ${file}`); return file; }

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [`--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl); activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; const text = (d.exception && (d.exception.description || d.exception.value)) || d.text; pageErrors.push(`exception: ${String(text).slice(0, 300)}`); console.log("[page-exception]", String(text).slice(0, 200)); }
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") { const text = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300); pageErrors.push(`console.error: ${text}`); console.log("[page-error]", text.slice(0, 200)); }
  };
  await c.open(); await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.map)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // --scan: print a ground/water height grid around the pen and exit (placement aid)
  if (process.argv.includes("--scan")) {
    const grid = await ev(c, `(()=>{const m=window.__sf.map;const probe=(cx,cz,r)=>{let mn=1e9,mx=-1e9;for(let dz=-r;dz<=r;dz+=6)for(let dx=-r;dx<=r;dx+=6){const h=m.groundTop(cx+dx,cz+dz);mn=Math.min(mn,h);mx=Math.max(mx,h);}return [+mn.toFixed(1),+mx.toFixed(1)];};return JSON.stringify({padNew:probe(-775,-1655,30),padNew2:probe(-790,-1665,30),centerSpot:probe(-720,-1655,10)});})()`);
    console.log("[scan] groundTop grid, rows dz=-120..120 (20m), cols dx=-120..120, around", PEN);
    console.log(grid);
    cleanup();
    process.exit(0);
  }

  // Deterministic ticking + daylight for readable screenshots; hide the HUD so
  // the hourly progress shots are clean
  await ev(c, `window.__sfManual(true)`);
  await ev(c, `(()=>{try{window.__sf.sky.setTimeOfDay?.(14.0)}catch(e){} return true})()`);
  await ev(c, `(()=>{const h=document.getElementById('hud');if(h)h.style.display='none';return true})()`);

  // Walk to the pen: teleport just south of it, facing north — inside the site's
  // approach radius so the lazy loader + site gate both fire.
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const x=${PEN.x},z=${PEN.z + 14};const y=m.groundTop(x,z);p.teleportTo({x,y:y+1.5,z,facing:${Math.PI},mode:'walk'});return true;})()`);
  await settle(c, 30);

  // Wait for the optional site to hydrate + the gate to wake the pen
  console.log("[probe] waiting for pup site...");
  const t1 = Date.now(); let pupReady = false;
  while (Date.now() - t1 < 120000) {
    await settle(c, 6);
    try { if (await ev(c, `!!(window.__sf.pup && window.__sf.siteGate.awake('pup'))`)) { pupReady = true; break; } } catch {}
  }
  if (!pupReady) throw new Error("pup site never woke");
  console.log(`[probe] pup awake in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  // Let the pup live a bit, then read its ground truth
  await settle(c, 90);
  const state = await ev(c, `window.__sf.pup.debugState()`);
  console.log("[probe] pup state:", JSON.stringify(state));

  // Wide shot: pen + sign + Marina backdrop
  const g = await ev(c, `window.__sf.map.groundTop(${PEN.x},${PEN.z})`);
  await freeCamAt(c, PEN.x + 7, g + 3.4, PEN.z + 11, PEN.x, g + 0.8, PEN.z);
  await settle(c, 8);
  await shoot(c, `${LABEL}-wide`);
  // Close-up: aim at the pup itself (with its activation lattice overhead)
  const s2 = await ev(c, `window.__sf.pup.debugState()`);
  await freeCamAt(c, s2.wx + 1.5, s2.wy + 1.0, s2.wz + 1.9, s2.wx, s2.wy + 0.25, s2.wz);
  await settle(c, 8);
  await shoot(c, `${LABEL}-close`);

  // Snapshot the checkpoint alongside the shots so the morning timeline pairs
  // each image with the exact brain that produced it
  const policyPath = path.join(ROOT, "public/models/pup_policy.json");
  if (existsSync(policyPath)) copyFileSync(policyPath, path.join(OUT, `${LABEL}-policy.json`));

  const verdict = {
    label: LABEL,
    at: new Date().toISOString(),
    state,
    ok: !!state.hasPolicy && state.tall > 0.25,
    pageErrors: pageErrors.slice(0, 12)
  };
  writeFileSync(path.join(OUT, `${LABEL}-state.json`), JSON.stringify(verdict, null, 2));
  console.log(`[probe] ${verdict.ok ? "PASS" : "CHECK"} gen=${state.gen} tall=${state.tall?.toFixed(2)} upY=${state.upY?.toFixed(2)} speed=${state.speed?.toFixed(2)}`);
  cleanup();
  process.exit(verdict.ok ? 0 : 2);
}

main().catch((e) => { console.error("[probe] FAIL:", e.message); cleanup(); process.exit(1); });
