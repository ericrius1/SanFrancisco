// Japanese Tea Garden, Golden Gate Park — surveyed layout in the project's
// pinned local-metre frame (+X east, +Z south).
//
// Primary geometry source (checked 2026-07-11): OpenStreetMap way 30900516 and
// its mapped paths/buildings/ponds. The official 2026 Gardens of Golden Gate
// Park visitor map is the authority for landmark names and circulation intent:
// https://gggp.org/wp-content/uploads/2026/05/20260315-JapaneseTeaGarden-Map-11x8-v4-FINAL-1.pdf
//
// Projection: x=(lon+122.444)*87971.963, z=(37.79-lat)*110574.

export type TeaGardenXZ = readonly [x: number, z: number];

export type TeaGardenTerrain = {
  groundHeight(x: number, z: number): number;
  groundTop(x: number, z: number): number;
  baseGroundTop(x: number, z: number): number;
  surfaceType(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
};

export const JAPANESE_TEA_GARDEN_CENTER = { x: -2298, z: 2182 } as const;
export const JAPANESE_TEA_GARDEN_ENTRANCE = { x: -2248.8, z: 2187.2, heading: -2.35 } as const;

/** Current garden boundary: OSM way 30900516 (the closing point is implicit). */
export const TEA_GARDEN_OUTLINE: readonly TeaGardenXZ[] = [
  [-2218.05, 2154.91],
  [-2274.49, 2243.72],
  [-2314.16, 2246.97],
  [-2330.09, 2246.39],
  [-2334.69, 2243.83],
  [-2361.41, 2207.57],
  [-2365.66, 2194.44],
  [-2360.12, 2163.73],
  [-2298.2, 2114.76],
  [-2278.46, 2100.14]
] as const;

export const TEA_GARDEN_BOUNDS = {
  minX: -2365.66,
  maxX: -2218.05,
  minZ: 2100.14,
  maxZ: 2246.97
} as const;

function distanceToSegment(x: number, z: number, a: TeaGardenXZ, b: TeaGardenXZ): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSq)) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

export function pointInTeaGardenPolygon(x: number, z: number, polygon: readonly TeaGardenXZ[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    const crosses = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function inJapaneseTeaGarden(x: number, z: number, pad = 0): boolean {
  if (pointInTeaGardenPolygon(x, z, TEA_GARDEN_OUTLINE)) return true;
  if (pad <= 0) return false;
  for (let i = 0; i < TEA_GARDEN_OUTLINE.length; i++) {
    if (distanceToSegment(x, z, TEA_GARDEN_OUTLINE[i], TEA_GARDEN_OUTLINE[(i + 1) % TEA_GARDEN_OUTLINE.length]) <= pad) {
      return true;
    }
  }
  return false;
}

export type TeaGardenBuildingKind =
  | "tea-house"
  | "gift-shop"
  | "pagoda"
  | "temple-gate"
  | "south-gate"
  | "hagiwara-gate"
  | "turnstile-house";

export type TeaGardenBuildingSpec = {
  kind: TeaGardenBuildingKind;
  name: string;
  outline: readonly TeaGardenXZ[];
  yaw: number;
};

/** Mapped real footprints. Custom architecture replaces every baked prism. */
export const TEA_GARDEN_BUILDINGS: readonly TeaGardenBuildingSpec[] = [
  {
    kind: "tea-house",
    name: "Tea House",
    yaw: 0.612,
    outline: [
      [-2277.08, 2167.5],
      [-2270.41, 2162.83],
      [-2266.05, 2168.96],
      [-2272.72, 2173.64]
    ]
  },
  {
    kind: "gift-shop",
    name: "Gift Shop",
    yaw: -0.884,
    outline: [
      [-2273.65, 2153.03],
      [-2268.89, 2149.12],
      [-2265.67, 2153.01],
      [-2270.42, 2156.91]
    ]
  },
  {
    kind: "pagoda",
    name: "Five-story Pagoda",
    yaw: -0.383,
    outline: [
      [-2328.11, 2201.4],
      [-2325.02, 2193.79],
      [-2316.8, 2197.07],
      [-2319.89, 2204.68]
    ]
  },
  {
    kind: "temple-gate",
    name: "Temple Gate",
    yaw: -0.403,
    outline: [
      [-2317.87, 2216.2],
      [-2314.89, 2217.5],
      [-2311.8, 2218.83],
      [-2309.73, 2214.12],
      [-2312.87, 2212.76],
      [-2315.81, 2211.5]
    ]
  },
  {
    kind: "south-gate",
    name: "South Gate",
    yaw: 0.771,
    outline: [
      [-2274.49, 2243.72],
      [-2270.89, 2247.38],
      [-2268.79, 2245.34],
      [-2263.98, 2240.66],
      [-2267.57, 2237]
    ]
  },
  {
    kind: "hagiwara-gate",
    name: "Hagiwara Gate",
    yaw: 2.356,
    outline: [
      [-2252.14, 2186.15],
      [-2247.18, 2191.07],
      [-2245.02, 2188.95],
      [-2242.34, 2186.26],
      [-2247.3, 2181.34],
      [-2249.1, 2183.18],
      [-2250.89, 2184.98]
    ]
  },
  {
    kind: "turnstile-house",
    name: "West Turnstile House",
    yaw: 2.57,
    outline: [
      [-2354.77, 2171.98],
      [-2350.6, 2174.6],
      [-2347.14, 2169.16],
      [-2351.31, 2166.54]
    ]
  }
] as const;

/** Baked tile/citygen identities for the mapped structures above. */
export const TEA_GARDEN_SUPPRESSED_BUILDINGS: readonly { key: string; index: number }[] = [
  { key: "6_13", index: 1 },
  { key: "6_13", index: 2 },
  { key: "6_13", index: 3 },
  { key: "6_13", index: 4 },
  { key: "6_13", index: 5 },
  { key: "6_13", index: 217 },
  { key: "6_13", index: 222 }
] as const;

const TEA_GARDEN_BUILDING_IDS = new Set(TEA_GARDEN_SUPPRESSED_BUILDINGS.map((b) => `${b.key}:${b.index}`));

export function isTeaGardenBuilding(key: string, index: number): boolean {
  return TEA_GARDEN_BUILDING_IDS.has(`${key}:${index}`);
}

export type TeaGardenPath = {
  name: string;
  kind: "path" | "steps" | "bridge";
  width: number;
  points: readonly TeaGardenXZ[];
};

/** Current principal footways, simplified only where OSM ways continue outside the gate. */
export const TEA_GARDEN_PATHS: readonly TeaGardenPath[] = [
  {
    name: "tea-house north loop",
    kind: "path",
    width: 1.65,
    points: [
      [-2286.68, 2173.27], [-2279.27, 2171.25], [-2279.25, 2164.6], [-2275.49, 2161.61],
      [-2271.37, 2158.33], [-2269.81, 2157.09], [-2267.93, 2155.6]
    ]
  },
  {
    name: "west upper loop",
    kind: "path",
    width: 1.65,
    points: [
      [-2310.28, 2195.89], [-2316.53, 2192.62], [-2321.61, 2191.44], [-2324.55, 2189.35],
      [-2326.82, 2184.1], [-2331.35, 2181.11], [-2334.37, 2175.1]
    ]
  },
  {
    name: "central promenade",
    kind: "path",
    width: 1.75,
    points: [
      [-2331.35, 2181.11], [-2334.37, 2187.11], [-2334.37, 2196.86], [-2336.44, 2201.38],
      [-2338.15, 2205.11], [-2342.17, 2208], [-2348.72, 2206.61], [-2351.74, 2200.61],
      [-2347.21, 2190.86], [-2340.41, 2181.11], [-2334.37, 2175.1], [-2332.1, 2168.35],
      [-2323.8, 2160.85], [-2314.74, 2155.6], [-2304.28, 2148.95], [-2300.22, 2148.14],
      [-2293.73, 2149.41], [-2292.32, 2152.15], [-2293.02, 2156.71]
    ]
  },
  {
    name: "east upper walk",
    kind: "path",
    width: 1.65,
    points: [
      [-2240.99, 2156.98], [-2246.03, 2151.1], [-2248.81, 2142.37], [-2250.62, 2139.78],
      [-2253.17, 2138.72], [-2255.57, 2138.79], [-2257.61, 2140.13], [-2258.88, 2144.86],
      [-2257.71, 2149.34], [-2267.93, 2155.6]
    ]
  },
  {
    name: "east garden loop",
    kind: "path",
    width: 1.65,
    points: [
      [-2273.11, 2189.91], [-2271.32, 2188.76], [-2270.05, 2186.11], [-2277.21, 2178.46],
      [-2270.95, 2176.94], [-2260.98, 2179.29], [-2254.08, 2183.62], [-2250.89, 2184.98]
    ]
  },
  {
    name: "pagoda approach",
    kind: "path",
    width: 1.65,
    points: [
      [-2312.87, 2212.76], [-2314.12, 2210.81], [-2310.35, 2204.09], [-2307.94, 2197.6],
      [-2308.85, 2197.28], [-2310.28, 2195.89]
    ]
  },
  {
    name: "south pond walk",
    kind: "path",
    width: 1.65,
    points: [
      [-2307.07, 2226.26], [-2307.4, 2229.55], [-2309.77, 2234.69], [-2303.92, 2232.26],
      [-2299.87, 2231.52], [-2296.07, 2231.31], [-2292.28, 2232.83], [-2288.02, 2235.93],
      [-2283.27, 2238.01], [-2279.69, 2238.74], [-2277.3, 2234.84], [-2275.52, 2232.39],
      [-2274.96, 2226.75], [-2271.19, 2223], [-2272.43, 2219.39], [-2278.98, 2214.49],
      [-2283.08, 2210.27], [-2285.38, 2204.02], [-2288.65, 2199.15], [-2288.12, 2196.17],
      [-2283.6, 2196.81], [-2274.81, 2196.14]
    ]
  },
  {
    name: "west perimeter walk",
    kind: "path",
    width: 1.65,
    points: [
      [-2363.67, 2163.42], [-2366.52, 2171.81], [-2368.79, 2181.57], [-2369.71, 2189.21],
      [-2370.42, 2194.2], [-2369.67, 2199.42], [-2363.11, 2209.58], [-2341.75, 2240.38],
      [-2340.08, 2244.97]
    ]
  },
  {
    name: "pond spine",
    kind: "path",
    width: 1.65,
    points: [
      [-2292.84, 2190.86], [-2291.95, 2193.28], [-2291.92, 2195.73], [-2292.43, 2198.03],
      [-2295.27, 2202.17], [-2297.71, 2206.78], [-2299.23, 2208.64], [-2297.53, 2210.76],
      [-2294.73, 2215], [-2293.53, 2218.51], [-2292.33, 2221.54], [-2294.68, 2222.76],
      [-2297.61, 2222.29], [-2300.88, 2222.57], [-2304.61, 2223.26], [-2307.07, 2226.26]
    ]
  },
  {
    name: "north central loop",
    kind: "path",
    width: 1.65,
    points: [
      [-2271.37, 2158.33], [-2277.09, 2150.94], [-2281.45, 2153.37], [-2285.47, 2155.97],
      [-2293.02, 2156.71], [-2296.61, 2157.85], [-2301.76, 2158.14], [-2304.78, 2161.89],
      [-2304.94, 2166.16], [-2304.72, 2170.03], [-2303.96, 2175.12], [-2303.37, 2181.75]
    ]
  },
  {
    name: "tea pond walk",
    kind: "path",
    width: 1.65,
    points: [
      [-2271.32, 2188.76], [-2267.89, 2192.78], [-2263.29, 2193.28], [-2260.4, 2192.46],
      [-2257.92, 2190.81], [-2258.86, 2188.24], [-2254.08, 2183.62]
    ]
  },
  {
    name: "peace lantern walk",
    kind: "path",
    width: 1.65,
    points: [[-2336.44, 2201.38], [-2322.22, 2208.91], [-2314.12, 2210.81]]
  },
  {
    name: "pagoda terrace",
    kind: "path",
    width: 1.65,
    points: [[-2324.55, 2189.35], [-2316.96, 2183.44], [-2310.77, 2181.27], [-2303.37, 2181.75]]
  },
  {
    name: "central connector",
    kind: "path",
    width: 1.65,
    points: [[-2303.37, 2181.75], [-2296.26, 2186.5], [-2294.45, 2188.15], [-2292.84, 2190.86]]
  },
  {
    name: "long bridge",
    kind: "bridge",
    width: 2.1,
    points: [[-2294.52, 2176.78], [-2307.31, 2191.23]]
  },
  {
    name: "pagoda plaza stairs",
    kind: "steps",
    width: 1.45,
    points: [[-2301.24, 2207.28], [-2304.64, 2205.94], [-2310.35, 2204.09]]
  },
  {
    name: "temple gate steps",
    kind: "steps",
    width: 1.45,
    points: [[-2314.89, 2217.5], [-2312.87, 2212.76]]
  }
] as const;

export function distanceToTeaGardenPaths(x: number, z: number): number {
  let best = Infinity;
  for (const path of TEA_GARDEN_PATHS) {
    for (let i = 0; i + 1 < path.points.length; i++) {
      best = Math.min(best, distanceToSegment(x, z, path.points[i], path.points[i + 1]) - path.width * 0.5);
    }
  }
  return best;
}

/** Main south pond, OSM way 409163924. */
export const SOUTH_POND_OUTLINE: readonly TeaGardenXZ[] = [
  [-2294.61, 2207.17], [-2290.48, 2199.32], [-2288.3, 2202.19], [-2284.94, 2207.99],
  [-2284.14, 2211.51], [-2281.28, 2214.8], [-2277.27, 2217.72], [-2273.96, 2221],
  [-2275.68, 2224.57], [-2279.69, 2229.67], [-2280.45, 2233.02], [-2283.17, 2236.47],
  [-2286.53, 2233.31], [-2291.6, 2230.84], [-2296.56, 2230.2], [-2300.16, 2230.73],
  [-2306, 2232.14], [-2306.29, 2229.03], [-2302.58, 2225.74], [-2298.44, 2224.69],
  [-2291.13, 2224.82], [-2288.95, 2222.47], [-2289.89, 2218.19], [-2293.49, 2212.27]
] as const;

/**
 * Narrow connected stream beneath the Drum Bridge. The official visitor map
 * shows this water joining the mapped south pond, but OSM does not carry a
 * separate polygon. This conservative trace follows the visible channel and
 * deliberately stays out of the mapped circulation loops and Pagoda Plaza.
 */
export const DRUM_BRIDGE_STREAM_OUTLINE: readonly TeaGardenXZ[] = [
  [-2292.1, 2201.1], [-2288.4, 2198.1], [-2283.8, 2196.4], [-2279.2, 2195.5],
  [-2276.3, 2193.5], [-2274.5, 2189.7], [-2272.5, 2188.1], [-2269.2, 2187.4],
  [-2266.7, 2185.7], [-2264.2, 2183.2], [-2262.5, 2181.9], [-2261.1, 2183.4],
  [-2263.2, 2186], [-2265.8, 2188.2], [-2268.4, 2189.2], [-2271.1, 2190.5],
  [-2272.7, 2193.7], [-2274.5, 2197], [-2278.4, 2198.1], [-2282.9, 2198.9],
  [-2286.8, 2200.5], [-2290.1, 2203.1]
] as const;

export const TEA_GARDEN_WATER_FEATURES: readonly {
  name: string;
  outline: readonly TeaGardenXZ[];
}[] = [
  { name: "South pond", outline: SOUTH_POND_OUTLINE },
  { name: "Drum Bridge stream", outline: DRUM_BRIDGE_STREAM_OUTLINE }
] as const;

export function inTeaGardenWater(x: number, z: number, pad = 0): boolean {
  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    if (pointInTeaGardenPolygon(x, z, feature.outline)) return true;
    if (pad <= 0) continue;
    for (let i = 0; i < feature.outline.length; i++) {
      if (distanceToSegment(x, z, feature.outline[i], feature.outline[(i + 1) % feature.outline.length]) <= pad) {
        return true;
      }
    }
  }
  return false;
}

/** Matches the shallow-water simulation lattice in waterSimulation.ts. */
export const TEA_GARDEN_WATER_GRID_WIDTH = 224;
export const TEA_GARDEN_WATER_GRID_HEIGHT = 272;
const TEA_GARDEN_WATER_BOUNDS_PAD = 0.36;

/** Distance to nearest authored water feature edge (0 when inside). */
export function teaGardenWaterDistance(x: number, z: number): number {
  if (inTeaGardenWater(x, z)) return 0;
  let distance = Infinity;
  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    for (let i = 0; i < feature.outline.length; i++) {
      distance = Math.min(
        distance,
        distanceToSegment(x, z, feature.outline[i], feature.outline[(i + 1) % feature.outline.length])
      );
    }
  }
  return distance;
}

/**
 * Spatial-bin layout shared by the GPU water field and the debug overlay.
 * Bounds/pad/grid must stay in lockstep with waterSimulation.ts.
 */
export function teaGardenWaterSpatialLayout() {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    for (const [x, z] of feature.outline) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  minX -= TEA_GARDEN_WATER_BOUNDS_PAD;
  maxX += TEA_GARDEN_WATER_BOUNDS_PAD;
  minZ -= TEA_GARDEN_WATER_BOUNDS_PAD;
  maxZ += TEA_GARDEN_WATER_BOUNDS_PAD;
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    gridWidth: TEA_GARDEN_WATER_GRID_WIDTH,
    gridHeight: TEA_GARDEN_WATER_GRID_HEIGHT,
    cellSizeX: (maxX - minX) / (TEA_GARDEN_WATER_GRID_WIDTH - 1),
    cellSizeZ: (maxZ - minZ) / (TEA_GARDEN_WATER_GRID_HEIGHT - 1),
    outlines: TEA_GARDEN_WATER_FEATURES.map((f) => f.outline)
  };
}

export function inTeaGardenBuilding(x: number, z: number, pad = 0): boolean {
  for (const building of TEA_GARDEN_BUILDINGS) {
    if (pointInTeaGardenPolygon(x, z, building.outline)) return true;
    if (pad > 0) {
      for (let i = 0; i < building.outline.length; i++) {
        if (distanceToSegment(x, z, building.outline[i], building.outline[(i + 1) % building.outline.length]) <= pad) return true;
      }
    }
  }
  return false;
}

export type TeaGardenTreeKind = "pine" | "maple" | "cherry";
export type TeaGardenTreePlacement = { x: number; z: number; kind: TeaGardenTreeKind; scale: number; yaw: number };

/** Mapped specimen anchors (OSM nodes), classified into the garden's visible plant vocabulary. */
export const TEA_GARDEN_TREES: readonly TeaGardenTreePlacement[] = [
  { x: -2265.9, z: 2222.1, kind: "cherry", scale: 0.82, yaw: 0.2 },
  { x: -2271.7, z: 2210.8, kind: "maple", scale: 0.95, yaw: 1.2 },
  { x: -2262.2, z: 2214, kind: "pine", scale: 0.92, yaw: 2.4 },
  { x: -2274.9, z: 2253.1, kind: "cherry", scale: 0.9, yaw: 3.1 },
  { x: -2305.4, z: 2236.7, kind: "pine", scale: 1.12, yaw: 0.8 },
  { x: -2329.1, z: 2232.3, kind: "maple", scale: 1.05, yaw: 4.1 },
  { x: -2324, z: 2222.2, kind: "pine", scale: 1.08, yaw: 2.9 },
  { x: -2341, z: 2226.7, kind: "cherry", scale: 0.95, yaw: 1.7 },
  { x: -2348.4, z: 2234.3, kind: "pine", scale: 1.2, yaw: 0.4 },
  { x: -2228, z: 2164.7, kind: "cherry", scale: 0.88, yaw: 5.2 },
  { x: -2227.8, z: 2159.2, kind: "maple", scale: 0.9, yaw: 2.1 },
  { x: -2241.3, z: 2177.8, kind: "pine", scale: 1.05, yaw: 1.4 },
  { x: -2244.2, z: 2169.2, kind: "maple", scale: 0.86, yaw: 4.8 },
  { x: -2284.8, z: 2192.7, kind: "maple", scale: 0.92, yaw: 3.7 },
  { x: -2272.1, z: 2180.2, kind: "cherry", scale: 0.82, yaw: 0.9 },
  { x: -2276.1, z: 2174.3, kind: "maple", scale: 0.86, yaw: 5.6 },
  { x: -2261.3, z: 2164.1, kind: "pine", scale: 1.02, yaw: 2.7 },
  { x: -2286.8, z: 2167.1, kind: "pine", scale: 1.1, yaw: 4.5 },
  { x: -2278.7, z: 2186.7, kind: "maple", scale: 0.94, yaw: 1.8 },
  { x: -2287.3, z: 2185.9, kind: "pine", scale: 0.96, yaw: 3.3 },
  { x: -2354.6, z: 2208.2, kind: "pine", scale: 1.25, yaw: 0.5 },
  { x: -2317.6, z: 2178.3, kind: "cherry", scale: 0.9, yaw: 2.2 },
  { x: -2263.9, z: 2147.6, kind: "maple", scale: 0.9, yaw: 5.1 },
  { x: -2282.9, z: 2179.7, kind: "maple", scale: 0.85, yaw: 3.9 },
  { x: -2255.1, z: 2160.5, kind: "pine", scale: 1.04, yaw: 0.6 },
  { x: -2285.8, z: 2159.8, kind: "pine", scale: 1.08, yaw: 2.6 },
  { x: -2301.7, z: 2161.4, kind: "cherry", scale: 0.88, yaw: 4.2 },
  { x: -2298.6, z: 2143.5, kind: "maple", scale: 0.96, yaw: 1.1 },
  { x: -2336.4, z: 2171.2, kind: "pine", scale: 1.18, yaw: 3.4 },
  { x: -2328, z: 2154.4, kind: "pine", scale: 1.13, yaw: 5.4 },
  { x: -2327.8, z: 2145.8, kind: "cherry", scale: 1, yaw: 2.5 },
  { x: -2283.2, z: 2139.5, kind: "maple", scale: 0.92, yaw: 4.7 },
  { x: -2293.3, z: 2144.8, kind: "pine", scale: 1.05, yaw: 0.1 },
  { x: -2341.9, z: 2210.1, kind: "pine", scale: 1.2, yaw: 1.6 },
  { x: -2346.3, z: 2196.1, kind: "maple", scale: 0.98, yaw: 3.8 },
  { x: -2240.2, z: 2182.4, kind: "cherry", scale: 0.84, yaw: 5.8 }
] as const;

export const GUIDE_HOME = { x: -2278.7, z: 2170.6, heading: 1.57 } as const;

export type TeaGardenTourStopId = "tea-house" | "drum-bridge" | "pagoda-pines" | "dry-landscape" | "survivor-ginkgoes";

export type TeaGardenTourStop = {
  id: TeaGardenTourStopId;
  title: string;
  x: number;
  z: number;
  guideX: number;
  guideZ: number;
  route: readonly TeaGardenXZ[];
};

/** Walkable guide route. Stops follow the mapped path network and avoid ponds. */
export const TEA_GARDEN_TOUR_STOPS: readonly TeaGardenTourStop[] = [
  {
    id: "tea-house",
    title: "Tea House & the Hagiwaras",
    x: -2271.6,
    z: 2168.2,
    guideX: -2279.1,
    guideZ: 2171,
    route: [[-2279.1, 2171]]
  },
  {
    id: "drum-bridge",
    title: "Drum Bridge",
    x: -2274,
    z: 2193,
    guideX: -2280,
    guideZ: 2195,
    route: [[-2286.7, 2173.3], [-2283.6, 2182.2], [-2277.5, 2187.8], [-2280, 2195]]
  },
  {
    id: "pagoda-pines",
    title: "Pagoda Plaza & Black Pines",
    x: -2323,
    z: 2199,
    guideX: -2310.6,
    guideZ: 2196,
    route: [[-2288.1, 2196.2], [-2292.8, 2190.9], [-2303.4, 2181.8], [-2310.8, 2181.3], [-2316.5, 2192.6], [-2310.6, 2196]]
  },
  {
    id: "dry-landscape",
    title: "Dry Landscape Garden",
    x: -2344,
    z: 2166.5,
    guideX: -2335.5,
    guideZ: 2174.5,
    route: [[-2316.5, 2192.6], [-2324.6, 2189.4], [-2331.4, 2181.1], [-2335.5, 2174.5]]
  },
  {
    id: "survivor-ginkgoes",
    title: "Hiroshima-descendant Ginkgoes",
    x: -2308.6,
    z: 2209.2,
    guideX: -2313.5,
    guideZ: 2205.6,
    route: [[-2334.4, 2187.1], [-2324.6, 2189.4], [-2316.5, 2192.6], [-2310.3, 2204.1], [-2313.5, 2205.6]]
  }
] as const;
