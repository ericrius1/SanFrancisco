// Citywide CityGen streaming ring.
//
// Streams generated buildings across the real city: within LOAD_R of the player,
// each qualifying OSM building (from tools/export-citygen.mjs, bucketed by tile)
// is generated + its baked twin suppressed; beyond UNLOAD_R it is disposed and
// the baked twin restored, so the distant city stays whole. Only archetypes that
// have a bespoke decorator render (Victorian/Edwardian today); everything else
// keeps its baked facade until its grammar lands. Loads are budgeted per scan so
// arriving in a district streams in over ~1 s instead of hitching.
//
// Generated buildings sit on the SAME footprint + height as their baked twin, so
// the swap is silhouette-identical (no "shift"). Each contributes precise per-edge
// wall + ground-pad colliders so you collide with the real geometry.
import type * as THREE from "three/webgpu";
import { generate } from "../index";
import { buildBuilding } from "../render";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec } from "../core/types";

/** archetypes that currently have a bespoke decorator worth showing */
const READY = new Set(["victorian", "edwardian"]);

const LOAD_R = 120;      // generate + suppress OSM within this (metres)
const UNLOAD_R = 170;    // dispose + restore OSM beyond this (hysteresis gap)
const MAX_LOADED = 48;   // hard ceiling on concurrently resident generated buildings
const SCAN_EVERY = 0.2;  // seconds between ring re-scans
const LOAD_BUDGET = 2;   // generations kicked off per scan (spreads the hitch)
const CELL_RADIUS = 1;   // tiles around the player's cell to consider

interface PhysWorld {
  createBox(o: { type: number; position: readonly [number, number, number]; halfExtents: readonly [number, number, number]; friction?: number }): number;
  setBodyTransform(h: number, p: readonly [number, number, number], q: readonly [number, number, number, number]): void;
  destroyBody(h: number): void;
}

interface Tiles {
  suppressBuilding(key: string, index: number): void;
  unsuppressBuilding(key: string, index: number): void;
}

interface Entry extends BuildingSpec {
  key: string;  // tile key of the baked twin
  cx: number; cz: number; // footprint centroid (for distance tests)
  built: { group: THREE.Group; dispose(): void } | null;
  bodies: number[];
}

function centroidOf(poly: readonly (readonly [number, number])[]): [number, number] {
  let x = 0, z = 0;
  for (const [px, pz] of poly) { x += px; z += pz; }
  return [x / poly.length, z / poly.length];
}

interface GridData {
  tile: number; minX: number; minZ: number; tilesX: number; tilesZ: number;
  cells: Record<string, (BuildingSpec & { i: number })[]>;
}

export interface CityGenRing {
  count: number;
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): { total: number; loaded: number; triangles: number };
}

async function fetchGrid(url: string): Promise<GridData | null> {
  try {
    const r = await fetch(url, { cache: "force-cache" });
    if (!r.ok) return null;
    return (await r.json()) as GridData;
  } catch { return null; }
}

export async function createCityGenRing(
  opts: { url?: string },
  ctx: { scene: THREE.Object3D; physics: { world: PhysWorld }; map: { groundHeight(x: number, z: number): number }; tiles: Tiles },
): Promise<CityGenRing> {
  const url = opts.url ?? "/citygen/buildings.json";
  const grid = await fetchGrid(url);
  const materials = buildCityGenMaterials();

  // materialize each cell's entries once (only the ready archetypes), indexed by cell
  const cells = new Map<string, Entry[]>();
  let total = 0;
  if (grid) {
    for (const [key, list] of Object.entries(grid.cells)) {
      const entries = list
        .filter((b) => READY.has(b.archetype))
        .map((b) => {
          const [cx, cz] = centroidOf(b.poly);
          return { ...b, key, cx, cz, built: null, bodies: [] as number[] } as Entry;
        });
      if (entries.length) { cells.set(key, entries); total += entries.length; }
    }
  }
  const tile = grid?.tile ?? 800;
  const minX = grid?.minX ?? 0, minZ = grid?.minZ ?? 0;
  const tilesX = grid?.tilesX ?? 0, tilesZ = grid?.tilesZ ?? 0;

  const built = new Set<Entry>();
  let accum = 0;
  const loadR2 = LOAD_R * LOAD_R, unloadR2 = UNLOAD_R * UNLOAD_R;

  const loadOne = (e: Entry) => {
    ctx.tiles.suppressBuilding(e.key, e.i);
    const b = buildBuilding(e as BuildingSpec, materials);
    ctx.scene.add(b.group);
    e.built = b;
    // precise per-edge colliders (world space already)
    const cols = generate(e as BuildingSpec).colliders;
    for (const c of cols) {
      const h = ctx.physics.world.createBox({ type: 0, position: [c.x, c.y, c.z], halfExtents: [c.hx, c.hy, c.hz], friction: 0.8 });
      ctx.physics.world.setBodyTransform(h, [c.x, c.y, c.z], [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]);
      e.bodies.push(h);
    }
    built.add(e);
  };

  const unloadOne = (e: Entry) => {
    if (e.built) { ctx.scene.remove(e.built.group); e.built.dispose(); e.built = null; }
    for (const h of e.bodies) ctx.physics.world.destroyBody(h);
    e.bodies.length = 0;
    ctx.tiles.unsuppressBuilding(e.key, e.i);
    built.delete(e);
  };

  return {
    count: total,
    update(playerPos, dt) {
      accum += dt;
      if (accum < SCAN_EVERY) return;
      accum = 0;

      // unload pass
      for (const e of built) {
        const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
        if (dx * dx + dz * dz > unloadR2) unloadOne(e);
      }
      if (built.size >= MAX_LOADED) return;

      // load pass over nearby cells
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
            if (e.built) continue;
            const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
            if (dx * dx + dz * dz < loadR2) wants.push(e);
          }
        }
      }
      wants.sort((a, b) =>
        ((playerPos.x - a.cx) ** 2 + (playerPos.z - a.cz) ** 2) -
        ((playerPos.x - b.cx) ** 2 + (playerPos.z - b.cz) ** 2));
      let budget = LOAD_BUDGET;
      for (const e of wants) {
        if (budget <= 0 || built.size >= MAX_LOADED) break;
        budget--;
        loadOne(e);
      }
    },
    dispose() { for (const e of [...built]) unloadOne(e); built.clear(); },
    stats() {
      let triangles = 0;
      for (const e of built) if (e.built) triangles += 0; // meshes carry their own; cheap stat
      return { total, loaded: built.size, triangles };
    },
  };
}
