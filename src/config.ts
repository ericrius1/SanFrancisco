import { tunables, tweakDefault } from "./core/persist";
import type { PlayerMode } from "./player/types";

// The scene's light-unit rescale: the reference sun illuminance (100, paired with
// ~0.13 exposure) over the old artistic sun (6 at 0.62). Anything that emits in
// absolute units — emissive nodes, unlit sprites/tracers — multiplies by this to
// keep its old proportion to the lit world.
export const LIGHT_SCALE = 100 / 6;

/**
 * The one universal render mode: the fixed, measurement-tuned settings every
 * session runs. Replaces the old three-tier quality preset system (performance /
 * balanced / high) and its separate shadow-quality tiers, both removed 2026-07 —
 * there is no user-facing quality switch any more. The two other universal-mode
 * values live with the systems they configure: scene MSAA = 2 in
 * POSTFX_TUNING.sceneSamples (render/postfx.ts) and the always-on CSM shadow
 * config as named constants near the setup in world/sky.ts.
 */
export const RENDER_MODE = {
  // drawing-buffer cap on devicePixelRatio. The scene is fragment-bound: retina
  // dpr 2 costs ~2× the frame time of 1.5 for a near-invisible sharpness delta
  // (measured 17.1 → 8.6 ms p50 at 2560×1600). dpr-1 displays are unaffected —
  // the cap only ever lowers the ratio.
  pixelRatioCap: 1.5,
  // Dynamic-resolution governor (src/render/dynamicRes.ts): under sustained
  // frame pressure the drawing-buffer pixel ratio steps down from the ceiling
  // — min(devicePixelRatio, pixelRatioCap) — toward minPixelRatio, and back up
  // when there's headroom, so weaker GPUs hold the display's frame budget.
  dynamicRes: true,
  // Lowest pixel ratio the governor will drop to under sustained load.
  minPixelRatio: 1.0
} as const;

/** Renderer grading, bound in the "/" panel's lighting folder. */
export const RENDER_TUNING = tunables("render", {
  exposure: { v: 0.13, min: 0.01, max: 1, label: "exposure" },
  wireframe: { v: false, label: "wireframe mode" },
  // collider x-ray: draw every active physics collider as a wireframe box (red =
  // baked body, orange = citywide index, green = walk-in wall, blue = interior).
  // Diagnoses "invisible collision" — a box that sits where no mesh is drawn.
  colliderDebug: { v: false, label: "collider x-ray" }
});

/** Draw distance + fog, bound in the "/" panel. `radius` drives both tile radii. */
export const WORLD_TUNING = tunables("world", {
  // Draw distance. The marine-layer + distance fog (below) is tuned to fully melt
  // geometry into the sky by ~1350 m — the distance haze + a GLOBAL horizon veil
  // densify everywhere (not just the coast), so the tile radius sits low without a
  // visible pop-in edge: the fog IS the far cull. (Down from 1500; 1300 was a touch
  // too tight — it culled the FiDi cluster from the Embarcadero before the fog had
  // fully closed over it.) Push it back up if you turn fog down.
  // 1200: the horizon veil now closes to full opacity (fogHorizon 1.0) by ~1150 m,
  // so the far cull is genuinely solid and the radius can drop below where it used
  // to pop — fewer far buildings drawn, all of them fully fogged before the edge.
  radius: { v: 1200, min: 900, max: 6000, step: 100, label: "buildings (m)" },
  fogEnabled: { v: true, label: "custom fog" },
  // fog colour: 0 = pure reference near-white (0xd0dee7, three's webgpu_custom_fog),
  // 1 = fully phase-atmospheric (blue by day, rose at golden hour, dark blue at
  // night). The DEFAULT bank reads as a luminous white marine layer with a little
  // sky colour bled in; the far horizon veil always stays atmospheric regardless so
  // distant geometry melts into the actual sky, never a white band.
  fogTint: { v: 0.3, min: 0, max: 1, step: 0.02, label: "atmosphere tint" },
  // --- ground/valley bank: a marine layer that pools in low ground and lets the
  // hills poke through. base/top are world-Y metres; billow gives it a churning
  // edge; the marine field (fogMarine) makes it thick at the coast + Golden Gate
  // and thin downtown.
  fogBase: { v: -30, min: -140, max: 240, step: 1, label: "base" },
  // top pulled down (was 170) so the bank doesn't tower over the elevated Golden
  // Gate deck (y≈67) or bury the tops of things — the lid now sits below deck level.
  fogTop: { v: 130, min: -20, max: 420, step: 1, label: "top" },
  // bank density dropped (was 1.85) so the marine layer reads as a translucent veil,
  // not an opaque wall: from the GG deck you can now see the bay water below rather
  // than a grey wall. See fogPeak for the coast/Gate multiplier this scales.
  fogBank: { v: 1.05, min: 0, max: 3, step: 0.05, label: "bank density" },
  fogSoftness: { v: 45, min: 1, max: 180, step: 1, label: "edge softness" },
  fogNoise: { v: 0.72, min: 0, max: 1, step: 0.02, label: "billow" },
  fogScale: { v: 0.0026, min: 0.0004, max: 0.01, step: 0.0001, format: (v: number) => v.toFixed(4), label: "billow scale" },
  fogDrift: { v: 0.03, min: 0, max: 0.12, step: 0.001, format: (v: number) => v.toFixed(3), label: "drift" },
  fogStart: { v: 60, min: 0, max: 1200, step: 10, label: "near fade" },
  // marine-layer contrast: 0 = uniform fog everywhere (old look), 1 = full
  // west/Golden-Gate-heavy, thin-downtown gradient. Coast/Gate get fogPeak× the
  // bank density, the sheltered east gets fogFloor×.
  fogMarine: { v: 1, min: 0, max: 1, step: 0.02, label: "marine contrast" },
  fogFloor: { v: 0.3, min: 0, max: 1.5, step: 0.02, label: "· east density" },
  // coast/Gate multiplier dropped (was 2.1): 1.85×2.1 = 3.885 fully saturated the
  // low band along the whole coast + Golden Gate, so the bay water read as an opaque
  // wall from the bridge. 1.05×1.25 ≈ 1.3 leaves the near/mid water visible while the
  // far water + distance still fog out via the horizon veil (the actual far-cull).
  fogPeak: { v: 1.05, min: 0.5, max: 3, step: 0.05, label: "· coast density" },
  // --- distance haze: exp² fog that slams shut far out so the draw edge melts
  // into the sky. This is the draw-distance lever.
  fog: { v: 0.0011, min: 0, max: 0.002, step: 0.00001, format: (v: number) => v.toFixed(5), label: "haze" },
  // GLOBAL far veil (region-independent) — the unified far-cull that lets the tile
  // radius sit low. Ramps in from `start` and is near-solid by the tile edge.
  // veil nudged up (was 0.82) to keep the far-cull firm now that the bank is thinner —
  // the last stretch to the tile edge still melts into sky so radius can stay at 1400.
  fogHorizon: { v: 1.0, min: 0, max: 1.5, step: 0.02, label: "horizon veil" },
  fogHorizonStart: { v: 600, min: 300, max: 6000, step: 50, label: "horizon start (m)" },
  fogHorizonSoftness: { v: 550, min: 100, max: 3000, step: 50, label: "horizon softness" }
});

/** Cosmetic vegetation visibility, bound in the "/" panel for performance checks. */
export const FOLIAGE_TUNING = tunables("foliage", {
  visible: { v: true, label: "foliage (trees/grass/flowers)" }
});

/**
 * Procedural building streaming (src/world/citygen). Read LIVE by the ring each
 * scan, so dragging these sliders in the "/" panel re-tunes streaming instantly —
 * watch the fps + the near/far band move. All perf-relevant:
 *  · detailRadius — distance band where buildings are *eligible* for the full grammar
 *    mesh (bays/windows/interior). Bigger = more candidates; the nearest maxDetail
 *    inside the band actually get the mesh (rest stay as chunk prisms).
 *  · maxDetail    — hard cap on resident full-detail buildings. Always the nearest-N
 *    inside detailRadius (far holders are evicted when nearer ones need a slot).
 *  · fadeTime     — LOD crossfade duration (s).
 *  · cellLoad/Unload — how many tile cells (≈800 m) of chunk-LOD stream around you.
 */
export const CITYGEN_TUNING = tunables("citygen", {
  detailRadius: { v: 150, min: 40, max: 400, step: 5, label: "detail distance (m)" },
  maxDetail: { v: 40, min: 4, max: 140, step: 2, label: "max detail buildings" },
  fadeTime: { v: 0.4, min: 0.05, max: 2, step: 0.05, label: "crossfade (s)" },
  cellLoad: { v: 1, min: 1, max: 3, step: 1, label: "chunk cells (±)" },
  cellUnload: { v: 2, min: 2, max: 5, step: 1, label: "chunk unload (±)" }
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
 * Wildlands grass ring shaping — the player-following blade grass (the same
 * blades as the botanical garden). Read live on each re-scatter; the debug panel
 * forces one on slider release. These only change how MANY blades grow and where
 * — the wind sway is a GLOBAL shared envelope, so grass bends in lockstep with
 * the flowers at any density.
 *  · density    — keep multiplier (0 = bare ground, 1 = designed, up to 2.5 = carpet)
 *  · patchiness — 0 = even lawn, 0.5 = designed clumps/clearings, 1 = strong patches
 */
export const GRASS_TUNING = tunables("grass", {
  density: { v: 1, min: 0, max: 2.5, step: 0.05, label: "density" },
  patchiness: { v: 0.5, min: 0, max: 1, step: 0.02, label: "even ↔ patchy" }
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
  // static building AABBs are ~free in the box3d broadphase (they never move), so
  // this comfortably covers every facade within the player's collider radius.
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
