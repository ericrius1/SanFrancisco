// Sky-flicker catch probe: reproduces the transient sky object while logging
// (a) every mesh attach/detach on the scene, (b) per-frame positions of ALL
// scene meshes (visible or not) above y>40 within 8km, and (c) burst
// screenshots with timestamps — then correlates sightings with the logs.
//
//   node tools/sky-flicker-catch.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/sky-flicker-catch");
const SHOTS = Number(process.env.SF_SHOTS ?? 80);
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  close() { try { this.#ws.close(); } catch {} }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 900)}`);
  return r.result?.value;
}

const INSTRUMENT = `(() => {
  const sf = window.__sf;
  if (!sf) return "no __sf";
  const log = { hits: [], frames: 0, t0: performance.now() };
  window.__catch = log;
  const chainOf = (o) => {
    const parts = [];
    for (let p = o; p && parts.length < 7; p = p.parent) parts.push(p.name || p.type);
    return parts.join(" < ");
  };
  const ray = new sf.THREE.Raycaster();
  ray.far = 9000;
  const ndc = new sf.THREE.Vector2();
  const scan = () => {
    log.frames++;
    // 28x12 grid over the upper 60% of the screen
    for (let gy = 0; gy < 12; gy++) {
      for (let gx = 0; gx < 28; gx++) {
        ndc.x = (gx + 0.5) / 28 * 2 - 1;
        ndc.y = 1 - (gy + 0.5) / 12 * 1.2; // ndc y from 1 down to -0.2
        ray.setFromCamera(ndc, sf.camera);
        const hits = ray.intersectObjects(sf.scene.children, true);
        for (const h of hits) {
          if (h.distance < 250) break;      // near stuff: skip whole ray
          if (h.point.y < 60) break;        // ground/buildings: skip
          log.hits.push({ t: Math.round(performance.now() - log.t0), frame: log.frames, name: h.object.name || h.object.type, chain: chainOf(h.object), d: Math.round(h.distance), px: Math.round(h.point.x), py: Math.round(h.point.y), pz: Math.round(h.point.z) });
          if (log.hits.length > 4000) log.hits.shift();
          break;
        }
      }
    }
    requestAnimationFrame(scan);
  };
  requestAnimationFrame(scan);
  return "ray grid running";
})()`;

async function main() {
  mkdirSync(path.join(OUT, "shots"), { recursive: true });
  const vitePort = await freePort();
  const vite = spawn(path.join(ROOT, "node_modules/.bin/vite"), ["--port", String(vitePort), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  const viteLog = [];
  vite.stdout.on("data", (d) => viteLog.push(String(d)));
  vite.stderr.on("data", (d) => viteLog.push(String(d)));
  try {
    await waitHttp(`http://localhost:${vitePort}/`, 30000, "vite");
    const dbgPort = await freePort();
    const chrome = spawn(await findChrome(), [
      `--remote-debugging-port=${dbgPort}`,
      "--headless=new", "--use-angle=metal", "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,WebGPU", "--hide-scrollbars", "--mute-audio",
      `--window-size=${W},${H}`, "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${path.join(OUT, "chrome-profile")}`,
      "about:blank"
    ], { stdio: "ignore" });
    try {
      await waitHttp(`http://127.0.0.1:${dbgPort}/json/version`, 15000, "chrome");
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      const cdp = new Cdp(page.webSocketDebuggerUrl);
      await cdp.open();
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Page.navigate", { url: `http://localhost:${vitePort}/?autostart=1&spawn=oceanBeach&fullfps=1` });
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const ready = await ev(cdp, `!!(window.__sf && window.__sf.player && document.body.classList.contains("started"))`).catch(() => false);
        if (ready) break;
        await sleep(1000);
      }
      if (!(await ev(cdp, `!!window.__sf`))) throw new Error("no __sf: " + viteLog.slice(-5).join(""));
      await sleep(4000);

      await ev(cdp, `(() => {
        const sf = window.__sf;
        const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
        const p = proxy ? proxy.position : { x: -4170, y: 460, z: -2450 };
        window.__sfFreeCam([sf.player.position.x, sf.player.position.y + 8, sf.player.position.z], [p.x, p.y, p.z]);
        const hud = document.getElementById("hud"); if (hud) hud.style.display = "none";
        return 1;
      })()`);
      await sleep(800);
      console.log("[catch]", await ev(cdp, INSTRUMENT));

      const shotTimes = [];
      const pageT0 = await ev(cdp, `window.__catch.t0`);
      for (let i = 0; i < SHOTS; i++) {
        const tPage = await ev(cdp, `Math.round(performance.now() - window.__catch.t0)`);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        shotTimes.push(tPage);
        writeFileSync(path.join(OUT, "shots", `s${String(i).padStart(3, "0")}.png`), Buffer.from(shot.data, "base64"));
      }
      const logs = await ev(cdp, `(() => {
        const l = window.__catch;
        return { hits: l.hits, frames: l.frames };
      })()`);
      writeFileSync(path.join(OUT, "logs.json"), JSON.stringify({ shotTimes, pageT0, ...logs }, null, 1));
      console.log("[catch] shots:", SHOTS, "rayHits:", logs.hits.length, "frames:", logs.frames);
      const byName = {};
      for (const h of logs.hits) byName[h.chain] = (byName[h.chain] || 0) + 1;
      for (const [k, v] of Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log("   ", v, k);
      cdp.close();
    } finally { chrome.kill("SIGKILL"); }
  } finally { vite.kill("SIGKILL"); }
}
main().catch((e) => { console.error("[catch] FAILED:", e.message); process.exit(1); });
