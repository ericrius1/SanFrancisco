// Wildflower species vocabulary — palettes, region preferences and the per-species
// constants shared by the bloom geometry (flowerRing.ts) and the baked placement
// field (flowerField.ts). Pure data + pure math so either side can import it
// without pulling in three or the renderer.

export type AuthoredFlowerSpecies = "poppy" | "lupine" | "yarrow" | "goldfield";

export const FLOWER_SPECIES_IDS: readonly AuthoredFlowerSpecies[] = [
  "poppy",
  "lupine",
  "yarrow",
  "goldfield"
];

/** Bloom base palettes; a per-instance tint lerps within [a, b]. */
export const PALETTES: readonly { a: number; b: number }[] = [
  { a: 0xff5a1e, b: 0xe23c14 }, // 0 poppy — california orange
  { a: 0x6a5cc4, b: 0x8f7ad8 }, // 1 lupine — blue-violet
  { a: 0xf3ead2, b: 0xf7d65a }, // 2 yarrow — cream→gold
  { a: 0xffc31e, b: 0xffd94a } // 3 goldfield — bright gold
];

/** Which species favour which region; index 0 is the clump-dominant pick order. */
export const REGION_FLOWERS: Record<string, readonly number[]> = {
  ggpark: [0, 1, 2, 3],
  presidio: [1, 2, 0, 1],
  marin: [0, 0, 3, 1], // poppy-heavy golden hills + goldfields
  twinpeaks: [1, 2, 0, 3]
};

export const DEFAULT_PALETTE_ORDER: readonly number[] = [0, 1, 2, 3];

/** Apparent flower heads represented by one clump instance, per LOD grade. */
export const HEADS_PER_CLUMP = [3, 3, 3, 5] as const;
export const MID_HEADS_PER_CLUMP = [2, 2, 2, 2] as const;

/** Relative accent height per species, so a distant lupine spike still reads tall. */
export const FAR_HEIGHT_SCALE = [1, 1.28, 0.9, 0.68] as const;

/** Root footprint radius used to seat a clump on the low point of its ground. */
export const ROOT_FOOTPRINT_RADIUS = [0.31, 0.29, 0.27, 0.24] as const;

// ---- keep-probability shape (the density knob multiplies it at placement) -------
export const EVEN_PROB = 0.28; // clumpiness 0: a uniform moderate field
export const CLUMP_PEAK = 0.85; // clumpiness 1: dense inside a clump
export const CLUMP_FLOOR = 0.03; // clumpiness 1: sparse singles between clumps
export const CLUMP_SALT = 5171;
/** Ceiling on the baked keep shape × density. A hard 1.0 would let the maximum
 *  density slider ask for one bloom in EVERY cell of a superbloom drift, which is
 *  both a carpet nobody wants and the only case that could overrun a species
 *  layer's reserved instance slots. */
export const KEEP_CEILING = 0.92;
