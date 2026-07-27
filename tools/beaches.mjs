// The city's ocean beaches, as authored shore corridors, plus the sweep that
// stamps their dry sand into the surface grid.
//
// WHY THIS EXISTS. surface.bin's sand class normally comes from OSM
// `natural=beach|sand` polygons, but SF's ocean beaches are ALSO inside the
// GGNRA / city-park polygons that prepare-city rasterizes FIRST — so Ocean
// Beach, Baker/Marshall's and China Beach baked as class 1 green. Everything
// keyed on surfaceType then treated the sand as parkland: the wildlands grass
// gate (src/world/wildlands/layout.ts grassyGround) grew a wildflower meadow
// down to the waterline, and the clipmap painted the beach lawn-green.
//
// A corridor is a shore-hugging AABB plus `berm`, the height at which the sand
// ends — the dune line / Great Highway at Ocean Beach, the bluff toe at Baker.
// A cell is dry sand when it is land, inside a corridor, below the berm AND
// within reach of open water. The three gates are deliberately redundant: the
// berm stops a corridor that overshoots inland, and the water reach stops one
// that runs too long down the coast.
//
// NOT LISTED, on purpose: Crissy Field / East Beach, Aquatic Park and the rest
// of the bay shore already bake as class 2 from their own OSM polygons, and the
// low green immediately behind them IS lawn (Crissy meadow, Marina Green,
// Aquatic Park) that must stay planted. Lands End is rock and bluff scrub.

export const SAND_CLASS = 2;

/** Only grass-bearing land re-classes: leave water 3 and roads 4 alone. */
const RECLASSABLE = new Set([0, 1]);

export const BEACH_CORRIDORS = [
  {
    id: "ocean-beach",
    // Cliff House south to Fort Funston. Starts clear of the Sutro Baths gate
    // (centre z 1117, half-length 76), whose deck is authored ground.
    minX: -6420, maxX: -5640, minZ: 1240, maxZ: 5000,
    // The Great Highway and the dune shelf behind it sit at 8-10 m; the widest
    // stretch of sand tops out near 6.
    berm: 7,
    waterReach: 16
  },
  {
    id: "baker-marshalls",
    // The dark strip under the Presidio bluffs, from the Golden Gate's south
    // landing down to the Sea Cliff headland. Includes the Beach Pianist pad,
    // which its own meta describes as dry sand near the waterline.
    minX: -3560, maxX: -3200, minZ: -1560, maxZ: -430,
    berm: 7,
    waterReach: 10
  },
  {
    id: "china-beach",
    // A pocket cove below Sea Cliff — a couple of cells of sand, no more.
    minX: -4220, maxX: -4000, minZ: 90, maxZ: 260,
    berm: 5,
    waterReach: 8
  }
];

/**
 * Stamp every corridor's dry sand into `surface`, in place.
 *
 * @param surface   Uint8Array of W*H surface classes (0 urban, 1 green, 2 sand, 3 water, 4 road)
 * @param heightAt  (index) => terrain height in metres for that cell
 * @param grid      { width, height, cellSize, minX, minZ }
 * @returns per-corridor flip counts
 */
export function markBeachSand(surface, heightAt, grid) {
  const { width: W, height: H, cellSize: CELL, minX: MINX, minZ: MINZ } = grid;
  const idx = (gx, gy) => gy * W + gx;
  const counts = [];

  for (const beach of BEACH_CORRIDORS) {
    const gx0 = Math.max(0, Math.floor((beach.minX - MINX) / CELL));
    const gx1 = Math.min(W - 1, Math.ceil((beach.maxX - MINX) / CELL));
    const gy0 = Math.max(0, Math.floor((beach.minZ - MINZ) / CELL));
    const gy1 = Math.min(H - 1, Math.ceil((beach.maxZ - MINZ) / CELL));
    // Collect first, write after: `nearWater` reads the same grid, and flipping
    // as we go would let a freshly-stamped cell shorten a neighbour's reach.
    const hits = [];
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = idx(gx, gy);
        if (!RECLASSABLE.has(surface[i])) continue;
        if (heightAt(i) >= beach.berm) continue;
        if (!nearWater(surface, W, H, gx, gy, beach.waterReach)) continue;
        hits.push(i);
      }
    }
    for (const i of hits) surface[i] = SAND_CLASS;
    counts.push({ id: beach.id, cells: hits.length });
  }
  return counts;
}

/** Open water within `reach` cells along either axis — beaches face the sea. */
function nearWater(surface, W, H, gx, gy, reach) {
  for (let d = 1; d <= reach; d++) {
    if (gx - d >= 0 && surface[gy * W + gx - d] === 3) return true;
    if (gx + d < W && surface[gy * W + gx + d] === 3) return true;
    if (gy - d >= 0 && surface[(gy - d) * W + gx] === 3) return true;
    if (gy + d < H && surface[(gy + d) * W + gx] === 3) return true;
  }
  return false;
}
