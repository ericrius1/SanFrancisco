// U7 · Composite + survivors + god rays — build spec: .data/postfx/BRIEF.md §7
//
// SURVIVOR ADAPTER, not a rewrite. `src/render/pianoGodRays.ts` stays untouched;
// this folder owns the lazy import, the epoch guard, setPianoGodRaysArea,
// applyPianoGodRaysFx, the shadowMapReady() promote/demote gate and
// disposePianoGodRaysRuntime — all of which moved here intact from the old
// pipeline.ts:285-430, :1000-1013. The 16-entry `pianoGodRaysVariants` map died
// with them: there are no style masks and no bloom families left to cross with,
// so there is exactly one composite source to swap.
//
// HOW IT PLUGS INTO THE CHAIN. The runtime's `sceneTexture` is an `rtt()` of
// beauty ⊕ raymarch ⊕ bilateral blur ⊕ depth-aware blend. This stage declares
// itself `kind: "colour"` at STAGE_ORDER.godrays (45) — one slot ahead of the
// composite (50) — so chain.ts:223-226 threads its output forward as the
// composite's beauty source with no shared-file edit and no second pipeline.
// While the player is outside the grove the stage is simply not enabled, which
// costs exactly nothing (chain.ts:215).
//
// TWO THINGS THIS ADAPTER MUST DO THAT THE OLD PIPELINE GOT FOR FREE, because
// the RTT used to sit inside the display pipeline's own node graph and now
// nothing samples the NODE — the composite samples its TEXTURE through the
// chain's slot:
//
//  1. Build it. `RTTNode.setup()` is what assigns `_rttNode`, and without it
//     `updateBefore` would render the RTT's quad with a null fragment node. The
//     copy quad below is the one graph that contains the RTT node, so building
//     that material is what arms the whole stack.
//  2. Drive it. `updateBeforeType` is forced to NONE and `updateBefore` is called
//     explicitly, from `render()`, with NO pass open. Left at RENDER scope it
//     would fire from `Renderer.js:3778` — i.e. from inside the copy quad's own
//     render pass, while that pass binds the very texture the RTT writes. That
//     is the WebGPU command-buffer rejection contactShadows.ts:326-345 measured
//     at ~70% of captures coming back as bare clear colour.
//
// Still nested, and deliberately unchanged: GodraysNode (FRAME) and
// BilateralBlurNode fire from inside the RTT's own quad render. That is exactly
// what shipped before, except the outermost pass is now the RTT's instead of the
// display pipeline's — strictly one level shallower.
import * as THREE from "three/webgpu"
import { NodeUpdateType, screenUV, vec4 } from "three/tsl"
import { createStageQuad, type StageQuad } from "../shared/fullscreen"
import { STAGE_ORDER } from "../order"
import type { PostFrameContext, PostStage, PostStageSetup } from "../types"
import type { PianoGodRaysParams } from "../../pianoGodRaysTypes"
import { GODRAYS_TUNING, getPianoGodRaysParams } from "./tuning"

type PianoGodRaysRuntime = {
  sceneTexture: any
  configure(params: PianoGodRaysParams): void
  update(center: THREE.Vector3): void
  shadowMapReady(): boolean
  dispose(): void
}

export type GodRaysState = {
  requested: boolean
  active: boolean
  loaded: boolean
  renderedFrames: number
}

export type GodRaysControls = {
  /**
   * Hand the adapter the two things `PostStageSetup` does not carry: the scene
   * the dedicated shadow light attaches to, and the world sun whose direction it
   * copies. Required — `createPianoGodRays` cannot be built without them, and
   * chain.ts constructs every stage with `setup` alone.
   */
  attachWorld(scene: THREE.Scene, light: THREE.DirectionalLight | null): void
  /** Enter/leave the only area allowed to allocate and render god rays. */
  setArea(active: boolean, center?: THREE.Vector3): void
  /** Push controls without touching anything else in the chain. */
  applyFx(): void
  /** Promote once the dedicated light's shadow map exists, demote if it retires.
   *  Called from the frame driver BEFORE anything opens a pass. */
  updatePromotion(): void
  state(): GodRaysState
}

export type GodRaysStage = PostStage & GodRaysControls

/**
 * THE LAZY BOUNDARY. `src/render/pianoGodRays.ts` pulls in three's official
 * raymarched GodraysNode stack, a dedicated shadow light and its own render
 * targets — none of which may exist until the player actually enters the grove
 * gate, and all of which are disposed on leaving.
 *
 * It lives here, exported, specifically so the boundary never disappears from
 * the source tree between units: tools/mission-dolores-contract-test.mjs asserts
 * on its literal text, and a contract that goes red for a whole wave teaches
 * everyone to ignore it.
 */
let pianoGodRaysModulePromise: Promise<typeof import("../../pianoGodRays")> | null = null;
export function loadPianoGodRaysModule() {
  if (!pianoGodRaysModulePromise) {
    pianoGodRaysModulePromise = import("../../pianoGodRays").catch((err) => {
      pianoGodRaysModulePromise = null
      throw err
    })
  }
  return pianoGodRaysModulePromise
}

const INERT_STATE: GodRaysState = Object.freeze({
  requested: false,
  active: false,
  loaded: false,
  renderedFrames: 0
})

export function createGodRaysStage(setup: PostStageSetup): GodRaysStage {
  const camera = setup.gbuffer.camera

  // The official raymarched GodraysNode stack is a piano-only nested lazy
  // feature. Its module, dedicated shadow light and render targets do not exist
  // until the player enters the grove gate; leaving disposes all GPU ownership.
  let scene: THREE.Scene | null = null
  let sourceLight: THREE.DirectionalLight | null = null
  let requested = false
  const center = new THREE.Vector3()
  let runtime: PianoGodRaysRuntime | null = null
  let buildPending: { epoch: number } | null = null
  let epoch = 0
  let active = false
  let renderedFrames = 0
  let worldWarned = false
  /**
   * A build that threw is LATCHED, not retried.
   *
   * `updatePromotion()` reconciles every frame (see below), so without this a
   * failed dynamic import would be re-attempted 60 times a second forever —
   * `loadPianoGodRaysModule()` nulls its own memo on rejection precisely so a
   * later, deliberate retry can succeed. The latch clears on the next genuine
   * change of intent (entering/leaving the area, or toggling the tunable), which
   * is one retry per user action rather than one per frame.
   */
  let buildFailed = false

  // Chain-independent GPU ownership: allocated when the runtime lands, freed
  // when the player leaves. `allocTarget` would have parked an input-resolution
  // rgba16float (≈5 MB at 1512×982×0.667) in the pool for every player who never
  // walks into the grove, which is exactly what docs/LAZY_LOADING.md forbids.
  let target: THREE.RenderTarget | null = null
  let quad: StageQuad | null = null
  let quadBuilt = false
  let inputWidth = 1
  let inputHeight = 1

  const tunablesEnabled = () => GODRAYS_TUNING.values.enabled === true
  const wantsGodRays = () => Boolean(requested && tunablesEnabled() && sourceLight && scene)

  const ensureTarget = (width: number, height: number) => {
    inputWidth = Math.max(1, width)
    inputHeight = Math.max(1, height)
    if (!target) {
      target = new THREE.RenderTarget(inputWidth, inputHeight, {
        type: THREE.HalfFloatType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false
      })
      // Underscores only, for the same reason pianoGodRays.ts:112-118 documents.
      target.texture.name = "post_godrays_composite"
      return target
    }
    if (target.width !== inputWidth || target.height !== inputHeight) {
      target.setSize(inputWidth, inputHeight)
    }
    return target
  }

  const disposeRuntime = () => {
    active = false
    quad?.dispose()
    quad = null
    quadBuilt = false
    target?.dispose()
    target = null
    runtime?.dispose()
    runtime = null
  }

  /** A genuine change of intent. Invalidates any in-flight activation and gives
   *  the failure latch one more chance. */
  const bumpEpoch = () => {
    epoch += 1
    buildPending = null
    buildFailed = false
  }

  /**
   * PROMOTE, DEMOTE — **and reconcile**. Called from the frame driver every
   * presented frame (pipeline.ts:319), before anything opens a pass.
   *
   * `wantsGodRays()` is a conjunction of FOUR independent inputs: the area gate
   * (`requested`), the tunable, the scene and the sun. The runtime's existence
   * used to be edge-triggered off only three of them — `setArea()`,
   * `attachWorld()` and `applyFx()` were the only callers of `ensureRuntime()` —
   * while the fourth, `post.godrays.enabled`, has mutation lanes of its own that
   * are contractually forbidden from allocating anything: `chain.applyParams()`
   * (types.ts:180-183 — "MUST NOT recompile, reallocate, or reselect"),
   * `Object.assign(POST_TUNING.values, …)` from debugExposure.ts:245, the
   * tweaks-to-defaults reset at frameBody.ts:976, and the generic per-stage
   * panel that replaces the placeholder in debug.ts:989-1002. Flip the tunable
   * through any of those while the player is ALREADY standing in the grove and
   * the stage stayed dead forever: requested true, runtime null, nothing left to
   * build it.
   *
   * So the lifecycle is level-triggered here instead. The runtime's existence is
   * a FUNCTION of `wantsGodRays()`, not a residue of which call site last fired,
   * and no future control lane has to know to call anything.
   *
   * It costs nothing for the ~everyone who never enters the grove:
   * `wantsGodRays()` short-circuits on `requested`, which only `setArea(true)`
   * sets, so the lazy import boundary docs/LAZY_LOADING.md requires is untouched.
   */
  const updatePromotion = () => {
    if (!wantsGodRays()) {
      // Whichever input went false — the area gate, the tunable, a detached
      // world — the GPU ownership goes with it, on the same frame.
      if (runtime || buildPending || buildFailed) {
        bumpEpoch()
        disposeRuntime()
      }
      active = false
      return
    }
    if (!runtime) {
      if (!buildFailed) ensureRuntime()
      return
    }
    // The god-ray graph dereferences the dedicated light's shadow map at setup;
    // hold the raw beauty until the beauty pass has allocated it.
    active = runtime.shadowMapReady()
  }

  /** BUILD ONLY. `updatePromotion()` is the single gate — it has already
   *  established `wantsGodRays()` and that no runtime exists. */
  const ensureRuntime = () => {
    const requestEpoch = epoch
    if (buildPending?.epoch === requestEpoch) return
    buildPending = { epoch: requestEpoch }
    void loadPianoGodRaysModule()
      .then(({ createPianoGodRays }) => {
        if (epoch !== requestEpoch || !wantsGodRays() || !scene || !sourceLight) return
        disposeRuntime()
        runtime = createPianoGodRays({
          scene,
          camera,
          sceneColor: setup.gbuffer.colour,
          sceneDepth: setup.gbuffer.depth,
          sourceLight,
          center,
          params: getPianoGodRaysParams()
        }) as PianoGodRaysRuntime

        // See the header: NONE + an explicit drive, or this fires from inside
        // the copy quad's pass and takes the command buffer with it.
        runtime.sceneTexture.updateBeforeType = NodeUpdateType.NONE
        quad = createStageQuad("post_godrays")
        quad.setFragment(vec4(runtime.sceneTexture.sample(screenUV).rgb, 1.0))
        quadBuilt = false
        updatePromotion()
      })
      .catch((err) => {
        // Latch, or the per-frame reconcile above turns one failure into an
        // import storm.
        if (epoch === requestEpoch) buildFailed = true
        console.warn("[render] piano god rays unavailable:", err)
      })
      .finally(() => {
        if (buildPending?.epoch === requestEpoch) buildPending = null
      })
  }

  const setArea = (areaActive: boolean, areaCenter?: THREE.Vector3) => {
    if (areaCenter) center.copy(areaCenter)
    if (areaActive === requested) return
    requested = areaActive
    bumpEpoch()
    if (!areaActive) {
      disposeRuntime()
      return
    }
    if (!scene || !sourceLight) {
      // Loud, once. Silent god rays would look like a content bug in the grove
      // and send someone hunting through pianoGodRays.ts for a fault that is not
      // there.
      if (!worldWarned) {
        worldWarned = true
        console.error(
          "[render] piano god rays cannot build: pipeline.ts must call godRays.attachWorld(scene, directionalLight) once, next to godRaysControls(...)."
        )
      }
      return
    }
    updatePromotion()
  }

  const applyFx = () => {
    // A deliberate toggle is a change of intent: a build that failed under the
    // previous one gets exactly one more chance. Nothing else here — the
    // reconcile below decides whether that means build, tear down, or neither,
    // and it is the same decision the frame driver makes anyway. This lane only
    // still exists so the panel's response is immediate rather than next-frame.
    buildFailed = false
    runtime?.configure(getPianoGodRaysParams())
    updatePromotion()
  }

  return {
    id: "godrays",
    label: "pianist god rays",
    order: STAGE_ORDER.godrays,
    // Publishes the composite source the linear composite reads as its beauty.
    kind: "colour",
    resolution: "input",
    enabled: () => active && tunablesEnabled() && quad !== null,
    output: () => (active ? target?.texture ?? null : null),
    render: (frame: PostFrameContext) => {
      if (!runtime || !quad) return
      const destination = ensureTarget(frame.inputWidth, frame.inputHeight)

      // Shadow-light transform for THIS frame's centre. The kite re-issues a
      // moving centre every frame through setArea, which is why this is not a
      // build-time constant (main.ts:332-338).
      runtime.update(center)

      // Match the RTT to the chain's input resolution rather than the drawing
      // buffer: the composite consumes it at input res, so a full-res god-ray
      // composite would be fragment work thrown away by the very next sample.
      const scale = frame.outputWidth > 0 ? frame.inputWidth / frame.outputWidth : 1
      if (runtime.sceneTexture.getResolutionScale() !== scale) {
        runtime.sceneTexture.setResolutionScale(scale)
      }

      // First frame only: the copy quad's material has to be BUILT before the
      // RTT can be driven, because `RTTNode.setup()` is what assigns the node it
      // renders (RTTNode.js:290). This draw reads an empty target and is thrown
      // away; the second one below is the frame the player sees.
      if (!quadBuilt) {
        quad.render(frame.renderer, destination)
        quadBuilt = true
      }

      // Explicit, with no pass open. Everything nested inside — raymarch,
      // bilateral blur, depth-aware blend — runs here.
      runtime.sceneTexture.updateBefore({ renderer: frame.renderer })
      // The copy costs one input-res fullscreen pass (0.66 Mpx) and buys the
      // chain a target it owns the format, filter and lifetime of. Handing out
      // `sceneTexture.value` directly would save it, at the price of the chain's
      // colour being a texture allocated and disposed inside pianoGodRays.ts —
      // not worth it until it measures.
      quad.render(frame.renderer, destination)
      renderedFrames += 1
    },
    setSize: (frame: PostFrameContext) => {
      if (target) ensureTarget(frame.inputWidth, frame.inputHeight)
      else {
        inputWidth = Math.max(1, frame.inputWidth)
        inputHeight = Math.max(1, frame.inputHeight)
      }
    },
    // Nothing to warm at boot on purpose: the god-ray graph does not exist until
    // the grove gate opens, and compiling it here would defeat the lazy import
    // it is wrapped in. The compile happens on entry, exactly as it did when
    // this was a lazily built RenderPipeline variant.
    warmupQuads: (): THREE.QuadMesh[] => (quad ? [quad.mesh] : []),
    // Live controls only — applyParams must not reallocate (types.ts:180-183),
    // so `post.godrays.enabled` is deliberately NOT honoured here. It is honoured
    // by `updatePromotion()`, which the frame driver runs every frame with no
    // pass open; a value written through this lane therefore takes effect on the
    // next presented frame without this lane having to know that the tunable is
    // a lifecycle key rather than a uniform.
    applyParams: () => {
      runtime?.configure(getPianoGodRaysParams())
    },
    applyStructure: () => {
      // `resolution` resizes the raymarch target through GodraysNode.setSize on
      // its next update, so a configure() is the whole structural change.
      runtime?.configure(getPianoGodRaysParams())
    },
    tuning: { group: GODRAYS_TUNING, structuralKeys: ["resolution"], recompileKeys: [] },
    dispose: () => {
      requested = false
      bumpEpoch()
      disposeRuntime()
    },

    attachWorld: (worldScene: THREE.Scene, light: THREE.DirectionalLight | null) => {
      scene = worldScene
      sourceLight = light
      if (requested) updatePromotion()
    },
    setArea,
    applyFx,
    updatePromotion,
    state: (): GodRaysState => ({
      requested,
      active,
      loaded: runtime !== null,
      renderedFrames
    })
  }
}

/**
 * The frame driver's handle. Returns an inert set when the stage is missing or
 * still a stub, so pipeline.ts calls it unconditionally.
 */
export function godRaysControls(stage: PostStage | undefined): GodRaysControls {
  const candidate = stage as (PostStage & Partial<GodRaysControls>) | undefined
  if (!candidate || typeof candidate.setArea !== "function") {
    return {
      attachWorld: () => {},
      setArea: () => {},
      applyFx: () => {},
      updatePromotion: () => {},
      state: () => INERT_STATE
    }
  }
  return {
    attachWorld: candidate.attachWorld!.bind(candidate),
    setArea: candidate.setArea.bind(candidate),
    applyFx: candidate.applyFx!.bind(candidate),
    updatePromotion: candidate.updatePromotion!.bind(candidate),
    state: candidate.state!.bind(candidate)
  }
}
