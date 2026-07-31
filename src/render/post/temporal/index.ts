// U4 · Temporal resolve — build spec: .data/postfx/BRIEF.md §4.5
//
// The one stage that changes chain resolution: it consumes "input" (the beauty
// pass at `post.temporal.scale` of the drawing buffer) and produces "output".
// Everything downstream of it runs at drawing-buffer resolution, and the entire
// performance argument for the chain is that the beauty pass drops to 44% of the
// pixels at the default 0.667 while the presented image does not.
//
// The resolution wire itself lives OUTSIDE this folder, and already exists:
// `postInputScale()` (post/tuning.ts) reads `TEMPORAL_TUNING.values.scale` and
// the frame driver applies it with `scenePass.setResolutionScale()` before the
// beauty pass renders (pipeline.ts:234-238), invalidating the history whenever
// it moves. This stage therefore never touches the beauty pass; it only reports
// what it consumed.
//
// See vendor/taau.ts for the four upstream defects this unit exists to fix, one
// of which is a hard WebGPU error rather than an artefact.
import type * as THREE from "three/webgpu"
import { STAGE_ORDER } from "../order"
import { jitterOffsetAt } from "../jitter/sequence"
import type { PostFrameContext, PostStage, PostStageSetup } from "../types"
import { VELOCITY_TUNING } from "../velocity/tuning"
import { TEMPORAL_TUNING } from "./tuning"
import type { TemporalParams, TemporalResolve } from "./common"
import { TaauResolve } from "./vendor/taau"
import { TraaResolve } from "./vendor/traa"

export type TemporalMode = "taau" | "traa"

export type TemporalStage = PostStage & {
  /**
   * The beauty-pass scale this stage is prepared to consume, as a fraction of
   * the drawing buffer. `postInputScale()` composes the same artist value with
   * the governor; this is the stage-side statement of it, and the ONE place that
   * knows the TRAA fallback cannot upscale.
   */
  inputScale(): number
  mode(): TemporalMode
  /**
   * The velocity buffer holds this frame's motion. Pass false when the velocity
   * stage did not run — the reprojection then reads a stale buffer, which is
   * worse than not reprojecting at all. Costs a uniform write, never a rebuild.
   */
  setVelocityEnabled(enabled: boolean): void
}

function readMode(): TemporalMode {
  return String(TEMPORAL_TUNING.values.mode) === "traa" ? "traa" : "taau"
}

function readParams(): TemporalParams {
  const values = TEMPORAL_TUNING.values
  return {
    depthThreshold: Number(values.depthThreshold),
    edgeDepthDiff: Number(values.edgeDepthDiff),
    maxVelocityLength: Math.max(1, Number(values.maxVelocityLength)),
    currentFrameWeight: Number(values.currentFrameWeight),
    varianceGammaMin: Number(values.varianceGammaMin),
    varianceGammaMax: Number(values.varianceGammaMax)
  }
}

export function createTemporalStage(setup: PostStageSetup): TemporalStage {
  const { renderer, gbuffer, inputSlot } = setup
  const slot = inputSlot()

  // Captured ONCE. `gbuffer.velocity` is null when no velocity stage exists at
  // all, and that decision is baked into the graph (a constant zero offset)
  // because it cannot change without rebuilding the world's g-buffer anyway.
  // A velocity buffer that exists but is not being written this frame is the
  // other case, and that one is a uniform — see setVelocityEnabled.
  const velocityNode = gbuffer.velocity ?? null

  const buildResolve = (mode: TemporalMode): TemporalResolve => {
    const options = {
      renderer,
      camera: gbuffer.camera,
      beautyNode: slot.node,
      depthNode: gbuffer.depth,
      velocityNode
    }
    return mode === "traa" ? new TraaResolve(options) : new TaauResolve(options)
  }

  /** Manual override, latched; ANDed with the velocity stage's own toggle. */
  let velocityAllowed = velocityNode !== null
  const velocityLive = () =>
    velocityAllowed && velocityNode !== null && VELOCITY_TUNING.values.enabled === true

  let activeMode = readMode()
  let resolve = buildResolve(activeMode)
  resolve.setParams(readParams())
  resolve.setVelocityGain(velocityLive() ? 1 : 0)

  // Seed on the first frame, on every history invalidation, and whenever the
  // stage did not run on the immediately preceding presented frame. That last
  // one is the self-healing invariant: the node's "previous camera" and previous
  // depth only advance when render() runs, so any gap — the stage toggled off
  // and on, a resize, or a still capture that skipped frameIndex — would
  // otherwise reproject against a frame that is not the previous one. Cheaper
  // to detect here than to require every caller to remember. (H-key stills now
  // advance frameIndex across their accumulation, so they accumulate rather
  // than trip this seed-every-time path.)
  let pendingSeed = true
  let lastRenderedFrame = -1

  const stage: TemporalStage = {
    id: "temporal",
    label: "temporal resolve",
    order: STAGE_ORDER.temporal,
    kind: "colour",
    // Always reported as "output": TAAU genuinely produces drawing-buffer
    // resolution, and the TRAA fallback resolves at output resolution too (it
    // just upscales bilinearly on the way in — vendor/traa.ts deviation 4).
    resolution: "output",
    enabled: () => TEMPORAL_TUNING.values.enabled === true,
    output: () => resolve.outputTexture(),

    render: (frame: PostFrameContext) => {
      const offset = jitterOffsetAt(frame.frameIndex, frame.inputWidth, frame.outputWidth)

      const seed = frame.historyInvalid || pendingSeed || frame.frameIndex !== lastRenderedFrame + 1
      pendingSeed = false
      lastRenderedFrame = frame.frameIndex

      // A velocity buffer that nobody rendered this frame still holds the LAST
      // frame it was written on, and reprojecting against stale motion is worse
      // than not reprojecting: it confidently fetches the wrong history. This is
      // the same condition `velocityOf()` (velocity/index.ts:161-171) guards, read
      // from the tunable because a stage cannot reach a sibling stage instance.
      // A uniform write per frame, never a rebuild.
      resolve.setVelocityGain(velocityLive() ? 1 : 0)

      // The resolve reads the INPUT size from the bound texture itself
      // (`textureSize`), not from the frame context, so a one-frame disagreement
      // between the two — which is exactly what the WebGPU resize timing bug
      // produces — cannot misplace a single tap.
      resolve.render(frame.renderer, {
        outputWidth: frame.outputWidth,
        outputHeight: frame.outputHeight,
        // The SAME pure function of the SAME presented-frame counter the jitter
        // stage used to offset the projection before the beauty pass. No shared
        // mutable state, so the reconstruction weights cannot disagree with where
        // the samples actually landed.
        jitterX: offset.x,
        jitterY: offset.y,
        seed
      })
    },

    // The resolve sizes its own history from the frame context (it has to: the
    // seed has to happen on the same call that reallocates). Chain-owned targets
    // could not express these anyway — they carry a depth attachment and they
    // ping-pong.
    setSize: () => {},

    invalidateHistory: () => {
      pendingSeed = true
    },

    warmupQuads: (): THREE.QuadMesh[] => resolve.quads(),

    applyParams: () => {
      resolve.setParams(readParams())
    },

    applyStructure: () => {
      const wanted = readMode()
      if (wanted === activeMode) {
        resolve.setParams(readParams())
        return
      }
      // Switching the fallback on is a debug/verification action, not a live
      // toggle: it disposes one resolve's history pair and allocates another's,
      // which is a reallocation on a presented frame. That is why `mode` is a
      // structural key gated on Apply.
      //
      // It USED to be justified by "the incoming resolve's quads were never
      // handed to compileFullscreenQuads, so the first frame after the switch
      // compiles them inline". That reason is gone: `applyPostStructure()`
      // (pipeline.ts) calls `warmChainQuads` AFTER `applyStructure()`, and
      // `chain.warmupGroups()` re-reads `resolve.quads()` — so by the time the
      // Apply resolves, the new mode's quads are warm. The gate stays for the
      // realloc alone.
      resolve.dispose()
      activeMode = wanted
      resolve = buildResolve(activeMode)
      resolve.setParams(readParams())
      resolve.setVelocityGain(velocityLive() ? 1 : 0)
      pendingSeed = true
    },

    tuning: {
      group: TEMPORAL_TUNING,
      // `scale` reallocates every chain target through postInputScale(); `mode`
      // rebuilds this stage's graph. Neither is a recompile of a stage that is
      // enabled by default in its default configuration, so recompileKeys is
      // empty, as the invariant requires.
      structuralKeys: ["scale", "mode"],
      recompileKeys: []
    },

    dispose: () => resolve.dispose(),

    inputScale: () => {
      // TRAA has no reconstruction filter: it resolves one input sample per
      // output pixel, so upscaling through it would just be a blurrier frame.
      if (activeMode === "traa") return 1
      const scale = Number(TEMPORAL_TUNING.values.scale)
      return Number.isFinite(scale) ? Math.min(1, Math.max(0.4, scale)) : 1
    },

    mode: () => activeMode,

    setVelocityEnabled: (enabled: boolean) => {
      velocityAllowed = enabled
      resolve.setVelocityGain(velocityLive() ? 1 : 0)
    }
  }

  return stage
}
