// Buena Vista Park art-direction anchors in the local SF metre frame (+X east,
// +Z south). The bounds come from the OSM park polygon in data/raw/land.json;
// the summit is the highest sampled point inside that footprint. Keeping these
// in one tiny module lets the tree layout and the TSL fog treatment agree on
// the same place without coupling the sky to the vegetation implementation.

export const BUENA_VISTA_REGION = {
  minX: 20,
  maxX: 490,
  minZ: 2130,
  maxZ: 2660
} as const;

// Seven-metre simplification of OSM way 7459901. The surface raster is only an
// eight-metre grid and merges a small class-1 patch across the park's southeast
// edge; this polygon keeps trees in Buena Vista instead of spilling them toward
// Corona Heights. Atmospheric mist may feather beyond it naturally.
const BUENA_VISTA_OUTLINE: readonly (readonly [number, number])[] = [
  [78.2, 2166.5],
  [71.7, 2174.2],
  [85.3, 2214.5],
  [105.3, 2232.4],
  [142.4, 2241.7],
  [149.0, 2262.3],
  [57.9, 2342.8],
  [19.8, 2479.8],
  [23.2, 2513.5],
  [38.9, 2563.2],
  [80.5, 2601.2],
  [99.0, 2639.6],
  [135.6, 2658.0],
  [166.1, 2658.8],
  [286.4, 2548.7],
  [338.4, 2454.1],
  [450.1, 2382.1],
  [489.8, 2312.8],
  [386.8, 2168.8],
  [311.5, 2131.4]
] as const;

export function inBuenaVistaPark(x: number, z: number): boolean {
  if (
    x < BUENA_VISTA_REGION.minX ||
    x > BUENA_VISTA_REGION.maxX ||
    z < BUENA_VISTA_REGION.minZ ||
    z > BUENA_VISTA_REGION.maxZ
  ) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = BUENA_VISTA_OUTLINE.length - 1; i < BUENA_VISTA_OUTLINE.length; j = i++) {
    const [xi, zi] = BUENA_VISTA_OUTLINE[i];
    const [xj, zj] = BUENA_VISTA_OUTLINE[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Buena Vista is densely wooded but opens around the crown. This clearing is
// intentionally large enough to remain legible from the Corona Heights orbit.
export const BUENA_VISTA_SUMMIT_CLEARING = {
  x: 212,
  z: 2450,
  radiusX: 66,
  radiusZ: 50
} as const;

// A feathered, rotated ellipse follows the park's long NW/SE axis. It is used
// only to localise wispy fog; the actual trees still obey the map's class-1 park
// surface, so planting follows the irregular OSM footprint rather than this
// broad atmospheric envelope.
export const BUENA_VISTA_MIST = {
  x: 215,
  z: 2390,
  rotation: -1.1473,
  radiusAlong: 305,
  radiusAcross: 238,
  minY: 72,
  fullY: 104,
  fadeY: 184,
  maxY: 222,
  strength: 0.24
} as const;
