import * as THREE from "three/webgpu"
import { texture, uniform } from "three/tsl"
import type { N } from "../types"

/**
 * What the two forked temporal resolves have in common: the shape the stage
 * drives them through, the live-tunable bag, and the two pieces of machinery
 * that are OURS rather than upstream's (the camera-history bookkeeping and the
 * previous-depth copy, which is where the hard WebGPU error lives).
 *
 * These live outside `vendor/` on purpose. Everything in `vendor/` should stay
 * diffable against the three file it was forked from; this is the part that has
 * no upstream counterpart.
 */

export type TemporalParams = {
  readonly depthThreshold: number
  readonly edgeDepthDiff: number
  /** In INPUT pixels. */
  readonly maxVelocityLength: number
  readonly currentFrameWeight: number
  readonly varianceGammaMin: number
  readonly varianceGammaMax: number
}

export type TemporalResolveFrame = {
  readonly outputWidth: number
  readonly outputHeight: number
  /** The offset the beauty pass this frame was rendered with, in INPUT pixels. */
  readonly jitterX: number
  readonly jitterY: number
  /** Discard the accumulated history and re-seed from the current frame. */
  readonly seed: boolean
}

export interface TemporalResolve {
  /** Called ONLY from the chain driver, with no render pass open. */
  render(renderer: THREE.WebGPURenderer, frame: TemporalResolveFrame): void
  /** The resolved colour, at output resolution. Valid after render(). */
  outputTexture(): THREE.Texture
  /** Every quad whose WGSL must exist before the first live frame. */
  quads(): THREE.QuadMesh[]
  setParams(params: TemporalParams): void
  /** 1 = reproject with the velocity buffer, 0 = ignore it (see index.ts). */
  setVelocityGain(gain: number): void
  dispose(): void
}

// --------------------------------------------------------------- camera history

export type TemporalCameraUniforms = {
  readonly nearFar: N
  readonly worldMatrix: N
  readonly worldMatrixInverse: N
  readonly projectionInverse: N
  readonly previousWorldMatrix: N
  readonly previousProjectionInverse: N
  /**
   * Roll current → previous and re-read the camera. `seed` collapses the two so
   * the first frame after a reset compares against itself instead of against a
   * camera from before a teleport.
   */
  advance(seed: boolean): void
}

/**
 * Deliberately NOT `shared/matrices.ts`'s CameraHistory: that one publishes
 * view/viewProjection pairs, and the temporal resolve needs the camera's
 * `matrixWorld` from the PREVIOUS frame (to push last frame's depth back out to
 * world space), which CameraHistory does not keep. Same idea, different four
 * matrices, so it keeps its own copies exactly like stock does
 * (TAAUNode.js:385-393).
 *
 * These are read AFTER `jitter.clear()` (the chain runs after the beauty pass),
 * so both the current and the previous projection inverse are UNJITTERED. That
 * is deliberate and self-consistent: the previous depth is unprojected and the
 * result reprojected in the same unjittered space, which is also the space the
 * velocity buffer is computed in (BRIEF §3.4). The residual is the sub-pixel
 * offset between where a depth sample was rendered and where we unproject it —
 * bounded by half an output pixel, and it only feeds a threshold test.
 */
export function createTemporalCameraUniforms(
  camera: THREE.PerspectiveCamera
): TemporalCameraUniforms {
  const nearFar = uniform(new THREE.Vector2(camera.near, camera.far)) as N
  const worldMatrix = uniform(new THREE.Matrix4()) as N
  const worldMatrixInverse = uniform(new THREE.Matrix4()) as N
  const projectionInverse = uniform(new THREE.Matrix4()) as N
  const previousWorldMatrix = uniform(new THREE.Matrix4()) as N
  const previousProjectionInverse = uniform(new THREE.Matrix4()) as N

  const readCamera = () => {
    ;(nearFar.value as THREE.Vector2).set(camera.near, camera.far)
    ;(worldMatrix.value as THREE.Matrix4).copy(camera.matrixWorld)
    ;(worldMatrixInverse.value as THREE.Matrix4).copy(camera.matrixWorldInverse)
    ;(projectionInverse.value as THREE.Matrix4).copy(camera.projectionMatrixInverse)
  }

  const rollForward = () => {
    ;(previousWorldMatrix.value as THREE.Matrix4).copy(worldMatrix.value as THREE.Matrix4)
    ;(previousProjectionInverse.value as THREE.Matrix4).copy(
      projectionInverse.value as THREE.Matrix4
    )
  }

  readCamera()
  rollForward()

  return {
    nearFar,
    worldMatrix,
    worldMatrixInverse,
    projectionInverse,
    previousWorldMatrix,
    previousProjectionInverse,
    advance(seed: boolean) {
      rollForward()
      readCamera()
      if (seed) rollForward()
    }
  }
}

// -------------------------------------------------------------- previous depth

export type PreviousDepth = {
  /** Sample this for last frame's raw depth. Same reversed-Z convention as the source. */
  readonly node: N
  /** Copy the current scene depth in. Call at the END of the frame's work. */
  sync(renderer: THREE.WebGPURenderer, depthNode: N): void
  dispose(): void
}

/**
 * THE HARD WEBGPU ERROR, and its fix.
 *
 * Stock TAAU allocates `new DepthTexture()` with no type (TAAUNode.js:186) and
 * then copies the scene depth into it (`:485`). Under `reversedDepthBuffer`
 * three forces the scene pass's depth attachment to `FloatType`
 * (PassNode.js:770-772, and pipeline.ts:122-124 states it again because the pass
 * is driven explicitly and its setup() may never run), i.e. `depth32float` —
 * while an untyped DepthTexture is `depth24plus-stencil8`. That is a
 * mismatched-format `copyTextureToTexture` and WebGPU rejects it outright. Not
 * an artefact: a hard runtime failure, every frame.
 *
 * The fix is TRAANode.js:466-470's, ported: when the renderer is reversed, the
 * destination depth texture is FloatType too.
 *
 * Why a RenderTarget wraps the texture at all: `copyTextureToTexture` needs the
 * destination to be a real allocated GPU texture, and a render target is the one
 * shape three reliably materialises depth textures through (`initRenderTarget`).
 * It costs an unused colour attachment at input resolution (~2.6 MB at 0.66 Mpx)
 * and that is what stock pays too.
 *
 * The size guard is upstream's, kept verbatim in spirit (TAAUNode.js:471-488,
 * the same defence TRAANode.js:418-429 words as "there are timing issues with
 * WebGPU resulting in different size of the drawing buffer and the beauty render
 * target when resizing the browser window"): track the SOURCE texture's own
 * dimensions rather than any bookkeeping number, and skip the copy entirely
 * until the source has a size. A one-frame mismatch would be another rejected
 * command buffer.
 */
export function createPreviousDepth(
  renderer: THREE.WebGPURenderer,
  name: string
): PreviousDepth {
  const depthTexture = new THREE.DepthTexture(1, 1)
  depthTexture.name = name
  if (renderer.reversedDepthBuffer === true) {
    depthTexture.type = THREE.FloatType
  }

  const target = new THREE.RenderTarget(1, 1, { depthBuffer: false, depthTexture })
  target.texture.name = `${name}_unused_colour`

  const node = texture(depthTexture) as N
  node.name = name

  return {
    node,
    sync(activeRenderer: THREE.WebGPURenderer, depthNode: N) {
      const source = depthNode?.value as THREE.Texture | undefined
      const image = source?.image as { width?: number; height?: number } | undefined
      const width = image?.width ?? 0
      const height = image?.height ?? 0
      if (!source || width < 1 || height < 1) return

      if (target.width !== width || target.height !== height) {
        target.setSize(width, height)
        activeRenderer.initRenderTarget(target)
      }
      activeRenderer.copyTextureToTexture(source, depthTexture)
      // setSize() disposes and reallocates, so re-point the node at whatever
      // object the render target holds now.
      node.value = target.depthTexture
    },
    dispose() {
      target.dispose()
    }
  }
}
