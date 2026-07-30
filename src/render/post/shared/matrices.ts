import * as THREE from "three/webgpu"
import { uniform } from "three/tsl"
import type { N } from "../types"

/**
 * Previous/current camera matrices, advanced exactly once per PRESENTED frame.
 *
 * "Presented" is the load-bearing word. A compile-held frame (pipeline.render()
 * returns early while an exclusive compile window is mutating shared renderer
 * state), a warmup covered render and `captureStillRgba` all render the beauty
 * pass without presenting, and if any of them advanced the history the velocity
 * reprojection would compare this frame against a camera that was never shown.
 * Same reason `frameIndex` does not advance on those paths.
 *
 * Both the JITTERED and the UNJITTERED forms are kept. Velocity must be computed
 * from the unjittered projection on both sides so jitter never leaks into motion
 * vectors — that is exactly what `TRAANode`/`TAAUNode` use their mutable
 * `velocity.setProjectionMatrix(unjittered)` singleton for, and we get it
 * structurally instead.
 */
export type CameraHistory = {
  /** uniform(Matrix4) — object references, re-uploaded every frame. */
  readonly view: N
  readonly viewInverse: N
  readonly projection: N
  readonly projectionInverse: N
  readonly viewProjection: N
  readonly projectionUnjittered: N
  readonly projectionInverseUnjittered: N
  readonly viewProjectionUnjittered: N
  readonly previousView: N
  readonly previousViewProjection: N
  readonly previousViewProjectionUnjittered: N
  /**
   * THIS frame's view space straight to the PREVIOUS frame's unjittered clip
   * space, i.e. `previousViewProjectionUnjittered × cameraWorldMatrix`, folded
   * on the CPU once per frame.
   *
   * Two reasons it exists rather than the velocity pass doing the two products
   * itself (BRIEF §3.4 writes the math in two steps; this is the same product,
   * associated differently):
   *
   *  1. **Precision.** `THREE.Matrix4.elements` is a plain JS array, so this
   *     multiply happens in float64. Going through world space on the GPU means
   *     forming a world position with SF-scale magnitudes (thousands of metres
   *     out at the Golden Gate) in float32 and then subtracting the previous
   *     camera's translation back off it — a cancellation of two large numbers
   *     to recover a sub-pixel offset. Folding the camera translation into the
   *     matrix in double keeps the cancellation off the GPU entirely.
   *  2. One `mat4 × vec4` per pixel instead of two.
   *
   * After `reset()` this is exactly `viewProjectionUnjittered × cameraWorld`,
   * which reprojects every pixel onto itself — a static frame therefore reads
   * zero motion, to float precision, by construction rather than by tuning.
   */
  readonly reprojectFromView: N
  /**
   * The projection ACTUALLY used by the beauty pass, jitter included. Equal to
   * the unjittered form unless the frame driver calls `captureJittered()`.
   * Velocity must NOT use these — see the note above the type.
   */
  readonly projectionJittered: N
  readonly projectionInverseJittered: N
  readonly viewProjectionJittered: N
  /**
   * Capture the CURRENT camera as "current" and roll the previous frame's
   * values into the "previous" slots. Call once per presented frame, BEFORE the
   * beauty pass and BEFORE the jitter offset is applied — the unjittered
   * projection is the one this snapshots.
   *
   * chain.ts calls it at the top of `chain.render()` instead, which is AFTER
   * `jitter.clear()`; that is equally unjittered and equally once-per-presented
   * frame, so both call sites are correct. What is NOT correct is calling it
   * between `jitter.apply()` and `jitter.clear()`.
   */
  advance(camera: THREE.PerspectiveCamera): void
  /**
   * Record the jittered projection the beauty pass is about to use. Optional:
   * call it from the frame driver immediately after `jitter.apply()`. Until
   * something does, the jittered slots simply mirror the unjittered ones, so a
   * consumer can read them unconditionally.
   */
  captureJittered(camera: THREE.PerspectiveCamera): void
  /** Collapse previous == current so a temporal stage seeds instead of smearing. */
  reset(camera: THREE.PerspectiveCamera): void
}

export function createCameraHistory(camera: THREE.PerspectiveCamera): CameraHistory {
  const view = new THREE.Matrix4()
  const viewInverse = new THREE.Matrix4()
  const projection = new THREE.Matrix4()
  const projectionInverse = new THREE.Matrix4()
  const viewProjection = new THREE.Matrix4()
  const projectionUnjittered = new THREE.Matrix4()
  const projectionInverseUnjittered = new THREE.Matrix4()
  const viewProjectionUnjittered = new THREE.Matrix4()
  const projectionJittered = new THREE.Matrix4()
  const projectionInverseJittered = new THREE.Matrix4()
  const viewProjectionJittered = new THREE.Matrix4()
  const previousView = new THREE.Matrix4()
  const previousViewProjection = new THREE.Matrix4()
  const previousViewProjectionUnjittered = new THREE.Matrix4()
  const reprojectFromView = new THREE.Matrix4()

  const uniforms = {
    view: uniform(view) as N,
    viewInverse: uniform(viewInverse) as N,
    projection: uniform(projection) as N,
    projectionInverse: uniform(projectionInverse) as N,
    viewProjection: uniform(viewProjection) as N,
    projectionUnjittered: uniform(projectionUnjittered) as N,
    projectionInverseUnjittered: uniform(projectionInverseUnjittered) as N,
    viewProjectionUnjittered: uniform(viewProjectionUnjittered) as N,
    projectionJittered: uniform(projectionJittered) as N,
    projectionInverseJittered: uniform(projectionInverseJittered) as N,
    viewProjectionJittered: uniform(viewProjectionJittered) as N,
    previousView: uniform(previousView) as N,
    previousViewProjection: uniform(previousViewProjection) as N,
    previousViewProjectionUnjittered: uniform(previousViewProjectionUnjittered) as N,
    reprojectFromView: uniform(reprojectFromView) as N
  }

  const capture = (target: THREE.PerspectiveCamera) => {
    view.copy(target.matrixWorldInverse)
    viewInverse.copy(target.matrixWorld)
    projection.copy(target.projectionMatrix)
    projectionInverse.copy(target.projectionMatrixInverse)
    viewProjection.multiplyMatrices(projection, view)
    // Called outside the jitter window, so the live projection IS the unjittered
    // one. Keeping a separate copy is not redundant: a future stage may want
    // both inside the same frame, after setViewOffset has already run.
    projectionUnjittered.copy(projection)
    projectionInverseUnjittered.copy(projectionInverse)
    viewProjectionUnjittered.multiplyMatrices(projectionUnjittered, view)
    // Mirror until captureJittered() says otherwise, so a consumer never has to
    // ask whether the jitter stage has landed yet.
    projectionJittered.copy(projection)
    projectionInverseJittered.copy(projectionInverse)
    viewProjectionJittered.copy(viewProjection)
  }

  /** previousViewProjectionUnjittered × cameraWorldMatrix, folded in float64. */
  const foldReprojection = () => {
    reprojectFromView.multiplyMatrices(previousViewProjectionUnjittered, viewInverse)
  }

  capture(camera)
  previousView.copy(view)
  previousViewProjection.copy(viewProjection)
  previousViewProjectionUnjittered.copy(viewProjectionUnjittered)
  foldReprojection()

  return {
    ...uniforms,
    advance(target: THREE.PerspectiveCamera) {
      previousView.copy(view)
      previousViewProjection.copy(viewProjection)
      previousViewProjectionUnjittered.copy(viewProjectionUnjittered)
      capture(target)
      foldReprojection()
    },
    captureJittered(target: THREE.PerspectiveCamera) {
      projectionJittered.copy(target.projectionMatrix)
      projectionInverseJittered.copy(target.projectionMatrixInverse)
      viewProjectionJittered.multiplyMatrices(projectionJittered, view)
    },
    reset(target: THREE.PerspectiveCamera) {
      capture(target)
      previousView.copy(view)
      previousViewProjection.copy(viewProjection)
      previousViewProjectionUnjittered.copy(viewProjectionUnjittered)
      foldReprojection()
    }
  }
}
