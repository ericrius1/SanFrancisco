# M7 teleport materialize arrivals — implementation audit

## Files changed

Created or modified by THIS task (the tree also carries the uncommitted M1–M6
work; only these deltas are M7's):

- `src/app/worldArrival.ts` — far-arrival classification hook + far-cut hook,
  far path reveals on destination `groundReady` instead of visual-ready
  (`#waitForDestinationGround`), background completion of the visual primes on
  the far path, `(far cut)` marker in the `?profile` arrival log
- `src/app/ringCoordinator.ts` — `RingFocusOptions.prime?: boolean` (skip the
  re-prime when the caller already primed); focus() doc updated
- `src/world/shadows/clipmapShadowNode.ts` — `setStreamingHold(active)` +
  hold gate in `#applyPendingStaticInvalidations` (M6 leftover: static
  redraws held while the materialize sweep is active; latched dirt applies as
  one redraw per domain on settle; 60 s safety bound; tracer
  `shadowRedrawHeldStreaming`)
- `src/world/sky.ts` — `setStaticShadowStreamingHold(active)` passthrough
- `src/main.ts` — far classification + far-cut wiring (late-bound closures
  next to `prepareDestinationEssentials`, real impls bound after the P5 ring
  coordinator constructs), `ringUpdate` wrapper drives the shadow streaming
  hold from `ringCoordinator.state`, `?nofarcut=1` QA escape hatch
- `feature-research/m7-teleport-arrivals/audit.md` — this audit

Probe artifacts (scratchpad, not in repo): `m7-probe.mjs`, `m7-shadowshot.mjs`,
`m7-{far,nofarcut,near,rapid}.log`, `m7-*.png`.

## Behavior

FAR arrivals (destination beyond current residency) now reuse the
void→materialize machinery:

1. The opaque cover holds only for the cut. After the covered commit
   (teleport + camera cut, unchanged), the arrival waits for the destination's
   CPU ground carpet (`physics.collisionArrivalStatus(epoch).groundReady` —
   the same milestone boot releases control on) instead of the full local
   visual settle, then reveals. The player stands in holo-terrain void at the
   destination.
2. At the commit moment `ringCoordinator.focus(dest, {reset: true,
   prime: false})` runs: generation bump aborts any in-flight sweep (boot
   included — latest-wins), the front collapses at the destination, and the
   materialize sweep chases residency exactly like boot. `prime: false`
   because the arrival already primed tiles (`tiles.primeAt`), authored
   regions (`prepareRequiredDestinationVisuals`) and collision through its own
   epoch-guarded path — the coordinator never duplicates priming.
3. Collision semantics are byte-identical to before: input suspension + player
   hold stay up through `#waitForCollision` until collision-ready
   (fail-closed, retry cycle, blocked reporting all unchanged); `cancel()`
   paths untouched. Only the COVER stops waiting for visuals.
4. NEAR arrivals: fully unchanged (covered visual settle, no front reset).
5. The visual prime/participant promises on the far path are detached into a
   `Promise.allSettled` (no unhandled rejections; a failed required region
   logs a warning — holo terrain + the sweep is the visual floor, exactly like
   boot's void).

### Far/near classification (main.ts, documented at the closure)

`far ⇔ hop > 500 m AND tiles.residentRadiusAround(dest) < 500 m`, evaluated
pre-commit (player still at the origin).

- `residentRadiusAround(dest)` is the truest "destination beyond current
  residency" measure available: a short hop inside the settled world reads a
  large radius (near — a resident front is never re-dissolved), while a
  multi-km teleport reads ~0 because nothing near the destination is attached.
  The crossover lands naturally around the streamed load radius.
- The 500 m minimum hop keeps recovery probes and short covered mode
  relocations (8–200 m) on the near path even mid-boot when local tiles are
  still pending.
- One-off dest-centred query = a single ~205-entry manifest pass at arrival
  time (it perturbs the streamer's single-slot residency memo once; the ring
  coordinator's next refresh recomputes — negligible).
- `?nofarcut=1` forces every arrival onto the pre-M7 near path (A/B QA on one
  build).

### Shadow streaming hold (M6 leftover)

While `ringCoordinator.state === "sweeping"` (boot or far arrival), main's
`ringUpdate` wrapper sets `sky.setStaticShadowStreamingHold(true)` →
`ClipmapShadowNode.setStreamingHold`. `#applyPendingStaticInvalidations`
then skips promotion (tracer `shadowRedrawHeldStreaming` counts skipped
opportunities while dirt is latched). On settle the hold clears and the stale
dirt is immediately due → exactly one redraw per domain, frame-staggered by
the existing local/far logic. Lone events outside a sweep keep the M6
quiet-window path untouched. A 60 s safety bound re-enables applies if a
sweep never settles (stalled expansion must not freeze shadows forever).

## Per-surface routing

Every runtime teleport funnels through `WorldArrivalCoordinator.arrive` (all
five call sites live in `src/app/navigation.ts`), so all of these get far
classification automatically:

| surface | path |
|---|---|
| Minimap click teleport | `minimap.onTeleport → navigation.teleportToTarget` (main.ts ~2350) |
| Remote-player "go to" | same `teleportToTarget` wrapper (main.ts ~3820) |
| Place history Alt-back/forward | `navigation.applyHistory` |
| Mode-switch relocations (surf shore, boat water, …) | `navigation.switchMode` covered-relocation branch (local surf hop still bypasses, unchanged) |
| World-ride boarding | `navigation.teleportCustom` (main.ts ~2300) |
| Tutorial jumps | `tutorial.teleport → navigation.teleportToPose` |
| Minigame exit | `navigation.returnToMinigameStart` |
| Invite links `?j=`, `?spawn=` deep links, session resume | boot-time placement (main.ts P1, before the P5 `RingCoordinator` constructor adopts the final player position) — the BOOT sweep is their materialize arrival; worldArrival not involved |
| Dev demos / cinematics (`src/dev/demos/*`) | direct `player.teleportTo` — deliberately bypass worldArrival (pre-existing; they own cameras/timing and are dev-only), so no front reset |

## Deviations from the plan

- Far signal is residency-around-destination + a minimum hop rather than the
  suggested "1.2× resident radius from front centre" or flat 1500 m: the front
  centre goes stale once the player wanders after settle (a 30 m hop 5 km from
  the boot focus must not re-dissolve the world), and a flat player distance
  re-dissolves fully-resident destinations. Rationale documented in main.ts.
- Added `?nofarcut=1` (dev/QA flag, ~3 lines) to measure the pre-M7 timing on
  the same build, per the acceptance's before/after requirement.
- Shadow hold is polled from the `ringUpdate` wrapper (state compare + setter
  on change) instead of a coordinator callback — the coordinator has no
  state-change event and gaining one for this would widen its API; the check
  is two scalar ops per frame.
- M6's audit floated "skip redraws for holo-dark casters" as the option here;
  the shipped hold-while-sweeping is that lever in its cheapest form.

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes.
- Headless probes (`scratchpad/m7-probe.mjs`, fresh vite-preview port + fresh
  Chrome profile per scenario, CDP WebGPU/metal, `?autostart=1&fullfps=1&profile=1`,
  no device-metrics override):
  - **Far teleport** (5.9 km, settled world → downtown): cover dropped
    **+390 ms** after the teleport command (arrival-internal visual milestone
    98 ms), control **+706 ms** (interactive 382 ms). Ring front reset +
    swept at the destination (timeline: front FULL → 0 → bloom → FULL;
    destination `frontComplete` reached). Player Y sane for 10 s
    post-arrival, collision-ready completed, **zero console errors**.
  - **Pre-M7 baseline** (same build, `&nofarcut=1`, same 6.0 km teleport):
    cover dropped **+1716 ms**, control **+2336 ms** (visual 1614 ms,
    interactive 1794 ms) — and no materialize sweep, content pops in around
    the revealed destination afterwards. M7 cuts time-behind-cover ~4.4×
    on a warm run; heavier destinations widen the gap (the near path's
    visual settle scales with destination content, groundReady does not).
  - **Near hop** (250 m after settle): near path taken, front NEVER reset
    (`front=FULL`, ring `settled` through the whole arrival — asserted every
    120 ms sample), arrival completed normally, zero errors.
  - **Rapid A→B→C** (two far teleports 700 ms apart): B's arrival + sweep
    cleanly superseded (B logged `visual 80ms, interactive 397ms (far cut)`
    before C took over), final arrival + sweep at C, C settled, no stuck
    cover/hold, zero errors.
  - **Boot regression**: control 1133/1190 ms warm (M4–M6 band 1047–1494;
    the 4.6–5.6 s runs are cold-shader-cache first boots of fresh profiles,
    matching M6's cold-cache observations), frontComplete 24.0–27.2 s
    (band 21–27 s), zero console errors in every run.
  - **Shadow hold**: during sweeps `shadowStaticRedrawLocal/Far` stayed 0
    while `shadowRedrawHeldStreaming` counted 1.4–3.3 k held opportunities
    (boot: 38.8–43.3 k invalidations → 1+1 applied redraws on settle;
    far-arrival window after tracer reset: 51.7 k invalidations → 1+1 on
    destination settle).
- Screenshots (scratchpad):
  - `m7-far-arrival-holo.png` — player revealed standing in holo-terrain void
    downtown right after the cut
  - `m7-far-mid-sweep.png` — destination materialized near the player, holo
    skyline remnant at the horizon
  - `m7-far-settled.png`, `m7-far-boot-settled.png` — fully settled
  - `m7-shadow-noon-dest-settled.png` — forced noon, far teleport to the
    archery range, settled: avatar/tree/prop shadows all present and correct
    (redraw-on-settle sanity)
  - `m7-near-arrived.png`, `m7-rapid-final.png`
- All probe preview servers + headless Chromes killed. The worktree handoff
  preview on port 5240 was restarted over the FINAL dist and verified 200.
  Nothing committed.

## Open risks / notes

- **Rapid-teleport ground wait can stretch** (~4 s for C in the A→B→C run vs
  ~0.4 s for a single far teleport) — the clipmap carpet re-anchors twice in
  quick succession. Fail-closed and bounded (15 s → visual-blocked); cosmetic
  only.
- **Far arrivals into optional-site gameplay radii** rely on the sites'
  existing arrival priority lane (untouched); site content materializes under
  the sweep like everything else.
- **Shadow hold during a stalled sweep**: casters that attach near the player
  mid-sweep have no static shadow until settle (by design — holo-dark);
  the 60 s safety bound caps the worst case.
- The far path marks `#unsafeVisualReady = true` at ground reveal, so a
  cancel() mid-collision-wait lands in `collision-blocked` (not
  visual-blocked) — correct: the world is visible, movement stays held.
- `?nofarcut=1` is a QA flag; harmless in production (forces the legacy
  covered path).
