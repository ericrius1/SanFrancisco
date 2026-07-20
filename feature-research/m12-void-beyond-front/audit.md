# M12 nothing-but-void-beyond-the-front — implementation audit

## Files changed

Created or modified by THIS task (the tree also carries the uncommitted
M1–M11 work plus the concurrent bufstorm session's edits — only these deltas
are M12's):

- `src/render/frontGate.ts` — NEW: shared front visibility gate (hidden-entry
  registry, `shouldHide`/`shouldHideRect`, budgeted nearest-first `update()`
  reveals, `clearedRadius()` for the coordinator clamp, settle flush,
  `frontUnhide` tracer counts)
- `src/render/materialize.ts` — layer 2: `edgeGlowWindow` + `holoShade`
  `edgeWindow` option (grid/fill glow concentrated at the dissolve edge) and
  the `applyMaterialize` dark-floor windowed to zero beyond the edge
- `src/app/ringCoordinator.ts` — `unhideClearedRadius` option; front target
  clamps to nearestHidden − `FRONT_GATE_CLAMP_MARGIN`
- `src/world/tiles.ts` — tile-level front gating (finalize/adopt/scan routed
  through `#applyTileVisibility`; unload/shadow-proxy handling; landmark
  subtree gates; public `applyFrontGate()`)
- `src/world/authoredRegions.ts` — region-root front gating at attach +
  `applyFrontGate()`; handle cleanup on unload/attach-failure
- `src/world/citygen/stream/ring.ts` — published cells' chunk meshes gate
  through frontGate (`applyCellFrontGate` in `publishChunk`), handle cleanup in
  unload/dispose paths, `applyFrontGate()` on the ring interface
- `src/main.ts` — gate arming/refresh wiring (coordinator creation, ringUpdate,
  far-arrival cut re-gate incl. rebindable `citygenApplyFrontGate`),
  `unhideClearedRadius` option, `?nofrontgate=1` QA escape hatch, `__sfVoid`
  frontGate probe surface
- `feature-research/m12-void-beyond-front/audit.md` — this audit

Probe artifacts (scratchpad, not in repo): `m12-probe.mjs`, `m12-diag.mjs`,
`m12-*.png` (+ reused `m11-probe.mjs`).

NOT touched (per concurrency instructions): `src/app/renderCore.ts`,
`src/world/citygen/render/shellBatch.ts`, any shellBatch buffer-lifetime code.

## How gating works per system (file:line, post-edit)

Shared core — `src/render/frontGate.ts`: content asks
`shouldHide(x, z, r)` / `shouldHideRect(bounds)` at attach; hidden chunks
register with a `show()` callback. Admission radius =
`frontRadius + band + FRONT_GATE_LEAD(200)`. `update()` (called once per frame
from main's ringUpdate wrapper, both voidTick and the real loop) reveals
admitted chunks nearest-first under a budget: 6/frame while sweeping,
16/frame flush once inactive (settle / force-settle). `clearedRadius()` =
nearest still-hidden chunk; the ring coordinator
(`ringCoordinator.ts:~283`) clamps its target to `cleared − 150`
(`FRONT_GATE_CLAMP_MARGIN`; LEAD + band(48) > 150, so admission always
overtakes the clamp — no deadlock; a clamp below the current radius just
pauses the monotonic front). Reveals therefore always happen ≥ ~100 m past
the dissolve edge, where layer 2 renders the chunk near-black.

1. **Baked tiles** — `tiles.ts`: `#applyTileVisibility` (~2280) is the single
   owner-router (cancels any gate handle, then either hides
   bundle+road/building/park batch instances+shadow proxy, gate-registers, or
   shows). Called from `#drainReady` finalize (~1800), `#adoptDestinationWork`
   (~1135), `#scan` re-adopt (~1255). `#unloadTile` cancels (~2450); the async
   shadow-proxy attach mirrors `tile.group.visible` (~2085). Batch instances
   folded into a hidden tile start hidden via the pre-existing
   `!tile.group.visible → handle.setVisible(false)` checks.
2. **Landmarks** (always-resident GLB) — `tiles.ts` init loader (~677): one
   bounds circle per top-level subtree (`#landmarkGates`),
   `#applyLandmarkFrontGate` (~2350) hides/reg-registers each. Because the GLB
   can land in P1 BEFORE the gate arms at P5, main.ts calls
   `tiles.applyFrontGate()` right after arming (main.ts ~905) — without this
   the Bay/Golden Gate bridges + Alcatraz stayed visible across the void
   (caught on screenshots, fixed, re-verified).
3. **CityGen cells** — `ring.ts` `publishChunk` → `applyCellFrontGate`
   (~1760): a cell publishing beyond the front keeps its chunk mesh +
   shadowMesh hidden and registers (exact cell-rect distance — cells are
   800 m, bounding circles were uselessly loose). Publication, residency
   (`materializedRadiusAround`) and pipeline warm are UNTOUCHED, so the front
   never waits on citygen's serialized prepare. The baked meshes the publish
   suppresses are equally gate-hidden/black out there, so the swap stays
   invisible. Handles cancelled in `unloadCell`, `disposeCellChunk`, ring
   `dispose()`; `applyFrontGate()` exported for teleport re-gates.
4. **Authored regions** — `authoredRegions.ts` `#attach` →
   `#applyRegionFrontGate` (~505): region root hidden by bounds circle;
   terrain overlay/cutouts/watchers stay live (collision never depends on
   visibility). Cleanup in `#unload` and the attach-failure path.
5. **Street lamps** — verified, untouched: their own residency edges keep them
   inside the front in practice; no lamp glow observed in void screenshots.
6. **Bay/GG lights** — untouched (M5 CPU intensity ramps already follow the
   front); the bridge GLB gating (item 2) removes the silhouette+deck dots
   that were visible before.
7. **Water** — verified: M5 spatial opacity multiply already zeroes all sheets
   beyond the front (horizon checked in void screenshots).

Teleports: `onFarArrivalCut` (main.ts ~955) re-arms the gate and calls
`tiles.applyFrontGate()` + `authoredRegions.applyFrontGate()` +
`citygenApplyFrontGate()` at the cut (under the cover), so content revealed by
the previous sweep — or shown by the covered-arrival adopt while the front was
still origin-centred — re-hides against the collapsed destination front.

No-stuck-hidden guarantees: every unload/dispose/adopt path cancels its
handle; settle/force-settle (all M9 escapes) deactivate the gate and the
per-frame flush (16/frame) empties it; probes assert gate==0 + all in-range
tiles + all landmark subtrees visible after every settle.

## Layer 2 (shader)

`materialize.ts` `edgeGlowWindow(dist)` = 1 inside the dissolve edge, easing
to 0 over 3 bands (~144 m) beyond the front. `holoShade` gains an
`edgeWindow` opt (default OFF — terrain clipmap keeps its full-view contour
grid untouched, no terrainClipmap.ts edit needed); `applyMaterialize` passes
it for all world fabric AND multiplies its 4% dark-floor albedo by the same
window, so far beyond the edge fragments render exactly black (no noon
silhouettes from sunlit 4% albedo). Post-settle the front parks at the
revealed sentinel → window ≡ 1 → birth-ramp look byte-identical to M11.
Emissive/color attenuation only — no discard/alphaTest/transparency added.

## Unhide budget + measured re-record cost

6 chunks/frame while sweeping (16 at flush), nearest-first, tracer-counted.
Typical idle boot: 42–84 `frontUnhide` total, maxHidden 19–71 (spawn
dependent). Measured cost: most unhide frames never surface in the spike list;
the worst observed unhide-bearing frame was 50–56 ms carrying 6 unhides
(bundle re-record + batch visibility upload), classified still-hidden by the
motion gate (camera still) — imperceptible. The coordinator clamp was observed
holding the front during a deliberate stall (pre-fix run: front parked at the
clamp for 40 s, then force-settle flushed everything — the escape path works).

## Deviations from the plan / notes

1. **CityGen gate moved from publication-deferral to publish-then-hide.** The
   first implementation deferred cell prepare/publication beyond the front:
   (a) the index-nearest-cell defer stranded admitted neighbours (residency
   pinned at 70 m, age-cap force-settle at 90 s — caught by probe), and (b)
   even fixed, the front then waited on the SERIALIZED one-at-a-time cell
   prepare ring-by-ring (frontComplete 37 s vs 19 s). Final design publishes
   normally and gates only the chunk mesh's visibility — honest cull, no
   residency coupling, warm-ahead fully preserved (C2).
2. **Landmark gating needed a P5 re-apply** (see item 2 above) because the
   landmarks GLB loads before the gate arms.
3. **`?nofrontgate=1` QA escape hatch** added (the `?nofarcut` precedent) for
   same-build A/B timing; not in the plan.
4. Boats/water-echo vessels and Sutro FAA beacons were NOT gated (not in the
   plan's system list). After bridge/landmark gating the void screenshots show
   only a handful of sub-pixel light specks; acceptable leftover (below).
5. GG bridge admits early via its huge bounds circle when the front approaches
   within ~admit of its span; its holo material + edge window keep the far
   spans black until the front reaches them (documented in code).

## Test results (vite preview build, headless Chrome WebGPU/Metal, fresh boots, no device-metrics override)

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes on the final configuration.

Visual acceptance (`m12-probe.mjs`; screenshots in scratchpad):
- **(a) void/control moment** — `m12-v0-void.png` (drone 380 m over downtown,
  dusk) + `m12-a-void.png` / `m12-a-dt-void.png` (ground): terrain contour
  grid + sky + avatar only; NO skyline, NO bridges, NO Alcatraz, NO boats
  (pre-fix shot had a lit Bay-Bridge silhouette + Alcatraz + a vessel —
  eliminated). City massing exists only in the immediate band hugging the
  collapsed front. Contrast: M5's `m5-a-early-bloom.png` showed a full
  holo-grid skyline to the horizon.
- **(b) mid-sweep** — `m12-v1-mid.png`/`m12-v1b-mid.png` (0.5 s apart, same
  camera): shaded city out to the edge, cyan dissolve band, pure grid/void
  beyond; the 0.5 s pair shows only continuous band progression, no discrete
  pop-in (ground-level pair `m12-b-dt-mid.png`/`m12-b2-dt-mid.png` pixel-diff:
  0.07% of pixels > 30/255). No geometry appears in the void region between
  the pair.
- **(c) settled** — `m12-v2-settled.png` / `m12-c-dt-settled.png`: normal full
  city; post-settle audits (every scenario): gate inactive+empty, zero
  in-range hidden tiles, zero hidden landmark subtrees. Settled fps on a calm
  host: 119.6 (4 s rAF; M5 recorded 118.9/119.3); settled emaMs 8.26 (M5:
  8.28–8.32).
- **(d) noon variant** — `m12-v1n-mid.png` (+ pair): bright sky, no full-
  horizon silhouettes; a transient dark rim hugs the advancing dissolve edge
  (the admitted edge band at amount≈0 against a noon sky) and is crossed by
  the band within ~1–2 s. Pre-M12 the entire skyline stood dark at noon.
- Zero console errors in every final-config run (visual ×2, noon ×2, vista
  ×3, rapid ×2, idle ×5).

Sweep integrity: front monotonic in every run; settles by residency
(no force-settle) — frontComplete idle downtown 18.2–19.7 s across final-build
runs (M11 baseline 18.4–18.6 s; ≤ 35 s bound), 20.2 s noon. Tea-garden spawn
57 s once under heavy host contention (user's Chrome at ~80% CPU — control
3.1 s, fps 41 on the same run; not gate-related: gate was empty during the
stalls).

Smoothness (M11 idle-orient methodology, downtown, final build):
- Clean-host runs (control 1327/1338 ms, in-band): FULL worst 250–307 ms,
  17–18 > 33 ms, **motion-visible 3** (74.6/50.1/42.9 ms streaming/shadow-held
  residue; NONE carry `frontUnhide` counts); SETTLE window zero > 33 ms
  (second run: one 106 ms still-HIDDEN frame at fc+~2 s — the known
  post-settle shadow-domain redraw class, motion-gate-hidden); TAIL zero.
- Same-build/same-machine A/B with `?nofrontgate=1` (gate off): motion-visible
  **5**, worst 2850 ms — the residue is the pre-existing M10/M11 class plus
  host noise, not M12. Target "≤ 2" missed by 1 on the absolute count in
  clean runs, but the gate-off control on the identical build measures worse,
  i.e. M12's delta is ≤ 0. Contended-host runs (control ~2 s) read 5–18
  visible — documented as environment, matching the OFF arm.
- `compileGateForced` 0–1, `compileWindowStillHidden` 13–15 per run — M11
  behavior intact.

Escape / rapid teleports (`SF_SCENARIO=rapid`, final build, ×2): mid-sweep
A→B→C (Downtown → Palace → Coit, 2.5 s apart) settles normally; post-settle
audit: gate empty, zero in-range hidden tiles, zero hidden landmarks, zero
errors (`m12-f-rapid-settled.png`). Force-settle flush additionally exercised
by the pre-fix stalled run: 44 hidden → 0 within the flush budget at age-cap.

Preview: `http://localhost:5240/?autostart=1` → 200 serving the final `dist/`.
All probe vite servers + headless Chromes killed. Nothing committed.

## Open risks / leftovers

1. **Noon edge rim**: at high sun the admitted edge band (dissolve edge →
   +~450 m worst case incl. tile extents) reads as a transient dark rim
   against the bright sky while the band crosses it. Unavoidable without
   per-building granularity or transparency (banned); vastly better than the
   pre-M12 full skyline.
2. Tiny far light specks (water-echo vessels' sprites / FAA beacons / stray
   lamp sprites) remain visible in the void at night — sub-pixel, not in the
   plan's system list. Lever: multiply their intensity by
   `materializeField.amountAt` like the M5 bridge-light ramps.
3. GG bridge's bounding circle admits the whole span at once when the front
   nears; shader keeps far spans black, but a per-segment gate would be
   tighter.
4. The `?nofrontgate=1` flag ships in the build (QA-only, off by default).
5. Idle motion-visible=3 (target ≤ 2): all three frames are M10/M11-class
   streaming-attach/shadow-held residue with no unhide involvement; gate-off
   A/B reads 5 on the same build. Revisit only if the M10 leftover #1 codegen
   work lands.
