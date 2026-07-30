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

  const pass = new DofPass({
    source: slot.node,
    viewZ: viewZAt(uv()),
    focusDistance: U.focusDistance,
    focalLength: U.focalLength,
    bokehScale: U.bokehScale
  })
  pass.setResolutionScale(values.resolution)

  // ------------------------------------------------------------- autofocus
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

  let focusDistance = Number(values.focusDistance)
  let focusTarget = focusDistance
  let readbackInFlight = false
  let snapNextFrame = true

  const clampFocus = (metres: number) =>
    Math.min(FOCUS_MAX_M, Math.max(FOCUS_MIN_M, metres))

  const requestProbe = (renderer: THREE.WebGPURenderer) => {
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

  const updateFocus = (frame: PostFrameContext) => {
    if (DOF_TUNING.values.autofocus !== true) {
      // Manual focus is authoritative the moment autofocus is switched off, and
      // re-enabling snaps rather than easing from a stale value.
      focusDistance = clampFocus(Number(DOF_TUNING.values.focusDistance))
      focusTarget = focusDistance
      snapNextFrame = true
      U.focusDistance.value = focusDistance
      return
    }

    requestProbe(frame.renderer)

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
    enabled: () => DOF_TUNING.values.enabled === true,
    output: () => pass.texture,
    render: (frame: PostFrameContext) => {
      updateFocus(frame)
      pass.render(frame.renderer)
    },
    // The fork owns its six targets plus the nested gaussian's two; their sizes
    // are relative to each other rather than to a chain resolution class, so
    // this stage does its own sizing. The 1x1 probe never resizes.
    setSize: (frame: PostFrameContext) => {
      pass.setSize(frame.outputWidth, frame.outputHeight)
    },
    invalidateHistory: () => {
      // The only history here is the eased focus. Snapping it on a teleport is
      // the same contract every temporal stage in the chain follows.
      snapNextFrame = true
    },
    // Six materials compiled at boot for a stage that ships off. That is the
    // chain's contract — `warmupQuads` exists so no toggle can open a codegen
    // window on a presented frame, and enabling DOF from the panel or a
    // cinematic is exactly such a toggle. If boot compile time turns out to
    // matter more than a one-frame hitch on enable, this becomes `() => []` and
    // nothing else changes. `pass.quads()` already omits the one material that
    // is unsafe to compile here at all — see vendor/dof.ts.
    warmupQuads: () => [...pass.quads(), probeQuad.mesh],
    applyParams,
    applyStructure: () => {
      // The chain marks sizes dirty after applyStructure(), so the reallocation
      // lands in the next setSize() rather than here.
      pass.setResolutionScale(Number(DOF_TUNING.values.resolution))
    },
    tuning: {
      group: DOF_TUNING,
      structuralKeys: ["resolution"],
      // Empty, as it must be for every stage — `resolution` only resizes
      // targets, and every other knob is a uniform. (types.ts:125-128 only
      // requires this of default-enabled stages; there is no reason for DOF to
      // be the exception, and a rebuild-on-toggle would hitch the first frame of
      // every cinematic.)
      recompileKeys: []
    },
    dispose: () => {
      pass.dispose()
      probeQuad.dispose()
      probeTarget.dispose()
    }
  }
}
