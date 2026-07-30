import { tunables } from "../../../core/persist"

export const SSR_TUNING = tunables("post.ssr", {
  enabled: { v: true, label: "reflections" },
  intensity: { v: 0.8, min: 0, max: 2, step: 0.01, label: "· intensity" },
  /** Stock default is 1 m, which is useless at city scale. */
  maxDistance: { v: 18, min: 1, max: 80, step: 0.5, label: "· max distance (m)" },
  thickness: { v: 0.12, min: 0.02, max: 1, step: 0.01, label: "· thickness" },
  screenEdgeFade: { v: 0.22, min: 0, max: 0.4, step: 0.01, label: "· edge fade (uv)" },
  /** Firefly clamp (SSRNode.js:1273-1274). */
  maxLuminance: { v: 8, min: 2, max: 50, step: 0.5, label: "· max luminance" },
  quality: { v: 0.45, min: 0, max: 1, step: 0.01, label: "· quality" },
  /** Below this the ray-march kernel discards as its FIRST statement. The mask
   *  is the whole design: on a dry SF afternoon it is empty and the pass costs a
   *  discard per pixel. */
  maskThreshold: { v: 0.02, min: 0, max: 0.5, step: 0.01, label: "· mask threshold" },
  resolution: {
    v: 0.5,
    options: { "¼": 0.25, "½": 0.5, full: 1 },
    label: "· resolution"
  },
  /** Promoted to a uniform by the fork — stock bakes it (SSRNode.js:498). */
  stepExponent: { v: 2, min: 1, max: 4, step: 0.1, label: "· step exponent" },
  /** Genuinely baked. Declared in recompileKeys; the panel puts it behind Apply. */
  blurQuality: { v: 2, min: 1, max: 3, step: 1, label: "· blur quality (rebuild)" },
  binaryRefine: { v: false, label: "· binary refine (rebuild)" }
})
