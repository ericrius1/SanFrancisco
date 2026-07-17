# Phase 5 audit — buskers TrioAudio + fortMason EnsembleAudio → engine "music" group

## Files changed
- `src/gameplay/buskers/audio.ts` (TrioAudio)
- `src/gameplay/fortMasonEnsemble/index.ts` (EnsembleAudio)
- `tools/audio-context-guard.mjs` (allowlist)

(Other files in `git diff --stat` — gameplaySfxBus, natureSoundscape, fx/*, golf, main.ts, package.json — are Phases 1–4, not mine.)

## What changed per file

### src/gameplay/buskers/audio.ts (TrioAudio)
- Added `import { audioEngine }`. Added fields `#offline`, `#holdRelease`, `#inRange`.
  Removed `#retryAt`, `#wantSuspend`, the module `setParam` helper and the
  `_fwd/_up/_pos` THREE temporaries, and the `RESUME_HYSTERESIS`/`RESUME_RETRY_SECONDS`
  constants. Added `AUDIBLE_TAIL`.
- Constructor: offline path sets `#offline = true` and builds the graph on the injected
  ctx straight to `ctx.destination` (unchanged behavior). Live path unchanged (still lazy).
- `#ensureLiveContext()`: `new AudioContext()` + `navigator.userActivation` gate replaced
  by `audioEngine.bus("music")` (non-null = unlocked). Master connects to `bus.input`.
- `#initialize(ctx, synchronousImpulse, output)`: added the `output` param — `bus.input`
  live, `ctx.destination` offline. Master's initial gain now honors the current
  `#holdSilent`/`#masterOpen()` (see "latent gap" under deviations).
- `#masterOpen()`: new. Returns `musicAudioLevel()` offline (bake loudness in — no engine
  group offline) and `1` live (engine music group applies the level).
- `holdSilent()`: unchanged mechanism, but the open value is now `#masterOpen()` instead of
  `musicAudioLevel()`. Still hard-zeros master (and gates `#reverbIn`) — the film-cue gate.
- `update()`: dropped the per-frame `musicAudioLevel()` master poll and the entire
  ctx.listener camera block (engine owns the listener) and the suspend/resume/retry
  hysteresis. Now purely edge-triggered: `acquireHold()` while `distance <= AUDIBLE_RADIUS`,
  release outside with a `touch(AUDIBLE_TAIL)` to cover in-flight tails.
- `get running()`: now `#inRange && ctx.state === "running"`. Needed because the shared
  engine ctx can be "running" for other features while the trio is out of earshot; the
  in-range gate keeps index.ts's scheduling loop stopping exactly as it did when the trio
  owned its own suspended context.
- `captureStream()`: unchanged tap point (`#comp`, the safety compressor). Comment clarified
  that `#comp` is the trio's pre-engine mix node, so the capture is the trio alone.
- `dispose()`: releases the engine hold, disconnects own nodes (added `#master`/`#comp`
  disconnects), never calls `close()`.

### src/gameplay/fortMasonEnsemble/index.ts (EnsembleAudio)
- Swapped `import { musicAudioLevel }` for `import { audioEngine }`. Added `#comp`,
  `#holdRelease`; removed `#suspended`. Added `AUDIO_TAIL`.
- `#ensure()`: `new AudioContext()` + userActivation gate → `audioEngine.bus("music")`.
  Master gain is a constant unity trim (was `musicAudioLevel()`); master → compressor →
  `bus.input`.
- `update()`: deleted the per-frame `ctx.listener` camera block and the `master.gain`
  `musicAudioLevel()` poll and the suspend/resume. Now edge-triggered engine hold while
  `distance < AUDIO_RADIUS + 12` (the same +12 window the `#audible` play-gate uses),
  released outside with `touch(AUDIO_TAIL)`. Still updates the three panners while inside.
- `play()`: dropped the `ctx.resume()`; added `audioEngine.touch(duration*3 + 0.5)` so a
  scheduled note's tail survives idle suspend.
- `dispose()`: releases hold, disconnects own nodes, never `close()`.

### tools/audio-context-guard.mjs
- Removed `src/gameplay/buskers/audio.ts` and `src/gameplay/fortMasonEnsemble/index.ts`
  from the ALLOWLIST (now: engine.ts, voice.ts, btsSoundscape.ts).

## Offline path — level handling (why render loudness is preserved)
The offline render (`offlineRender.ts`) never ticks `update()`; it builds `new TrioAudio(ctx)`
on an OfflineAudioContext and calls `audio.holdSilent(false)` to open the mix at t=0.
Previously `holdSilent(false)` set `master.gain = musicAudioLevel()`, so the rendered master
level was exactly `musicAudioLevel()` (the render tool seeds this via localStorage). The
migration keeps that: on the offline path `#masterOpen()` returns `musicAudioLevel()`, so
`holdSilent(false)` still opens the offline master to `musicAudioLevel()` and the offline
graph still feeds `ctx.destination` directly (no engine group involved). Effective offline
gain is unchanged → render loudness unchanged. Only the LIVE path holds master at unity and
delegates the level to the engine music group (invariant #1, no double attenuation).

## Capture tap
`captureStream()` taps a `MediaStreamAudioDestinationNode` off `#comp` (the safety
compressor). `#comp` is the LAST node the trio owns before its output: master → comp →
[engine music input live | ctx.destination offline]. The tap therefore carries the full trio
mix (master gain + shared reverb + all three voices) and nothing else — no other app audio on
the shared context, since the engine music group sits downstream of the tap. Both paths that
consume `#comp` (the live speaker output into the engine, and the capture destination) get the
identical mix.

Note: the live capture now records at unity trim (independent of the HUD music slider),
because the slider is applied by the engine group downstream of the tap. This only affects the
legacy realtime `captureStream` render path; the canonical deterministic render is
`renderTrioAudioOffline`, whose loudness is preserved exactly (above).

## Hold edges
- TrioAudio: `acquireHold()` on entering `distance <= AUDIBLE_RADIUS` (80); release + a
  `touch(4)` slack on leaving. One hold at a time (`#holdRelease` guards re-acquire).
- EnsembleAudio: `acquireHold()` on entering `distance < AUDIO_RADIUS + 12` (112); release +
  `touch(3)` on leaving. Per-note `touch(duration*3+0.5)` from `play()`.
- Both patterned on `natureSoundscape.update()`'s edge-triggered hold.

## Grep explanation (`musicAudioLevel|userActivation|.suspend(|.resume(|.close(`)
- `fortMasonEnsemble/index.ts:135` — comment only.
- `buskers/audio.ts:2` — import of `musicAudioLevel`, used by the offline path.
- `buskers/audio.ts:111,121` — comments.
- `buskers/audio.ts:123` — `#masterOpen()` returns `musicAudioLevel()` **only on the offline
  path** (`this.#offline ? musicAudioLevel() : 1`). This is the offline loudness preservation,
  not a live gain — expected per the spec.
- No `userActivation`, `.suspend(`, `.resume(`, `.close(` hits remain in either file.

## Deviations from the plan
- Latent gap fixed in `#initialize`: because the live path no longer re-asserts the master
  gain every frame, the master's *initial* value must reflect the current film-cue gate. The
  ctx can be created AFTER a `holdSilent()`/phase call (notably restored state, where
  `#restoreState` calls `holdSilent()` while ctx is still null). So `#initialize` sets
  `master.gain.value = this.#holdSilent ? 0 : this.#masterOpen()` instead of a bare `0`. This
  also makes `#holdSilent` a read field (satisfies `noUnusedLocals`). No behavior change
  offline (constructed with `#holdSilent` false → opens to `musicAudioLevel()`, matching the
  explicit `holdSilent(false)` offlineRender already does).
- No trio/ensemble code dedupe attempted (per instruction).

## Test results
- `npx tsc --noEmit` — clean.
- `npm run test:player-audio` — PASS (all probes green; includes `audio-context-guard: ok`).
- Guard confirms both files removed from the allowlist with no stray `new AudioContext(` left.

## Open risks
- Live `captureStream` loudness now unity rather than slider-scaled (documented above);
  only affects the legacy realtime capture path, not the deterministic offline render.
- `running` now depends on `#inRange`; index.ts's audio-clock re-anchor and scheduling both
  key off `running`, so an out-of-earshot trio advances its transport on the wall clock (dt)
  exactly as before (when the private ctx was suspended). Verified by reading index.ts
  update()/enterPhase/seek paths — all tolerate `ctx` present but `running` false.
- Not run here (Phase 8, main agent drives): `npm run build` and the headless browser
  single-context probe.
