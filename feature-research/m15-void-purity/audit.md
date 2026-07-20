# M15 — Void purity (nothing visible beyond the front) — audit

## Files changed

- `src/world/streetLamps.ts` — front-gate lamp discs/bulbs (TSL) + holo posts
- `src/world/traffic/trafficLights.ts` — front-gate signal lenses (TSL)
- `src/world/roadMarkings.ts` — front-gate paint decals (TSL)
- `src/world/sutroTower.ts` — export `SUTRO_TOWER_ANCHOR` for the CPU ramp
- `src/world/citygen/render/moduleLayer.ts` — holo wrap on trim + glass window buckets
- `src/gameplay/islands.ts` — node materials + holo wrap on islands/balloons/strings
- `src/render/frontGate.ts` — static-prop gate registry; band-scaled admission lead + clamp margin
- `src/app/ringCoordinator.ts` — band scales with front radius; clamp uses `frontGateClampMargin()`
- `src/main.ts` — Sutro beacon front ramp; surf-shack static gate; `applyStatic()` on far-arrival cut; `__sfVoid.scene`/`__sfVoid.sky` probe surface
- `src/fx/worldCursor.ts` — name the cursor orb (`world_cursor_orb`) so probes can exclude it

No other files were modified by this task (the other modified files in `git status` belong to the prior M12–M14 work on this branch).

## Per-leak root-cause map

| Leak (mission item) | Root cause | Gate applied |
|---|---|---|
| Orange glow dots across the horizon | `src/world/streetLamps.ts` — disc pool `colorNode` (old line ~387) and bulb `colorNode` (~411) rode only residency/edge/born fades, never the front; posts were a plain `MeshStandardMaterial` | Disc + bulb colour now multiply a `vertexStage(materializeAmount())` front term; posts converted to `MeshStandardNodeMaterial` + `applyHoloBirth` (streetLamps.ts:322-333, 386-400, 419-427) |
| Lit windows beyond the front | `src/world/citygen/render/moduleLayer.ts` — the city-wide instanced window buckets (`makeTrimMaterial` ~131, `makeGlassMaterial` ~145, glass night emissive ~165) are shared meshes NOT under any front-gated cell group and had no materialize wrap | `applyHoloBirth(m, { extraAmount: nodes.fade })` on both materials (moduleLayer.ts:143-152, 180-185) — the shellBatch pattern; kills the glow + normal shading beyond the front |
| Dark building silhouettes at the void moment | `src/render/frontGate.ts:34` — flat `FRONT_GATE_LEAD = 200` admitted (unhid) tiles whose edge was within ~220 m of a 10 m front, so black tile bodies stood against the sky at spawn | Lead and clamp margin now scale with the band: admit at `front + 5·band` (50 m at spawn, ≈288 m at full band — the M12 geometry), clamp at `3·band + 6` (frontGate.ts:29-50, ringCoordinator.ts:283-296). Deadlock invariant `lead + band > margin` holds for any band ≥ 3 |
| Traffic-light reds/greens beyond front | `src/world/traffic/trafficLights.ts:340` — unlit `MeshBasicNodeMaterial` lens colour was always full-bright | lens `colorNode` × `materializeAmount()` (trafficLights.ts:336-342). The steel frame deliberately keeps its plain material (`hasNode=false` bundle-skip optimization, per the in-file comment) — it is a dark sub-260 m pole set, zero-luminance |
| Road-marking paint city-wide | `src/world/roadMarkings.ts:34` — unlit `MeshBasicNodeMaterial`, always full-bright | `colorNode = materialColor × materializeAmount()` (roadMarkings.ts:56-61) |
| Sutro beacons (FAA reds, visible city-wide) | `src/world/sutroTower.ts:152` — `SUTRO_LIGHTS_INTENSITY` is sky-driven only, never front-coupled | CPU ramp in main's `applyLightFrontRamps` (main.ts ~779-787): `× materializeField.amountAt(SUTRO_TOWER_ANCHOR)` — the Bay/Golden-Gate lights pattern. Bay/GG ramps verified already present (main.ts:771-778) |
| Floating islands + balloons + strings | `src/gameplay/islands.ts:99,149,166` — plain `MeshStandardMaterial`/`LineBasicMaterial`, visible city-wide by design | Bodies + balloons → `MeshStandardNodeMaterial` + `applyHoloBirth`; strings → `LineBasicNodeMaterial` with `colorNode × materializeAmount()` |
| Ocean-beach surf shack (boot-resident one-off prop) | `src/main.ts` `ensureSurfShack` — added directly to the scene, no streamer owns it, so nothing hid it beyond the front | New `frontGate.registerStatic(obj, x, z, r)` registry (frontGate.ts:163-203); registered at creation, re-applied via `frontGate.applyStatic()` in `onFarArrivalCut` |
| Palace lagoon / water sheets / Bay+GG lights / batched tiles / landmarks / chunkLod prisms | Audited — already gated (water + lagoon opacity × `materializeAmount()`; bridges CPU-ramped; tile batches mirror per-tile gate visibility; landmark subtrees + shadow proxies gated; citygen cells + prisms gated via `applyCellFrontGate`) | none needed |

Diagnosis method: dev-mode scene census at the void moment (`__sfVoid.scene` walk, scratchpad `m15-diag*.mjs`) listing every effectively-visible drawable beyond the front, cross-checked with per-layer visibility toggles and burst screenshots. Two probe traps found and documented in the probe: (a) re-navigating one headless page can serve a **stale compositor frame** to `Page.captureScreenshot` (the "ribbon" false positives — fresh Chrome per phase fixes it), and (b) the `#loading` cover art (a full-screen holo-grid graphic) is still mid-fade at control+0.5 s in some boots — the probe waits for its computed opacity to reach 0.

## Band scaling (mission item 4)

`ringCoordinator.ts`: `band = clamp(radius × 0.4, 10, 48)`, written as a pure uniform every sweep frame (and at focus/construction). At spawn the front+3·band glow disc is ~40 m instead of ~150 m; the band relaxes to the default 48 by radius 120. The admission lead and clamp margin ride the same band (above), so the visibility flips stay past the glow window at every scale. Settled sentinel unaffected (every materialize mix saturates at radius 1e9).

## Pixel assertions — before / after

Probe: scratchpad `m15-probe2.mjs` + `m15-assert.mjs` (pngjs). Regions are fractions of the frame; UI rectangles cropped. "Sky band" = y ≤ 0.27h — from the on-summit ground camera, beyond-front content can only appear above the lit disc's crest arc. "Chromatic" = channel spread > 20 (teal holo / warm glow / sunlit albedo); "warm" = r > b+25 ∧ luma > 40 (lamp pools, lit windows, beacons); neutral brights (the moon) are legitimate sky and only reported.

| Check | Before (pre-fix build) | After | Threshold |
|---|---|---|---|
| Void sky-band chromatic max | **229.5** (`m15-before-a-void.png`) | **0.0** | ≤ 10 |
| Void sky-band mean | **10.44** | **1.93** (night) / 20.90 (noon void-sky gradient, ≤ 32) | ≤ 4 night |
| Void sky-band warm pixels | 0 (night ribbons were teal); archived original leak crop: **422 in-band / 1815 full-frame** warm px (`m15-a-crop-horizon.png`) | **0** (night and noon) | = 0 |
| Mid-sweep corner warm pixels | n/a before (baseline shot was daytime) | **0** | = 0 |
| Mid-sweep corner chromatic max | — | **83.9** vs sky ref 67.6 (moon-halo blue sky) | ≤ skyRef + 40 |
| Settled outside-disc mean (world present) | 43.4 | **47.5** | ≥ 8 |

The noon void moment keeps a smooth neutral-gray void-sky gradient (mean ~21, peak ~30) with zero chromatic and zero warm pixels — the documented "no content vs the smooth sky gradient" method (plus row-median outlier stats logged for the record; they include the disc's own crest so they are not asserted).

## Probe results (final run, scratchpad `m15-probe2-run6.log`)

- ALL CHECKS PASSED (23/23).
- Cold boot control +1374 ms; warm boot control +1585 ms (≤ 3500 ms band).
- front/band telemetry: void `front 21 / band 10`, ring `front 503 / band 48`, settle → `FULL`; `frontComplete` mark fired.
- Regressions: holo debug toggle default-off; far teleport (Sutro Baths) arrival completes + rings re-settle; escape-settle while sprinting away settles in ~11 s; zero console errors in all four sessions.
- Shots: `m15-fixed-a-void.png`, `m15-fixed-b-ring.png`, `m15-fixed-c-settled.png`, `m15-fixed-noon-void.png`, `m15-fixed-noon-ring.png`, `m15-fixed-teleport.png`, `m15-fixed-escape.png` (scratchpad).
- Typecheck clean; full `npm run build` clean; preview on http://localhost:5240/?autostart=1 (HTTP 200, 🌲 worktree title).

## Deviations from the mission text

- Assertion geometry: the mission suggested a center-disc exclusion; from the ground-level chase camera the lit disc fills everything below its crest arc, so the enforced region is the sky band above it (plus the two mid-sweep corner windows). Documented above; the pre-fix baseline fails these assertions and the fixed build passes.
- The moon (and the blue night sky around it) is treated as sky, not content — neutral-channel exemption + a corner margin of skyRef+40 (observed halo ≈ +16; observed leak classes measure 100-220 or trip the warm rule).
- Traffic-light steel frames keep their plain material (a deliberate `hasNode=false` bundle optimization); only their emissive lenses are gated. They are ≤ 260 m resident, zero-luminance dark steel.
- `?nofrontgate=1` A/B was not used as the "before" control because the M12 shading wraps (already on this branch) hide most emissive leaks even with the gate off; the pre-fix build shots are the honest baseline.

## Open risks

- During a mid-sweep at DAY, tiles inside the admission ring (front → front+5·band) render as near-black bodies that can silhouette against a bright sky (they are zero-luminance, so the night/void acceptance passes; the noon acceptance applies to the void moment per the mission). Making beyond-front fabric truly invisible against a lit sky would need discard (banned for opaque city fabric — early-Z) or sky-matched fog on the holo floor; left as the known day-sweep look.
- Buildings on an already-admitted tile (e.g. the spawn tile itself, half-diagonal ~360 m) can be visible-black at the void moment if they poke above the local horizon — tile-granularity gating; not observed to breach the pixel bands at Corona Heights.
- The corner chromatic margin (skyRef+40) is calibrated for the 23 h moon-halo sky; a much brighter moon position could need the sky-reference strip widened.
