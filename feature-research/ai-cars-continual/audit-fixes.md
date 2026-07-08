# Reviewer-fix pass audit — continual-learning AI cars

Applied the 5 reviewer fixes (blockers #1, #2; hardening #3, #4, #5). Finding #6
(`cars` pose msg not leader-gated) deliberately skipped per task. Scope was held to
exactly these five source files; no refactors, no repo-wide tooling.

## Files changed

- `src/gameplay/aiCars/fleet.ts` — FIX 1
- `src/gameplay/aiCars/learner.ts` — FIX 1 (`resetCar`), FIX 2, FIX 4
- `src/gameplay/aiCars/index.ts` — FIX 3
- `src/net/net.ts` — FIX 4
- `server/server.mjs` — FIX 4, FIX 5

(Runtime-only, not a source change: `server/data/aicars-life.json` was rewritten by the
browser smoke run — it is regenerated game state.)

## What changed per file

### `src/gameplay/aiCars/fleet.ts` (FIX 1)
- Extracted the per-car random-road placement out of `#placeAll` into a new
  `#placeCarRandom(car, cx, cz)` (identical behaviour; `#placeAll` now loops it around
  `#anchors[0]`).
- `importState`: after applying the blob's covered subset, tracks a `covered[]` bitmap
  and a fallback anchor (first covered car's position, used when `#anchors[0]` isn't set
  yet at boot). Every slot NOT covered by the blob is `#placeCarRandom`'d onto a road and
  reset to a fresh individual via `learner.resetCar(id)`. Result: every slot ends
  `alive=true` on a sane road position — no slot stranded at `alive=false`/`(0,0,0)`.
- Added `resetCar(i): void` to the structural `Learner` interface (line ~97) so the real
  Learner stays assignable.

### `src/gameplay/aiCars/learner.ts`
- FIX 1: new public `resetCar(i)` — reseeds both nets (`#seedActor`/`#seedCritic`), clears
  traces, and zeroes all per-car bookkeeping (rhoBar/sigma/skillRate/ageS/odoM/lessons/
  belowS; `lastLessonAge = -RESCUE_COOLDOWN_S`).
- FIX 2: `importCar` now sets `lastLessonAge[i] = blob.ageS` (full cooldown after import,
  was `blob.ageS - RESCUE_COOLDOWN_S`) and advances the shared clock
  `lastCheckAge = Math.max(lastCheckAge, blob.ageS)`. `lessonCheck` clamps `dt = 0` when
  `dt > 120` (legit gaps are ~30 s; a large dt means ages jumped on a bulk restore).
- FIX 4: `importCar` range caps — `|rhoBar| ≤ 1e3`, `ageS ≤ 1e12`, `odoM ≤ 1e12`,
  `lessons ≤ 1e9` (rejects otherwise; lower bounds already present).

### `src/gameplay/aiCars/index.ts` (FIX 3)
- `#adoptCachedBrains`: ghost-pose adoption condition changed from `g && g.active` to
  `g && g.spawned && performance.now() - g.seen < 10000`, so a promotion up to ~10 s after
  the leader went silent still adopts the last-seen ghost pose instead of snapping to a
  potentially 48 s-stale blob position. Uses the existing `Ghost.seen` field — no new
  GhostStore accessor needed.

### `src/net/net.ts` (FIX 4)
- `parseCarBlob`: after the finiteness checks, added range caps `|rhoBar| ≤ 1e3`,
  `0 ≤ ageS ≤ 1e12`, `0 ≤ odoM ≤ 1e12`, `0 ≤ lessons ≤ 1e9` (returns null otherwise).

### `server/server.mjs`
- FIX 4: `validBrain` gains the same four range caps.
- FIX 5: `scheduleLifeWrite` now writes `LIFE_FILE + ".tmp"` then `await rename(tmp,
  LIFE_FILE)`; imported `rename` from `node:fs/promises`.

## Deviations from the plan

- **`fleet.ts` structural `Learner` interface** needed one added method signature
  (`resetCar`) so `importState`'s new call typechecks. This is within the FIX-1 file set
  and is the minimal change required; no behavioural change to existing methods.
- FIX 3 did **not** need a new `lastSeen` accessor on GhostStore — `Ghost.seen`
  (perf-now of last snapshot) is already public on `ghosts.cars[id]` and survives ghost
  timeout (only `active`/`spawned` reset), so the "seen within 10 s" test works directly.
- FIX 2: the reviewer's "20 min → lesson eventually fires" expectation is bounded by the
  now-full 30-min post-import cooldown; the "rule still works" node test therefore runs on
  a fresh learner (cooldown pre-expired, as at real world-birth) where the lesson fires at
  ~15 min continuous-below. This proves the rule survives the `dt` clamp without the
  import-cooldown confound.

## Verification results

- `npx tsc --noEmit` — **exit 0** (repo-wide).
- `node --check server/server.mjs` — **OK**.
- Node tests in `…/scratchpad/fix-tests/` (each bundles the real source via esbuild;
  `net.bundle` built from a temp `src/net/__net_test_entry.ts` that was deleted after;
  server `validBrain` eval'd verbatim from source text):
  - **test1_importState** — PASS. 12-car blob → **32/32 alive**, 12 preserved (blob
    position + brain fingerprint + age), **20 fresh residents each on a road node**,
    every car finite and sitting on ground; 0 at origin.
  - **test2_lessons** — PASS. (2a) bulk import raising ages to ~3 h then two immediate
    `lessonCheck`s → **0 lessons**. (2b) fresh learner, one sustained-below car under
    legit 30 s gaps → **lesson fired at ~15 min**.
  - **test3_validators** — PASS. Base valid blob accepted by all three layers; `rhoBar
    1e30`, `ageS 1e18`, `odoM -5`, `lessons 1e12` each **rejected by learner.importCar,
    net.parseCarBlob, and server.validBrain**.
  - **test4_atomic** — PASS. Source uses `LIFE_FILE + ".tmp"` + `rename`; crash-sim
    (write tmp, no rename) leaves the previous file **byte-identical**; a completed
    write atomically replaces it and consumes the tmp.
- Browser boot smoke (own vite :5210, relay :8788, `?fullfps&autostart`) — **PASS**.
  Ready; **32 cars alive** before and after reload; **0 console errors/warnings**; eldest
  age continued across reload (36 s → 38 s).
- Browser truncated-restore (FIX 1 in-app) — **PASS** on the resilience criteria: forced
  a 32-car localStorage save, truncated it to 12, reloaded → **32 alive, 0 at origin, all
  finite, 0 console errors**. Note: single-client relay persistence shadows the exact
  localStorage blob by summed-age resolution, so the in-app run may restore via the relay
  welcome rather than the truncated LS set; the importState placement logic itself is
  proved exhaustively by test1. No runtime errors either way.

## Open risks / notes

- FIX 2's full post-import cooldown means a just-restored car can't be lessoned for 30 min
  even if genuinely bad from t=0. Intentional per the reviewer's instruction; the anti-
  collapse mechanism still engages after the cooldown.
- The truncated-restore path is hard to exercise unconfounded in a single browser client
  because the relay mirrors the leader continuously; node test1 is the authoritative proof
  of the placement logic.
- `server/data/aicars-life.json` shows as modified — it is runtime state regenerated by
  the smoke run, not a code change.
