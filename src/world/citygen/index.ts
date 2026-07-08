// SF CityGen — portable, neighborhood-aware procedural building module.
//
// Replaces the vendored Hong-Kong/Kowloon kit (src/world/buildings + vendor/
// BuildingGenerator). See feature-research/sf-citygen/PLAN.md for the full design.
//
// Status: PHASE 1 (foundation). The engine (core/) turns a BuildingSpec built on
// the REAL OSM footprint into geometry (footprint-faithful → no "shift") and
// colliders; the SF theme pack (theme/) chooses per-neighborhood style. The
// streaming ring, multi-anchor citywide physics, LOD crossfade and walkable
// interiors arrive in Phases 3–5 — so createCityGen is a wired-to-nothing stub
// today (it does not mutate the scene). main.ts still runs the Chinatown-only
// legacy ring until this module is feature-complete.
//
// Portability: everything under core/ is city-agnostic (no SF, no THREE-in-core).
// To retune for another city, swap theme/ + tools/citygen-classify.mjs. See
// README.md for the ThemePack contract.
import type * as THREE from "three/webgpu";
import { massBuilding, type Massing } from "./core/massing";
import { mergePanels } from "./core/mesh";
import { buildingColliders } from "./core/collider";
import type { BuildingSpec, ColliderBox, MeshData } from "./core/types";
import { specFor, SF_THEME } from "./theme/archetypes";
import { decoratorFor } from "./theme/decorators";

export type { BuildingSpec, MeshData, ColliderBox } from "./core/types";
export { SF_THEME, ARCHETYPE_SPECS, specFor } from "./theme/archetypes";
export { createCityGenRing, type CityGenRing } from "./stream/ring";

/** Generate one building's geometry + colliders from its spec (pure; no scene).
 *  The theme's per-archetype façade decorator authors the detail (Victorian
 *  canted bays, etc.); the mass silhouette always equals the real footprint. */
export function generate(spec: BuildingSpec): { mass: Massing; meshes: MeshData[]; colliders: ColliderBox[] } {
  const arch = specFor(spec.archetype);
  const mass = massBuilding(spec, arch, decoratorFor(spec.archetype));
  const meshes = mergePanels(mass.panels);
  const colliders = buildingColliders(spec);
  return { mass, meshes, colliders };
}

export interface CityGen {
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  stats(): { resident: number };
}

export interface CityGenCtx {
  scene: THREE.Object3D;
  physics: { world: unknown };
  map: { groundHeight(x: number, z: number): number };
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
