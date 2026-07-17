// The Wave Organ — an acoustic sculpture at the tip of the Marina breakwater
// jetty, built (like the real one) from carved granite and marble salvaged from
// a demolished Victorian cemetery. Five listening pipes rise from the rubble;
// each hums a low voice driven by the tide. Keep still beside a pipe and it
// wakes; wake all five and the organ remembers its song.
//
// This module is PURE geometry + constants (no THREE, no map). The jetty spit
// itself already exists in the baked terrain (a narrow L2–L4 finger of land
// hooking NE from the Marina shore); everything here is seated on it.

import { WAVE_ORGAN_CENTER } from "./meta";

export { WAVE_ORGAN_CENTER } from "./meta";

export type XZ = { x: number; z: number };

/** One listening pipe: where it rises, which way its mouth faces (yaw, world
 *  XZ bearing of the horizontal mouth), and the voice it keeps. Notes spell a
 *  slow D-minor-9 — the same key the city's buskers keep — so the finished
 *  organ chord sits inside the world's songbook. */
export type PipeSpec = {
  x: number;
  z: number;
  /** Mouth bearing: mouth offset = (cos(yaw), sin(yaw)) on XZ. */
  yaw: number;
  /** Fundamental of the pipe's voice, Hz. */
  note: number;
  /** Pipe body lean, radians off vertical (toward the mouth). */
  lean: number;
  /** Body height from the stone collar to the elbow, metres. */
  height: number;
};

/** Five voices, rim → tip. Positions hand-seated on the L3–L4 crown of the
 *  jetty (probed from the baked heightfield). Mouths face the walk spine so a
 *  walker can put an ear to each without leaving the stones. */
export const PIPES: readonly PipeSpec[] = [
  { x: 299, z: -2031, yaw: 0.95, note: 73.42, lean: 0.16, height: 1.35 }, // D2 — the deep one
  { x: 314, z: -2040, yaw: -2.4, note: 87.31, lean: 0.22, height: 1.15 }, // F2
  { x: 319, z: -2052, yaw: 0.7, note: 110.0, lean: 0.12, height: 1.5 }, // A2
  { x: 331, z: -2060, yaw: -2.65, note: 130.81, lean: 0.26, height: 1.05 }, // C3
  { x: 336, z: -2072, yaw: -0.85, note: 164.81, lean: 0.18, height: 1.28 } // E3 — the tip pipe
] as const;

/** Ear-to-the-pipe geometry: how close counts as listening, and for how long
 *  before a voice wakes. */
export const LISTEN = {
  radius: 2.8, // m from the pipe mouth
  holdSeconds: 2.1
} as const;

/** The bronze plaque on its granite pedestal where the spit widens into the
 *  terrace — the quest's only written clue. */
export const PLAQUE = {
  x: 289,
  z: -2023,
  /** Face bearing (the reader stands on the landward side). */
  yaw: 0.88,
  reach: 4.6
} as const;

/** The tip cairn — the organ's heart, past the last pipe, where the payoff
 *  bloom is centred. */
export const HEART: XZ = { x: 338.5, z: -2075 };

/** Whole-site footprint (LOD, audio wake, site debug). Covers the terrace and
 *  the jetty walk back to shore. */
export function inWaveOrgan(x: number, z: number, pad = 0): boolean {
  const dx = x - WAVE_ORGAN_CENTER.x;
  const dz = z - WAVE_ORGAN_CENTER.z;
  const r = 95 + pad;
  return dx * dx + dz * dz < r * r;
}

// A cheap deterministic hash → 0..1 (stable across reloads, no seeded RNG).
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** The walkable spine of the jetty, shore-end → tip, traced from the baked
 *  land probe. Ruins scatter flanks this line but never blocks it. */
export const SPINE: readonly XZ[] = [
  { x: 262, z: -2012 },
  { x: 276, z: -2018 },
  { x: 290, z: -2025 },
  { x: 303, z: -2033 },
  { x: 313, z: -2043 },
  { x: 321, z: -2053 },
  { x: 329, z: -2062 },
  { x: 336, z: -2070 }
] as const;

export type StonePlacement = {
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** 0 = rough granite block, 1 = carved marble baluster (rarer). */
  kind: 0 | 1;
  /** Balusters only: tipped over on their side when true. */
  fallen: boolean;
};

/**
 * Scatter the cemetery salvage along the spit: rough granite blocks with the
 * occasional carved baluster, hugging the flanks of the walk spine. Offsets
 * stay ≥1.6 m off-spine so the walk itself is never blocked, and ≤4.2 m so
 * nothing lands in the water off the narrow crown.
 */
export function buildStonePlacements(): StonePlacement[] {
  const out: StonePlacement[] = [];
  let seed = 7;
  for (let i = 0; i < SPINE.length - 1; i++) {
    const a = SPINE[i];
    const b = SPINE[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const dirX = (b.x - a.x) / segLen;
    const dirZ = (b.z - a.z) / segLen;
    // left-hand perpendicular (bay side)
    const perpX = -dirZ;
    const perpZ = dirX;
    for (let d = 0.6; d < segLen; d += 2.1) {
      for (const side of [-1, 1] as const) {
        seed++;
        if (hash01(seed * 3.7) < 0.38) continue; // gaps keep the rubble informal
        const off = 1.6 + hash01(seed * 1.9) * 2.6;
        const along = d + (hash01(seed * 5.3) - 0.5) * 1.2;
        const kind: 0 | 1 = hash01(seed * 7.1) < 0.18 ? 1 : 0;
        out.push({
          x: a.x + dirX * along + perpX * off * side,
          z: a.z + dirZ * along + perpZ * off * side,
          yaw: hash01(seed * 2.3) * Math.PI * 2,
          scale: 0.55 + hash01(seed * 4.1) * 0.95,
          kind,
          fallen: kind === 1 && hash01(seed * 9.7) < 0.45
        });
      }
    }
  }
  return out;
}

/** The two granite listening benches on the terrace — long slabs set to face
 *  the tip, like pews for the tide. */
export const BENCHES: readonly { x: number; z: number; yaw: number }[] = [
  { x: 323, z: -2046, yaw: 0.9 },
  { x: 328, z: -2055, yaw: 0.78 }
] as const;
