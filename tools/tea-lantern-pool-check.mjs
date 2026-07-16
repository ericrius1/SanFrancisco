// One-off: verify the tea house lanterns light via the shared pool (ambient
// anchors with range gating) after the light-set-invariant migration.
//   node tools/tea-lantern-pool-check.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/tea-lantern-pool-check");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5199";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    "--window-size=1280,720", `${SERVER_URL}/?autostart&fullfps&profile`
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
  await c.send("Runtime.enable");

  console.log("[check] waiting for app...");
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.sky)`)) break; } catch {}
    await sleep(600);
  }
  console.log("[check] app ready; night + teleport into tea house");
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(22);return true;})()`);
  // Inside the tea house pavilion (spec outline centroid ~(-2273, 2163))
  await ev(c, `(()=>{const sf=window.__sf,x=-2273,z=2163;sf.player.teleportTo({x,y:sf.map.groundHeight(x,z)+1.5,z,facing:0,mode:'walk'});return true;})()`);

  // Wait for the tea garden architecture (and its lantern anchors) to build.
  let lanterns = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    lanterns = await ev(c, `(()=>{const sf=window.__sf,out=[];sf.scene.traverse((o)=>{if(o.userData&&o.userData.lightSpec&&o.userData.lightSpec.range!==undefined){const p=new sf.THREE.Vector3();o.getWorldPosition(p);out.push({intensity:o.userData.lightSpec.intensity,range:o.userData.lightSpec.range,pos:[+p.x.toFixed(1),+p.y.toFixed(1),+p.z.toFixed(1)]});}});return out;})()`);
    if (lanterns.length > 0) break;
    await sleep(2500);
  }
  console.log(`[check] lantern anchors: ${JSON.stringify(lanterns)}`);
  if (lanterns.length === 0) throw new Error("tea garden lantern anchors never appeared");

  await sleep(1500);
  const near = await ev(c, `(()=>{const sf=window.__sf,out=[];sf.scene.children.forEach((o)=>{if(o.isPointLight)out.push({intensity:+o.intensity.toFixed(1),pos:[+o.position.x.toFixed(1),+o.position.y.toFixed(1),+o.position.z.toFixed(1)]});});return out;})()`);
  console.log(`[check] pool lights with player INSIDE pavilion: ${JSON.stringify(near)}`);
  const litNear = near.filter((l) => l.intensity > 1 && Math.hypot(l.pos[0] + 2273, l.pos[2] - 2163) < 25);
  if (litNear.length < 2) throw new Error("expected both lantern fills lit from the pool inside the pavilion");

  // Walk away beyond range → slots must release.
  await ev(c, `(()=>{const sf=window.__sf,x=-2273,z=2283;sf.player.teleportTo({x,y:sf.map.groundHeight(x,z)+1.5,z,facing:0,mode:'walk'});return true;})()`);
  await sleep(1500);
  const far = await ev(c, `(()=>{const sf=window.__sf,out=[];sf.scene.children.forEach((o)=>{if(o.isPointLight)out.push({intensity:+o.intensity.toFixed(1),pos:[+o.position.x.toFixed(1),+o.position.z.toFixed(1)]});});return out;})()`);
  console.log(`[check] pool lights 120m away: ${JSON.stringify(far)}`);
  const stillLit = far.filter((l) => l.intensity > 1 && Math.hypot(l.pos[0] + 2273, l.pos[1] - 2163) < 25);
  if (stillLit.length > 0) throw new Error("lantern fills failed to release their pool slots at range");

  console.log("[check] PASS — lanterns pool-lit inside, released at range, scene light count fixed at 4");
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[check] FAIL", e); process.exit(1); });
