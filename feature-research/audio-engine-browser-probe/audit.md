# Audit — audio-engine single-context browser probe

## Files changed
- `tools/audio-engine-browser-probe.mjs` (created)
- `package.json` (modified — added one npm script line)

## What changed per file

### tools/audio-engine-browser-probe.mjs (new)
Self-contained headless-Chrome/WebGPU probe that proves the single-AudioContext
invariant at runtime. Harness conventions copied from existing probes:
- CDP-over-WebSocket driver, `freePort()`, `waitHttp()`, `findChrome()`, and the
  own-vite spawn/teardown pattern taken verbatim from `tools/boot-probe.mjs`.
- `setKey()` (Input.dispatchKeyEvent) trusted-gesture pattern from
  `tools/surf-probe.mjs`.
- world-ready gate (`__sf.renderIdle()` && `__sf.worldArrival.active === false`)
  and the `?autostart=1` load from `tools/player-audio-browser-probe.mjs`.

Behavior:
1. `Page.addScriptToEvaluateOnNewDocument` installs a counting proxy over
   `window.AudioContext` and `webkitAudioContext` (records every `new`, stashes
   instances on `window.__audioCtxProbe = {count, instances, states()}`), and a
   separate count-only proxy over `OfflineAudioContext` /
   `webkitOfflineAudioContext` (`window.__offlineAudioCtxProbe.count`). Runs
   before any app module.
2. Launches its OWN vite on a fresh free port with `--strictPort` (never 5179);
   Chrome intentionally omits `--autoplay-policy=no-user-gesture-required` so the
   pre-gesture suspended state is observable.
3. Boot assertions: exactly 1 AudioContext, state `suspended`, 0 Offline,
   `debugState.unlocked === false`, no audio-related console errors.
4. Trusted CDP `KeyW` down / 2s / up gesture. Assertions: count still 1, state
   `running`, `debugState.unlocked === true`, effects group level > 0.
5. Mute via the real HUD path `#hud .mute-btn` (`.click()`), reachable from
   window without a synthetic pref poke.
6. Final assertions: count still exactly 1, Offline count 0, no audio console
   errors. Prints a PASS summary with the full debugState at each phase.

### package.json
Added `"test:audio-engine:browser": "node tools/audio-engine-browser-probe.mjs"`
immediately after `test:player-audio:browser`.

## Deviations from the plan
- The closest model probe (`player-audio-browser-probe.mjs`) uses Playwright
  against an EXTERNAL server (`SF_PROBE_URL`), which conflicts with the required
  "launch own vite on a fresh port" rule. Resolved by taking the self-contained
  vite-spawn + raw-CDP harness from `boot-probe.mjs` (same repo, same
  conventions) and the readiness/gesture logic from the Playwright model. No
  Playwright dependency; matches the repo's fresh-port rule exactly.
- Mute assertion was NOT skipped: `#hud .mute-btn` is a clean, window-reachable
  DOM path (AudioControls flips `AUDIO_PREFS.enabled` on click), so the probe
  exercises it directly.

## Test results
`npm run test:audio-engine:browser` → PASS (ran twice, deterministic).
- boot: count 1, state suspended, offline 0, unlocked false, 0 audio errors.
- after gesture: count 1, state running, unlocked true, effects level 0.462.
- after mute: count still 1; ctx correctly idles to suspended (all group levels
  → 0, engine's idle-suspend policy).
- final: count 1, offline 0, 0 console errors.

## Bugs found
None. The consolidated engine holds the single-context invariant across boot,
unlock, and mute.

## Open risks
- Probe timing is generous (120s ready wait, 2s walk, 1.2s settles) to stay
  robust on a cold vite; a severely overloaded machine could still time out on
  world-ready. No functional risk to the app.
- Not committed, per instructions.
