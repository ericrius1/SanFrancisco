// Shared bake for the terrain-query surface (emitted as `groundtop-delta.bin`).
//
// The RENDERED ground the player sees is NOT the raw heightfield: park lawns are
// separate meshes draped PARK_LIFT metres ABOVE the terrain (see build_tile_green
// in tools/blender_city.py). The raw heightfield (`heightmap.bin`) therefore sits
// UNDER every lawn, so ground raycasts (paint, cursor) that march it land beneath
// the visible grass and get occluded — "the paint disappears".
//
// This module exports the actual top ground surface — base terrain raised to the
// highest lawn covering each cell — so the runtime ray/carpet sample what's on
// screen. It is the single source of truth for that surface: the numbers below
// MUST match the mesh bake in tools/blender_city.py (PARK_LIFT + nested stagger).

export const PARK_LIFT = 0.15; // MUST match blender_city.py PARK_LIFT
export const PARK_NEST_STAGGER = 0.05; // MUST match blender_city.py `lift = PARK_LIFT + (k % 4) * 0.05`

/**
 * Topmost rendered ground height per grid cell.
 * @param grid   meta.grid: { cellSize, width, height, minX, minZ }
 * @param height Float32Array W*H — base terrain (heightmap.bin), row-major (gy*W+gx)
 * @param greenLists iterable of per-tile green lists; each green list is an array
 *   of polygons ([[x,z],...] game frame), enumerated in the SAME per-tile order
 *   the mesh bake uses so the k-indexed nested-lawn stagger lines up.
 * @returns Float32Array W*H — base terrain off-park (identity), lawn height on park.
 */
export function computeGroundTop(grid, height, greenLists) {
  const { width: W, height: H, cellSize: cell, minX, minZ } = grid;
  const top = new Float32Array(height); // start = base terrain; only park cells rise
  for (const green of greenLists) {
    if (!green) continue;
    for (let k = 0; k < green.length; k++) {
      // nested lawns (park + playground + garden rings) drape the same terrain;
      // the mesh staggers their lift to avoid z-fight — the visible top is the
      // highest, so we max() and reproduce the same per-tile stagger here.
      rasterPoly(green[k], PARK_LIFT + (k % 4) * PARK_NEST_STAGGER, top, height, W, H, cell, minX, minZ);
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
