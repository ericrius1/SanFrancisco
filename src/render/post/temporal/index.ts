// U4 · Temporal + jitter — build spec: .data/postfx/BRIEF.md §4.5
//
// STUB. See velocity/index.ts for what "stub" means here.
//
// THIS IS THE HIGHEST-RISK FILE IN THE PLAN and must be built first in Wave 1.
// Four independent defects in TAAUNode, one of which is a hard WebGPU error and
// not an artefact: `_previousDepthRenderTarget`'s untyped DepthTexture
// (TAAUNode.js:186) makes copyTextureToTexture at :485 a depth32float ->
// depth24plus-stencil8 copy under reversedDepthBuffer, which WebGPU rejects.
// Port TRAANode.js:466-470 verbatim as the very first edit, then :510-513 for
// the inverted depth dilation.
//
// This is also the ONLY stage that changes chain resolution — it consumes
// "input" and produces "output". Until it lands, post/tuning.ts reports an input
// scale of 1 and the whole chain runs at drawing-buffer resolution.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { TEMPORAL_TUNING } from "./tuning"

export function createTemporalStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "temporal",
    label: "temporal resolve",
    order: STAGE_ORDER.temporal,
    kind: "colour",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    invalidateHistory: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: TEMPORAL_TUNING, structuralKeys: ["scale"], recompileKeys: ["mode"] },
    dispose: () => {}
  }
}
