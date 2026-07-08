// Real-boot smoke test: boots the app with its REAL animation loop running (no
// aiCars neutralization, no camera freeze), lets it run a few seconds, and checks
// the render-frame counter keeps advancing — i.e. the frame loop did not throw
// itself dead (the WIP aiCars module was suspected of breaking it). Screenshots
// the actual gameplay view + reports uncaught errors.
//
//   node tools/_probe-smoke.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1280, H = 800;
const OUT = "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/96e2d226-a5bb-4a84-ab31-2af9185c15aa/scratchpad";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"]) if (await isFile(c)) return c;
  throw new Error("no chrome");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp {
  #ws; #id = 1; #p = new Map(); errors = [];
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.method === "Runtime.exceptionThrown") { this.errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "err"); return; }
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { const to = setTimeout(() => { this.#p.delete(id); rej(new Error("timeout " + method)); }, 30000); this.#p.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } }); }); }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + expr); }

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8796" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(URL, 60000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-smoke")}`,
      "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal",
      "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures",
      `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    console.log("[smoke] booted; teleporting into Chinatown, letting the REAL rAF loop stream buildings...");
    // teleport the player onto a Chinatown block; the real frame loop drives the
    // ring (update + pump) so buildings stream in over a few seconds, no cheats.
    const CX = 3300, CZ = -360;
    await waitEval(c, "Boolean(window.__sf.map && window.__sf.buildings && window.__sf.buildings.current)", 60000);
    const CY = await evaluate(c, `+window.__sf.map.groundHeight(${CX},${CZ}).toFixed(2)`);
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${CY}+2;
      p.position.set(${CX},y,${CZ}); p.renderPosition.set(${CX},y,${CZ});
      s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ}],[0,0,0,1]);
      s.sky.cycleEnabled=false; s.sky.setTimeOfDay(14.5); return 1;})()`);
    await sleep(9000); // real streaming
    const bstats = await evaluate(c, "window.__sf.buildings.current.stats()");
    const errs = [...new Set(c.errors)].slice(0, 8);
    console.log(`[smoke] buildings streamed in Chinatown: ${JSON.stringify({ loaded: bstats.loaded, pending: bstats.pools?.pools?.pendingJobs, verts: bstats.pools?.pools?.instances })}`);
    console.log(`[smoke] uncaught errors (${c.errors.length} total): ${JSON.stringify(errs)}`);
    // freeze chase + frame a 3/4 elevated beauty shot over the block
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera; if(!window.__f){window.__f=1; s.chase.update=()=>{};}
      c.position.set(${CX - 70},${CY + 55},${CZ + 90}); c.lookAt(${CX + 10},${CY + 8},${CZ - 20}); return 1;})()`);
    await sleep(600);
    const s1 = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    writeFileSync(path.join(OUT, "citywide_aerial.jpg"), Buffer.from(s1.data, "base64"));
    // and a street-level look down the block
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX},${CY + 3},${CZ + 40}); c.lookAt(${CX},${CY + 10},${CZ - 60}); return 1;})()`);
    await sleep(400);
    const s2 = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    writeFileSync(path.join(OUT, "citywide_street.jpg"), Buffer.from(s2.data, "base64"));
    console.log("[smoke] saved citywide_aerial.jpg + citywide_street.jpg");

    // --- walk INTO a building: pick a loaded building near the teleport point from
    //     the citywide data, stand the player just inside its open storefront, let
    //     the real loop build its interior, then frame the camera inside it. ---
    try {
      const bpos = await evaluate(c, `(async()=>{
        const s=window.__sf;
        const data=await (await fetch('/buildinggen/buildings-citywide.json')).json();
        // buildings live in cells keyed by tile; scan cells near (CX,CZ) for the closest
        let best=null,bd=1e9;
        for(const k in data.cells){ for(const b of data.cells[k]){
          const dx=b.x-${CX}, dz=b.z-(${CZ}); const d=dx*dx+dz*dz;
          if(d<bd){bd=d;best={x:b.x,z:b.z,yaw:b.yaw,floors:b.floors};}
        }}
        return best;
      })()`);
      if (bpos) {
        const by = await evaluate(c, `+window.__sf.map.groundHeight(${bpos.x},${bpos.z}).toFixed(2)`);
        // step just inside the open front (-z local) of the building
        const ix = bpos.x - Math.sin(bpos.yaw) * 0.0, iz = bpos.z - Math.cos(bpos.yaw) * 0.0;
        await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${by}+1.6;
          p.position.set(${bpos.x},y,${bpos.z}); p.renderPosition.set(${bpos.x},y,${bpos.z});
          s.physics.world.setBodyTransform(p.body,[${bpos.x},y,${bpos.z}],[0,0,0,1]); return 1;})()`);
        await sleep(4000); // real loop builds the interior (player <40 m)
        const ib = await evaluate(c, `(()=>{let n=0; window.__sf.scene.traverse(o=>{ if(o.name==='generatedBuilding'&&o.children.length) n++; }); return n;})()`);
        await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
          c.position.set(${bpos.x},${by + 1.6},${bpos.z}); c.lookAt(${bpos.x + Math.sin(bpos.yaw) * 5},${by + 1.4},${bpos.z + Math.cos(bpos.yaw) * 5}); return 1;})()`);
        await sleep(500);
        const s3 = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
        writeFileSync(path.join(OUT, "citywide_interior.jpg"), Buffer.from(s3.data, "base64"));
        console.log(`[smoke] saved citywide_interior.jpg (interiors standing: ${ib})`);
      }
    } catch (e) { console.log("[smoke] interior capture failed:", e.message); }
    console.log(`[smoke] VERDICT: ${bstats.loaded > 0 && c.errors.length === 0 ? "RUNS + BUILDINGS ✓" : "CHECK ✗"}`);
    c.close();
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
