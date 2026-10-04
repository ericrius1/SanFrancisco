// City parks and bay islands — botanical intent only.
//
// Golden Gate Park, the Presidio, Marin, Twin Peaks and Buena Vista already
// carry the Wildlands canopy. Everything else that is green on the map was
// bald: the Western Addition squares, Dolores Park, Washington Square, Fort
// Mason, Sutro Heights and Lincoln Park, and the two wooded islands in the
// middle of every bay view (Angel Island and Yerba Buena). This module plants
// them through the shared vegetation runtime with the same discipline as
// wildlands/layout.ts: pure, deterministic, hash-driven, no three imports, so
// identical placements rebuild anywhere and the boot chunk never sees it.
//
// Real-geography anchors: x=(lon+122.444)*87972, z=(37.79-lat)*110574.

/** spawnPoints.SUTRO_BATHS_GATE centre, inlined to keep this module import-free. */
const SUTRO_BATHS_XZ = { x: -6125, z: 1117 };

export type CityTreeKind =
  | "cypress"
  | "windswept"
  | "pine"
  | "oak"
  | "eucalyptus"
  | "redwood"
  | "palm"
  | "magnolia"
  | "cherry";

export type CityPark = {
  id: string;
  x: number;
  z: number;
  /** Planting radius (m). */
  r: number;
  /** surface.bin classes that may hold a tree (1 = park, 0 = open land). */
  classes: readonly number[];
  /** Grid pitch (m) before the min-spacing pass. */
  cell: number;
  /** Peak keep probability inside a stand. */
  density: number;
  /** Stand-noise threshold: higher leaves more open lawn/clearing. */
  standThresh: number;
  /** Weighted species mix. */
  mix: readonly (readonly [CityTreeKind, number])[];
  /** Reject ground lower than this (keeps islands off the tide line). */
  minGround?: number;
};

export type CityParkGroup = {
  id: string;
  parks: readonly CityPark[];
  /** Landscape visibility of the patch (m). */
  visibleDistance: number;
};

export type CityTreePlacement = {
  x: number;
  z: number;
  yaw: number;
  scale: number;
  kind: CityTreeKind;
};

/** Minimal terrain surface the collector needs (WorldMap satisfies it). */
export type CityParkTerrain = {
  groundHeight(x: number, z: number): number;
  surfaceType(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
  bridgeDeck(x: number, z: number): number;
};

export const CITY_PARK_GROUPS: readonly CityParkGroup[] = [
  {
    id: "city-parks-western-addition",
    visibleDistance: 950,
    parks: [
      { id: "alamo-square", x: 827, z: 1526, r: 112, classes: [1], cell: 10, density: 0.5, standThresh: 0.4,
        mix: [["pine", 0.35], ["cypress", 0.35], ["oak", 0.2], ["magnolia", 0.1]] },
      { id: "alta-plaza", x: 554, z: -133, r: 108, classes: [1], cell: 10, density: 0.5, standThresh: 0.42,
        mix: [["cypress", 0.4], ["pine", 0.35], ["oak", 0.25]] },
      { id: "lafayette-park", x: 1425, z: -166, r: 118, classes: [1], cell: 10, density: 0.55, standThresh: 0.38,
        mix: [["eucalyptus", 0.3], ["cypress", 0.35], ["pine", 0.25], ["oak", 0.1]] },
      { id: "jefferson-square", x: 1715, z: 995, r: 78, classes: [1], cell: 10, density: 0.42, standThresh: 0.45,
        mix: [["pine", 0.4], ["oak", 0.4], ["cherry", 0.2]] },
      { id: "duboce-park", x: 924, z: 2267, r: 66, classes: [1], cell: 10, density: 0.4, standThresh: 0.45,
        mix: [["oak", 0.45], ["cherry", 0.3], ["magnolia", 0.25]] }
    ]
  },
  {
    id: "city-parks-mission",
    visibleDistance: 950,
    parks: [
      // Mission Dolores Park: palms on the slope, broadleaf shade on the lawns,
      // the big open bowl left open.
      { id: "dolores-park", x: 1504, z: 3361, r: 150, classes: [1], cell: 11, density: 0.42, standThresh: 0.5,
        mix: [["palm", 0.3], ["oak", 0.25], ["magnolia", 0.2], ["cypress", 0.25]] }
    ]
  },
  {
    id: "city-parks-north-shore",
    visibleDistance: 1100,
    parks: [
      { id: "washington-square", x: 2982, z: -1194, r: 68, classes: [1], cell: 9, density: 0.45, standThresh: 0.4,
        mix: [["cypress", 0.55], ["magnolia", 0.2], ["cherry", 0.25]] },
      // Fort Mason: the Great Meadow stays open; cypress and pine wrap its rim.
      { id: "fort-mason", x: 1276, z: -1603, r: 168, classes: [1], cell: 11, density: 0.42, standThresh: 0.56,
        mix: [["cypress", 0.45], ["pine", 0.3], ["eucalyptus", 0.25]] }
    ]
  },
  {
    id: "city-parks-lincoln",
    visibleDistance: 1300,
    parks: [
      // Sutro Heights and Lincoln Park: salt-pruned Monterey cypress, the
      // coastal forest the Lands End trail threads through.
      { id: "sutro-heights", x: -5894, z: 1327, r: 150, classes: [1], cell: 10, density: 0.55, standThresh: 0.36,
        mix: [["windswept", 0.45], ["cypress", 0.35], ["pine", 0.2]] },
      { id: "lincoln-park", x: -4794, z: 608, r: 470, classes: [1], cell: 11, density: 0.5, standThresh: 0.44,
        mix: [["cypress", 0.4], ["windswept", 0.3], ["pine", 0.2], ["eucalyptus", 0.1]] }
    ]
  },
  {
    id: "angel-island-woods",
    visibleDistance: 2600,
    parks: [
      // Oak woodland on the slopes, eucalyptus and pine pockets, grass crowns
      // left open by the stand noise. The map's north edge clips the island.
      { id: "angel-island", x: 1080, z: -7920, r: 1150, classes: [0, 1], cell: 15, density: 0.34, standThresh: 0.42, minGround: 6,
        mix: [["oak", 0.42], ["eucalyptus", 0.28], ["pine", 0.18], ["redwood", 0.12]] }
    ]
  },
  {
    id: "yerba-buena-woods",
    visibleDistance: 2200,
    parks: [
      { id: "yerba-buena-island", x: 6950, z: -2211, r: 430, classes: [1], cell: 12, density: 0.42, standThresh: 0.4, minGround: 4,
        mix: [["eucalyptus", 0.5], ["pine", 0.25], ["oak", 0.25]] }
    ]
  }
];

/** Ground the Wildlands canopy or an authored site already plants. */
const KEEP_OUT: readonly { x: number; z: number; r: number }[] = [
  { x: -5890, z: 775, r: 60 }, // Lands End labyrinth plateau (its own cypress ring)
  { x: SUTRO_BATHS_XZ.x, z: SUTRO_BATHS_XZ.z, r: 150 } // the bath house owns its own planting
];

const MIN_SPACING = 6;

function hash2(ix: number, iz: number, salt: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
  const fx = x / cell - gx, fz = z / cell - gz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(gx, gz, salt), b = hash2(gx + 1, gz, salt);
  const c = hash2(gx, gz + 1, salt), d = hash2(gx + 1, gz + 1, salt);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function smoothstep(a: number, b: number, t: number): number {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

/** Height range of each kind as a scale band over its archetype. */
const KIND_SCALE: Record<CityTreeKind, readonly [number, number]> = {
  cypress: [0.8, 1.2],
  windswept: [0.75, 1.1],
  pine: [0.8, 1.2],
  oak: [0.75, 1.2],
  eucalyptus: [0.85, 1.3],
  redwood: [0.8, 1.25],
  palm: [0.85, 1.15],
  magnolia: [0.75, 1.1],
  cherry: [0.7, 1.05]
};

function pickKind(mix: CityPark["mix"], u: number): CityTreeKind {
  const total = mix.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [kind, weight] of mix) {
    acc += weight / total;
    if (u <= acc) return kind;
  }
  return mix[mix.length - 1][0];
}

function slopeOk(map: CityParkTerrain, x: number, z: number, maxDelta: number): boolean {
  if (Math.abs(map.groundHeight(x + 6, z) - map.groundHeight(x - 6, z)) > maxDelta) return false;
  return Math.abs(map.groundHeight(x, z + 6) - map.groundHeight(x, z - 6)) <= maxDelta;
}

/** Deterministic placements for one park group. */
export function collectCityParkTrees(map: CityParkTerrain, group: CityParkGroup): CityTreePlacement[] {
  const out: CityTreePlacement[] = [];
  const taken = new Set<string>();
  group.parks.forEach((park, pi) => {
    const salt = 9100 + pi * 131 + park.id.length * 7;
    const cells = Math.ceil((park.r * 2) / park.cell);
    // Species zones are large and smooth so neighbours share a species and the
    // park reads as stands, not salt-and-pepper.
    for (let iz = 0; iz <= cells; iz++) {
      for (let ix = 0; ix <= cells; ix++) {
        const x = park.x - park.r + ix * park.cell + (hash2(ix, iz, salt) - 0.5) * park.cell * 0.9;
        const z = park.z - park.r + iz * park.cell + (hash2(ix, iz, salt + 1) - 0.5) * park.cell * 0.9;
        const dn = Math.hypot(x - park.x, z - park.z) / park.r;
        if (dn > 1) continue;
        const stand = smoothstep(park.standThresh - 0.08, park.standThresh + 0.14, valueNoise(x, z, 70, salt + 2));
        if (stand <= 0) continue;
        const edge = 1 - smoothstep(0.82, 1, dn) * 0.6;
        if (hash2(ix, iz, salt + 3) > park.density * stand * edge) continue;
        if (KEEP_OUT.some((k) => (x - k.x) ** 2 + (z - k.z) ** 2 < k.r * k.r)) continue;
        if (map.isWater(x, z)) continue;
        if (!park.classes.includes(map.surfaceType(x, z))) continue;
        const ground = map.groundHeight(x, z);
        if (park.minGround !== undefined && ground < park.minGround) continue;
        if (Number.isFinite(map.bridgeDeck(x, z))) continue;
        if (!slopeOk(map, x, z, park.r > 400 ? 9.5 : 7.5)) continue;
        const key = `${Math.round(x / MIN_SPACING)}:${Math.round(z / MIN_SPACING)}`;
        if (taken.has(key)) continue;
        taken.add(key);
        const kind = pickKind(park.mix, valueNoise(x, z, 55, salt + 4) * 0.7 + hash2(ix, iz, salt + 5) * 0.3);
        const [lo, hi] = KIND_SCALE[kind];
        out.push({
          x,
          z,
          yaw: hash2(ix, iz, salt + 6) * Math.PI * 2,
          // Stand hearts grow the elders, like the Wildlands groves.
          scale: (lo + hash2(ix, iz, salt + 7) * (hi - lo)) * (1 + stand * 0.12),
          kind
        });
      }
    }
  });
  return out;
}

/** Centre and residency reach of a group (centroid + farthest planted edge). */
export function cityParkGroupBounds(group: CityParkGroup): { x: number; z: number; reach: number } {
  const n = group.parks.length;
  const x = group.parks.reduce((s, p) => s + p.x, 0) / n;
  const z = group.parks.reduce((s, p) => s + p.z, 0) / n;
  const reach = Math.max(...group.parks.map((p) => Math.hypot(p.x - x, p.z - z) + p.r));
  return { x, z, reach };
}
