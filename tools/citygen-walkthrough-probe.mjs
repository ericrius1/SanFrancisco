// Walkthrough / door-integrity probe — NEW player-operated door contract.
// Doors materialize CLOSED (solid collider walls + the grammar's baked
// "citygen.doorleaf" leaf drawn in the visual doorway). E / toggleDoor OPENS the
// door: the walk-through collider gap (+ stoop ramp) appears and a dynamic leaf
// swings inward while the baked leaf hides. Boots the FULL app, streams detail
// buildings in two districts, and per district asserts:
//   CLOSED: (c1) collider SOLID across the doorway column (no walk-through gap),
//           (c2) collider solid 2 m aside,
//           (c3) the doorway MESH hole exists (no wall mesh spans it) and the
//                baked leaf is VISIBLE in it,
//           (c4) an honest physics push toward the doorway does NOT get inside.
//   OPEN:   (o1) the door opens — victorian via a REAL KeyE dispatch with the
//                player standing in range (main.ts wiring end-to-end),
//                largecommercial via the ring's toggleDoor API,
//           (o2) collider GAP at the doorway,  (o3) still solid 2 m aside,
//           (o4) no wall mesh spans the doorway / wall mesh present aside,
//           (o5) baked leaf HIDDEN + a dynamic hinged leaf present,
//           (o6) the same physics push now walks through the gap,
//           (o7) the interior gate reports inside once the body is in.
// (c1/c2/o2/o3) test the EXACT oriented boxes the physics engine uses (via
// debugColliders); (c3/o4) raycast the live detail mesh. Prints PASS/FAIL per
// check and exits non-zero on failure.
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

// Injected before any page script: kill vite's HMR socket (protocol "vite-hmr")
// so live src/ edits from OTHER sessions can't full-reload the page mid-probe
// (a reload wipes the injected helpers and reboots the player mid-assertion).
// The app's own relay/multiplayer sockets use no subprotocol and pass through.
const HMR_BLOCK_SRC = `
(() => {
  const OW = window.WebSocket;
  const isHmr = (p) => p === "vite-hmr" || (Array.isArray(p) && p.includes("vite-hmr"));
  const W = function (url, protocols) {
    if (isHmr(protocols)) return { addEventListener(){}, removeEventListener(){}, send(){}, close(){}, readyState: 3, binaryType: "blob" };
    return new OW(url, protocols);
  };
  W.prototype = OW.prototype;
  W.CONNECTING = OW.CONNECTING; W.OPEN = OW.OPEN; W.CLOSING = OW.CLOSING; W.CLOSED = OW.CLOSED;
  window.WebSocket = W;
})();`;

// ---- in-page helpers: door picker + collider/raycast/leaf checks --------------
// __cgDoorChecks(door) reports the live collider + mesh + leaf state of ONE door
// (interpretable both closed and open); __cgPick picks the nearest CLOSED,
// operable (fully faded-in), walkable candidate and returns it with its
// closed-state checks (ready=true when every closed assertion holds).
const HELPERS_SRC = `
(() => {
  const S = () => window.__sf;
  const SOLID = { "base.stoop":1, "lc.stone":1, "lc.pier":1, "lc.band":1 };
  const isWall = (nm) => typeof nm==="string" && (nm.indexOf("wall.")===0 || SOLID[nm]===1);
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
  // ≈world centre of a mesh's geometry (bundle children carry near-identity
  // matrices with a ~0.6% z-fight scale — run the sphere centre through them)
  const worldCenter = (o) => {
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    return o.localToWorld(o.geometry.boundingSphere.center.clone());
  };
  // baked "citygen.doorleaf" visibility + dynamic hinged leaf presence at a door.
  // The baked leaf is the bundle's merged leaf mesh (nearest one to the door);
  // the dynamic leaf lives under the scene-level "cityGenDoors" group.
  window.__cgLeafState = (d) => {
    const s = S();
    s.scene.updateMatrixWorld(true);
    let baked = null, bd = 1e9;
    s.scene.traverse(o => { if (o.isMesh && o.name === "citygen.doorleaf") {
      const p = worldCenter(o);
      const dist = Math.hypot(p.x - d.center[0], p.z - d.center[2]);
      if (dist < bd) { bd = dist; baked = o; } } });
    let dyn = false;
    const root = s.scene.getObjectByName("cityGenDoors");
    if (root) for (const ch of root.children)
      if (Math.hypot(ch.position.x - d.center[0], ch.position.z - d.center[2]) < 2.5) { dyn = true; break; }
    const found = !!baked && bd < 3.0;
    return { bakedFound: found, bakedVisible: found && baked.visible, dynLeaf: dyn,
             bakedDist: +(bd < 1e9 ? bd : -1).toFixed(2) };
  };
  window.__cgDoorChecks = (d) => {
    const s = S(), THREE = s.THREE, ring = s.citygenRing.current;
    s.scene.updateMatrixWorld(true);
    const walls = []; ring.debugColliders(walls, []);
    const meshes = []; s.scene.traverse(o => { if (o.isMesh && isWall(o.name)) meshes.push({ m:o, c:worldCenter(o) }); });
    const openH = d.openTop - d.sill;
    const y = d.sill + Math.min(0.9, openH * 0.5);
    const inx=d.inward[0], inz=d.inward[2], ax=d.along[0], az=d.along[2];
    const boxes = walls.filter(b => b.x>d.bb.minx-1.5 && b.x<d.bb.maxx+1.5 && b.z>d.bb.minz-1.5 && b.z<d.bb.maxz+1.5);
    const ms = []; for (const mi of meshes) { const c=mi.c; if (c.x>d.bb.minx-2 && c.x<d.bb.maxx+2 && c.z>d.bb.minz-2 && c.z<d.bb.maxz+2) ms.push(mi.m); }
    // rays only cross the FRONT WALL PLANE (1.2 m outside → 0.8 m inside): deeper
    // would hit a concave building's own inner wall / a party-wall neighbour —
    // irrelevant to whether THIS doorway is open.
    const OUT = 1.2, T = 2.0, FAR = 2.1;
    const rc = new THREE.Raycaster();
    const hitBox = (off) => { const ox=d.center[0]+ax*off-inx*OUT, oz=d.center[2]+az*off-inz*OUT;
      return boxes.some(b => rayBox(ox, oz, inx, inz, y, b, T)); };
    const castMesh = (off) => { const ox=d.center[0]+ax*off-inx*OUT, oz=d.center[2]+az*off-inz*OUT;
      rc.far = FAR; rc.set(new THREE.Vector3(ox, y, oz), new THREE.Vector3(inx,0,inz).normalize());
      return rc.intersectObjects(ms, false).length > 0; };
    const gapOff = [0, d.halfW*0.5, -d.halfW*0.5];
    const sideDir = (d.length-d.dcenter) > d.dcenter ? 1 : -1;
    const sideOff = sideDir * (d.halfW + 2.0);
    const mine = ring.debugDoors().find(x => Math.hypot(x.center[0]-d.center[0], x.center[2]-d.center[2]) < 0.05) || null;
    // every box crossing the doorway column at capsule heights + whether any of
    // them is FOREIGN — i.e. not this building's own street wall (own signature:
    // centred on midY with halfH vertical extent, thin). OSM footprints sometimes
    // OVERLAP, and an overlapping neighbour's co-linear facade walls a doorway
    // shut no matter what the door does — a world-data condition, not the door
    // contract; the picker skips those candidates.
    // exact-match signature: collider.ts builds jamb/full walls at EXACTLY
    // y=midY, hy=halfH from these same spec numbers — a party-wall neighbour a
    // mere 0.5 m taller must still read as foreign, so the tolerance is tight.
    const midY = (d.base + d.top) / 2, halfH = Math.max(0.1, (d.top - d.base) / 2);
    const ownWall = (b) => !b.quat && Math.abs(b.y - midY) < 0.05 && Math.abs(b.hy - halfH) < 0.05 && b.hz <= 0.4;
    const crossers = [];
    for (const off of gapOff) {
      const ox=d.center[0]+ax*off-inx*OUT, oz=d.center[2]+az*off-inz*OUT;
      for (const yy of [d.sill + 0.5, d.sill + 1.4])
        for (const b of boxes) if (rayBox(ox, oz, inx, inz, yy, b, T) && !crossers.includes(b)) crossers.push(b);
    }
    const foreignGap = crossers.some(b => !ownWall(b));
    const gapBlockers = crossers.slice(0, 4).map(b =>
      "["+[b.x,b.y,b.z].map(n=>n.toFixed(1)).join(",")+" h="+[b.hx,b.hy,b.hz].map(n=>n.toFixed(2)).join(",")+" yaw="+b.yaw.toFixed(2)+(b.quat?" quat":"")+(ownWall(b)?" own":" FOREIGN")+"]").join(" ");
    return {
      gapBlockers, foreignGap,
      colliderDoorClear: gapOff.every(o => !hitBox(o)),
      colliderDoorSolid: gapOff.every(o => hitBox(o)),
      colliderSideBlocked: hitBox(sideOff),
      rayDoorClear: gapOff.every(o => !castMesh(o)),
      raySideHit: castMesh(sideOff),
      open: mine ? mine.open : null, nRamp: mine ? mine.nRamp : null,
      testY:+y.toFixed(2), nWallBoxes:boxes.length, nWallMeshes:ms.length,
      ...window.__cgLeafState(d),
    };
  };
  window.__cgPick = (opts) => {
    const s = S(), ring = s.citygenRing && s.citygenRing.current;
    if (!ring) return { ok:false, err:"no ring" };
    const near = opts.near, preferLarge = !!opts.preferLarge;
    const doors = ring.debugDoors();
    if (!doors.length) return { ok:false, err:"no detail doors streamed yet" };
    const d2 = (d) => { const dx=d.center[0]-near[0], dz=d.center[2]-near[1]; return dx*dx+dz*dz; };
    const openH = (d) => d.openTop - d.sill;
    const sideRoom = (d) => Math.max(d.dcenter, d.length - d.dcenter) > 2.0 + d.halfW + 0.35;
    // modest front rise only: the E-press player and the push both start ~1.5 m
    // out at sill height — a >2.4 m cliff-front door is legitimately rampable
    // only once open, but makes the closed-side placements degenerate.
    const rise = (d) => d.sill - s.map.groundHeight(d.center[0]-d.inward[0]*1.5, d.center[2]-d.inward[2]*1.5);
    // the APPROACH must be genuinely clear of live wall colliders (own bays,
    // party-wall/facing neighbours, coll-tier walls): the street edge is still
    // the longest-edge heuristic (a pre-existing TODO), so a party-wall "door"
    // faces a wall ~1 m out — exclude those from the contract test.
    const walls = []; ring.debugColliders(walls, []);
    const inBox = (px,py,pz,b) => { if (b.quat) return false; // tilted ramps are walkable, not blockers
      if (Math.abs(py-b.y) > b.hy) return false;
      const cs=Math.cos(-b.yaw), sn=Math.sin(-b.yaw), ox=px-b.x, oz=pz-b.z;
      const lx=ox*cs-oz*sn, lz=ox*sn+oz*cs;
      return Math.abs(lx) <= b.hx+0.34 && Math.abs(lz) <= b.hz+0.34; }; // + capsule radius
    const frontClear = (d) => {
      const nearBoxes = walls.filter(b => Math.abs(b.x-d.center[0])<12 && Math.abs(b.z-d.center[2])<12);
      for (const t of [0.7, 1.1, 1.5, 2.4, 3.2]) {
        const px=d.center[0]-d.inward[0]*t, pz=d.center[2]-d.inward[2]*t;
        for (const py of [d.sill+0.3, d.sill+0.9, d.sill+1.6]) if (nearBoxes.some(b=>inBox(px,py,pz,b))) return false;
      }
      return true;
    };
    const pool = doors.filter(d => !d.open && sideRoom(d) && openH(d) >= 1.8 && rise(d) <= 2.4 && rise(d) >= -0.6 && frontClear(d));
    if (!pool.length) return { ok:false, err:"no closed walkable door with a clear approach streamed yet" };
    pool.sort((a,b) => { if (preferLarge){ const ha=a.top-a.base, hb=b.top-b.base; if (Math.abs(hb-ha)>4) return hb-ha; } return d2(a)-d2(b); });
    let best = null, skippedForeign = 0;
    for (const d of pool.slice(0, 28)) {
      // operable = the ring will toggle it (fully faded in): nearestDoor from the
      // door's own centre must return THIS door, still closed
      const nd = ring.nearestDoor({ x:d.center[0], y:d.sill+1.0, z:d.center[2] });
      const operable = !!nd && Math.hypot(nd.x-d.center[0], nd.z-d.center[2]) < 0.05 && !nd.open;
      const chk = window.__cgDoorChecks(d);
      if (chk.foreignGap) { skippedForeign++; continue; } // overlapping-neighbour wall crosses this doorway
      const rec = { ok:true, archetype:d.archetype, height:+(d.top-d.base).toFixed(1),
        openH:+openH(d).toFixed(2), rise:+rise(d).toFixed(2), operable, skippedForeign,
        doorId: operable ? nd.id : -1, ...chk, door: d };
      if (!best) best = rec;
      if (operable && chk.colliderDoorSolid && chk.colliderSideBlocked && chk.raySideHit && chk.rayDoorClear && chk.bakedVisible)
        return { ...rec, ready:true };
    }
    if (!best) return { ok:false, err:"all "+skippedForeign+" candidate doorways crossed by overlapping-neighbour walls", skippedForeign };
    return { ...best, ready:false, scanned:Math.min(pool.length,28) };
  };
})();`;

async function pushThrough(c, door) {
  // place the body 1.6 m OUTSIDE the door, freeze the controller, drive it inward
  const dj = JSON.stringify(door);
  await ev(c, `(()=>{const s=window.__sf,d=${dj};
    s.__savedUpd=s.player.update; s.player.update=()=>{};
    const st=[d.center[0]-d.inward[0]*1.6, d.sill+1.1, d.center[2]-d.inward[2]*1.6];
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

// Open the door the way a PLAYER does: stand 1.5 m outside it (walk mode) and
// dispatch a real KeyboardEvent KeyE on window — main.ts's E branch must find it
// via nearestDoor and call toggleDoor itself.
async function openViaKeyE(c, door) {
  const dj = JSON.stringify(door);
  const pre = await ev(c, `(()=>{const s=window.__sf,d=${dj};
    const st=[d.center[0]-d.inward[0]*1.5, d.sill+1.05, d.center[2]-d.inward[2]*1.5];
    s.physics.world.setBodyTransform(s.player.body, st, [0,0,0,1]);
    s.physics.world.setBodyVelocity(s.player.body,[0,0,0],[0,0,0]);
    s.player.position.set(st[0],st[1],st[2]); s.player.renderPosition.copy(s.player.position);
    const nd = s.citygenRing.current.nearestDoor(s.player.position);
    return { mode:s.player.mode, dist: nd?+nd.dist.toFixed(2):null,
             sameDoor: !!nd && Math.hypot(nd.x-d.center[0], nd.z-d.center[2]) < 0.05 };})()`);
  await tick(c);
  await ev(c, `(window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyE"})),1)`);
  await tick(c);
  await ev(c, `(window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyE"})),1)`);
  await tick(c);
  const open = await ev(c, `(()=>{const d=${dj};
    const m=window.__sf.citygenRing.current.debugDoors().find(x=>Math.hypot(x.center[0]-d.center[0],x.center[2]-d.center[2])<0.05);
    return m ? m.open : null;})()`);
  return { pre, opened: open === true };
}

// (Re-)arm the page: wait for the app, inject the helpers, force walk mode.
// Ran per district, not just at boot — a vite full-reload mid-run (another
// session editing src/) wipes window.__cg* and reboots the player on the board.
async function armPage(c) {
  await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
  await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11.0); return 1;})()`);
  await ev(c, HELPERS_SRC);
  for (let i = 0; i < 3; i++) {
    const m = await ev(c, `(()=>{const s=window.__sf; if (s.player.mode!=="walk") try{s.player.trySwitch("walk");}catch(e){} return s.player.mode;})()`);
    if (m === "walk") break;
    for (let j = 0; j < 10; j++) await tick(c);
  }
}

async function verifyDistrict(c, spot, label, preferLarge, useKeyE) {
  console.log(`\n[${label}] district @ ${spot} (preferLarge=${preferLarge}, open via ${useKeyE ? "KeyE" : "toggleDoor"})`);
  await armPage(c);
  // teleport into the district so its detail buildings stream + fade in
  await ev(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${spot[0]},${spot[1]})+2;
    p.position.set(${spot[0]},y,${spot[1]}); p.renderPosition.copy(p.position);
    s.physics.world.setBodyTransform(p.body,[${spot[0]},y,${spot[1]}],[0,0,0,1]); return 1;})()`);
  for (let i = 0; i < 60; i++) await tick(c);
  // poll until a CLOSED candidate door has fully faded in with its closed state intact
  let pick = null;
  for (let k = 0; k < 18; k++) {
    for (let i = 0; i < 15; i++) await tick(c);
    pick = await ev(c, `window.__cgPick({near:[${spot[0]},${spot[1]}],preferLarge:${preferLarge}})`);
    if (pick && pick.ok && pick.ready) break;
  }
  if (!pick || !pick.ok || !pick.ready) {
    console.log(`  FAIL  ${pick?.err || "no ready closed door"}` + (pick && pick.ok
      ? `  best: ${pick.archetype} operable=${pick.operable} solid=${pick.colliderDoorSolid} side=${pick.colliderSideBlocked} rayClear=${pick.rayDoorClear} leafVis=${pick.bakedVisible} (scanned ${pick.scanned})` : ""));
    return { label, ok: false };
  }
  console.log(`  target: ${pick.archetype}  height=${pick.height}m openH=${pick.openH}m rise=${pick.rise}m doorId=${pick.doorId}  door halfW=${pick.door.halfW.toFixed(2)}m len=${pick.door.length.toFixed(1)}m  (wallBoxes=${pick.nWallBoxes} wallMeshes=${pick.nWallMeshes} testY=${pick.testY} skippedForeign=${pick.skippedForeign || 0})`);
  // clean framed shot of the CLOSED doorway (static 3/4 camera)
  const dj = JSON.stringify(pick.door);
  const frame = `(()=>{const s=window.__sf,d=${dj}; s.chase.update=()=>{}; s.player.update=()=>{};
    const st=[d.center[0]-d.inward[0]*1.4, d.sill+1.1, d.center[2]-d.inward[2]*1.4];
    s.player.position.set(st[0],st[1],st[2]); s.player.renderPosition.copy(s.player.position);
    const eye=[d.center[0]-d.inward[0]*5.5+d.along[0]*2.2, d.sill+2.6, d.center[2]-d.inward[2]*5.5+d.along[2]*2.2];
    s.camera.position.set(eye[0],eye[1],eye[2]); s.camera.lookAt(d.center[0], d.sill+1.3, d.center[2]); return 1;})()`;
  await ev(c, frame); for (let i = 0; i < 6; i++) await tick(c); await ev(c, frame);
  await sleep(150); await shot(c, `citygen_door_${label}_closed.jpg`);
  // (c4) an honest push must NOT get past the wall plane while closed
  const pushC = await pushThrough(c, pick.door);
  const closedBlocked = pushC.depth <= -0.05;

  // ---- OPEN the door -----------------------------------------------------------
  let opened = false, openInfo;
  if (useKeyE) {
    const r = await openViaKeyE(c, pick.door);
    opened = r.opened;
    openInfo = `KeyE (mode=${r.pre.mode} dist=${r.pre.dist}m sameDoor=${r.pre.sameDoor})`;
  } else {
    const r = await ev(c, `window.__sf.citygenRing.current.toggleDoor(${pick.doorId})`);
    opened = r === "opened";
    openInfo = `toggleDoor → "${r}"`;
  }
  for (let i = 0; i < 20; i++) await tick(c); // leaf swing is 0.45 s
  const after = await ev(c, `window.__cgDoorChecks(${dj})`);
  await ev(c, frame); for (let i = 0; i < 6; i++) await tick(c); await ev(c, frame);
  await sleep(150); await shot(c, `citygen_door_${label}_open.jpg`);
  // (o6) the same push now goes through the gap
  const pushO = await pushThrough(c, pick.door);
  // (o7) interior gate: park the player where the push ended, let the ring see it
  let insideGate = false;
  if (pushO.depth >= 0.4) {
    await ev(c, `(()=>{const s=window.__sf,p=${JSON.stringify(pushO.pos)};
      s.physics.world.setBodyTransform(s.player.body,[p[0],p[1]+0.05,p[2]],[0,0,0,1]);
      s.player.position.set(p[0],p[1]+0.05,p[2]); s.player.renderPosition.copy(s.player.position); return 1;})()`);
    for (let i = 0; i < 8; i++) await tick(c);
    insideGate = await ev(c, `window.__sf.citygenRing.current.isPlayerInside()`) === true;
  }

  const gate = [
    ["(c1) CLOSED: collider SOLID across doorway", pick.colliderDoorSolid],
    ["(c2) CLOSED: collider solid 2 m aside", pick.colliderSideBlocked],
    ["(c3) CLOSED: doorway mesh hole + baked leaf visible", pick.rayDoorClear && pick.bakedVisible],
    [`(c4) CLOSED: physics push blocked outside (depth ${pushC.depth}m)`, closedBlocked],
    [`(o1) door opens via ${openInfo}`, opened],
    ["(o2) OPEN: collider GAP at doorway (can pass)", !!after.colliderDoorClear],
    ["(o3) OPEN: collider solid 2 m aside", !!after.colliderSideBlocked],
    ["(o4) OPEN: no wall mesh spans doorway / present aside", !!(after.rayDoorClear && after.raySideHit)],
    [`(o5) OPEN: baked leaf hidden + dynamic leaf present (nRamp=${after.nRamp})`, !!(after.bakedFound && !after.bakedVisible && after.dynLeaf)],
    [`(o6) OPEN: physics push through gap (depth ${pushO.depth}m)`, pushO.depth >= 0.4],
    ["(o7) OPEN: interior gates once inside", insideGate],
  ];
  for (const [name, ok] of gate) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!after.colliderDoorClear) console.log(`  diag  open-gap ray blockers: ${after.gapBlockers || "(none?)"}`);
  if (pushO.depth < 0.4) console.log(`  diag  open push stalled at ${JSON.stringify(pushO.pos)}`);
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
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: HMR_BLOCK_SRC });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    // day; keep PLAYER + physics live; helpers + walk mode (armPage re-arms per
    // district in case the page is torn down mid-run anyway)
    await armPage(c);
    console.log("[probe] booted; player mode:", await ev(c, `window.__sf.player.mode`));

    // belt over the HMR-block braces: if the page still gets torn down
    // mid-district (dev-server restart), re-arm and retry the whole district
    const runDistrict = async (spot, label, preferLarge, useKeyE) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await verifyDistrict(c, spot, label, preferLarge, useKeyE); }
        catch (e) {
          console.log(`  [retry] ${label} crashed (attempt ${attempt}): ${String(e).split("\n")[0]}`);
          if (attempt === 3) return { label, ok: false };
        }
      }
    };
    const results = [];
    // victorian: KeyE end-to-end (main.ts wiring); large-commercial: direct API
    results.push(await runDistrict((process.env.SF_SPOT_VIC || "900,2400").split(",").map(Number), "victorian", false, true));
    // SoMa/downtown fabric: big blocks classify "downtown" → largeCommercial grammar;
    // preferLarge grabs the tallest streamed door (the grand-entrance path).
    results.push(await runDistrict((process.env.SF_SPOT_LC || "1800,800").split(",").map(Number), "largecommercial", true, false));

    console.log("\n[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    const allPass = results.every((r) => r.ok);
    console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"} — ` + results.map((r) => `${r.label}:${r.ok ? "ok" : "FAIL"}(${r.archetype || "?"} ${r.height || "?"}m)`).join("  "));
    failed = !allPass;
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
