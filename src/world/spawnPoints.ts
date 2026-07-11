// Code-level spawn registry. Baked spawns live in meta.json (map.meta.spawns);
// these sit on top of them and carry the extra per-location knobs that make a
// spawn cheap to boot: which heavy park regions must be ready when the cover
// lifts, versus which stream in afterwards while the player takes in the view.
//
// This is the abstraction the whole "optimize for a specific place" idea rests
// on: adding a great spawn is a few lines here, and its boot cost is whatever
// its own immediate surroundings cost — never the whole city's foliage.

import type { PlayerMode } from "../player/types";

/** Heavy park regions built lazily off the boot path (own Vite chunks). A spawn
 * either GATES a region (built before reveal) or lets it stream in after. */
export type RegionKey = "garden" | "wildlands" | "golf";

export const ALL_REGIONS: readonly RegionKey[] = ["garden", "wildlands", "golf"];

export type SpawnPoint = {
  key: string;
  label: string;
  x: number;
  z: number;
  /** Raw facing yaw (forward = (−sinθ, −cosθ)); the chase cam sits behind it. */
  heading: number;
  /** Embodiment to arrive in. Omit to keep the session default (START.mode). */
  mode?: PlayerMode;
  /** Regions that MUST finish before the loading cover lifts. Anything omitted
   * streams in after reveal (hidden → compileAsync → shown), so it never delays
   * first play. `undefined` = distance-based default (a region gates only when
   * the spawn sits within NEAR_GATE of its footprint). An explicit list — `[]`
   * included — overrides distance, which is how a scenic-but-treeless spot like
   * Corona Heights opts into the leanest possible boot. */
  gates?: readonly RegionKey[];
};

export const SPAWN_POINTS: Record<string, SpawnPoint> = {
  // Corona Heights summit — the busker trio on the SE rim, the dog park just
  // below, red-chert crags underfoot, and the whole downtown/Mission skyline
  // dropping away to the east. Nothing tree-heavy sits at the spawn itself (the
  // hill's own grass/crags/dog park are built with the world), so it gates
  // NOTHING: garden, wildlands and golf all stream in after reveal while the
  // player reads the name gate and looks at the view. The leanest boot we have.
  coronaHeights: {
    key: "coronaHeights",
    label: "Corona Heights",
    x: 398,
    z: 2752,
    heading: -2.1, // faces SE over the buskers toward the Mission and downtown
    mode: "walk",
    gates: []
  }
};

/** A code spawn if one is registered for `key`, else null (fall back to the
 * baked meta.json spawn table). */
export function resolveSpawnPoint(key: string): SpawnPoint | null {
  return SPAWN_POINTS[key] ?? null;
}
