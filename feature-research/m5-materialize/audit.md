# M5 per-system materialize — implementation audit

## Files changed

Created or modified by THIS task (the tree also carries the uncommitted M1–M4
work; only the deltas listed below are M5's):

- `src/render/materialize.ts` — extended: `amountAt` CPU twin, `applyHoloBirth`,
  `batchBirthNode` / `configureBatchHoloBirth`, `extraAmount` option,
  basic-material emissive fallback, softened edge flash, `birthCount` /
  `birthKeys` probe getters
- `src/world/tiles.ts` — tile-fabric materialize: per-residency birth uniforms,
  holo-wrapped material sets + facade slots, per-instance batch birth textures,
  front-only landmark wrap, node-material base swaps
- `src/world/water.ts` — spatial front amount multiplied into all sheet
  opacities (far/near/lagoon/underside)
- `src/world/authoredRegions.ts` — per-region holo-birth (material conversion +
  markBorn/forgetBirth)
- `src/world/citygen/render.ts` — fade-clone holo retint (bundle fallback path)
- `src/world/citygen/render/shellBatch.ts` — batched-shell crossfade holo retint
- `src/world/citygen/render/lod.ts` — chunk-prism front-only holo
- `src/world/citygen/stream/ring.ts` — `materializedRadiusAround(x, z)` query
- `src/app/ringCoordinator.ts` — optional `citygenRadius` min'd into residency
- `src/main.ts` — coordinator wiring for citygen radius, Bay/GG light front
  ramps after every `sky.update` render site, import additions

Probe artifacts (scratchpad, not in repo): `m5-probe.mjs`, `m5-flash.mjs`,
`m5-*.png`.

## Per-system map (file:line, post-edit)

1. **Baked tile fabric** — `src/world/tiles.ts`
   - Birth uniform per residency: `#drainReady` (~:1560) does
     `materializeField.birthOf("tile:"+key)` + `markBorn`;
     `#unloadTile` (~:2245) `forgetBirth`.
   - Per-residency material clones: `createTileMaterialSet(birth)` (~:344)
     wraps road/park/plain/palace/sutro clones with `applyHoloBirth({birth})`.
     Base mats `plainMat/palaceMat/sutroMat/goldenGateMat` switched to
     `MeshStandardNodeMaterial` (~:300) — node slots on plain materials are
     ignored by the WebGPU backend; vertex colours still multiply after a
     custom colorNode.
   - Facade slots: wired in `#drainReady` right after `#takeSlot()`
     (`applyHoloBirth(slot.matNear/matFar, {birth})`, ~:1592) — slot materials
     are recreated per residency, so graph shape stays constant.
   - Batched folds: `BatchBirth` (1×capacity R32F DataTexture + one texel
     write per instance add, `createBatchBirth`/`stampBatchBirth` ~:335) —
     building batch in `#ensureBuildingBatch` (birth configured AFTER
     `configureFacadeBatchMaterial`, BEFORE `onBatchCreated` warm), road/park
     batches in `#attachRoadPart`/`#attachParkPart` (clone → batch → configure
     → announce). Stamped at each successful `batch.add` via `stampBatchBirth`.
   - Landmarks: `init()` landmarks loader (~:635) wraps per UNIQUE material —
     `holoLandmarkMaterial` clone map (front-only, no birth; boot-resident),
     crown wrapped in place, GG road via `createGoldenGateRoadSurface(map,
     holoLandmarkMaterial(roadMat))`.
2. **CityGen** —
   - Shell batch retint: `shellBatch.ts` `makeWallBatchMaterial` /
     `makeStdBatchMaterial` (~:122/:148): `applyHoloBirth(m, {extraAmount:
     fade})` — amount = min(front, per-instance fade texel); alphaHash dither
     untouched; settle (fade=1) collapses to original shading.
   - Bundle fallback: `render.ts` `fadeCloneOf` (~:165):
     `applyHoloBirth(f, {extraAmount: materialOpacity})` — clones exist only
     while fading; the settle swap to shared opaque materials is untouched.
   - Chunk prisms: `lod.ts` `lodMaterial()` (~:63): front-only
     `applyHoloBirth(m)`; per-cell clones inherit the wrap.
   - Radius query: `ring.ts` `materializedRadiusAround` (~:1874): min distance
     from (x,z) to any wanted cell (Chebyshev window `activeCellLoad`, capped
     by CHUNK_VISUAL_RADIUS via that variable) not yet phase
     `ready`/`fallback`; Infinity when nothing constrains; ≤49 keys per call.
   - Coordinator fold: `ringCoordinator.ts` `#refreshResidency` (~:236) mins
     `opts.citygenRadius(cx,cz)` into resident;
     `tracer.count("ringCitygenResidency")`. Wired in `main.ts` via a
     rebindable `citygenResidencyRadius` (default Infinity; rebound right
     after the `citygenRing` holder declaration, avoiding TDZ — the ring is a
     post-reveal dynamic import).
3. **Landmarks** — see 1 (front-only per unique material, applied at load,
   before any render/warm).
4. **Water** — `water.ts`: `.mul(materializeAmount())` appended to the opacity
   chains of the bay far/near sheets (~:301), palace lagoon (~:366) and the
   underside lid (~:433). `#uReveal` (VoidRealm global) stays the outer
   multiplier — void phase still hides water entirely.
5. **Bay/GG lights** — `main.ts` `applyLightFrontRamps` (defined above
   voidTick): CPU multiply of `BAY_LIGHTS_INTENSITY` /
   `GOLDEN_GATE_LIGHTS_INTENSITY` by `materializeField.amountAt(bridge
   midpoint)`. Called after ALL five `sky.update` sites that precede a render
   (voidTick, updateWorld, and the three preSimulate cinematic/pause branches)
   because Sky#applySun rewrites the uniforms every update. Zero shader work.
6. **Authored regions** — `authoredRegions.ts` `applyRegionMaterialize`
   (~:182): unique-material conversion (standard/physical/basic node twins via
   `copy()`) + `applyHoloBirth({birth})`, run in `#load` BEFORE the
   `prepareRoot` warm; `markBorn("region:"+id)` in `#attach`, `forgetBirth` in
   `#unload`. Optional sites (`src/app/compose/optionalSites.ts`) NOT covered
   — documented TODO (they arrive under their own gates/covers; material zoo
   per site is large).
7. **Street lamps** — skipped (time-boxed, plan-sanctioned): their existing
   birth+edge fades already avoid pops; holo retint of the birth window left
   for a later pass.

## How batched-instance birth works

BatchedMesh has no per-instance custom attribute, so birth timestamps ride a
1-row `R32F` DataTexture per batch (capacity = instance capacity), indexed by
the SAME indirect-texture row three's own batch node uses
(`batchBirthNode` in materialize.ts mirrors facade.ts's row Fn). Written once
per `add()` (`stampBatchBirth` — no per-frame CPU writes; the shader ramps
from `worldTime − birth`). Unwritten rows hold +1e9 (amount 0), but every row
is stamped the same frame its instance is added; freed ids are re-stamped on
reuse. Cost: two exact texel fetches on the batched paths (indirect + birth) —
the moduleLayer precedent; not measurable in the settled fps numbers below.

## Deviations from the plan / notes

- **Edge flash softened** (`materialize.ts`, 0.35 → 0.08 weight): the first
  probe run showed teleport-arrival buildings as a flat saturated cyan wash —
  under a birth ramp the amount is uniform per object, so the parabola flash
  (peak ≈1.2 linear with LIGHT_SCALE) washed whole facades instead of
  accenting the front band. Peak is now ≈0.28 linear.
- **`applyMaterialize` emissive fallback**: `materialEmissive` is referenced
  only when the material actually has an `emissive` colour (basic/unlit GLB
  materials fall back to vec3(0)).
- **Per-tile bundle "core" meshes** (landmarks-in-tiles/misc) share the tile
  birth uniform stamped at finalize; a very large tile whose bundle parts
  attach for >1 s can have its last few parts land post-ramp. Batched
  buildings/roads/parks (the bulk) have exact per-instance births. Accepted;
  re-stamping per part would visibly re-dip the whole tile.
- **`setColorAt` hijack** was not used (checked: the building batch has no
  free channel — the alive atlas is fully occupied); the DataTexture path was
  the plan's other sanctioned option.
- **PLAYER_CLEAR kept at 150**: a fast mover can push the front over
  non-resident ground, but with M5 that content simply birth-fades when it
  attaches — the steady-state grace covers it.
- **Citygen residency gating extends settle** when the ring comes online
  mid-sweep (resident transiently dips to the nearest unpublished cell; the
  monotonic front holds). Measured frontComplete 21.9 s / 26.6 s across runs
  vs M4's ~22.8 s — same ballpark, spawn-dependent.
- **fadeCloneOf pipeline variant**: the wrapped fade-clone graph compiles on
  the first fade-in exactly like the pre-M5 clone graph did (bundle fallback
  path only; batched shells are pre-warmed via prepareExterior).

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes.
- Headless probe (`scratchpad/m5-probe.mjs`: fresh ports, `vite preview`,
  headless Chrome + CDP/metal WebGPU, `?autostart=1&fullfps=1&profile=1`, NO
  `Emulation.setDeviceMetricsOverride` per the M4 stale-canvas gotcha) — **ALL
  PASS**, two full executions (pre- and post-flash-soften):
  - **Run 1 (idle sweep)**: front monotonic, settled; frontComplete 21.9 s /
    26.6 s (M4: 22.8 s); control 2091 ms (cold cache) / 1666 ms / 1219–1526 ms
    warm (M4 range 1047–1388 ms — within noise of the warm runs); zero console
    errors. Screenshots: `m5-a-early-bloom.png` (near street fully shaded, the
    skyline beyond the front a glowing cyan holo-grid city — the M3 pop-in is
    gone), `m5-b-mid-chase.png` (city shaded to the rim, holo remnant at the
    horizon), `m5-c-settled.png` (normal world).
  - **Settled perf (?fullfps)**: 118.9 / 119.3 fps (4 s rAF count),
    tracer emaMs 8.28 / 8.32 — identical across pre/post-M5-tuning runs; no
    absolute pre-M5 fps figure exists in the M4 audit, so this is the recorded
    baseline; nothing suspicious. `tracer.summary()` shows the two new counts
    (`ringCitygenResidency` 86–87 ≙ one per residency refresh,
    `tileResidencyScan` unchanged) and no new spike sources; worst frames are
    the known boot/citygen-import compiles.
  - **Run 2 (post-settle streaming grace)**: teleport after full reveal →
    covered arrival completes; birth-key diff asserts NEW registrations
    (15 and 22 new keys across runs — `tile:*` + `region:fort-mason` /
    `region:sutro-baths`). First execution's downtown arrival captured the
    ramp visually (`m5-d-arrival-early.png` holo facades →
    `m5-e-arrival-late.png` fully shaded 1.5 s later); that pair also exposed
    the too-strong flash that was then softened. The post-fix targeted rerun
    (`m5-flash.mjs`) landed in parkland (no facades in frame), so the
    softened-flash bound is analytic (0.28 linear peak, well under the
    saturation that caused the wash).
  - **Run 3 (walk-away, M4 regression)**: front kept growing under continuous
    W (940 → 2778/FULL), `cg 1` showing the citygen min active; zero errors.
- Screenshots at
  `/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco--claude-worktrees-streaming-world-concentric-chunks-b8eefb/016a9db0-273c-468a-8995-6e1b9fac50be/scratchpad/m5-{a,b,c,d,e}-*.png`.
- All probe preview servers + headless Chrome instances killed; the only
  surviving process is the intentional worktree handoff preview on port 5240.
- Nothing committed.

## Open risks / M6 TODOs

- **Optional-site interiors** (`optionalSites.ts`) still pop if one loads
  after the front passes its area — mitigated by their own arrival covers/
  gates; wire them through `applyRegionMaterialize`-style wrapping in a later
  pass.
- **Street lamps** holo retint of the birth window not done (low priority).
- **moduleLayer windows** (citygen instanced glass) fade via their own texel
  dither without the holo tint — visually in step with the shells' dither,
  just without the cyan accent.
- **Citygen swap pops behind the front**: a cell publishing after the front
  passed still swaps baked→chunk without a crossfade (two shaded
  representations of similar massing — pre-existing behaviour, out of M5
  scope).
- **M6**: shadow invalidation debounce during sweeps; consider front-priority
  compile ordering; verify uniform refresh of the front under BundleGroups on
  more hardware (confirmed working in probe screenshots — bundle tiles
  visibly holo/reveal correctly).
- The 2 texel fetches per fragment on batched fabric and ~40 ALU of holoShade
  on always-on paths did not move emaMs at 1600×1000; re-check at 4K in M8 if
  budgets tighten.
