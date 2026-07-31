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
// `enabled` SHIPS TRUE, and the argument for cutting it is now falsified rather
// than merely unproven. The case for cutting was written against a mirror-flat
// water g-buffer: "a near-fullscreen ray march traced against a wave-free
// surface, for one code value at the surf line". That surface no longer exists
// (water.ts writes the real ripple normal), and re-measured at the same Ocean
// Beach stop, for the same 1.36-1.44 ms:
//
//   reflection buffer nonZeroRatio  0.0163 -> 0.10905   (6.7x)
//   reflection buffer mean          0.0037 -> 0.01305   (3.5x)
//   non-zero sampled rows           1 of 34 -> 29 of 35
//   band-mean luma, SSR on vs off   +1.39 to +3.69, against an A/A floor of 0.02
//
// wave-locked and on the crests, in the direction the geometry predicts (two
// independent instruments, `.data/postfx/f2b-reflection-direction.json`). It
// reads as sheen on water. Bloom costs more at that stop.
//
// WHAT IT DOES NOT EARN IS THE FRAME WHERE THE MASK IS EMPTY, and most of this
// city is that frame. See "the dry probe" below: the stage now measures the mask
// and skips itself when nobody has opted in, which is a bit-exact identity and
// which is why 0.27 ms of provably-wasted work downtown is no longer the price
// of having reflections at the coast.
//
// STILL UNRESOLVED, and named so it is not lost: the reflection is scaled by
// `post.ssr.intensity` (0.8, applied in the kernel at vendor/ssr.ts:698) AND by
// `post.composite.ssrIntensity` (0.8, applied at the consumer). Both are in the
// brief — §4.3's table and §4.4's formula — so they are a SPEC collision, not a
// coding slip: two sliders in two panels multiply to 0.64 and neither says so.
// Left at 0.64 rather than silently rescaled, because collapsing them changes the
// shipping strength of a stage by 1.25x and that is the wave owner's decision.
import * as THREE from "three/webgpu"
import { max, unpackRGBToNormal, uniform, uv, vec2, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
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

// ------------------------------------------------------------- the dry probe
//
// THE PROBLEM IT SOLVES, measured: at downtown FiDi the SSR mask is provably
// ALL ZERO (`nonZeroRatio 0.00000`, `max 0.000` — wave 2) and the stage still
// costs 0.274 ms, because "the kernel discards on the first statement" prices
// the FRAGMENTS and not the six render passes, the mask fetch per pixel and the
// blur chain that run regardless. Most of this city is inland.
//
// WHY NOT A CPU-SIDE GATE, which was the cheaper-sounding option. Because it
// would not catch the case that motivated this. A CPU gate can only ask "is a
// mask-authoring surface in the frustum", and at FiDi the bay IS in the frustum
// — the mask is empty because BUILDINGS OCCLUDE IT. The bay sheets also span a
// 2 km annulus, so frustum membership is true almost everywhere in this world.
// The only signal that answers the real question is the g-buffer alpha itself.
//
// SHAPE. One draw into a 64x1 r32float target, each texel owning one tile of an
// 8x8 screen grid and taking a 4x4 jittered sub-sample of it: 1024 taps on a
// 32x32 lattice, 16 sequential fetches across 64 parallel lanes, single-digit
// microseconds. 64x1 rather than 8x8 on purpose — `copyTextureToBuffer` aligns
// bytesPerRow to 256 (WebGPUTextureUtils.js:757-760), and 64 floats is exactly
// 256 B, so the readback has no padding to stride over and no trap in it.
//
// The per-frame jitter is what makes small features findable: a puddle smaller
// than a lattice cell is caught within a few frames rather than never.
const PROBE_TILES = 8
const PROBE_SUBS = 4
const PROBE_TEXELS = PROBE_TILES * PROBE_TILES

/** Minimal structural typing for the r185 readback — DOF's autofocus probe uses
 *  the identical route (dof/index.ts), narrowed the same way. */
type PixelReader = {
  readRenderTargetPixelsAsync(
    target: THREE.RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<ArrayLike<number>>
}

/**
 * How many CONSECUTIVE dry readings before the stage skips itself, and how long
 * a wet reading keeps it alive.
 *
 * Asymmetric on purpose. Going wet is instant — one positive reading turns the
 * march back on, so rounding a corner onto the bay costs at most the readback's
 * own latency (1-2 frames). Going dry is slow, because the cost of being wrong
 * in that direction is a visible loss of sheen and the cost of being late is
 * ~0.27 ms for a few more frames.
 */
const DRY_STREAK_TO_SKIP = 4
/** Probe cadence while the stage is already running. Dry frames probe EVERY
 *  frame — that is the case being optimised, and the probe is what pays for it. */
const WET_PROBE_INTERVAL = 8

export function createSsrStage(setup: PostStageSetup): SsrStage {
  const { gbuffer, allocTarget, inputSlot, renderer } = setup
  const slot: TextureSlot = inputSlot()
  const values = SSR_TUNING.values

  const clampResolution = (v: unknown) => Math.min(1, Math.max(0.25, Number(v) || 0.5))

  // `minEdge` on BOTH, and on the reflection target too even though only the
  // blur target carries the pre-declared five-level mip chain. Two reasons, and
  // the second is why this is a fix rather than belt-and-braces:
  //
  //  1. THE POOL IS THE PATH THAT RUNS WHILE THIS STAGE IS OFF. `setSize()`
  //     below has always floored at MIN_SSR_TARGET_EDGE, but a disabled stage is
  //     never sized (chain.ts skips it entirely) while `targets.resize()` still
  //     sizes its pooled targets from the spec — and the composite samples the
  //     blur target every frame regardless, multiplied by `active = 0`. So the
  //     texture gets created at whatever the pool decided, with five mip levels
  //     requested on it, and WebGPU rejects that outright below 16 px.
  //  2. Targets are ALLOCATED at the pool's seed size (1×1 before the first
  //     resize). Boot survived that only because `warmupGroups()` collapses both
  //     of these into one destination by colour-format signature and happens to
  //     bind the reflection target. Flooring the spec removes the coincidence.
  //
  // The two must also stay the same size — `ssr.setSize()` drives one blit
  // between them — so they carry the same floor rather than one each.
  const ssrSpec: MutableSpec = {
    name: "post_ssr_reflection",
    resolution: "input",
    scale: clampResolution(values.resolution),
    type: THREE.HalfFloatType,
    minEdge: MIN_SSR_TARGET_EDGE
  }
  const blurSpec: MutableSpec = {
    name: "post_ssr_blur",
    resolution: "input",
    scale: ssrSpec.scale,
    type: THREE.HalfFloatType,
    minEdge: MIN_SSR_TARGET_EDGE
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

  // ------------------------------------------------------------- the dry probe
  //
  // Built eagerly and warmed with the rest of the stage: it is one NodeMaterial
  // and a 64x1 texture, and it has to be compiled before the first frame that
  // wants to consult it.
  const probeTarget = new THREE.RenderTarget(PROBE_TEXELS, 1, {
    format: THREE.RedFormat,
    type: THREE.FloatType,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false
  })
  probeTarget.texture.name = "post_ssr_dry_probe"

  const probeJitter = uniform(new THREE.Vector2(0, 0)) as N
  const probeQuad = createStageQuad("post_ssr_dry_probe")
  {
    // Unrolled in JS rather than a TSL `Loop`: 16 taps, no loop overhead, no
    // uniformity question to answer, and the graph reads as what it is.
    const index = (uv() as N).x.mul(PROBE_TEXELS).floor()
    const tileX = index.mod(PROBE_TILES)
    const tileY = index.div(PROBE_TILES).floor()
    const taps: N[] = []
    for (let sy = 0; sy < PROBE_SUBS; sy++) {
      for (let sx = 0; sx < PROBE_SUBS; sx++) {
        const offX = probeJitter.x.add(sx + 0.5).div(PROBE_SUBS)
        const offY = probeJitter.y.add(sy + 0.5).div(PROBE_SUBS)
        taps.push(
          maskAt(
            vec2(tileX.add(offX).div(PROBE_TILES), tileY.add(offY).div(PROBE_TILES)) as N
          )
        )
      }
    }
    const peak = taps.reduce((a, b) => max(a, b) as N)
    probeQuad.setFragment(vec4(peak, 0, 0, 1) as N)
  }

  /** Fail OPEN. Until the first readback lands — and after any teardown of the
   *  reading — the stage behaves exactly as it did before this gate existed. */
  let wet = true
  let dryStreak = 0
  let probeInFlight = false
  let framesSinceProbe = 1e9

  const requestDryProbe = (frame: PostFrameContext) => {
    // A cheap decorrelated jitter in [-0.5, 0.5)², deterministic in frameIndex
    // so a cinematic reel probes the same way twice.
    const h = Math.imul(frame.frameIndex ^ 0x9e3779b1, 0x85ebca6b) >>> 0
    probeJitter.value.set(((h & 0xffff) / 65536 - 0.5), ((h >>> 16) / 65536 - 0.5))
    probeQuad.render(frame.renderer, probeTarget)
    framesSinceProbe = 0
    if (probeInFlight) return
    probeInFlight = true
    void (frame.renderer as unknown as PixelReader)
      .readRenderTargetPixelsAsync(probeTarget, 0, 0, PROBE_TEXELS, 1)
      .then((pixels) => {
        const threshold = Number(values.maskThreshold)
        let peak = 0
        for (let i = 0; i < PROBE_TEXELS; i++) {
          const v = pixels[i]
          if (Number.isFinite(v) && v > peak) peak = v
        }
        if (peak > threshold) {
          dryStreak = 0
          wet = true
        } else if (++dryStreak >= DRY_STREAK_TO_SKIP) {
          wet = false
        }
      })
      .catch(() => {
        // Device loss, a disposed target, a readback that never maps. FAIL OPEN:
        // a gate that cannot see must not be allowed to delete reflections.
        wet = true
        dryStreak = 0
      })
      .finally(() => {
        probeInFlight = false
      })
  }

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

    /**
     * The per-frame reconcile for a stage that may be skipped, and the place the
     * dry probe is paid for.
     *
     * Two jobs:
     *
     *  1. `ssr.active` — a skipped stage keeps its last-rendered target
     *     contents, so without this the composite would go on adding a frozen
     *     reflection after the stage stopped running. Zeroing it here makes a
     *     skip an exact identity, whether the skip came from the user's toggle
     *     or from the dry gate.
     *  2. The probe. It runs EVERY frame while the stage is skipped (that is the
     *     frame being optimised, and 1024 taps is what buys the skip) and once
     *     every WET_PROBE_INTERVAL frames while it is running (where the march
     *     dwarfs it and only "have we gone dry" is still in question).
     *
     * Note the probe runs on frames the stage does not: it samples the BEAUTY
     * pass's g-buffer, which pipeline.ts has already produced by the time the
     * chain is driven, so it needs nothing from this stage's own passes.
     */
    prepare: (frame: PostFrameContext) => {
      const userOn = values.enabled === true
      const gateOn = values.autoSkipWhenDry !== true || wet
      ssr.active.value = userOn && gateOn ? 1 : 0
      if (!userOn || values.autoSkipWhenDry !== true) {
        // Nothing to decide. Leave the reading where it is but do not let it go
        // stale in the "dry" direction while nobody is looking — re-arming to
        // wet means switching the gate back on never costs a dark first frame.
        if (values.autoSkipWhenDry !== true) {
          wet = true
          dryStreak = 0
        }
        return
      }
      framesSinceProbe += 1
      if (wet && framesSinceProbe < WET_PROBE_INTERVAL) return
      requestDryProbe(frame)
    },

    // PURE. `values.enabled` is the user's and is never written from this file;
    // the gate can only subtract. See ./tuning.ts on `autoSkipWhenDry`.
    enabled: () =>
      values.enabled === true && (values.autoSkipWhenDry !== true || wet),

    output: () => null,

    render: (frame: PostFrameContext) => {
      ssr.render(frame.renderer)
    },

    setSize,

    /**
     * A teleport, a resize, a master-toggle flip — anything the chain calls
     * `invalidateHistory` for is also a reason the last dry reading describes a
     * frame that no longer exists. FAIL OPEN and let the probe re-establish it,
     * so arriving at Ocean Beach never starts with the reflections switched off.
     */
    invalidateHistory: () => {
      wet = true
      dryStreak = 0
      framesSinceProbe = 1e9
    },

    warmupQuads: () => [...ssr.quads, probeQuad.mesh],

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

    reflectionAt: (uvNode: N) => ssr.reflectionAt(uvNode),
    // Both halves, so a consumer polling this agrees with what the chain will
    // actually run. It stays a plain read — no uniform is written here.
    active: () => values.enabled === true && (values.autoSkipWhenDry !== true || wet),

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
      probeQuad.dispose()
      probeTarget.dispose()
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
