# AI Cars — reviewer-fix pass audit

## Files changed

- `src/gameplay/aiCars/trainer.ts` — B1 (stale-report guard via `gen` arg) + N1 (evolve-surviving stats ring buffer).
- `src/gameplay/aiCars/fleet.ts` — B1 (`gen` field on AiCar, stamp at `#place`, pass to `report`) + N3 (zero progress reward when off any road).
- `src/gameplay/aiCars/index.ts` — B2c (mirror relay trust in `#maybeAdoptPool`: bounded gen + exact row length).
- `src/gameplay/aiCars/carMesh.ts` — N4 (wheel-order comment corrected).
- `src/net/net.ts` — N2 (fire `onCarPool` when `welcome` sets `carsPool`).
- `server/server.mjs` — B2a/B2b (exact 146-param rows; cpool gen monotonic + finite-int ≤ 1e6).

Test scripts adapted (scratchpad, not repo): `test-trainer.mjs`, `test-fleet.mjs`; new `test-relay-cpool.mjs`.

Not touched: policy.ts, roadGraph.ts, brainOverlay.ts, statsChip.ts, netSync.ts, main.ts, src/world/garden/*.

## What changed, per file

### trainer.ts (B1 + N1)
- `report(genomeId, fit, gen)` — new required `gen` param. `if (gen !== this.gen) return;`
  drops reports from cars that picked up their genome under a since-replaced pool, so
  `#evolve()` ranks genomes only on fitness they actually earned. The evolve trigger is
  unchanged (`reportedSinceEvolve >= POP`), and since ignored reports don't increment the
  counter, evolve still fires at POP *valid* reports.
- Added `fitRing: number[]` (cap POP) + `fitRingPos`, pushed on every valid report and NOT
  wiped by `#evolve()`. `bestEver` tracked (public field; stats() shape unchanged).
- `stats()` now derives `{gen, bestFit, meanFit}` from `fitRing` (best = max, mean = avg)
  instead of the per-genome arrays that `#evolve()` clears — fixes the post-evolve `-0.0`.
- `importPool()` resets `fitRing`/`fitRingPos` (imported pool has unknown history).

### fleet.ts (B1 + N3)
- `AiCar` gained `gen: number`; initialized 0 in the constructor.
- `#place()` stamps `car.gen = this.#trainer.gen` at genome assignment (uses the existing
  public `trainer.gen` accessor).
- `#endEpisode()` reports `this.#trainer.report(car.genomeId, car.fitness, car.gen)`.
- N3: progress term is now `proj ? dx*travelX + dz*travelZ : 0`. When `roadGraph.project`
  returns null (>40 m from any road) `travel*` falls back to the car's own heading, so the
  old code paid raw heading speed for driving into the void. Penalties (off-road, obstacle,
  steer-smoothness) still apply on that step.

### index.ts (B2c)
- Imported `paramCount`; `CAR_PARAM_COUNT = paramCount([...CAR_SIZES])` (146) and
  `POOL_GEN_MAX = 1e6`. `#maybeAdoptPool()` now imports only when gen is finite and ≤ 1e6
  AND every weights row length === 146 (mirrors the relay's trust even if a bad pool slips
  through). Still gated on `pool.gen > trainer.gen` and the already-adopted check.

### carMesh.ts (N4)
- Comment corrected to `fl, fr, rl, rr` (matches `WHEEL_NAMES` and the assignment order).

### net.ts (N2)
- `welcome` handler fires `this.onCarPool(this.selfId, this.carsPool)` after setting
  `carsPool`, so a welcome arriving *after* `aiCars.attachNet()` still reaches the ghost
  display. The attach-after-welcome path (`if (net.carsPool) #receivePool(...)`) is
  unchanged, so both orderings are covered without double-import risk (`#adoptedPool` guard).

### server.mjs (B2a + B2b)
- Replaced `POOL_ROW_MAX = 160` with `POOL_ROW_LEN = 146` (derivation commented: 9*12+12 +
  12*2+2) and added `POOL_GEN_MAX = 1e6`. `validCarPool` now requires `row.length === 146`.
- The `cpool` handler additionally requires `Number.isInteger(msg.gen)`, `msg.gen <= 1e6`,
  and `msg.gen >= (latestPool?.gen ?? 0)` — a peer can no longer regress the stored gen or
  overflow it. loadPool() also benefits from the tighter row-length check.

## Deviations from the plan
- None material. `bestEver` is stored but not surfaced through `stats()` (the plan said
  "if trivial"); kept stats() shape identical so `statsChip.ts` needs no change, as required.
- Used `paramCount([...CAR_SIZES])` in index.ts rather than a hardcoded 146, to keep the
  client check derivation-safe (server stays hardcoded since it's plain JS, per instruction).

## Test results
- `npx tsc --noEmit` → **exit 0** (strict + noUnusedLocals).
- `node --check server/server.mjs` → **OK**.
- Trainer GA (`test-trainer.mjs`, updated to `report(g, fit, t.gen)`): 40 gens, bestFit
  **-44.318 → -31.200**, **0 regressions**, export/import round-trips (gen 40, genome0 fit
  -31.204). **PASS**.
- Fleet sim (`test-fleet.mjs`): 24/24 cars, 200 episodes over 4 evolves. Mean fitness/gen
  `34.9 66.5 78.8 94.7 76.0`; early **34.93** → late **75.99** (still rises across evolves).
  New N1 assertion: `stats().bestFit` min after 50 episodes = **110.03** over 7153 checks —
  never collapses to ~0. prePhysics 34.6 µs/24 cars. **PASS**.
- Relay validator (`test-relay-cpool.mjs`, live local relay + 2 ws clients):
  valid gen5 accepted ✓, lower gen3 rejected ✓, row len 145 rejected ✓, gen 2e6 rejected ✓,
  higher gen6 accepted ✓. **PASS**.

## Open risks / notes
- B1 slows evolution slightly right after each evolve boundary: cars in flight at the flip
  report stale (ignored) once, then get restamped on respawn, so ~one extra cycle of reports
  is discarded per generation. This is the intended correctness/throughput trade — the fleet
  sim still shows monotone-ish mean-fitness growth across gens.
- Did not run `npm run build` or a browser preview (change is logic-only; verified via node
  + tsc + live relay). No git commits made.
