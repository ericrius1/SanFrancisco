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
export type { BuildingSpec, MeshData, ColliderBox, ColliderMesh, ModuleInstance } from "./core/types";
export { expandModuleInstances, moduleBuckets } from "./theme/moduleDefs";
export { SF_THEME, ARCHETYPE_SPECS, specFor } from "./theme/archetypes";
export { createCityGenRing, type CityGenRing } from "./stream/ring";

export { generate } from "./generate";
