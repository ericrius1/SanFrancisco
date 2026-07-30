import { tunables } from "../../../core/persist"

/**
 * `scale` is read by post/tuning.ts as the beauty pass's resolution CEILING —
 * it is the single lever the whole performance argument rests on (the beauty
 * pass drops to 44% of the pixels at 0.667) and the one the adaptive-resolution
 * governor degrades through instead of dropping the output resolution.
 */
export const TEMPORAL_TUNING = tunables("post.temporal", {
  enabled: { v: false, label: "temporal resolve" },
  scale: {
    v: 0.667,
    options: { native: 1, quality: 0.77, balanced: 0.667, performance: 0.59, ultra: 0.5 },
    label: "· render scale"
  },
  /** Stock 0.025 converges very slowly and smears under this game's camera. */
  currentFrameWeight: { v: 0.06, min: 0.01, max: 0.25, step: 0.005, label: "· current weight" },
  depthThreshold: { v: 0.0005, min: 0.0001, max: 0.005, step: 0.0001, label: "· depth threshold" },
  edgeDepthDiff: { v: 0.001, min: 0.0005, max: 0.01, step: 0.0005, label: "· edge depth diff" },
  /** Stock 128 is far too permissive with reprojection-only velocity. This is
   *  the primary defence against moving-object ghosting. */
  maxVelocityLength: { v: 48, min: 16, max: 256, step: 1, label: "· max velocity (px)" },
  varianceGammaMin: { v: 0.5, min: 0.25, max: 1.5, step: 0.05, label: "· clamp at rest" },
  varianceGammaMax: { v: 1, min: 0.5, max: 2, step: 0.05, label: "· clamp in motion" },
  /** Declared fallback: stock TRAANode at scale 1 is the only correct-under-
   *  reversed-depth temporal node in three's display folder. */
  mode: { v: "taau", options: { TAAU: "taau", TRAA: "traa" }, label: "· mode" }
})
