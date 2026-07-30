// U5 · DOF + bloom — build spec: .data/postfx/BRIEF.md §4.6
//
// STUB. See velocity/index.ts for what "stub" means here.
// Fork target: DepthOfFieldNode -> dof/vendor/dof.ts (plus its nested
// GaussianBlurNode). Inherently reversed-depth safe: it never touches raw depth
// and PassNode.getViewZNode() routes through the reversed-aware
// perspectiveDepthToViewZ. The one aliasing detail to preserve exactly is the
// `_CoCTextureNode.value` swap at DepthOfFieldNode.js:294, :303, :319 — three
// reuses the blur materials that way and the near/far fields cross-contaminate
// if it is "cleaned up".
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { DOF_TUNING } from "./tuning"

export function createDofStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "dof",
    label: "depth of field",
    order: STAGE_ORDER.dof,
    kind: "colour",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: DOF_TUNING, structuralKeys: ["resolution"], recompileKeys: [] },
    dispose: () => {}
  }
}
