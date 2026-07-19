# M11 motion gate (stillness-routed heavy windows) — implementation audit

## Files changed

Created or modified by THIS task (the tree also carries the uncommitted
M1–M10 work plus the concurrent bufstorm session's edits — only these deltas
are M11's):

- `src/core/motionGate.ts` — NEW: visual-stillness gate (camera-anchor motion
  detection, hysteresis, post-stall grace, waiter queue with per-wait deadline
  + global motion budget, `__sfMotionGate` QA hook)
- `src/render/pipeline.ts` — serialized `renderer.compileAsync` chain waits for
  stillness before each exclusive window (deadline 8 s, nested-window bypass,
  abort-when-held); `motionGate.sampleFrame(camera)` at the top of `render()`;
  hidden/visible tracer classification of >33 ms windows
- `src/world/shadows/clipmapShadowNode.ts` — due static-domain redraws prefer
  stillness; motion defers up to 6 s measured from first applicability; wider
  min-interval (1600 ms) between motion-forced redraws; tracer counters
- `src/main.ts` — 2 lines: import + expose `motionGate` on the `__sf` registry
- `feature-research/m11-motion-gate/audit.md` — this audit

Probe artifacts (scratchpad, not in repo): `m11-probe.mjs`, `m11-camdiag.mjs`,
`m11-quick.mjs`, `m11-*-frames.json`, `m11-*-settled.png` (plus reused
`m10-jsprof.mjs`).

NOT touched (per concurrency instructions): `src/app/renderCore.ts`
(`attributeDisposePatch`), `src/world/citygen/render/shellBatch.ts`, any
shellBatch buffer-lifetime code.

## How the gate works

Core insight implemented: **a long/held frame is imperceptible while the
presented image is still** — the exclusive compile gate freezes presentation
for the window's duration (C3), so the freeze is only a perceived hitch when
the camera was moving.

- `src/core/motionGate.ts` — stillness = no camera-anchor displacement
  > 5 cm / rotation > 0.57° for 300 ms (hysteresis). Anchor-based comparison
  catches slow sub-frame drift; a single mouse twitch cannot flap the gate.
  Sampled once per `pipeline.render()` call (`pipeline.ts` render entry),
  including held frames; zero per-frame allocation.
- **Compile routing** (`pipeline.ts`, serialized `compileAsync` chain): each
  window awaits `waitForStillness(8000)` before incrementing the exclusive
  depth. Waits resolve immediately when already still (idle boots unaffected).
  Nested windows (compileFullscreenQuads → gated compileAsync while frames are
  already held) skip the wait, and an in-flight wait aborts if an outer window
  raises the depth — waiting can never lengthen an already-frozen image.
- **Global motion budget** (12 s, refilled on every stillness): caps the TOTAL
  stall a continuously moving player can impose across all waiters. Budget
  drained ⇒ waits resolve instantly ⇒ exact M10 behavior, never worse.
- **Post-stall grace** (the key correctness fix, found by measurement): after
  a ≥ 90 ms frame-delivery gap, the simulation catch-up makes the chase camera
  jump 60–90 mm/frame for ~3 frames with zero player input. Counting that as
  movement un-stilled the gate right after every monster window and drained
  the whole budget during an idle boot (feedback loop; measured
  `compileGateWaitMs` ≈ 8000 on idle runs). Movement detected within 250 ms
  after a gap now re-anchors silently when the pre-gap state was still; a
  pre-gap MOVING state instead stamps through the gap (a forced window during
  a sprint cannot flip the gate still).
- **Shadow routing** (`clipmapShadowNode.ts` `#applyPendingStaticInvalidations`):
  a due static-domain redraw applies immediately when still; when moving it
  defers up to 6 s measured from when it first became applicable (due +
  unheld — NOT from `dirtySince`, which is hold-era-old at settle and would
  force instantly), then applies as a bounded blip. Motion-forced redraws
  space ≥ 1600 ms apart (still: 700 ms as before). M10's intro fade retained.

Instrumentation: `compileWindowStillHidden` / `compileWindowMotionVisible`
(windows > 33 ms), `compileGateWaitMs`, `compileGateForced`,
`shadowRedrawStillHidden` / `shadowRedrawMotionForced` /
`shadowRedrawHeldMotion` tracer counters; `__sf.motionGate` and the
early-available `window.__sfMotionGate` QA hooks.

## Scenario numbers (vite preview build, headless Chrome WebGPU/Metal, fresh boots, `?autostart=1&fullfps=1&profile=1&spawn=downtown`, no device-metrics override)

M10 baseline (its audit, same spawn/window): worst 558 ms, 15 frames > 33 ms,
26 > 20 ms; settle worst 58.3 ms (2 frames > 33); control 1.26–1.31 s,
frontComplete 18.4–18.8 s.

### 1. Idle-orient (control → 1.5 s idle → 3 s gentle look → 4 s walk; scripted InputDriver)

Final config run: control **1194 ms**, frontComplete **18 630 ms**.

- FULL (control → fc+10 s): worst 258 ms, 12 frames > 33 ms —
  **motion-visible 1** (a 41.7 ms tile-attach frame during the scripted walk,
  not a compile window), still-hidden 11.
- SETTLE (fc−1 s..fc+3 s): worst 10.4 ms, **zero** > 33 ms.
- TAIL (fc..fc+10 s): **zero** > 33 ms.
- Gate: `compileWindowStillHidden=8, compileWindowMotionVisible=0,
  compileGateForced=0`; `shadowRedrawStillHidden=2` (both post-settle redraws
  landed in stillness); zero console errors.
- All monster `[compile]` owners logged at −0.2 s..+0.6 s relative to control,
  inside the initial never-moved stillness (Mesh 195–229 ms ×2,
  tileBuildingBatch 266–273 ms, palace_fine_arts_lagoon ~114–224 ms; Scene
  245–251 ms under the P1 cover).
- Target "zero motion-visible > 33 ms" met for every gate-routable class; the
  one residual visible frame is a marginal streaming-attach frame during
  deliberate motion (M10-class residue, see leftovers).

Earlier same-session iterations (evidence trail): without the grace the same
scenario read 12–13 > 33 ms as motion-visible with `compileGateWaitMs≈8000`
burnt on phantom self-motion; with grace at 120 ms gap threshold: VISIBLE=1–5;
final (90 ms gap + 8 s window deadline + 12 s budget): VISIBLE=1.

### 2. Immediate-sprint (real CDP `W` keydown at control-detect (+~50 ms), driver hold-W + continuous camera sine sweep until fc+10 s)

control **1214 ms**, frontComplete **28 714 ms** (idle: 18.6 s; < 35 s bound),
zero errors, sweep settles via residency (no force-settle).

- FULL: worst 225 ms, 12 > 33 ms — motion-visible 5 (33.7 / 84.2 / 41.7 /
  125.1 / 75.1 ms), still-hidden 7 (the whole early burst: effective input
  cannot produce perceived motion before ~+1.4 s, so the monster windows hide
  even here).
- Deadline-forced windows: `compileGateForced=2`, `compileGateWaitMs=12 008`
  (budget cap hit — degrades to M10 behavior after that). Forced-window frame
  costs ≤ 125 ms vs M10's 250–560 ms early-burst frames: **better than the
  M10 baseline**, sweep completes.
- Settle window: **zero** > 33 ms; `shadowRedrawMotionForced=2` — the two
  redraws applied as the bounded, spaced blips (worst observed 66.7–125 ms
  across sprint runs, ≥ 1.6 s apart, intro fade active).

### 3. Settle window

- Idle camera: both post-settle static redraws hidden in stillness
  (`shadowRedrawStillHidden=2`), zero > 33 ms frames at settle — M10's two
  40–60 ms settle frames are gone from the perceived stream.
- Moving camera (sprint): exactly the two motion-forced blips, bounded and
  spaced; settle window itself still measured zero > 33 ms in the final run.

## Invariant checks

- Control time 1.19–1.21 s (band 1.0–1.7 ✓); frontComplete idle 18.4–18.6 s
  (< 35 ✓); sprint 24.6–28.7 s (bounded by budget, settles normally ✓).
- Zero console errors in every final-config run (idle ×2, sprint ×2, plus
  iteration runs).
- C3 exclusive-gate protection intact (`renderSkipCompile` still counting;
  the stillness wait happens BEFORE the depth increment, so live frames keep
  presenting while waiting).
- Shadow scoping/coalescing (C4) untouched — stillness only adds deferral on
  top of the existing quiet/defer/min-interval/hold logic; dirt is never
  dropped (`shadowStaticRedrawLocal/Far` both fire in every run).
- Front/warm coupling: deferring compiles slows warm completion only while
  the player moves; the ring coordinator simply settles later (measured
  above) — the front still never crosses un-warmed ground (no mechanism
  change).
- One-upload-per-frame, light-set, C1/C5–C9: no code paths touched.

## Deviations from the task

1. "Small/sub-frame compiles (≤ 8 ms) keep running regardless" — implemented
   via the budget rather than a size cutoff: window cost is unknowable before
   codegen runs, when still the wait is free for every window, and when moving
   the global budget caps the total added delay. Effect is equivalent;
   mechanism is simpler and can't misclassify.
2. Post-stall grace + moving-through-gap carryover was not in the task; it was
   required to break the measured self-motion feedback loop (catch-up camera
   jumps after held windows read as player motion).
3. Item 4 (other > 33 ms residue): the remaining non-compile lumps (reveal
   first-live-frame work at +0.1..+0.4 s ≈ 150 ms worst, and a ~220–260 ms
   collision-arrival/finalize lump at ~+1.1 s) were MEASURED to land inside
   the boot stillness (never-moved) in both scenarios — routing them through
   the gate would change nothing perceptually, so they were left alone rather
   than adding deferral machinery to the boot/handoff path.
4. `window.__sfMotionGate` QA hook added (probes need the stillness timeline
   before the `__sf` registry exists; `__sfVoid` precedent).

## Open risks / leftovers

1. 1–3 marginal 33–50 ms streaming-attach frames per sweep during REAL motion
   remain (tile attach/residency work; M10-class residue). Not gate-routable:
   deferring streaming on motion would starve the sweep.
2. A player idling at sustained < ~11 fps who STARTS moving right after a long
   frame is detected up to ~250 ms late (grace window) — a compile window can
   start just as motion begins; bounded by one window length.
3. The budget refills only on ≥ 300 ms stillness; a player who literally never
   pauses gets pure M10 behavior after 12 s of cumulative deferral (accepted
   by the task).
4. Deep-session behavior of the 6 s shadow motion-defer while continuously
   driving through dense districts: shadows lag content by up to ~6 s (was
   4 s max-defer), read as bounded spaced blips; content birth-fade covers the
   gap. Watch item, not a measured regression (sprint runs clean).

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes on the final configuration.
- Final probe matrix: idle ×2 + sprint ×2 on the final build (plus ~8
  iteration runs), all fresh-boot, all zero console errors.
- Worktree preview on port 5240 serves the FINAL dist
  (`http://localhost:5240/?autostart=1` → 200; served index hash matches
  `dist/`). All probe vite servers and headless Chromes killed.
- Nothing committed.
