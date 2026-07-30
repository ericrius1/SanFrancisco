import { tunables } from "../../../core/persist"

export { GRADE_TUNING } from "../../grade"

/**
 * The AgX live knobs. `grade` (the existing group) keeps `look`, and exposure
 * keeps riding on `renderer.toneMappingExposure` through the `render` group —
 * neither moves, because tools/grade-probe.mjs, tools/calibration-probe.mjs and
 * tools/grade-compare-probe.mjs all import render/grade.ts directly and that is
 * the strongest argument for putting AgX INSIDE `evaluateLook` rather than in a
 * new module: those three probes then predict AgX correctly the moment the
 * branch exists.
 *
 * Defaults are the solved `agxPunch` entry. Bisected so linear 0.18 lands where
 * goldenState lands it (0.206785 display-linear) — the "switching looks changes
 * character, not brightness" contract.
 *
 * These are the reason `grade.rebake()` must gain a cache: measured bake cost is
 * goldenState 53.9 ms but AgX base 147.9 ms and AgX punchy 133.6 ms for 110,592
 * evaluations at 48³, and `rebake()` has no cache today, so A -> B -> A re-pays
 * every time. Live sliders must re-bake only on `last === true`, with a 16³
 * preview bake (~6 ms) while dragging.
 */
export const POST_GRADE_TUNING = tunables("post.grade", {
  /**
   * DEPARTURE FROM THE BRIEF, and it is load-bearing. The brief's table lists
   * the eight knobs with "defaults: as the agxPunch entry" and nothing else —
   * but applied unconditionally those defaults do not leave `agxPunch` alone,
   * they OVERWRITE `agx`, whose authored CDL is the neutral one (power 1,
   * saturation 1). Selecting "AgX" would silently render AgX punch, and the
   * measured 16.5%-chroma reference look would not exist.
   *
   * So the knobs are opt-in. Off, both looks render exactly as authored in
   * gradeLooks.ts and nothing here can re-bake anything. Switching it ON seeds
   * these values from the ACTIVE look first, so enabling it is an image no-op
   * and the numbers below are a starting point rather than a jump.
   */
  agxLive: { v: false, label: "agx live edit" },
  agxSlopeR: { v: 1, min: 0.5, max: 2, step: 0.01, label: "agx slope R" },
  agxSlopeG: { v: 1, min: 0.5, max: 2, step: 0.01, label: "agx slope G" },
  agxSlopeB: { v: 1, min: 0.5, max: 2, step: 0.01, label: "agx slope B" },
  agxOffset: { v: 0, min: -0.2, max: 0.2, step: 0.005, label: "agx offset" },
  agxPower: { v: 1.35, min: 0.5, max: 2.5, step: 0.01, label: "agx power" },
  agxSaturation: { v: 1.4, min: 0, max: 2, step: 0.01, label: "agx saturation" },
  agxMinEv: { v: -12.47393, min: -20, max: -4, step: 0.01, label: "agx min EV" },
  agxMaxEv: { v: 4.026069, min: 2, max: 12, step: 0.01, label: "agx max EV" }
})
