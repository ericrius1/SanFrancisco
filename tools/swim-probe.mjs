// Swim + underwater-camera acceptance probe (real boot, real rAF loop, WebGPU).
//
// Proves two fixes:
//   1. walk.ts swim buoyancy now rests the capsule with the waterline at the
//      chest (body submerged) instead of floating the whole avatar on top, and
//      Shift dives you under + holding it keeps you under; releasing floats up.
//   2. camera.ts no longer clamps the chase cam to sea level (y=0), so diving
//      takes the camera underwater with the player instead of locking overhead.
//
// Boots the app, finds the deepest bay-water cell near the start, teleports the
// player there in walk mode, then drives the REAL loop with injected keys and
// reads player/camera geometry back out.
//
//   node tools/swim-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1280, H = 800;
const OUT = "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/4d6c7db5-7e83-4297-b902-5b8322365ffd/scratchpad";
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
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + expr); }

let pass = 0, fail = 0;
const check = (ok, label) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); };

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8799" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(URL, 60000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-swim-" + Date.now())}`,
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
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.map && window.__sf.chase)", 120000);
    await sleep(2500); // let the first frames stream tiles around the spawn
    console.log("[swim] booted; searching for bay water NEAR the spawn (keeps tiles/GPU warm)...");

    // Search rings around the actual spawn for interior bay water of a real,
    // moderate depth. Staying near the spawn avoids teleporting into an unloaded
    // far-map corner (which dropped the WebGPU context last run).
    const spot = await evaluate(c, `(()=>{const s=window.__sf,m=s.map,p=s.player;
      const ox=p.position.x, oz=p.position.z; let best=null;
      for(let r=60;r<=600;r+=40) for(let a=0;a<6.2832;a+=Math.PI/12){
        const x=ox+Math.cos(a)*r, z=oz+Math.sin(a)*r;
        if(!m.isWater(x,z)) continue; const g=m.groundHeight(x,z);
        if(g<-40||g>-4) continue;                         // real bathymetry band
        if(!m.isWater(x+40,z)||!m.isWater(x-40,z)||!m.isWater(x,z+40)||!m.isWater(x,z-40)) continue; // interior
        if(!best||g<best.g) best={x:+x.toFixed(1),z:+z.toFixed(1),g:+g.toFixed(2)};
      } return best;})()`);
    if (!spot) { console.log("[swim] no interior bay water near spawn — FAIL"); check(false, "found bay water near spawn"); throw new Error("no water"); }
    console.log(`[swim] bay water @ (${spot.x}, ${spot.z})  seabed y=${spot.g.toFixed(2)}`);
    check(spot.g < -6, `found deep bay water near spawn (seabed ${spot.g.toFixed(1)}m, need < -6)`);

    // Put the player in the water. swimEnter=true makes walk.enter drop us at the
    // waterline instead of hopping to the nearest shore (the boat-exit path).
    const setup = await evaluate(c, `(()=>{const s=window.__sf,p=s.player;
      s.sky.cycleEnabled=false; s.input.suspended=false;
      p.position.set(${spot.x},0,${spot.z}); p.renderPosition.set(${spot.x},0,${spot.z});
      p.swimEnter=true; p.trySwitch('walk'); s.chase.pitch=0.15;
      return {mode:p.mode, y:+p.position.y.toFixed(2)};})()`);
    console.log(`[swim] entered water, mode=${setup.mode}, y=${setup.y}`);
    // fail fast if the entry hopped us onto land instead of into the water
    await sleep(800);
    const settled = await evaluate(c, `(()=>{const p=window.__sf.player;
      return {cy:+p.position.y.toFixed(2), seabed:+window.__sf.map.groundHeight(p.position.x,p.position.z).toFixed(2)};})()`);
    check(settled.seabed < -4 && settled.cy < 1.5, `stayed in the water, not hopped to shore (y=${settled.cy}, seabed=${settled.seabed})`);

    const clearKeys = `window.__sf.input.keys.clear(); window.__sf.input.mouseDX=0; window.__sf.input.mouseDY=0;`;
    // capsule centre y, chase-camera y, seabed under the camera + under the player.
    // waterHeight isn't on __sf, but open-bay swell is <0.3m so the calm surface
    // sits at y≈0; we assert RELATIVE changes (idle→dive→release) that don't need
    // the exact surface, plus the absolute camera-underwater threshold vs the old
    // sea-level clamp (0.7).
    const readState = `(()=>{const s=window.__sf,p=s.player; const cx=p.position.x, cz=p.position.z;
      return {cy:p.position.y, camY:s.camera.position.y,
        camFloorG:s.map.effectiveGround(s.camera.position.x,s.camera.position.z),
        seabed:s.map.groundHeight(cx,cz)};})()`;

    // 1) IDLE — let buoyancy settle
    await evaluate(c, clearKeys);
    await sleep(1800);
    const idle = await evaluate(c, readState);
    console.log(`[swim] IDLE   centre y=${idle.cy.toFixed(2)}  camera y=${idle.camY.toFixed(2)}  seabed=${idle.seabed.toFixed(2)}`);
    const idleTop = idle.cy + 0.9, idleBottom = idle.cy - 0.9;
    // waterline ~0 in open bay. Submerged body: centre below surface, head near/above.
    check(idle.cy < 0.2, `idle: body centre at/under the surface (y=${idle.cy.toFixed(2)} ≤ ~0), not floating on top`);
    check(idleTop > -0.6 && idleTop < 1.4, `idle: head near the waterline (top=${idleTop.toFixed(2)}), not sunk, not perched high`);
    check(idleBottom > idle.seabed + 0.3, `idle: buoyancy holds you off the seabed (bottom=${idleBottom.toFixed(2)} > seabed ${idle.seabed.toFixed(2)})`);

    // 2) DIVE — hold Shift (descend); expect to sink well below idle and stay under.
    // Keep pitch low so the chase cam trails just above the diver and follows under.
    await evaluate(c, `${clearKeys} window.__sf.input.keys.add('ShiftLeft'); window.__sf.chase.pitch=0.15;`);
    await sleep(3200);
    const dive = await evaluate(c, readState);
    console.log(`[swim] DIVE   centre y=${dive.cy.toFixed(2)}  camera y=${dive.camY.toFixed(2)}  camFloor=${dive.camFloorG.toFixed(2)}`);
    check(dive.cy < idle.cy - 1.2, `dive: Shift takes you well under (centre ${dive.cy.toFixed(2)} < idle ${idle.cy.toFixed(2)} − 1.2)`);
    check(dive.cy - 0.9 > dive.seabed - 0.1, `dive: does not burrow through the seabed (bottom=${(dive.cy - 0.9).toFixed(2)} ≥ seabed ${dive.seabed.toFixed(2)})`);
    // THE camera fix: diving deep should pull the camera below the old sea-level clamp (y=0.7)
    check(dive.camY < 0.5, `camera followed underwater (camera y=${dive.camY.toFixed(2)} < 0.5; old clamp pinned it ≥ 0.7)`);

    // --- underwater overlay: active while submerged, waterline band positioned ---
    const ov = await evaluate(c, `(()=>{const r=document.getElementById('uw-root'); if(!r) return null;
      const cs=getComputedStyle(r), tint=r.children[0], body=r.children[1];
      const tOp=+getComputedStyle(tint).opacity, bTf=getComputedStyle(body).transform;
      return {vis:cs.visibility, tintOpacity:+tOp.toFixed(3), tintBg:getComputedStyle(tint).backgroundColor, bodyTransform:bTf};})()`);
    console.log(`[swim] overlay while submerged: ${JSON.stringify(ov)}`);
    check(ov && ov.vis === "visible", `underwater overlay is visible while submerged`);
    check(ov && ov.tintOpacity > 0.1, `tint layer is casting the scene (opacity=${ov?.tintOpacity})`);
    check(ov && /matrix|translate/.test(ov.bodyTransform) && ov.bodyTransform !== "none", `waterline band is positioned by pitch (transform=${ov?.bodyTransform?.slice(0, 24)})`);

    // --- seabed pillars: spatial-reference spires stream in around you ---
    const pil = await evaluate(c, `(()=>{const p=window.__sf.seaPillars; return p?{count:p.mesh.count,visible:p.mesh.visible}:null;})()`);
    console.log(`[swim] sea pillars: ${JSON.stringify(pil)}`);
    check(pil && pil.visible && pil.count > 0, `seabed pillars populated around the diver (count=${pil?.count})`);

    // --- water underside ("ceiling" seen from below) shows while submerged ---
    const lid = await evaluate(c, `(()=>{const u=window.__sf.water.underside; return {visible:u.visible,y:+u.position.y.toFixed(2)};})()`);
    console.log(`[swim] water underside: ${JSON.stringify(lid)}`);
    check(lid && lid.visible, `water surface underside (ceiling) is drawn while submerged`);

    // 3) RELEASE — let go, buoyancy floats you back up toward the surface
    await evaluate(c, clearKeys);
    await sleep(2500);
    const up = await evaluate(c, readState);
    console.log(`[swim] RISE   centre y=${up.cy.toFixed(2)}  camera y=${up.camY.toFixed(2)}`);
    check(up.cy > dive.cy + 1.0, `release: buoyancy floats you back up (centre ${up.cy.toFixed(2)} > dive ${dive.cy.toFixed(2)} + 1.0)`);
    check(Math.abs(up.cy - idle.cy) < 0.8, `release: returns near the idle surface rest (${up.cy.toFixed(2)} ≈ ${idle.cy.toFixed(2)})`);
    check(up.camY > dive.camY + 0.5, `camera rose back with you (${up.camY.toFixed(2)} > ${dive.camY.toFixed(2)})`);
    // camera is above the surface again → overlay must switch off (no stuck tint)
    const ovUp = await evaluate(c, `(()=>{const r=document.getElementById('uw-root'); return r?getComputedStyle(r).visibility:'none';})()`);
    check(ovUp === "hidden", `overlay clears when the camera is back above water (visibility=${ovUp})`);

    // proof screenshots: dive deep, then look DOWN (into the depths) and UP
    // (toward the bright surface) so the waterline band visibly tracks pitch.
    await evaluate(c, `${clearKeys} window.__sf.input.keys.add('ShiftLeft');`);
    await sleep(2600);
    await evaluate(c, `window.__sf.chase.pitch=0.75;`); // look down
    await sleep(500);
    const sDown = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    writeFileSync(path.join(OUT, "swim_dive_down.jpg"), Buffer.from(sDown.data, "base64"));
    await evaluate(c, `window.__sf.chase.pitch=-0.5;`); // look up toward the surface
    await sleep(500);
    const sUp = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    writeFileSync(path.join(OUT, "swim_dive_up.jpg"), Buffer.from(sUp.data, "base64"));
    await evaluate(c, `window.__sf.chase.pitch=0.12;`); // level
    await sleep(400);
    const s1 = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    writeFileSync(path.join(OUT, "swim_dive.jpg"), Buffer.from(s1.data, "base64"));
    console.log("[swim] saved swim_dive.jpg + swim_dive_down.jpg + swim_dive_up.jpg");

    const errs = [...new Set(c.errors)].slice(0, 6);
    check(c.errors.length === 0, `no uncaught runtime errors (${c.errors.length})`);
    if (errs.length) console.log("  errors:", JSON.stringify(errs));

    console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"}  (${pass} passed, ${fail} failed)`);
    c.close();
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
