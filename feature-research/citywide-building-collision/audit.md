# Audit — citywide building collision for AI cars

## Files changed
- `src/core/buildingBodies.ts` (NEW) — pure, THREE-free multi-anchor candidate selection.
- `src/core/buildingColliderIndex.ts` (NEW) — citywide baked-OBB streamer, decoupled from the visual TileStreamer.
- `src/core/physics.ts` — multi-anchor `#updateBuildingBodies`, index wiring, `sweepBuildings` sees the index.
- `src/gameplay/aiCars/index.ts` — new `anchorPositions()` accessor + two pooled fields.
- `src/config.ts` — `carColliderRadius: 60`, `maxActiveBuildingBodies: 240 → 700`.
- `src/main.ts` — one line registering the anchor provider.
- `tools/collision-probe.mjs` (NEW) — headless acceptance probe.

## The bug (confirmed)
Building static bodies (and, in multiplayer, the collider DATA itself) only existed within
`CONFIG.colliderRadius` (260 m) of the HUMAN player. `#updateBuildingBodies(playerPos)` ranked
buildings around the player only, and `#tileColliders` is populated solely by the visual
`TileStreamer` around the player. So:
- Solo: a car in its NEAR tier (up to `NEAR_R` = 380 m from the player) has a kinematic body but
  no building static body existed past 260 m → it drove through walls in the 260–380 m band.
- Multiplayer: the leader sims cars anchored around REMOTE players (thousands of metres away). The
  leader's visual tiles are only around its own player, so those regions had zero collider data —
  `sweepBuildings` returned clear and no bodies materialised → cars clipped straight through.

## What changed, per file

### src/core/buildingBodies.ts (new, pure)
`selectBodyCandidates(anchors, tiles, budget, isAlive, tileReach)` — ranks every alive building box
within ANY anchor's radius by its min wall distance to any anchor, dedups by `key:i:s`, caps at
`budget`. Plus `obbPlanarDistance`, `obbContainsXZ`, `anchorHold` (eviction hysteresis). No THREE /
DOM, so it bundles into the Node probe and unit-tests directly.

### src/core/buildingColliderIndex.ts (new, browser)
`BuildingColliderIndex` loads the same baked `public/data/colliders/tile_*.json` OBBs the visual
streamer uses, but on a coarse wide grid around EVERY anchor, independent of what's rendered.
Reuses the existing `colliderWorker.ts` (Vite emits it as one shared chunk) so fetch + parse + trig
patch stay off the main thread. Loads tiles within `half + 160 m` of any anchor, evicts past
`half + 460 m`, throttled to 2 fetches/update. `init()` is best-effort; a failed manifest load
leaves the index null and physics falls back to visual-only (prior behaviour).

### src/core/physics.ts
- `create()` builds + `init()`s the index (try/catch → graceful null).
- `setColliderAnchors(provider)` — main.ts registers AI-car positions.
- `#gatherAnchors(playerPos)` — player as anchor #0 (`colliderRadius`), each provider point at
  `carColliderRadius`. Reused array, no per-tick alloc.
- `#mergedBodyTiles()` — visual tiles (alive-gated) + index-only tiles (keys the player can't see).
- `#updateBuildingBodies` — calls `#colliderIndex.update(anchors)`, then `selectBodyCandidates` over
  the merged source; eviction uses `anchorHold` (min dist to any anchor whose ×1.35 outer band still
  covers it) with the same budget-cutoff hysteresis; the "don't spawn a box around an anchor already
  inside it" guard now checks ALL anchors via `obbContainsXZ`.
- `sweepBuildings` → `#sweepTiles(map, gate, …)` run twice: visual (alive-gated) then index-only
  (skipping keys already in the visual map). This is what lets a far-off AI car's STEERING see walls
  before the body materialises.

### src/gameplay/aiCars/index.ts
`anchorPositions()` returns the live positions of cars that own a kinematic body
(`bodyHandle !== 0`), pooled (no alloc). Only bodied (NEAR) cars are returned — FAR cars integrate
kinematically with road-estimate sensors and have no body to collide, so anchoring them would only
waste the budget. Ghost (non-leader) clients run no local sim → return empty.

### src/main.ts (the single edit)
```ts
physics.setColliderAnchors(() => aiCars.anchorPositions());
```
Added immediately after `void aiCars.ready();` (line ~266).

### src/config.ts
`carColliderRadius: 60` (a car moves ~2.8 m between the 5 Hz body updates; 60 m is ample look-ahead),
`maxActiveBuildingBodies` raised `240 → 700` (static AABBs are ~free in the box3d broadphase; 700
covers the player plus every bodied car at once — measured peak in the probe was 106).

## Deviations from the plan
- **Anchor filter to bodied cars.** The plan says "every AI car". I return only cars with a kinematic
  body (NEAR tier). Rationale: FAR cars have no physics body, so a static building box around them
  collides with nothing. This bounds the budget and index memory to the regions that actually need
  collision, and is where the clipping actually happens. Documented in the accessor's doc comment.
- **Index/tiles aliveness tradeoff.** Index-only tiles (no visual copy) are treated as always alive.
  Demolition/suppression state lives only in a loaded visual tile's slot, and a building can only be
  demolished where a player can see it — where a visual tile exists and wins the merge. So a demolished
  building never collides where anyone is looking; index-only regions can't have been demolished. This
  matches the plan's documented-tradeoff option.

## Test results
- `npx tsc --noEmit -p tsconfig.json` → **exit 0, no errors** (the pre-existing minimap.ts WildRegionId
  error did not surface under this config; nothing touched there).
- `npx vite build` → **success**, `colliderWorker` emitted as a single shared 0.53 kB chunk (index +
  tiles.ts dedup to one worker module). The `node:module` externalized warning is pre-existing (box3d.js).
- `node tools/collision-probe.mjs` → **ALL PASS (10/10)**, driven against the real 205 tiles / 172,121
  building boxes. Anchors: player in tile 3_4, three cars 8.5–10.4 km away in tiles 6_14 / 10_11 / 14_10.

Before/after body counts around non-player anchors:
```
[1] BEFORE — player-only anchor        [2] AFTER — multi-anchor
    bodies near player: 25                 bodies near player: 25   (not regressed)
    bodies near car 0:  0                   bodies near car 0:  47
    bodies near car 1:  0                   bodies near car 1:  29
    bodies near car 2:  0                   bodies near car 2:  5
```
Also proven: dedup by `key:i:s` (106 unique), within budget (106 ≤ 700), ranked nearest-first, a tight
120 budget still covers every car (nearest walls win), and each car's 30 m drive segment into its wall
stops at the 25 m standoff (would pass through with no body).

## Open risks
- Index-only tile loads run through the shared collider worker; a burst of cars simultaneously crossing
  into fresh tiles is throttled to 2 fetches/update (5 Hz) so it can't spike, but a just-turned-NEAR car
  near a remote could momentarily lack index data for ~0.2 s until the fetch lands. It's typically 380 m
  from any wall at that instant, so the window is harmless in practice.
- 700 is a headroom budget, not a measured worst case in-app. If a future scenario clusters many cars in
  dense downtown simultaneously it could saturate; selection is global-nearest so the player and closest
  car walls always win, and the value is a one-line config change.
- The index holds player-region tiles redundantly with the visual stream (~4 tiles). Trivial memory; not
  optimised away to keep the anchor path uniform.
