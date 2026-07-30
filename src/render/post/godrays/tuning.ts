import { tunables } from "../../../core/persist"
import type { PianoGodRaysParams } from "../../pianoGodRaysTypes"

/**
 * Carried verbatim from postfx.ts:87-98 onto its own dotted path. The runtime in
 * render/pianoGodRays.ts is UNCHANGED by this rebuild; this folder is a thin
 * adapter around it.
 */
export const GODRAYS_TUNING = tunables("post.godrays", {
  enabled: { v: true, label: "pianist · god rays" },
  steps: { v: 48, min: 24, max: 96, step: 1, label: "· raymarch steps" },
  density: { v: 0.2, min: 0.02, max: 0.8, step: 0.01, label: "· air density" },
  maxDensity: { v: 0.2, min: 0.02, max: 0.5, step: 0.01, label: "· max brightness" },
  attenuation: { v: 2.2, min: 0, max: 4, step: 0.05, label: "· distance falloff" },
  resolution: {
    v: 0.5,
    options: { "⅓ resolution": 0.35, "½ resolution": 0.5, "¾ resolution": 0.75 },
    label: "· ray quality"
  },
  edgeRadius: { v: 2, min: 0, max: 5, step: 1, label: "· edge radius" },
  edgeStrength: { v: 1.5, min: 0, max: 5, step: 0.1, label: "· edge protection" }
})

export function getPianoGodRaysParams(): PianoGodRaysParams {
  const v = GODRAYS_TUNING.values
  return {
    raymarchSteps: v.steps,
    density: v.density,
    maxDensity: v.maxDensity,
    distanceAttenuation: v.attenuation,
    resolutionScale: v.resolution,
    edgeRadius: v.edgeRadius,
    edgeStrength: v.edgeStrength
  }
}
