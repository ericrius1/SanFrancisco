// U6 · Display tail + grade + AgX + grain + sharpen
// build spec: .data/postfx/BRIEF.md §4.9
//
// STUB. TSL only — no render target, no PostStage pass.
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
import { STAGE_ORDER } from "../order"
import type { N, PostStage, PostStageSetup } from "../types"
import { GRAIN_TUNING } from "./tuning"

/**
 * The display tail's hook. Exact identity while this is a stub, exactly as
 * `strength: 0` will be once it is real.
 */
export function filmGrain(colour: N, screenCoord: N): N {
  void screenCoord
  return colour
}

export function createGrainStage(setup: PostStageSetup): PostStage {
  void setup
  return {
    id: "grain",
    label: "film grain",
    order: STAGE_ORDER.grain,
    kind: "inline",
    resolution: "output",
    enabled: () => false,
    output: () => null,
    render: () => {},
    setSize: () => {},
    warmupQuads: (): THREE.QuadMesh[] => [],
    applyParams: () => {},
    tuning: { group: GRAIN_TUNING, structuralKeys: [], recompileKeys: [] },
    dispose: () => {}
  }
}
