# M1–M3 review punch-list fixes — audit

## Files changed

- `src/net/net.ts`
- `src/app/bootScreen.ts`
- `src/app/boot/bootPhysics.ts`
- `src/core/physics.ts`
- `src/main.ts`

(`src/app/frameDriver.ts`, `src/app/ringCoordinator.ts`, `src/world/tiles.ts` were read/verified but not modified.)

## Per-item changes

### 1. BLOCKING — net welcome/roster handler race (`src/net/net.ts`)

Preferred fix, setter variant: `onWelcome`, `onRoster`, and `onStatus` are now
accessor pairs backed by `#onWelcome`/`#onRoster`/`#onStatus`. Assigning a
handler replays the missed hydration at assignment time:

- `onRoster`/`onWelcome` setters replay when `selfId !== 0` (a welcome already
  hydrated the roster; `selfId` resets to 0 on socket close, so a stale
  pre-disconnect welcome is never replayed).
- `onStatus` setter replays the current status (with the cached
  `#statusDetail`, new field) when `status !== "connecting"` — covers a missed
  "online", "full", or "offline" transition.
- Replay happens exactly once per handler: if the welcome arrives after a
  handler is wired it dispatches normally; if before, the setter fires it.
  There is no window where it can run twice, and the fix is robust to future
  reorderings of the P3 wiring.
- DEV-only `console.info("[net] welcome arrived before handler wiring — replayed")`
  in the `onWelcome` setter as the requested diagnostic.

No `main.ts` change was needed for this item (the setters fire at the existing
assignment sites, main.ts:1944/2005/2149).

### 2. Silent post-reveal boot failure (`src/app/bootScreen.ts` fail(), :76)

`fail()` now does `this.loading.classList.remove("done")` (re-shows the folio
that the start handler dismissed at main.ts:630) plus a `console.error`. The
existing `boot().catch` at main.ts:4964 already logged; the failure banner +
click-to-reload now render visibly even after Start.

### 3. Collider-index fail-open healing (`src/app/boot/bootPhysics.ts` :38, `src/core/physics.ts`)

- `bootPhysics` replaces the one-shot `console.warn` with a bounded retry:
  3 retries at 2 s / 8 s / 30 s backoff, each attempt re-running
  `physics.initColliderServices()`. Final failure logs a prominent
  `console.error` ("building collision stays offline this session").
- `physics.initColliderServices()` made idempotent under retry: new
  `#landmarkQueryHydrated` flag skips the landmark/bridge query-mirror fetch on
  re-entry once it has hydrated, so retries cannot duplicate query-world solids
  (each retry does rebuild a fresh `BuildingColliderIndex`, which is the part
  that can fail).
- Verified (code read, not modified): tile background-streaming resume is NOT
  solely dependent on collision arrival. `RingCoordinator.#refreshResidency`
  (src/app/ringCoordinator.ts:240-242) calls
  `tiles.resumeBackgroundStreaming()` FIRST and only then
  `onExpansionStalled` → `tiles.beginBackgroundExpansion()` — the required
  resume → expansion order. `resumeBackgroundStreaming` (tiles.ts:859) clears a
  settled visual prime before `beginBackgroundExpansion`, and the visual prime
  settles independently of colliders (`#drainColliderReady` is skipped during
  the prime; residency counts visual parts only). Confirmed empirically in
  probe run C: with the first collider attempt failing, the world still
  streamed to full settle.

### 4. Reveal gate missing a release path (`src/main.ts` voidTick, was :767)

Gate is now
`voidFrames >= 2 && (bootHoldReleased || initialArrivalReleased)`, so a runtime
relocation that releases the boot hold through
`worldArrival.onStateChange` → `initialArrivalReleased` (main.ts:432-435) no
longer falls through to the 15 s cap.

### 5. Progress bar going backwards (`src/app/bootScreen.ts` progress(), :65)

New `#progressMax` field; `progress()` clamps the bar width to the running
maximum (labels still update freely). P3's 62 after P1's 88 no longer moves the
bar backwards.

### 6. Unhandled-rejection window in P0 (`src/main.ts` :222)

`void gpuPromise.catch(() => {})` marker right after `bootGpu(app)` — silences
the transient unhandled rejection while `await mapPromise` is pending, without
swallowing the real `await gpuPromise` (a rejection still throws into boot()'s
catch). `mapPromise` is awaited immediately so it needs no marker.

### 7. Adaptive resolution during construction (`src/main.ts` frameDriver wiring, was :772-781)

The `adaptiveRes` passed to `startFrameDriver` is now a wrapper that forwards
`update(emaMs)` only once `constructionDoneFlag` is set (P4 handoff), so P3
construction-slice frame times can never trigger a spurious downscale.
`frameDriver.ts` unchanged.

## Deviations from suggested approach

- Item 1: used the setter variant rather than an explicit `replayPending()`
  call — it removes the double-dispatch window entirely (an explicit call after
  wiring could re-run a welcome that had already dispatched normally between
  the `onWelcome` assignment and the call).
- Item 3: the collider index init consumes `tiles.manifest` directly
  (no network fetch of its own in the current wiring), so a natural failure is
  rare; blocking `landmark-colliders.json` cannot make `initColliderServices`
  reject (that fetch is internally caught by design). The failure simulation
  therefore used a temporary DEV-only `?failcolliders=1` first-attempt
  rejection in bootPhysics.ts, removed after the test (verified removed;
  typecheck + build re-run afterward).
- Item 3 also touched `src/core/physics.ts` (not named in the punch list) for
  the retry-idempotency guard — retrying without it would duplicate landmark
  query-world solids.

## Test results

- `npx tsc --noEmit` — clean.
- `npm run build` — clean (4.3 s, precompress OK), re-run after scaffolding
  removal.
- Headless probes (fresh random ports, Playwright-style headless Chrome + CDP,
  warm shader-cache profile), `scratchpad/punchlist-probe.mjs` +
  `scratchpad/replay-race.mjs`:
  - **Run A** (vite preview, `?autostart=1&fullfps=1&profile=1`): clean boot,
    **0 console errors**, control mark **1100 ms** (within the 1.0–1.4 s warm
    band), reveal 1226 ms, ring settled to full reveal (frontComplete ~23 s).
    Screenshot `punch-a-settled.png` shows the fully revealed world + HUD.
  - **Run B** (vite dev + relay): app state — not just the socket — reflects
    the welcome: `__sf.net.status === "online"`, `selfId` assigned, and
    `__sf.player.avatarTraits` exactly equals `avatarFromSeed(selfId)`
    (avatar-seed adoption ran). 0 console errors.
  - **Race replay check** (deterministic): constructed a `Net`, let the real
    relay `welcome` dispatch into the DEFAULT no-op handlers, then assigned
    handlers — each replayed on assignment (`roster:2`, `welcome:113`,
    `status:online`). PASS.
  - **Run C** (`?failcolliders=1` temp scaffolding): retry warn fired at
    attempt 1, healed (no final error), world streamed to full settle. PASS.
    Scaffolding removed after.
- All probe preview/dev servers and Chrome instances killed (verified; the
  remaining vite listeners on this machine belong to the main repo and another
  worktree, started before this session). Nothing committed.

## Open risks

- Item 1: if a welcome arrives, the socket drops, and wiring happens before
  reconnect, the roster/welcome replay is intentionally skipped (`selfId` is 0)
  and only `status` replays — the reconnect welcome then hydrates normally.
- Item 3: after final retry exhaustion the session deliberately stays
  fail-open (no collision) with a console.error; there is no user-facing HUD
  banner for that terminal state (bootArrivalTick's existing
  "could not settle safely" message covers the per-tile failure path only).
- Item 5: the clamp is boot-lifetime (BootScreen instance); if a future flow
  reuses the folio for a second progress pass it will need a reset.
- Item 7: adaptive resolution is now entirely inert until `constructionDone`;
  a pathological pre-handoff GPU overload (not observed) would go unmitigated
  for that ~0.3 s window.
