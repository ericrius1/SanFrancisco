# Phase 1 audit — AudioEngine consolidation

## Files changed

- `src/audio/engine.ts` (new, 240 lines)
- `tools/audio-context-guard.mjs` (new, 61 lines)
- `src/main.ts` (modified — 3 edits)
- `package.json` (modified — scripts)

## What changed per file

### src/audio/engine.ts (new)
The single shared AudioContext and its four group buses, per the "Engine design"
section of the spec.

- `AudioGroupName` / `EngineBus` exports; `class AudioEngine`; module singleton
  `export const audioEngine = new AudioEngine();`.
- Lazy `#ensure()`: four group GainNodes (initial gain 0) → `#master` GainNode
  (gain 1, reserved for future global fades) → `ctx.destination`. No engine-level
  compressor. Guards `typeof AudioContext === "undefined"` → null for Node probes.
  Bare `new AudioContext()` (no options), matching every current site.
- Constructor registers the pointerdown/keydown/touchstart unlock dance ported
  from `gameplaySfxBus.ts:35-47`, guarded by `typeof window !== "undefined"`.
- API: `prewarm()`, `unlock()` (probe force-open, mirrors gameplaySfxBus),
  `get unlocked`, `bus(group, holdSeconds=0.8)` (null until unlocked; touches +
  resumes), `touch(seconds=0.8)`, `acquireHold({background?})` (idempotent
  release; background holds keep running while hidden), `update(dt, camera)`,
  `get debugState`, `dispose()` (closes ctx — the only closer).
- `update()`: polls `document.visibilityState`; music/effects/world targets =
  level × (visible?1:0), voice = `voiceAudioLevel()` unconditionally; per-group
  smoothing via the ported `approach` helper + `setTargetAtTime(..., 0.025)` while
  running; `wantRunning = background>0 || (visible && (hold>0 || persistent>0))`;
  suspends when `unlocked && running && !wantRunning && all smoothed levels ≤
  0.001`; resumes when `wantRunning && unlocked`.
- `#updateListener()`: the ONE `ctx.listener` implementation. Ported from
  `natureSoundscape.ts:523-557` including the deprecated Safari
  `setPosition`/`setOrientation` fallback and the 0.02 (pos/forward) / 0.05 (up)
  `setTargetAtTime` damping constants.

### tools/audio-context-guard.mjs (new)
Node, no deps. Recursively scans `src/**/*.ts` for `new AudioContext(` /
`webkitAudioContext`, ignoring `OfflineAudioContext` (stripped before matching).
Explicit `ALLOWLIST` = the 10 current sites + `src/audio/engine.ts`. Any match
outside the allowlist → prints the offenders and `process.exit(1)` with a message
pointing at `src/audio/engine.ts`.

### src/main.ts (3 edits)
- Added `import { audioEngine } from "./audio/engine";` next to the
  `GameplaySfxBus` import.
- `audioEngine.prewarm();` immediately after `gameplaySfxBus.prewarm();`.
- One `audioEngine.update(frameDt, camera);` per frame (see placement below).
- Added `audioEngine` to the `__sf` debug object next to `gameplaySfxBus`.

### package.json
- New script `"test:audio-guard": "node tools/audio-context-guard.mjs"`.
- Appended `&& node tools/audio-context-guard.mjs` to `test:player-audio`.

## Per-frame update placement — where and why

`audioEngine.update(frameDt, camera)` is placed once, right after `frameDt` is
computed at the top of `tick()` (src/main.ts, just before
`noteWorldBackgroundMotion()`), i.e. **before all four of the branch early
returns** in the tick:

- reading-overlay / museum freeze (`return` ~4308)
- expanded-minimap branch (`return` ~4413)
- paused branch (`return` ~4476)
- normal active branch (`return` ~4587)

A single pre-branch call is the minimal correct placement: the spec's four
candidate sites (the `vehicleAudio.update` calls near 4380/4439/4542/5493) each
live inside a different mutually-exclusive branch, so covering all of them with
one call requires a point that runs before the branch split. Putting it here also
satisfies "the paused branches must still call it" — voice keeps running while
paused because the engine tick runs regardless of branch. `camera` is in closure
scope (destructured from `createRenderCore` at the top of `main`).

## Deviations from the plan

- Listener port is decoded directly from `camera.matrixWorld.elements`
  (position from the translation column; forward = −Z basis column, up = +Y basis
  column, both normalized) rather than calling `getWorldPosition/Direction/
  Quaternion`. This yields identical vectors while keeping engine.ts THREE-free
  and asset-free (massive-app lazy-loading rule #5) and matches the spec's loose
  `{ matrixWorld: unknown }` update signature. Damping constants and the Safari
  fallback are preserved exactly.
- `prewarmBus(group)` (the pre-gesture bus accessor) is intentionally NOT added
  yet — the spec introduces it in Phase 3. Nothing in Phase 1 needs it.

No files outside the plan's scope were touched. None of the 10 existing audio
feature files were modified.

## Test results

- `node tools/audio-context-guard.mjs` → `ok (all AudioContext sites on the
  allowlist)`, exit 0. Negative test (temporary stray `new AudioContext()` in a
  scratch src file) → exit 1 with the offender listed.
- `npx tsc --noEmit` → clean.
- `npm run test:player-audio` → exit 0 (all three probes PASS, then the guard
  runs and passes). The probes' mocked `voiceBus()` shape was untouched.

## Open risks

- Idle suspend is conservative: because the voice group target is
  `voiceAudioLevel()` unconditionally, the "all smoothed levels ≤ 0.001" suspend
  gate effectively only trips when the master mixer is muted (or the tab is hidden
  with voice also muted). This is exactly the spec's stated condition and is moot
  in Phase 1 (no feature routes through the engine yet), but worth revisiting once
  features migrate if idle-tab suspension becomes desirable while unmuted.
- The listener uses the camera's `matrixWorld` as it stands at the top of the
  frame (before this frame's chase-camera update). This is at most one frame
  stale and is further smoothed by `setTargetAtTime`; the previous per-feature
  listener ran mid-branch after camera updates. Inaudible in practice.
