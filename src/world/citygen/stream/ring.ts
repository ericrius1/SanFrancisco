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
import { buildBuilding, buildInterior } from "../render";
import { buildCityGenMaterials } from "../theme/materials";
import type { BuildingSpec } from "../core/types";

/** archetypes that currently have a bespoke decorator worth showing */
const READY = new Set(["victorian", "edwardian", "marina", "downtown", "soma"]);

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
  bb: { minx: number; maxx: number; minz: number; maxz: number }; // footprint bbox
  built: BuiltGroup | null;
  bodies: number[];
  interior: { group: THREE.Group; dispose(): void } | null;
  intBodies: number[];
  fade: number;      // 0..1 current crossfade opacity
  fadeDir: number;   // +1 fading in, -1 fading out, 0 settled
  bakedHidden: boolean; // baked twin currently suppressed
}

interface BuiltGroup { group: THREE.Group; setOpacity(o: number): void; dispose(): void; }

const FADE_T = 0.45; // seconds for a building to crossfade in/out

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
  stats(): { total: number; loaded: number; interiors: number };
  /** debug: currently-resident buildings (for headless entry tests) */
  debugBuildings(): { cx: number; cz: number; base: number; top: number; interior: boolean }[];
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
          const g = boundsOf(b.poly);
          return { ...b, key, cx: g.cx, cz: g.cz, bb: { minx: g.minx, maxx: g.maxx, minz: g.minz, maxz: g.maxz }, built: null, bodies: [] as number[], interior: null, intBodies: [] as number[], fade: 0, fadeDir: 0, bakedHidden: false } as Entry;
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

  const addBody = (c: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }): number => {
    const h = ctx.physics.world.createBox({ type: 0, position: [c.x, c.y, c.z], halfExtents: [c.hx, c.hy, c.hz], friction: 0.8 });
    ctx.physics.world.setBodyTransform(h, [c.x, c.y, c.z], [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]);
    return h;
  };

  // ---- crossfade lifecycle ---------------------------------------------------
  // Load: build the generated twin at opacity 0 OVER the still-visible baked twin,
  // fade it in, and suppress the baked twin only once fully opaque. Unload: restore
  // the baked twin, fade the generated one out, then dispose. Silhouettes match, so
  // the fade reads as detail resolving in/out — never a pop or shift.
  const loadOne = (e: Entry) => {
    const b = buildBuilding(e as BuildingSpec, materials);
    b.setOpacity(0);
    ctx.scene.add(b.group);
    e.built = b;
    e.fade = 0; e.fadeDir = 1; e.bakedHidden = false;
    const { colliders } = generate(e as BuildingSpec, true); // collide immediately
    for (const c of colliders) e.bodies.push(addBody(c));
    built.add(e);
  };

  const disposeInterior = (e: Entry) => {
    if (e.interior) { ctx.scene.remove(e.interior.group); e.interior.dispose(); e.interior = null; }
    for (const h of e.intBodies) ctx.physics.world.destroyBody(h);
    e.intBodies.length = 0;
  };

  // begin fading out (restore the baked twin underneath); dispose happens at fade 0
  const beginUnload = (e: Entry) => {
    if (e.fadeDir === -1) return;
    e.fadeDir = -1;
    if (e.bakedHidden) { ctx.tiles.unsuppressBuilding(e.key, e.i); e.bakedHidden = false; }
  };

  const finishUnload = (e: Entry) => {
    disposeInterior(e);
    if (e.built) { ctx.scene.remove(e.built.group); e.built.dispose(); e.built = null; }
    for (const h of e.bodies) ctx.physics.world.destroyBody(h);
    e.bodies.length = 0;
    if (e.bakedHidden) { ctx.tiles.unsuppressBuilding(e.key, e.i); e.bakedHidden = false; }
    e.fadeDir = 0; e.fade = 0;
    built.delete(e);
  };

  const advanceFades = (dt: number) => {
    for (const e of [...built]) {
      if (!e.built || e.fadeDir === 0) continue;
      e.fade += e.fadeDir * (dt / FADE_T);
      if (e.fadeDir > 0 && e.fade >= 1) {
        e.fade = 1; e.fadeDir = 0; e.built.setOpacity(1);
        if (!e.bakedHidden) { ctx.tiles.suppressBuilding(e.key, e.i); e.bakedHidden = true; }
      } else if (e.fadeDir < 0 && e.fade <= 0) {
        finishUnload(e);
      } else {
        e.built.setOpacity(e.fade);
      }
    }
  };

  // interior lazy gate: build only while the player is INSIDE the footprint,
  // dispose once they step out (nothing renders for a building nobody is in).
  const gateInterior = (e: Entry, p: THREE.Vector3) => {
    const inX = p.x > e.bb.minx - 1.2 && p.x < e.bb.maxx + 1.2;
    const inZ = p.z > e.bb.minz - 1.2 && p.z < e.bb.maxz + 1.2;
    const inY = p.y > e.base - 1.5 && p.y < e.top + 1.0;
    const inside = inX && inZ && inY;
    if (inside && !e.interior) {
      const it = buildInterior(e as BuildingSpec, materials);
      ctx.scene.add(it.group);
      for (const c of it.colliders) e.intBodies.push(addBody(c));
      e.interior = it;
    } else if (!inside && e.interior) {
      // hysteresis: only dispose once well clear of the footprint
      const clear = p.x < e.bb.minx - 4 || p.x > e.bb.maxx + 4 || p.z < e.bb.minz - 4 || p.z > e.bb.maxz + 4;
      if (clear) disposeInterior(e);
    }
  };

  return {
    count: total,
    update(playerPos, dt) {
      // interior gate runs every frame so entering a door is instant (cheap: only
      // the resident set, ~40, and it only builds meshes when actually inside)
      for (const e of built) gateInterior(e, playerPos);
      advanceFades(dt); // crossfade in/out every frame

      accum += dt;
      if (accum < SCAN_EVERY) return;
      accum = 0;

      // unload pass — begin fading out anything past the ring
      for (const e of built) {
        const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
        if (dx * dx + dz * dz > unloadR2) beginUnload(e);
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
            const dx = playerPos.x - e.cx, dz = playerPos.z - e.cz;
            const d2 = dx * dx + dz * dz;
            if (e.built) { if (e.fadeDir < 0 && d2 < loadR2) e.fadeDir = 1; continue; } // came back → fade back in
            if (d2 < loadR2) wants.push(e);
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
    dispose() { for (const e of [...built]) finishUnload(e); built.clear(); },
    stats() {
      let interiors = 0;
      for (const e of built) if (e.interior) interiors++;
      return { total, loaded: built.size, interiors };
    },
    debugBuildings() {
      return [...built].filter((e) => e.built).map((e) => ({ cx: e.cx, cz: e.cz, base: e.base, top: e.top, interior: !!e.interior }));
    },
  };
}
