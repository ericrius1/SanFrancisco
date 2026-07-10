// Shared bake for the terrain-query surface (emitted as `groundtop-delta.bin`).
//
// The RENDERED ground the player sees is NOT the raw heightfield: BOTH park lawns
// and road ribbons are separate meshes draped ABOVE the terrain (see
// build_tile_green / build_tile_roads in tools/blender_city.py). The raw
// heightfield (`heightmap.bin`) therefore sits UNDER every lawn AND every street,
// so ground raycasts (paint, cursor, walk carpet) that march it land beneath the
// visible surface and get occluded — "the paint disappears" / "the player stands
// ankle-deep in asphalt".
//
// This module exports the actual top ground surface — base terrain raised to the
// highest lawn/road covering each cell — so the runtime ray/carpet sample what's
// on screen. It is the single source of truth for that surface: the numbers below
// MUST match the mesh bake in tools/blender_city.py (PARK_LIFT + nested stagger,
// ROAD_LIFT + draped centerline heights).

export const PARK_LIFT = 0.15; // MUST match blender_city.py PARK_LIFT
export const PARK_NEST_STAGGER = 0.05; // MUST match blender_city.py `lift = PARK_LIFT + (k % 4) * 0.05`

// Road drape — MUST match build_tile_roads in tools/blender_city.py:
//   hs = max(sample_height(centerline), ROAD_MIN_H) + ROAD_LIFT
export const ROAD_LIFT = 0.3; // metres the asphalt ribbon floats over terrain
export const ROAD_MIN_H = 0.15; // floor the centerline sample never drops below
export const ROAD_SUBSTEP = 12.0; // MUST match blender_city.py ROAD_SUBSTEP (densify step)
// The runtime samples groundTops BILINEARLY between grid nodes, so a road cell
// adjacent to an un-lifted cell reads an intermediate (buried) height right at the
// asphalt edge. Pad the ribbon test by ~half a cell so the lifted band covers the
// full visible width — the paint/carpet stops sinking at kerbs. (grid cell = 8 m.)
export const ROAD_EDGE_PAD = 4.0;

/**
 * Topmost rendered ground height per grid cell.
 * @param grid   meta.grid: { cellSize, width, height, minX, minZ }
 * @param height Float32Array W*H — base terrain (heightmap.bin), row-major (gy*W+gx)
 * @param greenLists iterable of per-tile green lists; each green list is an array
 *   of polygons ([[x,z],...] game frame), enumerated in the SAME per-tile order
 *   the mesh bake uses so the k-indexed nested-lawn stagger lines up.
 * @param roadLists iterable of per-tile road lists; each road is
 *   { pts:[[x,z],...], w, bridge }. Bridge-flagged roads are SKIPPED — the bridge
 *   deck is a real solid cast separately (physics.raycastWorld); lifting groundTop
 *   under it would create a phantom floor at deck height over the water below.
 * @param opts   { roadPad } — extra metres added to each road's half-width when
 *   testing which cells the ribbon covers (default ROAD_EDGE_PAD). Set 0 to bake
 *   the bare ribbon (used by the mismatch probe to measure the un-padded surface).
 * @returns Float32Array W*H — base terrain off-surface (identity), lawn/road height on top.
 */
export function computeGroundTop(grid, height, greenLists, roadLists = [], opts = {}) {
  const { width: W, height: H, cellSize: cell, minX, minZ } = grid;
  const roadPad = opts.roadPad ?? ROAD_EDGE_PAD;
  const top = new Float32Array(height); // start = base terrain; only park/road cells rise
  for (const green of greenLists) {
    if (!green) continue;
    for (let k = 0; k < green.length; k++) {
      // nested lawns (park + playground + garden rings) drape the same terrain;
      // the mesh staggers their lift to avoid z-fight — the visible top is the
      // highest, so we max() and reproduce the same per-tile stagger here.
      rasterPoly(green[k], PARK_LIFT + (k % 4) * PARK_NEST_STAGGER, top, height, W, H, cell, minX, minZ);
    }
  }
  for (const roads of roadLists) {
    if (!roads) continue;
    for (const road of roads) {
      rasterRoad(road, top, height, W, H, cell, minX, minZ, roadPad);
    }
  }
  return top;
}

/** Raise every grid cell whose centre falls inside `poly` to base + lift (keeping
 *  the higher value where lawns overlap). Bounded to the polygon's grid AABB. */
function rasterPoly(poly, lift, top, height, W, H, cell, minX, minZ) {
  const n = poly.length;
  if (n < 3) return;
  let minx = Infinity;
  let maxx = -Infinity;
  let minz = Infinity;
  let maxz = -Infinity;
  for (const [x, z] of poly) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (z < minz) minz = z;
    if (z > maxz) maxz = z;
  }
  const gx0 = Math.max(0, Math.floor((minx - minX) / cell));
  const gx1 = Math.min(W - 1, Math.ceil((maxx - minX) / cell));
  const gy0 = Math.max(0, Math.floor((minz - minZ) / cell));
  const gy1 = Math.min(H - 1, Math.ceil((maxz - minZ) / cell));
  for (let gy = gy0; gy <= gy1; gy++) {
    const wz = minZ + gy * cell;
    for (let gx = gx0; gx <= gx1; gx++) {
      const wx = minX + gx * cell;
      if (!pointInPoly(wx, wz, poly)) continue;
      const i = gy * W + gx;
      const v = height[i] + lift;
      if (v > top[i]) top[i] = v;
    }
  }
}

/**
 * Drape one road ribbon onto `top`, matching build_tile_roads: the mesh densifies
 * the OSM centerline to <=ROAD_SUBSTEP m, drapes each point at
 * max(bilinear(terrain), ROAD_MIN_H) + ROAD_LIFT, and sweeps a flat ribbon of
 * width `w` perpendicular to the path (constant height across the ribbon, linear
 * along it). We reproduce that surface by, for every grid node within `half-width
 * + pad` of the polyline, raising it to the centerline height at the node's
 * nearest projection. Same "raise-only" max() rule the lawn raster uses.
 */
function rasterRoad(road, top, height, W, H, cell, minX, minZ, pad) {
  if (!road || road.bridge) return; // bridge decks are real solids — never lift ground under them
  const pts = road.pts;
  if (!pts || pts.length < 2) return;
  const dpts = densifyPolyline(pts, ROAD_SUBSTEP);
  const n = dpts.length;
  const testR = road.w / 2 + pad;
  const testR2 = testR * testR;
  // per-point draped heights (exactly build_tile_roads' `hs`)
  const hs = new Array(n);
  for (let i = 0; i < n; i++) {
    hs[i] = Math.max(bilinearHeight(height, W, H, cell, minX, minZ, dpts[i][0], dpts[i][1]), ROAD_MIN_H) + ROAD_LIFT;
  }
  for (let i = 0; i < n - 1; i++) {
    const ax = dpts[i][0];
    const az = dpts[i][1];
    const bx = dpts[i + 1][0];
    const bz = dpts[i + 1][1];
    const hA = hs[i];
    const hB = hs[i + 1];
    const abx = bx - ax;
    const abz = bz - az;
    const ll = abx * abx + abz * abz;
    const segMinX = Math.min(ax, bx) - testR;
    const segMaxX = Math.max(ax, bx) + testR;
    const segMinZ = Math.min(az, bz) - testR;
    const segMaxZ = Math.max(az, bz) + testR;
    const gx0 = Math.max(0, Math.floor((segMinX - minX) / cell));
    const gx1 = Math.min(W - 1, Math.ceil((segMaxX - minX) / cell));
    const gy0 = Math.max(0, Math.floor((segMinZ - minZ) / cell));
    const gy1 = Math.min(H - 1, Math.ceil((segMaxZ - minZ) / cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      const wz = minZ + gy * cell;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = minX + gx * cell;
        // project node onto the segment, clamped to its ends
        let t = ll < 1e-9 ? 0 : ((wx - ax) * abx + (wz - az) * abz) / ll;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const px = ax + t * abx;
        const pz = az + t * abz;
        const dx = wx - px;
        const dz = wz - pz;
        if (dx * dx + dz * dz > testR2) continue;
        const v = hA + t * (hB - hA);
        const idx = gy * W + gx;
        if (v > top[idx]) top[idx] = v;
      }
    }
  }
}

/** Insert points so no segment exceeds `step` metres — matches
 *  densify_polyline in blender_city.py (so the draped heights line up). */
export function densifyPolyline(pts, step = ROAD_SUBSTEP) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const segN = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / step));
    for (let s = 1; s <= segN; s++) {
      const t = s / segN;
      out.push([x1 + (x2 - x1) * t, z1 + (z2 - z1) * t]);
    }
  }
  return out;
}

/** Bilinear terrain sample in game frame — matches sample_height in
 *  blender_city.py (clamp fx,fy to [0, W-2]/[0, H-2] then lerp the 4 nodes). */
export function bilinearHeight(height, W, H, cell, minX, minZ, x, z) {
  let fx = (x - minX) / cell;
  let fy = (z - minZ) / cell;
  if (fx < 0) fx = 0;
  else if (fx > W - 2) fx = W - 2;
  if (fy < 0) fy = 0;
  else if (fy > H - 2) fy = H - 2;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const axf = fx - ix;
  const ayf = fy - iy;
  const h00 = height[iy * W + ix];
  const h10 = height[iy * W + ix + 1];
  const h01 = height[(iy + 1) * W + ix];
  const h11 = height[(iy + 1) * W + ix + 1];
  return (h00 * (1 - axf) + h10 * axf) * (1 - ayf) + (h01 * (1 - axf) + h11 * axf) * ayf;
}

/** Ray-casting point-in-polygon (handles the concave park footprints). */
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
