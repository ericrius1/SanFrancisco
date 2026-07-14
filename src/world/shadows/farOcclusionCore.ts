/**
 * Pure CPU builder for the far-range occlusion field. Kept free of THREE/DOM so
 * the worker and headless regression probe execute exactly the same algorithm.
 *
 * Channel R is a conservative directional ceiling built from half-texel-padded
 * occluders. Runtime decodes it weakly, so tiny casters survive without turning
 * whole 16 m cells fully dark. Channel G is a tightly stamped directional core
 * decoded at full shadow strength. Both are world-space heights, which keeps
 * roofs and upper facades clean without another texture sample.
 */

export const FAR_OCCLUDER_STRIDE = 7
export const FAR_NO_OCCLUSION_HEIGHT = -60_000

/** Packed fields: x, z, topY, halfX, halfZ, cosYaw, sinYaw. */
export type PackedFarOccluders = Float32Array

export type FarOcclusionBuildInput = Readonly<{
  width: number
  height: number
  minX: number
  minZ: number
  texelSize: number
  terrain: Float32Array
  occluderSets: Iterable<PackedFarOccluders>
  sunX: number
  sunY: number
  sunZ: number
  /** Prevent near-horizon casters from darkening an unbounded portion of the map. */
  minimumSunSlope: number
  /** Low base ceiling merged into each occupied footprint in both envelopes. */
  footprintHeightMeters: number
}>

export type FarOcclusionFloatField = Readonly<{
  /** Interleaved conservative-outer/tight-core shadow ceilings. */
  data: Float32Array
  occluders: number
  occupiedTexels: number
  coreOccupiedTexels: number
}>

function validInput(input: FarOcclusionBuildInput): void {
  if (!Number.isInteger(input.width) || input.width <= 0) throw new Error("width must be a positive integer")
  if (!Number.isInteger(input.height) || input.height <= 0) throw new Error("height must be a positive integer")
  if (input.terrain.length !== input.width * input.height) throw new Error("terrain size does not match field dimensions")
  if (!Number.isFinite(input.texelSize) || input.texelSize <= 0) throw new Error("texelSize must be finite and positive")
}

function stampOccluderEnvelopes(
  outerSurface: Float32Array,
  coreSurface: Float32Array,
  outerOccupied: Uint8Array,
  coreOccupied: Uint8Array,
  input: FarOcclusionBuildInput
): { occluders: number; occupiedTexels: number; coreOccupiedTexels: number } {
  const { width, height, minX, minZ, texelSize } = input
  const maxX = minX + width * texelSize
  const maxZ = minZ + height * texelSize
  const footprintPad = texelSize * 0.5
  let occluders = 0

  for (const packed of input.occluderSets) {
    const count = Math.floor(packed.length / FAR_OCCLUDER_STRIDE)
    for (let i = 0; i < count; i++) {
      const o = i * FAR_OCCLUDER_STRIDE
      const x = packed[o]
      const z = packed[o + 1]
      const top = packed[o + 2]
      const hx = packed[o + 3]
      const hz = packed[o + 4]
      const cos = packed[o + 5]
      const sin = packed[o + 6]
      if (
        !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(top) ||
        !Number.isFinite(hx) || !Number.isFinite(hz) ||
        !Number.isFinite(cos) || !Number.isFinite(sin) || hx <= 0 || hz <= 0
      ) continue

      occluders++
      const outerHx = hx + footprintPad
      const outerHz = hz + footprintPad
      // Rotate the expanded OBB extents, rather than adding one world-axis pad
      // after rotation (which under-bounds a diagonal conservative footprint).
      const radiusX = Math.abs(cos) * outerHx + Math.abs(sin) * outerHz
      const radiusZ = Math.abs(sin) * outerHx + Math.abs(cos) * outerHz
      const x0 = Math.max(0, Math.floor((x - radiusX - minX) / texelSize))
      const x1 = Math.min(width - 1, Math.floor((x + radiusX - minX) / texelSize))
      const z0 = Math.max(0, Math.floor((z - radiusZ - minZ) / texelSize))
      const z1 = Math.min(height - 1, Math.floor((z + radiusZ - minZ) / texelSize))
      let coreHit = false

      for (let iz = z0; iz <= z1; iz++) {
        const worldZ = minZ + (iz + 0.5) * texelSize
        const dz = worldZ - z
        for (let ix = x0; ix <= x1; ix++) {
          const worldX = minX + (ix + 0.5) * texelSize
          const dx = worldX - x
          // Inverse of the yaw convention used by tileShadowProxy/physics.
          const localX = dx * cos - dz * sin
          const localZ = dx * sin + dz * cos
          const index = iz * width + ix
          if (Math.abs(localX) <= outerHx && Math.abs(localZ) <= outerHz) {
            if (top > outerSurface[index]) outerSurface[index] = top
            outerOccupied[index] = 1
          }
          if (Math.abs(localX) <= hx && Math.abs(localZ) <= hz) {
            if (top > coreSurface[index]) coreSurface[index] = top
            coreOccupied[index] = 1
            coreHit = true
          }
        }
      }

      // A tight sub-texel OBB may contain no atlas cell centre. Keep one
      // deterministic core texel at the nearest cell so the caster survives,
      // while the separate padded envelope remains the conservative fringe.
      if (!coreHit && x >= minX && x < maxX && z >= minZ && z < maxZ) {
        const ix = Math.floor((x - minX) / texelSize)
        const iz = Math.floor((z - minZ) / texelSize)
        const index = iz * width + ix
        if (top > coreSurface[index]) coreSurface[index] = top
        if (top > outerSurface[index]) outerSurface[index] = top
        coreOccupied[index] = 1
        outerOccupied[index] = 1
      }
    }
  }

  let occupiedTexels = 0
  let coreOccupiedTexels = 0
  for (let i = 0; i < outerOccupied.length; i++) {
    occupiedTexels += outerOccupied[i]
    coreOccupiedTexels += coreOccupied[i]
  }
  return { occluders, occupiedTexels, coreOccupiedTexels }
}

function interpolateEnvelope(a: number, b: number, t: number): number {
  const aValid = a > FAR_NO_OCCLUSION_HEIGHT + 1
  const bValid = b > FAR_NO_OCCLUSION_HEIGHT + 1
  if (!aValid) return bValid ? b : FAR_NO_OCCLUSION_HEIGHT
  if (!bValid) return a
  return a + (b - a) * t
}

function sweepShadowCeiling(
  surfaceAndEnvelope: Float32Array,
  output: Float32Array,
  input: FarOcclusionBuildInput,
  channel: 0 | 1
): void {
  const { width, height, texelSize } = input
  const horizontal = Math.hypot(input.sunX, input.sunZ)
  if (horizontal < 1e-5 || input.sunY <= 0) {
    for (let i = 0; i < width * height; i++) output[i * 2 + channel] = FAR_NO_OCCLUSION_HEIGHT
    return
  }

  // SUN points from the receiver toward the light. Shadow propagation moves in
  // the opposite horizontal direction. Clamping the slope bounds both shadow
  // reach and low-sun rebuild cost/visual dominance.
  const awayX = -input.sunX / horizontal
  const awayZ = -input.sunZ / horizontal
  const sunSlope = Math.max(input.minimumSunSlope, input.sunY / horizontal)

  if (Math.abs(awayX) >= Math.abs(awayZ)) {
    const stepX = awayX >= 0 ? 1 : -1
    const slopeZ = awayZ / Math.abs(awayX)
    const travelMeters = texelSize / Math.abs(awayX)
    const heightDrop = sunSlope * travelMeters
    const startX = stepX > 0 ? 0 : width - 1
    const endX = stepX > 0 ? width : -1

    for (let x = startX; x !== endX; x += stepX) {
      const previousX = x - stepX
      for (let z = 0; z < height; z++) {
        const index = z * width + x
        let propagated = FAR_NO_OCCLUSION_HEIGHT
        if (previousX >= 0 && previousX < width) {
          const previousZ = z - slopeZ
          const z0 = Math.floor(previousZ)
          const z1 = Math.min(height - 1, z0 + 1)
          if (previousZ >= 0 && previousZ <= height - 1 && z0 >= 0) {
            propagated = interpolateEnvelope(
              surfaceAndEnvelope[z0 * width + previousX],
              surfaceAndEnvelope[z1 * width + previousX],
              previousZ - z0
            )
            if (propagated > FAR_NO_OCCLUSION_HEIGHT + 1) propagated -= heightDrop
          }
        }
        output[index * 2 + channel] = propagated
        const ownHeight = surfaceAndEnvelope[index]
        surfaceAndEnvelope[index] = Math.max(ownHeight, propagated)
      }
    }
  } else {
    const stepZ = awayZ >= 0 ? 1 : -1
    const slopeX = awayX / Math.abs(awayZ)
    const travelMeters = texelSize / Math.abs(awayZ)
    const heightDrop = sunSlope * travelMeters
    const startZ = stepZ > 0 ? 0 : height - 1
    const endZ = stepZ > 0 ? height : -1

    for (let z = startZ; z !== endZ; z += stepZ) {
      const previousZ = z - stepZ
      for (let x = 0; x < width; x++) {
        const index = z * width + x
        let propagated = FAR_NO_OCCLUSION_HEIGHT
        if (previousZ >= 0 && previousZ < height) {
          const previousX = x - slopeX
          const x0 = Math.floor(previousX)
          const x1 = Math.min(width - 1, x0 + 1)
          if (previousX >= 0 && previousX <= width - 1 && x0 >= 0) {
            propagated = interpolateEnvelope(
              surfaceAndEnvelope[previousZ * width + x0],
              surfaceAndEnvelope[previousZ * width + x1],
              previousX - x0
            )
            if (propagated > FAR_NO_OCCLUSION_HEIGHT + 1) propagated -= heightDrop
          }
        }
        output[index * 2 + channel] = propagated
        const ownHeight = surfaceAndEnvelope[index]
        surfaceAndEnvelope[index] = Math.max(ownHeight, propagated)
      }
    }
  }
}

function mergeFootprintCeiling(
  coreOccupied: Uint8Array,
  output: Float32Array,
  input: FarOcclusionBuildInput
): void {
  const footprintHeight = Math.max(0, input.footprintHeightMeters)
  for (let i = 0; i < coreOccupied.length; i++) {
    if (!coreOccupied[i]) continue
    // The weak outer channel also owns base contact. Restricting it to tight
    // occupancy replaces the old one-texel chamfer/padded block semantics.
    output[i * 2] = Math.max(output[i * 2], input.terrain[i] + footprintHeight)
  }
}

export function buildFarOcclusionFloatField(input: FarOcclusionBuildInput): FarOcclusionFloatField {
  validInput(input)
  const count = input.width * input.height
  const outerSurface = new Float32Array(input.terrain)
  const coreSurface = new Float32Array(input.terrain)
  const outerOccupied = new Uint8Array(count)
  const coreOccupied = new Uint8Array(count)
  // `occluderSets` may be a worker Map iterator, so both envelopes must be
  // stamped in this single traversal.
  const stamped = stampOccluderEnvelopes(
    outerSurface,
    coreSurface,
    outerOccupied,
    coreOccupied,
    input
  )
  const data = new Float32Array(count * 2)
  sweepShadowCeiling(outerSurface, data, input, 0)
  sweepShadowCeiling(coreSurface, data, input, 1)
  mergeFootprintCeiling(coreOccupied, data, input)
  return { data, ...stamped }
}

/** Allocation-free IEEE754 float32 -> float16 conversion for worker output. */
export function floatToHalf(value: number): number {
  // Adapted to avoid per-value typed-array views in the million-texel pack loop.
  if (Number.isNaN(value)) return 0x7e00
  if (value === Infinity) return 0x7c00
  if (value === -Infinity) return 0xfc00
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0
  let magnitude = Math.abs(value)
  if (magnitude > 65504) magnitude = 65504
  if (magnitude < 5.960464477539063e-8) return sign

  let exponent = Math.floor(Math.log2(magnitude))
  let mantissa: number
  if (exponent < -14) {
    mantissa = Math.round(magnitude / 5.960464477539063e-8)
    return sign | Math.min(0x3ff, mantissa)
  }
  if (exponent > 15) return sign | 0x7bff
  mantissa = Math.round((magnitude / 2 ** exponent - 1) * 1024)
  if (mantissa === 1024) {
    exponent++
    mantissa = 0
    if (exponent > 15) return sign | 0x7bff
  }
  return sign | ((exponent + 15) << 10) | (mantissa & 0x3ff)
}

export function packFarOcclusionHalf(field: Float32Array): Uint16Array {
  const packed = new Uint16Array(field.length)
  for (let i = 0; i < field.length; i++) packed[i] = floatToHalf(field[i])
  return packed
}
