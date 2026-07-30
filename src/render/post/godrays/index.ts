// U7 · Composite + survivors + god rays — build spec: .data/postfx/BRIEF.md §7
//
// STUB. See velocity/index.ts for what "stub" means here.
//
// SURVIVOR ADAPTER, not a rewrite. `src/render/pianoGodRays.ts` stays untouched;
// this folder owns the lazy import, the epoch guard, setPianoGodRaysArea,
// applyPianoGodRaysFx, the shadowMapReady() promote/demote gate and
// disposePianoGodRaysRuntime — all of which move here intact from the old
// pipeline.ts:285-430, :1000-1013. The 16-entry `pianoGodRaysVariants` map dies
// with them: there are no style masks and no bloom families left to cross with,
// so there is exactly one composite source to swap.
//
// The controls below stay wired to pipeline.ts through `godRaysControls()` even
// while this is a stub, because main.ts:renderFrame calls setPianoGodRaysArea()
// every single frame and must not have to know whether U7 has landed.
//
// Fix while adapting (a LIVE bug today, independent of this rebuild):
// `depthAwareBlend`'s edge protection is silently inert under reversed depth.
// depthAwareBlend.js:31 uses the non-reversed viewZToOrthographicDepth, which
// produces a negative `correctDepth`, so `abs(diff) < 0.05 * correctDepth` is
// never true, `count` stays 0 and `pushDir` is always zero.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import type { PostStage, PostStageSetup } from "../types"
import { GODRAYS_TUNING } from "./tuning"

export type GodRaysState = {
  requested: boolean
  active: boolean
  loaded: boolean
  renderedFrames: number
}

export type GodRaysControls = {
  /** Enter/leave the only area allowed to allocate and render god rays. */
  setArea(active: boolean, center?: THREE.Vector3): void
  /** Push controls without touching anything else in the chain. */
  applyFx(): void
  /** Promote once the dedicated light's shadow map exists, demote if it retires.
   *  Called from the frame driver BEFORE anything opens a pass. */
  updatePromotion(): void
  state(): GodRaysState
}

/**
 * THE LAZY BOUNDARY. `src/render/pianoGodRays.ts` pulls in three's official
 * raymarched GodraysNode stack, a dedicated shadow light and its own render
 * targets — none of which may exist until the player actually enters the grove
 * gate, and all of which are disposed on leaving.
 *
 * It lives here, exported, from Wave 0 onward specifically so the boundary never
 * disappears from the source tree between units:
 * tools/mission-dolores-contract-test.mjs asserts on its literal text, and a
 * contract that goes red for a whole wave teaches everyone to ignore it.
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

export function createGodRaysStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "godrays",
    label: "pianist god rays",
    order: STAGE_ORDER.godrays,
    kind: "aux",
    resolution: "input",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: GODRAYS_TUNING, structuralKeys: ["resolution"], recompileKeys: [] },
    dispose: () => {}
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
      setArea: () => {},
      applyFx: () => {},
      updatePromotion: () => {},
      state: () => INERT_STATE
    }
  }
  return {
    setArea: candidate.setArea.bind(candidate),
    applyFx: candidate.applyFx!.bind(candidate),
    updatePromotion: candidate.updatePromotion!.bind(candidate),
    state: candidate.state!.bind(candidate)
  }
}
