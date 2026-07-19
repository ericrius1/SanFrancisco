# M6 hitch closure — implementation audit

> **CORRECTION (2026-07-19, M9 review fixes):** items 5 and 6 below claim that
> "RenderObjects subscribe to GEOMETRY dispose too (three r185
> RenderObject.js:346-347)" and that per-proxy/per-cell geometry dispose keeps
> releasing RenderObjects. That claim is WRONG: r185's `onGeometryDispose`
> only nulls the render object's attribute caches — ONLY material dispose
> triggers `renderObject.dispose()` and the RenderObjects cleanup
> (RenderObjects.js:201-209). With the M6 shared materials, every retired tile
> shadow proxy / citygen cell therefore left its RenderObjects permanently
> retained in the shared material's `_listeners.dispose` array (pinning meshes,
> merged cell geometry arrays, node builder states and per-object bind
> groups) — unbounded per-session growth. Fixed in M9 by an explicit per-object
> RenderObject release at retire (`src/render/renderObjectRegistry.ts`,
> deferred two presented frames); the shared materials themselves were kept, so
> the storm fix stands. Measurements and details:
> `feature-research/m9-review-fixes/audit.md`.

## Files changed

Created or modified by THIS task (the tree also carries the uncommitted M1–M5
work; only these deltas are M6's):

- `src/world/shadows/clipmapShadowNode.ts` — static-shadow invalidation
  burst-coalescing (dirty latch + quiet-window apply + bounded defer +
  local/far frame stagger), tracer counts
- `src/world/shadows/tileShadowProxy.ts` — ROOT-CAUSE FIX: per-proxy depth
  MATERIAL clone replaced by a shared material + per-proxy trivial geometry
  (RenderObject release now rides geometry dispose)
- `src/world/citygen/render/chunkLod.ts` — same root-cause fix for citygen
  cells: per-cell beauty/shadow material clones → shared singletons
  (per-cell geometry dispose keeps releasing RenderObjects); warmup helper
  warms the shared material
- `src/render/warmStaticRegion.ts` — new `warmScenePaced` (whole-scene
  signature-deduped compile in small paced chunks; paced collection sweep too)
- `src/render/pipeline.ts` — `warmup(scope, pace?)` paced pre-warm before the
  monolithic scene compile; compile-window + held-frame tracer attribution
  (`gpuCompile`, `gpuCompileMs`, `renderSkipCompile`)
- `src/main.ts` — P4 post-construction warmup re-run now passes a pace
  (presentation-frame yield + capped background quiet window per chunk)
- `feature-research/m6-hitch-closure/audit.md` — this audit

Probe artifacts (scratchpad, not in repo): `m6-probe.mjs`, `m6-bufdiag.mjs`,
`m6-noshadow.mjs`, `m6-shadowshots.mjs`, `m6-*.log`, `m6-*.png`.

## What changed per file

1. **`src/world/shadows/clipmapShadowNode.ts`** — shadow invalidation
   coalescing (task 3):
   - `invalidateStatic(scope)` no longer bumps the revision directly; it
     latches per-domain dirty flags + timestamps (scope semantics preserved
     exactly — "local"/"far"/"all" map to the same domains as before).
   - `#applyPendingStaticInvalidations(nowMs)` (called from `schedule()`,
     every enabled frame) promotes dirt to a revision bump when the burst has
     QUIETED (no invalidation for 250 ms) or the dirt is older than the
     2.5 s defer bound. Local and far never apply on the same frame.
   - Rationale (measured, see below): a static-domain redraw containing
     first-ever-drawn casters costs ~250–270 ms of GPU; redraws of already
     drawn content are cheap. Streaming bursts (ring sweep, citygen district
     publish) invalidate up to ~50×/frame for seconds — pre-M6 that meant a
     ~270 ms redraw EVERY frame for the burst's duration.
   - Tracer: `shadowInvalidate` (calls), `shadowStaticRedrawLocal/Far`
     (applied redraws).
2. **`src/render/warmStaticRegion.ts`** — `warmScenePaced(renderer, camera,
   scene, pace, chunkBudgetMs=35)`: collects all scene meshes, dedupes by the
   existing render-signature scheme, then compiles one representative at a
   time via `renderer.compileAsync(mesh, camera, scene)` (cache keys shared
   with live renders — three r185 resolves sceneRef to the target scene),
   calling `pace()` whenever the chunk budget is spent. The signature-dedup
   sweep itself is paced on the same budget (it is a string-building lump over
   thousands of meshes). Representatives get `visible/frustumCulled` forced on
   for the compile root only and restored immediately; meshes that left the
   scene between chunks are skipped. Tracer: `pacedWarmCompile`.
3. **`src/render/pipeline.ts`** —
   - `warmup(scope, pace?)`: when a pace is provided, `warmScenePaced` runs
     BEFORE the render-scoped update overrides (contact shadows stay live
     between chunks) and before the monolithic `compilePass(scenePass)` — the
     final pass compile then finds warm pipelines and completes in a few ms.
     The P1 covered boot warmup passes no pace and is unchanged (critical
     path preserved).
   - Attribution: the patched serialized `compileAsync` counts
     `gpuCompile`/`gpuCompileMs` per completed window; the `render()`
     early-return under `exclusiveCompileDepth > 0` counts
     `renderSkipCompile`. (GPU-bound stalls surface one frame late in
     rAF timing, so spike counts pair with the preceding frame.)
4. **`src/main.ts`** — the P4 post-construction `pipeline.warmup("boot")`
   re-run passes `pace = rAF presentation yield + waitForWorldBackgroundWindow(600)`.
   Pre-M6 this re-run was a 1.2 s monolithic compile window (profiled
   `scene-compile 747 ms · record 389 ms`) landing as 371–458 ms frozen
   frames ~15 s into a session; it is now ~40 ms chunks.
5. **`src/world/shadows/tileShadowProxy.ts`** — THE storm root cause. Every
   streamed tile's shadow proxy cloned the shared `MeshBasicMaterial` (so
   `dispose()` could release the proxy's RenderObjects, which subscribe to
   material dispose). A NEW material identity per streamed caster made the
   next static shadow redraw build a fresh node/pipeline — ~250 ms GPU-side
   per redraw, i.e. one ~270 ms frozen frame per attach for the whole sweep.
   RenderObjects also subscribe to GEOMETRY dispose (three r185
   `RenderObject.js:346-347`), so each proxy now owns a trivial 8-vertex box
   geometry instead and shares ONE material. A/B measured: sweep-storm frames
   (~25 × ~270 ms) vanish with the shared material.
6. **`src/world/citygen/render/chunkLod.ts`** — identical pattern for citygen
   cells (`lodMaterial().clone()` + `shadowProxyMaterial.clone()` per
   published cell — the downtown drive-in storm). Cells now use the shared
   singletons; the per-cell merged geometry (already disposed on retire, and
   shared between beauty and shadow mesh) releases the RenderObjects. The
   detached beauty warmup warms the shared material and no longer disposes it.

## Deviations from the plan

- **Coalescing scheme**: the task suggested "at most one static redraw per
  domain per ~300–400 ms while a sweep is active, immediate when lone". A
  fixed-rate limiter was implemented first and measured INSUFFICIENT — during
  streaming the invalidation stream is sparse-but-steady (a clump per attach,
  ~300 ms apart), so 350 ms rate limiting barely reduced applied redraws, and
  each applied redraw containing fresh casters costs ~250 ms GPU. The shipped
  scheme is burst-quiet coalescing (apply after 450 ms of invalidation
  silence, bounded by a 4 s defer), which converts a continuous storm into a
  handful of redraws. Lone events redraw ≤450 ms later instead of
  immediately — imperceptible next to the M5 birth fades.
- **"Skip redraws for holo-dark casters"** — not implemented; the burst
  deferral subsumes most of the benefit (redraws mostly land after the local
  fade window). Noted as an M7 option below.
- **Root-cause fixes in `tileShadowProxy.ts`/`chunkLod.ts`** were not in the
  task's named files, but fall squarely under task 4 (first-draw compile
  stragglers): the per-streamed-caster material clones were the measured
  compile source. A/B verified for the tile proxies (storm frames vanish with
  a shared material).
- **`onBatchCreated`/`warmStaticRegion`/M5 warms audited, not changed**: each
  covers one batch owner or a signature-deduped representative set — already
  small compile units.

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes.
- Headless probe (`scratchpad/m6-probe.mjs`, fresh vite-preview port per run,
  fresh Chrome profile per labeled run — cold Metal shader cache, matching the
  baseline; `?autostart=1&fullfps=1&profile=1`, no device-metrics override).
  Two scenarios per run: (1) boot sweep to settle, (2) settle → teleport to an
  unvisited district → 25 s of live driving. In-page rAF watcher (worst dt,
  >50 ms count) + `tracer.summary()`/spike ring.
- **Caveat on comparability**: spawn is random per boot, so content density in
  the sweep/drive windows varies between runs; the counts below carry that
  noise. The tracer counters (invalidations vs applied redraws, compile-window
  attribution) are the reliable signal.

| run | boot sweep worst | >50 ms | drive worst | >50 ms | errors |
|---|---|---|---|---|---|
| baseline | 642 ms | 38 | 409 ms | 19 | **1914** (buffer-destroyed storm) |
| after (coalesce+paced warmup) | 483 ms | 29 | 300 ms (GG Park) / 330 (downtown, after2) | 18 / 38 | 0 |
| final (all fixes) | 434 ms | 43 | 8.6 s cold-citygen outlier + ~13×270 ms | 27 | 0 |

- **Decisive attribution wins** (tracer, stable across runs):
  - Invalidation storm: `shadowInvalidate` 19k–45k per window →
    `shadowStaticRedraw*` applied 12–43 (pre-M6: one full redraw per frame
    during bursts).
  - P4 warmup: pre-M6 one 1.25 s exclusive window (`scene-compile 747 ms`,
    371–458 ms frozen frames); post-M6 `pacedWarmCompile` chunks of ~35–40 ms
    each (largest paced spike 43 ms).
  - Tile-proxy material-clone fix A/B (`m6-sharedmat.log`): the boot-sweep
    ~270 ms-per-attach storm frames vanish with the shared material
    (over50 29 → 15 on comparable spawns).
  - The baseline's 1914 `GPUValidationError: buffer used in submit while
    destroyed` did NOT reproduce in ANY M6 run (5 fresh boots + drives). A
    dispose-tracker diagnostic (`m6-bufdiag.mjs`) showed the only
    scene-attached disposals during streaming are the shellBatch arena grows;
    with per-cell chunkLod materials no longer disposed mid-stream the
    suspected race surface shrank. Kept as an open watch item.
- **Shadow visual sanity** (`m6-shadow-mid-sweep.png`, `m6-shadow-settled.png`,
  forced noon): avatar + building shadows present mid-sweep and settled, holo
  front visible at the horizon, no missing/stale shadow regions.
- frontComplete 21.3–23.8 s across runs (baseline 23.4 s; M4/M5 ballpark
  21.9–26.6 s) — no regression. Control 1087–1494 ms (baseline 1109 ms).
- Zero console errors in every M6 run.
- Probe artifacts: `scratchpad/m6-{baseline,after,after2,after3,final}-probe.log`,
  `m6-*.png`, `m6-bufdiag.log`, `m6-noshadow.log`, `m6-sharedmat.log`.
- All probe preview servers + headless Chromes killed; the worktree handoff
  preview on port 5240 (vite preview over the final dist) verified 200.
- Nothing committed.

## Open risks / leftovers (M7/M8 notes)

1. **Full static-domain redraw cost in fresh districts (~250 ms GPU)** — the
   dominating leftover. With clones fixed and redraws coalesced, each APPLIED
   redraw whose domain contains just-streamed casters still stalls ~250–270 ms
   (redraws over already-drawn content are cheap — measured via the
   already-visited-ground drive). During a 25 s drive into a dense district
   ~13 redraws apply → ~13 such frames. Closing this needs redraw
   amortization (scissored partial domain updates, or time-slicing the two
   static domains' caster sets across frames) — a clipmapShadowNode/ShadowNode
   render change, out of M6's bounded scope. Alternative cheap lever: hold
   static redraws entirely while the ring coordinator reports `sweeping` and
   apply once on settle (state is available; visual pop at settle untested).
2. **Cold-shader-cache first district visit** — on an empty Metal cache the
   citygen import/warm `compileAsync` is one 1.2–8.6 s exclusive window (gate
   holds frames; `renderSkipCompile` confirms). Warm caches: ~tens of ms.
   Chunking that warm through `warmScenePaced`-style pacing (it goes through
   `prepareRenderOwner` one owner at a time already — the big lump is the
   initial import batch) is M7 material; pipeline-cache persistence is the
   real fix (out of scope per M3 audit too).
3. **P3 construction-phase spikes (+0.5–4 s post-control, 130–520 ms)** —
   water sheet warms (single-signature monster TSL graphs, can't split
   below one compile), terrain patch builds, and early attach uploads. Held
   frames behind the compile gate; visible as void-phase hiccups. Accepted.
4. **GPU-bound attribution is one frame late** in the tracer (a redraw
   submitted on frame N surfaces as frame N+1's long dt) — remember when
   reading spike rings.
5. **Buffer-destroyed validation storm** (baseline run2) never reproduced
   post-M6; root cause not conclusively proven. Watch item: shellBatch
   `setGeometrySize` disposes the old arena while scene-attached
   (`m6-bufdiag.log` shows these are the only live disposals).
6. M5 audit's non-perf TODOs (optional-site materialize wrapping, street-lamp
   holo retint, moduleLayer tint) — untouched, still open.
