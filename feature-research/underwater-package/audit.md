# Underwater package — audit

## Files changed

- `src/fx/underwaterVolume.ts` (created)
- `src/fx/underwaterRig.ts` (created)
- `src/render/postfx.ts` (modified)
- `src/app/compose/frameBody.ts` (modified — imports + underwater lines after L1450)
- `src/fx/underwater.ts` (modified — tint opacity reduction only)

No other files were touched. `src/world/water.ts`, `src/world/tslUtil.ts`,
`src/world/heightmap.ts`, `src/world/ocean/**`, `src/main.ts`,
`src/app/compose/worldSystemsCore.ts`, `package.json` untouched.

## What changed per file

### src/render/postfx.ts
- Value import of `Vector2`/`Vector3` (was type-only THREE import).
- Eight new `U` uniforms (`uwSubmersion`, `uwSigma`, `uwSigmaScale`,
  `uwScatterAmbient`, `uwSunScatter`, `uwSunViewDir`, `uwSunScreen`,
  `uwRayAmount`) + exported `setUnderwaterPostFx()` driver.
- In `createPostFx`: derives the full-res beauty-pass depth node via
  `sceneTex.passNode.getTextureNode("depth")` — deliberately NOT the outline
  prepass depth (half-res, and referencing it in the zero-style variant would
  force the prepass to render every frame).
- In `build()` (so it lands in all 8 cached variants + the piano god-ray
  specializations): per-channel Beer-Lambert fog in linear light before
  `renderOutput` (dist = view distance from scene depth, clamped 240 m;
  transmittance `exp(−dist·σ·scale)`; in-scatter = CPU-depth-graded ambient +
  `pow(dot(view,sunViewDir),6)` sun lobe), then 16 fixed radial god-ray taps of
  the scene toward the refracted-sun screen anchor with a luminance gate.
  Branchless throughout (mix/smoothstep/mul only).

### src/fx/underwaterRig.ts (new, boot bundle, small)
- Smooths the 0..1 submersion state (same family of test as UnderwaterOverlay:
  over `map.isWater` and camera > 0.35 m under `waterHeight`).
- Computes the refracted sun (air→water Snell through a flat surface),
  projects its screen anchor, transforms it to view space, fades rays by
  facing (behind-camera), camera depth (~25 m falloff) and sun elevation.
- Depth-grades ambient/sun scatter per channel with `exp(−σ·0.7·camDepth)`,
  scaled by `LIGHT_SCALE`.
- Dynamic-imports `underwaterVolume` on first NEAR-water approach (camera
  < 8 m above the surface over water) and prewarms it hidden via
  `warmHiddenRoot` before it may ever flip visible.
- Dry path: one `isWater` lookup and an early return; uniforms latched to the
  exact identity once.
- DEV-only read-only `window.__uw` introspection (ease/loadStarted/
  volumeReady) — stripped from production builds by the `import.meta.env.DEV`
  guard; no forcing paths.

### src/fx/underwaterVolume.ts (new, lazy chunk — 2.89 kB emitted)
- Marine snow: ONE draw call. `THREE.Sprite` + `count = 3000` +
  `instancedArray` seeds (the bayLights instanced-sprite pattern, including
  the vertexStage rule for instance reads used by the fragment stage).
  Positions wrap around a camera uniform in the position node via
  fract-mod (±22 m box) — buffers are never rewritten. Slow sink + sway from
  `time`. Radial-falloff disc (no texture), edge/near distance fades hide the
  wrap. `alphaTest 0.05` + `depthWrite true` (see deviations), additive,
  renderOrder 18.
- Caustic carpet: 90×90 m camera-following quad at the local bay floor
  (`map.groundHeight` at camera XZ, CPU-side), `causticWeb` from
  waterShadingTSL over world XZ (pattern stays world-anchored while the quad
  glides), radial fade 18→44 m, intensity = submersion ×
  `exp(−0.09·floorDepth)` × sun elevation. Additive, `depthWrite true`,
  renderOrder 8 (under the water-underside lid at 9).
- `update()` is uniform writes + one visibility flip; no allocation, no
  lights, no pipeline changes.

### src/app/compose/frameBody.ts
- One import (`updateUnderwaterFx`) and one call right after
  `underwater.update(camera, …)` at the ~L1450 site, passing
  camera/map/renderer/scene/time/frameDt.

### src/fx/underwater.ts
- Flat DOM tint opacity reduced from `(0.24 + deepK*0.26)*e` to
  `(0.07 + deepK*0.09)*e` (GPU fog now owns the volumetric-tint role).
  Waterline band and vignette kept at full strength.

## How each feature is gated (dry cost)

- Post nodes are permanently in every cached variant and collapse to exact
  identity when dry: fog mixes by `uwSubmersion = 0`, rays add
  `× uwRayAmount = 0`, and the ray step is scaled by submersion so all 16
  taps read the SAME texel (cache-coherent). No pipeline selection or rebuild
  ever happens on submerge/resurface; no lights are involved.
- Dry residual cost: 1 extra depth sample + 16 same-texel scene samples +
  arithmetic in the fullscreen pass; CPU dry path is an isWater lookup.
- The volume module (snow + caustics) is a separate Vite chunk
  (`underwaterVolume-*.js`), imported on first near-water approach, compiled
  hidden through `warmHiddenRoot` (serialized compile gate), then toggled via
  `.visible` + uniforms only.

## Deviations from the plan, and why

1. **Snow/caustics write depth** (spec said `depthWrite false`). The post fog
   attenuates each pixel by the OPAQUE depth behind it; a depth-free additive
   sprite over open water inherits the far column's ~zero transmittance and is
   erased entirely (verified in probe screenshots). Alpha-tested depth-writing
   cores give the fog the sprite's true distance, so motes/caustics are fogged
   correctly instead of deleted. `alphaTest` uses discard but the materials
   sample no textures, so the WGSL uniformity hazard does not apply.
2. **Scene depth via `passNode`** instead of a new `createPostFx` dep —
   pipeline.ts was not on my allowed-files list.
3. **No temp submersion-forcing debug hook was needed**: the probe drives the
   real code path (freecam under real bay water). The only hook added is the
   read-only DEV `window.__uw` state, which contains no forcing paths.
4. **No true pre-change screenshot baseline**: a parallel agent shares this
   worktree, so `git stash` was unsafe. Instead: (a) dry identity is
   structural (mix-by-0 / add-0), and (b) the probe captures dry A → dive →
   dry C in one session; A↔C at a downtown vantage were visually identical
   (mean pixel diff 11.8 vs 3.06 noise floor, residual is facade-texture
   streaming + wave animation; a separate run measured 2.55 vs 0.025).

## Test results

- `npx tsc --noEmit` — clean.
- `npx vite build` — clean; `underwaterVolume` emitted as its own 2.89 kB
  chunk (code splitting confirmed).
- Headless probe (fresh random Vite port each run, `--headless=new`,
  `?autostart=1&fullfps=1`, scratchpad script `underwater-probe.mjs`):
  - Zero new console errors across the dive in every run (pre-existing
    warnings only: "Vertex attribute normal not found", starlink/KTX2 notes,
    one unrelated spawn-fallback warning).
  - Real-path submersion: DOM overlay visible, rig ease → 1, lazy module
    loaded + prewarmed (`volumeReady` true), resurface ease → 0 with uniforms
    latched to identity.
  - Screenshots (scratchpad `uw-shots/`): Beer-Lambert fog with depth
    grading and sun-forward glow; marine snow motes drifting and correctly
    fogged; caustic dapple on a shallow (−4.5 m) seabed; crisp dry frames
    before and after with no residue.

## Open risks

- `sceneTex.passNode` is an r185 internal shape (guarded with optional
  chaining; the whole underwater block is skipped if it disappears, dry
  visuals unaffected).
- Depth-writing snow cores could occlude later-order transparents
  (renderOrder > 18) behind individual motes while submerged; not observed in
  testing and impossible when dry (meshes hidden).
- The caustic carpet's depth writes create a soft "floor" for post-fog over
  spans with no streamed seabed geometry — intended, but its 45 m edge could
  read as a faint deep-blue transition in extremely clear tuning.
- God rays are deliberately subtle (luminance-gated); if an art pass wants
  drama, raise `uwRayAmount` scale (rig) or lower the `smoothstep(0.3, 1.1)`
  gate (postfx).
