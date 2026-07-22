// In-game spectral-ocean smoke check: boots headless, captures EVERY console
// message + exception during boot and settle, then inspects __sf.water.ocean.
//   node tools/ocean-game-check.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res(a.port)); });
  });
}
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url)).ok) return; } catch { } await sleep(300); }
  throw new Error("timeout " + url);
}
class Cdp {
  #ws; #id = 1; #p = new Map(); #l = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); return; }
      for (const l of this.#l.get(m.method) ?? []) l(m.params ?? {});
    });
  }
  on(m, l) { const a = this.#l.get(m) ?? []; a.push(l); this.#l.set(m, a); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
}
const evaluate = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

async function main() {
  const vitePort = await freePort();
  const relay = await freePort();
  const vite = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true
  });
  process.on("exit", () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { } });
  await waitHttp(`http://127.0.0.1:${vitePort}/`, 60000);

  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-ocean-check-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--mute-audio", "--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal",
    "--window-size=1200,800", "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  process.on("exit", () => { try { process.kill(-chrome.pid, "SIGTERM"); } catch { } });

  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch { } await sleep(200); }
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  const msgs = [];
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "warning")
      msgs.push(`console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry?.level === "error" || p.entry?.level === "warning")
      msgs.push(`log.${p.entry.level}: ${String(p.entry.text).slice(0, 300)}`);
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    msgs.push(`EXCEPTION: ${(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0]}`);
  });

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1&j=-700,1,-2440,3.14,walk` });
  const tBoot = Date.now();
  while (Date.now() - tBoot < 180000) {
    try { if (await evaluate(cdp, "Boolean(window.__sf?.water)")) break; } catch { }
    await sleep(500);
  }
  await sleep(6000);
  const state = await evaluate(cdp, `(() => {
    const w = window.__sf?.water;
    if (!w) return { ok: false };
    const o = w.ocean;
    const p = window.__sf.player;
    return {
      ok: true,
      cascades: o?.cascades?.map((c) => ({
        patch: c.spec.patchSize,
        slopeVar: +c.slopeVariance.toFixed(4),
        texW: c.dispTex?.image?.width
      })),
      simMask: w.simMask,
      near: { vis: w.near.visible, x: +w.near.position.x.toFixed(1), z: +w.near.position.z.toFixed(1) },
      hero: w.heroNear ? { vis: w.heroNear.visible, x: +w.heroNear.position.x.toFixed(1), z: +w.heroNear.position.z.toFixed(1) } : null,
      player: { x: +p.position.x.toFixed(1), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(1), mode: p.mode }
    };
  })()`);
  console.log("[check] state:", JSON.stringify(state, null, 1));
  try {
    const rb = await evaluate(cdp, "window.__sf.water.ocean.debugReadback(window.__sf.renderer)");
    console.log("[check] cascade bufA readback:", JSON.stringify(rb));
  } catch (e) { console.log("[check] readback failed:", String(e).split("\n")[0]); }

  // Frozen deterministic view: camera 9 m above the bay looking down-forward,
  // fixed time of day — screenshot comparable across code variants.
  await evaluate(cdp, `(()=>{const s=window.__sf;s.sky.cycleEnabled=false;s.sky.setTimeOfDay(15);
    const c=s.camera;if(!window.__fixedCam){window.__fixedCam=true;s.chase.update=()=>{c.position.set(-700,9,-2410);c.up.set(0,1,0);c.lookAt(-700,0,-2470);c.updateMatrixWorld();};}
    document.body.classList.add('started');return true;})()`);
  await sleep(2500);
  const shotTag = process.env.SF_TAG ?? "check";
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const { writeFileSync, mkdirSync: mk } = await import("node:fs");
  mk(path.resolve(ROOT, ".data/ocean-game-check"), { recursive: true });
  writeFileSync(path.resolve(ROOT, `.data/ocean-game-check/${shotTag}.png`), Buffer.from(r.data, "base64"));
  console.log(`[check] shot -> .data/ocean-game-check/${shotTag}.png`);
  console.log(`[check] ${msgs.length} console errors/warnings:`);
  const uniq = [...new Set(msgs)];
  for (const m of uniq.slice(0, 30)) console.log("   " + m);
  process.exit(0);
}
main().catch((e) => { console.error("[check] fatal", e); process.exit(1); });
