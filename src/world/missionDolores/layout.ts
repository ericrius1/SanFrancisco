// Mission San Francisco de Asís (Mission Dolores) — the founding Franciscan
// mission that gave the city its name. We build the basilica-scale church here
// and turn its nave into a walkable museum of Saint Francis.
//
// LOCAL FRAME (every exhibit works in this frame; the root Group is positioned
// at CENTER and rotated by YAW, and lifted so local y=0 == the interior floor):
//   +x  →  toward the EAST wall  (player's right when facing the altar)
//   −x  →  toward the WEST wall
//   +z  →  toward the APSE / ALTAR (the far, sacred end)
//   −z  →  toward the ENTRANCE / narthex (where you walk in)
//    y  →  up from the floor (0 = floor)
//
// World placement: the flat lower-Mission valley near the real basilica site.

// Placed on the open north lawn of Mission Dolores Park — the park named for the
// mission, one block from the real Mission San Francisco de Asís, and free of the
// dense Mission street-grid buildings that would otherwise interpenetrate it.
export const MD_CENTER = { x: 1560, z: 3235 } as const;
export const MD_YAW = 0; // local axes align with world axes (kept as a knob)

// ---- interior envelope (metres, local) ----
export const NAVE_HALF_W = 12; // interior half-width (nave + side aisles)
export const AISLE_LINE = 8; // colonnade x — central nave is |x| < 8, aisles beyond
export const Z_ENTRANCE = -34; // inner face of the entrance (façade) wall
export const Z_APSE = 30; // inner face of the apse (altar) wall
export const APSE_RADIUS = 9; // semicircular altar niche beyond Z_APSE
export const WALL_H = 11; // side-wall height to the vault springline
export const VAULT_APEX = 14; // barrel-vault crown height (kept below the roof ridge)
export const TOWER_H = 24; // bell-tower height at the façade

// central portal (entrance) — a walkable wall gap on the −z façade
export const PORTAL_HALF_W = 3;
export const PORTAL_H = 6.5;

// exterior footprint (for the ground pad + broad-phase). Generous of the walls.
export const FOOT_HALF_W = 13.5;
export const FOOT_Z0 = -36;
export const FOOT_Z1 = 40; // includes the apse bulge

/** Museum-local → world position (accounts for CENTER + YAW; floorTop added by caller). */
export function mdToWorldXZ(lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(MD_YAW);
  const s = Math.sin(MD_YAW);
  return { x: MD_CENTER.x + lx * c + lz * s, z: MD_CENTER.z - lx * s + lz * c };
}

/** World → museum-local (XZ only). */
export function mdToLocalXZ(x: number, z: number): { lx: number; lz: number } {
  const c = Math.cos(MD_YAW);
  const s = Math.sin(MD_YAW);
  const dx = x - MD_CENTER.x;
  const dz = z - MD_CENTER.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/** True if a WORLD point lies over the church footprint (nave rectangle + apse bulge). */
export function mdInsideFootprint(x: number, z: number, pad = 0): boolean {
  const { lx, lz } = mdToLocalXZ(x, z);
  if (Math.abs(lx) <= FOOT_HALF_W + pad && lz >= FOOT_Z0 - pad && lz <= Z_APSE + pad) return true;
  // apse semicircle
  const dz = lz - Z_APSE;
  if (dz > 0 && lx * lx + dz * dz <= (APSE_RADIUS + pad) * (APSE_RADIUS + pad)) return true;
  return false;
}

// ---- exhibit zones (LOCAL rectangles) handed to each builder so they never
// overlap. x across the nave, z along it. Central dioramas stay within |x|<7
// (inboard of the x=±8 colonnade); aisle galleries hang on the outer walls. ----
export interface MdZone {
  readonly id: string;
  readonly title: string;
  /** local x range */ readonly x: readonly [number, number];
  /** local z range */ readonly z: readonly [number, number];
  readonly note: string;
}

export const MD_ZONES: Record<string, MdZone> = {
  book: {
    id: "book",
    title: "Narthex — the Canticle book on its pedestal",
    x: [-7, 7],
    z: [-32, -24],
    note: "Entrance. A pedestal on the centre line at (0, 0, -28) holds the interactive Canticle of the Creatures book."
  },
  canticleGallery: {
    id: "canticleGallery",
    title: "West aisle — Canticle of the Creatures gallery",
    x: [-12, -8.2],
    z: [-22, 12],
    note: "Plaques hang on the WEST wall (x ≈ -11.6) facing +x into the nave. Brother Sun, Sister Moon, Wind, Water, Fire, Mother Earth, All Creatures."
  },
  lifeTimeline: {
    id: "lifeTimeline",
    title: "East aisle — Life & Legacy timeline",
    x: [8.2, 12],
    z: [-22, 12],
    note: "Plaques hang on the EAST wall (x ≈ +11.6) facing -x into the nave. Birth, conversion at San Damiano, renouncing wealth, founding the order, the stigmata, death & sainthood."
  },
  birds: {
    id: "birds",
    title: "Sermon to the Birds diorama",
    x: [-7, -1],
    z: [-12, -3],
    note: "Central nave, west of centre line. A low diorama base with a flock of birds gathered around a preaching friar, and an illustrated plaque."
  },
  wolf: {
    id: "wolf",
    title: "The Wolf of Gubbio diorama",
    x: [1, 7],
    z: [-12, -3],
    note: "Central nave, east of centre line. The tamed wolf offering its paw, and an illustrated plaque telling the reconciliation story."
  },
  peacemaker: {
    id: "peacemaker",
    title: "The Peacemaker — Francis & the Sultan",
    x: [-6, 6],
    z: [2, 12],
    note: "Central nave near the altar steps. A tableau of Francis meeting Sultan al-Kamil, and an illustrated plaque."
  },
  apse: {
    id: "apse",
    title: "The Apse shrine — rose window & statue",
    x: [-8, 8],
    z: [18, 34],
    note: "The sacred far end. A backlit rose window high on the apse wall, a statue of Saint Francis on a plinth at (0, 0, 27), and soft light."
  }
} as const;
