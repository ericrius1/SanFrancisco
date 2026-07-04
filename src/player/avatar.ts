export type AvatarHat = "none" | "cap" | "beanie" | "visor" | "crown";
export type AvatarHair = "short" | "bob" | "mohawk" | "buzz" | "long";
export type AvatarOutfit = "jacket" | "hoodie" | "tee" | "overalls" | "dress";

export type AvatarTraits = {
  skin: number;
  hair: AvatarHair;
  hat: AvatarHat;
  outfit: AvatarOutfit;
  color: number;
  accent: number;
};

export const AVATAR_STORAGE_KEY = "sf-avatar-v2";

export const AVATAR_HATS: { id: AvatarHat; label: string }[] = [
  { id: "none", label: "none" },
  { id: "cap", label: "cap" },
  { id: "beanie", label: "beanie" },
  { id: "visor", label: "visor" },
  { id: "crown", label: "crown" }
];

export const AVATAR_HAIR: { id: AvatarHair; label: string }[] = [
  { id: "short", label: "short" },
  { id: "bob", label: "bob" },
  { id: "mohawk", label: "mohawk" },
  { id: "buzz", label: "buzz" },
  { id: "long", label: "long" }
];

export const AVATAR_OUTFITS: { id: AvatarOutfit; label: string }[] = [
  { id: "jacket", label: "jacket" },
  { id: "hoodie", label: "hoodie" },
  { id: "tee", label: "tee" },
  { id: "overalls", label: "overalls" },
  { id: "dress", label: "dress" }
];

export const SKIN_TONES = [
  { label: "porcelain", color: 0xf2c7ad },
  { label: "peach", color: 0xd99b76 },
  { label: "bronze", color: 0xb87350 },
  { label: "umber", color: 0x865136 },
  { label: "deep", color: 0x5b3527 },
  { label: "rose", color: 0xe6aa9c }
];

export const HAIR_COLORS = [0x251810, 0x5b321f, 0xd68c3a, 0x1d2128, 0xf0d6a2, 0x8b3f7b];

export const CLOTHING_COLORS = [
  { label: "sky", color: 0x2e8fc9 },
  { label: "coral", color: 0xf15c45 },
  { label: "mint", color: 0x26b47c },
  { label: "gold", color: 0xe3aa28 },
  { label: "plum", color: 0x7a4bd6 },
  { label: "graphite", color: 0x3b4654 },
  { label: "rose", color: 0xd94e82 },
  { label: "teal", color: 0x1798a8 }
];

const DEFAULT_AVATAR: AvatarTraits = {
  skin: 1,
  hair: "short",
  hat: "cap",
  outfit: "jacket",
  color: 0,
  accent: 3
};

const HATS = AVATAR_HATS.map((v) => v.id);
const HAIRS = AVATAR_HAIR.map((v) => v.id);
const OUTFITS = AVATAR_OUTFITS.map((v) => v.id);

function int(value: unknown, max: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < max ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function normalizeAvatarTraits(raw: unknown): AvatarTraits {
  const v = (raw ?? {}) as Partial<AvatarTraits>;
  return {
    skin: int(v.skin, SKIN_TONES.length, DEFAULT_AVATAR.skin),
    hair: oneOf(v.hair, HAIRS, DEFAULT_AVATAR.hair),
    hat: oneOf(v.hat, HATS, DEFAULT_AVATAR.hat),
    outfit: oneOf(v.outfit, OUTFITS, DEFAULT_AVATAR.outfit),
    color: int(v.color, CLOTHING_COLORS.length, DEFAULT_AVATAR.color),
    accent: int(v.accent, CLOTHING_COLORS.length, DEFAULT_AVATAR.accent)
  };
}

function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcg(seed: number) {
  let s = seed || 0x9e3779b9;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

function pick<T>(items: readonly T[], roll: () => number): T {
  return items[Math.floor(roll() * items.length) % items.length];
}

export function avatarFromSeed(seed: string | number): AvatarTraits {
  const roll = lcg(hashSeed(seed));
  const color = Math.floor(roll() * CLOTHING_COLORS.length) % CLOTHING_COLORS.length;
  let accent = Math.floor(roll() * CLOTHING_COLORS.length) % CLOTHING_COLORS.length;
  if (accent === color) accent = (accent + 3) % CLOTHING_COLORS.length;
  return {
    skin: Math.floor(roll() * SKIN_TONES.length) % SKIN_TONES.length,
    hair: pick(HAIRS, roll),
    hat: pick(HATS, roll),
    outfit: pick(OUTFITS, roll),
    color,
    accent
  };
}

export function randomAvatarTraits(): AvatarTraits {
  return avatarFromSeed(`${Date.now()}:${Math.random()}`);
}

export function loadAvatarTraits(): AvatarTraits {
  try {
    const raw = localStorage.getItem(AVATAR_STORAGE_KEY);
    if (raw) return normalizeAvatarTraits(JSON.parse(raw));
  } catch {
    // fall through to a new generated avatar
  }
  const next = randomAvatarTraits();
  saveAvatarTraits(next);
  return next;
}

export function saveAvatarTraits(traits: AvatarTraits) {
  localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(normalizeAvatarTraits(traits)));
}

export function avatarKey(traits: AvatarTraits): string {
  const t = normalizeAvatarTraits(traits);
  return `${t.skin}|${t.hair}|${t.hat}|${t.outfit}|${t.color}|${t.accent}`;
}

export function isDefaultAvatar(traits: AvatarTraits): boolean {
  return avatarKey(traits) === avatarKey(DEFAULT_AVATAR);
}
