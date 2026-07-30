import { tunables } from "../../../core/persist"

export const GRAIN_TUNING = tunables("post.grain", {
  /** 0 is an exact identity — this is the toggle. */
  strength: { v: 0.018, min: 0, max: 0.08, step: 0.001, label: "film grain" },
  /** Lattice scale INDEPENDENT of resolution, so a 0.667 internal render does
   *  not halve the grain. */
  size: { v: 1.35, min: 0.5, max: 4, step: 0.05, label: "· size (px)" },
  /** 0 = flat additive noise; 1 = fully luminance-dependent. Real grain vanishes
   *  in specular highlights and deep shadows. */
  response: { v: 0.85, min: 0, max: 1, step: 0.01, label: "· response" },
  falloff: { v: 1, min: 0.4, max: 2.5, step: 0.05, label: "· falloff" },
  /** Per-channel decorrelation. Real emulsion grain is not achromatic. */
  chroma: { v: 0.35, min: 0, max: 1, step: 0.01, label: "· chroma" },
  animate: { v: true, label: "· animate" }
})
