// CityGen core types — the city-agnostic contract.
//
// PORTABILITY RULE: nothing in core/ knows about San Francisco, THREE.js, or any
// texture. The engine turns a BuildingSpec (real footprint + heights + an
// archetype id + a seed) into plain geometry data (MeshData) and colliders. All
// San-Francisco-ness lives in ../theme (the swappable ThemePack). To retune the
// module for another city you write a new theme pack; core/ never changes.

/** 2D footprint vertex, in the host's world frame (metres). [x, z]. */
export type Vec2 = readonly [number, number];

/** Opaque archetype id (a theme pack defines the actual set, e.g. "victorian"). */
export type ArchetypeId = string;

/** One building to generate — exactly the record shape tools/export-citygen.mjs emits. */
export interface BuildingSpec {
  /** tile-local index; pairs with tiles.suppressBuilding(tileKey, i) */
  i: number;
  id: number;
  /** REAL footprint ring (not a bbox) — the anti-"shift" guarantee */
  poly: Vec2[];
  /** world Y where the walls meet the ground */
  base: number;
  /** world Y of the roof */
  top: number;
  h?: number;
  archetype: ArchetypeId;
  /** deterministic per-building seed (drives all style jitter) */
  seed: number;
}

/** A run of geometry sharing one material id (theme resolves id → material). */
export interface Panel {
  materialId: string;
  /** flat xyz triples, world space */
  positions: number[];
  /** flat xyz triples */
  normals: number[];
  /** flat uv pairs */
  uvs: number[];
  /** triangle indices into this panel's vertices */
  indices: number[];
}

/** Merged, typed geometry for one material id — ready for a THREE.BufferGeometry. */
export interface MeshData {
  materialId: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Axis-aligned collider box in the host's world frame (metres). Yaw is baked
 *  into the box extents for Phase-1 (footprint edges are world-aligned quads);
 *  oriented per-edge boxes arrive with the grammar phase. */
export interface ColliderBox {
  /** centre */
  x: number; y: number; z: number;
  /** half extents */
  hx: number; hy: number; hz: number;
  /** yaw about Y (radians) for oriented wall boxes; 0 = axis-aligned */
  yaw: number;
}

/** Per-archetype style parameters a theme pack supplies to the engine. */
export interface ArchetypeSpec {
  /** metres per storey (drives floor count from real height) */
  floorH: number;
  /** material id for the main wall surface */
  wallMaterial: string;
  /** material id for the roof cap */
  roofMaterial: string;
  /** flat | pitched | gable — Phase 1 builds flat; others reserved for grammar */
  roofType: "flat" | "pitched" | "gable";
  // ---- grammar / detail material ids (Phase 2, all optional) ---------------
  /** trim / cornice / window-frame material */
  trimMaterial?: string;
  /** window glass material */
  glassMaterial?: string;
  /** storefront / garage door material */
  baseMaterial?: string;
  /** target bay (window column) width in metres */
  bayWidth?: number;
  /** how far a bay window projects from the façade (metres); 0 = flush */
  bayProjection?: number;
  /** ground floor treatment the theme should draw on the street face */
  groundFloor?: "storefront" | "stoop" | "garage" | "loadingDock" | "plain";
  /** cornice projection at the roofline (metres); 0 = none */
  cornice?: number;
  /** human-readable note on the real SF style (documentation only) */
  note?: string;
}

/** A city theme = its archetype specs (+ a material builder, added in Phase 2). */
export interface ThemePack {
  archetypes: Record<ArchetypeId, ArchetypeSpec>;
}
