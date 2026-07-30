// Forked from three/examples/jsm/tsl/display/TAAUNode.js — three r185 (0.185.1).
//
// Upstream is a TempNode that schedules itself through the node graph and
// mutates a global velocity singleton. This fork keeps upstream's MATH — the
// 9-tap Blackman-Harris reconstruction (:696-713), the variance clip, the
// thin-feature lock channel (:736-750), the flicker reduction — and replaces
// everything about how it is DRIVEN. Method bodies stay in upstream's order with
// upstream line references so the two remain diffable.
//
// EVERY DEVIATION, and why:
//
//  1. NOT A NODE AT ALL (upstream: `extends TempNode`, `updateBeforeType =
//     NodeUpdateType.FRAME`, :68). `Renderer.js:3778` fires `_nodes.updateBefore`
//     from inside an open render pass; a node that renders its own quads from
//     there makes WebGPU reject the whole command buffer and the frame comes out
//     as bare clear colour — measured at ~70% of captures
//     (contactShadows.ts:326-345). `updateBeforeType = NodeUpdateType.NONE` is
//     the minimum fix; not being reachable from any node graph is the complete
//     one. The chain calls `render(renderer, frame)` explicitly, with no pass
//     open. Consequence: `setup(builder)` never runs, so the TSL is built in the
//     constructor, where the renderer — the only thing upstream needed the
//     builder for — is already known.
//
//  2. PREVIOUS-DEPTH FORMAT (upstream :186, :485). Untyped `DepthTexture` is
//     `depth24plus-stencil8`; under `reversedDepthBuffer` the scene depth is
//     `depth32float`, and `copyTextureToTexture` between them is a hard WebGPU
//     rejection every frame. TRAANode.js:466-470 ported — see
//     ../common.ts:createPreviousDepth.
//
//  3. DEPTH DILATION WAS INVERTED (upstream :538-566). Upstream seeds
//     `closestDepth = float(2)` and takes `min()` over the 3x3 neighbourhood
//     with no `oneMinus()`. Under reversed Z, background is 0.0 and near is 1.0,
//     so `min()` picks the FARTHEST neighbour and `closestPositionTexel` — which
//     :670 uses to sample velocity — points AWAY from every silhouette. The
//     result is edge ghosting on every moving object, which reads exactly like a
//     tuning problem. TRAANode.js:510-513 ported: convert to standard depth once,
//     at the sample, and the rest of the function is upstream's.
//
//  4. DEPTH SPACES ARE NOW ONE SPACE. `samplePreviousDepth` returns STANDARD
//     depth (:579, via the non-reversed `viewZToPerspectiveDepth` — three's
//     depth<->viewZ helpers are asymmetric, see shared/reversedDepth.ts). With
//     (3) fixed, `closestDepth` is standard too, so every comparison in the
//     resolve is in one space, exactly as TRAA is. The all-reversed variant is
//     deliberately NOT also attempted.
//
//  5. NO GLOBAL VELOCITY SINGLETON (upstream :334, :365, :510-525). Both
//     `velocity.setProjectionMatrix()` calls and the
//     `renderPipeline.context.onBeforeRenderPipeline` assignment are gone. That
//     slot is a SINGLE assignable field (RenderPipeline.js:200-204) that TRAA,
//     TAAU and TemporalReproject all write, so whichever is constructed second
//     silently wins. We own the jitter (post/jitter) and our velocity is
//     unjittered by construction (BRIEF §3.4), so nothing here needs it.
//
//  6. THE LOCK RIDES IN THE HISTORY'S ALPHA, and the history PING-PONGS.
//     Upstream renders colour and lock as TWO fragment outputs (:643, :767) into
//     a ONE-attachment resolve target (:171) and then blits that into a
//     two-attachment history (:462). WebGPU derives the fragment target list
//     from `renderTarget.textures` (WebGPUPipelineUtils.js:127-176), so upstream
//     as written cannot create that pipeline, and the lock channel it feeds
//     could never have been written. Both problems disappear if the lock lives
//     in the alpha of the single rgba16f history — nothing downstream of the
//     resolve reads alpha (the display tail samples `.rgb`), the lock is
//     saturated so 16 bits is generous, and it costs no second fetch because it
//     arrives with the history colour.
//     ** CONTRACT FOR DOWNSTREAM STAGES: the temporal output's alpha is the
//     lock, not opacity. Sample `.rgb`. **
//     Ping-ponging two history targets then removes upstream's two
//     output-resolution blits entirely: the resolve writes the new history
//     directly and the chain rebinds downstream slots every frame anyway
//     (chain.ts:220), so an output texture that alternates costs one binding
//     update — the mechanism DepthOfFieldNode.js:294 uses three times per frame.
//     Also keeps the two quads MRT-free, which matters because
//     `compileFullscreenQuads` compiles with no render target bound and a
//     two-output fragment shader would fail pipeline creation there.
//     Net: 23.8 MB of history at 1.485 Mpx against upstream's 35.7 MB, and two
//     fewer full-resolution copies per frame.
//
//  7. THE LOCK IS REPROJECTED. Upstream reads it at the CURRENT uv (:749) while
//     the colour it gates is read at the reprojected `historyUV` (:727), so under
//     any camera motion the lock is misaligned with the history it locks. Both
//     are history; both are now read at `historyUV` — the same fetch.
//
//  8. TUNABLES ARE UNIFORMS. `depthThreshold`, `edgeDepthDiff`,
//     `maxVelocityLength`, `currentFrameWeight` and the variance gamma pair are
//     JS literals baked into the graph upstream (`float(this.currentFrameWeight)`
//     at :752); here they are uniforms, so the panel drives them live and the
//     stage can declare an empty `recompileKeys`.
//
//  9. NaN GUARD on the thin-feature ratio (:738 divides by `meanLuma`). A black
//     pixel makes that NaN, the NaN reaches `mix()` into the history, and a NaN
//     in a temporal accumulator is permanent — it never washes out. `.max(1e-5)`,
//     the same defence upstream already applies to `sumWeight` at :715.
//
// 10. VELOCITY MAY BE ABSENT (BRIEF §3.4 ships the velocity stage separately and
//     the user can switch it off). With no velocity node the reprojection offset
//     is a constant zero: history is compared at the same pixel, which under
//     camera motion is rejected by the previous-depth disocclusion test rather
//     than smeared. A `velocityGain` uniform does the same thing without a
//     rebuild when the buffer exists but is not being written this frame.
import * as THREE from "three/webgpu"
import {
  Fn,
  If,
  add,
  exp,
  float,
  getViewPosition,
  ivec2,
  luminance,
  max,
  mix,
  struct,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
  viewZToPerspectiveDepth
} from "three/tsl"
import { ndcMotionToUv } from "../../velocity/source"
import { createStageQuad, type StageQuad } from "../../shared/fullscreen"
import type { N } from "../../types"
import {
  createPreviousDepth,
  createTemporalCameraUniforms,
  type PreviousDepth,
  type TemporalCameraUniforms,
  type TemporalParams,
  type TemporalResolve,
  type TemporalResolveFrame
} from "../common"

export type TaauOptions = {
  readonly renderer: THREE.WebGPURenderer
  readonly camera: THREE.PerspectiveCamera
  /** INPUT-resolution colour. The chain rebinds this slot node every frame. */
  readonly beautyNode: N
  /** INPUT-resolution raw depth, reversed-Z. */
  readonly depthNode: N
  /** INPUT-resolution NDC motion, or null when no velocity stage is running. */
  readonly velocityNode: N | null
}

/** Upstream's 9 taps, in upstream's order (:690-694). */
const RECONSTRUCTION_TAPS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
]

export class TaauResolve implements TemporalResolve {
  private readonly renderer: THREE.WebGPURenderer
  private readonly depthNode: N

  private readonly cameraUniforms: TemporalCameraUniforms
  private readonly previousDepth: PreviousDepth

  private readonly depthThreshold = uniform(0.0005) as N
  private readonly edgeDepthDiff = uniform(0.001) as N
  private readonly maxVelocityLength = uniform(48) as N
  private readonly currentFrameWeight = uniform(0.06) as N
  private readonly varianceGammaMin = uniform(0.5) as N
  private readonly varianceGammaMax = uniform(1) as N
  private readonly velocityGain = uniform(1) as N
  private readonly jitterOffset = uniform(new THREE.Vector2()) as N

  /** rgb = accumulated colour, a = thin-feature lock. Roles alternate per frame. */
  private readonly history: [THREE.RenderTarget, THREE.RenderTarget]
  private readIndex = 0

  private readonly historyNode: N

  private readonly resolveQuad: StageQuad
  private readonly seedQuad: StageQuad

  constructor(options: TaauOptions) {
    this.renderer = options.renderer
    this.depthNode = options.depthNode

    this.cameraUniforms = createTemporalCameraUniforms(options.camera)
    this.previousDepth = createPreviousDepth(options.renderer, "post_temporal_previous_depth")

    this.history = [createHistoryTarget("a"), createHistoryTarget("b")]
    this.historyNode = texture(this.history[0].texture) as N
    this.historyNode.name = "post_temporal_history"

    this.resolveQuad = createStageQuad("post_temporal_resolve")
    this.seedQuad = createStageQuad("post_temporal_seed")

    this.build(options)
  }

  /** Upstream `setup( builder )`, :502-782, minus the render-pipeline plumbing. */
  private build(options: TaauOptions): void {
    const { beautyNode, velocityNode } = options
    const depthNode = this.depthNode
    const camera = this.cameraUniforms
    const reversed = this.renderer.reversedDepthBuffer === true

    const currentDepthStruct = struct({
      closestDepth: "float",
      closestPositionTexel: "vec2",
      farthestDepth: "float"
    })

    // Upstream :538-566, with TRAANode.js:510-513's conversion. The If()s are
    // data-dependent, which is fine: the bodies only assign, and every read here
    // is a `textureLoad` (no implicit derivatives), so nothing in this function
    // needs uniform control flow.
    const sampleCurrentDepth = Fn(([positionTexel]: N[]) => {
      const closestDepth = float(2).toVar()
      const closestPositionTexel = vec2(0).toVar()
      const farthestDepth = float(-1).toVar()

      for (let x = -1; x <= 1; ++x) {
        for (let y = -1; y <= 1; ++y) {
          const neighbor = positionTexel.add(vec2(x, y)).toVar()
          let depth: N = depthNode.load(neighbor).r
          // Reversed Z: background 0.0, near 1.0. This one conversion puts the
          // whole resolve in standard-depth space — the space
          // samplePreviousDepth() returns — so `min` really is nearest.
          if (reversed) depth = depth.oneMinus()
          depth = depth.toVar()

          If(depth.lessThan(closestDepth), () => {
            closestDepth.assign(depth)
            closestPositionTexel.assign(neighbor)
          })

          If(depth.greaterThan(farthestDepth), () => {
            farthestDepth.assign(depth)
          })
        }
      }

      return currentDepthStruct(closestDepth, closestPositionTexel, farthestDepth)
    })

    // Upstream :573-581. `getViewPosition(uv, rawDepth, projectionInverse)` is
    // already correct under reversed depth — the camera's inverse IS the
    // reversed inverse (Matrix4.js:1159) and PostProcessingUtils feeds raw depth
    // straight into clip.z. Do NOT add a oneMinus() here.
    const samplePreviousDepth = (uvNode: N): N => {
      const depth = this.previousDepth.node.sample(uvNode).r
      const positionView = getViewPosition(uvNode, depth, camera.previousProjectionInverse)
      const positionWorld = camera.previousWorldMatrix.mul(vec4(positionView, 1)).xyz
      const viewZ = camera.worldMatrixInverse.mul(vec4(positionWorld, 1)).z
      return viewZToPerspectiveDepth(viewZ, camera.nearFar.x, camera.nearFar.y)
    }

    // Upstream :585-607, verbatim. https://github.com/playdeadgames/temporal
    const clipAABB = Fn(([currentColor, historyColor, minColor, maxColor]: N[]) => {
      const pClip = maxColor.rgb.add(minColor.rgb).mul(0.5)
      const eClip = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7)
      const vClip = historyColor.sub(vec4(pClip, currentColor.a))
      const vUnit = vClip.xyz.div(eClip)
      const absUnit = vUnit.abs()
      const maxUnit = max(absUnit.x, absUnit.y, absUnit.z)
      return maxUnit
        .greaterThan(1)
        .select(vec4(pClip, currentColor.a).add(vClip.div(maxUnit)), historyColor)
    }).setLayout({
      name: "clipAABB",
      type: "vec4",
      inputs: [
        { name: "currentColor", type: "vec4" },
        { name: "historyColor", type: "vec4" },
        { name: "minColor", type: "vec4" },
        { name: "maxColor", type: "vec4" }
      ]
    })

    // Upstream :610-624, verbatim.
    const flickerReduction = Fn(([currentColor, historyColor, currentWeight]: N[]) => {
      const historyWeight = currentWeight.oneMinus()
      const compressedCurrent = currentColor.mul(
        float(1).div(max(currentColor.r, currentColor.g, currentColor.b).add(1))
      )
      const compressedHistory = historyColor.mul(
        float(1).div(max(historyColor.r, historyColor.g, historyColor.b).add(1))
      )

      const luminanceCurrent = luminance(compressedCurrent.rgb)
      const luminanceHistory = luminance(compressedHistory.rgb)

      currentWeight.mulAssign(float(1).div(luminanceCurrent.add(1)))
      historyWeight.mulAssign(float(1).div(luminanceHistory.add(1)))

      return add(currentColor.mul(currentWeight), historyColor.mul(historyWeight))
        .div(max(currentWeight.add(historyWeight), 0.00001))
        .toVar()
    })

    // Upstream :645-762.
    //
    // For each OUTPUT pixel: map it into input-pixel space, find the input
    // sample nearest to it (the jitter says where that sample actually landed),
    // and reconstruct the current colour as a Blackman-Harris-weighted sum of
    // the 3x3 neighbourhood around it. The same neighbourhood supplies the
    // moments for the variance clip, so the history costs no second gather.
    const resolve = Fn(() => {
      const uvNode = uv()
      const inputSize = beautyNode.size() // ivec2 of whatever is bound this frame
      const inputSizeF = vec2(inputSize)

      const pIn = uvNode.mul(inputSizeF)

      // The input sample at integer texel (m,n) was rendered at
      // (m + 0.5 + jitter), so the nearest tap solves to this.
      const closestTapF: N = pIn.sub(vec2(0.5).add(this.jitterOffset)).round()
      const closestTap = ivec2(closestTapF)

      const currentDepth = sampleCurrentDepth(closestTapF)
      const closestDepth: N = currentDepth.get("closestDepth")
      const closestPositionTexel: N = currentDepth.get("closestPositionTexel")
      const farthestDepth: N = currentDepth.get("farthestDepth")

      // Reproject with the velocity sampled at the DILATED tap — the whole point
      // of fix (3): under reversed Z that tap now really is the nearest one, so
      // a silhouette carries its own motion instead of the background's.
      // `ndcMotionToUv` is U1's, deliberately: the buffer is NDC (y up) and
      // every consumer samples in uv (y down), and their header records that
      // getting that negate wrong "looks like vertical ghosting that gets WORSE
      // when you tighten the velocity clamp". One home for the convention.
      const offsetUV: N =
        velocityNode === null
          ? vec2(0)
          : ndcMotionToUv(velocityNode.load(closestPositionTexel).xy).mul(this.velocityGain)
      const historyUV = uvNode.sub(offsetUV)
      const previousDepth = samplePreviousDepth(historyUV)

      const isValidUV = historyUV.greaterThanEqual(0).all().and(historyUV.lessThanEqual(1).all())
      const isEdge = farthestDepth.sub(closestDepth).greaterThan(this.edgeDepthDiff)
      const isDisocclusion = closestDepth.sub(previousDepth).greaterThan(this.depthThreshold)
      const hasValidHistory = isValidUV.and(isEdge.or(isDisocclusion.not()))

      const sumColor = vec4(0).toVar()
      const sumWeight = float(0).toVar()
      const moment1 = vec4(0).toVar()
      const moment2 = vec4(0).toVar()

      for (const [x, y] of RECONSTRUCTION_TAPS) {
        const tap = closestTap.add(ivec2(x, y))
        const tapCenter = vec2(tap).add(vec2(0.5).add(this.jitterOffset))
        const delta = pIn.sub(tapCenter)
        const d2 = delta.dot(delta)
        const w = exp(d2.mul(-2.29))

        // max() so a NaN in the source cannot propagate into the history.
        const c = beautyNode.load(tap).max(0)

        sumColor.addAssign(c.mul(w))
        sumWeight.addAssign(w)

        moment1.addAssign(c)
        moment2.addAssign(c.pow2())
      }

      const currentColor = sumColor.div(sumWeight.max(1e-5))

      const tapCount = float(RECONSTRUCTION_TAPS.length)
      const mean = moment1.div(tapCount)
      const motionFactor = uvNode
        .sub(historyUV)
        .mul(inputSizeF)
        .length()
        .div(this.maxVelocityLength)
        .saturate()
      const varianceGamma = mix(
        this.varianceGammaMin,
        this.varianceGammaMax,
        motionFactor.oneMinus().pow2()
      )
      const variance = moment2.div(tapCount).sub(mean.pow2()).max(0).sqrt().mul(varianceGamma)
      const minColor = mean.sub(variance)
      const maxColor = mean.add(variance)

      // One fetch: rgb is the accumulated colour, a is last frame's lock, and
      // both are reprojected because they are both history.
      const historyColor = this.historyNode.sample(historyUV).toVar()
      const clippedHistoryColor = clipAABB(
        mean.clamp(minColor, maxColor),
        historyColor,
        minColor,
        maxColor
      )

      // The thin-feature lock: a pixel whose luma stands well clear of its
      // neighbourhood mean is a wire, a railing or a mast — exactly what the
      // variance clip erases every frame. Locking keeps the UNCLIPPED history
      // for those pixels, and the lock decays unless it is re-earned.
      const currentLuma = luminance(currentColor.rgb)
      const meanLuma = luminance(mean.rgb).toConst()
      const thinFeature = currentLuma.sub(meanLuma).abs().div(meanLuma.max(1e-5)).smoothstep(0, 0.2)

      // Two-sided: `isDisocclusion` only fires when the scene moves FARTHER, but
      // new geometry appearing closer makes the history just as stale.
      const isDepthChanged = closestDepth.sub(previousDepth).abs().greaterThan(this.depthThreshold)
      const canLock = isValidUV.and(isDepthChanged.not())
      const gatedThinFeature = canLock.select(thinFeature, float(0))

      const decay = isDisocclusion.select(0, 0.5)
      const lock = max(gatedThinFeature, historyColor.a.mul(decay)).saturate().toVar()
      const lockedHistoryColor = mix(clippedHistoryColor, historyColor, lock)

      const currentWeight = this.currentFrameWeight.toVar()
      currentWeight.assign(hasValidHistory.select(currentWeight.add(motionFactor).saturate(), 1))

      const output: N = flickerReduction(currentColor, lockedHistoryColor, currentWeight)

      return vec4(output.rgb, lock)
    })

    this.resolveQuad.setFragment(resolve())

    // Upstream :769-778. A bilinear upscale of the current beauty buffer, so the
    // first frame after a resize or a teleport starts from the picture instead
    // of fading up from black. Alpha (the lock) seeds to zero.
    this.seedQuad.setFragment(
      Fn(() => {
        return vec4(beautyNode.sample(uv()).rgb, 0)
      })()
    )
  }

  /** Upstream `updateBefore( frame )`, :379-494 — driven by the chain, not the graph. */
  render(renderer: THREE.WebGPURenderer, frame: TemporalResolveFrame): void {
    const width = Math.max(1, Math.round(frame.outputWidth))
    const height = Math.max(1, Math.round(frame.outputHeight))

    let seed = frame.seed
    if (this.history[0].width !== width || this.history[0].height !== height) {
      for (const target of this.history) {
        target.setSize(width, height)
        // setSize() disposes, so the targets must be re-initialised before
        // anything renders into or samples from them (upstream :425-426).
        renderer.initRenderTarget(target)
      }
      seed = true
    }

    this.cameraUniforms.advance(seed)
    ;(this.jitterOffset.value as THREE.Vector2).set(frame.jitterX, frame.jitterY)

    const read = this.history[this.readIndex]
    const write = this.history[this.readIndex ^ 1]

    if (seed) {
      // The scene depth texture still holds THIS frame's depth, so seeding the
      // previous-depth copy here makes the disocclusion test compare the frame
      // against itself. Without it the first frame after a teleport tests
      // against depth from wherever the camera used to be and rejects the
      // history it was just handed.
      this.previousDepth.sync(renderer, this.depthNode)
      this.seedQuad.render(renderer, read)
    }

    this.historyNode.value = read.texture
    this.resolveQuad.render(renderer, write)
    this.readIndex ^= 1

    this.previousDepth.sync(renderer, this.depthNode)
  }

  outputTexture(): THREE.Texture {
    return this.history[this.readIndex].texture
  }

  quads(): THREE.QuadMesh[] {
    return [this.resolveQuad.mesh, this.seedQuad.mesh]
  }

  setParams(params: TemporalParams): void {
    this.depthThreshold.value = params.depthThreshold
    this.edgeDepthDiff.value = params.edgeDepthDiff
    this.maxVelocityLength.value = params.maxVelocityLength
    this.currentFrameWeight.value = params.currentFrameWeight
    this.varianceGammaMin.value = params.varianceGammaMin
    this.varianceGammaMax.value = params.varianceGammaMax
  }

  setVelocityGain(gain: number): void {
    this.velocityGain.value = gain
  }

  dispose(): void {
    for (const target of this.history) target.dispose()
    this.previousDepth.dispose()
    this.resolveQuad.dispose()
    this.seedQuad.dispose()
  }
}

/** Upstream :160-162, collapsed to one attachment — see deviation (6). */
function createHistoryTarget(suffix: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter
  })
  target.texture.name = `post_temporal_history_${suffix}`
  return target
}
