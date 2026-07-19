# Audit — M1 (materialize core) + M2 (terrain holo + void realm)

Contract: docs/VOID_STREAM_REWRITE.md, milestones M1 + M2 only. No boot
restructuring (M3), no ring coordinator (M4), no per-system materialize (M5).

## Files changed

- src/render/materialize.ts (NEW)
- src/world/voidRealm.ts (NEW)
- src/world/terrainClipmap.ts (modified)
- src/world/sky.ts (modified)
- src/world/water.ts (modified)
- src/main.ts (modified)

## What changed per file

### src/render/materialize.ts (new, M1)
- `MaterializeField` class + module-level `materializeField` singleton owning
  shared front uniforms: `frontCenter` (vec2), `frontRadius` (starts at 1e9 =
  fully revealed), `frontBand` (48 m default), `holoColor` (0x36e0cf cyan-teal,
  one uniform), `holoIntensity` (LIGHT_SCALE-anchored emissive gain),
  `worldTime` (field clock). All consumers reference the same uniform node
  objects; one CPU write updates every material.
- Birth registry: `birthOf(key)` (lazy shared uniform, unborn = +1e9 so the
  ramp evaluates 0), `markBorn(key)` (stamps `worldTime`), `forgetBirth(key)`.
- API: `setFront(x,z,radius,band?)`, `sweep(toRadius,speed=450 m/s)`,
  `holo(x?,z?)`, `reveal()`, `sweeping`, `update(dt)` (clock + sweep animation,
  dt clamped to 0.1 s).
- `materializeAmount({worldPos?,birth?})` → 0..1: `saturate((radius-dist)/band)`,
  min'd with the ~1 s birth ramp when a birth uniform is supplied.
- `holoShade(worldPos, baseColor?)` → emissive-ready vec3: fwidth-antialiased
  world-space grid (8 m lattice + 1 m sub-grid, moiré-faded via ascending
  smoothstep + oneMinus), 4 m elevation contour lines on worldPos.y (conform to
  real heights), animated radial scanline band windowed to the dissolve edge.
  Pure ALU, zero texture taps.
- `applyMaterialize(material, opts)` — wraps colorNode (holo-dark multiply),
  emissiveNode (holo + mid-band flash, plain mixes back to original at
  amount=1), and optionally opacityNode with a stable screen-door dissolve
  (hash of quantized WORLD position — never per-frame random) + alphaTestNode
  0.5 for opaque materials. Explicit opacityNode always set (the
  NodeMaterialObserver bundle footgun, citygen/render.ts pattern). Single
  graph, no If() anywhere, no material swap — pipeline exists from
  construction.

### src/world/voidRealm.ts (new, M2)
- `VoidRealm(sky, water)` derives a void factor from the front
  (`1 - radius/900 m`, clamped) or an explicit `setVoidFactor(v|null)`
  override; `update()` pushes it into `sky.setVoidFactor` +
  `water.setReveal(1-v)`, idempotent (skips when unchanged).

### src/world/terrainClipmap.ts (M2 — SHADING ONLY)
- In `#createMaterial` (terrainClipmap.ts:719-733 area): after the existing
  `terrainColor` composition, `materializeAmount` + `holoShade` mix in — below
  the front the lit response multiplies to a dark base (0.045) and
  `emissiveNode` carries the glowing contour grid; above, both terms collapse
  to the original shading via uniform mixes. **#heightAt, geometry, positionNode,
  normals, cutouts, opacity are untouched** — CPU/GPU lockstep preserved.
  New import of `holoShade`/`materializeAmount` only.

### src/world/sky.ts (M2)
- New `#uVoid = uniform(0)` (sky.ts:~272).
- `#skyRadiance`: `voidDim = mix(1, 0.018, uVoid)` multiplies all three return
  paths (soften/IBL, fogBackdrop dome, plain); the fog-backdrop horizon mix is
  additionally gated by `voidKeep = uVoid.oneMinus()`.
- `#buildFogNode`: final fog factor multiplied by `uVoid.oneMinus()` (fog off
  in the void).
- Public `setVoidFactor(v)` (clamped). No light membership or intensity
  changes anywhere — sun/hemi untouched (C1).

### src/world/water.ts (M2)
- New `#uReveal = uniform(1)`; multiplied into the opacityNode of the far/near
  bay sheets, the palace lagoon, and the underside lid. Public `setReveal(v)`.
  Same pipelines (all four materials were already transparent).

### src/main.ts (minimal wiring)
- Imports: `VoidRealm`, `materializeField` (main.ts:23-24).
- `const voidRealm = new VoidRealm(sky, water)` right after Water construction
  (main.ts:~228) — before any pipeline warm, no boot reordering.
- `?voidholo=1` handling after spawn resolution (after `bootMark("physics")`,
  main.ts:~310): `materializeField.setFront(spawn.x, spawn.z, 0)` +
  `voidRealm.update()`.
- Main loop: `materializeField.update(frameDt); voidRealm.update();`
  immediately before the existing `sky.update(...)` call (main.ts:~4300).
- `__sf` debug surface: `materialize { field, setFront, sweep, holo, reveal }`
  + `voidRealm` added to the DebugRegistry refs (main.ts:~4650).

## Deviations from the plan

- Void sky is "minimum viable" per the plan's own escape hatch: a dome/IBL
  darken multiply (floor 0.018, not absolute black) + fog-off multiply, rather
  than a bespoke void dome look. Left for M5+ polish if desired.
- `holoShade` returns a single emissive-ready vec3 (dark fill + lines) instead
  of a {base, glow} pair; `applyMaterialize`/terrain route it to emissiveNode
  and darken colorNode separately. Functionally equivalent to the doc sketch.
- Water "far plane fades in with the front" is implemented as the global
  reveal uniform driven by the void factor (VoidRealm), not per-distance front
  tracking — per-system front coupling is M5 scope.

## Test results

- `npx tsc --noEmit`: clean.
- `npm run build` (contract tests + tsc + vite build + precompress): clean.
- Headless visual QA (fresh vite on a free port, headless Chrome WebGPU/metal,
  CDP screenshots, paced — no shot bursts), spawn=coronaHeights. Screenshots in
  /private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco--claude-worktrees-streaming-world-concentric-chunks-b8eefb/016a9db0-273c-468a-8995-6e1b9fac50be/scratchpad/:
  - `a-holo.png` — `?voidholo=1&autostart=1` boot: whole world as glowing
    cyan contour grid conforming to real topography, dark void sky, water
    hidden, avatar fully lit. front radius verified 0.
  - `b-sweep.png` — mid `__sf.materialize.sweep(2400, 300)` (radius ≈ 780 m):
    revealed interior, holo shimmer + sky returning beyond the front.
  - `b2-edge-close.png` — front pinned at 260 m: dissolve edge in frame;
    revealed summit inside, holo city outside.
  - `c-revealed.png` — after `reveal()`: normal world.
  - `d-normal-boot.png` — control boot WITHOUT `?voidholo`: visually matches
    (c); normal boot unchanged (front defaults to 1e9 → amount 1 everywhere;
    added cost is a handful of ALU mixes, no texture taps).
  - Zero page errors/exceptions across both probe runs.
- All probe servers/browsers killed (verified no surviving processes for this
  worktree).

## Open risks / leftovers for M3+

- Buildings/tiles/citygen/lamps/landmarks do NOT holo yet (M5): in holo phase
  they render with normal albedo lit by the (unchanged) hemi against the holo
  ground — visible as colorful blocks on the grid (see b2 screenshot). Expected
  at this milestone.
- The scanline band around a collapsed front (radius 0) pulses brightly within
  ~1.5 bands of the player; stylish but tunable via `holoIntensity` /
  `frontBand` if too hot for the final boot look.
- `applyMaterialize`'s dissolve path is exercised by typecheck/build but has no
  in-game consumer yet (first consumers arrive in M5); the terrain path
  (dissolve-free) is the one visually verified.
- VoidRealm derives void purely from front radius (900 m fade); M3/M4 may want
  the explicit `setVoidFactor` override during boot/teleport choreography.
- `materializeField.update` runs only in the real game loop (adjacent to
  sky.update), not in the boot-time settle/warmup mini-loops — fine for M2
  (front is static during boot), revisit in M3 when the provisional void loop
  exists.
