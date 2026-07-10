import { tunables, tweakDefault } from "./core/persist"
import type { PlayerMode } from "./player/types"

// 2026-07 exposure re-anchor: toneMappingExposure now sits at an honest 1.0
// (the "/" slider trims 0.5–1.5 around it); historically the whole rig was
// authored against a 0.13 exposure. Every linear value the old rig authored —
// key/fill/moon intensities and the sky dome boost (sky.ts), the fog colours,
// baked emissive tints, LIGHT_SCALE below — shrinks by this factor so the
// rendered image is IDENTICAL at the anchor. New emitters should use
// LIGHT_SCALE (or author true linear values) and never reference this directly.
export const EXPOSURE_REBASE = 0.13

// The scene's light-unit rescale for things that emit in absolute units —
// emissive nodes, unlit sprites/tracers — sized so authored 0..1 colours keep
// their proportion to the lit world. Historically 100/6 (the reference sun over
// the old artistic sun), carried through the exposure re-anchor above.
export const LIGHT_SCALE = (100 / 6) * EXPOSURE_REBASE

/**
 * The one universal render mode: the fixed, measurement-tuned settings every
 * session runs. Replaces the old three-tier quality preset system (performance /
 * balanced / high) and its separate shadow-quality tiers, both removed 2026-07 —
 * there is no user-facing quality switch any more. The two other universal-mode
 * values live with the systems they configure: scene AA (single-sample by
 * default, optional 4x MSAA for profiling) in POSTFX_TUNING.sceneSamples
 * (render/postfx.ts), and the always-on CSM shadow config as named constants
 * near the setup in world/sky.ts.
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
} as const

/** Renderer grading, bound in the "/" panel's lighting folder. */
export const RENDER_TUNING = tunables("render", {
  // Anchored at 1.0 — a ±half-stop-ish artistic trim, NOT the day-brightness
  // control (that's sky.ts sunDay/hemiDay). Night, emissives and fog are all
  // balanced against the anchor, so big moves here shift everything at once.
  exposure: { v: 1.0, min: 0.5, max: 1.5, step: 0.01, label: "exposure" },
  // grey-card calibration chart (src/ui/calibrationChart.ts): camera-locked row
  // of matte spheres at 5/18/50/90% albedo — the referee for any grading change.
  greyCards: { v: false, label: "grey cards (5·18·50·90%)" },
  wireframe: { v: false, label: "wireframe mode" },
  // collider x-ray: draw every active physics collider as a wireframe box (red =
  // baked body, orange = citywide index, green = walk-in wall, blue = interior).
  // Diagnoses "invisible collision" — a box that sits where no mesh is drawn.
  colliderDebug: { v: false, label: "collider x-ray" }
})

/**
 * The official-example distance haze is calibrated at this draw distance.
 * Sky.applyFogParams scales its density by radius / DRAW_BASELINE and keeps a
 * narrow white edge fade over only the final 12% of the streamed radius, so
 * geometry culls invisibly without turning the whole middle distance into a wall.
 */
export const DRAW_BASELINE = 1200

/** Draw distance + fog, bound in the "/" panel. `radius` is the MASTER draw
 * distance: one top-level slider drives the tile streaming radii, rescales the
 * distance fog (see DRAW_BASELINE), and sets the citygen chunk reach — pull it
 * and the whole visible world grows or shrinks together. */
export const WORLD_TUNING = tunables("world", {
  radius: {
    v: DRAW_BASELINE,
    min: 50,
    max: 6000,
    step: 100,
    label: "draw distance (m)"
  },
  fogEnabled: { v: true, label: "custom fog" },
  // The five fog controls. Shape, colour, octave scales, path accumulation and
  // cull-edge calibration live together in sky.ts beside the r185 reference graph.
  //
  // Top of the marine layer in world metres. The 95 m default socks in low
  // districts while Twin Peaks, Sutro and the bridge towers emerge above it.
  fogTop: { v: 95, min: -20, max: 320, step: 1, label: "height (m)" },
  // Beer-Lambert path density inside the layer; 1 is the authored reference.
  fogBank: { v: 1, min: 0, max: 2, step: 0.02, label: "density" },
  // 1 = the official 22 m noisy-ceiling variation; 0 = a flat bank.
  fogNoise: { v: 1, min: 0, max: 1.5, step: 0.02, label: "billow" },
  // 1 = official r185 motion; lower values make the world-anchored billows evolve
  // more slowly without turning them into a coherently scrolling texture.
  fogDrift: {
    v: 1,
    min: 0,
    max: 2,
    step: 0.01,
    format: (v: number) => v.toFixed(2),
    label: "motion"
  },
  // The official exp² distance haze; the separate fixed edge fade hides only the
  // final streamed slice and is intentionally not an artistic control.
  fog: {
    v: 0.0012,
    min: 0,
    max: 0.0025,
    step: 0.00001,
    format: (v: number) => v.toFixed(5),
    label: "haze"
  }
})

/** Cosmetic vegetation visibility, bound in the "/" panel for performance checks. */
export const FOLIAGE_TUNING = tunables("foliage", {
  visible: { v: true, label: "foliage (trees/grass/flowers)" }
})

/**
 * Procedural building DETAIL (src/world/citygen). Read LIVE by the ring each
 * scan, so dragging these sliders in the "/" panel re-tunes streaming instantly —
 * watch the fps + the near/far band move. All perf-relevant:
 *  · detailRadius — distance band where buildings are *eligible* for the full grammar
 *    mesh (bays/windows/interior). Bigger = more candidates; the nearest maxDetail
 *    inside the band actually get the mesh (rest stay as chunk prisms).
 *  · maxDetail    — hard cap on resident full-detail buildings. Always the nearest-N
 *    inside detailRadius (far holders are evicted when nearer ones need a slot).
 *  · fadeTime     — LOD crossfade duration (s).
 * How FAR chunk-LOD cells stream is no longer its own knob — the ring derives it
 * from the master draw-distance slider (CONFIG.tileLoadRadius) each scan.
 */
export const CITYGEN_TUNING = tunables("citygen", {
  detailRadius: {
    v: 150,
    min: 40,
    max: 400,
    step: 5,
    label: "detail distance (m)"
  },
  maxDetail: {
    v: 40,
    min: 4,
    max: 140,
    step: 2,
    label: "max detail buildings"
  },
  fadeTime: { v: 0.4, min: 0.05, max: 2, step: 0.05, label: "crossfade (s)" }
})

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
})

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
})

/**
 * Where and how a fresh session starts. Editable in the Tab panel (persisted);
 */
export const START_DEFAULTS = {
  spawn: "goldenGate",
  mode: "board" as PlayerMode
}

export const START = {
  spawn: tweakDefault("start.spawn", START_DEFAULTS.spawn),
  mode: tweakDefault<PlayerMode>("start.mode", START_DEFAULTS.mode)
}

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

  // water
  seaLevel: 0.0,

  camera: {
    fov: 62,
    near: 0.3,
    far: 24000
  }
}
