# Foliage Epic Pass — Continuation Notes

## Landed in this pass

- Dense, layered grass now streams progressively inside a bounded frame budget.
- Grass and flowers reach farther and use staggered, world-stable population fades instead of one visible cutoff.
- Native trees have stronger distant silhouettes, staggered LOD transitions, and more detailed nearby broadleaf crowns without increasing the close crown vertex count.
- CityGen prioritizes footprint distance and maintains an 80 m detailed-building core while the player moves.
- Tea Garden/Hiro destination visuals start before deferred global owners, retain the baked fallback until ready, and avoid waking the broader Wildlands/golf bundle at the Tea site.
- Far shadows use a world-locked 16 m dual-envelope atlas: a weak padded envelope preserves small casters and a tight strong envelope restores definition. It remains one RG16F sample and 3,277,568 GPU bytes. The moving far-raster square is retired outside the local handoff.

## Verified evidence

- Tea House/Hiro appeared in about 2.98 s in the production lazy-loading probe, versus the original 15–32 s delay.
- Progressive grass immediate generation fell below 1 ms in the synthetic streaming benchmark; the old synchronous path took about 452 ms.
- The fixed-scene dual-envelope shadow capture held exact A/B/A scene and atlas revisions. Far focus movement changed 0.186% of pixels with 0.031 mean error; local changed 1.295% with 0.327 mean error.
- Shadow field/composition tests, Tea Garden source contract, native-tree tests, flower/grass contracts, TypeScript, and production builds passed during the pass.

## Do next after a context refresh

1. Build the merged `main` revision and rerun `tools/tea-garden-lazy-probe.mjs`. Confirm zero Tea requests at clean boot and zero Wildlands/golf/Afterlight chunks during Tea activation.
2. Run `tools/grass-orbit.mjs` against that production build. It now uses the covered world-arrival path; inspect the final meadow screenshot for dense ground coverage and stable world-locked rings.
3. Run matched, sequential baseline/current captures with `tools/perf-shot-probe.mjs` at `meadow` and `victorian`. Record p50 and p90, CityGen's 80 m core population, and any delta above the preferred 3% target.
4. Rerun `tools/shadow-domain-continuity-probe.mjs` from the production static preview. Its harness now distinguishes the expected missing-preview `/ws` endpoint from real HTTP/runtime failures and allows an eight-second camera quiet window.
5. Do one subjective visual review at the user's original Golden Gate Park viewpoints. The automated gates prove continuity and population behavior, but final foliage style/texture approval should still be visual.

## Optional experiments, not required for this merge

- Build the tight shadow-core envelope internally at the native 8 m terrain resolution, then max-downsample it into the existing 16 m G channel. This may sharpen medium shadows with no runtime memory/sample increase, at the cost of worker build time.
- Tune dual-envelope outer/core strengths only with paired screenshots; increasing the weak envelope alone makes 16 m cells look darker rather than more detailed.
- If the Tea House receives an art overhaul later, an optimized merged GLB with Meshopt and a KTX2 atlas could raise authored quality. It is not a loading-speed fix: the measured delay came from loader scheduling and compile order, not procedural house generation.
