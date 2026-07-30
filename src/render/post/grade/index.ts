// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.8
//
// THIN ADAPTER over src/render/grade.ts, which is already better than
// Lut3DNode and stays exactly where it is. This folder owns nothing but the
// wiring: it creates the ONE GradeRuntime the chain hands out as `chain.grade`,
// and it hands the display tail the TSL seam.
//
// What U6 adds here: the `agx` / `agxPunch` looks live in render/gradeLooks.ts
// (so tools/grade-probe.mjs, tools/calibration-probe.mjs and
// tools/grade-compare-probe.mjs predict them without knowing this folder
// exists), and this file owns only the LIVE CDL knobs from ./tuning and the
// bake scheduling they need.
//
// The one thing that will silently ruin AgX: `mul3` in gradeLooks.ts is
// ROW-major (documented at :278-283) while three writes the AgX matrices as
// mat3(vec3, vec3, vec3) in ToneMappingFunctions.js:144-145, :169-170, which is
// a COLUMN constructor. Every array there is that file's TRANSPOSE, and
// `agxWhitePreservationError()` re-checks the row sums numerically so a probe
// can assert it. A missing or transposed AGX_OUTSET moves mid-grey by 0.0 CV and
// only shows up as chroma loss (16.5% -> 13.2% on the sun surround) — i.e. it
// looks entirely reasonable.
//
// `goldenState` stays the default. Measured this session with the shipped
// arithmetic: AgX holds 16.5% chroma on the sun surround against goldenState's
// 50.5%. AgX beats ACES everywhere warm, but shipping it as the default would
// partially reinstate the exact failure gradeLooks.ts:17-34 documents as the
// reason ACES was dropped.
import type * as THREE from "three/webgpu"
import { createGrade, type GradeRuntime } from "../../grade"
import { AGX_NEUTRAL, findLook, type GradeLook } from "../../gradeLooks"
import { STAGE_ORDER } from "../order"
import type { N, PostStage } from "../types"
import { POST_GRADE_TUNING } from "./tuning"

export type GradeAdapter = {
  /** Handed out raw as `chain.grade` / `pipeline.grade`. A look change swaps the
   *  LUT's CONTENTS — same texture object, same bind group, no recompile. That
   *  is why it is exposed directly rather than fronted by an applyX() call. */
  readonly runtime: GradeRuntime
  /** THE SEAM. Scene-linear HDR above, display-referred sRGB below. */
  toDisplay(linear: N): N
  readonly stage: PostStage
  dispose(): void
}

/**
 * Edge length for the bake that runs WHILE a slider is moving. 16³ is 4,096
 * evaluations against 48³'s 110,592: ~6 ms rather than the measured 147.9 ms an
 * AgX bake costs at full size. Coarse, but the half-texel correction follows the
 * size, so the preview is blurry in the LUT sense and not SHIFTED — which is
 * what makes it usable for judging a knob rather than merely cheap.
 */
const PREVIEW_LUT_SIZE = 16

/**
 * How long after the last change to promote the preview to the shipped size.
 * Tweakpane does not hand this file a `last` flag — `applyParams()` is a bare
 * "values changed" callback — so the settle is detected here rather than
 * assumed. 180 ms is longer than the gap between two pointer-move events and
 * shorter than a deliberate pause, which is the whole requirement.
 */
const SETTLE_MS = 180

export function createGradeAdapter(): GradeAdapter {
  // ONE instance for the whole renderer. There is exactly one RenderPipeline now,
  // so the "shared by eight cached variants" reasoning from postfx.ts:259-262 is
  // moot — but the instance is still single because the LUT is a GPU resource and
  // a second one would be a second 48³ bake for no image difference.
  const runtime = createGrade()

  /** The last patch we actually applied, as its cache key. */
  let appliedKey = ""
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  /** Copy the active look's authored CDL into the panel values, so switching
   *  the live editor on is an image no-op rather than a jump to somebody else's
   *  numbers. Called on the false -> true edge only. */
  const seedKnobsFrom = (look: GradeLook) => {
    const a = look.agx ?? AGX_NEUTRAL
    const v = POST_GRADE_TUNING.values
    v.agxSlopeR = a.slope[0]
    v.agxSlopeG = a.slope[1]
    v.agxSlopeB = a.slope[2]
    v.agxOffset = a.offset
    v.agxPower = a.power[1]
    v.agxSaturation = look.saturation
    v.agxMinEv = a.minEv
    v.agxMaxEv = a.maxEv
  }

  /**
   * Build the live overlay from the panel values.
   *
   * Returns null — meaning "render the look exactly as authored" — unless the
   * live editor is on AND the active look is actually AgX. On every other look
   * these knobs are inert, and re-baking `goldenState` because someone nudged an
   * AgX slider would be a 54 ms hitch with no visible effect.
   *
   * `offsetStops` is deliberately NOT a knob and is carried through untouched:
   * it is the solved exposure anchor, and a look selector whose options differ
   * in brightness is a look selector nobody can use.
   */
  const buildPatch = (look: GradeLook): Partial<GradeLook> | null => {
    if (look.curve !== "agx" || POST_GRADE_TUNING.values.agxLive !== true) return null
    const v = POST_GRADE_TUNING.values
    return {
      saturation: v.agxSaturation,
      agx: {
        slope: [v.agxSlopeR, v.agxSlopeG, v.agxSlopeB],
        offset: v.agxOffset,
        power: [v.agxPower, v.agxPower, v.agxPower],
        minEv: v.agxMinEv,
        maxEv: v.agxMaxEv
      }
    }
  }

  /**
   * THE ENTRY POINT FOR LIVE AgX KNOBS. `runtime.setLook` early-returns on an
   * unchanged id, so without `runtime.refresh()` these values could never reach
   * the LUT at all.
   *
   * Two protections, both mandatory rather than nice-to-have (brief risk 10):
   * the no-op guard, because `chain.applyParams()` fans out to EVERY stage and
   * an unrelated bloom slider must not trigger a 148 ms bake; and the
   * preview-then-settle schedule, because a bake is main-thread arithmetic and
   * one per pointer-move is a frozen panel.
   */
  let liveWasOn = POST_GRADE_TUNING.values.agxLive === true

  const applyAgxKnobs = () => {
    const look = findLook(runtime.activeLookId())
    const liveIsOn = POST_GRADE_TUNING.values.agxLive === true
    if (liveIsOn && !liveWasOn) seedKnobsFrom(look)
    liveWasOn = liveIsOn
    const patch = buildPatch(look)
    const key = patch ? JSON.stringify(patch) : ""
    if (key === appliedKey) return
    appliedKey = key

    runtime.setLookPatch(patch)
    if (settleTimer !== null) clearTimeout(settleTimer)
    if (patch === null) {
      // Leaving AgX: no preview stage, just restore the shipped size once.
      runtime.refresh()
      settleTimer = null
      return
    }
    runtime.refresh(PREVIEW_LUT_SIZE)
    settleTimer = setTimeout(() => {
      settleTimer = null
      runtime.refresh()
    }, SETTLE_MS)
  }

  const stage: PostStage = {
    id: "grade",
    label: "display grade",
    order: STAGE_ORDER.grade,
    // Display-referred and cheap, so it is fused into the display tail's single
    // fragment shader rather than paying an RGBA8 round trip of its own.
    kind: "inline",
    resolution: "output",
    // No pass, so nothing for the driver to call. See the grain stage's note:
    // in this chain `enabled()` means "call render()", not "is it doing
    // anything", and the display transform is never optional anyway.
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: applyAgxKnobs,
    tuning: { group: POST_GRADE_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }

  return {
    runtime,
    toDisplay: (linear: N) => runtime.toDisplay(linear),
    stage,
    dispose: () => {
      if (settleTimer !== null) clearTimeout(settleTimer)
      settleTimer = null
      runtime.dispose()
    }
  }
}
