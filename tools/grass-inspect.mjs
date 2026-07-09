// In-situ floating-grass probe. Boots the app headless, teleports to the
// botanical-garden meadow, screenshots it, then raycasts EVERY rendered grass
// instance straight down onto the real terrain mesh and reports which blades
// float above the ground and by how much (per grass mesh).
//
//   node tools/grass-inspect.mjs
// Env: SF_PROBE_URL (default http://127.0.0.1:5191), SF_TIME (default 17.2),
//      SF_XZ ("x,z" focus, default meadow west of the garden)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/grass-inspect");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5191";
const TIME = Number(process.env.SF_TIME ?? 17.2);
const [FX, FZ] = (process.env.SF_XZ ?? "-2740,2500").split(",").map(Number);
const W = 1600, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}`); }
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); console.log("[probe] reusing vite at", SERVER_URL); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] });
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
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(1 / 60)); await sleep(60); } }

// The in-page measurement: raycast every grass instance down onto terrain.
const MEASURE = `(() => {
  const THREE = window.__sf.THREE, sf = window.__sf;
  const terrain = [];
  // visible ground meshes: the terrain_*.glb scenes + streamed tile meshes
  if (sf.tiles && sf.tiles.terrain) for (const g of sf.tiles.terrain.values()) g.traverse(o => { if (o.isMesh) terrain.push(o); });
  const ray = new THREE.Raycaster(); ray.far = 400;
  const down = new THREE.Vector3(0, -1, 0), up = new THREE.Vector3(0, 1, 0);
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3();
  const groups = [];
  const collect = (root, tag) => { if (!root) return; root.traverse(o => { if (o.isInstancedMesh && o.count > 0 && /grass/i.test(o.name)) groups.push([tag, o]); }); };
  collect(sf.wildlands && sf.wildlands.grass && sf.wildlands.grass.group, 'wild');
  collect(sf.garden && sf.garden.group, 'garden');
  const perMesh = {};
  let sampled = 0;
  const worst = [];
  for (const [tag, mesh] of groups) {
    const name = tag + ':' + mesh.name;
    const rec = perMesh[name] || (perMesh[name] = { count: mesh.count, floatOver03: 0, floatOver1: 0, max: 0, checked: 0, noGround: 0 });
    const step = Math.max(1, Math.floor(mesh.count / 400)); // cap ~400 rays/mesh
    for (let i = 0; i < mesh.count; i += step) {
      mesh.getMatrixAt(i, m4); pos.setFromMatrixPosition(m4);
      if (pos.lengthSq() < 1) continue; // zeroed/degenerate slot
      mesh.localToWorld(pos);
      rec.checked++; sampled++;
      ray.set(new THREE.Vector3(pos.x, pos.y + 40, pos.z), down);
      let hit = ray.intersectObjects(terrain, true)[0];
      if (!hit) { ray.set(new THREE.Vector3(pos.x, pos.y - 40, pos.z), up); hit = ray.intersectObjects(terrain, true)[0]; }
      if (!hit) { rec.noGround++; continue; }
      const gap = pos.y - hit.point.y; // + = blade base above visible ground = floating
      if (gap > 0.3) rec.floatOver03++;
      if (gap > 1) rec.floatOver1++;
      if (gap > rec.max) rec.max = gap;
      worst.push([Math.round(gap * 100) / 100, name, Math.round(pos.x), Math.round(pos.z), Math.round(pos.y * 100) / 100, Math.round(hit.point.y * 100) / 100]);
    }
  }
  worst.sort((a, b) => b[0] - a[0]);
  return { focus: [${FX}, ${FZ}], terrainMeshes: terrain.length, grassMeshes: groups.length, sampled, perMesh, worst: worst.slice(0, 20) };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [`--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => { if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text); } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") { console.log("[page-error]", m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300)); } };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.wildlands)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);

  // teleport to the meadow, let tiles + grass ring build
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${FX},${FZ});p.teleportTo({x:${FX},y:y+1.5,z:${FZ},facing:${Math.PI / 2},mode:'walk'});return true;})()`);
  await settle(c, 40);
  await ev(c, `window.__sf.sky.setTimeOfDay(${TIME})`);

  // free camera low + behind, looking east toward the garden/buildings like the user's shot
  await ev(c, `(()=>{const gy=window.__sf.map.groundHeight(${FX},${FZ});window.__sfFreeCam([${FX}-34, gy+6, ${FZ}], [${FX}+60, gy+3, ${FZ}]);return true;})()`);
  for (let i = 0; i < 6; i++) await ev(c, frame(1 / 30));
  const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
  writeFileSync(path.join(OUT, "meadow.jpg"), Buffer.from(shot.data, "base64"));
  console.log("[probe] screenshot ->", path.join(OUT, "meadow.jpg"));

  const res = await ev(c, MEASURE);
  console.log("\n=== grass float measurement ===");
  console.log("focus", res.focus, "terrainMeshes", res.terrainMeshes, "grassMeshes", res.grassMeshes, "sampled", res.sampled);
  for (const [name, r] of Object.entries(res.perMesh)) {
    console.log(`  ${name.padEnd(42)} count=${String(r.count).padStart(5)} checked=${String(r.checked).padStart(4)} float>0.3m=${String(r.floatOver03).padStart(4)} >1m=${String(r.floatOver1).padStart(4)} max=${r.max.toFixed(2)}m noGround=${r.noGround}`);
  }
  console.log("worst [gap, mesh, x, z, baseY, groundY]:");
  for (const w of res.worst) console.log("   ", JSON.stringify(w));
  writeFileSync(path.join(OUT, "measure.json"), JSON.stringify(res, null, 2));

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAILED", e); process.exit(1); });
