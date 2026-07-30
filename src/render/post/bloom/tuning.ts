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
  /**
   * The base resolution of the five-mip blur chain, as a fraction of the chain's
   * OUTPUT size. Structural — it reallocates eleven targets.
   *
   * DEFAULT IS ½, NOT THE 1.0 IN BRIEF §4.7's TABLE. This is the one number in
   * this file that is not a straight carry-forward, so the evidence:
   *
   *  - `BloomNode.js:116` sets `_resolutionScale = 0.5` in the constructor, and
   *    the deleted call site (`git show 3a754dd^:src/render/pipeline.ts`, lines
   *    249-252) was `bloom( sceneColor, strengthU, radiusU, thresholdU )` with
   *    no `setResolutionScale`. Every measurement quoted above was therefore
   *    taken against a HALF-resolution chain.
   *  - Kernel radii are in texels of their own mip (`vendor/bloom.ts`,
   *    KERNEL_RADII), so the chain's reach in OUTPUT pixels is inversely
   *    proportional to this number. Shipping 1.0 would halve the bloom's angular
   *    width while leaving `strength` and `radius` — both tuned against that
   *    width — untouched. Bloom is the base look, not an optional style, so that
   *    is a silent change to the default frame.
   *
   * Raising it to 1.0 costs roughly 4x the fill and buys a tighter, cleaner
   * bloom around small bright features (the sun disc, the lamp speculars) that
   * the temporal resolve now keeps sharp enough for it to be worth considering.
   * Worth an A/B — as a deliberate look change with `strength`/`radius`
   * re-measured, not as a default nobody chose.
   */
  resolution: {
    v: 0.5,
    options: { "½": 0.5, "¾": 0.75, full: 1 },
    label: "· resolution"
  }
})
