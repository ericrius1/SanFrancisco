// Doors coverage + walk-in + stoop probe — NEW player-operated door contract.
// Doors materialize CLOSED (solid walls + baked "citygen.doorleaf" leaf); E /
// toggleDoor OPENS: the collider gap + stoop ramp appear and the leaf swings.
// Boots the FULL app, streams detail buildings in the Victorian + SoMa
// districts, and asserts per district:
//   • coverage: doored / total detail buildings + walkable fraction (openTop−sill ≥ 1.8),
//   • closed-by-default: the first door scan reports ZERO open doors,
//   • a REAL walk at a closed door STOPS at the solid wall (no gap while closed),
//   • the door OPENS via a real KeyE dispatch with the player in range (main.ts
//     wiring end-to-end — the ring's toggleDoor is used for later candidates),
//   • after opening: baked leaf hidden + dynamic hinged leaf present,
//   • a real WALK through the opened door into the interior (walk.ts drives the
//     capsule — a faithful walk, not a teleport) with the interior gate
//     confirmed + an inside screenshot, then a walk back out,
//   • a downhill door's climbable STOOP: opened first (the ramp collider only
//     exists once the door is open), then walked from the low street with the
//     player-y progression logged.
// Screenshots → .data/doors-fix/.  Usage: node tools/citygen-doors-coverage-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "doors-fix");
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

// coverage over the streamed DETAIL buildings + a picker of walkable doors near a spot.
const HELPERS = `
window.__cov = (near) => {
  const s = window.__sf, ring = s.citygenRing && s.citygenRing.current;
  if (!ring) return { ok:false };
  const dets = ring.debugBuildings();      // full-grammar detail buildings
  const doors = ring.debugDoors();          // eligible street doors (≤1 per building)
  const openH = (d)=> d.openTop - d.sill;
  const walkable = doors.filter(d => openH(d) >= 1.8);
  // front-terrain rise for each door (sampled 1.3 m out = the ring's frontGroundFor)
  // → the biggest CLIMBABLE stoop nearby (rise within the ≤3 m ramp cap; a door past
  // the cap deliberately takes no ramp — it's entered from its uphill side).
  const withRise = doors.map(d => {
    const fx = d.center[0] - d.inward[0]*1.3, fz = d.center[2] - d.inward[2]*1.3;
    const fg = s.map.groundHeight(fx, fz);
    return { d, rise: +(d.sill - fg).toFixed(2), fg:+fg.toFixed(2), openH:+openH(d).toFixed(2) };
  });
  const d2 = (d)=>{ const dx=d.center[0]-near[0], dz=d.center[2]-near[1]; return dx*dx+dz*dz; };
  const sideRoom = (d)=> Math.max(d.dcenter, d.length-d.dcenter) > 2.0 + d.halfW + 0.35;
  // the door's APPROACH must be genuinely clear: no live wall collider box (own
  // jambs, party-wall neighbour, coll-tier neighbour) on the walk-in line. The
  // street edge is the longest-edge heuristic, so a party-wall "door" faces a wall
  // (a known TODO) — those are excluded from the walk tests, not from coverage.
  const walls = []; ring.debugColliders(walls, []);
  const inBox = (px,py,pz,b)=>{ if (b.quat) return false;         // tilted ramps are walkable, not blockers
    if (Math.abs(py-b.y) > b.hy) return false;
    const cs=Math.cos(-b.yaw), sn=Math.sin(-b.yaw), ox=px-b.x, oz=pz-b.z;
    const lx=ox*cs-oz*sn, lz=ox*sn+oz*cs;
    return Math.abs(lx) <= b.hx+0.34 && Math.abs(lz) <= b.hz+0.34; }; // + capsule radius
  const frontClear = (d)=>{
    const nearBoxes = walls.filter(b => Math.abs(b.x-d.center[0])<12 && Math.abs(b.z-d.center[2])<12);
    for (const t of [0.7, 1.5, 2.4, 3.2, 4.2]) {
      const px=d.center[0]-d.inward[0]*t, pz=d.center[2]-d.inward[2]*t;
      // low sample catches a facing building's stoop/skirt (party-wall door pairs)
      for (const py of [d.sill+0.3, d.sill+0.9, d.sill+1.6]) if (nearBoxes.some(b=>inBox(px,py,pz,b))) return false;
    }
    return true;
  };
  // OSM footprints sometimes OVERLAP: an overlapping neighbour's co-linear facade
  // walls a doorway shut no matter what the door does (world data, not the door
  // contract). Detectable while CLOSED: every box crossing the doorway column must
  // carry the OWN street wall's signature (centred on midY, halfH tall, thin).
  const rayBox = (px,pz,dx,dz,y,b,tMax)=>{
    if (b.quat || Math.abs(y-b.y) > b.hy) return false;
    const cs=Math.cos(-b.yaw), sn=Math.sin(-b.yaw);
    const ox=px-b.x, oz=pz-b.z;
    const lx=ox*cs-oz*sn, lz=ox*sn+oz*cs, ldx=dx*cs-dz*sn, ldz=dx*sn+dz*cs;
    let tmin=0, tmax=tMax;
    const slabs=[[lx,ldx,b.hx],[lz,ldz,b.hz]];
    for (let k=0;k<2;k++){ const o=slabs[k][0], dd=slabs[k][1], h=slabs[k][2];
      if (Math.abs(dd)<1e-9){ if (o<-h||o>h) return false; }
      else { let t1=(-h-o)/dd, t2=(h-o)/dd; if (t1>t2){const t=t1;t1=t2;t2=t;} if(t1>tmin)tmin=t1; if(t2<tmax)tmax=t2; if(tmin>tmax) return false; }
    }
    return true;
  };
  const gapNotForeign = (d)=>{
    // exact-match signature: collider.ts builds jamb/full walls at EXACTLY
    // y=midY, hy=halfH from these same spec numbers — a party-wall neighbour a
    // mere 0.5 m taller must still read as foreign, so the tolerance is tight.
    const midY=(d.base+d.top)/2, halfH=Math.max(0.1,(d.top-d.base)/2);
    const ownWall = (b)=> Math.abs(b.y-midY)<0.05 && Math.abs(b.hy-halfH)<0.05 && b.hz<=0.4;
    const nearBoxes = walls.filter(b => b.x>d.bb.minx-1.5 && b.x<d.bb.maxx+1.5 && b.z>d.bb.minz-1.5 && b.z<d.bb.maxz+1.5);
    const inx=d.inward[0], inz=d.inward[2], ax=d.along[0], az=d.along[2];
    for (const off of [0, d.halfW*0.5, -d.halfW*0.5]) {
      const ox=d.center[0]+ax*off-inx*1.2, oz=d.center[2]+az*off-inz*1.2;
      for (const yy of [d.sill+0.5, d.sill+1.4])
        for (const b of nearBoxes) if (rayBox(ox, oz, inx, inz, yy, b, 2.0) && !ownWall(b)) return false;
    }
    return true;
  };
  // NEW contract: doors start CLOSED — candidates are picked closed and the
  // probe opens them itself (KeyE / toggleDoor). Walk tests still need a
  // street-reachable door (rise within the stoop cap — a >3 m cliff-front door
  // legitimately has no ramp).
  const reach = new Map(withRise.map(x=>[x.d, x.rise]));
  const nearWalk = walkable.filter(d=>sideRoom(d) && frontClear(d) && gapNotForeign(d) && reach.get(d) <= 2.9).sort((a,b)=>d2(a)-d2(b));
  const bigStoop = withRise.filter(x=>sideRoom(x.d) && frontClear(x.d) && gapNotForeign(x.d) && x.rise >= 0.5 && x.rise <= 2.9).sort((a,b)=>b.rise-a.rise);
  const deco = (d) => { const x = withRise.find(w => w.d === d); return { ...d, _rise: x.rise, _fg: x.fg }; };
  return {
    ok:true, total:dets.length, doored:doors.length, walkable:walkable.length,
    openNow: doors.filter(d=>d.open).length,
    nearest: nearWalk.slice(0, 10).map(deco),
    stoop: bigStoop.slice(0, 4).map(x => ({ ...x.d, _rise:x.rise, _fg:x.fg })),
  };
};
// open a door via the ring API (used for non-first candidates; the first door of
// each district is opened with a real KeyE dispatch instead)
window.__openDoor = (d) => {
  const ring = window.__sf.citygenRing.current;
  const nd = ring.nearestDoor({ x:d.center[0], y:d.sill+1.0, z:d.center[2] });
  if (!nd || Math.hypot(nd.x-d.center[0], nd.z-d.center[2]) > 0.05) return { ok:false, err:"door not operable (fade?) or another door nearer" };
  if (nd.open) return { ok:true, already:true };
  const r = ring.toggleDoor(nd.id);
  return { ok: r === "opened", r };
};
// baked "citygen.doorleaf" visibility + dynamic hinged leaf presence near a door
window.__leafState = (d) => {
  const s = window.__sf;
  s.scene.updateMatrixWorld(true);
  let baked = null, bd = 1e9;
  s.scene.traverse(o => { if (o.isMesh && o.name === "citygen.doorleaf") {
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const p = o.localToWorld(o.geometry.boundingSphere.center.clone());
    const dist = Math.hypot(p.x - d.center[0], p.z - d.center[2]);
    if (dist < bd) { bd = dist; baked = o; } } });
  let dyn = false;
  const root = s.scene.getObjectByName("cityGenDoors");
  if (root) for (const ch of root.children)
    if (Math.hypot(ch.position.x - d.center[0], ch.position.z - d.center[2]) < 2.5) { dyn = true; break; }
  const found = !!baked && bd < 3.0;
  return { bakedFound: found, bakedVisible: found && baked.visible, dynLeaf: dyn };
};
// name the culprit: all wall/interior collider boxes within reach of a position
// (capsule radius + margin), so a stalled walk can report exactly what blocked it.
window.__whatBlocks = (pos) => {
  const s = window.__sf, ring = s.citygenRing.current;
  const walls = [], ints = []; ring.debugColliders(walls, ints);
  const all = walls.map(b=>({...b, kind:"wall"})).concat(ints.map(b=>({...b, kind:"int"})));
  const out = [];
  for (const b of all) {
    // coarse: point vs box AABB inflated by capsule reach (ignore yaw/quat — this
    // is a shortlist, not an exact contact test)
    const rx = Math.hypot(b.hx, b.hz) + 0.55;
    if (Math.abs(pos[0]-b.x) > rx || Math.abs(pos[2]-b.z) > rx) continue;
    if (pos[1]-0.95 > b.y+b.hy || pos[1]+0.95 < b.y-b.hy) continue;
    out.push(b.kind+"["+[b.x,b.y,b.z].map(n=>n.toFixed(1)).join(",")+" h="+[b.hx,b.hy,b.hz].map(n=>n.toFixed(2)).join(",")+(b.quat?" quat":"")+"]");
  }
  return out.slice(0,6).join(" ");
};
// physics-eye view of the door approach: downward raycasts (query world sees the
// quat stoop ramps) at distances OUTSIDE (+d) .. INSIDE (−d) along the walk line.
// NOTE: raycastWorld races the terrain heightfield, so values are max(terrain, box).
window.__profile = (d) => {
  const s = window.__sf, T = s.THREE;
  const o = new T.Vector3(), dir = new T.Vector3(0,-1,0);
  const rows = [];
  for (const t of [4.5,4.0,3.5,3.0,2.5,2.0,1.5,1.0,0.6,0.3,0.1,-0.1,-0.3,-0.6,-1.0]) {
    o.set(d.center[0]-d.inward[0]*t, d.sill+2.0, d.center[2]-d.inward[2]*t);
    const h = s.physics.raycastWorld(o, dir, 8);
    rows.push(t.toFixed(1)+":"+(h? (h.point.y-d.sill).toFixed(2) : "--"));
  }
  return rows.join(" ");
};`;

// Walk the REAL player controller toward `dir`: hold a synthetic KeyW with the
// chase yaw pinned so walk.ts drives the capsule exactly as it does for a human
// (its own righting, ground handling, speeds). Stops early once the signed depth
// past the door's wall plane ((p−center)·inward) crosses `targetDepth` (positive =
// until that deep INSIDE; negative = until that far OUTSIDE). Returns y samples,
// final depth, and the frame-fresh interior-gate flag.
async function walkDrive(c, startXYZ, dir, door, targetDepth, maxTicks = 360) {
  const j = JSON.stringify({ s: startXYZ, d: dir, c: door.center, i: door.inward, t: targetDepth });
  // aim point: through the door 2.5 m INSIDE (walk-in) or 3.5 m OUTSIDE (walk-out);
  // the heading is re-aimed at it every tick, as a player steering for a doorway.
  const AIM = `const gx=o.c[0]+o.i[0]*(o.t>0?2.5:-3.5), gz=o.c[2]+o.i[2]*(o.t>0?2.5:-3.5);
      const p0=s.physics.world.getBodyTransform(s.player.body).position;
      const dx=gx-p0[0], dz=gz-p0[2], L=Math.hypot(dx,dz)||1;
      s.chase.yaw=Math.atan2(-dx/L, -dz/L);`;
  await ev(c, `(()=>{const s=window.__sf,o=${j};
    s.chase.update=()=>{};
    s.input.suspended=false;
    s.input.keys.add("KeyW");
    s.physics.world.setBodyTransform(s.player.body,o.s,[0,0,0,1]);
    s.physics.world.setBodyVelocity(s.player.body,[0,0,0],[0,0,0]);
    s.player.position.set(o.s[0],o.s[1],o.s[2]); s.player.renderPosition.copy(s.player.position);
    ${AIM}
    window.__ys=[]; window.__reached=false; return 1;})()`);
  for (let i = 0; i < maxTicks; i++) {
    const done = await ev(c, `(()=>{const s=window.__sf,o=${j};
      ${AIM}
      const p=p0;
      window.__ys.push(+p[1].toFixed(2));
      const depth=(p[0]-o.c[0])*o.i[0]+(p[2]-o.c[2])*o.i[2];
      if (o.t>0 ? depth>=o.t : depth<=o.t) { window.__reached=true; return 1; }
      return 0;})()`).catch(() => 0);
    await tick(c);
    if (done) { await tick(c); break; } // settle a frame so the interior gate sees it
  }
  return ev(c, `(()=>{const s=window.__sf,o=${j};
    s.input.keys.delete("KeyW");
    const p=s.physics.world.getBodyTransform(s.player.body).position;
    const depth=(p[0]-o.c[0])*o.i[0]+(p[2]-o.c[2])*o.i[2];
    return { ys:window.__ys, reached:window.__reached, depth:+depth.toFixed(2),
             finalInside:s.citygenRing.current.isPlayerInside(),
             pos:[+p[0].toFixed(1),+p[1].toFixed(1),+p[2].toFixed(1)] };})()`);
}

// Open a door the way a PLAYER does: stand ~1.5 m outside it in walk mode and
// dispatch a real KeyboardEvent KeyE on window — main.ts's E branch must find
// the door via nearestDoor and call toggleDoor itself.
async function openViaKeyE(c, door) {
  const dj = JSON.stringify(door);
  const pre = await ev(c, `(()=>{const s=window.__sf,d=${dj};
    s.input.keys.delete("KeyW");
    const gx=d.center[0]-d.inward[0]*1.5, gz=d.center[2]-d.inward[2]*1.5;
    const gy=Math.max(s.map.groundHeight(gx,gz)+1.0, d.sill+0.6);
    s.physics.world.setBodyTransform(s.player.body,[gx,gy,gz],[0,0,0,1]);
    s.physics.world.setBodyVelocity(s.player.body,[0,0,0],[0,0,0]);
    s.player.position.set(gx,gy,gz); s.player.renderPosition.copy(s.player.position);
    const nd = s.citygenRing.current.nearestDoor(s.player.position);
    return { mode:s.player.mode, dist: nd?+nd.dist.toFixed(2):null,
             sameDoor: !!nd && Math.hypot(nd.x-d.center[0], nd.z-d.center[2]) < 0.05 };})()`);
  for (let i = 0; i < 2; i++) await tick(c);
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
// session editing src/) wipes the window.__* helpers and reboots on the board.
async function armPage(c) {
  await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
  await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11.0); return 1;})()`);
  await ev(c, HELPERS);
  for (let i = 0; i < 3; i++) {
    const m = await ev(c, `(()=>{const s=window.__sf; if (s.player.mode!=="walk") try{s.player.trySwitch("walk");}catch(e){} return s.player.mode;})()`);
    if (m === "walk") break;
    for (let j = 0; j < 10; j++) await tick(c);
  }
}

async function district(c, spot, label) {
  console.log(`\n[${label}] @ ${spot}`);
  await armPage(c);
  await ev(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${spot[0]},${spot[1]})+2;
    p.position.set(${spot[0]},y,${spot[1]}); p.renderPosition.copy(p.position);
    s.physics.world.setBodyTransform(p.body,[${spot[0]},y,${spot[1]}],[0,0,0,1]); return 1;})()`);
  for (let i = 0; i < 90; i++) await tick(c);
  // poll until detail buildings + doors have streamed and faded in
  let cov = null;
  for (let k = 0; k < 24; k++) {
    for (let i = 0; i < 12; i++) await tick(c);
    cov = await ev(c, `window.__cov([${spot[0]},${spot[1]}])`);
    if (cov && cov.ok && cov.doored > 0 && cov.nearest && cov.nearest.length) break;
  }
  if (!cov || !cov.ok || !cov.doored) { console.log("  FAIL no coverage"); return { label, ok: false, checks: [["coverage streamed", false]] }; }
  const frac = cov.doored ? (cov.walkable / cov.doored) : 0;
  console.log(`  coverage: doored ${cov.doored}/${cov.total} detail buildings (${(100*cov.doored/Math.max(1,cov.total)).toFixed(0)}%)  |  walkable ${cov.walkable}/${cov.doored} (${(100*frac).toFixed(0)}%)`);
  // NEW contract: nothing has been toggled yet — every streamed door must be closed
  const closedByDefault = cov.openNow === 0;
  console.log(`  closed-by-default: ${cov.openNow} open of ${cov.doored} (${closedByDefault ? "PASS" : "FAIL — doors auto-opened"})`);

  // start on the street BEYOND the stoop ramp's outer tip (spawning astride the
  // thin ramp box wedges the capsule under it — a test artifact, not a door),
  // at local ground height, then walk the whole approach like a player would.
  const startFor = async (d) => {
    // clear the REAL ramp's outer tip: its run comes from the ring's own sampled
    // frontGround (d.fg — may be lower than the 1.3 m-out sample on a dropping
    // street), else spawning astride the thin ramp box wedges the capsule under it
    const fg = d.fg !== undefined ? Math.min(d.fg, d._fg) : d._fg;
    const rise = d.sill - fg;
    const startD = rise > 0.25 ? 0.30 + rise / Math.tan(0.56) + 0.8 : 2.6;
    return ev(c, `(()=>{const s=window.__sf,d=${JSON.stringify(d)};
      const x=d.center[0]-d.inward[0]*${startD}, z=d.center[2]-d.inward[2]*${startD};
      return [x, s.map.groundHeight(x,z)+1.0, z];})()`);
  };

  // ---- WALK-IN: closed door must block; open it (KeyE first, API after); walk in
  let entered = null, closedTest = null, keyE = null, leafCheck = null;
  let interiorOk = false;
  let first = true;
  for (const nd of cov.nearest || []) {
    const ndj = JSON.stringify(nd);
    if (first) {
      // the exact walk that must succeed once open has to FAIL while closed
      const wr = await walkDrive(c, await startFor(nd), nd.inward, nd, 1.0, 140);
      closedTest = { blocked: !wr.reached && wr.depth <= -0.2, depth: wr.depth };
      console.log(`  closed-door walk (${nd.archetype}, rise=${nd._rise}m): crossed=${wr.reached} depth=${wr.depth}m → ${closedTest.blocked ? "blocked (correct)" : "GOT THROUGH A CLOSED DOOR"}`);
    }
    let opened = false;
    if (first) {
      let r = await openViaKeyE(c, nd);
      if (!r.opened) { console.log(`  KeyE press did not open (mode=${r.pre.mode} dist=${r.pre.dist} sameDoor=${r.pre.sameDoor}) — retrying once`); r = await openViaKeyE(c, nd); }
      keyE = r.opened;
      opened = r.opened;
      console.log(`  KeyE open (${nd.archetype}): mode=${r.pre.mode} dist=${r.pre.dist}m sameDoor=${r.pre.sameDoor} → opened=${r.opened}`);
    } else {
      const r = await ev(c, `window.__openDoor(${ndj})`);
      opened = !!r.ok;
      if (!r.ok) console.log(`  toggleDoor open failed (${nd.archetype}): ${JSON.stringify(r)}`);
    }
    first = false;
    if (!opened) continue;
    for (let i = 0; i < 14; i++) await tick(c); // leaf swing (0.45 s); gap is already live
    if (!leafCheck) {
      leafCheck = await ev(c, `window.__leafState(${ndj})`);
      console.log(`  leaf after open: bakedVisible=${leafCheck.bakedVisible} dynamicLeaf=${leafCheck.dynLeaf}`);
    }
    const wr = await walkDrive(c, await startFor(nd), nd.inward, nd, 1.0, 320);   // drive until 1 m INSIDE
    console.log(`  walk-in try (${nd.archetype}, rise=${nd._rise}m): crossed=${wr.reached} depth=${wr.depth}m pos=${JSON.stringify(wr.pos)} interior=${wr.finalInside}`);
    if (!wr.reached) { console.log(`    sillRel=${(wr.pos[1]-nd.sill).toFixed(2)} blockers: ${await ev(c, `window.__whatBlocks(${JSON.stringify(wr.pos)})`)}`); continue; }
    entered = { nd, wr };
    interiorOk = wr.finalInside === true;
    break; // crossing the doorway = the contract's promise
  }
  if (entered) {
    const { nd, wr } = entered;
    console.log(`  WALK-IN OK (${nd.archetype}): crossed the doorway to ${wr.depth}m inside, interior gated=${wr.finalInside}, pos=${JSON.stringify(wr.pos)}`);
    // frame an interior shot from the player's own eye, looking deeper inside
    const dj = JSON.stringify(nd);
    await ev(c, `(()=>{const s=window.__sf,d=${dj}; s.chase.update=()=>{};
      const p=s.physics.world.getBodyTransform(s.player.body).position;
      s.camera.position.set(p[0],p[1]+0.7,p[2]);
      s.camera.lookAt(p[0]+d.inward[0]*6, p[1]+0.2, p[2]+d.inward[2]*6); return 1;})()`);
    for (let i = 0; i < 6; i++) await tick(c); await sleep(120);
    await shot(c, `door_${label}_inside.jpg`);
    // walk back OUT from exactly where the walk-in ended (teleporting deep inside
    // would strand the capsule on interior furniture — a test artifact, not a door)
    const wo = await walkDrive(c, [wr.pos[0], wr.pos[1] + 0.05, wr.pos[2]], [-nd.inward[0], 0, -nd.inward[2]], nd, -1.2);
    console.log(`  walk-out: exited=${wo.reached && !wo.finalInside} (depth ${wo.depth}m, inside gate=${wo.finalInside})  pos=${JSON.stringify(wo.pos)}`);
  } else {
    console.log("  WALK-IN FAILED on all candidates");
  }

  // ---- STOOP climb: open the biggest climbable downhill doors, then walk up ----
  // (the walkable stoop RAMP collider only exists once the door is open)
  let climbed = null, stoopTried = 0;
  for (const st of cov.stoop || []) {
    stoopTried++;
    const sj = JSON.stringify(st);
    const od = await ev(c, `window.__openDoor(${sj})`);
    if (!od.ok) { console.log(`  stoop open failed (${st.archetype}, rise ${st._rise}m): ${JSON.stringify(od)}`); continue; }
    for (let i = 0; i < 14; i++) await tick(c); // leaf swing
    const ramp = await ev(c, `(()=>{const d=${sj};
      const m=window.__sf.citygenRing.current.debugDoors().find(x=>Math.hypot(x.center[0]-d.center[0],x.center[2]-d.center[2])<0.05);
      return m ? m.nRamp : null;})()`);
    const wr = await walkDrive(c, await startFor(st), st.inward, st, 0.6, 320);
    const ys = wr.ys, dy = ys[ys.length - 1] - ys[0];
    console.log(`  stoop try (${st.archetype}, rise ${st._rise}m, nRamp after open=${ramp}): climbed Δ${dy.toFixed(2)}m, through door=${wr.reached} depth=${wr.depth} pos=${JSON.stringify(wr.pos)}`);
    if (!wr.reached) console.log(`    sillRel=${(wr.pos[1]-st.sill).toFixed(2)} blockers: ${await ev(c, `window.__whatBlocks(${JSON.stringify(wr.pos)})`)}`);
    if (wr.reached && dy > st._rise * 0.6) { climbed = { st, wr, ys, ramp }; break; }
  }
  if (climbed) {
    const { st, wr, ys } = climbed;
    console.log(`  STOOP OK (${st.archetype}): sill=${st.sill.toFixed(2)} frontGround=${st._fg} rise=${st._rise}m rampBoxes=${climbed.ramp}`);
    console.log(`         player y: ${ys.filter((_, i) => i % 8 === 0).join(" → ")} → ${ys[ys.length - 1]}  (Δ=${(ys[ys.length-1]-ys[0]).toFixed(2)}m; rise ${st._rise}m)  through door=${wr.reached}`);
    // this building demonstrably has an opened door + a live interior (the walk
    // carried on up its internal staircase) — shoot the interior from where the
    // player stands, then walk back OUT through the same front door.
    await ev(c, `(()=>{const s=window.__sf,d=${JSON.stringify(st)};
      const p=s.physics.world.getBodyTransform(s.player.body).position;
      s.camera.position.set(p[0],p[1]+0.7,p[2]);
      s.camera.lookAt(p[0]+d.inward[0]*6, p[1]-0.6, p[2]+d.inward[2]*6); return 1;})()`);
    for (let i = 0; i < 6; i++) await tick(c); await sleep(120);
    await shot(c, `door_${label}_interior_from_stoop.jpg`);
    const outStart = [st.center[0] + st.inward[0] * 1.2, st.sill + 1.05, st.center[2] + st.inward[2] * 1.2];
    const wo = await walkDrive(c, outStart, [-st.inward[0], 0, -st.inward[2]], st, -1.5, 200);
    console.log(`  stoop walk-out: exited=${wo.reached} (depth ${wo.depth}m)  final pos=${JSON.stringify(wo.pos)}`);
    // exterior 3/4 shot of the open door + stoop (leaf swung inward)
    const dj = JSON.stringify(st);
    await ev(c, `(()=>{const s=window.__sf,d=${dj}; s.chase.update=()=>{};
      const st2=[d.center[0]-d.inward[0]*1.5, d.sill+1.0, d.center[2]-d.inward[2]*1.5];
      s.player.position.set(st2[0],st2[1],st2[2]); s.player.renderPosition.copy(s.player.position);
      const eye=[d.center[0]-d.inward[0]*6.5+d.along[0]*3.0, d._fg+3.0, d.center[2]-d.inward[2]*6.5+d.along[2]*3.0];
      s.camera.position.set(eye[0],eye[1],eye[2]); s.camera.lookAt(d.center[0], d.sill+0.6, d.center[2]); return 1;})()`);
    for (let i = 0; i < 6; i++) await tick(c); await sleep(120);
    await shot(c, `door_${label}_stoop.jpg`);
  } else {
    console.log(stoopTried ? "  STOOP: no candidate climbed cleanly" : "  STOOP: no closed candidate with a ≥0.5 m rise streamed (skipping)");
  }

  const checks = [
    ["coverage streamed", true],
    ["doors closed by default (0 open on first scan)", closedByDefault],
    ["closed door blocks walk-in", !!(closedTest && closedTest.blocked)],
    ["KeyE opens the door (main.ts wiring)", keyE === true],
    ["baked leaf hidden + dynamic leaf after open", !!(leafCheck && !leafCheck.bakedVisible && leafCheck.dynLeaf)],
    ["walk-in through opened door", !!entered],
    ["interior gate while inside", interiorOk],
  ];
  if (stoopTried) checks.push(["stoop climb after open (ramp live)", !!climbed]);
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  return { label, ok: checks.every((x) => x[1]), checks, cov: { total: cov.total, doored: cov.doored, walkable: cov.walkable } };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort(); const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  let failed = false;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 120000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: HMR_BLOCK_SRC });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    // helpers + walk mode (armPage re-arms per district in case the page is
    // torn down mid-run anyway)
    await armPage(c);
    console.log("[probe] booted; player mode:", await ev(c, `window.__sf.player.mode`));
    // if the page still gets torn down mid-district (dev-server restart),
    // re-arm and retry the whole district
    const runDistrict = async (spot, label) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await district(c, spot, label); }
        catch (e) {
          console.log(`  [retry] ${label} crashed (attempt ${attempt}): ${String(e).split("\n")[0]}`);
          if (attempt === 3) return { label, ok: false };
        }
      }
    };
    const results = [];
    results.push(await runDistrict((process.env.SF_SPOT_VIC || "900,2400").split(",").map(Number), "victorian"));
    results.push(await runDistrict((process.env.SF_SPOT_SOMA || "1800,800").split(",").map(Number), "soma"));
    console.log("\n[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    const allPass = results.every((r) => r.ok);
    console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"} — ` + results.map((r) => `${r.label}:${r.ok ? "ok" : "FAIL"}`).join("  "));
    failed = !allPass;
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
