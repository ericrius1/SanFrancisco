// Citywide CityGen streaming ring — CHUNKED LOD + own crossfade, no baked fabric.
//
// The whole visible city is OURS. Buildings are grouped by tile cell; each cell
// within view is baked into ONE merged LOD chunk (render/chunkLod.ts) — a couple
// dozen draw calls for the entire skyline. The baked OSM mesh is hidden across
// every loaded cell (mesh-only suppression: R=1, so the ACCURATE baked collider
// stays live and catches cars/players via the multi-anchor physics — no oversized
// proxy box). As you approach a building (DETAIL_R) its full grammar mesh dithers
// in OVER the chunk prism (an all-ours crossfade), its baked collider is swapped
// for per-edge walk-in walls with a CLOSED street door (E toggles it — nearestDoor/
// toggleDoor), and the lazy interior gates on being inside.
//
// Everything is STATIC: world-space geometry, matrixAutoUpdate off, Static bodies.
// Nothing is destructible — buildings don't break; a crash just stops you.
import * as THREE from "three/webgpu";
import { buildingColliders, doorMetrics, doorEligible, stoopColliders } from "../core/collider";
import { ensureCCW, streetEdgeIndex, edgeOutwardNormal, signedDistToPoly } from "../core/footprint";
import { buildBuilding, buildInterior, assembleBuilding, warmupMaterials } from "../render";
import { buildChunkLOD, type ChunkLOD } from "../render/chunkLod";
import { lodMaterial } from "../render/lod";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec, ColliderBox, MeshData } from "../core/types";
import { CITYGEN_TUNING, CONFIG } from "../../../config";

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
// Player-operated doors (E → toggleDoor). Doors start CLOSED (solid walls + the
// grammar's baked leaf); opening hides the baked leaf, swings a dynamic twin
// inward on the hinge, and swaps in the door-gapped colliders.
const DOOR_RANGE = 8;        // nearestDoor scan radius (m)
const DOOR_SWING = 1.95;     // open leaf angle (rad, swung INTO the building)
const DOOR_SWING_TIME = 0.45;// swing duration (s), ease-out
const DOOR_LEAF_T = 0.06;    // leaf thickness (m) — matches the grammar-authored leaf

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
  // detail tier: true = the street door is CLOSED — SOLID walls live, the baked
  // leaf drawn in the doorway. Doors are PLAYER-OPERATED (E → toggleDoor): the old
  // fade-end auto-open is gone. Set on materialization and by a finished close;
  // cleared by openDoorway() when toggleDoor swings the leaf open.
  doorPending: boolean;
  // lazily-computed door runtime (world-space metrics cached once per entry +
  // swing animation state). undefined = never computed, null = edge takes no door.
  door?: DoorRt | null;
  // a grammar-build request is in flight on the worker (counts against the
  // detail cap; cleared on assemble, displacement is handled by normal eviction)
  pendingBuild: boolean;
}

/** Per-door runtime: world-space metrics cached ONCE per entry (the footprint is
 *  static, so ensureCCW/doorMetrics never run twice for a building) + the swing
 *  animation / dynamic-leaf state. The id is a stable session-wide handle. */
interface DoorRt {
  id: number;
  cx: number; cz: number;        // door centre on the street edge (world XZ)
  sill: number; openTop: number; halfW: number;
  hx: number; hz: number;        // hinge point (edge of the opening, dC − halfW along)
  baseYaw: number;               // leaf group yaw when CLOSED (leaf lies in the wall plane)
  w: number; h: number;          // leaf dimensions (match the grammar-authored baked leaf)
  // swing animation (advanced by ring.update while on the active list)
  swing: number;                 // current angle, 0 = closed .. DOOR_SWING = open
  from: number; to: number; t: number;
  animating: boolean;
  needSolid: boolean;            // close finished but the solid-wall swap is deferred (player in gap)
  leaf: THREE.Group | null;      // dynamic hinged leaf (lives OUTSIDE the bundle)
  leafGeo: THREE.BufferGeometry | null;
  bakedLeaf: THREE.Mesh | null;  // the bundle's merged "citygen.doorleaf" mesh
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
  /** true while the door is OPEN (player toggled it — walk-through gap + stoop
   *  colliders live); false = closed (solid walls, baked leaf drawn) */
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
  /** DEBUG/probe: streaming state of every entry within r metres of (x,z). */
  debugEntriesNear(x: number, z: number, r: number): { i: number; d: number; state: string; bodies: number; pendingBuild: boolean; insideBB: boolean }[];
  /** DEBUG/probe: world-space door frames for every faded-in detail building. */
  debugDoors(): CityGenDoorProbe[];
  /** Nearest operable street door within ~8 m of pos (fully faded-in detail
   *  buildings only), or null. Alloc-light: per-entry door metrics are cached on
   *  first sight (no repeated ensureCCW/doorMetrics) and the scan allocates
   *  nothing — one small result object only when a door is in range.
   *  `open` = the walk-through gap is live (door open or mid-swing);
   *  `id` = stable handle for toggleDoor. */
  nearestDoor(pos: { x: number; y: number; z: number }): { x: number; z: number; sill: number; dist: number; open: boolean; id: number } | null;
  /** Open/close a door by handle. Opening swaps in the door-gapped colliders
   *  (+ stoop ramp) and swings a dynamic leaf inward over ~0.45 s; closing
   *  reverses the swing, then restores the SOLID walls and the baked leaf.
   *  "blocked" = refused — the player is standing in the doorway (never wall
   *  someone in). "gone" = the building is no longer a faded-in detail mesh. */
  toggleDoor(id: number): "opened" | "closed" | "blocked" | "gone";
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
  // The swap MUST be atomic per building: suppressBuilding() kills the baked
  // collider the moment it runs, so it may only run in the same job (= same
  // frame) that creates the exact walls. The regression this guards against:
  // suppress at enqueue + walls queued frames later left a no-collider hole —
  // a car nosed into the lot edge, then the walls materialized AROUND it and
  // wedged it inside static boxes (repro: 8 stuck events/min in the Castro).
  //
  // Body creation still goes through the host scheduler's "physics" lane: the
  // scan can admit 20 buildings at once, and 20×~7 boxes ×2 worlds of WASM
  // createBox in one frame was a measured hitch. One queued job per building
  // (~14-24 creates, well under a lane budget slice) keeps the swap invisible.
  // The job re-checks state on entry — the building may have left the ring
  // while queued (drop/unload flip state back to "lod" → job is a no-op).
  // Stoop bodies (landing + ramp) appended to whatever wall set is live. The
  // DETAIL tier draws the stoop steps, so its collider set must make them
  // tangible in BOTH door states — the door toggle then swaps only the wall
  // gap, never the floor underfoot (review R1: a ramp appearing only on open
  // could spawn under a standing player; one removed on close dropped them down
  // the hillside frontage). The coll tier stays stoop-free: its mesh is the
  // plain LOD prism with NO drawn steps, and an invisible ramp in the street is
  // exactly the obstacle class the ground-source fix just eliminated.
  const appendStoopNow = (e: Entry) => {
    if (e.frontGround === undefined) e.frontGround = frontGroundFor(e);
    for (const c of stoopColliders(e as BuildingSpec, e.frontGround)) {
      e.bodies.push(addBody(c));
      e.wallBoxes.push(c);
    }
  };
  const buildSolidWallsNow = (e: Entry, withStoop = false) => {
    const { boxes } = buildingColliders(e as BuildingSpec, false); // SOLID (no door gap)
    for (const c of boxes) e.bodies.push(addBody(c));
    e.wallBoxes = boxes;
    if (withStoop) appendStoopNow(e);
  };
  // Player XZ inside the footprint AABB (+margin) at building height → walls must
  // NEVER materialize this frame (they'd spawn around/inside the player = wedge);
  // the coll job defers with "again" until the player clears the lot.
  const lastPlayer = new THREE.Vector3();
  const playerInsideBB = (e: Entry, margin: number) =>
    lastPlayer.x > e.bb.minx - margin && lastPlayer.x < e.bb.maxx + margin &&
    lastPlayer.z > e.bb.minz - margin && lastPlayer.z < e.bb.maxz + margin &&
    lastPlayer.y > e.base - 5 && lastPlayer.y < e.top + 5;
  const ensureExactCollider = (e: Entry) => {
    if (e.state !== "lod") return;
    // "coll" now = in-flight marker; the baked collider stays LIVE until the job
    // runs. dropExactCollider on a still-queued entry stays safe: clearBodies is
    // a no-op on empty, and unsuppressing a never-suppressed building is just an
    // idempotent alive-texel write + onBuildingAlive(true) re-fire (tiles.ts).
    e.state = "coll";
    schedule("physics", () => {
      if (e.state !== "coll" || e.bodies.length) return; // stale/duplicate (dropped, unloaded, or upgraded to detail)
      if (playerInsideBB(e, 3.5)) return "again";        // anti-wedge: retry next frame
      // ATOMIC: baked collider off (R=0) + exact walls on, in this same frame
      ctx.tiles.suppressBuilding(e.key, e.i);
      buildSolidWallsNow(e);
    });
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
    // R6: DON'T open the door gap — the walls stay SOLID after fade-in too, because
    // doors are now player-operated: they materialize CLOSED (doorPending=true) and
    // only toggleDoor → openDoorway() swaps in the door-gapped walls.
    // Reuse the "coll" solid walls if we came from there; otherwise (from "lod", or
    // "coll" whose queued job hasn't run) build them SYNCHRONOUSLY — the suppress
    // above just killed the baked collider, so the walls should land this same
    // frame (no collider hole). Detail builds are capped at 1-3 per scan, so this
    // inline burst is ~30-60 createBox worst case — sub-ms, unlike the 20-per-scan
    // coll tier which stays on the physics lane.
    // EXCEPT anti-wedge: if the player is inside the footprint AABB right now
    // (e.g. a car driving across the lot while the worker build landed), walls
    // materializing this frame would spawn AROUND the car and wedge it — the same
    // failure the coll job's playerInsideBB guard prevents. Defer to a "physics"
    // job that retries ("again") until the player clears the lot. The baked
    // collider is already suppressed above, so this leaves a temporary collider
    // hole while the player is inside — acceptable, strictly better than wedging.
    e.state = "detail";
    if (!e.bodies.length) {
      if (!playerInsideBB(e, 3.5)) buildSolidWallsNow(e, true);
      else schedule("physics", () => {
        if (e.state !== "detail" || e.bodies.length) return; // stale/duplicate (dropped, unloaded, or walls landed elsewhere)
        if (playerInsideBB(e, 3.5)) return "again";          // anti-wedge: retry next frame
        buildSolidWallsNow(e, true);
      });
    } else {
      // coll→detail reuse: the walls stand, but the newly-drawn steps need bodies
      appendStoopNow(e);
    }
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
        // stale reply: the player has driven well past this building while the
        // worker chewed — materializing it now would just fade in and back out
        const sdx = e.cx - lastPlayer.x, sdz = e.cz - lastPlayer.z;
        const staleR = CT.detailRadius + 40;
        if (sdx * sdx + sdz * sdz > staleR * staleR) return;
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
  // swap the solid street wall for the door-gapped one — called by toggleDoor when
  // the player OPENS the door, so the swinging leaf and the walk-through gap appear
  // together. Passes the live front-terrain height so a downhill door gets a
  // walkable stoop.
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

  // ---- player-operated doors ---------------------------------------------------
  // Doors are CLOSED by default (solid walls + the grammar's baked leaf mesh, its
  // own "citygen.doorleaf" bucket). E → toggleDoor: opening hides the baked leaf
  // (one bundle re-record), swaps in the door-gapped colliders (openDoorway), and
  // swings a dynamic twin leaf inward on the hinge; closing reverses, restores the
  // SOLID walls, and re-shows the baked leaf. The dynamic leaf lives in doorRoot
  // (OUTSIDE the BundleGroup) so its per-frame rotation never re-records a bundle.
  const doorRoot = new THREE.Group();
  doorRoot.name = "cityGenDoors";
  ctx.scene.add(doorRoot);
  const doorRegistry = new Map<number, Entry>(); // stable id → entry
  let nextDoorId = 1;
  const activeDoors: Entry[] = []; // doors animating or awaiting a deferred wall swap
  const markDoorActive = (e: Entry) => { if (!activeDoors.includes(e)) activeDoors.push(e); };
  // Compute-once world door metrics (same math as debugDoors / core's collider —
  // doorMetrics is the single source of truth, so leaf ⟺ gap ⟺ baked leaf line up).
  const doorRtOf = (e: Entry): DoorRt | null => {
    if (e.door !== undefined) return e.door;
    const poly = ensureCCW(e.poly);
    const si = streetEdgeIndex(poly);
    const p0 = poly[si], p1 = poly[(si + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const length = Math.hypot(dx, dz);
    const grade = e.grade ?? e.base;
    if (length < 0.3 || !doorEligible({ isStreet: true, length, base: e.base, top: e.top, grade })) {
      e.door = null;
      return null;
    }
    const ux = dx / length, uz = dz / length;
    const { tc, halfW, sill, openTop } = doorMetrics(length, e.base, e.top, grade);
    const dC = tc * length;
    const rt: DoorRt = {
      id: nextDoorId++,
      cx: p0[0] + ux * dC, cz: p0[1] + uz * dC,
      sill, openTop, halfW,
      // hinge at the dC − halfW edge of the opening (grammar authors the baked
      // leaf against this same edge, so the dynamic twin pivots where it should)
      hx: p0[0] + ux * (dC - halfW), hz: p0[1] + uz * (dC - halfW),
      // group yaw mapping local +X → the edge direction u: THREE's +Y rotation by
      // θ sends +X to (cos θ, 0, −sin θ), so θ = atan2(−uz, ux). This is a plain
      // THREE Object3D rotation — the box3d addBody half-angle negation gotcha
      // (see addBody above) does NOT apply here; no physics body is created.
      baseYaw: Math.atan2(-uz, ux),
      w: 2 * halfW * 0.96, h: (openTop - sill) - 0.04,
      swing: 0, from: 0, to: 0, t: 1, animating: false, needSolid: false,
      leaf: null, leafGeo: null, bakedLeaf: null,
    };
    e.door = rt;
    doorRegistry.set(rt.id, e);
    return rt;
  };
  // player standing in the doorway volume (XZ disc around the door centre between
  // sill and head) — closing now would rebuild a wall around them (wedge)
  const playerInGap = (rt: DoorRt): boolean => {
    const dx = lastPlayer.x - rt.cx, dz = lastPlayer.z - rt.cz;
    const r = rt.halfW + 0.4;
    return dx * dx + dz * dz < r * r && lastPlayer.y > rt.sill - 0.5 && lastPlayer.y < rt.openTop;
  };
  const retargetSwing = (rt: DoorRt, to: number) => { rt.from = rt.swing; rt.to = to; rt.t = 0; rt.animating = true; };
  // spawn the dynamic hinged leaf + hide the baked one (one bundle re-record).
  // SWING SIGN: rotating a vector by +φ about +Y sends the edge direction u to the
  // OUTWARD normal (u=(ux,uz) → (uz,−ux) = edgeOutwardNormal) — so the INWARD
  // swing is the NEGATIVE delta: rotation.y = baseYaw − swing (verified with edge
  // u=+X → street at −Z: baseYaw 0, swing π/2 points the leaf at +Z = inward).
  const spawnLeaf = (e: Entry, rt: DoorRt) => {
    const bundle = e.detail!.group as THREE.BundleGroup;
    let baked: THREE.Mesh | null = null;
    for (const ch of bundle.children) if (ch.name === "citygen.doorleaf") { baked = ch as THREE.Mesh; break; }
    if (baked) { baked.visible = false; bundle.needsUpdate = true; }
    rt.bakedLeaf = baked;
    // SAME shared material instance as the baked leaf (settled at fade≥1) → no new
    // pipeline, and it must never be disposed with the leaf
    const mat = (baked?.material as THREE.Material | undefined) ?? materials["citygen.doorleaf"] ?? materials["citygen.door"];
    const geo = new THREE.BoxGeometry(rt.w, rt.h, DOOR_LEAF_T);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(rt.w / 2, 0.02 + rt.h / 2, 0); // left box edge ON the hinge axis
    const leaf = new THREE.Group();
    leaf.add(mesh);
    // sit the hinge where the detail mesh actually drew the doorway: the bundle is
    // scaled ~0.6% proud of the true footprint (z-fight offset in assembleBuilding),
    // so run the true-world hinge through its matrix — no cm-pop at leaf swap.
    leaf.position.set(rt.hx, rt.sill, rt.hz).applyMatrix4(bundle.matrix);
    leaf.rotation.y = rt.baseYaw - rt.swing;
    doorRoot.add(leaf);
    rt.leaf = leaf;
    rt.leafGeo = geo;
  };
  const disposeLeaf = (rt: DoorRt) => {
    if (rt.leaf) doorRoot.remove(rt.leaf);
    rt.leafGeo?.dispose(); // geometry only — the material is SHARED, never disposed here
    rt.leaf = null;
    rt.leafGeo = null;
  };
  // door-gapped walls out, SOLID walls back in — ATOMIC (same frame), and never
  // while the player occupies the gap (anti-wedge, same convention as the coll
  // tier's playerInsideBB guard: retried from update() via needSolid).
  const trySolidify = (e: Entry, rt: DoorRt) => {
    if (e.state !== "detail") { rt.needSolid = false; return; } // dropped — dropDetail owns the bodies
    if (playerInGap(rt)) { rt.needSolid = true; return; }
    rt.needSolid = false;
    clearBodies(e);
    buildSolidWallsNow(e, true); // detail tier: steps stay tangible across the swap
  };
  // leaf reached the frame: logically closed — restore the baked leaf + solid walls
  const finishClose = (e: Entry, rt: DoorRt) => {
    e.doorPending = true;
    if (rt.bakedLeaf && e.detail) { rt.bakedLeaf.visible = true; (e.detail.group as THREE.BundleGroup).needsUpdate = true; }
    disposeLeaf(rt);
    trySolidify(e, rt);
    if (rt.needSolid) markDoorActive(e); // keep retrying the wall swap
  };
  // instant close (no animation) — fade-out path: the baked leaf must dither away
  // with the bundle, and no dynamic leaf may outlive the detail mesh
  const closeDoorNow = (e: Entry) => {
    const rt = e.door;
    if (!rt) return;
    rt.animating = false;
    rt.swing = 0; rt.from = 0; rt.to = 0; rt.t = 1;
    finishClose(e, rt);
  };
  // full reset on dropDetail/unload: dynamic leaf gone, bookkeeping cleared
  const resetDoorRt = (e: Entry) => {
    const rt = e.door;
    if (!rt) return;
    disposeLeaf(rt);
    if (rt.bakedLeaf) { rt.bakedLeaf.visible = true; rt.bakedLeaf = null; } // group is being disposed; restore for tidiness
    rt.swing = 0; rt.from = 0; rt.to = 0; rt.t = 1;
    rt.animating = false;
    rt.needSolid = false;
    const idx = activeDoors.indexOf(e);
    if (idx >= 0) activeDoors.splice(idx, 1);
  };

  const dropDetail = (e: Entry) => {
    resetDoorRt(e); // dynamic leaf + door bookkeeping first (leaf must not outlive the mesh)
    disposeInterior(e);
    if (e.detail) { ctx.scene.remove(e.detail.group); e.detail.dispose(); e.detail = null; }
    clearBodies(e);
    // back to LOD: baked mesh hidden (R=1) but accurate baked collider live again.
    // If still within collider range the next scan re-swaps it to a tight "coll".
    ctx.tiles.unsuppressBuilding(e.key, e.i);
    ctx.tiles.suppressBuildingMesh(e.key, e.i);
    e.state = "lod"; e.fade = 0; e.fadeDir = 0; e.doorPending = true; e.pendingBuild = false;
  };
  const advanceFades = (dt: number) => {
    for (const cell of loaded.values()) for (const e of cell.entries) {
      if (!e.detail || e.fadeDir === 0) continue;
      // fading out with the door open/mid-swing → snap it shut first, so the baked
      // leaf dithers away with the bundle and the walls settle back to solid
      if (e.fadeDir < 0 && !e.doorPending) closeDoorNow(e);
      e.fade += e.fadeDir * (dt / CT.fadeTime);
      // at fade end the door stays CLOSED (solid walls) — the player opens it with E
      if (e.fadeDir > 0 && e.fade >= 1) { e.fade = 1; e.fadeDir = 0; e.detail.setOpacity(1); }
      else if (e.fadeDir < 0 && e.fade <= 0) dropDetail(e);
      else e.detail.setOpacity(e.fade);
    }
  };
  // advance swinging doors + retry deferred wall swaps; drop settled doors from
  // the active list (a resting OPEN door costs nothing per frame)
  const advanceDoors = (dt: number) => {
    for (let i = activeDoors.length - 1; i >= 0; i--) {
      const e = activeDoors[i];
      const rt = e.door;
      if (!rt) { activeDoors.splice(i, 1); continue; }
      if (rt.animating) {
        rt.t = Math.min(1, rt.t + dt / DOOR_SWING_TIME);
        const k = 1 - (1 - rt.t) ** 3; // ease-out cubic
        rt.swing = rt.from + (rt.to - rt.from) * k;
        if (rt.leaf) rt.leaf.rotation.y = rt.baseYaw - rt.swing;
        if (rt.t >= 1) {
          rt.animating = false;
          rt.swing = rt.to;
          if (rt.to === 0) finishClose(e, rt);
        }
      }
      if (!rt.animating && rt.needSolid) trySolidify(e, rt); // player was in the gap — retry
      if (!rt.animating && !rt.needSolid) activeDoors.splice(i, 1);
    }
  };

  // Retain the specific building that owns the indoor camera. Entry uses the
  // tight doorway threshold; exit gets a wider threshold so tiny signed-distance
  // changes at a door cannot repeatedly reverse a camera transition.
  let insideBuilding: Entry | null = null;
  // Precise footprint gate. The world AABB is a broad-phase reject only (it's a
  // superset of the real ring — for a lot rotated ~30–45° it overshoots the walls
  // by metres, which is exactly why brushing the sidewalk used to flash an interior
  // in mid-air). Inside the AABB we test the REAL polygon: build/stay-inside within
  // GATE_DILATE of a wall (so a doorway counts), dispose only past GATE_DISPOSE
  // outside (hysteresis → no rebuild flash when you skim a wall).
  const GATE_DILATE = 0.75;   // inside OR within 0.75 m of an edge = "inside" (doorway)
  const CAMERA_EXIT = 1.4;    // stay in FPS until clearly through the doorway
  const GATE_DISPOSE = 3.0;   // dispose only when clearly outside the footprint
  const gateInterior = (e: Entry, p: THREE.Vector3, wasCameraInside: boolean) => {
    if (e.state !== "detail") return; // only faded-in detail buildings have interiors
    // broad-phase: outside the (inflated) AABB by a clear margin → definitely out
    if (p.x < e.bb.minx - 4 || p.x > e.bb.maxx + 4 || p.z < e.bb.minz - 4 || p.z > e.bb.maxz + 4) {
      if (e.interior) disposeInterior(e);
      return;
    }
    const inY = p.y > e.base - 1.5 && p.y < e.top + 1.0;
    const d = signedDistToPoly(e.poly, p.x, p.z); // + inside, − outside (metres)
    const inside = inY && d >= -GATE_DILATE;
    const cameraInside = inY && d >= -(wasCameraInside ? CAMERA_EXIT : GATE_DILATE);
    if (cameraInside) insideBuilding = e;
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
      lastPlayer.copy(playerPos); // read by queued coll jobs (anti-wedge) + stale-build check
      if (!warmupStarted) startWarmup(playerPos); // one-shot pipeline warmup rig
      // per-frame: interior gate + detail crossfade + chunk merging
      const previousInside = insideBuilding;
      insideBuilding = null;
      for (const cell of loaded.values()) for (const e of cell.entries) gateInterior(e, playerPos, e === previousInside);
      advanceFades(dt);
      advanceDoors(dt);
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
      // read the live-tunable knobs fresh each scan (dragging a "/" slider re-tunes now).
      // chunk reach follows the master draw-distance slider (not its own knob): whole
      // cells inside the tile radius, never below the ±1 the near detail band needs.
      // unload one cell further out — the same hysteresis the old sliders defaulted to.
      const cellLoad = Math.max(1, Math.floor(CONFIG.tileLoadRadius / tile));
      const cellUnload = cellLoad + 1;
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
      for (const cell of [...loaded.values()]) unloadCell(cell); // → dropDetail → resetDoorRt per entry
      loaded.clear();
      building.length = 0;
      activeDoors.length = 0;
      doorRegistry.clear();
      ctx.scene.remove(doorRoot);
    },
    stats() {
      let buildings = 0, detail = 0, interiors = 0;
      for (const cell of loaded.values()) { buildings += cell.entries.length; for (const e of cell.entries) { if (e.detail) detail++; if (e.interior) interiors++; } }
      return { total, cells: loaded.size, buildings, detail, interiors };
    },
    isPlayerInside() { return insideBuilding !== null; },
    debugBuildings() {
      const out: { cx: number; cz: number; base: number; top: number; interior: boolean; bb: { minx: number; maxx: number; minz: number; maxz: number } }[] = [];
      for (const cell of loaded.values()) for (const e of cell.entries) if (e.detail) out.push({ cx: e.cx, cz: e.cz, base: e.base, top: e.top, interior: !!e.interior, bb: { ...e.bb } });
      return out;
    },
    debugEntriesNear(x, z, r) {
      const out: { i: number; d: number; state: string; bodies: number; pendingBuild: boolean; insideBB: boolean }[] = [];
      const r2 = r * r;
      for (const cell of loaded.values()) for (const e of cell.entries) {
        const dx = x - e.cx, dz = z - e.cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        out.push({ i: e.i, d: Math.round(Math.sqrt(d2) * 10) / 10, state: e.state, bodies: e.bodies.length,
          pendingBuild: e.pendingBuild,
          insideBB: x > e.bb.minx - 1 && x < e.bb.maxx + 1 && z > e.bb.minz - 1 && z < e.bb.maxz + 1 });
      }
      out.sort((a, b) => a.d - b.d);
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
    nearestDoor(pos) {
      let bestE: Entry | null = null;
      let bestRt: DoorRt | null = null;
      let bestD2 = DOOR_RANGE * DOOR_RANGE;
      for (const cell of loaded.values()) for (const e of cell.entries) {
        if (!e.detail || e.state !== "detail" || e.fade < 1) continue; // operable = fully faded in
        // cheap AABB reject before touching the cached (or computing the first) metrics
        if (pos.x < e.bb.minx - DOOR_RANGE - 2 || pos.x > e.bb.maxx + DOOR_RANGE + 2 ||
            pos.z < e.bb.minz - DOOR_RANGE - 2 || pos.z > e.bb.maxz + DOOR_RANGE + 2) continue;
        const rt = doorRtOf(e);
        if (!rt) continue;
        if (pos.y < rt.sill - 3 || pos.y > rt.openTop + 3) continue; // street-level approaches only
        const dx = pos.x - rt.cx, dz = pos.z - rt.cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestE = e; bestRt = rt; }
      }
      if (!bestE || !bestRt) return null;
      return { x: bestRt.cx, z: bestRt.cz, sill: bestRt.sill, dist: Math.sqrt(bestD2), open: !bestE.doorPending, id: bestRt.id };
    },
    toggleDoor(id) {
      const e = doorRegistry.get(id);
      const rt = e?.door;
      if (!e || !rt || !e.detail || e.state !== "detail" || e.fade < 1) return "gone";
      if (e.doorPending) {
        // CLOSED → open. Anti-wedge guard: if the solid walls never materialized
        // (finishDetail deferred them — player inside the footprint), cutting the
        // gapped set now would spawn walls around the player.
        if (!e.bodies.length && playerInsideBB(e, 3.5)) return "blocked";
        rt.needSolid = false;       // cancel any deferred solid swap — we're going gapped
        openDoorway(e);             // ATOMIC: solid walls out, door gap + stoop in (this frame)
        if (!rt.leaf) spawnLeaf(e, rt);
        retargetSwing(rt, DOOR_SWING);
        markDoorActive(e);
        return "opened";
      }
      if (rt.animating && rt.to === 0) {
        // mid-close → swing back open (colliders still gapped, leaf still live)
        retargetSwing(rt, DOOR_SWING);
        markDoorActive(e);
        return "opened";
      }
      // OPEN (or opening) → close; refused while the player stands in the gap
      if (playerInGap(rt)) return "blocked";
      retargetSwing(rt, 0);
      markDoorActive(e);
      return "closed";
    },
  };
}
