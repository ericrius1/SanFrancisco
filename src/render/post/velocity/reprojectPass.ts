// U1 · Velocity — the DEFAULT source. Build spec: .data/postfx/BRIEF.md §3.4.
//
// One fullscreen pass at input resolution: raw depth -> view position -> the
// previous frame's unjittered clip space -> NDC delta, written to rg16float.
//
// It is EXACT for every static surface — terrain, city, buildings, roads,
// unmoving foliage — which is the overwhelming majority of screen coverage at
// every benchmark stop, and it costs one depth tap, one mat4xvec4 and one RG16F
// write (~0.2 ms at 0.66 Mpx, 2.6 MB, 160 MB/s). It changes NO world material,
// which is the whole reason it is the default: see mrtVelocity.ts's header for
// the three measured reasons true per-object velocity cannot be.
//
// What it gets wrong, honestly: a moving object reports CAMERA-only motion. That
// is not a smear, because TAAU's history rejection is driven by previous DEPTH
// as much as by velocity (TAAUNode.js:678 isDisocclusion, :744 isDepthChanged) —
// when a car, a bird, a kite or a wave moves, the depth at that pixel changes
// and the history is thrown away. The failure mode is "moving objects are less
// anti-aliased", not "moving objects smear", and that is the better failure.
import * as THREE from "three/webgpu"
import { Fn, float, getViewPosition, max, screenUV, vec2, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
import type { PostFrameContext, PostStageSetup } from "../types"
import type { VelocitySourceImpl } from "./source"

/** Underscores only — targets.ts emits this verbatim as a WGSL identifier. */
export const REPROJECT_TARGET_NAME = "post_velocity_reproject"

/**
 * Largest motion we will write, in NDC units (2.0 NDC = one full screen).
 *
 * This is a NaN/Inf fence, not a quality knob — the temporal resolve's own
 * `maxVelocityLength` (BRIEF §4, default 48 px) is the knob, and it is two
 * orders of magnitude tighter. The fence matters because a surface that was
 * BEHIND the previous camera reprojects through a near-zero or negative `w`,
 * and rg16float saturates to Inf at 65504; an Inf in the velocity buffer
 * poisons every neighbourhood the resolve reads it into, not just its own texel.
 * Clamping the direction-preserving magnitude keeps such pixels large enough
 * that the resolve rejects them and finite enough that they cannot spread.
 */
const MAX_NDC_MOTION = 4.0

/** Smallest |w| we will divide by. See MAX_NDC_MOTION. */
const W_EPSILON = 1e-6

export function createReprojectSource(setup: PostStageSetup): VelocitySourceImpl {
  const { gbuffer, matrices, allocTarget } = setup

  // rg16float at INPUT resolution — exactly the beauty pass's grid, so the
  // depth tap below is a 1:1 texel fetch and no reconstruction filter sits
  // between the depth we read and the pixel we write.
  const target = allocTarget({
    name: REPROJECT_TARGET_NAME,
    resolution: "input",
    format: THREE.RGFormat,
    type: THREE.HalfFloatType
  })

  const quad = createStageQuad(REPROJECT_TARGET_NAME)
  quad.setFragment(
    Fn(() => {
      const uv = screenUV

      // Raw depth, reversed: background is 0.0 and near is 1.0. There is
      // deliberately NO comparison against 1.0 anywhere in this pass and no
      // background branch at all — see the note under `prevClip` for why the
      // sky falls out correct without one.
      const depth = gbuffer.depth.sample(uv).r

      // UNJITTERED on both sides. `getViewPosition` is already reversed-Z
      // correct (shared/reversedDepth.ts documents the three source lines that
      // make it so) — do NOT add a oneMinus() here.
      //
      // Using the unjittered inverse to unproject a pixel that was RASTERISED
      // with the jittered projection is off by the sub-pixel jitter, and that is
      // the point: the same convention is used to form `currentNdc` below, so a
      // stationary camera whose only change is the Halton offset reads exactly
      // zero motion. Mixing the two (jittered unproject, unjittered reproject)
      // would instead publish the jitter delta itself as motion, which is the
      // one thing a temporal resolve must never be told.
      const viewPos = getViewPosition(uv, depth, matrices.projectionInverseUnjittered)

      // `reprojectFromView` is previousUnjitteredViewProjection x cameraWorld,
      // folded on the CPU in float64 (shared/matrices.ts). BRIEF §3.4 writes
      // this as two steps through world space; it is the same product, and
      // associating it this way keeps an SF-scale world coordinate — thousands
      // of metres, subtracted back off to recover a sub-pixel offset — out of
      // float32 entirely, for one fewer per-pixel matrix multiply.
      const prevClip = matrices.reprojectFromView.mul(vec4(viewPos, 1.0)).toVar()

      // Background: depth 0.0 unprojects to the far plane rather than to
      // infinity, so the sky reprojects with a parallax error of
      // (camera translation / far) radians — ~1e-5 rad at this world's far
      // plane, i.e. far under a thousandth of a pixel. A branch to special-case
      // it would cost more than it corrects, and branchless is also what keeps
      // this pass free of any control flow at all.
      const w = prevClip.w.toVar()
      const signedW = w
        .abs()
        .max(W_EPSILON)
        .mul(w.lessThan(0.0).select(float(-1.0), float(1.0)))
      const prevNdc = prevClip.xy.div(signedW)

      // Current NDC from uv, in getViewPosition's own convention
      // (PostProcessingUtils.js:24 under WebGPUCoordinateSystem): x maps
      // straight through, y is FLIPPED. So this buffer's +y is NDC up, not uv
      // down — a consumer wanting a uv-space or texel-space offset must negate
      // y. `motionUvAt()` in ./source.ts is the one place that conversion is
      // written down.
      const currentNdc = vec2(uv.x, uv.y.oneMinus()).mul(2.0).sub(1.0)

      const motion = currentNdc.sub(prevNdc).toVar()
      // Direction-preserving magnitude clamp. `max()` with the limit means the
      // scale is exactly 1 for everything under it, so this is free in the
      // common case and cannot itself perturb a good vector.
      const limited = motion.mul(
        float(MAX_NDC_MOTION).div(max(float(MAX_NDC_MOTION), motion.length()))
      )

      return vec4(limited, 0.0, 1.0)
    })()
  )

  return {
    kind: "reproject",
    texture: () => target.texture,
    render: (frame: PostFrameContext) => {
      // Clear to zero: "no motion" is the value a discarded pixel should keep,
      // and this target is never read before it is written anyway.
      quad.render(frame.renderer, target, 0x000000, 0)
    },
    warmupQuads: () => [quad.mesh],
    dispose: () => quad.dispose()
  }
}
