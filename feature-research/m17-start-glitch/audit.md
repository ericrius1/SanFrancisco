# M17 — start-moment "grid to infinity" glitch: audit

## Files changed
- `src/render/materialize.ts` — added exported `bandForRadius()`; `setFront` band now defaults to the radius-scaled band instead of `MATERIALIZE_DEFAULT_BAND` (48).
- `src/app/ringCoordinator.ts` — local `bandFor` replaced by the shared `bandForRadius` import (constants deduped; behavior identical).
- `src/main.ts` — P1 warm frame counts toward a new `voidFramesPresented` counter; reveal gate (`voidRevealCheck`, extracted from voidTick) now requires ≥1 PRESENTED void-front frame (via `pipeline.compileHeld`) in addition to the original `voidFrames >= 2`, and keeps running from the real loop's `afterRender` so an all-held void phase still reveals; 15 s cap unchanged.

## Root cause (hypothesis 3 variant — with hypothesis 1/2 experimentally killed)
Two ingredients, both required:

1. **`materializeField.holo()` left (radius = 0, band = 48).** `holo()` →
   `setFront(x, z, 0)` used the default band 48. With band 48, the edge-glow
   window (~3 bands) and the terrain visibility tail (front + 3·band) extend
   ~144 m — the bright "M13 grid to what reads as infinity" look. main.ts boot
   (old line ~547) called `holo()` and then presented one covered frame
   (`renderFrame()` before `pipeline.warmup("boot")`) BEFORE the ring
   coordinator (P5) rewrote the band via its radius-scaled `bandFor` → that
   presented frame carried the bad look.
2. **Every subsequent void-phase frame was gate-held.** The exclusive-compile
   gate (`pipeline.ts` `exclusiveCompileDepth` → `renderSkipCompile`) held
   presents through the boot compile chain, so the canvas kept the bad frame.
   The old reveal gate counted `voidFrames >= 2` — TICKS, not presents — so
   autostart flipped `body.started`, the cover faded onto the stale bad frame,
   and the correct ~5 m pool only appeared ~1–1.5 s later when presents
   resumed.

### Experiment evidence
- **Kill-shot (hypotheses 1+2 dead):** during the glitch window, writing
  `__sf.materialize.field.frontRadius.value = 500` from the page changed the
  presented image within ~150 ms (`m17-ks-before-poke.png` vs
  `m17-ks-after-poke.png` in the scratchpad) — the material reads the live
  shared uniform objects. Import-specifier audit also showed a single
  consistent `render/materialize` module path (no duplicate module instance).
- **Held presents:** the `renderSkipCompile` tracer counter climbed every
  frame across the glitch window (12 → 62 over the start transition,
  `m17-killshot.mjs` log), and the unfixed build's screencast shows the cyan
  fraction frozen at exactly 65.19 % for ~600 ms — a not-repainting canvas.
- **Bad-look provenance:** the glitch frame's signature (bright grid fading
  out by ~150 m, holo towers near the player) is exactly the
  (radius≈0, band=48) shading; CPU state during the glitch read
  radius 2.0 / band 1.0 (correct), proving the visible frame was stale.

## Fix
- **(a) Band can never contradict the radius** (`materialize.ts`):
  `bandForRadius(radius)` (min 1 m, 0.35·radius, capped at 48) is now the
  `setFront` default; `holo()` therefore collapses to (0, band 1) — even the
  covered P1 warm frame renders the tiny-pool look. The ring coordinator uses
  the same shared helper (`bandFor = bandForRadius`). Explicit band callers
  (`__sf.materialize.setFront` with band) keep their behavior.
- **(b) Cover cannot fade before a presented void frame** (`main.ts`):
  `voidFramesPresented` counts frames where `pipeline.compileHeld` was false
  at render time, starting at the P1 warm frame (first frame rendered after
  `holo()`, i.e. first frame carrying the final void uniforms). Reveal (and
  the autostart cover fade) requires `voidFrames >= 2 && voidFramesPresented
  >= 1`. The check was extracted to `voidRevealCheck()` and is also called
  from the real loop's `afterRender` because a long cold-boot compile chain
  can hold every void-phase frame past the P4 handoff (observed: reveal would
  otherwise never fire). The 15 s cap remains as the backstop; if it fires
  while presents are held, fix (a) guarantees the stale frame is still the
  correct pool look.

Deviation note: an intermediate version required 2 PRESENTED frames and did
not count the P1 warm frame — it wedged reveal behind cold-boot compile chains
(measured +7 s on a cold Metal shader cache, reveal only via the 15 s cap).
Final form keeps warm/cold boot timing at parity with pre-fix.

## Probe results
Probes in the session scratchpad (`m17-killshot.mjs`, `m17-probe.mjs`).
The acceptance probe uses CDP **screencast** (every composited frame — finer
than the requested 100 ms cadence) across started−450 ms … +1600 ms, asserting
the cyan-teal fraction outside a 0.42·min(w,h) disc (M15 geometry) and outside
UI rects stays ≤ 2 %; then waits for ring settle, screenshots, and runs a far
teleport (`teleportToTarget(-5600, -3800)`, the m14 baseline) asserting
arrival + destination position + zero console errors.

- **Assertion validity:** run against the unfixed main dev (5179):
  FAIL with cyanFrac up to **67 %** across dozens of frames (the glitch).
- **Fixed worktree dev (fresh vite on 5313): 3 fresh boots** — run1, run2,
  run3 all **PASS** (every transition frame 0.00–0.11 % cyan; ring settled;
  zero console errors). run4 (teleport-asserting variant) PASS with arrival
  interactive 305 ms at (−5600, −3800) and a fresh destination bloom
  (ring sweeping, r=56 post-arrival).
- **Production build on the 5240 preview:** PASS (transition clean, settled,
  teleport arrival interactive 238 ms, zero console errors). Note: an earlier
  "prod FAIL" was traced to another worktree's dev server (laughing-hamilton)
  having claimed port 5240 mid-session — the probe was testing unfixed code;
  the port was reclaimed with this worktree's `vite preview`.

## Build / typecheck
- `npx tsc --noEmit` — clean.
- `npx vite build` — clean (built in ~6 s). Ran vite build directly instead of
  `npm run build` per task note (the build script chains contract tests
  including the known-red foliage contract test on main); the terrain-tiles /
  bird-removal tests were therefore also not run here.
- `vite preview --port 5240 --strictPort --host` left serving the fresh dist
  (HTTP 200; title left as "San Francisco - main" per instructions).

## Open risks / leftovers
- The 15 s reveal cap can still fade the cover during a held-present stretch;
  fix (a) makes that benign (stale frame = correct pool), but a pathological
  pre-`holo()` present would be the only remaining hole (none exists today —
  the P1 warm frame is the first canvas present).
- Port 5240 is contested: another active worktree session (laughing-hamilton)
  had a dev server there and may try to reclaim it.
- `__sf`/`__sfVoid` are dev/`?profile`-only; prod probes must pass `&profile`.
