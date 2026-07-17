// Sky-flicker probe: boots headless at the Ocean Beach spawn, then watches the
// scene graph every frame for meshes that appear high in the air at mid/far
// distance — the "flickering objects" seen in captures. Reports any object
// whose world Y jumps wildly between frames, plus snapshots of the usual
// suspects (abandonedMounts, ghostShip pose, net remotes).
//
//   node tools/sky-flicker-probe.mjs
// Env: CHROME_BIN, SF_PROBE_SECONDS (default 14)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/sky-flicker-probe");
const SECONDS = Number(process.env.SF_PROBE_SECONDS ?? 14);
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
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
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

const WATCHER = `(() => {
  const sf = window.__sf;
  if (!sf) return "no __sf";
  const cam = sf.camera;
  const rec = new Map(); // uuid -> {name, chain, ys:[], frames:[], kinds}
  const v = new sf.THREE.Vector3();
  let frame = 0;
  const chainOf = (o) => {
    const parts = [];
    for (let p = o; p && parts.length < 8; p = p.parent) parts.push(p.name || p.type);
    return parts.join(" < ");
  };
  window.__skyWatch = { rec, samples: [] };
  const scan = () => {
    frame++;
    sf.scene.traverse((o) => {
      if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
      let vis = true;
      for (let p = o; p; p = p.parent) { if (!p.visible) { vis = false; break; } }
      if (!vis) return;
      v.setFromMatrixPosition(o.matrixWorld);
      const dx = v.x - cam.position.x, dz = v.z - cam.position.z;
      const dist = Math.hypot(dx, dz);
      if (v.y < 60 || dist < 250 || dist > 8000) return;
      let e = rec.get(o.uuid);
      if (!e) { e = { name: o.name || o.type, chain: chainOf(o), ys: [], xs: [], zs: [], frames: [], n: 0 }; rec.set(o.uuid, e); }
      e.n++;
      if (e.frames.length < 400) { e.frames.push(frame); e.ys.push(Math.round(v.y)); e.xs.push(Math.round(v.x)); e.zs.push(Math.round(v.z)); }
    });
    requestAnimationFrame(scan);
  };
  requestAnimationFrame(scan);
  return "watching";
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
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
      // wait for world
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const ready = await ev(cdp, `!!(window.__sf && window.__sf.player && document.body.classList.contains("started"))`).catch(() => false);
        if (ready) break;
        await sleep(1000);
      }
      const started = await ev(cdp, `!!(window.__sf && document.body.classList.contains("started"))`);
      if (!started) throw new Error("world never started: " + viteLog.slice(-5).join(""));
      await sleep(4000); // settle

      console.log("[probe] world up, installing watcher");
      console.log("[probe] watcher:", await ev(cdp, WATCHER));
      await sleep(SECONDS * 1000);

      const report = await ev(cdp, `(() => {
        const sf = window.__sf;
        const out = { airborne: [], mounts: null, ghost: null, remotes: null, playerPos: null };
        const w = window.__skyWatch;
        for (const [uuid, e] of w.rec) {
          const ys = e.ys;
          const min = Math.min(...ys), max = Math.max(...ys);
          out.airborne.push({ uuid: uuid.slice(0, 8), name: e.name, chain: e.chain, n: e.n, yMin: min, yMax: max, ySpread: max - min, x0: e.xs[0], z0: e.zs[0], xLast: e.xs[e.xs.length-1], zLast: e.zs[e.zs.length-1], frames: e.frames.slice(0, 40), ysSample: ys.slice(0, 40) });
        }
        out.airborne.sort((a, b) => b.ySpread - a.ySpread);
        try { out.playerPos = sf.player.position.toArray().map((n) => Math.round(n)); } catch {}
        try { out.mounts = sf.abandonedMounts && sf.abandonedMounts.debugList ? sf.abandonedMounts.debugList() : String(sf.abandonedMounts && Object.keys(sf.abandonedMounts)); } catch (err) { out.mounts = String(err); }
        try { out.ghost = sf.ghostShip ? { pose: sf.ghostShip.pose ? sf.ghostShip.pose() : null, keys: Object.keys(sf.ghostShip) } : null; } catch (err) { out.ghost = String(err); }
        try { out.remotes = sf.remotes ? Object.keys(sf.remotes) : null; } catch {}
        return out;
      })()`);
      writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(OUT, "final.png"), Buffer.from(shot.data, "base64"));
      console.log("[probe] player at", report.playerPos);
      console.log("[probe] airborne candidates (top 25 by ySpread):");
      for (const a of report.airborne.slice(0, 25)) {
        console.log(`  ${a.name} n=${a.n} y=[${a.yMin}..${a.yMax}] spread=${a.ySpread} at(${a.x0},${a.z0})->(${a.xLast},${a.zLast})  chain: ${a.chain}`);
      }
      console.log("[probe] ghost:", JSON.stringify(report.ghost)?.slice(0, 400));
      console.log("[probe] mounts:", JSON.stringify(report.mounts)?.slice(0, 400));
      console.log("[probe] remotes:", JSON.stringify(report.remotes)?.slice(0, 200));
      cdp.close();
    } finally { chrome.kill("SIGKILL"); }
  } finally { vite.kill("SIGKILL"); }
}
main().catch((e) => { console.error("[probe] FAILED:", e.message); process.exit(1); });
