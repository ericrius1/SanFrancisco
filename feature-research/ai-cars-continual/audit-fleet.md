# Wave-B audit — fleet.ts continual-learning surgery

## Files changed
- `src/gameplay/aiCars/fleet.ts` — full rewrite (only file modified).

Test artifact (not in repo; scratchpad):
`…/scratchpad/test-fleet-continual.mjs` — the 5-scenario node suite below.

## What changed in fleet.ts

Removed the entire episodic-GA ontology and replaced it with persistent
continual-learning individuals driven by an injected `Learner`.

Deleted:
- `Trainer` dependency, `onEpisode` hook, `#trainer`/`trainer` getter.
- `EPISODE_T`, `OFFROAD_LIMIT`, `SPAWN_*`, `DESPAWN`, `MANAGE_INTERVAL`.
- `#endEpisode`, `#spawn`, `#place` (genome assignment), `#manage` (spawn/despawn),
  `#pickAnchor`, `#minAnchorDist2`'s old despawn use.
- AiCar fields `genomeId`, `gen`, `fitness`, `episodeT`, `offRoadT`.
- Every respawn / teleport / despawn-by-distance path. Cars now only move by
  integration — there is no code path that discontinuously repositions a car.

Added / reworked:
- `MAX_CARS` 24 → 32.
- **Placement once**: `#placeAll()` runs on the first `prePhysics` that has an
  anchor (or is skipped if `importState` already ran). Cars get random road
  points in a radius up to `PLACE_RADIUS` (600 m, widened on retry) around the
  first anchor. Identity (`id` fixed at construction; `bodyKind`, `paintHue`
  assigned once here) is never rerolled.
- **Reverse gear**: `speed ∈ [SPEED_MIN,-4 … SPEED_MAX,14]`, symmetric integrate
  (accel<0 → brake toward 0 then into reverse). `obs[0] = speed/12` is now
  signed. Steering is a kinematic bicycle model:
  `yawRate = speed·tan(steer·MAX_STEER_ANGLE)/WHEELBASE`, so heading rate is
  proportional to **signed** speed and the steering geometry flips naturally when
  reversing (backing out of corners is learnable). Position integrates along
  `heading·speed`.
- **Learner integration** (replaces trainer): `actorForward` every substep for
  control; `learnStep` on every 3rd substep (20 Hz) with a per-second reward
  rate; `addOdometer(i,|ds|)` each substep; `lessonCheck()` every 30 s;
  `syncPolicy(i, car.policy)` at ≤5 Hz for the overlay (followed by a
  `policy.forward(lastObs)` so `layerOut` stays populated for index.ts, which no
  longer triggers a forward itself).
- **Reward** (per plan): progress-along-road (0 when no projection) minus
  offRoad 0.5/s, grinding 2/s (`clearAhead<0.08 && |speed|>1`), steer-smoothness
  `0.02·|steerRate|` (steerRate = Δsteer/dt — the change in the steering command,
  the natural "smoothness" penalty), reversing 0.3/s (`speed<-0.1`), stuck 1/s
  (`|speed|<0.3` continuously >5 s). Accumulated per substep then converted to a
  **per-second rate** (`rewardAccum / windowDt`) for `learnStep`, matching
  learner.ts's documented REWARD CONVENTION.
- **Distance tiers** (`#manageTiers`, hysteresis 380/420 m):
  - NEAR: kinematic body + real building sweeps + car-vs-car forward cone.
  - FAR: no body (created/destroyed across the boundary through the existing
    `onWillRemoveBody` contract); the SAME obs slots are filled by road-based
    estimates — `clearAhead` from lookAhead straight-line divergence /
    segment-end proximity, `clearLeft/Right` from lateral road-edge margin. Sim +
    learning run at full rate in both tiers, city-wide, forever.
- **Persistence**: `exportState(): FleetBlob` merges `learner.exportCar(i)` with
  fleet-owned `{id, bodyKind, paintHue, x, z, heading}`; `importState(blob):
  boolean` validates the whole blob first (rejects wrong `v`, bad id, non-finite
  fields) then restores identities/positions and calls `learner.importCar`.
  Format v:2 as specified. (localStorage/relay I/O is Wave C's, not here.)

Kept as required: sensors/probe code, `FleetWorld` injection, road-frame math
(`project`/`lookAhead`/curvature), zero-alloc discipline (reused `#obs`,
`#action`, per-car `learnObs`/`learnAction`), heading convention, `HALF_EXTENTS`,
`#writeBody`, `lastObs` snapshot for the overlay.

## Fields kept for index.ts / netSync.ts (so they keep compiling)
Grep confirmed index.ts reads only: `pos, heading, speed, steer, bodyKind,
paintHue, mesh, alive, lastObs, policy`, plus `fleet.cars`, `fleet.stats()`,
`fleet.prePhysics`, `fleet.dispose`, `fleet.onWillRemoveBody`. netSync reads
`alive, policy.layerOut, id, bodyKind, paintHue, pos, heading, speed`. All kept.

- **`alive`**: retained on AiCar, set true at init and never toggled false during
  life. It now means "initialized", not "alive this episode" (documented in the
  type). index.ts's `if (!car.alive)` mesh-removal branch simply never fires now.
- **`policy`**: kept purely as the overlay mirror; `learner.syncPolicy` writes
  weights into it and fleet calls `policy.forward(lastObs)` to refresh `layerOut`.
- **`stats()`**: shimmed to `{gen:0, bestFit, meanFit}` derived from learner
  skills, so index.ts's current HUD call compiles until Wave C rewrites it.
- No genome-field stubs were needed — index.ts / netSync never referenced
  `genomeId`, `gen`, `fitness`, or `episodeT`, so they were deleted outright.

## Deviation from plan (must be handled by Wave C, not a fleet bug)
- The plan's `lessonCheck(medianCtx)` interface was **superseded by the real
  learner.ts**, whose `lessonCheck()` takes no args and computes the fleet-wide
  skill median/MAD/mentor pool itself (returns taught ids). Fleet calls it with
  no args. My `Learner` interface in fleet.ts matches the concrete learner.ts
  class exactly (reward = per-second rate; `importCar` returns boolean;
  `lessonCheck(): number[]`).
- **Constructor signature changed** `Fleet(world, roads, trainer)` →
  `Fleet(world, roads, learner, rng?)`. This is the single remaining tsc error,
  in **index.ts (line 127, Wave C's file)**: it still passes a `Trainer`. No
  stub can reconcile a Trainer with the Learner contract — Wave C must construct
  `new Learner(MAX_CARS)` and pass it, and rewire the HUD/persistence. fleet.ts
  itself is tsc-clean.

## Test results (node --experimental-strip-types)
Suite `test-fleet-continual.mjs`, all 20 checks PASS:

1. **No-teleport invariant** — 100 000 ticks, anchor orbiting a 700 m circle to
   force repeated NEAR↔FAR tier flips, all 32 cars at full throttle. Max
   per-tick position delta = **0.23333 m ≤ SPEED_MAX·dt = 0.23343 m**. No jump
   ever exceeds the kinematic bound.
2. **Reverse** — scripted reverse policy with a wall 5 m ahead (dead-end): speed
   reaches −4.0 m/s, car backs up −6.24 m along its initial forward vector, and
   heading rate **flips sign** vs the identical forward run (fwd Δh=+0.832,
   rev Δh=−0.691) — steering geometry inverts when reversing.
3. **Tier transitions** — body created exactly when d<380, destroyed exactly
   when d>420, no toggle inside the 380–420 hysteresis band (from either side);
   `onWillRemoveBody` fired before every `removeBody`; obs never NaN across 192
   NEAR+FAR sensor calls.
4. **Stuck detection** — wedged car: reward ≈ 0 at t=3 s (before threshold),
   reward ≈ −1.0/s at t=6.5 s (after 5 s continuously stuck).
5. **export/import round-trip** — positions, identities (bodyKind/paintHue), and
   brains (actor 146 + critic 133 + rhoBar) restored **exactly** on a fresh
   fleet+learner; corrupted blobs (wrong version, NaN position) rejected with no
   mutation.

Plus a 10-minute real-`Learner` integration smoke (36 000 ticks, drifting
anchor): no NaN poses, 383 968 learnStep calls (≈ 20 Hz × 32 cars), 79/77
bodies created/destroyed across tier flips, 132 km total odometer, all skills
finite.

`npx tsc --noEmit`: fleet.ts **clean**; only the expected index.ts(127) Learner
constructor mismatch remains (Wave C).

## Open risks / notes
- FAR-tier obs semantics are approximations of the NEAR sweeps (documented in
  code): off-road FAR cars read clearAhead/Left/Right = 1 (no wall data). Per
  the plan this is acceptable — the offRoad reward still teaches road-keeping.
- `steerRate` for the smoothness penalty is Δsteer/dt (steering-command jerk),
  not the old heading angular velocity. Chosen as the literal "smoothness"
  reading of the plan; if Wave-D review prefers heading-rate, it is a one-line
  change.
- `LessonContext` was designed then removed once learner.ts's no-arg
  `lessonCheck()` was confirmed — the fleet↔learner lesson contract is now
  "learner owns the whole computation."
- Untrained median skill is strongly negative (random policies wander off-road);
  demonstrating that skill *rises* over time is learner.ts's soak test (Wave A),
  not a fleet responsibility.
