# AI Cars — Agent C audit (integration into the running app)

## Files changed

Created:
- `src/gameplay/aiCars/index.ts` — the `AiCars` facade (browser adapter + fleet/trainer/overlay wiring + mesh mirroring). ~250 lines.
- `src/gameplay/aiCars/statsChip.ts` — bottom-left HUD readout `🧠 cars gen N · best F · mean F`. ~55 lines.

Modified:
- `src/gameplay/aiCars/fleet.ts` — added a per-car `lastObs` snapshot (3 tiny edits, see Deviations). Agent A's module; change is additive and documented.
- `src/main.ts` — 6 minimal wiring edits (import, construct, releaseBody hook, prePhysics, update, `__sf`).

Not touched: policy.ts, roadGraph.ts, trainer.ts, carMesh.ts, brainOverlay.ts, src/net/, server/, index.html.

## What changed, per file

### src/gameplay/aiCars/index.ts (new)
`AiCars` facade per plan.
- `constructor(physics, map, scene, getCamera)` — stores refs; builds nothing yet.
- `ready()` — async: `RoadGraph.load()`, then `Trainer.loadSaved()` (restores the
  localStorage pool), `new Fleet(buildWorld(), roads, trainer)`, `BrainOverlay(scene,
  CAR_SIZES, fleet.cars.length, getCamera)`, `StatsChip`. Called fire-and-forget from
  main.ts (`void aiCars.ready()`); load failure logs and leaves AiCars inert. No cars
  until it resolves.
- `#buildWorld()` — the deviation-3 adapter: `ground → map.effectiveGround`,
  `isWater → map.isWater`, `sweep → physics.sweepBuildings` converted to a distance
  from p0, `createBody → physics.world.createBox({type: BodyType.Kinematic,…})` +
  `setBodyTransform`, `moveBody → setBodyTransform`, `removeBody → destroyBody`.
- `prePhysics(dt, anchors)` — forwards to `fleet.prePhysics` (guarded on ready).
- `update(frameDt, playerPos, highUp)` — for each car: remove mesh of a dead car
  (and hide its overlay); lazily `buildCarMesh(bodyKind, paintHue)` + cache wheel refs
  for a new car; mirror pos + yaw + ground-normal tilt onto the group (reused temp
  quats/vecs, matches the fleet body construction); roll all wheels by `speed/radius`
  and steer the front pair by `car.steer`; overlay.update for cars within 130 m
  (worldPos = car top + 0.9) else overlay.hide. Overlays gated off when `highUp` or
  `setOverlays(false)`. HUD chip refreshed at 1 Hz from `fleet.stats()`.
- `stats()`, `setOverlays(on)`, `exportPool(topK?)`, `importPool(blob)`, `dispose()`,
  `onWillRemoveBody` (forwarded into the fleet).

No per-frame allocations in `update`: all vectors/quaternions are reused instance
fields; the anchors array is created once in main.ts.

### src/gameplay/aiCars/statsChip.ts (new)
A `div.ai-cars-chip` appended to `#hud` (falls back to body). Injects a one-time
`<style>` giving it `#hud.faded .ai-cars-chip{opacity:0}` so it participates in the
Tab HUD-fade with no index.html edit. Hidden (`display:none`) until the first
`set()`. Styling matches the existing chip conventions (system-ui, translucent dark
pill, subtle border, text-shadow).

### src/gameplay/aiCars/fleet.ts (modified — additive)
The LOCKED `BrainOverlay.update(carId, worldPos, layerOut, obs)` needs the real
per-car observation for its input column, but the fleet's `#obs` is a single private
buffer overwritten for every car every step, so it can't be exposed as-is. Added a
per-car `lastObs: Float32Array` (declared on the `AiCar` type, allocated in the
ctor, filled with `car.lastObs.set(o)` right after the 9 sensors are written). Three
localized edits, no behavior change to the sim.

### src/main.ts (modified — 6 edits)
- import `AiCars` from `./gameplay/aiCars/index.ts`.
- construct beside `traffic`: `const aiCars = new AiCars(physics, map, scene, () => camera); void aiCars.ready();`
  plus `const aiCarAnchors = [player.position];` (stable ref, no per-frame alloc).
- `aiCars.onWillRemoveBody = releaseBody;` beside the traffic hook (ropes/grab release
  before a kinematic body is destroyed).
- fixed loop: `aiCars.prePhysics(physics.world.fixedTimeStep, aiCarAnchors);` beside
  `traffic.prePhysics`.
- render loop: `aiCars.update(frameDt, player.position, highUp);` beside `traffic.update`.
- `__sf` global gains `aiCars`.

## Deviations from the plan

1. **fleet.ts `lastObs` (documented above).** The plan said not to modify sibling
   modules "unless a real bug blocks integration". Passing a fabricated obs to the
   overlay isn't a crash, but it would make the 9-node input column show static
   garbage — degrading the core "live activations" visual. The correct source is the
   fleet's per-step obs, and its shared buffer can't be exposed safely, so the minimal
   honest fix is a per-car snapshot. Kept to 3 additive edits.
2. **HUD chip parented to `#hud` with an injected CSS rule** rather than an
   index.html edit, so the Tab HUD-fade works and index.html stays untouched (outside
   my file scope). This satisfies the "respect Tab-fade if trivially easy" ask.
3. **No `import * as THREE` needed for a sweep-result temp** — `sweepBuildings`
   returns its own Vector3; the adapter reads it inline and returns a scalar distance.

## Test results

- `npx tsc --noEmit` — **exit 0** (strict + noUnusedLocals), clean before and after.
- Headless end-to-end (own vite on **:5202**, system Chrome `--headless=new
  --use-angle=metal --enable-unsafe-webgpu`, raw CDP from Node, `?fullfps&autostart`):
  - `__sf.aiCars` exists; `stats()` returns `{gen,bestFit,meanFit}`.
  - Fleet populates: **24 alive cars** with meshes in the scene after teleport to a
    Mission-grid street (1500,-300).
  - **Movement**: sampled 6 car positions every ~3 s sim; 4–6 of 6 moved >0.3 m each
    round — cars are driving, not frozen.
  - **Gen progression**: gen advanced **0 → 1 → 2** within a ~40 s sim burst, and to
    **gen 5** over the longer session; best fitness climbed 2.66 → 92.9 → **292.4** in
    the Mission area (fitness resets its window after a teleport relocates the fleet —
    expected).
  - **Frame time**: mean **2.11 ms per full tick** (whole-frame render, not just cars)
    over 30 synchronous ticks — no fps collapse; cars/overlays are a small slice.
  - **Console**: 0 exceptions / 0 error events over 120 ticks.
  - HUD chip DOM verified: `🧠 cars gen 5 · best -0.0 · mean -0.3` (correct format;
    it's a child of #hud so it's occluded in headless GPU-canvas captures — a known
    headless artifact per the CDP-verify memory, not a runtime bug).
- Screenshots (in scratchpad):
  - `integration_carcam.png` — **money shot**: a blue pickup + a van on a street,
    each with a floating brain lattice overhead (9-node input column, cyan/white
    activations, fanned edges).
  - `integration_cars.png` — player settled on a Mission street, 3 cars within 130 m,
    3 lattices visible.
  - `integration_street.png` — initial teleport frame.

## Open risks / notes

- localStorage pool persists across the headless profile: after a teleport the fleet
  respawns in a new area and the trainer's recent-fitness window dips before recovering
  — normal online-GA behavior, not a regression.
- Kinematic car bodies are created via the adapter but intentionally NOT registered as
  vehicles (no chip/fracture on contact), matching Agent A's design.
- Overlay billboarding uses the live camera each update; in a frozen/manual capture the
  lattice faces the camera position at the last `update()` call.
- Agent D (multiplayer/persistence/deploy) is untouched here; `exportPool`/`importPool`
  passthroughs are in place for it.
