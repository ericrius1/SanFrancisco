// Shared deterministic placement helpers for scattered ground cover.
//
// Grass and flowers both want the SAME world-seeded value noise plus a cheap
// Voronoi/worley clustering primitive, so their placement is coherent and
// reproducible anywhere (a flower clump sits in the same spot every time you walk
// back). Pure math — no three, no host imports — mirroring layout.ts's discipline
// so any module (even the pure ones) can share it.
//
// `worleyClump` is the engine behind the flowers' clump↔scatter knob and follows
// the "False Earth" article's Voronoi-clustering idea: instead of an even sprinkle,
// each point asks "which clump centre owns me, and how close am I?" — near a centre
// you get a dense same-species patch, far from every centre you get sparse singles.

/** 32-bit integer hash → [0,1). Same recipe the garden/wildlands layouts use. */
export function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0,1] on a `cell`-metre lattice. */
export function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell, fz = z / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ax = fx - ix, az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax), sz = az * az * (3 - 2 * az);
  const n00 = hash2(ix, iz, salt), n10 = hash2(ix + 1, iz, salt);
  const n01 = hash2(ix, iz + 1, salt), n11 = hash2(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

/** Clamped Hermite smoothstep. */
export function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

// R2 low-discrepancy (Roberts' plastic-constant) constants. `1/φ₂` and `1/φ₂²`
// where φ₂ ≈ 1.3247179572 is the plastic number — the 2-D generalisation of the
// golden ratio, and the vector that minimises 2-D lattice discrepancy.
const R2_A1 = 0.7548776662466927; // 1 / φ₂
const R2_A2 = 0.5698402909980532; // 1 / φ₂²

/**
 * Low-discrepancy per-cell offset in [0,1)², a blue-noise-ish drop-in for the
 * `hash2`-based jitter grass and flowers use to un-grid their placement.
 *
 * A raw hash gives each cell an *independent uniform* offset, so neighbouring
 * cells routinely clump (two points nearly touching) or gap (a bald patch) — the
 * variance real meadows don't have. Advancing each cell's offset by the plastic
 * vector (R2) instead makes adjacent cells step to well-separated positions, so
 * nearest-neighbour spacing tightens toward even without going regular. A small
 * hash dither keeps it from reading as a lattice. Deterministic in (gx,gz,salt),
 * and — crucially for the tile-ownership contract — always inside the unit cell.
 */
export function r2Offset(gx: number, gz: number, salt: number): { ox: number; oz: number } {
  // A hash gives each cell a distinct, decorrelated seed; folding it through the
  // plastic constants spreads those seeds as an R2 set rather than white noise.
  const h = hash2(gx, gz, salt);
  const hz = hash2(gx, gz, salt + 977);
  const ox = (gx * R2_A1 + gz * R2_A2 + h * 0.5) % 1;
  const oz = (gx * R2_A2 + gz * R2_A1 + hz * 0.5) % 1;
  return { ox: ox < 0 ? ox + 1 : ox, oz: oz < 0 ? oz + 1 : oz };
}

export type Clump = {
  /** distance (m) to the nearest clump centre */
  d: number;
  /** that centre's own hash seed in [0,1) — pick its dominant species / hue from it */
  seed: number;
};

/**
 * Nearest Voronoi/worley clump centre to (x,z). Centres live one-per-cell on a
 * `cell`-metre lattice, each jittered inside its own cell, so clumps are irregular
 * (no grid look). Searches the 3×3 neighbourhood, which is enough because a jittered
 * centre never lands more than one cell away from the point it owns. Returns the
 * distance to that centre plus its seed — small `d` ⇒ deep inside a clump.
 */
export function worleyClump(x: number, z: number, cell: number, salt: number): Clump {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  let best = Infinity;
  let seed = 0;
  for (let jz = -1; jz <= 1; jz++) {
    for (let jx = -1; jx <= 1; jx++) {
      const cxi = gx + jx, czi = gz + jz;
      const px = (cxi + hash2(cxi, czi, salt)) * cell;
      const pz = (czi + hash2(cxi, czi, salt + 101)) * cell;
      const dx = px - x, dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        seed = hash2(cxi, czi, salt + 202);
      }
    }
  }
  return { d: Math.sqrt(best), seed };
}
