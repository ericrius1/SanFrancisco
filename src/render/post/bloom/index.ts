// U5 · DOF + bloom — build spec: .data/postfx/BRIEF.md §4.7
//
// STUB. See velocity/index.ts for what "stub" means here. Bloom is ON by
// default and is NOT a style — it is the base look, so this stub is the one
// visible difference between the Wave-0 skeleton and today's default frame.
//
// Two hard-won rules from the deleted pipeline.ts:230-248 must survive the port,
// because both are cheap to re-break:
//
//  (a) The bloomed source has to be a TEXTURE and not an expression. Consumers
//      tap it at several UVs (the underwater god rays, the flow lens), and an
//      expression re-evaluates the whole bloom chain per tap. Rendering once
//      into an owned half-float target is what `rtt` used to buy.
//  (b) ONE BloomNode per source, never shared. `BloomNode.setup()` pushes five
//      separable-blur materials per NodeBuilder with no reset (:415-419) while
//      `setSize` (:320-330) and `updateBefore` (:361-379) only ever index the
//      first five — so one instance reached by eight cached style variants built
//      forty materials and orphaned thirty-five. Explicit driving into an owned
//      target satisfies both automatically; the fork should still add the
//      missing `_separableBlurMaterials = []` reset at the top of setup(),
//      because it is one line and removes a whole class of bug.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { BLOOM_TUNING } from "./tuning"

export function createBloomStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "bloom",
    label: "bloom",
    order: STAGE_ORDER.bloom,
    kind: "colour",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: BLOOM_TUNING, structuralKeys: ["resolution"], recompileKeys: [] },
    dispose: () => {}
  }
}
