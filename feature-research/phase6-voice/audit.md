# Phase 6 audit — src/net/voice.ts on the shared AudioEngine

## Files changed
- `src/net/voice.ts` — migrate WebRTC voice chat off its own AudioContext onto the engine "voice" group.
- `tools/audio-context-guard.mjs` — remove `src/net/voice.ts` from the allowlist.

No other files touched. main.ts and src/ui/audioControls.ts were read only (no caller change needed).

## What changed, per file

### src/net/voice.ts
- **Import**: added `import { audioEngine } from "../audio/engine";`.
- **Header doc**: updated the graph description — per-peer chain now ends at the engine "voice" group input; noted the engine owns the ctx + listener and that a background hold keeps the ctx running while the tab is hidden.
- **Fields**: removed `#ctx: AudioContext | null`. Added `#hold: (() => void) | null` (the single background engine hold).
- **`setMic(true)`**: now calls `void audioEngine.unlock()` first (the mic click IS a user gesture). Removed the old `void this.#ensureCtx()?.resume()`. Calls `this.#refreshHold()` (both on/off paths) so the hold tracks mic state.
- **`#refreshHold()`** (new): edge-triggered helper. `want = micOn || peers.size > 0`; acquires one `audioEngine.acquireHold({ background: true })` when wanted and none held, releases when not wanted. Never called per frame.
- **`#ensureCtx()`**: removed. It became dead once the only remaining consumer (`#wireAudio`) needed the group `input` node as well as the ctx; `#wireAudio` now goes through `audioEngine.prewarmBus("voice")` directly (see deviation).
- **`#createPeer()`**: `this.#refreshHold()` right after `this.#peers.set(id, p)` — first peer wires the ctx and (once unlocked) the engine resumes it next frame.
- **`#wireAudio()`**: gets `bus = audioEngine.prewarmBus("voice")` (prewarm accessor, not `bus()`, so a remote track arriving before any local gesture still builds the receive graph). Chain unchanged through panner→gain; final `.connect(bus.input)` replaces `.connect(ctx.destination)`. Initial per-peer gain is now `VOICE_TUNING.values.volume` (dropped the `* voiceAudioLevel()`). Hidden muted `<audio>` element, MediaStreamSource, HRTF panner, and the pre-gain analyser tap are all untouched.
- **`drop()`**: `this.#refreshHold()` right after `this.#peers.delete(id)` — releases the hold when the last peer is gone and the mic is off.
- **`update()`**: deleted the entire per-frame `ctx.listener` block (engine owns the listener). Param renamed `camera` → `_camera` (now unused; signature kept for main.ts). Per-frame gain is `t.volume` (dropped `* voiceAudioLevel()`). `voiceAudioLevel()` kept only as `const audible = voiceAudioLevel() > 0`, a cheap gate on the speaking-indicator RMS block (was `level > 0`).
- **`debugState()`**: `ctx` now reports `audioEngine.debugState.ctx` (the shared ctx state) instead of the removed `#ctx`.
- **`dispose()`**: drops all peers, then `this.#hold?.(); this.#hold = null;`. No longer closes any ctx (removed `void this.#ctx?.close()`).
- Removed the module-level `TMP` scratch object (only the deleted listener block used it). `THREE` import stays — still used for `THREE.Vector3` / `THREE.Camera` types.

### tools/audio-context-guard.mjs
- Removed `"src/net/voice.ts"` from `ALLOWLIST` (now `engine.ts` + `btsSoundscape.ts`).

## Hold acquire/release edges (requirement 6)
Edge-triggered via `#refreshHold()`, `want = micOn || #peers.size > 0`:
- **Acquire**: in `setMic` (mic turns on with no peers) and in `#createPeer` (first peer added). One background hold total; `#refreshHold` no-ops while already held.
- **Release**: in `drop` (last peer removed while mic off) and in `setMic` (mic turns off while no peers) and in `dispose`.

Because the hold is `background: true`, the engine keeps the ctx running while the tab is hidden — matching today's "voice never suspends" behavior. A peer connecting while the ctx is suspended: `#createPeer` acquires the hold → engine `update` sees `background > 0` (wantRunning) and, if unlocked, resumes next frame; if not yet unlocked the ctx stays suspended (correct pre-gesture gate) and resumes on the first gesture.

## Grep explanations — `rg "voiceAudioLevel|\.listener|\.close\(|\.resume\(|new AudioContext" src/net/voice.ts`
- L3 `import { voiceAudioLevel }` — needed for the speaking-indicator gate below.
- L251, L301, L312-313 — comments only.
- L288 `p.pc.close()` — RTCPeerConnection teardown in `drop()`, not an AudioContext. Correct.
- L315 `voiceAudioLevel() > 0` — the one remaining runtime use: a cheap early-out gate on the speaking meter (invariant #1 permits gate use; it is not a gain value). The engine's voice group gain applies the actual attenuation.
- No `.listener` (deleted), no `.resume(` (engine owns resume), no `new AudioContext` (uses the shared engine ctx).

`rg "voice\." src/main.ts` call sites: `voice.drop`, `voice.update(camera)`, `voice.onSpeaking`, `voice.onMicChange`, `voice.setMic`, `voice.micOn`, `new Voice(...)` — all public, all unchanged. No caller change required.

## Deviations from the plan
- The plan (requirement 1) described `#ensureCtx()` returning the engine ctx via `prewarmBus("voice")`. After the migration the only remaining consumer, `#wireAudio`, needs both the ctx and the group `input` node, so it calls `prewarmBus("voice")` directly (that call IS the `#ensureCtx` body plus the input). Keeping a separate `#ensureCtx()` would have been dead code (`noUnusedLocals` spirit / codebase style), so it was removed. The prewarm-accessor rationale comment moved onto the `#wireAudio` bus acquisition. Net behavior is exactly as specified.

## Test results
- `npx tsc --noEmit` — clean.
- `npm run test:player-audio` — PASS (player-foley + jump/landing probes), and `audio-context-guard: ok` with voice.ts off the allowlist.

## Open risks
- Requirement 5 (listener continuity while paused) verified, not assumed: main.ts line 4285 calls `audioEngine.update(frameDt, camera)` before every tick branch's early return (active / map / paused / reading-overlay), so the engine's `#updateListener` keeps tracking the camera even though `voice.update` no longer touches the listener. voice.update is still called in the paused branch (main.ts:4470) for gains/panners/scan.
- Speaking indicator is now suppressed when the voice group is muted (`voiceAudioLevel() === 0`) — matches prior behavior where `level` (which included `voiceAudioLevel()`) gated the same block.
