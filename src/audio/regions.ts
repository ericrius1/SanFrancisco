// Nature region audio profiles — the one place you edit to add a soundscape.
//
// Each region maps a rectangular footprint (reused from the existing vegetation
// layout so bounds never drift out of sync) to: a mix of the four sampled beds,
// a day and a night palette of procedural voices, a baseline call density, and
// a "character" (how wind-dominated, how foggy/soft, how reverberant). The
// engine (natureSoundscape.ts) is fully generic over this list — dropping a new
// nature area in is a matter of appending one entry here.

import { BOTANICAL_GARDEN_BOUNDS } from "../world/garden/layout";
import { WILD_REGIONS } from "../world/wildlands/regions";
import type { NatureVoiceKind } from "./voices";

export type BedId = "forestBirds" | "windGrass" | "windTree" | "nightCrickets";

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

export type VoiceWeight = { kind: NatureVoiceKind; w: number };

export type NatureRegionSpec = {
  id: string;
  label: string;
  bounds: Rect;
  /** metres of smoothstep falloff outside the bounds (how gently it fades in). */
  fade: number;
  /** peak gain (0..1) of each sampled bed inside this region; missing = absent. */
  beds: Partial<Record<BedId, number>>;
  /** procedural voice palette by daylight; weights are relative pick odds. */
  day: VoiceWeight[];
  night: VoiceWeight[];
  /** baseline calls-per-minute at full influence, midday, calm wind. */
  density: number;
  character: {
    /** 0..1 how much of the bed is wind vs. wildlife — drives the wind synth. */
    windBias: number;
    /** 0..1 mist/fog softness — lowpass on the whole region. */
    fog: number;
    /** 0..1 reverberation (open canyon > enclosed garden). */
    reverb: number;
  };
  /** Optional altitude lift for exposed hills: this region's wind-synth
   *  contribution scales by 1 + boost·smoothstep(y0, y1, playerY), so climbing
   *  toward the summit gets audibly windier. Omitted = flat (no change). */
  windAltitude?: { y0: number; y1: number; boost: number };
};

const wild = (id: string): Rect => {
  const r = WILD_REGIONS.find((w) => w.id === id);
  if (!r) throw new Error(`[nature-audio] missing wild region "${id}"`);
  return { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ };
};

export const NATURE_REGIONS: NatureRegionSpec[] = [
  {
    // Lush cultivated garden inside Golden Gate Park — dense, layered birdsong.
    id: "botanical",
    label: "Botanical Garden",
    bounds: {
      minX: BOTANICAL_GARDEN_BOUNDS.minX,
      maxX: BOTANICAL_GARDEN_BOUNDS.maxX,
      minZ: BOTANICAL_GARDEN_BOUNDS.minZ,
      maxZ: BOTANICAL_GARDEN_BOUNDS.maxZ
    },
    fade: 60,
    beds: { forestBirds: 1.0, windGrass: 0.5, windTree: 0.42, nightCrickets: 1.0 },
    day: [
      { kind: "songbird", w: 4 },
      { kind: "warble", w: 3 },
      { kind: "sparrow", w: 3 },
      { kind: "dove", w: 2 },
      { kind: "bee", w: 1 }
    ],
    night: [
      { kind: "cricketChirp", w: 4 },
      { kind: "frog", w: 2 },
      { kind: "owl", w: 2 }
    ],
    density: 26,
    character: { windBias: 0.32, fog: 0.42, reverb: 0.22 }
  },
  {
    // Broad park — general songbirds, crows, wind through the meadows.
    id: "ggpark",
    label: "Golden Gate Park",
    bounds: wild("ggpark"),
    fade: 95,
    beds: { forestBirds: 0.72, windGrass: 0.8, windTree: 0.6, nightCrickets: 0.72 },
    day: [
      { kind: "songbird", w: 3 },
      { kind: "sparrow", w: 3 },
      { kind: "crow", w: 2 },
      { kind: "dove", w: 1 },
      { kind: "woodpecker", w: 1 }
    ],
    night: [
      { kind: "cricketChirp", w: 3 },
      { kind: "owl", w: 2 },
      { kind: "frog", w: 1 }
    ],
    density: 16,
    character: { windBias: 0.5, fog: 0.3, reverb: 0.3 }
  },
  {
    // Coastal cypress/eucalyptus plantation — windy, gulls and crows, foggy.
    id: "presidio",
    label: "Presidio",
    bounds: wild("presidio"),
    fade: 110,
    beds: { forestBirds: 0.5, windGrass: 0.6, windTree: 1.0, nightCrickets: 0.5 },
    day: [
      { kind: "crow", w: 3 },
      { kind: "gull", w: 3 },
      { kind: "songbird", w: 2 },
      { kind: "hawk", w: 1 },
      { kind: "woodpecker", w: 1 }
    ],
    night: [
      { kind: "owl", w: 2 },
      { kind: "cricketChirp", w: 2 },
      { kind: "foghorn", w: 1 }
    ],
    density: 12,
    character: { windBias: 0.8, fog: 0.5, reverb: 0.4 }
  },
  {
    // Wild Marin headlands — sparse, raptors and quail over golden hills, big sky.
    id: "marin",
    label: "Marin Headlands",
    bounds: wild("marin"),
    fade: 130,
    beds: { forestBirds: 0.4, windGrass: 1.0, windTree: 0.7, nightCrickets: 0.8 },
    day: [
      { kind: "hawk", w: 3 },
      { kind: "crow", w: 2 },
      { kind: "quail", w: 2 },
      { kind: "gull", w: 1 },
      { kind: "songbird", w: 1 }
    ],
    night: [
      { kind: "owl", w: 3 },
      { kind: "cricketChirp", w: 3 },
      { kind: "frog", w: 1 },
      { kind: "foghorn", w: 1 }
    ],
    density: 9,
    character: { windBias: 0.9, fog: 0.35, reverb: 0.6 }
  },
  {
    // Corona Heights — bare chaparral hilltop over the Castro: a quieter,
    // windier echo of the parks below. Sparse dry-scrub birds by day, owls and
    // crickets by night; the wind lifts noticeably toward the rocky summit.
    id: "corona",
    label: "Corona Heights",
    bounds: { minX: 292, maxX: 524, minZ: 2644, maxZ: 2892 },
    fade: 90,
    beds: { forestBirds: 0.3, windGrass: 0.9, windTree: 0.3, nightCrickets: 0.6 },
    day: [
      { kind: "sparrow", w: 3 },
      { kind: "songbird", w: 2 },
      { kind: "hawk", w: 2 },
      { kind: "crow", w: 2 },
      { kind: "quail", w: 1 }
    ],
    night: [
      { kind: "owl", w: 3 },
      { kind: "cricketChirp", w: 3 }
    ],
    density: 8,
    character: { windBias: 0.72, fog: 0.22, reverb: 0.5 },
    windAltitude: { y0: 104, y1: 158, boost: 0.55 }
  }
];

/* ---------------------------------------------------------------- pure math */

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 0 inside the rect, else the shortest distance to its border. */
export function distanceToRect(x: number, z: number, r: Rect): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/** How present a region is at (x,z): 1 inside, smoothly to 0 by `fade` metres out. */
export function regionInfluence(spec: NatureRegionSpec, x: number, z: number): number {
  const d = distanceToRect(x, z, spec.bounds);
  if (d >= spec.fade) return 0;
  return smoothstep(spec.fade, 0, d);
}
