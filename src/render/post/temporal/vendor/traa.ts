// Forked from three/examples/jsm/tsl/display/TRAANode.js — three r185 (0.185.1).
//
// THE DECLARED FALLBACK (BRIEF §4.5). TRAA is the only temporal node in three's
// display folder that is already correct under `reversedDepthBuffer` — the two
// lines in the entire folder that account for reversed depth are TRAANode.js:466
// and :511 — so if the TAAU fork misbehaves in verification we switch
// `post.temporal.mode` to "traa", lose the upscaling win and keep the AA. It has
// no reconstruction filter and no thin-feature lock; it is the same resolve at
// one sample per output pixel.
//
// DEVIATIONS from upstream, and why:
//
//  1. NOT A NODE (upstream `extends TempNode`, `updateBeforeType =
//     NodeUpdateType.FRAME`, :58). Identical reasoning to the TAAU fork's
//     deviation (1) — see vendor/taau.ts. The chain drives `render()` with no
//     pass open; `setup(builder)` never runs, so the graph is built in the
//     constructor.
//
//  2. NO GLOBAL VELOCITY SINGLETON (upstream :296, :332, :451-462). We own the
//     jitter and our velocity is unjittered by construction.
//
//  3. PREVIOUS DEPTH LIVES IN ITS OWN INPUT-RESOLUTION TARGET, not in the
//     history target's depth attachment (upstream :145, :426). Upstream can
//     share because history and beauty are the same size; here the history is at
//     OUTPUT resolution and the scene depth is at INPUT resolution, and
//     `copyTextureToTexture` between mismatched extents is a WebGPU rejection.
//     ../common.ts:createPreviousDepth owns the copy, its `depth32float` fix and
//     the resize guard upstream words at :418-429.
//
//  4. RESOLVES AT OUTPUT RESOLUTION even when the beauty pass is smaller. Every
//     neighbourhood read is a texel load in INPUT space (`uv * beautySize`) and
//     every history read is a normalised UV, so the only thing a smaller input
//     changes is that `currentColor` becomes a bilinear upscale. That makes the
//     fallback safe whether or not `postInputScale()` has been taught to clamp
//     to 1 in this mode; at scale 1 it is upstream's behaviour exactly.
//
//  5. PING-PONGED HISTORY instead of resolve-then-blit (upstream :404-412), and
//     no separate resolve target. Same reasoning as the TAAU fork's deviation
//     (6): the chain rebinds downstream slots every frame, so alternating the
//     output texture costs a binding update and saves a full-resolution copy.
//
//  6. TUNABLES ARE UNIFORMS, including upstream's baked minimum current weight
//     (`float(0.05)` at :686), which becomes `currentFrameWeight`.
//
//  7. THE LOGARITHMIC-DEPTH BRANCH IS GONE (:482-488, :512, :540). This project
//     never enables `logarithmicDepthBuffer`, and that branch is the one place
//     upstream mixes the non-reversed `viewZToPerspectiveDepth` into a depth it
//     has already converted.
//
//  8. Velocity may be absent; see the TAAU fork's deviation (10).
import * as THREE from "three/webgpu"
import {
  Fn,
  If,
  add,
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

export type TraaOptions = {
  readonly renderer: THREE.WebGPURenderer
  readonly camera: THREE.PerspectiveCamera
  readonly beautyNode: N
  readonly depthNode: N
  readonly velocityNode: N | null
}

/** Upstream :580-589. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]

export class TraaResolve implements TemporalResolve {
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

  private readonly history: [THREE.RenderTarget, THREE.RenderTarget]
  private readIndex = 0
  private readonly historyNode: N

  private readonly resolveQuad: StageQuad
  private readonly seedQuad: StageQuad

  constructor(options: TraaOptions) {
    this.renderer = options.renderer
    this.depthNode = options.depthNode

    this.cameraUniforms = createTemporalCameraUniforms(options.camera)
    this.previousDepth = createPreviousDepth(options.renderer, "post_traa_previous_depth")

    this.history = [createHistoryTarget("a"), createHistoryTarget("b")]
    this.historyNode = texture(this.history[0].texture) as N
    this.historyNode.name = "post_traa_history"

    this.resolveQuad = createStageQuad("post_traa_resolve")
    this.seedQuad = createStageQuad("post_traa_seed")

    this.build(options)
  }

  /** Upstream `setup( builder )`, :443-716. */
  private build(options: TraaOptions): void {
    const { beautyNode, velocityNode } = options
    const depthNode = this.depthNode
    const camera = this.cameraUniforms
    const reversed = this.renderer.reversedDepthBuffer === true

    const currentDepthStruct = struct({
      closestDepth: "float",
      closestPositionTexel: "vec2",
      farthestDepth: "float"
    })

    // Upstream :499-534, including its reversed-depth conversion at :511 — the
    // line the TAAU fork had to import.
    const sampleCurrentDepth = Fn(([positionTexel]: N[]) => {
      const closestDepth = float(2).toVar()
      const closestPositionTexel = vec2(0).toVar()
      const farthestDepth = float(-1).toVar()

      for (let x = -1; x <= 1; ++x) {
        for (let y = -1; y <= 1; ++y) {
          const neighbor = positionTexel.add(vec2(x, y)).toVar()
          let depth: N = depthNode.load(neighbor).r
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

    // Upstream :537-548, perspective branch only (this project has no
    // orthographic beauty camera).
    const samplePreviousDepth = (uvNode: N): N => {
      const depth = this.previousDepth.node.sample(uvNode).r
      const positionView = getViewPosition(uvNode, depth, camera.previousProjectionInverse)
      const positionWorld = camera.previousWorldMatrix.mul(vec4(positionView, 1)).xyz
      const viewZ = camera.worldMatrixInverse.mul(vec4(positionWorld, 1)).z
      return viewZToPerspectiveDepth(viewZ, camera.nearFar.x, camera.nearFar.y)
    }

    // Upstream :552-574, verbatim.
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

    // Upstream :578-611.
    const varianceClipping = Fn(([positionTexel, currentColor, historyColor, gamma]: N[]) => {
      const moment1 = currentColor.toVar()
      const moment2 = currentColor.pow2().toVar()

      for (const [x, y] of NEIGHBOUR_OFFSETS) {
        // max() so a NaN in the source cannot propagate into the history.
        const neighbor = beautyNode.offset(ivec2(x, y)).load(positionTexel).max(0)
        moment1.addAssign(neighbor)
        moment2.addAssign(neighbor.pow2())
      }

      const count = float(NEIGHBOUR_OFFSETS.length + 1)
      const mean = moment1.div(count)
      const variance = moment2.div(count).sub(mean.pow2()).max(0).sqrt().mul(gamma)
      const minColor = mean.sub(variance)
      const maxColor = mean.add(variance)

      return clipAABB(mean.clamp(minColor, maxColor), historyColor, minColor, maxColor)
    })

    // Upstream :614-628. How much of the velocity is sub-pixel.
    const subpixelCorrection = Fn(([velocityUV, textureSize]: N[]) => {
      const velocityTexel = velocityUV.mul(textureSize)
      const phase = velocityTexel.fract().abs()
      const weight: N = max(phase, phase.oneMinus())
      return weight.x.mul(weight.y).oneMinus().div(0.75)
    }).setLayout({
      name: "subpixelCorrection",
      type: "float",
      inputs: [
        { name: "velocityUV", type: "vec2" },
        { name: "textureSize", type: "ivec2" }
      ]
    })

    // Upstream :631-645, verbatim.
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

    // Upstream :649-708.
    const resolve = Fn(() => {
      const uvNode = uv()
      const textureSize = beautyNode.size() // INPUT resolution; see deviation (4)
      const positionTexel = uvNode.mul(vec2(textureSize))

      const currentDepth = sampleCurrentDepth(positionTexel)
      const closestDepth: N = currentDepth.get("closestDepth")
      const closestPositionTexel: N = currentDepth.get("closestPositionTexel")
      const farthestDepth: N = currentDepth.get("farthestDepth")

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

      const currentColor = beautyNode.sample(uvNode)
      const historyColor = this.historyNode.sample(historyUV)

      const motionFactor = uvNode
        .sub(historyUV)
        .mul(vec2(textureSize))
        .length()
        .div(this.maxVelocityLength)
        .saturate()

      const currentWeight = this.currentFrameWeight.toVar()
      // Bias toward the current frame when the velocity is mostly sub-pixel;
      // that is where reprojection blurs most and costs least to reject.
      currentWeight.addAssign(subpixelCorrection(offsetUV, textureSize).mul(0.25))
      currentWeight.assign(hasValidHistory.select(currentWeight.add(motionFactor).saturate(), 1))

      const varianceGamma = mix(
        this.varianceGammaMin,
        this.varianceGammaMax,
        motionFactor.oneMinus().pow2()
      )
      const clippedHistoryColor = varianceClipping(
        positionTexel,
        currentColor,
        historyColor,
        varianceGamma
      )

      return flickerReduction(currentColor, clippedHistoryColor, currentWeight)
    })

    this.resolveQuad.setFragment(resolve())
    this.seedQuad.setFragment(Fn(() => vec4(beautyNode.sample(uv()).rgb, 1))())
  }

  /** Upstream `updateBefore( frame )`, :346-435. */
  render(renderer: THREE.WebGPURenderer, frame: TemporalResolveFrame): void {
    const width = Math.max(1, Math.round(frame.outputWidth))
    const height = Math.max(1, Math.round(frame.outputHeight))

    let seed = frame.seed
    if (this.history[0].width !== width || this.history[0].height !== height) {
      for (const target of this.history) {
        target.setSize(width, height)
        renderer.initRenderTarget(target)
      }
      seed = true
    }

    this.cameraUniforms.advance(seed)

    const read = this.history[this.readIndex]
    const write = this.history[this.readIndex ^ 1]

    if (seed) {
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

function createHistoryTarget(suffix: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter
  })
  target.texture.name = `post_traa_history_${suffix}`
  return target
}
