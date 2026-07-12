# Audit — Pickleball ambient overhaul: main.ts integration

Wiring-only pass. The pickleball module (ambient/audio/ui/poses/playerRig) was
already done + typechecking; this integrates it into src/main.ts. The module
author's own audit is `audit.md` (left untouched).

NOTE: The task pointed me at an "INTEGRATION SPEC" in audit.md's final section.
That section does not exist in the file on disk (audit.md ends at "Open
risks", no code snippets / line anchors). I reconstructed the integration from
the module APIs (fully specified in the task brief), the confirmed facts, and
the existing golf/archery integration patterns already in main.ts.

## Files changed
- src/main.ts (integration wiring)
- tools/pickleball-probe.mjs (one-line probe pointer — sanctioned by the task)

Created (my own scratch/report + verification artifacts, not app code):
- feature-research/pickleball/integration-audit.md (this file)
- .data/pickleball-smoke/*.jpg (smoke screenshots, gitignored)

## What changed per file

### src/main.ts
1. **Imports** — added `PickleballAmbient, PickleballAudio, PickleballUI` and
   types `PickleballFrameResult, PickleballInteraction` from
   `./gameplay/pickleball`; added `type GoldmanCourtAnchor, type GoldmanCourtRef`
   to the `./world/goldenGateTennis` import (for the ambient anchor cast).

2. **State declarations** (by `let pickleball`) — added
   `let pickleballAmbient / pickleballAudio / pickleballUI` (all `| null`).

3. **Frame-driver state** (by `pickleballLocalPose`) — added
   `let pickleballAmbientSide: PickleballSide | null` (the side of the ambient
   court the player has taken over).

4. **Build block** (the `try` that creates the networked court):
   - Construct `pickleballAudio = new PickleballAudio(nature)` and
     `pickleballUI = new PickleballUI()` (shared by networked + ambient).
   - **Rewrote `pickleball.onEvent`**: every event now flows to
     `pickleballAudio.handle(event, netCenter)` (netCenter = gameplayAnchor+1y);
     `paddle` still does `fx.impactPuff`; `point`/`game` now go to
     `pickleballUI.applyEvent(event, pickleball.localSide)` instead of the old
     `hud.message` lines.
   - Build the ambient cluster from `goldenGateTennis.courtAnchors` for refs
     `["14A","14C","14D","15"]` (14B stays networked), filtering missing anchors;
     `daylight: () => sky.sunElevation > 0.05`; wire
     `pickleballAmbient.onSeatEvent = (e) => pickleballUI.applyEvent(e, pickleballAmbientSide)`;
     `scene.add(pickleballAmbient.group)`; fire-and-forget
     `renderer.compileAsync(pickleballAmbient.group, camera, scene)` (golf/archery
     pattern) to warm shaders before first wake.
   - **Site-gate fields** (the two the task named):
     `keepAwake: () => game.localSide !== null || pickleballAmbient?.seatedRef != null`;
     `setAwake: (on) => { game.setActive(on); pickleballAmbient?.setAwake(on); }`.
     The registration itself is unchanged (not duplicated).

5. **`releasePickleballForNavigation`** — prepended an ambient-seat release: if
   `pickleballAmbient.seatedRef != null`, `exitCourt()` + restore the walking
   player at the returned pose (same restoreState shape as
   `finishPickleballExit`) + un-hide embodiment, then return. Without this a
   navigation/travel while seated on an ambient court would strand the player
   (embodiment hidden, site pinned awake by keepAwake).

6. **`updatePickleballGameplay` (frame driver, rewritten)** — now drives BOTH
   courts each frame:
   - Extracted `buildPickleballInput(side)` (the old inline intent) so both the
     networked and the ambient seated court get correctly net-flipped input.
   - Networked court: unchanged claim/release semantics (requestedRelease →
     `releasePickleballSide`, requestedSide → `requestPickleballSide`). Its
     frame becomes the seat frame when `localSide !== null`, else its interaction
     becomes the E-prompt.
   - Ambient cluster: `pickleballAmbient.update(dt, t, player.position, ambInput)`
     runs every awake frame. Seated → its `seat.frame` drives pose/HUD;
     `seat.frame.requestedRelease` triggers `exitCourt()` + player restore.
     Unseated + no networked seat/prompt → its `interaction` is offered; `KeyE`
     press → `enterCourt(ref, side, avatarTraits)` (player's own look), hide
     embodiment.
   - Shared tail: `pickleballLocalPose = seatFrame?.localPose`; HUD
     `setVisible(true)` / `setScore(score, server, rally)` /
     `setSeated(seated, input.padConnected)`; dedup'd prompt via `hud.message`.
   - Returns `eConsumed` (still consumed first in the E-chain as
     `pickleballEConsumed` — the archery/golf terms are untouched).

7. **`playingPickleball`** (in tick) — now
   `(pickleball?.localSide != null) || pickleballAmbient?.seatedRef != null`, so
   all the seated-player suppressions (jump/input/vehicle-switch/click-as-swing)
   also apply during an ambient takeover.

8. **`__sf` debug export** — added `pickleballAmbient, pickleballAudio,
   pickleballUI` (the smoke test + probe read `__sf.pickleballAmbient` /
   `__sf.pickleballUI`).

### tools/pickleball-probe.mjs
One line: `window.__pbUi = new ui.PickleballUI()` →
`window.__pbUi = window.__sf.pickleballUI ?? new ui.PickleballUI()`. See
"Deviations" for why this is required.

## Deviations from the brief

1. **restoreState vs applyPickleballPlayerPose.** Used `player.restoreState({mode,
   x, y, z, heading})` for the ambient exit (identical to the existing
   `finishPickleballExit`). Verified against the networked exit path — that
   shape is exactly what restoreState needs; tsc is clean. `applyPickleballPlayerPose`
   is still used unchanged for the per-frame seated pose.

2. **UI method signatures — all matched what exists, no adaptation needed.**
   `setVisible(on)`, `setScore(readonly[number,number], server, rally)`,
   `setSeated(on, isPad)`, `banner(kind, text)`, `applyEvent(event, localSide)`.
   I pass `input.padConnected` for `isPad`. `applyEvent` handles only
   point/game internally, so `onEvent`/`onSeatEvent` route freely.

3. **The one-line probe edit (required, not optional).** The probe self-builds
   its own `PickleballUI` and its `hud-mounts` assertion queries the FIRST
   `#hud .pb-card`. Now that main builds a real integrated UI at boot, main's
   card is first in the DOM, so the probe would read main's nodes (hints hidden
   → assertion fails). Pointing `__pbUi` at `__sf.pickleballUI` makes the probe
   drive and verify the SHIPPED HUD (strictly better coverage) and falls back to
   a fresh instance if unbuilt. The probe's ambient cluster stays self-built and
   independent (its ambient assertions traverse its own group, unaffected by
   main's cluster), so this is genuinely one line. This is the "one-line probe
   pointer" the task's rule anticipated.

4. **Networked court takes E-priority over ambient takeover.** When the player
   is near an open networked (14B) side AND an ambient athlete, E joins the
   networked court. In practice 14B and the ambient courts are far enough apart
   that both prompts rarely fire together. Simple and predictable.

## Test results
- `npx tsc --noEmit`: **0 errors** (was 0 before; kept 0).
- `node tools/pickleball-probe.mjs`: **PASS 8/8**, zero page errors. Ports
  5221/8791 free afterward. Assertions: main-court-rallies, takeover-interaction
  ("E — take over near player", 14A side 0, 0.98 m), ambient-courts-live (4
  courts, 2 balls), night-empties-courts (0→4), audio-no-throw (all six
  one-shots, ctx running), hud-mounts (real UI: card+banner+hints), ambient-seat,
  no-console-errors.
- Smoke test (own vite 5226 / relay 8796, headless CDP, ?fullfps, teleport to
  Goldman courts): **PASS**, 0 page errors. Confirmed via `__sf`:
  `pickleballAmbient` exposed; 4 visible ambient courts; score HUD present +
  shown ("Pickleball 1–0"); `pickleballAmbient.getInteraction(playerPos)` near a
  14A athlete returns `{ref:"14A", side:0, prompt:"E — take over near player",
  available:true, d:0.36}`. Two screenshots read: (courts.jpg) blue mini-courts
  with distinctly-outfitted avatar athletes at the baselines + the "PICKLEBALL
  1 – 0" chip with the serving-side dot; (hud.jpg) the in-world "E — take over
  far player" prompt rendering. No visual breakage. Ports 5226/8796 free
  afterward. Human's port 5179 never touched.

## Open risks for final verification
- **Interactive takeover round-trip untested end-to-end.** The smoke test
  confirms the prompt + `getInteraction` + `enterCourt` API (probe covers
  enter/exit), but a real keyboard `E`-press → seat → swing → `E`-exit → walk
  restore was not driven with synthetic key events in main's own flow (the
  probe seats via its own cluster). The code path mirrors the proven networked
  seat exactly; worth one manual play-through.
- **Two PickleballAudio layers exist only under the probe** (main's + the
  probe's self-built one) — harmless (both no-throw, probe asserts its own).
  In real play there is exactly one.
- **E-priority** nuance (deviation 4) if courts are ever placed closer.
- Everything the module author flagged in `audit.md` "Open risks" still stands
  (grip-system hand-scale coupling on `setAvatarTraits`, pose-space swing tuning
  if W4 re-tunes shared arm geometry). Untouched by this pass.
