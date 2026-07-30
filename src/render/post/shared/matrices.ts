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
  readonly viewProjectionUnjittered: N
  readonly previousView: N
  readonly previousViewProjection: N
  readonly previousViewProjectionUnjittered: N
  /**
   * Capture the CURRENT camera as "current" and roll the previous frame's
   * values into the "previous" slots. Call once per presented frame, BEFORE the
   * beauty pass and BEFORE the jitter offset is applied — the unjittered
   * projection is the one this snapshots.
   */
  advance(camera: THREE.PerspectiveCamera): void
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
  const viewProjectionUnjittered = new THREE.Matrix4()
  const previousView = new THREE.Matrix4()
  const previousViewProjection = new THREE.Matrix4()
  const previousViewProjectionUnjittered = new THREE.Matrix4()

  const uniforms = {
    view: uniform(view) as N,
    viewInverse: uniform(viewInverse) as N,
    projection: uniform(projection) as N,
    projectionInverse: uniform(projectionInverse) as N,
    viewProjection: uniform(viewProjection) as N,
    projectionUnjittered: uniform(projectionUnjittered) as N,
    viewProjectionUnjittered: uniform(viewProjectionUnjittered) as N,
    previousView: uniform(previousView) as N,
    previousViewProjection: uniform(previousViewProjection) as N,
    previousViewProjectionUnjittered: uniform(previousViewProjectionUnjittered) as N
  }

  const capture = (target: THREE.PerspectiveCamera) => {
    view.copy(target.matrixWorldInverse)
    viewInverse.copy(target.matrixWorld)
    projection.copy(target.projectionMatrix)
    projectionInverse.copy(target.projectionMatrixInverse)
    viewProjection.multiplyMatrices(projection, view)
    // Called before jitter.apply(), so the live projection IS the unjittered
    // one. Keeping a separate copy is not redundant: a future stage may want
    // both inside the same frame, after setViewOffset has already run.
    projectionUnjittered.copy(projection)
    viewProjectionUnjittered.multiplyMatrices(projectionUnjittered, view)
  }

  capture(camera)
  previousView.copy(view)
  previousViewProjection.copy(viewProjection)
  previousViewProjectionUnjittered.copy(viewProjectionUnjittered)

  return {
    ...uniforms,
    advance(target: THREE.PerspectiveCamera) {
      previousView.copy(view)
      previousViewProjection.copy(viewProjection)
      previousViewProjectionUnjittered.copy(viewProjectionUnjittered)
      capture(target)
    },
    reset(target: THREE.PerspectiveCamera) {
      capture(target)
      previousView.copy(view)
      previousViewProjection.copy(viewProjection)
      previousViewProjectionUnjittered.copy(viewProjectionUnjittered)
    }
  }
}
