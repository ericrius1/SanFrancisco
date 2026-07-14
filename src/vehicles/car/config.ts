export type CarForm = "coast-coupe" | "apex-wedge" | "trail-box" | "mission-gt";
export type CarSurface = "solid" | "fogline-graphite" | "sunset-terrazzo" | "midnight-switchback";
export type CarDecal = "none" | "coastal-gull" | "bridge-flash" | "poppy-rush";
export type CarWheel = "split-five" | "mesh-ten" | "rally-eight";

export type CarConfig = {
  form: CarForm;
  surface: CarSurface;
  decal: CarDecal;
  wheel: CarWheel;
  paint: number;
  trim: number;
  interior: number;
  rim: number;
  brake: number;
  paintHex: number | null;
  trimHex: number | null;
  interiorHex: number | null;
  rimHex: number | null;
  brakeHex: number | null;
  surfaceScale: number;
  decalScale: number;
  decalPosition: number;
  clearcoat: number;
};

// One current schema only. Old experiments are intentionally reset instead of
// migrated so shape metadata and asset gates stay small and deterministic.
export const CAR_STORAGE_KEY = "sf-car-v1";

export const CAR_FORMS: { id: CarForm; label: string; note: string }[] = [
  { id: "coast-coupe", label: "coast coupe", note: "rear-engine curves" },
  { id: "apex-wedge", label: "apex wedge", note: "mid-engine drama" },
  { id: "trail-box", label: "trail box", note: "short utility stance" },
  { id: "mission-gt", label: "mission GT", note: "long-road fastback" }
];

export const CAR_SURFACES: { id: CarSurface; label: string; url: string | null }[] = [
  { id: "solid", label: "solid lacquer", url: null },
  { id: "fogline-graphite", label: "fogline graphite", url: "/cars/textures/fogline-graphite.webp" },
  { id: "sunset-terrazzo", label: "sunset terrazzo", url: "/cars/textures/sunset-terrazzo.webp" },
  { id: "midnight-switchback", label: "midnight switchback", url: "/cars/textures/midnight-switchback.webp" }
];

export const CAR_DECALS: { id: CarDecal; label: string; url: string | null }[] = [
  { id: "none", label: "clean", url: null },
  { id: "coastal-gull", label: "coastal gull", url: "/cars/decals/coastal-gull.webp" },
  { id: "bridge-flash", label: "bridge flash", url: "/cars/decals/bridge-flash.webp" },
  { id: "poppy-rush", label: "poppy rush", url: "/cars/decals/poppy-rush.webp" }
];

export const CAR_WHEELS: { id: CarWheel; label: string }[] = [
  { id: "split-five", label: "split five" },
  { id: "mesh-ten", label: "mesh ten" },
  { id: "rally-eight", label: "rally eight" }
];

export const CAR_PAINT_COLORS = [
  { label: "poppy", color: 0xd74432 },
  { label: "pacific", color: 0x287ca1 },
  { label: "butter", color: 0xe4b940 },
  { label: "cypress", color: 0x315f51 },
  { label: "fog", color: 0xb9c2c4 },
  { label: "plum", color: 0x62456f },
  { label: "cream", color: 0xe9dfc8 },
  { label: "midnight", color: 0x152333 }
];

export const CAR_TRIM_COLORS = [
  { label: "graphite", color: 0x171d22 },
  { label: "chrome", color: 0xc4ccd0 },
  { label: "warm alloy", color: 0xb99b65 },
  { label: "cream", color: 0xeee7d6 },
  { label: "navy", color: 0x182c45 },
  { label: "black", color: 0x090c0f }
];

export const CAR_INTERIOR_COLORS = [
  { label: "saddle", color: 0x8c4e32 },
  { label: "espresso", color: 0x2a211e },
  { label: "sand", color: 0xb8895f },
  { label: "oxblood", color: 0x632b32 },
  { label: "navy", color: 0x26374b },
  { label: "black", color: 0x121619 }
];

export const CAR_RIM_COLORS = [
  { label: "bright alloy", color: 0xcbd1d3 },
  { label: "gunmetal", color: 0x596169 },
  { label: "bronze", color: 0xa67d43 },
  { label: "cream", color: 0xe9e0c8 },
  { label: "black", color: 0x11161a }
];

// Brake-light glow: the colour the taillights lerp toward under braking.
// Default is a reddish-purple so the brake reads distinct from the resting red.
export const CAR_BRAKE_COLORS = [
  { label: "magenta", color: 0xff1f5e },
  { label: "orchid", color: 0xd23bff },
  { label: "crimson", color: 0xff2436 },
  { label: "violet", color: 0x7c3cff },
  { label: "rose", color: 0xff5a8a }
];

const DEFAULT_CAR: CarConfig = {
  form: "coast-coupe",
  surface: "solid",
  decal: "none",
  wheel: "split-five",
  paint: 0,
  trim: 0,
  interior: 0,
  rim: 0,
  brake: 0,
  paintHex: null,
  trimHex: null,
  interiorHex: null,
  rimHex: null,
  brakeHex: null,
  surfaceScale: 48,
  decalScale: 50,
  decalPosition: 52,
  clearcoat: 72
};

const FORMS = CAR_FORMS.map((v) => v.id);
const SURFACES = CAR_SURFACES.map((v) => v.id);
const DECALS = CAR_DECALS.map((v) => v.id);
const WHEELS = CAR_WHEELS.map((v) => v.id);

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : fallback;
}

function index(value: unknown, count: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count ? value : fallback;
}

function hex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : null;
}

function percent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : fallback;
}

export function normalizeCarConfig(raw: unknown): CarConfig {
  const value = (raw ?? {}) as Partial<CarConfig>;
  return {
    form: oneOf(value.form, FORMS, DEFAULT_CAR.form),
    surface: oneOf(value.surface, SURFACES, DEFAULT_CAR.surface),
    decal: oneOf(value.decal, DECALS, DEFAULT_CAR.decal),
    wheel: oneOf(value.wheel, WHEELS, DEFAULT_CAR.wheel),
    paint: index(value.paint, CAR_PAINT_COLORS.length, DEFAULT_CAR.paint),
    trim: index(value.trim, CAR_TRIM_COLORS.length, DEFAULT_CAR.trim),
    interior: index(value.interior, CAR_INTERIOR_COLORS.length, DEFAULT_CAR.interior),
    rim: index(value.rim, CAR_RIM_COLORS.length, DEFAULT_CAR.rim),
    brake: index(value.brake, CAR_BRAKE_COLORS.length, DEFAULT_CAR.brake),
    paintHex: hex(value.paintHex),
    trimHex: hex(value.trimHex),
    interiorHex: hex(value.interiorHex),
    rimHex: hex(value.rimHex),
    brakeHex: hex(value.brakeHex),
    surfaceScale: percent(value.surfaceScale, DEFAULT_CAR.surfaceScale),
    decalScale: percent(value.decalScale, DEFAULT_CAR.decalScale),
    decalPosition: percent(value.decalPosition, DEFAULT_CAR.decalPosition),
    clearcoat: percent(value.clearcoat, DEFAULT_CAR.clearcoat)
  };
}

function hashSeed(seed: string | number): number {
  const source = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
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

function pick<T>(values: readonly T[], roll: () => number): T {
  return values[Math.floor(roll() * values.length) % values.length];
}

export function carFromSeed(seed: string | number): CarConfig {
  const roll = lcg(hashSeed(seed));
  return {
    form: pick(FORMS, roll),
    surface: pick(SURFACES, roll),
    decal: pick(DECALS, roll),
    wheel: pick(WHEELS, roll),
    paint: Math.floor(roll() * CAR_PAINT_COLORS.length) % CAR_PAINT_COLORS.length,
    trim: Math.floor(roll() * CAR_TRIM_COLORS.length) % CAR_TRIM_COLORS.length,
    interior: Math.floor(roll() * CAR_INTERIOR_COLORS.length) % CAR_INTERIOR_COLORS.length,
    rim: Math.floor(roll() * CAR_RIM_COLORS.length) % CAR_RIM_COLORS.length,
    brake: Math.floor(roll() * CAR_BRAKE_COLORS.length) % CAR_BRAKE_COLORS.length,
    paintHex: null,
    trimHex: null,
    interiorHex: null,
    rimHex: null,
    brakeHex: null,
    surfaceScale: 28 + Math.floor(roll() * 57),
    decalScale: 28 + Math.floor(roll() * 55),
    decalPosition: 20 + Math.floor(roll() * 61),
    clearcoat: 45 + Math.floor(roll() * 51)
  };
}

export function randomCarConfig(): CarConfig {
  return carFromSeed(`${Date.now()}:${Math.random()}`);
}

export function carKey(raw: CarConfig): string {
  const config = normalizeCarConfig(raw);
  return [
    config.form,
    config.surface,
    config.decal,
    config.wheel,
    config.paint,
    config.trim,
    config.interior,
    config.rim,
    config.brake,
    config.paintHex,
    config.trimHex,
    config.interiorHex,
    config.rimHex,
    config.brakeHex,
    config.surfaceScale,
    config.decalScale,
    config.decalPosition,
    config.clearcoat
  ].join("|");
}

export function isDefaultCar(config: CarConfig): boolean {
  return carKey(config) === carKey(DEFAULT_CAR);
}

export function carPaintHex(config: CarConfig): number {
  return config.paintHex ?? CAR_PAINT_COLORS[config.paint]?.color ?? CAR_PAINT_COLORS[0].color;
}

export function carTrimHex(config: CarConfig): number {
  return config.trimHex ?? CAR_TRIM_COLORS[config.trim]?.color ?? CAR_TRIM_COLORS[0].color;
}

export function carInteriorHex(config: CarConfig): number {
  return config.interiorHex ?? CAR_INTERIOR_COLORS[config.interior]?.color ?? CAR_INTERIOR_COLORS[0].color;
}

export function carRimHex(config: CarConfig): number {
  return config.rimHex ?? CAR_RIM_COLORS[config.rim]?.color ?? CAR_RIM_COLORS[0].color;
}

export function carBrakeHex(config: CarConfig): number {
  return config.brakeHex ?? CAR_BRAKE_COLORS[config.brake]?.color ?? CAR_BRAKE_COLORS[0].color;
}

export function loadSavedCar(): CarConfig | null {
  try {
    const raw = localStorage.getItem(CAR_STORAGE_KEY);
    return raw ? normalizeCarConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveCarConfig(config: CarConfig): void {
  localStorage.setItem(CAR_STORAGE_KEY, JSON.stringify(normalizeCarConfig(config)));
}

let localCar = DEFAULT_CAR;

export function setLocalCarConfig(config: CarConfig): void {
  localCar = normalizeCarConfig(config);
}

export function localCarConfig(): CarConfig {
  return localCar;
}
