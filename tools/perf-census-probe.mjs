// Scene census: WHO owns the draw calls and triangles. Boots headless, parks at
// stops, and for each visible mesh that survives frustum culling attributes its
// draw + triangle count to its top-level scene-graph ancestor (or name prefix).
// Also dumps the 20 heaviest individual meshes. Pure diagnosis, no timing.
//
//   node tools/perf-census-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/perf-census");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5198";
const W = Number(process.env.SF_W ?? 2560), H = Number(process.env.SF_H ?? 1600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STOPS = [
  { name: "downtown", x: 4117, z: 200, facing: Math.PI, mode: "walk" },
  { name: "meadow", x: -2260, z: 2450, facing: 2.4, mode: "walk" }
];

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
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
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    // `profile` exposes window.__sf on PROD builds too (import.meta.env.DEV is
    // false there); on a dev server it's a harmless no-op. Lets this probe run
    // against a static prod build, immune to concurrent-edit HMR reloads.
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&profile&fullfps`
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
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  const results = [];
  for (const stop of STOPS) {
    await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${stop.x},${stop.z});sf.player.teleportTo({x:${stop.x},y:gy+1.6,z:${stop.z},facing:${stop.facing},mode:'${stop.mode}'});return true;})()`);
    let lastDraws = -1;
    for (let k = 0; k < 40; k++) {
      const d = await ev(c, `(async()=>{
        const sf = window.__sf; const dev = sf.renderer.backend.device;
        for (let i=0;i<30;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
        sf.renderer.info.autoReset = false;
        sf.renderer.info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone();
        return sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0;
      })()`);
      if (k > 4 && lastDraws > 50 && Math.abs(d - lastDraws) < Math.max(3, lastDraws * 0.01)) { lastDraws = d; break; }
      lastDraws = d;
      await sleep(300);
    }
    const census = await ev(c, `(()=>{
      const sf = window.__sf;
      const cam = sf.camera;
      cam.updateMatrixWorld();
      const THREE = sf.THREE;
      const frustum = new THREE.Frustum();
      frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const groups = {};
      const heavy = [];
      const rootOf = (o) => {
        let r = o;
        while (r.parent && r.parent !== sf.scene) r = r.parent;
        return r;
      };
      const trisOf = (m) => {
        const g = m.geometry; if (!g) return 0;
        const idx = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
        let t = idx / 3;
        if (m.isInstancedMesh) t *= m.count;
        return t;
      };
      sf.scene.traverse((o) => {
        if (!o.isMesh && !o.isSprite && !o.isLine && !o.isPoints) return;
        // visibility up the chain
        let v = true, p = o;
        while (p) { if (!p.visible) { v = false; break; } p = p.parent; }
        if (!v) return;
        // frustum test like the renderer does
        if (o.frustumCulled !== false) {
          const geo = o.geometry;
          if (geo) {
            if (!geo.boundingSphere) { try { geo.computeBoundingSphere(); } catch {} }
            if (geo.boundingSphere) {
              const s = geo.boundingSphere.clone().applyMatrix4(o.matrixWorld);
              if (o.isInstancedMesh) s.radius *= 20; // fudge: instanced bounds often widened
              if (!frustum.intersectsSphere(s)) return;
            }
          }
        }
        const root = rootOf(o);
        const key = root.name || root.type || "?";
        const g = groups[key] ?? (groups[key] = { draws: 0, tris: 0, meshes: 0, instanced: 0 });
        const t = trisOf(o);
        g.draws += 1; g.tris += t; g.meshes += 1; if (o.isInstancedMesh) g.instanced += 1;
        heavy.push({ name: o.name || o.type, root: key, tris: Math.round(t), instanced: !!o.isInstancedMesh, count: o.isInstancedMesh ? o.count : 1 });
      });
      heavy.sort((a,b)=>b.tris-a.tris);
      return { groups, heavy: heavy.slice(0, 25) };
    })()`);
    results.push({ stop: stop.name, draws: lastDraws, census });
    console.log(`\n=== ${stop.name} ===  (renderer draws/frame ~${lastDraws})`);
    const sorted = Object.entries(census.groups).sort((a, b) => b[1].tris - a[1].tris);
    for (const [k, g] of sorted.slice(0, 20)) {
      console.log(`  ${k.padEnd(28)} draws ${String(g.draws).padStart(5)}  tris ${(g.tris / 1e6).toFixed(2).padStart(7)}M  inst ${g.instanced}`);
    }
    console.log("  --- heaviest meshes ---");
    for (const h of census.heavy.slice(0, 12)) {
      console.log(`  ${(h.root + "/" + h.name).slice(0, 60).padEnd(60)} ${(h.tris / 1e6).toFixed(2)}M tris${h.instanced ? ` (inst x${h.count})` : ""}`);
    }
  }
  writeFileSync(path.join(OUT, "census.json"), JSON.stringify(results, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "census.json")}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
