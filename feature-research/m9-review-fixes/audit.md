# M9 review fixes — implementation audit

> **CORRECTION (2026-07-19, bufstorm root-cause):** the "buffer used in submit
> while destroyed" storm below was attributed to `?m9norelease=1` (A/B) with
> shellBatch arena grows as prime suspect. Both attributions are WRONG. An
> instrumented probe (per-buffer create/destroy stacks + per-submit validation
> scopes, `tools/bufstorm-probe.mjs`) reproduced the storm identically in BOTH
> configs (10,176 errors releases-enabled vs 10,353 disabled — the M9 A/B was
> coincidence) and attributed every error to ONE 80-byte buffer: three's
> module-global shared Sprite quad geometry (interleaved position+uv),
> destroyed by `palaceReverie/memoryLamps.dispose()` traversing sprites'
> geometry on site unload, then re-bound forever because r185's
> `WebGPUAttributeUtils.destroyAttribute` evicts the backend cache under the
> wrong key for interleaved attributes. shellBatch/tileBatch arena grows ran
> throughout with zero errors — exonerated. Fixed by sprite-guarding five site
> disposal traverses + `src/render/attributeDisposePatch.ts`. Details:
> `feature-research/bufstorm-rootcause/audit.md`.

## Files changed

Created or modified by THIS task (the tree also carries the committed M1–M8
work; only these deltas are M9's):

- `src/render/renderObjectRegistry.ts` — NEW: per-object RenderObject index +
  deferred release + shared-material leak counters (blocker 1)
- `src/app/renderCore.ts` — installs the registry after `renderer.init()`
- `src/world/shadows/tileShadowProxy.ts` — release RenderObjects at proxy
  dispose; corrected the wrong r185 geometry-dispose comments; leak counter
- `src/world/citygen/render/chunkLod.ts` — release RenderObjects at cell +
  warmup dispose; corrected comments; leak counter
- `src/world/citygen/render/lod.ts` — fix 8 stale comment (no per-cell clone;
  when the citygen residency min binds); leak counter for the shared beauty
  material
- `src/app/ringCoordinator.ts` — blocker 2: player-escape + age-cap force
  settles, live-load-radius settle target, `coversPoint()` for fix 5
- `src/main.ts` — fixes 3 & 5 + wiring: warmup pace deadline, sweep-aware far
  classification, `liveLoadRadius` option, `destinationRequiresAuthoredFloor`
  wiring, `__sf.m9Leak()` debug surface
- `src/app/worldArrival.ts` — fix 4: far arrivals onto an authored floor
  handoff await the required-region prime before dropping the cover
- `src/world/authoredRegions.ts` — fix 7 (dispose replaced GLTF originals) +
  `requiresFloorHandoffAt()` query for fix 4
- `src/net/net.ts` — fix 6: `#setStatus` publishes when only the detail changed
- `feature-research/m6-hitch-closure/audit.md` — dated correction note for the
  wrong RenderObject-release claim
- `feature-research/m9-review-fixes/audit.md` — this audit

Probe artifacts (scratchpad, not in repo): `m9-probe.mjs`,
`m9-leak-samples.json`, `m9-*.png`.

## Blocker 1 — RenderObject leak in the M6 shared-material refactor

**Verified the reviewer's reading of three r185:** `onGeometryDispose`
(RenderObject.js:337-344) only nulls `attributes`/`attributesId`; only
`onMaterialDispose` calls `renderObject.dispose()`, which is the sole path to
the RenderObjects cleanup (RenderObjects.js:201-209: pipelines refcount
delete, bindings.deleteForRender, nodes.delete, chainMap delete, listener
removal). M6's shared materials therefore retained every retired proxy/cell
RenderObject forever in `_listeners.dispose`.

**Approach chosen: direct per-object release (neither (a) nor (b)).** Instead
of generation-swapping the shared material (risks a node re-build/compile per
swap) or re-measuring per-residency clones (the measured M6 storm cause), the
fix keeps the shared materials — live pipelines never churn, the storm
mechanically cannot return — and releases retired RenderObjects directly:

- `installRenderObjectRegistry(renderer)` wraps
  `renderer._objects.createRenderObject` once (same pattern as
  `applyBundleOrderPatch`) and indexes render objects by their Object3D in a
  WeakMap; the chained `onDispose` keeps the index correct on every dispose
  path, with a once-guard so refcount cleanup can never run twice.
- `releaseRenderObjectsFor(mesh)` is called by `TileShadowProxy.dispose()`
  (per microcell mesh) and `ChunkLOD.dispose()` (beauty + shadow mesh) and the
  chunk-LOD warmup dispose. `renderObject.dispose()` performs exactly the
  cleanup the per-clone material dispose used to trigger; pipelines are
  usedTimes-refcounted so shared pipelines survive while any live user exists.
- **Deferred two presented frames**: `renderObject.dispose()` destroys the
  object's uniform GPU buffers immediately (Bindings `_destroyBindings`), and
  destroying synchronously at retire raced pending encoders/bundle replays.
  The release queue flushes after two `requestAnimationFrame`s.
- `?m9norelease=1` QA escape hatch disables the release for A/B attribution.

**Leak metric** — `__sf.m9Leak()` returns the shared materials'
`_listeners.dispose.length` (tileShadowProxyDepth, cityGenChunkLodBeauty,
cityGenChunkShadowDepth) plus total released.

### Measurements

Long-roam probe (scratchpad `m9-probe.mjs`, scenario `leak`): fresh vite +
fresh headless Chrome (WebGPU/metal, `?autostart=1&fullfps=1&profile=1`, no
device-metrics override); boot to settle, then 3.5 min of 300 m hops every
2.5 s (~120 m/s) around a downtown→embarcadero→bay→marina→goldenGate→palace
loop, sampling every 10 s.

- **With the fix** (final 210 s run): counters PLATEAU, tracking live
  residency — tileShadowProxyDepth oscillates 5→407 with district density and
  returns to baseline over water; 2 840 render objects released; **zero
  console errors**.
- **Fix disabled** (`?m9norelease=1`, same probe): tileShadowProxyDepth grows
  MONOTONICALLY 55 → 2 075 in 210 s (≈10/s of roam, unbounded), beauty/shadow
  cell counters 1→116/0→113 — the leak, reproduced.
- **Storm A/B (no hitch regression):** boot-sweep numbers across final-config
  runs: worst 408–1 659 ms, >50 ms count 11–44 (M6 audit band: 434–483 ms
  worst, 29–43 over50, plus 1.2–8.6 s cold-shader-cache outliers — my runs are
  all COLD fresh profiles, and the 1.6 s/8–10.5 s outliers match M6's cold
  observations). Drive-phase over50 per 210 s roam: 160–197 at ~4× the content
  crossing rate of M6's 25 s drive (~13 redraw frames there). Shared-material
  identity is untouched, so the ~270 ms-per-attach clone storm cannot recur;
  no new spike class appeared in any run.

### Buffer-destroyed validation storm: pre-existing, NOT this task

Two long roams surfaced `GPUValidationError: buffer used in submit while
destroyed` storms (the M6 audit's open watch item 5). Attribution A/B on one
build, same spawn (`palaceFineArts`, escape sprint):

- releases DISABLED (`?m9norelease=1`): **939 errors** (leak roam variant:
  7 143) — the storm occurs WITHOUT any M9 disposal.
- releases ENABLED: **0 errors** (and 3 further full-length runs with the fix
  enabled were clean; the storm is nondeterministic and correlates with dense
  district churn + large cold-citygen compile windows).

Prime suspect remains shellBatch's arena-grow dispose-while-attached (M6
`m6-bufdiag`). Left as an open item (background task chip filed).

## Blocker 2 — permanent-holo dead-end when the player outruns the sweep

`src/app/ringCoordinator.ts`:

- **Player-escape settle** (`PLAYER_ESCAPE_DISTANCE = 2600`): checked every
  sweeping update before the target math; beyond 2.6 km from the sweep focus
  `#forceSettle("player-escape")` runs. 2 600 m is deliberately below the
  front cap (3 840 m) so PLAYER_CLEAR still protects the player's bubble when
  the escape fires; content near the player is resident (streamers follow the
  player) and post-settle attaches birth-fade, so the instant reveal is
  invisible at that range.
- **Sweep age cap** (`SWEEP_MAX_AGE_S = 90`): `#forceSettle("age-cap")`
  regardless of position — covers capped load radii and any future stall.
- **Live-radius settle target**: `liveLoadRadius: () => CONFIG.tileLoadRadius`
  is min'd into the settle radius ONLY once residency has plateaued at the cap
  for 12 s (`CAPPED_RADIUS_QUIET_MS`) — surf's 2 km cap can now settle
  normally, while boot's initial-bubble clamp (which lifts and keeps growing
  within seconds) can never cause a premature settle.
- `#forceSettle` takes the full normal settle path: `settled` state (main's
  `ringUpdate` wrapper polls state → releases the M7 shadow streaming hold on
  the change, on EVERY settle path), `materializeField.reveal()`, and
  `onSettled` (bootMark). Tracer `ringForceSettle` + one `[rings]
  force-settle` info line.

**Escape probe** (scenario `escape`): boot, then 60 m hops every 250 ms
(~240 m/s) one direction from control onward. Force-settle fired at 2 640 m
from focus at t≈13 s: state `sweeping→settled`, `[rings] force-settle
(player-escape)` logged, front = revealed sentinel (1e9), shadow hold released
(`shadowRedrawHeldStreaming` frozen at 970–1 015 post-settle, 7–8 applied
static redraws), `frontComplete` bootMark present, world around the player
fully shaded (`m9-escape-settled.png`), zero errors (final-config run).
**Idle-boot control**: untouched boot settles via residency at 21.3–25.8 s
(band 21–27 s), NO force-settle, state `settled`, zero errors
(`m9-idleboot-settled.png`).

## Secondary fixes

3. **P4 warmup pace deadline** (`src/main.ts` ~4870): the pace now passes
   `waitForWorldBackgroundWindow(600, performance.now() + 3000)` — the first
   argument is extra-quiet-ms, not a cap, so a continuously moving player used
   to defer the paced warmup forever and pin `warmupInFlight`. Comment
   corrected.
4. **Far arrival authored-floor pop** (`worldArrival.ts` +
   `authoredRegions.requiresFloorHandoffAt` + main wiring): far destinations
   sitting within the arrival radius of a region that owns terrain (groundTop
   overlay) additionally await the REQUIRED-region prime (18 s timeout →
   visual-blocked fail-closed) before the cover drops; tile prime +
   supplemental scenery stay detached. Probe: far teleport downtown→Sutro
   Baths lands ON the deck — post-interactive Y samples for 8 s show
   maxUpStep 0.020 m (no pop), y stable at 32.08–32.10
   (`m9-far-authored-floor.png`).
5. **Near-mid-sweep holo reveal** (`main.ts` classifier +
   `ringCoordinator.coversPoint`): a hop while the coordinator is `sweeping`
   to a destination outside the current front classifies FAR even when
   resident. Probe: settle → far hop to Golden Gate → 900 ms later hop back to
   Sutro with `residentRadiusAround(dest) = 1 200 m` (old classifier: near →
   cover onto stale holo): now `(far cut)`, front recentred (17 m fresh bloom
   at the destination), cover drops onto materializing ground
   (`m9-near-mid-sweep.png`).
6. **net.ts `#setStatus`**: publishes when the status string is unchanged but
   the detail differs (stale HUD detail on replayed connection cycles).
7. **authoredRegions original-material leak**: after node-twin conversion the
   GLTF originals are disposed (twins share texture objects — `copy()` carries
   references and `Material.dispose()` never disposes textures, so the twins'
   maps stay live; verified visually at Sutro, textures intact). Unload keeps
   disposing the twins via `disposeRoot`.
8. **lod.ts comment**: no more per-cell clone (cells share the singleton), and
   the citygen residency min gates the front only while a sweep is active once
   the citygen ring exists (far-arrival sweeps; boot loads citygen
   post-reveal).

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes.
- Probe matrix (all fresh-profile cold-cache headless WebGPU/metal runs, no
  device-metrics override; scratchpad `m9-probe.mjs`):
  - idleboot ×2: settle via residency 21.3 s / 25.8 s, no force-settle, 0
    errors.
  - escape ×3 (incl. attribution pair): force-settle at ~2 640 m every run,
    hold released, 0 errors with the final config on the same spawn where the
    pre-existing storm reproduces with the fix DISABLED.
  - leak: final 210 s run — plateau + 0 errors (details above).
  - teleport ×2 (spawn=downtown): control 1 314/1 344 ms (band 1.0–1.7 s);
    Sutro far cut visual 548–550 ms, interactive 1 501–1 520 ms; no Y pop;
    mid-sweep hop-back reclassified far with front refocus; rapid A→B→C ends
    settled at C with B cleanly superseded, 0 console errors.
    (One rapid B leg logged a handled `transition failed … superseded` WARN —
    the documented M7 latest-wins path. A separate pre-existing quirk: rapid
    teleports onto not-yet-streamed waterfront coords can fail resolution with
    "No non-water spawn candidate found within 200m" — warn, fail-closed,
    superseded by the next arrival; untouched.)
- Screenshots (scratchpad): `m9-idleboot-settled.png`, `m9-escape-settled.png`,
  `m9-far-authored-floor.png`, `m9-near-mid-sweep.png`, `m9-rapid-final.png`.
- All probe vite servers + headless Chromes killed. Worktree handoff preview
  on port 5240 restarted over the FINAL dist, `http://localhost:5240/?autostart=1`
  verified 200. Nothing committed.

## Deviations from the plan

- **Blocker 1 approach**: neither suggested candidate was shipped. (a)
  generation swap risks one node-graph rebuild/compile per swap inside a
  render (the swap-warm would need a shadow-pass pre-warm three does not
  expose), and (b) per-residency clones are the measured storm cause. The
  direct-release registry achieves strictly stronger retention (zero per
  retirement, not "bounded every N") with zero material churn. It required two
  small files outside the blocker's named pair: the new
  `src/render/renderObjectRegistry.ts` and a 3-line install in
  `src/app/renderCore.ts`.
- `?m9norelease=1` QA flag added for A/B attribution (mirrors M7's
  `?nofarcut=1` precedent).
- The near-mid-sweep probe's hop-back leg exercised BOTH classification rules
  across runs (one run had residency already decayed to 0 → old rule; the
  reported run had 1 200 m residency → new coversPoint rule fired).

## Open risks

1. **Pre-existing buffer-destroyed storm** under extreme streaming churn
   (attribution above; background task chip filed). Not reproducible in
   normal-speed play in any M6–M9 run.
2. The deferred release window is two presented frames; a hypothetical future
   caller that re-renders a mesh AFTER calling `releaseRenderObjectsFor`
   would recreate its render objects (correct, just wasteful).
3. Cold-shader-cache first-district compile windows (1.6–10.5 s) remain as
   documented in M6/M7 — untouched by M9.
