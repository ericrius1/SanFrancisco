// U3 · Masked screen-space reflections — build spec: .data/postfx/BRIEF.md §4.3
//
// THE MASK IS THE WHOLE DESIGN. Stock SSR decides what reflects with
// `reflectNonMetals` (SSRNode.js:909-913), a build-time boolean over a metalness
// channel this g-buffer does not carry. This stage reads an explicit reflectivity
// mask — the alpha of the beauty pass's second attachment, written only by
// materials that called `writeSsrMask()` — and the ray-march kernel's FIRST
// statement discards below `maskThreshold`. On a dry SF afternoon nothing has
// opted in: the pass costs one RGBA8 fetch and a discard per pixel at quarter
// area. After rain, in the Ocean Beach swash band, and on every water surface it
// costs where it shows.
//
// WHAT THE MASK ACTUALLY CONTAINS, as of this wave. The authoring sites landed
// alongside this stage, so it is NOT hypothetical: water.ts:729/:897 (ocean +
// Palace lagoon, 0.9 × no-foam), terrainClipmap.ts:848 (`wetSand`),
// oceanBeachShorebreak:382 (`wet` × no-foam), sutroBaths/staticWater.ts:495,
// japaneseTeaGarden/waterSimulation.ts:1593 and ghostShip/hotTubWater.ts:166
// (pools, ~0.85). So the mask is empty downtown, in the Mission and inside every
// interior pocket, and it is emphatically NOT empty anywhere you can see water.
//
// WHICH MAKES THE BRIEF'S WARNING LIVE, NOT THEORETICAL: "an unmasked SSR on the
// ocean is strictly worse than the analytic sky reflection already in
// waterShadingTSL.ts". The ocean now carries mask 0.9, so at any coastal stop
// this stage adds a screen-space reflection ON TOP of an analytic one that is
// already shading the same pixels. Expect over-bright, doubled horizons at Ocean
// Beach and the Golden Gate deck. The three ways out, in order of preference:
//   1. drop the ocean's own mask to 0 and let SSR own the reflection (water.ts,
//      not this unit's file);
//   2. drop `post.ssr.intensity` to taste — a knob, not a fix;
//   3. cut the stage, which is what the brief asks for if the honest answer is
//      that the analytic reflection was already better.
// This cannot be settled without pixels. It is the first thing the verification
// phase should look at.
import * as THREE from "three/webgpu"
import { unpackRGBToNormal } from "three/tsl"
import { provideReflections } from "../composite/auxSources"
import { STAGE_ORDER } from "../order"
import type {
  N,
  PostFrameContext,
  PostStage,
  PostStageSetup,
  TargetSpec,
  TextureSlot
} from "../types"
import { SSR_TUNING } from "./tuning"
import { MIN_SSR_TARGET_EDGE, MaskedSsr } from "./vendor/ssr"

/**
 * What the linear composite needs from this stage.
 *
 * Published as an interface and as a module accessor because `chain.ts`
 * constructs every stage from `setup` alone and the composite is built from the
 * same registry — neither file may be edited to thread an SSR handle through, and
 * neither needs to be.
 */
export type SsrReflections = {
  /**
   * Scene-linear reflection radiance at `uv`, blurred by roughness, ready to ADD.
   *
   * This is the accessor `composite/auxSources.ts` asks U3 to publish so that
   * `ssrColourAt()` can become an import and the texture registry can be deleted.
   * It is strictly better than sampling the texture, for one reason: the reflection
   * buffer holds a MIP CHAIN, and only this function knows the roughness→LOD
   * mapping. A plain fullscreen sample of the same texture always lands on level 0
   * and every wet surface reads as a perfect mirror.
   *
   * Mask-weighted and intensity-scaled HERE, once. Whoever adopts it must DROP the
   * `.mul(gbuffer.reflectivityAt(uv))` at composite/index.ts:144 in the same edit —
   * that multiply is correct against the raw texture and squares the mask against
   * this. Reads zero while the stage is disabled or skipped, so the composite's
   * `ssrActive` uniform branch stays correct either way.
   */
  reflectionAt(uv: N): N
  /** Whether the stage is producing this frame's contents. */
  active(): boolean
}

export type SsrStage = PostStage & SsrReflections

const INERT: SsrReflections = {
  reflectionAt: () => null,
  active: () => false
}

let currentStage: SsrStage | null = null

/**
 * The composite's handle. Returns an inert set before the stage is constructed,
 * so a consumer may call it unconditionally.
 *
 * Single-instance by construction: this project builds exactly one post chain
 * (pipeline.ts). A second `createPostChain()` takes ownership here, which is the
 * right behaviour for a hot reload and meaningless otherwise.
 */
export function ssrReflections(): SsrReflections {
  return currentStage ?? INERT
}

/** For the panel and probes, which hold the chain and can ask it by id. */
export function ssrReflectionsOf(stage: PostStage | undefined): SsrReflections {
  const candidate = stage as (PostStage & Partial<SsrReflections>) | undefined
  if (!candidate || typeof candidate.reflectionAt !== "function") return INERT
  return {
    reflectionAt: candidate.reflectionAt.bind(candidate),
    active: candidate.active!.bind(candidate)
  }
}

/** `TargetSpec.scale` is readonly for stages that never change it. The resolution
 *  dropdown is structural, and `targets.ts` recomputes every pooled target's size
 *  from the spec OBJECT it was handed — so mutating this one field in place is
 *  what keeps the pool and the stage from disagreeing after an Apply. */
type MutableSpec = TargetSpec & { scale: number }

export function createSsrStage(setup: PostStageSetup): SsrStage {
  const { gbuffer, allocTarget, inputSlot, renderer } = setup
  const slot: TextureSlot = inputSlot()
  const values = SSR_TUNING.values

  const clampResolution = (v: unknown) => Math.min(1, Math.max(0.25, Number(v) || 0.5))

  const ssrSpec: MutableSpec = {
    name: "post_ssr_reflection",
    resolution: "input",
    scale: clampResolution(values.resolution),
    type: THREE.HalfFloatType
  }
  const blurSpec: MutableSpec = {
    name: "post_ssr_blur",
    resolution: "input",
    scale: ssrSpec.scale,
    type: THREE.HalfFloatType
  }
  const ssrTarget = allocTarget(ssrSpec)
  const blurTarget = allocTarget(blurSpec)

  // Explicit LOD on every FILTERABLE tap the kernel makes inside conditional
  // control flow. WGSL's uniformity analysis rejects `textureSample` reached
  // through a non-uniform `Break`, and the ray-march loop is nothing but
  // non-uniform breaks. `textureSampleLevel` is legal anywhere and costs the same
  // on a texture with no mips. The depth tap is exempt: FloatType depth is
  // unfilterable, so three already emits `textureSampleLevel` for it
  // (WGSLNodeBuilder.js:828) — which is why contactShadows.ts can march it as-is.
  const gbufferAt = (uv: N): N => (gbuffer.gbuffer as N).sample(uv).level(0)
  const maskAt = (uv: N): N => gbufferAt(uv).a
  const colourAt = (uv: N): N => slot.node.sample(uv).level(0)
  const depthAt = (uv: N): N => (gbuffer.depth as N).sample(uv).r
  // The same decode as `gbuffer.normalViewAt` (shared/gbuffer.ts:64), restated
  // here for the explicit LOD and for that reason ONLY. The march re-samples the
  // normal at every accepted hit — inside the loop, past a non-uniform Break —
  // and the shared decoder's implicit-LOD `textureSample` is exactly what the
  // uniformity rule forbids there.
  const normalAt = (uv: N): N => unpackRGBToNormal(gbufferAt(uv).rgb).normalize()

  // ROUGHNESS IS DERIVED FROM THE MASK, deliberately. This is the one line to
  // change if a real roughness channel ever lands.
  //
  // The g-buffer has four channels and three of them are the normal; there is no
  // room for roughness without doubling the attachment to 8 B/px (shared/gbuffer.ts
  // documents that escape hatch). But the mask already carries the signal: every
  // authoring site the brief names produces it from WETNESS — `wet` in the terrain
  // clipmap, `swashWetness` at the shorebreak, a near-constant on standing water.
  // A partly-wet surface IS partly rough, because the film is too thin to drown its
  // microstructure; a surface at mask 1 is standing water and is a mirror. So
  // `1 - mask` is not a placeholder, it is the physical correlation the mask was
  // authored from, and it is what makes the damp end of the swash band read as a
  // soft sheen instead of a sharp mirror lying on sand.
  const roughnessAt = (uv: N): N => maskAt(uv).oneMinus()

  const ssr = new MaskedSsr({
    renderer,
    camera: gbuffer.camera,
    colourAt,
    depthAt,
    normalAt,
    maskAt,
    roughnessAt,
    ssrTarget,
    blurTarget,
    // Non-stochastic: one mirror ray plus the roughness blur chain. The scatter
    // path exists in the fork but needs a temporal/spatial denoiser to be worth
    // anything, and the whole denoiser stack is out of scope — as is the
    // equirect-HDR environment its miss path wants, this sky being procedural.
    stochastic: false,
    binaryRefine: values.binaryRefine === true,
    blurQuality: Math.round(Number(values.blurQuality) || 2)
  })

  const applyParams = () => {
    ssr.intensity.value = Number(values.intensity)
    ssr.maxDistance.value = Number(values.maxDistance)
    ssr.thickness.value = Number(values.thickness)
    ssr.screenEdgeFade.value = Number(values.screenEdgeFade)
    ssr.maxLuminance.value = Number(values.maxLuminance)
    ssr.quality.value = Number(values.quality)
    ssr.maskThreshold.value = Number(values.maskThreshold)
    // Promoted from a baked constant by the fork (deviation (f)). This is the
    // whole reason it can sit on a live slider at all: a pointer-move here
    // uploads four bytes instead of opening a codegen window, and a codegen
    // window in this renderer HOLDS PRESENTED FRAMES (compileGate.ts).
    ssr.stepExponent.value = Number(values.stepExponent)
  }
  applyParams()

  const setSize = (frame: PostFrameContext) => {
    const scale = ssrSpec.scale
    // Floored at the smallest edge that can hold the blur target's five mips —
    // see MIN_SSR_TARGET_EDGE. Below that WebGPU rejects the texture outright
    // instead of degrading, and a tiny window is a plausible way to get there.
    const width = Math.max(MIN_SSR_TARGET_EDGE, Math.round(frame.inputWidth * scale))
    const height = Math.max(MIN_SSR_TARGET_EDGE, Math.round(frame.inputHeight * scale))
    // Compared against the TARGETS, never against a remembered value. The chain's
    // pool sizes these from the same spec objects, but only when the drawing
    // buffer actually moved — an Apply on the resolution dropdown changes the
    // scale with the frame size unchanged, and the pool's own arithmetic has no
    // MIN_SSR_TARGET_EDGE floor. Reading the targets is the only way both of
    // those disagreements self-correct.
    if (ssrTarget.width !== width || ssrTarget.height !== height) {
      ssrTarget.setSize(width, height)
    }
    if (blurTarget.width !== width || blurTarget.height !== height) {
      blurTarget.setSize(width, height)
    }
    ssr.setSize(width, height)
  }

  const stage: SsrStage = {
    id: "ssr",
    label: "reflections",
    order: STAGE_ORDER.ssr,
    // "aux": the chain does not thread this forward as the chain colour — a
    // reflection is a contribution, not a replacement. The composite ADDS it in
    // linear HDR, reaching it through `composite/auxSources.ts` today and through
    // `reflectionAt()` once it adopts the accessor.
    kind: "aux",
    resolution: "input",

    enabled: () => {
      const on = values.enabled === true
      // The only per-frame hook a SKIPPED stage gets — `render()` is not called
      // when this returns false. A skipped stage keeps its last-rendered target
      // contents, so without this the composite would go on adding a frozen
      // reflection after the toggle went off.
      ssr.active.value = on ? 1 : 0
      return on
    },

    output: () => null,

    render: (frame: PostFrameContext) => {
      ssr.render(frame.renderer)
    },

    setSize,

    warmupQuads: () => ssr.quads,

    applyParams,

    applyStructure: () => {
      const scale = clampResolution(values.resolution)
      ssrSpec.scale = scale
      blurSpec.scale = scale
      // THE RECOMPILE TRAP. These two are the only genuinely baked constants left
      // in the stage, and they only ever arrive here — the panel renders
      // `recompileKeys` behind an explicit Apply, never a live slider, because a
      // rebuild per pointer-move is a codegen window per pointer-move.
      //
      // INTEGRATION NOTE: `PostStage.applyStructure` returns void, so a rebuild
      // cannot tell the chain that two of its warmup quads now carry a graph
      // nothing has compiled. Whoever owns the Apply button must follow it with
      // `compileFullscreenQuads(chain.warmupQuads())` — that call increments
      // `exclusiveCompileDepth`, so the frame is HELD rather than corrupted. Skip
      // it and the first frame after Apply pays a synchronous WGSL build mid-frame,
      // which is the exact hitch `recompileKeys` exists to schedule away.
      ssr.rebuild({
        blurQuality: Math.round(Number(values.blurQuality) || 2),
        binaryRefine: values.binaryRefine === true
      })
      applyParams()
    },

    reflectionAt: (uv: N) => ssr.reflectionAt(uv),
    active: () => values.enabled === true,

    tuning: {
      group: SSR_TUNING,
      structuralKeys: ["resolution"],
      // TENSION WITH THE §5 INVARIANT, stated rather than hidden. §5 says
      // `recompileKeys` must be empty for a stage that is enabled by default, and
      // the same section names `ssr.blurQuality` and `ssr.binaryRefine` as the
      // only two genuinely baked constants left in the whole chain. Both cannot
      // hold while `enabled` defaults to true.
      //
      // Declaring them is the reading that protects what the invariant is FOR: the
      // hazard is a live slider opening a codegen window on a presented frame, and
      // `recompileKeys` is precisely the mechanism that moves them behind an Apply
      // button. Leaving them undeclared would put them on live sliders — which is
      // the exact failure the invariant exists to prevent.
      //
      // The other resolution — defaulting `enabled` to false — is available, and
      // is the right one IF the mask stays empty. See this file's header.
      recompileKeys: ["blurQuality", "binaryRefine"]
    },

    dispose: () => {
      if (currentStage === stage) currentStage = null
      // A stale closure in the aux registry would outlive this render target.
      // The composite clears the registry too; both orders are safe.
      provideReflections(null)
      ssr.dispose()
    }
  }

  currentStage = stage

  // The registry hand-off composite/auxSources.ts specifies, verbatim. A pull, so
  // nothing has to be re-pushed after a resize (a RenderTarget keeps texture
  // identity across setSize) or after a toggle; `null` means "not this frame" and
  // the composite binds its own black identity instead.
  //
  // The BLUR target, not the raw one. Level 0 of the blur chain is an unblurred
  // copy of the raw reflection, and an implicit-LOD fullscreen sample of a
  // half-res texture from a full-res quad computes a negative LOD that clamps to
  // 0 — so today's consumer gets exactly the raw reflection, and the mip chain is
  // already in place for the day it switches to `reflectionAt()`.
  provideReflections(() => (stage.enabled() ? ssr.reflectionTexture : null))

  return stage
}
