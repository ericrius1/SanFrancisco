// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.11
//
// THE ONLY THREE.RenderPipeline in the whole renderer. It replaces a matrix of
// up to 33 retained pipelines (8 style masks x 2 bloom families, plus up to 16
// god-ray variants, plus FXAA), each of which was its own TSL codegen window
// that `warmupPostFx` existed purely to pre-build one per frame.
//
// `outputColorTransform = false`: grade.toDisplay owns the display transform,
// and app/renderCore.ts:63 sets renderer.toneMapping = NoToneMapping so nothing
// applies a second one.
//
//   uv    = surfFlowLens(screenUV)                 // SURVIVOR, verbatim
//   c     = grade.toDisplay(colourSlot.sample(uv)) // exposure x guard x shaper x LUT
//   If (uSharpen > 0): c = rcas(...)               // 4 more grade evals, uniform branch
//   c    += filmGrain(c, screenCoord)              // unconditional, zeroed identity
//   c     = surfFlowGrade(c)                       // SURVIVOR, verbatim
import * as THREE from "three/webgpu"
import { Fn, screenCoordinate, screenUV, vec4 } from "three/tsl"
import { advanceGrain, filmGrain } from "../grain"
import { STAGE_ORDER } from "../order"
import { sharpenRcas } from "../sharpen"
import type { GradeAdapter } from "../grade"
import type { N, PostFrameContext, PostStage, PostStageSetup, TextureSlot } from "../types"
import { DISPLAY_TUNING } from "./tuning"
import { surfFlowGrade, surfFlowLens } from "./surfFlow"

export { setFlowPostFx } from "./surfFlow"

/**
 * Order inside the fused tail: `grade -> sharpen -> grain`.
 *
 * docs/POSTFX_CINEMATIC_PATHWAY.md used to specify `grade -> grain -> sharpen`
 * and now records the shipped order plus this reasoning (§ "the display tail"),
 * so the doc and this file agree — do not re-add an "against the doc" note.
 * Implementing the old order literally makes RCAS amplify the grain into crunchy
 * speckle and keys its local-contrast estimate off noise instead of edges. AMD's
 * own RCAS guidance and every film pipeline put grain last, immediately before
 * display encode.
 *
 * Because both live in the SAME fused pass, flipping this is one line and costs
 * nothing — grain is a pure function of screen position, so evaluating it at all
 * five RCAS taps is still cheap.
 */
const GRAIN_BEFORE_SHARPEN = false

export type DisplayDeps = {
  readonly renderer: THREE.WebGPURenderer
  readonly grade: GradeAdapter
}

export type DisplayStage = PostStage & {
  /** The chain's single present. Exposed so `chain.displayPipeline` can hand out
   *  the same object identity probes already assert on. */
  readonly pipeline: THREE.RenderPipeline
}

export function createDisplayStage(setup: PostStageSetup, deps: DisplayDeps): DisplayStage {
  const slot: TextureSlot = setup.inputSlot()
  const pipeline = new THREE.RenderPipeline(deps.renderer)
  pipeline.outputColorTransform = false

  // Evaluating the grade at an arbitrary UV is what RCAS needs: sharpening has
  // to happen in DISPLAY space, after the transform, or it sharpens the HDR
  // ratios instead of the visible contrast.
  const gradedAt = (uv: N): N => deps.grade.toDisplay(slot.node.sample(uv).rgb)

  pipeline.outputNode = Fn(() => {
    const lens = surfFlowLens(screenUV)
    const c = gradedAt(lens.sampleUv).toVar()

    // Grain is applied to `c`; sharpen REPLACES it, reading the graded
    // neighbourhood through `gradedAt`. Flipping the flag therefore also decides
    // whether RCAS's four taps see grain — they do not, in the shipped order,
    // which is the point.
    if (GRAIN_BEFORE_SHARPEN) {
      c.assign(filmGrain(c, screenCoordinate.xy))
      c.assign(sharpenRcas(c, gradedAt, lens.sampleUv, slot.texelSize))
    } else {
      c.assign(sharpenRcas(c, gradedAt, lens.sampleUv, slot.texelSize))
      c.assign(filmGrain(c, screenCoordinate.xy))
    }

    surfFlowGrade(c, lens)
    return vec4(c, 1.0)
  })()

  return {
    id: "display",
    label: "display",
    order: STAGE_ORDER.display,
    kind: "inline",
    resolution: "output",
    // Always on. "Off" would mean not presenting.
    enabled: () => true,
    output: () => null,
    render: (frame: PostFrameContext) => {
      // The grain lattice advances here rather than in the grain stage, because
      // the grain stage is never called by the driver (it owns no pass) and
      // because THIS is the call that presents. A frame that is never presented
      // must not consume a seed: `frameIndex` does not advance on compile-held
      // frames, warmup covered renders or captureStillRgba, which is exactly
      // what keeps a captured still's grain reproducible.
      advanceGrain(frame.frameIndex)
      // Draws into whatever render target the caller bound — that is how
      // ?fastcapture and the H-key still both redirect the final frame without
      // this stage knowing about either.
      pipeline.render()
    },
    setSize: () => {},
    warmupQuads: () => {
      // RenderPipeline has no public compile method in r185, so ask it to
      // configure its quad and hand that quad to the shared compile adapter.
      const internal = pipeline as THREE.RenderPipeline & {
        _update: () => void
        _quadMesh: THREE.QuadMesh
      }
      internal._update()
      return [internal._quadMesh]
    },
    applyParams: () => {},
    tuning: { group: DISPLAY_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => pipeline.dispose(),
    pipeline
  }
}
