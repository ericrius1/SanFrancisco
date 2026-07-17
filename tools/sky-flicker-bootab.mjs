// Boot-window A/B: applies a condition as soon as __sf exists, then captures
// the first ~45s after world start (when streaming churn — and the flicker —
// is at its peak). One condition per boot; run several conditions in sequence.
//
//   SF_COND=control|noshadow|nosun|noproxies node tools/sky-flicker-bootab.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COND = process.env.SF_COND ?? "control";
const OUT = path.resolve(ROOT, `.data/sky-flicker-bootab/${COND}`);
const SHOTS = Number(process.env.SF_SHOTS ?? 70);
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

const CONDITIONS = {
  control: `1`,
  noshadow: `(() => {
    const sf = window.__sf; let n = 0;
    sf.scene.traverse((o) => { if (o.isLight && o.castShadow) { o.castShadow = false; n++; } });
    return "lights shadow-off: " + n;
  })()`,
  nosun: `(() => {
    const sf = window.__sf; let n = 0;
    sf.scene.traverse((o) => { if (o.isDirectionalLight) { o.visible = false; n++; } });
    return "suns hidden: " + n;
  })()`,
  noproxies: `(() => {
    const sf = window.__sf; let n = 0;
    sf.scene.traverse((o) => {
      if (o.name && (o.name.startsWith("tileShadowProxy") || o.name.startsWith("landmarkShadowProxy") || o.name.startsWith("cityGenChunkShadowProxy"))) { o.visible = false; n++; }
    });
    const origAdd = sf.THREE.Object3D.prototype.add;
    sf.THREE.Object3D.prototype.add = function (...objs) {
      for (const o of objs) if (o && o.name && (o.name.startsWith("tileShadowProxy") || o.name.startsWith("landmarkShadowProxy") || o.name.startsWith("cityGenChunkShadowProxy"))) o.visible = false;
      return origAdd.apply(this, objs);
    };
    return "proxies hidden: " + n;
  })()`,
};

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
        await sleep(500);
      }
      if (!(await ev(cdp, `!!window.__sf`))) throw new Error("no __sf: " + viteLog.slice(-5).join(""));

      // Freecam + condition IMMEDIATELY (no settle — capture the churn window).
      await ev(cdp, `(() => {
        const sf = window.__sf;
        const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
        const p = proxy ? proxy.position : { x: -4170, y: 460, z: -2450 };
        window.__sfFreeCam([sf.player.position.x, sf.player.position.y + 8, sf.player.position.z], [p.x, p.y, p.z]);
        const hud = document.getElementById("hud"); if (hud) hud.style.display = "none";
        const dawn = Number("${process.env.SF_HOUR ?? ""}");
        if (Number.isFinite(dawn)) sf.sky.setTimeOfDay(dawn);
        return 1;
      })()`);
      console.log(`[bootab:${COND}]`, await ev(cdp, CONDITIONS[COND] ?? "1"));

      for (let i = 0; i < SHOTS; i++) {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(path.join(OUT, "shots", `s${String(i).padStart(3, "0")}.png`), Buffer.from(shot.data, "base64"));
      }
      console.log(`[bootab:${COND}] captured`, SHOTS);
      cdp.close();
    } finally { chrome.kill("SIGKILL"); }
  } finally { vite.kill("SIGKILL"); }
}
main().catch((e) => { console.error("[bootab] FAILED:", e.message); process.exit(1); });
