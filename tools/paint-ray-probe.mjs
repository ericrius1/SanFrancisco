// Verifies building-ray refinement (core/buildingRayRefine.ts): paint/golf/cursor
// rays aimed at citygen buildings BEYOND the exact-collider ring (90 m) must land
// on the VISIBLE chunk-LOD prism wall, not the loose baked OBB that overshoots the
// footprint by ~2 m — and a ray aimed through a GAP between buildings must NOT
// report a mid-air building hit at the loose box.
//
// Method: teleport to the victorian district at (900, 2400), settle, then sweep
// 480 near-horizontal rays from eye height. Rays whose UNREFINED cast (refiner
// detached) reports a building at 95-190 m are candidates. For a sample of them,
// compare: loose-box distance vs refined distance vs an in-page THREE.Raycaster
// ground truth against the rendered cityGenChunkLOD / cityGenBuilding meshes
// (lodVisibility-filtered). Wall rays must refine to within 0.5 m of the visible
// surface; gap rays (no visible triangle within ±4 m of the box) must stop
// reporting the phantom hit.
//   node tools/paint-ray-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "paint-ray-probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push(m.params?.exceptionDetails?.exception?.description || "exn"); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function evaluate(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.05) { try { await evaluate(c, `window.__sf.tick(${dt})`); } catch {} }

const PX = 900, PZ = 2400;

// In-page helpers: refined cast (worldQueries — the paint path), unrefined cast
// (refiner detached — the OLD behaviour), a direct physics.raycastWorld (the golf
// path), and a THREE.Raycaster ground truth over the rendered citygen meshes.
const SETUP = `(() => {
  const s = window.__sf, T = s.THREE;
  const caster = new T.Raycaster();
  const targetsOf = () => {
    const list = [];
    for (const ch of s.scene.children) {
      if (ch.name === "cityGenChunkLOD" || ch.name === "cityGenBuilding" || ch.name === "cityGenInterior") list.push(ch);
    }
    return list;
  };
  // ascending distances of VISIBLE citygen triangles along the ray
  const visHits = (o, d, max) => {
    caster.ray.origin.copy(o); caster.ray.direction.copy(d);
    caster.near = 0; caster.far = max;
    const out = [];
    for (const h of caster.intersectObjects(targetsOf(), true)) {
      if (h.object.visible === false) continue;
      if (h.object.name === "cityGenChunkLOD") {
        const vis = h.object.geometry.getAttribute("lodVisibility");
        if (h.face && vis && vis.getX(h.face.a) < 0.5) continue; // hidden prism
      }
      out.push(Math.round(h.distance * 1000) / 1000);
    }
    return out;
  };
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const pack = (o, h) => h ? { kind: h.kind, dist: Math.round(o.distanceTo(h.point) * 1000) / 1000, y: Math.round(h.point.y * 100) / 100 } : null;
  const castQ = (o, d, max) => pack(o, s.worldQueries.raycast(o, d, max));
  const castPhys = (o, d, max) => pack(o, s.physics.raycastWorld(o, d, max));
  const castLoose = (o, d, max) => {
    s.physics.setBuildingRayRefiner(null);
    const r = castPhys(o, d, max);
    s.physics.setBuildingRayRefiner(s.buildingRayRefiner);
    return r;
  };
  window.__probe = { T, V, visHits, castQ, castPhys, castLoose };
  return 1;
})()`;

// Sweep + classify + verify, all in-page (one evaluate; world is static between ticks)
const RUN = (ox, oy, oz) => `(() => {
  const P = window.__probe;
  const o = P.V(${ox}, ${oy}, ${oz});
  const MAX = 200, LO = 95, HI = 190;
  const N = 1440; // 0.25° steps — a ~2m corner overshoot spans ~1° at 120m
  const candidates = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const d = P.V(Math.sin(a), 0.02, Math.cos(a)).normalize();
    const loose = P.castLoose(o, d, MAX);
    if (loose && loose.kind === "building" && loose.dist > LO && loose.dist < HI) {
      candidates.push({ deg: Math.round((a * 180) / Math.PI * 100) / 100, a, loose });
    }
  }
  // classify with the (cheap) refined casts first, then vis-verify a sample.
  // wall = the refined cast still reports a building within the ±4m window of
  // the loose hit; gap = the loose hit vanished (continued past / other kind).
  const walls = [], gaps = [];
  for (const cnd of candidates) {
    const d = P.V(Math.sin(cnd.a), 0.02, Math.cos(cnd.a)).normalize();
    cnd.refined = P.castQ(o, d, MAX); // the paint/cursor path (worldQueries)
    cnd.refinedPhys = P.castPhys(o, d, MAX); // the golf path (raw physics)
    const r = cnd.refinedPhys;
    const moved = r && r.kind === "building" && Math.abs(r.dist - cnd.loose.dist) <= 4.2;
    // spread the wall sample around the sweep instead of 12 adjacent rays
    if (moved) { if (walls.length < 12 && !walls.some((w) => Math.abs(w.deg - cnd.deg) < 3)) walls.push(cnd); }
    else if (gaps.length < 10) gaps.push(cnd);
  }
  const verify = (cnd) => {
    const d = P.V(Math.sin(cnd.a), 0.02, Math.cos(cnd.a)).normalize();
    const vis = P.visHits(o, d, MAX);
    cnd.visInWindow = vis.filter((v) => Math.abs(v - cnd.loose.dist) <= 4.05);
    const r = cnd.refinedPhys;
    cnd.visNearRefined = r && r.kind === "building" ? vis.reduce((m, v) => Math.min(m, Math.abs(v - r.dist)), Infinity) : null;
    delete cnd.a;
  };
  for (const cnd of walls) verify(cnd);
  for (const cnd of gaps) verify(cnd);
  return { swept: N, candidates: candidates.length, walls, gaps };
})()`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  let failures = 0;
  const fail = (msg) => { failures++; console.log("  FAIL:", msg); };
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", "--window-size=1280,800", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current && window.__sf.buildingRayRefiner)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5); if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await evaluate(c, `window.__sf.map.groundHeight(${PX},${PZ})`);
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(${PX},y,${PZ});p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[${PX},y,${PZ}],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 25; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    // settle: stream cells, merge chunks, drain solid queues — until prisms exist
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 10; i++) await tick(c);
      const ready = await evaluate(c, `(()=>{const s=window.__sf;let ch=0;for(const o of s.scene.children) if(o.name==="cityGenChunkLOD") ch++;const st=s.citygenRing.current.stats();return ch>0&&st.cells>0?ch:0;})()`);
      if (ready && round >= 6) { console.log(`[probe] settled: ${ready} chunk meshes in scene`); break; }
    }
    for (let i = 0; i < 60; i++) await tick(c);
    console.log("[probe] ring stats:", JSON.stringify(await evaluate(c, "window.__sf.citygenRing.current.stats()")));
    console.log("[probe] lod entries near:", JSON.stringify((await evaluate(c, `window.__sf.citygenRing.current.debugEntriesNear(${PX},${PZ},200)`)).filter((e) => e.state === "lod").slice(0, 5)));

    await evaluate(c, SETUP);
    const eye = gy + 2 + 0.6;
    const rep = await evaluate(c, RUN(PX, eye, PZ));
    console.log(`[probe] sweep: ${rep.swept} rays, ${rep.candidates} loose building hits in the 95-190m lod band`);
    if (rep.candidates < 8) fail(`too few lod-band candidates (${rep.candidates}) — wrong spot or ring not settled`);

    console.log("[probe] WALL RAYS (loose box vs refined vs visible mesh):");
    let wallPass = 0;
    for (const w of rep.walls) {
      const r = w.refined;
      const okKind = r && r.kind === "building";
      const okVis = w.visNearRefined !== null && w.visNearRefined <= 0.5;
      const ok = okKind && okVis;
      if (ok) wallPass++;
      console.log(`  bearing ${String(w.deg).padStart(5)}°  loose ${w.loose.dist.toFixed(2)}m -> refined ${r ? r.dist.toFixed(2) + "m" : "MISS"} (Δ ${r ? (r.dist - w.loose.dist).toFixed(2) : "-"}m)  visΔ ${w.visNearRefined === null ? "-" : w.visNearRefined.toFixed(3)}m  ${ok ? "OK" : "BAD"}`);
      if (!ok) fail(`wall ray ${w.deg}°: refined hit not on visible surface (visΔ ${w.visNearRefined})`);
      // worldQueries (paint) and raw physics (golf) must agree on the wall
      if (r && w.refinedPhys && Math.abs(r.dist - w.refinedPhys.dist) > 0.01) fail(`wall ray ${w.deg}°: worldQueries ${r.dist} != physics ${w.refinedPhys.dist}`);
    }
    if (wallPass < Math.min(8, rep.walls.length)) fail(`only ${wallPass} wall rays verified`);
    if (rep.walls.length === 0) fail("no wall rays found");

    console.log("[probe] GAP RAYS (loose box hit with NO visible wall within ±4m — must not splat mid-air):");
    if (rep.gaps.length === 0) console.log("  (none found in sweep — every loose hit had a wall nearby)");
    for (const g of rep.gaps) {
      const r = g.refinedPhys;
      // ground truth: was there really no visible triangle near the loose hit?
      const trueGap = g.visInWindow.length === 0;
      const noPhantom = !r || r.kind !== "building" || r.dist > g.loose.dist + 3.9 || (g.visNearRefined !== null && g.visNearRefined <= 0.5);
      console.log(`  bearing ${String(g.deg).padStart(5)}°  loose ${g.loose.dist.toFixed(2)}m -> refined ${r ? r.kind + " " + r.dist.toFixed(2) + "m" : "pass-through"}  visInWindow=${g.visInWindow.length}  ${noPhantom ? "OK" : "BAD"}`);
      if (trueGap && !noPhantom) fail(`gap ray ${g.deg}°: still reports phantom building at ${r.dist}m (loose ${g.loose.dist}m)`);
      if (r && r.kind === "building" && g.visNearRefined !== null && g.visNearRefined > 0.5) fail(`gap ray ${g.deg}°: continued hit not on a visible surface (visΔ ${g.visNearRefined})`);
      if (!trueGap && (!r || r.kind !== "building")) console.log(`    note: visible wall existed near the loose hit but the cast ended ${r ? r.kind : "empty"} — check window edges`);
    }
    const trueGaps = rep.gaps.filter((g) => g.visInWindow.length === 0).length;
    console.log(`[probe] true gap rays verified: ${trueGaps}`);

    console.log("[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    if (c.errs.length) failures++;
    console.log(failures ? `[probe] FAIL (${failures})` : "[probe] PASS");
    process.exitCode = failures ? 1 : 0;
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
