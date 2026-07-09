// Does the wildlands grass ring follow the CAMERA instead of the player? Hold the
// player still on a flat spot, orbit the free camera around them, and watch the
// grass instance centroid + screenshot. If the centroid slides with the camera
// (and grass re-scatters when you only look around), the ring is camera-locked.
//
//   node tools/grass-orbit.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/grass-orbit");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5192";
const TIME = Number(process.env.SF_TIME ?? 13.5);
const [FX, FZ] = (process.env.SF_XZ ?? "-3760,2250").split(",").map(Number); // flat GG Park speedway meadow
const W = 1500, H = 850;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("No Chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}`); }
async function startDevIfNeeded() { try { await waitHttp(SERVER_URL, 2500, "vite"); return null; } catch {} const relay = await freePort(); const vitePort = Number(new URL(SERVER_URL).port); console.log(`[probe] starting Vite ${SERVER_URL}`); const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] }); await waitHttp(SERVER_URL, 60000, "vite"); return child; }
class Cdp { #ws; #id = 1; #p = new Map(); constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) { if (this.onEvent) this.onEvent(m); return; } const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {}); }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); } close() { this.#ws.close(); } }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(1 / 60)); await sleep(45); } }

// centroid of the wildlands grass instances (the ring center) + count
const CENTROID = `(() => {
  const sf = window.__sf, THREE = sf.THREE, m4 = new THREE.Matrix4(), p = new THREE.Vector3();
  let sx = 0, sz = 0, n = 0, minY = 1e9, maxY = -1e9;
  const g = sf.wildlands && sf.wildlands.grass && sf.wildlands.grass.group;
  if (g) g.traverse(o => { if (o.isInstancedMesh && /grass/i.test(o.name)) { const step = Math.max(1, (o.count/300)|0); for (let i=0;i<o.count;i+=step){ o.getMatrixAt(i,m4); p.setFromMatrixPosition(m4); if (p.lengthSq()<1) continue; sx+=p.x; sz+=p.z; n++; } } });
  const cam = sf.camera.position, pl = sf.player.position;
  return { grassCentroid: n?[Math.round(sx/n), Math.round(sz/n)]:null, grassN: n, camXZ:[Math.round(cam.x),Math.round(cam.z)], playerXZ:[Math.round(pl.x),Math.round(pl.z)] };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [`--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page; for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no page");
  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => { if (m.method === "Runtime.exceptionThrown") console.log("[exc]", (m.params.exceptionDetails.exception||{}).description||m.params.exceptionDetails.text); };
  await c.open(); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  console.log("[probe] waiting __sf...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.wildlands&&window.__sf.camera)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("never ready");
  console.log("[probe] ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  // teleport player to flat spot, DO NOT move again
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${FX},${FZ});p.teleportTo({x:${FX},y:y+1.5,z:${FZ},facing:0,mode:'walk'});return true;})()`);
  await settle(c, 30);

  // orbit the free camera AROUND the stationary player; look inward.
  // If the grass centroid tracks the camera, the ring is camera-locked.
  console.log(`\nplayer held at ${FX},${FZ}. Orbiting camera; watch grassCentroid vs camXZ vs playerXZ:`);
  const R = 10; // camera boom radius
  for (const deg of [0, 90, 180, 270, 45, 225]) {
    const a = (deg * Math.PI) / 180;
    // place the eye on a circle of radius R around the player, looking at the player
    await ev(c, `(()=>{const gy=window.__sf.map.groundHeight(${FX},${FZ});
      window.__sfFreeCam([${FX}+Math.sin(${a})*${R}, gy+2, ${FZ}+Math.cos(${a})*${R}], [${FX}, gy+1, ${FZ}]);return true;})()`);
    await settle(c, 16); // let the ring react to the moved camera
    const s = await ev(c, CENTROID);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 84, fromSurface: true });
    writeFileSync(path.join(OUT, `orbit_${deg}.jpg`), Buffer.from(shot.data, "base64"));
    const drift = s.grassCentroid ? Math.hypot(s.grassCentroid[0] - FX, s.grassCentroid[1] - FZ) : -1;
    console.log(`  cam@${String(deg).padStart(3)}°  camXZ=${JSON.stringify(s.camXZ)} playerXZ=${JSON.stringify(s.playerXZ)}  grassCentroid=${JSON.stringify(s.grassCentroid)} (drift from player ${drift.toFixed(1)}m, n=${s.grassN})`);
  }
  console.log("\n=== orbit test done ===");
  c.close(); proc.kill(); if (dev) dev.kill(); process.exit(0);
}
main().catch((e) => { console.error("[probe] FAILED", e); process.exit(1); });
