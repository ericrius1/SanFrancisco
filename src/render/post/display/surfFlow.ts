import { If, float, mix, saturation, screenUV, smoothstep, uniform, vec2, vec3 } from "three/tsl"
import type { N } from "../types"

/**
 * SURVIVOR. Both halves of the surf flow-state effect, carried over from
 * postfx.ts:302-314 (the lens) and :516-548 (the grade), verbatim.
 *
 * Runtime-only state: `setFlowPostFx(amount, phase)` from
 * worldSystemsCore.ts:574 is the whole contract. These uniforms are
 * intentionally not persisted and not exposed in tweakpane — gameplay owns the
 * envelope.
 *
 * Moving both halves to the display tail is strictly better than where they
 * were: the lens now warps a RESOLVED image, so a UV warp that the velocity
 * buffer knows nothing about can no longer fight the temporal history.
 */
const U = {
  flowAmount: uniform(0),
  flowPhase: uniform(0)
}

export function setFlowPostFx(amount: number, phase: number) {
  U.flowAmount.value = Math.min(1, Math.max(0, amount))
  U.flowPhase.value = Number.isFinite(phase) ? phase : 0
}

export type SurfFlowLens = {
  /** The warped UV to sample the resolved colour at. */
  readonly sampleUv: N
  /** `.toVar()`'d in the BASE control flow — the grade below reads them. */
  readonly dist: N
  readonly fall: N
}

/**
 * Cozy flow-state lens: one warped colour lookup, even in the default graph. At
 * amount = 0 this is exactly the original UV, so the inactive cost is arithmetic
 * only — not additional texture taps.
 */
export function surfFlowLens(uv: N): SurfFlowLens {
  const flowCentre = screenUV.sub(0.5).toVar()
  const flowDist = flowCentre.length().toVar()
  const flowFall = smoothstep(0.08, 0.78, flowDist).oneMinus()
  const flowRipple = flowDist
    .mul(35)
    .sub(U.flowPhase.mul(5.2))
    .sin()
    .mul(flowFall)
    .mul(U.flowAmount)
  const flowTangent = vec2(flowCentre.y.negate(), flowCentre.x)
  const sampleUv = uv
    .add(flowTangent.mul(flowRipple.mul(0.008)))
    .sub(flowCentre.mul(flowFall).mul(U.flowAmount).mul(0.006))
  return { sampleUv, dist: flowDist, fall: flowFall }
}

/**
 * Sea-glass tri-tone, pearlescent caustic ring and a warm sun flash.
 * Presentation time stays unscaled while only the local rider slows.
 *
 * Every term here is multiplied by flowAmount, so at the default 0 the
 * block already contributed exactly nothing — it just did so at ~60 ALU
 * per OUTPUT pixel of the fullscreen composite, in every variant, at
 * every stop. Same uniform-If treatment as the underwater package:
 * the condition is a uniform-buffer read, so the whole draw skips it
 * rather than masking it, and the skip is bit-identical at amount 0
 * (mix(c, ·, 0) === c, and every added term carries a `flow` factor).
 *
 * The tri-tone mix deliberately stays OUTSIDE the branch. It is the one
 * unconditional read of `c` in the default (no ink/ukiyo/dream/retro)
 * variant, so it is what materialises `c`'s var in the base flow rather
 * than inside a conditional; the branch below then only ever reads and
 * reassigns an already-live var. `flowDist`/`flowFall` are likewise
 * materialised by the lens UV block above, which still runs.
 *
 * @param c a display-referred colour VAR; reassigned in place.
 */
export function surfFlowGrade(c: N, lens: SurfFlowLens): void {
  const flow = U.flowAmount
  const flowGrade = c.mul(vec3(0.9, 1.075, 1.045)).add(vec3(0.025, 0.045, 0.032))
  c.assign(mix(c, flowGrade, flow.mul(0.78)))
  If(flow.greaterThan(0), () => {
    c.assign(saturation(c, float(1).add(flow.mul(0.14))))
    const ringRadius = U.flowPhase.mul(0.11).fract().mul(0.72).add(0.08)
    const pearlRing = smoothstep(0.0, 0.065, lens.dist.sub(ringRadius).abs())
      .oneMinus()
      .mul(lens.fall)
      .mul(flow)
    c.addAssign(vec3(0.2, 0.88, 0.72).mul(pearlRing).mul(0.17))
    const sunPulse = U.flowPhase.mul(2.3).sin().mul(0.5).add(0.5).pow(5).mul(flow)
    c.addAssign(vec3(1.0, 0.52, 0.22).mul(sunPulse).mul(0.045))
  })
}
