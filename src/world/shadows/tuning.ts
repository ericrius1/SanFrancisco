import { tunables } from "../../core/persist"
import { SHADOW_DEFAULTS } from "./defaults"

export { SHADOW_DEFAULTS } from "./defaults"

/**
 * One current shadow-settings schema. Pane metadata lives here beside the pure
 * defaults module so persisted values reset whenever this surface changes.
 */
const scientific = (value: number) => value.toExponential(1)

export const SHADOW_TUNING = tunables("shadow", {
  enabled: { v: SHADOW_DEFAULTS.enabled, label: "all shadows" },
  heroStrength: { v: SHADOW_DEFAULTS.heroStrength, min: 0, max: 1, step: 0.05, label: "hero map strength" },
  localStrength: { v: SHADOW_DEFAULTS.localStrength, min: 0, max: 1, step: 0.05, label: "local map strength" },
  farStrength: { v: SHADOW_DEFAULTS.farStrength, min: 0, max: 1, step: 0.05, label: "far map strength" },
  farFieldStrength: { v: SHADOW_DEFAULTS.farFieldStrength, min: 0, max: 1, step: 0.05, label: "far atlas strength" },
  heroNormalBias: { v: SHADOW_DEFAULTS.heroNormalBias, min: 0, max: 0.15, step: 0.005, label: "hero normal bias" },
  heroDepthBias: { v: SHADOW_DEFAULTS.heroDepthBias, min: -0.001, max: 0.001, step: 0.00001, label: "hero depth bias", format: scientific },
  localNormalBias: { v: SHADOW_DEFAULTS.localNormalBias, min: 0, max: 0.3, step: 0.005, label: "local normal bias" },
  localDepthBias: { v: SHADOW_DEFAULTS.localDepthBias, min: -0.001, max: 0.001, step: 0.00001, label: "local depth bias", format: scientific },
  farNormalBias: { v: SHADOW_DEFAULTS.farNormalBias, min: 0, max: 2, step: 0.05, label: "far normal bias" },
  farDepthBias: { v: SHADOW_DEFAULTS.farDepthBias, min: -0.002, max: 0.002, step: 0.00002, label: "far depth bias", format: scientific },
  contactEnabled: { v: SHADOW_DEFAULTS.contactEnabled, label: "contact shadows" },
  contactIntensity: { v: SHADOW_DEFAULTS.contactIntensity, min: 0, max: 1, step: 0.01, label: "contact intensity" },
  contactResolutionScale: { v: SHADOW_DEFAULTS.contactResolutionScale, min: 0.25, max: 1, step: 0.05, label: "contact resolution" },
  contactMaxDistance: { v: SHADOW_DEFAULTS.contactMaxDistance, min: 0.05, max: 2, step: 0.05, label: "contact ray (m)" },
  contactThickness: { v: SHADOW_DEFAULTS.contactThickness, min: 0.005, max: 0.5, step: 0.005, label: "contact thickness" },
  contactNormalBias: { v: SHADOW_DEFAULTS.contactNormalBias, min: 0, max: 0.1, step: 0.002, label: "contact normal bias" },
  contactFadeStart: { v: SHADOW_DEFAULTS.contactFadeStart, min: 1, max: 50, step: 0.5, label: "contact fade start" },
  contactFadeEnd: { v: SHADOW_DEFAULTS.contactFadeEnd, min: 2, max: 60, step: 0.5, label: "contact fade end" }
})
