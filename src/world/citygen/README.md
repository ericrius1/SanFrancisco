# CityGen — portable procedural building module

A neighborhood-aware procedural building generator. Built for this San Francisco
world, but structured so it can be lifted into another project and retuned for
another city by swapping one folder.

## Why it exists

It replaces a vendored Hong-Kong/Kowloon building kit that (1) stamped Chinese
signage over the whole city, (2) approximated every footprint as a bbox rectangle
so generated buildings visibly "shifted" from their baked originals, (3) had
entrances facing alleys, and (4) only collided near the human player so cars
clipped through buildings everywhere else. CityGen fixes each at the root.

## Layout

```
core/     city-agnostic ENGINE. No SF, no THREE, no textures.
  types.ts       the contract (BuildingSpec, Panel, MeshData, ColliderBox, ThemePack)
  rng.ts         deterministic mulberry32 keyed by building seed
  footprint.ts   polygon math + ear-clipping triangulation (handles concave L/T/U)
  massing.ts     extrude the REAL footprint → floor stack → wall panels + roof cap
  mesh.ts        merge panels by material id → typed BufferGeometry arrays
  collider.ts    footprint → oriented per-edge wall boxes + ground pad
theme/    the SWAPPABLE city pack. All SF style lives here.
  archetypes.ts  per-archetype specs (floor height, materials, roof, grammar params)
  materials.ts   (Phase 2) real THREE materials per material id
index.ts  generate(spec) pure API + createCityGen(...) streaming host
```

The archetype **classifier** lives in `tools/citygen-classify.mjs` (it runs at
export time and bakes an archetype id into each building record, so the runtime
never re-classifies and the geography lives in exactly one place).

## The ThemePack contract (how to retune for another city)

1. Write a classifier: `tools/citygen-classify.mjs → classify(x, z, {...}) → id`.
   Return whatever archetype ids your city needs.
2. Write `theme/archetypes.ts`: one `ArchetypeSpec` per id (floor height, material
   ids, roof type; + grammar params once Phase 2 lands).
3. Re-run `node tools/export-citygen.mjs` to bake footprints + archetypes for your
   city's `data/city/city.json`.

`core/` is never touched. That is the whole portability promise: **the engine is
city-agnostic; a city is data + a theme.**

## Data foundation

Everything is driven by the REAL baked footprints in `data/city/city.json`
(`tiles[key].buildings[] = {id, poly, base, top, h, area, c, p, i}`). Building on
the real `poly` (not a bbox) is what makes generated buildings sit exactly on
their baked silhouette — no shift.

## Determinism

All variation flows from a building's `seed` via `core/rng.ts`. Identical geometry,
colliders and interiors on every client and every visit — required for multiplayer
and for AI-car training to see a stable world.

## Verify

- `node tools/export-citygen.mjs` — bake footprints + archetype histogram.
- `node tools/citygen-probe.mjs` — data-foundation acceptance checks.
- (core geometry is unit-checked by bundling `core/` with esbuild; see the Phase 1
  notes in the plan.)

## Status

LIVE citywide via `createCityGenRing` (stream/ring.ts): real-polygon export,
classifier, portable core (massing/mesh/collider), SF theme specs, chunked LOD
skyline crossfading into full grammar meshes + walkable interiors, multi-anchor
physics. The old vendored Kowloon kit (`src/world/buildings` + `vendor/
BuildingGenerator`) has been removed. Chinatown has no facade grammar yet, so it
falls back to its baked OSM facade until a `chinatown` decorator lands
(theme/decorators.ts).
