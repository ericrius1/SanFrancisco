// Turns raw OSM + DEM into game-ready data:
//   public/data/heightmap.bin       Int16 W*H terrain heights (int16 encoded, see terrain-codec.mjs)
//   public/data/groundtop-delta.bin Sparse SFGD delta for park lawns
//   public/data/surface.bin         Uint8 W*H: 0 urban, 1 park, 2 sand, 3 water
//   public/data/meta.json           grid + tiles + bridges + spawn points + terrain encoding
//   public/data/colliders/tile_X_Y.json  building OBBs for physics
//   public/data/manifest.json       tile index for streaming
//   data/city/city.json             full geometry payload for the Blender build
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { BBOX, GRID, ORIGIN, M_PER_DEG_LAT, M_PER_DEG_LON, lonLatToLocal } from "./geo.mjs";
import { decomposeFootprint, minAreaRect } from "./collider-lib.mjs";
import { computeGroundTop } from "./groundtop-lib.mjs";
import { buildRoadClearanceIndex, filterRoadOverlappingColliders } from "./road-collider-clearance.mjs";
import { encodeHeightmap, encodeGroundTopDelta } from "./terrain-codec.mjs";

const RAW = new URL("../data/raw/", import.meta.url);
const PUB = new URL("../public/data/", import.meta.url);
const CITY = new URL("../data/city/", import.meta.url);

const TILE = 800;
const TILES_X = Math.ceil((GRID.width * GRID.cellSize) / TILE);
const TILES_Z = Math.ceil((GRID.height * GRID.cellSize) / TILE);

const { width: W, height: H, cellSize: CELL, minX: MINX, minZ: MINZ } = GRID;

// ---------------------------------------------------------------- height grid

let height = null; // Float32Array, final game heights
let surface = null; // Uint8Array: 0 urban, 1 park, 2 sand, 3 water

function idx(gx, gy) {
  return gy * W + gx;
}

function sampleHeight(x, z) {
  const fx = (x - MINX) / CELL;
  const fy = (z - MINZ) / CELL;
  const ix = Math.max(0, Math.min(W - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(H - 2, Math.floor(fy)));
  const ax = Math.min(1, Math.max(0, fx - ix));
  const ay = Math.min(1, Math.max(0, fy - iy));
  const h00 = height[idx(ix, iy)];
  const h10 = height[idx(ix + 1, iy)];
  const h01 = height[idx(ix, iy + 1)];
  const h11 = height[idx(ix + 1, iy + 1)];
  return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
}

function rasterizePolygon(poly, fn) {
  // poly: [[x,z]...] local meters. Calls fn(gx,gy) for covered cells (scanline).
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, z] of poly) {
    if (z < minY) minY = z;
    if (z > maxY) maxY = z;
  }
  const gy0 = Math.max(0, Math.floor((minY - MINZ) / CELL));
  const gy1 = Math.min(H - 1, Math.ceil((maxY - MINZ) / CELL));
  for (let gy = gy0; gy <= gy1; gy++) {
    const zc = MINZ + (gy + 0.5) * CELL;
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i];
      const [x2, z2] = poly[(i + 1) % poly.length];
      if (z1 === z2) continue;
      if ((zc >= z1 && zc < z2) || (zc >= z2 && zc < z1)) {
        xs.push(x1 + ((zc - z1) / (z2 - z1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const gx0 = Math.max(0, Math.floor((xs[k] - MINX) / CELL));
      const gx1 = Math.min(W - 1, Math.ceil((xs[k + 1] - MINX) / CELL));
      for (let gx = gx0; gx <= gx1; gx++) fn(gx, gy);
    }
  }
}

async function buildHeightAndWater(pierPolys) {
  const raw = new Float32Array((await readFile(new URL("heightmap-raw.bin", RAW))).buffer);
  height = new Float32Array(raw);
  surface = new Uint8Array(W * H);

  // Water candidates: low cells. Flood fill from map edges = ocean/bay.
  const isLow = (i) => raw[i] < 0.9;
  const water = new Uint8Array(W * H);
  const queue = [];
  for (let gx = 0; gx < W; gx++) {
    for (const gy of [0, H - 1]) {
      const i = idx(gx, gy);
      if (isLow(i) && !water[i]) {
        water[i] = 1;
        queue.push(i);
      }
    }
  }
  for (let gy = 0; gy < H; gy++) {
    for (const gx of [0, W - 1]) {
      const i = idx(gx, gy);
      if (isLow(i) && !water[i]) {
        water[i] = 1;
        queue.push(i);
      }
    }
  }
  while (queue.length) {
    const i = queue.pop();
    const gx = i % W;
    const gy = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = idx(nx, ny);
      if (!water[ni] && isLow(ni)) {
        water[ni] = 1;
        queue.push(ni);
      }
    }
  }

  // Piers become walkable deck "land" at +3.4m.
  for (const poly of pierPolys) {
    rasterizePolygon(poly, (gx, gy) => {
      const i = idx(gx, gy);
      water[i] = 0;
      height[i] = 3.4;
      surface[i] = 0;
    });
  }

  // Distance-to-land (chamfer, in cells) for depth shaping + sand band.
  const INF = 1e9;
  const dist = new Float32Array(W * H).fill(INF);
  for (let i = 0; i < W * H; i++) if (!water[i]) dist[i] = 0;
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const i = idx(gx, gy);
      if (gx > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (gy > 0) dist[i] = Math.min(dist[i], dist[i - W] + 1);
      if (gx > 0 && gy > 0) dist[i] = Math.min(dist[i], dist[i - W - 1] + 1.414);
      if (gx < W - 1 && gy > 0) dist[i] = Math.min(dist[i], dist[i - W + 1] + 1.414);
    }
  }
  for (let gy = H - 1; gy >= 0; gy--) {
    for (let gx = W - 1; gx >= 0; gx--) {
      const i = idx(gx, gy);
      if (gx < W - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (gy < H - 1) dist[i] = Math.min(dist[i], dist[i + W] + 1);
      if (gx < W - 1 && gy < H - 1) dist[i] = Math.min(dist[i], dist[i + W + 1] + 1.414);
      if (gx > 0 && gy < H - 1) dist[i] = Math.min(dist[i], dist[i + W - 1] + 1.414);
    }
  }

  for (let i = 0; i < W * H; i++) {
    if (water[i]) {
      surface[i] = 3;
      // Shaped bay floor: gentle ramp from shore, keep real bathymetry when deeper.
      const ramp = -Math.min(2 + dist[i] * CELL * 0.045, 16);
      height[i] = Math.min(Math.max(raw[i], -60), ramp);
    } else {
      // Land never dips below +0.6 right at the shore.
      if (height[i] < 0.6) height[i] = 0.6;
    }
  }
  return { water, dist };
}

// ------------------------------------------------------------------ osm parse

function wayToLocal(geometry) {
  return geometry.map((g) => lonLatToLocal(g.lon, g.lat));
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

function centroid(poly) {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / poly.length, z / poly.length];
}

// minAreaRect now lives in collider-lib.mjs (shared with bake-colliders.mjs)

function hash01(n) {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const LANDMARK_NAME = /(transamerica|salesforce tower|coit tower|ferry building|sutro tower|palace of fine arts)/i;

// Hand-built landmark meshes own these parcels: drop any generic OSM building
// (named or not — annexes, building:part fragments) that reaches into the zone,
// so nothing pierces the landmark geometry.
const LANDMARK_CLEAR = [
  { x: 3680, z: 32, r: 44 }, // Transamerica Pyramid + wings
  { x: 4117, z: 33, r: 34 } // Salesforce Tower
];

function inLandmarkClear(poly, cx, cz) {
  for (const zone of LANDMARK_CLEAR) {
    const r2 = zone.r * zone.r;
    if ((cx - zone.x) ** 2 + (cz - zone.z) ** 2 < r2) return true;
    for (const [x, z] of poly) {
      if ((x - zone.x) ** 2 + (z - zone.z) ** 2 < r2) return true;
    }
  }
  return false;
}

function buildingHeight(tags, area, id) {
  const parse = (v) => {
    if (!v) return null;
    const m = String(v).match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  };
  let h = parse(tags.height) ?? parse(tags["building:height"]);
  if (h == null) {
    const levels = parse(tags["building:levels"]);
    if (levels != null) h = levels * 3.05 + 1.2;
  }
  if (h == null) {
    const j = hash01(id);
    if (area > 2200) h = 10 + j * 8;
    else if (area > 500) h = 8 + j * 7;
    else h = 7 + j * 5; // SF rowhouses: 2-3 floors
  }
  return Math.min(h, 330);
}

function districtPalette(x, z, h, tags, id) {
  const j = hash01(id * 7 + 13);
  if (h > 60) return 0; // glass tower
  const pick = (list) => list[Math.floor(j * list.length) % list.length];
  // FiDi / SOMA
  if (x > 3200 && x < 5600 && z > -1100 && z < 1500) return h > 30 ? pick([0, 8, 8]) : pick([8, 6, 7]);
  // Chinatown / North Beach
  if (x > 3100 && x < 4400 && z > -1700 && z < -300) return pick([2, 6, 7, 3]);
  // Marina / Pacific Heights
  if (x > -1600 && x < 2300 && z > -3000 && z < -1100) return pick([1, 1, 2, 5]);
  // Mission / Castro / Haight
  if (x > -1200 && x < 3100 && z > 1100 && z < 4600) return pick([3, 4, 5, 2, 1]);
  // Richmond / Sunset west
  if (x < -2900) return pick([1, 2, 5, 4]);
  if (tags.building === "industrial" || tags.building === "warehouse") return 6;
  return pick([2, 7, 8, 1]);
}

function parseBuildings(chunks, waterInfo) {
  const { water } = waterInfo;
  const wetAt = (x, z) => {
    const gx = Math.floor((x - MINX) / CELL);
    const gy = Math.floor((z - MINZ) / CELL);
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return false;
    return water[idx(gx, gy)] === 1;
  };
  let flooded = 0;
  const seen = new Set();
  // OSM double-maps many buildings: the outline way AND a multipolygon relation
  // (or building:part twins) trace the same footprint, and each extrudes into a
  // coincident shell that z-fights in game. Key on rounded centroid + area to
  // keep only the first copy of a footprint.
  const footprints = new Set();
  let dupes = 0;
  const buildings = [];
  for (const chunk of chunks) {
    for (const el of chunk.elements) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = el.tags ?? {};
      if (LANDMARK_NAME.test(tags.name ?? "")) continue;
      // Bridge pylons/anchorages are OSM-mapped as buildings but stand mid-bay
      // on pier-cleared cells, dodging the water filter; the game builds its
      // own bridge towers, so these render as floating window-lit skyscrapers.
      if (tags["bridge:support"]) continue;

      let rings = [];
      if (el.type === "way" && el.geometry?.length > 3) {
        rings = [wayToLocal(el.geometry)];
      } else if (el.type === "relation" && el.members) {
        rings = el.members
          .filter((m) => m.role === "outer" && m.geometry?.length > 3)
          .map((m) => wayToLocal(m.geometry));
      }
      for (const poly of rings) {
        if (poly.length > 3) poly.pop(); // drop closing duplicate
        const area = polygonArea(poly);
        if (area < 30) continue;
        const [cx, cz] = centroid(poly);
        if (cx < MINX || cz < MINZ || cx > MINX + W * CELL || cz > MINZ + H * CELL) continue;
        if (inLandmarkClear(poly, cx, cz)) continue;
        // OSM artifacts float in the bay: drop footprints mostly over open
        // water (pier cells were already cleared from the water mask, so
        // pier sheds and wharf buildings survive this).
        let wet = wetAt(cx, cz) ? 1 : 0;
        for (const [x, z] of poly) if (wetAt(x, z)) wet++;
        if (wet * 2 > poly.length + 1) {
          flooded++;
          continue;
        }
        const sig = `${round1(cx)},${round1(cz)},${round1(area)}`;
        if (footprints.has(sig)) {
          dupes++;
          continue;
        }
        footprints.add(sig);
        const h = buildingHeight(tags, area, el.id);
        const simplified = simplifyPoly(poly, area > 4000 ? 1.5 : 0.8);
        if (simplified.length < 3) continue;
        buildings.push({
          id: el.id,
          poly: simplified.map(([x, z]) => [round1(x), round1(z)]),
          h: round1(h),
          area,
          c: [round1(cx), round1(cz)],
          p: districtPalette(cx, cz, h, tags, el.id)
        });
      }
    }
  }
  if (flooded) console.log(`[prep] dropped ${flooded} water-flooded footprints`);
  if (dupes) console.log(`[prep] dropped ${dupes} duplicate footprints`);
  return buildings;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function simplifyPoly(poly, epsilon) {
  // Douglas-Peucker on a closed ring (approximate: run on open list).
  if (poly.length <= 4) return poly;
  const keep = new Array(poly.length).fill(false);
  keep[0] = keep[poly.length - 1] = true;
  const stack = [[0, poly.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let maxI = -1;
    const [ax, az] = poly[a];
    const [bx, bz] = poly[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = poly[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
      const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsilon) {
      keep[maxI] = true;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return poly.filter((_, i) => keep[i]);
}

const ROAD_WIDTH = {
  motorway: 19,
  trunk: 16,
  primary: 14,
  secondary: 11,
  tertiary: 9,
  residential: 7.5,
  unclassified: 7,
  living_street: 6,
  pedestrian: 4.5,
  motorway_link: 9,
  trunk_link: 8,
  primary_link: 8,
  secondary_link: 7,
  tertiary_link: 7
};

function parseRoads(json) {
  const roads = [];
  for (const el of json.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const width = ROAD_WIDTH[tags.highway];
    if (!width) continue;
    const pts = wayToLocal(el.geometry).map(([x, z]) => [round1(x), round1(z)]);
    roads.push({
      id: el.id,
      pts,
      w: width,
      major: ["motorway", "trunk", "primary"].includes(tags.highway),
      bridge: tags.bridge === "yes" || tags.bridge === "viaduct",
      name: tags.name ?? ""
    });
  }
  return roads;
}

function parseLand(json) {
  const piers = [];
  const green = [];
  const sand = [];
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const polys = [];
    if (el.type === "way" && el.geometry?.length > 3) {
      polys.push(wayToLocal(el.geometry));
    } else if (el.type === "relation" && el.members) {
      for (const m of el.members) {
        if (m.role === "outer" && m.geometry?.length > 3) polys.push(wayToLocal(m.geometry));
      }
    }
    for (const poly of polys) {
      if (poly.length > 3) poly.pop();
      if (polygonArea(poly) < 40) continue;
      const rounded = poly.map(([x, z]) => [round1(x), round1(z)]);
      if (tags.man_made === "pier") piers.push(rounded);
      else if (tags.natural === "sand" || tags.natural === "beach") sand.push(rounded);
      else if (tags.natural === "water") continue; // inland lakes: leave to terrain
      else green.push(rounded);
    }
  }
  return { piers, green, sand };
}

// -------------------------------------------------------------------- bridges

const BRIDGES = [
  {
    name: "Golden Gate Bridge",
    // south approach (Presidio) -> south tower -> north tower -> north edge
    line: [
      [-2882, -1500, 62],
      [-2947, -2289, 69],
      [-3017, -3306, 69],
      [-3110, -4640, 60],
      [-3150, -5100, 20]
    ],
    width: 24,
    towers: [
      [-2947, -2289],
      [-3017, -3306]
    ],
    towerHeight: 227,
    deckThickness: 4,
    color: "internationalOrange"
  },
  {
    name: "Bay Bridge",
    line: [
      [4680, 640, 6],
      [4830, 500, 40],
      [4953, 376, 58],
      [6862, -2267, 60],
      [7160, -2680, 60]
    ],
    width: 26,
    towers: [
      [5430, -284],
      [5910, -945],
      [6390, -1606]
    ],
    towerHeight: 158,
    deckThickness: 5,
    color: "gray"
  }
];

// ----------------------------------------------------------------------- main

async function main() {
  await mkdir(PUB, { recursive: true });
  await mkdir(new URL("colliders/", PUB), { recursive: true });
  await mkdir(CITY, { recursive: true });

  const land = parseLand(JSON.parse(await readFile(new URL("land.json", RAW), "utf8")));
  console.log(`[prep] piers ${land.piers.length}, green ${land.green.length}, sand ${land.sand.length}`);

  const waterInfo = await buildHeightAndWater(land.piers);

  // Surface classes from polys.
  for (const poly of land.green) {
    rasterizePolygon(poly, (gx, gy) => {
      const i = idx(gx, gy);
      if (surface[i] !== 3) surface[i] = 1;
    });
  }
  for (const poly of land.sand) {
    rasterizePolygon(poly, (gx, gy) => {
      const i = idx(gx, gy);
      if (surface[i] !== 3) surface[i] = 2;
    });
  }
  // Natural sand band along ocean beach: western shore land cells near water.
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const i = idx(gx, gy);
      if (surface[i] === 0 && height[i] < 6) {
        // near water?
        let nearWater = false;
        for (let d = 1; d <= 3 && !nearWater; d++) {
          if (gx - d >= 0 && surface[idx(gx - d, gy)] === 3) nearWater = true;
          if (gx + d < W && surface[idx(gx + d, gy)] === 3) nearWater = true;
        }
        if (nearWater && MINX + gx * CELL < -5200) surface[i] = 2;
      }
    }
  }

  const buildingChunks = [];
  for (let i = 0; i < 24; i++) {
    buildingChunks.push(JSON.parse(await readFile(new URL(`buildings-${i}.json`, RAW), "utf8")));
  }
  const buildings = parseBuildings(buildingChunks, waterInfo);
  console.log(`[prep] buildings ${buildings.length}`);

  const roads = parseRoads(JSON.parse(await readFile(new URL("roads.json", RAW), "utf8")));
  console.log(`[prep] roads ${roads.length}`);

  // Stamp road ribbons into the surface grid as class 4 so ground-cover (grass +
  // wildflowers, keyed on surfaceType) never plants on the asphalt. Sweep each
  // road as a width-w ribbon over land cells (0/1 only — leave water 3 + sand 2).
  // Keep this in lockstep with tools/mark-roads-surface.mjs, which patches an
  // already-baked surface.bin without a full re-bake.
  {
    const ROAD_CLASS = 4;
    const PAD = 1.5;
    let roadCells = 0;
    const stamp = (gx, gy) => {
      const i = idx(gx, gy);
      if (surface[i] === 0 || surface[i] === 1) {
        surface[i] = ROAD_CLASS;
        roadCells++;
      }
    };
    for (const r of roads) {
      if (r.bridge) continue; // elevated: don't mask the ground below
      const half = r.w / 2 + PAD;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i];
        const [bx, bz] = r.pts[i + 1];
        let dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        dx /= len; dz /= len;
        const nx = -dz, nz = dx;
        const e0 = i > 0 ? half : 0;
        const e1 = i < r.pts.length - 2 ? half : 0;
        const a0x = ax - dx * e0, a0z = az - dz * e0;
        const b0x = bx + dx * e1, b0z = bz + dz * e1;
        rasterizePolygon(
          [
            [a0x + nx * half, a0z + nz * half],
            [b0x + nx * half, b0z + nz * half],
            [b0x - nx * half, b0z - nz * half],
            [a0x - nx * half, a0z - nz * half]
          ],
          stamp
        );
      }
    }
    console.log(`[prep] road surface class → ${roadCells} cells`);
  }

  // Tile assignment.
  const tiles = new Map();
  const tileOf = (x, z) => {
    const ix = Math.max(0, Math.min(TILES_X - 1, Math.floor((x - MINX) / TILE)));
    const iz = Math.max(0, Math.min(TILES_Z - 1, Math.floor((z - MINZ) / TILE)));
    return `${ix}_${iz}`;
  };
  const tileEntry = (key) => {
    if (!tiles.has(key)) tiles.set(key, { buildings: [], roads: [], green: [], piers: [] });
    return tiles.get(key);
  };

  for (const b of buildings) {
    // ground height at footprint = min over verts (buildings dig into hills)
    let minH = Infinity;
    let maxH = -Infinity;
    for (const [x, z] of b.poly) {
      const h = sampleHeight(x, z);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    b.base = round1(minH - Math.min(maxH - minH, 4) * 0.15 - 0.3);
    b.top = round1(minH + b.h);
    tileEntry(tileOf(b.c[0], b.c[1])).buildings.push(b);
  }

  // Roads: split polylines at tile borders (coarse: chop each segment by midpoint tile).
  for (const r of roads) {
    const segsByTile = new Map();
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [x1, z1] = r.pts[i];
      const [x2, z2] = r.pts[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / 200));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const ax = x1 + (x2 - x1) * t0;
        const az = z1 + (z2 - z1) * t0;
        const bx = x1 + (x2 - x1) * t1;
        const bz = z1 + (z2 - z1) * t1;
        const key = tileOf((ax + bx) / 2, (az + bz) / 2);
        if (!segsByTile.has(key)) segsByTile.set(key, []);
        const list = segsByTile.get(key);
        const last = list[list.length - 1];
        if (last && last[last.length - 1][0] === round1(ax) && last[last.length - 1][1] === round1(az)) {
          last.push([round1(bx), round1(bz)]);
        } else {
          list.push([[round1(ax), round1(az)], [round1(bx), round1(bz)]]);
        }
      }
    }
    for (const [key, segs] of segsByTile) {
      for (const pts of segs) {
        tileEntry(key).roads.push({ pts, w: r.w, major: r.major, bridge: r.bridge });
      }
    }
  }

  for (const poly of land.green) {
    const [cx, cz] = centroid(poly);
    tileEntry(tileOf(cx, cz)).green.push(poly.map(([x, z]) => [round1(x), round1(z)]));
  }
  for (const poly of land.piers) {
    const [cx, cz] = centroid(poly);
    tileEntry(tileOf(cx, cz)).piers.push(poly.map(([x, z]) => [round1(x), round1(z)]));
  }

  // Collider files per tile.
  const manifest = { tile: TILE, tilesX: TILES_X, tilesZ: TILES_Z, minX: MINX, minZ: MINZ, tiles: {} };
  const roadClearance = buildRoadClearanceIndex(
    [...tiles.values()].flatMap((t) => t.roads.map((r) => ({ width: r.w, points: r.pts })))
  );
  let roadFilteredColliders = 0;
  for (const [key, t] of tiles) {
    // Stable per-tile building index shared by mesh (_BID attribute) + colliders.
    t.buildings.forEach((b, i) => {
      b.i = i;
    });
    const colliders = [];
    for (const b of t.buildings) {
      const rect = minAreaRect(b.poly);
      if (!rect) continue;
      // concave footprints decompose into several boxes sharing the building's
      // `i` (see collider-lib.mjs) — one rect over an L-block/stadium ring
      // turns its courtyard into an invisible wall. `vol` stays the whole
      // building's single-rect volume on every box so HP balance is unchanged.
      const vol = round1(rect.hx * rect.hz * b.h);
      for (const r of decomposeFootprint(b.poly)) {
        colliders.push({
          i: b.i,
          p: b.p,
          x: round1(r.cx),
          z: round1(r.cz),
          y: round1((b.base + b.top) / 2),
          hy: round1((b.top - b.base) / 2),
          hx: round1(Math.max(r.hx, 0.8)),
          hz: round1(Math.max(r.hz, 0.8)),
          yaw: Math.round(r.yaw * 1000) / 1000,
          vol
        });
      }
    }
    const { kept, dropped } = filterRoadOverlappingColliders(colliders, roadClearance);
    roadFilteredColliders += dropped.length;
    await writeFile(new URL(`colliders/tile_${key}.json`, PUB), JSON.stringify(kept));
    manifest.tiles[key] = {
      b: t.buildings.length,
      r: t.roads.length,
      g: t.green.length,
      p: t.piers.length
    };
  }

  await writeFile(new URL("manifest.json", PUB), JSON.stringify(manifest));

  // int16 heightmap: halves the file size (13 MB → 6.5 MB) with 2 cm precision
  const { int16: heightI16, heightBase, heightQuant } = encodeHeightmap(height);
  await writeFile(new URL("heightmap.bin", PUB), Buffer.from(heightI16.buffer));
  await writeFile(new URL("surface.bin", PUB), Buffer.from(surface.buffer));

  // rendered top-ground surface (base terrain + draped park lawns) as a sparse
  // delta — only park cells differ from base terrain (~1–2 MB vs 13 MB float32).
  // See groundtop-lib.mjs + terrain-codec.mjs.
  const groundTop = computeGroundTop(GRID, height, [...tiles.values()].map((t) => t.green || []));
  const groundTopDelta = encodeGroundTopDelta(height, groundTop);
  await writeFile(new URL("groundtop-delta.bin", PUB), groundTopDelta);
  console.log(`[prep] heightmap: ${(height.buffer.byteLength / 1e6).toFixed(1)}MB float32 → ${(heightI16.byteLength / 1e6).toFixed(1)}MB int16`);
  console.log(`[prep] groundtop-delta.bin: ${(groundTopDelta.byteLength / 1e3).toFixed(1)}KB (was ${(groundTop.buffer.byteLength / 1e6).toFixed(1)}MB float32)`);

  const meta = {
    grid: GRID,
    bbox: BBOX,
    origin: ORIGIN,
    mPerDegLat: M_PER_DEG_LAT,
    mPerDegLon: M_PER_DEG_LON,
    tile: TILE,
    tilesX: TILES_X,
    tilesZ: TILES_Z,
    seaLevel: 0,
    terrain: { formatVersion: 1, heightEncoding: "int16", heightBase, heightQuant },
    bridges: BRIDGES,
    landmarks: {
      transamerica: { x: 3680, z: 32, note: "computed in blender build" },
      salesforce: { x: 4117, z: 33 },
      coit: { x: 3366, z: -1360 },
      ferry: { x: 4425, z: -608 },
      alcatraz: { x: 1848, z: -4058 },
      sutro: { x: -782, z: 3846 },
      palaceFineArts: { x: -388, z: -1426 }
    },
    spawns: {
      // Telegraph Hill just NE of Coit Tower, facing the bay into the sunset arc
      coit: { x: 3400, z: -1390, heading: -0.5 },
      embarcadero: { x: 4340, z: -380, heading: 1.8 },
      downtown: { x: 3900, z: 200, heading: 0.5 },
      marina: { x: -700, z: -2350, heading: 0 },
      bay: { x: 3000, z: -2600, heading: 2.4 },
      // dead centre of the main span, on the deck between the two towers (y≈69)
      goldenGate: { x: -2982, z: -2798, heading: 0.07 },
      palaceFineArts: { x: -360, z: -1426, heading: 1.57 }
    }
  };
  await writeFile(new URL("meta.json", PUB), JSON.stringify(meta, null, 2));

  // Full payload for Blender.
  const cityJson = {
    meta,
    tiles: Object.fromEntries(tiles)
  };
  await writeFile(new URL("city.json", CITY), JSON.stringify(cityJson));
  const sizeMb = (JSON.stringify(cityJson).length / 1e6).toFixed(1);
  console.log(`[prep] city.json ${sizeMb}MB, tiles ${tiles.size}`);
  console.log(`[prep] filtered ${roadFilteredColliders} road-overlap collider boxes`);
  console.log("[prep] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
