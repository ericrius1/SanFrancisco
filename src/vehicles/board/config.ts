/**
 * Hoverboard identity — the rider-facing customization knobs (shape, colors,
 * fins, procedural surface, hum voicing). Mirrors the avatar-traits contract:
 * normalize accepts any junk off the wire, a per-id seed gives uncustomized
 * players distinct boards, and localStorage is written only when the player
 * actually edits (an absent key means "seed me from my server id" — the same
 * identity lesson avatar.ts learned about multi-tab identical blobs).
 */

export type BoardShape = "classic" | "dart" | "manta" | "saucer" | "twintip";
export type BoardFin = "none" | "twin" | "spoiler" | "halo";
export type BoardSurface = "aurora" | "topo" | "terrazzo" | "circuit" | "plasma";
export type BoardHum = "hum" | "crystal" | "deep" | "choir" | "retro";

export type BoardConfig = {
  shape: BoardShape;
  fin: BoardFin;
  deck: number; // index into BOARD_DECK_COLORS
  trim: number; // index into BOARD_DECK_COLORS (surface ink, edge guard, fins)
  glow: number; // index into BOARD_GLOW_COLORS (rails, underglow, thrusters, light)
  surface: BoardSurface;
  surfaceScale: number; // 0..100: broad pools -> fine detail
  surfaceWarp: number; // 0..100: ordered -> turbulent
  surfaceSeed: number; // 0..65535 deterministic reroll
  surfaceFlow: number; // 0..100: still -> animated
  surfaceReaction: number; // 0..100: calm -> motion-reactive
  hum: BoardHum; // synth voicing (fx/vehicleAudio.ts)
  pitch: number; // index into BOARD_PITCHES
  soundTone: number; // 0..100: warm -> glassy
  soundMotion: number; // 0..100: still -> fluttering LFO
  soundThrust: number; // 0..100: glide -> punchy speed response
  soundAir: number; // 0..100: pure tone -> airy noise layer
};

// One current schema only. Earlier saved boards are deliberately left behind;
// the simplified visual + expanded audio model starts clean instead of migrating.
export const BOARD_STORAGE_KEY = "sf-board-v4";

export const BOARD_SHAPES: { id: BoardShape; label: string }[] = [
  { id: "classic", label: "classic" },
  { id: "dart", label: "dart" },
  { id: "manta", label: "manta" },
  { id: "saucer", label: "saucer" },
  { id: "twintip", label: "twin tip" }
];

export const BOARD_FINS: { id: BoardFin; label: string }[] = [
  { id: "none", label: "none" },
  { id: "twin", label: "twin fins" },
  { id: "spoiler", label: "spoiler" },
  { id: "halo", label: "halo ring" }
];

export const BOARD_SURFACES: { id: BoardSurface; label: string }[] = [
  { id: "aurora", label: "aurora" },
  { id: "topo", label: "topo" },
  { id: "terrazzo", label: "terrazzo" },
  { id: "circuit", label: "circuit" },
  { id: "plasma", label: "plasma" }
];

export const BOARD_HUMS: { id: BoardHum; label: string }[] = [
  { id: "hum", label: "classic hum" },
  { id: "crystal", label: "crystal" },
  { id: "deep", label: "deep" },
  { id: "choir", label: "choir" },
  { id: "retro", label: "retro" }
];

/** Hum root notes — all low register so the stack never turns shrill. */
export const BOARD_PITCHES = [
  { label: "A", hz: 55.0 },
  { label: "C", hz: 65.41 },
  { label: "D", hz: 73.42 },
  { label: "E", hz: 82.41 },
  { label: "G", hz: 98.0 }
];

export const BOARD_DECK_COLORS = [
  { label: "sunset coral", color: 0xe8563f },
  { label: "midnight", color: 0x232a36 },
  { label: "seafoam", color: 0x3fae9c },
  { label: "banana", color: 0xf0c245 },
  { label: "grape", color: 0x7a4bd6 },
  { label: "cloud", color: 0xe9e4d8 },
  { label: "rose", color: 0xd94e82 },
  { label: "surf blue", color: 0x2e8fc9 }
];

export const BOARD_GLOW_COLORS = [
  { label: "bay ice", color: 0x54f0ff },
  { label: "ultraviolet", color: 0xa46bff },
  { label: "neon lime", color: 0x8dff4f },
  { label: "hot magenta", color: 0xff4fd8 },
  { label: "ember", color: 0xffb63d },
  { label: "starlight", color: 0xd8f6ff },
  { label: "laser red", color: 0xff4438 },
  { label: "sea glass", color: 0x3dffc0 }
];

/** The authored starting point for the current surface + sound schema. */
const DEFAULT_BOARD: BoardConfig = {
  shape: "classic",
  fin: "none",
  deck: 0,
  trim: 5,
  glow: 0,
  surface: "aurora",
  surfaceScale: 52,
  surfaceWarp: 58,
  surfaceSeed: 1847,
  surfaceFlow: 24,
  surfaceReaction: 52,
  hum: "hum",
  pitch: 0,
  soundTone: 50,
  soundMotion: 50,
  soundThrust: 50,
  soundAir: 30
};

const SHAPES = BOARD_SHAPES.map((v) => v.id);
const FINS = BOARD_FINS.map((v) => v.id);
const SURFACES = BOARD_SURFACES.map((v) => v.id);
const HUMS = BOARD_HUMS.map((v) => v.id);

function int(value: unknown, max: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < max ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function normalizeBoardConfig(raw: unknown): BoardConfig {
  const v = (raw ?? {}) as Partial<BoardConfig>;
  return {
    shape: oneOf(v.shape, SHAPES, DEFAULT_BOARD.shape),
    fin: oneOf(v.fin, FINS, DEFAULT_BOARD.fin),
    deck: int(v.deck, BOARD_DECK_COLORS.length, DEFAULT_BOARD.deck),
    trim: int(v.trim, BOARD_DECK_COLORS.length, DEFAULT_BOARD.trim),
    glow: int(v.glow, BOARD_GLOW_COLORS.length, DEFAULT_BOARD.glow),
    surface: oneOf(v.surface, SURFACES, DEFAULT_BOARD.surface),
    surfaceScale: int(v.surfaceScale, 101, DEFAULT_BOARD.surfaceScale),
    surfaceWarp: int(v.surfaceWarp, 101, DEFAULT_BOARD.surfaceWarp),
    surfaceSeed: int(v.surfaceSeed, 65536, DEFAULT_BOARD.surfaceSeed),
    surfaceFlow: int(v.surfaceFlow, 101, DEFAULT_BOARD.surfaceFlow),
    surfaceReaction: int(v.surfaceReaction, 101, DEFAULT_BOARD.surfaceReaction),
    hum: oneOf(v.hum, HUMS, DEFAULT_BOARD.hum),
    pitch: int(v.pitch, BOARD_PITCHES.length, DEFAULT_BOARD.pitch),
    soundTone: int(v.soundTone, 101, DEFAULT_BOARD.soundTone),
    soundMotion: int(v.soundMotion, 101, DEFAULT_BOARD.soundMotion),
    soundThrust: int(v.soundThrust, 101, DEFAULT_BOARD.soundThrust),
    soundAir: int(v.soundAir, 101, DEFAULT_BOARD.soundAir)
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

/**
 * Distinct board per seed. Draw order is part of the wire contract — the
 * relay (server/server.mjs) runs the identical function so everyone agrees on
 * what an uncustomized player #id rides. Change one, change both.
 */
export function boardFromSeed(seed: string | number): BoardConfig {
  const roll = lcg(hashSeed(seed));
  const deck = Math.floor(roll() * BOARD_DECK_COLORS.length) % BOARD_DECK_COLORS.length;
  let trim = Math.floor(roll() * BOARD_DECK_COLORS.length) % BOARD_DECK_COLORS.length;
  if (trim === deck) trim = (trim + 3) % BOARD_DECK_COLORS.length;
  return {
    deck,
    trim,
    glow: Math.floor(roll() * BOARD_GLOW_COLORS.length) % BOARD_GLOW_COLORS.length,
    shape: pick(SHAPES, roll),
    fin: pick(FINS, roll),
    surface: pick(SURFACES, roll),
    surfaceScale: 22 + Math.floor(roll() * 67),
    surfaceWarp: 18 + Math.floor(roll() * 73),
    surfaceSeed: Math.floor(roll() * 65536),
    surfaceFlow: Math.floor(roll() * 66),
    surfaceReaction: 20 + Math.floor(roll() * 71),
    hum: pick(HUMS, roll),
    pitch: Math.floor(roll() * BOARD_PITCHES.length) % BOARD_PITCHES.length,
    soundTone: 20 + Math.floor(roll() * 66),
    soundMotion: 12 + Math.floor(roll() * 77),
    soundThrust: 20 + Math.floor(roll() * 66),
    soundAir: 10 + Math.floor(roll() * 71)
  };
}

export function randomBoardConfig(): BoardConfig {
  return boardFromSeed(`${Date.now()}:${Math.random()}`);
}

export function boardKey(config: BoardConfig): string {
  const c = normalizeBoardConfig(config);
  return `${boardVisualKey(c)}|${c.hum}|${c.pitch}|${c.soundTone}|${c.soundMotion}|${c.soundThrust}|${c.soundAir}`;
}

/** Mesh-relevant identity. Audio edits never need geometry/material rebuilds. */
export function boardVisualKey(config: BoardConfig): string {
  const c = normalizeBoardConfig(config);
  return `${c.shape}|${c.fin}|${c.deck}|${c.trim}|${c.glow}|${c.surface}|${c.surfaceScale}|${c.surfaceWarp}|${c.surfaceSeed}|${c.surfaceFlow}|${c.surfaceReaction}`;
}

export function isDefaultBoard(config: BoardConfig): boolean {
  return boardKey(config) === boardKey(DEFAULT_BOARD);
}

/** The player's explicit choice, or null for "never touched — seed from id". */
export function loadSavedBoard(): BoardConfig | null {
  try {
    const raw = localStorage.getItem(BOARD_STORAGE_KEY);
    if (raw) return normalizeBoardConfig(JSON.parse(raw));
  } catch {
    // corrupt entry: treat as no choice
  }
  return null;
}

export function saveBoardConfig(config: BoardConfig) {
  localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify(normalizeBoardConfig(config)));
}

// The local player's live config, readable by systems that build board meshes
// outside Player's control (abandonedMounts spawns your board where you left
// it — it should look like YOUR board, not the default).
let localBoard: BoardConfig = DEFAULT_BOARD;

export function setLocalBoardConfig(config: BoardConfig) {
  localBoard = normalizeBoardConfig(config);
}

export function localBoardConfig(): BoardConfig {
  return localBoard;
}
