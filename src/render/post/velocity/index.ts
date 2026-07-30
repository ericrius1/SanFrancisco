// U1 · Velocity + G-buffer helpers — build spec: .data/postfx/BRIEF.md §3.4
//
// STUB. The chain registers every stage at boot, in final order, so the unit
// that builds this one rewrites only this folder and never touches a shared
// file. Until then `enabled()` is false and the chain skips it entirely: no
// render, no blit, no cost (BRIEF §5, mechanism 1). The tunable defaults below
// are the brief's and go live the moment the real stage lands.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { VELOCITY_TUNING } from "./tuning"

export function createVelocityStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "velocity",
    label: "velocity",
    order: STAGE_ORDER.velocity,
    kind: "aux",
    resolution: "input",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: VELOCITY_TUNING, structuralKeys: [], recompileKeys: ["source"] },
    dispose: () => {}
  }
}
