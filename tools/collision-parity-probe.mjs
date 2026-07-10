// Citywide COLLISION-vs-VISUAL parity audit.
//
// Boots the real app headless, teleports the player to ~40 sample sites across
// the districts (curated anchors + random street points from public/data/roads.json),
// lets the citygen exact-collider "coll" tier settle at each site, then at each
// site casts, per direction:
//   HORIZONTAL — 16 compass rays from chest height (gy+1.2) out to 30 m, comparing
//     (a) the PHYSICS world (__sf.physics.raycastWorld — buildings + citygen exact
//         walls + landmarks + terrain) against
//     (b) a THREE.Raycaster over the VISIBLE opaque world meshes (baked facades /
//         citygen wall panels / terrain / landmarks; foliage, water, decals, glass,
//         sprites and dynamic entities filtered out).
//   VERTICAL — one ray straight down from gy+3: physics ground vs visual surface.
//
// Classifies each mismatch:
//   PHANTOM = physics building hit >=1 m CLOSER than any visible wall (invisible box)
//   GHOST   = visible wall but physics passes >=1 m BEYOND it (walk-through wall)
//   FLOATBURY = |physics ground - visual surface| > 0.3 m (floating / buried floor)
// Excludes the KNOWN-GOOD cases: door gaps (ring.debugDoors ±(halfW+1.5)), open bay
// water, and terrain-slope grazes (physics "ground" kind is never a phantom wall).
//
// Output: ranked defect report to stdout + JSON + top-6 PNG screenshots in
//   .data/parity-audit/. Read-only on src. Owns its own vite + relay ports.
//
//   node tools/collision-parity-probe.mjs
//
// Harness cloned from tools/perf-shot-probe.mjs + tools/citygen-walkthrough-probe.mjs.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/parity-audit");
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- harness plumbing
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout " + url); }
class Cdp {
  #ws; #id = 1; #p = new Map(); errs = [];
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.method === "Runtime.exceptionThrown") this.errs.push((m.params?.exceptionDetails?.exception?.description || "exn").split("\n")[0]);
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
  close() { this.#ws.close(); }
}
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails).slice(0, 500)); return r.result?.value; }
async function ticks(c, n) { return ev(c, `(async()=>{const s=window.__sf,dev=s.renderer.backend.device;for(let i=0;i<${n};i++){s.tick(1/60);await dev.queue.onSubmittedWorkDone();}return 1;})()`); }

// -------------------------------------------------------- district + site sampling
// world coords: roads.json point values are /10 (see world/traffic/roadGraph.ts).
// District bboxes [minX,maxX,minZ,maxZ] + a hand-verified anchor per district.
const DISTRICTS = {
  fidi:        { bbox: [3850, 4500, -150, 650], anchor: [4260, 420], n: 5 },
  downtown:    { bbox: [3650, 4300, -350, 300], anchor: [4117, 120], n: 5 },
  soma:        { bbox: [2600, 3850, 500, 1750], anchor: [3400, 1150], n: 6 },
  chinatown:   { bbox: [2950, 3550, -720, -150], anchor: [3260, -430], n: 5 },
  victorian:   { bbox: [400, 1650, 1750, 2850], anchor: [900, 2400], n: 6 },
  // marina streets sit ~z -1600..-2150; the (-700,-2380) anchor is Marina Green /
  // the bay edge (off the grid) — kept as a curated vertical-parity test spot.
  marina:      { bbox: [-1500, 100, -2150, -1600], anchor: [-700, -2380], n: 4 },
  embarcadero: { bbox: [3350, 4250, -1550, -450], anchor: [3900, -1050], n: 5 },
};

// mulberry32 seeded RNG for reproducible sampling
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function loadRoadPoints() {
  const j = JSON.parse(readFileSync(path.join(ROOT, "public/data/roads.json"), "utf8"));
  const pts = [];
  for (const seg of j.segs) {
    const p = seg.p; // interior points bias toward denser cores; take all vertices
    for (let i = 0; i < p.length; i += 2) pts.push([p[i] / 10, p[i + 1] / 10]);
  }
  return pts;
}

function buildSites() {
  const roadPts = loadRoadPoints();
  const r = rng(0xC0FFEE);
  const sites = [];
  const inBox = (x, z, b) => x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3];
  for (const [name, d] of Object.entries(DISTRICTS)) {
    // curated anchor first
    sites.push({ id: `${name}-anchor`, district: name, x: d.anchor[0], z: d.anchor[1], kind: "anchor" });
    const pool = roadPts.filter((p) => inBox(p[0], p[1], d.bbox));
    const want = Math.max(0, d.n - 1);
    const picked = new Set();
    for (let tries = 0; tries < want * 40 && picked.size < want && pool.length; tries++) {
      const idx = Math.floor(r() * pool.length);
      const p = pool[idx];
      // de-dup: reject points within 25 m of an already picked one (spread out)
      let dup = false;
      for (const q of picked) { const [qx, qz] = q.split(",").map(Number); if (Math.hypot(qx - p[0], qz - p[1]) < 25) { dup = true; break; } }
      if (dup) continue;
      picked.add(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
    }
    let k = 0;
    for (const q of picked) { const [x, z] = q.split(",").map(Number); sites.push({ id: `${name}-r${k++}`, district: name, x, z, kind: "road" }); }
  }
  return sites;
}

// ------------------------------------------------------------ in-page audit code
// Injected once. Everything that touches THREE / the scene lives here so Node just
// orchestrates teleport -> settle -> cast and aggregates the returned records.
const PARITY_SRC = `
window.__parityPrep = () => {
  const s = window.__sf;
  // freeze the controller + chase so a teleported player stays put while we tick
  // streaming; a static camera is set explicitly for screenshots.
  s.__pu = s.player.update; s.player.update = () => {};
  if (s.chase) { s.__cu = s.chase.update; s.chase.update = () => {}; }
  try { s.sky.cycleEnabled = false; s.sky.setTimeOfDay(11.5); } catch {}
  return true;
};

// Move the player (drives ring/tile streaming) to a site; returns ground info.
window.__parityGo = (x, z) => {
  const s = window.__sf;
  const gy = s.map.groundHeight(x, z);
  const y = Math.max(gy + 1.6, s.map.effectiveGround(x, z) + 1.5);
  s.player.position.set(x, y, z);
  s.player.renderPosition.copy(s.player.position);
  try { s.physics.world.setBodyTransform(s.player.body, [x, y, z], [0, 0, 0, 1]); } catch {}
  return { gy: +gy.toFixed(2), water: !!s.map.isWater(x, z) };
};

// Settle telemetry: how many citygen exact-wall boxes + how many OPAQUE, visible
// citygen wall MESHES sit within r of the site. When colliders exist but no opaque
// wall mesh has faded in yet, the site is not settled (a fading wall is transparent
// and would read as a false PHANTOM).
window.__paritySettle = (x, z, r) => {
  const s = window.__sf, ring = s.citygenRing && s.citygenRing.current;
  let coll = 0;
  if (ring) { const w = []; ring.debugColliders(w, []); for (const b of w) { const dx = b.x - x, dz = b.z - z; if (dx * dx + dz * dz <= r * r) coll++; } }
  let opaqueWalls = 0;
  s.scene.updateMatrixWorld(true);
  s.scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.visible) return;
    let p = o, cg = false; while (p) { if (p.name === "cityGenBuilding") { cg = true; break; } p = p.parent; }
    if (!cg) return;
    const nm = o.name || ""; if (!/^wall\\.|^base\\.|^lc\\.(stone|pier|band)/.test(nm)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!m || (m.transparent && (m.opacity == null ? 1 : m.opacity) < 0.98)) return;
    if (!o.geometry.boundingSphere) { try { o.geometry.computeBoundingSphere(); } catch {} }
    const bs = o.geometry.boundingSphere; if (!bs) return;
    const c = bs.center.clone().applyMatrix4(o.matrixWorld);
    if (Math.hypot(c.x - x, c.z - z) < r) opaqueWalls++;
  });
  return { coll, opaqueWalls };
};

// classify a visual hit mesh
window.__wallClass = (o) => {
  const g = o.geometry;
  if (g && g.getAttribute && (g.getAttribute("_bid") || g.getAttribute("_BID"))) return "baked";     // baked OSM facade
  let p = o; while (p) { if (p.name === "cityGenBuilding") { const nm = o.name || ""; return /^wall\\.|^base\\.|^lc\\.(stone|pier|band)/.test(nm) ? "citygen" : "citygen-other"; } if (/^terrain_/.test(p.name || "")) return "terrain"; p = p.parent; }
  const nm = o.name || "";
  if (/^lm_bridge/.test(nm) || nm === "lm_bridge_goldengate_asphalt") return "bridge";
  if (/^lm_/.test(nm)) return "landmark";
  if (/^road_/.test(nm)) return "road";
  if (/^grn_/.test(nm)) return "ground";
  return "other";
};

// ray vs one oriented box (yaw about Y, optional quat->yaw). Returns entry distance
// along unit dir within [0,tMax], or Infinity. Origin inside the box => 0.
window.__rayOBB = (px, py, pz, dx, dy, dz, b, tMax) => {
  let yaw = b.yaw || 0;
  if (b.quat) yaw = 2 * Math.atan2(b.quat[1], b.quat[3]); // planar yaw from quat
  const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
  const ox = px - b.x, oy = py - b.y, oz = pz - b.z;
  const lx = ox * cs - oz * sn, lz = ox * sn + oz * cs, ly = oy;
  const ldx = dx * cs - dz * sn, ldz = dx * sn + dz * cs, ldy = dy;
  let tmin = 0, tmax = tMax;
  const slabs = [[lx, ldx, b.hx], [ly, ldy, b.hy], [lz, ldz, b.hz]];
  for (const [o, d, h] of slabs) {
    if (Math.abs(d) < 1e-9) { if (o < -h || o > h) return Infinity; }
    else { let t1 = (-h - o) / d, t2 = (h - o) / d; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return Infinity; }
  }
  return tmin;
};

// Full per-site cast: 16 horizontal rays + 1 vertical. Pure query (no side effects).
// Compares the VISUAL scene against TWO physics sources:
//   (a) raycastWorld  — the #solids query world (baked buildings + terrain + landmarks
//       + citygen exact-wall MIRRORS). This is what paint / world-cursor / aim use.
//   (b) citygen exact-wall OBBs (ring.debugColliders) — the REAL stepped-world walls
//       the walking player actually collides with.
// Walk-collision truth = min(raycastWorld building, nearest citygen OBB). A visible
// wall that neither stops = TRUE GHOST (walk-through). A wall the OBB stops but (a)
// misses = MIRROR gap (paint/cursor/aim blind, walking is fine).
window.__parityCast = (x, z) => {
  const s = window.__sf, THREE = s.THREE, ring = s.citygenRing && s.citygenRing.current;
  s.scene.updateMatrixWorld(true);
  const gy = s.map.groundHeight(x, z);
  const oy = gy + 1.2, MAX = 30;
  const origin = new THREE.Vector3(x, oy, z);

  // dynamic / non-collidable exclusion (name or ancestor name)
  const DYN = /(^|[_\\.\\b])(car|vehicle|wheel|chassis|avatar|remote|creature|bear|raccoon|horse|bird|feather|butterfly|crab|fish|gull|player|guitar|rocket|firework|paintball|splat|bubble|chime|coin|chest|rope|grab|sail|cloth|banner|flag|wake|ripple|spray|smoke|dust|cloud|sky|grass|flower|petal|leaf|foliage|tree|shrub|hedge|blade|marking|crosswalk|decal|sprite|cursor|minimap|particle|water|snitch|quaffle|ball|satchel|lamp|light|glow|sign|awning|antenna|wire|cable)/i;
  const isDyn = (o) => { let p = o; while (p) { if (DYN.test(p.name || "")) return true; p = p.parent; } return false; };

  // candidate opaque visible world meshes near the site (rebuilt per site — cheap)
  const cand = [];
  s.scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.visible) return;
    let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; } if (!vis) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!m) return;
    if (m.transparent && (m.opacity == null ? 1 : m.opacity) < 0.98) return;   // glass / decals / fading
    if (isDyn(o)) return;
    if (!o.geometry || !o.geometry.attributes.position) return;
    if (!o.geometry.boundingSphere) { try { o.geometry.computeBoundingSphere(); } catch {} }
    const bs = o.geometry.boundingSphere; if (!bs) return;
    const c = bs.center.clone().applyMatrix4(o.matrixWorld);
    const sc = Math.max(Math.abs(o.scale.x), Math.abs(o.scale.y), Math.abs(o.scale.z));
    const rad = bs.radius * sc;
    if (Math.hypot(c.x - x, c.z - z) - rad > MAX + 3) return;                    // too far to matter
    cand.push(o);
  });

  // real citygen stepped-collision wall OBBs near the site (walk-collision truth)
  const obbs = [];
  if (ring) { const w = []; ring.debugColliders(w, []); for (const b of w) { if (Math.hypot(b.x - x, b.z - z) < MAX + 6) obbs.push(b); } }

  // nearby door centres (expected collider GAPS) for GHOST exclusion
  const doors = [];
  if (ring) { for (const d of ring.debugDoors()) { const dx = d.center[0] - x, dz = d.center[2] - z; if (dx * dx + dz * dz < (MAX + 5) * (MAX + 5)) doors.push({ cx: d.center[0], cz: d.center[2], r: d.halfW + 1.5 }); } }
  const nearDoor = (px, pz) => doors.some((d) => Math.hypot(px - d.cx, pz - d.cz) <= d.r);

  const rc = new THREE.Raycaster(); rc.far = MAX;
  const WALLCLASS = { baked: 1, citygen: 1, landmark: 1, bridge: 1 };
  const rayOut = { handle: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
  const SELF = 0.5; // skip the player's own capsule on the stepped-world cast

  const dirs = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const dvec = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    // (a) raycastWorld — the #solids QUERY world (paint / world-cursor / aim reticle)
    const ph = s.physics.raycastWorld(origin, dvec, MAX);
    const physKind = ph ? ph.kind : null;
    const physDist = ph ? origin.distanceTo(ph.point) : Infinity;
    const physBuild = physKind === "building" ? physDist : Infinity;
    // (b) STEPPED world — the actual bodies the WALKING player collides with (baked
    // building bodies + citygen exact walls). Cast from just past the self capsule.
    let walkDist = Infinity;
    try {
      const h = s.physics.world.castRayClosest(origin.x + dvec.x * SELF, origin.y + dvec.y * SELF, origin.z + dvec.z * SELF, dvec.x, dvec.y, dvec.z, MAX - SELF, undefined, rayOut);
      if (h) walkDist = h.distance + SELF;
    } catch {}
    // (c) nearest citygen exact-wall OBB — to attribute a stepped hit to citygen vs baked
    let obbDist = Infinity;
    for (const b of obbs) { const t = window.__rayOBB(origin.x, origin.y, origin.z, dvec.x, dvec.y, dvec.z, b, MAX); if (t < obbDist) obbDist = t; }
    // visual: nearest solid wall + nearest-of-any
    rc.set(origin, dvec);
    const hits = rc.intersectObjects(cand, false);
    let visAny = Infinity, visAnyName = null, visAnyClass = null, visWall = Infinity, visWallName = null, visWallClass = null, visWallPt = null;
    for (const h of hits) {
      if (h.distance < 0.05) continue;
      if (visAny === Infinity) { visAny = h.distance; visAnyName = h.object.name || "?"; visAnyClass = window.__wallClass(h.object); }
      const cls = window.__wallClass(h.object);
      if (WALLCLASS[cls] && visWall === Infinity) { visWall = h.distance; visWallName = h.object.name || "?"; visWallClass = cls; visWallPt = h.point; }
      if (visAny !== Infinity && visWall !== Infinity) break;
    }

    // TERRAIN-SLOPE GRAZE exclusion (the audit charter's third known-good case). A
    // horizontal chest-height ray on SF's hills runs into the RISING ground ahead;
    // the stepped world has terrain colliders, so the walker "stops" there with NO
    // building involved. The old test only kept terrain out of visWall (WALLCLASS),
    // which — since visWall then stayed Infinity — made every such graze read as a
    // PHANTOM and, because physBuild is Infinity for a "ground" hit, a ray-blind
    // MIRROR too. Both are false: nothing invisible is there, and paint/cursor land
    // on the same ground the walker does. Detect the graze off what the STEPPED stop
    // actually is — the #solids raycast calls it "ground" at ~the same range, or the
    // nearest visible thing is terrain/road right there — and never off a building.
    // A genuine invisible box (query solid stripped) keeps walkDist FAR short of the
    // ground raycast / visible terrain, so it survives this filter and stays flagged.
    const GROUNDISH = { terrain: 1, road: 1, ground: 1 };
    const grazeGround = visWall === Infinity && (
      (physKind === "ground" && isFinite(physDist) && Math.abs(physDist - walkDist) < 3.0) ||
      (isFinite(visAny) && GROUNDISH[visAnyClass] && Math.abs(visAny - walkDist) < 3.0)
    );

    let klass = "ok", gap = 0, note = "";
    // PHANTOM: the WALKING player is stopped >=1 m CLOSER than any visible wall
    // (terrain grazes excluded — those are ground, not an invisible building box).
    if (!grazeGround && walkDist !== Infinity && walkDist + 1.0 <= visWall) {
      klass = "phantom"; gap = +(Math.min(visWall, MAX) - walkDist).toFixed(2);
      note = (isFinite(obbDist) && Math.abs(obbDist - walkDist) < 1.0) ? "citygen-wall" : "baked/other";
    }
    // GHOST: a visible wall is the nearest solid but the walking player is NOT stopped.
    else if (visWall !== Infinity && visWall <= visAny + 0.5 && visWall + 1.0 <= walkDist) {
      if (nearDoor(visWallPt.x, visWallPt.z)) { klass = "door"; note = "expected door gap"; }
      else { klass = "ghost"; gap = +(Math.min(walkDist, MAX) - visWall).toFixed(2); }
    }
    // MIRROR mismatch (info, NOT a walk defect): the #solids raycast world disagrees
    // with the real stepped collision by >=1 m — paint / cursor / aim land wrong.
    // Only meaningful for BUILDINGS (the metric's charter); a terrain graze is not a
    // paint-vs-walk wall mismatch, so it's excluded on the same grazeGround signal.
    let mirror = null;
    if (!grazeGround && Math.abs(physBuild - walkDist) > 1.0) mirror = physBuild < walkDist ? "ray-proud" : "ray-blind";
    dirs.push({ i, deg: Math.round(a * 180 / Math.PI), klass, gap, note, mirror, grazeGround,
      physKind, physDist: isFinite(physDist) ? +physDist.toFixed(2) : null,
      walkDist: isFinite(walkDist) ? +walkDist.toFixed(2) : null,
      obbDist: isFinite(obbDist) ? +obbDist.toFixed(2) : null,
      visWall: isFinite(visWall) ? +visWall.toFixed(2) : null, visWallName, visWallClass,
      visAny: isFinite(visAny) ? +visAny.toFixed(2) : null, visAnyName, visAnyClass });
  }

  // VERTICAL: ray down from gy+3. physFloorY is the collision floor you stand on.
  // A world-wide flat mesh sits ~2.6 m above ground (see topHit) and would dominate
  // the FIRST hit, so we pick the visual surface whose Y is CLOSEST to the physics
  // floor; a real float/bury is when even that best surface disagrees by >0.3 m.
  const vo = new THREE.Vector3(x, gy + 3, z), vd = new THREE.Vector3(0, -1, 0);
  const vph = s.physics.raycastWorld(vo, vd, 12);
  const physY = vph ? vph.point.y : null, physVKind = vph ? vph.kind : null;
  rc.far = 20; rc.set(new THREE.Vector3(x, gy + 8, z), vd);
  const vhits = rc.intersectObjects(cand, false);
  let topName = null, topClass = null, topY = null;
  let bestY = null, bestName = null, bestClass = null, bestErr = Infinity;
  for (const h of vhits) {
    if (topY === null) { topY = +h.point.y.toFixed(2); topName = h.object.name || "?"; topClass = window.__wallClass(h.object); }
    if (physY !== null) { const e = Math.abs(h.point.y - physY); if (e < bestErr) { bestErr = e; bestY = h.point.y; bestName = h.object.name || "?"; bestClass = window.__wallClass(h.object); } }
  }
  let vKlass = "ok", vDelta = 0;
  if (physVKind === "water" && bestY === null) { vKlass = "water"; }
  else if (physY !== null && bestY !== null) { vDelta = +(physY - bestY).toFixed(2); if (Math.abs(vDelta) > 0.3) vKlass = "floatbury"; }
  else if (physY !== null && bestY === null) { vKlass = "no-visual"; }
  else if (physY === null && bestY !== null) { vKlass = "no-physics"; }
  const vertical = { klass: vKlass, delta: vDelta, physY: physY == null ? null : +physY.toFixed(2), physKind: physVKind, visY: bestY == null ? null : +bestY.toFixed(2), visName: bestName, visClass: bestClass, topName, topClass, topY };

  return { x, z, gy: +gy.toFixed(2), nCand: cand.length, nObb: obbs.length, nDoors: doors.length, dirs, vertical };
};

// Screenshot: restore the real controller + chase cam and teleport the player to
// the site FACING the offending direction, so the natural third-person view shows
// the wall ahead. (The frozen-manual-camera path grabbed stale headless frames.)
window.__parityShot = (x, z, deg) => {
  const s = window.__sf;
  if (s.__pu) s.player.update = s.__pu;
  if (s.__cu && s.chase) s.chase.update = s.__cu;
  const gy = s.map.groundHeight(x, z), a = deg * Math.PI / 180;
  s.player.teleportTo({ x, y: gy + 1.6, z, facing: a, mode: "walk" });
  return true;
};
// Re-freeze between shots so the next teleport+settle is deterministic.
window.__parityRefreeze = () => { const s = window.__sf; s.player.update = () => {}; if (s.chase) s.chase.update = () => {}; return true; };
`;

// ------------------------------------------------------------------------ driver
async function settleSite(c, x, z) {
  let prev = -1, stable = 0, last = null;
  for (let round = 0; round < 9; round++) {
    await ticks(c, 20);
    last = await ev(c, `window.__paritySettle(${x},${z},45)`);
    if (last.coll === prev) stable++; else stable = 0;
    prev = last.coll;
    const opaqueOk = last.coll === 0 || last.opaqueWalls > 0;
    if (round >= 2 && stable >= 1 && opaqueOk) return { ...last, settled: true, rounds: round + 1 };
  }
  return { ...last, settled: last.coll === 0 || last.opaqueWalls > 0, rounds: 9 };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const sites = buildSites();
  console.log(`[parity] ${sites.length} sites across ${Object.keys(DISTRICTS).length} districts`);

  const vitePort = await freePort(), relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 120000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--hide-scrollbars", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });

    // wait for app + citygen ring
    const t0 = Date.now(); let ready = false;
    while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.citygenRing)`)) { ready = true; break; } } catch {} await sleep(600); }
    if (!ready) throw new Error("app never ready");
    await ev(c, `window.__sfManual&&window.__sfManual(true)`);
    await ev(c, PARITY_SRC);
    await ev(c, `window.__parityPrep()`);
    await ticks(c, 30);
    // wait for the ring to actually exist (createCityGenRing resolves post-boot)
    for (let i = 0; i < 40 && !(await ev(c, `!!(window.__sf.citygenRing.current)`)); i++) await ticks(c, 15);
    console.log(`[parity] booted (vite ${vitePort}); ring=${await ev(c, `!!window.__sf.citygenRing.current`)}`);

    const results = [];
    const startAll = Date.now();
    for (let n = 0; n < sites.length; n++) {
      const site = sites[n];
      const go = await ev(c, `window.__parityGo(${site.x},${site.z})`);
      const st = await settleSite(c, site.x, site.z);
      const cast = await ev(c, `window.__parityCast(${site.x},${site.z})`);
      // tally
      let phantom = 0, ghost = 0, door = 0, mirror = 0, graze = 0, worst = 0, worstDir = null;
      for (const d of cast.dirs) {
        if (d.klass === "phantom") { phantom++; if (d.gap > worst) { worst = d.gap; worstDir = d; } }
        else if (d.klass === "ghost") { ghost++; if (d.gap > worst) { worst = d.gap; worstDir = d; } }
        else if (d.klass === "door") door++;
        if (d.mirror) mirror++;
        if (d.grazeGround) graze++;
      }
      const v = cast.vertical;
      const vert = v.klass === "floatbury" ? Math.abs(v.delta) : 0;
      const score = phantom * 2 + ghost * 2 + (vert > 0 ? 1 + Math.min(vert, 3) : 0) + Math.min(worst, 15) * 0.3;
      results.push({ ...site, go, settled: st.settled, collNear: st.coll, nObb: cast.nObb, phantom, ghost, door, mirror, graze, worst: +worst.toFixed(2), worstDir, vert: +vert.toFixed(2), vertRec: v, nCand: cast.nCand, dirs: cast.dirs, score: +score.toFixed(2) });
      const flag = (!st.settled) ? " UNSETTLED" : "";
      process.stdout.write(`  [${String(n + 1).padStart(2)}/${sites.length}] ${site.id.padEnd(18)} (${String(Math.round(site.x)).padStart(5)},${String(Math.round(site.z)).padStart(6)}) ph=${phantom} gh=${ghost} mir=${mirror} graze=${graze} vert=${vert ? vert.toFixed(2) : "-"} obb=${cast.nObb}${flag}\n`);
    }
    console.log(`[parity] all sites cast in ${((Date.now() - startAll) / 1000).toFixed(0)}s`);

    // ---- aggregate ----------------------------------------------------------
    const byDistrict = {};
    let totPh = 0, totGh = 0, totDoor = 0, totVert = 0, totRays = 0, totMirror = 0, totGraze = 0;
    for (const r of results) {
      const d = byDistrict[r.district] || (byDistrict[r.district] = { sites: 0, rays: 0, phantom: 0, ghost: 0, door: 0, mirror: 0, graze: 0, vert: 0, unsettled: 0 });
      d.sites++; d.rays += 16; d.phantom += r.phantom; d.ghost += r.ghost; d.door += r.door; d.mirror += r.mirror; d.graze += r.graze; if (r.vert > 0) d.vert++; if (!r.settled) d.unsettled++;
      totPh += r.phantom; totGh += r.ghost; totDoor += r.door; totMirror += r.mirror; totGraze += r.graze; if (r.vert > 0) totVert++; totRays += 16;
    }
    // breakdowns: what ghosts SEE, phantom source, mirror-mismatch kind, vertical top-mesh
    const ghostByClass = {}, phantomSource = {}, mirrorKind = {}, vertTopMesh = {};
    for (const r of results) for (const d of r.dirs) {
      if (d.klass === "ghost") ghostByClass[d.visWallClass || "?"] = (ghostByClass[d.visWallClass || "?"] || 0) + 1;
      if (d.klass === "phantom") phantomSource[d.note || "?"] = (phantomSource[d.note || "?"] || 0) + 1;
      if (d.mirror) mirrorKind[d.mirror] = (mirrorKind[d.mirror] || 0) + 1;
    }
    for (const r of results) { const t = `${r.vertRec.topClass}:${r.vertRec.topName || ""}`; vertTopMesh[t] = (vertTopMesh[t] || 0) + 1; }

    const ranked = [...results].sort((a, b) => b.score - a.score);
    const worst20 = ranked.slice(0, 20);

    // ---- screenshots of top 6 (natural chase-cam view facing the worst ray) ----
    const shots = [];
    for (let i = 0; i < Math.min(6, worst20.length); i++) {
      const r = worst20[i];
      if (r.score <= 0) break;
      const deg = r.worstDir ? r.worstDir.deg : 0;
      await ev(c, `window.__parityGo(${r.x},${r.z})`);
      await settleSite(c, r.x, r.z);
      await ev(c, `window.__parityShot(${r.x},${r.z},${deg})`);
      // let the player land + chase cam ease in behind, rendering real frames
      for (let k = 0; k < 6; k++) { await ticks(c, 12); await sleep(120); }
      const png = await c.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const fn = `worst${i + 1}_${r.id}_${deg}deg.png`;
      writeFileSync(path.join(OUT, fn), Buffer.from(png.data, "base64"));
      shots.push(fn);
      await ev(c, `window.__parityRefreeze()`);
    }

    // ---- write report -------------------------------------------------------
    const report = { generated: new Date().toISOString(), branch: "claude/game-perf-polish-79a383", sites: results.length, totals: { rays: totRays, phantom: totPh, ghost: totGh, mirrorMismatch: totMirror, grazeExcluded: totGraze, doorExcluded: totDoor, vertMismatchSites: totVert }, byDistrict, ghostByClass, phantomSource, mirrorKind, vertTopMesh, worst20: worst20.map((r) => ({ id: r.id, district: r.district, x: Math.round(r.x), z: Math.round(r.z), gy: r.go.gy, phantom: r.phantom, ghost: r.ghost, mirror: r.mirror, worstGap: r.worst, worstDeg: r.worstDir?.deg ?? null, worstVisWall: r.worstDir?.visWallName ?? null, worstVisClass: r.worstDir?.visWallClass ?? null, worstKlass: r.worstDir?.klass ?? null, worstNote: r.worstDir?.note ?? null, worstWalkDist: r.worstDir?.walkDist ?? null, worstObbDist: r.worstDir?.obbDist ?? null, vert: r.vert, vertRec: r.vertRec, settled: r.settled, collNear: r.collNear, nObb: r.nObb, score: r.score })), shots, full: results };
    writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

    // ---- console summary ----------------------------------------------------
    console.log("\n================ COLLISION-vs-VISUAL PARITY AUDIT ================");
    console.log(`sites=${results.length}  horizontal rays=${totRays}  (+${results.length} verticals)`);
    console.log(`PHANTOM (WALK blocked, nothing visible): ${totPh}   <- real invisible walls`);
    console.log(`GHOST   (visible wall, WALK-through)   : ${totGh}   <- real walk-through`);
    console.log(`MIRROR  (#solids raycast != stepped)   : ${totMirror}  <- paint/cursor/aim only`);
    console.log(`FLOAT/BURY (vertical>0.3m)             : ${totVert} sites`);
    console.log(`terrain-slope grazes excluded (ok)     : ${totGraze}  <- horizontal ray into rising ground`);
    console.log(`door gaps excluded (ok)                : ${totDoor}`);
    console.log(`unsettled sites                        : ${results.filter((r) => !r.settled).length}`);
    console.log("\n-- per district (phantom / ghost / mirror / graze / vertSites / unsettled) --");
    for (const [name, d] of Object.entries(byDistrict)) console.log(`  ${name.padEnd(12)} ph=${String(d.phantom).padStart(3)}  gh=${String(d.ghost).padStart(3)}  mir=${String(d.mirror).padStart(3)}  graze=${String(d.graze).padStart(3)}  vert=${String(d.vert).padStart(2)}  rays=${String(d.rays).padStart(3)}  unsettled=${d.unsettled}`);
    console.log("\n-- ghost hits by visual wall kind --");
    for (const [k, v] of Object.entries(ghostByClass).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("-- phantom source (which collider stopped the walker early) --");
    for (const [k, v] of Object.entries(phantomSource).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("-- mirror mismatch kind (ray-proud=paint stops early / ray-blind=paint passes) --");
    for (const [k, v] of Object.entries(mirrorKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("-- vertical top-mesh (surface directly under gy+8, per site) --");
    for (const [k, v] of Object.entries(vertTopMesh).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
    console.log("\n-- worst 20 sites --");
    console.log("  rank  id                  coord            ph gh mir vert   what");
    worst20.forEach((r, i) => {
      const wd = r.worstDir; const what = wd ? `${wd.klass}(${wd.note}) ${wd.gap}m @${wd.deg}deg vis:${wd.visWallName || "-"}(${wd.visWallClass || "-"}) walk=${wd.walkDist} obb=${wd.obbDist}` : (r.vert > 0 ? `vert ${r.vertRec.delta}m ${r.vertRec.visClass || "-"}<>${r.vertRec.physKind}` : "-");
      console.log(`  ${String(i + 1).padStart(3)}   ${r.id.padEnd(18)} (${String(Math.round(r.x)).padStart(5)},${String(Math.round(r.z)).padStart(6)})  ${String(r.phantom).padStart(2)} ${String(r.ghost).padStart(2)} ${String(r.mirror).padStart(3)}  ${String(r.vert).padStart(4)}  ${what}${r.settled ? "" : "  [UNSETTLED]"}`);
    });
    console.log(`\nscreenshots: ${shots.length} -> ${path.join(OUT)}`);
    console.log(`report.json -> ${path.join(OUT, "report.json")}`);
    console.log("page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    c.close();
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error("[parity] FAIL", e); process.exitCode = 1; });
