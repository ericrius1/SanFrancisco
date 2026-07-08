# AI Cars — Agent A audit (road data, car sim, trainer)

## Files changed

Created:
- `tools/export-roads.mjs` — build-time road exporter (plain node, no deps).
- `public/data/roads.json` — GENERATED output of the exporter (kept, as instructed).
- `src/gameplay/aiCars/roadGraph.ts` — `RoadGraph` class (spatial index + road queries).
- `src/gameplay/aiCars/fleet.ts` — `FleetWorld` interface, `AiCar` type, `Fleet` class.
- `src/gameplay/aiCars/trainer.ts` — `Trainer` (online GA), plus the LOCKED `CAR_SIZES` and `POP`.

Not touched (as scoped): `src/gameplay/aiCars/policy.ts`, `src/main.ts`, `src/net/`, `server/`.
Did NOT create `carMesh.ts` / `brainOverlay.ts` / `index.ts` (other agents).

## What changed, per file

### tools/export-roads.mjs + public/data/roads.json
Reads `data/city/city.json` (205 tiles), merges all `tiles[key].roads`, drops
`bridge===true` and `w < 6` segments, quantises coords to 0.1 m ints, drops
consecutive duplicate points, emits `{ v:1, segs:[{p:[x1,z1,...], w}] }`.
Run result:
- segments: **11,224**, points: 69,757
- dropped: bridge=291, narrow(<6 m)=410, short=0
- size: **0.97 MB** uncompressed (target < 2 MB) — gzip serves smaller.

### roadGraph.ts
Constructor takes an already-parsed `RoadsJson` (node-testable); `RoadGraph.load(url)`
is the browser fetch wrapper. Decodes into flat typed arrays (px/pz/cum/ptSeg/segW…)
and builds a 64 m spatial hash of polyline edges plus an endpoint hash for hops.
- `project(x,z)` — nearest road edge within 40 m; returns segId, arc `s`, signed
  `lateral` (+ = left of travel), unit tangent, halfWidth. Uses a per-query visited
  stamp to dedupe multi-cell edges.
- `lookAhead(segId,s,dir,dist)` — walks the polyline; clamps at ends, hops to a
  connected segment endpoint within 15 m (recursion-capped). Returns a REUSED
  zero-alloc object (documented).
- `randomPointNear` — annulus sample over hashed vertices, aligned to tangent.

### fleet.ts
`FleetWorld` injected interface `{ ground, isWater, sweep, createBody, moveBody,
removeBody }` — browser adapts Physics+WorldMap; node tests stub it. Kinematic
bicycle-ish sim per fixed substep: 9-float sensors → per-car `Policy.forward` →
steer/accel integrate → Y snapped to `ground+rideHeight`, pitch/roll from
finite-difference ground normal, pose written to a kinematic body. Fitness shaping
(forward progress along road tangent, off-road/obstacle/steer-smoothness penalties),
30 s episodes (staggered start), 6 s off-road early-out (−5). Roster: MAX_CARS=24,
spawn/despawn around anchors (`> 550 m` despawn), throttled to every 0.5 s.
`onWillRemoveBody` hook fired before every body destroy.

**Heading convention (documented in-file):** heading 0 = +Z, fwd = (sin h, cos h),
left normal of a tangent (tx,tz) is (−tz, tx) so + lateral = left of travel.

### trainer.ts
Online GA, dependency-free (only imports policy.ts) so it node-tests cleanly.
Pool of POP=24 genomes `{weights, fitness[], gen}`. `nextGenome()` hands out the
least-evaluated genome (round-robin tiebreak); `report()` accumulates and evolves
after POP reports: rank by mean recent fitness, keep top 25% elites untouched,
refill with elite-clone + gaussian mutation (σ = max(0.03, 0.12·0.995^gen)), 10%
uniform crossover of two elites. Seed = `Policy.random(CAR_SIZES)·0.5` with accel
output-bias +0.3 pre-tanh. `exportPool(topK)` / `importPool(blob)` (weights 3 dp)
for net sync + persistence; `save()`/`loadSaved()` to localStorage key
`sf_aicars_pool_v1` (no-op outside browser). `CAR_SIZES=[9,12,2]` exported here
(dependency-free module) so fleet/overlay/index import it without pulling in THREE.

## Test results (plain node, `--experimental-strip-types`)

- **roadGraph** (test-roadgraph.mjs): 11,224 segs. project lateral-recovery 1881/2000
  ok under a ±3 m strict offset test (misses are legitimate — nearer crossing roads
  at intersections). lookAhead advances correctly (d=8→dist 8, d=20→dist 20; verified
  by direct calls), far-walk stays finite via hops, randomPointNear 50/50 in-ring.
- **trainer GA** (test-trainer.mjs): fake objective = −‖w−target‖². 40 generations,
  best fitness **−44.32 → −31.20**, **0 regressions** (monotonic). export/import
  round-trips gen. → PASS.
- **mini driving sim** (test-fleet.mjs): 24 cars, real road graph, gen-0 random
  policies, stubbed flat/clear world. 200 episodes over 8 evolves. Mean fitness/gen:
  `38.7 70.8 77.1 87.7 93.4 70.4 102.9 123.0 …`; **early third 62.2 → late third 102.5**.
  Validates obs/action/fitness/spawn/evolve plumbing end-to-end. → PASS.
- **Perf**: `prePhysics` for 24 alive cars = **~36 µs** (target < 1 ms). Zero-ish
  per-step allocation (shared obs Float32Array + reused Vector3/Quaternion scratch).
- **Typecheck**: `npx tsc --noEmit` exits **0** (strict + noUnusedLocals), no new
  errors anywhere in the repo.

## Deviations from the plan

- Fleet's injected surface includes body lifecycle (`createBody/moveBody/removeBody`)
  in addition to the plan's `{ ground, sweep, isWater }`, so kinematic-body creation
  is also stubbable in node. `sweep` returns a distance-or-null (not the raw point)
  so clearance probes need no extra math. Browser index.ts must build this adapter
  over Physics/WorldMap (createBody → kinematic `world.createBox`; sweep →
  `physics.sweepBuildings` distance).
- Fleet exposes `bodyHandle` on `AiCar` (additive to the locked type) and an optional
  `onEpisode` instrumentation hook (default no-op, used only by the sim test).
- `CAR_SIZES` is exported from `trainer.ts` (dependency-free) rather than fleet.ts,
  so trainer/overlay node tests don't transitively import THREE. `fleet.ts` re-imports
  it from trainer; consumers can import from either.
- Obstacle/off-road penalties applied as per-second rates (×dt) rather than one-shot,
  giving continuous gradient for the GA (plan listed the magnitudes, not the cadence).

## Open risks / notes for other agents

- `lookAhead` returns a single reused object — read it before the next call. Only
  fleet uses it today and it consumes each result immediately.
- Cars are Kinematic and intentionally NOT registered via `physics.registerVehicle`,
  so they don't chip/fracture buildings on contact. The browser adapter should
  createBox with `BodyType.Kinematic`.
- `randomPointNear` can return null when an anchor is far from any road; `#spawn`
  and respawn both handle null (skip / despawn). On the real map near the player
  this is rare, but a leader anchored mid-bay would spawn fewer cars.
- Trainer persistence uses localStorage only in-browser; net/relay persistence is
  Agent D's job via `exportPool/importPool`.
