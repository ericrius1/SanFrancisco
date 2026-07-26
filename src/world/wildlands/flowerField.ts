// Baked wildflower ecology — the designed placement, moved off the per-move CPU
// scatter and into the same paged foliage field the grass already streams.
//
// The ring used to re-run Voronoi clumping, twelve drift ellipses, the grassy
// ground gate and a five-tap footprint fit for every candidate cell in a 1.1 km
// disc, every nine metres of walking. That is a periodic multi-millisecond CPU
// stall on a system that is otherwise entirely GPU-resident. All of that design
// intent is unchanged — it just runs ONCE per world cell here, into a toroidal
// texture that pages a slab at a time, and GPU placement reads it per candidate.
//
// Channels (mirroring FoliageField's contract):
//   R world height
//   G keep SHAPE — clump/drift probability before the live density knob. 0 where
//     the shared ground-cover gate says nothing may grow, so it doubles as the
//     plantability bit the placement pass already tests.
//   B species + clump seed, packed as (species + seed) / 4. Read with a NEAREST
//     tap so a species id never interpolates into a neighbouring palette.
//   A base spread — the in-clump / lone-single size split.
//
// Two resolutions, because the features are metres-wide and the terrain lattice
// is 8 m: a 2.5 m near field carries the ladder out to ~200 m, and a 12 m horizon
// field carries the sparse accent band out past 700 m for a third of the cells.

import { FoliageField, type FoliageFieldPaint } from "../groundcover/foliageField";
import { hash2, smoothstep, worleyClump } from "../groundcover/scatter";
import { flowerDriftAt, grassyGround, wildRegionAt } from "./layout";
import {
  CLUMP_FLOOR,
  CLUMP_PEAK,
  CLUMP_SALT,
  DEFAULT_PALETTE_ORDER,
  EVEN_PROB,
  KEEP_CEILING,
  REGION_FLOWERS
} from "./flowerSpecies";
import type { GardenTerrain } from "../garden/layout";
import { FLOWER_TUNING } from "../../config";

/** Near ladder (hero → mid → far): ±200 m of 2.5 m ecology. */
export const FLOWER_FIELD = { size: 160, spacing: 2.5 } as const;
/** Horizon accents: ±768 m of 12 m ecology, for a third of the near field's cells. */
export const FLOWER_HORIZON_FIELD = { size: 128, spacing: 12 } as const;

export const FLOWER_FIELD_HALF_EXTENT = FLOWER_FIELD.size * FLOWER_FIELD.spacing * 0.5;
export const FLOWER_HORIZON_HALF_EXTENT =
  FLOWER_HORIZON_FIELD.size * FLOWER_HORIZON_FIELD.spacing * 0.5;

const EMPTY: FoliageFieldPaint = { density: 0, species: 0, height: 1 };

/**
 * One world cell of designed wildflower ecology. Deterministic in (x, z) and the
 * live clump tunables — the exact scatter rules the ring used to evaluate per
 * candidate, evaluated per field cell instead.
 */
export function flowerEcologyAt(
  map: GardenTerrain,
  x: number,
  z: number,
  excluded?: (x: number, z: number) => boolean
): FoliageFieldPaint {
  if (excluded?.(x, z) || !grassyGround(map, x, z)) return EMPTY;

  const tuning = FLOWER_TUNING.values;
  const clumpiness = Math.min(1, Math.max(0, Number(tuning.clumpiness)));
  const clumpSize = Math.max(2, Number(tuning.clumpSize));

  // Voronoi clumping (the "False Earth" trick): how deep this cell sits inside
  // its nearest clump centre decides both how likely a bloom is and which
  // species owns the patch, so a clump reads as one intentional stand.
  const wc = worleyClump(x, z, clumpSize * 1.7, CLUMP_SALT);
  const clumpField = smoothstep(clumpSize, 0, wc.d); // 1 at centre → 0 at rim
  const clumpyProb = CLUMP_FLOOR + (CLUMP_PEAK - CLUMP_FLOOR) * clumpField;
  const local = EVEN_PROB * (1 - clumpiness) + clumpyProb * clumpiness;

  // Designed superbloom meadows: a drift overrides the local scatter with its own
  // banded density and its dominant species. The live density knob multiplies
  // both sides on the GPU, so comparing the shapes here is equivalent to the old
  // post-density comparison.
  const drift = flowerDriftAt(x, z);
  const driftShape = drift.boost > 0 ? drift.boost * 1.6 : 0;
  const useDrift = driftShape > local;
  const shape = Math.min(KEEP_CEILING, Math.max(local, driftShape));

  const cellX = Math.round(x);
  const cellZ = Math.round(z);
  const region = wildRegionAt(x, z);
  const palette = (region && REGION_FLOWERS[region.id]) || DEFAULT_PALETTE_ORDER;
  const inClump = clumpField > 0.4;
  let species: number;
  if (useDrift && drift.species >= 0) species = drift.species;
  else if (inClump) species = palette[Math.floor(wc.seed * palette.length) % palette.length];
  else species = palette[Math.floor(hash2(cellX, cellZ, 29) * palette.length) % palette.length];

  return {
    // Species id and its clump's brightness seed share one channel; a nearest tap
    // keeps `floor` / `fract` an exact unpack.
    density: shape,
    species: (species + Math.min(0.999, wc.seed)) / 4,
    height: inClump ? 0.9 : 0.72
  };
}

export type FlowerFields = {
  near: FoliageField;
  horizon: FoliageField;
  /** Page both squares around `focus`; resolves once the near ladder is valid. */
  request(focus: { x: number; z: number }): Promise<void>;
  /** Drop both squares so the next request re-bakes them (clump tunables moved). */
  invalidate(): void;
  dispose(): void;
};

export function createFlowerFields(
  map: GardenTerrain,
  excluded?: (x: number, z: number) => boolean,
  options: {
    schedule?: (job: () => void | "again") => void;
    now?: () => number;
    sliceBudgetMs?: number;
  } = {}
): FlowerFields {
  // A world arrival waits on the near square, so it gets a bigger slice than the
  // default streaming budget: a bloom field that is still filling in when the
  // cover lifts reads as flowers appearing out of nowhere, which is the exact
  // artefact this pass exists to remove. Both squares are far smaller than the
  // blade field, so even at this budget they are not the arrival's long pole.
  const sliceBudgetMs = options.sliceBudgetMs ?? 2.5;
  const paint = (x: number, z: number) => flowerEcologyAt(map, x, z, excluded);
  const shared = {
    groundHeight: (x: number, z: number) => map.groundHeight(x, z),
    // Plantability is already folded into the painted keep shape; this fallback
    // only runs if `paint` ever returns a partial record.
    plantable: (x: number, z: number) => !excluded?.(x, z) && grassyGround(map, x, z),
    paint,
    schedule: options.schedule,
    now: options.now,
    sliceBudgetMs,
    maxCellsPerSlice: 768
  };
  const near = new FoliageField({ ...shared, ...FLOWER_FIELD });
  const horizon = new FoliageField({ ...shared, ...FLOWER_HORIZON_FIELD });

  return {
    near,
    horizon,
    request(focus) {
      // The horizon square is deliberately not awaited: it is a sparse colour
      // wash hundreds of metres out, and holding a teleport's reveal on it would
      // trade a visible stall for pixels nobody can resolve.
      void horizon.request(focus).catch(() => {});
      return near.request(focus);
    },
    invalidate() {
      near.invalidate();
      horizon.invalidate();
    },
    dispose() {
      near.dispose();
      horizon.dispose();
    }
  };
}
