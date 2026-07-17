# Phase 7 audit — btsSoundscape rides the engine + final guard ratchet

## Files changed
- `src/ui/btsSoundscape.ts`
- `tools/audio-context-guard.mjs`

## What changed per file

### src/ui/btsSoundscape.ts
- Added `import { audioEngine } from "../audio/engine";`.
- Removed the module-level `let actx` and the `audioCtx()` helper (which built
  `new (window.AudioContext || webkitAudioContext)()`).
- `playChannels()` now pulls `audioEngine.bus("effects")`; null (pre first
  gesture) → silent no-op. The per-sound chain connects `src → gain(0.85) →
  bus.input` instead of `ctx.destination`. Buffer is created on the engine ctx.
  Added `audioEngine.touch(chs[0].length / SR + 0.1)` sized to the clip duration
  so idle-suspend can't clip a toy sound.
- Kept the 0.85 gain as a plain per-sound trim.
- `deactivate()` no longer closes/nulls any context — the engine owns it. Removed
  the `actx` close + null-out block; kept rAF/listener teardown.
- Updated the stale module-level doc comment (was "lazily-created AudioContext
  (closed when you leave the tab)") to describe riding the shared engine's
  effects group and obeying global mute / FX slider.

### tools/audio-context-guard.mjs
- ALLOWLIST is now exactly `new Set(["src/audio/engine.ts"])`.
- Reworded the allowlist comment from "Shrinks per phase" to the permanent
  invariant ("only the engine may construct a context").
- Updated the file header comment: consolidation complete; engine.ts is the sole
  permitted site.

## Deviations from the plan
None. Task item 4 (docs): `rg -l "AudioContext" docs AGENTS.md` returned no
matches, so there were no stale doc statements to fix.

## Behavior change (intentional bug fix)
BTS toy sounds (synthesis explorer + build-a-bird) previously used their own
AudioContext straight to destination, ignoring the global mixer. They now route
through the engine effects group, so global mute and the FX slider apply.

## Test results
- `npx tsc --noEmit` → exit 0.
- `npm run test:player-audio` (includes audio-context-guard) → all PASS;
  guard prints "ok (all AudioContext sites on the allowlist)".
- `rg -n "AudioContext" src/ui/btsSoundscape.ts` → only a code comment (SR line)
  and user-facing chapter prose remain; no constructor, no context type
  annotations.

## Open risks
- The BTS chapter prose (SOUNDSCAPE_TAB_HTML, ~line 472/478) still narrates the
  old "toys open their own context on your first click, and close it again" model
  to the reader. Left as-is — it is user-facing chapter copy, outside this
  plan's mechanical scope, and touching it is a content decision, not a code fix.
