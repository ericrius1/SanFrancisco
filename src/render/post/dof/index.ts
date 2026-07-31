// U5 · DOF + bloom — build spec: .data/postfx/BRIEF.md §4.6
//
// OFF BY DEFAULT, and that is the design rather than an oversight. Nine
// fullscreen passes — CoC, two for the CoC gaussian, the CoC downsample, then
// blur64/blur16 for each of the near and far fields, then the composite — plus
// one more pixel for autofocus, and ~160 taps per output pixel at the default
// half-res blur chain. That makes this the most expensive stage in the chain,
// and restrained depth of field at play FOV is very nearly invisible: you pay
// ~2 ms every frame for something the player cannot see. It exists for
// cinematics and photo mode, where the camera is doing something deliberate
// with focus.
//
// OFF BY DEFAULT ALSO MEANS ABSENT AT BOOT — see `ensureBuilt` below. It did
// not, and that was a live AGENTS.md "massive-app loading policy" regression:
// `createDofStage` built `DofPass` unconditionally at chain construction (6
// render targets, the nested gaussian's 2 more, 5 NodeMaterials) and then handed
// SEVEN quads — including a `Loop(64)` Vogel gather and a `Loop(16)` max filter —
// to the boot compile, inside the exclusive window that holds presented frames,
// for a stage that ships off. "Constructing an object … must not fetch that
// feature's optional images, audio, models, shaders, or code chunks" is the
// policy verbatim, and this stage's own header says it exists for cinematics.
// `post/godrays/index.ts` is the precedent that got this right.
//
// Compounding it, three of the warmed quads draw into RedFormat targets
// (vendor/gaussianBlur.ts, `dof_coc_blurred`) while `chain.warmupGroups()` warms
// a stage with no POOLED targets against the rgba16float scratch — so the boot
// compile did not even produce the pipelines they use. That residue is gone with
// the boot compile itself; the Apply lane warms what is actually built.
//
// Reversed depth: nothing to do here. This stage never touches raw depth; it
// consumes a viewZ built with `perspectiveDepthToViewZ`, which IS reversed-aware
// (ViewportDepthNode.js:229) — the same route `PassNode.getViewZNode()` takes
// (PassNode.js:695-706). Do not add an `oneMinus()`, and do not convert back
// from viewZ to depth: those helpers are NOT reversed-aware
// (ViewportDepthNode.js:203, :153). See shared/reversedDepth.ts.
import * as THREE from "three/webgpu"
import { Fn, perspectiveDepthToViewZ, uniform, uv, vec2, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup } from "../types"
import { DOF_TUNING } from "./tuning"
import { DofPass } from "./vendor/dof"

/**
 * Autofocus easing time constant, seconds to ~63% of the way there. A real lens
 * hunts; a hard cut between focus distances reads as a glitch, and anything
 * slower than about a third of a second reads as a slow camera rather than a
 * focus pull. Frame-rate independent (`1 - exp(-dt / TAU)`), so it survives the
 * 120 Hz / 30 Hz spread this project actually runs at.
 */
const AUTOFOCUS_TAU_S = 0.22

/** The probe is clamped into the tunable's own range before it eases. */
const FOCUS_MIN_M = 0.5
const FOCUS_MAX_M = 500

/** Minimal structural typing for the r185 readback — @types/three has it on
 *  Renderer, but narrowing here keeps the cast honest about what is used. */
type PixelReader = {
  readRenderTargetPixelsAsync(
    target: THREE.RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<ArrayLike<number>>
}

export function createDofStage(setup: PostStageSetup): PostStage {
  const { gbuffer, inputSlot } = setup
  const slot = inputSlot()
  const values = DOF_TUNING.values

  const U = {
    focusDistance: uniform(values.focusDistance) as N,
    focalLength: uniform(values.focalLength) as N,
    bokehScale: uniform(values.bokehScale) as N
  }

  // View-space Z from the g-buffer's raw depth. `gbuffer.depth` is at INPUT
  // resolution while this stage runs at OUTPUT resolution, so every tap is a
  // read of a lower-resolution buffer. Deliberate: the circle of confusion is a
  // low-frequency field and the CoC output is dilated by a gaussian one pass
  // later anyway. Do NOT add a depth upsample pass for this.
  const viewZAt = (uvNode: N): N =>
    perspectiveDepthToViewZ(
      gbuffer.depth.sample(uvNode).r,
      gbuffer.cameraNear,
      gbuffer.cameraFar
    )

  // The eased focus survives a demote/rebuild on purpose — it is CPU state worth
  // a few bytes, and re-entering DOF at the distance you left it is what a
  // photo-mode toggle should feel like. `snapNextFrame` is re-armed by `build()`
  // so the first frame after a rebuild lands rather than eases.
  let focusDistance = Number(values.focusDistance)
  let focusTarget = focusDistance
  let readbackInFlight = false
  let snapNextFrame = true

  // ------------------------------------------------------- the lazy boundary
  //
  // Nothing below exists until the stage is actually asked to run. Two entry
  // points, and the difference between them is which lane pays for the compile:
  //
  //  - `applyStructure()` — the GOOD one, and the reason `enabled` is declared a
  //    structural key. The panel routes the checkbox through the chain's
  //    structure lane, which builds here and THEN re-warms via `warmChainQuads`
  //    inside an exclusive compile window, so frames are held rather than
  //    hitched.
  //  - `enabled()` — the safety net, for anything that writes the tunable
  //    directly and only calls `applyParams()` (a probe, a cinematic, the
  //    tweaks-to-defaults reset). It builds and the first DOF frame compiles
  //    inline: one hitch on enable, which is exactly the trade this file's old
  //    warmup note already sanctioned.
  //
  // It never DEMOTES from `enabled()`. That hook runs inside `chain.render()`'s
  // stage loop, and disposing eight render targets from there is a class of
  // thing this chain deliberately keeps out of the frame. Teardown is
  // `applyStructure()` (the deliberate lane, no pass open, followed by a re-warm)
  // and `dispose()`.
  type Built = {
    readonly pass: DofPass
    readonly probeTarget: THREE.RenderTarget
    readonly probeQuad: ReturnType<typeof createStageQuad>
  }
  let built: Built | null = null

  const build = (): Built => {
    const pass = new DofPass({
      source: slot.node,
      viewZ: viewZAt(uv()),
      focusDistance: U.focusDistance,
      focalLength: U.focalLength,
      bokehScale: U.bokehScale
    })
    pass.setResolutionScale(Number(DOF_TUNING.values.resolution))

    // ----------------------------------------------------------- autofocus
    //
    // One texel, written by a fullscreen quad, read back to JS asynchronously.
    //
    // Why not sample the centre depth inside the CoC shader: because focus has to
    // be EASED, and easing needs state that persists between frames. Doing that on
    // the GPU means a 1x1 ping-pong pair and a value JS can never see; doing it on
    // the CPU costs one extra one-pixel pass and gives cinematics and the debug
    // panel a focus distance they can read, log and override. The brief asked for
    // the CPU form for exactly that reason.
    //
    // The readback is one frame or two behind — `copyTextureToBuffer` submits its
    // own encoder and awaits `mapAsync` (WebGPUTextureUtils.js:748-801). At a
    // 0.22 s time constant that latency is a rounding error, and only one read is
    // ever in flight, so a slow map cannot queue up buffers.
    //
    // NOT ALLOCATED FROM THE CHAIN POOL: `TargetSpec` sizes are fractions of the
    // input or output size and this target is 1x1 forever. r32float so the
    // readback lands as a Float32Array with no half-float decode
    // (WebGPUTextureUtils.js:1625-1646 for the format, :1311-1352 for the type).
    const probeTarget = new THREE.RenderTarget(1, 1, {
      format: THREE.RedFormat,
      type: THREE.FloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false
    })
    probeTarget.texture.name = "dof_focus_probe"

    const probeQuad = createStageQuad("dof_focus_probe")
    probeQuad.setFragment(
      Fn(() => {
        // Distance, not viewZ: viewZ is negative in front of the camera. Under
        // reversed depth the sky reads 0.0, which `perspectiveDepthToViewZ`
        // resolves to -far, so an empty centre of frame focuses at the far plane
        // and the clamp below pulls it back to something usable.
        return vec4(viewZAt(vec2(0.5, 0.5)).negate(), 0, 0, 1)
      })()
    )

    // A newly built pass has no eased focus and no history. Snap on the first
    // frame rather than racking in from whatever the slider happened to say.
    snapNextFrame = true
    return { pass, probeTarget, probeQuad }
  }

  /** Build on demand. Idempotent, and the ONLY place `built` becomes non-null. */
  const ensureBuilt = (): Built => {
    if (built === null) built = build()
    return built
  }

  /** Free every GPU resource this stage owns and return to the boot state. */
  const demote = () => {
    if (built === null) return
    built.pass.dispose()
    built.probeQuad.dispose()
    built.probeTarget.dispose()
    built = null
  }

  const clampFocus = (metres: number) =>
    Math.min(FOCUS_MAX_M, Math.max(FOCUS_MIN_M, metres))

  const requestProbe = (renderer: THREE.WebGPURenderer, live: Built) => {
    const { probeQuad, probeTarget } = live
    probeQuad.render(renderer, probeTarget)
    if (readbackInFlight) return
    readbackInFlight = true
    void (renderer as unknown as PixelReader)
      .readRenderTargetPixelsAsync(probeTarget, 0, 0, 1, 1)
      .then((pixels) => {
        const metres = pixels[0]
        // NaN/Inf guard: a depth attachment that has not been written yet, or a
        // device-lost frame, must not poison the eased value permanently.
        if (Number.isFinite(metres)) focusTarget = clampFocus(metres)
      })
      .catch(() => {
        // Readback can reject on device loss or a disposed target. Keeping the
        // last focus is the right failure — DOF stays where it was.
      })
      .finally(() => {
        readbackInFlight = false
      })
  }

  const updateFocus = (frame: PostFrameContext, live: Built) => {
    if (DOF_TUNING.values.autofocus !== true) {
      // Manual focus is authoritative the moment autofocus is switched off, and
      // re-enabling snaps rather than easing from a stale value.
      focusDistance = clampFocus(Number(DOF_TUNING.values.focusDistance))
      focusTarget = focusDistance
      snapNextFrame = true
      U.focusDistance.value = focusDistance
      return
    }

    requestProbe(frame.renderer, live)

    if (snapNextFrame || frame.historyInvalid) {
      // A teleport, a resize or the first enabled frame. Easing across a cut is
      // a rack focus nobody asked for.
      focusDistance = focusTarget
      snapNextFrame = false
    } else {
      const alpha = 1 - Math.exp(-Math.max(0, frame.dt) / AUTOFOCUS_TAU_S)
      focusDistance += (focusTarget - focusDistance) * alpha
    }
    U.focusDistance.value = focusDistance
  }

  const applyParams = () => {
    const v = DOF_TUNING.values
    U.focalLength.value = Number(v.focalLength)
    U.bokehScale.value = Number(v.bokehScale)
    // focusDistance is owned by updateFocus() — with autofocus off it reads the
    // slider every frame, and with it on the slider is not the source of truth.
    if (v.autofocus !== true) U.focusDistance.value = clampFocus(Number(v.focusDistance))
  }
  applyParams()

  return {
    id: "dof",
    label: "depth of field",
    order: STAGE_ORDER.dof,
    kind: "colour",
    resolution: "output",
    // Level-triggered, and the build is the safety net described above. The
    // chain calls this every frame whatever the answer is, which is what makes
    // it a legitimate place to reconcile — the same hook SSAO and SSR already
    // use to push their neutral uniforms.
    enabled: () => {
      if (DOF_TUNING.values.enabled !== true) return false
      ensureBuilt()
      return true
    },
    output: () => built?.pass.texture ?? null,
    render: (frame: PostFrameContext) => {
      const live = ensureBuilt()
      updateFocus(frame, live)
      live.pass.render(frame.renderer)
    },
    // The fork owns its six targets plus the nested gaussian's two; their sizes
    // are relative to each other rather than to a chain resolution class, so
    // this stage does its own sizing. The 1x1 probe never resizes.
    setSize: (frame: PostFrameContext) => {
      // Only when built. The chain sizes a stage on its first ENABLED frame, so
      // in practice this always follows an `enabled()` that built — but sizing
      // must never be the thing that allocates 8 targets for a stage nobody
      // turned on.
      built?.pass.setSize(frame.outputWidth, frame.outputHeight)
    },
    invalidateHistory: () => {
      // The only history here is the eased focus. Snapping it on a teleport is
      // the same contract every temporal stage in the chain follows.
      snapNextFrame = true
    },
    // EMPTY UNTIL BUILT — the whole point of the lazy boundary. Once DOF is on,
    // its quads are real and the structure lane warms them properly, which is
    // strictly better than the boot compile this replaces: they are warmed after
    // the pass exists, in the exclusive window, with frames held.
    //
    // `pass.quads()` already omits the one material that is unsafe to compile
    // outside a render — see vendor/dof.ts. Three of the quads it DOES return
    // draw into RedFormat targets (vendor/gaussianBlur.ts's pair and
    // `dof_coc_blurred`), and this stage allocates nothing from the chain pool,
    // so `chain.warmupGroups()` warms them against the rgba16float scratch and
    // those three still build their real pipeline on first draw. Fixing that
    // properly is a `PostStage` change (quads WITH their targets); it is one
    // hitch on the first DOF frame, and it is now paid only by someone who
    // turned DOF on.
    warmupQuads: () => (built ? [...built.pass.quads(), built.probeQuad.mesh] : []),
    applyParams,
    applyStructure: () => {
      // THE DELIBERATE LANE. `enabled` is a structural key (below), so the panel
      // checkbox lands here — build or demote — and `applyPostStructure()`
      // re-warms immediately afterwards inside an exclusive compile window.
      if (DOF_TUNING.values.enabled !== true) {
        demote()
        return
      }
      // The chain marks sizes dirty after applyStructure(), so the reallocation
      // lands in the next setSize() rather than here.
      ensureBuilt().pass.setResolutionScale(Number(DOF_TUNING.values.resolution))
    },
    tuning: {
      group: DOF_TUNING,
      // `enabled` is structural HERE and nowhere else in the chain, because it
      // is the only stage whose toggle allocates: every other stage keeps its
      // targets and its compiled quads across a toggle, so theirs is a live key
      // that costs nothing. Declaring it here is what routes the checkbox
      // through build/re-warm instead of leaving the first DOF frame to compile
      // seven quads inline.
      structuralKeys: ["enabled", "resolution"],
      // Empty, as it must be for every stage — `resolution` only resizes
      // targets, and every other knob is a uniform. (types.ts only requires this
      // of default-enabled stages; there is no reason for DOF to be the
      // exception.)
      recompileKeys: []
    },
    dispose: demote
  }
}
