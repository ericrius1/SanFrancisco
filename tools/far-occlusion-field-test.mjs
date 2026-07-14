import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temporary = await mkdtemp(path.join(os.tmpdir(), "far-occlusion-field-"))
const outfile = path.join(temporary, "core.mjs")

try {
  await build({
    entryPoints: [path.join(root, "src/world/shadows/farOcclusionCore.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error"
  })
  const {
    FAR_NO_OCCLUSION_HEIGHT,
    buildFarOcclusionFloatField,
    floatToHalf,
    packFarOcclusionHalf
  } = await import(pathToFileURL(outfile).href)

  const width = 16
  const height = 8
  const terrain = new Float32Array(width * height)
  const box = new Float32Array([
    8.5, 3.5, 20, 0.2, 0.2, 1, 0
  ])
  const buildField = (sunX, sunZ, terrainField = terrain, sets = [box]) =>
    buildFarOcclusionFloatField({
      width,
      height,
      minX: 0,
      minZ: 0,
      texelSize: 1,
      terrain: terrainField,
      occluderSets: sets.values(),
      sunX,
      sunY: 1,
      sunZ,
      minimumSunSlope: 0.2,
      footprintHeightMeters: 3
    })

  const fromEast = buildField(1, 0)
  const outerAt = (field, x, z) => field.data[(z * width + x) * 2]
  const coreAt = (field, x, z) => field.data[(z * width + x) * 2 + 1]
  assert(outerAt(fromEast, 7, 3) > 18, "padded envelope should cast west from the box")
  assert(coreAt(fromEast, 7, 3) > 18, "tight core should cast west from the box")
  assert(outerAt(fromEast, 6, 3) > 17, "outer shadow ceiling should propagate with solar slope")
  assert(coreAt(fromEast, 6, 3) > 17, "core shadow ceiling should propagate with solar slope")
  assert(outerAt(fromEast, 9, 3) < 1, "up-sun outer field must remain open")
  assert(coreAt(fromEast, 9, 3) < 1, "up-sun core field must remain open")
  assert(outerAt(fromEast, 7, height - 1) < 1, "axis sweep must preserve the boundary row")
  assert(outerAt(fromEast, 8, 3) >= 2.99, "tight footprint should raise the weak outer base ceiling")

  const fromWest = buildField(-1, 0)
  assert(outerAt(fromWest, 9, 3) > 18, "west sun should cast the outer envelope east")
  assert(coreAt(fromWest, 9, 3) > 18, "west sun should cast the tight core east")
  assert(outerAt(fromWest, 7, 3) < 1, "opposite outer side must remain open after sun flip")
  assert(coreAt(fromWest, 7, 3) < 1, "opposite core side must remain open after sun flip")

  const ridge = new Float32Array(width * height)
  for (let z = 0; z < height; z++) ridge[z * width + 8] = 24
  const terrainOnly = buildField(1, 0, ridge, [])
  assert(outerAt(terrainOnly, 7, 4) > 22, "terrain ridge should cast into the outer field")
  assert(coreAt(terrainOnly, 7, 4) > 22, "terrain ridge must remain strong in the core field")
  assert.equal(outerAt(terrainOnly, 7, 4), coreAt(terrainOnly, 7, 4))
  assert.equal(terrainOnly.occluders, 0)
  assert.equal(terrainOnly.occupiedTexels, 0)
  assert.equal(terrainOnly.coreOccupiedTexels, 0)

  const cornerBox = new Float32Array([
    8, 3, 20, 0.05, 0.05, 1, 0
  ])
  const corner = buildField(1, 0, terrain, [cornerBox])
  assert.equal(corner.coreOccupiedTexels, 1, "sub-texel core must select one deterministic owner cell")
  assert.equal(corner.occupiedTexels, 4, "half-texel outer envelope should retain conservative coverage")
  assert(coreAt(corner, 7, 3) > 18, "owner-cell fallback should cast from the tight core")
  assert(coreAt(corner, 7, 2) < 1, "tight core must not inflate into the adjacent row")
  assert(outerAt(corner, 7, 2) > 18, "weak outer envelope should preserve the adjacent padded row")

  const diagonal = Math.SQRT1_2
  const rotatedCornerBox = new Float32Array([
    8, 3, 20, 0.01, 0.01, diagonal, diagonal
  ])
  const rotatedCorner = buildField(1, 0, terrain, [rotatedCornerBox])
  assert.equal(rotatedCorner.coreOccupiedTexels, 1)
  assert(coreAt(rotatedCorner, 7, 3) > 18, "rotated fallback must cast from its owner cell")

  const zenith = buildField(0, 0, terrain, [cornerBox])
  assert.equal(outerAt(zenith, 8, 3), 3, "weak outer channel should own tight base contact")
  assert.equal(coreAt(zenith, 8, 3), FAR_NO_OCCLUSION_HEIGHT)
  assert.equal(outerAt(zenith, 7, 2), FAR_NO_OCCLUSION_HEIGHT)

  const assertOuterContainsCore = (field, label) => {
    for (let i = 0; i < field.data.length; i += 2) {
      assert(
        field.data[i] >= field.data[i + 1] - 1e-6,
        `${label} outer envelope must contain core at texel ${i / 2}`
      )
    }
  }
  for (const [label, field] of [
    ["east", fromEast],
    ["west", fromWest],
    ["terrain", terrainOnly],
    ["corner", corner],
    ["rotated", rotatedCorner],
    ["zenith", zenith]
  ]) assertOuterContainsCore(field, label)

  const repeat = buildField(1, 0)
  assert.deepEqual(repeat.data, fromEast.data, "field builds must be deterministic")
  assert.equal(floatToHalf(0), 0x0000)
  assert.equal(floatToHalf(1), 0x3c00)
  assert.equal(floatToHalf(-2), 0xc000)
  assert.equal(floatToHalf(65504), 0x7bff)

  // Production-size smoke/perf fixture: SF resolves to 944x868 at 16 m. The
  // timing is informational (no machine-specific threshold); it catches an
  // accidental super-linear sweep or pack before browser profiling.
  const largeWidth = 944
  const largeHeight = 868
  const largeTerrain = new Float32Array(largeWidth * largeHeight)
  const largeBoxes = new Float32Array(20_000 * 7)
  for (let i = 0; i < 20_000; i++) {
    const o = i * 7
    largeBoxes[o] = ((i * 83) % largeWidth + 0.5) * 16
    largeBoxes[o + 1] = ((i * 47) % largeHeight + 0.5) * 16
    largeBoxes[o + 2] = 8 + (i % 52)
    largeBoxes[o + 3] = 3 + (i % 5)
    largeBoxes[o + 4] = 3 + ((i >> 2) % 6)
    largeBoxes[o + 5] = 1
    largeBoxes[o + 6] = 0
  }
  const largeStarted = performance.now()
  const large = buildFarOcclusionFloatField({
    width: largeWidth,
    height: largeHeight,
    minX: 0,
    minZ: 0,
    texelSize: 16,
    terrain: largeTerrain,
    occluderSets: [largeBoxes],
    sunX: 0.7,
    sunY: 0.55,
    sunZ: -0.45,
    minimumSunSlope: Math.tan(7 * Math.PI / 180),
    footprintHeightMeters: 3
  })
  const buildMs = performance.now() - largeStarted
  assertOuterContainsCore(large, "production fixture")
  const packStarted = performance.now()
  const packed = packFarOcclusionHalf(large.data)
  const packMs = performance.now() - packStarted
  assert.equal(packed.byteLength, largeWidth * largeHeight * 4)
  assert.equal(packed.byteLength, 3_277_568)

  console.log(JSON.stringify({
    status: "pass",
    dimensions: [width, height],
    westOuterCeiling: outerAt(fromEast, 7, 3),
    westCoreCeiling: coreAt(fromEast, 7, 3),
    footprintOuterCeiling: outerAt(fromEast, 8, 3),
    productionFixture: {
      dimensions: [largeWidth, largeHeight],
      occluders: large.occluders,
      gpuBytes: packed.byteLength,
      buildMs: Number(buildMs.toFixed(1)),
      packMs: Number(packMs.toFixed(1))
    }
  }, null, 2))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
