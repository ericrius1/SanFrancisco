// Verifies the interior spawn-gate + local-frame layout fix end-to-end:
//   (a) GATE: park the player on the sidewalk at points that are OUTSIDE the real
//       footprint but INSIDE the old inflated-AABB gate (the "flash zone"). Assert
//       no interior builds and isPlayerInside()===false. Screenshot: no panels in
//       mid-air outside the walls.
//   (b) ENTER: step inside the real polygon → interior builds, isPlayerInside()===
//       true. Screenshot inside + from outside (nothing protrudes through facades).
//   (c) LEAVE: walk clear → interior disposes.
//   node tools/interior-fix-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "interior-fix");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout " + url); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push((m.params?.exceptionDetails?.exception?.description || "exn").split("\n")[0]); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); }
  // every send carries a hard timeout — a Runtime.evaluate raced by a page reload
  // can otherwise never resolve and hang the whole probe.
  send(method, params = {}, ms = 30000) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { const t = setTimeout(() => { this.#p.delete(id); rej(new Error(`cdp timeout ${method}`)); }, ms); this.#p.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); }); } close() { this.#ws.close(); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.05) { try { await ev(c, `window.__sf.tick(${dt})`); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); console.log("  saved", name); }

// Target: victorian bldg 288543110 @ (951.5,2400.5). Flash point (959.9,2395.1) is
// 0.87 m OUTSIDE the real footprint but inside the old AABB+1.2 gate.
const B = { cx: 951.5, cz: 2400.5, base: 47.3, top: 57.8, flash: [959.9, 2395.1] };
// sidewalk points verified OFFLINE to be >1 m outside EVERY nearby footprint yet
// inside the old AABB+1.2 gate — each one used to flash an interior in mid-air.
const SIDEWALK = [[936.5, 2394.6], [936.5, 2404.7], [960.4, 2395.1], [936.5, 2403.9], [937.7, 2394.6], [936.0, 2395.6]];

const place = (c, x, z, y) => ev(c, `(()=>{const s=window.__sf,p=s.player; const y=${y ?? "s.map.groundHeight(" + x + "," + z + ")+1.1"};
  p.position.set(${x},y,${z}); p.renderPosition.copy(p.position);
  s.physics.world.setBodyTransform(p.body,[${x},y,${z}],[0,0,0,1]); return 1;})()`);
const setCam = (c, px, py, pz, lx, ly, lz) => ev(c, `(()=>{const cam=window.__sf.camera; cam.position.set(${px},${py},${pz}); cam.lookAt(${lx},${ly},${lz}); return 1;})()`);
const status = (c) => ev(c, `(()=>{const r=window.__sf.citygenRing.current; return { inside:r.isPlayerInside(), interiors:r.stats().interiors, detail:r.stats().detail }; })()`);

async function main() {
  await mkdir(OUT, { recursive: true });
  // SF_URL: point at an already-running server (prod build via server/server.mjs —
  // immune to vite HMR reloads mid-probe); otherwise spawn a fresh vite dev.
  let baseUrl = process.env.SF_URL || null;
  let dev = null;
  if (!baseUrl) {
    const vitePort = await freePort(), relayPort = await freePort();
    baseUrl = `http://127.0.0.1:${vitePort}`;
    dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  }
  const chromePath = await findChrome(); const dport = await freePort(); let chrome; let failed = false;
  try {
    await waitHttp(baseUrl, 120000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${baseUrl}/?autostart=1&profile=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    console.log("[probe] booted");
    await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11.0);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);

    // stream the district; wait until our target building has faded to a detail mesh
    await place(c, B.cx, B.cz, B.base + 1.2);
    for (let i = 0; i < 120; i++) { await tick(c); if (i % 30 === 29) console.log(`[probe] settling ${i + 1}/120`); }
    await waitEval(c, `(()=>{const bs=window.__sf.citygenRing.current.debugBuildings(); return bs.some(b=>Math.hypot(b.cx-${B.cx},b.cz-${B.cz})<8); })()`, 40000);
    console.log("[probe] target is a detail building");

    // ---- (a) GATE: sidewalk flash-zone points must NOT build an interior ---------
    let gatePass = true;
    // move OUT first so any interior from the settle disposes
    await place(c, B.cx + 40, B.cz); for (let i = 0; i < 12; i++) await tick(c);
    for (let k = 0; k < SIDEWALK.length; k++) {
      const [x, z] = SIDEWALK[k];
      await place(c, x, z, B.base + 1.1);
      for (let i = 0; i < 8; i++) await tick(c);
      const st = await status(c);
      const ok = !st.inside && st.interiors === 0;
      gatePass = gatePass && ok;
      console.log(`  [gate] sidewalk (${x},${z})  inside=${st.inside} interiors=${st.interiors}  -> ${ok ? "PASS (no flash)" : "FAIL"}`);
    }
    // exterior beauty shot from the flash side (should show a clean facade, no floating panels)
    await place(c, B.flash[0] + 6, B.flash[1] - 6, B.base + 1.1);
    await setCam(c, B.cx + 16, B.top + 4, B.cz - 16, B.cx, B.base + 4, B.cz);
    for (let i = 0; i < 6; i++) await tick(c);
    await setCam(c, B.cx + 16, B.top + 4, B.cz - 16, B.cx, B.base + 4, B.cz);
    await sleep(300); await shot(c, "a_sidewalk_exterior.jpg");

    // ---- (b) ENTER: inside the real polygon → interior builds --------------------
    await place(c, B.cx, B.cz, B.base + 1.2);
    for (let i = 0; i < 20; i++) await tick(c);
    const inSt = await status(c);
    const enterPass = inSt.inside && inSt.interiors >= 1;
    console.log(`  [enter] centroid  inside=${inSt.inside} interiors=${inSt.interiors}  -> ${enterPass ? "PASS" : "FAIL"}`);
    const floorY = await ev(c, `window.__sf.map.groundHeight(${B.cx},${B.cz})`);
    // interior shot: stand in a corner looking across the plan
    await setCam(c, B.cx - 4.5, floorY + 1.5, B.cz - 4.5, B.cx + 3, floorY + 1.2, B.cz + 3);
    for (let i = 0; i < 8; i++) await tick(c);
    await setCam(c, B.cx - 4.5, floorY + 1.5, B.cz - 4.5, B.cx + 3, floorY + 1.2, B.cz + 3);
    await sleep(300); await shot(c, "b_interior_inside.jpg");
    // from outside + above: confirm rooms/furniture sit WITHIN the walls (nothing pokes)
    await setCam(c, B.cx + 14, B.top + 8, B.cz + 14, B.cx, floorY + 2, B.cz);
    await sleep(250); await shot(c, "b_interior_from_outside.jpg");

    // ---- (c) LEAVE: interior disposes -------------------------------------------
    await place(c, B.cx + 30, B.cz);
    for (let i = 0; i < 18; i++) await tick(c);
    const outSt = await status(c);
    const leavePass = !outSt.inside && outSt.interiors === 0;
    console.log(`  [leave] +30m  inside=${outSt.inside} interiors=${outSt.interiors}  -> ${leavePass ? "PASS (disposed)" : "FAIL"}`);

    console.log("\n[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    const allPass = gatePass && enterPass && leavePass;
    console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"}  gate=${gatePass} enter=${enterPass} leave=${leavePass}`);
    failed = !allPass;
    c.close();
  } catch (e) { console.error("[probe] ERROR:", e.message); failed = true; }
  finally { chrome?.kill("SIGTERM"); if (dev) { try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } } }
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
