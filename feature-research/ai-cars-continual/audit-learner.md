# Wave-A audit — learner.ts (continual-learning core)

## Files changed

- **`src/gameplay/aiCars/learner.ts`** — CREATED. The only repo file touched.

Test scripts (outside the repo, in the session scratchpad — not for review, listed
for reproducibility):
`.../scratchpad/learner-tests/{env.mjs, drive.mjs, gradcheck.mjs, learn.mjs,
soak.mjs, lesson.mjs, roundtrip.mjs}`. Run with
`node --experimental-strip-types <file>.mjs` (Node 22). They import the real
`src/gameplay/aiCars/roadGraph.ts` + `public/data/roads.json`.

## What the file provides

`class Learner` — a per-car bank of hand-rolled tanh MLPs implementing online
continuing actor-critic (average-reward, eligibility traces). Zero-allocation
`actorForward`/`learnStep` hot paths; only import is the `Policy` *type* from
`policy.ts`.

Public surface = the LOCKED interface exactly, plus the requested `addOdometer`:
`actorForward, learnStep, skill, lessonCheck, exportCar, importCar, syncPolicy,
addOdometer`. Exports `CarBrainBlob`, `ACTOR_SIZES=[9,12,2]`,
`CRITIC_SIZES=[9,12,1]`, `ACTOR_PARAMS=146`, `CRITIC_PARAMS=133`. A handful of
read-only accessors (`age`, `lessonCount`, `sigmaOf`, `rho`) and test-only
`__debugGrads`/`__actorWeights`/`__criticWeights` exist for HUD/testing; none
change the fleet contract.

Algorithm details, all on flat `Float32Array`s with preallocated scratch:
- Actor [9,12,2] tanh-everywhere (matches `policy.ts`, so `syncPolicy` is a direct
  `policy.setParams(actorFlat)` and the brain overlay is untouched). Outputs =
  Gaussian mean; `actorForward` writes `mean + sigma*N(0,1)` (Box-Muller, spare).
- Critic [9,12,1] tanh hidden, **linear** value head.
- `delta = r - rhoBar + V(s') - V(s)`; `rhoBar += 1e-3*delta`.
- Accumulating traces λ=0.9 on both nets; `alphaA=1e-3`, `alphaC=3e-3`.
- Grad-norm clip 1.0/net/step on the raw ∇logπ / ∇V before trace accumulation;
  param clamp ±8; weight decay 1e-5 (see deviation 1); sigma schedule
  `clamp(0.06 + 0.19/(1+max(0,rhoBar)*2), 0.06, 0.25)`.
- Social rescue: skill = reward-rate EMA (τ=60 s); candidate if
  `skill < median − 1.5·MAD` continuously ≥15 min; lesson
  `w ← 0.8w + 0.2·mentor + N(0,0.02)` on both nets, mentor = random top-quartile;
  cooldown ≥30 min/car. `lessonCheck()` uses max fleet `ageS` as its monotone clock.

## Test results (all PASS, exit 0)

**1. Gradient check** (`gradcheck.mjs`) — numerical (central diff, eps 1e-5) vs
analytic ∇logπ (146 params) and ∇V (133 params):
- actor  grad-log-pi: **maxRelErr = 6.79e-4**
- critic grad-V:      **maxRelErr = 6.79e-4**  (both < 1e-3) → PASS

**2. Learning** (`learn.mjs`, N=32, real RoadGraph, plan reward incl. reverse,
30 min, rescue on) — fleet mean `rhoBar` (starts at exactly 0):
```
min  1: 2.67   min 11: 4.44   min 21: 4.33
min  5: 4.73   min 15: 3.83   min 29: 5.21
```
End mean rhoBar **5.16 /s**, best car **8.72 /s**, **69% competent** (rho>5),
median skill 510/min. rhoBar rose 0 → 5.16. → PASS

**3. Soak** (`soak.mjs`, N=32, 8 simulated hours, rescue on) — 10-min-window mean
rhoBar by hour:
```
0h 4.84  1h 6.34  2h 7.11  3h 7.22  4h 7.98  5h 8.36  6h 8.48  7h 8.52
```
peak 8.72, **final 8.66 = 99% of peak** (≥80% ✓), **100% competent**, 97 lessons
issued, **max |w| = 8.000** (clamp holds), **no NaN/Inf**, 11,846 km / 8.00 h aged.
The mean *rises* over the soak as rescue lifts stragglers into the good basin. → PASS

**4. Lesson / social rescue** (`lesson.mjs`, N=24) — train 45 min, lobotomize the
best car (randomize weights, still |w|≤3), then observe with rescue:
```
pre-lobotomy  skill 622/min (median 496)
post-lobotomy skill -177/min
... 4 lessons over the next ~120 min (30-min cooldown honored) ...
t150 (4th lesson lands) skill jumps -183 -> 92 -> 594, settles ~510
final skill 496/min vs median 514/min
```
`lessonCheck` fired for the victim; the lesson escapes the absorbing bad basin and
online learning finishes the recovery to the fleet median. → PASS

**5. Export/import round-trip** (`roundtrip.mjs`) — 24 assertions:
blob shape (v2, 146/133), age/odo preserved, imported brain reproduces identical
deterministic mean + critic value + sampled action (matched rng), and corruption
rejected (wrong length, NaN, Inf, |w|>16, bad version, NaN rhoBar, sigma≤0,
negative ageS) with the target car left byte-identical; |w|==16 accepted then
clamped to ≤8. → PASS

**tsc** — `npx tsc --noEmit` reports **0 errors in learner.ts**. There is 1
pre-existing error in `src/gameplay/aiCars/index.ts` (`Argument of type 'Trainer'
is not assignable to parameter of type 'Learner'`) — that is another agent's
in-flight fleet/index integration passing a `Trainer` where my `Learner` is now
expected. It is not a file I own; NOT fixed. It actually confirms my `Learner`
interface (actorForward, learnStep, skill, addOdometer, lessonCheck, exportCar,
importCar, syncPolicy) is what the downstream integration is being typed against.

## Deviations from the plan (with rationale)

1. **Weight decay coupled to the learning rate** — `w -= alphaX * 1e-5 * w`
   (≈1e-8/step), NOT a raw per-step `w -= 1e-5*w`. A raw 1e-5 multiply at 20 Hz
   compounds to ~0.5×/hour, which *erodes converged policies* and produced
   catastrophic collapse in testing (a car at rhoBar 9.8 decayed to −2.5). Standard
   weight decay is lr-coupled; this is the "tiny regularizer" the plan intends. This
   single change flipped the 8-h soak from failing (~72% of peak) to 99% of peak.
   **Recommend the plan text be read this way.**

2. **Reward convention = per-second rate.** `learnStep(reward)` is treated as the
   plan's per-second shaped reward VALUE (not integrated over dt). Hence `rhoBar`
   and the skill EMA are per-second averages, and `skill(i)` returns `rate*60` for
   "per minute". Consequence: a good driver's skill is ~500/min (progress up to
   14 m/s × 60), much larger than the HUD's illustrative "4.2/min". The HUD (Wave C)
   can rescale for display. **Coordination flag for Wave B: fleet must pass the
   per-second reward value, not a per-tick integrated reward** — otherwise rhoBar
   stays tiny and the sigma schedule never leaves 0.25.

3. **Single scalar sigma per car** for both action dims (plan says "per output" but
   specifies one scalar schedule). Documented in-file.

4. **Grad clip on the raw ∇** (before trace accumulation), to unit L2 norm. This
   also normalizes the `1/sigma^2` factor in ∇logπ, decoupling the effective step
   size from sigma — good for stability. This is my reading of "gradient-norm clip
   1.0 per net per step."

5. **Critic linear output head** (value is unbounded); actor stays tanh-everywhere
   to match `policy.ts`.

6. **Extra accessors + test hooks** (`age/lessonCount/sigmaOf/rho`, `__debugGrads`,
   `__actorWeights`, `__criticWeights`). Additive only; the locked 8-method fleet
   contract is exactly as specified.

## Open risks

- **Metastable bad basin.** A lone car can get stuck at sigma 0.25 / negative
  rhoBar and never self-recover; escape depends entirely on social rescue landing
  it a good mentor. Verified to work at the fleet level (soak reaches 100%
  competent). If a *majority* collapse at once (pathological init), the median
  itself is low and the `median−1.5·MAD` gate may fail to flag them — the fleet
  then relies on the minority of good cars as mentors. In practice the fleet
  self-heals over hours.
- **Reward-convention dependency** (deviation 2) — the biggest integration risk;
  needs Wave B to feed per-second reward.
- **skill scale vs HUD example** (deviation 2) — cosmetic; Wave C should rescale.
- The lesson `0.8/0.2` blend + 30-min cooldown makes recovery slow (~4 lessons /
  ~2 h in the test before the car crosses into the good basin). This is the LOCKED
  rule; acceptable for a "learns over hours" system but worth noting for tuning.
