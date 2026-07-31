// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.10
//
// TSL only — no render target, no PostStage pass. RCAS (AMD FidelityFX, 5 taps,
// the cheapest correct sharpener there is) fuses into the display tail so it
// costs no extra RGBA8 round trip. Do NOT use FSR1Node: it is the same RCAS plus
// a redundant EASU spatial upscale that TAAU already does better.
//
// Order is sharpen -> grain, not grain -> sharpen. Sharpening on top of grain
// amplifies it into crunchy speckle and makes RCAS's local-contrast estimate
// respond to noise instead of edges. Because both live in the same fused pass,
// flipping the order is one const in display/index.ts and costs nothing.
// docs/POSTFX_CINEMATIC_PATHWAY.md records the same order and the same reason —
// it was updated in wave 3, so this is no longer a deviation from the doc.
//
// The math is ported from three/examples/jsm/tsl/display/SharpenNode.js:170-240,
// which is itself AMD's ffx_fsr1.h. THREE DELIBERATE DEPARTURES:
//
//  1. It is a FUNCTION over a caller-supplied sampler, not a node over a
//     texture. RCAS has to run in DISPLAY space — after grade.toDisplay — or it
//     sharpens HDR ratios instead of visible contrast, and in a fused tail there
//     is no display-space texture to tap. So the tail hands us a closure that
//     re-evaluates the grade at an arbitrary UV, and the 4 neighbours cost 4
//     extra LUT fetches rather than 4 extra texture loads.
//  2. UV + texelSize instead of ivec2 textureLoad. The tail may be sampling an
//     input-resolution texture at output resolution (temporal resolve off), where
//     integer texel addressing is not even defined. Bilinear taps at ±1 texel
//     degrade gracefully; textureLoad would alias.
//  3. The whole neighbourhood sits behind `If(amount > 0)`.
import type * as THREE from "three/webgpu"
import { If, float, max, min, uniform, vec2, vec3 } from "three/tsl"
import { STAGE_ORDER } from "../order"
import type { N, PostStage, PostStageSetup } from "../types"
import { SHARPEN_TUNING } from "./tuning"

const U = {
  /** 0..1, the panel-facing value. 0 is an exact identity. */
  amount: uniform(0),
  /**
   * Stock's inverted `sharpness`, kept as its own uniform so the exp2 below is
   * literally SharpenNode.js:199 and diffs against upstream stay readable.
   */
  sharpness: uniform(2),
  /** 1 = attenuate in noisy areas, 0 = off. A float, not a bool: bool uniforms
   *  are a bind-group type of their own and this is multiplied, not branched. */
  denoise: uniform(1)
}

export function applySharpenParams(): void {
  const amount = Math.min(1, Math.max(0, SHARPEN_TUNING.values.amount))
  U.amount.value = amount
  // WRAPPED. Stock exposes `sharpness` where 0 is MAXIMUM and 2 is minimum
  // (con = exp2(-sharpness), SharpenNode.js:199). A slider whose zero is its
  // strongest setting is a bug generator, so the panel gets `amount` and the
  // inversion lives here, once.
  U.sharpness.value = 2 * (1 - amount)
  U.denoise.value = SHARPEN_TUNING.values.denoise === true ? 1 : 0
}

/**
 * RCAS, fused.
 *
 * @param colour the already-graded centre pixel — reused rather than re-fetched,
 *   because the tail has it in a var and a 5th grade evaluation would be pure
 *   waste.
 * @param sampleGraded re-evaluates the graded colour at an arbitrary UV.
 * @param uv the centre UV (post surf-flow lens).
 * @param texelSize 1/size of the texture being sampled.
 * @returns a display-referred vec3 node. At `amount: 0` this returns `colour`
 *   untouched — see the identity note below.
 */
export function sharpenRcas(colour: N, sampleGraded: (uv: N) => N, uv: N, texelSize: N): N {
  const out = vec3(colour).toVar()

  // THE 4 EXTRA TAPS ARE BEHIND A UNIFORM READ, AND THAT IS THE ONLY THING
  // KEEPING THEM LEGAL. `U.amount` is a uniform-buffer value, so the condition
  // is uniform across the whole draw: the GPU skips the block outright rather
  // than masking it, and WGSL's uniformity analysis permits the implicit-LOD
  // `textureSample` calls inside.
  //
  // They ARE implicit-LOD, and an earlier version of this comment claimed the
  // opposite ("no implicit derivatives are required — every tap is an explicit
  // level-0 sample"). It is false: the closure is display/index.ts's
  // `gradedAt`, a plain `slot.node.sample(uv)`, and `grade.toDisplay` adds
  // `lutNode.sample(...)` (render/grade.ts:281) — four of each, all implicit.
  //
  // SO: MOVING THIS GATE TO A NON-UNIFORM CONDITION IS A COMPILE ERROR, not a
  // performance question. A per-pixel sharpen mask, an `If(luma > x)`, anything
  // derived from a texture read — every one of those turns these taps into
  // WGSL uniformity-rule violations, and the rejection message will point at
  // generated code with no hint where it came from. If you need a non-uniform
  // gate, give the closure explicit `.level(0)` taps first; ssr/vendor/ssr.ts
  // deviation (m) is the worked example of exactly that.
  //
  // Same pattern as the underwater package, and like it this block contains no
  // noise node.
  //
  // This If is also what makes `amount: 0` a BIT-EXACT identity, which the
  // wrapper alone would not give: exp2(-2) is 0.25, not 0, so stock RCAS at its
  // documented "no sharpening" setting still sharpens a quarter as hard.
  If(U.amount.greaterThan(0.0), () => {
    const dx = texelSize.x
    const dy = texelSize.y
    const b = sampleGraded(uv.add(vec2(0.0, dy.negate()))).toVar()
    const d = sampleGraded(uv.add(vec2(dx.negate(), 0.0))).toVar()
    const f = sampleGraded(uv.add(vec2(dx, 0.0))).toVar()
    const h = sampleGraded(uv.add(vec2(0.0, dy))).toVar()

    // AMD's approximate luma (luma × 2), verbatim.
    const luma = (s: N): N => s.g.add(s.b.add(s.r).mul(0.5))
    const bL = luma(b)
    const dL = luma(d)
    const eL = luma(out)
    const fL = luma(f)
    const hL = luma(h)

    // Sharpening amount. The extra `.mul(U.amount)` is OURS, not AMD's: without
    // it the slider steps from "off" straight to con = 0.25 as it leaves zero,
    // because exp2(-2) is a quarter and not nothing. Multiplying by the linear
    // amount closes that step while leaving both endpoints exactly where the
    // brief put them — 0 = identity, 1 = con 1.0, stock's maximum.
    const con = U.sharpness.negate().exp2().mul(U.amount).toVar()

    const mn4 = min(min(b, d), min(f, h)).toVar()
    const mx4 = max(max(b, d), max(f, h)).toVar()

    // Limiters: how much sharpening the local contrast can tolerate before the
    // lobe would ring. RCAS_LIMIT is AMD's 0.25 - 1/16.
    const RCAS_LIMIT = float(0.25 - 1.0 / 16.0)
    // The denominators can be zero on a flat black or flat white neighbourhood.
    // Stock leans on the ±inf that follows resolving to a lobe of 0 through
    // min/max; we clamp instead, because this is fused into the tail and a NaN
    // here does not stay in a scratch target — it is the presented pixel.
    const hitMin = min(mn4, out).div(max(mx4.mul(4.0), vec3(1e-5))).toVar()
    const hitMax = vec3(1.0)
      .sub(max(mx4, out))
      .div(min(mn4.mul(4.0).sub(4.0), vec3(-1e-5)))
      .toVar()
    const lobeRGB = max(hitMin.negate(), hitMax)

    const lobe = max(
      RCAS_LIMIT.negate(),
      min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), float(0.0))
    )
      .mul(con)
      .toVar()

    // Noise attenuation (SharpenNode.js:222-224). On by default because this
    // chain has a temporal resolve upstream and film grain downstream, and RCAS
    // will happily sharpen resolve noise into shimmer.
    const nz = bL.add(dL).add(fL).add(hL).mul(0.25).sub(eL)
    const nzRange = max(max(bL, dL), max(eL, max(fL, hL))).sub(
      min(min(bL, dL), min(eL, min(fL, hL)))
    )
    const nzFactor = float(1.0).sub(
      nz.abs().div(max(nzRange, float(1.0 / 65536.0))).saturate().mul(0.5)
    )
    // An arithmetic lerp on a float uniform, where stock uses
    // `this.denoise.equal(true).select(...)` on a BOOL node (SharpenNode.js:226).
    // Same result, one fewer node type in the bind group, and it keeps this
    // function at exactly one branch — the amount gate above.
    const effectiveLobe = lobe.mul(float(1.0).sub(U.denoise).add(nzFactor.mul(U.denoise))).toVar()

    out.assign(
      b
        .add(d)
        .add(f)
        .add(h)
        .mul(effectiveLobe)
        .add(out)
        .div(effectiveLobe.mul(4.0).add(1.0))
    )
  })

  return out
}

/**
 * Sharpen owns a LOOK, not a pass. See the note on the grain stage for why
 * `enabled()` is false here even when the effect is doing something.
 */
export function createSharpenStage(setup: PostStageSetup): PostStage {
  void setup
  applySharpenParams()
  return {
    id: "sharpen",
    label: "sharpen",
    order: STAGE_ORDER.sharpen,
    kind: "inline",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: applySharpenParams,
    tuning: { group: SHARPEN_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }
}
