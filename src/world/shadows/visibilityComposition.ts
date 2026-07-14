/**
 * Compose a detailed raster shadow with the low-frequency world atlas.
 *
 * Visibility is a transmittance factor: 1 is fully lit and 0 is fully occluded.
 * Taking the darker sample forms a union of the two caster representations
 * without multiplying duplicated casters. `rasterRetireWeight` then removes
 * only the raster detail as its light-space domain ends.
 */
export function composeRasterAtlasVisibility<T, W>(
  rasterVisibility: T,
  atlasBaseVisibility: T,
  rasterRetireWeight: W,
  darkest: (a: T, b: T) => T,
  blend: (a: T, b: T, weight: W) => T
): T {
  const detailedVisibility = darkest(rasterVisibility, atlasBaseVisibility)
  return blend(detailedVisibility, atlasBaseVisibility, rasterRetireWeight)
}
