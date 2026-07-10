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
// Nothing here is destructible (only the baked layer is, and we hide that).
import type * as THREE from "three/webgpu";
import { buildingColliders, doorMetrics, doorEligible } from "../core/collider";
import { ensureCCW, streetEdgeIndex, edgeOutwardNormal } from "../core/footprint";
import { buildBuilding, buildInterior } from "../render";
import { buildChunkLOD, type ChunkLOD } from "../render/chunkLod";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec, ColliderBox } from "../core/types";
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
// cast. Keyed by the stepped-body handle so removal stays exact; a `tag` on a wall
// box routes a vehicle crash into it to the cosmetic chip path. Optional so the
// module stays portable to a host without a query world.
interface QuerySolidHost {
  addQuerySolid(id: number, box: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number; quat?: readonly [number, number, number, number] }, tag?: { key: string; i: number }): void;
  removeQuerySolid(id: number): void;
}
interface Tiles {
  suppressBuilding(key: string, index: number): void;
  unsuppressBuilding(key: string, index: number): void;
  suppressBuildingMesh(key: string, index: number): void;
  unsuppressBuildingMesh(key: string, index: number): void;
}
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
  /** door centre on the street edge, at the grade line (world x,y,z) */
  center: [number, number, number];
  /** unit vector pointing INTO the building (−outward normal) */
  inward: [number, number, number];
  /** unit vector along the street edge (p0→p1) */
  along: [number, number, number];
  /** metres from p0 to the door centre along the edge (for on-wall side tests) */
  dcenter: number;
  halfW: number; head: number; base: number; grade: number; top: number; length: number;
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
  ctx: { scene: THREE.Object3D; physics: { world: PhysWorld } & Partial<QuerySolidHost>; map: { groundHeight(x: number, z: number): number }; tiles: Tiles },
): Promise<CityGenRing> {
  const url = opts.url ?? "/citygen/buildings.json";
  const grid = await fetchGrid(url);
  const materials = buildCityGenMaterials();

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
          state: "lod" as const, doorPending: false } as Entry;
      });
      if (entries.length) { cellEntries.set(key, entries); total += entries.length; }
    }
  }
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0, minZ = grid?.minZ ?? 0;

  const loaded = new Map<string, CellState>();
  const building: CellState[] = []; // cells still merging their chunk
  let accum = 0;

  // `tag` (a wall's baked key:index) is passed for walls so a crash chips them;
  // omitted for interiors (nothing rams them). Every box is mirrored into the query
  // world regardless, so raycasts hit walls AND interior geometry.
  const addBody = (c: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; quat?: readonly [number, number, number, number] }, tag?: { key: string; i: number }): number => {
    const h = ctx.physics.world.createBox({ type: 0, position: [c.x, c.y, c.z], halfExtents: [c.hx, c.hy, c.hz], friction: 0.8 });
    const q: [number, number, number, number] = c.quat
      ? [c.quat[0], c.quat[1], c.quat[2], c.quat[3]]
      : [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)];
    ctx.physics.world.setBodyTransform(h, [c.x, c.y, c.z], q);
    ctx.physics.addQuerySolid?.(h, c, tag); // mirror into the raycast query world
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
  const ensureExactCollider = (e: Entry) => {
    if (e.state !== "lod") return;
    ctx.tiles.suppressBuilding(e.key, e.i); // baked mesh + loose collider off (R=0)
    // buildingColliders directly (not generate): colliders only, no throwaway mesh
    const { boxes } = buildingColliders(e as BuildingSpec, false); // SOLID (no door yet)
    for (const c of boxes) e.bodies.push(addBody(c, { key: e.key, i: e.i }));
    e.wallBoxes = boxes;
    e.state = "coll";
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
  const buildDetail = (e: Entry) => {
    const b = buildBuilding(e as BuildingSpec, materials);
    b.setOpacity(0);
    ctx.scene.add(b.group);
    e.detail = b; e.fade = 0; e.fadeDir = 1;
    ctx.tiles.suppressBuilding(e.key, e.i); // baked mesh + loose collider fully off
    // R6: DON'T open the door gap yet — the detail mesh (with its doorway hole) is
    // still transparent, and the chunk prism behind it is solid, so an open gap now
    // would be a walk-through in front of a solid-looking face. Keep SOLID walls up;
    // openDoorway() swaps in the door-gapped walls once the mesh has fully faded in.
    // Reuse the "coll" solid walls if we came from there; build them from "lod".
    if (!(e.state === "coll" && e.bodies.length)) {
      clearBodies(e);
      const { boxes } = buildingColliders(e as BuildingSpec, false); // SOLID, no door
      for (const c of boxes) e.bodies.push(addBody(c, { key: e.key, i: e.i }));
      e.wallBoxes = boxes;
    }
    e.doorPending = true;
    e.state = "detail";
  };
  // swap the solid street wall for the door-gapped one — called when the detail mesh
  // is fully opaque, so the visible doorway and the walk-through gap appear together.
  const openDoorway = (e: Entry) => {
    if (!e.doorPending) return;
    e.doorPending = false;
    clearBodies(e);
    const { boxes } = buildingColliders(e as BuildingSpec, true); // door gap cut
    for (const c of boxes) e.bodies.push(addBody(c, { key: e.key, i: e.i }));
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
    e.state = "lod"; e.fade = 0; e.fadeDir = 0; e.doorPending = false;
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
  const gateInterior = (e: Entry, p: THREE.Vector3) => {
    const inside = e.state === "detail" && p.x > e.bb.minx - 1.2 && p.x < e.bb.maxx + 1.2 && p.z > e.bb.minz - 1.2 && p.z < e.bb.maxz + 1.2 && p.y > e.base - 1.5 && p.y < e.top + 1.0;
    if (inside) insideBuilding = true;
    if (inside && !e.interior && e.bodies.length) {
      const it = buildInterior(e as BuildingSpec, materials);
      ctx.scene.add(it.group);
      for (const c of it.colliders) e.intBodies.push(addBody(c));
      e.intBoxes = it.colliders;
      e.interior = it;
    } else if (!inside && e.interior) {
      const clear = p.x < e.bb.minx - 4 || p.x > e.bb.maxx + 4 || p.z < e.bb.minz - 4 || p.z > e.bb.maxz + 4;
      if (clear) disposeInterior(e);
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

  return {
    count: total,
    update(playerPos, dt) {
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
      // Active (not fading-out) detail count — fading holders don't block new builds.
      let detailCount = 0;
      for (const cell of loaded.values()) {
        for (const e of cell.entries) if (e.detail && e.fadeDir >= 0) detailCount++;
      }
      let db = detailBudget;
      for (const [e] of ranked) {
        if (db <= 0 || detailCount >= maxDetail) break;
        if (!keep.has(e) || e.detail) continue;
        buildDetail(e); db--; detailCount++;
      }
      // then tighten the nearest still-loose colliders (cheap; guard skips any that
      // just upgraded to detail this scan)
      wantColl.sort((a, b) => a[1] - b[1]);
      let cb = COLLIDER_BUDGET;
      for (const [e] of wantColl) { if (cb <= 0) break; if (e.state !== "lod") continue; ensureExactCollider(e); cb--; }
    },
    dispose() { for (const cell of [...loaded.values()]) unloadCell(cell); loaded.clear(); building.length = 0; },
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
        const { tc, halfW, head } = doorMetrics(length, e.base, e.top);
        const dC = tc * length;                    // metres from p0 to door centre
        const y = Math.max(e.base, grade);
        out.push({
          archetype: e.archetype,
          center: [p0[0] + ux * dC, y, p0[1] + uz * dC],
          inward: [-nrm[0], 0, -nrm[1]],
          along: [ux, 0, uz],
          dcenter: dC,
          halfW, head, base: e.base, grade, top: e.top, length,
          bb: { ...e.bb },
        });
      }
      return out;
    },
  };
}
