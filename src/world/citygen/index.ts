// SF CityGen — portable, neighborhood-aware procedural building module.
//
// Replaced the vendored Hong-Kong/Kowloon kit (the old src/world/buildings +
// vendor/BuildingGenerator, now removed).
//
// Status: LIVE citywide. The engine (core/) turns a BuildingSpec built on the
// REAL OSM footprint into geometry (footprint-faithful → no "shift") + colliders;
// the SF theme pack (theme/) chooses per-neighborhood style; createCityGenRing
// (stream/ring.ts) streams the whole city — merged LOD chunks for the far skyline
// crossfading into full grammar meshes + walkable interiors up close. Chinatown
// currently has no facade grammar, so it falls back to its baked OSM facade until
// a chinatown decorator lands (theme/decorators.ts).
//
// Portability: everything under core/ is city-agnostic (no SF, no THREE-in-core).
// To retune for another city, swap theme/ + tools/citygen-classify.mjs. See
// README.md for the ThemePack contract.
import type * as THREE from "three/webgpu";
import { massBuilding, type Massing } from "./core/massing";
import { mergePanels } from "./core/mesh";
import { buildingColliders } from "./core/collider";
import type { BuildingSpec, ColliderBox, MeshData, ModuleInstance } from "./core/types";
import { specFor, SF_THEME } from "./theme/archetypes";
import { decoratorFor } from "./theme/decorators";
import { expandModuleInstances } from "./theme/moduleDefs";

export type { BuildingSpec, MeshData, ColliderBox, ModuleInstance } from "./core/types";
export { expandModuleInstances, moduleBuckets } from "./theme/moduleDefs";
export { SF_THEME, ARCHETYPE_SPECS, specFor } from "./theme/archetypes";
export { createCityGenRing, type CityGenRing } from "./stream/ring";

/** Generate one building's geometry + colliders from its spec (pure; no scene).
 *  The theme's per-archetype façade decorator authors the detail (Victorian
 *  canted bays, etc.); the mass silhouette always equals the real footprint.
 *  `withDoor` cuts a walk-through doorway in the street wall + returns where.
 *
 *  Windows come back as kit-of-parts INSTANCES (`instances` + `matTable`)
 *  rather than baked triangles; hosts with the instanced module layer draw
 *  them there, everyone else calls `expandModuleInstances` (or passes
 *  `expandModules: true`) to fold them back into `meshes`. */
export function generate(spec: BuildingSpec, withDoor = false, opts: { expandModules?: boolean } = {}): { mass: Massing; meshes: MeshData[]; instances: ModuleInstance[]; matTable: string[]; colliders: ColliderBox[]; door: import("./core/collider").DoorOpening | null } {
  const arch = specFor(spec.archetype);
  const mass = massBuilding(spec, arch, decoratorFor(spec.archetype));
  let panels = mass.panels;
  let instances = mass.instances;
  let matTable = mass.matTable;
  if (opts.expandModules && instances.length) {
    panels = panels.concat(expandModuleInstances(instances, matTable));
    instances = [];
    matTable = [];
  }
  const meshes = mergePanels(panels);
  const { boxes: colliders, door } = buildingColliders(spec, withDoor);
  return { mass, meshes, instances, matTable, colliders, door };
}

export interface CityGen {
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): { resident: number };
}

export interface CityGenCtx {
  scene: THREE.Object3D;
  physics: { world: unknown };
  map: { groundHeight(x: number, z: number): number; surfaceType?(x: number, z: number): number };
  tiles: { suppressBuilding(key: string, i: number): void; unsuppressBuilding(key: string, i: number): void };
}

/** Streaming host — STUB (Phases 3–5). Present so main.ts can wire the module
 *  once it's ready without churning imports; today it does nothing. */
export async function createCityGen(_opts: { url?: string }, _ctx: CityGenCtx): Promise<CityGen> {
  void SF_THEME;
  return {
    update() {},
    dispose() {},
    stats() { return { resident: 0 }; },
  };
}
