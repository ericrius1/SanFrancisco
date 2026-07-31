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
  /**
   * <30 gives 3 directions, >=30 gives 5 (vendor/gtao.ts, DIRECTIONS/STEPS).
   * Structural. STAYS AT 16 — see `resolution` below for why the saving was
   * taken on the other axis instead.
   */
  samples: { v: 16, min: 8, max: 32, step: 8, label: "· samples" },
  /**
   * ¼ OF THE BEAUTY PASS, DOWN FROM ½ ON MEASUREMENT. SSAO was the single most
   * expensive stage in the chain — 0.82 ms at the Golden Gate deck, 1.29 ms
   * downtown, against BRIEF §9.2's 0.45 ms budget — and this is where that went.
   *
   * COST, paired within each round of a round-robin at downtown FiDi, 1512x982
   * @ ratio 1, as (config − ssao off) in the SAME round
   * (`.data/postfx/perf/ssao-curve-fidi.json`):
   *
   *     s8  @ ¼   0.25 ms      s16 @ ½   1.02 ms   ← was the default
   *     s16 @ ¼   0.45 ms      s24 @ ½   1.43 ms
   *     s8  @ ½   0.58 ms      s32 @ ½   2.28 ms
   *                            s16 @ full 4.66 ms   s32 @ full 9.53 ms
   *
   * (A second reading of s16 @ ½ taken later in each round read 1.49 ms — the
   * session drifts upward within a round, which is why every number above is a
   * same-round difference and not a cross-row one.)
   *
   * QUALITY, paired the same way, at the BOTANICAL MEADOW — blade grass and
   * trees over 90% of the frame, `occludedFraction 0.593`, the richest AO
   * content in this world. Downtown at the §9.4 heading is one facade above an
   * empty plaza (`occludedFraction 0.059`) and separates nothing; that stop
   * cannot answer this question and its numbers are not used here.
   *
   * Each row is the mean |Δ| over the occluded pixels against `s32 @ full`,
   * MINUS the same config against ITSELF across an identical settle — the
   * meadow's wind moves every frame, so the self-delta is the floor and only
   * what clears it is signal (`.data/postfx/perf/ssao-quality-meadow.json`):
   *
   *     AO OFF      12.28 vs 6.67 self  →  +5.61   ← what AO is worth, total
   *     s16 @ ½      6.89 vs 6.52 self  →  +0.37   ← indistinguishable from s32@full
   *     s16 @ ¼      8.70 vs 7.99 self  →  +0.71   ← 6% of the AO effect given up
   *     s8  @ ½      8.53 vs 7.63 self  →  +0.90   ← 9% given up, and DEARER
   *
   * THE FINDING THAT DECIDES IT: `resolution` is the cheaper axis. Quarter res
   * is both cheaper than `samples 8` (0.45 vs 0.58 ms) AND closer to the
   * reference (+0.71 vs +0.90). That is not a coincidence — fewer horizon-search
   * steps is a SYSTEMATIC bias (a missed horizon lightens the AO), while less
   * resolution is a blur of a signal this stage is deliberately tuned to keep
   * low-frequency ("a wide, soft gradient across a whole wall", see the format
   * note in ./index.ts). The high-frequency near-field term is not this stage's
   * at all; contactShadows.ts owns it and the composite min()-combines them.
   *
   * WHAT THIS DOES NOT COVER, and it is the thing to look at: every frame above
   * is a still. Quarter-res AO upsampled across a full-res depth discontinuity
   * is the classic setup for halos and for crawl on a MOVING camera, and no
   * measurement here can see either. The meadow — grass, i.e. nothing but depth
   * discontinuities — is the best available evidence that it is small, and it is
   * still only static evidence. One dropdown click puts it back, and the "high"
   * preset already takes it to full.
   */
  resolution: {
    v: 0.25,
    options: { "¼": 0.25, "½": 0.5, full: 1 },
    label: "· resolution"
  },
  /** 6-frame slice rotation. Safe because the temporal resolve is downstream. */
  temporalRotation: { v: true, label: "· temporal rotation" }
})
