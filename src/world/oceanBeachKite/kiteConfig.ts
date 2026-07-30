/**
 * What YOUR kite is: which sail you fly, how it is dyed, how much line you let
 * out and how long a tail you tie on.
 *
 * Data only — no THREE, no geometry, no runtime. The HUD keeps a live config
 * from boot (the same contract the board/scooter/car configs follow), so this
 * module has to stay out of the kite's own chunk: everything it borrows from
 * `kiteDesigns` is `import type`, which erases.
 */
import type { KiteDesignId, KitePalette } from "./kiteDesigns";

/**
 * Runtime mirror of `KiteDesignId`. The `SailEntry` annotation below makes a
 * drifted id a type error, so this stays honest without importing the designs
 * (and their geometry builders) at boot.
 */
type SailEntry = { id: KiteDesignId; label: string; note: string };

export const KITE_SAILS: readonly SailEntry[] = [
  { id: "diamond", label: "diamond", note: "the original · one steady face" },
  { id: "sunwheel", label: "sunwheel", note: "six blades round an open eye" },
  { id: "lantern", label: "lantern", note: "two box cells · eight windows" },
  { id: "sled", label: "sled", note: "no cross spar · two tall vents" },
  { id: "centipede", label: "centipede", note: "five discs on one line" },
  { id: "prism", label: "prism", note: "hollow triangle · a spectrum below it" }
];

/**
 * A dye job is a whole `KitePalette`, not a colour: cloth, glow, spar, hem,
 * tail and bows all have to move together or the kite stops reading as one
 * object. `native` is the sail's own authored palette — the five designs were
 * each colour-designed around what they do to the light, so keeping their own
 * dye is the default and always the honest answer.
 */
export type KiteColorwayId =
  | "native"
  | "amethyst"
  | "lagoon"
  | "ember"
  | "pearl"
  | "gilt"
  | "seafoam"
  | "dusk"
  | "poppy";

export type KiteColorway = {
  id: KiteColorwayId;
  label: string;
  /** Two-stop chip for the swatch row. */
  chip: readonly [number, number];
  /** Null for `native`: the flyer keeps whatever the sail was authored with. */
  palette: KitePalette | null;
};

export const KITE_COLORWAYS: readonly KiteColorway[] = [
  {
    id: "native",
    label: "as shaped",
    chip: [0x4b1f91, 0xe8c25a],
    palette: null
  },
  {
    id: "amethyst",
    label: "amethyst",
    chip: [0x4b1f91, 0xa766ef],
    palette: {
      clothDeep: 0x4b1f91,
      clothLight: 0xa766ef,
      glowLow: 0x7d2ea8,
      glowHigh: 0xd8409a,
      spar: 0x5d3a24,
      hem: 0xd5a6ff,
      tailA: 0x9a4ae0,
      tailB: 0xffc8f0,
      bows: [0xf0d27a, 0xd08cf5, 0xffb27a, 0xa26be0]
    }
  },
  {
    id: "lagoon",
    label: "lagoon",
    chip: [0x0c4d5e, 0x46d4c6],
    palette: {
      clothDeep: 0x0c4d5e,
      clothLight: 0x46d4c6,
      glowLow: 0x1f8f9c,
      glowHigh: 0x8ffbe2,
      spar: 0x4a3524,
      hem: 0x9ff3e4,
      tailA: 0x1f9fae,
      tailB: 0xc8fff2,
      bows: [0xffd98a, 0x59e0cf, 0xa9f7ea, 0x1c7f8c]
    }
  },
  {
    id: "ember",
    label: "ember",
    chip: [0x7a1230, 0xff7a4e],
    palette: {
      clothDeep: 0x7a1230,
      clothLight: 0xff7a4e,
      glowLow: 0xc4321f,
      glowHigh: 0xffd08a,
      spar: 0x241a12,
      hem: 0xffb08a,
      tailA: 0xd93b32,
      tailB: 0xffd9a8,
      bows: [0xffd07a, 0xe4553c, 0xffb27a, 0x8f1f2e]
    }
  },
  {
    id: "pearl",
    label: "pearl",
    chip: [0x3b4a66, 0xeff3fb],
    palette: {
      clothDeep: 0x3b4a66,
      clothLight: 0xeff3fb,
      glowLow: 0xd9a05e,
      glowHigh: 0xfff4d8,
      spar: 0x2f3a44,
      hem: 0xdfe8ff,
      tailA: 0x6f88b8,
      tailB: 0xffffff,
      bows: [0xffc978, 0xeff3fb, 0x8fa8d6, 0x3b4a66]
    }
  },
  {
    id: "gilt",
    label: "gilt",
    chip: [0x0d3b2b, 0xe8c25a],
    palette: {
      clothDeep: 0x0d3b2b,
      clothLight: 0xe8c25a,
      glowLow: 0x3f9a52,
      glowHigh: 0xfff0a6,
      spar: 0x7a5a24,
      hem: 0xffe6a4,
      tailA: 0x18774a,
      tailB: 0xffe27a,
      bows: [0xff6b3d, 0xe8c25a, 0x18774a, 0xfff0a6]
    }
  },
  {
    // Ice plant and sea foam — the two colours actually on this stretch of sand.
    id: "seafoam",
    label: "sea foam",
    chip: [0x1d6b57, 0xdcf7e4],
    palette: {
      clothDeep: 0x1d6b57,
      clothLight: 0xdcf7e4,
      glowLow: 0x4fbf87,
      glowHigh: 0xe8fff0,
      spar: 0x4f4231,
      hem: 0xc4f2d8,
      tailA: 0x36a37a,
      tailB: 0xf2fff8,
      bows: [0xffd9a0, 0x8ce8b8, 0xdcf7e4, 0x1d6b57]
    }
  },
  {
    // Deep enough to go nearly black in silhouette, so the transmission glow
    // does all the work once the sun drops behind it.
    id: "dusk",
    label: "dusk",
    chip: [0x191b3c, 0x6a63c9],
    palette: {
      clothDeep: 0x191b3c,
      clothLight: 0x6a63c9,
      glowLow: 0x5b3fa8,
      glowHigh: 0xffb6e2,
      spar: 0x22243f,
      hem: 0xb9b2ff,
      tailA: 0x3a3480,
      tailB: 0xffc9ee,
      bows: [0xffd27a, 0x8b83e0, 0xffb6e2, 0x191b3c]
    }
  },
  {
    id: "poppy",
    label: "poppy",
    chip: [0xc23b1c, 0xffc247],
    palette: {
      clothDeep: 0xc23b1c,
      clothLight: 0xffc247,
      glowLow: 0xff6a2a,
      glowHigh: 0xfff2b0,
      spar: 0x3d2414,
      hem: 0xffdc92,
      tailA: 0xe85c22,
      tailB: 0xfff0bd,
      bows: [0xfff0bd, 0xff8a3d, 0xffc247, 0xc23b1c]
    }
  }
];

export type KiteConfig = {
  design: KiteDesignId;
  colorway: KiteColorwayId;
  /** 0..100 — how much line is out. Scales the design's own tuned length. */
  line: number;
  /** 0..100 — tail length, from a stub to a long streamer. */
  tail: number;
  /** Whether your kite is actually up. Off means you are just holding a reel. */
  flying: boolean;
};

export const KITE_STORAGE_KEY = "sf-kite-v1";

const DEFAULT_KITE: KiteConfig = {
  design: "diamond",
  colorway: "native",
  line: 52,
  tail: 46,
  flying: true
};

const SAIL_IDS: readonly KiteDesignId[] = KITE_SAILS.map((entry) => entry.id);
const COLORWAY_IDS: readonly KiteColorwayId[] = KITE_COLORWAYS.map((entry) => entry.id);

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function percent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

export function normalizeKiteConfig(raw: unknown): KiteConfig {
  const value = (raw ?? {}) as Partial<KiteConfig>;
  return {
    design: oneOf(value.design, SAIL_IDS, DEFAULT_KITE.design),
    colorway: oneOf(value.colorway, COLORWAY_IDS, DEFAULT_KITE.colorway),
    line: percent(value.line, DEFAULT_KITE.line),
    tail: percent(value.tail, DEFAULT_KITE.tail),
    flying: typeof value.flying === "boolean" ? value.flying : DEFAULT_KITE.flying
  };
}

export function kiteColorway(id: KiteColorwayId): KiteColorway {
  return KITE_COLORWAYS.find((entry) => entry.id === id) ?? KITE_COLORWAYS[0];
}

/** Everything the built kite depends on. A change here rebuilds the sail. */
export function kiteBuildKey(config: KiteConfig): string {
  const value = normalizeKiteConfig(config);
  return `${value.design}`;
}

/** Everything a live kite can absorb without being rebuilt. */
export function kiteDressKey(config: KiteConfig): string {
  const value = normalizeKiteConfig(config);
  return [value.colorway, value.line, value.tail, value.flying].join("|");
}

export function kiteKey(config: KiteConfig): string {
  return `${kiteBuildKey(config)}|${kiteDressKey(config)}`;
}

function hashSeed(seed: string | number): number {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function lcg(seed: number) {
  let state = seed || 0x9e3779b9;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 0x100000000;
  };
}

export function kiteFromSeed(seed: string | number, flying = true): KiteConfig {
  const roll = lcg(hashSeed(seed));
  return {
    design: SAIL_IDS[Math.floor(roll() * SAIL_IDS.length) % SAIL_IDS.length],
    // Skip `native` here: a rolled kite should look rolled.
    colorway: COLORWAY_IDS[1 + (Math.floor(roll() * (COLORWAY_IDS.length - 1)) % (COLORWAY_IDS.length - 1))],
    line: 28 + Math.floor(roll() * 60),
    tail: 20 + Math.floor(roll() * 70),
    flying
  };
}

export function randomKiteConfig(flying = true): KiteConfig {
  return kiteFromSeed(`${Date.now()}:${Math.random()}`, flying);
}

export function loadSavedKite(): KiteConfig | null {
  try {
    const raw = localStorage.getItem(KITE_STORAGE_KEY);
    return raw ? normalizeKiteConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveKiteConfig(config: KiteConfig): void {
  try {
    localStorage.setItem(KITE_STORAGE_KEY, JSON.stringify(normalizeKiteConfig(config)));
  } catch {
    // Private-mode storage refusals must never cost you the kite you just dyed.
  }
}
