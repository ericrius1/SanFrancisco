// U2 · SSAO — build spec: .data/postfx/BRIEF.md §4.2
//
// Ground-truth ambient occlusion at half the beauty-pass resolution, forked from
// three's GTAONode. The fork and every deviation from upstream live in
// ./vendor/gtao.ts; this file is the chain stage around it.
//
// The AO factor is CONSUMED by post/composite/, which min()-combines it with the
// contact-shadow factor rather than multiplying — contactShadows.ts:441-454
// already darkens contacts on the direct-sun term, and a product double-darkens
// (docs/POSTFX_CINEMATIC_PATHWAY.md:75). U7's accessor is `ssaoFactorAt(uv)`,
// exported below.
//
// IF YOU ARE HERE BECAUSE OF OCCLUSION ON WATER, read vendor/gtao.ts deviation
// 10 first. `radius` is a view-space length spent by a screen-space march, and
// past the range where it projects to one depth texel upstream's kernel does not
// degrade to "no occlusion" — it fabricates a fixed 22-32% at grazing incidence
// out of the projection alone. Measured at 0.68-0.75 over the open sea, -7.5 luma
// on the water in the shipping frame; now 0.98 there with the near field
// unchanged at 0.9925. The tunables below are innocent and none of them moved.
import * as THREE from "three/webgpu"
import { clamp, float, texture, uniform } from "three/tsl"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup, TargetSpec } from "../types"
import { SSAO_TUNING } from "./tuning"
import { GtaoPass } from "./vendor/gtao"

/**
 * A 1×1 white r16float stand-in so `ssaoFactorAt()` is a complete, buildable
 * node BEFORE the stage exists — the composite (chain order 50) is constructed
 * after this stage (order 30) today, but nothing in `chain.ts` promises that and
 * a graph that silently loses its AO term when someone reorders the registry is
 * not a failure anyone would notice.
 *
 * Same idiom as `shared/textureSlot.ts`, and the same reason its placeholder is
 * mandatory rather than optional: the bound texture's FORMAT and FILTER MODE
 * decide the WGSL sampler binding type, so the stand-in has to match the real
 * target (RedFormat + HalfFloatType + LinearFilter, see the spec below) or the
 * first rebind is a bind-group mismatch rather than a cosmetic difference.
 * 0x3c00 is half-float 1.0 — "unoccluded".
 */
const AO_NEUTRAL = new THREE.DataTexture(
  new Uint16Array([0x3c00]),
  1,
  1,
  THREE.RedFormat,
  THREE.HalfFloatType
)
AO_NEUTRAL.minFilter = THREE.LinearFilter
AO_NEUTRAL.magFilter = THREE.LinearFilter
AO_NEUTRAL.generateMipmaps = false
AO_NEUTRAL.needsUpdate = true

const aoTextureNode = texture(AO_NEUTRAL) as N
// Underscores only — some codegen paths emit a texture name verbatim as a WGSL
// identifier and a dot is a parse error (pianoGodRays.ts:112-118).
aoTextureNode.name = "post_ssao_factor"

/**
 * `intensity`, or zero when the stage is off. Folding "off" into the strength is
 * what lets the composite sample this stage unconditionally: an `aux` stage that
 * `chain.ts:215` skips is never cleared and never re-rendered, so its target
 * keeps whatever AO it last drew — a disabled stage would otherwise freeze its
 * final frame of occlusion onto the world forever.
 */
const aoStrength = uniform(0) as N

/**
 * THE ACCESSOR U7's COMPOSITE CALLS: `ssaoFactorAt(uv)`.
 *
 * Returns an occlusion FACTOR in [0,1] — 1 = unoccluded — ready to be
 * min()-combined with the contact-shadow factor. Exactly 1.0 when the stage is
 * disabled, so `min(contactFactor, ssaoFactorAt(uv))` degrades to the contact
 * term with no branch and no second graph.
 *
 * `intensity` reaches up to 1.5, so the lerp toward the raw AO can undershoot
 * zero; the clamp is not decorative.
 */
export function ssaoFactorAt(uv: N): N {
  const ao = aoTextureNode.sample(uv).r
  return clamp(float(1).sub(ao.oneMinus().mul(aoStrength)), 0, 1)
}

export function createSsaoStage(setup: PostStageSetup): PostStage {
  const { renderer, gbuffer, allocTarget } = setup

  const resolutionScale = () => {
    const value = Number(SSAO_TUNING.values.resolution)
    return Number.isFinite(value) && value > 0 ? value : 0.5
  }

  // RedFormat + HalfFloatType, NOT upstream's UnsignedByteType (GTAONode.js:97).
  // 8-bit AO quantises to 1/255 per step, and the falloff this stage is tuned
  // for is a wide, soft gradient across a whole wall — exactly the signal where
  // banding shows, and where the temporal resolve cannot dither it away because
  // the bands are stationary in world space.
  //
  // Mutable on purpose: `resolution` is a structural key, and `targets.ts` keeps
  // this exact object and re-derives the size from `spec.scale` on every chain
  // resize. Updating it in applyStructure() keeps the pool and this stage from
  // disagreeing about how big the target is.
  const targetSpec = {
    name: "post_ssao_factor",
    resolution: "input" as const,
    scale: resolutionScale(),
    format: THREE.RedFormat,
    type: THREE.HalfFloatType
  }
  const target = allocTarget(targetSpec satisfies TargetSpec)
  aoTextureNode.value = target.texture

  const pass = new GtaoPass({
    renderer,
    depthNode: gbuffer.depth,
    // Real normals. Upstream's `normalNode === null` fallback costs 9
    // textureLoad + 5 getViewPosition per pixel to reconstruct what the beauty
    // pass already wrote into its second attachment.
    normalViewAt: gbuffer.normalViewAt,
    camera: gbuffer.camera,
    target
  })

  /** Push the sliders. Never recompiles, never reallocates. */
  const applyParams = () => {
    const v = SSAO_TUNING.values
    pass.radius.value = v.radius
    pass.thickness.value = v.thickness
    pass.distanceExponent.value = v.distanceExponent
    pass.distanceFallOff.value = v.distanceFallOff
    pass.punch.value = v.punch
    pass.samples.value = v.samples
    aoStrength.value = v.enabled === true ? v.intensity : 0
  }
  applyParams()

  return {
    id: "ssao",
    label: "ambient occlusion",
    order: STAGE_ORDER.ssao,
    kind: "aux",
    resolution: "input",

    enabled: () => {
      const on = SSAO_TUNING.values.enabled === true
      // The one hook the chain calls every frame whatever the answer is
      // (chain.ts:215). Once this returns false the stage gets no render(), no
      // setSize() and no applyParams(), so the strength that neutralises
      // ssaoFactorAt() has to be pushed from here or the composite goes on
      // multiplying by a frozen AO buffer.
      aoStrength.value = on ? SSAO_TUNING.values.intensity : 0
      return on
    },

    // "aux": this never becomes the chain colour. The composite reads it by
    // name, through ssaoFactorAt().
    output: () => null,

    render: (frame: PostFrameContext) => {
      pass.setTemporalFrame(
        SSAO_TUNING.values.temporalRotation === true ? frame.frameIndex : null
      )
      pass.render(frame.renderer)
    },

    setSize: (frame: PostFrameContext) => {
      const scale = resolutionScale()
      const width = Math.max(1, Math.round(frame.inputWidth * scale))
      const height = Math.max(1, Math.round(frame.inputHeight * scale))
      // RenderTarget.setSize() early-returns on an unchanged size, so this is
      // also the cheap path when the chain's pool resize already got there.
      target.setSize(width, height)
      pass.setResolution(width, height)
      // NOT `width, height`. The horizon search marches the BEAUTY DEPTH, which
      // is at the chain's input resolution, and the step test that keeps this
      // stage from inventing occlusion at long range (vendor/gtao.ts deviation
      // 10) has to measure a step against the sampling rate of the buffer it
      // steps through, not against this pass's own.
      pass.setDepthResolution(frame.inputWidth, frame.inputHeight)
    },

    warmupQuads: () => [pass.quadMesh],

    applyParams,

    applyStructure: () => {
      // `samples` and `resolution` are both structural in the panel's sense —
      // gated on slider release — but for different reasons, and only one of
      // them touches memory. `resolution` reallocates the target, so the pooled
      // spec has to follow it. `samples` is a plain uniform driving dynamic loop
      // bounds (vendor/gtao.ts, DIRECTIONS/STEPS); it is release-gated purely
      // because doubling the tap count mid-drag is a visible frame-time step,
      // not because anything rebuilds. Nothing here is a recompile key, which is
      // the invariant this stage has to hold: it is enabled by default.
      targetSpec.scale = resolutionScale()
      applyParams()
    },

    tuning: {
      group: SSAO_TUNING,
      structuralKeys: ["samples", "resolution"],
      recompileKeys: []
    },

    dispose: () => {
      pass.dispose()
      // The target belongs to targets.ts, but the module-level accessor node
      // does not — leave it pointing at something valid so a rebuilt chain (or a
      // graph that outlives this stage) samples neutral white rather than a
      // disposed texture.
      aoTextureNode.value = AO_NEUTRAL
      aoStrength.value = 0
    }
  }
}
