// Citywide generated-building ring.
//
// Streams procedurally generated buildings across the WHOLE city: within LOAD_R
// of the player each qualifying OSM mid-rise is replaced by a generated building
// (generate + suppress the baked twin); beyond UNLOAD_R it is disposed and the
// baked twin restored, so the distant city is always whole. Towers / superblocks
// were filtered out at export time and keep their baked mesh.
//
// Source data (tools/export-buildings-citywide.mjs) is bucketed into the tile
// grid, so each scan only walks the handful of cells around the player instead of
// every building in the city. Buildings render as merged, frustum-culled meshes
// (pools.ts) — only the few on screen draw — and the resident set is capped
// (MAX_LOADED) for memory. Interiors ride the per-building 40 m/80 m gate inside
// createGeneratedBuilding, so any building you walk up to is enterable.
import type * as THREE from "three/webgpu";
import {
  createGeneratedBuilding,
  buildingPoolStats,
  type GeneratedBuilding,
} from "./index";

interface Entry {
  key: string; i: number;                 // (tileKey, index) of the baked OSM twin
  x: number; z: number; yaw: number;
  floors: number; length: number; width: number;
  seed: number;
  built: GeneratedBuilding | null;
  loading: boolean;
  disposedWhileLoading?: boolean;
}

interface GridData {
  tile: number; minX: number; minZ: number; tilesX: number; tilesZ: number;
  cells: Record<string, Omit<Entry, "key" | "built" | "loading">[]>;
}

export interface BuildingRing {
  count: number;
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): {
    total: number; loaded: number; loading: number;
    loadMs: { avg: number; p50: number; max: number; n: number } | null;
    pools: ReturnType<typeof buildingPoolStats>;
  };
}

interface Tiles {
  suppressBuilding(key: string, index: number): void;
  unsuppressBuilding(key: string, index: number): void;
}

const LOAD_R = 90;        // generate + suppress OSM within this (metres)
const UNLOAD_R = 130;     // dispose + restore OSM beyond this (hysteresis gap)
const MAX_LOADED = 40;    // hard ceiling on concurrently resident generated buildings
const SCAN_EVERY = 0.2;   // seconds between ring re-scans
const LOAD_BUDGET = 1;    // one generation per scan — spreads the merge hitch out
const CELL_RADIUS = 1;    // tiles around the player's cell to consider (tile≈800 m ≫ LOAD_R)

async function fetchGrid(url: string): Promise<GridData | null> {
  try {
    const r = await fetch(url, { cache: "force-cache" });
    if (!r.ok) return null;
    return (await r.json()) as GridData;
  } catch {
    return null;
  }
}

export async function createBuildingRing(
  opts: { url?: string },
  ctx: {
    scene: THREE.Object3D;
    physics: { world: any };
    map: { groundHeight(x: number, z: number): number };
    tiles: Tiles;
  }
): Promise<BuildingRing> {
  const url = opts.url ?? "/buildinggen/buildings-citywide.json";
  const grid = await fetchGrid(url);

  // materialize each cell's entries once (attach runtime state + tile key), keep
  // them indexed by cell for nearby-only scans.
  const cells = new Map<string, Entry[]>();
  let total = 0;
  if (grid) {
    for (const [key, list] of Object.entries(grid.cells)) {
      const entries = list.map((b) => ({ ...b, key, built: null as GeneratedBuilding | null, loading: false }));
      cells.set(key, entries);
      total += entries.length;
    }
  }
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0;
  const minZ = grid?.minZ ?? 0;
  const tilesX = grid?.tilesX ?? 0;
  const tilesZ = grid?.tilesZ ?? 0;

  const built = new Set<Entry>();          // currently loaded or loading
  const recentLoadMs: number[] = [];

  // Per-building style variety from the seed so blocks don't read uniform: window
  // family (wood vs steel vs mixed), curtain fullness, and roof-clutter density.
  // Deterministic (same building → same style across visits / clients).
  const styleParams = (seed: number) => {
    const r = (n: number) => (((seed ^ (seed >>> n)) >>> 0) % 1000) / 1000;
    return {
      windowType: 0.25 + r(3) * 0.7,        // 0.25..0.95 → varied wood/steel/mixed frames
      curtainClose: r(7) * 0.85,            // some blocks curtained, some bare
      roofProbability: 0.3 + r(11) * 0.6,   // varied rooftop clutter
      storeSign: 0.5 + r(13) * 0.5,         // most shopfronts signed
      objectOnRoof: 0.5 + r(17) * 0.5,
    };
  };
  let accum = 0;
  const loadR2 = LOAD_R * LOAD_R;
  const unloadR2 = UNLOAD_R * UNLOAD_R;

  const loadOne = (e: Entry) => {
    e.loading = true;
    built.add(e);
    ctx.tiles.suppressBuilding(e.key, e.i); // baked twin vanishes as soon as its tile is loaded
    const y = ctx.map.groundHeight(e.x, e.z);
    const t0 = performance.now();
    createGeneratedBuilding(
      { position: { x: e.x, y, z: e.z }, yawRad: e.yaw,
        params: { floor: e.floors, length: e.length, width: e.width, ...styleParams(e.seed) },
        seed: e.seed, detail: "low" },
      ctx
    ).then((b) => {
      e.loading = false;
      recentLoadMs.push(performance.now() - t0);
      if (recentLoadMs.length > 24) recentLoadMs.shift();
      if (e.disposedWhileLoading) {
        b.dispose();
        ctx.tiles.unsuppressBuilding(e.key, e.i);
        e.disposedWhileLoading = false;
        built.delete(e);
        return;
      }
      e.built = b;
    });
  };

  const unloadOne = (e: Entry) => {
    if (e.built) {
      e.built.dispose();
      e.built = null;
      ctx.tiles.unsuppressBuilding(e.key, e.i);
      built.delete(e);
    } else if (e.loading) {
      e.disposedWhileLoading = true; // undo when the in-flight build resolves
    }
  };

  return {
    count: total,
    update(playerPos, dt) {
      accum += dt;
      if (accum < SCAN_EVERY) {
        for (const e of built) e.built?.update(playerPos, dt);
        return;
      }
      accum = 0;

      // unload pass over the resident set
      for (const e of built) {
        if (e.built) {
          e.built.update(playerPos, dt);
          const dx = playerPos.x - e.x, dz = playerPos.z - e.z;
          if (dx * dx + dz * dz > unloadR2) unloadOne(e);
        } else if (e.loading) {
          const dx = playerPos.x - e.x, dz = playerPos.z - e.z;
          if (dx * dx + dz * dz > unloadR2) unloadOne(e);
        }
      }

      if (built.size >= MAX_LOADED) return;

      // load pass over the cells around the player only
      const ptx = Math.floor((playerPos.x - minX) / tile);
      const ptz = Math.floor((playerPos.z - minZ) / tile);
      const wants: Entry[] = [];
      for (let cx = ptx - CELL_RADIUS; cx <= ptx + CELL_RADIUS; cx++) {
        if (cx < 0 || cx >= tilesX) continue;
        for (let cz = ptz - CELL_RADIUS; cz <= ptz + CELL_RADIUS; cz++) {
          if (cz < 0 || cz >= tilesZ) continue;
          const list = cells.get(`${cx}_${cz}`);
          if (!list) continue;
          for (const e of list) {
            if (e.built || e.loading) continue;
            const dx = playerPos.x - e.x, dz = playerPos.z - e.z;
            if (dx * dx + dz * dz < loadR2) wants.push(e);
          }
        }
      }
      wants.sort((a, b) =>
        ((playerPos.x - a.x) ** 2 + (playerPos.z - a.z) ** 2) -
        ((playerPos.x - b.x) ** 2 + (playerPos.z - b.z) ** 2));
      let budget = LOAD_BUDGET;
      for (const e of wants) {
        if (budget <= 0 || built.size >= MAX_LOADED) break;
        budget--;
        loadOne(e);
      }
    },
    dispose() {
      for (const e of [...built]) unloadOne(e);
      built.clear();
    },
    stats() {
      let loaded = 0, loading = 0;
      for (const e of built) { if (e.built) loaded++; else if (e.loading) loading++; }
      const sorted = [...recentLoadMs].sort((a, b) => a - b);
      const loadMs = sorted.length
        ? { avg: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1),
            p50: +sorted[sorted.length >> 1].toFixed(1),
            max: +sorted[sorted.length - 1].toFixed(1), n: sorted.length }
        : null;
      return { total, loaded, loading, loadMs, pools: buildingPoolStats() };
    },
  };
}
