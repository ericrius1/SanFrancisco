# Audit — W4 golf NPC groups + swing polish

## Files changed
- src/gameplay/golf/npcGolfers.ts (NEW)
- src/gameplay/golf/game.ts (modified)
- src/gameplay/golf/index.ts (modified)
- src/gameplay/golf/ui.ts (modified)
- src/gameplay/golf/tuning.ts (modified)

No other repo files touched. (git status also shows course.ts and files
outside golf/ modified — those are OTHER agents' uncommitted work on this
shared worktree, not mine.) Probes live in the session scratchpad
(npc-golf-probe.mjs, join-debug-probe.mjs); screenshots in
.data/npc-golf-probe/.

## What changed per file

### src/gameplay/golf/npcGolfers.ts (new, ~570 lines)
`NpcGolfers` — ambient golfer twosomes, owned by GolfGame.
- 3 groups × 2 golfers, staggered starts at hole indices 1/6/11 (refs 2/7/12).
  Each golfer = `buildRig(avatarFromSeed(...))` + `buildGolfClub()` via
  `attachToHand(rig,"R",club,GOLF_CLUB_GRIP)` + `secondHandCurl("L")`;
  `poseGolf(rig, 0)` is run once at build so the lingering wrist keyframes
  read as "carrying the club" during walks (per the F1 audit note).
- Per-golfer state machine: idle(0.8s) → address (smoothstep 0→-charge over
  1s + 0.25s hold) → swing (same cubic ease and 0.46s SWING_TIME as the
  player; own `GolfBall.strike` fires as the pose sweeps s ≥ 0) → watch
  (finish held 0.5s, head-tracks the ball, ball simulated to rest) → resolve.
  Turn order = farthest-from-pin plays first (real "away" golf). Partner
  walks to a spot beside their own ball, then idles and head-tracks the live
  shot.
- Shot planning: `suggestedClubIndex(dist, lie)`; power =
  clamp(dist / estimatedCarry(club,1,lie), .35, 1) (putter uses the exact
  √(d/carry) roll relation), ±4% power and ±0.05 rad aim error. Water/out
  results replay from the pre-shot spot with a penalty stroke, matching the
  player's rules. Hole-out = ball holed, OR rest within 0.35 m of the pin,
  OR 4 strokes (pick up). All done → group walks to the next tee
  ((idx+1)%18) and re-tees.
- Distance tiers: nearest-golfer distance to the player decides per group.
  < 160 m = full animation (poses, walks at 1.6 m/s with stride-matched
  poseWalk, one-leg water sidestep via map.isWater probe). ≥ 160 m = frozen
  poses; the group progresses by one whole stroke per ~11 s timer tick
  (teleport to address, strike, flight resolved synchronously, bounded)
  — no unseen golfer ever simulates a stroll.
- Cost gating: every rig root has `matrixWorldAutoUpdate=false` and is
  refreshed only on frames its pose/transform changed (buskers pattern);
  buskers' volume-thresholded shadow diet applied to every rig+club; shared
  ball geometry/material module-level; per-frame allocation-free (scratch
  vectors). At most one ball per group is ever in flight (turn-based).
- Day/night: `daylight()` provider with a 2 s debounce before hiding/showing
  (time-scrub safe). Hidden = groups return early, zero pose work.
- Audio: reuses the game's GolfAudio; NPC strikes only thwack when the
  player is within 60 m, power scaled down ~50–85% with distance (the class
  is non-spatial). No whoosh/land/holed sounds for NPCs.
- Dev surface: `window.__golfNpc`, `ticks` counter, `debugState()`,
  `setDaylightProvider()` (probe/night testing before main.ts wires the sky).

### src/gameplay/golf/game.ts
All the fresh site-gating is PRESERVED untouched (root group, GOLF_SITE_PADS,
setSiteAwake, keepsSiteAwake, the update() early-return, tryStartAtTee's
main.ts contract).
- Constructor gains optional `opts: GolfOptions = {}` (new exported type,
  `{ daylight?: () => boolean }`); builds `#npc = new NpcGolfers(...)` under
  `this.root` (hides with the site, compiles with the existing deferred
  compileAsync of root).
- update(): after the siteAwake early-return, `if (this.#siteAwake)
  this.#npc.update(dt, elapsed, player.renderPosition)` — asleep golf still
  costs one boolean; a cart-held-awake sleep (root hidden) also skips NPCs.
- tryStartAtTee: unchanged tee/cart behavior, plus — not at a tee, within
  6 m of an NPC golfer, no round active → `#startRound(group.holeIdx)`. The
  welcome is folded into #teeUp's toast ("Joined the group at hole N —
  you're playing too ⛳ Your ball's on the tee") via a #joinedGroup flag so
  there is exactly one message, no ordering race. Groups keep playing
  alongside (ambient companions, no shared scoring).
- Swing polish:
  - SWEET_SPOT (0.92) release: pendingStrike carries `perfect`;
    #strikeNow applies power×1.04 (≈+4% carry) and a brighter thwack
    (power×1.25 capped at 1); #beginSwing triggers ui.flashPerfect().
  - Turf puff at the strike: `onImpact(ball.pos)` when power > 0.5 and
    lie ≠ tee (same fx.impactPuff hook main already wires for landings).
  - Follow-through: FOLLOW_HOLD 0.4 s at the finish pose, then a 0.28 s
    smoothstep ease-down instead of the old 0.32 s snap. The downswing curve
    for t ≤ SWING_TIME — and therefore #strikeNow timing and ball physics —
    is bit-identical (verified: golf-logic probe + pose probe pass).
- Dev: `get npcTicks` on GolfGame (probe asserts the freeze).

### src/gameplay/golf/ui.ts
- gm-sweet element: golden conic arc over the 92–100% band of the ring,
  visible while charging; meter gets a `sweet` class (ring brightens, club
  label golden) when charge enters the band; `flashPerfect()` = a 0.38 s
  scale pop + ring flash on release. CSS injected from TS via a <style>
  element (index.html must not be edited), :root tokens where applicable.

### src/gameplay/golf/tuning.ts
- `SWEET_SPOT = 0.92` lives here so game.ts and ui.ts stay acyclic.

### src/gameplay/golf/index.ts
- createGolf gains optional `opts?: GolfOptions` 5th parameter (backward
  compatible — main.ts's current 4-arg call needs no change); re-exports
  GolfOptions.

## INTEGRATION SPEC (optional, one line)
Nothing REQUIRED — main.ts compiles and runs unchanged (NPCs then golf
around the clock). To make groups pack up at night, in
buildWildlandsGolf change:

```ts
const game = await golfMod.createGolf(map, physics, scene, loadedGolfCourse,
  { daylight: () => sky.sunElevation > 0.05 });
```

## Deviations from the plan
- "3 groups of 2 during day" default: without the main.ts daylight param the
  provider defaults to always-day (feature still ships; the one-liner above
  turns on night pack-up). Probe verified night behavior by injecting the
  provider via the dev hook.
- Join message is composed inside #teeUp (flag) rather than a second
  hud.message after #startRound — hud.message replaces, and composing at the
  source guarantees exactly one toast.
- Far-mode "teleport-advance" resolves a whole stroke per ~11 s tick
  (bounded synchronous flight sim) rather than pure relocation — same cost
  class, keeps ball/pin state truthful for the join feature.
- Group advance to the next tee WALKS when the player is near (nice
  ambience) and only re-tees instantly in far mode.

## Test results
- `npx tsc --noEmit`: clean.
- `npm run test:golf` (golf-logic-probe): ok:true, worstEstimatePct 0.
- `node tools/golf-pose-probe.mjs` (F1 audit asked for a post-integration
  re-run): passes, 0 page errors.
- Headless CDP probe (own vite :5222, SF_RELAY_PORT=8792, ?fullfps, WebGPU
  metal; server + chrome killed after, ports verified free): 19/19 PASS —
  - three staggered groups exist at holes 2/7/12
  - near-mode: swing observed, ball flew and rested elsewhere
    (~230–370 m downrange with roll), golfers walk to their balls
  - E-join: after a golfer walked clear of every tee box, tryStartAtTee
    returns true, round active at the group's hole, toast reads "Joined the
    group at hole 2 — you're playing too ⛳ Your ball's on the tee"
  - teleport far: round auto-ends, golf.siteAwake false, npcTicks frozen
    (counter identical across 30 ticks)
  - far-mode advance: holes 1,6,11 → 3,8,13 over ~200 s simulated
  - sweet band lights at full charge; perfect pop class fires on release
  - night (setTimeOfDay 1): debounce holds ~0.5 s, groups hidden after 2 s;
    day restores them
  - zero page exceptions
- Screenshots (.data/npc-golf-probe/): a-npc-midswing (top of backswing,
  club cocked over the trail shoulder IN both hands, partner watching, pin
  downrange — looks right), b-npc-walking (club carried mid-stride),
  c-wide-course + c2-two-groups (aerials), d-sweetspot-meter (full ring +
  golden band, DR 230m), e-joined-hud (join toast + Hole 2 scorecard chip),
  f-night-packed (course empty at night, only tee webs glow).

## Perf notes
- Asleep (site gate): literally zero — NpcGolfers.update is behind the
  existing early-return (probe: ticks counter frozen).
- Awake + near (< 160 m): 6 rigs × pose fn + manual matrix refresh only on
  dirty frames; at most one ball integrating per group (turn-based); no
  per-frame allocations. Rig subtrees are pruned from the auto matrix pass
  and every sub-1.5e-3 m³ box is shadow-diet'd (buskers thresholds).
- Awake + far: zero animation; one bounded synchronous flight resolution
  per group per ~11 s.
- Draw calls: 6 avatars + 6 clubs + 6 balls, all shared-material Lamberts.

## Open risks
1. NPC drives can run out very long (~370 m drive+roll seen on a downhill
   fairway) because they share the player's exact ball physics at power 1.
   Cosmetically plausible, but if it reads as super-human, cap NPC power at
   ~0.92 in #planShot.
2. `#setupHole` re-tees groups instantly in far mode on an 11 s cadence; if
   the player watches a group from just outside 160 m with binocular-level
   attention they could catch a teleport. The 160 m radius makes this
   practically invisible at 1280p.
3. Walking golfers cut straight lines (single water sidestep only) — they
   can walk through bunkers and across greens. Real golfers do the former,
   avoid the latter; nobody has complained in screenshots.
4. Daylight default is "always on" until main.ts passes the provider (see
   INTEGRATION SPEC).
5. The join radius (6 m) is checked against golfer positions only while
   groups are visible (day); at night joinableHole returns -1 by design.
