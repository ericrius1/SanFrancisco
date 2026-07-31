// A value import, not `import type`: `warmupGroups()` below constructs a 1x1
// scratch RenderTarget so a stage whose targets are vendor-internal can still be
// warmed against a matching colour format. See the WARMUP GROUPING note.
import * as THREE from "three/webgpu"
import { RENDER_TUNING } from "../../config"
import { setTemporalResolveReporter } from "../pocketQuality"
import { createChainTargets } from "./targets"
import { createTextureSlot } from "./shared/textureSlot"
import { createCameraHistory, type CameraHistory } from "./shared/matrices"
import { STAGE_ORDER } from "./order"
import { POST_TUNING } from "./tuning"
import type {
  N,
  PostChain,
  PostChainState,
  PostFrameContext,
  PostGBuffer,
  PostStage,
  PostStageSetup,
  TargetSpec,
  TextureSlot
} from "./types"

import { createVelocityStage } from "./velocity"
import { createJitterStage } from "./jitter"
import { createSsaoStage } from "./ssao"
import { createSsrStage } from "./ssr"
import { createGodRaysStage } from "./godrays"
import { createCompositeStage } from "./composite"
import { createTemporalStage } from "./temporal"
import { createDofStage } from "./dof"
import { createBloomStage } from "./bloom"
import { createGradeAdapter } from "./grade"
import { createSharpenStage } from "./sharpen"
import { createGrainStage } from "./grain"
import { createDisplayStage } from "./display"

/** What `#renderBypass` runs: the display tail, and nothing else. */
const BYPASS_RAN: readonly string[] = Object.freeze(["display"])

/**
 * The looks fused into the display tail's ONE fragment shader
 * (display/index.ts:64-86 calls them in order). They own no pass, so the frame
 * driver never calls them and their `enabled()` returns false by contract; they
 * are evaluated whenever the tail draws, which is every presented frame,
 * including under the master bypass. Their "off" is a uniform-valued identity
 * (`grain.strength 0` and `sharpen.amount 0` are both measured bit-exact —
 * .data/postfx/wave2-correctness.md §6 and §7), not a skipped stage.
 *
 * Stated here rather than inferred from `kind: "inline"` because that kind does
 * not mean "fused": `display` is inline (it produces no chain texture) and IS
 * the pass, and `jitter` is inline but has a live predicate — it is a camera
 * hook the frame driver applies, so the loop below reports it from `enabled()`
 * like any other stage. The construction check underneath makes this list
 * fail loudly instead of quietly going stale.
 */
const FUSED_INTO_DISPLAY: readonly string[] = Object.freeze(["grade", "sharpen", "grain"])

/**
 * One compile batch: the quads to compile, and the render target whose COLOUR
 * FORMAT they will actually be drawn into. See the WARMUP GROUPING note on
 * `warmupGroups()` for why the target, not just the quad, has to be named.
 */
export type WarmupGroup = {
  /** null = the canvas, which is where the display tail presents. */
  readonly target: THREE.RenderTarget | null
  readonly quads: THREE.QuadMesh[]
}

/**
 * The chain as its own module sees it: `PostChain` plus the warmup grouping,
 * which is deliberately NOT public. Only `warmup.ts` may consume it, because
 * binding a group's target is half of what makes the warm match the runtime and
 * a caller that iterates the groups without doing that is back to warming the
 * canvas format (see `warmChainQuads`).
 */
export interface PostChainInternals extends PostChain {
  readonly warmupGroups: () => WarmupGroup[]
}

/**
 * Typed read of `state()`.
 *
 * A plain pass-through now that `PostChain.state` carries `PostChainState`
 * itself — kept because it is what the panel and the probes already call, and
 * because a named door is the honest place to hang the "tick, then read"
 * warning that `state()` carries in types.ts.
 */
export function postChainState(chain: PostChain): PostChainState {
  return chain.state()
}

export type PostChainDeps = {
  readonly renderer: THREE.WebGPURenderer
  readonly camera: THREE.PerspectiveCamera
  /** Everything the beauty pass publishes. Built by pipeline.ts. */
  readonly gbuffer: PostGBuffer
  /** The beauty pass's colour attachment — the chain's source each frame. */
  readonly beautyTexture: THREE.Texture
  /** Half-res close-contact complement, consumed by the composite. */
  readonly contactFactorAt?: (uv: N) => N
}

/**
 * The assembler.
 *
 * The one structural decision everything else follows from: **the chain is
 * driven explicitly, in a fixed order, from pipeline.render(). No stage is ever
 * scheduled by the node graph, and every node the chain owns sets
 * `updateBeforeType = NodeUpdateType.NONE`.**
 *
 * The reason is measured, not theoretical. `Renderer.js:3778` calls
 * `this._nodes.updateBefore(renderObject)` from `renderObject()` — which runs
 * WHILE A RENDER PASS IS OPEN. A FRAME-scoped node reached from that path
 * renders its quads inside somebody else's pass, and WebGPU rejects the whole
 * command buffer when a pass both writes and binds the same texture: the frame
 * comes out as bare clear colour. contactShadows.ts:326-345 records the
 * measurement verbatim — ~70% of captures across the same ten-second shot, the
 * rest clean, and once it starts it repeats every frame. Every stock display
 * node three ships is FRAME-scoped (GTAONode.js:89, SSRNode.js:160,
 * TAAUNode.js:68, TRAANode.js:58, DepthOfFieldNode.js:224, BloomNode.js:266,
 * SharpenNode.js:100), so dropping seven of them into this renderer unmodified
 * is asking for that failure seven more times, non-deterministically.
 *
 * Driving explicitly buys four more things, and each of them is a requirement:
 * free toggles ("off" is not calling `stage.render()` — zero recompile, zero
 * variant matrix), a deterministic order that is a contract rather than an
 * emergent property of graph dependencies, ownership of the TAA jitter (we never
 * touch `RenderPipeline.context.onBeforeRenderPipeline`, which is a single
 * assignable slot that two stock temporal nodes both write to), and history
 * control (warmup covered renders do not go through this driver; H-key stills
 * invalidate history on both sides of their own accumulation so they cannot
 * poison the live temporal history).
 */
export function createPostChain(deps: PostChainDeps): PostChainInternals {
  const { renderer, camera, gbuffer, beautyTexture } = deps

  const targets = createChainTargets()
  const matrices: CameraHistory = createCameraHistory(camera)
  const grade = createGradeAdapter()

  // Per-stage upstream colour slots. A stage asks for one during construction;
  // the chain rebinds it every frame to whatever the last ENABLED upstream stage
  // produced. That rebinding is a binding update, never a recompile, which is
  // precisely what makes skipping a stage cost zero rather than costing a blit.
  const slots = new Map<string, TextureSlot>()
  let constructing: string | null = null
  /**
   * Which pooled targets each stage allocated, recorded as it asks for them.
   * `warmupGroups()` needs "what colour format does this stage's quad actually
   * draw into", and this is the only place that answer exists without adding a
   * method to `PostStage`. Recording it here also means it cannot go stale: a
   * stage that changes its target's format changes what it is warmed against, in
   * the same edit, with no second list to update.
   */
  const stageTargets = new Map<string, THREE.RenderTarget[]>()

  const setup: PostStageSetup = {
    renderer,
    gbuffer,
    matrices,
    allocTarget: (spec: TargetSpec) => {
      const target = targets.alloc(spec)
      if (constructing !== null) {
        const owned = stageTargets.get(constructing) ?? []
        if (!owned.includes(target)) owned.push(target)
        stageTargets.set(constructing, owned)
      }
      return target
    },
    inputSlot: () => {
      const id = constructing
      if (id === null) throw new Error("[post] inputSlot() is only valid during stage construction")
      const existing = slots.get(id)
      if (existing) return existing
      const slot = createTextureSlot(`${id}_input`, beautyTexture)
      slots.set(id, slot)
      return slot
    }
  }

  /** Names the stage whose `inputSlot()` calls belong to the slot map. */
  const build = <T extends PostStage>(id: string, create: () => T): T => {
    constructing = id
    try {
      return create()
    } finally {
      constructing = null
    }
  }

  // The display tail is built first because it is the only stage the chain holds
  // a concrete reference to (it owns the single RenderPipeline); it still runs
  // last, by STAGE_ORDER.
  const displayStage = build("display", () => createDisplayStage(setup, { renderer, grade }))

  /**
   * THE STAGE REGISTRY. One entry per stage id, every stage registered at once,
   * in final chain order.
   *
   * This exists in exactly this shape so the units that follow can each rewrite
   * ONLY their own folder and never touch a shared file: a unit replaces the body
   * of `post/<its stage>/index.ts` and this line does not move. Do not reorder
   * these to express a preference — `STAGE_ORDER` in ./order.ts is where the
   * ordering decision lives, and the sort below is what actually enforces it.
   */
  const stages: PostStage[] = [
    build("velocity", () => createVelocityStage(setup)),
    build("jitter", () => createJitterStage(setup)),
    build("ssao", () => createSsaoStage(setup)),
    build("ssr", () => createSsrStage(setup)),
    build("godrays", () => createGodRaysStage(setup)),
    build("composite", () =>
      createCompositeStage(setup, { contactFactorAt: deps.contactFactorAt })
    ),
    build("temporal", () => createTemporalStage(setup)),
    build("dof", () => createDofStage(setup)),
    build("bloom", () => createBloomStage(setup)),
    grade.stage,
    build("sharpen", () => createSharpenStage(setup)),
    build("grain", () => createGrainStage(setup)),
    displayStage
  ]
  constructing = null

  /**
   * CONSTRUCTION order, not render order — the one place the two are both load
   * bearing, so it is checked rather than assumed.
   *
   * `composite` builds its fragment ONCE and reaches SSR through the module
   * accessor `ssrReflections()`, which returns an INERT set until
   * `createSsrStage()` has run. Build them the other way round and the composite
   * silently compiles with no reflection term at all: no error, no warning, a
   * stage that renders six passes into a buffer nothing samples. That is the
   * exact failure mode this chain is supposed to make impossible, so it gets an
   * assertion instead of a comment.
   *
   * This is a JS-time ordering question about the array literal above and cannot
   * be expressed through STAGE_ORDER, which only sorts the per-frame loop.
   */
  const constructionOrder = stages.map((stage) => stage.id)
  if (constructionOrder.indexOf("ssr") > constructionOrder.indexOf("composite")) {
    throw new Error(
      "[post] the ssr stage must be CONSTRUCTED before composite — the composite captures " +
        "ssrReflections() while building its fragment, and an inert capture loses reflections silently"
    )
  }

  const ordered = [...stages].sort((a, b) => a.order - b.order)
  const byId = new Map(ordered.map((stage) => [stage.id, stage]))
  if (ordered[ordered.length - 1] !== displayStage) {
    throw new Error("[post] the display tail must be last in STAGE_ORDER")
  }

  // FUSED_INTO_DISPLAY is a claim about other folders, so it is checked rather
  // than trusted: each named stage must exist, must be inline, and must own no
  // quad. The day someone gives sharpen a pass of its own, this throws at boot
  // instead of quietly under-reporting `passes` forever.
  for (const id of FUSED_INTO_DISPLAY) {
    const fused = byId.get(id)
    if (!fused || fused.kind !== "inline" || fused.warmupQuads().length > 0) {
      throw new Error(
        `[post] "${id}" is listed as fused into the display tail but is not a pass-free inline ` +
          "stage. Either it grew a pass — in which case it belongs in the render loop and out of " +
          "FUSED_INTO_DISPLAY — or it was renamed and state().inline is now lying about it."
      )
    }
  }

  /**
   * Does this stage own a PASS — i.e. does the driver calling `render()` issue
   * GPU work?
   *
   * Derived from the existing contract with exactly one exception, rather than
   * from a second list: `kind: "inline"` means "no chain texture of my own", and
   * for grade / sharpen / grain / jitter that also means no pass. The display
   * tail is inline for the same reason (it presents, it does not publish) but it
   * IS the pass the others are fused into, and the chain already holds it by
   * reference and asserts it runs last.
   */
  const ownsPass = (stage: PostStage) => stage.kind !== "inline" || stage === displayStage

  /**
   * Tell the resolution systems whether a temporal resolve is ACTUALLY running.
   *
   * Two consumers hang off this and both fail quietly in the wrong direction if
   * it is left at its default: `pocketRenderScale()` drops the Sutro hall's
   * 1.5x supersample on the promise that TAA is gathering that coverage instead
   * (no AA at all if it isn't), and `upscaleAvailable()` decides whether the
   * governor's ladder degrades the beauty pass or the drawing buffer (a lever
   * that publishes caps nothing consumes if it guesses wrong).
   *
   * The stage toggle alone is not the answer, which is the whole reason this
   * call exists: `post.enabled` is a master bypass, and with it off `render()`
   * takes `renderBypass` above and no stage runs however `post.temporal.enabled`
   * reads. Only the chain knows both halves, so the chain is what reports them.
   *
   * Installed here rather than in pipeline.ts because it is a fact about a
   * chain, and the chain is built in exactly one place. A second chain would
   * replace the reporter rather than race it.
   */
  const temporalStage = byId.get("temporal")
  // Wireframe forces the master bypass (see render below) so TAA is not live
  // either — pocket/governor resolution must agree or beauty stays half-res
  // while the resolve that justified it is skipped.
  setTemporalResolveReporter(
    () =>
      POST_TUNING.values.enabled === true &&
      RENDER_TUNING.values.wireframe !== true &&
      temporalStage?.enabled() === true
  )

  /**
   * A monotonic size generation, NOT a dirty flag plus a "who has been sized"
   * set. The pair was wrong in a way that only shows up after a specific
   * sequence: a stage that had already been sized, then got disabled, then sat
   * out a resize (the flag is cleared at the end of that frame, and a skipped
   * stage keeps its stale set entry), would be re-enabled at the old size and
   * never told. It affects every toggleable stage, and the symptom — one stage
   * rendering at the pre-resize resolution — reads as a stage bug rather than a
   * chain bug. Comparing a per-stage stamp against a counter makes "has this
   * stage been sized for the CURRENT geometry" the actual question asked.
   */
  let sizeGeneration = 1
  const sizedAt = new Map<string, number>()
  let lastInputWidth = 0
  let lastInputHeight = 0
  let lastOutputWidth = 0
  let lastOutputHeight = 0
  /**
   * THE STAGES THAT ACTUALLY RENDERED on the last presented frame, in the order
   * they ran. `state()` reports this and derives `passes` from its length, which
   * is the only way the two can be made to agree.
   *
   * They did not. `state().passes` was a record of the last frame while
   * `state().enabled` re-ran every stage's `enabled()` predicate at call time, so
   * the pair answered two different questions — "how many stages rendered" versus
   * "how many would render if the chain ran". Under the master toggle they
   * disagreed by construction: `#renderBypass` runs exactly one pass and the
   * predicates still reported the seven stages that would have run. Any check of
   * `passes === enabled.length` was therefore false the moment anyone bypassed
   * the chain, which is the shape of contract that gets deleted rather than
   * fixed.
   *
   * Re-running the predicates was also not the read-only observation it looked
   * like: `enabled()` is the ONLY per-frame hook a skipped stage gets, and SSR
   * uses it to write `ssr.active.value` (ssr/index.ts:239-247). A probe polling
   * `state()` was writing a GPU uniform.
   *
   * WHAT THE TWO LISTS MEAN, and why there are two. Reporting only what the
   * driver ran told a second, measurable lie: grain at strength 0.2 moves the
   * frame by 23.55 meanAbsDelta (.data/postfx/wave2-correctness.md §6) while
   * `state().enabled` never named it, because a stage fused into the display
   * tail has no pass for the driver to call and reports `enabled() === false` so
   * as not to inflate the pass count. So:
   *
   *   passes  — stages that issued GPU work last frame. The cost number.
   *   enabled — those same stages, in the order they ran. `passes ===
   *             enabled.length` holds by construction, which is what the probes
   *             assert; it is one list read twice, not two counters.
   *   inline  — stages that were ACTIVE last frame and own no pass: the jitter
   *             hook when it is on, plus FUSED_INTO_DISPLAY whenever the tail
   *             drew.
   *
   * `inline` is honest about what it can be: an entry means the stage's
   * arithmetic is IN the presented shader, not that its slider is above zero.
   * A stage with no pass has no per-frame hook the chain could ask, and its off
   * state is a uniform-valued identity rather than an absence.
   */
  let lastRan: readonly string[] = []
  let lastInline: readonly string[] = []
  let lastInputScale = 1

  const resizeIfNeeded = (frame: PostFrameContext) => {
    if (
      frame.inputWidth === lastInputWidth &&
      frame.inputHeight === lastInputHeight &&
      frame.outputWidth === lastOutputWidth &&
      frame.outputHeight === lastOutputHeight
    ) {
      return
    }
    lastInputWidth = frame.inputWidth
    lastInputHeight = frame.inputHeight
    lastOutputWidth = frame.outputWidth
    lastOutputHeight = frame.outputHeight
    targets.resize(
      { width: frame.inputWidth, height: frame.inputHeight },
      { width: frame.outputWidth, height: frame.outputHeight }
    )
    sizeGeneration += 1
  }

  /**
   * Master toggle off: present the beauty pass through the display tail and run
   * no stage at all. Deliberately NOT a fallback path with its own graph — it is
   * the same single RenderPipeline reading a different texture, which is the
   * whole point of the slot mechanism.
   */
  const renderBypass = (frame: PostFrameContext) => {
    slots.get("display")?.bind(beautyTexture)
    displayStage.render(frame)
    // Recorded through the same variables the loop below writes, for the same
    // reason: the display tail is a pass, it ran, and it is the only one that
    // did. `state()` reads these and reports passes 1 / enabled ["display"].
    // The fused looks are still in that shader — bypassing the CHAIN does not
    // bypass the tail — so a bypassed frame is still graded, sharpened and
    // grained, and `inline` says so.
    lastRan = BYPASS_RAN
    lastInline = FUSED_INTO_DISPLAY
  }

  /**
   * The stand-in destination for a stage whose targets are vendor-internal.
   * 1x1 on purpose: the pipeline cache key carries format, samples and colour
   * space and never dimensions, so this warms the right pipeline for the price
   * of one texel. Built lazily so a chain that is never warmed never allocates
   * it, and matched to targets.ts's format policy (rgba16float, no depth).
   */
  let warmScratch: THREE.RenderTarget | null = null
  const hdrScratch = (): THREE.RenderTarget => {
    if (warmScratch === null) {
      warmScratch = new THREE.RenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false
      })
      warmScratch.texture.name = "post_warmup_hdr"
    }
    return warmScratch
  }

  const chain: PostChainInternals = {
    render(frame: PostFrameContext) {
      // Reported by state(). The frame driver owns the real number, because the
      // beauty pass has to be scaled before it renders and that happens upstream
      // of here.
      lastInputScale = frame.outputWidth > 0 ? frame.inputWidth / frame.outputWidth : 1
      matrices.advance(camera)
      resizeIfNeeded(frame)
      if (frame.historyInvalid) matrices.reset(camera)

      // Wireframe is a debug topology view — TAA/bloom/SSAO smear or glow the
      // lines. Bypass the stage loop (display tail still presents) without
      // mutating the user's persisted `post.enabled` preference.
      if (POST_TUNING.values.enabled !== true || RENDER_TUNING.values.wireframe === true) {
        renderBypass(frame)
        return
      }

      let colour: THREE.Texture = beautyTexture
      const ran: string[] = []
      const inline: string[] = []

      for (const stage of ordered) {
        // The per-frame hook a SKIPPED stage gets, with a frame context and no
        // pass open. It is what lets `enabled()` below be a pure predicate:
        // neutralising uniforms (SSAO's `aoStrength`, SSR's `active`) and any
        // work a stage does to EARN its skip (SSR's dry probe) happen here, so
        // a probe polling the predicate no longer writes to the GPU.
        stage.prepare?.(frame)
        // THE ENTIRE TOGGLE MECHANISM. Not blitted, not cleared, not rendered —
        // and the stage's targets stay allocated, so re-enabling is free too.
        // "Free" is checked, not hoped: no stage frees a target outside its own
        // dispose() except the two that OWN their GPU lifetime deliberately —
        // god rays, whose runtime is a lazily imported region feature, and DOF,
        // which ships off and would otherwise park ~30 MB of full- and half-res
        // output-resolution targets for the session the first time anyone
        // enabled it. Both demote through the structure lane, never from here.
        // The one place a kept target could still bite is the temporal resolve,
        // whose history would be arbitrarily old on the frame it comes back —
        // temporal/index.ts seeds on a frameIndex gap for exactly that reason,
        // so re-enabling costs a seeded frame rather than a smear.
        if (!stage.enabled()) continue
        if (sizedAt.get(stage.id) !== sizeGeneration) {
          stage.setSize(frame)
          sizedAt.set(stage.id, sizeGeneration)
        }
        slots.get(stage.id)?.bind(colour)
        stage.render(frame)
        // A pass-free stage that said yes is ACTIVE, not a pass. Today that is
        // only the jitter hook, whose render() is a no-op because the frame
        // driver — not the chain — is what applies the camera offset.
        if (ownsPass(stage)) ran.push(stage.id)
        else inline.push(stage.id)
        if (stage.kind === "colour") {
          const produced = stage.output()
          // A "colour" stage that rendered and produced nothing leaves the chain
          // colour where it was. That is a stage-contract violation, not a
          // supported mode; the guard exists because carrying `null` forward
          // would present a black frame, and a black frame is a worse diagnostic
          // than an unchanged one.
          if (produced) colour = produced
        }
      }
      // The fused looks live in the tail's fragment shader, so they ran iff the
      // tail drew. Appended after the loop rather than tracked in it: they never
      // enter the loop at all — `enabled()` is false for a stage with no pass.
      if (ran.includes(displayStage.id)) inline.push(...FUSED_INTO_DISPLAY)
      // The chain deliberately does NOT thread `stage.resolution` down the loop.
      // Only the temporal resolve ever changes it (input -> output), and every
      // downstream stage samples by normalized UV with a `texelSize` that
      // `TextureSlot.bind()` re-derives from whatever texture it was just handed.
      // A resolution change is therefore already carried by the binding, and a
      // parallel bookkeeping variable would be a second source of truth.
      lastRan = ran
      lastInline = inline
    },

    applyParams() {
      for (const stage of ordered) stage.applyParams()
    },

    applyStructure() {
      for (const stage of ordered) stage.applyStructure?.()
      // Every stage re-sizes on its next enabled frame. A structural key is
      // usually a resolution scale, and a stage's own targets are sized from it
      // rather than from the pool.
      sizeGeneration += 1
    },

    invalidateHistory(reason: string) {
      void reason
      matrices.reset(camera)
      for (const stage of ordered) stage.invalidateHistory?.()
    },

    /**
     * WARMUP GROUPING — the same quads, batched by the colour format they will
     * actually be drawn into.
     *
     * Compiling with NO render target bound does not warm what the chain runs,
     * and this is verifiable rather than suspected. `Pipelines._getRenderCacheKey`
     * (Pipelines.js:431-433) is `stageVertex.id + stageFragment.id +
     * backend.getRenderCacheKey(renderObject)`, and the backend half
     * (WebGPUBackend.js:2125-2140) includes
     * `utils.getCurrentColorFormat(renderContext)` and
     * `getCurrentDepthStencilFormat(renderContext)`. With no target bound,
     * `renderContext.textures === null`, so those resolve to the PREFERRED CANVAS
     * FORMAT (bgra8unorm) and depth32float (WebGPUUtils.js:130-150, :44-78, with
     * `renderContext.depth = this.depth` at Renderer.js:931). Every chain stage
     * instead draws into a pooled target whose texture is rgba16float / rg16float
     * / r16float with `depthBuffer: false`, and Renderer.js:1693-1699 sets
     * `renderContext.depth = renderTarget.depthBuffer` — so BOTH halves of that
     * key differ and the pipeline compiled at boot is not the pipeline used at
     * runtime. Only the display tail matched, because it alone presents to the
     * canvas.
     *
     * WHAT THAT ACTUALLY COST, which is the part nobody had checked: the
     * expensive half was warm anyway. `NodeManager.getForRenderCacheKey` is
     * `renderObject.initialCacheKey` (NodeManager.js:151-155), which is
     * material + dynamic key with NO render context in it (RenderObject.js:730,
     * :913-951), and `Pipelines.programs.vertex/fragment` are keyed by the shader
     * SOURCE STRING (Pipelines.js:186-212). So TSL codegen, WGSL generation and
     * `device.createShaderModule` are shared across render contexts and are
     * genuinely warmed by the boot compile. What is NOT warmed is the
     * `GPURenderPipeline` per (module, colour format) pair, which on Metal is
     * where the MSL compile and PSO link happen — created SYNCHRONOUSLY, mid
     * frame, the first time a stage draws. So "no toggle can ever create an
     * uncompiled pipeline at runtime" was false as written, but the residue is a
     * PSO build, not a shader build.
     *
     * The fix is to name the destination, and the chain is the only place that
     * knows it: a stage's own pooled targets when it has any, otherwise a 1x1
     * HDR scratch. Size is irrelevant — the cache key carries format, sample
     * count and colour space, never dimensions — so the scratch costs one 1x1
     * texture and matches every stage whose targets are vendor-internal
     * (temporal's history pair, bloom's mip chain, the god-ray composite: all
     * rgba16float).
     *
     * FOUR quads do NOT match, all of them DOF's: the CoC gaussian's PAIR
     * (RedFormat/Half, dof/vendor/gaussianBlur.ts), the `dof_coc_blurred` quad
     * (RedFormat, dof/vendor/dof.ts) and the 1x1 r32float focus probe. The
     * honest fix is for `PostStage` to hand back quads WITH their targets, which
     * is a types.ts change. It is no longer a boot cost either way: DOF is lazy
     * (dof/index.ts) and returns no quads at all until someone enables it, so
     * those four are warmed — imperfectly — only on the structure lane that
     * builds them, and the residue is one hitch on the first DOF frame.
     */
    warmupGroups() {
      const groups: WarmupGroup[] = []
      // Format identity, not object identity: SSR allocates two rgba16float
      // targets and both produce the same pipeline key, so warming against one
      // warms both. Dimensions are deliberately absent — see above.
      const signature = (target: THREE.RenderTarget) =>
        `${target.texture.format}:${target.texture.type}:${target.texture.colorSpace}:${target.samples}`

      for (const stage of ordered) {
        const quads = stage.warmupQuads()
        if (quads.length === 0) continue
        if (stage === displayStage) {
          // The tail presents to whatever the caller bound, which is the canvas
          // on every frame that is not a still capture. null is that context.
          groups.push({ target: null, quads })
          continue
        }
        const owned = stageTargets.get(stage.id) ?? []
        const destinations: (THREE.RenderTarget | null)[] = []
        const seen = new Set<string>()
        for (const target of owned) {
          const key = signature(target)
          if (seen.has(key)) continue
          seen.add(key)
          destinations.push(target)
        }
        if (destinations.length === 0) destinations.push(hdrScratch())
        for (const target of destinations) groups.push({ target, quads })
      }
      return groups
    },

    get displayPipeline() {
      return displayStage.pipeline
    },

    stages: ordered,

    stage: (id: string) => byId.get(id),

    // A pure read of the last presented frame — it renders nothing, evaluates no
    // stage predicate and touches no uniform, so polling it cannot perturb what
    // it is measuring. `passes` is `enabled.length` by construction; there is no
    // longer a second number that can drift from the first. `inline` is the
    // stages that were active with no pass of their own — see the note on
    // `lastInline` for what an entry there does and does not claim.
    state: () => ({
      enabled: [...lastRan],
      inline: [...lastInline],
      inputScale: lastInputScale,
      passes: lastRan.length
    }),

    grade: grade.runtime,

    dispose() {
      for (const stage of ordered) stage.dispose()
      grade.dispose()
      targets.dispose()
      warmScratch?.dispose()
      warmScratch = null
      slots.clear()
      stageTargets.clear()
      // Symmetry with the reporter installed at construction. A torn-down chain
      // renders nothing, so "is a resolve running" is false — and answering
      // anything else is not harmless: the pocket drops its 1.5x supersample on
      // the promise that TAA replaces it, so a stale `true` leaves the Sutro
      // hall with no anti-aliasing at all. `null` would restore the default,
      // which reads the stage toggle and would still say true.
      //
      // Unreached today (pipeline.ts builds one chain and never disposes it),
      // and kept anyway because dispose() exists precisely so that stops being
      // guaranteed.
      setTemporalResolveReporter(() => false)
    }
  }

  return chain
}

export { STAGE_ORDER }
