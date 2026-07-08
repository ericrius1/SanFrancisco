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
import { generate } from "../index";
import { buildBuilding, buildInterior } from "../render";
import { buildChunkLOD, type ChunkLOD } from "../render/chunkLod";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec } from "../core/types";

const READY = new Set(["victorian", "edwardian", "marina", "downtown", "soma"]);

const CELL_LOAD = 1;     // load chunks in the player's cell ± this (tile ≈ 800 m)
const CELL_UNLOAD = 2;   // dispose chunks beyond this (hysteresis)
const DETAIL_R = 95;     // full grammar + walk-in door + interior within this
const DETAIL_EXIT = 120; // detail fades back to the chunk prism beyond this
const MAX_DETAIL = 28;   // nearest-N full grammar meshes (expensive)
const DETAIL_BUDGET = 1; // detail builds per scan
const CHUNK_BUDGET = 260;// buildings merged into chunk geometry per frame (no hitch)
const SCAN_EVERY = 0.15;
const FADE_T = 0.4;

interface PhysWorld {
  createBox(o: { type: number; position: readonly [number, number, number]; halfExtents: readonly [number, number, number]; friction?: number }): number;
  setBodyTransform(h: number, p: readonly [number, number, number], q: readonly [number, number, number, number]): void;
  destroyBody(h: number): void;
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
  bodies: number[];              // walk-in colliders (detail tier only)
  interior: { group: THREE.Group; dispose(): void } | null;
  intBodies: number[];
  state: "lod" | "detail";       // lod = baked mesh hidden R=1 (collider kept); detail = R=0 + walk-in
}

interface CellState { key: string; ix: number; iz: number; entries: Entry[]; chunk: ChunkLOD | null; phase: "building" | "ready"; }

function boundsOf(poly: readonly (readonly [number, number])[]) {
  let x = 0, z = 0, minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [px, pz] of poly) { x += px; z += pz; if (px < minx) minx = px; if (px > maxx) maxx = px; if (pz < minz) minz = pz; if (pz > maxz) maxz = pz; }
  return { cx: x / poly.length, cz: z / poly.length, minx, maxx, minz, maxz };
}

interface GridData {
  tile: number; minX: number; minZ: number; tilesX: number; tilesZ: number;
  cells: Record<string, (BuildingSpec & { i: number })[]>;
}

export interface CityGenRing {
  count: number;
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): { total: number; cells: number; buildings: number; detail: number; interiors: number };
  debugBuildings(): { cx: number; cz: number; base: number; top: number; interior: boolean }[];
}

async function fetchGrid(url: string): Promise<GridData | null> {
  try { const r = await fetch(url, { cache: "force-cache" }); if (!r.ok) return null; return (await r.json()) as GridData; }
  catch { return null; }
}

export async function createCityGenRing(
  opts: { url?: string },
  ctx: { scene: THREE.Object3D; physics: { world: PhysWorld }; map: { groundHeight(x: number, z: number): number }; tiles: Tiles },
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
        return { ...b, key, cx: g.cx, cz: g.cz, bb: { minx: g.minx, maxx: g.maxx, minz: g.minz, maxz: g.maxz },
          detail: null, fade: 0, fadeDir: 0, bodies: [] as number[], interior: null, intBodies: [] as number[], state: "lod" as const } as Entry;
      });
      if (entries.length) { cellEntries.set(key, entries); total += entries.length; }
    }
  }
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0, minZ = grid?.minZ ?? 0;

  const loaded = new Map<string, CellState>();
  const building: CellState[] = []; // cells still merging their chunk
  let accum = 0;
  const detailR2 = DETAIL_R * DETAIL_R, detailExit2 = DETAIL_EXIT * DETAIL_EXIT;

  const addBody = (c: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }): number => {
    const h = ctx.physics.world.createBox({ type: 0, position: [c.x, c.y, c.z], halfExtents: [c.hx, c.hy, c.hz], friction: 0.8 });
    ctx.physics.world.setBodyTransform(h, [c.x, c.y, c.z], [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]);
    return h;
  };
  const clearBodies = (e: Entry) => { for (const h of e.bodies) ctx.physics.world.destroyBody(h); e.bodies.length = 0; };
  const disposeInterior = (e: Entry) => {
    if (e.interior) { ctx.scene.remove(e.interior.group); e.interior.dispose(); e.interior = null; }
    for (const h of e.intBodies) ctx.physics.world.destroyBody(h);
    e.intBodies.length = 0;
  };

  // ---- detail tier -----------------------------------------------------------
  const buildDetail = (e: Entry) => {
    const b = buildBuilding(e as BuildingSpec, materials);
    b.setOpacity(0);
    ctx.scene.add(b.group);
    e.detail = b; e.fade = 0; e.fadeDir = 1; e.state = "detail";
    // baked mesh+collider fully off; add per-edge walk-in walls + door
    ctx.tiles.suppressBuilding(e.key, e.i);
    const { colliders } = generate(e as BuildingSpec, true);
    for (const c of colliders) e.bodies.push(addBody(c));
  };
  const dropDetail = (e: Entry) => {
    disposeInterior(e);
    if (e.detail) { ctx.scene.remove(e.detail.group); e.detail.dispose(); e.detail = null; }
    clearBodies(e);
    // back to LOD: baked mesh hidden (R=1) but accurate baked collider live again
    ctx.tiles.unsuppressBuilding(e.key, e.i);
    ctx.tiles.suppressBuildingMesh(e.key, e.i);
    e.state = "lod"; e.fade = 0; e.fadeDir = 0;
  };
  const advanceFades = (dt: number) => {
    for (const cell of loaded.values()) for (const e of cell.entries) {
      if (!e.detail || e.fadeDir === 0) continue;
      e.fade += e.fadeDir * (dt / FADE_T);
      if (e.fadeDir > 0 && e.fade >= 1) { e.fade = 1; e.fadeDir = 0; e.detail.setOpacity(1); }
      else if (e.fadeDir < 0 && e.fade <= 0) dropDetail(e);
      else e.detail.setOpacity(e.fade);
    }
  };

  const gateInterior = (e: Entry, p: THREE.Vector3) => {
    const inside = e.state === "detail" && p.x > e.bb.minx - 1.2 && p.x < e.bb.maxx + 1.2 && p.z > e.bb.minz - 1.2 && p.z < e.bb.maxz + 1.2 && p.y > e.base - 1.5 && p.y < e.top + 1.0;
    if (inside && !e.interior && e.bodies.length) {
      const it = buildInterior(e as BuildingSpec, materials);
      ctx.scene.add(it.group);
      for (const c of it.colliders) e.intBodies.push(addBody(c));
      e.interior = it;
    } else if (!inside && e.interior) {
      const clear = p.x < e.bb.minx - 4 || p.x > e.bb.maxx + 4 || p.z < e.bb.minz - 4 || p.z > e.bb.maxz + 4;
      if (clear) disposeInterior(e);
    }
  };

  // ---- cell load / unload -----------------------------------------------------
  const loadCell = (key: string, entries: Entry[]) => {
    const [ix, iz] = key.split("_").map(Number);
    const cell: CellState = { key, ix, iz, entries, chunk: buildChunkLOD(entries as BuildingSpec[]), phase: "building" };
    loaded.set(key, cell);
    building.push(cell);
  };
  const unloadCell = (cell: CellState) => {
    for (const e of cell.entries) {
      if (e.detail || e.state === "detail") dropDetail(e);
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

      // unload cells beyond the ring
      for (const cell of [...loaded.values()]) {
        if (Math.abs(cell.ix - ptx) > CELL_UNLOAD || Math.abs(cell.iz - ptz) > CELL_UNLOAD) unloadCell(cell);
      }
      // load cells in range
      for (let cx = ptx - CELL_LOAD; cx <= ptx + CELL_LOAD; cx++) {
        for (let cz = ptz - CELL_LOAD; cz <= ptz + CELL_LOAD; cz++) {
          const key = `${cx}_${cz}`;
          if (loaded.has(key)) continue;
          const entries = cellEntries.get(key);
          if (entries) loadCell(key, entries);
        }
      }

      // detail tier: nearest-N ready-cell buildings within DETAIL_R
      let detailCount = 0;
      const wants: [Entry, number][] = [];
      for (const cell of loaded.values()) {
        if (cell.phase !== "ready") continue;
        for (const e of cell.entries) {
          const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
          const d2 = dx * dx + dz * dz;
          if (e.detail) {
            detailCount++;
            if (d2 > detailExit2 && e.fadeDir >= 0) e.fadeDir = -1;
            else if (d2 < detailR2 && e.fadeDir < 0) e.fadeDir = 1;
          } else if (d2 < detailR2) wants.push([e, d2]);
        }
      }
      wants.sort((a, b) => a[1] - b[1]);
      let db = DETAIL_BUDGET;
      for (const [e] of wants) { if (db <= 0 || detailCount >= MAX_DETAIL) break; buildDetail(e); db--; detailCount++; }
    },
    dispose() { for (const cell of [...loaded.values()]) unloadCell(cell); loaded.clear(); building.length = 0; },
    stats() {
      let buildings = 0, detail = 0, interiors = 0;
      for (const cell of loaded.values()) { buildings += cell.entries.length; for (const e of cell.entries) { if (e.detail) detail++; if (e.interior) interiors++; } }
      return { total, cells: loaded.size, buildings, detail, interiors };
    },
    debugBuildings() {
      const out: { cx: number; cz: number; base: number; top: number; interior: boolean }[] = [];
      for (const cell of loaded.values()) for (const e of cell.entries) if (e.detail) out.push({ cx: e.cx, cz: e.cz, base: e.base, top: e.top, interior: !!e.interior });
      return out;
    },
  };
}
