export type ScooterBody = "classic" | "sport" | "touring";
export type ScooterSeat = "bench" | "saddle" | "petpad";
export type ScooterScreen = "none" | "fly" | "touring";
export type ScooterCargo = "none" | "rack" | "basket" | "topbox";
export type ScooterWheel = "spoke" | "turbine";
export type ScooterSurface = "solid" | "fog-circuit" | "night-topography";
export type ScooterDecal = "none" | "volt-wasp" | "bridge-bolt" | "poppy-power";

export type ScooterConfig = {
  body: ScooterBody;
  seat: ScooterSeat;
  screen: ScooterScreen;
  cargo: ScooterCargo;
  wheel: ScooterWheel;
  surface: ScooterSurface;
  decal: ScooterDecal;
  paint: number;
  trim: number;
  upholstery: number;
  paintHex: number | null;
  trimHex: number | null;
  upholsteryHex: number | null;
  whitewalls: boolean;
  stance: number;
  bodyVolume: number;
  decalScale: number;
  decalPosition: number;
  rimGlow: number;
  screenTint: number;
};

// v2 intentionally resets the old compact-scooter schema. There is one current
// shape/art schema and no migration path to keep in the boot bundle.
export const SCOOTER_STORAGE_KEY = "sf-scooter-v2";

export const SCOOTER_BODIES: { id: ScooterBody; label: string }[] = [
  { id: "classic", label: "classic" },
  { id: "sport", label: "sport" },
  { id: "touring", label: "touring" }
];

export const SCOOTER_SEATS: { id: ScooterSeat; label: string }[] = [
  { id: "bench", label: "two-up bench" },
  { id: "saddle", label: "twin saddle" },
  { id: "petpad", label: "pet comfort" }
];

export const SCOOTER_SCREENS: { id: ScooterScreen; label: string }[] = [
  { id: "none", label: "open" },
  { id: "fly", label: "flyscreen" },
  { id: "touring", label: "touring" }
];

export const SCOOTER_CARGO: { id: ScooterCargo; label: string }[] = [
  { id: "none", label: "clean tail" },
  { id: "rack", label: "chrome rack" },
  { id: "basket", label: "front basket" },
  { id: "topbox", label: "top box" }
];

export const SCOOTER_WHEELS: { id: ScooterWheel; label: string }[] = [
  { id: "spoke", label: "wire spoke" },
  { id: "turbine", label: "electric turbine" }
];

export const SCOOTER_SURFACES: { id: ScooterSurface; label: string; url: string | null }[] = [
  { id: "solid", label: "pinstripe", url: null },
  { id: "fog-circuit", label: "fog circuit", url: "/scooters/textures/fog-circuit.webp" },
  { id: "night-topography", label: "night topo", url: "/scooters/textures/night-topography.webp" }
];

export const SCOOTER_DECALS: { id: ScooterDecal; label: string; url: string | null }[] = [
  { id: "none", label: "clean", url: null },
  { id: "volt-wasp", label: "volt wasp", url: "/scooters/decals/volt-wasp.webp" },
  { id: "bridge-bolt", label: "bridge bolt", url: "/scooters/decals/bridge-bolt.webp" },
  { id: "poppy-power", label: "poppy power", url: "/scooters/decals/poppy-power.webp" }
];

export const SCOOTER_PAINT_COLORS = [
  { label: "tomato", color: 0xe84c3d },
  { label: "sea glass", color: 0x58b7a7 },
  { label: "buttercup", color: 0xf0c84b },
  { label: "sky", color: 0x4b91d1 },
  { label: "orchid", color: 0x9a65c7 },
  { label: "cream", color: 0xeee4cc },
  { label: "midnight", color: 0x202b38 },
  { label: "rose", color: 0xd95d88 }
];

export const SCOOTER_TRIM_COLORS = [
  { label: "chrome", color: 0xc6d0d3 },
  { label: "graphite", color: 0x283139 },
  { label: "cream", color: 0xf0ead8 },
  { label: "gold", color: 0xc9a455 },
  { label: "white", color: 0xf4f5ee },
  { label: "black", color: 0x11171c }
];

export const SCOOTER_SEAT_COLORS = [
  { label: "chestnut", color: 0x7a432e },
  { label: "espresso", color: 0x2b211d },
  { label: "sand", color: 0xb99064 },
  { label: "black", color: 0x15181b },
  { label: "oxblood", color: 0x662c31 },
  { label: "navy", color: 0x26384c }
];

const DEFAULT_SCOOTER: ScooterConfig = {
  body: "classic",
  seat: "bench",
  screen: "fly",
  cargo: "rack",
  wheel: "spoke",
  surface: "fog-circuit",
  decal: "bridge-bolt",
  paint: 0,
  trim: 0,
  upholstery: 0,
  paintHex: null,
  trimHex: null,
  upholsteryHex: null,
  whitewalls: true,
  stance: 54,
  bodyVolume: 58,
  decalScale: 46,
  decalPosition: 56,
  rimGlow: 38,
  screenTint: 48
};

const BODIES = SCOOTER_BODIES.map((v) => v.id);
const SEATS = SCOOTER_SEATS.map((v) => v.id);
const SCREENS = SCOOTER_SCREENS.map((v) => v.id);
const CARGO = SCOOTER_CARGO.map((v) => v.id);
const WHEELS = SCOOTER_WHEELS.map((v) => v.id);
const SURFACES = SCOOTER_SURFACES.map((v) => v.id);
const DECALS = SCOOTER_DECALS.map((v) => v.id);

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
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

export function normalizeScooterConfig(raw: unknown): ScooterConfig {
  const v = (raw ?? {}) as Partial<ScooterConfig>;
  return {
    body: oneOf(v.body, BODIES, DEFAULT_SCOOTER.body),
    seat: oneOf(v.seat, SEATS, DEFAULT_SCOOTER.seat),
    screen: oneOf(v.screen, SCREENS, DEFAULT_SCOOTER.screen),
    cargo: oneOf(v.cargo, CARGO, DEFAULT_SCOOTER.cargo),
    wheel: oneOf(v.wheel, WHEELS, DEFAULT_SCOOTER.wheel),
    surface: oneOf(v.surface, SURFACES, DEFAULT_SCOOTER.surface),
    decal: oneOf(v.decal, DECALS, DEFAULT_SCOOTER.decal),
    paint: index(v.paint, SCOOTER_PAINT_COLORS.length, DEFAULT_SCOOTER.paint),
    trim: index(v.trim, SCOOTER_TRIM_COLORS.length, DEFAULT_SCOOTER.trim),
    upholstery: index(v.upholstery, SCOOTER_SEAT_COLORS.length, DEFAULT_SCOOTER.upholstery),
    paintHex: hex(v.paintHex),
    trimHex: hex(v.trimHex),
    upholsteryHex: hex(v.upholsteryHex),
    whitewalls: typeof v.whitewalls === "boolean" ? v.whitewalls : DEFAULT_SCOOTER.whitewalls,
    stance: percent(v.stance, DEFAULT_SCOOTER.stance),
    bodyVolume: percent(v.bodyVolume, DEFAULT_SCOOTER.bodyVolume),
    decalScale: percent(v.decalScale, DEFAULT_SCOOTER.decalScale),
    decalPosition: percent(v.decalPosition, DEFAULT_SCOOTER.decalPosition),
    rimGlow: percent(v.rimGlow, DEFAULT_SCOOTER.rimGlow),
    screenTint: percent(v.screenTint, DEFAULT_SCOOTER.screenTint)
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
  let state = seed || 0x9e3779b9;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 0x100000000;
  };
}

function pick<T>(values: readonly T[], roll: () => number): T {
  return values[Math.floor(roll() * values.length) % values.length];
}

export function scooterFromSeed(seed: string | number): ScooterConfig {
  const roll = lcg(hashSeed(seed));
  return {
    body: pick(BODIES, roll),
    seat: pick(SEATS, roll),
    screen: pick(SCREENS, roll),
    cargo: pick(CARGO, roll),
    wheel: pick(WHEELS, roll),
    surface: pick(SURFACES, roll),
    decal: pick(DECALS, roll),
    paint: Math.floor(roll() * SCOOTER_PAINT_COLORS.length) % SCOOTER_PAINT_COLORS.length,
    trim: Math.floor(roll() * SCOOTER_TRIM_COLORS.length) % SCOOTER_TRIM_COLORS.length,
    upholstery: Math.floor(roll() * SCOOTER_SEAT_COLORS.length) % SCOOTER_SEAT_COLORS.length,
    whitewalls: roll() > 0.35,
    paintHex: null,
    trimHex: null,
    upholsteryHex: null,
    stance: 28 + Math.floor(roll() * 57),
    bodyVolume: 24 + Math.floor(roll() * 65),
    decalScale: 24 + Math.floor(roll() * 59),
    decalPosition: 18 + Math.floor(roll() * 65),
    rimGlow: 16 + Math.floor(roll() * 69),
    screenTint: 24 + Math.floor(roll() * 67)
  };
}

export function randomScooterConfig(): ScooterConfig {
  return scooterFromSeed(`${Date.now()}:${Math.random()}`);
}

export function scooterKey(config: ScooterConfig): string {
  const c = normalizeScooterConfig(config);
  return [
    c.body,
    c.seat,
    c.screen,
    c.cargo,
    c.wheel,
    c.surface,
    c.decal,
    c.paint,
    c.trim,
    c.upholstery,
    c.paintHex,
    c.trimHex,
    c.upholsteryHex,
    c.whitewalls,
    c.stance,
    c.bodyVolume,
    c.decalScale,
    c.decalPosition,
    c.rimGlow,
    c.screenTint
  ].join("|");
}

export function isDefaultScooter(config: ScooterConfig): boolean {
  return scooterKey(config) === scooterKey(DEFAULT_SCOOTER);
}

export function scooterPaintHex(config: ScooterConfig): number {
  return config.paintHex ?? SCOOTER_PAINT_COLORS[config.paint]?.color ?? SCOOTER_PAINT_COLORS[0].color;
}

export function scooterTrimHex(config: ScooterConfig): number {
  return config.trimHex ?? SCOOTER_TRIM_COLORS[config.trim]?.color ?? SCOOTER_TRIM_COLORS[0].color;
}

export function scooterSeatHex(config: ScooterConfig): number {
  return config.upholsteryHex ?? SCOOTER_SEAT_COLORS[config.upholstery]?.color ?? SCOOTER_SEAT_COLORS[0].color;
}

export function loadSavedScooter(): ScooterConfig | null {
  try {
    const raw = localStorage.getItem(SCOOTER_STORAGE_KEY);
    return raw ? normalizeScooterConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveScooterConfig(config: ScooterConfig): void {
  localStorage.setItem(SCOOTER_STORAGE_KEY, JSON.stringify(normalizeScooterConfig(config)));
}

let localScooter = DEFAULT_SCOOTER;

export function setLocalScooterConfig(config: ScooterConfig): void {
  localScooter = normalizeScooterConfig(config);
}

export function localScooterConfig(): ScooterConfig {
  return localScooter;
}
