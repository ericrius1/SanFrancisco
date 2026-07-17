// Sky-flicker bisection: one boot, then sequentially hide each subset of scene
// root children while burst-capturing. The subset whose hiding stops the
// transient sky blobs contains the culprit.
//
//   node tools/sky-flicker-bisect.mjs                 # partition roots into 8 groups
//   SF_SEGMENT_SHOTS=50 SF_GROUPS=8 node tools/...
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/sky-flicker-bisect");
const SEGMENT_SHOTS = Number(process.env.SF_SEGMENT_SHOTS ?? 50);
const GROUPS = Number(process.env.SF_GROUPS ?? 8);
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

      // Partition root children round-robin into GROUPS groups; report names.
      const groups = await ev(cdp, `(() => {
        const sf = window.__sf;
        const kids = sf.scene.children;
        const groups = Array.from({ length: ${GROUPS} }, () => []);
        kids.forEach((o, i) => groups[i % ${GROUPS}].push(i));
        window.__bisect = { groups, names: kids.map((o) => o.name || o.type) };
        return groups.map((g) => g.map((i) => window.__bisect.names[i]));
      })()`);
      groups.forEach((g, i) => console.log(`[bisect] group ${i}: ${g.join(", ").slice(0, 400)}`));

      // Interleaved: cycle through conditions repeatedly to cancel temporal
      // burstiness. Condition 0 = baseline, k>0 = group k-1 hidden.
      const CYCLES = Number(process.env.SF_CYCLES ?? 4);
      const PER = Number(process.env.SF_PER ?? 12);
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (let seg = 0; seg <= GROUPS; seg++) {
          await ev(cdp, `(() => {
            const sf = window.__sf;
            const { groups } = window.__bisect;
            sf.scene.children.forEach((o) => { o.visible = true; });
            if (${seg} > 0) for (const i of groups[${seg - 1}]) { const o = sf.scene.children[i]; if (o) o.visible = false; }
            return 1;
          })()`);
          await sleep(300);
          for (let i = 0; i < PER; i++) {
            // Churn generator: bounce the (freecam-frozen) player between two
            // spots so tile/citygen/site streaming stays busy the whole run.
            await ev(cdp, `(() => {
              const sf = window.__sf;
              if (!window.__churnBase) window.__churnBase = { x: sf.player.position.x, z: sf.player.position.z, n: 0 };
              const b = window.__churnBase; b.n++;
              const off = (b.n % 2) ? 420 : 0;
              sf.player.position.x = b.x + off; sf.player.position.z = b.z - off;
              return 1;
            })()`);
            const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(path.join(OUT, "shots", `seg${String(seg).padStart(2, "0")}_${String(cycle).padStart(2, "0")}${String(i).padStart(3, "0")}.png`), Buffer.from(shot.data, "base64"));
          }
        }
        console.log(`[bisect] cycle ${cycle} done`);
      }
      writeFileSync(path.join(OUT, "groups.json"), JSON.stringify(groups, null, 1));
      cdp.close();
    } finally { chrome.kill("SIGKILL"); }
  } finally { vite.kill("SIGKILL"); }
}
main().catch((e) => { console.error("[bisect] FAILED:", e.message); process.exit(1); });
