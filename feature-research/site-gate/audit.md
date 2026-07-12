# Audit — F2 universal minigame site gating

## Files changed
- src/gameplay/siteGate.ts (NEW)
- src/gameplay/golf/game.ts
- src/gameplay/golf/course.ts
- src/gameplay/golf/index.ts
- src/main.ts

(No change to src/gameplay/pickleball/game.ts — its existing setActive/localSide
API already matched the GameSite contract; adoption happened entirely in main.ts.)

## What changed per file

### src/gameplay/siteGate.ts (new)
GameSite type + createSiteGate() exactly per spec:
`{ id, contains(x,z,pad), activatePad, deactivatePad, keepAwake?(), setAwake(on), onWake?() }`
and `{ register, update(x,z), awake(id) }`. update() does one contains() per
site per frame, tracks each site's awake flag internally, calls setAwake only
on transitions, onWake after setAwake on false→true. Sites register asleep;
the first update() wakes any the player already stands in.

### src/gameplay/golf/game.ts
- New public `root: THREE.Group` ("golf") added to the scene once; born
  hidden with `matrixWorldAutoUpdate=false`. Ball mesh, beacon, aim arrow,
  parked cart, remote balls (they parent off `#ballMesh.parent`) and the
  course view all live under it. The guide chevron intentionally stays on the
  scene (it floats over the PLAYER and only shows during a live round).
- `GOLF_SITE_PADS = { activate: 80, deactivate: 140 }` exported.
- New site-gate surface: `get siteAwake`, `siteContains(x,z,pad)` (delegates
  to the private course), `get keepsSiteAwake` (= active || cartBoarded),
  `setSiteAwake(on)`. Sleep hides root + freezes its matrix pass and clears a
  lingering round-summary card; wake re-shows, refreshes matrices, and snaps
  remote balls to their net targets (no lerp ran while hidden).
- `update()` first line: `if (!#siteAwake && !keepsSiteAwake) return;` —
  asleep golf costs one boolean test per frame. handleNet still stores remote
  state cheaply while asleep (targets only). `updateBallCam` already returns
  false when `!active`, so asleep golf never owns the camera.
- Removed now-unused `#scene` field.

### src/gameplay/golf/course.ts
GolfCourseView constructor takes `parent: THREE.Object3D` instead of
`scene: THREE.Scene` and adds its group to that parent (golf's root). No
render changes.

### src/gameplay/golf/index.ts
Re-exports `GOLF_SITE_PADS` (used by main.ts via the dynamic golfMod import).

### src/main.ts
- `const siteGate = createSiteGate()` next to the pickleball decl; removed
  `pickleballSiteAwake` and the whole `syncPickleballSiteActivation` fn.
- Pickleball adoption at creation: `game.setActive(false)` (register-asleep
  invariant — it is constructed active), then a registered GameSite with
  contains=inGoldmanTennisSite, pads from PICKLEBALL_TUNING (48/72),
  keepAwake = localSide !== null, onWake = replayPickleball when online.
  updatePickleballGameplay unchanged apart from dropping the sync call — it
  still early-returns on `!pickleball.active`.
- Golf registered inside buildWildlandsGolf right after `golf = game`, with
  keepAwake = game.keepsSiteAwake, plus a fire-and-forget
  `renderer.compileAsync(game.root, …)` (garden/wildlands deferred pattern) so
  the first wake never draws an uncompiled course.
- Driver: one `siteGate.update(player.position.x, player.position.z)` per
  tick, immediately before updatePickleballGameplay (the old sync call site).
  Chosen approach for golf: `golf?.update(...)` stays unconditional; the
  zero-work early return lives inside GolfGame.update (one place owns the
  rule; updateBallCam stays consistent for free).
- `siteGate` added to the dev `__sf` hooks (probe/debug access).

## Deviations from the plan
1. keepAwake for golf is `active || cartBoarded`, not just `active` — without
   it, driving the golf cart beyond the deactivate pad would freeze
   `#updateCart`, so hopping out would never re-park/re-show the cart.
2. GolfGuide stays parented to the scene (guide.ts is outside my file list and
   its constructor types `scene`); it is only ever visible mid-round, when the
   site is necessarily awake, so it costs nothing asleep.
3. Added `game.setActive(false)` before pickleball registration: the game is
   constructed active and the gate fires on transitions only. Probe-caught.
4. Added deferred compileAsync of golf.root: the root now boots hidden, so
   without it the first wake would draw uncompiled materials (first-look hitch).

## Test results
- `npx tsc --noEmit`: clean (a transient `./held` error mid-run came from the
  parallel F1 workstream editing src/player/rig.ts in this shared worktree and
  resolved itself when F1 landed held.ts).
- `npm run test:golf` (golf-logic-probe): `"ok": true`.
- Headless CDP probe (own vite on a free port, SF_RELAY_PORT=8788, ?fullfps,
  real name-gate entry, WebGPU/metal): 8/8 PASS, zero page errors.
  Script + screenshots: scratchpad/site-gate-probe.mjs, site-gate-probe-out/.
  - far (3000, 800): golf siteAwake=false root.visible=false, pickleball
    active=false root.visible=false, gate.awake false for both — draws 178
  - hole-1 tee: golf awake, root visible, tee curtains + course visible,
    "Press E to start · Hole 1" prompt fires (full update path) — draws 328
  - Goldman courts: pickleball awake, root visible, ambient match live (ball
    moved 10.97 m over 120 ticks) — draws 487 (bulk is the non-gated tennis
    center architecture, not the game)
  - far again: both asleep (hysteresis exit) — draws 143

## Open risks
- First golf wake relies on the fire-and-forget compileAsync having finished;
  if a player sprints from spawn to the course within ~a second of the module
  landing there could still be a small compile hitch (bounded, one-time).
- Draw-call numbers above were sampled while parallel workstreams (W6
  clubhouse etc.) were mid-flight on the same worktree; absolute values will
  drift, the asleep/awake deltas are the signal.
- Pickleball boot behavior is one frame lazier than before (asleep until the
  first gate tick instead of pre-set at construction) — indistinguishable in
  practice since the world is behind the loading cover.

## How archery (or any new game) registers
Build everything under one root Group added to the scene once, keep an
internal awake flag with a zero-work early return in update(), then:

```ts
siteGate.register({
  id: "archery",
  contains: (x, z, pad) => archery.siteContains(x, z, pad), // footprint + pad
  activatePad: 60,
  deactivatePad: 110, // must exceed activatePad (hysteresis)
  keepAwake: () => archery.drawing || archery.arrowsInFlight > 0,
  setAwake: (on) => archery.setSiteAwake(on), // hide root, flip matrixWorldAutoUpdate
  onWake: () => {/* optional net resync */}
});
```
setAwake is called on transitions only; sites start asleep, so constructors
must build hidden (root.visible=false) and, if deferred-built, pre-compile the
hidden root via renderer.compileAsync.
