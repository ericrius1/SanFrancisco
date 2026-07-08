# "build system" geometry-node graph — decoded

Source: `procedural-hong-kong-building/source/procedural_building.blend`, node group
**build system** (592 nodes) on object `Cube.001`. This document is the reference for the
TypeScript port in `src/generator.ts`. Coordinates are Blender-style (Z-up, meters);
the Three.js scene rotates the root group -90° around X.

## Parameters (modifier inputs)

| name | type | default in file |
|---|---|---|
| floor | int | 6 |
| length | int | 7 |
| width | int | 3 |
| AC UNIT | 0-1 | 0.724 |
| Roof Probability | 0-1 | 0.512 |
| Clothline Probability | 0-1 | 0.709 |
| Lights | 0-1 | 0.546 |
| window type | 0-1 | 0.75 (P of steel vs wood) |
| window open amount | 0-1 | 0 |
| curtain close | 0-1 | 0 |
| closed/open store | 0-1 | 0.598 |
| roof on store | 0-1 | 0.594 |
| object on ground | 0-1 | 1.0 |
| store sign | 0-1 | 0.748 |
| object on roof | 0-1 | 0.835 |
| randomise | int | seed |
| deform | int | realize-instances toggle (irrelevant in JS) |
| low poly | int | swap detail for plain shell |

## Random-value semantics

Blender `Random Value` = pure function of (element id, seed). With ID unlinked it uses
the element **index within the current geometry** — and geometry gets **re-indexed after
every SeparateGeometry/Join**, so filters must be applied sequentially on arrays with
positional ids. Two nodes with the same seed correlate. Kinds used:
- bool(p): hash01(id, seed) < p
- int(min,max): uniform integer, inclusive
- float vec: componentwise lerp
- Pick Instance index wraps modulo collection child count. An **unlinked** Instance
  Index socket defaults to the implicit element index (NOT constant 0) — guardrails,
  storefronts, shutters, AC wires, clotheslines etc. cycle variants per point.

## Facade grids

Both grids: 1×1 cells, XZ-plane, centered on origin. MeshGrid takes verts = param+1,
size = param (validated against evaluated instances with tools/compare_truth.ts):
- **Grid B (front/back)**: (length+1) × (floor+1) vertices, x ∈ ±length/2, z ∈ ±floor/2.
- **Grid A (sides)**: (width+1) × (floor+1) vertices.

Split (identical for both, N = length|width):
- top row (z = floor/2) → guardrails (pick = column index); top-right → `roofcorner`
- right column (x = N/2) → `corner`; bottom-right → `ground_corner`
- bottom row (z = -floor/2) → ground-floor cells
- remainder → **window cells**, N columns × (floor-1) rows (front/back shifted y-0.5,
  sides y-0.1)

Mirrored corner variants (pre-transform Rz +90°, scale(-1,1,1)) are used on the side
facades; plain ones on front/back. 4 facades × right-column corners = 4 building corners.

## Window cell content (per cell, id = index in window-cell array)

Front/back (grid B) picks — sides (grid A) use the same structure with different ranges
(in brackets):
- `wall.001` pick int(0,100) [A: int(0,100)] — same value reused for `window guard.001`
- `ROOMS.001` pick int(0,80) [A: int(0,101)]
- awning `roof.002` if bool(RoofProbability), pick int(45,125) [A: int(0,113)]
- curtains ×2 `CURTAINS.001` pick int(0,101) [A: int(0,164)] at (0.079, 0.038, 0.5) and
  (0.919, 0.038, 0.5); x-scale = randFloat(1, 5·curtainClose) seeds 41 / -(seed 32)
- lights `lights.001` if bool(Lights), pick int(0,120) [A: int(0,89)]
- AC (front/back: only above 2nd row — "ac_remove first floor" z > -(floor+1)/2+2):
  if bool(AC UNIT): `ac.001` pick int(50,100) [A: int(50,200)] with pre-transform
  T(0.5, 0, 0.15) plus per-child x-jitter randFloat(-0.175, 0.175, childIdx, seed 0);
  plus `AC WIRE.001` child 0. Cells with AC: clotheslines `cloth lines.001`
  pick int(0,113) [A: int(0,96)] if bool(Clothline).
  Cells without AC (concat noAC + belowACcut): if bool(Clothline) then 50/50 bool →
  `cloth lines WITH CLOTHES.001` child 0 or `cloth lines.001` child 0.
- window: bool(window type, seed 0) → **steel** else **wood**.
  Steel: `steel frame.001`, `steel window top preset.001` pick int(0,100), 4 panes
  `steel window.001` at x=0.079/0.494/0.506/0.921, y=0.011, z=0.518; outer pair
  scale(-1,1,1) rot z rand(0, 2·open), inner pair rot z rand(0, -open).
  Wood: same layout with `wood frame.001`, `wood window top preset.001`,
  `wood window.001`.

All random seeds = `randomise` except window-type choice and store old-sign (seed 0) and
curtain scale (seeds 32/41).

## Ground floor

Front row cells (id = index in bottom row): always `groud_front` child 0 and `wire`
pick int(0,25). Per cell bool(closed/open store):
- open → `storefront` c0, `storeinside` c0, `lightsground` pick int(0,25),
  `prop_store` pick int(0,25); if bool(store sign): `store_sign` pick int(0,25) and
  `store_sign_hanging` pick int(0,25); if bool(roof on store): `store_roof` (object);
  if bool(object on ground): `prop_front` pick int(0,25)
- closed → `shutter` c0, `old store_sign` c0 if bool(store sign, **seed 0**),
  `prop_groud` c0 if bool(object on ground)

Back row: `ground_back` pick int(0,100), `wire` pick int(0,25), `eletricarea`
pick int(0,31). Side bottom rows: `groud side wall` pick int(0,100), plus `prop_groud`
pick int(0,54) where bool(object on ground).

## Guardrails / roof

- top rows: `guardrail front` c0 (front), `guardrail back` c0 (back), `guardrailside` c0
  (both sides); corners `roofcorner` (mirrored variant on sides).
- roof grid `length` × `width` faces at z = floor/2 + 0.1 (centers x=-length/2+0.5+i,
  y=0.6-width/2+0.5+j): `roof` collection (whole, 1 child) every face; `roof_prop`
  pick int(0,120) on faces passing bool(object on roof, seed 0).
- watertank branch exists but its MeshToPoints has **no mesh input** in the file — dead.

## Assembly

Window-cell content is generated ONCE per grid and reused: front and back facades are
identical; side B filters content instances to facade-local x > -(width+1)/2 + 1.45
(drops column 0 items whose local x-offset < 0.45) and adds a solid `side_wall` panel
c0 on column-0 cells (raw cell positions, no y-shift).

Facade transforms (then everything T(0, -0.6, floor/2 + 0.05)); mapping validated
against ground truth — stores face +Y:
- front (stores, guardrail front): T(0, +width/2 + 0.6, 0) · Rz(180°)
- back (ground_back, wires, electric): T(0, -width/2 + 0.6, 0)
- side A (+x): T(+length/2, 0.6, 0) · Rz(90°) — all windows
- side B (-x): T(-length/2, 0.6, 0) · Rz(270°) — filtered + solid column

Placement matrix order: `Final · Facade · Post · T(point)·Rz·S · Pre`.

`low poly` swaps everything for extruded-slab shell geometry (front/back slabs 0.5
thick, flat side grids, roof slab 0.4 with 0.5 overhangs front/back).

## Asset kit

`public/assets/kit.glb` (exported Z-up, `export_yup=False`): top-level nodes named
`COL[<collection>][<childIdx>]` (child transforms reset to identity, mirroring
CollectionInfo Reset Children) and `OBJ[<name>]` for Object Info nodes.
Collection-instance empties are realized recursively at export (ROOMS children embed a
`floor_preset` collection; `store_roof` is an empty instancing `groud_roof_preset`).
`public/assets/kit_manifest.json` records child order/counts for index wrapping.

Materials are NOT taken from the GLB — the exporter marks the building material
alpha-blended, which breaks depth sorting at grazing angles. `src/kit.ts` builds
building/floor/glass from `public/textures/` (opaque + emissive; floor uses alphaTest
cutout; glass is the only blended material).

**Normals**: the source objects carry Blender "Auto Smooth" custom split normals, which
bake into the GLB and shade inconsistently per face (mottled walls, mismatched corners).
This is geometry data — a material's `normalScale` (the normal *map*) cannot fix it.
`tools/export_kit.py` drops the custom normals and rebuilds clean **angle-based** normals
(sharp above ~35°, smooth below) via bmesh, so flat walls shade evenly while hard edges
stay crisp. Fix it at export, not with a runtime `computeVertexNormals()`.

## Validation

`tools/dump_truth.py` dumps every evaluated instance (name + world matrix) from the
.blend; `tools/compare_truth.ts` aggregates positions per collection and diffs against
the TS generator. Deterministic categories (walls, rooms, curtains, rails, corners,
roof tiles, ground rows) must be exact; probabilistic ones differ because the JS hash
is not bit-identical to Blender's.
