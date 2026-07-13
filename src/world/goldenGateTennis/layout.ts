// Lisa & Douglas Goldman Tennis Center -- current surveyed layout in the
// project's local metre frame (+X east, +Z south). Coordinates are converted
// from OpenStreetMap with the city bake's pinned projection:
//   x = (lon + 122.444) * 87972, z = (37.79 - lat) * 110574.
//
// Sources checked 2026-07-10:
// - Current OSM courts/building/fences/paths: https://www.openstreetmap.org/way/25309187
// - SF Rec & Park project: https://sfrecpark.org/1151/4617/Golden-Gate-Park-Tennis-Center-Renovatio
// - 2018 city site-plan presentation: https://sfrecpark.org/DocumentCenter/View/8049/
// - Built 16-tennis + five-mini-court count: https://sfrecpark.org/CivicAlerts.aspx?AID=1592&ARC=1749
// - Low, linear clubhouse design intent: https://ehdd.com/project/golden-gate-park-tennis-center/

export type GoldmanXZ = readonly [x: number, z: number];
export type GoldmanCourtKind = "tennis" | "pickleball";
export type GoldmanTennisCourtRef =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "13"
  | "16"
  | "17"
  | "18";
export type GoldmanPickleballCourtRef = "14A" | "14B" | "14C" | "14D" | "15";
export type GoldmanCourtRef = GoldmanTennisCourtRef | GoldmanPickleballCourtRef;

export type GoldmanCourtSpec = {
  ref: GoldmanCourtRef;
  kind: GoldmanCourtKind;
  x: number;
  z: number;
  /** Long-axis heading in radians, measured from world +Z toward world +X. */
  yaw: number;
  /** Painted playing-line dimensions, in metres. */
  playWidth: number;
  playLength: number;
  /** Rendered runoff/safety-pad dimensions, in metres. */
  padWidth: number;
  padLength: number;
  name?: string;
};

const deg = (degrees: number) => (degrees * Math.PI) / 180;

const tennis = (
  ref: GoldmanTennisCourtRef,
  x: number,
  z: number,
  yawDegrees: number,
  name?: string
): GoldmanCourtSpec => ({
  ref,
  kind: "tennis",
  x,
  z,
  yaw: deg(yawDegrees),
  // The OSM line polygons measure 10.97 x 23.61 m, matching a regulation
  // doubles court after survey/rounding. The surrounding green pad is authored
  // separately and deliberately compact where adjacent courts share alleys.
  playWidth: 10.97,
  playLength: 23.61,
  padWidth: 13.6,
  padLength: 27.4,
  name
});

const pickleball = (
  ref: GoldmanPickleballCourtRef,
  x: number,
  z: number,
  yawDegrees: number
): GoldmanCourtSpec => ({
  ref,
  kind: "pickleball",
  x,
  z,
  yaw: deg(yawDegrees),
  // OSM's five current line polygons resolve to the regulation 20 x 44 ft
  // rectangle. A modest runoff pad fits the actual mini-court battery.
  playWidth: 6.1,
  playLength: 13.41,
  padWidth: 8.35,
  padLength: 16.65
});

/** Exact current court centres and headings derived from the OSM line polygons. */
export const GOLDMAN_COURTS: readonly GoldmanCourtSpec[] = [
  tennis("1", -1368.74, 2250.76, 3.01),
  tennis("2", -1354.24, 2249.89, 3.01),
  tennis("3", -1339.36, 2249.11, 3.01),
  tennis("4", -1319.26, 2248.03, 3.03),
  tennis("5", -1304.39, 2247.26, 3.03),
  tennis("6", -1346.64, 2208.56, 3.03, "Taube Family Feature Court"),
  tennis("7", -1322.05, 2208.05, 3.03),
  tennis("8", -1307.55, 2207.18, 3.01, "Taube Family Championship Court"),
  tennis("9", -1292.67, 2206.4, 3.03),
  tennis("10", -1346.09, 2169.33, 3.03),
  tennis("11", -1331.21, 2168.56, 3.03),
  tennis("12", -1309.65, 2170.59, 3.01),
  tennis("13", -1294.78, 2169.82, 3.01),
  pickleball("14A", -1334.96, 2136.96, 93.22),
  pickleball("14B", -1334.62, 2145.41, 93.22),
  pickleball("14C", -1316.79, 2135.92, 93.22),
  pickleball("14D", -1316.22, 2144.31, 93.22),
  pickleball("15", -1300.17, 2139.35, 3.56),
  tennis("16", -1279.78, 2138.36, 25.15),
  tennis("17", -1266.66, 2132.14, 25.15),
  tennis("18", -1253.16, 2125.89, 25.16)
] as const;

export const GOLDMAN_TENNIS_COURTS = GOLDMAN_COURTS.filter(
  (court): court is GoldmanCourtSpec & { ref: GoldmanTennisCourtRef; kind: "tennis" } => court.kind === "tennis"
);

export const GOLDMAN_PICKLEBALL_COURTS = GOLDMAN_COURTS.filter(
  (court): court is GoldmanCourtSpec & { ref: GoldmanPickleballCourtRef; kind: "pickleball" } =>
    court.kind === "pickleball"
);

export const DEFAULT_GAMEPLAY_COURT_REF: GoldmanPickleballCourtRef = "14B";

/** Main historic center boundary (OSM way 25309187). Closing point is implicit. */
export const GOLDMAN_SITE_OUTLINE: readonly GoldmanXZ[] = [
  [-1374.06, 2269.72],
  [-1376.95, 2267.21],
  [-1380.41, 2264.09],
  [-1380.59, 2257.92],
  [-1384.31, 2248.99],
  [-1392.87, 2245.26],
  [-1394.1, 2227.58],
  [-1386.45, 2224.51],
  [-1377.47, 2213.22],
  [-1368.15, 2187.25],
  [-1364.9, 2163.6],
  [-1359.68, 2145.38],
  [-1344.48, 2132.63],
  [-1305.85, 2130.55],
  [-1295.66, 2130],
  [-1286.37, 2149.75],
  [-1286.42, 2154.25],
  [-1284.44, 2187.82],
  [-1282.81, 2221],
  [-1285.27, 2224.62],
  [-1296.38, 2225.1],
  [-1296.26, 2228.5],
  [-1294.26, 2265.63],
  [-1327.6, 2267.39],
  [-1329.03, 2267.45]
] as const;

/** The rotated three-court northeast pod is a separately surveyed OSM area. */
export const GOLDMAN_NORTHEAST_POD_OUTLINE: readonly GoldmanXZ[] = [
  [-1281.28, 2156.35],
  [-1277.66, 2157.55],
  [-1240.08, 2139.76],
  [-1238.52, 2136.05],
  [-1251.11, 2108.57],
  [-1255.9, 2106.85],
  [-1293.23, 2124.52],
  [-1294.42, 2128.62]
] as const;

export const GOLDMAN_SITE_BOUNDS = {
  minX: -1395,
  maxX: -1238,
  minZ: 2106,
  maxZ: 2271
} as const;

/** Current Taube Family Clubhouse footprint (OSM way 959594549). */
export const GOLDMAN_CLUBHOUSE_OUTLINE: readonly GoldmanXZ[] = [
  [-1358.65, 2168.8],
  [-1365.07, 2167.7],
  [-1368.15, 2187.25],
  [-1376.75, 2211.21],
  [-1386.45, 2224.51],
  [-1377.68, 2227.76],
  [-1375.19, 2228.69],
  [-1360.32, 2225.95],
  [-1359.98, 2214.21],
  [-1359.18, 2187.2]
] as const;

export type GoldmanPathSpec = {
  name: string;
  width: number;
  points: readonly GoldmanXZ[];
};

/** Principal public and internal circulation from the current OSM footways. */
export const GOLDMAN_PATHS: readonly GoldmanPathSpec[] = [
  {
    name: "Bowling Green entrance walk",
    width: 4.2,
    points: [
      [-1400.71, 2240.02],
      [-1401.06, 2229.19],
      [-1379.29, 2207.93],
      [-1370.99, 2185.11]
    ]
  },
  {
    name: "south court crosswalk",
    width: 3.1,
    points: [
      [-1385.59, 2219.71],
      [-1390.31, 2225.6],
      [-1375.77, 2231.31],
      [-1332.05, 2228.83],
      [-1296.32, 2226.78],
      [-1278.44, 2225.78]
    ]
  },
  {
    name: "central court spine",
    width: 3.1,
    points: [
      [-1328.34, 2267.42],
      [-1330.64, 2228.74],
      [-1332.05, 2228.83],
      [-1334.34, 2188.67],
      [-1319.41, 2187.83],
      [-1321.47, 2151.63],
      [-1285.98, 2149.64]
    ]
  },
  {
    name: "clubhouse court link",
    width: 3,
    points: [
      [-1356.67, 2182.94],
      [-1356.29, 2189.85],
      [-1334.34, 2188.67]
    ]
  },
  {
    name: "north pickleball approach",
    width: 3,
    points: [
      [-1294.97, 2130.5],
      [-1285.98, 2149.64],
      [-1278.96, 2164.6]
    ]
  },
  {
    name: "Hippie Hill south walk",
    width: 2.8,
    points: [
      [-1400.71, 2240.02],
      [-1374.78, 2271.61],
      [-1300.47, 2268.65],
      [-1269.53, 2271.9],
      [-1232.88, 2264.14],
      [-1207.77, 2249.1]
    ]
  }
] as const;

/** Hippie Hill's current OSM park polygon, immediately east of the center. */
export const HIPPIE_HILL_OUTLINE: readonly GoldmanXZ[] = [
  [-1256.05, 2209.84],
  [-1252.2, 2204.61],
  [-1246.24, 2199.97],
  [-1234.4, 2193.31],
  [-1217.95, 2185.58],
  [-1210.55, 2182.89],
  [-1191.44, 2206.16],
  [-1172.22, 2220.55],
  [-1201.9, 2243.25],
  [-1219.35, 2257.83],
  [-1232.88, 2264.14],
  [-1249.25, 2270.19],
  [-1260.61, 2272.22],
  [-1269.53, 2271.9],
  [-1264.31, 2265.63],
  [-1259.67, 2257.3],
  [-1257.5, 2250.76],
  [-1256.08, 2241],
  [-1255.61, 2225.79],
  [-1256.64, 2216.39]
] as const;

function pointInPolygon(x: number, z: number, polygon: readonly GoldmanXZ[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x: number, z: number, a: GoldmanXZ, b: GoldmanXZ): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const ll = dx * dx + dz * dz;
  const t = ll > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / ll)) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function nearPolygon(x: number, z: number, polygon: readonly GoldmanXZ[], pad: number): boolean {
  if (pointInPolygon(x, z, polygon)) return true;
  if (pad <= 0) return false;
  for (let i = 0; i < polygon.length; i++) {
    if (distanceToSegment(x, z, polygon[i], polygon[(i + 1) % polygon.length]) <= pad) return true;
  }
  return false;
}

/** Court/building footprint exclusion for wildland trees and ground cover. */
export function inGoldmanTennisSite(x: number, z: number, pad = 0): boolean {
  return nearPolygon(x, z, GOLDMAN_SITE_OUTLINE, pad) || nearPolygon(x, z, GOLDMAN_NORTHEAST_POD_OUTLINE, pad);
}

/**
 * Wider authored-vegetation ownership zone. The wildlands collector excludes
 * generic matrix trees here, then appends the deterministic Goldman perimeter
 * and Hippie Hill slots into its unified SeedForest. Ground cover uses only the
 * tighter `inGoldmanTennisSite` exclusion so the hill stays grassy.
 */
export function inGoldmanVegetationZone(x: number, z: number): boolean {
  if (inGoldmanTennisSite(x, z, 18)) return true;
  const hx = (x + 1227) / 73;
  const hz = (z - 2228) / 59;
  return hx * hx + hz * hz < 1;
}

/** Baked generic clubhouse footprint to suppress before adding the authored pavilion. */
export const GOLDMAN_SUPPRESSED_BUILDINGS: readonly { key: string; index: number }[] = [
  { key: "7_13", index: 406 }
] as const;
