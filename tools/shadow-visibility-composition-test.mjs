import assert from "node:assert/strict"
import { composeRasterAtlasVisibility } from "../src/world/shadows/visibilityComposition.ts"

const blend = (a, b, weight) => a + (b - a) * weight
const compose = (raster, atlasBase, retire = 0) =>
  composeRasterAtlasVisibility(raster, atlasBase, retire, Math.min, blend)

// Duplicate raster/atlas casters form a union, not an over-dark multiplication.
assert.equal(compose(0.6, 0.7), 0.6)
assert.notEqual(compose(0.6, 0.7), 0.6 * 0.7)

// Low-frequency terrain occlusion remains present beneath a brighter raster map.
assert.equal(compose(0.8, 0.45), 0.45)

// Retiring darker raster detail converges continuously to the atlas base.
assert.equal(compose(0.6, 0.8, 0.5), 0.7)
assert.equal(compose(0.6, 0.8, 1), 0.8)

// The same atlas base is applied after the local→far raster blend. A darker
// terrain base therefore stays identical across that domain boundary, while a
// lighter base preserves the raster blend's smooth, bounded transition.
const localFarBlend = (local, far, atlas, farWeight) =>
  compose(blend(local, far, farWeight), atlas)
assert.deepEqual(
  [0, 0.25, 0.5, 0.75, 1].map((weight) => localFarBlend(0.85, 0.75, 0.45, weight)),
  [0.45, 0.45, 0.45, 0.45, 0.45]
)
const lighterBaseBlend = [0, 0.25, 0.5, 0.75, 1]
  .map((weight) => localFarBlend(0.6, 0.7, 0.8, weight))
for (const [index, expected] of [0.6, 0.625, 0.65, 0.675, 0.7].entries()) {
  assert(Math.abs(lighterBaseBlend[index] - expected) < 1e-12)
}

// With far-field strength disabled the neutral base preserves raster behavior,
// including the existing fully-lit result after the raster domain retires.
assert.equal(compose(0.6, 1, 0), 0.6)
assert.equal(compose(0.6, 1, 1), 1)

console.log("shadow visibility composition: pass")
