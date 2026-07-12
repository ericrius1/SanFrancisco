# Audit — W3 Pickleball overhaul

## Files changed
- src/gameplay/pickleball/playerRig.ts (REWRITTEN)
- src/gameplay/pickleball/poses.ts (NEW)
- src/gameplay/pickleball/ambient.ts (NEW)
- src/gameplay/pickleball/audio.ts (NEW)
- src/gameplay/pickleball/ui.ts (NEW)
- src/gameplay/pickleball/game.ts (modified)
- src/gameplay/pickleball/types.ts (modified)
- src/gameplay/pickleball/constants.ts (modified)
- src/gameplay/pickleball/index.ts (modified)
- tools/pickleball-probe.mjs (NEW — sanctioned by the task's "Optional" bullet)

NOT touched: src/main.ts, index.html, src/player/**, src/world/**,
src/gameplay/golf/**, src/gameplay/siteGate.ts, src/gameplay/archery/**.
Integration is spec-only (see INTEGRATION SPEC in the workstream report).

## What changed per file

### playerRig.ts (rewritten)
The one-off box athlete is gone. PickleballPlayerRig is now an adapter over
the canonical avatar stack: buildRig(avatarFromSeed(seed)) + attachToHand(rig,
"R", buildPickleballPaddle(), PADDLE_GRIP). Contract preserved exactly:
constructor(side [, seed]), pose(state), readPaddlePose(courtRoot, outCenter,
outNormal), worldPosition(out), group, dispose(). New: setAvatarTraits(traits
| null) — local takeover wears the player's own look; null reverts to the
seeded outfit; the paddle re-attaches to re-bake the per-outfit hand scale.
readPaddlePose now derives the sweep contact from the ACTUAL paddle-face mesh
(world position + its Z-cylinder axis as the normal, sign-flipped net-ward).
RIG_LIFT 0.585 puts the shared rig's soles on the paint under game.ts's
PLAYER_FOOT_LIFT 0.32. dispose() frees the per-rig avatar materials only
(rig geometry cache + held.ts item materials are shared statics).

### poses.ts (new)
posePickleball(rig, state): athletic ready crouch (crouch 0.13, wide split,
bent shins), speed-blended shuffle/run, head tracking from lookX/lookY, and a
keyframed forehand overlay (port of the old curve's wind/drive/settle timing)
re-authored as a 4-key track (ready → coil → contact → finish) on armR + foreR
+ handR (wrist). Key insight baked into a comment: shoulder Y mostly TWISTS a
hanging arm — the visible arc lives in X/Z keys + torso turn. WRIST ready
(-1.1, 0, 0) holds the face square to the net (screenshot-solved, sweep
candidates w0–w7). DEV hook window.__pbTune overrides wrist/crouch keys.

### ambient.ts (new)
PickleballAmbient: 2–4 extra LOCAL-ONLY PickleballGame instances on Goldman
mini courts ("14A","14C","14D","15" — 14B stays networked). One
update(dt, elapsed, playerPos, input) drives the cluster; setAwake(on) hangs
it off main's existing pickleball site gate; asleep = one boolean test.
Daylight provider empties the courts at night (a live seat keeps ITS court
on). getInteraction / enterCourt(ref, side, traits) / exitCourt() give the
E-takeover a local-only seat; exitCourt returns the athlete pose for player
restore and reverts the NPC outfit. Sleeping/empty courts hide their roots
AND freeze matrixWorldAutoUpdate (updateMatrixWorld(true) on re-wake).
Per-court seeds decorrelate outfits and AI aim.

### audio.ts (new)
PickleballAudio on the shared nature soundscape (dogPark.ts pattern; no new
AudioContext). One deliberate deviation from dogPark: the layer connects to
io.bus (presence-faded master), NOT alwaysBus + setExternalAwake — the courts
sit inside the "ggpark" nature region so the ctx is guaranteed alive whenever
a court is audible, and this sidesteps the setExternalAwake single-flag fight
with the roaming dog-park layer. effectsAudioLevel/HUD mute arrive via the
bus; nothing re-multiplies them. 6 pooled HRTF panners, round-robin. Voices:
paddle "thock" (bandpass noise burst + falling sine knock), serve = deeper
thock, bounce tick, net thud (lowpass noise + 80 Hz body), point chime
(2-partial; side-out = single soft), game = chime + 3 staggered filtered
noise swells (crowd "oh!"). handle(event, at) — `at` = court centre for
events without a worldPosition (serve/point/game).

### ui.ts (new)
PickleballUI, GolfUI pattern: DOM once into #hud, pointer-events none, CSS
injected from TS via a <style id="pickleball-ui-css"> on the :root tokens
(--surface-strong/--hairline-2/--accent*/--r-md/--r-pill/--shadow-sm/
--edge-hi/--blur; tabular-nums scores). Pieces: (a) top-centre score chip —
big score pair with per-number bump animation, serving-side dot under the
server's number, rally counter (shows ≥3, "hot" ≥8); (b) pop banner (SIDE
OUT / POINT / GAME POINT / GAME / YOU'RE IN / fault labels), per-kind
duration via --pb-banner-s; (c) seated keycap hint row (keyboard + pad
variants); #hud.pb-context tucks the travel toolbar/help like golf-context.
applyEvent(event, localSide) maps game events to banners in one call
(includes derived GAME POINT at 10+ with the lead).

### game.ts
- Athlete rigs seeded from the game seed → per-court outfits.
- setAthleteTraits(side, traits|null) — seat look swap passthrough.
- localPose(side) made public (was #localPose) for seat handoff.
- Frame result gains `rally` (HUD counter).
- Local assistedReach 0.52 → 0.62 (feel pass; AI stays 0.74).

### types.ts
PickleballFrameResult.rally added.

### constants.ts
Feel pass: swingContactStart/End 0.14–0.29 → 0.12–0.32 (timing forgiveness,
documented in a comment).

### index.ts
Exports posePickleball, PickleballAmbient(+types), PickleballAudio,
PickleballUI(+PickleballBannerKind).

### tools/pickleball-probe.mjs (new)
Self-managed vite :5221 (SF_RELAY_PORT=8791, killed on exit) + headless
Chrome/WebGPU-metal. Builds the ambient cluster + UI + audio IN-PAGE via
vite dynamic imports (integration not yet in main.ts), then asserts: 14B
rallies (paddle contacts increase), takeover interaction fires at an
athlete's baseline, ≥2 ambient courts live, night empties / day restores
courts, all six audio one-shots dispatch with the ctx running without
throwing, HUD DOM mounts with score/banner/hints. Screenshots: ambient
courts mid-rally, grip closeup, seated swing profile + finish, HUD.

## Deviations from the plan
1. audio.ts connects to nature's `bus` instead of `alwaysBus` +
   setExternalAwake (see above — avoids clobbering the dog-park pet layer's
   external-awake flag; courts are inside the ggpark region, so the presence
   fade is the correct gate anyway).
2. Kept the class name PickleballPlayerRig in playerRig.ts rather than a new
   athleteRig.ts — game.ts/index.ts import paths unchanged, zero compat shim.
3. Athletes are "left-handed": attachToHand(…,"R") lands on the rig's -X arm,
   which is the anatomical LEFT for a figure facing -Z (the rig's L/R naming
   is mirrored; golf has the same trait). Cosmetic and self-consistent — the
   swing was authored and verified for that arm.
4. Ambient court refs are typed `string`, not GoldmanPickleballCourtRef, to
   keep the pickleball module decoupled from world code (anchors are injected
   by main).

## Test results
- npx tsc --noEmit: clean for every file above (pre-existing TS6133 errors in
  src/gameplay/golf/* belong to the in-flight W4 workstream).
- node tools/pickleball-probe.mjs: PASS — 8/8 assertions, zero page errors,
  screenshots in .data/pickleball-probe/. Ports 5221/8791 verified free after.
- Pose iteration (scratchpad pose-tune.mjs, own vite :5221, killed after):
  wrist sweep w0–w7 → ready carry face-square (w1); swing re-authored after
  profile screenshots exposed the lateral-contact foreshortening; final
  contact frame reads extended-at-chest in profile AND front.

## Tuning values (for future passes)
- poses.ts WRIST r(-1.1,0,0) b(-1.5,-0.7,0.45) c(-0.9,0.2,-0.2)
  f(-0.1,0.7,-0.7); arm track x(0.42,-0.35,1.2,1.45) y(-0.1,-0.3,0.25,0.55)
  z(-0.3,-0.55,0.2,0.5); torso swing yaw -0.55·wind +0.72·stroke; crouch 0.13.
  All wrist keys + crouch live-sweepable via window.__pbTune.
- playerRig RIG_LIFT 0.585.
- audio.ts PB_AUDIO: layerGain 0.9, refDistance 5, rolloff 1.2, levels
  paddle 0.5 / serve 0.62 / bounce 0.16 / net 0.4 / chime 0.3 / crowd 0.34.

## Open risks
- HUD screenshots show the capture-context #hud "faded" state (pointer not
  locked in headless); in real play the chip/banner render at full opacity.
  body:not(.started) hides #hud entirely — probe forces the class.
- Ambient cluster first wake draws uncompiled materials unless main adds the
  golf-style fire-and-forget renderer.compileAsync(ambient.group, …) (in the
  spec).
- setAvatarTraits during a hold re-attaches the paddle; if applyAvatarToRig
  API changes hand scaling conventions, revisit (grip-system audit risk).
- The pose-space swing was solved against standard rig proportions; outfit
  scaling (dress/overalls) is pose-space-safe, but if W4 re-tunes shared arm
  geometry, re-run scratch pose-tune.
- serve event carries no worldPosition; audio uses court centre — if a future
  consumer needs exact serve position, add it to the event in types.ts.
