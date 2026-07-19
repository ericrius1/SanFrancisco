# M4 ring coordinator — implementation audit

## Files changed

Created or modified by THIS task:

- `src/app/ringCoordinator.ts` — NEW: the ring coordinator (front driver, focus API, stall nudge)
- `src/world/tiles.ts` — added `residentRadiusAround(x, z)` + its cached memo field + recompute-cadence constant (nothing else touched)
- `src/main.ts` — P5 interim front driver replaced with the coordinator; `ringUpdate` single-call-site helper wired into voidTick + updateWorld; `__sfVoid` ringState/residentRadius getters; `__sf.rings` debug surface; `RingCoordinator` import

Pre-existing uncommitted M1–M3 work in the tree (NOT touched here): `src/render/materialize.ts`, `src/world/voidRealm.ts`, `src/world/sky.ts`, `src/world/terrainClipmap.ts`, `src/world/water.ts`, boot-phase code in main.ts other than the lines above, `src/core/*`, `src/app/boot/*`, docs, feature-research/m1–m3.

## What changed per file

### src/world/tiles.ts

- `residentRadiusAround(x, z): number` (after `backgroundStreamingDebug`, ~line 940): largest R such that every WANTED tile whose bounds intersect the disc R around (x,z) has drained `pendingParts`/`pendingRoadParts`/`pendingBuildingParts`. Key details:
  - "Wanted" mirrors `#scan`'s own criterion — tile CENTER inside `#currentLoadRadius()` — not bounds-intersection. (First cut used bounds and permanently pinned residency at ~2950 m: 17 rim tiles whose bounds graze the 3500 m disc but whose centers sit outside are never loaded by the streamer, correctly.)
  - Capped at `#currentLoadRadius()` (beyond it nothing is requested).
  - Terminally failed tiles (`#visualFailures.terminal`) are non-blocking (they will never attach; the area is terrain fallback — the front must not stall on them).
  - `detailParts` (high-altitude pier-deck deferral) deliberately does not block.
  - Cost: one pass over the 205 manifest entries (center d², plus bounds sqrt only for non-resident entries), recomputed at most every `RESIDENT_RADIUS_RECOMPUTE_TICKS = 15` streamer ticks and memoized in a reused object (`#residentRadiusCache`; no per-query allocation). `tracer.count("tileResidencyScan")` marks each recompute.
- New private field `#residentRadiusCache` and constant `RESIDENT_RADIUS_RECOMPUTE_TICKS`.

### src/app/ringCoordinator.ts (new)

`RingCoordinator` — thin orchestration over existing streamers, read-only queries + existing prime/expansion entry points only:

- **Residency chase.** Every `RESIDENCY_REFRESH_FRAMES = 20` updates it reads `tiles.residentRadiusAround(focus)` (which is itself tick-cached). Target radius each frame = `max(resident − 60, playerDist + 150, currentRadius)` — monotonic, never shrinks except on `focus({reset:true})`. The player-dist term carries an explicit comment: safe today because only terrain/sky/water consume the front (always resident); M5 may tighten it.
- **Growth animation.** Eased velocity: cap ramps 16 → 120 m/s over the first 10 s (smoothstep — slow bloom near the player, edge visible), then 520 m/s catch-up; velocity approaches the cap exponentially (`VELOCITY_EASE = 1.6/s`) and the step is clamped to the remaining gap. Writes `materializeField.frontRadius.value` directly (≤2 uniform writes/frame, zero allocations in `update`).
- **Settle.** When residency reaches `min(fullRadius, 3600)` (fullRadius = the player's real draw radius, passed from boot before the initial-visual clamp), a one-shot settle target of `resident + 240` pushes the band past the fog veil, then `materializeField.reveal()` collapses to the revealed sentinel, state → `settled`, `onSettled` fires (main wires `bootMark("frontComplete")`), and `update()` early-returns forever — steady-state cost is the collapsed-front path.
- **Stall nudge.** If residency has not grown for 20 s (and not yet settling), once per 20 s: `tiles.resumeBackgroundStreaming()` (no-op unless a settled visual prime still holds the ring) and, if the current load radius is still below the settle radius, `onExpansionStalled` (main.ts restores `CONFIG.tileLoadRadius` to full — same restore the worldReady quiet-window block performs, skipped for surf — and calls `tiles.beginBackgroundExpansion()`). This replaces the P5 interim block's wall-clock caps, centralized: continuous player movement can no longer pin the front at the boot bubble (the quiet-window admission gate has no deadline by itself).
- **Focus API (for M7, implemented now, NOT wired to worldArrival).** `focus(x, z, {reset})`: bumps `#generation`, recenters `materializeField.setFront`, resets radius/velocity/age when `reset` (default), clears residency/settle/nudge state, and re-primes via the injected `prime` callback — main wires `primeInitialVisualAt`, the exact path boot/supersede use (tiles.primeAt + authoredRegions.prepareAt with its own epoch guard), so no prime logic is duplicated and stale async completions are ignored by the existing generation/epoch guards.
- Constructor adopts the boot spawn without re-priming (boot already primed); `?voidholo=1` → state `holding` (front stays collapsed for manual `__sf.materialize` control, as before).
- Citygen: the interior ring materializes near-player cells (~150 m visual-chunk LOD) on its own lifecycle and exposes no materialized-cell radius; folding it into the residency min was NOT trivial. TODO documented for M5 in the module header ("Staged background expansion stays owned by tiles.ts…" note) — M5 should have citygen (and other front consumers) register births via `materializeField.markBorn` when content lands after the front has passed.

### src/main.ts

- `let ringUpdate` no-op declared above `voidTick`; bound to `ringCoordinator.update` when the coordinator is created (same synchronous block as `startFrameDriver`, so no tick can run before it is bound).
- `voidTick`: `ringUpdate(frameDt)` inserted immediately before `materializeField.update(frameDt)`.
- `updateWorld` (real loop): same insertion before `materializeField.update(frameDt)` — the required single-helper dual call site.
- P5 block replaced (search "P5 ring coordinator"): coordinator construction with `tiles`, `player`, `prime: primeInitialVisualAt`, `fullRadius: fullTileRadius`, `holdHolo: bootQuery.has("voidholo")`, `onSettled: bootMark("frontComplete")`, `onExpansionStalled` (CONFIG restore + `beginBackgroundExpansion`, surf-guarded).
- `__sfVoid` gains `ringState()` / `residentRadius()` (DEV/`?profile` only, same guard as the existing hook).
- `__sf.rings = { state(), residentRadius(), frontRadius(), focus(x, z, opts) }` in `exposeDebugHooks`.
- `bootArrivalTick` untouched: its stray re-anchor moves only the collision bubble; the coordinator never resets the front on stray — the wandering player is covered by the player-dist clamp term (comment in `update()`).

## Deviations from the plan

- **Wanted = tile center, not bounds** in `residentRadiusAround` (see above) — required to match `#scan`; the doc comment spells out why.
- **Citygen materialized-cell radius NOT included** in the residency min (not trivial; interior cells are near-player-only and front-irrelevant today). TODO left for M5.
- **`onExpansionStalled` also restores `CONFIG.tileLoadRadius`** (not just "nudge the next stage"): the worldReady restore block waits on a no-deadline quiet window, so a continuously moving player would otherwise cap residency at the 1000 m boot bubble forever — the walk-away acceptance test fails without it. It performs the identical restore that block performs (idempotent; surf excluded).
- **Settle uses `fullTileRadius` passed from boot** rather than live `CONFIG.tileLoadRadius` (which is clamped to 1000 during early boot and would settle prematurely).
- `frameBudget` lanes were not needed: the only bursty work (the 205-entry residency pass at ≤1/15 ticks) is far below slice size; it is tracer-counted instead.
- The coordinator writes `frontRadius` directly instead of `materializeField.sweep()` — the sweep API remains for `__sf.materialize` debug control (usable after settle, or under `?voidholo=1`).

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite build + precompress) passes.
- Headless probe (fresh-port `vite preview`, headless Chrome + CDP WebGPU/metal, `?autostart=1&fullfps=1&profile=1`, warm shader-cache profile) — `scratchpad/m4-probe.mjs`:
  - **Run 1 (idle, spawn missionDolores), 1 Hz timeline:** front 3 → 13 → 32 → 50 → 83 → 119 (bloom, ~6 s) → 182…576 (chasing staged residency 1000/1200/2200) → 770 → 1255 → 1808 → 2331 → 2855 → 3378 → FULL at ~23 s; resident 0 → 1000 → 1200 → 2200 → 3500. Monotonic ✓, clamp violations 0 ✓ (resident transiently dips when a new expansion stage widens "wanted" — e.g. 2200 → 1839 — and the front simply holds), settled ✓ (`frontComplete` bootMark at 22.8 s). An earlier landsEnd-spawn run settled at ~21 s (frontComplete 19.5 s).
  - **Control timing not regressed:** control 1388 ms / 1047 ms / 1098 ms across runs vs M3's 1109 ms (same warm-cache setup); phase deltas essentially identical.
  - **Run 2 (walk-away):** W held from control for ~55 s. Front grew through the walk (16 → 940, clamped at resident 1000 − 60 = 940 while expansion was admission-gated, then the 20 s stall nudge kicked expansion: resident 1000 → 1528 → 2254 → 2920, front → 2860 still growing; a prior run reached FULL/settled at 35 s while walking). No stall ✓, no errors ✓.
  - **Zero console errors / page exceptions** in every run.
  - **Screenshots** (Corona Heights vista spawn, same probe minus run 2): `m4-a-early-bloom.png` (revealed bubble around the player, holo grid city to the horizon), `m4-b-mid-chase.png` (city materialized to ~2 km, holo remnant at the rim), `m4-c-settled.png` (full world, no holo) in `/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco--claude-worktrees-streaming-world-concentric-chunks-b8eefb/016a9db0-273c-468a-8995-6e1b9fac50be/scratchpad/`.
  - Probe gotcha found + worked around: `Emulation.setDeviceMetricsOverride` before `Page.captureScreenshot` on this WebGPU page yields stale composited canvas frames (DOM HUD updates, canvas frozen — verified in-page: renderer frame counter advanced 361 frames/3 s while shots stayed stale). Dropping the override (window-size flag only) fixes it. Worth a memory note for M8 QA.
- All probe preview servers and Chrome instances killed; remaining vite processes on the machine belong to the main repo / other worktrees (verified by cwd). Nothing committed.

## Open risks

- **Settle vs. permanently missing rim tiles:** terminal visual failures are non-blocking by design; if a *non*-terminal failure loops retries forever, residency stalls short of settle and the front holds at the last resident ring (nudges fire but can't fix a bad GLB). Acceptable: M3 behavior for that area is terrain fallback either way.
- **Resident radius can transiently shrink** when a new expansion stage (or the stall-path `beginBackgroundExpansion` stage reset) widens "wanted". The front is monotonic and simply pauses; a probe sampling right then could see front > resident − 60 briefly. The settle overshoot phase (front → resident + 240) also intentionally exceeds the resident clamp.
- **Player-dist clamp** lets a fast mover (plane/boost) push the front over not-yet-resident ground — safe while only terrain/sky/water consume the front; flagged in code for M5 tightening.
- `__sf.rings.focus()` is implemented but unwired; calling it from the console mid-session re-primes tiles/regions/collision via the boot path — intended for M7, harmless but visually dramatic.

## What M5 needs from this

- **Birth registration:** when streamed content (tiles, citygen cells, landmarks, sites) attaches *after* the front has passed its position, it must call `materializeField.markBorn(key)` at attach (and `forgetBirth` at unload) so it plays the birth ramp instead of popping; content attaching *ahead* of the front needs no birth (the front sweep covers it). The coordinator guarantees the front never crosses non-resident tile ground (modulo the player-dist bubble), so tile-batch content revealed by the sweep is always already attached.
- If citygen (or another streamer) should gate the front, expose a cheap materialized-radius query and min it into `#refreshResidency` — the coordinator already takes the min-shaped value from a single call.
- When M5 puts streamed content on the front, revisit `PLAYER_CLEAR` (shrink or make residency-aware) and consider front-priority compile ordering (M6).
