// VENDORED from three/examples/jsm/tsl/utils/RNoise.js — three r185 (0.185.1).
//
// Texture-free analytic R² (plastic-constant) noise. Four independent low-
// discrepancy dimensions hashed from the pixel coordinate, tile-shifted per
// sample index into a 64×64 period.
//
// Used ONLY by the SSR fork's stochastic (GGX-scatter) path. The stage ships
// `stochastic: false`, so in the current build this is baked out — see the header
// of ./ssr.ts for why the path is kept rather than deleted.
//
// It is arithmetic, not a texture fetch and not `mx_noise`, so it is safe to
// evaluate anywhere — including inside an `If()`, which the project's noise rule
// forbids for the mx_* family (postfx.ts:44-51).
//
// DEVIATIONS FROM UPSTREAM:
//  1. TypeScript signatures only. Node parameters are `N` (= any).
//  2. `seed` participates in the hash exactly as upstream (both as `seedOffset`
//     on the sample index and as an additive term inside `r4`); no change.
import * as TSL from "three/tsl"
import type { N } from "../../types"

// See ./boxBlur.ts for why the TSL namespace is taken loose in one place.
const { Fn, float, fract, int, vec2, vec4 } = TSL as unknown as Record<string, N>

/**
 * @param resolution - `uniform(Vector2)` holding the pass resolution in pixels.
 * @param seed - added to the coordinate hash so each pass gets an independent phase.
 */
export function bindAnalyticNoise(resolution: N, seed = 0): N {
  const seedOffset = int(seed)

  const r4 = (coords: N): N => {
    const P = 1.32471795724474602596

    const t = coords.x
      .mul(1 / P)
      .add(coords.y.mul(1 / P ** 2))
      .add(float(seed))

    return vec4(
      fract(t.mul(P).mul(1 / P)),
      fract(t.mul(P * 2).mul(1 / P ** 2)),
      // Not 1 / P**3 — upstream's note: this magic constant gives better noise.
      fract(t.mul(P * 3).mul(0.419875421)),
      fract(t.mul(P * 4).mul(1 / P ** 3))
    )
  }

  return Fn(([uvCoord, sampleIndex]: N[]): N => {
    const index = int(sampleIndex).add(seedOffset)
    const noise = vec4().toVar()

    const tileSize = float(32)

    const screenPixel = uvCoord.mul(resolution).floor()
    const offset = fract(vec2(float(index).mul(0.7548776662), float(index).mul(0.569840291)))
      .mul(tileSize)
      .floor()
    const coords = screenPixel.add(offset).mod(tileSize)

    noise.assign(r4(coords))

    return noise
  })
}
