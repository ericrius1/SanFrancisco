# Phase 4 audit — natureSoundscape onto the AudioEngine

## Files changed
- `src/audio/natureSoundscape.ts` (modified)
- `tools/audio-context-guard.mjs` (modified)

## What changed per file

### src/audio/natureSoundscape.ts
- **Imports**: dropped `effectsAudioLevel`; added `import { audioEngine } from "./engine"`.
  Kept `soundscapeAudioLevel` (now used only as an early-out gate).
- **`#ensure()` — context + routing split**: no longer calls `new AudioContext()`.
  Pulls two engine buses via `audioEngine.prewarmBus("world")` and
  `audioEngine.prewarmBus("effects")` (prewarm accessor so it can run pre-gesture).
  The old single limiter → destination is replaced by TWO compressors with the
  same params (thr −14, knee 22, ratio 5, attack 0.005, release 0.35), built by
  the new free helper `makeNatureComp(ctx)`:
  - world side: `#bus` + `#worldBus` (+ their reverb returns, which feed those
    buses) → `#worldComp` → engine `world` group input.
  - effects side: `#alwaysBus` (+ its reverb return) → `#effectsComp` → engine
    `effects` group input.
- **Gain re-map (no double attenuation)**: `#bus.gain` target = `T.master * presence`
  (dropped `soundscapeAudioLevel()`); `#worldBus.gain` = constant 1; `#alwaysBus.gain`
  = constant 1 (dropped `effectsAudioLevel()`). The `#worldBus`/`#alwaysBus` gains are
  set once in `#ensure()` and never written per frame. Presence smoothing preserved
  (`#presence` approach at rate 1.6, `#masterLevel` approach at rate 3.5).
- **Listener block deleted**: removed `#updateListener()` and the four module-scope
  scratch vectors (`tmpPos/tmpFwd/tmpUp/tmpQuat`). The engine owns `ctx.listener`.
- **Visibility gating deleted**: removed `document.visibilityState` reads; `allowed`
  is now `Boolean(T.enabled) && Number(T.master) > 0.001`.
- **Suspend/resume → engine hold**: removed the ~250-262 suspend/resume block. New
  edge-triggered persistent hold: `#holdRelease` field holds the release fn;
  acquired via `audioEngine.acquireHold()` when `presence > 0.02 || #externalAwake`,
  released (and nulled) when neither. Never acquired/released per frame. When the
  engine hasn't resumed the ctx yet, `update()` returns early after managing the
  hold (`if (ctx.state !== "running") return`).
- **Spatial one-shot touch**: `#spawnVoice()` calls `audioEngine.touch(dur + 2.6)`
  sized to the scheduled voice + its tail.
- **Unlock plumbing**: deleted the constructor's pointerdown/keydown/touchstart
  listener dance. All `#unlocked` reads replaced with `audioEngine.unlocked`
  (debugState, voiceBus, update, `#loadBeds`, `#startBeds`); the `#unlocked` field
  is gone. `unlock()` now `await audioEngine.unlock()` then `#ensure()`.
- **`dispose()`**: no longer closes the ctx. Disconnects `#bus`/`#worldBus`/
  `#alwaysBus`/`#worldComp`/`#effectsComp`, releases the hold, drops the ctx ref.
- **Unchanged**: worker buffer synthesis (`#prepareBuffers`), MP3 bed load/decode
  (`#loadBeds`/`#startBeds`), wind synth attach (`new ProceduralWindSynth(ctx, this.#bus)`),
  region influence/blend logic, voice scheduler/reaper, `voiceBus()` return shape.

### tools/audio-context-guard.mjs
- Removed `"src/audio/natureSoundscape.ts"` from the ALLOWLIST.

## voiceBus() shape preserved (exact, unchanged)
`{ ctx, bus, worldBus, alwaysBus, regionalReverbSend, worldReverbSend, effectsReverbSend, noise } | null`,
still null until `audioEngine.unlocked && #buffersReady`. Verified against the two
consumers: `dogPark.ts` (uses `ctx`, `alwaysBus`, `effectsReverbSend`, `noise`) and
`waveAudio.ts` (uses `ctx`, `worldBus`, `worldReverbSend`, `noise`). `setExternalAwake`
still drives the hold + touch (both consumers call it).

## Deviations from the plan
None. All eight requirements implemented as specified.

## Test results
- `npx tsc --noEmit`: clean.
- `node tools/audio-context-guard.mjs`: ok (all sites on allowlist).
- `npm run test:player-audio`: PASS (player foley + jump/landing probes; guard re-run ok).
- Grep `AudioLevel(|visibilityState|listener`: only allowed remnants — one gate
  (`soundscapeAudioLevel() > 0.001` in the voice scheduler) and comment mentions of
  "listener"; no `visibilityState`, no `ctx.listener`, no `#updateListener`.

## Open risks
- `debugState.world` / `debugState.effects` now report the constant unity bus gains
  (1) rather than the old per-frame HUD-scaled values. Cosmetic (debug surface only);
  the true group levels live on `audioEngine.debugState`.
- The engine suspends only when all group levels fall to ~0 (mute/hidden), so the ctx
  now generally stays running in the city whenever a slider is up — this is the
  engine's Phase-1 design, not introduced here; nature's hold only forces resume while
  near a region or `#externalAwake`.
