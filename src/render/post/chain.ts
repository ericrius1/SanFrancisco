import type * as THREE from "three/webgpu"
import { createChainTargets } from "./targets"
import { createTextureSlot } from "./shared/textureSlot"
import { createCameraHistory, type CameraHistory } from "./shared/matrices"
import { STAGE_ORDER } from "./order"
import { POST_TUNING } from "./tuning"
import type {
  N,
  PostChain,
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
 * control (warmup covered renders and `captureStillRgba` do not go through this
 * driver, so they cannot poison the temporal history).
 */
export function createPostChain(deps: PostChainDeps): PostChain {
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

  const setup: PostStageSetup = {
    renderer,
    gbuffer,
    matrices,
    allocTarget: (spec: TargetSpec) => targets.alloc(spec),
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
   */
  let lastRan: readonly string[] = []
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
    // Recorded through the same variable the loop below writes, for the same
    // reason: the display tail is a pass, it ran, and it is the only one that
    // did. `state()` reads this and reports passes 1 / enabled ["display"].
    lastRan = BYPASS_RAN
  }

  const chain: PostChain = {
    render(frame: PostFrameContext) {
      // Reported by state(). The frame driver owns the real number, because the
      // beauty pass has to be scaled before it renders and that happens upstream
      // of here.
      lastInputScale = frame.outputWidth > 0 ? frame.inputWidth / frame.outputWidth : 1
      matrices.advance(camera)
      resizeIfNeeded(frame)
      if (frame.historyInvalid) matrices.reset(camera)

      if (POST_TUNING.values.enabled !== true) {
        renderBypass(frame)
        return
      }

      let colour: THREE.Texture = beautyTexture
      const ran: string[] = []

      for (const stage of ordered) {
        // THE ENTIRE TOGGLE MECHANISM. Not blitted, not cleared, not rendered —
        // and the stage's targets stay allocated, so re-enabling is free too.
        if (!stage.enabled()) continue
        if (sizedAt.get(stage.id) !== sizeGeneration) {
          stage.setSize(frame)
          sizedAt.set(stage.id, sizeGeneration)
        }
        slots.get(stage.id)?.bind(colour)
        stage.render(frame)
        ran.push(stage.id)
        if (stage.kind === "colour") {
          const produced = stage.output()
          if (produced) colour = produced
        }
      }
      // The chain deliberately does NOT thread `stage.resolution` down the loop.
      // Only the temporal resolve ever changes it (input -> output), and every
      // downstream stage samples by normalized UV with a `texelSize` that
      // `TextureSlot.bind()` re-derives from whatever texture it was just handed.
      // A resolution change is therefore already carried by the binding, and a
      // parallel bookkeeping variable would be a second source of truth.
      lastRan = ran
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

    warmupQuads() {
      const quads: THREE.QuadMesh[] = []
      for (const stage of ordered) {
        for (const quad of stage.warmupQuads()) {
          if (!quads.includes(quad)) quads.push(quad)
        }
      }
      return quads
    },

    get displayPipeline() {
      return displayStage.pipeline
    },

    stages: ordered,

    stage: (id: string) => byId.get(id),

    // A pure read of the last presented frame — it renders nothing, evaluates no
    // stage predicate and touches no uniform, so polling it cannot perturb what
    // it is measuring. `passes` is `enabled.length` by construction; there is no
    // longer a second number that can drift from the first.
    state: () => ({
      enabled: [...lastRan],
      inputScale: lastInputScale,
      passes: lastRan.length
    }),

    grade: grade.runtime,

    dispose() {
      for (const stage of ordered) stage.dispose()
      grade.dispose()
      targets.dispose()
      slots.clear()
    }
  }

  return chain
}

export { STAGE_ORDER }
