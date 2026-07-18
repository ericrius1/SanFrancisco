// Global vegetation controls. These values affect every vegetation subsystem,
// so they must not live in either the garden-grass or wildlands-grass tuning.

import { tunables } from "../../core/persist";
import { foliageBrightness } from "./appearance";
import { setWindTargets } from "./wind";

export const VEGETATION_TUNING = tunables("vegetation", {
  windStrength: { v: 0.42, min: 0, max: 1, step: 0.01, label: "wind strength" },
  windSpeed: { v: 0.92, min: 0, max: 3, step: 0.05, label: "wind tempo" },
  leafBrightness: { v: 1.05, min: 0.3, max: 1.6, step: 0.01, label: "tree leaf brightness" }
});

export function applyVegetationTuning(immediate = false) {
  const values = VEGETATION_TUNING.values;
  setWindTargets(values.windStrength, values.windSpeed, immediate);
  foliageBrightness.value = values.leafBrightness;
}
