// Walkthrough test: boots the FULL app, drives the player into a generated
// building and walks it room-to-room, capturing the real in-game chase camera
// (not a teleported camera) — the honest "what you see when you go inside" test.
//   node tools/citygen-walkthrough-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "citygen-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push((m.params?.exceptionDetails?.exception?.description || "exn").split("\n")[0]); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.033) { try { await ev(c, `window.__sf.tick(${dt})`); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); console.log("  saved", name); }

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort(); const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 120000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-walk-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    console.log("[probe] booted");
    // day; keep PLAYER + CHASE CAMERA LIVE (that's the whole point). Just quiet the AI cars.
    await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11.0);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{} return 1;})()`);
    const spot = (process.env.SF_SPOT || "900,2400").split(",").map(Number);
    // teleport near the district and stream detail buildings
    await ev(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${spot[0]},${spot[1]})+2; p.position.set(${spot[0]},y,${spot[1]}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${spot[0]},y,${spot[1]}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 90; i++) await tick(c);
    const b = await ev(c, `(()=>{const bs=window.__sf.citygenRing.current.debugBuildings(); if(!bs.length) return null;
      // nearest detail building to the district spot
      bs.sort((a,b)=>((a.cx-${spot[0]})**2+(a.cz-${spot[1]})**2)-((b.cx-${spot[0]})**2+(b.cz-${spot[1]})**2));
      return bs[0];})()`);
    if (!b) { console.log("[probe] no detail building"); c.close(); return; }
    console.log("[probe] target building:", JSON.stringify(b));

    // Drive the player: place at building centre (interior builds), then WALK the
    // body around with real velocity so the live chase camera frames the rooms.
    const floorY = await ev(c, `window.__sf.map.groundHeight(${b.cx},${b.cz})`);
    const put = (x, z, hdg) => ev(c, `(()=>{const s=window.__sf,p=s.player; p.position.set(${x},${floorY}+1.1,${z}); p.renderPosition.copy(p.position); p.heading=${hdg};
      s.physics.world.setBodyTransform(p.body,[${x},${floorY}+1.1,${z}],[0,Math.sin(${hdg}/2),0,Math.cos(${hdg}/2)]); return 1;})()`);
    const walk = async (hdg, frames) => { for (let i = 0; i < frames; i++) { await ev(c, `(()=>{const s=window.__sf,p=s.player; p.heading=${hdg};
      s.physics.world.setBodyVelocity(p.body,[Math.sin(${hdg})*3.2, s.physics.world.getBodyVelocity? s.physics.world.getBodyVelocity(p.body)[1]:0, Math.cos(${hdg})*3.2],[0,0,0]); return 1;})()`).catch(()=>{}); await tick(c); } };

    // enter at centre + let the interior build and the chase settle
    await put(b.cx, b.cz, 0);
    for (let i = 0; i < 25; i++) await tick(c);
    console.log("[probe] interiors:", await ev(c, "window.__sf.citygenRing.current.stats().interiors"));
    await sleep(300); await shot(c, "citygen_walk1.jpg");
    // turn + walk toward a wall/room, capturing the chase view
    await walk(Math.PI * 0.5, 14); await sleep(200); await shot(c, "citygen_walk2.jpg");
    await walk(Math.PI * 1.15, 16); await sleep(200); await shot(c, "citygen_walk3.jpg");
    await walk(Math.PI * 1.75, 14); await sleep(200); await shot(c, "citygen_walk4.jpg");
    console.log("[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    c.close(); console.log("[probe] done");
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
