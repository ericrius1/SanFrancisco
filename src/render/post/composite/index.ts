// U7 · Composite + survivors + god rays — build spec: .data/postfx/BRIEF.md §4.4
//
// This stage exists because something has to fold occlusion, contact shadows and
// SSR into the beauty colour BEFORE the temporal resolve, and because the
// underwater package has to live somewhere. It is the last stage in linear HDR.
//
//   lin  = colourSlot.sample(uv).rgb          // beauty, or the god-ray composite
//   occ  = min(contactFactorAt(uv), ssaoFactorAt(uv))
//   lin *= occ
//   lin += ssrReflectionAt(uv) * ssrIntensity  // mask AND roughness→mip inside
//   If (uwSubmersion > 0): Beer-Lambert fog + 16-tap god rays   // SURVIVOR
import * as THREE from "three/webgpu"
import { Fn, If, float, mix, screenUV, uniform, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
import { ssaoFactorAt } from "../ssao"
import { ssrReflections } from "../ssr"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup, TextureSlot } from "../types"
import { COMPOSITE_TUNING } from "./tuning"
import { applyUnderwater, setUnderwaterEnabled } from "./underwater"

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

  /**
   * U3's published accessor, resolved ONCE at construction — `chain.ts` builds
   * `ssr` before `composite` and now checks that it did, because this is the one
   * line where the order matters.
   *
   * `reflectionAt()` and not a texture handoff, and that is not a tidy-up: the
   * reflection buffer is a FIVE-LEVEL MIP CHAIN and only U3 knows the
   * roughness→LOD mapping. The composite used to reach it through a texture
   * registry and sample it with an implicit LOD — a full-res quad over a half-res
   * texture computes a negative LOD that clamps to 0 — so level 0 was the only
   * level anything ever read, the copy and the four blur passes were computed and
   * discarded every frame, and every damp surface reflected like polished glass.
   * The accessor is what makes the wet end of a swash band read as a sheen.
   */
  const reflections = ssrReflections()

  const U = {
    /**
     * 0 = min, 1 = multiply. A UNIFORM, not two graphs: `occlusionCombine` is an
     * artist-facing A/B for the Mission Dolores nave referee stop, and
     * `recompileKeys` must stay empty for a stage that is enabled by default
     * (types.ts:125-128). Both terms are one ALU op, so evaluating the pair and
     * mixing is cheaper than a branch would be.
     */
    occlusionCombine: uniform(0),
    ssrIntensity: uniform(0.8),
    /** 1 while an SSR texture is bound this frame. Uniform branch condition. */
    ssrActive: uniform(0)
  }

  const quad = createStageQuad("post_composite")
  quad.setFragment(
    Fn(() => {
      // ONE uv. The surf-flow lens moved to the display tail, so the old
      // `uv` vs flow-warped `sampleUv` split that postfx.ts:339 had to
      // navigate (contactFactorAt sampled at `uv`, the scene at `sampleUv`)
      // does not exist here any more.
      const uv = screenUV
      const lin = slot.node.sample(uv).rgb.toVar()

      // OCCLUSION RECONCILIATION — the reason this line is a min() and not a
      // product. `contactShadows.ts:441-454` already darkens contacts on the
      // DIRECT-SUN term, keyed to the sun direction and discarding back/grazing
      // faces; GTAO on top of that double-darkens
      // (docs/POSTFX_CINEMATIC_PATHWAY.md:75). min() means whichever term is
      // more confident wins and stacking is impossible — which is what lets
      // SSAO's default intensity stay as low as 0.55 without the two systems
      // fighting. `multiply` survives only as the A/B.
      //
      // `ssaoFactorAt` is exactly 1.0 while SSAO is off (ssao/index.ts:70), so
      // the whole term degrades to the contact factor with no branch, and to
      // 1.0 when neither system is present.
      const contact = deps.contactFactorAt ? deps.contactFactorAt(uv) : float(1)
      const ao = ssaoFactorAt(uv)
      lin.mulAssign(mix(contact.min(ao), contact.mul(ao), U.occlusionCombine))

      // Masked SSR, added in linear light. The mask is the g-buffer alpha that
      // only surfaces which opted in via `writeSsrMask()` ever write, so a dry SF
      // afternoon adds exactly zero here — and the uniform branch means it does
      // not even pay the fetches to discover that. Same measured idiom as the
      // underwater skip below (PERF_LEVELUP.md:296).
      //
      // NO `.mul( gbuffer.reflectivityAt( uv ) )`. `reflectionAt()` applies the
      // mask itself (ssr/vendor/ssr.ts:290-301) and multiplying here as well
      // would SQUARE it — which erases exactly the damp end of the swash band the
      // mip chain was built to serve. The mask is applied once, at whichever end
      // owns the accessor, and that end is U3's.
      //
      // `null` means THIS CHAIN HAS NO SSR STAGE — the accessor's inert form —
      // and the whole term is then omitted from the graph rather than added as a
      // zero, which is what makes such a chain bit-identical to Wave 0's
      // composite. A JS `if`, deliberately not a TSL `If()`: the answer is fixed
      // at codegen.
      const ssrTerm = reflections.reflectionAt(uv)
      if (ssrTerm !== null) {
        If(U.ssrActive.greaterThan(0), () => {
          lin.addAssign(ssrTerm.mul(U.ssrIntensity))
        })
      }

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

  const applyParams = () => {
    const values = COMPOSITE_TUNING.values
    U.occlusionCombine.value = values.occlusionCombine === "multiply" ? 1 : 0
    U.ssrIntensity.value = Number(values.ssrIntensity)
    setUnderwaterEnabled(values.underwater !== false)
  }
  // Persisted overrides are already in `values` by the time the stage builds, so
  // seed the uniforms before the first frame rather than waiting for the panel.
  applyParams()

  return {
    id: "composite",
    label: "linear composite",
    order: STAGE_ORDER.composite,
    kind: "colour",
    resolution: "input",
    enabled: () => COMPOSITE_TUNING.values.enabled === true,
    output: () => target.texture,
    render: (frame: PostFrameContext) => {
      // Asked per frame, never cached: a stage toggled off mid-flight answers
      // false and the branch below stops paying for the fetches. `active()` is a
      // plain read of the tunable — it renders nothing and writes no uniform, so
      // asking it here cannot perturb the stage it is asking about.
      //
      // This is a COST branch, not a correctness one: `reflectionAt()` already
      // multiplies by the stage's own `active` uniform, so a skipped stage
      // contributes exactly zero even if this uniform were stale.
      U.ssrActive.value = reflections.active() ? 1 : 0

      quad.render(frame.renderer, target)
    },
    // Sizing is the chain's job — targets.ts resizes the whole pool from one
    // place, so a stage never has to know what "input resolution" resolved to.
    setSize: () => {},
    warmupQuads: () => [quad.mesh],
    applyParams,
    tuning: { group: COMPOSITE_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {
      quad.dispose()
    }
  }
}
