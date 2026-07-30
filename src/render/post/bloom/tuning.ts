import { tunables } from "../../../core/persist"

/**
 * Carried from postfx.ts:67-70, and the threshold's rationale at :59-66 is
 * load-bearing rather than decorative:
 *
 * A white diffuse surface in full sun lands near 1.0-1.3 linear here, so a
 * "just above white" threshold catches ordinary lit geometry — at 1.05 the
 * player's plain-white head became a blazing orb outdoors and an outdoor frame's
 * mean luma rose 83 -> 106. Sitting it at 2.2 leaves lit white alone while the
 * Sutro lamp globes (emissive ~4.8, luminance ~1.9) and the sun disc still bleed
 * properly: the hall's mean still moves 58.8 -> 61.8 with the lamps blooming,
 * which is the effect this is for.
 *
 * Note the threshold is measured in PRE-exposure scene-linear — exposure is
 * applied inside grade.toDisplay (grade.ts:186), downstream. Any future
 * auto-exposure must go in the same place or this number silently changes
 * meaning.
 */
export const BLOOM_TUNING = tunables("post.bloom", {
  enabled: { v: true, label: "bloom" },
  strength: { v: 0.42, min: 0, max: 2, step: 0.01, label: "· strength" },
  radius: { v: 0.55, min: 0, max: 1, step: 0.01, label: "· radius" },
  threshold: { v: 2.2, min: 0, max: 6, step: 0.01, label: "· threshold" },
  resolution: {
    v: 1,
    options: { "½": 0.5, "¾": 0.75, full: 1 },
    label: "· resolution"
  }
})
