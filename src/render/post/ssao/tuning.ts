import { tunables } from "../../../core/persist"

export const SSAO_TUNING = tunables("post.ssao", {
  enabled: { v: true, label: "ambient occlusion" },
  /** Deliberately low: this multiplies the final colour, not the ambient term,
   *  and contactShadows.ts:441-454 already darkens contacts on the direct-sun
   *  term. The composite reconciles the two with min(), never a product. */
  intensity: { v: 0.55, min: 0, max: 1.5, step: 0.01, label: "· intensity" },
  /** Stock GTAO defaults to 0.25 m, which is far too small at city scale. */
  radius: { v: 0.9, min: 0.1, max: 3, step: 0.05, label: "· radius (m)" },
  thickness: { v: 1, min: 0.25, max: 4, step: 0.05, label: "· thickness" },
  distanceExponent: { v: 1, min: 1, max: 2, step: 0.05, label: "· distance exponent" },
  distanceFallOff: { v: 1, min: 0, max: 1, step: 0.05, label: "· distance falloff" },
  /** Stock's `scale`; final pow(ao, punch). Renamed — "scale" reads as resolution. */
  punch: { v: 1.1, min: 0.5, max: 3, step: 0.05, label: "· punch" },
  /** <30 gives 3 directions, >=30 gives 5 (GTAONode.js:363). Structural. */
  samples: { v: 16, min: 8, max: 32, step: 8, label: "· samples" },
  resolution: {
    v: 0.5,
    options: { "¼": 0.25, "½": 0.5, full: 1 },
    label: "· resolution"
  },
  /** 6-frame slice rotation. Safe because the temporal resolve is downstream. */
  temporalRotation: { v: true, label: "· temporal rotation" }
})
