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
  }
> = {
  performance: {
    maxPixelRatio: 1,
    shadowQuality: "off",
    sceneSamples: 0
  },
  balanced: {
    maxPixelRatio: 1.5,
    shadowQuality: "low",
    sceneSamples: 2
  },
  high: {
    maxPixelRatio: 1.5,
    shadowQuality: "high",
    sceneSamples: 4
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
  // Draw distance. The marine-layer + distance fog (below) is tuned to fully melt
  // geometry into the sky by ~1350 m — the distance haze + a GLOBAL horizon veil
  // densify everywhere (not just the coast), so the tile radius sits low without a
  // visible pop-in edge: the fog IS the far cull. (Down from 1500; 1300 was a touch
  // too tight — it culled the FiDi cluster from the Embarcadero before the fog had
  // fully closed over it.) Push it back up if you turn fog down.
  radius: { v: 1400, min: 900, max: 6000, step: 100, label: "buildings (m)" },
  fogEnabled: { v: true, label: "custom fog" },
  // --- ground/valley bank: a marine layer that pools in low ground and lets the
  // hills poke through. base/top are world-Y metres; billow gives it a churning
  // edge; the marine field (fogMarine) makes it thick at the coast + Golden Gate
  // and thin downtown.
  fogBase: { v: -30, min: -140, max: 240, step: 1, label: "base" },
  fogTop: { v: 170, min: -20, max: 420, step: 1, label: "top" },
  fogBank: { v: 1.85, min: 0, max: 3, step: 0.05, label: "bank density" },
  fogSoftness: { v: 45, min: 1, max: 180, step: 1, label: "edge softness" },
  fogNoise: { v: 0.72, min: 0, max: 1, step: 0.02, label: "billow" },
  fogScale: { v: 0.0026, min: 0.0004, max: 0.01, step: 0.0001, format: (v: number) => v.toFixed(4), label: "billow scale" },
  fogDrift: { v: 0.03, min: 0, max: 0.12, step: 0.001, format: (v: number) => v.toFixed(3), label: "drift" },
  fogStart: { v: 20, min: 0, max: 1200, step: 10, label: "near fade" },
  // marine-layer contrast: 0 = uniform fog everywhere (old look), 1 = full
  // west/Golden-Gate-heavy, thin-downtown gradient. Coast/Gate get fogPeak× the
  // bank density, the sheltered east gets fogFloor×.
  fogMarine: { v: 1, min: 0, max: 1, step: 0.02, label: "marine contrast" },
  fogFloor: { v: 0.3, min: 0, max: 1.5, step: 0.02, label: "· east density" },
  fogPeak: { v: 2.1, min: 0.5, max: 3, step: 0.05, label: "· coast density" },
  // --- distance haze: exp² fog that slams shut far out so the draw edge melts
  // into the sky. This is the draw-distance lever.
  fog: { v: 0.0011, min: 0, max: 0.002, step: 0.00001, format: (v: number) => v.toFixed(5), label: "haze" },
  // GLOBAL far veil (region-independent) — the unified far-cull that lets the tile
  // radius sit low. Ramps in from `start` and is near-solid by the tile edge.
  fogHorizon: { v: 0.82, min: 0, max: 1.5, step: 0.02, label: "horizon veil" },
  fogHorizonStart: { v: 600, min: 300, max: 6000, step: 50, label: "horizon start (m)" },
  fogHorizonSoftness: { v: 550, min: 100, max: 3000, step: 50, label: "horizon softness" }
});

/** Cosmetic vegetation visibility, bound in the "/" panel for performance checks. */
export const FOLIAGE_TUNING = tunables("foliage", {
  visible: { v: true, label: "trees / grass visible" }
});

/**
 * Wildflower ring shaping, bound in the "/" panel's foliage folder. The flowers are
 * a player-following ring (like the grass); these knobs are read live on each
 * re-scatter, and the debug panel forces an immediate re-scatter on slider release.
 *  · density    — overall keep multiplier (0 = none, 1 = designed, up to 2.5 = carpet)
 *  · clumpiness  — 0 = even scatter across the field, 1 = tight clumps + sparse singles
 *  · clumpSize   — radius (m) of a clump when clumpiness > 0
 *  · reach       — ring radius (m) the flowers fill around the player
 */
export const FLOWER_TUNING = tunables("flowers", {
  density: { v: 1, min: 0, max: 2.5, step: 0.05, label: "density" },
  clumpiness: { v: 0.6, min: 0, max: 1, step: 0.02, label: "clump ↔ scatter" },
  clumpSize: { v: 9, min: 2, max: 30, step: 0.5, label: "clump size (m)" },
  reach: { v: 80, min: 30, max: 110, step: 2, label: "reach (m)" }
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
 * Where and how a fresh session starts. Editable in the Tab panel (persisted);
 */
export const START_DEFAULTS = { spawn: "goldenGate", mode: "board" as PlayerMode };

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
  // per-AI-car collider anchor radius: a car only needs a few tens of metres of
  // building bodies around it (it moves ~2.8 m between the 5 Hz body updates), so
  // this is far tighter than the player's, keeping the citywide budget bounded.
  carColliderRadius: 60,
  // static building AABBs are ~free in the box3d broadphase (they never move), so
  // this is generous enough to cover the player plus every bodied AI car at once
  // (48 cars × a handful of downtown boxes each) without starving the player.
  maxActiveBuildingBodies: 700,

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
