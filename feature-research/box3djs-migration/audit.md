# box3d-wasm → box3d.js migration — audit

Facade-stable swap of the physics engine binding from the vendored `box3d-wasm`
wrapper (`file:vendor/box3d-wasm`, integer handles + custom C bridge) to the npm
package `box3d.js` (isaac-mason, embind bindings mirroring the box3d C API 1:1).
The exported surface of `src/core/physics.ts` and its `world` object is unchanged;
all ~16 consumer files needed only their import specifier rewritten.

## Files changed

Created:
- `src/core/box3dWorld.ts` — the new facade. Reimplements `Box3D` / `PhysicsWorld`
  / `TransformBatch` / `BodyType` / `TRANSFORM_STRIDE` / `createBox3D` on box3d.js.

Modified:
- `src/core/physics.ts` — import from `./box3dWorld` instead of `box3d-wasm`; added
  re-exports (`BodyType`, `TRANSFORM_STRIDE`, `TransformBatch`, and the types) so the
  gameplay/vehicle modules depend on the physics facade, not the engine package.
- `package.json` — removed the `box3d-wasm` dependency entry. `box3d.js` added.
  `sync:box3d` script left untouched; `vendor/box3d-wasm/` left on disk.
- `package-lock.json` — updated by `npm install box3d.js`.

Import specifier rewritten (`"box3d-wasm"` → relative `core/physics`), no call-site
changes in any of them:
- `src/gameplay/props.ts`, `exploratorium.ts`, `islands.ts`, `traffic.ts`,
  `loot.ts`, `ropes.ts`, `abandonedMounts.ts`, `aiCars/index.ts`
- `src/vehicles/{car,boat,plane,drone,bird,board}/controller.ts`
- `src/player/walk.ts`

## Consumer surface (facade parity checklist)

External modules import only `BodyType` (value), plus `TRANSFORM_STRIDE` (value) and
`TransformBatch` (type) in `props.ts` / `ropes.ts`. All re-exported from physics.ts.

`physics.world` methods exercised across the repo, all reimplemented with identical
name/signature/return-shape/units/quaternion convention (`[x,y,z,w]` arrays at the
boundary, `1/60` fixed step, `substeps=4`):

createBox, createSphere, createCapsule, destroyBody, step, setBodyTransform,
setBodyVelocity, getBodyTransform, getBodyVelocity, applyImpulse, applyImpulseAtPoint,
applyAngularImpulse, applyForce, explode, getBodySpeed, getBodyMass, setBodyAwake,
isBodyAwake, setBodyGravityScale, setHitEventThreshold, setBodyHitEvents, readHitEvents,
getBodyCapsule, createTransformBatch, createSphericalJoint, createDistanceJoint,
destroyJoint, spawnHuman, fixedTimeStep.
(`humanSetVelocity` / `humanApplyRandomImpulse` are dead in the app — omitted.)

## API mapping (old wrapper → box3d.js)

| old wrapper                         | box3d.js                                             |
|-------------------------------------|------------------------------------------------------|
| integer body handle                 | `b3BodyId {index1,world0,generation}`, wrapped by an int handle + reverse index `key→handle` |
| `_b3w_create_box`                   | `b3CreateBody` + `b3CreateBoxShape` (native box vs old box-hull) |
| `_b3w_create_sphere`                | `b3CreateBody(allowFastRotation)` + `b3CreateSphereShape` |
| `_b3w_create_capsule`               | `b3CreateBody` + `b3CreateCapsuleShape` (local-Y capsule) |
| `_b3w_step_world`                   | `b3World_Step`                                       |
| `_b3w_get_body_transform`           | `b3Body_GetTransform` → `{p, q:{v,s}}`               |
| `_b3w_set_body_transform`           | `b3Body_SetTransform(pos, {v,s})`                    |
| `_b3w_get/set_body_velocity`        | `b3Body_Get/SetLinear+AngularVelocity`              |
| `_b3w_apply_impulse[_at_point]`     | `b3Body_ApplyLinearImpulse[ToCenter]`               |
| `_b3w_explode`                      | `b3World_Explode(b3ExplosionDef)`                   |
| `_b3w_get_hit_events`               | `getEvents` + `getContactHitEventAt`; `b3Shape_GetBody` → reverse index → int handles for bodyA/bodyB |
| `_b3w_get_body_capsule`             | `b3Body_GetShapes`[0] + `b3Shape_GetCapsule`        |
| `_b3w_create_spherical/distance_joint` | `b3CreateSphericalJoint` / `b3CreateDistanceJoint` (`b3Body_GetLocalPoint` for local frames) |
| `_b3w_spawn_human`                  | ported `native/human.c` `CreateHuman` verbatim as `HUMAN_BONES` table (14 bones, head at index 5) built from capsules + spherical/revolute/filter joints |
| batched `_b3w_get_body_transforms`  | JS loop over `b3Body_GetTransform` into an owned Float32Array (box3d.js has no batched C export) |

Defaults preserved exactly from the old wrapper: box friction 0.55 / restitution 0.05;
sphere 0.35 / 0.25 / rollingResistance 0.02 / allowFastRotation; capsule 0.45 / 0.1 /
0.02; density `dynamic?1:0`; spawnHuman frictionTorque 5 / hertz 1 / dampingRatio 0.7;
ragdoll shape rollingResistance 0.2, negative filter group on spine_01/thigh_l/thigh_r
plus thigh_l↔thigh_r filter joint. `|q|!=1` normalize in physics.ts preserved (facade
passes quats through unchanged, as the old bridge did).

## WASM loading

Used the `box3d.js/inline` build — WASM base64-inlined in the JS module (~993 KB),
single-threaded (mt build needs COOP/COEP, out of scope). No separate `.wasm` asset to
serve, which keeps the Railway Docker `dist/` serving trivial. `createBox3D()` awaits
`Box3DFactory()`. `vite build` inlines it cleanly (one warning: the inline module's
Node-only `node:module` branch is externalized to an empty browser stub by Vite — the
browser path never reaches it; verified booting headless). No `vite.config` change was
required and none was made (kept in scope).

## Destroy-order / joint-freeing contract

box3d auto-destroys joints attached to a destroyed body. The app's callers already
notify-before-remove and destroy joints-before-bodies (ropes, props, `onWillRemoveBody`
in main/traffic/aiCars); `destroyJoint` guards with `b3Joint_IsValid` so a joint already
freed by its body's destruction is a no-op. Verified in step (e): destroying ragdoll
bones (which have attached joints) threw nothing.

## Verification (headless Chrome via CDP, own vite on :5206, relay on :8790)

Driven through `window.__sf` with the rAF loop frozen (`__sfManual(true)`). The WIP
`aiCars` learner throws at runtime independently of this migration (see risks); it was
monkeypatched to no-op in-test to isolate physics.

- (a) BOOT — `__sf` present, physics initialized, **0** physics/box3d/wasm console errors.
- (b) WALK — teleport to street, `walk` mode, hold KeyW 10 s: moved **51.6 m** horizontally,
  y stayed **69.87–69.97** (did not fall through the world), no NaN. (capsule body path)
- (c) DRIVE — `drive` mode, throttle 5 s: forward displacement **143 m** (> 15 m gate),
  no NaN in position or quaternion. (box body + setBodyVelocity + getBodyTransform)
- (d) TRAFFIC — at a downtown street 6 NPC cars spawned; of survivors sampled, all moved
  > 0.3 m over 3 s, no NaN. (createBox + setBodyVelocity + getBodyTransform)
  aiCars (24-car fleet) NOT verifiable — pre-existing WIP learner bug + needs 2-client
  leader election; see risks. The physics side (car bodies) is proven by traffic.
- (e) JOINTS / RAGDOLL / CAPSULE — `spawnHuman` returned **14** bones; head (index 5)
  capsule matches `human.c` exactly (`center1≈{-1e-6,0.016892,-0.05869}`, r=0.0975);
  ragdoll fell under gravity, no NaN; `createTransformBatch` returned stride-8
  (14×8=112); `destroyBody` on jointed bones threw nothing. (spawnHuman + capsule +
  spherical/revolute/filter joints + batch + destroy-frees-joints)
- (f) PROJECTILES — `fireProjectile` created a bullet sphere (gravity scale + velocity +
  hit events), 60 steps, no error. (createSphere + setBodyGravityScale + sweep)
- Hit-events — fast dynamic box into a static box (both hit-enabled): `readHitEvents`
  returned 1 event with correct `bodyA`/`bodyB` **int handles** and `approachSpeed=40`.
  Proves the events-buffer read + `b3Shape_GetBody`→reverse-index mapping (the path
  `#handleHit` / destruction relies on).

### (g) Perf

In-app (browser, dev, downtown): `world.step(1/60,2)` **0.029 ms**; full
`physics.step` (carpet + building bodies + projectile sweeps + hit events)
**0.119 ms**.

Node A/B, identical scene (800 static + 300 dynamic boxes, 300 steps, 3 runs),
old box3d-wasm vs new box3d.js facade:

| path                         | old      | new      | new/old |
|------------------------------|----------|----------|---------|
| `step`                       | ~0.15 ms | ~0.14 ms | **0.7–0.9x** |
| `getBodyTransform` ×300      | ~0.03 ms | ~0.3 ms  | ~8–11x  |
| `TransformBatch.read` ×300   | ~0.01 ms | ~0.25 ms | ~24–30x |

`step` (the dominant physics cost, same underlying C engine) is on par or slightly
faster — comfortably within the 1.5× gate. The read paths regress because box3d.js
embind returns freshly-allocated nested JS objects per `b3Body_GetTransform`, whereas
the old wrapper had a single batched WASM→HEAPF32 reader; box3d.js exposes no batched
transform export. Absolute cost is small (~0.3 ms for 300 bodies/frame; the app's live
debris/props/rope batches are typically far smaller). Mitigation applied: dropped the
per-body `b3Body_IsAwake` call from the batch (index-7 awake flag is unused by every
consumer), which roughly halved batch cost. Further reduction would need box3d.js to
add a batched C transform export.

## Behavior deltas noticed

- Boxes: native `b3CreateBoxShape` vs the old bridge's box-hull. Physically identical
  for a box; simpler.
- Read-path allocation cost (above) — the one real regression, inherent to box3d.js.
- The `human` handle from `spawnHuman` is now an opaque id (velocity/impulse human
  helpers are dead code in the app); bones and their behavior are unchanged.

## Open risks

- **Concurrent in-flight work broke the tsc gate (not this migration).** `npm run build`
  (tsc + vite) PASSED with the full migration in place earlier. On re-run, two errors
  appear, both in files another task is editing live and both unrelated to physics:
  `src/world/sky.ts` (a TSL/three overload error; the error line moved 408→410 between
  two of my tsc runs — it is being edited live) and `src/gameplay/aiCars/index.ts:127`
  (a `Trainer`/`Learner` type mismatch — the WIP learner refactor; same code that throws
  `#learner.actorForward/skill is not a function` at runtime). My files
  (`box3dWorld.ts`, `physics.ts`) and my import rewrites are type-clean. I did not touch
  sky.ts, aiCars beyond its import line, or any of the other files showing as modified
  (config.ts, persist.ts, main.ts, net.ts, ui/debug.ts, ui/minimap.ts, server.mjs).
- **aiCars 24-car verification (step d) could not be completed** for the same reason
  plus its dependence on 2-client leader election. The physics-body side is proven via
  the traffic system.
- `box3d-wasm` remains in `node_modules` (dep entry removed from package.json but
  `npm install` was not re-run to avoid disturbing node_modules while other tasks are
  in flight). `vendor/box3d-wasm/` intentionally left on disk. `sync:box3d` untouched.
- `vite.config` still has a stale `optimizeDeps.exclude: ["box3d-wasm"]` and an
  `fs.allow` entry for the old package — harmless, left untouched to stay in scope.
