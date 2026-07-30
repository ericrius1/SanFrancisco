import { tunables } from "../../../core/persist"

/**
 * Its own dotted path, like every stage group. `core/persist.ts:187-195`
 * fingerprints per group and discards only THAT group's saved overrides when its
 * spec changes, so editing this table never collaterals a sibling stage's tuning.
 *
 * Every entry below is a live uniform except `resolution` (structural — the panel
 * gates it on slider release) and the two marked "(rebuild)", which are the only
 * genuinely baked constants left in the whole chain. See ./index.ts for why
 * `stepExponent` is NOT among them any more, and for the standing question of
 * whether this stage should default to enabled at all.
 */
export const SSR_TUNING = tunables("post.ssr", {
  enabled: { v: true, label: "reflections" },
  intensity: { v: 0.8, min: 0, max: 2, step: 0.01, label: "· intensity" },
  /** Stock default is 1 m, which is useless at city scale. */
  maxDistance: { v: 18, min: 1, max: 80, step: 0.5, label: "· max distance (m)" },
  thickness: { v: 0.12, min: 0.02, max: 1, step: 0.01, label: "· thickness" },
  /** Fades a hit whose SOURCE pixel is near a screen border, to black — there is
   *  no environment map to blend toward, this sky being procedural. Stock applies
   *  this only on the stochastic path; the fork applies it on the mirror path too,
   *  because "the reflection vanishes when its source scrolls off screen" is the
   *  single most recognisable SSR artefact. 0 disables it. */
  screenEdgeFade: { v: 0.22, min: 0, max: 0.4, step: 0.01, label: "· edge fade (uv)" },
  /** Firefly clamp (SSRNode.js:1273-1274). */
  maxLuminance: { v: 8, min: 2, max: 50, step: 0.5, label: "· max luminance" },
  /** Scales the per-ray step budget, capped at 64 steps by the fork. */
  quality: { v: 0.45, min: 0, max: 1, step: 0.01, label: "· quality" },
  /** Below this the ray-march kernel discards as its FIRST statement. The mask
   *  is the whole design: on a dry SF afternoon it is empty and the pass costs a
   *  fetch and a discard per pixel. */
  maskThreshold: { v: 0.02, min: 0, max: 0.5, step: 0.01, label: "· mask threshold" },
  /** STRUCTURAL. Reallocates both targets; gate on slider release. */
  resolution: {
    v: 0.5,
    options: { "¼": 0.25, "½": 0.5, full: 1 },
    label: "· resolution"
  },
  /** Promoted to a uniform by the fork — stock bakes it (SSRNode.js:498) and its
   *  setter rebuilds the material, which on a live slider is one codegen window
   *  per pointer-move. 1 reproduces stock's uniform march exactly; above 1 the
   *  step budget concentrates near the ray origin. */
  stepExponent: { v: 2, min: 1, max: 4, step: 0.1, label: "· step exponent" },
  /** RECOMPILE. `boxBlur`'s (size*2+1)² loop bounds must be constants. */
  blurQuality: { v: 2, min: 1, max: 3, step: 1, label: "· blur quality (rebuild)" },
  /** RECOMPILE. Adds an 8-iteration bisection of the bracketed depth crossing. */
  binaryRefine: { v: false, label: "· binary refine (rebuild)" }
})
