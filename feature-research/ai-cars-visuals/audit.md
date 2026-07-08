# Audit — AI Cars visual layer (Agent B)

## Files changed
- `src/gameplay/aiCars/carMesh.ts` (created)
- `src/gameplay/aiCars/brainOverlay.ts` (created)

(Preview harness lives in scratchpad, outside the repo — not part of the repo diff.)

## What changed per file

### src/gameplay/aiCars/carMesh.ts
- Exports `BODY_KINDS = 6` and `buildCarMesh(bodyKind, paintHue): THREE.Group`.
- Follows the traffic.ts recipe: `BoxSpec` + `buildGeo` (merged `BoxGeometry` with
  baked per-vertex colors), three shared module-level materials —
  `bodyMat` (`MeshStandardMaterial{vertexColors}`), `glowMat`
  (`MeshBasicMaterial{vertexColors}`, color scaled by `LIGHT_SCALE` for unlit
  head/tail lights), and `tyreMat`. No `THREE.Light` objects anywhere.
- Six distinct silhouettes: sedan, coupe (low + rear spoiler), hatchback
  (tall rounded cabin), pickup (cab + bed + tailgate), van (tall box), muscle
  (long low, hood scoop, lowrider rocker).
- Convention: group origin at wheel-contact center, **+Z forward** (matches the
  LOCKED fleet heading convention — note traffic.ts uses -Z, this module does not).
- Four separate un-merged wheel meshes named `wheel_fl/wheel_fr/wheel_rl/wheel_rr`,
  built from a cached `CylinderGeometry` rotated so its axis is local X (spin via
  `mesh.rotation.x`). Wheels share one geometry + `tyreMat`.
- Paint from `paintHue` via HSL with per-kind saturation/lightness bands; buckets
  0/6/11 of 12 are achromatic (white/black/silver) so the fleet isn't a pure rainbow.
- Geometry cached per `(kind, hueBucket)` (12 buckets) in `geoCache`; wheel geometry
  cached per `(radius, width)`.

### src/gameplay/aiCars/brainOverlay.ts
- `class BrainOverlay` per LOCKED interface, plus the allowed 4th constructor
  param `getCamera: () => THREE.Camera` (documented in plan as an allowed extension).
- Adapted from horse `#buildBrain`/`#updateBrain` (git f938c00): one
  `THREE.LineSegments` lattice + one `InstancedMesh` of node spheres per car.
  `LineBasicNodeMaterial{vertexColors, transparent, AdditiveBlending, depthWrite:false}`,
  static geometry, per-update writes ONLY the color BufferAttribute / instanceColor
  (both `DynamicDrawUsage`).
- Layers from constructor `sizes` ([9,12,2]). Layer-0 node activations come from
  `obs`; later layers from `layerOut`. Node brightness = |activation|; edge
  brightness ∝ src·dst (signed). Cyan negative / warm orange positive.
- Output nodes drawn ~2.1× larger (`OUT_NODE_BOOST`). Lattice normalized to ~1.6 m
  wide, positioned at the caller's `worldPos`, billboards toward camera (yaw) each
  update with a slight forward tilt.
- All `maxCars` lattices pre-allocated up front, hidden until first `update`.
  `hide(carId)` sets visible=false; `update` re-shows. Color writes internally
  capped to ~20 Hz per car via `performance.now()` timestamp (billboard position
  still updates every call). `setEnabled(false)` hides all + short-circuits.
  `dispose()` frees geometries + materials.

## Deviations from the plan
- **Vertex budget**: plan asked for "< ~300 verts/car". Actual after trimming is
  352–424 verts/car (sedan 376, coupe 400, hatch 352, pickup 424, van 352,
  muscle 400). BoxGeometry is a fixed 24 verts/box and the 6-segment cylinder
  wheels are ~40 verts each (160/car for four). Getting under 300 would mean box
  wheels (uglier when spinning) or stripping silhouette detail. I prioritized the
  "charming varied low-poly fleet" goal; 24 cars × ~390 ≈ 9.4k verts is a
  negligible GPU load and comparable to traffic.ts's own vehicles. Flagged here as
  the one soft-target miss.
- carMesh uses +Z forward (per LOCKED interface) whereas the reference traffic.ts
  uses -Z forward — intentional, to match the fleet heading convention.
- brainOverlay drops the horse's separate "halos" InstancedMesh (2 draws/car
  instead of 3) to stay lean; the node spheres already use additive blending for glow.

## Test results
- `npx tsc --noEmit` — CLEAN (whole project, strict + noUnusedLocals; 0 errors).
- Visual verification via standalone Vite harness (scratchpad/carmesh-preview) +
  headless Playwright/WebGPU (Chrome --use-angle=metal --enable-unsafe-webgpu):
  all 6 BODY_KINDS × 4 hues laid out in a grid with spinning wheels + 6 BrainOverlay
  lattices fed sinusoidal activations. Confirmed: 6 distinct silhouettes, varied
  saturated paint + neutrals, visible glass/head/tail lights, round-reading wheels,
  and clearly legible lattices (input column of 9, hidden of 12, larger output pair,
  cyan/orange activation coloring).
  Screenshots: scratchpad/cars_final.png (also cars.png, cars2.png).

## Open risks
- Vert counts above the soft ~300 target (see deviation) — acceptable but noted.
- `paintFor` HSL bands are tuned by eye; extreme hues near the neutral buckets can
  read slightly muted for the pale van kind. Cosmetic only.
- brainOverlay assumes `layerOut[l-1]` has the layer's activations (matches
  policy.ts `layerOut` semantics: index 0 = first hidden). Guarded with `?? 0`.
- Integration (index.ts / main.ts) is Agent C's responsibility; these modules were
  verified in isolation only.
