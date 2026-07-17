# Phase 3 audit — gameplaySfxBus rides the engine (+ prewarmBus, fireworks carry-over)

## Files changed
- `src/audio/engine.ts`
- `src/audio/gameplaySfxBus.ts`
- `src/fx/fireworksAudio.ts`
- `tools/audio-context-guard.mjs`

## What changed per file

### src/audio/engine.ts
Added `prewarmBus(group: AudioGroupName): EngineBus | null`. It is `bus()` minus the
unlocked gate and minus `touch()`/resume: it just `#ensure()`s and returns
`{ ctx, input: this.#groups[group] }`. Doc comment states it is prewarm-only —
creation is allowed pre-gesture, audibility is not (group gains start at 0, ctx stays
suspended until unlock). No other engine changes.

### src/audio/gameplaySfxBus.ts (migrated)
- Public API unchanged: `prewarm`, `unlock`, `touch`, `voiceBus() -> {ctx,dry,room,noise}|null`,
  `update(dt, continuous)`, `dispose`, `debugState`. `GameplaySfxVoiceBus` shape unchanged.
- Deleted: `new AudioContext()`, the constructor's pointerdown/keydown/touchstart unlock
  listeners, the `effectsAudioLevel` import + all its uses, `document.visibilityState`
  gating, the `#unlocked`/`#hold`/`#level` fields, the module-level `approach` helper, and
  the ctx suspend/resume logic.
- `#ensure()` now pulls `audioEngine.prewarmBus("effects")` (so the room/noise graph builds
  pre-gesture under the loading cover). Graph: `#dry` + convolver `roomReturn` -> limiter
  (thr -15, kept as feature glue) -> `#master` (constant unity trim) -> engine effects input.
  Convolver room impulse and 1.35s stereo noise buffer synthesis are byte-for-byte the same.
- `#master` is a fixed `gain = 1` trim (the engine effects group now applies the HUD
  volume/mute), so no per-frame master polling remains.
- `voiceBus(holdSeconds)` gates on `audioEngine.bus("effects", holdSeconds)` being non-null
  (that call is the unlocked gate + `touch(holdSeconds)` + resume in one), then returns our
  own `{ctx, dry, room, noise}`. Returns null until `audioEngine.unlocked`, same contract.
- `touch(seconds)` -> `audioEngine.touch(seconds)`.
- `update(_dt, continuous)` -> `if (continuous) audioEngine.touch(0.15)` (no-op otherwise).
- `unlock()` -> `await audioEngine.unlock(); this.#ensure()`.
- `dispose()` disconnects `#master` only; never closes the shared ctx.
- `debugState` keeps its `{ctx, unlocked, level, hold}` shape, now sourced from the engine
  (`this.#ctx?.state`, `audioEngine.unlocked`, `audioEngine.debugState.levels.effects`,
  `audioEngine.debugState.hold`).

### src/fx/fireworksAudio.ts (carry-over)
`#ensure()` now uses `audioEngine.prewarmBus("effects")` instead of `audioEngine.bus("effects")`,
so `prewarm()` (main.ts:521, under the loading cover) builds the full echo graph + ~250k
noise/crackle samples pre-gesture as originally designed. `boom()`'s early-out gates
(`muted`, `volume<=0`, `effectsAudioLevel()<=0`, `#ensure()` null) and its
`audioEngine.touch(...)` are unchanged. Updated the `prewarm()` doc comment (it no longer
defers the graph build to the first boom).

### tools/audio-context-guard.mjs
Removed `"src/audio/gameplaySfxBus.ts"` from the ALLOWLIST. Guard now covers engine.ts,
natureSoundscape.ts, buskers/audio.ts, fortMasonEnsemble/index.ts, net/voice.ts,
ui/btsSoundscape.ts, plus engine.ts.

## Hold mapping (how the semantics carry over)
- `touch(seconds)` -> `audioEngine.touch(seconds)` (extends the engine idle hold).
- `voiceBus(holdSeconds)` -> `audioEngine.bus("effects", holdSeconds)`, which internally
  `touch(holdSeconds)`s and resumes; a null return preserves the pre-gesture lock.
- `update(dt, continuous)`: `continuous` foley (e.g. footstep rustle bed) -> `touch(0.15)`
  every call, mirroring vehicleAudio's per-update `touch(0.3)`; the old non-continuous hold
  decay is now the engine's job, so the non-continuous branch is a no-op.
The engine's per-frame `update()` (main.ts:4285) does the actual gain smoothing + idle
suspend against these holds.

## main.ts interaction (verified, not edited)
- 524 `new GameplaySfxBus()` (empty ctor), 525 `gameplaySfxBus.prewarm()` now creates the
  engine ctx via `prewarmBus` and builds the room/noise graph pre-gesture (the point of
  prewarmBus), 526 `audioEngine.prewarm()` is idempotent afterward.
- The bus's `update()` is driven from `PlayerFoleyAudio.update` (playerFoleyAudio.ts:128),
  itself called at main.ts:655 — semantics hold: continuous rustle keeps touching the engine.
- The six consumers (paint/bubble/foley/modeTransition/jumpLanding/door) only use
  `voiceBus()`/`touch()`/`update()`; their construction sites (523-600) and the `__sf`
  debug entry are untouched.

## Deviations from plan
None. Followed the spec's explicit signal order (limiter -> trim -> engine input) and the
verify checklist. One tiny extra: reworded a comment in gameplaySfxBus.#ensure so the word
`effectsAudioLevel` does not appear at all, making the required grep unambiguously clean.

## Test results
- `npx tsc --noEmit`: exit 0.
- `npm run test:player-audio`: audio-mixer probe PASS, player-foley probe PASS,
  jump/landing probe PASS, audio-context-guard: ok.
- `grep effectsAudioLevel|document.visibilityState src/audio/gameplaySfxBus.ts`: CLEAN.

## Open risks
- Because the migrated `update()` cannot reference `effectsAudioLevel` (grep requirement),
  continuous foley `touch(0.15)`s the engine even when the effects group is muted. Effect is
  silent (group gain 0) but the shared ctx will not idle-suspend while foley is continuously
  active under mute — a minor efficiency delta versus vehicleAudio, which gates its touch on
  the level. No sonic/behavioral impact.
- `voiceBus()` no longer resumes via `prewarmBus`; it resumes through `audioEngine.bus()`
  instead. Confirmed equivalent — `bus()` resumes a suspended ctx just like the old path did.
