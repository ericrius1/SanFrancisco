# Worker-owned ambient simulation (design)

Wave-2+ design doc — not yet implemented. Goal: move ambient, latency-tolerant
per-frame CPU off the main thread so render encode owns the frame on slower
machines (M1/M2). The main thread's measured hot spot is pipeline encode;
everything else is small — but small things add up and grow with every feature.

## What qualifies (latency-tolerant, no scene-graph access)

| System | Today (main) | Worker plan |
|---|---|---|
| Traffic light phases | trafficSignals timing | pure timer math → phase array |
| Enterable traffic cars | steering/lane AI | poses in SAB ring, 20 Hz sim |
| Remote-player interpolation | per-remote lerp buffers | interpolate in worker, main reads poses |
| Ambient wanderers (birds, dogs, koi visits) | per-entity update | 10-20 Hz sim → pose ring |
| Minimap composition | 2D canvas draw | OffscreenCanvas worker |

Explicitly NOT worker material: player physics (box3d main-thread contract),
anything reading the THREE scene graph, audio (needs the one AudioContext),
camera, input.

## Architecture

- One `ambientSim.worker.ts` owning a fixed-tick loop (20 Hz, `setInterval`
  drift-corrected). Main thread posts world snapshots it already has (player
  pos, time-of-day, region awake flags) at low rate.
- Poses cross via SharedArrayBuffer rings: `Float32Array` blocks of
  `[id, x, y, z, qx, qy, qz, qw, aux…]`, double-buffered with a generation
  counter so main never reads a torn frame. Main-thread systems become thin
  "apply pose to mesh" loops (the cheap part they already do).
- Feature modules register a sim-side `tick(dt, inputs)` and a main-side
  `apply(poses)` — the SystemRegistry from docs/MAIN_DECOMPOSITION.md is the
  natural registration point; a system's `update` splits into the two halves.
- COOP/COEP headers required for SAB: dev server + server/server.mjs must send
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` (audit third-party fetches first — basis transcoder, fonts,
  relay websocket are same-origin already; weather API is server-proxied).
  Fallback: postMessage transferable Float32Array ping-pong when SAB is
  unavailable (identical API, one frame more latency).

## Payload audit (wave 4, 2026-07-17)

Measured per-frame sim costs on merged main: every worker-eligible system is
under 0.3 ms (minimap canvas 0.2-0.3 ms was the largest; traffic/AI/net all
≤0.1 ms). The frame is render-encode-bound, which cannot move off-thread.
Verdict: the worker carries no measurement-justified payload TODAY — shipping
the plumbing now would be dead weight. Landed instead: the minimap repaint
gate (30 Hz cap + idle-signature skip + force flag for event repaints), which
captures most of the OffscreenCanvas win in 20 lines. The worker design below
stays the blueprint for when a payload crosses ~1 ms — the first real
candidate is remote-player interpolation at 20+ player rooms.

## Migration order (each step independently shippable)

1. Plumbing: worker + SAB ring + registry hook, with ONE system (traffic light
   phase timing) as proof. Zero visual change; verify with the traffic probe.
2. Remote-player interpolation (biggest steady win in multiplayer sessions).
3. Traffic car AI, then ambient wanderers.
4. Minimap to OffscreenCanvas (independent of the SAB work).

## Risks / invariants

- box3d stays main-thread; worker sims that need collision use the baked query
  grids (heightmap/groundTop are transferable read-only copies).
- Determinism: sim tick uses its own clock; pauses (P) post a freeze flag.
- HMR: worker module reload must rebuild rings (dev-only concern).
- Probe support: __sf gains `ambientSim.stats()` (tick rate, ring lag) so the
  perf harness can assert the worker is actually absorbing the load.
