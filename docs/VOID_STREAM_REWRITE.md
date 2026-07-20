# Void Boot + Concentric Materialize Rewrite

Contract doc for the streaming-world rewrite on branch
`claude/streaming-world-concentric-chunks-b8eefb`. Every implementation task on
this branch follows this doc. File refs are repo-relative.

## Experience spec

1. **Void boot.** Player loads the page (or `?autostart=1`) and within ~1s is
   standing in a dark "holo void": the terrain clipmap rendered as a glowing
   contour grid of the real SF topography, avatar fully lit, controls live.
   No opaque loading screen once the void is up (prod name gate floats over the
   live void render).
2. **Concentric materialize.** The world streams in around the player in
   center-out rings using the existing streamers. A world-space **materialize
   front** (expanding radius) sweeps outward; content inside the front is fully
   shaded, content crossing it plays a holo-materialize dissolve
   (scanline/grid → full shading, ~1s). The front only advances over ground
   that is already resident + pipeline-warmed, so nothing ever pops behind it.
3. **Zero hitches.** All existing hitch disciplines preserved (see
   Constraints). New content admission stays budget-sliced.
4. **Teleports reuse it.** Far `worldArrival` arrivals swap the opaque cover
   for a short cut + void-at-destination + materialize front.

Look: cool cyan-teal holo (fog-city palette), thin world-space grid + scanline
band + edge glow at the dissolve boundary. Single color uniform so it can be
retinted in one place.

## Hard constraints (violations = regressions)

- **C1 Light set never changes size.** Sun + hemi (`src/world/sky.ts:347,366`)
  + 4-slot `LightPool` (`src/player/lightPool.ts`) exist from the first void
  frame. Streamed content uses `registerAmbientLightAnchor`, never `new *Light`.
- **C2 Warm before first visible frame.** Every new pipeline goes through the
  gated `renderer.compileAsync` (`src/render/pipeline.ts:545-579`) via
  `warmHiddenRoot` / `warmStaticRegion` / `onBatchCreated` hooks. The
  materialize front must not cross geometry whose pipelines aren't compiled.
- **C3 No live draw during a compile window.** Keep using the patched
  serialized `compileAsync`; never bypass it.
- **C4 Shadow invalidations stay distance-scoped** (`local` ≤220m else `far`,
  `src/world/tiles.ts:2129-2151`) and must be **debounced/coalesced** during
  ring sweeps (new work, M6) — never blanket-`all`, never per-attach redraw
  storms.
- **C5 InstancedMesh/BatchedMesh counts pinned.** Reveal via zero-scale rows /
  fade texels / instance attrs + one-frame warm delay (`waterEchoes.ts`
  pattern). Never grow `count` to reveal.
- **C6 No mid-frame batch arena growth.** Arenas pre-sized; fallback to
  bundles, never live `setGeometrySize` on a hot path.
- **C7 Per-residency material lifecycle.** Materialize variants follow the
  CityGen pattern: fade-variant material (alphaHash/dissolve node, transparent
  pipeline compiled at warm time) during birth, swap to shared opaque at
  settle, dispose per-residency clones at unload.
- **C8 One GPU upload per frame** on streaming attach paths (`#drainAttach`
  discipline). Boot no longer has a "turbo covered" window after reveal —
  post-reveal the live budget applies everywhere.
- **C9 Decode on workers only** (meshopt/KTX2); main thread does bounded
  finalize slices.
- **Freeze triad until groundReady.** Player hold (`holdForWorldArrival`) +
  input suspension release only when `#groundReadyAt` is true at spawn
  (`src/core/physics.ts:722-735`). Void boot keeps this — it resolves in a few
  frames since only CPU carpet is required.
- **CPU/GPU terrain lockstep** (`heightmap.ts #sampleGrid` ↔
  `terrainClipmap.ts #heightAt`) must not drift — it is the zero-pop guarantee.
- **Lift-only recovery discipline**: void floor sits at exactly
  `effectiveGround` so real surfaces never trigger stacked lifts.
- **Multiplayer Y**: first `sendState` already carries true terrain Y
  (`player.ts:471`); keep it that way during the void phase.

## Architecture

### A. Materialize core — `src/render/materialize.ts` (new)

- `MaterializeField` singleton owning:
  - Reveal front uniforms: `frontCenter (vec2)`, `frontRadius`, `frontBand`,
    `holoColor`, `worldTime`. Front animates per frame; radius is clamped to
    `minResidentRadius - margin` reported by the ring coordinator (front
    chases residency).
  - Birth registry: `birthOf(key)` returns a shared uniform holding a birth
    timestamp for a chunk/site/tile residency; `markBorn(key)` stamps it.
- TSL factory `materializeAmount({worldPos, birth?})` → 0..1 factor combining
  the front sweep and (when provided) the per-chunk birth ramp
  (`min(frontAmt, birthAmt)`; content born after the front passed uses the
  birth ramp alone).
- TSL helpers:
  - `holoShade(worldPos, baseColor)` — grid lines (fwidth world-grid) +
    scanline + fresnel-ish glow in `holoColor`.
  - `applyMaterialize(nodeMaterial, opts)` — wraps `colorNode`/`emissiveNode`/
    `opacityNode`: amount<1 → dissolve threshold (alphaHash-style) + holo
    edge glow; amount≥1 → untouched original graph. Plain materials must get
    an explicit `opacityNode` (the `NodeMaterialObserver` footgun,
    `citygen/render.ts:137-160`).
- Semantics unify the three existing fade families (CityGen fadeClone,
  shellBatch/moduleLayer texel fades, streetLamps birth attr) rather than
  adding a fourth: batched/instanced content keeps texel/attr fades but feeds
  them from `MaterializeField` timing so the look matches.

### B. Void realm + terrain holo — `src/world/voidRealm.ts` (new) + clipmap edit

- Terrain clipmap gets a materialize mix: below amount → holo contour grid
  (dark base, glowing grid conforming to real heights); above → existing
  ground shading. Driven purely by the front uniforms (terrain is always
  resident; no birth needed).
- Sky in void: dome dark/hidden variant (uniform-driven, not light changes),
  fog off or minimal, sun+hemi at normal intensity so the avatar reads.
  Sky/fog shading ramps in with the front (or a global reveal clock).
- Water: reveal uniform in water materials; far plane fades in with the front.

### C. Ring coordinator — `src/app/ringCoordinator.ts` (new)

Thin orchestration over existing streamers (do NOT rewrite them):
- Drives staged center-out admission from a focus (spawn or teleport dest):
  tiles (`primeAt` + `beginBackgroundExpansion` radii), citygen ring, tree
  chunks (`prepareAt`), lamps, groundcover, authored regions, optional sites.
- Tracks per-ring residency+warm completion; publishes `minResidentRadius`
  that the materialize front chases.
- Uses `frameBudget` lanes for sync slices and `backgroundAdmission` for heavy
  async admission; per-focus generation/AbortSignal for teleport cancel
  (NativeTreeForest `residencyEpoch` pattern).

### D. Boot restructure — `src/main.ts` + `src/app/boot/*`

Phases (replaces the monolithic straight-through boot):

1. **P0 kickoff (parallel):** map fetch, GPU init, box3d WASM import, tiles
   manifest fetch all start immediately as promises.
2. **P1 void essentials (awaited):** map → gpu → Sky (lights) → physics-min
   (world + carpet; landmark colliders + `BuildingColliderIndex` deferred
   until manifest ready) → spawn resolution → `Input` → `Player` →
   `ChaseCamera` → `createRenderPipeline` → materialize core + void realm →
   `player.warmup()` + covered `renderFrame()` + `pipeline.warmup("boot")`
   (near-empty scene: cheap).
3. **P2 void live:** start a **provisional void loop** (lightweight tick:
   physics step + maintainStreaming + player/camera update + materialize
   update + frameBudget.run + render). Reveal + control handover as soon as
   `groundReady` at spawn (freeze triad until then). `bootScreen.markReady`
   here; prod name gate floats over live render; autostart enters instantly.
4. **P3 sliced construction:** the former sync stretch (audio, FX, gameplay,
   net, minimap, etc.) runs in order but chopped with
   `createFrameBudgetCheckpoint(≈5ms)` awaits so void frames never hitch.
   Systems constructed but not ticked (same as today — nothing ticks before
   the real loop).
5. **P4 handoff:** `createGameLoop` builds the real tick; stop void driver,
   `startFrameDriver` with the real loop. Deferred `revealedPromise.then`
   blocks gate on `constructionComplete && revealed`.
6. **P5 rings:** ring coordinator starts at spawn immediately at P2 (visual
   fabric first); heavier optional layers admit post-P4 as today.

Boot marks preserved + new marks: `voidFrame`, `control`, `construction`,
`handoff`, `frontComplete`.

### E. Teleport mode — `src/app/worldArrival.ts`

New arrival flavor: brief cut cover (or camera treatment) → place player at
dest (CPU height, triad hold) → ring coordinator re-focuses (abort old
generation) → materialize front sweeps at dest. Collision-ready semantics
unchanged (fail closed).

## Milestones

- **M1 Materialize core** (`src/render/materialize.ts`): field, TSL nodes,
  holo look. Acceptance: typecheck + build pass; node compiles in isolation.
- **M2 Terrain holo + void realm**: clipmap materialize mix, void sky/water
  uniforms, front animation drivable via debug hook (`__sf.materialize`).
  Acceptance: with a debug query flag, the live app can show terrain in holo
  mode and sweep the front by console command; no perf regression when
  amount=1 everywhere (front collapsed = shading byte-identical path or
  near-zero cost mix).
- **M3 Boot restructure**: phases P0–P5, provisional void loop, early control.
  Acceptance: `?autostart=1` boots to controllable avatar with holo terrain
  fast; bootMarks show voidFrame ≪ old reveal; existing full world still
  arrives; no hitch > 20ms attributable to construction slices
  (hitchTracer).
- **M4 Ring coordinator**: front chases residency; staged radii; teleport
  generation cancel.
- **M5 Per-system materialize**: tiles (per-residency material uniform +
  batch instance birth channel), citygen (retint existing crossfade to holo),
  landmarks (per-landmark birth fade), water, bay/GG light ramps, lamps
  restyle, authored/optional site roots.
- **M6 Hitch closure**: shadow invalidation debounce/coalesce during sweeps;
  compile-queue ordering (front-priority); verify one-upload-per-frame.
- **M7 Teleport materialize arrivals.**
- **M8 QA**: fresh-boot perf probes (`?fullfps`), headless Playwright boot
  probe (3-phase waterfall per docs/LAZY_LOADING.md), hitchTracer summaries,
  screenshots, timing comparison vs main.

## M14 — Data-concentric world (terrain tiling)

Phase 2: the sweep loads DATA, not just visuals. Boot fetches ~350KB instead of
~11.5MB; terrain heights/surface/groundtop stream concentrically behind the
front. Full ground-truth in the terrain-pipeline exploration (grid: 8m cells,
1888×1736, tile=800m=100 cells, manifest = existence oracle).

Core design decisions:
- **Full-lattice arrays stay** (~26MB RAM, same as today). Boot allocates them
  and fills from a low-res OVERVIEW (1/8 heights ~102KB + 1/8 surface ~51KB,
  new bake artifacts). Absent regions therefore read plausible coarse data —
  no sampler changes, no apron, no guards; `#sampleGrid` and every consumer
  (FarOcclusionField length check included) work unmodified. Real 800m tiles
  overwrite their region (CPU arrays + GPU sub-rect) as they stream.
- **Bake**: `tools/bake-terrain-tiles.mjs` emits `public/data/terrain/`
  overviews + per-tile bundles `tile_IX_IZ.bin` (heights int16 + surface u8 +
  groundtop sparse deltas for that tile), keyed to the existing 800m manifest
  grid. Contract test: stitched tiles + overview == original artifacts
  byte-exact (heights/surface) / value-exact (groundTops).
- **Runtime**: terrain-tile worker (spawnWorker pattern: id map, cancel,
  transferables) fetches+decodes+builds the 4 mip sub-rects; main thread
  installs bounded per frame — CPU row writes + `copyTextureToTexture` blits
  into the clipmap height/normal/surface atlases (all mips) + height-bounds
  region update + `groundRevision` bump (throttled). CPU install and GPU blit
  land in the SAME install step (lockstep). Quantization range comes from
  `meta.terrain` constants, not a whole-map rescan.
- **Overlay safety**: tiles patch BASE arrays only (overlays compose at query
  time). `prepareCoronaHeightsGround` re-applies after any intersecting tile
  installs (post-install fixup hook), then bumps revision.
- **Residency**: `terrain.residentRadiusAround(x,z)` joins the ring
  coordinator's residency min — the front cannot sweep onto ground whose data
  isn't installed. Fetch priority: spawn/teleport-dest tile first, then
  nearest-first outward, abortable per focus generation.
- **groundReady tightens**: `#groundReadyAt` (and far-arrival ground wait)
  additionally require the terrain tile at the anchor cell to be REAL (not
  overview) — spawn and teleport ground is never approximate. Elsewhere,
  physics carpet may transiently ride overview ground (fast vehicles beyond
  the front); tile install re-places via the existing groundRevision path.
- **Escape hatch**: `?fullmap=1` keeps the legacy monolithic load path for
  A/B and emergencies; old artifacts remain in /data.
- Boot prefetch (index.html) becomes meta + manifest + overviews; spawn tiles
  fetch immediately after spawn resolution.

Acceptance: boot waterfall probe asserts NO heightmap.bin/surface.bin/
groundtop-delta.bin fetch (default path) and total terrain bytes < ~500KB
before control; map bootMark and far-teleport arrival times drop accordingly;
lockstep contract tests extended to tile installs; fast-drive probe confirms
sane physics Y while outrunning tiles (overview ground) with no pop at spawn/
teleport anchors; full regression suite (escape-settle, rapid teleports,
holo-off default) stays green.

## QA notes

- Probes must fresh-boot (memory: baseline ladder pollutes late stops) and
  kill stale vite on fixed ports first.
- Headless: hidden Browser pane stalls raw-rAF gates — use Playwright headless
  probe + CDP screenshots for visuals.
- `?startscreen=1` covers the start-gate experience; default local dev
  auto-enters.
