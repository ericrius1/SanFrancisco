// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.8
//
// THIN ADAPTER over src/render/grade.ts, which is already better than
// Lut3DNode and stays exactly where it is. This folder owns nothing but the
// wiring: it creates the ONE GradeRuntime the chain hands out as `chain.grade`,
// and it hands the display tail the TSL seam.
//
// What U6 adds here: register the `agx` / `agxPunch` looks and expose the live
// CDL knobs from ./tuning. AgX is a new `curve` branch inside `evaluateLook`,
// not new parameter values — its defining operations (a log2 encode over a fixed
// 16.5-stop window, a per-channel sigmoid, two 3x3 rotations, a Rec.2020 round
// trip) have no counterpart in whiteBalance/contrast/saturation/white/pathToWhite.
//
// The one thing that will silently ruin it: `mul3` in gradeLooks.ts is
// ROW-major (documented at :278-283) while three writes the AgX matrices as
// mat3(vec3, vec3, vec3) in ToneMappingFunctions.js:144-145, :169-170, which is
// a COLUMN constructor. Every array must be that file's TRANSPOSE. The invariant
// that catches it on sight: every row of all four matrices sums to 1.0, because
// all four preserve white. A missing or transposed AGX_OUTSET moves mid-grey by
// 0.0 CV and only shows up as chroma loss (16.5% -> 13.2% on the sun surround) —
// i.e. it looks entirely reasonable.
//
// `goldenState` stays the default. Measured chroma retention: AgX holds ~16.5%
// on the sun surround against goldenState's 50.5%, and 4.5% against 16.0% on the
// sun disc. AgX beats ACES everywhere warm, but shipping it as the default would
// partially reinstate the exact failure gradeLooks.ts:17-34 documents as the
// reason ACES was dropped.
import type * as THREE from "three/webgpu"
import { createGrade, type GradeRuntime } from "../../grade"
import { STAGE_ORDER } from "../order"
import type { N, PostStage } from "../types"
import { POST_GRADE_TUNING } from "./tuning"

export type GradeAdapter = {
  /** Handed out raw as `chain.grade` / `pipeline.grade`. A look change swaps the
   *  LUT's CONTENTS — same texture object, same bind group, no recompile. That
   *  is why it is exposed directly rather than fronted by an applyX() call. */
  readonly runtime: GradeRuntime
  /** THE SEAM. Scene-linear HDR above, display-referred sRGB below. */
  toDisplay(linear: N): N
  readonly stage: PostStage
  dispose(): void
}

export function createGradeAdapter(): GradeAdapter {
  // ONE instance for the whole renderer. There is exactly one RenderPipeline now,
  // so the "shared by eight cached variants" reasoning from postfx.ts:259-262 is
  // moot — but the instance is still single because the LUT is a GPU resource and
  // a second one would be a second 48³ bake for no image difference.
  const runtime = createGrade()

  const stage: PostStage = {
    id: "grade",
    label: "display grade",
    order: STAGE_ORDER.grade,
    // Display-referred and cheap, so it is fused into the display tail's single
    // fragment shader rather than paying an RGBA8 round trip of its own.
    kind: "inline",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: POST_GRADE_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }

  return {
    runtime,
    toDisplay: (linear: N) => runtime.toDisplay(linear),
    stage,
    dispose: () => runtime.dispose()
  }
}
