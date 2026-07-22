// Boat-on-waves probe: spawns in boat mode on open bay, samples hull Y +
// attitude over time (must ride the spectral swell), grabs close-up stills.
//   node tools/ocean-boat-probe.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/ocean-boat-probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res(a.port)); }); });
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url)).ok) return; } catch { } await sleep(300); } throw new Error("timeout " + url); }
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) return; const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
}
const ev = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
async function shot(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`[boat] ${name}.png`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vitePort = await freePort();
  const relay = await freePort();
  const vite = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  process.on("exit", () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { } });
  await waitHttp(`http://127.0.0.1:${vitePort}/`, 60000);
  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-boat-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--mute-audio",
    "--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--window-size=1500,900", "--force-device-scale-factor=1", "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  process.on("exit", () => { try { process.kill(-chrome.pid, "SIGTERM"); } catch { } });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch { } await sleep(200); }
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1&j=-700,1,-2600,0.6,boat` });
  const tb = Date.now();
  while (Date.now() - tb < 180000) { try { if (await ev(cdp, "Boolean(window.__sf?.player && window.__sf?.water && window.__sf?.renderIdle?.())")) break; } catch { } await sleep(600); }
  const tod = Number(process.env.SF_TIME ?? 15);
  await ev(cdp, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${tod});document.body.classList.add('started');return true;})()`);
  await sleep(6000);

  // sample hull pose over ~5 s
  const samples = await ev(cdp, `(async()=>{const s=window.__sf,out=[];
    for(let i=0;i<25;i++){const p=s.player;out.push({y:+p.renderPosition.y.toFixed(3), mode:p.mode});await new Promise(r=>setTimeout(r,200));}
    return out;})()`);
  const ys = samples.map((s) => s.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  console.log(`[boat] mode=${samples[0].mode} yMin=${min} yMax=${max} range=${(max - min).toFixed(3)} m`);
  await shot(cdp, "boat-a");
  await sleep(1600);
  await shot(cdp, "boat-b");

  // low oblique close-ups (the "looking around the player" view the chase cam
  // never gives headlessly): freeze the camera 20 m out, 4.5 m up, two azimuths
  for (const [name, az] of [["boat-low-e", 0.2], ["boat-low-s", 1.8]]) {
    await ev(cdp, `(()=>{const s=window.__sf,c=s.camera,p=s.player.renderPosition;
      window.__lowCam=[p.x+Math.cos(${az})*20, 4.5, p.z+Math.sin(${az})*20, p.x, p.y, p.z];
      if(!window.__lowPatched){window.__lowPatched=true;s.chase.update=()=>{const a=window.__lowCam;c.position.set(a[0],a[1],a[2]);c.up.set(0,1,0);c.lookAt(a[3],a[4],a[5]);c.updateMatrixWorld();};}
      return true;})()`);
    await sleep(1200);
    await shot(cdp, name);
  }
  console.log(max - min > 0.12 ? "[boat] PASS — hull rides the swell" : "[boat] FAIL — hull static (range < 0.12 m)");
  process.exit(max - min > 0.12 ? 0 : 1);
}
main().catch((e) => { console.error("[boat] fatal", e); process.exit(1); });
