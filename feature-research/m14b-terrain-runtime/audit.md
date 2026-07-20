# M14b — Terrain-data streaming runtime: audit

## Files changed

- `src/world/heightmap.ts` — WorldMap streamed-boot core: `loadCore()`, tile residency bitset + queries, `installTile`, install fixups, revision-bump coalescing, `terrainResidentRadiusAround`.
- `src/world/coronaHeights/ground.ts` — carve refactored into bounded `applyLift`; registers a tile-install fixup for its cell rect.
- `src/world/terrainMaterialData.ts` — NEW export `computeSurfaceWeightsRegion`: sub-rect twin of the surface base build (park-path erosion onion + Gaussian feather).
- `src/world/terrainClipmap.ts` — fixed quantization range from `meta.terrain`; `TerrainHeightBounds.updateRegion`; `applyTileRegion` (CPU mip refresh + pooled-staging GPU sub-rect blits); `debugHeightEncoding` QA hook; staging disposal.
- `src/world/terrainTileWorker.ts` — NEW SFTT fetch+decode module worker (spawnWorker idioms: id map, cancel, retries, timeout, 404-tolerant).
- `src/world/terrainTiles.ts` — NEW `TerrainTileStreamer`: manifest-gated nearest-first scheduling around focus + player, in-flight cap 4, anchor 3×3 absolute priority with per-focus cancel, ≤1 queued install per frame (anchor-ring tiles install on decode), revision-bump commit/discard, fail-open on missing tiles.
- `src/core/physics.ts` — `#groundReadyAt` additionally requires `map.isTileRealAt(x, z)` (spawn hold + far-arrival ground wait never release onto overview ground).
- `src/app/boot/bootMap.ts` — `loadCore()` default; legacy `WorldMap.load()` under `?fullmap=1`.
- `src/main.ts` — streamer construction (after bootTiles; null on ?fullmap), anchor wiring in `primeInitialVisualAt` + `onFarArrivalCut`, terrain residency min'd into the ring coordinator's `citygenRadius` callback, per-frame drive in the `ringUpdate` wrapper, `bootMark("spawnTile")`, `__sfVoid.terrainTiles` + `__sf.rings.terrain` probe surfaces.
- `index.html` — `__sfStartPrefetch`: default list = meta + manifest + terrain-manifest + overview + overview-surface; legacy trio kept under `?fullmap=1`.
- `feature-research/m14b-terrain-runtime/audit.md` — this file.

NOT touched (concurrency instructions): `src/app/renderCore.ts`, `src/world/citygen/render/shellBatch.ts` and shellBatch buffer-lifetime code, attributeDisposePatch. The working tree also carries earlier UNCOMMITTED M12/M13 edits (materialize.ts, tiles.ts, ringCoordinator.ts, authoredRegions.ts, citygen/stream/ring.ts, frontGate.ts, config.ts, ui/debug.ts) from prior sessions on this branch — present in `git diff` but not part of M14b.

## What changed per file (essentials)

### heightmap.ts
- `loadCore()`: fetch meta + `terrain/overview.bin` + `terrain/overview-surface.bin` (~160 KB wire total), allocate FULL lattices, bilinear-upsample int16 overview into `heights` (box-average centers at gx = 8ox+3.5), nearest-class `surface`, `groundTops` = separate copy of heights (no deltas in overview). Falls back to the legacy full load if the overview bake is missing or terrain meta absent.
- `installTile(ix, iz, data)`: row-writes heights/surface, groundTops = height rows then `height + deltaMm/1000` for delta cells; marks residency; runs intersecting fixups (Corona); invalidates the residency memo; sets a pending revision bump. `commitRevisionBump()` / `discardRevisionBump()` let the streamer coalesce (≤1 bump/frame) and skip physics-irrelevant far installs (constant patch/carpet rebuilds during streaming would otherwise run every frame).
- `terrainResidentRadiusAround(x, z)`: min distance to any non-real tile rect, capped 4400 (above ring SETTLE_CAP+overshoot), memoized 250 ms/1 m (tiles.residentRadiusAround idiom).
- `markTileUnavailable`: terminal-404 fail-open — overview data becomes final for that tile so groundReady/front can never hang on absent data (stale-deploy safety).
- CRITICAL overlay rule respected: tiles patch BASE arrays only; `setGroundTopOverlay` overlays compose at query time and are untouched.

### terrainClipmap.ts
- Quantization now FIXED from meta.terrain: `min = heightBase (−60)`, `range = 32767 × heightQuant (≈655.34 m)` — encode step 0.01 m; tile installs re-encode identically with no global rescan. Shader decode reads the same constants (they are baked as shader constants from the same fields). Legacy float32 maps keep the whole-map scan.
- `applyTileRegion(renderer, gx0, gz0, cellsX, cellsZ)`: recomputes, per pyramid, mip0 + 3 coarser mips FROM THE CPU LATTICE (source of truth), updating the retained CPU mip arrays in place and blitting each dirty sub-rect through a pooled 128×128 staging DataTexture via `renderer.copyTextureToTexture(src, dst, srcRegion, dstPosition, 0, dstLevel)` (WebGPU GPU→GPU sub-rect copy; textures carry COPY_SRC/COPY_DST by default in r185).
  - height mips ≥1: 2×2 box-average of the previous packed mip (decode u16 → avg → round), rect halved + expanded 1 per level.
  - normals: rect = height rect +1 (central differences), same [1 2 1] separable derivative; mips ≥1 decode the quantized height mip (±half a 0.01 m step vs the boot float chain — invisible in 8-bit normal channels; no seam observed).
  - surface: rect = tile +4 cells (3 erosion passes + 1 feather), exact sub-rect erosion onion in `computeSurfaceWeightsRegion` (global-border semantics preserved; buffer-edge==global-edge sides skip the onion inset).
  - `TerrainHeightBounds.updateRegion` recomputes only the 8-cell blocks intersecting the tile rect.
- `#heightAt` / CR sampling / m13 edgeWindow holo shading: UNTOUCHED (verified in diff) — CPU/GPU lockstep and the concentric grid look are preserved.

### terrainTiles.ts / terrainTileWorker.ts
- Worker decodes SFTT off-main (heights int16→Float32 meters), transfers typed arrays; cancel/timeout/retry per spawnWorker; 404/text-html → "missing".
- Streamer wanted-set: dist-to-tile-rect ≤ 3980 around the sweep focus (anchor) OR ≤ CONFIG.tileLoadRadius+400 around the live player; sorted nearest-first (min of the two distances); anchor 3×3 gets −1e6 (anchor tile −2e6). Order refreshed every 30 update calls or on re-anchor. `setAnchor` cancels in-flight fetches outside the new anchor ring (per-focus generation abort).
- Installs: anchor-ring tiles install the moment they decode (≤9, spawn/teleport-critical — during boot the provisional loop may not tick yet, and control gates on the anchor tile being real); all others drain strictly one per `update()` call. `tracer.count("terrainTileInstall")` per install.

### physics.ts / worldArrival
- `#groundReadyAt` prepends `isTileRealAt` — covers the boot spawn hold (bootArrivalTick → control) AND far-teleport `#waitForDestinationGround` with zero worldArrival changes.

## GPU partial-update mechanism + measured cost

Pooled staging DataTextures (one RG8 + one RGBA8, 128×128, reused every install; staging re-upload is 32/64 KB) + `renderer.copyTextureToTexture` sub-rect blits: 12 blits per tile (3 pyramids × 4 mips), ~120 KB total GPU upload per tile vs the forbidden ~8.7 MB full pyramid re-upload. Measured main-thread cost per tile install (encode + mips + normals + erosion/feather + bounds, M-series, production build): **3–7 ms typical (7.3 ms worst seen)** — bounded at one tile per frame. No frame errors, no pipeline rebuilds (texture objects never change identity).

## Probe results (scratchpad m14-probe.mjs; fresh boots, vite preview, ?fullfps, no metrics-override)

### Waterfall (default path) — PASS
- /data fetch set before control: meta.json 1.2 KB, manifest.json 2 KB, terrain-manifest.json 1.9 KB, overview.bin 102.7 KB, overview-surface.bin 51.5 KB (+ landmark-colliders/authored-regions as before). **No heightmap.bin / surface.bin / groundtop-delta.bin.** Terrain bytes before control: **156,136 B** (< 500 KB budget).
- `?fullmap=1` spot-check — PASS: legacy trio fetched (6.55 MB + 3.28 MB + 1.65 MB), zero /data/terrain fetches, boots identically (control fires, no errors, terrain telemetry null).

### Timing (warm runs; warmup variance dominates this harness)
- map mark: ~40–60 ms after start on the streamed path (meta + overview decode + upsample; legacy full decode was similar on-mark because the head prefetch races, but 11.5 MB stays off the wire).
- bootMarks best warm streamed run: start 179 → map 221 → tiles 680 → physics 739 → world 785 → **spawnTile 1410** → warmup 1424 → **control 1499 ms** (wall +1677). Back-to-back fullmap warm run: control 4478 ms (wall +4769) — run-to-run Dawn-cache variance far exceeds any path difference; across runs both paths land 1.5–4.5 s with the streamed path never worse than fullmap in matched pairs.
- Far teleport 8.9 km (worldArrival far path): **cover-drop visual 109 ms, interactive 289 ms** vs M7 baseline 98/382 ms — comparable (dest tile ~30 KB rides the anchor priority lane). **Dest tile REAL at reveal; player Y spread over next 5 s: 1.3 cm** (no approximate ground under an arriving player).

### Idle boot — PASS
99 tiles installed (focus radius set), in-flight ≤4 throughout, front swept monotonically below terrain residency and settled (front FULL at ~23.5 s incl. the deliberate bloom profile), tracer terrainTileInstall=99, settled fps 80, zero console errors.

### Lockstep spot-check — PASS
In-page comparison of `map.groundHeight` (CPU float lattice) vs CR interpolation over the clipmap's ENCODED mip0 bytes (the exact texel data the GPU samples; kernel + anti-ringing clamp mirrored): 26 points (20 near inside the front, 6 at 5.6 km including 5 overview-only points on the mixed lattice) — **worst |Δ| = 0.0033 m** (quantization epsilon 0.01 m).

### Fast-drive (Marin, overview territory) — PASS
Direct hop to (−4200, −5200) mid-session (no re-anchor) in drive mode + 30 s scripted W+boost: zero console errors, **0 vertical snaps** (dy>6 m with <5 m horizontal), max slope-consistent ΔY 5.5 m/250 ms on the steep headlands, player-priority fetches promoted the area within ~1 s of arrival; **one promotion under the player recorded: ΔY = −0.38 m** (overview slightly above real ground → brief re-seat; lift-only carpet recovery + gravity absorbed it invisibly). Rises would re-place the carpet upward via the committed revision bump (lift-only recovery tolerates them); drops mean brief airborne — both signs verified benign at this magnitude. The player-escape force-settle path also fired here (sweep terminated correctly).

### Regression sweep — PASS
- Rapid A→B→C mid-sweep teleports (m12-probe rapid): final settle, post-settle visibility audit clean (gate empty, nothing stuck hidden), zero errors.
- `?voidholo=1`: holds (state "holding", front 0) while terrain tiles keep streaming (28 installed at check); manual `__sf.materialize.sweep(1200)` drives; zero errors.
- Holo-off default + toggle: `birthHolo {enabled:true(gate sweep), debugToggle:false}` unchanged semantics (M13 gate untouched).
- Minimap renders (terrain wash from installed data), water visually sane (bay in m14-drive-end.png), Corona: after its tile installs, `groundTop − groundHeight = 0.700 m` at the summit platform (0.38 carve + 0.32 platform — exact pre-M14 value; fixup re-application verified), dest tile real, zero errors.

Screenshots (scratchpad): m14-idle-settled.png, m14-teleport-dest.png, m14-drive-end.png, m14-corona.png, m14-voidholo.png, m14-voidholo-swept.png.

## Build/typecheck
- `tsc --noEmit` clean; full `npm run build` (ambient-bird + foliage-shadow + terrain-tiles contract tests + tsc + vite build + precompress) passed end-to-end. One further one-line change (anchor-ring install-on-decode) landed after that full run and was re-verified with `tsc --noEmit` + `vite build` (contract tests exercise baked data only, unchanged).
- 5240 preview restarted from this worktree's final dist (HTTP 200, 🌲 [wt: streaming-world] title). Probe vite servers + headless Chromes killed. Nothing committed.

## Deviations from plan
- `installTile` does not bump groundRevision itself; the STREAMER owns commit/discard per install (near player/anchor → commit, far → discard). Rationale: an unconditional bump rebuilds the physics terrain patch + carpet on every install frame for the whole streaming session; distant installs are re-sampled anyway on the next anchor crossing. Same coalescing guarantee (≤1 bump/frame), stronger hitch bound.
- Terrain residency joins the ring coordinator through the existing `citygenRadius` callback (min in main.ts) instead of a new coordinator option — zero ringCoordinator.ts changes (file is shared with prior uncommitted milestones).
- Anchor-ring tiles install on decode rather than strictly 1/frame (bounded at 9, under cover/boot; measured 3–7 ms each) — needed so boot control does not wait for the provisional loop to start ticking.
- Fail-open on terminally missing tiles (markTileUnavailable) — not in the plan text, added so a stale deploy cannot hang spawn/teleport ground waits forever; mirrors tiles.ts's "terminally failed tiles are non-blocking" philosophy.
- Fast-drive probe uses a direct hop to Marin + scripted 30 s drive (spawn surroundings are fetched too quickly to ever outrun tiles from a cold boot at car speeds — the promotion path is exercised at the hop point).

## Open risks / leftovers
- FarOcclusionField and the water floor texture snapshot the lattice when they build (P3): far shadow atlas / far bay floor may bake coarse overview heights for not-yet-streamed regions and are not re-baked on tile install. Far-field soft-shadow/deep-water impact only; no artifact observed in probes. A follow-up could re-request the occlusion build after the boot wanted-set finishes installing.
- Normal mips ≥1 re-encode from quantized heights (±0.005 m before the [1 2 1] derivative) — mathematically different from the boot float chain by <1/255 per channel; no visible seam, documented in code.
- Tiles never unload (11.5 MB CPU ceiling if a player visits everything — same order as the pre-M14 permanent load; GPU textures are fixed-size regardless).
- Boot-time control remains warmup/Dawn-cache dominated in the probe harness; the streamed path's own contribution (spawnTile) lands during warmup.
