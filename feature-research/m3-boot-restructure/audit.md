# M3 boot restructure (void boot P0–P5) — implementation audit

## Files changed

Created or modified by THIS task:

- `src/main.ts` — boot restructured into P0–P5 (the bulk of the change)
- `src/core/physics.ts` — `Physics.create` split into `createCore` + `initColliderServices`
- `src/core/box3dWorld.ts` — added `prefetchBox3D()` (P0 WASM kickoff)
- `src/core/bootMarks.ts` — added `bootMarkList()` accessor (feeds `__sfVoid` probe hook)
- `src/app/boot/bootPhysics.ts` — uses `createCore`; collider services complete in background
- `src/world/voidRealm.ts` — water is now late-bound (`attachWater`), sky-only until P3

Pre-existing UNCOMMITTED M1/M2 work also in the working tree (NOT touched by this
task, listed so the reviewer doesn't attribute them here): `src/render/materialize.ts`,
`src/world/sky.ts`, `src/world/terrainClipmap.ts`, `src/world/water.ts`,
`docs/VOID_STREAM_REWRITE.md`, `feature-research/m1-m2-materialize/`.

## What changed per file

### src/main.ts (phase map, current line numbers)

- **P0 kickoff** (~215–231): `bootMap()` + `bootGpu(app)` start as parallel promises;
  `prefetchBox3D()` starts the ~1 MB WASM import immediately. The tiles manifest
  already races via the inline `<head>` `__sfPrefetch` (index.html), so no extra
  fetch was added.
- **P1 void essentials** (~233–532): FarOcclusionField + Sky (sun/hemi/clipmap
  shadow — light set complete before first frame), `VoidRealm(sky)` (water
  late-bound), `bootTiles` (constructs the terrain clipmap = void floor and
  resolves the manifest), initial-arrival machinery unchanged, `bootPhysics`
  (now physics-min, see below). Then, moved up from the old sync stretch:
  `Input`, `ModeDiscovery`, avatar/vehicle config loads, `Player` (all
  embodiments + LightPool), boot hold (`holdForWorldArrival` +
  prepare/activateCollisionArrival), `ChaseCamera` + camera seed,
  `createFrameScheduler()`, `createRenderPipeline`, `renderFrame` (+ hoisted
  void-safe `let`s: `foliageOn`, `siteFoliage`, `beachPianist`,
  `pianoGodRaysActive`, `bootHud`), `WorldArrivalCoordinator` +
  `createBackgroundAdmission` + `onStateChange`, resume/invite POSITION
  application (surf sessions restore on foot; upgraded in P3), the re-prime
  supersede check, `input.setMode`, non-surf `startMode` switch,
  `materializeField.holo(player)` + `voidRealm.update()` (world boots as holo
  void), timer/elapsed/accumulator/`aim`/`rayOrigin`, then
  `bootMark("world")` → sky.update → player.warmup → covered `renderFrame()` →
  `await pipeline.warmup("boot")` → `bootMark("warmup")`.
- **P2 void live** (~534–814): reveal machinery (`revealedPromise`,
  `constructionDone`, `worldReady = revealed ∧ constructionDone`,
  `runAfterConstruction` queue), `bootQuery`/`autoEnter`/`skipGate`/
  `autoStartSaved`, new `revealWorld` (semantics: void ready — no settle wait),
  split start handler (immediate: blur/`started`/`done`/lock; deferred:
  `net.setName`, avatar sync, mic nudge, welcome toast), `bootArrivalTick`
  (control release at `groundReady` + `bootMark("control")`, visual-deadline
  fallback, collision retries, stray re-anchor >60 m, completion →
  `resumeBackgroundStreaming`), the provisional `voidTick` (input → fixed-step
  physics → player/camera → tiles/authoredRegions update → materialize/void →
  sky → scheduler.run → bootArrivalTick → render; marks `voidFrame`; reveals
  after 2 frames + groundReady, 15 s cap), `activeTick` indirection +
  `startFrameDriver` (driver created ONCE here; P4 swaps the tick, not the
  driver), `__sfManual`, `__sfVoid` probe hook (DEV/`?profile`), and the
  **P5 interim front driver** (clearly marked for M4 replacement): stage 1
  sweeps to 1000 m @145 m/s when the initial visual prime resolves; stage 2
  (arrival complete or 20 s cap, + 8 s) sweeps to 3600 m then
  `materializeField.reveal()`. `?voidholo=1` is repurposed to "hold the holo".
- **P3 sliced construction** (~815–4711): the former sync stretch in its
  ORIGINAL ORDER, chopped with `createFrameBudgetCheckpoint(5)` awaits (~16
  slice points). New at its head: `Water` construction + `voidRealm.attachWater`
  + detached warm of the four water sheets (`warmHiddenRoot`, hidden until
  compiled), `UnderwaterOverlay`, roadMarkings kickoff (moved out of P1).
  Deferred surf/mode upgrades live at the old resume/invite spot (after
  debugPanel, so `onModeChange` is safe): `startMode`/resume/invite surf →
  `prepareSurfEntry()` + `trySwitch("surf")`, `invite.animal` →
  `embodiments.currentAnimal`, surf stash radius fix. Every deferred
  region/enhancement block that used `revealedPromise` now gates on
  `worldReady` (reveal fires seconds before their dependencies exist). Old
  settle gate + settleTick deleted; `postSchedule` now just calls
  `bootArrivalTick()`.
- **P4 handoff** (~4712+): `bootMark("constructionDone")` → `activeTick = tick`
  → `bootMark("handoff")` → drain queued start-handler actions →
  `persistBootHistory()` → background re-run of `pipeline.warmup("boot")`
  behind `waitForWorldBackgroundWindow(1500)` (compiles P3's material-heavy
  systems off the critical path, contract C2).

### src/core/physics.ts
`create` → `createCore` (WASM + stepped/query worlds + carpet pools + tile
hooks); landmark query mirrors + `BuildingColliderIndex.init` +
`tiles.setColliderSource` moved to new instance method `initColliderServices()`.
All consumers were already null-safe against `#colliderIndex`; arrival status
stays honestly "pending" until the index lands.

### src/app/boot/bootPhysics.ts
Awaits `Physics.createCore`; kicks `initColliderServices()` in the background
with a warn-on-failure. Far-occlusion chaining + landmark fetch unchanged.

### src/core/box3dWorld.ts
`prefetchBox3D()` — starts `loadBox3DModule()`; clears the memo on failure so
the real `createBox3D()` retries.

### src/core/bootMarks.ts
`bootMarkList()` read-only accessor.

### src/world/voidRealm.ts
Constructor takes only `sky`; `attachWater(water)` binds late and immediately
syncs the reveal uniform; `update()` null-safe on water.

## Deviations from the plan

- **Driver swap instead of stop/restart**: `startFrameDriver` is created once in
  P2 with `tick: (dt) => activeTick(dt)`; P4 swaps `activeTick`. Same guarantees
  (no double tick, shared timer/accumulator), simpler than making the driver
  stoppable, and the rAF-deadlock backstop keeps working for both ticks.
- **Surf/mode upgrades placed at the OLD resume/invite spot** (after debugPanel),
  not at the old 738 surf-cull block: `player.trySwitch("surf")` fires
  `onModeChange`, which reads `debugPanel` (TDZ crash if earlier). The 738 block
  was deleted; its `fullTileRadius` stash fix moved with the upgrades.
- **`persistBootHistory` moved from reveal to handoff** so the persisted history
  includes constructionDone/handoff marks.
- **P5 stage-2 trigger** approximates "background expansion's next stage" with
  "boot arrival complete (expansion resumed)" + 8 s, capped at 20 s — tiles
  expose no expansion-stage signal; M4's ring coordinator owns this properly.
- **`initialCollisionReady` variable removed** (was only read by the deleted
  settleTick).
- **Added `__sfVoid` probe hook + `bootMarkList()`** (not in the plan text):
  minimal DEV/`?profile` surface needed to verify control/marks/front during
  P2/P3, before the end-of-boot `__sf` registry exists. Reusable for M8 QA.
- **Boot re-anchor**: early control lets the player wander before the pinned
  collision arrival completes; `bootArrivalTick` re-anchors the safety bubble
  under them (>60 m, 2 s throttle) via the same prepare/activate path so
  completion/`resumeBackgroundStreaming` cannot strand. New behavior, required
  by early control.
- The start handler is installed in P2 unconditionally (it used to be installed
  mid-stretch); its net/hud/audio effects queue until construction completes.

## Test results

- `npx tsc --noEmit`: clean. Full `npm run build` (contract tests + tsc + vite
  build + precompress): passes.
- Headless probe (vite preview on a free port, headless Chrome + CDP WebGPU/metal,
  `?autostart=1&fullfps=1&profile=1`):
  - **bootMarks (warm shader cache, absolute ms):** start 110 · map 138 · gpu 138
    · tiles 477 · physics 515 · world 551 · warmup 1052 · **control 1109** ·
    voidFrame 1109 · reveal 1233 · constructionDone 1534 · handoff 1534.
    Cold first-ever run (empty Metal shader cache) is warmup-dominated:
    warmup 7264 → control 7317 → handoff 7745 (the P1 boot warmup stage was
    `scene-1x-wf0-compile 4151ms · output-compile 2149ms` on the cold run vs
    `220ms total` warm). Construction itself is ~300 ms sliced.
  - **Early control:** scripted `KeyW` keydown after the `control` mark moved the
    avatar 4–6 m; `constructionDone` was still false at control.
  - **World arrival:** at +42 s the city, tea garden, site foliage and trees are
    fully materialized; interim front swept (radius 0 → 1000 → 3600 →
    full-reveal sentinel).
  - **Tracer:** frames 4276, ema 8.7 ms, worst 569 ms, 15 spikes. Spike phase
    attribution shows `sched ≈ 0 ms` and world/physics ≤ 3 ms in every captured
    spike — the big dts are outside the tick (GPU pipeline-compile windows of
    newly attached tile batches and the deliberate post-construction warmup,
    contract C3), not construction slices. No >20 ms spike attributable to
    sched/construction after control.
  - **Zero console errors / page exceptions** in all runs.
  - Screenshots: `m3-a-void-control.png` (avatar on the holo contour grid right
    after control), `m3-b-mid-sweep.png` (near world materialized, holo horizon
    band), `m3-c-full-world.png` (fully arrived) under
    `/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco--claude-worktrees-streaming-world-concentric-chunks-b8eefb/016a9db0-273c-468a-8995-6e1b9fac50be/scratchpad/`.
- Dev-server sanity (plain `vite`, no flags): auto-enters (`body.started`) at
  +1.7 s, revealed, no errors. `?startscreen=1`: `markReady` fires, world does
  NOT auto-start (gate holds), no errors.
- All probe servers/browsers were killed; leftover vite processes on this
  machine belong to other worktrees (verified by cwd).

## Open risks

- **Content pops behind the front at M3**: streamed tiles/landmarks render fully
  shaded as they attach (only terrain/sky/water are materialize-aware until M5).
  Expected per milestone plan.
- **P3 attach compile hitches**: fx/decorative systems constructed during live
  void frames may sync-compile on their first draw (Water is warmed detached;
  WaterEchoes and small decorative layers are not). Probe shows the resulting
  spikes land in the render/GPU column, worst 569 ms during the deliberate
  post-construction warmup window; M6 (compile-queue ordering) is the planned
  closure.
- **Early control without building colliders**: the player can briefly walk
  through building footprints before the collision arrival completes (void has
  no building visuals, per spec). The re-anchor keeps completion converging if
  they run; a sprinting player still extends the window.
- **Cold-cache first visit** is warmup-bound (~7 s to control on this machine).
  The void goal (~1 s) holds only with a warm Metal shader cache; pipeline-cache
  strategies are out of M3 scope.
- **Prod name gate**: the folio is translucent enough that the live void shows
  through (verified visually), but the folio CSS wasn't touched; if design wants
  a clearer live-void backdrop pre-Start, that's a CSS follow-up.
- `getRevealed()` passed to optional sites now reports true much earlier; site
  admission is additionally gated by `worldReady`, but any site logic that
  keys on "revealed" alone sees the new earlier timing.

## Notes for M4 (ring coordinator)

- Replace the clearly-marked **P5 interim block** in main.ts (search
  "P5 interim materialize driver"). Everything it needs already exists in scope:
  `initialVisualState`, `initialArrivalReleased`, `materializeField`,
  `bootQuery` (`voidholo` = hold holo).
- The front should chase `minResidentRadius`; today's stage-1 target (1000 m)
  equals `INITIAL_VISUAL_RADIUS` in `app/compose/initialArrival.ts`.
- `bootArrivalTick` owns the boot arrival lifecycle and the stray re-anchor —
  the coordinator should subsume/coordinate re-focusing rather than fight it.
- `voidTick` only ticks the P1 set; if the coordinator needs per-frame updates
  during the void phase, hook them next to `materializeField.update` in BOTH
  `voidTick` and `updateWorld` (or expose one shared updater like
  `bootArrivalTick`).
- `pipeline.warmup("boot")` is re-invoked post-construction behind
  `waitForWorldBackgroundWindow(1500)`; ring-driven warm ordering (front
  priority) belongs to M6.
