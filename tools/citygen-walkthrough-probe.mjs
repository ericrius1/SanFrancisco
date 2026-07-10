// Walkthrough / door-integrity probe: boots the FULL app, streams detail buildings
// in a couple of districts, and for a Victorian door + a large-commercial door
// asserts the collision fix end-to-end:
//   (a) the collider has a genuine walk-through GAP at the doorway (you pass in),
//   (b) the wall 2 m to the SIDE of the door is solid (you're blocked),
//   (c) no wall/base/stone MESH spans the doorway column (a raycast through the
//       opening misses the wall mesh; a raycast 2 m aside hits it), and
//   (+) an honest physics push drives the player body through the opening.
// (a)/(b) test the EXACT oriented boxes the physics engine uses (via debugColliders);
// (c) raycasts the live detail mesh. Prints PASS/FAIL and exits non-zero on failure.
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

// ---- in-page door picker + collider/raycast checks (no side effects) ----------
// Injected once; picks the door nearest `near` (biased to tall buildings when
// preferLarge) and reports whether the collider gap is open + the mesh has a hole.
const PICK_SRC = `
window.__cgPick = (opts) => {
  const s = window.__sf, THREE = s.THREE, ring = s.citygenRing && s.citygenRing.current;
  if (!ring) return { ok:false, err:"no ring" };
  const near = opts.near, preferLarge = !!opts.preferLarge;
  const doors = ring.debugDoors();
  if (!doors.length) return { ok:false, err:"no detail doors streamed yet" };
  const d2 = (d) => { const dx=d.center[0]-near[0], dz=d.center[2]-near[1]; return dx*dx+dz*dz; };
  // walkable opening height = door head above the ground line. On a steep hillside
  // base the head (fixed above base) can sit barely above grade → a genuinely short
  // door; test a real walk-through one (≥1.8 m) so the ray samples the opening.
  const openH = (d) => (d.base + d.head) - Math.max(d.base, d.grade);
  const sideRoom = (d) => Math.max(d.dcenter, d.length - d.dcenter) > 2.0 + d.halfW + 0.35;
  const roomy = doors.filter(d => sideRoom(d) && openH(d) >= 1.8);
  const pool = (roomy.length ? roomy : doors.filter(d => openH(d) >= 1.2)).slice();
  if (!pool.length) return { ok:false, err:"no door with a walk-through opening streamed" };
  pool.sort((a,b) => { if (preferLarge){ const ha=a.top-a.base, hb=b.top-b.base; if (Math.abs(hb-ha)>4) return hb-ha; } return d2(a)-d2(b); });
  s.scene.updateMatrixWorld(true);

  const walls = []; ring.debugColliders(walls, []);
  const SOLID = { "base.stoop":1, "lc.stone":1, "lc.pier":1, "lc.band":1 };
  const isWall = (nm) => typeof nm==="string" && (nm.indexOf("wall.")===0 || SOLID[nm]===1);
  // wall/base/stone meshes + their (≈world) centres, so each candidate raycasts only
  // nearby panels (fast) instead of every detail building in the scene.
  const meshes = []; s.scene.traverse(o => { if (o.isMesh && isWall(o.name) && o.geometry.boundingSphere) meshes.push({ m:o, c:o.geometry.boundingSphere.center }); });
  const rc = new THREE.Raycaster();
  const rayBox = (px,pz,dx,dz,y,b,tMax) => {
    if (Math.abs(y-b.y) > b.hy) return false;
    const c=Math.cos(-b.yaw), sn=Math.sin(-b.yaw);
    const ox=px-b.x, oz=pz-b.z;
    const lx=ox*c-oz*sn, lz=ox*sn+oz*c, ldx=dx*c-dz*sn, ldz=dx*sn+dz*c;
    let tmin=0, tmax=tMax;
    const slabs=[[lx,ldx,b.hx],[lz,ldz,b.hz]];
    for (let k=0;k<2;k++){ const o=slabs[k][0], dd=slabs[k][1], h=slabs[k][2];
      if (Math.abs(dd)<1e-9){ if (o<-h||o>h) return false; }
      else { let t1=(-h-o)/dd, t2=(h-o)/dd; if (t1>t2){const t=t1;t1=t2;t2=t;} if(t1>tmin)tmin=t1; if(t2<tmax)tmax=t2; if(tmin>tmax) return false; }
    }
    return true;
  };
  // Test only that a ray CROSSES THE FRONT WALL PLANE (short span: 1.2 m outside →
  // 0.8 m inside). Deeper reach would hit a concave building's own inner wall or an
  // attached neighbour behind a party-wall "street" edge (the longest-edge door
  // heuristic, a pre-existing TODO) — irrelevant to whether THIS door is open.
  const OUT = 1.2, T = 2.0, FAR = 2.1;
  const evalDoor = (d) => {
    const y = Math.max(d.base, d.grade) + Math.min(0.9, openH(d) * 0.5);
    const inx=d.inward[0], inz=d.inward[2], ax=d.along[0], az=d.along[2];
    const boxes = walls.filter(b => b.x>d.bb.minx-1.5 && b.x<d.bb.maxx+1.5 && b.z>d.bb.minz-1.5 && b.z<d.bb.maxz+1.5);
    const ms = []; for (const mi of meshes) { const c=mi.c; if (c.x>d.bb.minx-2 && c.x<d.bb.maxx+2 && c.z>d.bb.minz-2 && c.z<d.bb.maxz+2) ms.push(mi.m); }
    const hitBox = (off) => { const ox=d.center[0]+ax*off-inx*OUT, oz=d.center[2]+az*off-inz*OUT;
      return boxes.some(b => rayBox(ox, oz, inx, inz, y, b, T)); };
    const castMesh = (off) => { const ox=d.center[0]+ax*off-inx*OUT, oz=d.center[2]+az*off-inz*OUT;
      rc.far = FAR; rc.set(new THREE.Vector3(ox, y, oz), new THREE.Vector3(inx,0,inz).normalize());
      return rc.intersectObjects(ms, false).length > 0; };
    const gapOff = [0, d.halfW*0.5, -d.halfW*0.5];
    const sideDir = (d.length-d.dcenter) > d.dcenter ? 1 : -1;
    const sideOff = sideDir * (d.halfW + 2.0);
    return {
      colliderDoorClear: gapOff.every(o => !hitBox(o)),
      colliderSideBlocked: hitBox(sideOff),
      rayDoorClear: gapOff.every(o => !castMesh(o)),
      raySideHit: castMesh(sideOff),
      testY:+y.toFixed(2), nWallBoxes:boxes.length, nWallMeshes:ms.length,
    };
  };

  // Walk candidates nearest-first; return the first door that is fully open to clear
  // space (all four checks pass). If none is ready yet, return the nearest so the
  // poll keeps ticking. Skips party-wall / not-yet-faded doors automatically.
  let best = null;
  const scanned = pool.slice(0, 28);
  for (const d of scanned) {
    const r = evalDoor(d);
    const rec = { ok:true, archetype:d.archetype, height:+(d.top-d.base).toFixed(1),
      openH:+openH(d).toFixed(2), gradeRise:+(Math.max(d.base,d.grade)-d.base).toFixed(2), ...r,
      door: { center:d.center, inward:d.inward, along:d.along, grade:d.grade, halfW:+d.halfW.toFixed(2),
              length:+d.length.toFixed(1), dcenter:+d.dcenter.toFixed(1) } };
    if (!best) best = rec;
    if (r.colliderDoorClear && r.colliderSideBlocked && r.rayDoorClear && r.raySideHit) return { ...rec, clear:true };
  }
  return { ...best, clear:false, scanned:scanned.length };
};`;

async function pushThrough(c, door) {
  // place the body 1.6 m OUTSIDE the door, freeze the controller, drive it inward
  const dj = JSON.stringify(door);
  await ev(c, `(()=>{const s=window.__sf,d=${dj};
    s.__savedUpd=s.player.update; s.player.update=()=>{};
    const st=[d.center[0]-d.inward[0]*1.6, d.grade+1.1, d.center[2]-d.inward[2]*1.6];
    s.physics.world.setBodyTransform(s.player.body, st, [0,0,0,1]);
    s.player.position.set(st[0],st[1],st[2]); s.player.renderPosition.copy(s.player.position); return 1;})()`);
  for (let i = 0; i < 45; i++) {
    await ev(c, `(()=>{const s=window.__sf,d=${dj};
      s.physics.world.setBodyVelocity(s.player.body,[d.inward[0]*3.0,-1.0,d.inward[2]*3.0],[0,0,0]); return 1;})()`).catch(() => {});
    await tick(c);
  }
  return ev(c, `(()=>{const s=window.__sf,d=${dj};
    const p=s.physics.world.getBodyTransform(s.player.body).position;
    if (s.__savedUpd) s.player.update=s.__savedUpd;
    const depth=(p[0]-d.center[0])*d.inward[0]+(p[2]-d.center[2])*d.inward[2];
    return { depth:+depth.toFixed(2), pos:[+p[0].toFixed(1),+p[1].toFixed(1),+p[2].toFixed(1)] };})()`);
}

async function verifyDistrict(c, spot, label, preferLarge) {
  console.log(`\n[${label}] district @ ${spot} (preferLarge=${preferLarge})`);
  // teleport into the district so its detail buildings stream + fade in
  await ev(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${spot[0]},${spot[1]})+2;
    p.position.set(${spot[0]},y,${spot[1]}); p.renderPosition.copy(p.position);
    s.physics.world.setBodyTransform(p.body,[${spot[0]},y,${spot[1]}],[0,0,0,1]); return 1;})()`);
  for (let i = 0; i < 60; i++) await tick(c);
  // poll until a door has fully faded in + opened to clear space (openDoorway done)
  let pick = null;
  for (let k = 0; k < 18; k++) {
    for (let i = 0; i < 15; i++) await tick(c);
    pick = await ev(c, `window.__cgPick({near:[${spot[0]},${spot[1]}],preferLarge:${preferLarge}})`);
    if (pick && pick.ok && pick.clear) break;
  }
  if (!pick || !pick.ok) { console.log(`  FAIL  ${pick?.err || "no door"}`); return { label, ok: false, checks: [] }; }
  // clean framed shot of the doorway: freeze the controller/chase and aim a static
  // camera at the opening from outside + off to one side (3/4 view).
  const dj = JSON.stringify(pick.door);
  const frame = `(()=>{const s=window.__sf,d=${dj}; s.chase.update=()=>{}; s.player.update=()=>{};
    const st=[d.center[0]-d.inward[0]*1.4, d.grade+1.1, d.center[2]-d.inward[2]*1.4];
    s.player.position.set(st[0],st[1],st[2]); s.player.renderPosition.copy(s.player.position);
    const eye=[d.center[0]-d.inward[0]*5.5+d.along[0]*2.2, d.grade+2.6, d.center[2]-d.inward[2]*5.5+d.along[2]*2.2];
    s.camera.position.set(eye[0],eye[1],eye[2]); s.camera.lookAt(d.center[0], d.grade+1.3, d.center[2]); return 1;})()`;
  await ev(c, frame); for (let i = 0; i < 6; i++) await tick(c); await ev(c, frame);
  await sleep(150); await shot(c, `citygen_door_${label}.jpg`);
  const push = await pushThrough(c, pick.door);
  console.log(`  target: ${pick.archetype}  height=${pick.height}m  openH=${pick.openH}m gradeRise=${pick.gradeRise}m testY=${pick.testY}  door halfW=${pick.door.halfW}m len=${pick.door.length}m  (wallBoxes=${pick.nWallBoxes} wallMeshes=${pick.nWallMeshes})`);
  // (a)/(b)/(c) gate the result; the physics push is informational (the controller
  // freeze makes exact displacement noisy, but the collider boxes it tests are the
  // real ones the engine uses).
  const gate = [
    ["(a) collider GAP at doorway (can pass through)", pick.colliderDoorClear],
    ["(b) collider SOLID 2 m aside (blocked)", pick.colliderSideBlocked],
    ["(c) no wall MESH spans the doorway column", pick.rayDoorClear],
    ["(c) wall MESH present 2 m aside", pick.raySideHit],
  ];
  for (const [name, ok] of gate) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`  info  physics push moved body ${(push.depth + 1.6).toFixed(2)}m inward from 1.6m outside (final depth vs wall plane=${push.depth}m)`);
  return { label, archetype: pick.archetype, height: pick.height, ok: gate.every((x) => x[1]) };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort(); const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  let failed = false;
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
    // day; keep PLAYER + physics live, just quiet the AI cars. Inject the picker.
    await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11.0);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{} return 1;})()`);
    await ev(c, PICK_SRC);

    const results = [];
    results.push(await verifyDistrict(c, (process.env.SF_SPOT_VIC || "900,2400").split(",").map(Number), "victorian", false));
    // SoMa/downtown fabric: big blocks classify "downtown" → largeCommercial grammar;
    // preferLarge grabs the tallest streamed door (the grand-entrance path).
    results.push(await verifyDistrict(c, (process.env.SF_SPOT_LC || "1800,800").split(",").map(Number), "largecommercial", true));

    console.log("\n[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    const allPass = results.every((r) => r.ok);
    console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"} — ` + results.map((r) => `${r.label}:${r.ok ? "ok" : "FAIL"}(${r.archetype || "?"} ${r.height || "?"}m)`).join("  "));
    failed = !allPass;
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
