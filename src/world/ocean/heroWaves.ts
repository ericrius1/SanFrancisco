/**
 * CPU twin of the spectral physics band (cascade 0, sparsified — see
 * spectrum.ts HERO_PAIRS). `waterHeight()` adds this so boats, boards,
 * swimmers, wakes and the chase camera ride the exact waves the GPU renders.
 *
 * Zero imports on purpose: heightmap.ts (boot-critical) pulls this in, and the
 * ocean module wires the actual components in later (P3, when Water is built).
 * Until then the ocean contributes 0 — matching the GPU, whose cascade
 * textures are also still empty.
 *
 * Two gates keep CPU and GPU in lockstep (both sides apply BOTH):
 *   • focus fade — the rendered FFT displacement rim-fades toward the flat far
 *     sheet around the local player (FOCUS_FADE_INNER→OUTER). The CPU applies
 *     the same radial fade around the same focus, so far entities sit on the
 *     flat far sheet and near ones ride full waves — exactly what's drawn.
 *   • strip gate — inside the authored Ocean Beach surf strip the spectral
 *     band yields to the authored wave train (surf gameplay tuning owns it).
 */

import type { HeroWaveComponent } from "./spectrum";

/** Must match the near-patch rim fade in water.ts (smoothstep OUTER→INNER). */
export const FOCUS_FADE_INNER = 200;
export const FOCUS_FADE_OUTER = 276;

export interface HeroStripGate {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Feather width (m) outside the rectangle. */
  feather: number;
}

let components: HeroWaveComponent[] = [];
let strip: HeroStripGate | null = null;
let focusX = 0;
let focusZ = 0;
let focusSet = false;

export function setHeroWaves(list: HeroWaveComponent[], stripGate: HeroStripGate | null): void {
  components = list;
  strip = stripGate;
}

/** Per-frame: the local player position (= centre of the rendered near patch). */
export function setHeroFocus(x: number, z: number): void {
  focusX = x;
  focusZ = z;
  focusSet = true;
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** 1 inside the authored surf strip → spectral band suppressed there. */
export function heroStripMask(x: number, z: number): number {
  if (!strip) return 0;
  const f = strip.feather;
  const inX =
    smooth01((x - (strip.minX - f)) / f) * (1 - smooth01((x - strip.maxX) / f));
  const inZ =
    smooth01((z - (strip.minZ - f)) / f) * (1 - smooth01((z - strip.maxZ) / f));
  return inX * inZ;
}

/** Spectral physics-band height at world (x,z), time t seconds. */
export function heroWaveHeight(x: number, z: number, t: number): number {
  const n = components.length;
  if (n === 0 || !focusSet) return 0;
  const dx = x - focusX;
  const dz = z - focusZ;
  const r2 = dx * dx + dz * dz;
  if (r2 >= FOCUS_FADE_OUTER * FOCUS_FADE_OUTER) return 0;
  const r = Math.sqrt(r2);
  // smoothstep(OUTER, INNER, r): 1 inside INNER, 0 at OUTER — the near patch rim.
  const fade = smooth01((FOCUS_FADE_OUTER - r) / (FOCUS_FADE_OUTER - FOCUS_FADE_INNER));
  if (fade <= 0) return 0;
  const gate = fade * (1 - heroStripMask(x, z));
  if (gate <= 0) return 0;
  let h = 0;
  for (let i = 0; i < n; i++) {
    const c = components[i];
    h += c.amp * Math.cos(c.kx * x + c.kz * z + c.sign * c.omega * t + c.phase);
  }
  return h * gate;
}
