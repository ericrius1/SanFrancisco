// U4 · Temporal + jitter — build spec: .data/postfx/BRIEF.md §4.1
//
// STUB. See velocity/index.ts for what "stub" means here.
//
// Jitter is the one stage the CHAIN cannot drive: `camera.setViewOffset` has to
// be applied before the beauty pass renders and cleared immediately after, and
// the chain runs after both. So the frame driver in pipeline.ts calls
// `cameraJitter(chain.stage("jitter"))` directly. The stage registration still
// exists so the jitter shows up in `chain.state()` and gets `applyParams()` for
// free — and so this folder owns both halves.
//
// Owning it is what buys the three hazards named in BRIEF §4.1:
//  - the sequence advances on PRESENTED frames only, so a compile-held frame, a
//    warmup covered render and captureStillRgba can never desync the projection
//    sequence from the accumulated history;
//  - the wireframe camera clone is synced AFTER apply(), so wireframe mode
//    carries the jitter while keeping its separate camera identity (BundleGroups
//    key their WebGPU command caches by camera identity);
//  - we never touch `RenderPipeline.context.onBeforeRenderPipeline`, which is a
//    single assignable slot two stock temporal nodes both write to.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostFrameContext, PostStage, PostStageSetup } from "../types"
import { JITTER_TUNING } from "./tuning"

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

export function createJitterStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "jitter",
    label: "taa jitter",
    order: STAGE_ORDER.jitter,
    kind: "inline",
    resolution: "input",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: JITTER_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }
}

/**
 * The frame driver's handle on the jitter stage. Returns an exact identity when
 * the stage is missing or still a stub, so pipeline.ts calls it unconditionally
 * and never branches on whether U4 has landed.
 */
export function cameraJitter(stage: PostStage | undefined): CameraJitter {
  const candidate = stage as (PostStage & Partial<CameraJitter>) | undefined
  if (!candidate || typeof candidate.apply !== "function" || typeof candidate.clear !== "function") {
    return IDENTITY_JITTER
  }
  return { apply: candidate.apply.bind(candidate), clear: candidate.clear.bind(candidate) }
}
