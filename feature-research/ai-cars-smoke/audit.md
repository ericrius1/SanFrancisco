# AI Cars — post-fix browser smoke test audit

## Files changed

- `feature-research/ai-cars-smoke/audit.md` — this audit (new).

No source, server, config, or data files were created or modified. All test
scripts live in the session scratchpad
(`/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/99aecd62-6add-4602-b253-32a9e7861c7f/scratchpad/`):
`cdp.mjs` (raw-CDP helper), `run_smoke.mjs` (main 2-client run),
`test-import-midflight.mjs` (node repro), `probe_episodes.mjs`,
`probe_ghosts.mjs`, `rerun_a2_a4.mjs`, `rerun_a4.mjs`, `shot_cars2.mjs`.

## Setup

- `npx tsc --noEmit` → exit 0 before any browser work.
- Relay: started via the vite plugin (`SF_RELAY_PORT=8788 npx vite --port 5204`
  — running `node server/server.mjs` separately AND vite double-starts the
  relay and the in-vite copy EADDRINUSE-crashes the ws lib despite the
  http-server error handler, so the plugin-owned relay is the correct recipe).
- Headless Chrome 150 `--headless=new --use-angle=metal --enable-unsafe-webgpu`
  + raw CDP from Node 22 (no deps), URL `?fullfps&autostart`, teleport to the
  Mission grid (1500, -300). `localStorage sf_aicars_pool_v1` cleared first.
  The relay had a persisted pool (`server/data/aicars-pool.json`, gen 4,
  6 rows × 146) — kept, since welcome-pool adoption is part of what's tested.

## Results per assertion

1. **No console exceptions — PASS.** 0 console errors / 0 uncaught exceptions
   on every client across the ~3.5 min main run, the 2 reruns, and all probes
   (Runtime.consoleAPICalled + Runtime.exceptionThrown captured continuously).
2. **Gen advances ≥ 2, no post-evolve stats collapse — PASS** (shortened rerun
   with a visible leader tab): gen 4 → 5 at t=24.2 s, 5 → 6 at t=55.5 s.
   Samples at/after the flips: best 162.399/mean 68.706 (gen 5),
   best 160.814/mean 54.264 (gen 6) — never ~0/-0. N1 fitRing fix verified
   in-browser at a 1 Hz sampling cadence across two evolve boundaries.
3. **≥ 20 cars alive and moving — PASS.** minAlive = 24/24 across all 207
   1 Hz samples of the main run; 4701/4944 matched mesh positions moved
   > 0.05 m between consecutive samples.
4. **Second client ghosts + gen within 1 — PASS** (rerun with visible leader):
   client2 ghostCars = 24, ghost meshes moved 23/24 over 3 s, client2 gen = 6
   = leader gen exactly, surfaced within ~10 s of joining (leader was at
   gen ≥ 1 long before client2 joined) — N2 welcome-pool callback verified.
5. **Leader kill → promotion without gen reset — PASS** (main run): leader
   closed at gen 4; client2 flipped leader=false→true, spawned its own 24-car
   fleet, and reported gen 4 (== received gen, no reset to 0) on every
   post-promotion sample.
6. **Screenshot — saved** to scratchpad `street_cars_lattices.png` (daylight
   Mission street, AI pickup ahead of the player with its brain lattice above,
   second car up the street). Close-up lattice shots from the integration pass
   (`integration_carcam.png`) are in the same directory.

Also validated the cpool trust path implicitly: the relay's saved gen-4 pool
was adopted by every fresh leader (stats jump 0→4 at boot), and the relay
accepted the leader's re-broadcast (pool file re-written mid-run, gen intact).

## The false alarm (documented for future harnesses)

The first full run appeared to FAIL assertion 2: gen pinned at 4 and
bestFit/meanFit = 0.000 for ~170 s. This is NOT a regression:

- Node repro of the exact scenario (fresh trainer gen 0 → cars in flight →
  `importPool(gen 4)` from the relay blob) recovers within ~15 sim-seconds and
  reaches gen 10 with bestFit 354 by t=240 s. Logic is sound.
- Root cause: **both headless tabs report `document.visibilityState ===
  "hidden"`, and Chrome throttles the dev keep-alive `setInterval` in hidden
  tabs to ~1 Hz** → sim advances at ~5% real time (tick(0.05)/second). The
  main run opened client2 at t≈0, which backgrounded the leader tab for the
  whole run. First valid fitness surfaced at t=172.2 s (29.796) — training was
  working, 20× slower. With the leader tab activated
  (`GET /json/activate/<targetId>`), gen advanced +2 in 56 s.
- Same throttling explains the ghost "flapping" seen from client2: the hidden
  leader broadcast `cars` at ~0.4 Hz instead of 8 Hz, beyond GHOST_TIMEOUT_MS
  (1500 ms), so ghosts cycled active/inactive. With a visible leader the
  snapshots flow at 8 Hz and ghosts are rock steady.
- Harness rule going forward: **the training-leader tab must be the active tab
  (json/activate) — or drive `__sf.tick()` synchronously — whenever wall-clock
  pacing matters.** Production leaders are real players with foreground tabs,
  so this is a headless-harness artifact, not a product bug.

## Open risks / notes

- A leader who backgrounds their tab for a long time will slow fleet training
  and make remote ghosts flap for everyone else (snapshot gap > 1.5 s). This
  predates the reviewed fixes (broadcast pacing is original Agent D code) and
  is a product-behavior question, not a regression — flagged, not fixed.
- Cleanup done: relay :8788, vite :5204, and Chrome :9333 all killed;
  no repo files touched beyond this audit.
