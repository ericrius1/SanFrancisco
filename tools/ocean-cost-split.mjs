// Attribute the ocean upgrade's frame cost at a stop: measures p50 frame time
// with the cascade sim ON (mask 7) vs OFF (mask 0) in the same session.
//   node tools/ocean-cost-split.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

async function main() {
  const vitePort = await freePort();
  const relay = await freePort();
  const vite = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  process.on("exit", () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { } });
  await waitHttp(`http://127.0.0.1:${vitePort}/`, 60000);
  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-ocean-split-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--mute-audio",
    "--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--window-size=1600,1000", "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  process.on("exit", () => { try { process.kill(-chrome.pid, "SIGTERM"); } catch { } });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch { } await sleep(200); }
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1&j=4117,5,200,3.14,walk` });
  const tb = Date.now();
  while (Date.now() - tb < 180000) { try { if (await ev(cdp, "Boolean(window.__sf?.water && window.__sf?.renderIdle?.())")) break; } catch { } await sleep(600); }
  await sleep(8000); // settle

  const measure = () => ev(cdp, `(async()=>{
    const samples=[];let last=performance.now();
    for(let i=0;i<180;i++){await new Promise(r=>requestAnimationFrame(r));const n=performance.now();samples.push(n-last);last=n;}
    samples.sort((a,b)=>a-b);
    return {p50:samples[90].toFixed(2),p90:samples[162].toFixed(2)};
  })()`);

  // The director rewrites simMask every frame — freeze it behind a getter once,
  // then steer the closure value per phase.
  await ev(cdp, `(()=>{const w=window.__sf.water;window.__oceanMask={v:7};
    Object.defineProperty(w,'simMask',{configurable:true,get:()=>window.__oceanMask.v,set:()=>{}});return true;})()`);
  // interleave A/B twice to cancel drift
  const out = [];
  for (const [label, mask] of [["sim ON", 7], ["sim OFF", 0], ["sim ON", 7], ["sim OFF", 0]]) {
    await ev(cdp, `window.__oceanMask.v=${mask};true`);
    await sleep(800);
    out.push([label, await measure()]);
  }
  for (const [l, r] of out) console.log(`[split] ${l}: p50 ${r.p50} ms  p90 ${r.p90} ms`);
  process.exit(0);
}
main().catch((e) => { console.error("[split] fatal", e); process.exit(1); });
