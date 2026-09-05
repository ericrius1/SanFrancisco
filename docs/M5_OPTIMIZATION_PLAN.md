# M5 Air / WebGPU optimization review and implementation

Updated 2026-09-05. Target: the Apple M5 MacBook Air with 24 GB in this workspace, plus WebGPU-capable laptops and desktops. Full mobile support is outside this pass. The changes live on `codex/m5-world-upgrade`; the original checkout's local work is preserved in the worktree baseline.

## Main integration

The release combines optimization commit `94bfb5e` with main's `7708a2f` weather, living-score and atomic CityGen ownership changes. Conflict resolution retains both the optional optimization owners and the weather/music updates in world composition, and uses main's matched authored-site sources and ledgers. The integrated production bundle is `main-BQrDIaRg.js`.

Asset validation, TypeScript, the production lazy-chunk contract, eight focused CPU regressions, and headless production landmark, weather and living-score checks pass on the combined source. The performance measurements below belong to the earlier `main-tXiqEXIq.js` optimization snapshot; the 20-minute timed run was not repeated after incorporating main's newer weather/music work. Integration logs are under `.data/merge-release/`.

## Outcome

This pass implements the main architecture changes in the original ranked plan: optional vehicle loading, bounded detailed city residency with a far skyline, representative shader preparation, transactional ecology uploads, distant groundcover coverage, laptop profiles, shared texture decoding, junction-aware ambient life, and a smaller cloud pass. Japanese Tea Garden, Beach Pianist and the other activity/park pins are discoverable even from a pocket world. Selecting a distant pin wakes destination admission before traveling.

This is a completed implementation pass, not a certification of 60 FPS throughout the world. First-use shader compilation still causes visible holds in some destinations. Cloud cost varies by view. Hardware coverage is the local M5/Chrome combination; Safari and Windows integrated GPUs need their own runs. The measurements and remaining performance limits below are part of the handoff.

## Review findings and scope

The review followed boot/composition, rendering and post-processing, streaming and collision ownership, physics scheduling, native trees, grass/flowers, local and remote vehicles, audio, and existing musical installations. The starting tree contained roughly 760 TypeScript modules and 233,000 lines.

| Area | Finding and implementation |
| --- | --- |
| Boot graph | Optional vehicle barrels and remote prototypes entered the fundamental graph. Configuration is now lightweight, and each vehicle runtime loads through `src/vehicles/runtime.ts` on first use. Surf-shack metadata no longer imports or constructs the shack. |
| World residency | The draw-distance slider also encouraged eventual whole-city detail residency. `src/world/tiles.ts` now separates nearby playable detail from `citySkyline.ts`, with a profile-sized detail ring and eviction hysteresis. |
| Shader preparation | The warmup batch hid representatives but left duplicate meshes visible. `warmStaticRegion.ts` now excludes duplicates and empty pooled geometry from each batch, rechecks live representatives after yielding, and restores original visibility. First-use vehicles compile in the actual beauty-pass context. |
| Vegetation | Culling was sized to maximum population, and ecology paging uploaded the entire field. Shared indirect dispatch now follows live counts; ecology publishes only completed entering strips through actual WebGPU region writes. |
| Quality control | Pacing alone could mistake CPU streaming for GPU pressure. The frame driver now supplies CPU and asynchronous GPU measurements to the existing governor, while one owner controls resolution. |
| Optional effects | Fireworks allocated/warmed a large pool during walking boot. A lazy owner now prepares the pool on demand and disposes idle resources. |
| Shared assets | Separate KTX2 loaders could create overlapping worker/upload pressure. Standalone textures and embedded GLTF textures now share renderer-scoped ownership and a global two-job admission budget. |
| Street life | A bounded local population is now routed through legal road endpoints, with cheaper distant walker poses and a smaller Quiet population. |
| Shared musical play | Tidal Choir adds a six-pad walking instrument and kinetic sculpture in Marin, using replicated positions, the relay clock and the shared music bus. |

The installed Three r185 source is the implementation authority. Rendering remains WebGPU-only. The two private backend boundaries—float texture region uploads and timestamp descriptor cleanup—are isolated in `src/render/floatTextureUpload.ts` and `gpuFrameTiming.ts`; rerun their real-device probes on a Three upgrade.

## Implemented changes

### Discoverability and destination loading

Activity and park pins register from metadata at boot, including pocket worlds. Pin registration performs no exhibit construction, surf-shack build or media hydration. Traveling beyond a pocket lifts its residency/site restriction immediately; background city construction continues independently. Tests start in Tidal Choir, find Japanese Tea Garden and Beach Pianist, travel using the real minimap callback, and wait for each destination to become ready.

The authored-asset gate is repaired. Fort Mason, Grace Cathedral, St Mary's and Sutro Baths were rebaked from the repository's source files with `SF_SKIP_BLENDER_COMPOSE=1`; their source/output ledgers match again. The external Blender world was not composed or edited. The far-city asset also has a reproducible baker and ledger. Normal `npm run build` passes the asset gate, required contracts, TypeScript, bundling and precompression.

### First-use local and remote vehicles

Walking boot builds the walking controller and shared avatar rigs. Other modes start with empty roots. The chosen runtime constructs its controller and visual, prepares its material pipelines, and then commits the mode transition. Concurrent preparations share a promise; newer mode/teleport requests supersede earlier ones. Configuration changed during preparation or between a failed attempt and its retry is reapplied and compiled before reveal. A later Surf selection also cancels an earlier cold Drive request while the surf activity prepares.

The same boundaries cover saved sessions, invitations, navigation, first-person cameras, golf carts, gliding/rocket activities, surf entry and cinematic setup. A remote vehicle hydrates only after local activation of that mode and within 180 m. Beyond 260 m its owned shell/cosmetics retire; returning peers can hydrate again. Distant peers retain inexpensive procedural visuals and their network state. Local runtime modules remain cached for the session; this is not a claim that every previously used local controller is unloaded.

Car and other customizers load only selected media, not catalogs. The production car waterfall checks three distinct phases: no car media or editor at walking boot; selected finish/decal on driving and editor code on opening the editor; exactly one additional finish when selected.

The Vite manifest contract verifies nine vehicle runtime chunks plus fireworks, clouds, far-city geometry code, Tidal Choir and its vegetation outside the walking entry's static import graph. Main JavaScript is about 1.39 MB minified / 463 kB gzip versus about 1.55 MB / 517 kB after the first wave. These are individual chunk sizes, **not total startup transfer or a whole-app speedup**.

### Bounded city detail with preserved roof shapes

The far-city bake uses the actual 184 authored building tile geometries, retaining positions and colors while removing nearby-only data. Attribute-aware simplification reduces 2,105,885 triangles to 1,056,375; preservation constraints deliberately prevent forcing every roof to the requested 22% ratio. The meshopt asset is 8,339,432 bytes.

The skyline uses one batch owner and shared pipeline binding, with no shadows. Three r185 still emits visible-tile sub-draws; this is not a claim of one physical GPU draw. A far tile hides only when its detailed tile is attached and visible. Detailed tile admission uses these radii after the skyline is prepared:

| Profile | Detail radius | Frame cap | Distant groundcover coverage | Streaming budget factor |
| --- | ---: | ---: | ---: | ---: |
| Balanced | 3.6 km | 60 Hz | 85% | 1.0 |
| Quiet | 2.4 km | 30 Hz | 65% | 0.7 |
| High | 6 km | Uncapped | 100% | 1.0 |

An extra 800 m and five-second grace prevent boundary churn; disposal drains one tile at a time. Collision retains independent leases. If skyline loading/preparation fails, full detailed residency remains available while preparation retries. Pocket boot does not fetch the skyline; its existing smaller cap remains effective until wake. Landmark models, global height information and terrain have separate ownership.

The initial detailed-building arena is smaller (about 1.05 million vertices / 2.10 million indices), retaining existing growth caps and size-class reuse. An arena can retain its high-water allocation; fewer loaded tiles do not imply immediate process-memory shrinkage. Repeated-route and renderer-memory observations are reported separately from total system memory.

### Shared vegetation and uploads

- Groundcover cull dispatch uses bounded live population counts published by compute. Empty fields dispatch zero workgroups. Overflow clamps to capacity. Eleven flower layers use two legal publication batches, each within the eight-storage-buffer guarantee. No per-frame CPU readback is added.
- Empty or unchanged far-tree fields reuse their cull results. Admission, retirement, focus/camera changes and near-pool handoffs invalidate them. Final retirement clears and parks the draw.
- Ecology paging uses compact strip descriptors and staging arrays. Cancellation discards unpublished work without changing the resident field. Commit copies completed strips into toroidal storage and uploads the corresponding rectangles with `GPUQueue.writeTexture`. A first upload remains a truthful full upload.
- Stable cluster ranks reduce overlap beyond 60 m, grading out to 200 m. The close 60 m retains its full population. Profile changes update a uniform rather than scattering or compiling a second vegetation system.
- Trees, shrubs, grass and flowers retain the shared native vegetation/groundcover runtimes, wind, trample, chunk ownership and shadow prohibition. Tidal Choir's cypress and flowers register through `SiteFoliageStreamer` independently of gameplay residency.

Measured fixtures: sparse culling uses 19 groups instead of 483 (96.1% fewer groups in that controlled compute fixture, **not 96.1% faster gameplay**). A 32×32 RGBA float ecology field uploads 16,384 bytes initially, 512 for a one-column movement, 2,000 for the tested diagonal move, 4,720 for reversal, and 16,384 for teleport. GPU readback matches a full rebuild for movement, cancellation and paint cases.

### Frame scheduling, compilation and decoding

The scheduler uses an amortized constant-time queue and promptly releases consumed job closures. The quality governor requires uninterrupted hot/cool dwell. Pauses, neutral observations, warmup and profile changes reset the dwell. CPU-heavy streaming does not automatically spend resolution quality unless GPU measurements also justify it. Quiet's wall-clock cap works independently of panel refresh; it does not double-apply an interior cap. Its 0.9 resolution factor applies once, on the existing active resolution axis. Disabling adaptation for capture neutralizes this factor even at level zero; resizing and changing profiles keep that same resolution owner.

GPU timestamps sample one live frame every two seconds when supported, resolving asynchronously without blocking the frame loop. Only a frame that issued real render queries can publish a fresh measurement; compile-held and compute-only samples invalidate the old pressure value instead of renewing Three's cached timestamp result. The integration passes both CPU and GPU measurements through the startup wrapper; a production trace caught and fixed an earlier dropped-argument connection. `pipeline.frameTelemetry` counts completed presentation submissions and compile-skipped calls separately, so rAF ticks cannot be mistaken for rendered frames.

The representative warmup fixture compiles one mesh from 200 identical meshes, restoring visibility afterward. Additional fixtures exclude empty traffic-light pool slots while still preparing valid hidden descendants, and revalidate a representative whose geometry changes while the sweep yields. This reduces duplicate preparation work; it does not eliminate legitimate TSL material variants or every first-use hold.

One shared KTX2 service covers embedded GLTF and standalone foliage textures. Registration itself loads no decoder code. Worker count and concurrent decode/network admission are both bounded at two. Replacing a renderer retires the old service after in-flight work drains, rejects queued old requests, disposes late textures, and does not fall through to resurrecting WebP textures for the old owner. Existing foliage template/material/texture leases remain intact.

Fireworks prepare on first local use. Network fireworks cannot activate the feature and are distance-filtered after local activation. After 60 idle seconds, the owner disposes particles, materials, audio voices and persistent bus nodes; later use can prepare again.

### Art, clouds and ambient life

**Tidal Choir · Marin** is a six-pad collaborative chime circle around a kinetic spiral. Different occupied pads build a chord; multiple people on one pad share one voice rather than multiplying gain. The existing synchronized relay clock aligns pulses. Two lightweight visitors move around the clearing. No external audio assets are required. Find it on the map or use `?zone=tidal-choir`.

**Volumetric clouds** are first-use and opt-in under `/` → lighting, or `?clouds=1`. The ray march now runs into two small HDR targets with dedicated reprojected history; the ordinary depth-tested sky composite supplies foreground occlusion. Balanced uses quarter output resolution, Quiet one fifth, and High one third. Coverage/base/time changes, large camera movement, resize and long frame gaps invalidate history. The Balanced targets at 1512×982 use 1,487,808 bytes together. The same WGSL volume implementation is used throughout; there is no duplicate renderer backend.

Day/dusk/night tests cover below, inside and above the layer. In `.data/world-upgrade/cloud-settled/results.json`, the isolated cloud-stage medians range from 0.32 to 1.29 ms. Whole-frame paired medians range from −0.25 to +10.01 ms; the broad sample variance means this is not a certified incremental GPU budget or a speedup claim. Keep clouds opt-in. This is a sky volume: it does not cast landscape cloud shadows or implement weather scattering for every object inside the layer.

**Ambient street life** uses up to 18 cars in three instanced model draws and 12 avatar walkers, or nine/six in Quiet. Walking/driving at least 12 m near a road activates the feature. Simulation runs at 10 Hz, with local 220 m recycling, lane spacing, signals and near-player yielding. Cars choose legal endpoint connections and respect one-way directions. Distant walkers pose at 5 Hz or 2 Hz. These ambient cars are not enterable vehicles or a replacement for player physics.

## Validation and measurements

The recorded normal production build (`.data/wave2-build.log`) passed the asset gate, required contracts, TypeScript, Vite and precompression. Subsequent correctness fixes were checked with fresh TypeScript and Vite builds (`.data/final-bundle.log`), the production chunk contract, focused CPU tests and browser regressions; unchanged asset precompression was not repeated. Focused CPU tests cover scheduler semantics, quality dwell, far-tree invalidation, transactional ecology, representative compilation, road junction legality, profile caps and decoder retirement. Real WebGPU fixtures compare indirect draw results and actual uploaded texture contents. The production graph and real request waterfall are both checked; code splitting alone is insufficient evidence of lazy loading.

Production browser checks cover landmark discovery/travel, first-use modes, cameras, selected car media and editor behavior. Multiplayer/lifecycle checks cover near/far vehicle hydration, passenger seat resolution, firework disposal/reopen and Tidal Choir participation. Uncaught page errors and explicit GPU validation errors fail their checks. Console warnings are retained separately; the route probe additionally fails on the missing position/color/traffic attributes that exposed empty pooled geometry in shader warmup. Missing-normal and background-warmup warnings are reported below rather than silently treated as a clean console.

Performance artifacts are under `.data/world-upgrade/`. Live route probes measure submitted-frame intervals, compile holds, scheduler queues, drawing-buffer size, governor scale/pressure, GPU timing, tile residency and Three's attributed memory counters. Manual timestamp probes are a separate serialized phase and are never reported as FPS. A shared process lock prevents overlapping performance probes. Tests use headless Chrome and fresh contexts; other user applications on this shared laptop are not controlled.

Device: Apple M5, 24 GiB unified memory, macOS 26.5.1 (25F80), headless Chrome 152, Apple `metal-3` WebGPU adapter. Final measurements are below. Initial goals remain 60 Hz / warm p95 ≤20 ms for Balanced and 30 Hz / p95 ≤36 ms for Quiet. These goals are acceptance targets, not established guarantees.

### Final Balanced route

The final production bundle is `main-tXiqEXIq.js`. In `.data/world-upgrade/balanced-verified/results.json`, five stops were measured for 12 seconds each after an 18-second settling interval. Profile adaptation stayed enabled; these are end-to-end profile observations, not fixed-quality before/after comparisons. The output buffer was 1512×982, with governor levels 0, 0, 1, 1 and 2 across the five stops.

| Stop | Submitted FPS | p95 interval | Compile-skipped calls | Attributed memory |
| --- | ---: | ---: | ---: | ---: |
| Japanese Tea Garden | 57.6 | 19.2 ms | 20 | 461 MiB |
| Tidal Choir · Marin | 52.1 | 17.5 ms | 94 | 480 MiB |
| Beach Pianist | 53.9 | 30.1 ms | 0 | 567 MiB |
| Japanese Tea Garden (return) | 54.3 | 28.8 ms | 0 | 626 MiB |
| Tidal Choir · Marin (return) | 56.6 | 21.2 ms | 0 | 556 MiB |

The route completed with zero page/console errors, zero missing traffic/position/color attributes, and no supplemental-destination timeout. Twelve missing-normal warnings remain. Detailed tile counts were 77, 38, 48, 70 and 38; memory includes cached resources and high-water arenas and did not return to its cold value. The 60 FPS / 20 ms p95 target was not met consistently. An earlier run with the empty traffic geometry warning stream is superseded by this final check; its measurements are not used as a controlled speedup baseline.

### Final Quiet route and endurance

The same production bundle, output size and five-stop protocol were used in a fresh context. Quiet remained at governor level zero with a temporal-scale ceiling of 0.693. Route measurements are in `.data/world-upgrade/quiet-verified/results.json`.

| Stop | Submitted FPS | p95 interval | Compile-skipped calls | Attributed memory |
| --- | ---: | ---: | ---: | ---: |
| Japanese Tea Garden | 28.1 | 36.9 ms | 16 | 472 MiB |
| Tidal Choir · Marin | 25.8 | 44.4 ms | 28 | 504 MiB |
| Beach Pianist | 24.8 | 54.6 ms | 0 | 573 MiB |
| Japanese Tea Garden (return) | 29.1 | 45.8 ms | 0 | 592 MiB |
| Tidal Choir · Marin (return) | 30.1 | 35.7 ms | 0 | 547 MiB |

The route has twelve missing-normal warnings and two supplemental-destination visual warmups exceeding their eight-second deadline. There are no missing position/color/traffic attributes. First visits miss the 30 FPS / 36 ms p95 target; the return to the choir meets it in the sampled interval. These arrival warnings must not be mistaken for a warning-free loading experience.

The **completed 20-minute stationary endurance run** at Tidal Choir contains all 20 one-minute measurement windows (20.00 minutes measured). It averaged **29.82 submitted FPS**; individual minutes ranged from 29.43 to 30.01 FPS, with per-minute p95 intervals from 34.2 to 35.6 ms. Every minute had zero compile-skipped calls, governor level zero and 21 detailed tiles. Three's attributed memory stayed between 539.13 and 539.15 MiB. The final browser report passed with zero page/console errors and no missing traffic/position/color attributes. Earlier interrupted Quiet attempts are not endurance evidence and are superseded by this completed run.

After resize to 1280×800 and pause/resume, Quiet measured 29.9 FPS / 34.6 ms p95 with no compile holds, retaining its 2.4 km cap and single scale owner. Balanced's separate resize/resume sample measured 59.9 FPS / 18.2 ms p95 and retained its 3.6 km cap.

This was a fixed landscape view with clouds off on AC power, starting at 94% battery while charging. Power snapshots are in `.data/quiet-verified-power-before.log` and `quiet-verified-power-after.log`; they report no recorded thermal/performance warning. They do not measure chip temperature or prove the absence of throttling. This run supports settled Quiet behavior in this scene; it does not certify all-city 30 FPS, battery endurance, total process-memory stability or other hardware.

Known unrelated failure: the rough-sea boat-buoyancy physics probe fails 22 checks. Running the unchanged first-wave commit produces byte-identical output. Surf, gliding and car-jump physics probes pass. The city grounding contract also reports its existing per-building discrepancy in `tile_10_8`; this work does not change those buildings.

## Remaining performance work and limits

1. Use route traces to identify the actual first-use material variants behind long compile holds. The representative fix removes duplicates, but legitimate variants still require preparation. Do not remove compile serialization or reveal unprepared destination materials to hide the counter.
2. Set tighter per-scene GPU budgets from controlled measurements. Cloud full-frame overhead and dense landscape views need further profiling before changing the default cloud setting or promising Balanced 60 Hz everywhere.
3. Validate skyline/detail handoffs and memory behavior on extended driving/flying routes and on additional adapters. The local repeated teleport route is useful regression coverage, not a substitute for Safari/Windows or process-level memory testing.
4. The remaining CPU audit identifies three follow-ups: worker-expand the boot height overview, reduce main-thread GLTF object construction, and share the landmark-collider payload. Terrain binary decoding, collider JSON parsing, road graph preparation and CityGen ingestion/generation already run in workers; repeating those migrations would not address the remaining costs.
5. Investigate the independently reproduced rough-sea boat failures as a physics task.

The CPU follow-ups have specific ownership boundaries:

| Priority | Remaining main-thread work | Current gate and next boundary |
| --- | --- | --- |
| 1 | `WorldMap.loadCore()` in `src/world/heightmap.ts` expands the small overview into 3,277,568 height/surface cells, then copies heights to ground tops: about 29.5 MB of final arrays. | Essential boot, before world progression. A worker can generate transferable arrays; the download itself is already small. Measure this phase before choosing worker expansion versus lazy pages. |
| 2 | `TileStreamer.#load` and `AuthoredRegions` still call `GLTFLoader.parseAsync` on the main thread. Meshopt decompression already uses workers, but Three geometry/material/object construction does not. | Landmark boot, destination arrival or admitted background work. A packed runtime format or worker-side container preparation must leave a bounded Three object/material commit on the main thread. |
| 3 | `/data/landmark-colliders.json` (65,910 bytes) is parsed for tile shadow proxies and again for deferred physics. | Boot visual proxy plus deferred collider services. Share a parsed/packed payload; retain collision-readiness ordering. Ordinary tile collider hydration is already sliced, so focus on the remaining body/proxy construction burst. |

## Reproduction

Start this worktree with `npm run play`, using its explicit code marker to avoid accidentally reusing another checkout's server. See the runnable command in the feature handoff. Production preview must proxy the same relay (`SF_RELAY_PORT=8270` when using dev port 5270).

Useful checks:

```bash
npm run build
node tools/lazy-runtime-build-contract.mjs
node tools/world-upgrade-contract-test.mjs
node tools/optimization-wave2-contract-test.mjs
node tools/texture-decoder-contract-test.mjs
node tools/gpu-timing-contract-test.mjs
node tools/render-budget-contract-test.mjs
SF_PROBE_URL=http://localhost:5270 node tools/world-upgrade-gpu-probe.mjs
SF_PROBE_URL=http://localhost:5270 SF_GPU_PROBE=foliage-upload-probe node tools/world-upgrade-gpu-probe.mjs
SF_PROBE_URL=http://localhost:5270 node tools/world-upgrade-features-probe.mjs
SF_PROBE_URL=http://localhost:5271 node tools/landmark-restoration-probe.mjs
SF_PROBE_URL=http://localhost:5271 node tools/lazy-vehicles-probe.mjs
SF_PROBE_URL=http://localhost:5271 node tools/wave2-lifecycle-probe.mjs
SF_PROBE_URL=http://localhost:5271 node tools/car-customizer-probe.mjs
SF_PROBE_URL=http://localhost:5271 node tools/vehicle-transition-probe.mjs
SF_URL=http://localhost:5271 node tools/vehicle-first-person-camera-probe.mjs
SF_PROBE_URL=http://localhost:5271 SF_PROFILES=quiet SF_SOAK_MINUTES=20 node tools/world-upgrade-route-probe.mjs
SF_PROBE_URL=http://localhost:5271 node tools/cloud-budget-probe.mjs
```

Run browsers sequentially. Complete builds before performance measurements. Do not reuse earlier invalid baseline/cloud experiments or infer whole-game gains from compute dispatch reductions, triangle counts, request counts or individual chunk sizes.
