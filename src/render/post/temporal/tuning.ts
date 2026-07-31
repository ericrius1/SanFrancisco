import { tunables } from "../../../core/persist"

/**
 * `scale` is read by post/tuning.ts as the beauty pass's resolution CEILING, and
 * it is the value the adaptive-resolution governor degrades PROPORTIONALLY from
 * instead of dropping the output resolution.
 *
 * INTEGRATION NOTE: `postInputScale()` reads `scale` directly, so it does not
 * know about `mode`. The TRAA fallback cannot upscale — it resolves one input
 * sample per output pixel — so when `mode === "traa"` the scale must be clamped
 * to 1. The stage states that authoritatively as `temporalStage.inputScale()`;
 * post/tuning.ts is not this unit's file to edit.
 */
export const TEMPORAL_TUNING = tunables("post.temporal", {
  enabled: { v: true, label: "temporal resolve" },
  /**
   * 0.77, RAISED FROM 0.667 ON MEASUREMENT. The full write-up is
   * `.data/postfx/perf/` (probes) and the wave-3 performance report; the short
   * version, because the number that used to be here carried a claim that is
   * now known to be false:
   *
   * **0.667 was chosen because "the beauty pass at 44% of the pixels pays for
   * the six new fullscreen passes". It does not.** BRIEF §9.2's acceptance gate
   * — full chain at 0.667 must be ≤ the same build with the chain bypassed at
   * scale 1 — FAILS at both designated stops, on a within-session round-robin at
   * the shipping 1512x982 / pixelRatio 1 (`RENDER_TUNING.pixelRatio` defaults to
   * 1 and devicePixelRatio is deliberately ignored, config.ts:60-62):
   *
   *   botanical meadow   17.64 ms vs 15.99 ms bypassed   (+1.65, and +2.08 in a
   *                                                       second session)
   *   Ocean Beach, open  13.95 ms vs  8.87 ms bypassed   (+5.09)
   *   Golden Gate deck    7.01 ms vs  6.38 ms bypassed   (+0.63)
   *
   * The reason is structural, not a tuning miss: only velocity / SSAO / SSR /
   * composite render at BEAUTY resolution. The temporal resolve, bloom and the
   * display tail render at OUTPUT resolution and do not shrink with this value
   * at all — measured at downtown FiDi they are 2.27 ms of a 4.23 ms chain. So
   * `scale` can only ever attack 46% of the chain's cost while the beauty-pass
   * saving it buys has to cover 100% of it.
   *
   * Once the trade does not pay, this is a pure quality dial, and 0.667's cost
   * is measured and visible. Gradient energy in the Golden Gate vanishing-point
   * suspender band, relative to native: 1.0 → 100%, **0.77 → 81.4%**, 0.667 →
   * 73.5%, 0.59 → 67.1%, 0.5 → 60.5%. In the plates the far suspenders go from
   * continuous lines to dotted traces between 0.77 and 0.667.
   *
   * 0.77 rather than 1.0, and this half is judgement on a measured curve:
   *  - marginal cost 0.667 → 0.77 is +1.2 ms (median of four stops) for 30% of
   *    the lost detail back; 0.77 → 1.0 costs a further +3.8…+6.5 ms for the
   *    rest, i.e. about half the quality per millisecond.
   *  - THE GOVERNOR'S LADDER IS PROPORTIONAL TO THIS VALUE
   *    (`adaptiveResolution.ts` `SCALE_BY_LEVEL`, factors 1 / .9 / .8 / .8 / .7,
   *    composed into `temporalScale` by `computeEffects`). From
   *    0.77 the rungs are 0.770 / 0.693 / 0.616 / 0.616 / 0.539 — they bracket
   *    today's fixed 0.667, so under load the governor reaches and passes the
   *    old cost inside its gentle levels. From 1.0 the rungs are 0.9 / 0.8 /
   *    0.7: every one of them is ABOVE 0.667, so on a stop where 0.667 was
   *    already the right cost the ladder could never get there and would park at
   *    L4 — which also flips heroShadowHalfRate, contactShadowScale 0.5 → 0.35,
   *    fftEconomy and foliageScale 0.7. A resolution default must not be able to
   *    conscript the shadow and foliage budget.
   *
   * What this does NOT settle: whether the chain should be the live default at
   * all. That is `post.enabled` (post/tuning.ts) and BRIEF risk #3's policy
   * call, and the gate failing is evidence for that conversation, not for this
   * number.
   */
  scale: {
    v: 0.77,
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
  /**
   * The neighbourhood variance clamp's width. LABELS SWAPPED RELATIVE TO THE
   * KEY NAMES, ON PURPOSE — the keys are persisted paths (`post.temporal.*`) so
   * renaming them would discard user overrides, but the panel must not lie.
   *
   * `vendor/taau.ts:375` is `mix(min, max, motionFactor.oneMinus().pow2())`,
   * verbatim from TAAUNode.js:722 (`mix(0.5, 1, …)`). At REST motionFactor is 0,
   * so `oneMinus().pow2()` is 1 and the mix returns `varianceGammaMAX`; under
   * full motion it returns `varianceGammaMIN`. That is the correct behaviour —
   * a wide clamp accepts more history and is safe when nothing is moving, and a
   * tight clamp rejects history where a moving object would ghost — but it means
   * `varianceGammaMin` is the IN-MOTION knob and `varianceGammaMax` is the
   * AT-REST one. Verified: sweeping `varianceGammaMin` 0.5 → 1.25 on a static
   * frame moves the far-cable thin-feature metric by 0.000.
   */
  varianceGammaMin: { v: 0.5, min: 0.25, max: 1.5, step: 0.05, label: "· clamp in motion" },
  varianceGammaMax: { v: 1, min: 0.5, max: 2, step: 0.05, label: "· clamp at rest" },
  /** Declared fallback: TRAA is the only temporal node in three's display folder
   *  that is already correct under reversed depth. Structural, not a live
   *  toggle — switching builds the other resolve's graph. */
  mode: { v: "taau", options: { TAAU: "taau", TRAA: "traa" }, label: "· mode" }
})
