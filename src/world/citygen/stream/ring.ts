// Citywide CityGen streaming ring — CHUNKED LOD + own crossfade, no baked fabric.
//
// The whole visible city is OURS. Buildings are grouped by tile cell; each cell
// within view is baked into ONE merged LOD chunk (render/chunkLod.ts) — a couple
// dozen draw calls for the entire skyline. The baked OSM mesh is hidden across
// every loaded cell (mesh-only suppression: R=1, so the ACCURATE baked collider
// stays live and catches cars/players via the multi-anchor physics — no oversized
// proxy box). As you approach a building (DETAIL_R) its full grammar mesh dithers
// in OVER the chunk prism (an all-ours crossfade), its baked collider is swapped
// for per-edge walk-in walls + a door, and the lazy interior gates on being inside.
//
// Everything is STATIC: world-space geometry, matrixAutoUpdate off, Static bodies.
// Nothing is destructible — buildings don't break; a crash just stops you.
import * as THREE from "three/webgpu";
import { buildingColliders, doorMetrics, doorEligible } from "../core/collider";
import { ensureCCW, streetEdgeIndex, edgeOutwardNormal, signedDistToPoly } from "../core/footprint";
import { buildBuilding, buildInterior, assembleBuilding, warmupMaterials } from "../render";
import { buildChunkLOD, type ChunkLOD } from "../render/chunkLod";
import { lodMaterial } from "../render/lod";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec, ColliderBox, MeshData } from "../core/types";
import { CITYGEN_TUNING } from "../../../config";

const READY = new Set(["victorian", "edwardian", "marina", "downtown", "soma"]);

// Live-tunable streaming params (CITYGEN_TUNING, "/" panel). Read fresh each scan.
const CT = CITYGEN_TUNING.values;
const DETAIL_EXIT_MARGIN = 25; // detail fades back to the chunk prism this far past detailRadius
// detail MESH builds per scan — buildBuilding() is the expensive synchronous call here.
// Adaptive on frame headroom (gauged off dt, the delta update() was just called with) so
// rounding a corner into a dense block backfills faster instead of visibly sharpening one
// building at a time, but only triples the worst-case per-scan cost when the frame can
// afford it. No smoothing/history: a slow frame caps it back down on the very next scan.
const DETAIL_BUDGET_FAST = 3; // dt < 1/50s (running >50fps): plenty of headroom
const DETAIL_BUDGET_MED = 2;  // dt < 1/30s (running >30fps): some headroom
const DETAIL_BUDGET_SLOW = 1; // else: frame is tight, stay conservative
// Exact-collider tier: tight radius (you can only ever TOUCH a building a few
// metres away — a wider band would just spawn hundreds of idle static walls).
// 90 m + a 20/scan nearest-first fill beats even a fast approach (boost/board downhill)
// to the ~3 m touch range before the ~2m-oversized loose baked box is ever hit — the
// prior 55m/12 could lose that race under speed (audit R3). These are cheap physics
// boxes (near-free for box3d's static broadphase) and citygen-owned — addBody() below
// calls physics.world.createBox() directly and isn't tracked against, or gated by,
// CONFIG.maxActiveBuildingBodies (that 700 cap lives entirely in physics.ts's own
// #buildingBodies bookkeeping for baked-tile OBBs) — so the wider ring/budget costs
// effectively nothing extra. Own radius, NOT detailR (which is 150 m for the mesh and
// would over-spawn).
const COLLIDER_R = 90;
const COLLIDER_EXIT = 115; // hysteresis: drop back to baked only past here
const COLLIDER_BUDGET = 20; // exact-collider swaps per scan (cheap: no mesh) — nearest first
const CHUNK_BUDGET = 260;// buildings merged into chunk geometry per frame (no hitch)
const SCAN_EVERY = 0.15;

interface PhysWorld {
  createBox(o: { type: number; position: readonly [number, number, number]; halfExtents: readonly [number, number, number]; friction?: number }): number;
  setBodyTransform(h: number, p: readonly [number, number, number], q: readonly [number, number, number, number]): void;
  destroyBody(h: number): void;
}
// Optional host hook (SF's Physics facade provides it): mirror each wall/interior
// box into the physics query world so raycasts (paint / world cursor / aim reticle)
// see it — our bodies live on the STEPPED world, invisible to raycastWorld's #solids
// cast. Keyed by the stepped-body handle so removal stays exact. Optional so the
// module stays portable to a host without a query world.
interface QuerySolidHost {
  addQuerySolid(id: number, box: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number; quat?: readonly [number, number, number, number] }): void;
  removeQuerySolid(id: number): void;
}
interface Tiles {
  suppressBuilding(key: string, index: number): void;
  unsuppressBuilding(key: string, index: number): void;
  suppressBuildingMesh(key: string, index: number): void;
  unsuppressBuildingMesh(key: string, index: number): void;
}
// Optional host frame-budget scheduler (SF's core/frameBudget.ts): deferrable
// bursty work — physics body batches, mesh assembly, material warmups — queues
// here and drains under the host's per-frame ms budget. Without a host
// scheduler the module stays portable: work runs immediately (old behaviour).
type ScheduleFn = (lane: "physics" | "build" | "upload" | "background", job: () => void | "again") => void;
interface BuiltGroup { group: THREE.Group; setOpacity(o: number): void; dispose(): void; }

interface Entry extends BuildingSpec {
  key: string;
  cx: number; cz: number;
  bb: { minx: number; maxx: number; minz: number; maxz: number };
  detail: BuiltGroup | null;
  fade: number; fadeDir: number;
  bodies: number[];              // exact-poly wall colliders (coll + detail tiers)
  wallBoxes: ColliderBox[];      // source OBBs of `bodies` (debug x-ray only)
  interior: { group: THREE.Group; dispose(): void } | null;
  intBodies: number[];
  intBoxes: ColliderBox[];       // source OBBs of `intBodies` (debug x-ray only)
  // lod    = far: baked mesh hidden (R=1), the LOOSE baked collider is live.
  // coll   = near: baked collider dropped (R=0) + exact-poly SOLID walls, so the
  //          collider matches the visible LOD prism (no "invisible box" — the
  //          baked decomposition overshoots the true footprint by ~2 m). Mesh is
  //          still the prism (the pretty grammar mesh is budgeted separately).
  // detail = closest-N: exact-poly walls WITH a door + full grammar mesh + interior.
  state: "lod" | "coll" | "detail";
  // detail tier: SOLID walls are live but the door gap is not cut yet — the swap to
  // door-gapped walls waits until the detail mesh has fully faded in, so there's
  // never an open collider gap in front of a still-transparent doorway (R6). Cleared
  // by openDoorway() at fade end.
  doorPending: boolean;
  // a grammar-build request is in flight on the worker (counts against the
  // detail cap; cleared on assemble, displacement is handled by normal eviction)
  pendingBuild: boolean;
}

interface CellState { key: string; ix: number; iz: number; entries: Entry[]; chunk: ChunkLOD | null; phase: "building" | "ready"; }

function boundsOf(poly: readonly (readonly [number, number])[]) {
  let x = 0, z = 0, minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [px, pz] of poly) { x += px; z += pz; if (px < minx) minx = px; if (px > maxx) maxx = px; if (pz < minz) minz = pz; if (pz > maxz) maxz = pz; }
  return { cx: x / poly.length, cz: z / poly.length, minx, maxx, minz, maxz };
}

// Highest ground under a footprint (verts + edge midpoints), from live terrain.
// The baked `base` is the LOWEST ground (buildings dig into hills), so on a slope
// the bottom window rows would sit below the uphill grade — this is the line the
// façade/LOD keep windows above. Clamped into (base, top) against a bad sample.
function footprintGrade(
  poly: readonly (readonly [number, number])[], base: number, top: number,
  map: { groundHeight(x: number, z: number): number },
): number {
  let gmax = -Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [x0, z0] = poly[k];
    const [x1, z1] = poly[(k + 1) % poly.length];
    const h0 = map.groundHeight(x0, z0);
    const hm = map.groundHeight((x0 + x1) / 2, (z0 + z1) / 2);
    if (h0 > gmax) gmax = h0;
    if (hm > gmax) gmax = hm;
  }
  if (!Number.isFinite(gmax)) return base;
  // grade = the true ground line (highest terrain under the footprint). Ground-floor
  // doors/storefronts meet it exactly; window sills clear it via aboveGrade()'s own
  // margin (so no +margin here, or entries would float above flat-lot sidewalks).
  return Math.min(Math.max(gmax, base), top - 1.5);
}

interface GridData {
  tile: number; minX: number; minZ: number; tilesX: number; tilesZ: number;
  cells: Record<string, (BuildingSpec & { i: number })[]>;
}

/** One faded-in detail building's street door, in world space — enough for a probe
 *  to raycast the opening and push a body through it. Matches the collider gap and
 *  the visible doorway exactly (all read core's doorMetrics/doorEligible). */
export interface CityGenDoorProbe {
  archetype: string;
  /** door centre on the street edge, at the SILL / doorway-floor line (world x,y,z) */
  center: [number, number, number];
  /** unit vector pointing INTO the building (−outward normal) */
  inward: [number, number, number];
  /** unit vector along the street edge (p0→p1) */
  along: [number, number, number];
  /** metres from p0 to the door centre along the edge (for on-wall side tests) */
  dcenter: number;
  /** doorway floor (raised to grade) + head of the walk-through opening (world Y) */
  sill: number; openTop: number;
  halfW: number; base: number; grade: number; top: number; length: number;
  /** true once the fade finished and openDoorway swapped in the gap + stoop
   *  colliders (false while the detail mesh is still fading in over solid walls) */
  open: boolean;
  /** DEBUG: the entry's sampled front-terrain height + how many tilted (stoop
   *  ramp) collider boxes are live for this building */
  fg?: number; nRamp: number;
  bb: { minx: number; maxx: number; minz: number; maxz: number };
}

export interface CityGenRing {
  count: number;
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): { total: number; cells: number; buildings: number; detail: number; interiors: number };
  /** true while the player is inside a generated building (drives the indoor camera). */
  isPlayerInside(): boolean;
  debugBuildings(): { cx: number; cz: number; base: number; top: number; interior: boolean; bb: { minx: number; maxx: number; minz: number; maxz: number } }[];
  /** DEBUG: live walk-in wall + interior collider OBBs for the "/" x-ray overlay. */
  debugColliders(walls: ColliderBox[], interiors: ColliderBox[]): void;
  /** DEBUG/probe: world-space door frames for every faded-in detail building. */
  debugDoors(): CityGenDoorProbe[];
}

async function fetchGrid(url: string): Promise<GridData | null> {
  try { const r = await fetch(url, { cache: "force-cache" }); if (!r.ok) return null; return (await r.json()) as GridData; }
  catch { return null; }
}

export async function createCityGenRing(
  opts: { url?: string },
  ctx: { scene: THREE.Object3D; physics: { world: PhysWorld } & Partial<QuerySolidHost>; map: { groundHeight(x: number, z: number): number }; tiles: Tiles; schedule?: ScheduleFn },
): Promise<CityGenRing> {
  const url = opts.url ?? "/citygen/buildings.json";
  const grid = await fetchGrid(url);
  const materials = buildCityGenMaterials();
  // no host scheduler → run deferred work immediately (portable fallback)
  const schedule: ScheduleFn = ctx.schedule ?? ((_lane, job) => { let v = job(); let guard = 0; while (v === "again" && guard++ < 10000) v = job(); });

  // materialize entries per cell (ready archetypes only)
  const cellEntries = new Map<string, Entry[]>();
  let total = 0;
  if (grid) {
    for (const [key, list] of Object.entries(grid.cells)) {
      const entries = list.filter((b) => READY.has(b.archetype)).map((b) => {
        const g = boundsOf(b.poly);
        const grade = footprintGrade(b.poly, b.base, b.top, ctx.map);
        return { ...b, grade, key, cx: g.cx, cz: g.cz, bb: { minx: g.minx, maxx: g.maxx, minz: g.minz, maxz: g.maxz },
          detail: null, fade: 0, fadeDir: 0, bodies: [] as number[], wallBoxes: [] as ColliderBox[],
          interior: null, intBodies: [] as number[], intBoxes: [] as ColliderBox[],
          state: "lod" as const, doorPending: false, pendingBuild: false } as Entry;
      });
      if (entries.length) { cellEntries.set(key, entries); total += entries.length; }
    }
  }
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0, minZ = grid?.minZ ?? 0;

  const loaded = new Map<string, CellState>();
  const building: CellState[] = []; // cells still merging their chunk
  let accum = 0;

  // Every box is mirrored into the query world (walls AND interior geometry) so
  // raycasts (paint / world cursor / aim reticle) hit citygen geometry exactly
  // where the baked twin has been suppressed.
  //
  // YAW SIGN: citygen authors `yaw` in the app's planar convention — the box's
  // local +X lies along (cos yaw, +sin yaw) in the x/z ground plane (this is what
  // core/collider's edge math produces and what the "/" collider x-ray draws).
  // box3d (like THREE) applies quaternions in the textbook right-handed sense,
  // where a +Y rotation by ψ sends +X to (cos ψ, −sin ψ) — so the half-angle must
  // be NEGATED here or every rotated wall/box lands mirrored about its centre
  // (verified against headless box3d ray profiles; scratch yaw-semantics test).
  // The query-world mirror gets the same negation so raycasts agree with contacts.
  const addBody = (c: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; quat?: readonly [number, number, number, number] }): number => {
    const h = ctx.physics.world.createBox({ type: 0, position: [c.x, c.y, c.z], halfExtents: [c.hx, c.hy, c.hz], friction: 0.8 });
    const q: [number, number, number, number] = c.quat
      ? [c.quat[0], c.quat[1], c.quat[2], c.quat[3]]
      : [0, Math.sin(-c.yaw / 2), 0, Math.cos(-c.yaw / 2)];
    ctx.physics.world.setBodyTransform(h, [c.x, c.y, c.z], q);
    ctx.physics.addQuerySolid?.(h, c.quat ? c : { ...c, yaw: -c.yaw }); // raycast query world (same convention fix)
    return h;
  };
  const clearBodies = (e: Entry) => { for (const h of e.bodies) { ctx.physics.removeQuerySolid?.(h); ctx.physics.world.destroyBody(h); } e.bodies.length = 0; e.wallBoxes = []; };
  const disposeInterior = (e: Entry) => {
    if (e.interior) { ctx.scene.remove(e.interior.group); e.interior.dispose(); e.interior = null; }
    for (const h of e.intBodies) { ctx.physics.removeQuerySolid?.(h); ctx.physics.world.destroyBody(h); }
    e.intBodies.length = 0;
    e.intBoxes = [];
  };

  // ---- collider tier (cheap, eager) ------------------------------------------
  // Swap the LOOSE baked collider for tight exact-poly SOLID walls the moment a
  // building is near enough to touch. The baked decomposition overshoots the true
  // footprint by ~2 m (bake-time box-count reduction), but the LOD prism we draw
  // is the exact poly — so in "lod" the car stops short of the visible wall on an
  // invisible box. "coll" removes that gap without paying for the detail mesh.
  //
  // Body creation goes through the host scheduler's "physics" lane: the scan can
  // admit 20 buildings at once, and 20×~7 boxes ×2 worlds of WASM createBox in
  // one frame was a measured hitch. One queued job per building (~14-24 creates,
  // well under a lane budget slice) keeps the swap invisible. The job re-checks
  // state on entry — the building may have left the ring while queued.
  const createSolidWalls = (e: Entry) => {
    schedule("physics", () => {
      if ((e.state !== "coll" && e.state !== "detail") || e.bodies.length) return; // stale/duplicate
      const { boxes } = buildingColliders(e as BuildingSpec, false); // SOLID (no door yet)
      for (const c of boxes) e.bodies.push(addBody(c));
      e.wallBoxes = boxes;
    });
  };
  const ensureExactCollider = (e: Entry) => {
    if (e.state !== "lod") return;
    ctx.tiles.suppressBuilding(e.key, e.i); // baked mesh + loose collider off (R=0)
    e.state = "coll";
    // buildingColliders directly (not generate): colliders only, no throwaway mesh
    createSolidWalls(e);
  };
  const dropExactCollider = (e: Entry) => {
    if (e.state !== "coll") return;
    clearBodies(e);
    // back to LOD: baked mesh hidden (R=1) but the accurate baked collider is live
    ctx.tiles.unsuppressBuilding(e.key, e.i);
    ctx.tiles.suppressBuildingMesh(e.key, e.i);
    e.state = "lod";
  };

  // ---- detail tier -----------------------------------------------------------
  // The grammar mesh (generate()) is the single most expensive synchronous call
  // in the app — 30-100 ms for a dense Victorian, the measured driving hitch.
  // It runs on a WORKER now: the scan posts a request (requestDetail), the reply's
  // typed arrays come back zero-copy, and only the cheap THREE assembly runs on
  // the main thread, through the host's "build" lane. A missing/failed worker
  // falls back to the old synchronous path so the module keeps working anywhere.
  const finishDetail = (e: Entry, b: BuiltGroup) => {
    b.setOpacity(0);
    ctx.scene.add(b.group);
    e.detail = b; e.fade = 0; e.fadeDir = 1;
    ctx.tiles.suppressBuilding(e.key, e.i); // baked mesh + loose collider fully off
    // R6: DON'T open the door gap yet — the detail mesh (with its doorway hole) is
    // still transparent, and the chunk prism behind it is solid, so an open gap now
    // would be a walk-through in front of a solid-looking face. Keep SOLID walls up;
    // openDoorway() swaps in the door-gapped walls once the mesh has fully faded in.
    // Reuse the "coll" solid walls if we came from there (or the queued job that's
    // about to create them); build them from "lod".
    const hadColl = e.state === "coll";
    e.state = "detail";
    if (!hadColl && !e.bodies.length) createSolidWalls(e);
    e.doorPending = true;
  };
  let buildWorker: Worker | null = null;
  const pendingBuilds = new Map<number, Entry>();
  let nextBuildId = 1;
  try {
    buildWorker = new Worker(new URL("./buildWorker.ts", import.meta.url), { type: "module" });
    buildWorker.onmessage = (ev: MessageEvent<{ id: number; meshes: MeshData[] }>) => {
      const { id, meshes } = ev.data;
      const e = pendingBuilds.get(id);
      pendingBuilds.delete(id);
      if (!e || !e.pendingBuild) return; // cancelled while in flight
      // assembly (geometry + materials + bundle) is main-thread but cheap-ish —
      // still, keep it off loaded frames via the build lane, one building per job
      schedule("build", () => {
        e.pendingBuild = false;
        if (e.detail || e.state === "detail" || !loaded.has(e.key)) return; // superseded
        finishDetail(e, assembleBuilding(e as BuildingSpec, meshes, materials));
      });
    };
    buildWorker.onerror = (err) => {
      console.warn("[citygen] build worker failed — falling back to sync builds", err);
      for (const e of pendingBuilds.values()) e.pendingBuild = false;
      pendingBuilds.clear();
      buildWorker = null;
    };
  } catch {
    buildWorker = null;
  }
  // the worker gets a PLAIN spec — Entry carries THREE objects/body handles that
  // must not (and cannot) cross the structured-clone boundary
  const specOf = (e: Entry): BuildingSpec => ({
    i: e.i, id: e.id, poly: e.poly, base: e.base, top: e.top,
    grade: e.grade, frontGround: e.frontGround, h: e.h, archetype: e.archetype, seed: e.seed,
  });
  const requestDetail = (e: Entry) => {
    // sample the live street terrain at the door front ONCE, before the mesh build:
    // the visible stoop steps (frontStoop) and the walkable ramp collider
    // (openDoorway → appendStoop) both read this same number, so steps ⟺ ramp.
    if (e.frontGround === undefined) e.frontGround = frontGroundFor(e);
    if (!buildWorker) {
      finishDetail(e, buildBuilding(e as BuildingSpec, materials)); // sync fallback
      return;
    }
    e.pendingBuild = true;
    const id = nextBuildId++;
    pendingBuilds.set(id, e);
    buildWorker.postMessage({ id, spec: specOf(e) });
  };
  // Live terrain height just outside the street door (for the stoop rise). Recomputes
  // the same street edge + door centre the collider does, then samples the street
  // side TWICE — near the wall (1.3 m out) and near where the stoop ramp's foot
  // would land — taking the LOWER, so on a street that keeps dropping the ramp
  // reaches the real ground instead of leaving its foot floating as a step face.
  // undefined when the edge takes no door (collider skips the stoop).
  const frontGroundFor = (e: Entry): number | undefined => {
    const poly = ensureCCW(e.poly);
    const si = streetEdgeIndex(poly);
    const p0 = poly[si], p1 = poly[(si + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.3) return undefined;
    const grade = e.grade ?? e.base;
    if (!doorEligible({ isStreet: true, length, base: e.base, top: e.top, grade })) return undefined;
    const ux = dx / length, uz = dz / length;
    const nrm = edgeOutwardNormal(p0, p1);           // unit outward (street side)
    const { tc, sill } = doorMetrics(length, e.base, e.top, grade);
    const dC = tc * length;
    const cxd = p0[0] + ux * dC, czd = p0[1] + uz * dC;
    const at = (d: number) => ctx.map.groundHeight(cxd + nrm[0] * d, czd + nrm[1] * d);
    const near = at(1.3);
    const foot = 0.3 + Math.max(0.5, (sill - near) / 0.63); // ≈ ramp run for that rise
    return Math.min(near, at(foot));
  };
  // swap the solid street wall for the door-gapped one — called when the detail mesh
  // is fully opaque, so the visible doorway and the walk-through gap appear together.
  // Passes the live front-terrain height so a downhill door gets a walkable stoop.
  const openDoorway = (e: Entry) => {
    if (!e.doorPending) return;
    e.doorPending = false;
    clearBodies(e);
    // same frontGround the mesh build used → the ramp matches the drawn steps
    const fg = e.frontGround ?? frontGroundFor(e);
    const { boxes } = buildingColliders(e as BuildingSpec, true, fg); // door gap + stoop
    for (const c of boxes) e.bodies.push(addBody(c));
    e.wallBoxes = boxes;
  };
  const dropDetail = (e: Entry) => {
    disposeInterior(e);
    if (e.detail) { ctx.scene.remove(e.detail.group); e.detail.dispose(); e.detail = null; }
    clearBodies(e);
    // back to LOD: baked mesh hidden (R=1) but accurate baked collider live again.
    // If still within collider range the next scan re-swaps it to a tight "coll".
    ctx.tiles.unsuppressBuilding(e.key, e.i);
    ctx.tiles.suppressBuildingMesh(e.key, e.i);
    e.state = "lod"; e.fade = 0; e.fadeDir = 0; e.doorPending = false; e.pendingBuild = false;
  };
  const advanceFades = (dt: number) => {
    for (const cell of loaded.values()) for (const e of cell.entries) {
      if (!e.detail || e.fadeDir === 0) continue;
      e.fade += e.fadeDir * (dt / CT.fadeTime);
      if (e.fadeDir > 0 && e.fade >= 1) { e.fade = 1; e.fadeDir = 0; e.detail.setOpacity(1); openDoorway(e); }
      else if (e.fadeDir < 0 && e.fade <= 0) dropDetail(e);
      else e.detail.setOpacity(e.fade);
    }
  };

  let insideBuilding = false; // set each frame by gateInterior; drives the indoor camera
  // Precise footprint gate. The world AABB is a broad-phase reject only (it's a
  // superset of the real ring — for a lot rotated ~30–45° it overshoots the walls
  // by metres, which is exactly why brushing the sidewalk used to flash an interior
  // in mid-air). Inside the AABB we test the REAL polygon: build/stay-inside within
  // GATE_DILATE of a wall (so a doorway counts), dispose only past GATE_DISPOSE
  // outside (hysteresis → no rebuild flash when you skim a wall).
  const GATE_DILATE = 0.75;   // inside OR within 0.75 m of an edge = "inside" (doorway)
  const GATE_DISPOSE = 3.0;   // dispose only when clearly outside the footprint
  const gateInterior = (e: Entry, p: THREE.Vector3) => {
    if (e.state !== "detail") return; // only faded-in detail buildings have interiors
    // broad-phase: outside the (inflated) AABB by a clear margin → definitely out
    if (p.x < e.bb.minx - 4 || p.x > e.bb.maxx + 4 || p.z < e.bb.minz - 4 || p.z > e.bb.maxz + 4) {
      if (e.interior) disposeInterior(e);
      return;
    }
    const inY = p.y > e.base - 1.5 && p.y < e.top + 1.0;
    const d = signedDistToPoly(e.poly, p.x, p.z); // + inside, − outside (metres)
    const inside = inY && d >= -GATE_DILATE;
    if (inside) insideBuilding = true;
    if (inside && !e.interior && e.bodies.length) {
      const it = buildInterior(e as BuildingSpec, materials);
      ctx.scene.add(it.group);
      for (const c of it.colliders) e.intBodies.push(addBody(c));
      e.intBoxes = it.colliders;
      e.interior = it;
    } else if (e.interior && d < -GATE_DISPOSE) {
      disposeInterior(e);
    }
  };

  // ---- cell load / unload -----------------------------------------------------
  const loadCell = (key: string, entries: Entry[]) => {
    const [ix, iz] = key.split("_").map(Number);
    const cell: CellState = { key, ix, iz, entries,
      // conform LOD chunk buildings to terrain (highest ground under each footprint
      // + a foundation skirt down to the lowest) so hillside windows aren't buried.
      chunk: buildChunkLOD(entries as BuildingSpec[], { groundHeight: (x, z) => ctx.map.groundHeight(x, z) }),
      phase: "building" };
    loaded.set(key, cell);
    building.push(cell);
  };
  const unloadCell = (cell: CellState) => {
    for (const e of cell.entries) {
      if (e.detail || e.state === "detail") dropDetail(e);
      else if (e.state === "coll") dropExactCollider(e);
      e.pendingBuild = false; // orphan any in-flight worker build (reply is dropped)
      ctx.tiles.unsuppressBuildingMesh(e.key, e.i); // restore baked mesh
      e.state = "lod";
    }
    if (cell.chunk?.mesh) ctx.scene.remove(cell.chunk.mesh);
    cell.chunk?.dispose();
    const idx = building.indexOf(cell); if (idx >= 0) building.splice(idx, 1);
    loaded.delete(cell.key);
  };
  // finish a chunk: add its merged mesh + hide the baked MESH for every building
  // in the cell (collider stays live). Atomic swap → no hole while it built.
  const finishChunk = (cell: CellState) => {
    if (cell.chunk?.mesh) ctx.scene.add(cell.chunk.mesh);
    for (const e of cell.entries) if (e.state === "lod") ctx.tiles.suppressBuildingMesh(e.key, e.i);
    cell.phase = "ready";
  };

  // ---- pipeline warmup --------------------------------------------------------
  // Compile every WebGPU pipeline a streamed building will ever need — pooled
  // wall kinds (settled + alphaHash fade variants), glass zones, the chunk-LOD
  // vertex-colour material — by drawing one hidden 2 cm triangle per material,
  // ONE PER FRAME through the background lane. Each addition compiles inside
  // that frame's render, so the cost is a dozen sub-frame compiles at ring boot
  // instead of a hard stall on the first building you drive up to. The warm
  // fade-clones are held (not disposed) so their pipelines stay cached.
  let warmupStarted = false;
  const warmHold: THREE.Material[] = [];
  const startWarmup = (at: THREE.Vector3) => {
    warmupStarted = true;
    const mats = warmupMaterials(materials);
    mats.push(lodMaterial());
    warmHold.push(...mats);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.02, 0, 0, 0, 0.02, 0]), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), 3)); // lodMaterial reads vertex colour
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    const group = new THREE.Group();
    group.position.set(at.x, ctx.map.groundHeight(at.x, at.z) + 0.4, at.z);
    ctx.scene.add(group);
    let i = 0;
    let settle = 0;
    schedule("background", () => {
      if (i < mats.length) {
        const m = new THREE.Mesh(geo, mats[i++]);
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        group.add(m);
        return "again"; // next material next frame — one compile per frame
      }
      if (settle++ < 2) return "again"; // let the last mesh render (+ shadow pass) once
      ctx.scene.remove(group);
      geo.dispose();
    });
  };

  return {
    count: total,
    update(playerPos, dt) {
      if (!warmupStarted) startWarmup(playerPos); // one-shot pipeline warmup rig
      // per-frame: interior gate + detail crossfade + chunk merging
      insideBuilding = false;
      for (const cell of loaded.values()) for (const e of cell.entries) gateInterior(e, playerPos);
      advanceFades(dt);
      if (building.length) {
        const cell = building[0]; // one cell slice per frame (bounded, no hitch)
        cell.chunk!.pump(CHUNK_BUDGET);
        if (cell.chunk!.done) { finishChunk(cell); building.shift(); }
      }

      accum += dt;
      if (accum < SCAN_EVERY) return;
      accum = 0;

      const ptx = Math.floor((playerPos.x - minX) / tile);
      const ptz = Math.floor((playerPos.z - minZ) / tile);
      // read the live-tunable knobs fresh each scan (dragging a "/" slider re-tunes now)
      const cellLoad = CT.cellLoad, cellUnload = Math.max(CT.cellUnload, cellLoad + 1);
      const detailR = CT.detailRadius, detailR2 = detailR * detailR;
      const detailExit = detailR + DETAIL_EXIT_MARGIN, detailExit2 = detailExit * detailExit;
      const maxDetail = CT.maxDetail;
      const collR2 = COLLIDER_R * COLLIDER_R, collExit2 = COLLIDER_EXIT * COLLIDER_EXIT;
      // headroom check for the detail budget below — dt is this frame's delta (update()
      // receives it fresh each call), so a hitch this frame caps the next scan right back
      // down; no rolling average kept.
      const detailBudget = dt < 1 / 50 ? DETAIL_BUDGET_FAST : dt < 1 / 30 ? DETAIL_BUDGET_MED : DETAIL_BUDGET_SLOW;

      // unload cells beyond the ring
      for (const cell of [...loaded.values()]) {
        if (Math.abs(cell.ix - ptx) > cellUnload || Math.abs(cell.iz - ptz) > cellUnload) unloadCell(cell);
      }
      // load cells in range
      for (let cx = ptx - cellLoad; cx <= ptx + cellLoad; cx++) {
        for (let cz = ptz - cellLoad; cz <= ptz + cellLoad; cz++) {
          const key = `${cx}_${cz}`;
          if (loaded.has(key)) continue;
          const entries = cellEntries.get(key);
          if (entries) loadCell(key, entries);
        }
      }

      // two tiers within detailR: the nearest-N get the full grammar MESH (budgeted,
      // expensive); everyone else in range gets a tight exact-poly COLLIDER (cheap)
      // so the car never hits the loose baked box on a building drawn as its prism.
      //
      // Slots are a true nearest-N, not first-come. A wide detailRadius can cover
      // hundreds of buildings; without eviction the cap fills with far ones and
      // nearby façades stay as chunk prisms forever (and raising maxDetail only
      // helps after a long drive frees slots). Rank everyone in range, keep the
      // closest maxDetail, fade the rest. Fading-out holders do NOT count toward
      // the cap, so a nearer candidate can start building while the far one fades.
      const candidates: [Entry, number][] = [];
      const haveDetail: [Entry, number][] = [];
      const wantColl: [Entry, number][] = [];
      for (const cell of loaded.values()) {
        if (cell.phase !== "ready") continue;
        for (const e of cell.entries) {
          const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
          const d2 = dx * dx + dz * dz;
          if (e.detail) {
            haveDetail.push([e, d2]);
          } else if (d2 < detailR2) {
            candidates.push([e, d2]);
          }
          if (!e.detail) {
            if (e.state === "lod") { if (d2 < collR2) wantColl.push([e, d2]); }
            else if (e.state === "coll" && d2 > collExit2) dropExactCollider(e);
          }
        }
      }

      // Rank holders + candidates by distance; nearest maxDetail earn/keep a slot.
      // Holders past detailExit are ranked but never kept (they must leave).
      const ranked = haveDetail.concat(candidates);
      ranked.sort((a, b) => a[1] - b[1]);
      const keep = new Set<Entry>();
      for (const [e, d2] of ranked) {
        if (keep.size >= maxDetail) break;
        if (d2 > detailExit2) continue;
        if (d2 > detailR2 && !e.detail) continue; // candidates need the entry band
        keep.add(e);
      }
      // Drive fade direction from keep membership (not a separate distance hysteresis
      // that would fight eviction and flicker opacity every scan).
      for (const [e, d2] of haveDetail) {
        if (keep.has(e)) {
          if (e.fadeDir < 0) e.fadeDir = 1; // reclaimed a slot → fade back in
        } else if (d2 > detailExit2) {
          dropDetail(e); // past hard exit — free the slot now
        } else if (e.fadeDir >= 0) {
          e.fadeDir = -1; // displaced by nearer / over cap — crossfade out
        }
      }
      // Active (not fading-out) detail count — fading holders don't block new
      // builds; in-flight worker requests DO count so a fast scan cadence can't
      // over-request past the cap while replies are pending.
      let detailCount = 0;
      for (const cell of loaded.values()) {
        for (const e of cell.entries) if ((e.detail && e.fadeDir >= 0) || e.pendingBuild) detailCount++;
      }
      let db = detailBudget;
      for (const [e] of ranked) {
        if (db <= 0 || detailCount >= maxDetail) break;
        if (!keep.has(e) || e.detail || e.pendingBuild) continue;
        requestDetail(e); db--; detailCount++;
      }
      // then tighten the nearest still-loose colliders (cheap; guard skips any that
      // just upgraded to detail this scan)
      wantColl.sort((a, b) => a[1] - b[1]);
      let cb = COLLIDER_BUDGET;
      for (const [e] of wantColl) { if (cb <= 0) break; if (e.state !== "lod") continue; ensureExactCollider(e); cb--; }
    },
    dispose() {
      buildWorker?.terminate();
      buildWorker = null;
      pendingBuilds.clear();
      for (const cell of [...loaded.values()]) unloadCell(cell);
      loaded.clear();
      building.length = 0;
    },
    stats() {
      let buildings = 0, detail = 0, interiors = 0;
      for (const cell of loaded.values()) { buildings += cell.entries.length; for (const e of cell.entries) { if (e.detail) detail++; if (e.interior) interiors++; } }
      return { total, cells: loaded.size, buildings, detail, interiors };
    },
    isPlayerInside() { return insideBuilding; },
    debugBuildings() {
      const out: { cx: number; cz: number; base: number; top: number; interior: boolean; bb: { minx: number; maxx: number; minz: number; maxz: number } }[] = [];
      for (const cell of loaded.values()) for (const e of cell.entries) if (e.detail) out.push({ cx: e.cx, cz: e.cz, base: e.base, top: e.top, interior: !!e.interior, bb: { ...e.bb } });
      return out;
    },
    debugColliders(walls, interiors) {
      walls.length = 0; interiors.length = 0;
      for (const cell of loaded.values()) for (const e of cell.entries) {
        for (const c of e.wallBoxes) walls.push(c);
        for (const c of e.intBoxes) interiors.push(c);
      }
    },
    debugDoors() {
      const out: CityGenDoorProbe[] = [];
      for (const cell of loaded.values()) for (const e of cell.entries) {
        if (!e.detail) continue;
        const poly = ensureCCW(e.poly);
        const si = streetEdgeIndex(poly);
        const p0 = poly[si], p1 = poly[(si + 1) % poly.length];
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
        const length = Math.hypot(dx, dz);
        const grade = e.grade ?? e.base;
        if (!doorEligible({ isStreet: true, length, base: e.base, top: e.top, grade })) continue;
        const ux = dx / length, uz = dz / length;
        const nrm = edgeOutwardNormal(p0, p1);     // unit outward (x,z)
        const { tc, halfW, sill, openTop } = doorMetrics(length, e.base, e.top, grade);
        const dC = tc * length;                    // metres from p0 to door centre
        out.push({
          archetype: e.archetype,
          center: [p0[0] + ux * dC, sill, p0[1] + uz * dC],
          inward: [-nrm[0], 0, -nrm[1]],
          along: [ux, 0, uz],
          dcenter: dC,
          sill, openTop, halfW, base: e.base, grade, top: e.top, length,
          open: !e.doorPending,
          fg: e.frontGround, nRamp: e.wallBoxes.reduce((n, b) => n + (b.quat ? 1 : 0), 0),
          bb: { ...e.bb },
        });
      }
      return out;
    },
  };
}
