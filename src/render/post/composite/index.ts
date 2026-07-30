// U7 · Composite + survivors + god rays — build spec: .data/postfx/BRIEF.md §4.4
//
// This stage exists because something has to fold occlusion, contact shadows and
// SSR into the beauty colour BEFORE the temporal resolve, and because the
// underwater package has to live somewhere. It is the last stage in linear HDR.
//
//   lin  = colourSlot.sample(uv).rgb          // beauty, or the god-ray composite
//   occ  = min(contactFactorAt(uv), ssaoFactorAt(uv))
//   lin *= occ
//   lin += ssr.sample(uv).rgb * ssrIntensity * reflectivityAt(uv)
//   If (uwSubmersion > 0): Beer-Lambert fog + 16-tap god rays   // SURVIVOR
import * as THREE from "three/webgpu"
import { Fn, If, float, mix, screenUV, uniform, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
import { createTextureSlot } from "../shared/textureSlot"
import { ssaoFactorAt } from "../ssao"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup, TextureSlot } from "../types"
import { COMPOSITE_TUNING } from "./tuning"
import { clearAuxSources, reflectionsTexture } from "./auxSources"
import { applyUnderwater, setUnderwaterEnabled } from "./underwater"

export { setUnderwaterPostFx } from "./underwater"
export { provideReflections, type AuxTextureSource } from "./auxSources"

export type CompositeDeps = {
  /**
   * The half-res close-contact complement's factor, sampled at the composite's
   * single UV. `contactShadows.ts` is unchanged by this rebuild; its quad is
   * still driven by `contactShadows.renderNow()` at the very top of the frame,
   * before anything opens a pass.
   */
  contactFactorAt?: (uv: N) => N
}

/**
 * A 1×1 stand-in holding the SSR stage's EXACT identity: black, adds nothing.
 * Two reasons it is a texture rather than a null check:
 *
 *  - a `texture()` node must always have something bound, and the bound object's
 *    format and filter mode decide the WGSL sampler binding type
 *    (textureSlot.ts:18-23) — hence rgba16float + LinearFilter, matching the
 *    real SSR target rather than a convenient RGBA8;
 *  - it makes "SSR is off" and "SSR wrote 0 everywhere" the same pixels, which is
 *    what lets an ablation probe attribute a difference to the stage rather than
 *    to the composite's plumbing.
 *
 * The fetch is skipped by a uniform branch anyway (see the fragment), so this is
 * bound for validity, not for cost.
 */
function ssrIdentityTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    // Half-float bits: 0x0000 = 0.0, 0x3c00 = 1.0. rgb black, alpha opaque.
    new Uint16Array([0x0000, 0x0000, 0x0000, 0x3c00]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.HalfFloatType
  )
  // Underscores only — see targets.ts:70-72.
  texture.name = "post_composite_ssr_identity"
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
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

  const ssrIdentity = ssrIdentityTexture()
  // Its own slot, not `inputSlot()` — the chain hands a stage exactly one
  // upstream COLOUR, and the reflection buffer is an aux product it does not
  // thread (auxSources.ts explains why the side channel exists at all).
  const ssrSlot = createTextureSlot("post_composite_ssr", ssrIdentity)

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

  /**
   * The reflection term. Reads the registry-bound slot today; when U3 publishes
   * a node accessor the way U2 did for AO, this function body becomes that
   * import and ./auxSources.ts goes away. Nothing else in the file changes.
   */
  const ssrColourAt = (uv: N): N => ssrSlot.node.sample(uv).rgb

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

      // Masked SSR, added in linear light. `reflectivityAt` is the g-buffer
      // alpha that only surfaces which opted in via `writeSsrMask()` ever write,
      // so a dry SF afternoon adds exactly zero here — and the uniform branch
      // means it does not even pay the two fetches to discover that. Same
      // measured idiom as the underwater skip below (PERF_LEVELUP.md:296).
      If(U.ssrActive.greaterThan(0), () => {
        lin.addAssign(ssrColourAt(uv).mul(U.ssrIntensity).mul(gbuffer.reflectivityAt(uv)))
      })

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
      // Resolved per frame, never cached: a stage toggled off mid-flight returns
      // null and the composite falls back to the exact identity without anything
      // having to notify it.
      const ssr = reflectionsTexture()
      ssrSlot.bind(ssr ?? ssrIdentity)
      U.ssrActive.value = ssr ? 1 : 0

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
      ssrIdentity.dispose()
      clearAuxSources()
    }
  }
}
