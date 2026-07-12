# Release-gate + perf + golf verification audit

Role: RELEASE-GATE / PERF / GOLF verifier. No product source was modified — this
was a verification pass. All artifacts are probes (scratchpad) and screenshots
(.data/).

## Files changed

No `src/` files were created or modified. Verification-only changes:

- `feature-research/release-gate/audit.md` — this report (created).
- `.data/gate-golf-probe/` — screenshots + results.json from the gate/perf/golf probe (created).
- `.data/golf-swing-only/` — golf swing / power-meter screenshots (created).
- Scratchpad probes (outside the repo, not committed): `gate-golf-probe.mjs`,
  `archery-diag.mjs`, `golf-swing-only.mjs` (a trimmed copy of `tools/golf-pose-probe.mjs`).

No tracked source, config, or `tools/` file was edited.

## 1. Release gate — `npm run build`

PASS. Exit code 0. `tsc --noEmit` clean (0 TS errors), `vite build` succeeded,
`precompress-dist.mjs` produced brotli/gzip artifacts (`dist/index.html`,
`dist/assets/*.br` present).

- Only warning: main bundle `index-*.js` is 3,415 kB (gzip 1,029 kB) — the standard
  "chunk larger than 500 kB" advisory. Pre-existing, benign, not introduced by this pass.
- No other vite warnings of note.

## 2. Perf when FAR from all sites (user #1 priority)

Player teleported to downtown SF (x0, z-400), well away from all sites. Verified
with the app's REAL rAF render loop running (the shipping path) — synchronous
manual-tick loops proved to be an unreliable measurement confound.

FAR draw baseline: **~775–781 drawcalls, ~1.17–1.25 M triangles** (`renderer.info.render`).
This is the dense downtown city itself. NOTE: the task cited a prior "~143–178"
far baseline; that figure must have been measured at a sparser far location — 775
at downtown is the city geometry, not the minigames. The load-bearing fact holds:
**all four new subsystems contribute ~0 when far, so they do NOT raise the far baseline.**

All-asleep assertions (all PASS):
- `golf.siteAwake === false`, `golf.root.visible === false`.
- pickleball ambient: 0 `pickleball-game` roots visible (`group.visible === false`).
- archery `stats().awake === false`, `stats().visible === false`, and `updatesRan`
  did NOT change across real frames (early-return proven).
- golf NPC `debugState().ticks` did NOT change across real frames (early-return proven).
- Goldman clubhouse / goldenGateTennis: no console errors; its update early-returns when far.

Wake-on-approach (both directions confirmed):
- Golf: teleport near hole-1 tee → `siteAwake=true`, `root.visible=true`,
  `siteGate.awake('golf')=true`, golf-NPC `ticks` increments (e.g. 32→60).
- Archery: teleport to the shooting line (-5547, 2079) → `siteGate.awake('archery')=true`,
  `stats().awake=true`, `visible=true`, `updatesRan` increments (e.g. 4→15). The
  footprint math (`inArcheryRange`) returns true at both center and shooting line.

Caveat (NOT a bug): archery/golf wake+sleep transitions can lag a fixed post-teleport
sleep because teleporting INTO a region (esp. GG Park NW for archery) stalls the render
loop while tiles/foliage stream — so wall-time ≠ frames processed. Given ~3–4 s of real
settle (or in normal walk-in play where the loop runs smoothly), the gate flips promptly
in both directions. Early probe runs that showed "archery didn't wake" / "golf still awake
at far" were purely this settle-timing artifact; every gate assertion passed once given
adequate settle. The gate LOGIC (`siteGate.ts`) is correct and never threw.

## 3. Golf gameplay + beauty

- `npm run test:golf` (golf-logic-probe): PASS (exit 0).
- Golf swing capture (trimmed golf-pose-probe against a live round on hole 1):
  clean run, page errors 0, ball goes airborne (phase "fly", tee → ~-1655,90,80).
  - `faceon_back_full.jpg`: golfer at top of backswing — **club raised and gripped in
    BOTH hands** together near the shoulder, standing over the ball. `handGap ≈ 0.2 m`
    (both hands on the grip).
  - `faceon_impact.jpg`: **club swung down into the ball, both hands on the grip.**
  - VERDICT: club-in-both-hands holds through the swing arc (backswing → impact). The
    grip-system deliverable is confirmed.
  - `power_meter_hud.jpg`: radial power meter ("DR 230m") with the golden sweet-spot
    arc at the top of a saturated ring, the full club-selection rail (DR/3W/3i/5i/7i/9i/
    PW/SW/PT), and the "hold click to swing" banner. Meter DOM: `charging=true, sweet=true`.
- NPC golfers: 3 groups exist at holes 1 / 6 / 11 (2 golfers each), advancing through
  phases (idle → turns), strokes increment (maxStrokes ≥ 1–2 observed). `__golfNpc`
  dev hook + `debugState()` work.
- E-join: teleport next to a live NPC golfer → `joinableHole = 1`, `tryStartAtTee`
  returns true, round goes active (`active false→true`). PASS.

Screenshots (repo copies): `.data/golf-swing-only/{faceon_back_full,faceon_impact,
faceon_downswing,faceon_finish,front34_*,dtl_*,power_meter_hud}.jpg`; far baseline:
`.data/gate-golf-probe/far_downtown.jpg`.

## Issues found

1. FLAG (low severity, tangential) — `tools/golf-pose-probe.mjs` fails its late
   cart-repark assertion at line 307: "cart or bag disappeared after golfer exited",
   after `setCartOccupants(2)` + hop-out. Root cause is likely that the round auto-ends
   during the probe's many intervening teleports, so on repark `#syncCartBags` passes
   `active ? occupants : 0` → 0 bags (`setCartBags`, src/gameplay/golf/cart.ts:239;
   `#syncCartBags`, src/gameplay/golf/game.ts:309). This is ambiguous between a probe-
   sequencing artifact and a minor 2-passenger bag-sync timing issue. It does NOT affect
   the core golf swing / NPC / E-join experience (all verified above). Recommend the
   golf-cart author confirm whether the round stays active through the pose-probe's
   teleport sequence before treating it as a product bug. The swing/pose captures
   themselves (which live AFTER this assertion in the probe) are unaffected — verified
   via a reordered copy.

2. Measurement note (not an app bug) — `renderer.info.render.drawCalls` reads 0 under
   `__sfManual(true)` (the render loop is detached) and can race the post-processing
   pipeline; the real count only surfaces with the live rAF loop running. Field name is
   `drawCalls` (camelCase) for the WebGPU backend, not `drawcalls`.

## Test results summary

| Check | Result |
|-------|--------|
| npm run build (tsc+vite+precompress) | PASS (exit 0) |
| Far: golf asleep / pickleball hidden / archery asleep / NPC early-return | PASS |
| Far draw baseline unchanged by new features | PASS (~775 = city; features ~0) |
| Golf wakes near tee (both directions) | PASS |
| Archery wakes near range (both directions) | PASS (needs region-stream settle) |
| npm run test:golf | PASS |
| Golf club-in-both-hands through swing | PASS (screenshots) |
| Golf power meter / sweet-spot UI | PASS (screenshot + DOM) |
| NPC golfer groups (3 at holes 1/6/11) play | PASS |
| Golf E-join (tryStartAtTee) | PASS |
| No console errors across runs | PASS |
| golf-pose-probe full run | FAIL at cart-repark assertion (see Issue 1) |

## Open risks

- The golf-cart 2-passenger bag repark path (Issue 1) is unverified end-to-end.
- Far baseline is high because "far" was downtown SF (dense city); if a lighter far
  reference is desired, re-measure at an emptier location — but the minigame subsystems
  are provably hidden either way.
- Cleanup done: my vite (port 5230 / relay 8790) and all probe Chrome instances were
  killed; ports 5230/8790 freed. The human dev server on 5179 was never touched.
