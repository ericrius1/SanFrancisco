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
  agxSlopeR: { v: 1, min: 0.5, max: 2, step: 0.01, label: "agx slope R" },
  agxSlopeG: { v: 1, min: 0.5, max: 2, step: 0.01, label: "agx slope G" },
  agxSlopeB: { v: 1, min: 0.5, max: 2, step: 0.01, label: "agx slope B" },
  agxOffset: { v: 0, min: -0.2, max: 0.2, step: 0.005, label: "agx offset" },
  agxPower: { v: 1.35, min: 0.5, max: 2.5, step: 0.01, label: "agx power" },
  agxSaturation: { v: 1.4, min: 0, max: 2, step: 0.01, label: "agx saturation" },
  agxMinEv: { v: -12.47393, min: -20, max: -4, step: 0.01, label: "agx min EV" },
  agxMaxEv: { v: 4.026069, min: 2, max: 12, step: 0.01, label: "agx max EV" }
})
