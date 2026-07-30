// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.9
//
// TSL only — no render target, no PostStage pass.
//
// Write our own; stock FilmNode is a 20-line demo, not grain. FilmNode.js:69 is
// `base.add(base.mul(clamp(noise.add(0.1), 0, 1)))`, so its output is always
// between 1.0x and 2.1x the input — it CANNOT darken a pixel, and the +0.1 bias
// is a flat exposure lift disguised as grain. Anyone who "tunes" it is fighting
// a brightness shift they cannot remove.
//
// The replacement is zero-mean, luminance-responsive, resolution-independent and
// channel-decorrelated, using shared/noise.ts `hash23` — pure arithmetic, not
// mx_noise. Two defences against the branch-corruption hazard postfx.ts:44-51
// records: (1) the hash is arithmetic; (2) grain is applied UNCONDITIONALLY with
// a zeroed-strength identity, never gated by an If(). Do not "optimise" that.
//
// The seed advances by frameIndex, not by `time`: `time` degrades in float
// precision over long sessions and carries boot wall-clock in.
import type * as THREE from "three/webgpu"
import { float, mix, uniform, vec3 } from "three/tsl"
import { hash23 } from "../shared/noise"
import { STAGE_ORDER } from "../order"
import type { N, PostStage, PostStageSetup } from "../types"
import { GRAIN_TUNING } from "./tuning"

/**
 * Rec.709 luminance, spelled out rather than imported from three's `luminance`
 * node: that one reads the renderer's working colour space, and by this point in
 * the tail the value is display-referred sRGB, not scene-linear. Asking a
 * linear-space helper what a gamma-encoded pixel's luminance is gives an answer
 * that is wrong in exactly the shadows where grain response matters most.
 */
const displayLuma = (c: N): N => c.r.mul(0.2126).add(c.g.mul(0.7152)).add(c.b.mul(0.0722))

const U = {
  strength: uniform(0),
  size: uniform(1.35),
  response: uniform(0.85),
  falloff: uniform(1),
  chroma: uniform(0.35),
  /** Advances one per PRESENTED frame. See advanceGrain. */
  seed: uniform(0)
}

/**
 * Push the persisted values into the live uniforms. Every one of these is a
 * uniform-buffer write; none of them can recompile anything, which is what lets
 * the whole grain package live in the default graph with no variant.
 */
export function applyGrainParams(): void {
  const v = GRAIN_TUNING.values
  U.strength.value = v.strength
  U.size.value = Math.max(0.01, v.size)
  U.response.value = v.response
  U.falloff.value = v.falloff
  U.chroma.value = v.chroma
}

/**
 * Advance the lattice seed. Called once per presented frame by the display tail.
 *
 * frameIndex, never elapsed time. Two reasons, both recorded elsewhere in this
 * repo: a float32 uniform carrying seconds loses its low bits after a long
 * session, and `elapsed` carries boot wall-clock in, so a "deterministic"
 * cinematic reel would get different grain on every run. The 1024 wrap keeps the
 * seed small enough that `sin(dot(p, k))` stays well-conditioned — the classic
 * fract-sin hash degenerates into visible banding once its argument gets large.
 */
export function advanceGrain(frameIndex: number): void {
  U.seed.value = GRAIN_TUNING.values.animate === true ? frameIndex % 1024 : 0
}

/**
 * Zero-mean film grain, added in display-referred space.
 *
 * @param colour display-referred rgb.
 * @param screenCoord pixel coordinates in the OUTPUT buffer (screenCoordinate.xy).
 * @returns the grained colour. At `strength: 0` this is `colour` exactly — every
 *   term is multiplied by the strength uniform, so the toggle is the value and
 *   there is no branch to corrupt.
 */
export function filmGrain(colour: N, screenCoord: N): N {
  // The lattice is quantised in OUTPUT pixels divided by `size`, so grain size
  // is stated in screen pixels and stays put when the beauty pass renders at
  // 0.667 and the temporal resolve upscales. Sampling a UV-derived coordinate
  // instead — which is what FilmNode does — makes the grain shrink and alias
  // the moment the adaptive-resolution governor moves.
  //
  // The mod 1024 is not cosmetic. hash23 is the fract(sin(dot(p, k))) hash, and
  // its argument here is dot(cell, (127.1, 311.7)) — at an unwrapped 4K
  // coordinate plus a free-running frame seed that reaches ~10^6, where a
  // float32 ULP is 0.06 rad and the hash starts returning structure instead of
  // noise. 1024 is exact in float32, and a wrap period of 1024·size screen
  // pixels puts the single seam outside the frame on every display this runs on.
  const cell = screenCoord.div(U.size).floor().add(U.seed).mod(1024.0)

  // hash23 gives three decorrelated channels; `chroma` mixes between one shared
  // achromatic sample and fully independent ones. Real emulsion grain is
  // neither: three dye layers with different grain structure, correlated but not
  // identical.
  //
  // The achromatic sample is the mean of the three ×√3, and the √3 is the whole
  // reason this is not just `.div(3)`. Averaging three independent samples cuts
  // the VARIANCE to a third, so a naive mean would make `chroma: 0` look 42%
  // weaker than `chroma: 1` at the same `strength` — a cross-talk between two
  // sliders that nobody would ever diagnose, they would just keep raising
  // strength.
  const n = hash23(cell).sub(0.5).mul(2.0)
  const mono = n.r.add(n.g).add(n.b).mul(1.7320508 / 3.0)
  const g = mix(vec3(mono), n, U.chroma)

  // Luminance response. l·(1−l) peaks at mid grey and vanishes at both ends,
  // which is what real grain does: a blown specular has no grain because the
  // emulsion is saturated, and a deep shadow has none because almost no crystals
  // developed. `falloff` shapes how fast it dies off; ·4 normalises the peak
  // to 1 so `strength` keeps meaning the same thing when falloff moves.
  const l = displayLuma(colour).clamp(0.0, 1.0)
  const resp = l.mul(l.oneMinus()).mul(4.0).clamp(0.0, 1.0).pow(U.falloff)

  return colour.add(g.mul(U.strength).mul(mix(float(1.0), resp, U.response)))
}

/**
 * Grain owns a LOOK, not a pass — see the folder-layout note in the brief. The
 * stage object exists only so the chain has one place to reach its tunables and
 * one place to push them into uniforms.
 */
export function createGrainStage(setup: PostStageSetup): PostStage {
  void setup
  applyGrainParams()
  return {
    id: "grain",
    label: "film grain",
    order: STAGE_ORDER.grain,
    kind: "inline",
    resolution: "output",
    // FALSE ON PURPOSE, and it does not mean "no grain". In this chain
    // `enabled()` decides whether the driver calls `render()`, and this stage
    // has no pass to render — it is arithmetic fused into the display tail.
    // Reporting true would inflate `chain.state().passes`, which probes read as
    // a GPU cost. The real toggle is `strength: 0`, which is an exact identity.
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: applyGrainParams,
    tuning: { group: GRAIN_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }
}
