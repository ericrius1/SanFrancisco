// U7 · Composite + survivors + god rays — build spec: .data/postfx/BRIEF.md §4.4
//
// WAVE 0 SHIPS THIS ONE WORKING, at pass-through fidelity: beauty x contact
// shadows, then the underwater package. The AO term, the SSR add and the god-ray
// source swap are U7's and land here without changing the stage's shape.
//
// This stage exists because something has to fold occlusion, contact shadows and
// SSR into the beauty colour BEFORE the temporal resolve, and because the
// underwater package has to live somewhere. It is the last stage in linear HDR.
import * as THREE from "three/webgpu"
import { Fn, screenUV, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup, TextureSlot } from "../types"
import { COMPOSITE_TUNING } from "./tuning"
import { applyUnderwater } from "./underwater"

export { setUnderwaterPostFx } from "./underwater"

export type CompositeDeps = {
  /**
   * The half-res close-contact complement's factor, sampled at the composite's
   * single UV. `contactShadows.ts` is unchanged by this rebuild; its quad is
   * still driven by `contactShadows.renderNow()` at the very top of the frame,
   * before anything opens a pass.
   */
  contactFactorAt?: (uv: N) => N
}

export function createCompositeStage(setup: PostStageSetup, deps: CompositeDeps): PostStage {
  const { gbuffer, allocTarget, inputSlot } = setup
  const slot: TextureSlot = inputSlot()

  // rgba16float at INPUT resolution. Everything written here is still
  // scene-linear HDR — the bloom threshold (2.2) is measured in pre-exposure
  // linear and `grade.toDisplay` is two stages downstream, so an 8-bit
  // intermediate at this seam would quantise the exact values the look is
  // tuned against.
  const target = allocTarget({
    name: "post_composite_linear",
    resolution: "input",
    type: THREE.HalfFloatType
  })

  const quad = createStageQuad("post_composite")
  quad.setFragment(
    Fn(() => {
      // ONE uv. The surf-flow lens moved to the display tail, so the old
      // `uv` vs flow-warped `sampleUv` split that postfx.ts:339 had to
      // navigate (contactFactorAt sampled at `uv`, the scene at `sampleUv`)
      // does not exist here any more.
      const uv = screenUV
      const lin = slot.node.sample(uv).rgb.toVar()

      // Occlusion. Wave 0 has the contact complement only; U7 adds
      // `min(contactFactor, aoFactor)` here — min(), never a product, so
      // whichever term is more confident wins and double-darkening is
      // impossible.
      if (deps.contactFactorAt) lin.mulAssign(deps.contactFactorAt(uv))

      // Depth is bound EXPLICITLY from the g-buffer now. See underwater.ts for
      // the private-traversal bug that fixes.
      applyUnderwater({
        linUw: lin,
        uv,
        sourceTexture: slot.node,
        depthTexture: gbuffer.depth,
        projectionInverse: gbuffer.projectionInverse
      })

      return vec4(lin, 1.0)
    })()
  )

  return {
    id: "composite",
    label: "linear composite",
    order: STAGE_ORDER.composite,
    kind: "colour",
    resolution: "input",
    enabled: () => COMPOSITE_TUNING.values.enabled === true,
    output: () => target.texture,
    render: (frame: PostFrameContext) => {
      quad.render(frame.renderer, target)
    },
    // Sizing is the chain's job — targets.ts resizes the whole pool from one
    // place, so a stage never has to know what "input resolution" resolved to.
    setSize: () => {},
    warmupQuads: () => [quad.mesh],
    applyParams: () => {},
    tuning: { group: COMPOSITE_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => quad.dispose()
  }
}
