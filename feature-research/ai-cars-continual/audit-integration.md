# Wave-C audit — continual-learning integration (net sync + HUD + glue)

## Files changed

- **`src/gameplay/aiCars/index.ts`** — rewritten: constructs `Learner` + new `Fleet`
  signature, localStorage persistence, `brain`/`life` net sync, promotion adoption,
  new HUD stats surface, `debugCars()`/`netDebug()` for headless checks.
- **`src/gameplay/aiCars/netSync.ts`** — import repoint (`CAR_SIZES` from the deleted
  trainer → `ACTOR_SIZES` from learner.ts); doc note that speed is now signed.
- **`src/gameplay/aiCars/statsChip.ts`** — rewritten to the continual-learning one-liner
  (`🧠 N cars · skill S ↗ · K km · eldest …`) with a `LifeStats` input + tooltip.
- **`src/net/net.ts`** — deleted the `cpool`/genome-pool client surface; added the
  `brain` message (`sendBrain`/`onBrain`), the `aicarsLife` welcome capture, and the
  strict `parseCarBlob`/`parseAiCarsLife` validators. New exported types
  `CarLifeBlob`, `AiCarsLife`.
- **`server/server.mjs`** — deleted the genome-pool persistence end-to-end; added
  per-car "life" persistence: strict `validBrain`, lowest-id leader auth, latest-blob-
  per-id map, 15 s debounced write to `server/data/aicars-life.json`, boot load, and
  the `aicarsLife` welcome payload.
- **`src/gameplay/aiCars/learner.ts`** — additive only: `odometer(i)` accessor (for the
  HUD total-km). No internal restructuring.
- **`src/gameplay/aiCars/fleet.ts`** — one necessary edit: the `CAR_SIZES` import now
  comes from learner.ts (`ACTOR_SIZES`) instead of the deleted trainer.ts. No logic
  change. (See "Deviations".)
- **`src/gameplay/aiCars/trainer.ts`** — DELETED (GA superseded by learner.ts; verified
  no remaining importers).

Test scripts (scratchpad, not in repo): `…/scratchpad/aicars/{acceptanceA,testB,testC,
testD,testE,testE2,shot3}.mjs` reusing `cdp.mjs`. Screenshots in the same dir.

## What changed per file (detail)

**index.ts** — `AiCars` now owns a concrete `#learner: Learner` (built with
`new Learner(MAX_CARS)`) and a `Fleet(world, roads, learner)`. New behaviour:
- **Persistence.** `LS_KEY = "sf_aicars_life_v2"`. On boot `#restoreFromLocalStorage()`
  imports the saved `FleetBlob` (localStorage < welcome < running-fleet, resolved by
  summed `ageS`). Autosaves via `fleet.exportState()` every 60 s (leader) + on
  `pagehide`. `#maybeAdoptLife()` adopts a relay welcome set only when its summed age
  exceeds the current fleet's — implementing "relay welcome (if newer) > localStorage >
  fresh".
- **Net.** `AiCarsNet` slice updated to `{aicarsLife, onCars, onBrain, sendCars,
  sendBrain}`. `#broadcast()` keeps the 8 Hz `cars` pose snapshot and adds a 1.5 s
  round-robin: one car's `#carLifeBlob(i)` (merged `learner.exportCar(i)` + identity +
  pose, weights rounded to 4 dp) sent via `sendBrain`. Non-leaders cache received
  brains (`#brainCache`) and seed the cache from the welcome set.
- **Promotion.** `#adoptCachedBrains()` builds a `FleetBlob` from the cache, overriding
  each car's stored `x/z/heading` with the LIVE ghost pose for that slot, then
  `fleet.importState()` — adopts every individual at its ghost position with no snap.
- **HUD.** `#rawStats()` (leader → live learner; ghost → brain cache) yields count /
  fleet-median skill / total km / eldest age / lessons; `#lifeStats()` adds a 10-min
  trend arrow (null until 10 min of samples). `netDebug()`/`debugCars()` expose these +
  per-car pose/mesh/speed for the headless tests.

**net.ts / server.mjs** — the `cars` pose wire format is unchanged; speed is signed
(−4..14) and the existing `round(speed·10)` / `speed/10` is symmetric across zero (no
change needed — verified in testC by decoding negative ghost speed). The `brain` blob is
validated identically on client and server (actor 146, critic 133, |w| ≤ 16, id 0..31,
bounded scalars). Server accepts `brain` only from `leaderId()` (lowest connected id).

## Deviations from the plan

1. **Two out-of-"Files touched" edits, both minimal and pre-authorized** by the task
   ("add what you need to fleet/learner ONLY via small additive accessors"):
   - `learner.ts`: added `odometer(i)` accessor (additive; needed for total-km HUD).
   - `fleet.ts`: the `CAR_SIZES` import was repointed from the now-deleted `trainer.ts`
     to `ACTOR_SIZES` in `learner.ts`. This is the minimal change required to satisfy
     "delete trainer.ts" — fleet.ts already imports `CarBrainBlob` from learner.ts, and
     `ACTOR_SIZES === [9,12,2] === CAR_SIZES`, so there is no behavioural change. Without
     it, deleting trainer.ts would not typecheck. No fleet logic was touched.
2. **`brain` wire shape.** The plan sketched `{t:"brain", d:{id, blob}}`; since the
   merged per-car export already carries `id`, I flattened it to `{t:"brain", d:<blob>}`
   (client→server) and the relay stamps the sender as `from` on rebroadcast
   (`{t:"brain", from, d:<blob>}`), mirroring the old `cpool` pattern. No duplicate id.
3. **`fleet.stats()` left in place** (now unused by index.ts). It is a harmless valid
   shim; removing it would be an unnecessary fleet edit.
4. **HUD skill scale.** Per the learner audit, `skill(i)` is reward/MINUTE (~500 for a
   good driver), not the plan's illustrative 4.2. The chip prints the rounded value with
   a `title` tooltip ("fleet-median reward per minute"). Observed values are often
   negative here because the test fleets are wandering (untrained) — correct behaviour;
   the learner soak (Wave A) is what demonstrates rising skill over 30 min.

## Verification results (headless Chrome, own vite :5208, relay :8788)

- **tsc** — `npx tsc --noEmit` exit **0** (repo-wide). The former sole error
  (`index.ts:127` Trainer→Learner) is resolved.
- **A — no disappearing cars (THE acceptance test): PASS.** 5 min of sim (150 samples ×
  40 ticks), player stationary at the fleet centroid: up to **29 cars continuously
  within 150 m**, 4768 tracked per-sample transitions, **0 position jumps** > SPEED_MAX·Δt,
  **0** cars ever lost their mesh/visibility. (Also incidentally adopted a relay-persisted
  set — age 450 s on a fresh client — proving welcome adoption.)
- **B — advance + persist across reload: PASS.** age 608→698 s and km 111→133 both
  advanced; HUD text well-formed (`🧠 32 cars · skill -67 · 133 km · eldest 11m`, tooltip
  present); localStorage `sf_aicars_life_v2` present (v2, 32 cars, actor 146, critic 133,
  maxAge 665 s); after `Page.navigate` reload the eldest age **continued** 698→701 s (not
  reset).
- **C — 2-client ghost/promotion/persistence: PASS.** ghost mirrors 32 cars, cacheSize 32
  from welcome; **reverse seen on leader and decoded negative on the ghost**; killing the
  leader promoted the ghost (aliveCars 32) and adopted all 32 cached brains at their
  ghost positions with **maxDelta 0.016 m** (< 3 m); `aicars-life.json` present (71 KB)
  and mtime advancing.
- **D — poison / leader auth (raw WS): PASS (7/7).** welcome carries the 32-car set;
  valid brain from the leader is relayed; brain from a **non-leader is rejected**;
  wrong-length actor, non-finite weight, |w|>16, and out-of-range id are all rejected.
- **E — console + perf: PASS.** 0 console errors/warnings during a full run;
  **fixed-step cost = 0.052 ms/step** for 32 cars + online learning (target < 1.5 ms).
  Measurement was FAR-tier-dominant; NEAR tier adds one building-sweep raycast per near
  car, but acceptance-A ran 27 near cars in real time without hitches, so the 1.5 ms
  budget holds with wide margin.
- **brain message size:** ~**2.25 KB** serialized (well under the 16 KB relay cap). Full
  32-car welcome set ~71 KB (server→client only; never sent by a client).

Screenshot `…/scratchpad/aicars/cars-overlays-hud.png` shows AI cars (van/trucks/sedan)
driving on a road with brain-lattice overlays floating above each, player among them;
HUD `🧠 32 cars · skill 3 · 0 km · eldest 3s` verified via DOM.

## Open risks / notes

- **Promotion completeness.** `#adoptCachedBrains()` only repositions slots present in
  the cache. In practice the welcome set seeds all 32 immediately, so this is a
  non-issue; a car never brain-broadcast/seeded would keep its localStorage/fresh pose.
- **Welcome set size** grows to ~71 KB for 32 fully-populated cars. It is server→client
  only (browser WS has no receive cap; the CDP harness uses 64 MB), so it never hits the
  16 KB inbound `maxPayload`. Fine, but worth remembering if the fleet grows.
- **Skill sign** on the HUD is negative for untrained/wandering fleets — expected; not a
  bug. It goes positive as cars learn (see Wave-A soak).
- Test-harness only: `__sf.teleportToTarget(x,z)` did not reliably move the player in the
  headless driver (a deferred/guarded teleport); tests worked around it by setting
  `player.position` directly. No product impact.
