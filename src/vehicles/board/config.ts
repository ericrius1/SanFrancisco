/**
 * Hoverboard identity — the rider-facing customization knobs (shape, colors,
 * fins, deck art, hum voicing). Mirrors the avatar-traits contract exactly:
 * normalize accepts any junk off the wire, a per-id seed gives uncustomized
 * players distinct boards, and localStorage is written only when the player
 * actually edits (an absent key means "seed me from my server id" — the same
 * v3 lesson avatar.ts learned about multi-tab identical blobs).
 */

export type BoardShape = "classic" | "dart" | "manta" | "saucer" | "twintip";
export type BoardFin = "none" | "twin" | "spoiler" | "halo";
export type BoardDeco = "clean" | "stripe" | "chevrons" | "dots" | "comet";
export type BoardHum = "hum" | "crystal" | "deep" | "choir" | "retro";

export type BoardConfig = {
  shape: BoardShape;
  fin: BoardFin;
  deco: BoardDeco;
  deck: number; // index into BOARD_DECK_COLORS
  trim: number; // index into BOARD_DECK_COLORS (deck art, fins, spoiler)
  glow: number; // index into BOARD_GLOW_COLORS (rails, underglow, thrusters, light)
  hum: BoardHum; // synth voicing (fx/vehicleAudio.ts)
  pitch: number; // index into BOARD_PITCHES
};

export const BOARD_STORAGE_KEY = "sf-board-v1";

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

export const BOARD_DECOS: { id: BoardDeco; label: string }[] = [
  { id: "clean", label: "clean" },
  { id: "stripe", label: "stripe" },
  { id: "chevrons", label: "chevrons" },
  { id: "dots", label: "dots" },
  { id: "comet", label: "comet" }
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

/** Today's board, upgraded: coral deck, cloud stripe, bay-ice glow, classic hum. */
const DEFAULT_BOARD: BoardConfig = {
  shape: "classic",
  fin: "none",
  deco: "stripe",
  deck: 0,
  trim: 5,
  glow: 0,
  hum: "hum",
  pitch: 0
};

const SHAPES = BOARD_SHAPES.map((v) => v.id);
const FINS = BOARD_FINS.map((v) => v.id);
const DECOS = BOARD_DECOS.map((v) => v.id);
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
    deco: oneOf(v.deco, DECOS, DEFAULT_BOARD.deco),
    deck: int(v.deck, BOARD_DECK_COLORS.length, DEFAULT_BOARD.deck),
    trim: int(v.trim, BOARD_DECK_COLORS.length, DEFAULT_BOARD.trim),
    glow: int(v.glow, BOARD_GLOW_COLORS.length, DEFAULT_BOARD.glow),
    hum: oneOf(v.hum, HUMS, DEFAULT_BOARD.hum),
    pitch: int(v.pitch, BOARD_PITCHES.length, DEFAULT_BOARD.pitch)
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
    deco: pick(DECOS, roll),
    hum: pick(HUMS, roll),
    pitch: Math.floor(roll() * BOARD_PITCHES.length) % BOARD_PITCHES.length
  };
}

export function randomBoardConfig(): BoardConfig {
  return boardFromSeed(`${Date.now()}:${Math.random()}`);
}

export function boardKey(config: BoardConfig): string {
  const c = normalizeBoardConfig(config);
  return `${c.shape}|${c.fin}|${c.deco}|${c.deck}|${c.trim}|${c.glow}|${c.hum}|${c.pitch}`;
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
