import { tunables, tweakDefault } from "./core/persist";
import type { PlayerMode } from "./player/types";

// The scene's light-unit rescale: the reference sun illuminance (100, paired with
// ~0.13 exposure) over the old artistic sun (6 at 0.62). Anything that emits in
// absolute units — emissive nodes, unlit sprites/tracers — multiplies by this to
// keep its old proportion to the lit world.
export const LIGHT_SCALE = 100 / 6;

export type RenderQualityPreset = "performance" | "balanced" | "high";
export type ShadowQuality = "off" | "low" | "high";

export const SHADOW_QUALITY: Record<
  ShadowQuality,
  { enabled: boolean; mapSize: number; maxFar: number; lightMargin: number; normalBias: [number, number, number] }
> = {
  off: { enabled: false, mapSize: 0, maxFar: 0, lightMargin: 0, normalBias: [0.25, 1.0, 3.0] },
  low: { enabled: true, mapSize: 1024, maxFar: 220, lightMargin: 160, normalBias: [0.35, 1.2, 2.6] },
  high: { enabled: true, mapSize: 2048, maxFar: 600, lightMargin: 400, normalBias: [0.25, 1.0, 3.0] }
};

export const RENDER_QUALITY_PRESETS: Record<
  RenderQualityPreset,
  {
    maxPixelRatio: number;
    shadowQuality: ShadowQuality;
    sceneSamples: number;
    ssao: boolean;
    ssaoScale: number;
    ssaoSamples: number;
    ssaoRadius: number;
    ssaoIntensity: number;
  }
> = {
  performance: {
    maxPixelRatio: 1,
    shadowQuality: "off",
    sceneSamples: 0,
    ssao: false,
    ssaoScale: 0.5,
    ssaoSamples: 4,
    ssaoRadius: 1.2,
    ssaoIntensity: 2.5
  },
  balanced: {
    maxPixelRatio: 1.5,
    shadowQuality: "low",
    sceneSamples: 2,
    ssao: false,
    ssaoScale: 0.5,
    ssaoSamples: 4,
    ssaoRadius: 1.35,
    ssaoIntensity: 3.2
  },
  high: {
    maxPixelRatio: 1.5,
    shadowQuality: "high",
    sceneSamples: 4,
    ssao: true,
    ssaoScale: 0.5,
    ssaoSamples: 8,
    ssaoRadius: 1.5,
    ssaoIntensity: 4
  }
};

/** Renderer grading, bound in the "/" panel's lighting folder. */
export const RENDER_TUNING = tunables("render", {
  renderQuality: {
    v: "balanced",
    options: { Performance: "performance", Balanced: "balanced", High: "high" },
    label: "quality preset"
  },
  exposure: { v: 0.13, min: 0.01, max: 1, label: "exposure" },
  // drawing-buffer cap on devicePixelRatio. The scene is fragment-bound: retina
  // dpr 2 costs ~2× the frame time of 1.5 for a near-invisible sharpness delta
  // (measured 17.1 → 8.6 ms p50 at 2560×1600), so 1.5 is the default; dpr-1
  // displays are unaffected (the cap only ever lowers the ratio).
  maxPixelRatio: { v: 1.5, min: 0.5, max: 2, step: 0.05, label: "max pixel ratio" },
  // lit windows beyond the interior-raymarch range (~520 m): OFF (default) is
  // the original 0.55 "dusk sparkle" glow; ON boosts far panes toward the
  // room-emissive average so the whole skyline burns brighter at dusk. Purely
  // a look toggle — the shader cost is identical either way.
  farWindowGlow: { v: false, label: "far window glow boost" },
  shadowQuality: {
    v: "low",
    options: { Off: "off", Low: "low", High: "high" },
    label: "shadow quality"
  },
  wireframe: { v: false, label: "wireframe mode" }
});

/** Draw distance + fog, bound in the "/" panel. `radius` drives both tile radii. */
export const WORLD_TUNING = tunables("world", {
  radius: { v: 2100, min: 900, max: 6000, step: 100, label: "buildings (m)" },
  fog: { v: 0.00055, min: 0, max: 0.006, step: 0.00001, format: (v: number) => v.toFixed(5), label: "fog density" }
});

/**
 * Window lights on falling chunks: stay lit for `hold` seconds, then flicker out
 * over `flicker` seconds; each chunk starts its fade at hold + rand * spread so a
 * collapse never blacks out in one frame. Bound in the "/" panel's debris folder.
 */
export const DEBRIS_TUNING = tunables("debrisLights", {
  hold: { v: 2.5, min: 0, max: 8, step: 0.1, label: "lit time (s)" },
  flicker: { v: 1.2, min: 0.1, max: 4, step: 0.05, label: "flicker-out (s)" },
  spread: { v: 1.5, min: 0, max: 4, step: 0.1, label: "fade spread (s)" }
});

/**
 * Where and how a fresh session starts: parade truck on the Golden Gate Bridge
 * deck, heading toward Marin. Editable in the Tab panel (persisted);
 */
export const START_DEFAULTS = { spawn: "goldenGate", mode: "truck" as PlayerMode };

export const START = {
  spawn: tweakDefault("start.spawn", START_DEFAULTS.spawn),
  mode: tweakDefault<PlayerMode>("start.mode", START_DEFAULTS.mode)
};

export const CONFIG = {
  // streaming (load/unload gap is hysteresis so tiles don't thrash at the boundary;
  // both live-tweakable via the "/" panel's draw-distance slider)
  tileLoadRadius: WORLD_TUNING.values.radius,
  tileUnloadRadius: WORLD_TUNING.values.radius + 400,
  colliderRadius: 260,
  maxActiveBuildingBodies: 240,

  // physics
  gravity: [0, -9.81, 0] as const,
  // ground boxes under the player: one tilted slab per cell. Cell size sets how
  // well the slabs hug curving hills — plane-vs-terrain error grows with cell²,
  // and 26m cells left metre-high seams that walled the car on Nob Hill grades.
  // 8m cells sit on the heightmap lattice, so each slab spans one bilinear
  // patch and the walker stands where the visual mesh says the ground is.
  // 21x21 keeps the old 13x13@13m footprint: a whole playground zone (r≈46m)
  // fits inside the carpet while the player stands near it — zone toys only
  // wake when their footprint is fully carpeted (see props.ts)
  carpetSize: 21,
  carpetCell: 8,

  // destruction: ordinary crashes chip the facade; a building only comes down to
  // real energy. Impact energy is ½·m·approach² in kJ, so grazing scrapes stay
  // cheap no matter how fast the vehicle is moving.
  chipSpeed: 6, // m/s approach speed before a crash can mark the facade at all
  chipEnergy: 90, // kJ a hit must carry to knock chips off — above anything the walk/board
  // body can deliver (boosted board tops out ~67 kJ), so only vehicle-mass crashes scar masonry
  crashBoomEnergy: 1500, // kJ that reads as a bomb — the crash detonates (full-speed plane dive)
  buildingHpBase: 500, // kJ of cumulative structural damage even a shed shrugs off
  buildingHpPerM3: 3, // extra strength per m³, so towers are effectively immortal to ramming
  damageFloor: 200, // kJ an impact must exceed to count as structural, not cosmetic
  maxDebris: 960,
  debrisLifetime: 14,
  projectileSpeed: 95,
  projectileRadius: 0.45,
  explosionRadius: 13,
  explosionImpulse: 30,
  // kJ-equivalent a tracer burst drives into the facade it hits — sizes the
  // chip spray. Projectile damage is always cosmetic: a scar, never collapse
  projectileChip: 160,

  // water
  seaLevel: 0.0,

  camera: {
    fov: 62,
    near: 0.3,
    far: 24000
  }
};
