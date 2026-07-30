// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.10
//
// STUB. TSL only — no render target, no PostStage pass. RCAS (AMD FidelityFX,
// 5 taps, the cheapest correct sharpener there is) fuses into the display tail
// so it costs no extra RGBA8 round trip. Do NOT use FSR1Node: it is the same
// RCAS plus a redundant EASU spatial upscale that TAAU already does better.
//
// Order is sharpen -> grain, not grain -> sharpen, and that is deliberate
// against docs/POSTFX_CINEMATIC_PATHWAY.md. Sharpening on top of grain amplifies
// it into crunchy speckle and makes RCAS's local-contrast estimate respond to
// noise instead of edges. Because both live in the same fused pass, flipping the
// order is one const in display/index.ts and costs nothing.
//
// When implemented, the 4 extra taps go behind `If(uAmount.greaterThan(0))` — a
// uniform-buffer read, therefore uniform control flow, therefore the GPU skips
// the block and the textureSample calls inside stay legal WGSL. Same pattern as
// the underwater package.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { N, PostStage, PostStageSetup } from "../types"
import { SHARPEN_TUNING } from "./tuning"

/**
 * The display tail's hook. Exact identity while this is a stub: `colour` is
 * returned untouched, so `amount: 0` and "not built yet" are the same image.
 *
 * @param sampleGraded re-evaluates the graded colour at an arbitrary UV — RCAS
 *   needs the 4-neighbourhood in DISPLAY space, after grade.toDisplay.
 */
export function sharpenRcas(colour: N, sampleGraded: (uv: N) => N, uv: N, texelSize: N): N {
  void sampleGraded
  void uv
  void texelSize
  return colour
}

export function createSharpenStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "sharpen",
    label: "sharpen",
    order: STAGE_ORDER.sharpen,
    kind: "inline",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: SHARPEN_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }
}
