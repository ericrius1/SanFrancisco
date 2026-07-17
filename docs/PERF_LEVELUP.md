# Performance level-up program

Working doc for the July 2026 performance/quality/loading push. Coordinator
notes live here so waves of work stay grounded in measurements, not vibes.
Companion doc: MAIN_DECOMPOSITION.md (main.ts modularization).

## Measured baseline (2026-07-17, worktree, headless M-series, 2560×1600)

Whole-app probe (`tools/perf-baseline-probe.mjs`), cpu p50 = sim + encode per
frame before / after the wave-0 fixes:

| stop | cpu before | cpu after wave 1+2 | frame p50 (dpr1, shadows on) |
|---|---|---|---|
| golden gate deck | 37.8 ms | 15.6-17.5 ms (−56%) | 51.6 → 25 ms (19→40 fps) |
| residential marina | ~21 ms | 7.4-9.6 ms (−60%) | 34.9 → 16.4 ms (29→61 fps) |
| botanical meadow | ~20 ms | 9.4-11.7 ms | 36.8 → 36.8 ms (GPU-bound: grass) |
| downtown FiDi | ~6-7 ms | 5.6-9 ms | 25 → 18.5 ms (40→54 fps) |
| embarcadero pier | 10.7-16 ms | 7.3-8.6 ms | ~unchanged (water GPU-bound) |

Fix stack: scatter-boat far gate, tea-garden sim gate, boat mesh merge,
traffic-rig merge, audio NaN guard. Meadow + pier are now GPU-bound (grass /
water) — next levers there are GPU-side, not draws.

Boot (dev, headless): reveal 2.7 s — warmup ≈1.5 s (scene pipeline compile
≈1.1 s), tiles ≈0.4 s. Prod bundle after vendor split: main 1.15 MB + three
1.37 MB + vendor 1.19 MB + debug-ui 152 KB (debug-ui loads on first "/").

## Wave 0 (landed)

- Scatter boats far-hide (abandonedMounts) — ~520 draws citywide removed.
- Audio listener NaN guard (audio/engine.ts) — per-frame throw after teleports.
- Tea-garden pond/koi/sand sim distance gate (150/175 m) inside 720 m awake radius.
- Adaptive resolution governor (render/adaptiveResolution.ts), floor 0.7×.
- Vendor/debug-ui chunk split; tweakpane + Inspector dynamic-import on first use.
- Authored-shrub renderer: core hull + inner layer + skirt (visual, cost-neutral).
- Tree shadow proxies: world-hash perforated crown + species cover + lumpy
  silhouette (shadows/treeShadowProxy.ts) — dapple instead of blob.

## Wave 1 (in flight, parallel agents, disjoint file ownership)

1. Boat mesh draw-merge (vehicles/boat/*) — ~35 meshes/boat → 2-4.
2. Traffic light rig draw-merge (world/traffic/trafficLights.ts) — 18/rig → ≤4.
3. Warmup diet round 2 — CLOSED, no-change (evidence-backed): boot warmup is
   already near-optimal. Shadows compile in the covered renderFrame (all three
   domains, before warmup); only ONE postfx variant compiles; skipping the
   scene compilePass makes reveal WORSE (work moves to serial
   createRenderPipeline paths). Real levers live elsewhere: fewer materials in
   the spawn frustum, and three.js-level parallel BundleGroup pipeline
   compilation (~500ms serial covered-render cost, cannot be compileAsync'd).
4. main.ts compose extractions (app/compose/*) — decomposition step 1.
5. KTX2 rollout assessment (read-only plan).

Rule: one agent per file set; only the decomposition agent touches main.ts.

## Wave 1 results (landed)

- Boats: sailboat ~46→6 draws, speedboat ~19→2 (vertex-color merge; sails/
  pennant/boom stay animated; emissive fixtures merged with baked emissive).
- Traffic rigs: 18→4 draws/rig (merged frame + merged lens mesh, uniform-driven
  lit state — also removes the per-phase-change bundle re-record).
- main.ts: 5,907→5,408 lines, 7 app/compose modules.
- Post-wave census: boat Lambert flood and TrafficLightRig gone from the
  downtown top list. Meadow now dominated by sf_botanical_garden (132 patch
  draws when hydrated) — garden patch batching is a wave-2 candidate.

## Wave 2 progress

- GLB textures → KTX2 (KHR_texture_basisu) DONE for the two live hero assets:
  eye-walker (~24-31 MB VRAM saved) + phoenix (~56 MB saved; WebP sources
  decoded via sharp first). attachKtx2Loader wired into all 4 GLTFLoader
  sites; tools/optimize-glb-textures.mjs is the converter; backups in
  .data/glb-backups/. truck.glb / eagle.glb / phoenix-hero-lod1.glb are
  ORPHANED (no code references) — deletion is the user's call (~13 MB).
- loadTexture KTX2 rollout confirmed COMPLETE (74 .ktx2); redundant surfboard
  PNGs deleted (−1.8 MB wire).

## Wave 2 (still queued)

- Embodiment/player mesh stack merge (~73 visible meshes at player).
- Botanical-garden patch batching (132 draws when hydrated).
- Streamed heightfield: split heightmap/surface grids into center-first tiles.
- Worker-owned ambient sim (traffic, wanderers, net interpolation) via SAB.
- Region QA sweep: shrub renderer change is shared — screenshot corona
  heights, sutro baths, botanical garden, buena vista understory.
- Re-run perf-baseline + census clean (no concurrent processes) and record here.

## Standing rules

- Persistent decorative entities MUST carry far-hide gates (hysteresis).
- Localized sims sleep on player distance, not just region awake radius.
- New features never add per-frame work without a tracer phase/counter.
- Optional/debug tooling never ships in the boot chunk.
