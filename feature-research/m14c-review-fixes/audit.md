# M14c — Review punch-list fixes: audit

## Files changed

- `src/world/terrainTiles.ts`
- `src/world/heightmap.ts`
- `src/world/tiles.ts`
- `src/world/authoredRegions.ts`
- `src/main.ts`
- `index.html`
- `.gitignore`
- `tools/terrain-tiles-contract-test.mjs`
- `feature-research/m14c-review-fixes/audit.md` (this file)

## Per-fix map

### BLOCKER 1 — boot hang on terrain-manifest failure (fail-open)
- `src/world/terrainTiles.ts` `#loadManifest()` (replaces the constructor's single-attempt fetch): 3 attempts with 1 s / 2 s backoff (first attempt still rides the head prefetch). On terminal failure it FAILS OPEN: sets `#manifestFailed` AND `map.terrainStreaming = false`, with a prominent `console.error`. Flipping `terrainStreaming` off makes `isTileReal*` return true everywhere and `terrainResidentRadiusAround` return the cap, so the physics spawn hold (`physics.ts #groundReadyAt`) and the ring coordinator's residency min release onto overview ground — same story as a tile 404. No physics.ts / boot-timeout change needed.
- `#markManifestAbsent(manifest)`: after a successful manifest load, every grid tile position (meta.tilesX × tilesZ, intersecting the cell grid) absent from the manifest is `markTileUnavailable`'d immediately and recorded in `#manifestAbsent` (permanent — excluded from the transient recovery). A manifest missing the anchor key can no longer hold boot.
- Far-teleport path untouched (15 s fail-closed retained).

### BLOCKER 2 — build chain vs untracked generated data
- `.gitignore`: `public/data/terrain/` added (generated bake output, ~11.6 MB, never committed).
- `tools/terrain-tiles-contract-test.mjs`: self-healing preamble — when `public/data/terrain/terrain-manifest.json` is missing, it runs `tools/bake-terrain-tiles.mjs` (spawnSync, stdio inherit) before asserting the contract, reporting the measured bake time. The contract test is the first terrain-touching step of `npm run build`, so a fresh clone (and every deploy) bakes as part of the build; bake sources (`public/data/heightmap.bin` / `surface.bin` / `groundtop-delta.bin` / `meta.json`) are tracked. **Deploys therefore always carry the baked data — the bake is part of `npm run build`.** Measured bake time in the simulated-fresh build: see "Build proof" below.

### 3 — unavailable-tile recovery
- `src/world/terrainTiles.ts`: fetch-failure `markTileUnavailable` calls now also record the key in `#unavailable` (transient set). `#recoverUnavailable()` reverses them via the new `WorldMap.clearTileUnavailable` (heightmap.ts) and resets the per-tile attempt budget; invoked on every `setAnchor` (teleports) and on a slow ~60 s re-probe inside `update()` (`UNAVAILABLE_REPROBE_MS`). `#manifestAbsent` keys are never recovered. Genuinely missing tiles simply re-mark after the next attempt budget (bounded retry traffic, 60 s cadence).
- `src/world/heightmap.ts` `clearTileUnavailable(ix, iz)`: bitset clear + realTileCount decrement + residency-memo invalidation. Documented as caller-restricted to tiles the streamer itself marked.

### 4 — ?fullmap spelling mismatch
- `index.html` inline prefetch: `/[?&]fullmap=1/` → `/[?&]fullmap(?:=|&|$)/` — presence-based, matching `bootMap.ts`'s `URLSearchParams.has("fullmap")`, so a bare `?fullmap` takes the legacy prefetch with the legacy load.

### 5 — anchor-ring revision-bump coalescing
- `src/world/terrainTiles.ts` `#install`: the immediate `commitRevisionBump()` / `discardRevisionBump()` is replaced by a burst accumulator (`#burstWantsCommit ||= near`) flushed ONCE per microtask (`queueMicrotask`, `#bumpFlushQueued`). An anchor-ring decode burst that installs up to 9 tiles in one task now produces exactly one commit; the steady-state path (1 install per `update()`) is unchanged (one flush per frame).

### 6 — landmark shadow proxies front-gated
- `src/world/tiles.ts`: new `#landmarkProxyGates` (same shape as `#landmarkGates`), populated when the landmark shadow proxy installs — one gate per proxy cell `InstancedMesh`, bounds from its instanced `boundingBox` (world-space; proxy matrices are world-space under an identity group). `#applyLandmarkFrontGate` now iterates both gate lists, so a front-hidden landmark's proxy cells stop casting (visible=false excludes them from shadow passes) and reveal through the same budgeted frontGate queue. Old handles are cancelled if a proxy is ever replaced.

### 7 — authored-region re-gate races
- `src/world/authoredRegions.ts` `#attach`: re-applies `#applyRegionFrontGate` immediately after `status = "ready"` — a front refocus that landed while the attach was mid-flight (applyFrontGate skips non-ready regions) is no longer lost.
- `src/main.ts` P5 arming block (after `tiles.applyFrontGate()`): now also calls `authoredRegions.applyFrontGate()`.

### 8 — applyTileRegion exception safety
- `src/world/terrainTiles.ts`: GPU sub-rect install extracted into `#applyGpuRegion(ix, iz)` with try/catch. On throw: warn + re-queue in `#gpuRetryQueue` (retried on subsequent `update()` calls, consuming that frame's install budget), bounded by `MAX_GPU_INSTALL_ATTEMPTS = 3`; terminal failure logs a console.error stating the visual clipmap keeps overview data for that tile while physics uses the real CPU lattice. The tile stays marked real (CPU is the source of truth); the retry restores CPU/GPU lockstep.

### 9 — contract-test tie-break
- `tools/terrain-tiles-contract-test.mjs`: the overview surface-class check now asserts the stored class EQUALS the lowest-id max-vote class (mirrors the bake's strict-`>`-over-ascending-ids tie-break) instead of accepting any max-vote class.

### 10 — documented leftovers (NOT fixed, carried forward from m14b)
- Vegetation/props seeded on overview ground are not re-seated after a real tile installs under them.
- FarOcclusionField / water-floor snapshots may bake coarse overview heights for not-yet-streamed regions (no re-bake on install).
- `[compile]` console.info + debug flags remain in prod builds.
- 🌲 worktree title prefix strip is a merge-time step.

## Deviations from the punch list
- Blocker 1 fail-open is implemented by flipping `map.terrainStreaming` off rather than adding a "dead" flag consulted by `isTileRealAt`: it is the single existing switch that already means "no terrain streaming this session" (legacy/fullmap semantics), and every consumer (physics gate, residency radius, streamer update) keys off it.
- Item 8 chose "bounded GPU-only retry" over "un-mark real": un-marking would re-hold physics on a tile whose CPU data is already correct; the retry converges the visual clipmap without touching gating.

## Test results

- `tsc --noEmit`: clean.
- **Simulated fresh-clone build**: `public/data/terrain/` moved aside → full `npm run build` passed end-to-end (exit 0); the contract test auto-baked (**measured bake: 1.0 s** — 342 tiles, 11.5 MB, 274,463 deltas) then verified byte-exactness. `.gitignore` confirmed effective (0 terrain files in `git status` after regeneration). Contract test also re-run standalone from the missing state: bake 1.0 s, "342 tiles byte-exact" PASS with the new lowest-id tie-break assertion.
- **Headless probes** (`.data/m14c-probe.mjs`, log `.data/m14c-probe-final3.log`; fresh boots against the final dist served by the 5240 `vite preview`, Playwright + Metal WebGPU; single foreground execution, overall verdict `M14C PROBE PASS`, exit 0):
  - **A — manifest 404 simulation** (route-fulfilled 404 on terrain-manifest.json): control reached at **5.3 s** (includes the 1 s + 2 s retry backoff), exactly one fail-open `console.error` ("failing open onto overview terrain"), `map.terrainStreaming === false`, player position finite on overview ground. **No hang.** Across repeats tonight: 3.9–12.2 s (warm) and ~28 s cold-Dawn-cache — always bounded, always fail-open.
  - **B — normal boot**: control at **3.3 s** (marks: map 329 / tiles 1295 / physics 1538 / world 1647 / spawnTile 3056 / warmup 3157 / control 3289 / reveal 3513; best warm repeat control 2.04 s); streamed waterfall intact — zero legacy bins (heightmap/surface/groundtop-delta), overview + terrain manifest fetched; tiles streaming (21–99 installed at check across runs), player tile REAL, **zero console errors**.
  - **C — far teleport** (teleportToTarget −4200,−5200 Marin): arrival idle with player at target in **1.7 s** (0.4–2.1 s across repeats), destination tile `3_4` REAL at completion, zero errors. Probe-side note: the original C assertion waited for a worldArrival GENERATION bump, which falsely times out when the session has settled+expanded and the hop classifies NEAR (no cover, no bump — the app relocates correctly); the assertion now checks actual arrival (position at target + idle + unheld). The intermittent "C timeout" seen during probe development was this probe artifact, verified via an isolated diagnostic (`.data/m14c-c-only.mjs`: FAR-classified run passes in 2.1 s with dest tile real).
  - **D — rapid A→B→C teleports**: final ring state **settled**, birthHolo debugToggle **false** (holo debug default-off), zero errors.
- 5240 preview restarted from this worktree's final dist: HTTP 200, `🌲 [wt: streaming-world] San Francisco` title. Probe server (5312) killed. Nothing committed.

## Open risks
- The transient-unavailable re-probe (60 s) causes small periodic re-fetch traffic for genuinely missing tiles on a stale deploy (≤ MAX_CLIENT_ATTEMPTS per cycle per tile).
- Proxy-cell front gates flip `visible` without a shadow-domain invalidation, matching the existing beauty-subtree gate behavior; the far cache picks the change up on its next redraw.
