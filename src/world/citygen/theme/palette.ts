// Pure palette shared by detailed and merged building tiers.
import { rng } from "../core/rng";

// SF "painted lady" body colours — mid-saturated so the bright white trim reads
// as the classic Victorian contrast (bodies vary building-to-building).
// Per-archetype body palettes. Victorians are saturated painted ladies; other
// districts read as their real materials (stucco pastels, grey masonry, brick).
export const PAINTED_LADY = [
  0x2e8577, 0xb05f28, 0x4666b8, 0x5f8a2e, 0xc06e26, 0x3f52a8,
  0xb03a52, 0xc79320, 0x1f7f92, 0x74459f, 0x3f8f4a, 0xc17c1e,
];
const PALETTES: Record<string, number[]> = {
  victorian: PAINTED_LADY,
  edwardian: [0xdcd8cc, 0xcdc6b4, 0xd8d0be, 0xc6cdc0, 0xd0c8b8, 0xbfc4c0], // pale Edwardian
  marina: [0xe6d8bc, 0xe0c9a6, 0xd9b48a, 0xe8d2b0, 0xcdd8c0, 0xe8cfc0, 0xefe2c2], // stucco pastels
  downtown: [0x9a9d9f, 0xb0a894, 0x8f9498, 0xa6a29a, 0x8a8d90, 0xa89f8c], // grey/tan masonry
  soma: [0x8f4a3a, 0x9c5540, 0x7a3f34, 0xa5634a, 0x86584a, 0x944e3c], // brick reds
  chinatown: [0xcabf9e, 0xc7b58a, 0xbfae86],
};

/** seeded body colour for a building, keyed to its archetype's palette */
export function bodyColour(seed: number, archetype = "victorian"): number {
  const pal = PALETTES[archetype] ?? PAINTED_LADY;
  const r = rng(seed, 99);
  return pal[Math.floor(r() * pal.length) % pal.length];
}


export const STRUCTURE_HEX: Record<string, number> = {
  "trim.victorian": 0xf9f4ea, "trim.edwardian": 0xf2eee4,
  "base.stoop": 0xa89e8c, "roof.flatTrim": 0x9a9384,
  "roof.tileCornice": 0xb56545, "roof.parapet": 0x969084,
  "int.wood": 0x5a4028, "lc.stone": 0xb8b0a2,
};

// Unscaled authoring values; materials apply the shared exposure rebase.
export const STRUCTURE_EMISSIVE: Record<string, number> = {
  "trim.victorian": 0.16, "trim.edwardian": 0.16,
  "roof.flatTrim": 0.5, "roof.tileCornice": 0.4, "roof.parapet": 0.5,
  "int.wood": 0.35,
};
