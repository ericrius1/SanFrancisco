// San Francisco theme pack — archetype specs.
//
// This is the ONLY place SF style lives on the runtime side (the classifier that
// assigns these ids lives in tools/citygen-classify.mjs and is baked into the
// export). Swapping cities = replacing this file + the classifier; core/ never
// changes. Phase 1 carries floor height + material ids + roof type; the
// split-grammar phase (Phase 2) extends each spec with bay rhythm, cornice
// profile, storefront/garage/stoop rules and real materials.
import type { ArchetypeId, ArchetypeSpec, ThemePack } from "../core/types";

// Material ids are resolved to real THREE materials by theme/materials.ts (Phase
// 2). Phase 1 uses a small shared palette so the shell is visible in a probe.
export const ARCHETYPE_SPECS: Record<ArchetypeId, ArchetypeSpec> = {
  // Italianate / Stick / Queen Anne rowhouses — Haight, Alamo Sq, Pacific Hts,
  // inner Mission. Narrow lots, slanted bay windows, bracketed cornice, stoop.
  victorian: {
    floorH: 3.4, wallMaterial: "wall.victorian", roofMaterial: "roof.flatTrim",
    roofType: "flat", note: "painted-lady rowhouse; slanted bay windows (Phase 2)",
  },
  // Post-1906 flat-front rowhouse — squared bays, restrained trim.
  edwardian: {
    floorH: 3.3, wallMaterial: "wall.edwardian", roofMaterial: "roof.flatTrim",
    roofType: "flat", note: "flat-front rowhouse; squared bay windows",
  },
  // Marina / Sunset / Richmond — Mediterranean/Spanish Revival stucco. Flat roof
  // with low tile cornice, arched garage + entry, bow window over the garage.
  marina: {
    floorH: 3.2, wallMaterial: "wall.stucco", roofMaterial: "roof.tileCornice",
    roofType: "flat", note: "stucco Mediterranean; arched garage (Phase 2)",
  },
  // Union Sq / FiDi-fringe commercial mid-rise — masonry grid, storefront +
  // awnings at grade, flat parapet.
  downtown: {
    floorH: 3.7, wallMaterial: "wall.commercial", roofMaterial: "roof.parapet",
    roofType: "flat", note: "commercial mid-rise; storefront + signband (Phase 2)",
  },
  // SoMa / Dogpatch brick warehouse + loft — exposed brick, tall industrial sash.
  soma: {
    floorH: 4.2, wallMaterial: "wall.brick", roofMaterial: "roof.parapet",
    roofType: "flat", note: "brick warehouse/loft; loading-dock grade (Phase 2)",
  },
  // Chinatown tenement — the ONLY archetype that keeps the Kowloon-flavored look
  // (vertical signage, awnings). Contained here so it can't leak citywide.
  chinatown: {
    floorH: 3.1, wallMaterial: "wall.chinatown", roofMaterial: "roof.parapet",
    roofType: "flat", note: "dense tenement; vertical signage (Phase 2)",
  },
};

export const SF_THEME: ThemePack = { archetypes: ARCHETYPE_SPECS };

/** Look up a spec, falling back to downtown for an unknown id. */
export function specFor(archetype: ArchetypeId): ArchetypeSpec {
  return ARCHETYPE_SPECS[archetype] ?? ARCHETYPE_SPECS.downtown;
}
