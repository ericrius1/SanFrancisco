# Horse RL — Handoff (galloping is the open problem)

You're picking up an RL project in a Three.js/WebGPU game (`/Users/eric/codeprojects/sanfrancisco`).
A herd of 20 horses lives on a raised paddock in Golden Gate Park. Each horse is an
**active-ragdoll quadruped** (box torso + 4 two-segment capsule legs) driven by a tiny
neural-net policy, trained with **Evolution Strategies against `box3d-wasm` physics headless in
Node** — same engine runs in the browser, so zero sim-to-real gap. There is NO JAX/MuJoCo/GPU.

**The one thing still not good: the GALLOP.** Walk/trot look fine and are stable. The "gallop"
is a slightly-faster **upright shuffle** (~2 m/s, legs barely reaching), not a powerful bounding
gallop. The owner wants a gallop that *looks* like a gallop. Everything below is about that.

---

## Run things (all Node, `--experimental-strip-types`, `.ts` extensions required)

```bash
cd /Users/eric/codeprojects/sanfrancisco
# EVALUATE a policy (THE source of truth — a rich gait-quality score 0-100):
POLICY=public/models/horse_policy.json node --experimental-strip-types rl/tools/evalGait.ts
# TRAIN (writes public/models/horse_policy.json by default):
node --experimental-strip-types rl/train.ts --creature horse --warm --gens 200 --pairs 64 --steps 480
#   env knobs: CONFIG=<tuning.json> (gait config), OUT=<path> (output policy), WARM=<path> (warm source)
# BROWSER GROUND TRUTH (headless WebGPU, reads the REAL in-world sim) — TRUST THIS OVER NODE:
SF_VERIFY_SECONDS=14 SF_VERIFY_GAIT=0.8 node tools/paddock-verify.mjs   # forces all horses to gallop; frames+summary in .data/paddock
# RECURSIVE SEARCH (evolutionary config search, described below):
GENS=100 POP=6 PARALLEL=5 ROUNDS=12 node rl/meta/search.mjs
```
Kill training before relaunching: `pkill -f train.ts`. Read frames with the Read tool (they're JPEGs).

---

## The system (files)

- `src/creatures/quadruped.ts` — **THE shared brain** (imported by Node trainer AND browser; dep-free).
  Contains `HORSE` spec, `observe()` (obs=23), `decode()` (joint torques), `advancePhase()` (CPG),
  `reward()`, and **`GaitTuning` + `setTuning()`/`getTuning()`** (see below).
- `src/creatures/policy.ts` — tiny MLP [23,32,32,14]. `PolicyDef.tuning` field carries the gait config.
- `rl/core/box3dEnv.ts` — training env (ragdoll build, reward, per-episode gait-speed sampling, balance shoves).
- `rl/train.ts` — ES trainer. Reads `CONFIG`/`OUT`/`WARM` env. Saves the tuning INTO the policy json.
- `rl/tools/evalGait.ts` — **RICH evaluator. Use this, not the old gaitTest.** Scores per gait: speed,
  **stride** (hip fore-aft swing), **bound** (torso vertical oscillation — a gallop has flight),
  upright-cleanliness, fall, + a sharp-turn probe. Prints a `SCORE:{json}` line. Composite 0-100.
- `rl/meta/search.mjs` — the recursive search (evolutionary loop over gait configs).
- `src/gameplay/horse/horseRagdoll.ts` — in-world runtime (private box3d world per horse). Applies
  `policyDef.tuning` on construction so the in-world gait replays exactly as trained.
- `src/gameplay/horse/horseHerd.ts` — 20-horse herd, wander/ride, **show-jumping gate course**
  (built + working), fall→lie-limp-10s→reset.
- `tools/paddock-verify.mjs` — headless-WebGPU browser harness; reads `window.__sf.horseHerd.debugStates()`.

### The config system (`GaitTuning`)
Every gait knob is a searchable parameter in `DEFAULT_TUNING` (quadruped.ts). `setTuning(cfg)` overrides
them; `train.ts` sets it from `CONFIG` and **saves it into the policy json** (`PolicyDef.tuning`); the
runtime (`HorseRagdoll` ctor) applies it. So a policy always replays the exact gait it was trained under.
Knobs: `freqBase/freqSpan` (cadence vs speed), `strideBase/strideSpan` (stride vs speed),
`actFreqAuth/actStrideAuth/actKneeAuth` (policy authority over CPG), `speedMatchA` (reward speed-match
sharpness), `progressW` (reward progress weight), `tallFloorSlope/doneFloorSlope/uprightSoften`
(how much the upright/height gate relaxes at high speed), `maxTorqueScale` (joint power). Defaults
reproduce the currently-deployed policy exactly (evalGait = 69.0).

---

## Scores + policies (current, as of handoff)

- Deployed `public/models/horse_policy.json` — **gait score 69.0**, browser-verified STABLE (walk/gallop
  ~5% fall, roaming 0% fall) but the gallop is the weak shuffle.
- `public/models/horse_policy.good.json` — same 69.0 policy, the **safe restore point** (browser-verified).
- `rl/runs/search/best.policy.json` + `best.cfg.json` — search best so far, **gait score 86.5**
  (gallop speed 0.52, more stride/bounce, turn-stable). NOT yet deployed. **Verify in browser before deploying.**
- A background **search is running** (`ps aux | grep search.mjs`; leaderboard at
  `rl/runs/search/leaderboard.log`). Kill with `pkill -f search.mjs` when you want the CPU.

Non-dim speeds are Froude: `V = sqrt(9.81 * standHeight) ≈ 4.0 m/s` at the in-world SCALE 2.3.
So walk cmd 0.25 = 1 m/s, gallop cmd 0.8 = 3.2 m/s (target); achieved gallop is only ~0.45-0.52 (~2 m/s).

---

## What's been learned (don't relearn these the hard way)

1. **The old `gaitTest` graded blind** ("upright + moving?") so a stable shuffle "passed." That's why
   manual tuning went nowhere. `evalGait.ts` grades stride/bound/speed/turn — **always judge with it.**
2. **Pure RL will NOT separate gaits.** Five reward variants (sharper speed-match, bimodal sampling,
   curriculum, etc.) all collapsed walk+gallop to one ~0.5V compromise trot. The fix was **hard-wiring
   speed→cadence+stride in the CPG** (`advancePhase`/`decode` read `state.targetSpeed`). That gives a
   genuinely slow walk and a distinct gallop. Keep this; don't go back to pure-RL speed conditioning.
3. **Gallop speed caps ~0.45-0.55V across every reward/CPG config** in the search. This is a **structural
   limit**, not a tuning problem. A config CAN hit gallop 0.60 but only by breaking the walk.
4. **More training matters a lot**: 80 warm gens took the score 69→86 and fixed sharp-turn falls (those
   were under-training, not a bug). Search runs are 80-100 gens (enough to rank); the winner needs a
   **long final run (250+ gens)**.
5. **The recursive search works** (`rl/meta/search.mjs`): population of gait configs, train each in
   parallel (warm from `good.json`), score with evalGait, keep elites + **the best-gallop specialist**
   (multi-objective — otherwise the composite score buries the fast-gallop lineage), mutate. It found
   that `strideSpan≈1.6, speedMatchA≈5.4 (soft), maxTorqueScale≈1.1, low actStrideAuth` = faster gallop.
6. **Verification honesty**: the Node evaluator is a proxy. The Node gate lied before (called a shuffle
   "PASS"). **Always confirm the final policy in the browser** via `paddock-verify.mjs` and by looking at
   the frames. `meanUp` "not fallen" ≠ "looks like a horse."

---

## Best next steps (ranked — start at the top)

### 1. TOP HYPOTHESIS — the gallop FOOTFALL pattern (untested, likely the real fix)
The CPG uses a fixed **lateral-sequence WALK footfall for every gait** (`spec.legs[].phase` =
HL 0, FL π/2, HR π, FR 3π/2, a quarter-cycle apart). **No amount of speed-scaling turns a walk
footfall into a gallop.** A real gallop is a **half-bound / rotary**: hind pair push ~together, then
front pair reach ~together, with a suspension. This was about to be implemented and is the most likely
lever left.
- **Where:** `decode()` in `quadruped.ts`, the line `const gaitPhase = phase + spc.phase + action[...]*π`.
- **How:** add a `gallopBlend` knob to `GaitTuning`. Compute a gallop offset per leg from hip position
  (`isFront = spc.hip[2] > 0`, `isRight = spc.hip[0] > 0`), e.g. `gallopOffset = (isFront?0.55π:0) + (isRight?0.12π:0)`.
  Blend `spec.legs[].phase → gallopOffset` by `gallopBlend * clamp((targetND-0.45)/0.4, 0, 1)` so the
  footfall shifts toward the gallop pattern ONLY at high commanded speed (walk stays the walk sequence).
  Default `gallopBlend = 0` (backward compatible). Then add `gallopBlend` (range ~0..1) to the search
  space in `rl/meta/search.mjs` (`SPACE`) and re-run the search. Also try a hind-knee "push" bias at gallop.
- **Watch:** the `kneeLag`/knee timing may also need to shift for a bound (hind legs extend to push).

### 2. Body geometry (second lever)
Add leg-length / proportion knobs (thigh+shank `halfHeight`, `standHeight`) as searchable params
(currently only `maxTorqueScale` varies the body). Longer legs = longer stride + taller = faster gallop.
CAUTION: `standHeight` must track leg length (it feeds `spawnY` and the Froude `V`); and the in-world
horse MESH is dressed on the ragdoll capsules in `horseHerd.ts` — verify hooves/legs still line up after
a geometry change (headless evalGait won't show mesh mismatch; the browser will).

### 3. Deploy + long-run the current search winner (quick win, do in parallel)
`best.policy.json` (score 86.5) is already better than deployed (69). Give its config a long final run,
then **browser-verify the gallop**, then deploy:
```bash
node --experimental-strip-types rl/train.ts --creature horse --warm --gens 300 --pairs 64 --steps 480 \
  CONFIG=rl/runs/search/best.cfg.json OUT=public/models/horse_policy.candidate.json WARM=public/models/horse_policy.good.json
POLICY=public/models/horse_policy.candidate.json node --experimental-strip-types rl/tools/evalGait.ts
SF_VERIFY_GAIT=0.8 SF_VERIFY_SECONDS=14 node tools/paddock-verify.mjs   # LOOK at .data/paddock frames
# if it looks good: cp public/models/horse_policy.candidate.json public/models/horse_policy.json
```
Keep `good.json` as the restore point — never deploy something worse than 69 without a browser check.

### 4. Spine flex (harder, speculative)
Real quadrupeds gallop by flexing the SPINE (the body lengthens/shortens each stride for reach). The
box torso is rigid. Options: a 2-segment torso with a sprung mid-joint, or a "virtual reach" that shifts
hip anchor positions fore/aft at gallop. Big change; only if 1-3 plateau.

---

## Gotchas
- `node --experimental-strip-types` + relative imports need `.ts` extensions. `tsconfig` has
  `allowImportingTsExtensions`.
- Kill `train.ts` before relaunching (multiple runs clobber the same output). Laptop SLEEP wedges a run
  (it hung once, 4h lost) — `train.ts` checkpoint-saves every 15 gens so the deployed policy stays recent.
- `SCALE = 2.3` in-world (`horseHerd.ts`); training domain-randomizes scale (Froude non-dim obs/reward
  make one policy work at any size). `bullet: true` (CCD) on ragdoll bodies stops ground tunneling — keep it.
- `.data/` is gitignored. Session work is currently UNCOMMITTED on `main` (owner interrupted a commit —
  ask before committing; branch first if you do).
- The show-jumping gates, jump (rider Space), fall→lie-10s, no-tunneling, walk/trot are all DONE + verified.
  Only the gallop quality is open.

**First move I'd make:** implement the footfall-blend knob (#1), add it to the search space, kill the old
search, and relaunch. That's the highest-probability path to a gallop that actually looks like one.
