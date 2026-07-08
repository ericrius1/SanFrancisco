// SF archetype classifier — the SINGLE SOURCE OF TRUTH for "which neighborhood
// style is this building." Pure geography + cheap signals, in GAME COORDINATES
// (+X east, +Z south, origin ~downtown; see tools/geo.mjs ORIGIN). Used by
// tools/export-citygen.mjs and tools/citygen-probe.mjs. The archetype id it
// returns is BAKED INTO the exported building record, so the TS runtime never
// re-classifies — it just reads the id and looks up the style spec in
// src/world/citygen/theme/archetypes.ts. That keeps the classifier in exactly
// one place (no TS/JS duplication) and keeps the runtime theme pack portable.
//
// Geography extends the district partition already validated in game coords by
// districtPalette() in tools/prepare-city.mjs (~line 242). Boxes are deliberately
// coarse and easy to tune; refine against the archetype histogram the probe
// prints. `p` is the baked palette index from city.json (districtPalette output);
// p === 6 marks OSM industrial/warehouse buildings citywide.

/** archetype ids the SF theme pack understands (excl. "tower", which is skipped). */
export const ARCHETYPES = ["victorian", "edwardian", "marina", "downtown", "soma", "chinatown"];

// Only genuinely TALL towers stay baked (Salesforce, Transamerica, big FiDi
// high-rises are bespoke landmarks). Large-but-low footprints — warehouses, big
// commercial blocks — now GENERATE (via the downtown/soma grammars, which suit
// them) instead of leaving a baked hole; only true superblocks are excluded.
export const TOWER = {
  maxHeight: 110,  // metres, roof above base — tall high-rises stay baked
  maxSpan: 145,    // metres, footprint longest axis — huge superblocks stay baked
  maxArea: 16000,  // m² — "
  minHeight: 5,    // skip sheds/garages shorter than this
  minArea: 40,     // skip tiny footprints
};

/** a large footprint reads as commercial/industrial, never a rowhouse — used to
 *  override the residential geography boxes so a big warehouse in the Mission
 *  doesn't become a giant Victorian. */
const BIG_FOOTPRINT = 2600; // m²

/** longest axis of an axis-aligned bbox of the polygon ring (metres). */
export function polySpan(poly) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  return Math.max(maxx - minx, maxz - minz);
}

/** true → leave this building baked (don't generate). */
export function isTower(b) {
  const height = (b.top ?? b.h ?? 0) - (b.base ?? 0);
  if (height > TOWER.maxHeight) return true;
  if (b.area != null && b.area > TOWER.maxArea) return true;
  if (b.poly && polySpan(b.poly) > TOWER.maxSpan) return true;
  return false;
}

/** true → too small to bother (shed, garage, artifact). */
export function isTooSmall(b) {
  const height = (b.top ?? b.h ?? 0) - (b.base ?? 0);
  if (height < TOWER.minHeight) return true;
  if (b.area != null && b.area < TOWER.minArea) return true;
  return false;
}

const inBox = (x, z, x0, x1, z0, z1) => x >= x0 && x <= x1 && z >= z0 && z <= z1;

/**
 * Classify a building to an SF archetype from its centroid (x,z), height, area
 * and baked palette index p. Deterministic — same building → same archetype on
 * every run and every client. `seed` (a hash of the OSM id) only breaks ties
 * where two styles genuinely coexist on a block (e.g. Victorian vs Edwardian).
 */
export function classify(x, z, { area = 0, height = 0, p = 0, seed = 0 } = {}) {
  // Industrial/warehouse tag survived into the palette → SoMa brick loft look,
  // wherever it is in the city.
  if (p === 6) return "soma";

  // Large footprints are commercial/industrial, not houses — route them to the
  // downtown/warehouse grammars regardless of neighborhood (a big block in a
  // Victorian district is a school/market/warehouse, not a giant rowhouse).
  if (area > BIG_FOOTPRINT) return "downtown";

  // Chinatown core (Grant/Stockton, just NW of downtown). Small box; the legacy
  // Chinatown ring still owns these today, so this only matters once citygen
  // takes them over (Phase 6). Tunable.
  if (inBox(x, z, -350, 550, -1150, -350)) return "chinatown";

  // SoMa (south of Market): SE of downtown — brick warehouses + lofts.
  if (inBox(x, z, 500, 3800, 250, 1500)) return "soma";

  // Marina / Pacific Heights band (districtPalette box). Split by latitude:
  // the Marina proper hugs the north waterfront (low z) = Mediterranean stucco;
  // Pacific Heights behind it = Victorian/Edwardian.
  if (inBox(x, z, -1600, 2300, -3000, -1100)) {
    return z < -1900 ? "marina" : "victorian";
  }

  // Mission / Castro / Haight — dense Victorian/Edwardian rowhouse fabric.
  if (inBox(x, z, -1200, 3100, 1100, 4600)) {
    // ~25% Edwardian mix so blocks aren't uniform (both coexist here IRL).
    return (seed & 3) === 0 ? "edwardian" : "victorian";
  }

  // Richmond / Sunset (far west): stucco Mediterranean rowhouses.
  if (x < -2900) return "marina";

  // Everything left = downtown / commercial mid-rise fabric.
  return "downtown";
}
