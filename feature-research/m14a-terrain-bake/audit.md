# M14a — Terrain tile bake: audit

## Files changed

- `tools/bake-terrain-tiles.mjs` — NEW. Bake script.
- `tools/terrain-tiles-contract-test.mjs` — NEW. Contract test.
- `package.json` — added `bake:terrain-tiles` script; inserted the contract test into the `build` chain (after foliage-shadow test, before tsc).
- `public/data/terrain/` — NEW directory, 345 generated files (342 `tile_IX_IZ.bin` + `overview.bin` + `overview-surface.bin` + `terrain-manifest.json`). Generated output, not committed (per task: nothing committed).
- `feature-research/m14a-terrain-bake/audit.md` — this file.

No files in src/, index.html, or dist/ were edited (dist/ was rebuilt by `npm run build`, which is generated output).

## What changed per file

### tools/bake-terrain-tiles.mjs
Reads `public/data/{meta.json,heightmap.bin,surface.bin,groundtop-delta.bin}` (never the raw DEM), writes `public/data/terrain/`. Deterministic and idempotent (verified: second run byte-identical via `diff -r`).

### package.json
- `"bake:terrain-tiles": "node tools/bake-terrain-tiles.mjs"`
- `build` now runs `node tools/terrain-tiles-contract-test.mjs` in the existing pre-tsc contract-test chain (same idiom as ambient-bird / foliage-shadow tests: plain node script, assert/strict, exits nonzero on failure).

### tools/terrain-tiles-contract-test.mjs
Runs against the actual baked output. Asserts (a) every tile's heights (int16-exact) and surface bytes (Buffer.compare) match the original sub-rects; (b) deltas reconstructed across all tiles == original SFGD (count, per-cell value, no duplicates, ascending local order); (c) overview dims (236×217, scale 8), byte lengths, each texel == 8×8 box-average within ±1 int16 step, each surface texel is a true majority class ≤4, decoded height range plausible; (d) manifest keys == exactly the intersecting 19×18 grid positions == files on disk, with true byte sizes. Runtime ~0.6 s.

## Binary layouts (exact — runtime decoder can be written from this alone)

All multi-byte values little-endian. Grid constants from `public/data/meta.json`: cellSize 8, width 1888, height 1736, minX -7168, minZ -8896, tile 800 m = 100 cells, tilesX 19, tilesZ 18. Height decode: `meters = meta.terrain.heightBase + int16 * meta.terrain.heightQuant` (currently -60 + v·0.02) — identical to heightmap.bin.

### terrain/overview.bin
`int16[236*217]` row-major (236 = 1888/8 wide, 217 = 1736/8 tall), overview cell (ox,oz) covers full-res cells gx∈[8ox,8ox+8), gz∈[8oz,8oz+8). Value = `round(mean of the 64 int16 source values)` (box average in int16 space; equivalent to averaging meters since encoding is affine). Same heightBase/heightQuant decode. 102,424 bytes.

### terrain/overview-surface.bin
`uint8[236*217]`, same layout. Value = MAJORITY VOTE of the 64 source surface classes (0 urban / 1 park / 2 sand / 3 water / 4 road); ties broken by lowest class id (deterministic). Majority chosen over centroid-sample for water-class stability (doc'd in bake header). 51,212 bytes.

### terrain/tile_IX_IZ.bin
Tile (ix,iz) covers full-res cells gx∈[100ix, 100ix+cellsX), gz∈[100iz, 100iz+cellsZ), where `cellsX = min(100, 1888-100ix)`, `cellsZ = min(100, 1736-100iz)` — i.e. only the rightmost column (ix=18 → cellsX=88) and bottom row (iz=17 → cellsZ=36) are clipped.

| offset | type | value |
|---|---|---|
| 0 | char[4] | magic `"SFTT"` |
| 4 | u16 | version = 1 |
| 6 | u16 | ix |
| 8 | u16 | iz |
| 10 | u16 | cellsX |
| 12 | u16 | cellsZ |
| 14 | int16[cellsX*cellsZ] | heights, row-major within tile: index = lz*cellsX + lx; same encoding as heightmap.bin |
| 14 + 2n | u8[cellsX*cellsZ] | surface classes, same layout |
| 14 + 3n | u32 | deltaCount |
| +4 | deltaCount × { u32 localCellIndex, u16 deltaMm } | groundtop deltas, ascending localCellIndex; `localCellIndex = lz*cellsX + lx`; `groundTop = height + deltaMm/1000` (matches SFGD semantics) |

(n = cellsX*cellsZ.) Global↔local: `gx = 100*ix + lx`, `gz = 100*iz + lz`, global cell = `gz*1888 + gx`.

### terrain/terrain-manifest.json
```json
{ "tile": 800, "tilesX": 19, "tilesZ": 18,
  "overview": { "scale": 8, "width": 236, "height": 217 },
  "tiles": { "IX_IZ": { "bytes": <int> }, ... } }
```
Existence oracle: exactly the 342 emitted tiles (see tiling note below). `bytes` is the exact uncompressed file size.

## Tiling / edge handling

- All 19×18 = 342 grid positions are baked — every position intersects the 1888×1736 grid (the manifest.json city-tile set has only 205 keys; ocean tiles have terrain data too, so we bake the full lattice as the task's "safer" option instructed). The `x0 >= width` skip branch in the bake is therefore currently dead but kept for robustness.
- Runtime consequence: `terrain-manifest.json` (not the city `manifest.json`) is the terrain existence oracle; every tile in the 19×18 lattice exists.

## Bake output stats

- 345 files, 11,485,638 tile bytes + 153,636 overview bytes + 8.4 KB manifest ≈ 11.65 MB total.
- Largest tile 53,184 B (delta-heavy park tile); smallest 9,522 B (open-water 88-wide edge tile: 88×100×3 + 14 + 4, zero deltas). Typical full tile ≈ 30,014 B (100×100, no deltas).
- 274,463 SFGD deltas distributed; contract test reconstructs all of them exactly.
- Overview height range: -60.00 .. 337.78 m — sane vs meta encoding envelope (int16 covers -60..+595 at quant 0.02; city max ≈ Mt. Davidson/Sutro area heights, and full-res max necessarily ≥ box-averaged max).

## Precompression note (deliverable 4)

`tools/precompress-dist.mjs` walks ALL of dist/ recursively and `.bin` is in its COMPRESSIBLE set, so `dist/data/terrain/` is picked up with zero changes: every terrain file ≥1 KB gets `.br` + `.gz` siblings. Verified in the build: dist/data/terrain has 1035 files; 11.65 MB source → 4.03 MB brotli / 5.18 MB gzip. So terrain .bin files ARE served precompressed by the production server (brotli q11), not raw. Overview wire cost is well under the ~350 KB boot budget.

## Test results / timing

- `npm run bake:terrain-tiles` — clean, ~1 s, idempotent (re-run diff-identical).
- `node tools/terrain-tiles-contract-test.mjs` — passes in 0.64 s.
- Full `npm run build` — passes end-to-end, 5 min 57 s wall on this machine. Added cost vs baseline: ~0.6 s contract test + ~15 s precompress (measured brotli-q11 on the 342 tiles alone: 13.0 s, plus gzip). The precompress overhead is inherent to shipping 11.6 MB of new static data, not the test; flagging it since the acceptance bar mentioned only "the new test's few seconds".

## Deviations from plan

- None functional. One interpretation call: baked all 342 lattice positions (task's stated safer option) rather than manifest.json's 205 keys.
- The ~15 s precompress increase (above) is the only timing deviation.

## Open risks

- Tile format has no checksum; corruption detection relies on magic/version/length checks only (consistent with existing artifacts).
- If the base artifacts are ever re-baked (heights/surface/deltas change), `bake:terrain-tiles` must be re-run — the contract test in `npm run build` will catch a stale terrain/ directory (byte mismatch), which is the intended guard.
- Overview surface majority vote can flip a mixed shoreline block between water/sand relative to centroid sampling; acceptable per design (coarse pre-stream data only, overwritten by real tiles).
