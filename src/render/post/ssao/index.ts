// U2 · SSAO — build spec: .data/postfx/BRIEF.md §4.2
//
// STUB. See velocity/index.ts for what "stub" means here.
// Fork target: GTAONode -> ssao/vendor/gtao.ts. The two edits that are not
// optional: `isGeometryDepth()` at GTAONode.js:346 (reversed depth), and
// `updateBeforeType = NodeUpdateType.NONE` plus a public render(renderer).
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { SSAO_TUNING } from "./tuning"

export function createSsaoStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "ssao",
    label: "ambient occlusion",
    order: STAGE_ORDER.ssao,
    kind: "aux",
    resolution: "input",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: SSAO_TUNING, structuralKeys: ["samples", "resolution"], recompileKeys: [] },
    dispose: () => {}
  }
}
