// U4 · Temporal + jitter — build spec: .data/postfx/BRIEF.md §4.1
//
// Jitter is the one stage the CHAIN cannot drive: `camera.setViewOffset` has to
// be applied before the beauty pass renders and cleared immediately after, and
// the chain runs after both. So the frame driver in pipeline.ts calls
// `cameraJitter(chain.stage("jitter"))` directly (pipeline.ts:203, :304, :314).
// The stage registration still exists so the jitter shows up in `chain.state()`
// and gets `applyParams()` for free — and so this folder owns both halves.
//
// Owning it is what buys the three hazards named in BRIEF §4.1:
//  - the sequence advances on PRESENTED frames only, so a compile-held frame, a
//    warmup covered render can never desync the projection sequence from the
//    accumulated history (H-key stills advance frameIndex deliberately);
//  - the wireframe camera clone is synced AFTER apply(), so wireframe mode
//    carries the jitter while keeping its separate camera identity (BundleGroups
//    key their WebGPU command caches by camera identity);
//  - we never touch `RenderPipeline.context.onBeforeRenderPipeline`, which is a
//    single assignable slot two stock temporal nodes both write to
//    (RenderPipeline.js:200-204, TRAANode.js:451, TAAUNode.js:510) — the second
//    assignment silently wins, which is why ownership has to be ours.
//
// There is no shared mutable jitter state between this stage and the temporal
// resolve. Both call `jitterOffsetAt(frame.frameIndex, …)`, a pure function.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostFrameContext, PostStage, PostStageSetup } from "../types"
import { JITTER_TUNING } from "./tuning"
import { jitterActive, jitterOffsetAt } from "./sequence"

export { jitterActive, jitterOffsetAt, NO_JITTER } from "./sequence"
export type { JitterOffset } from "./sequence"

export type CameraJitter = {
  /** Offset the projection by this frame's Halton sample. */
  apply(camera: THREE.PerspectiveCamera, frame: PostFrameContext): void
  /** Restore the projection before ANYTHING else reads it. */
  clear(camera: THREE.PerspectiveCamera): void
}

const IDENTITY_JITTER: CameraJitter = {
  apply: () => {},
  clear: () => {}
}

export function createJitterStage(setup: PostStageSetup): PostStage & CameraJitter {
  void setup

  // Only clear a view offset we ourselves set. `clearViewOffset()` is
  // unconditional in three (PerspectiveCamera.clearViewOffset), so calling it on
  // a frame we did not jitter would silently wipe an offset some other system
  // owns — a cinematic rig or a future stereo path.
  let applied = false

  return {
    id: "jitter",
    label: "taa jitter",
    order: STAGE_ORDER.jitter,
    kind: "inline",
    resolution: "input",
    // Honest, and read into `chain.state().INLINE` rather than `enabled` —
    // `render()` is a no-op, so counting it as a pass inflated the cost number
    // by one. The frame driver, not the chain, is what applies the offset.
    enabled: () => jitterActive(),
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: JITTER_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {},

    apply(camera: THREE.PerspectiveCamera, frame: PostFrameContext) {
      if (applied) {
        // Defensive: a caller that skipped clear() would otherwise stack
        // offsets. setViewOffset overwrites rather than accumulates, so the
        // only real damage is the flag, but say so out loud once.
        camera.clearViewOffset()
        applied = false
      }
      const offset = jitterOffsetAt(frame.frameIndex, frame.inputWidth, frame.outputWidth)
      if (offset.x === 0 && offset.y === 0) return
      if (frame.inputWidth < 1 || frame.inputHeight < 1) return

      // fullWidth === width (and fullHeight === height): the view rectangle is
      // the whole frame and the offset is pure sub-pixel translation. Units are
      // "full" pixels, i.e. input pixels — see sequence.ts on what one unit
      // spans. setViewOffset() calls updateProjectionMatrix() for us, which also
      // refreshes projectionMatrixInverse, so anything sampling the camera
      // between here and clear() sees the jittered pair consistently.
      camera.setViewOffset(
        frame.inputWidth,
        frame.inputHeight,
        offset.x,
        offset.y,
        frame.inputWidth,
        frame.inputHeight
      )
      applied = true
    },

    clear(camera: THREE.PerspectiveCamera) {
      if (!applied) return
      camera.clearViewOffset()
      applied = false
    }
  }
}

/**
 * The frame driver's handle on the jitter stage. Returns an exact identity when
 * the stage is missing, so pipeline.ts calls it unconditionally and never
 * branches on whether the stage exists.
 */
export function cameraJitter(stage: PostStage | undefined): CameraJitter {
  const candidate = stage as (PostStage & Partial<CameraJitter>) | undefined
  if (!candidate || typeof candidate.apply !== "function" || typeof candidate.clear !== "function") {
    return IDENTITY_JITTER
  }
  return { apply: candidate.apply.bind(candidate), clear: candidate.clear.bind(candidate) }
}
