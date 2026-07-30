// U3 · SSR — build spec: .data/postfx/BRIEF.md §4.3
//
// STUB. See velocity/index.ts for what "stub" means here.
// Fork target: SSRNode -> ssr/vendor/ssr.ts, plus vendored RNoise,
// SpecularHelpers and boxBlur. The mask is the design: an explicit `maskNode`
// and `mask.lessThan(0.02).discard()` as the first statement of the kernel.
// If the mask stays empty in practice, CUT the stage — an unmasked SSR on the
// ocean is strictly worse than the analytic sky reflection already in
// waterShadingTSL.ts.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { SSR_TUNING } from "./tuning"

export function createSsrStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "ssr",
    label: "reflections",
    order: STAGE_ORDER.ssr,
    kind: "aux",
    resolution: "input",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: {
      group: SSR_TUNING,
      structuralKeys: ["resolution"],
      // INVARIANT (BRIEF §5): recompileKeys must be empty for any stage enabled
      // by DEFAULT. SSR is enabled by default, so both of these have to reach
      // the panel behind an explicit Apply button and never a live slider — a
      // long codegen window HOLDS presented frames (pipeline.ts compile gate).
      recompileKeys: ["blurQuality", "binaryRefine"]
    },
    dispose: () => {}
  }
}
