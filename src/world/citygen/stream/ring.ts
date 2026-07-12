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
import { ensureCCW, streetEdgeIndex, edgeOutwardNormal, pointInPoly, signedDistToPoly } from "../core/footprint";
import { buildBuilding, buildInterior, assembleBuilding, warmupMaterials } from "../render";
import { buildChunkLOD, type ChunkLOD } from "../render/chunkLod";
import { createModuleLayer } from "../render/moduleLayer";
import { createShellBatchLayer } from "../render/shellBatch";
import { lodMaterial } from "../render/lod";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec, ColliderBox, ColliderMesh, MeshData, ModuleInstance } from "../core/types";
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
// Detail buildings cast shadows only inside this radius (+30 m exit hysteresis).
// The far CSM cascade ends at 350 m and reads through marine haze well before
// that; casters past ~220 m cost full cascade re-renders for invisible shadows.
const SHADOW_CAST_R = 220;
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
  setCastShadow(cast: boolean): void;
  setGlassHidden(hidden: boolean): void;
  /** hide/show the whole exterior shell while the player is inside (see
   *  render.ts BuiltBuilding.setShellHidden) */
  setShellHidden(hidden: boolean): void;
  setDoorLeavesVisible(vis: boolean): void;
  dispose(): void;
}

interface Entry extends BuildingSpec {
  key: string;
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
  // a grammar-build request is in flight on the worker (counts against the
  // detail cap; cleared on assemble, displacement is handled by normal eviction)
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
  bakedLeaf: THREE.Mesh | null;  // the bundle's merged "citygen.doorleaf" mesh
  bakedBack: THREE.Mesh | null;  // dedicated closed-only "citygen.doorback" occluder
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
  dispose(): void;
  stats(): { total: number; cells: number; buildings: number; detail: number; interiors: number };
  /** true while the player is inside a generated building (drives the indoor camera). */
  isPlayerInside(): boolean;
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

async function fetchGrid(url: string): Promise<GridData | null> {
  try { const r = await fetch(url, { cache: "force-cache" }); if (!r.ok) return null; return (await r.json()) as GridData; }
  catch { return null; }
}

export async function createCityGenRing(
  opts: { url?: string },
  ctx: { scene: THREE.Object3D; physics: { world: PhysWorld } & Partial<QuerySolidHost>; map: { groundHeight(x: number, z: number): number; surfaceType?(x: number, z: number): number }; tiles: Tiles; schedule?: ScheduleFn },
): Promise<CityGenRing> {
  const url = opts.url ?? "/citygen/buildings.json";
  const grid = await fetchGrid(url);
  const materials = buildCityGenMaterials();
  // instanced kit-of-parts windows: every detail building's panes/frames draw
  // as a handful of city-wide instanced meshes (see render/moduleLayer.ts)
  const moduleLayer = createModuleLayer(ctx.scene);
  // batched building SHELLS: walls/roof/trim/stoop/doors of every detail building
  // draw as ~a dozen city-wide BatchedMesh draws (was ~2384 bundle sub-draws), and
  // frustum-cull per instance (see render/shellBatch.ts). Sized off the detail cap.
  const shellBatch = createShellBatchLayer(ctx.scene, {
    capacity: Math.max(768, Math.ceil(CT.maxDetail * 1.5)),
  });
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
          detail: null, fade: 0, fadeDir: 0, bodies: [] as number[], wallBoxes: [] as ColliderBox[], roofBody: 0, roofMesh: null,
          interior: null, intBodies: [] as number[], intBoxes: [] as ColliderBox[],
          state: "lod" as const, doorPending: false, pendingBuild: false } as Entry;
      });
      if (entries.length) { cellEntries.set(key, entries); total += entries.length; }
    }
  }

  // Resolve the entrance facade against the complete footprint set, including
  // archetypes this ring does not currently render. The longest-edge fallback is
  // usually a good facade guess, but attached SF homes commonly share that edge
  // with their neighbour. Sampling a few metres outward rejects those party walls
  // before one consistent edge is handed to massing, colliders, doors and rooms.
  //
  // Footprints are indexed into every 32 m bin their AABB touches once at boot;
  // resolving a newly loaded entry is therefore local rather than O(city size).
  type StreetNeighbor = BuildingSpec & { cellKey: string };
  const STREET_BIN = 32;
  const streetBins = new Map<string, StreetNeighbor[]>();
  const streetBinKey = (ix: number, iz: number) => `${ix}_${iz}`;
  if (grid) {
    for (const [cellKey, list] of Object.entries(grid.cells)) for (const b of list) {
      const bb = boundsOf(b.poly);
      const neighbor = { ...b, cellKey } as StreetNeighbor;
      const ix0 = Math.floor(bb.minx / STREET_BIN), ix1 = Math.floor(bb.maxx / STREET_BIN);
      const iz0 = Math.floor(bb.minz / STREET_BIN), iz1 = Math.floor(bb.maxz / STREET_BIN);
      for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
        const key = streetBinKey(ix, iz);
        const bin = streetBins.get(key);
        if (bin) bin.push(neighbor); else streetBins.set(key, [neighbor]);
      }
    }
  }
  const sampleBlockedByNeighbor = (e: Entry, x: number, z: number): boolean => {
    const bin = streetBins.get(streetBinKey(Math.floor(x / STREET_BIN), Math.floor(z / STREET_BIN)));
    if (!bin) return false;
    for (const other of bin) {
      if (other.cellKey === e.key && other.i === e.i) continue;
      if (other.top <= e.base + 0.5 || e.top <= other.base + 0.5) continue;
      if (pointInPoly(other.poly, x, z)) return true;
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
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0, minZ = grid?.minZ ?? 0;

  const loaded = new Map<string, CellState>();
  const building: CellState[] = []; // cells still merging their chunk
  // Every entry that currently holds a detail mesh (≤ maxDetail + in-flight
  // fades). The per-frame loops (interior gate, fades) walk THIS, not every
  // loaded building — with a wide tileLoadRadius that's thousands of entries
  // per frame doing nothing but an early-out (measured ~8% of frame CPU).
  const detailSet = new Set<Entry>();
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
        if (e.state !== "detail" || e.bodies.length) return; // stale/duplicate (dropped, unloaded, or walls landed elsewhere)
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
  const pendingBuilds = new Map<number, Entry>();
  let nextBuildId = 1;
  try {
    buildWorker = new Worker(new URL("./buildWorker.ts", import.meta.url), { type: "module" });
    buildWorker.onmessage = (ev: MessageEvent<{ id: number; meshes: MeshData[]; instances?: ModuleInstance[]; matTable?: string[] }>) => {
      const { id, meshes, instances, matTable } = ev.data;
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
        finishDetail(e, assembleBuilding(e as BuildingSpec, { meshes, instances, matTable }, materials, moduleLayer, shellBatch));
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
    streetEdge: e.streetEdge, doorAllowed: e.doorAllowed,
    grade: e.grade, frontGround: e.frontGround, h: e.h, archetype: e.archetype, seed: e.seed,
  });
  const requestDetail = (e: Entry) => {
    // sample the live street terrain at the door front ONCE, before the mesh build:
    // the visible stoop steps (frontStoop) and the walkable ramp collider
    // (openDoorway → appendStoop) both read this same number, so steps ⟺ ramp.
    if (e.frontGround === undefined) e.frontGround = frontGroundFor(e);
    if (!buildWorker) {
      finishDetail(e, buildBuilding(e as BuildingSpec, materials, moduleLayer, shellBatch)); // sync fallback
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
      leaf: null, bakedLeaf: null, bakedBack: null,
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
    // SHARED door material (no per-building baked leaf to copy from now) → no new
    // pipeline, and it must never be disposed with the leaf
    const leafMat = materials["citygen.doorleaf"] ?? materials["citygen.door"];
    const panelMat = materials["citygen.door.panel"] ?? leafMat;
    const hardwareMat = materials["citygen.door.hardware"] ?? materials["int.frame"] ?? leafMat;
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
    if (rt.leaf) doorRoot.remove(rt.leaf);
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
  const loadCell = (key: string, entries: Entry[]) => {
    for (const e of entries) if (e.streetEdge === undefined) {
      const resolved = chooseExposedStreetEdge(e);
      e.streetEdge = resolved.edge;
      e.doorAllowed = resolved.doorAllowed;
    }
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
    geo.setAttribute("lodVisibility", new THREE.BufferAttribute(new Float32Array([1, 1, 1]), 1));
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
      // smoothed player speed (m/s) — fast traversal (flying, boost) shrinks the
      // effective detail radius below: at 400 m the ring would otherwise churn
      // builds/fades for buildings that blur past (measured fly-leg hitching)
      if (dt > 1e-4) {
        const inst = lastPlayer.distanceTo(playerPos) / dt;
        if (inst < 200) speedEma += (inst - speedEma) * Math.min(1, dt * 2.5);
      }
      lastPlayer.copy(playerPos); // read by queued coll jobs (anti-wedge) + stale-build check
      if (!warmupStarted) startWarmup(playerPos); // one-shot pipeline warmup rig
      // per-frame: interior gate + detail crossfade + chunk merging
      const previousInside = insideBuilding;
      insideBuilding = null;
      for (const e of detailSet) gateInterior(e, playerPos, e === previousInside);
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
      // Chunk MESH reach is capped at CHUNK_VISUAL_RADIUS so a large draw-distance
      // vista doesn't stream hundreds of prism cells (Corona/meadow tris). Baked
      // OSM tiles still cover the farther skyline. Unload one cell further out.
      const cellLoad = Math.max(
        1,
        Math.floor(Math.min(CONFIG.tileLoadRadius, CHUNK_VISUAL_RADIUS) / tile)
      );
      const cellUnload = cellLoad + 1;
      // fast traversal shrinks the detail ring: above ~18 m/s taper toward a
      // 160 m floor (street-level trim is unreadable at flight/boost speed, and
      // the build/fade churn of a full-radius ring was the fly-leg hitch source)
      const speedT = Math.min(1, Math.max(0, (speedEma - 18) / 22));
      const detailR = Math.max(Math.min(160, CT.detailRadius), CT.detailRadius * (1 - speedT) + 160 * speedT);
      const detailR2 = detailR * detailR;
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
      const rankKey = (e: Entry, d2: number) => (e.detail && e.fadeDir >= 0 ? d2 * STICKY : d2);
      const ranked = haveDetail.concat(candidates);
      ranked.sort((a, b) => rankKey(a[0], a[1]) - rankKey(b[0], b[1]));
      const keep = new Set<Entry>();
      // Occupancy/reveal safety outranks the nearest-N cap. This prevents a large
      // building (centroid far from its doorway) from fading around its player.
      for (const [e] of haveDetail) if (playerOccupiesDetail(e)) keep.add(e);
      const costOf = (e: Entry): number => {
        if (e.cost === undefined) {
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
      for (const [e, d2] of ranked) {
        if (keep.has(e)) { costLeft -= costOf(e); continue; }
        if (keep.size >= maxDetail) break;
        if (d2 > detailExit2) continue; // past the hard exit band — never kept
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
        if (!holder) {
          if (d2 > detailR2) continue; // candidates need the entry band
          if (c > costLeft) continue; // facade-area budget spent — skip big, keep filling small
        }
        costLeft -= c;
        keep.add(e);
      }
      // Shadow-caster diet: bundle children are frustumCulled=false, so every
      // detail building would re-render into every CSM cascade — beyond the far
      // cascade's readable range that's pure GPU burn (measured: the wall that
      // capped the detail ring at a few hundred buildings). Gate per building
      // with hysteresis; each flip is one cheap bundle re-record.
      const shadowR2 = SHADOW_CAST_R * SHADOW_CAST_R;
      const shadowExit2 = (SHADOW_CAST_R + 30) * (SHADOW_CAST_R + 30);
      for (const [e, d2] of haveDetail) {
        if (!e.detail) continue;
        if (d2 < shadowR2) e.detail.setCastShadow(true);
        else if (d2 > shadowExit2) e.detail.setCastShadow(false);
      }
      // Drive fade direction from keep membership (not a separate distance hysteresis
      // that would fight eviction and flicker opacity every scan).
      for (const [e, d2] of haveDetail) {
        if (keep.has(e)) {
          if (e.fadeDir < 0) e.fadeDir = 1; // reclaimed a slot → fade back in
        } else if (d2 > detailExit2) {
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
      moduleLayer.dispose();
      shellBatch.dispose();
      loaded.clear();
      building.length = 0;
      activeDoors.length = 0;
      doorRegistry.clear();
      ctx.scene.remove(doorRoot);
      doorBoxGeo.dispose();
      doorKnobGeo.dispose();
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
