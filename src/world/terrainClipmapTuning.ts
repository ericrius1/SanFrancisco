import { tunables } from "../core/persist";

/**
 * Terrain material and LOD transition controls. Geometry density and ranges are
 * intentionally source constants (terrainClipmapLayout.ts). The A/B switch
 * swaps prebuilt topology; the other live values change uniforms only, so
 * tuning never rebuilds buffers or recompiles shaders.
 */
export const TERRAIN_CLIPMAP_TUNING = tunables("terrainClipmap", {
  adaptiveMeterMesh: {
    v: true,
    label: "1 m interpolated mesh"
  },
  morphBand: {
    v: 0.24,
    min: 0.08,
    max: 0.45,
    step: 0.01,
    label: "LOD morph band"
  },
  macroVariation: {
    v: 0.07,
    min: 0,
    max: 0.2,
    step: 0.01,
    label: "macro variation"
  },
  microVariation: {
    v: 0.06,
    min: 0,
    max: 0.2,
    step: 0.01,
    label: "near variation"
  },
  debugLevels: { v: false, label: "show LOD rings" }
});
