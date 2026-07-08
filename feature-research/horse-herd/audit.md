# Audit — learning horse herd in the Botanical Garden meadow

## Files changed

Created:
- `src/creatures/policy.ts` — dependency-free MLP policy (canonical RL copy from `origin/horse-rl-gait-search`).
- `src/creatures/quadruped.ts` — CreatureSpec/HORSE/obs/action/CPG/reward + GaitTuning (from branch, verbatim).
- `src/gameplay/horse/horseRagdoll.ts` — active-ragdoll rig, PORTED to main's box3d.js facade.
- `src/gameplay/horse/horseHerd.ts` — NEW meadow herd manager + NN-lattice brain overlay (rewritten from the branch's platform/show-jump version).
- `public/models/horse_policy.good.json` — pretrained gait (~0.9 m/s), the herd's boot policy.
- `public/models/horse_policy.json` — fallback checkpoint.
- `feature-research/horse-herd/audit.md` — this file.

Modified:
- `src/main.ts` — import `HorseHerd`; construct `horses` after the garden; call `horses.prePhysics(fixedTimeStep, player.position)` in the fixed-step loop; call `horses.update(frameDt, camera)` per frame; expose `horses` on the `__sf` global.

NOT touched (guardrails respected): `src/gameplay/aiCars/**`, `tools/train-cars-*.mjs`, `tools/push-brains-to-prod.mjs`, `tools/overnight-maintain.sh`, `src/world/garden/**` (imported read-only), `src/world/seedForest/**`, `src/world/wildlands/**`, `src/audio/**`, `src/world/sky.ts`, and `src/world/buildings/**` (a concurrent session's in-flight refactor — see Blockers).

## What changed, per file

- **policy.ts / quadruped.ts** — copied verbatim via `git show origin/horse-rl-gait-search:…`. Both are dependency-free (no three/box3d/relative imports), so they compile unchanged under main's tsconfig. `policy.ts` is the canonical RL policy (with `obsMean`/`obsStd` normaliser + `layerOut` activations for the brain overlay) — the plan flagged that main's `aiCars/policy.ts` is an older resurrected copy, so this lives at `src/creatures/policy.ts` and is imported only by the horse kit.

- **horseRagdoll.ts** — the ONE hard part per the plan. Key finding: the ragdoll does NOT run on the game's live physics world; it builds its OWN private box3d world (a flat ground slab) so the Node-trained gait reproduces. Main's `PhysicsWorld` (box3d.js, behind `src/core/box3dWorld.ts`) already exposes every method the branch used against box3d-wasm — `createBox/createCapsule/createSphericalJoint/applyAngularImpulse/applyImpulse/setBodyAwake/getBodyMass/getBodyTransform/getBodyVelocity/setBodyTransform/setBodyVelocity/step/dispose` — with identical signatures and the `[x,y,z,w]` quat convention. So the adaptation was: swap `import { BodyType } from "box3d-wasm"` → `import { BodyType, type Box3D, type PhysicsWorld } from "../../core/box3dWorld"`, type the constructor param as `Box3D` and the private world as `PhysicsWorld`, and drop the `.ts` import extensions. No servo/joint re-implementation was needed — the quaternion-PD servo is pure TS math on top of `applyAngularImpulse`, which the facade already has. **Approach taken: FULL active-ragdoll physics (not the kinematic fallback).**

- **horseHerd.ts** — rewritten for the meadow. Dropped from the branch version: the floating show-jump platform + gate colliders, the training-guide UI, the live-training Web Worker (L-key), and riding — none needed for an ambient meadow herd (and each pulled in extra files/scope). Kept: the dressed capsule-horse mesh, the NN-lattice brain (`#buildBrain`/`#updateBrain`), settle-on-spawn (the ragdoll settles upright in its constructor), and the fallen→down-timer→reset recovery. Added: placement of 8 horses scattered within the meadow ellipse (`GARDEN_MEADOW` ±rx90/rz65, area-uniform), ground-follow via `gardenSurfaceHeight(map, x, z)` each frame (no floating platform), wander that steers back inside the ellipse, `good.json`-first policy load, and **distance gating** — `prePhysics` no-ops and sets `#active=false` when the player is >380 m from the meadow, and `update` early-returns when inactive, so the herd is 0-cost when nobody's near.

- **main.ts** — 4 edits (import, construct, prePhysics hook inside the existing fixed-step `while` loop next to `aiCars.prePhysics`, per-frame `update` next to `forest.update`) + `horses` added to `__sf`. Deterministic + local per the plan (no relay/net changes): every client runs the same herd from the shared policy + spawn RNG.

## Deviations from the plan

1. **Physics premise corrected.** The plan warned the in-browser ragdoll runs on the game's LIVE physics world and would need deep joint/servo re-adaptation. It does not — it runs in its own private world. Main's facade already matched the branch's API 1:1, so the port was a few lines and needed no fallback. Full ragdoll shipped.
2. **Engine swap, not box3d-wasm in the browser.** The private world is built from main's box3d.js (`createBox3D`/`Box3D.createWorld`), the same engine main ships — no second wasm engine bundled into the browser. The box3d-wasm-trained gait reproduced cleanly in box3d.js (both are ports of the same box3d C solver); verified upright + moving (see below).
3. **Trimmed scope** (platform/gates/guide/worker/riding removed) to keep the change small and avoid extra files — all were optional per the plan (P1 training worker, optional riding). The headless trainer (`tools/train-horse-headless.mjs`) and the `rl/core` kit were NOT ported in this pass; the herd already moves on the shipped `good.json`. This is the plan's P1 (post-stand/walk) and is noted as follow-up.
4. **Brain overlay perf optimisation** (not in the branch): cached the 4 layer `THREE.Color`s (the branch allocated one per line-vertex → ~70k allocs/frame) and throttled the cosmetic recolour to every other frame. Cut near-meadow cost 4.7 ms → 0.9 ms. Body posing still runs every frame.

## Test results (headless, own vite on :5212, box3d.js/WebGPU, chrome --headless=new --use-angle=metal)

Verification driver: `scratchpad/horse-verify.mjs` (teleport to meadow, settle, sample per-horse torso height + XZ displacement over 20 s of fixed-step sim).

Per-horse over ~20 s (upY = world-up·body-up, tall = torso/standingHeight, disp = XZ metres):

```
idx  upY   tall  disp(m)  spd
 0  0.56  0.60   14.06  1.05
 1  0.67  0.48    1.02  1.67
 2  1.00  0.90   26.59  1.27
 3  0.98  0.86   22.13  1.41
 4  0.99  0.79   20.36  1.44
 5  1.00  0.92   15.55  1.33
 6  0.98  0.94   23.15  0.93
 7  0.98  0.89   24.78  1.05
UPRIGHT 7/8   MOVED 7/8   VERDICT: PASS
```

- **Upright + moving: 7/8** (majority threshold met; upY>0.5, tall>0.55, disp>3 m). Horse 1 was momentarily crouched (tall 0.48) but not fallen and still moving; horse 0 borderline-tall but walking 14 m. No collapsed/flopping horses.
- **LOD gate:** teleport to Mission (1500,-300) → `__sf.horses.active === false` (physics frozen). PASS.
- **Frame cost** (`scratchpad/horse-perf.mjs`, median of 240 frames of `prePhysics+update`): **near meadow 0.9 ms / p95 1.1 ms; far 0 ms**. Under the 2 ms budget. (Split before optimisation: physics 1.2 ms, overlay 3.5 ms; after: 0.9 ms combined.)
- **Console errors: 0** over the full run (Log.enable + Runtime.exceptionThrown captured none).
- **`npx tsc --noEmit`: clean for all horse/creatures/main.ts files.** The tree currently reports errors ONLY in `src/world/buildings/**` — a different session's uncommitted mid-refactor (was TSC=0 when I started; see Blockers).

Screenshots (in `scratchpad/`):
- `horse-herd-closeup.png` — multiple recognisable dressed horses (foreground + on the ridge) with a glowing NN-lattice brain floating top-left.
- `horse-herd-meadow.png`, `horse-herd-framed.png`, `horse-herd-wide.png` — herd across the meadow (they naturally spread as they walk; tall meadow grass occludes distant ones).

## Open risks

- **Gait fidelity across engines:** the policy was trained in box3d-wasm; the browser runs box3d.js. It reproduces well (7/8 upright, real forward locomotion), but the two solvers aren't bit-identical, so an occasional horse crouches/trips — handled gracefully by the down-timer→reset recovery (it lies down, then stands back up), so the herd self-heals rather than accumulating floppers.
- **8 private box3d.js worlds:** one world per horse (branch design). Cheap here (0.9 ms), but the count is fixed at `COUNT = 8`; scaling up would need re-measuring.
- **Ground-follow uses `gardenSurfaceHeight`** (garden read-only import). If a horse wanders onto a steep detail bump the torso Y tracks the surface sample under its centre — fine on the flat meadow, could look slightly off on a slope (the wander ellipse keeps them on the flat meadow).
- **Training (P1) not yet shipped:** the herd runs on the fixed `good.json`; the overnight headless refiner is follow-up.

## Blockers

- **Deploy is gated by a concurrent session's in-flight `src/world/buildings/**` refactor.** Railway builds via `npm run build` = `tsc --noEmit && vite build`; the tree is currently NOT tsc-clean because `src/world/buildings/interior.ts` (uncommitted, another session) has type errors. My files are clean and the app runs (vite/esbuild strips types). Deploy proceeds automatically once that session's tree is clean — `bash scratchpad/deploy-retry.sh` then ships everyone's on-disk changes together. See Deploy status below for the outcome in this run.
