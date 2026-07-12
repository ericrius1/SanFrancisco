# Audit: F1 grip/held-item system

## Files changed
- src/player/rig.ts (modified)
- src/player/held.ts (NEW)
- src/player/player.ts (modified)

No other repo files were touched. Scratch probes live outside the repo
(scratchpad grip-probe.mjs / idle-probe.mjs).

## What changed per file

### src/player/rig.ts
- Articulated mitt replaces the single "clasp-L/R" flap: per hand a
  "fingers-L/R" group (proximal hinge at the palm front-bottom, box
  0.088×0.028×0.06) nesting "fingersTip-L/R" (distal, 0.084×0.026×0.048) and a
  "thumb-L/R" group on the inner edge (+X for L, -X for R, 0.028×0.032×0.055).
  All skin material, all below the castShadow volume threshold.
- Rig type gains cached joint refs: fingersL/R, fingersTipL/R, thumbL/R (no
  name lookups at pose time).
- `setHandPose(rig, side, curl)` NEW: clamped 0..1, allocation-free. Open
  (curl 0) keeps a relaxed rest bias (prox -0.3, distal -0.12 rad); closed
  (curl 1) adds prox -0.96, distal -1.31, thumb yaw ±0.8 + x -0.4 — sized so a
  0.03–0.05 m bar at the grip frame is enclosed.
- `setRigClasp` is now an alias of setHandPose (fetchBall, buskers, corona
  dog-park all keep working unchanged; verified they only call the function,
  never look up "clasp-*" mesh names).
- `buildGolfClub` moved to held.ts; rig.ts re-exports it for old import paths.
  STATIC_MAT lost its club entries (now MAT in held.ts); sole kept for the
  steering wheel.
- `poseGolf` gains WRIST keyframes (GOLF_WRIST const): the lead (R) hand
  carries the club rigidly, so the wrist is what lays the head on the ball at
  address, cocks the shaft high behind at the top, and releases it over the
  lead shoulder at the finish. Values solved empirically against the live hand
  frame (see verification). Trail hand mirrors y/z. DEV-sweepable via
  window.__golfTune keys wax/way/waz, wbx/wby/wbz, wfx/wfy/wfz.
  golfHinge()/hinge key untouched.

### src/player/held.ts (NEW) — API surface for downstream teams
- `type GripSpec = { position:[x,y,z]; rotation?:[x,y,z]; curl?: number }` —
  grip point/orientation in ITEM-local coords; grip-frame X must run along
  the item's handle (the bar the fingers wrap).
- `attachToHand(rig, side, object, spec): HeldItem` — parents object under
  the hand group solving the inverse transform so the item's grip frame lands
  on the hand grip frame (HAND_GRIP = hand-local (0,-0.05,-0.038), bar axis =
  hand local X); compensates the per-outfit hand-group scale (dress/overalls)
  so item world size is preserved; sets curl (default 1).
- `HeldItem = { object, side, release() }` — release un-parents, zeroes the
  hand-group (wrist) rotation and opens the hand.
- `secondHandCurl(rig, side, curl=1)` — closes the supporting hand.
- Item builders (shared module-level Lambert materials, castShadow on
  silhouette parts only):
  - `buildGolfClub()` + `GOLF_CLUB_GRIP` (grip [0,-0.05,0], rotation
    [0,0,π/2] → shaft down hand -X). Built hidden (owner shows it) — same
    contract as before.
  - `buildPickleballPaddle()` + `PADDLE_GRIP` (grip [0,-0.1,0], rotation
    [0,0,π/2]). Replicates the Goldman playerRig paddle proportions (handle
    0.055×0.24, edge r0.152/face r0.139 cylinders rotated X, scale.y 1.18).
  - `buildBow()` + `BOW_GRIP` — ~1.24 m recurve, origin at riser grip
    midpoint, limbs ±Y, back of bow -Z (downrange, same as avatar front),
    string one thin cylinder on the +Z side (name "bow-string" for archery
    to swap/animate).
  - `buildArrow()` + `ARROW_GRIP` — 0.7 m, origin at the NOCK, +Y toward the
    tip; 3 fletch fins at the nock end.

### src/player/player.ts
- `#clubPivot` chest-mount hack REMOVED. `#golfClub` is attached to the lead
  ("R") hand via attachToHand at first setGolfPose(true) and stays parented
  for the session (hidden when not golfing) because game.ts flips
  setGolfPose(false)→(true) within a single update while aiming — releasing
  on false would churn attach/release per frame (and did, in an intermediate
  version: release() zeroed the wrist after the pose ran, killing the swing).
- setBallHeld / #animate use setHandPose directly; #animate neutralises the
  hand-group (wrist) rotations whenever not golfing.
- `GolfTune` DEV keys REMAPPED: pivotY/pivotZ/pivotAX/raise/swingZ are GONE
  (they drove the deleted pivot). New keys: gripX/gripY/gripZ +
  gripRX/gripRY/gripRZ (item-local grip override; presence of __golfTune
  re-solves the attach every setGolfPose call), plus rig-side hinge and the
  wrist keys above. tools/golf-pose-probe.mjs SF_SWEEP mode still sets
  raise/swingZ — now inert no-ops (probe passes; its non-sweep path is what
  matters). I did not edit the probe (outside my file list) — flagging for
  whoever owns W4/probe upkeep.

## Deviations from plan
- Grip frame is (0,-0.05,-0.038), not the suggested ≈(0,-0.045,-0.02): the
  finger chain hinges at the palm front-bottom, so its curl pocket sits under
  the palm FRONT; the suggested point sat too far under the palm centre.
- Extra deliverable not in the plan text but required to make "club sits in
  both hands through the whole swing arc" true: poseGolf wrist keyframes
  (GOLF_WRIST). A rigid grip alone leaves the shaft perpendicular to the
  forearms (club pointed sideways at address — verified by screenshot).
- setGolfPose(false) does NOT release the club (kept parented+hidden); see
  player.ts notes above. HeldItem.release() still exists and works for
  downstream consumers.

## Verification
- `npx tsc --noEmit` clean (before + after).
- `node --experimental-strip-types tools/golf-logic-probe.mjs` passes before
  and after (worstEstimatePct 0).
- `node tools/golf-pose-probe.mjs` (self-managed vite:5197 + headless Chrome)
  exits 0, 0 page errors, cart/leave-golf assertions pass. NOTE: its late
  address/backswing measures run after the leave-golf teleport with no active
  round (pre-existing probe structure), so the meaningful in-round visual is
  wide_aim / settled-address.
- Custom scratch probe (own vite:5211, killed after) solved the wrist eulers
  against the live hand frame and screenshot-verified: address (head at the
  ball, headRelBall [-0.13,0.28,0.02]), top (shaft high behind the trail
  shoulder, head +1.87 m above ball), finish (club over the lead shoulder),
  in-round wide shot with baked constants, neutral idle (open mitts, no
  claw), held tennis ball nested in the right mitt (hand→ball 0.05 m,
  visible).
- No stray dev servers left (5197/5211 free).

## Open risks / notes for downstream agents
- **Concurrent edits**: golf/game.ts, course.ts, main.ts, siteGate.ts were
  being modified by other agents DURING my verification runs; two probe runs
  failed purely from that moving ground (golfer idle at the tee / standing on
  a newly-parked prop). Final runs pass, but W2/W4 should re-run
  tools/golf-pose-probe.mjs after integration.
- **Pose ordering contract**: poseGolf now writes handL/handR rotations;
  other poses never touch them, and Player#animate zeroes them when not
  golfing. NPC golfers (W4) driving poseGolf directly get the wrists for
  free, but if they blend to other poses while still holding a club they may
  want the lingering wrist (looks like carrying) or should zero hand
  rotations themselves.
- **Avatar rescale after attach**: attachToHand bakes the inverse hand scale
  at attach time; if applyAvatarToRig changes outfit mid-hold the item scale
  is stale until the next attach. Local player re-attaches per round only if
  __golfTune is set; cosmetic-only, worst case a ±20% club size.
- **GOLF_WRIST solved for the standard rig proportions** — pose-space, so
  avatar outfits/scales don't affect it, but if poseGolf arm keyframes are
  re-tuned (W4 "swing beauty"), re-solve with the scratch probe pattern
  (solve setFromUnitVectors(-X→target) composed onto hand.quaternion).
- Pickleball (W3) and archery (W5): use attachToHand + PADDLE_GRIP/BOW_GRIP;
  the grip-frame X-spin component is the knob for face/riser orientation.
  Expect one visual-tune pass per item — the specs are geometric best guesses
  verified only for the club.
