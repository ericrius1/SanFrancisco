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
// THE PREDICTION THIS HEADER MADE WAS WRONG, AND THE PIXELS SAY SO. It expected
// "over-bright, doubled horizons at Ocean Beach" from a screen-space reflection
// landing on top of waterShadingTSL.ts's analytic one. The opposite is true. Two
// independent browser sessions, three coastal stops: the raw reflection buffer is
// non-zero on 0.08-0.73% of pixels — a thin band tracing the far shoreline, near
// and mid bands exactly 0.0 — for a final-image delta of 0.0024-0.0083 against a
// 0.0397 noise floor, and 0.29-0.45 at MAXIMUM INTENSITY in the swash. Dry stops
// are correctly free. Forcing `maskThreshold` 0.02 -> 0 changed the image by
// EXACTLY 0.0, and forcing `intensity` 0.8 -> 2 with `maxDistance` 18 -> 120 made
// it WORSE (a fixed step budget spread over a longer ray misses more).
//
// THE FIRST HALF OF THAT IS STRUCTURAL AND IS NOT A BUG. A near-horizontal water
// surface reflects SKY; screen space cannot supply sky; this fork ships
// `environmentNode: null` on purpose (BRIEF §4.3 forbids vendoring
// ImportanceSampledEnvironment). The only reflections screen space CAN supply
// over open water are of geometry already above the waterline in frame — which is
// exactly the shoreline band that shows up, landing exactly where a reflection of
// that geometry belongs. That is SSR doing its job, and it is the RIGHT job:
// waterShadingTSL.ts already owns the analytic sky term, so a stage that also
// tried to would double it. Every stop measured so far — Ocean Beach, Lands End,
// the Golden Gate deck — is open coast, i.e. the case with the least on-screen
// geometry above the waterline that this world contains. The mask's other
// authoring sites are not: sutroBaths/staticWater, japaneseTeaGarden's pond,
// ghostShip's hot tub and terrainClipmap's `wetSand` are all enclosed by
// geometry, and none has been under a camera yet. Cutting the stage on coastal
// evidence would be cutting it on the evidence least able to speak for it.
//
// THE SECOND HALF WAS A REAL DEFECT, AND IT IS FIXED HERE. "It pays a pass, a
// copy and four blur passes for nothing" was literally true of five of those six
// passes, and for a reason that had nothing to do with the ocean: the composite
// reached this stage through a TEXTURE registry (the deleted
// composite/auxSources.ts) and sampled it with an implicit LOD. A full-res quad
// over a half-res texture computes a negative LOD that clamps to 0, so level 0 —
// an unblurred COPY of the SSR target — was the only level anything ever read.
// The four blur levels were computed and discarded every frame, and every damp
// surface reflected like polished glass. The composite now consumes
// `reflectionAt()`, which is where the roughness→LOD mapping lives; the mips are
// sampled, and the mask is applied once instead of twice.
//
// The copy is NOT waste and stays: it is what keeps the blur passes from binding
// and writing one texture in a single pass, which is the failure this whole chain
// is shaped around.
//
// `enabled` still ships `true`, and deliberately. Cutting a stage is a wave
// owner's call about what ships, not a repair pass's call to quietly zero a
// default — and the honest reading of the evidence is "not yet measured where it
// was designed to work", not "measured and worthless". If the call is ever to
// cut, `post.ssr.enabled: false` in ./tuning.ts also retires this file's
// RECOMPILE_EXCEPTIONS entry in tools/post-chain-contract-test.mjs, which is the
// tension §5 flagged.
//
// STILL UNRESOLVED, and named so it is not lost: the reflection is scaled by
// `post.ssr.intensity` (0.8, applied in the kernel at vendor/ssr.ts:698) AND by
// `post.composite.ssrIntensity` (0.8, applied at the consumer). Both are in the
// brief — §4.3's table and §4.4's formula — so they are a SPEC collision, not a
// coding slip: two sliders in two panels multiply to 0.64 and neither says so.
// Left at 0.64 rather than silently rescaled, because collapsing them changes the
// shipping strength of a stage by 1.25x and that is the wave owner's decision.
import * as THREE from "three/webgpu"
import { unpackRGBToNormal } from "three/tsl"
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
   * ADOPTED BY THE COMPOSITE, which is the point of it. The reflection buffer is
   * a FIVE-LEVEL MIP CHAIN and only this function knows the roughness→LOD
   * mapping; the texture registry it replaced could only hand over a Texture, and
   * a fullscreen quad sampling a half-res texture computes a negative implicit
   * LOD that clamps to 0. So while the registry was the consumer, level 0 was the
   * only level anything read — the copy and the four blur passes ran every frame
   * and were discarded, and every damp surface reflected like polished glass.
   *
   * Mask-weighted and intensity-scaled HERE, once, which is why the composite no
   * longer multiplies by `gbuffer.reflectivityAt(uv)`: that multiply is correct
   * against the RAW texture and squares the mask against this. Reads exactly zero
   * while the stage is disabled or skipped (the `active` uniform), so the
   * composite's uniform branch is a cost optimisation and never a correctness
   * dependency.
   */
  reflectionAt(uv: N): N
  /** Whether the stage is producing this frame's contents. A plain read of the
   *  tunable — it writes no uniform, so a consumer may poll it per frame. */
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
      ssr.dispose()
    }
  }

  // PUBLISHED BEFORE THE FACTORY RETURNS, because `composite` reads the accessor
  // during ITS construction and `chain.ts` builds this stage first (and now
  // checks that it did). The texture registry this replaced could be filled in
  // afterwards precisely because it only ever carried a Texture — and that is
  // exactly why it could not carry the roughness→LOD mapping, which is a graph.
  currentStage = stage

  return stage
}
