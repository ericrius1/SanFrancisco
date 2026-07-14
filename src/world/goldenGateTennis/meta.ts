/** Lightweight boot metadata for the lazy Goldman authored site. */
export const GOLDMAN_GAMEPLAY_LANDMARK = { x: -1334.62, z: 2145.41 } as const;

export const GOLDMAN_SITE_BOUNDS = {
  minX: -1395,
  maxX: -1238,
  minZ: 2106,
  maxZ: 2271
} as const;

export const GOLDMAN_SITE_CENTER = {
  x: (GOLDMAN_SITE_BOUNDS.minX + GOLDMAN_SITE_BOUNDS.maxX) / 2,
  z: (GOLDMAN_SITE_BOUNDS.minZ + GOLDMAN_SITE_BOUNDS.maxZ) / 2
} as const;

/** Baked generic clubhouse footprint swapped only after the authored site is ready. */
export const GOLDMAN_SUPPRESSED_BUILDINGS: readonly { key: string; index: number }[] = [
  { key: "7_13", index: 406 }
] as const;
