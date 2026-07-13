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
  const { buildFarOcclusionFloatField, floatToHalf, packFarOcclusionHalf } = await import(pathToFileURL(outfile).href)

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
      occluderSets: sets,
      sunX,
      sunY: 1,
      sunZ,
      minimumSunSlope: 0.2,
      contactRadiusMeters: 3,
      contactHeightMeters: 3,
      contactClearanceMeters: 12
    })

  const fromEast = buildField(1, 0)
  const ceilingAt = (field, x, z) => field.data[(z * width + x) * 2]
  const contactAt = (field, x, z) => field.data[(z * width + x) * 2 + 1]
  assert(ceilingAt(fromEast, 7, 3) > 18, "east sun should cast west from the box")
  assert(ceilingAt(fromEast, 6, 3) > 17, "shadow ceiling should propagate with solar slope")
  assert(ceilingAt(fromEast, 9, 3) < 1, "up-sun ground must remain open")
  assert(ceilingAt(fromEast, 7, height - 1) < 1, "axis sweep must preserve the boundary row")
  assert(contactAt(fromEast, 8, 3) >= 2.99, "box footprint should raise the contact ceiling")
  assert(contactAt(fromEast, 10, 3) < contactAt(fromEast, 8, 3), "contact ceiling should soften outward")
  assert.equal(contactAt(fromEast, 15, 3), -12, "far ground should have a safely neutral contact ceiling")

  const fromWest = buildField(-1, 0)
  assert(ceilingAt(fromWest, 9, 3) > 18, "west sun should cast east from the box")
  assert(ceilingAt(fromWest, 7, 3) < 1, "opposite side must remain open after sun flip")

  const ridge = new Float32Array(width * height)
  for (let z = 0; z < height; z++) ridge[z * width + 8] = 24
  const terrainOnly = buildField(1, 0, ridge, [])
  assert(ceilingAt(terrainOnly, 7, 4) > 22, "terrain ridge should cast into the far field")
  assert.equal(terrainOnly.occluders, 0)
  assert.equal(terrainOnly.occupiedTexels, 0)

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
    contactRadiusMeters: 30,
    contactHeightMeters: 3,
    contactClearanceMeters: 12
  })
  const buildMs = performance.now() - largeStarted
  const packStarted = performance.now()
  const packed = packFarOcclusionHalf(large.data)
  const packMs = performance.now() - packStarted
  assert.equal(packed.byteLength, largeWidth * largeHeight * 4)

  console.log(JSON.stringify({
    status: "pass",
    dimensions: [width, height],
    westShadowCeiling: ceilingAt(fromEast, 7, 3),
    footprintContact: contactAt(fromEast, 8, 3),
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
