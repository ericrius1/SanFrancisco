# Phase 2 audit — leaf effects sites migrate to the engine effects bus

## Files changed

- `src/gameplay/golf/audio.ts`
- `src/fx/swimAudio.ts`
- `src/fx/vehicleAudio.ts`
- `src/fx/fireworksAudio.ts`
- `tools/audio-context-guard.mjs`

No other files were modified. No caller changes were required (verified below).

## What changed per file

### src/gameplay/golf/audio.ts
- `#ensure()` now pulls `audioEngine.bus("effects")` instead of `new AudioContext()`;
  the feature limiter connects to `bus.input` instead of `ctx.destination`.
- `#master` keeps its **0.9** trim (unchanged) and the −12 limiter is kept.
- Removed all per-voice `effectsAudioLevel()` gain multipliers (were at whoosh,
  thwack, landThud, holed): `out.gain`/whoosh ramp values are now bare trims.
- `#ready()` keeps `effectsAudioLevel() <= 0` **only as an early-out gate** and now
  calls `audioEngine.touch(1.5)` so every one-shot's tail survives idle-suspend.
- No own ctx / unlock listeners existed to remove (swing is the gesture); the
  `ctx.state === "suspended"` resume was dropped (engine owns resume).

### src/fx/swimAudio.ts
- Deleted the constructor unlock dance (pointerdown/keydown listeners).
- `#ensure()` pulls the engine effects bus; limiter → `bus.input`; `#master` gain is
  now a **constant 1** trim (was ramped toward `effectsAudioLevel()`).
- Removed `#masterLevel` field and the per-frame master ramp.
- `update()` now `#ensure()`s lazily (`this.#ctx ?? this.#ensure()`) since there is
  no unlock listener to build the graph. Own `ctx.suspend()/resume()` removed.
  `effectsAudioLevel()` kept **only as an early-out gate** (muted + silent → no work).
  Calls `audioEngine.touch()` each frame while `#presence > 0.001` (continuous voice).
- `update(dt, null)` fade path preserved: null sig fades presence/ambience to 0.

### src/fx/vehicleAudio.ts
- Deleted the constructor unlock dance.
- `#ensure()` pulls the engine effects bus; limiter → `bus.input`; `#master` gain is
  a **constant 1** trim. Removed `#masterLevel` field and the master ramp/suspend.
- `debugState.master` now reports the constant trim (`this.#ctx ? 1 : 0`).
- `update()` `#ensure()`s lazily; own suspend/resume removed. `effectsAudioLevel()`
  kept **only as an early-out gate** guarding the `touch(0.3)` continuous hold
  (touched whenever a vehicle mode is active or a board preview is running).
- One-shots (`previewBoard`, `surfEvent`, `carLanding`) replaced their
  `ctx.resume()` with sized `audioEngine.touch(...)` calls (preview dur, 1.4s flow
  tail, 0.8s landing tail). All per-voice tunables/stacks unchanged.
- `update(dt, null)` fade path preserved: voices smooth toward 0 every frame.

### src/fx/fireworksAudio.ts
- Deleted the constructor unlock dance.
- `prewarm()` now calls `audioEngine.prewarm()` first (the shared audio-device
  startup that was fireworks' historical job), then `#ensure()`.
- `#ensure()` pulls the engine effects bus; limiter → `bus.input`. `#master` was
  already an un-attenuated trim (level was applied per-boom), so it is untouched.
  Echo ping-pong bus, noise buffer, and crackle buffer synthesis are unchanged.
- `boom()` drops `effectsAudioLevel()` from `g` (keeps `AUDIO_TUNING` volume²/bass/
  echo/muted), keeps `effectsAudioLevel() <= 0` **only as an early-out gate**, and
  calls `audioEngine.touch(dist/343 + 3.5)` to cover the scheduled flight time plus
  the echo tail. The `ctx.state !== "running"` guard was relaxed to `if (!ctx)`
  since the engine owns resume and Web Audio schedules against the (suspended-safe)
  context clock.

### tools/audio-context-guard.mjs
- Removed `src/fx/vehicleAudio.ts`, `src/fx/swimAudio.ts`, `src/fx/fireworksAudio.ts`,
  and `src/gameplay/golf/audio.ts` from the ALLOWLIST. Remaining entries: engine.ts,
  gameplaySfxBus.ts, natureSoundscape.ts, buskers/audio.ts, fortMasonEnsemble/index.ts,
  net/voice.ts, ui/btsSoundscape.ts.

## Deviations from the plan

- **Fireworks prewarm buffer synthesis is deferred to first `boom()`.** The spec's
  ideal is that `prewarm()` build the buffers/graph on the engine ctx pre-gesture.
  In Phase 2 the engine's public `bus()` is null until the first gesture and the
  internal prewarm accessor (`prewarmBus`) is explicitly a Phase 3 addition — and
  engine.ts is outside this phase's file scope. So `prewarm()` moves the expensive
  AudioContext/device startup to boot via `audioEngine.prewarm()`, but the ~250k
  sample noise/crackle synthesis now runs on the first boom (or on any early
  `unlock()` in headless probes) rather than under the loading cover. Phase 3's
  `prewarmBus` accessor is the intended place to restore pre-gesture buffer build.
  No engine.ts edits were made.

## Caller-change check (no changes needed)

- `new VehicleAudio()` / `new SwimAudio()` (main.ts:595-596), `new GolfAudio()`
  (golf/game.ts:116), `new FireworksAudio()` (fx/fireworks.ts:152): all default
  constructors, still valid (constructors now empty / removed).
- `vehicleAudio.update(...)` (main.ts:4387,4446,4549,5500), `swimAudio.update(...)`
  (main.ts:4388,4447,4562,5515), incl. the `update(dt, null)` pause branches:
  signatures unchanged and null path preserved.
- `vehicleAudio.setBoardStyle/previewBoard/carLanding/surfEvent`, golf one-shots,
  `fireworks.prewarm()` (main.ts:521) / `this.audio.prewarm()` (fx/fireworks.ts:160),
  `boom(...)`: all public signatures unchanged.

## Test results

- `npx tsc --noEmit` — clean (exit 0).
- `npm run test:player-audio` — PASS (mixer probe, foley probe, jump/landing probe,
  and `audio-context-guard: ok`), exit 0.
- `AudioLevel(` grep across the four files: every remaining occurrence is either a
  comment or an early-out gate (golf:36, swim:50, vehicle:407, fireworks:127) — none
  is a gain value.

## Open risks

- First boom / first swim frame after an idle-suspend relies on `touch()` +
  next-frame engine resume; scheduling uses the context clock so this is safe, but
  it is a behavioral change from the old per-feature immediate `resume()`.
- Deferred fireworks buffer synthesis (see deviation) reintroduces a small one-time
  CPU cost on the first boom; acceptable for Phase 2, closed by Phase 3.
