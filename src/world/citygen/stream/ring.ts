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
import { buildingColliders, doorMetrics, doorEligible, roofColliderMesh, STOOP_MAX_RISE, stoopColliders } from "../core/collider";
import { ensureCCW, streetEdgeIndex, edgeOutwardNormal, signedDistToPoly } from "../core/footprint";
import { buildInterior, assembleBuilding } from "../render";
import { buildChunkLOD, createChunkLODBeautyWarmup, type ChunkLOD } from "../render/chunkLod";
import { createModuleLayer } from "../render/moduleLayer";
import { createShellBatchLayer } from "../render/shellBatch";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec, ColliderBox, ColliderMesh, MeshData, ModuleInstance } from "../core/types";
import { CITYGEN_TUNING, CONFIG } from "../../../config";
import { enableShadowLayer, SHADOW_LAYERS } from "../../shadows/shadowLayers";
import {
  aabbDistance2,
  compareDetailAdmission,
  footprintSurfaceDistance2,
  shouldAdmitNewDetail,
} from "./detailAdmission";
import type { CityGridIngestReply, PackedCityGrid } from "./ingestTypes";
import { frontGate, type FrontGateHandle } from "../../../render/frontGate";

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
// The grammar worker is deliberately single-threaded and one building can take
// 30-100 ms. Keep scheduler preparation, queued work, worker generation and
// main-thread assembly under one bounded reservation set. Only ONE request is
// ever posted into the worker's inaccessible FIFO; the other prepared requests
// stay in a nearest-current-first main-thread queue, where a relocation can drop
// them before they consume worker time. Thus a cut can wait behind at most the
// one pure generation already executing, without reducing steady throughput.
const DETAIL_BUILD_BACKLOG_MAX = 6;
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
// Facade-area admission budget (Σ perimeter·storeys over the kept detail set).
// maxDetail counts BUILDINGS, but a large-commercial tower costs ~8-10x a
// victorian rowhouse in baked wall/pier triangles — downtown at a 250-building
// cap measured 2x the frame cost of a residential district. Weighing admission
// by facade area keeps rowhouse districts at the full count while downtown
// admits the nearest ~50-80 towers. Occupied buildings always stay.
const DETAIL_COST_BUDGET = 55_000;
const COLLIDER_R = 90;
const COLLIDER_EXIT = 115; // hysteresis: drop back to baked only past here
const COLLIDER_BUDGET = 20; // exact-collider swaps per scan (cheap: no mesh) — nearest first
const CHUNK_BUDGET = 260;// buildings merged into chunk geometry per frame (no hitch)
// Converting the packed worker payload into rich Entry/poly objects is allocation
// heavy in a dense cell. Bound that work so a 1,600-building downtown cell never
// becomes one GC-prone teleport frame. This is scheduling only; visual quality is
// identical once the cell's atomic baked→chunk swap completes.
const CELL_HYDRATE_SLICE = 96;
// Far teleports can retire dozens of dense cells at once. Most entries only
// flip a baked-mesh visibility bit; collider/detail owners are costlier, so cap
// both the total entries and heavy owners handled by one scheduler slice.
const CELL_RETIRE_SLICE = 48;
const CELL_RETIRE_HEAVY_SLICE = 1;
// Rich cells contain Entry objects, footprint tuples and live terrain samples.
// Keep enough for the entire 7x7 visual ring plus backtracking headroom, but do
// not retain every district visited during a long teleport session. The packed
// worker payload remains the immutable source for cheap re-hydration.
const MATERIALIZED_CELL_CACHE_MAX = 128;
// Visual chunk LOD radius (m): shorter than the master tile/draw-distance stream so
// far skyline stays on cheap baked OSM tiles instead of millions of citygen prism
// tris. At Corona Heights probes chunkLOD alone was ~1M tris with a 6 km stream.
// Collision/detail still use their own tight radii inside loaded cells.
const CHUNK_VISUAL_RADIUS = 2800;
const SCAN_EVERY = 0.15;
// Player-operated doors (E → toggleDoor). Doors start CLOSED (solid walls + the
// grammar's baked leaf); opening hides the baked leaf, swings a dynamic twin
// inward on the hinge, and swaps in the door-gapped colliders.
const DOOR_RANGE = 8;        // nearestDoor scan radius (m)
const DOOR_SWING = Math.PI * (100 / 180); // open leaf angle (rad), swung INTO the building
const DOOR_SWING_TIME = 0.6; // swing duration (s), ease-out
// Keep the closed blocker in place for the first visible part of the swing. At
// A 0.70 m player capsule clears even the narrowest 1.10 m opening at ~70°;
// before that the visible slab still occupies too much of the aperture. The
// solid↔gapped wall handoff happens at this same angle in both directions.
const DOOR_PASSABLE_AT = Math.PI * (70 / 180);
const DOOR_LEAF_T = 0.06;    // leaf thickness (m) — matches the grammar-authored leaf
const DOOR_FACE_OFFSET = 0.04;// sit on the same proud plane as the grammar leaf
const DOOR_PLAYER_R = 0.48;  // conservative XZ player/capsule reach around a moving leaf
const DETAIL_OCCUPANCY_MARGIN = 1.4; // pin a detail building through the indoor-camera handoff
const OPEN_INTERIOR_RETAIN = 12;     // keep an opened home's reveal alive for exterior viewing

interface PhysWorld {
  createBox(o: { type: number; position: readonly [number, number, number]; halfExtents: readonly [number, number, number]; friction?: number }): number;
  createStaticMesh(o: { position: readonly [number, number, number]; vertices: ArrayLike<number>; indices: ArrayLike<number>; friction?: number }): number;
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
  addQueryMesh(id: number, mesh: ColliderMesh): void;
  removeQuerySolid(id: number): void;
}
interface Tiles {
  suppressBuilding(key: string, index: number): void;
  unsuppressBuilding(key: string, index: number): void;
  suppressBuildingMesh(key: string, index: number): void;
  unsuppressBuildingMesh(key: string, index: number): void;
  /** Authored replacements (landmarks, bespoke sites) own these footprints and
   *  must never be materialized or revived by the procedural building ring. */
  isBuildingSuppressed?(key: string, index: number): boolean;
}
// Optional host frame-budget scheduler (SF's core/frameBudget.ts): deferrable
// bursty work — physics body batches, mesh assembly, material warmups — queues
// here and drains under the host's per-frame ms budget. Without a host
// scheduler the module stays portable: work runs immediately (old behaviour).
type ScheduleFn = (lane: "physics" | "build" | "upload" | "background", job: () => void | "again") => void;
interface BuiltGroup {
  group: THREE.Group;
  /** kit-of-parts window records (world-space, pre-proud) — the interior
   *  look-out feature aligns its wall holes to these. */
  windows: readonly ModuleInstance[];
  setOpacity(o: number): void;
  setGlassHidden(hidden: boolean): void;
  /** hide/show the whole exterior shell while the player is inside (see
   *  render.ts BuiltBuilding.setShellHidden) */
  setShellHidden(hidden: boolean): void;
  setDoorLeavesVisible(vis: boolean): void;
  dispose(): void;
}

interface Entry extends BuildingSpec {
  key: string;
  packedIndex: number;
  cx: number; cz: number;
  bb: { minx: number; maxx: number; minz: number; maxz: number };
  detail: BuiltGroup | null;
  fade: number; fadeDir: number;
  bodies: number[];              // exact-poly wall colliders (coll + detail tiers)
  wallBoxes: ColliderBox[];      // source OBBs of `bodies` (debug x-ray only)
  roofBody: number;              // kept across solid↔door-gapped wall swaps
  roofMesh: ColliderMesh | null; // footprint-faithful roof prism (coll + detail)
  interior: { group: THREE.Group; dispose(): void } | null;
  intBodies: number[];
  intBoxes: ColliderBox[];       // source OBBs of `intBodies` (debug x-ray only)
  // lod    = far: baked mesh hidden (R=1), the LOOSE baked collider is live.
  // coll   = near: baked collider dropped (R=0) + exact-poly SOLID walls, so the
  //          collider matches the visible LOD prism, including its roof (no
  //          "invisible box" — the
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
  // detail preparation is queued or a grammar-build request is in flight on the
  // worker (counts against the detail cap; cleared on assemble / cancellation)
  pendingBuild: boolean;
  /** facade-area admission cost (perimeter · storeys), computed lazily */
  cost?: number;
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
  ox: number; oz: number;        // facade outward normal (for the proud hinge offset)
  // swing animation (advanced by ring.update while on the active list)
  swing: number;                 // current angle, 0 = closed .. DOOR_SWING = open
  from: number; to: number; t: number;
  animating: boolean;
  needSolid: boolean;            // close finished but the solid-wall swap is deferred (player in gap)
  leaf: THREE.Group | null;      // dynamic hinged leaf (lives OUTSIDE the bundle)
  leafMaterials: THREE.Material[]; // render-object owners; disposed with the live leaf
  bakedLeaf: THREE.Mesh | null;  // the bundle's merged "citygen.doorleaf" mesh
  bakedBack: THREE.Mesh | null;  // dedicated closed-only "citygen.doorback" occluder
}

interface CellState {
  key: string;
  ix: number;
  iz: number;
  entries: Entry[];
  chunk: ChunkLOD | null;
  /** A finished cell stays on the baked tile until its ACTUAL beauty owner has
   *  been prepared in the live render context. Only `ready` may suppress baked
   *  meshes or admit detail/collider work. */
  phase: "building" | "awaiting-prepare" | "preparing" | "ready" | "fallback";
  /** M12: set while this published cell's chunk mesh is hidden by the front
   *  visibility gate (beyond the sweeping materialize front). Publication,
   *  residency and warm are untouched — visibility only. */
  frontGateHandle?: FrontGateHandle;
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
  /** Runtime observability: visual state, current hinge angle, and whether the
   *  collider gap is live. Existing callers can ignore these additive fields. */
  phase: "closed" | "opening" | "open" | "closing";
  swing: number;
  passable: boolean;
  dynamicLeaf: boolean;
  /** DEBUG: the entry's sampled front-terrain height + how many tilted (stoop
   *  ramp) collider boxes are live for this building */
  fg?: number; nRamp: number;
  bb: { minx: number; maxx: number; minz: number; maxz: number };
}

export interface CityGenRing {
  count: number;
  update(playerPos: THREE.Vector3, dt: number): void;
  /** M5: distance from (x, z) to the nearest WANTED cell (inside the current
   *  chunk-visual window) that has not yet published its chunk (or fallen back
   *  to the baked city) — Infinity when nothing constrains. The ring
   *  coordinator mins this into its residency so the materialize front never
   *  sweeps across a cell mid baked→chunk swap. One pass over ≤(2·cellLoad+1)²
   *  keys (≤ ~49) — cheap; callers throttle. */
  materializedRadiusAround(x: number, z: number): number;
  /** M12: re-evaluate every published cell against the front visibility gate
   *  (far-teleport refocus — cells revealed by the previous sweep re-hide when
   *  they now lie beyond the collapsed front). Inert when the gate is off. */
  applyFrontGate(): void;
  dispose(): void;
  stats(): {
    total: number;
    cells: number;
    buildings: number;
    detail: number;
    interiors: number;
    exteriorPipelinesPrepared: number;
    exteriorPipelinePrepareFailures: number;
    exteriorPipelinePrepareCancellations: number;
    cellsReady: number;
    cellsAwaitingPrepare: number;
    cellsPreparing: number;
    activeChunkPrepare: boolean;
    cellGeneration: number;
    hydrationQueued: number;
    detailBuildQueued: number;
    detailBuildActive: boolean;
    admissionRadius: number;
    detailCoreRadius: number;
    detailCoreEligible: number;
    detailCoreMissing: number;
    detailCostUsed: number;
    shellBatches: number;
    shellPreparedBatches: number;
    shellGeometryVertexCapacity: number;
    shellGeometryIndexCapacity: number;
  };
  /** true while the player is inside a generated building (drives the indoor camera). */
  isPlayerInside(): boolean;
  /** Rebuild every currently materialized interior from live procedural tuning.
   *  Usually this is one home; open-door reveal hysteresis can briefly retain a
   *  second. Returns the number successfully rebuilt. */
  refreshInteriors(): number;
  debugBuildings(): { cx: number; cz: number; base: number; top: number; interior: boolean; bb: { minx: number; maxx: number; minz: number; maxz: number } }[];
  /** DEBUG: live walk-in wall + interior collider OBBs for the "/" x-ray overlay. */
  debugColliders(walls: ColliderBox[], interiors: ColliderBox[], roofs?: ColliderMesh[]): void;
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
  /** Open/close a door by handle. Opening swings a dynamic leaf inward over
   *  ~0.6 s and swaps in the door-gapped colliders (+ stoop ramp) once visibly
   *  ajar; closing
   *  reverses the swing, then restores the SOLID walls and the baked leaf.
   *  "blocked" = refused — the player is standing in the doorway (never wall
   *  someone in). "gone" = the building is no longer a faded-in detail mesh. */
  toggleDoor(id: number): "opened" | "closed" | "blocked" | "gone";
}

async function fetchPackedGrid(url: string): Promise<PackedCityGrid | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./ingestWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      console.warn("[citygen] ingestion worker unavailable — retaining baked city", error);
      resolve(null);
      return;
    }
    const id = 1;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (grid: PackedCityGrid | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      worker.terminate();
      resolve(grid);
    };
    timeout = setTimeout(() => {
      console.warn("[citygen] ingestion timed out — retaining baked city");
      finish(null);
    }, 45_000);
    worker.onmessage = (event: MessageEvent<CityGridIngestReply>) => {
      if (event.data.id !== id) return;
      if (event.data.error || !event.data.grid) {
        console.warn("[citygen] ingestion failed — retaining baked city", event.data.error ?? "empty result");
        finish(null);
        return;
      }
      finish(event.data.grid);
    };
    worker.onerror = (error) => {
      console.warn("[citygen] ingestion worker failed — retaining baked city", error);
      finish(null);
    };
    worker.onmessageerror = (error) => {
      console.warn("[citygen] ingestion reply could not be decoded — retaining baked city", error);
      finish(null);
    };
    try {
      worker.postMessage({ id, url });
    } catch (error) {
      console.warn("[citygen] ingestion request failed — retaining baked city", error);
      finish(null);
    }
  });
}

export async function createCityGenRing(
  opts: { url?: string; excludeBuilding?: (key: string, index: number) => boolean },
  ctx: {
    scene: THREE.Object3D;
    physics: { world: PhysWorld } & Partial<QuerySolidHost>;
    map: { groundHeight(x: number, z: number): number; surfaceType?(x: number, z: number): number };
    tiles: Tiles;
    schedule?: ScheduleFn;
    /** Yield to the host immediately before creating/preparing a WebGPU owner.
     * Per-cell calls receive a current-generation predicate so a destination
     * change can cancel work before a non-cancellable driver compile begins. */
    beforeRenderOwnership?: (isCurrent?: () => boolean) => Promise<boolean | void>;
    /** Prepare one detached render owner in the exact host render context. The
     * production host uses WebGPURenderer.compileAsync(owner, camera, scene). */
    prepareRenderOwner?: (owner: THREE.Object3D) => Promise<void>;
  },
): Promise<CityGenRing> {
  const url = opts.url ?? "/citygen/buildings.json";
  const grid = await fetchPackedGrid(url);
  await ctx.beforeRenderOwnership?.();
  const materials = buildCityGenMaterials();
  // All always-on CityGen render owners live under one root that stays detached
  // until their exact exterior pipelines have been prepared. compileAsync
  // ignores invisible objects, so owners remain visible here; detachment is the
  // publication boundary that guarantees no half-warm object reaches a frame.
  const renderRoot = new THREE.Group();
  renderRoot.name = "cityGenRenderOwners";
  // instanced kit-of-parts windows: every detail building's panes/frames draw
  // as a handful of city-wide instanced meshes (see render/moduleLayer.ts)
  const moduleLayer = createModuleLayer(renderRoot);
  // batched building SHELLS: walls/roof/trim/stoop/doors of every detail building
  // draw as ~a dozen city-wide BatchedMesh draws (was ~2384 bundle sub-draws), and
  // frustum-cull per instance (see render/shellBatch.ts). Sized off the detail cap.
  const shellBatch = createShellBatchLayer(renderRoot, {
    capacity: Math.max(768, Math.ceil(CT.maxDetail * 1.5)),
  });
  let chunkLODBeautyWarmup: ReturnType<typeof createChunkLODBeautyWarmup> | null = null;
  let exteriorPipelinesPrepared = 0;
  let exteriorPipelinePrepareFailures = 0;
  let exteriorPipelinePrepareCancellations = 0;
  const prepareOwner = async (
    label: string,
    owner: THREE.Object3D,
    isCurrent?: () => boolean,
  ): Promise<boolean> => {
    if (!ctx.prepareRenderOwner) return false;
    if (isCurrent && !isCurrent()) {
      exteriorPipelinePrepareCancellations++;
      return false;
    }
    try {
      // Yield once before EVERY driver request. The host passes `isCurrent`
      // through its arrival wait, so a teleport can abort a pending old-cell
      // owner instead of serializing the destination behind it.
      const admitted = await ctx.beforeRenderOwnership?.(isCurrent);
      if (admitted === false) {
        exteriorPipelinePrepareCancellations++;
        return false;
      }
      // A teleport/unload can happen while the host yield is pending. Do not
      // start driver work for an owner that has already lost publication rights.
      if (isCurrent && !isCurrent()) {
        exteriorPipelinePrepareCancellations++;
        return false;
      }
      await ctx.prepareRenderOwner(owner);
      // compileAsync itself is not cancellable. Its late result may warm caches,
      // but it must never publish a stale owner.
      if (isCurrent && !isCurrent()) {
        exteriorPipelinePrepareCancellations++;
        return false;
      }
      exteriorPipelinesPrepared++;
      return true;
    } catch (error) {
      if (isCurrent && !isCurrent()) return false;
      exteriorPipelinePrepareFailures++;
      console.warn(`[citygen] detached exterior prepare failed (${label})`, error);
      return false;
    }
  };
  if (grid && ctx.prepareRenderOwner) {
    // Prepare one exact owner at a time. This lets WebGPURenderer.compileAsync
    // yield between node builds and prevents one multi-owner compile from
    // becoming a single post-reveal multi-second task.
    chunkLODBeautyWarmup = createChunkLODBeautyWarmup();
    await prepareOwner("chunk-lod:beauty", chunkLODBeautyWarmup.object);
    for (const owner of moduleLayer.warmupOwners()) {
      await prepareOwner(owner.label, owner.object);
    }
    await shellBatch.prepareExterior(materials, prepareOwner);
    if (exteriorPipelinePrepareFailures > 0) {
      // Fail closed: the baked city is complete. Never publish an unprepared
      // exterior owner and recreate the original first-visible-frame hitch.
      moduleLayer.dispose();
      shellBatch.dispose();
      chunkLODBeautyWarmup.dispose();
      chunkLODBeautyWarmup = null;
      for (const material of new Set(Object.values(materials))) material.dispose();
      throw new Error(`CityGen exterior preparation failed (${exteriorPipelinePrepareFailures} owner${exteriorPipelinePrepareFailures === 1 ? "" : "s"})`);
    }
  }
  ctx.scene.add(renderRoot);
  // no host scheduler → run deferred work immediately (portable fallback)
  const schedule: ScheduleFn = ctx.schedule ?? ((_lane, job) => { let v = job(); let guard = 0; while (v === "again" && guard++ < 10000) v = job(); });

  // The worker transferred one compact citywide store. Hydrate Entry objects,
  // footprint arrays, and live-terrain grade only when a cell first becomes
  // relevant. This removes ~91k object allocations + terrain sampling from boot.
  const cellRanges = new Map<string, readonly [number, number]>();
  const materializedCells = new Map<string, Entry[]>();
  if (grid) {
    for (let i = 0; i < grid.cellKeys.length; i++) {
      cellRanges.set(grid.cellKeys[i], [grid.cellStarts[i], grid.cellStarts[i + 1]]);
    }
  }
  let total = grid?.readyCount ?? 0;
  const excludedPacked = new Set<number>();
  const polyAt = (packedIndex: number): [number, number][] => {
    if (!grid) return [];
    const start = grid.polyStarts[packedIndex];
    const end = grid.polyStarts[packedIndex + 1];
    const poly = new Array<[number, number]>(end - start);
    for (let p = start; p < end; p++) poly[p - start] = [grid.polyXZ[p * 2], grid.polyXZ[p * 2 + 1]];
    return poly;
  };
  const materializeBuilding = (key: string, packedIndex: number): Entry | null => {
    if (!grid) return null;
    const archetype = grid.archetypes[grid.archetypeCodes[packedIndex]];
    if (!READY.has(archetype)) return null;
    const i = grid.sourceIndices[packedIndex];
    if (ctx.tiles.isBuildingSuppressed?.(key, i) || opts.excludeBuilding?.(key, i)) {
      if (!excludedPacked.has(packedIndex)) {
        excludedPacked.add(packedIndex);
        total--;
      }
      return null;
    }
    const poly = polyAt(packedIndex);
    const ho = packedIndex * 3;
    const bo = packedIndex * 6;
    const base = grid.heights[ho];
    const top = grid.heights[ho + 1];
    const h = grid.heights[ho + 2];
    const spec: BuildingSpec = {
      i,
      id: grid.ids[packedIndex],
      poly,
      base,
      top,
      archetype,
      seed: grid.seeds[packedIndex]
    };
    if (Number.isFinite(h)) spec.h = h;
    // Live terrain is main-thread owned, so the worker cannot provide grade.
    // Compute it inside the bounded cell slice before any detail ranking or
    // street-edge analysis can observe the Entry.
    spec.grade = footprintGrade(poly, base, top, ctx.map);
    return {
      ...spec,
      key,
      packedIndex,
      cx: grid.bounds[bo],
      cz: grid.bounds[bo + 1],
      bb: {
        minx: grid.bounds[bo + 2],
        maxx: grid.bounds[bo + 3],
        minz: grid.bounds[bo + 4],
        maxz: grid.bounds[bo + 5]
      },
      detail: null,
      fade: 0,
      fadeDir: 0,
      bodies: [],
      wallBoxes: [],
      roofBody: 0,
      roofMesh: null,
      interior: null,
      intBodies: [],
      intBoxes: [],
      state: "lod",
      doorPending: false,
      pendingBuild: false
    };
  };

  // Resolve the entrance facade against the complete footprint set, including
  // archetypes this ring does not currently render. The longest-edge fallback is
  // usually a good facade guess, but attached SF homes commonly share that edge
  // with their neighbour. Sampling a few metres outward rejects those party walls
  // before one consistent edge is handed to massing, colliders, doors and rooms.
  //
  // Footprints were indexed into every 32 m bin by the ingestion worker. Queries
  // binary-search its sparse CSR arrays; the main thread never rebuilds a global
  // Map or hydrates neighbour BuildingSpec objects.
  const STREET_BIN = 32;
  const streetBinRange = (ix: number, iz: number): readonly [number, number] | null => {
    if (!grid) return null;
    let lo = 0;
    let hi = grid.binStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const bx = grid.binCoords[mid * 2];
      const bz = grid.binCoords[mid * 2 + 1];
      if (bx < ix || (bx === ix && bz < iz)) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= grid.binStarts.length - 1) return null;
    if (grid.binCoords[lo * 2] !== ix || grid.binCoords[lo * 2 + 1] !== iz) return null;
    return [grid.binStarts[lo], grid.binStarts[lo + 1]];
  };
  const packedPointInPoly = (packedIndex: number, x: number, z: number): boolean => {
    if (!grid) return false;
    const start = grid.polyStarts[packedIndex];
    const end = grid.polyStarts[packedIndex + 1];
    let inside = false;
    for (let i = start, j = end - 1; i < end; j = i++) {
      const xi = grid.polyXZ[i * 2], zi = grid.polyXZ[i * 2 + 1];
      const xj = grid.polyXZ[j * 2], zj = grid.polyXZ[j * 2 + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const sampleBlockedByNeighbor = (e: Entry, x: number, z: number): boolean => {
    if (!grid) return false;
    const range = streetBinRange(Math.floor(x / STREET_BIN), Math.floor(z / STREET_BIN));
    if (!range) return false;
    for (let k = range[0]; k < range[1]; k++) {
      const other = grid.binMembers[k];
      if (other === e.packedIndex) continue;
      const ho = other * 3;
      if (grid.heights[ho + 1] <= e.base + 0.5 || e.top <= grid.heights[ho] + 0.5) continue;
      if (packedPointInPoly(other, x, z)) return true;
    }
    return false;
  };
  const sampleDoorFrontGround = (cx: number, cz: number, nx: number, nz: number, sill: number): number => {
    const at = (d: number) => ctx.map.groundHeight(cx + nx * d, cz + nz * d);
    const near = at(1.3);
    const foot = 0.3 + Math.max(0.5, (sill - near) / 0.63);
    return Math.min(near, at(foot));
  };
  const chooseExposedStreetEdge = (e: Entry): { edge: number; doorAllowed: boolean } => {
    const poly = ensureCCW(e.poly);
    const grade = e.grade ?? e.base;
    const fallback = streetEdgeIndex(poly);
    let best = fallback, bestScore = -Infinity, bestClearance = 0;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.3 || !doorEligible({ isStreet: true, length, base: e.base, top: e.top, grade })) continue;
      const ux = dx / length, uz = dz / length;
      const nrm = edgeOutwardNormal(p0, p1);
      const dm = doorMetrics(length, e.base, e.top, grade);
      const { tc } = dm;
      const cx = p0[0] + ux * tc * length, cz = p0[1] + uz * tc * length;
      // An exposed facade is still unusable if its sill floats above terrain
      // beyond the authored ramp/step contract. Score only candidates the same
      // 3 m stoop can physically reach; almost every steep-lot building has a
      // better exposed side, and the rare remainder becomes honestly doorless.
      const frontGround = sampleDoorFrontGround(cx, cz, nrm[0], nrm[1], dm.sill);
      if (!Number.isFinite(frontGround) || dm.sill - frontGround > STOOP_MAX_RISE) continue;
      // Near clearance has the largest weight: a sample immediately inside a
      // neighbour proves a party wall. Farther samples favour the street over a
      // narrow side/rear alley while edge length keeps the result deterministic.
      const distances = [0.35, 0.8, 1.5] as const;
      const laterals = [-0.42, 0, 0.42] as const; // full player-capsule corridor, not a zero-width ray
      let clearance = 0;
      for (let s = 0; s < distances.length; s++) {
        const d = distances[s];
        let depthClear = true;
        for (const lateral of laterals) {
          if (sampleBlockedByNeighbor(e, cx + nrm[0] * d + ux * lateral, cz + nrm[1] * d + uz * lateral)) {
            depthClear = false;
            break;
          }
        }
        if (depthClear) {
          clearance += 1 << (distances.length - s);
        }
      }
      // Equal-clearance candidates should face a real street, not merely the
      // marginally longer side/rear yard. surface.bin is intentionally coarse,
      // so road evidence is a bounded tiebreak: march a full capsule corridor,
      // accept road only across all three lanes, and stop if any lane meets a
      // neighbour first. This distinguishes a legitimate building across the
      // street (road comes first) from a courtyard/alley ending at another wall.
      let roadDistance = Infinity;
      if (clearance === 14 && ctx.map.surfaceType) {
        roadScan: for (let d = 1.5; d <= 16; d += 1) {
          for (const lateral of laterals) {
            const x = cx + nrm[0] * d + ux * lateral, z = cz + nrm[1] * d + uz * lateral;
            if (sampleBlockedByNeighbor(e, x, z)) break roadScan;
          }
          let allRoad = true;
          for (const lateral of laterals) {
            const x = cx + nrm[0] * d + ux * lateral, z = cz + nrm[1] * d + uz * lateral;
            if (ctx.map.surfaceType(x, z) !== 4) { allRoad = false; break; }
          }
          if (allRoad) { roadDistance = d; break; }
        }
      }
      // 1,025–1,375 points: enough that any qualified road edge beats the
      // longest real dataset edge at equal clearance, but far below the 20,000
      // gap between adjacent clearance levels. The gentle distance term avoids
      // pretending the 8 m surface raster has sub-cell precision.
      const roadBonus = Number.isFinite(roadDistance) ? 1000 + 25 * (16.5 - roadDistance) : 0;
      const score = clearance * 10000 + roadBonus + length;
      if (score > bestScore) { bestScore = score; best = i; bestClearance = clearance; }
    }
    return { edge: best, doorAllowed: bestScore > -Infinity && bestClearance === 14 };
  };
  // Street-facing analysis is needed only by full-detail facades/doors. Keeping
  // it lazy avoids doing thousands of terrain, road-raster, and neighbour probes
  // merely to prepare a destination's low-detail skyline.
  const resolveStreetEdge = (e: Entry) => {
    if (e.streetEdge !== undefined) return;
    const resolved = chooseExposedStreetEdge(e);
    e.streetEdge = resolved.edge;
    e.doorAllowed = resolved.doorAllowed;
  };
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0, minZ = grid?.minZ ?? 0;

  const loaded = new Map<string, CellState>();
  const building: CellState[] = []; // cells still merging their chunk
  // Cell hydration/chunk setup is scheduled center-out. A generation follows the
  // player's tile so queued origin work becomes a cheap no-op after teleport.
  type CellRequest = { key: string; ix: number; iz: number; d2: number; generation: number };
  type CellHydration = CellRequest & { cursor: number; end: number; entries: Entry[] };
  type CellRetirement = { cell: CellState; cursor: number };
  const pendingCells = new Map<string, number>();
  const cellQueue: CellRequest[] = [];
  const retiringCells = new Map<string, CellRetirement>();
  const retireQueue: CellRetirement[] = [];
  let activeCellHydration: CellHydration | null = null;
  let activeCellRetirement: CellRetirement | null = null;
  let cellHydrationScheduled = false;
  let cellRetirementScheduled = false;
  let cellGeneration = 0;
  let centerTileX = NaN;
  let centerTileZ = NaN;
  let activeCellLoad = 0;
  let disposed = false;
  type ActiveChunkPrepare = { cell: CellState; token: number; generation: number };
  let activeChunkPrepare: ActiveChunkPrepare | null = null;
  let nextChunkPrepareToken = 1;
  const touchMaterializedCell = (key: string, entries: Entry[]): void => {
    materializedCells.delete(key);
    materializedCells.set(key, entries);
  };
  const trimMaterializedCells = (): void => {
    if (materializedCells.size <= MATERIALIZED_CELL_CACHE_MAX) return;
    for (const key of materializedCells.keys()) {
      if (loaded.has(key) || retiringCells.has(key) || activeCellHydration?.key === key) continue;
      materializedCells.delete(key);
      if (materializedCells.size <= MATERIALIZED_CELL_CACHE_MAX) break;
    }
  };
  // Every entry that currently holds a detail mesh (≤ maxDetail + in-flight
  // fades). The per-frame loops (interior gate, fades) walk THIS, not every
  // loaded building — with a wide tileLoadRadius that's thousands of entries
  // per frame doing nothing but an early-out (measured ~8% of frame CPU).
  const detailSet = new Set<Entry>();
  let accum = 0;
  let lastAdmissionRadius = CT.detailRadius;
  let lastDetailCoreRadius = Math.min(CT.detailCoreRadius, CT.detailRadius);
  let lastDetailCoreEligible = 0;
  let lastDetailCoreMissing = 0;
  let lastDetailCostUsed = 0;

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
  const addMeshBody = (c: ColliderMesh): number => {
    const h = ctx.physics.world.createStaticMesh({
      position: [c.x, c.y, c.z], vertices: c.vertices, indices: c.indices, friction: 0.8
    });
    ctx.physics.addQueryMesh?.(h, c);
    return h;
  };
  const clearWalls = (e: Entry) => {
    for (const h of e.bodies) { ctx.physics.removeQuerySolid?.(h); ctx.physics.world.destroyBody(h); }
    e.bodies.length = 0;
    e.wallBoxes = [];
  };
  const clearBodies = (e: Entry) => {
    clearWalls(e);
    if (e.roofBody) {
      ctx.physics.removeQuerySolid?.(e.roofBody);
      ctx.physics.world.destroyBody(e.roofBody);
      e.roofBody = 0;
    }
    e.roofMesh = null;
  };
  const disposeInterior = (e: Entry) => {
    if (e.interior) { ctx.scene.remove(e.interior.group); e.interior.dispose(); e.interior = null; }
    for (const h of e.intBodies) { ctx.physics.removeQuerySolid?.(h); ctx.physics.world.destroyBody(h); }
    e.intBodies.length = 0;
    e.intBoxes = [];
    // bring the exterior shell + instanced glass back now that nobody's inside
    e.detail?.setShellHidden(false);
    e.detail?.setGlassHidden(false);
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
    if (!e.roofBody) {
      const roof = roofColliderMesh(e);
      if (roof) {
        e.roofBody = addMeshBody(roof);
        e.roofMesh = roof;
      }
    }
    if (withStoop) appendStoopNow(e);
  };
  // Player XZ inside the footprint AABB (+margin) at building height → walls must
  // NEVER materialize this frame (they'd spawn around/inside the player = wedge);
  // the coll job defers with "again" until the player clears the lot.
  const lastPlayer = new THREE.Vector3();
  let speedEma = 0; // smoothed player speed (m/s) — gates detail reach while flying
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
      if (!loaded.has(e.key) || e.state !== "coll" || e.bodies.length) return; // stale/duplicate (dropped, unloaded, or upgraded)
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
    detailSet.add(e);
    // R6: DON'T open the door gap — the walls stay SOLID after fade-in too, because
    // doors are now player-operated: they materialize CLOSED (doorPending=true) and
    // only toggleDoor → openDoorway() swaps in the door-gapped walls.
    // Reuse the "coll" solid walls if we came from there; otherwise (from "lod", or
    // "coll" whose queued job hasn't run) atomically suppress the baked collider
    // and install the exact walls + roof in the same frame. Detail builds are
    // capped at 1-3 per scan, so this
    // inline burst is ~30-60 createBox worst case — sub-ms, unlike the 20-per-scan
    // coll tier which stays on the physics lane.
    // EXCEPT anti-wedge: if the player is inside the footprint AABB right now
    // (e.g. a car driving across the lot while the worker build landed), walls
    // materializing this frame would spawn AROUND the car and wedge it — the same
    // failure the coll job's playerInsideBB guard prevents. Defer to a "physics"
    // job that retries ("again") until the player clears the lot. Keep the baked
    // collider live during that wait: dropping it early opened the entire house,
    // including its roof, exactly while an airborne player was arriving.
    e.state = "detail";
    if (!e.bodies.length) {
      if (!playerInsideBB(e, 3.5)) {
        ctx.tiles.suppressBuilding(e.key, e.i);
        buildSolidWallsNow(e, true);
      }
      else schedule("physics", () => {
        if (!loaded.has(e.key) || e.state !== "detail" || e.bodies.length) return; // stale/duplicate (dropped, unloaded, or walls landed elsewhere)
        if (playerInsideBB(e, 3.5)) return "again";          // anti-wedge: retry next frame
        ctx.tiles.suppressBuilding(e.key, e.i);
        buildSolidWallsNow(e, true);
      });
    } else {
      // coll→detail reuse: the walls stand, but the newly-drawn steps need bodies
      appendStoopNow(e);
    }
    e.doorPending = true;
  };
  let buildWorker: Worker | null = null;
  const BUILD_WORKER_WATCHDOG_MS = 10_000;
  type QueuedDetailBuild = { entry: Entry; spec: BuildingSpec; reservation: number };
  type ActiveDetailBuild = QueuedDetailBuild & { id: number; timer: ReturnType<typeof setTimeout> };
  const detailBuildQueue: QueuedDetailBuild[] = [];
  let activeDetailBuild: ActiveDetailBuild | null = null;
  const detailBuildReservations = new Set<Entry>();
  const detailBuildReservationOf = new Map<Entry, number>();
  let nextDetailBuildReservation = 1;
  const releaseDetailBuild = (e: Entry, reservation?: number) => {
    // An old scheduler/worker continuation must never clear a newer request for
    // the same cached Entry after rapid away→back travel.
    if (reservation !== undefined && detailBuildReservationOf.get(e) !== reservation) return;
    detailBuildReservationOf.delete(e);
    detailBuildReservations.delete(e);
    e.pendingBuild = false;
  };
  // the worker gets a PLAIN spec — Entry carries THREE objects/body handles that
  // must not (and cannot) cross the structured-clone boundary
  const specOf = (e: Entry): BuildingSpec => ({
    i: e.i, id: e.id, poly: e.poly, base: e.base, top: e.top,
    streetEdge: e.streetEdge, doorAllowed: e.doorAllowed,
    grade: e.grade, frontGround: e.frontGround, h: e.h, archetype: e.archetype, seed: e.seed,
  });
  const detailBuildDistance2 = (e: Entry) => {
    // Queue the nearest wall, not the nearest centroid. This matters for long
    // blocks whose facade is beside the player while their centre is far away.
    return aabbDistance2(e.bb, lastPlayer.x, lastPlayer.z);
  };
  const detailBuildIsCurrent = (e: Entry, reservation?: number) => {
    if (
      (reservation !== undefined && detailBuildReservationOf.get(e) !== reservation) ||
      !e.pendingBuild || e.detail || e.state === "detail" || !loaded.has(e.key)
    ) return false;
    // Fixed visual retention, not the speed-throttled NEW-admission band: work
    // admitted while moving slowly may finish without a speed change cancelling
    // it, but work from an actually departed district is discarded promptly.
    const staleR = CT.detailRadius + 40;
    return detailBuildDistance2(e) <= staleR * staleR;
  };
  let nextBuildId = 1;
  const failBuildWorker = (reason: unknown) => {
    console.warn("[citygen] build worker unavailable — keeping chunk LOD", reason);
    if (activeDetailBuild) clearTimeout(activeDetailBuild.timer);
    activeDetailBuild = null;
    detailBuildQueue.length = 0;
    // Includes preparation/assembly jobs already parked in the host scheduler.
    // They re-check pendingBuild on entry and become cheap no-ops.
    for (const entry of [...detailBuildReservations]) releaseDetailBuild(entry);
    buildWorker?.terminate();
    buildWorker = null;
  };
  const pumpDetailBuildWorker = () => {
    if (!buildWorker || activeDetailBuild) return;
    // Re-rank every time the worker frees up. At six reservations max this sort
    // is trivial, and it makes a recently moved-to district win over old FIFO.
    detailBuildQueue.sort((a, b) => detailBuildDistance2(a.entry) - detailBuildDistance2(b.entry));
    while (detailBuildQueue.length) {
      const queued = detailBuildQueue.shift()!;
      if (!detailBuildIsCurrent(queued.entry, queued.reservation)) {
        releaseDetailBuild(queued.entry, queued.reservation);
        continue;
      }
      const id = nextBuildId++;
      const timer = setTimeout(() => {
        if (activeDetailBuild?.id !== id) return;
        const stalled = activeDetailBuild;
        activeDetailBuild = null;
        releaseDetailBuild(stalled.entry, stalled.reservation);
        failBuildWorker(new Error(`detail build worker made no progress for ${BUILD_WORKER_WATCHDOG_MS}ms`));
      }, BUILD_WORKER_WATCHDOG_MS);
      activeDetailBuild = { ...queued, id, timer };
      try {
        buildWorker.postMessage({ id, spec: queued.spec });
      } catch (error) {
        clearTimeout(timer);
        activeDetailBuild = null;
        releaseDetailBuild(queued.entry, queued.reservation);
        failBuildWorker(error);
      }
      return;
    }
  };
  const pruneDetailBuildBacklog = () => {
    // Drop queued/preparation/assembly reservations that no longer belong to
    // the current local ring. The one request already executing cannot be
    // interrupted, but no second stale job has entered the worker FIFO.
    for (let i = detailBuildQueue.length - 1; i >= 0; i--) {
      const queued = detailBuildQueue[i];
      if (detailBuildIsCurrent(queued.entry, queued.reservation)) continue;
      detailBuildQueue.splice(i, 1);
      releaseDetailBuild(queued.entry, queued.reservation);
    }
    for (const entry of [...detailBuildReservations]) {
      const reservation = detailBuildReservationOf.get(entry);
      if (
        reservation !== undefined &&
        ((activeDetailBuild?.entry === entry && activeDetailBuild.reservation === reservation) ||
          detailBuildQueue.some((queued) => queued.entry === entry && queued.reservation === reservation))
      ) continue;
      if (!detailBuildIsCurrent(entry, reservation)) releaseDetailBuild(entry, reservation);
    }
    pumpDetailBuildWorker();
  };
  try {
    buildWorker = new Worker(new URL("./buildWorker.ts", import.meta.url), { type: "module" });
    buildWorker.onmessage = (ev: MessageEvent<
      | { id: number; ok: true; meshes: MeshData[]; instances?: ModuleInstance[]; matTable?: string[] }
      | { id: number; ok: false; error: string }
    >) => {
      const active = activeDetailBuild;
      if (!active || active.id !== ev.data.id) return;
      clearTimeout(active.timer);
      activeDetailBuild = null;
      const e = active.entry;
      const id = ev.data.id;
      if (!ev.data.ok) {
        releaseDetailBuild(e, active.reservation);
        console.warn(`[citygen] detail build ${id} failed; retaining chunk LOD: ${ev.data.error}`);
        pumpDetailBuildWorker();
        return;
      }
      const { meshes, instances, matTable } = ev.data;
      if (!detailBuildIsCurrent(e, active.reservation)) {
        releaseDetailBuild(e, active.reservation);
        pumpDetailBuildWorker();
        return; // cancelled while in flight
      }
      // assembly (geometry + materials + bundle) is main-thread but cheap-ish —
      // still, keep it off loaded frames via the build lane, one building per job
      schedule("build", () => {
        try {
          if (!detailBuildIsCurrent(e, active.reservation)) return; // superseded / departed before assembly
          finishDetail(e, assembleBuilding(e as BuildingSpec, { meshes, instances, matTable }, materials, moduleLayer, shellBatch));
        } finally {
          releaseDetailBuild(e, active.reservation);
        }
      });
      // Keep the pure worker saturated while main-thread assembly remains under
      // the host scheduler. The shared reservation cap still bounds both phases.
      pumpDetailBuildWorker();
    };
    buildWorker.onerror = failBuildWorker;
    buildWorker.onmessageerror = failBuildWorker;
  } catch {
    buildWorker = null;
  }
  const requestDetail = (e: Entry): boolean => {
    if (detailBuildReservations.size >= DETAIL_BUILD_BACKLOG_MAX) return false;
    const reservation = nextDetailBuildReservation++;
    detailBuildReservations.add(e);
    detailBuildReservationOf.set(e, reservation);
    e.pendingBuild = true;
    // Terrain grade, exposed-street resolution, and front-step sampling are live
    // map queries and cannot cross the worker boundary. They are still deferred
    // through the shared build lane so the scan itself remains allocation-free.
    schedule("build", () => {
      if (!e.pendingBuild || e.detail || e.state === "detail" || !loaded.has(e.key)) {
        releaseDetailBuild(e, reservation);
        return;
      }
      if (!detailBuildIsCurrent(e, reservation)) {
        releaseDetailBuild(e, reservation);
        return;
      }
      if (e.grade === undefined) e.grade = footprintGrade(e.poly, e.base, e.top, ctx.map);
      resolveStreetEdge(e);
      // Sample the live street terrain at the door front ONCE, before the mesh
      // build. Visible stoop steps and their ramp collider share this value.
      if (e.frontGround === undefined) e.frontGround = frontGroundFor(e);
      if (!buildWorker) {
        // Never run the documented 30–100 ms grammar generator in an
        // interactive frame. The existing chunk prism is the safe fallback.
        releaseDetailBuild(e, reservation);
        return;
      }
      detailBuildQueue.push({ entry: e, spec: specOf(e), reservation });
      pumpDetailBuildWorker();
    });
    return true;
  };
  // Live terrain height just outside the street door (for the stoop rise). Recomputes
  // the same street edge + door centre the collider does, then samples the street
  // side TWICE — near the wall (1.3 m out) and near where the stoop ramp's foot
  // would land — taking the LOWER, so on a street that keeps dropping the ramp
  // reaches the real ground instead of leaving its foot floating as a step face.
  // undefined when the edge takes no door (collider skips the stoop).
  const frontGroundFor = (e: Entry): number | undefined => {
    const poly = ensureCCW(e.poly);
    const si = streetEdgeIndex(poly, e.streetEdge);
    const p0 = poly[si], p1 = poly[(si + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.3) return undefined;
    const grade = e.grade ?? e.base;
    if (!doorEligible({ isStreet: true, doorAllowed: e.doorAllowed, length, base: e.base, top: e.top, grade })) return undefined;
    const ux = dx / length, uz = dz / length;
    const nrm = edgeOutwardNormal(p0, p1);           // unit outward (street side)
    const { tc, sill } = doorMetrics(length, e.base, e.top, grade);
    const dC = tc * length;
    const cxd = p0[0] + ux * dC, czd = p0[1] + uz * dC;
    return sampleDoorFrontGround(cxd, czd, nrm[0], nrm[1], sill);
  };
  // Swap the solid street wall for the door-gapped one once the live leaf reaches
  // DOOR_PASSABLE_AT. Passes the live front-terrain height so a downhill door gets
  // a walkable stoop.
  const openDoorway = (e: Entry) => {
    if (!e.doorPending) return;
    e.doorPending = false;
    clearWalls(e);
    // same frontGround the mesh build used → the ramp matches the drawn steps
    const fg = e.frontGround ?? frontGroundFor(e);
    const { boxes } = buildingColliders(e as BuildingSpec, true, fg); // door gap + stoop
    for (const c of boxes) e.bodies.push(addBody(c));
    e.wallBoxes = boxes;
    // The roof is independent of the door aperture and stays live through this
    // wall-only swap (no mesh rebuild, no one-frame contact churn).
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
  // Every live door reuses these two geometries and the theme's shared materials.
  // Opening many doors therefore adds transforms/draws, not geometry allocations or
  // new WebGPU pipelines. The unit box is scaled into the slab, raised panels and
  // escutcheon; the low-poly sphere becomes the pair of handles.
  const doorBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  const doorKnobGeo = new THREE.SphereGeometry(1, 12, 8);
  const doorRegistry = new Map<number, Entry>(); // stable id → entry
  let nextDoorId = 1;
  const activeDoors: Entry[] = []; // doors animating or awaiting a deferred wall swap
  const markDoorActive = (e: Entry) => { if (!activeDoors.includes(e)) activeDoors.push(e); };
  // Compute-once world door metrics (same math as debugDoors / core's collider —
  // doorMetrics is the single source of truth, so leaf ⟺ gap ⟺ baked leaf line up).
  const doorRtOf = (e: Entry): DoorRt | null => {
    if (e.door !== undefined) return e.door;
    const poly = ensureCCW(e.poly);
    const si = streetEdgeIndex(poly, e.streetEdge);
    const p0 = poly[si], p1 = poly[(si + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const length = Math.hypot(dx, dz);
    const grade = e.grade ?? e.base;
    if (length < 0.3 || !doorEligible({ isStreet: true, doorAllowed: e.doorAllowed, length, base: e.base, top: e.top, grade })) {
      e.door = null;
      return null;
    }
    const ux = dx / length, uz = dz / length;
    const outward = edgeOutwardNormal(p0, p1);
    const { tc, halfW, sill, openTop } = doorMetrics(length, e.base, e.top, grade);
    const dC = tc * length;
    const rt: DoorRt = {
      id: nextDoorId++,
      cx: p0[0] + ux * dC, cz: p0[1] + uz * dC,
      sill, openTop, halfW,
      // hinge at the dC − halfW edge of the opening (grammar authors the baked
      // leaf against this same edge, so the dynamic twin pivots where it should)
      hx: p0[0] + ux * (dC - halfW), hz: p0[1] + uz * (dC - halfW),
      ox: outward[0], oz: outward[1],
      // group yaw mapping local +X → the edge direction u: THREE's +Y rotation by
      // θ sends +X to (cos θ, 0, −sin θ), so θ = atan2(−uz, ux). This is a plain
      // THREE Object3D rotation — the box3d addBody half-angle negation gotcha
      // (see addBody above) does NOT apply here; no physics body is created.
      baseYaw: Math.atan2(-uz, ux),
      w: 2 * halfW * 0.96, h: (openTop - sill) - 0.04,
      swing: 0, from: 0, to: 0, t: 1, animating: false, needSolid: false,
      leaf: null, leafMaterials: [], bakedLeaf: null, bakedBack: null,
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
  // Conservative occupancy test for the whole sector swept by the hinged leaf,
  // not only the aperture centre. A player can stand inside beside the open leaf's
  // latch edge (~1.7 m from the hinge), outside playerInGap's smaller radius; a
  // close must still reverse before the render-only slab passes through them.
  const playerInLeafSweep = (rt: DoorRt): boolean => {
    if (lastPlayer.y < rt.sill - 0.5 || lastPlayer.y > rt.openTop) return false;
    const px = lastPlayer.x - rt.hx, pz = lastPlayer.z - rt.hz;
    const radius = Math.hypot(px, pz);
    if (radius > rt.w + DOOR_PLAYER_R) return false;
    if (radius < DOOR_PLAYER_R) return true;
    const closedAngle = -rt.baseYaw;
    const playerAngle = Math.atan2(pz, px);
    const delta = Math.atan2(Math.sin(playerAngle - closedAngle), Math.cos(playerAngle - closedAngle));
    const angularReach = Math.asin(Math.min(1, DOOR_PLAYER_R / radius));
    return delta >= -angularReach && delta <= rt.swing + angularReach;
  };
  const retargetSwing = (rt: DoorRt, to: number) => { rt.from = rt.swing; rt.to = to; rt.t = 0; rt.animating = true; };
  // Spawn the dynamic hinged leaf + hide the baked leaf AND its dedicated closed
  // backing (one bundle re-record). The old backing lived in citygen.room, so it
  // remained as an opaque black quad after opening and completely occluded this
  // animation from the street even though the collider gap was live.
  // SWING SIGN: rotating a vector by +φ about +Y sends the edge direction u to the
  // OUTWARD normal (u=(ux,uz) → (uz,−ux) = edgeOutwardNormal) — so the INWARD
  // swing is the NEGATIVE delta: rotation.y = baseYaw − swing (verified with edge
  // u=+X → street at −Z: baseYaw 0, swing π/2 points the leaf at +Z = inward).
  const spawnLeaf = (e: Entry, rt: DoorRt) => {
    const bundle = e.detail!.group;
    // Hide the baked leaf/back (batched shell OR bundle fallback handle this) while
    // the dynamic swinging leaf is up. rt.bakedLeaf flags that they're hidden so a
    // close restores them; the actual meshes live in the shell/batch, not here.
    e.detail!.setDoorLeavesVisible(false);
    rt.bakedLeaf = e.detail! as unknown as THREE.Mesh; // sentinel: leaves are hidden
    rt.bakedBack = null;
    // Three's WebGPU source-material listeners otherwise make a process-wide
    // shared material retain every retired dynamic door RenderObject. Clone the
    // few templates per open door; programs remain shared, while disposal has a
    // precise lifetime boundary.
    const owned = new Map<THREE.Material, THREE.Material>();
    const own = (source: THREE.Material): THREE.Material => {
      let material = owned.get(source);
      if (!material) {
        material = source.clone();
        owned.set(source, material);
      }
      return material;
    };
    const leafSource = materials["citygen.doorleaf"] ?? materials["citygen.door"];
    const leafMat = own(leafSource);
    const panelMat = own(materials["citygen.door.panel"] ?? leafSource);
    const hardwareMat = own(materials["citygen.door.hardware"] ?? materials["int.frame"] ?? leafSource);
    rt.leafMaterials = [...owned.values()];
    const leaf = new THREE.Group();
    leaf.name = `cityGenDoor.${rt.id}`;
    leaf.userData.citygenDoorId = rt.id;
    leaf.userData.swing = rt.swing;
    // Scaled unit primitives keep every live door allocation-light while giving
    // the slab a readable silhouette: two raised panels, an escutcheon and knobs
    // on both faces (so it still looks intentional from inside the home).
    const boxPart = (name: string, mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number) => {
      const mesh = new THREE.Mesh(doorBoxGeo, mat);
      mesh.name = name;
      mesh.castShadow = true;
      enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
      mesh.receiveShadow = true;
      mesh.position.set(x, y, z);
      mesh.scale.set(w, h, d);
      leaf.add(mesh);
    };
    const y0 = 0.02;
    boxPart("citygen.doorleaf.dynamic", leafMat, rt.w / 2, y0 + rt.h / 2, 0, rt.w, rt.h, DOOR_LEAF_T);
    const panelW = Math.max(0.42, rt.w * 0.58);
    const panelH = Math.max(0.38, rt.h * 0.25);
    const panelX = rt.w * 0.45;
    const panelD = DOOR_LEAF_T + 0.025;
    boxPart("citygen.door.panel.upper", panelMat, panelX, y0 + rt.h * 0.68, 0, panelW, panelH, panelD);
    boxPart("citygen.door.panel.lower", panelMat, panelX, y0 + rt.h * 0.29, 0, panelW, panelH, panelD);
    const handleX = rt.w * 0.83, handleY = y0 + rt.h * 0.51;
    boxPart("citygen.door.hardware.plate", hardwareMat, handleX, handleY, 0, 0.095, 0.22, DOOR_LEAF_T + 0.04);
    const knobR = 0.07;
    for (const side of [-1, 1]) {
      const knob = new THREE.Mesh(doorKnobGeo, hardwareMat);
      knob.name = side < 0 ? "citygen.door.hardware.outer" : "citygen.door.hardware.inner";
      knob.castShadow = true;
      enableShadowLayer(knob, SHADOW_LAYERS.HERO_DYNAMIC);
      knob.position.set(handleX, handleY, side * (DOOR_LEAF_T / 2 + knobR * 0.65));
      knob.scale.setScalar(knobR);
      leaf.add(knob);
    }
    // sit the hinge where the detail mesh actually drew the doorway: the bundle is
    // scaled ~0.6% proud of the true footprint (z-fight offset in assembleBuilding),
    // so run the proud world hinge through its matrix and inherit its scale — no
    // centimetre pop or slight shrink when the baked mesh hands off to the live one.
    leaf.position.set(rt.hx + rt.ox * DOOR_FACE_OFFSET, rt.sill, rt.hz + rt.oz * DOOR_FACE_OFFSET).applyMatrix4(bundle.matrix);
    leaf.scale.setFromMatrixScale(bundle.matrix);
    leaf.rotation.y = rt.baseYaw - rt.swing;
    doorRoot.add(leaf);
    rt.leaf = leaf;
  };
  const disposeLeaf = (rt: DoorRt) => {
    if (rt.leaf) {
      doorRoot.remove(rt.leaf);
      rt.leaf.clear();
    }
    for (const material of rt.leafMaterials) material.dispose();
    rt.leafMaterials.length = 0;
    rt.leaf = null;
  };
  // door-gapped walls out, SOLID walls back in — ATOMIC (same frame), and never
  // while the player occupies the gap (anti-wedge, same convention as the coll
  // tier's playerInsideBB guard: retried from update() via needSolid).
  const trySolidify = (e: Entry, rt: DoorRt) => {
    if (e.state !== "detail") { rt.needSolid = false; return; } // dropped — dropDetail owns the bodies
    if (playerInGap(rt)) { rt.needSolid = true; return; }
    rt.needSolid = false;
    clearWalls(e);
    buildSolidWallsNow(e, true); // detail tier: steps stay tangible across the swap
    e.doorPending = true;
  };
  // Complete the visual/logical close only AFTER solid walls actually land. This
  // keeps debug/UI state truthful and never paints a closed backing over a still-
  // passable gap while an occupant delays solidification.
  const restoreClosedVisual = (e: Entry, rt: DoorRt) => {
    e.doorPending = true;
    if (e.detail && rt.bakedLeaf) { e.detail.setDoorLeavesVisible(true); rt.bakedLeaf = null; rt.bakedBack = null; }
    disposeLeaf(rt);
  };
  // Leaf reached the frame: request solid walls, then restore the baked closed
  // visual. If occupied, advanceDoors retries and performs the visual handoff once
  // the wall swap succeeds.
  const finishClose = (e: Entry, rt: DoorRt) => {
    if (!e.doorPending) trySolidify(e, rt);
    else rt.needSolid = false;
    if (rt.needSolid) markDoorActive(e);
    else restoreClosedVisual(e, rt);
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
    if (rt.bakedLeaf) { e.detail?.setDoorLeavesVisible(true); rt.bakedLeaf = null; rt.bakedBack = null; } // detail being dropped; restore for tidiness

    rt.swing = 0; rt.from = 0; rt.to = 0; rt.t = 1;
    rt.animating = false;
    rt.needSolid = false;
    const idx = activeDoors.indexOf(e);
    if (idx >= 0) activeDoors.splice(idx, 1);
  };

  // Occupied buildings are allowed to exceed maxDetail by one (or, for malformed
  // overlaps, by the number actually occupied). Open doors within viewing range
  // are pinned too, so their furnished reveal cannot disappear while the player
  // steps back for an exterior look.
  const playerOccupiesDetail = (e: Entry): boolean => {
    const rt = e.door;
    if (rt && playerInGap(rt)) return true;
    if (rt && (!e.doorPending || rt.leaf)) {
      const dx = lastPlayer.x - rt.cx, dz = lastPlayer.z - rt.cz;
      if (dx * dx + dz * dz <= OPEN_INTERIOR_RETAIN * OPEN_INTERIOR_RETAIN) return true;
    }
    if (lastPlayer.y <= e.base - 1.5 || lastPlayer.y >= e.top + 1.0) return false;
    return signedDistToPoly(e.poly, lastPlayer.x, lastPlayer.z) >= -DETAIL_OCCUPANCY_MARGIN;
  };

  const dropDetail = (e: Entry) => {
    loaded.get(e.key)?.chunk?.setBuildingVisible(e.i, true);
    resetDoorRt(e); // dynamic leaf + door bookkeeping first (leaf must not outlive the mesh)
    disposeInterior(e);
    if (e.detail) { ctx.scene.remove(e.detail.group); e.detail.dispose(); e.detail = null; }
    detailSet.delete(e);
    clearBodies(e);
    // back to LOD: baked mesh hidden (R=1) but accurate baked collider live again.
    // If still within collider range the next scan re-swaps it to a tight "coll".
    ctx.tiles.unsuppressBuilding(e.key, e.i);
    ctx.tiles.suppressBuildingMesh(e.key, e.i);
    e.state = "lod"; e.fade = 0; e.fadeDir = 0; e.doorPending = true; e.pendingBuild = false;
  };
  const advanceFades = (dt: number) => {
    for (const e of detailSet) {
      if (!e.detail || e.fadeDir === 0) continue;
      // A fade request can predate this frame's doorway crossing. Cancel it before
      // any close/drop work if the player now occupies the home or its open reveal.
      if (e.fadeDir < 0 && playerOccupiesDetail(e)) e.fadeDir = 1;
      // fading out with the door open/mid-swing → snap it shut first, so the baked
      // leaf dithers away with the bundle and the walls settle back to solid
      if (e.fadeDir < 0 && (!e.doorPending || e.door?.leaf)) closeDoorNow(e);
      e.fade += e.fadeDir * (dt / CT.fadeTime);
      // at fade end the door stays CLOSED (solid walls) — the player opens it with E
      if (e.fadeDir > 0 && e.fade >= 1) {
        e.fade = 1; e.fadeDir = 0; e.detail.setOpacity(1);
        // The detailed shell is now fully opaque and owns this silhouette. Hide
        // only its merged LOD prism so real door/window holes reveal the room.
        loaded.get(e.key)?.chunk?.setBuildingVisible(e.i, false);
      }
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
        // Someone stepping into the aperture during a close wins: reverse the
        // visual immediately and keep the gapped colliders. The previous code
        // finished closing visually, then merely deferred the wall swap, leaving
        // a person intersecting a baked door even though physics still let them pass.
        if (rt.to === 0 && (playerInGap(rt) || playerInLeafSweep(rt))) retargetSwing(rt, DOOR_SWING);
        const duration = Math.max(0.08, DOOR_SWING_TIME * Math.abs(rt.to - rt.from) / DOOR_SWING);
        rt.t = Math.min(1, rt.t + dt / duration);
        const k = 1 - (1 - rt.t) ** 3; // ease-out cubic
        rt.swing = rt.from + (rt.to - rt.from) * k;
        if (rt.leaf) {
          rt.leaf.rotation.y = rt.baseYaw - rt.swing;
          rt.leaf.userData.swing = rt.swing;
        }
        // Opening is visual first, physical second: retain the solid wall until
        // the panel is clearly ajar, then atomically expose the walk-through gap.
        if (rt.to === DOOR_SWING && e.doorPending && rt.swing >= DOOR_PASSABLE_AT) openDoorway(e);
        if (rt.to === 0 && !e.doorPending && rt.swing <= DOOR_PASSABLE_AT) trySolidify(e, rt);
        if (rt.t >= 1) {
          rt.animating = false;
          rt.swing = rt.to;
          if (rt.to === 0) finishClose(e, rt);
        }
      }
      if (!rt.animating && rt.needSolid) {
        trySolidify(e, rt); // player was in the gap — retry
        if (!rt.needSolid && rt.swing === 0) restoreClosedVisual(e, rt);
      }
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
  const ensureInterior = (e: Entry) => {
    if (e.interior || e.state !== "detail" || !e.bodies.length) return;
    const it = buildInterior(e as BuildingSpec, materials, e.detail?.windows ?? []);
    ctx.scene.add(it.group);
    for (const c of it.colliders) e.intBodies.push(addBody(c));
    e.intBoxes = it.colliders;
    e.interior = it;
    // "look out the window": hide THIS building's exterior shell + instanced
    // glass so the real city shows through the interior shell's real window
    // holes instead of the painted parallax pane. Neighbours keep their shells.
    e.detail?.setShellHidden(true);
    e.detail?.setGlassHidden(true);
  };
  const gateInterior = (e: Entry, p: THREE.Vector3, wasCameraInside: boolean) => {
    if (e.state !== "detail") return; // only faded-in detail buildings have interiors
    const rt = e.door;
    const openReveal = !!rt && (!e.doorPending || !!rt.leaf);
    const broadMargin = openReveal ? OPEN_INTERIOR_RETAIN : 4;
    // broad-phase: outside the (inflated) AABB by a clear margin → definitely out
    if (p.x < e.bb.minx - broadMargin || p.x > e.bb.maxx + broadMargin || p.z < e.bb.minz - broadMargin || p.z > e.bb.maxz + broadMargin) {
      if (e.interior) {
        if (openReveal) closeDoorNow(e);
        disposeInterior(e);
      }
      return;
    }
    const inY = p.y > e.base - 1.5 && p.y < e.top + 1.0;
    const d = signedDistToPoly(e.poly, p.x, p.z); // + inside, − outside (metres)
    // Negative signed-distance tolerance exists only at an OPEN doorway. A
    // capsule stopped by the closed wall rests ~0.6 m outside—inside the old
    // unconditional 0.75 m dilation—so merely walking into a shut door built the
    // interior and flipped cameras. True polygon interior (d>=0) remains valid in
    // every state; doorway/exit hysteresis belongs to this open entry only.
    const entryMargin = openReveal ? GATE_DILATE : 0;
    const cameraMargin = openReveal && wasCameraInside ? CAMERA_EXIT : entryMargin;
    const inside = inY && d >= -entryMargin;
    const cameraInside = inY && d >= -cameraMargin;
    if (cameraInside) insideBuilding = e;
    if (inside) ensureInterior(e);
    else if (e.interior && d < -GATE_DISPOSE) {
      if (openReveal && d >= -OPEN_INTERIOR_RETAIN) return;
      if (openReveal) closeDoorNow(e);
      disposeInterior(e);
    }
  };

  // ---- cell load / unload -----------------------------------------------------
  const disposeCellChunk = (cell: CellState) => {
    cell.frontGateHandle?.cancel();
    cell.frontGateHandle = undefined;
    cell.chunk?.mesh?.removeFromParent();
    cell.chunk?.shadowMesh?.removeFromParent();
    cell.chunk?.dispose();
    cell.chunk = null;
  };
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
  const retireEntry = (e: Entry) => {
    if (e.detail || e.state === "detail") dropDetail(e);
    else if (e.state === "coll") dropExactCollider(e);
    e.pendingBuild = false; // orphan any in-flight worker build (reply is dropped)
    ctx.tiles.unsuppressBuildingMesh(e.key, e.i); // restore baked mesh behind the chunk
    e.state = "lod";
    e.fade = 0;
    e.fadeDir = 0;
    e.doorPending = true;
    if (e.door) doorRegistry.delete(e.door.id);
    e.door = undefined;
  };
  const finishCellRetirement = (task: CellRetirement) => {
    const { cell } = task;
    // compileAsync is not cancellable. Do not dispose buffers/materials under
    // an active driver request; its completion is invalidated by loaded identity
    // and owns the final cleanup. Every non-active cell can retire immediately.
    if (activeChunkPrepare?.cell !== cell) disposeCellChunk(cell);
    retiringCells.delete(cell.key);
    trimMaterializedCells();
  };
  const finishCellRetirementNow = (task: CellRetirement) => {
    for (; task.cursor < task.cell.entries.length; task.cursor++) retireEntry(task.cell.entries[task.cursor]);
    finishCellRetirement(task);
  };
  const pumpCellRetirement = (): void | "again" => {
    if (disposed) {
      activeCellRetirement = null;
      retireQueue.length = 0;
      cellRetirementScheduled = false;
      return;
    }
    while (!activeCellRetirement) {
      const task = retireQueue.shift();
      if (!task) {
        cellRetirementScheduled = false;
        return;
      }
      if (retiringCells.get(task.cell.key) !== task) continue;
      activeCellRetirement = task;
    }
    const task = activeCellRetirement;
    let processed = 0;
    let heavy = 0;
    while (task.cursor < task.cell.entries.length && processed < CELL_RETIRE_SLICE) {
      const e = task.cell.entries[task.cursor];
      const isHeavy = !!e.detail || e.state === "detail" || e.state === "coll" || e.bodies.length > 0 || e.intBodies.length > 0;
      if (isHeavy && heavy >= CELL_RETIRE_HEAVY_SLICE) break;
      task.cursor++;
      retireEntry(e);
      processed++;
      if (isHeavy) heavy++;
    }
    if (task.cursor < task.cell.entries.length) return "again";
    finishCellRetirement(task);
    activeCellRetirement = null;
    if (retireQueue.length) return "again";
    cellRetirementScheduled = false;
    return;
  };
  const ensureCellRetirementPump = () => {
    if (cellRetirementScheduled || disposed || (!activeCellRetirement && retireQueue.length === 0)) return;
    cellRetirementScheduled = true;
    schedule("physics", pumpCellRetirement);
  };
  const unloadCell = (cell: CellState) => {
    if (retiringCells.has(cell.key)) return;
    // Detach from all live scans/build queues immediately; expensive per-entry
    // disposal and baked-mesh restoration then drain under the shared budget.
    loaded.delete(cell.key);
    // M12: an unloading cell leaves the front gate immediately (its entry must
    // not clamp the front or reveal a retiring mesh later).
    cell.frontGateHandle?.cancel();
    cell.frontGateHandle = undefined;
    // Stop old-region chunk draws immediately; resource destruction remains
    // sliced below so a teleport never performs a dense teardown in one frame.
    if (cell.chunk?.mesh) cell.chunk.mesh.visible = false;
    if (cell.chunk?.shadowMesh) cell.chunk.shadowMesh.visible = false;
    const idx = building.indexOf(cell);
    if (idx >= 0) building.splice(idx, 1);
    const task: CellRetirement = { cell, cursor: 0 };
    retiringCells.set(cell.key, task);
    retireQueue.push(task);
    ensureCellRetirementPump();
  };
  const cellRequestWithinRange = (request: CellRequest) =>
    !disposed &&
    request.generation === cellGeneration &&
    Math.abs(request.ix - centerTileX) <= activeCellLoad &&
    Math.abs(request.iz - centerTileZ) <= activeCellLoad &&
    !loaded.has(request.key);
  const cellRequestIsCurrent = (request: CellRequest) =>
    cellRequestWithinRange(request) && pendingCells.get(request.key) === request.generation;
  const pumpCellHydration = (): void | "again" => {
    if (disposed) {
      activeCellHydration = null;
      cellQueue.length = 0;
      pendingCells.clear();
      cellHydrationScheduled = false;
      return;
    }

    // Skip requests made obsolete by a teleport/config range change. The packed
    // source stays immutable, so abandoning a partially hydrated cell is safe.
    if (activeCellHydration && !cellRequestIsCurrent(activeCellHydration)) {
      if (pendingCells.get(activeCellHydration.key) === activeCellHydration.generation) {
        pendingCells.delete(activeCellHydration.key);
      }
      activeCellHydration = null;
    }
    while (!activeCellHydration) {
      const request = cellQueue.shift();
      if (!request) {
        cellHydrationScheduled = false;
        return;
      }
      if (!cellRequestIsCurrent(request)) {
        if (pendingCells.get(request.key) === request.generation) pendingCells.delete(request.key);
        continue;
      }
      const cached = materializedCells.get(request.key);
      if (cached) {
        touchMaterializedCell(request.key, cached);
        pendingCells.delete(request.key);
        if (cached.length) loadCell(request.key, cached);
        if (cellQueue.length) return "again";
        cellHydrationScheduled = false;
        return;
      }
      const range = cellRanges.get(request.key);
      if (!range) {
        pendingCells.delete(request.key);
        continue;
      }
      activeCellHydration = { ...request, cursor: range[0], end: range[1], entries: [] };
    }

    const task = activeCellHydration;
    const sliceEnd = Math.min(task.end, task.cursor + CELL_HYDRATE_SLICE);
    for (; task.cursor < sliceEnd; task.cursor++) {
      const entry = materializeBuilding(task.key, task.cursor);
      if (entry) task.entries.push(entry);
    }
    if (task.cursor < task.end) return "again";

    // Publish a cell only after every Entry is ready. Until then the baked tile
    // remains visible, so sliced hydration cannot expose a partial block.
    touchMaterializedCell(task.key, task.entries);
    trimMaterializedCells();
    activeCellHydration = null;
    if (pendingCells.get(task.key) === task.generation) pendingCells.delete(task.key);
    if (cellRequestWithinRange(task) && task.entries.length) loadCell(task.key, task.entries);
    if (cellQueue.length) return "again";
    cellHydrationScheduled = false;
    return;
  };
  const ensureCellHydrationPump = () => {
    if (cellHydrationScheduled || disposed || (!activeCellHydration && cellQueue.length === 0)) return;
    cellHydrationScheduled = true;
    schedule("build", pumpCellHydration);
  };
  const cellWithinCurrentPrepareRing = (cell: CellState) =>
    loaded.get(cell.key) === cell &&
    Math.abs(cell.ix - centerTileX) <= activeCellLoad &&
    Math.abs(cell.iz - centerTileZ) <= activeCellLoad;
  const chunkPrepareIsCurrent = (task: ActiveChunkPrepare) =>
    !disposed &&
    activeChunkPrepare === task &&
    task.generation === cellGeneration &&
    task.cell.phase === "preparing" &&
    cellWithinCurrentPrepareRing(task.cell);

  // Publish only after the ACTUAL cell beauty owner has compiled. The shadow
  // proxy is deliberately not part of this prepare: it remains on the app's
  // already-booted depth-only path and attaches in the same atomic swap.
  const publishChunk = (cell: CellState) => {
    if (!cell.chunk?.mesh) throw new Error(`finished CityGen cell ${cell.key} has no beauty mesh`);
    const suppressed: Entry[] = [];
    try {
      ctx.scene.add(cell.chunk.mesh);
      if (cell.chunk.shadowMesh) ctx.scene.add(cell.chunk.shadowMesh);
      for (const e of cell.entries) if (e.state === "lod") {
        ctx.tiles.suppressBuildingMesh(e.key, e.i);
        suppressed.push(e);
      }
      cell.phase = "ready";
    } catch (error) {
      // Restore the complete baked side if any step of publication fails; a
      // half-suppressed cell is worse than retaining its lower-quality tile.
      cell.chunk.mesh.removeFromParent();
      cell.chunk.shadowMesh?.removeFromParent();
      for (const e of suppressed) ctx.tiles.unsuppressBuildingMesh(e.key, e.i);
      throw error;
    }
    applyCellFrontGate(cell);
  };

  // M12 front gate: a cell publishing beyond the sweeping materialize front
  // keeps its chunk mesh HIDDEN (the baked meshes it suppressed are equally
  // dark/gate-hidden out there, so the atomic swap stays invisible) and
  // registers with the shared frontGate, which reveals it — budgeted,
  // nearest-first — as the front approaches. Publication, residency
  // (materializedRadiusAround) and pipeline warm are untouched: visibility
  // only. Inert once the sweep settles (shouldHideRect false when inactive).
  const applyCellFrontGate = (cell: CellState) => {
    cell.frontGateHandle?.cancel();
    cell.frontGateHandle = undefined;
    const chunk = cell.chunk;
    if (!chunk?.mesh) return;
    const cellMinX = minX + cell.ix * tile;
    const cellMinZ = minZ + cell.iz * tile;
    if (frontGate.shouldHideRect(cellMinX, cellMinZ, cellMinX + tile, cellMinZ + tile)) {
      chunk.mesh.visible = false;
      if (chunk.shadowMesh) chunk.shadowMesh.visible = false;
      cell.frontGateHandle = frontGate.hide(
        cellMinX + tile / 2,
        cellMinZ + tile / 2,
        tile * Math.SQRT2 * 0.5,
        () => {
          cell.frontGateHandle = undefined;
          // Only reveal while this cell is still the live published owner.
          if (loaded.get(cell.key) !== cell || cell.phase !== "ready" || !cell.chunk?.mesh) return;
          cell.chunk.mesh.visible = true;
          if (cell.chunk.shadowMesh) cell.chunk.shadowMesh.visible = true;
        }
      );
    } else {
      chunk.mesh.visible = true;
      if (chunk.shadowMesh) chunk.shadowMesh.visible = true;
    }
  };

  const completeChunkPrepare = (task: ActiveChunkPrepare, prepared: boolean) => {
    if (activeChunkPrepare !== task) return;
    const current = chunkPrepareIsCurrent(task);
    activeChunkPrepare = null;
    const { cell } = task;
    if (prepared && current) {
      try {
        publishChunk(cell);
      } catch (error) {
        // Keep the complete baked fallback if publication itself cannot honor
        // the atomic swap. This cell remains ineligible for detail/colliders.
        cell.phase = "fallback";
        disposeCellChunk(cell);
        console.warn(`[citygen] prepared cell publication failed (${cell.key}); retaining baked city`, error);
      }
    } else if (current) {
      // A genuine prepare failure while still current is terminal for this cell.
      // Retrying a failing owner every scan would trade one hitch for a loop.
      cell.phase = "fallback";
      disposeCellChunk(cell);
    } else if (!disposed && loaded.get(cell.key) === cell) {
      // Teleport/latest-wins invalidated a non-cancellable compile. If the cell
      // remains loaded, leave it detached and eligible for the newly centered
      // nearest-first pass; otherwise retirement owns cleanup below.
      cell.phase = "awaiting-prepare";
    } else {
      disposeCellChunk(cell);
    }
    pumpChunkPrepare();
  };

  // Exactly one cell prepare can exist at a time. Completed cells themselves
  // are the bounded backlog (the loaded ring); no Promise/FIFO is created for
  // every finish. Re-selecting nearest to the current center after each result
  // makes a teleport latest-wins without special locations or device tuning.
  function pumpChunkPrepare() {
    if (disposed || activeChunkPrepare || !ctx.prepareRenderOwner) return;
    // Loop only over malformed completed cells; valid work returns immediately
    // after starting its sole Promise. This avoids recursive failure depth.
    while (true) {
      let nearest: CellState | null = null;
      let nearestD2 = Infinity;
      for (const cell of loaded.values()) {
        if (cell.phase !== "awaiting-prepare" || !cellWithinCurrentPrepareRing(cell)) continue;
        const d2 = (cell.ix - centerTileX) ** 2 + (cell.iz - centerTileZ) ** 2;
        if (d2 < nearestD2) { nearest = cell; nearestD2 = d2; }
      }
      if (!nearest) return;
      const mesh = nearest.chunk?.mesh;
      if (!mesh) {
        nearest.phase = "fallback";
        disposeCellChunk(nearest);
        continue; // a malformed cell must not strand valid cells behind it
      }
      nearest.phase = "preparing";
      const task: ActiveChunkPrepare = {
        cell: nearest,
        token: nextChunkPrepareToken++,
        generation: cellGeneration,
      };
      activeChunkPrepare = task;
      void prepareOwner(`chunk-lod:cell:${nearest.key}:${task.token}`, mesh, () => chunkPrepareIsCurrent(task))
        .then((prepared) => completeChunkPrepare(task, prepared), (error) => {
          // prepareOwner catches host/gate failures, but keep this terminal handler
          // so a future implementation change cannot create an unhandled Promise.
          if (chunkPrepareIsCurrent(task)) {
            exteriorPipelinePrepareFailures++;
            console.warn(`[citygen] detached cell prepare rejected (${task.cell.key})`, error);
          }
          completeChunkPrepare(task, false);
        });
      return;
    }
  }

  // A completed cell keeps its baked tile visible while the actual beauty mesh
  // prepares detached. Hosts without a prepare callback retain the portable,
  // immediate atomic swap used before this WebGPU-specific convergence gate.
  const finishChunk = (cell: CellState) => {
    if (!ctx.prepareRenderOwner) {
      publishChunk(cell);
      return;
    }
    cell.phase = "awaiting-prepare";
    pumpChunkPrepare();
  };

  return {
    get count() { return total; },
    applyFrontGate(): void {
      if (disposed) return;
      for (const cell of loaded.values()) {
        if (cell.phase === "ready") applyCellFrontGate(cell);
      }
    },
    materializedRadiusAround(x: number, z: number): number {
      // No grid / disposed → citygen never constrains. Before the first scan
      // (centerTile NaN, one frame at most) nothing is wanted yet either.
      if (!grid || disposed || Number.isNaN(centerTileX)) return Infinity;
      let r = Infinity;
      for (let ix = centerTileX - activeCellLoad; ix <= centerTileX + activeCellLoad; ix++) {
        for (let iz = centerTileZ - activeCellLoad; iz <= centerTileZ + activeCellLoad; iz++) {
          const key = `${ix}_${iz}`;
          if (!cellRanges.has(key)) continue; // no citygen content here
          const cached = materializedCells.get(key);
          if (cached && cached.length === 0) continue; // hydrated empty (all excluded)
          const cell = loaded.get(key);
          // "fallback" mirrors terminal tile failures: the baked city stands in
          // permanently, so the front must not stall on it.
          if (cell && (cell.phase === "ready" || cell.phase === "fallback")) continue;
          // blocking (queued / hydrating / chunk building / awaiting prepare):
          // distance from (x, z) to this cell's bounds constrains the front.
          const cellMinX = minX + ix * tile;
          const cellMinZ = minZ + iz * tile;
          const dx = Math.max(cellMinX - x, 0, x - (cellMinX + tile));
          const dz = Math.max(cellMinZ - z, 0, z - (cellMinZ + tile));
          const d = Math.hypot(dx, dz);
          if (d < r) r = d;
        }
      }
      return r;
    },
    update(playerPos, dt) {
      if (disposed) return;
      const ptx = Math.floor((playerPos.x - minX) / tile);
      const ptz = Math.floor((playerPos.z - minZ) / tile);
      const destinationChanged = ptx !== centerTileX || ptz !== centerTileZ;
      if (destinationChanged) {
        centerTileX = ptx;
        centerTileZ = ptz;
        cellGeneration++;
        // Invalidate origin work before ANY per-frame chunk/scheduler producer
        // gets another turn. Force the relocation through the scan below instead
        // of waiting up to SCAN_EVERY after a teleport.
        cellQueue.length = 0;
        activeCellHydration = null;
        pendingCells.clear();
        accum = SCAN_EVERY;
        // Re-rank completed detached cells around the new destination. An
        // in-flight old-generation prepare remains serialized but cannot publish.
        pumpChunkPrepare();
      }
      // Smoothed player speed (m/s) throttles only NEW detail admission below.
      // Existing detail remains at the fixed authored quality/radius, so speeding
      // up cannot dissolve a district and slowing down cannot rebuild-wave it.
      if (dt > 1e-4) {
        const inst = lastPlayer.distanceTo(playerPos) / dt;
        if (inst < 200) speedEma += (inst - speedEma) * Math.min(1, dt * 2.5);
      }
      lastPlayer.copy(playerPos); // read by queued coll jobs (anti-wedge) + stale-build check
      // per-frame: interior gate + detail crossfade + chunk merging
      const previousInside = insideBuilding;
      insideBuilding = null;
      for (const e of detailSet) gateInterior(e, playerPos, e === previousInside);
      advanceFades(dt);
      advanceDoors(dt);
      if (building.length && !destinationChanged) {
        const cell = building[0]; // one cell slice per frame (bounded, no hitch)
        cell.chunk!.pump(CHUNK_BUDGET);
        if (cell.chunk!.done) { finishChunk(cell); building.shift(); }
      }

      accum += dt;
      if (accum < SCAN_EVERY) return;
      accum = 0;

      // read the live-tunable knobs fresh each scan (dragging a "/" slider re-tunes now).
      // Chunk MESH reach is capped at CHUNK_VISUAL_RADIUS so a large draw-distance
      // vista doesn't stream hundreds of prism cells (Corona/meadow tris). Baked
      // OSM tiles still cover the farther skyline. Unload one cell further out.
      const cellLoad = Math.max(
        1,
        Math.floor(Math.min(CONFIG.tileLoadRadius, CHUNK_VISUAL_RADIUS) / tile)
      );
      activeCellLoad = cellLoad;
      pumpChunkPrepare();
      const cellUnload = cellLoad + 1;
      // Fixed visual retention/exit band: no runtime quality contraction.
      const detailR = CT.detailRadius;
      const detailExit = detailR + DETAIL_EXIT_MARGIN, detailExit2 = detailExit * detailExit;
      // A compact footprint-edge core is never sacrificed merely because a
      // large nearby facade costs more than the remainder of the legacy outer
      // budget. It still counts against maxDetail and spends that budget, so
      // this fixes close architecture without expanding the whole 700 m tier.
      const detailCoreR = Math.min(CT.detailCoreRadius, detailR);
      const detailCoreR2 = detailCoreR * detailCoreR;
      // Fast traversal can still avoid starting work that will be passed before
      // it finishes. This affects candidates only; holders use detailR/detailExit.
      const speedT = Math.min(1, Math.max(0, (speedEma - 18) / 22));
      const admissionFloor = Math.min(160, detailR);
      const admissionR = detailR * (1 - speedT) + admissionFloor * speedT;
      const admissionR2 = admissionR * admissionR;
      lastAdmissionRadius = admissionR;
      lastDetailCoreRadius = detailCoreR;
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
      pruneDetailBuildBacklog();
      // Queue cells center-out. Hydration computes live terrain grade only for
      // destination cells, one host build-lane job at a time. A later teleport
      // changes generation before stale jobs can materialize origin geometry.
      const wantedCells: CellRequest[] = [];
      for (let ix = ptx - cellLoad; ix <= ptx + cellLoad; ix++) {
        for (let iz = ptz - cellLoad; iz <= ptz + cellLoad; iz++) {
          const key = `${ix}_${iz}`;
          if (!cellRanges.has(key) || loaded.has(key) || retiringCells.has(key)) continue;
          if (materializedCells.has(key) && materializedCells.get(key)!.length === 0) continue;
          if (pendingCells.get(key) === cellGeneration) continue;
          wantedCells.push({ key, ix, iz, d2: (ix - ptx) ** 2 + (iz - ptz) ** 2, generation: cellGeneration });
        }
      }
      wantedCells.sort((a, b) => a.d2 - b.d2);
      for (const cellRequest of wantedCells) {
        pendingCells.set(cellRequest.key, cellRequest.generation);
        cellQueue.push(cellRequest);
      }
      ensureCellHydrationPump();

      // Two tiers within the fixed detail ring: current holders retain authored
      // quality throughout it, while only NEW candidates use admissionR. The
      // nearest-N admitted candidates get the full grammar MESH (budgeted,
      // expensive); everyone else in range gets a tight exact-poly COLLIDER (cheap)
      // so the car never hits the loose baked box on a building drawn as its prism.
      //
      // Slots are a true nearest-N, not first-come. A wide detailRadius can cover
      // hundreds of buildings; without eviction the cap fills with far ones and
      // nearby façades stay as chunk prisms forever (and raising maxDetail only
      // helps after a long drive frees slots). Rank everyone in range, keep the
      // closest maxDetail, fade the rest. Fading-out holders do NOT count toward
      // the cap, so a nearer candidate can start building while the far one fades.
      type RankedDetail = {
        entry: Entry;
        centerDistance2: number;
        surfaceDistance2: number;
        sticky: boolean;
      };
      const candidates: RankedDetail[] = [];
      const haveDetail: RankedDetail[] = [];
      const wantColl: [Entry, number][] = [];
      let detailCoreEligible = 0;
      let detailCoreMissing = 0;
      for (const cell of loaded.values()) {
        if (cell.phase !== "ready") continue;
        for (const e of cell.entries) {
          const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
          const d2 = dx * dx + dz * dz;
          const surfaceDistance2 = footprintSurfaceDistance2(
            e.poly,
            e.bb,
            playerPos.x,
            playerPos.z,
            detailCoreR2,
          );
          const inCore = surfaceDistance2 <= detailCoreR2;
          if (inCore) {
            detailCoreEligible++;
            if (!e.detail) detailCoreMissing++;
          }
          if (e.detail) {
            haveDetail.push({
              entry: e,
              centerDistance2: d2,
              surfaceDistance2,
              sticky: e.fadeDir >= 0,
            });
          } else if (inCore || d2 < admissionR2) {
            candidates.push({
              entry: e,
              centerDistance2: d2,
              surfaceDistance2,
              sticky: false,
            });
          }
          if (!e.detail) {
            if (e.state === "lod") { if (d2 < collR2) wantColl.push([e, d2]); }
            else if (e.state === "coll" && d2 > collExit2) dropExactCollider(e);
          }
        }
      }
      lastDetailCoreEligible = detailCoreEligible;
      lastDetailCoreMissing = detailCoreMissing;

      // Rank holders + candidates by distance; nearest maxDetail earn/keep a slot.
      // Holders past detailExit are ranked but never kept (they must leave).
      //
      // ADMISSION HYSTERESIS (the "roof flicker" fix): a building already showing
      // detail and not fading out sorts as if ~13% nearer, so at the maxDetail /
      // cost-budget bubble a candidate must be clearly closer to bump it, and a
      // bumped holder can't re-qualify until the nearer crowd genuinely thins.
      // Without this dead-band a building whose rank hovered at the cap flip-flopped
      // admit<->evict every scan and never settled — a permanent alphaHash dither
      // dissolve on one façade/roof while its neighbours were solid. The bonus also
      // covers fading-IN holders so an in-flight fade can finish before it's evictable.
      const STICKY = 0.76; // ≈0.87² on squared distance → ~13% linear dead-band
      const ranked = haveDetail.concat(candidates);
      ranked.sort((a, b) => compareDetailAdmission(a, b, detailCoreR2, STICKY));
      const keep = new Set<Entry>();
      // Occupancy/reveal safety outranks the nearest-N cap. This prevents a large
      // building (centroid far from its doorway) from fading around its player.
      for (const { entry } of haveDetail) if (playerOccupiesDetail(entry)) keep.add(entry);
      const costOf = (e: Entry): number => {
        if (e.cost === undefined) {
          // Entry hydration normally guarantees this. Keep the cache invariant
          // explicit so a future alternate source can never permanently price a
          // sloped building from baked `base` before live grade is available.
          if (e.grade === undefined) e.grade = footprintGrade(e.poly, e.base, e.top, ctx.map);
          let per = 0;
          for (let k = 0; k < e.poly.length; k++) {
            const [x0, z0] = e.poly[k], [x1, z1] = e.poly[(k + 1) % e.poly.length];
            per += Math.hypot(x1 - x0, z1 - z0);
          }
          e.cost = per * Math.max(1, (e.top - (e.grade ?? e.base)) / 3.5);
        }
        return e.cost;
      };
      let costLeft = DETAIL_COST_BUDGET;
      for (const { entry: e, centerDistance2, surfaceDistance2 } of ranked) {
        if (keep.has(e)) { costLeft -= costOf(e); continue; }
        if (keep.size >= maxDetail) break;
        const inCore = surfaceDistance2 <= detailCoreR2;
        if (!inCore && centerDistance2 > detailExit2) continue; // past both retention bands
        const c = costOf(e);
        // Grandfather clause (second half of the flicker fix): a building that
        // ALREADY owns detail and isn't fading out skips the entry-band + cost-
        // budget gates — those gate NEW admissions only. Re-evicting a holder
        // because the facade-area budget was momentarily tight was the other
        // flip-flop source: a big building on the cost bubble rebuilt, fade-
        // dithered, got cost-evicted, rebuilt… forever. A holder now leaves ONLY
        // when it falls past detailExit2 (distance) or the sticky rank pushes it
        // past the count cap.
        const holder = e.detail && e.fadeDir >= 0;
        if (!holder && !shouldAdmitNewDetail(inCore, centerDistance2, admissionR2, c, costLeft)) continue;
        costLeft -= c;
        keep.add(e);
      }
      lastDetailCostUsed = DETAIL_COST_BUDGET - costLeft;
      // Drive fade direction from keep membership (not a separate distance hysteresis
      // that would fight eviction and flicker opacity every scan).
      for (const { entry: e, centerDistance2, surfaceDistance2 } of haveDetail) {
        if (keep.has(e)) {
          if (e.fadeDir < 0) e.fadeDir = 1; // reclaimed a slot → fade back in
        } else if (surfaceDistance2 > detailCoreR2 && centerDistance2 > detailExit2) {
          dropDetail(e); // past hard exit — free the slot now
        } else if (e.fadeDir >= 0) {
          // Restore the prism BEFORE detail opacity starts falling, preserving
          // the no-hole crossfade contract on eviction.
          loaded.get(e.key)?.chunk?.setBuildingVisible(e.i, true);
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
      for (const { entry: e } of ranked) {
        if (db <= 0 || detailCount >= maxDetail) break;
        if (!keep.has(e) || e.detail || e.pendingBuild) continue;
        if (!requestDetail(e)) break;
        db--; detailCount++;
      }
      // then tighten the nearest still-loose colliders (cheap; guard skips any that
      // just upgraded to detail this scan)
      wantColl.sort((a, b) => a[1] - b[1]);
      let cb = COLLIDER_BUDGET;
      for (const [e] of wantColl) { if (cb <= 0) break; if (e.state !== "lod") continue; ensureExactCollider(e); cb--; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // M12: no gate entry may outlive the ring (stale show() / front clamp).
      for (const cell of loaded.values()) {
        cell.frontGateHandle?.cancel();
        cell.frontGateHandle = undefined;
      }
      cellGeneration++;
      cellQueue.length = 0;
      activeCellHydration = null;
      pendingCells.clear();
      if (activeDetailBuild) clearTimeout(activeDetailBuild.timer);
      activeDetailBuild = null;
      detailBuildQueue.length = 0;
      buildWorker?.terminate();
      buildWorker = null;
      for (const e of detailBuildReservations) e.pendingBuild = false;
      detailBuildReservations.clear();
      detailBuildReservationOf.clear();
      // Teardown owns the whole world and must not leave scheduled bodies/meshes
      // behind. Finish both live and already-sliced retirements synchronously.
      for (const cell of [...loaded.values()]) finishCellRetirementNow({ cell, cursor: 0 });
      for (const task of [...retiringCells.values()]) finishCellRetirementNow(task);
      activeCellRetirement = null;
      retireQueue.length = 0;
      cellRetirementScheduled = false;
      moduleLayer.dispose();
      shellBatch.dispose();
      renderRoot.removeFromParent();
      chunkLODBeautyWarmup?.dispose();
      chunkLODBeautyWarmup = null;
      for (const material of new Set(Object.values(materials))) material.dispose();
      loaded.clear();
      materializedCells.clear();
      cellRanges.clear();
      excludedPacked.clear();
      building.length = 0;
      activeDoors.length = 0;
      doorRegistry.clear();
      ctx.scene.remove(doorRoot);
      doorBoxGeo.dispose();
      doorKnobGeo.dispose();
    },
    stats() {
      let buildings = 0, detail = 0, interiors = 0;
      let cellsReady = 0, cellsAwaitingPrepare = 0, cellsPreparing = 0;
      for (const cell of loaded.values()) {
        buildings += cell.entries.length;
        if (cell.phase === "ready") cellsReady++;
        else if (cell.phase === "awaiting-prepare") cellsAwaitingPrepare++;
        else if (cell.phase === "preparing") cellsPreparing++;
        for (const e of cell.entries) {
          if (e.detail) detail++;
          if (e.interior) interiors++;
        }
      }
      const shell = shellBatch.stats();
      return {
        total, cells: loaded.size, buildings, detail, interiors,
        exteriorPipelinesPrepared,
        exteriorPipelinePrepareFailures,
        exteriorPipelinePrepareCancellations,
        cellsReady,
        cellsAwaitingPrepare,
        cellsPreparing,
        activeChunkPrepare: activeChunkPrepare !== null,
        cellGeneration,
        hydrationQueued: cellQueue.length + (activeCellHydration ? 1 : 0),
        detailBuildQueued: detailBuildQueue.length,
        detailBuildActive: activeDetailBuild !== null,
        admissionRadius: lastAdmissionRadius,
        detailCoreRadius: lastDetailCoreRadius,
        detailCoreEligible: lastDetailCoreEligible,
        detailCoreMissing: lastDetailCoreMissing,
        detailCostUsed: lastDetailCostUsed,
        shellBatches: shell.batches,
        shellPreparedBatches: shell.preparedBatches,
        shellGeometryVertexCapacity: shell.geometryVertexCapacity,
        shellGeometryIndexCapacity: shell.geometryIndexCapacity,
      };
    },
    isPlayerInside() { return insideBuilding !== null; },
    refreshInteriors() {
      if (disposed) return 0;
      const active: Entry[] = [];
      for (const cell of loaded.values()) for (const e of cell.entries) {
        if (e.interior) active.push(e);
      }
      let rebuilt = 0;
      for (const e of active) {
        disposeInterior(e);
        ensureInterior(e);
        if (e.interior) rebuilt++;
      }
      return rebuilt;
    },
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
          hasDetail: !!e.detail, fade: Math.round(e.fade * 100) / 100, fadeDir: e.fadeDir,
          insideBB: x > e.bb.minx - 1 && x < e.bb.maxx + 1 && z > e.bb.minz - 1 && z < e.bb.maxz + 1 } as typeof out[number]);
      }
      out.sort((a, b) => a.d - b.d);
      return out;
    },
    debugColliders(walls, interiors, roofs) {
      walls.length = 0; interiors.length = 0;
      if (roofs) roofs.length = 0;
      for (const cell of loaded.values()) for (const e of cell.entries) {
        for (const c of e.wallBoxes) walls.push(c);
        for (const c of e.intBoxes) interiors.push(c);
        if (roofs && e.roofMesh) roofs.push(e.roofMesh);
      }
    },
    debugDoors() {
      const out: CityGenDoorProbe[] = [];
      for (const cell of loaded.values()) for (const e of cell.entries) {
        if (!e.detail) continue;
        const poly = ensureCCW(e.poly);
        const si = streetEdgeIndex(poly, e.streetEdge);
        const p0 = poly[si], p1 = poly[(si + 1) % poly.length];
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
        const length = Math.hypot(dx, dz);
        const grade = e.grade ?? e.base;
        if (!doorEligible({ isStreet: true, doorAllowed: e.doorAllowed, length, base: e.base, top: e.top, grade })) continue;
        const ux = dx / length, uz = dz / length;
        const nrm = edgeOutwardNormal(p0, p1);     // unit outward (x,z)
        const { tc, halfW, sill, openTop } = doorMetrics(length, e.base, e.top, grade);
        const dC = tc * length;                    // metres from p0 to door centre
        const rt = e.door ?? null;
        const phase: CityGenDoorProbe["phase"] = rt?.animating
          ? (rt.to === 0 ? "closing" : "opening")
          : (!e.doorPending ? "open" : "closed");
        out.push({
          archetype: e.archetype,
          center: [p0[0] + ux * dC, sill, p0[1] + uz * dC],
          inward: [-nrm[0], 0, -nrm[1]],
          along: [ux, 0, uz],
          dcenter: dC,
          sill, openTop, halfW, base: e.base, grade, top: e.top, length,
          open: !e.doorPending,
          phase, swing: rt?.swing ?? 0, passable: !e.doorPending, dynamicLeaf: !!rt?.leaf,
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
      if (rt.animating) {
        if (rt.to === 0) {
          // mid-close → swing back open (colliders are still gapped if this door
          // had become passable; a pre-threshold reversal stays solid until 28°)
          rt.needSolid = false;
          retargetSwing(rt, DOOR_SWING);
          markDoorActive(e);
          return "opened";
        }
        // A second press during opening asks it to close again. If the gap has
        // already gone live, retain the same anti-wedge refusal as a settled door.
        if (!e.doorPending && (playerInGap(rt) || playerInLeafSweep(rt))) return "blocked";
        retargetSwing(rt, 0);
        markDoorActive(e);
        return "closed";
      }
      if (e.doorPending) {
        // CLOSED → begin opening. Anti-wedge guard: if the solid walls never
        // materialized (finishDetail deferred them — player inside the footprint),
        // the later gapped set would spawn walls around the player.
        if (!e.bodies.length && playerInsideBB(e, 3.5)) return "blocked";
        rt.needSolid = false;
        // Materialize the room before removing its closed backing: the first open
        // frame now reveals a furnished interior, not an empty/see-through shell.
        ensureInterior(e);
        if (!rt.leaf) spawnLeaf(e, rt);
        retargetSwing(rt, DOOR_SWING);
        markDoorActive(e);
        return "opened";
      }
      // OPEN → close; refused while the player stands in the gap
      if (playerInGap(rt) || playerInLeafSweep(rt)) return "blocked";
      retargetSwing(rt, 0);
      markDoorActive(e);
      return "closed";
    },
  };
}
