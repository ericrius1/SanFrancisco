import { float, fract, vec2, vec3 } from "three/tsl"
import type { N } from "../types"

/**
 * Pure-arithmetic hashes. This file exists so nothing in `post/` ever reaches
 * for `mx_noise_*` inside a branch.
 *
 * postfx.ts:44-51 records the hazard: the stylized stages used build-time JS
 * branches only, never `If()`, precisely because an mx_noise node inside a
 * conditional corrupts the generated WGSL. The two runtime branches this chain
 * keeps — the underwater package and sharpen's extra taps — are both
 * uniform-buffer-read conditions, i.e. uniform control flow for the whole draw,
 * and both are noise-free. Grain uses `hash23` and is applied UNCONDITIONALLY
 * with a zeroed-strength identity rather than gated. Do not "optimise" that
 * into a branch.
 *
 * All three functions are also resolution-independent by construction: they take
 * an already-quantised lattice coordinate, so a 0.667 internal render does not
 * halve the grain.
 */

/** vec2 -> float in [0,1). The classic sin-fract hash, no texture, no noise node. */
export const hash21 = (p: N): N =>
  fract(p.dot(vec2(127.1, 311.7)).sin().mul(43758.5453))

/** vec2 -> vec3 in [0,1)^3, decorrelated per channel (real grain is not achromatic). */
export const hash23 = (p: N): N =>
  fract(
    vec3(
      p.dot(vec2(127.1, 311.7)),
      p.dot(vec2(269.5, 183.3)),
      p.dot(vec2(419.2, 371.9))
    )
      .sin()
      .mul(43758.5453)
  )

/**
 * Jorge Jimenez's interleaved gradient noise — the standard low-discrepancy
 * dither for temporally-rotated sampling kernels. three exports its own under
 * the same name; this one is here so a stage can take a frame offset without
 * pulling in the node's own update scheduling.
 */
export const interleavedGradientNoise = (pixel: N, frame: N = float(0)): N => {
  const p = pixel.add(frame.mul(5.588238))
  return fract(p.dot(vec2(0.06711056, 0.00583715)).mul(52.9829189))
}
