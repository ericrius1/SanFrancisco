// Chinatown generated-building ring.
//
// Replaces the baked OSM buildings in the Chinatown core with procedurally
// generated Hong-Kong-style buildings (which is exactly what those blocks look
// like). The footprint list is precomputed offline by tools/export-chinatown.mjs
// from the baked colliders: each entry is { key, i, x, z, yaw, floors, length,
// width, seed } in game coordinates, where (key,i) is the OSM building the entry
// stands in for.
//
// Streaming: exteriors are cheap to DRAW (all buildings share 3 BatchedMesh
// pools) but each carries thousands of instance matrices, so we cannot hold all
// 500+ resident. Instead a distance ring loads a building (generate + suppress
// its OSM twin) within LOAD_R and unloads it (dispose + un-suppress the OSM twin
// so the distant baked city has no hole) beyond UNLOAD_R. Loads are budgeted per
// scan so arriving in Chinatown streams in over ~1 s instead of hitching.
//
// Interiors ride the per-building 40 m/80 m gate inside createGeneratedBuilding,
// nested within this coarser exterior ring — so any Chinatown building you walk
// up to is enterable, and nothing far away pays for it.
import type * as THREE from "three/webgpu";
import {
  createGeneratedBuilding,
  buildingPoolStats,
  type GeneratedBuilding,
} from "./index";

interface Entry {
  key: string; i: number;
  x: number; z: number; yaw: number;
  floors: number; length: number; width: number;
  seed: number;
  built: GeneratedBuilding | null;
  loading: boolean;
  /** set when the ring unloads a building whose async generate is still in flight */
  disposedWhileLoading?: boolean;
}

interface ChinatownData {
  center: { x: number; z: number };
  radius: number;
  buildings: Omit<Entry, "built" | "loading">[];
}

export interface Chinatown {
  count: number;
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): {
    total: number; loaded: number; loading: number;
    pools: ReturnType<typeof buildingPoolStats>;
  };
}

interface Tiles {
  suppressBuilding(key: string, index: number): void;
  unsuppressBuilding(key: string, index: number): void;
}

// Ring sizing. Each generated HK building carries ~8 k instance matrices, so the
// resident set is what costs memory + per-frame vertex throughput (draw calls
// stay at 3 regardless). LOAD_R 105 m holds ~60–70 dense Chinatown buildings
// (~0.5 M instances) — measured safe; 165 m / ~1.3 M instances lost the WebGPU
// device. MAX_LOADED is a hard ceiling so a dense pocket can't run memory away.
const LOAD_R = 105;      // generate + suppress OSM within this (metres)
const UNLOAD_R = 150;    // dispose + restore OSM beyond this (hysteresis gap)
const MAX_LOADED = 85;   // hard cap on concurrently resident generated buildings
const SCAN_EVERY = 0.2;  // seconds between ring re-scans
const LOAD_BUDGET = 3;   // max generations kicked off per scan (spreads hitches)

async function fetchData(url: string): Promise<ChinatownData | null> {
  try {
    const r = await fetch(url, { cache: "force-cache" });
    if (!r.ok) return null;
    return (await r.json()) as ChinatownData;
  } catch {
    return null;
  }
}

export async function createChinatown(
  opts: { url?: string },
  ctx: {
    scene: THREE.Object3D;
    physics: { world: any };
    map: { groundHeight(x: number, z: number): number };
    tiles: Tiles;
  }
): Promise<Chinatown> {
  const url = opts.url ?? "/buildinggen/chinatown.json";
  const data = await fetchData(url);
  const entries: Entry[] = (data?.buildings ?? []).map((b) => ({ ...b, built: null, loading: false }));

  let accum = 0;
  const loadR2 = LOAD_R * LOAD_R;
  const unloadR2 = UNLOAD_R * UNLOAD_R;

  const loadOne = (e: Entry, playerY: number) => {
    e.loading = true;
    // suppress the OSM twin up front so the baked mesh vanishes the instant the
    // tile is (or becomes) loaded — no double-draw during the async generate.
    ctx.tiles.suppressBuilding(e.key, e.i);
    const y = ctx.map.groundHeight(e.x, e.z);
    createGeneratedBuilding(
      {
        position: { x: e.x, y, z: e.z },
        yawRad: e.yaw,
        params: { floor: e.floors, length: e.length, width: e.width },
        seed: e.seed,
      },
      ctx
    ).then((b) => {
      e.loading = false;
      if (e.disposedWhileLoading) {
        // ring moved away before the async build resolved — undo immediately
        b.dispose();
        ctx.tiles.unsuppressBuilding(e.key, e.i);
        e.disposedWhileLoading = false;
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
    } else if (e.loading) {
      // build still in flight — flag it to undo on resolve
      e.disposedWhileLoading = true;
    }
  };

  return {
    count: entries.length,
    update(playerPos, dt) {
      accum += dt;
      if (accum < SCAN_EVERY) {
        // still tick interiors of already-loaded buildings every frame
        for (const e of entries) e.built?.update(playerPos, dt);
        return;
      }
      accum = 0;

      let budget = LOAD_BUDGET;
      let resident = 0; // built + in-flight, against MAX_LOADED
      // nearest-first so the closest holes fill before the far edge of the ring
      const wants: Entry[] = [];
      for (const e of entries) {
        const dx = playerPos.x - e.x, dz = playerPos.z - e.z;
        const d2 = dx * dx + dz * dz;
        if (e.built) {
          resident++;
          e.built.update(playerPos, dt);
          if (d2 > unloadR2) unloadOne(e);
        } else if (e.loading) {
          resident++;
          if (d2 > unloadR2) unloadOne(e); // cancel an in-flight load that left the ring
        } else if (d2 < loadR2) {
          wants.push(e);
        }
      }
      wants.sort((a, b) => {
        const da = (playerPos.x - a.x) ** 2 + (playerPos.z - a.z) ** 2;
        const db = (playerPos.x - b.x) ** 2 + (playerPos.z - b.z) ** 2;
        return da - db;
      });
      for (const e of wants) {
        if (budget <= 0 || resident >= MAX_LOADED) break;
        budget--; resident++;
        loadOne(e, playerPos.y);
      }
    },
    dispose() {
      for (const e of entries) unloadOne(e);
      entries.length = 0;
    },
    stats() {
      let loaded = 0, loading = 0;
      for (const e of entries) { if (e.built) loaded++; else if (e.loading) loading++; }
      return { total: entries.length, loaded, loading, pools: buildingPoolStats() };
    },
  };
}
