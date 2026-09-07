# Streaming and distance changes — September 2026

## What changed

- The merged building tier now preserves the main roof volumes, bays, cornices,
  commercial setbacks, foundations, and facade colours out to the existing
  roughly 2.8 km landscape radius. Windows remain analytic; each cell still
  uses one mesh and material. Geometry builds in 32-building slices.
- Detailed buildings remain eligible at 700 m during flight. The old speed
  heuristic reduced eligibility to 160 m. Existing admission, queue, count,
  and facade-cost limits still bound work; nearby protected buildings retain
  their existing priority exceptions.
- CityGen preparation no longer waits indefinitely for the player to stop.
  It still respects arrival/reveal ownership and the renderer's bounded,
  serialized compilation gate.
- The grammar worker imports a pure generator instead of the renderer entry
  point: about 26 KB bundled, down from 497 KB, with zero Three.js inputs.
- Window instances use a dense live prefix. Leaving a detailed district now
  reduces vertex submission rather than retaining the previous peak count.
- Corrected generated face winding to match outward normals, including roof
  caps. This fixes misleading lighting changes at transitions without moving
  geometry, windows, or colliders.
- Wildlands trees extend from 520 m to 1,050 m and begin loading at 1,300 m.
  A separate canopy owner lets these trees load before grass, flowers, or
  golf gameplay. Groundcover borrows that same forest on close approach.
- Beyond about 420 m camera distance, trees use worker-generated captures of
  the actual shared tree mesh: 16 yaw × 7 elevation views, a conservative
  10-triangle hull, and one packed colour/normal/coverage atlas. Captures support
  overhead flight and dynamic lighting; no new external texture requests.
- Close tree selection includes height relative to each tree's actual bounds.
  Flying high no longer selects expensive close foliage based only on XZ.
  Ground-level proximity and entry/exit hysteresis remain intact.

## Measurements and limits

Headless Chrome, native Metal WebGPU, 1440 × 900. These are local diagnostic
measurements, not a claim about every device or overall game FPS.

- Across 603 real buildings, the landscape tier uses about 92,220 triangles
  versus 2,191,752 for expanded detail: 95.8% fewer. It is more expensive than
  the old bare boxes (about 13,098 triangles); that is an intentional visual
  improvement without additional per-cell draw calls or detailed window meshes.
- Releasing 99 of 100 detailed buildings reduces submitted window triangles
  from 410,000 to 4,100. Another 600 allocation/release cycles do not grow that
  submission count; releasing everything submits zero.
- Matched forest fixture, equal 1,050 m range, four alternating samples per
  view. Median forest GPU time and submitted geometry:

| View | Previous mesh tier | New capture tier | Triangle reduction |
| --- | ---: | ---: | ---: |
| Flight | 2.881 ms | 3.036 ms | 95.3% |
| Street | 3.376 ms | 2.383 ms | 81.7% |
| Overhead | 3.713 ms | 3.610 ms | 99.0% |

The capture tier trades vertex work for alpha-tested pixel work. Its GPU
benefit varies by view: street improves here; flight is slightly slower at
equal range. The old 520 m flight case was 1.811 ms with much less coverage.
Do not describe doubling draw distance as free. Earlier multi-sample capture
shaders were rejected after measurements showed worse GPU cost.

The full-world test independently confirms the loading behavior: downtown
boot requests no native forest or near foliage assets; distant park approach
loads the canopy without groundcover, near textures, or golf gameplay; flight
at 250 m selects zero close trees; descent selects nearby trees and requests
only their three species' texture sets. Boosted city flight retains 700 m
detail eligibility and builds real detail while moving. No browser/GPU errors.
Its stationary park capture submits 7,774 far-tree triangles and zero close
trees; the complete rendered world measured about 18–21 ms GPU in that view.
This is not a matched whole-world before/after FPS comparison.

## Verification

Focused executable checks live under `tools/`:

- `citygen-streaming-test.mjs`: pure worker graph, continuous movement,
  arrival and cancellation contracts.
- `citygen-landscape-test.mjs`, `citygen-winding-test.mjs`, and
  `citygen-roof-visual-probe.mjs`: 1,214 building envelopes, outward winding
  across 2.19 million triangles, roof shape consistency.
- `citygen-module-residency-probe.mjs`: real browser attributes, relocation,
  buffer growth, idempotent release, and allocation churn.
- `citygen-landscape-browser-probe.mjs`: actual WebGPU day/night, street,
  elevated, and rear-roof comparisons using production materials/geometry.
- `native-tree-impostor-test.mjs`: actual six-species captures, all 112 views,
  deterministic output, coverage, hull containment, padding, bounded memory.
- `native-tree-near-altitude-test.mjs`: crown/ground proximity, high flight,
  vertical-only motion, camera tether, and asynchronous focus copies.
- `wildlands-canopy-lifecycle-test.mjs`: import graph and ownership/disposal.
- `native-tree-distance-probe.mjs`: matched WebGPU representation comparison,
  indirect submission readback, shared interleaved-buffer regression checks.
- `streaming-flight-probe.mjs`: full-world request waterfall and flight.

Browser probes default to the worktree preview on port 5280 and run headlessly.
Diagnostic JSON and screenshots stay under `.data/streaming-upgrade/`.
The production build also runs the project's existing rendering, asset,
grounding, facade, shadow, and TypeScript checks.

## Before expanding beyond San Francisco

Keep Three.js's WebGPU renderer for now. This implementation already uses
custom GPU compute culling, storage buffers, indirect instance counts, and
TSL materials. These measurements do not justify replacing the renderer.

The next scale boundary is data residency: forest GPU arenas are still sized
from the authored population, and city/vegetation metadata still describes
the whole local region. Larger coverage needs spatially tiled metadata and
placements, stable global feature IDs, bounded resident GPU pages, cancellation
of obsolete tile requests, and an origin/coordinate strategy. Generate/cache
tree captures and building envelopes as tile pipeline assets where practical.

Measure tile IO, CPU assembly, GPU uploads, pipeline preparation, memory, and
actual submitted frames separately. Consider direct WebGPU work only where a
measured Three.js limitation remains after that restructuring. A wholesale
renderer rewrite would not solve global data residency or request scheduling.
