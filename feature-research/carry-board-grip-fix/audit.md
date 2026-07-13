# Audit: carried surfboard now grips the walk rig's hand

## Files changed

- `/Users/eric/codeprojects/sanfrancisco/src/player/player.ts`

`src/player/held.ts` was read for reference (GripSpec type, attachToHand, golf
club / bow patterns) but not edited — no changes to it were needed.

## What changed and why

The on-foot beach `#carryBoard` prop was parented directly to `meshes.walk`
(the walk mesh group ROOT) at a fixed local offset
(`position.set(0.62, 1.0, -0.05)`). Because the mesh root doesn't move with
the arm during the walk cycle (only the rig's shoulder/forearm/hand bones do),
the board stayed rigidly glued in space relative to the torso and read as
floating beside the avatar instead of carried.

Fix: re-parent the board into the walk rig's hand via the existing
`attachToHand` grip system (`src/player/held.ts`), the same "attach once,
toggle `.visible`" pattern already used for the golf club (`#heldClub` /
`GOLF_CLUB_GRIP`) and the carried bow (`#heldBow` / `ARCHER_BOW_GRIP`
/ `#bowCarried`). The hand is a descendant of the shoulder→forearm chain that
`poseWalk` rotates every frame, so the board now swings naturally with the
arm as the avatar walks.

### Grip spec reasoning (`CARRY_BOARD_GRIP`, new const near the other DEV-tune
types, ~line 66)

`buildSurfboardMesh` (`src/vehicles/surf/mesh.ts`) builds the board lying flat
with local **X = width** (rail to rail), **Y = thin deck-normal** (the ~0.11m
extrusion depth, deck face up), **Z = length**, nose at **-Z** (file header:
"Front is local -Z", same convention as the avatar's own -Z-forward).

`attachToHand` parents the item under the rig's hand group and sets
`object.quaternion = inverse(spec.rotation)`, which means: the item-local axis
obtained by applying `spec.rotation` to `(1,0,0)` is the axis that lands on
the hand's local **X** — the "grip bar" fingers wrap around (per `held.ts`'s
own doc comment). I reverse-engineered this against the two working
precedents already in the file:

- `GOLF_CLUB_GRIP` = `rotation: [0,0,PI/2]` → maps the club's shaft axis (+Y)
  onto hand-X, matching its own comment ("Grip X runs UP the shaft (+Y)").
- `ARCHER_BOW_GRIP` = `rotation: [0,PI/2,PI/2]` → maps the bow's riser axis
  (+Y) onto hand-X too (the extra Y-term only adjusts roll, confirmed by
  matrix math — Ry doesn't touch a vector already rotated into the X-Z=0
  plane by the preceding Rz term).

For plain on-foot walking (no custom hold pose — `poseWalk` only rotates
`armL/armR`/`foreL/foreR` about local X, plus a small fixed Z tilt of ~0.06
rad), the hand's local **X axis stays close to world lateral (left/right)**
regardless of stride phase, since rotating a chain about its own X axis
doesn't reorient that axis. That's different from golf/archery, which run a
dedicated pose function that also rotates Y/Z and can therefore point hand-X
vertically.

So for the board I chose the opposite mapping from golf/bow: keep the item's
own **X (width)** axis fixed to hand-X (stable, lateral — the board stays
snug against the side rather than swinging its short axis around), and swing
the **length axis (Z)** into the hand's local Y, which — for a slightly bent,
mostly-vertical forearm — points close to world-up. Concretely:

```
rotation: [Math.PI / 2, 0, 0]   // +90° about item-local X only
```

Rotating only about X leaves the X axis itself unchanged (✓ stays the stable
grip-bar/lateral axis) and, worked through the rotation matrix, sends
`+Z_item → -hand_Y`, i.e. `-Z_item` (the nose, since nose = -Z) →
`+hand_Y` (up). That's nose-up. The remaining axis, the thin deck-normal (Y),
lands on hand-Z (fore/aft), so the board reads edge-on from the front — the
thin rail faces the camera, the wide flat deck faces sideways — matching how
a board is actually tucked under an arm (you see the edge, not the graphic,
from straight ahead).

`position: [0.4, 0.04, 0]` is the item-local grip point: `x=0.4` sits just
inside the widest rail for all three hull shapes (shortboard/fish/longboard
half-widths run 0.54–0.63m, so 0.4 clears the centreline without poking
through the opposite rail), `y=0.04` near the deck's top surface, `z=0`
(board centre — nose and tail hang roughly evenly above/below the grip).

I could not visually verify this in a running browser (constraint: no dev
server / preview). The math is internally consistent and cross-checked
against the two working precedents in the file, but the exact numbers
(rail inset, deck-top y, and whether a small extra roll around Z would read
better) are the kind of thing the golf/bow specs themselves say were "measured
w/ golf-pose-probe" — i.e., normally tuned by eye. Flagging this as the one
open risk: **the pose is reasoned from first principles, not eyeballed**, so
a quick look in the running game is worth doing before calling this final.

### Lifecycle changes

- Constructor: builds `#carryBoard` but no longer parents it anywhere
  (previously `meshes.walk.add(...)`). It stays an unparented, invisible
  `Group` until first actually carried.
- `setCarryingBoard(on)`: on the first `on === true` call, lazily calls
  `attachToHand(this.#walkRig, "R", this.#carryBoard, CARRY_BOARD_GRIP)` —
  mirrors `setGolfPose`/`setArcherPose`'s "attach once, never release,
  releasing per-frame would zero the wrist" pattern (see `held.ts`/`player.ts`
  comments). `attachToHand` also curls the right hand's fingers via
  `setHandPose(..., curl=1)` at attach time; I added a `#carryingBoard` bool
  field so the existing per-frame `#animate` hand-curl line also keeps the R
  mitt curled while the board is actively being carried (mirrors how
  `#ballHeld`/`#bowCarried` are folded into the same per-frame curl
  expression) — otherwise the curl set once at attach time would get
  overwritten to 0 on the very next walk frame (the code already resets/sets
  hand curl every frame based on state flags).
- `attachToHand` unconditionally does `object.scale.setScalar(invScale)`
  (compensating hand scale from outfit sizing), which would have wiped the
  old cosmetic `0.82` shrink. Re-applied it as `scale.multiplyScalar(0.82)`
  immediately after each attach (`CARRY_BOARD_SCALE` const) — happens exactly
  once per mesh instance in both attach sites (initial `setCarryingBoard` and
  the `setSurfboardConfig` rebuild), so it doesn't compound.
- `setSurfboardConfig` (rebuilds both the ridden and carried board on
  shape/color change): previously did `meshes.walk.remove(oldCarry)` +
  `meshes.walk.add(carry)`. Now: if the board has ever been gripped
  (`#heldCarryBoard` set), calls `.release()` on the old `HeldItem` (removes
  it from the hand, resets hand rotation/curl — `held.ts`'s own release()
  implementation) and re-attaches the freshly built mesh with the same
  `CARRY_BOARD_GRIP`/scale. If the board was never carried yet, the old mesh
  was never parented anywhere, so there's nothing to remove before disposing
  it — just discards it.

## Test results

- `npx tsc --noEmit` — clean, exit code 0, no errors (only an unrelated shell
  profile warning about a missing `virtualenvwrapper.sh` from the user's
  `.zshenv`, not from this change).
- No dev server / browser preview run, per the task's explicit constraint
  (preview pane in use by another task).

## Deviations from plan

None beyond implementation detail choices (which of `attachToHand` vs. direct
hand-parenting to use — went with `attachToHand` as the task suggested,
since it's the established convention for every other held prop in this
file and additionally gets the hand-curl for free).

## Note on unrelated diff hunk

`git diff` on `player.ts` also shows an unrelated hunk inside `#animate`
touching `#strideT` cadence / `WALK_TUNING.values.runSpeed` blending (walk→run
pose blend). **I did not make this change** — it was already present in the
working tree before/during my edits, consistent with the task's warning that
other tasks are in flight on this branch touching the same file. I left it
untouched and did not revert it.

## Open risks

1. **Unverified visually** (see grip-spec reasoning above) — the nose-up /
   edge-forward orientation and rail-grip position are derived from the mesh
   geometry and the same math that produces the game's existing golf/bow
   grips, but haven't been eyeballed in the running game. If it looks off
   (e.g. wrong roll, board too high/low, clipping through the hand/body),
   the only two numbers that should need adjusting are `CARRY_BOARD_GRIP.position`
   and possibly a small additional Z-axis roll term in `.rotation`.
2. `attachToHand`'s `setHandPose(..., curl ?? 1)` call happens once at attach
   time; ongoing curl state is otherwise fully owned by the per-frame
   `#animate` expression I extended — if any other code path sets the right
   hand's curl unconditionally elsewhere it could fight with
   `#carryingBoard`, but I found no such path in this file.
