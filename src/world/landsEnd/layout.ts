// Lands End — the NW headland. A twilight coastal art-experience: a cliff-top
// stone Labyrinth you light by walking, the flooded Sutro Baths ruins stepping
// down to the sea, a wind-bent cypress grove, and a lantern-keeper with a quest.
//
// This module is PURE geometry + constants (no THREE, no map). The spiral is
// generated here so both the stone placement and the walk-progress tracker read
// from one source of truth; the arc-length parameter `t` (0 at the entrance,
// 1 at the centre) is what the bioluminescent light-wave rides.

export type XZ = { x: number; z: number };
export type PathSample = { x: number; z: number; t: number };
export type StonePlacement = { x: number; z: number; t: number; scale: number; yaw: number; side: number };

/** Headland reference point (near the labyrinth), used for distance LOD. */
export const LANDS_END_CENTER: XZ = { x: -5920, z: 760 };

/** The cliff-top labyrinth. A flat sculpted terrace on the plateau (natural
 *  ground ≈71 m there, slope ≈2°) overlooking the open ocean to the WNW. */
export const LABYRINTH = {
  x: -5890,
  z: 775,
  radius: 12, // outer radius of the walked spiral
  terraceRadius: 15, // sculpted flat pad (a little wider than the stones)
  terraceFeather: 8, // metres of blend outside the pad
  terraceY: 71.2, // flat height of the pad
  turns: 6, // spiral revolutions from rim to centre
  grooveHalf: 0.78, // half-width of the walked groove (stone border offset)
  startAngle: 0.15 * Math.PI, // rim entrance bearing (roughly ESE, landward)
  stoneSpacing: 1.05 // spacing of stones along each border line
} as const;

/** Sutro Baths ruins — a stepped concrete shelf at the toe of the bluff where
 *  it meets the sea (shoreline crosses ≈ x -6055, z 718). Filled with still,
 *  reflective pools. Placed downslope NW of the labyrinth. */
export const RUINS = {
  x: -6035,
  z: 720,
  deckY: 3.4 // top of the ruin deck, just above sea level (0)
} as const;

/** Where the lantern-keeper stands: just outside the labyrinth rim, landward. */
export const KEEPER: XZ = {
  x: LABYRINTH.x + Math.cos(LABYRINTH.startAngle) * (LABYRINTH.radius + 3.4),
  z: LABYRINTH.z + Math.sin(LABYRINTH.startAngle) * (LABYRINTH.radius + 3.4)
};

/** Whole-region footprint test (audio region, LOD, keep-out for other foliage). */
export function inLandsEnd(x: number, z: number, pad = 0): boolean {
  const dx = x - LANDS_END_CENTER.x;
  const dz = z - LANDS_END_CENTER.z;
  return dx * dx + dz * dz < (240 + pad) * (240 + pad);
}

/** Distance from the labyrinth centre (for the walk gate / prompt). */
export function distToLabyrinth(x: number, z: number): number {
  return Math.hypot(x - LABYRINTH.x, z - LABYRINTH.z);
}

export type LabyrinthPath = {
  center: XZ;
  /** Dense centreline, arc-length parameterised (t: 0 rim → 1 centre). */
  samples: PathSample[];
  /** Two stone border lines flanking the groove. */
  stones: StonePlacement[];
  /** Total centreline length in metres. */
  length: number;
};

// A cheap deterministic hash → 0..1, so stone jitter is stable across reloads
// without pulling in a seeded RNG (and independent of the cinematic PRNG).
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Build the Archimedean spiral. r(θ) = R·(1 − θ/θmax), θ ∈ [0, 2π·turns].
 * Entrance at the rim (θ=0), winding inward to the centre. Stones sit on the
 * inner/outer borders of the groove so the walker threads between two lines of
 * cobbles — the classic labyrinth read, and trivial to light by arc position.
 */
export function buildLabyrinthPath(): LabyrinthPath {
  const { x: cx, z: cz, radius: R, turns, grooveHalf, startAngle, stoneSpacing } = LABYRINTH;
  const center = { x: cx, z: cz };
  const thetaMax = Math.PI * 2 * turns;

  // 1) Dense centreline with cumulative arc length.
  const raw: { x: number; z: number; cum: number }[] = [];
  const dTheta = 0.06;
  let px = 0;
  let pz = 0;
  let cum = 0;
  for (let theta = 0; theta <= thetaMax + 1e-6; theta += dTheta) {
    const r = Math.max(0, R * (1 - theta / thetaMax));
    const phi = theta + startAngle;
    const x = cx + Math.cos(phi) * r;
    const z = cz + Math.sin(phi) * r;
    if (raw.length > 0) cum += Math.hypot(x - px, z - pz);
    raw.push({ x, z, cum });
    px = x;
    pz = z;
  }
  const length = cum || 1;
  const samples: PathSample[] = raw.map((p) => ({ x: p.x, z: p.z, t: p.cum / length }));

  // 2) March along the centreline dropping stones on both borders. The border
  // offset is radial (≈ perpendicular to the spiral tangent), giving the tidy
  // concentric-cobble look. Skip the innermost ~2 m so the centre stays open
  // for the beacon cairn.
  const stones: StonePlacement[] = [];
  let nextDist = 0;
  let hi = 0;
  for (let s = 0; s <= length; s += stoneSpacing) {
    while (hi < raw.length - 1 && raw[hi].cum < s) hi++;
    const p = raw[hi];
    const r = Math.hypot(p.x - cx, p.z - cz);
    if (r < 1.9) continue; // leave the centre clear
    const nx = (p.x - cx) / (r || 1);
    const nz = (p.z - cz) / (r || 1);
    const t = p.cum / length;
    for (const side of [-1, 1] as const) {
      const jitter = (hash01(s * 3.1 + side * 17.7) - 0.5) * 0.16;
      const off = grooveHalf + jitter;
      const hx = hash01(s * 1.7 + side * 4.2);
      stones.push({
        x: p.x + nx * off * side,
        z: p.z + nz * off * side,
        t,
        scale: 0.82 + hx * 0.8,
        yaw: hash01(s + side) * Math.PI * 2,
        side
      });
    }
    nextDist = s;
  }
  void nextDist;

  return { center, samples, stones, length };
}
