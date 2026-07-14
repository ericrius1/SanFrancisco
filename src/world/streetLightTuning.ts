import { tunables } from "../core/persist";

/**
 * One persisted source of truth for both street-light render paths. The cheap
 * instanced fallback and the close depth-projected complement read the same
 * strength and falloff values, so their distance crossfade cannot expose a
 * change in shape.
 */
export const STREET_LIGHT_TUNING = tunables("lighting.streetLights", {
  resolutionScale: {
    v: 0.55,
    min: 0.25,
    max: 1,
    step: 0.05,
    label: "projection resolution",
    format: (value: number) => `${Math.round(value * 100)}%`
  },
  strength: {
    v: 1,
    min: 0.25,
    max: 2,
    step: 0.05,
    label: "pool strength"
  },
  falloffPower: {
    v: 1,
    min: 0.5,
    max: 3,
    step: 0.05,
    label: "falloff curve"
  },
  heightReach: {
    v: 4,
    min: 2,
    max: 10,
    step: 0.25,
    label: "surface height reach"
  }
});
