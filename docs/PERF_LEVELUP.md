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
- Foliage shadow casting/receiving and the native-tree proxy renderer were
  removed; plant residency and visibility changes no longer invalidate static CSM domains.

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

## Wave 3 (2026-07-17, fresh analysis on merged main)

Fresh probes on the combined codebase (this program + codex tea-garden +
flickerspy/water-echo sessions):

- Every stop measured FAST when booted fresh: pier 3.4ms, meadow 3.5-4.7ms
  (9.4ms with garden fully hydrated), marina ~8ms, downtown ~5ms frame p50.
- The baseline probe's scary pier numbers (52-76ms) do NOT reproduce in a
  clean environment and do NOT reproduce after a 4-stop teleport tour
  (3.4→3.6ms). They are an artifact of that probe's own shadows/DPR toggling
  ladder. Lesson recorded: trust fresh-boot single-stop measurements.
- Residency-leak theory tested and rejected: pier after touring
  downtown+marina+meadow = no frame cost delta.
- Census-script lesson: a visibility tally MUST walk ancestor visibility;
  counting `o.visible` alone reports pooled/hidden meshes (traffic-rig pool,
  embodiment stacks) as "visible" — several hundred phantom meshes.
- Garden tall-grass base = deliberate 48m frustum-cull tiles with count
  grading and a hard instance budget; bounded and healthy. Batching it is a
  modest optional win (~1-2ms at meadow), not a priority.
- Heightmap already ships int16-quantized (2.0 bytes/cell, terrain-codec
  repack) — the "quantize heightmap" idea was already shipped.
- dpr≥1.25 GPU cliffs at grass/water stops remain physical GPU load; the
  adaptive-resolution governor is the intended mitigation in real play.

Verdict: no measurement-supported CPU regressions remain on merged main.
Remaining backlog is speculative or architectural (worker sim, BatchedMesh
far-city, vehicle merges for extreme multiplayer crowds) — docs/WORKER_SIM.md
and MAIN_DECOMPOSITION.md carry those forward.

## Wave 4 (landed)

- Minimap repaint gate: 30 Hz cap + idle-signature skip (+force flag for the
  15 event repaint sites). Most of the OffscreenCanvas win in ~20 lines.
- Worker-sim payload audit (WORKER_SIM.md): all worker-eligible systems
  measure <0.3 ms — worker ships no payload until one crosses ~1 ms
  (first candidate: remote interpolation at 20+ players).
- BatchedMesh far-city ROADS: src/world/tileBatch.ts (size-classed slots,
  arena growth, per-instance frustum culling, handle add/free). Downtown
  ~44 road draws → 1; meadow ~59 → 1. Streaming cadence preserved (one
  arena upload per attach frame); boot unchanged.

## Wave 5 (landed, commits fc5c156 / 65487fc, 2026-07-18)

- Building-tile batching — SHIPPED. createFacadeMaterial (facade.ts) made
  batch-aware (shared alive-texture atlas with per-instance row via
  getIndirectIndex; per-instance scale replaces the modelScale dequant divide).
  Whole-city buildings collapse into one BatchedMesh — the ~42-59 bld draws
  per stop prize.
- Park (grn_) tile meshes — SHIPPED through the same generic tileBatch (~40
  tiles), alongside the main.ts decomposition round 2 + tile-batch pipeline
  prewarm hook (65487fc).

## Wave 6 (2026-07-23, multi-agent GPU-indirect + merge push)

Large parallel push focused on GPU-driven culling, draw-call merges, and the
adaptive governor. Landed in the working tree; verified functionally by headless
browser QA (grass-cull, perf-shot, avatar-zfight, buskers-motion, direct
foliage-toggle + garden-grass readback probes) — no WebGPU validation errors, no
visual regressions in the stop screenshots.

- Unified GPU indirect core — src/render/gpuIndirect.ts. One reset→cull→
  atomicAdd→visible-index-indirection pipeline now backs wildlands grass,
  botanical grass, the wildlands flower ring, AND the new tree far tiers. Cull
  writes indirect draw counts on-GPU (no CPU readback; readbackBuffers stays 0).
- Tree far tiers on GPU cull + indirect — src/world/nativeTreeForest/
  gpuFarTiers.ts + farCullRegistry.ts, integrated in nativeTreeForest/index.ts
  behind GPU_FAR_TIERS (A/B flag), dispatched once per frame from frameBody via
  renderNativeTreeForestFarCulls (dependency-light registry shim; no-op when no
  far forest is resident). Fixed per-frame draw count, dithered LOD dissolve.
- Botanical grass rewritten to the indirect pipeline — src/world/garden/
  botanicalGrass.ts: 132 hydrated patch draws → 4 indirect draws (base carpet +
  near/mid/far), player-following field with per-frame render-camera cull. The
  old paged-resample hitch class is deleted. (QA: ~10.3k visible instances,
  4 indirect layers, correct rank-fade shading at GARDEN_MEADOW.)
- Embodiment merge — src/player/rig.ts buildRig default is now ONE SkinnedMesh
  per character (rigid bone skinning, palette uniforms): ~73 → 1 draw/character.
  6 NPC files opt back into the classic path (buskers flutist/handpanist/
  ukulelist, beach pianist, tea master, sutro bathers). (QA: avatar-zfight probe
  reports meshes=1, coplanarPairs=0, <1% temporal flicker.)
- Static merges generalized — src/world/staticBatch.ts: ghost ship ~20 → 8
  draws, Mission Dolores exhibits ~170 sibling meshes collapsed. Grace Cathedral
  wrapper is a no-op; tea garden unchanged via the wrapper.
- Occlusion gates — src/render/occlusionGate.ts: ghost-ship visuals + Mission
  Dolores interior, K=10 hide hysteresis with instant reveal. Kill switch
  OCCLUSION_GATES_ENABLED.
- Adaptive governor L0-L4 ladder — src/render/adaptiveResolution.ts exports
  governorEffects()/onGovernorChange(); consumers: grass + flower density,
  hero-shadow half-rate (clipmapShadowNode), contact-shadow scale, FFT economy.
  Quiet-mode 30 fps frame-skip in frameDriver (RENDER_TUNING.quietMode).
- Grass opaque blades — rank fade moved into the cull compute (blade alpha-test
  deleted; anchor-shrink edge softening). SSS material only on near/hero layers;
  mid/far use cheaper MeshStandard. Density × governor foliageScale.
- Water annulus/horizon split — src/world/water.ts: far sheet split into a
  camera-following ~2.2 km annulus (full material) + a static cheap horizon
  sheet; FFT economy mask alternates fine cascades when the governor is hot
  (never while surfing). (QA: annulus↔horizon seam invisible at the marina stop.)
- Shadow axes — hero clipmap shadow half-rate + contact-shadow scale composed as
  governor ceilings (min of user value and governor allowance).
- Facade occlusion-swap distances reviewed and found already-optimal (280/240 m)
  — no change made.

Note: fresh M5 Air baselines + a soak run were deliberately deferred this push
(profiling skipped). Re-run perf-baseline + census clean and record numbers
before treating any of the above as measured wins.

## Wave 7 (2026-07-24) — the probe was lying, and every number above is suspect

### READ THIS BEFORE CITING ANY MEASUREMENT IN THIS DOCUMENT

Every deterministic probe in this repo silently under-reported frame cost, from
the beginning of the program until 2026-07-24. `__sf.tick()` drove the frame by
hand but never advanced three's node frame token:

- `PassNode.updateBeforeType` is `NodeUpdateType.FRAME`, so the post chain's
  scene pass re-renders only when `nodeFrame.frameId` changed
  (`NodeFrame.updateBeforeNode`).
- That token is bumped in exactly ONE place — the rAF callback inside
  `Animation.start()` (`three/src/renderers/common/Animation.js:77`), i.e. the
  renderer's own animation loop. `renderer.render()` bumps `renderId`, never
  `frameId`.
- `__sfManual(true)` parks that loop. So a manual tick ran the composite, which
  sampled the PREVIOUS scene texture and re-presented a stale frame.

It hid for so long because it is timing-dependent: when a manual tick loop was
slow enough, rAF interleaved and bumped the token anyway. The bug only became
visible once the app got FAST enough that a 130-tick window finished in ~0.2 s
with no interleaving — at which point the probe rendered a flat frame.

Fixed: `frameDriver.manualTick()` + `advanceNodeFrame()` (src/app/frameDriver.ts),
with `__sf.tick` rebound to it in src/app/compose/debugExposure.ts, so every
deterministic consumer (perf probes, calibration, cinematic capture) is correct
at once. The token is bumped only while the wall-clock loop is parked — bumping
on a live frame would run every FRAME-scoped node twice.

Consequences:
- **Every frame-time number in waves 0-6 above is unreliable.** Do not cite them
  as baselines or as evidence that a past change helped. They are kept for the
  narrative, not the numbers.
- This also explains the long-standing `calls=0 / tris=0.0M` mystery in probe
  output: `renderer.info` is reset by `info.autoReset` inside that same rAF
  callback.
- The Wave 3 note "trust fresh-boot single-stop measurements" was folk wisdom
  compensating for this bug. It can be retired.

### A SECOND probe flaw, found the same day — and still open

Fixing the node-frame token was necessary but NOT sufficient. Two more defects
in `tools/perf-baseline-probe.mjs` surfaced while trying to take a clean
before/after:

1. **No residency gate (FIXED).** The probe settled for a fixed ~4.2 s after
   teleporting, which is nowhere near enough for regional foliage. The botanical
   meadow was therefore benchmarked with or without its grass depending on luck:
   the same build measured 0.9 ms on one run and 12.9 ms on another. A residency
   gate (garden/wildlands owners attached, citygen prepare drained, 120 s budget,
   loud warning on timeout) now runs before the tier ladder.

2. **First-tier contamination (STILL OPEN).** `WARM` does not drain the work a
   tier switch kicks off (pipeline rebuilds, render-target reallocation, shadow
   refill), so the first tier measured at each stop absorbs it. The tell is a row
   where a HIGHER dpr is FASTER — downtown reported 20.8 ms at dpr1 and 1.3 ms at
   dpr1.5 in one run. Until this is fixed: treat tier[0] as a throwaway, compare
   stops only within the same tier index, and trust a row only when it is stable
   across all four tiers.

Consequence for this wave: **no honest end-to-end frame-time delta is available.**
The harness was broken before the work started and is only partly repaired, so
there is no valid "before" to subtract. Claims below are mechanism-level and
independently checkable (byte counts, texture-fetch counts in captured WGSL,
dispatch counts, resident bytes) rather than stopwatch deltas. Anyone continuing
this program should fix flaw 2 FIRST and re-baseline before optimizing further.

### What the residency-gated probe does establish (2026-07-24, M5 Air, 2560x1600)

With grass actually resident, the botanical meadow reads **28-36 ms across all
four tiers** — stable, so this one is trustworthy. That is ~28-36 fps and it is
the single worst scene in the game. Earlier meadow numbers in the 12-13 ms range
were measuring a half-empty meadow.

Every other stop reads in the low single digits once past tier[0].

Verdict: **grass is the remaining frontier**, and it is fragment-bound. The
analysis in this wave modelled the meadow as `frame = 1.7 + 11.2 x pixelRatio`
(~87% per-pixel), with ~60-70% of grass fragment ALU going to two shared terms
that grass does not need at its scale: the analytic sky IBL (evaluated TWICE per
lit fragment via EnvironmentNode's radiance + irradiance contexts) and the
full marine-layer fog graph (two 2-octave tri-noise fields). Substituting a cheap
hemispheric env node and a grass-local distance fog is the biggest single lever
left and was deliberately NOT taken this wave — it needs Sky to expose its
palette/fog uniforms, and it needs a visual A/B that a broken probe cannot
support.

### Landed this wave

- Boot: `vendor` chunk 1,190 KB -> 46 KB (box3d's inline wasm was force-hoisted
  into the eager chunk by the manualChunks catch-all); `bootTiles` no longer
  serializes `prepareFacadeTextures()` ahead of TileStreamer, so landmarks.glb
  starts at ~130 ms instead of ~725 ms; precompress-dist now covers .glb/.wasm
  (landmarks.glb 810 KB -> 135 KB br).
- Shared fragment path: hero clipmap shadow domain gated to its 15.9 m radius
  (bit-identical — heroEdgeWeight was already exactly 0 outside it); one
  triNoise3D fog octave dropped; sky dome moved to draw last among opaques.
- postfx: the underwater-fog + 16-tap god-ray block is gated out of dry-land
  frames — composite drops from 19 full-res texture fetches to 2.
- Water: near/hero displaced sheets hide beyond 460 m of any water; FFT cascade
  dispatches gated by proximity (24 -> 12 at the Ferry Building, -> 6 inland).
- Adaptive governor: **it could only ratchet down.** `COOL_MS = 15` sat below the
  16.67 ms vsync floor, so on a 60 Hz panel the step-up path was dead code and a
  single transient hot spell pinned the session blurrier for its whole life.
  Thresholds are now refresh-relative (measured display interval, tumbling-window
  minimum) with asymmetric dwell.
- Occlusion gates were a NO-OP: `Renderer.isOccluded()` returns null outside a
  render pass, so the ghost ship and Mission Dolores never hid while still paying
  per-frame QuerySet + MAP_READ churn. Now functional.
- Wave 6 bug fixes: far-tier indirect counts now reset on last-chunk unload;
  far-tree cull no longer frozen through world arrival; Mission Dolores exhibit
  teardown detaches again; shared RIG_PROXY_MAT no longer disposed by site
  teardown traversals; merged rig is frustum-culled and no longer casts full
  detail into the hero shadow domain.
- Cleanup: 5 orphaned shipped assets deleted (7.5 MB — rockin.mp3, guitarist.glb,
  golden-gate-historical-pilot.webp, glass-francis.{ktx2,webp}); 6 dead source
  files (~1,700 lines) deleted; the 5 Wave 6 files that were imported by tracked
  code but never `git add`ed are now tracked (a fresh clone was broken).

### Standing rule added

- `reversedDepthBuffer: true` (src/app/renderCore.ts:49) makes three's
  `RenderList.sort()` reverse the whole sorted list, which inverts `groupOrder`
  and `renderOrder` — not just depth. **In this app a HIGHER renderOrder draws
  EARLIER.** The ~98-entry renderOrder ladder (water 9 -> 12.7, HUD 90 -> 9999)
  was authored under this inversion. Anyone touching draw order must account for
  it, and turning reversed-z off would silently re-invert the whole ladder.
