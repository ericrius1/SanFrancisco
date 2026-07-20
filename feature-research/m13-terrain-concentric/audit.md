# M13 terrain concentric grid + steady-state holo default-off — audit

Two user-driven changes on top of M12:

1. **Terrain grid is concentric like everything else.** M12 deliberately
   exempted the terrain clipmap's holo contour grid — it glowed to the horizon
   from frame one. The user pushed back ("just focus on immediate area, then
   sweep out"): the grid now rides the same front-edge window as the buildings.
   At the void/control moment only a small lit patch of contour grid surrounds
   the front centre, fading to dark ground + dark sky beyond; the lit band
   grows outward with the sweep. A very faint albedo floor keeps far terrain
   reading as dark ground rather than a pure black abyss.
2. **Steady-state holo birth OFF by default.** Post-settle (normal play),
   chunks streaming in no longer play the cyan holo-materialize birth look —
   they appear via each system's plain crossfade (citygen fadeClone alphaHash
   opacity, shellBatch fade texel dither) or a plain attach (baked tiles,
   authored regions) — the pre-M5 steady-state behavior. The full holo
   language still owns the boot sweep and far-teleport arrival sweeps. A
   debug toggle ("/" pane → rendering → "holo chunk streaming") re-enables
   the holo birth look post-settle for chunk-loading visibility debugging.

## Files changed

- `src/render/materialize.ts`
  - `edgeGlowWindow` exported (terrain reuses the M12 building window).
  - `GRID_TO_HORIZON_DEBUG` (`?gridhorizon=1`): restores the pre-M13
    to-horizon terrain grid for A/B debugging (void phase only — settled
    shading identical either way).
  - `MaterializeField.birthHoloGate` uniform (+ `setBirthHoloEnabled`,
    `birthHoloEnabled`, update() lerp): the steady-state gate. 1 = full holo
    birth language; 0 = `applyMaterialize` forces its amount to 1 so the wrap
    collapses to the original graph. Disable direction eases over ~0.4 s
    (chunks mid-birth at the settle moment finish smoothly); enable snaps
    (teleport cut must be atomic with its front collapse).
  - `applyMaterialize`: `amount = max(amountExpr, 1 − birthHoloGate)` — one
    shared uniform, ~2 ALU, same single pipeline; covers every consumer
    (tiles per-residency births, batch birth texels, citygen fadeClones,
    shellBatch texel fades, lod, authored regions) with zero per-system edits.
- `src/world/terrainClipmap.ts` (#createMaterial, shading only — the
  `#heightAt` displacement path is untouched, CPU/GPU lockstep holds):
  - `holoShade(..., { edgeWindow: !GRID_TO_HORIZON_DEBUG })` — grid/fill
    emissive attenuates to ~0 over 3 bands (~144 m) beyond the dissolve edge.
  - Dark-floor albedo now windowed: `holoFloor = mix(0.02, 0.05, window)` —
    ~5% lit albedo near/inside the front easing to a minimal 2% far beyond
    (dark ground, not abyss; err-toward-darker per the user's preference).
  - Window ≡ 1 once the front parks at the revealed sentinel and the reveal
    mix is unchanged, so settled shading collapses to exactly the pre-M13
    output.
- `src/config.ts` — `RENDER_TUNING.holoChunkStreaming` (default false,
  label "holo chunk streaming"): the debug toggle, persisted like every
  other tweak ("." factory reset clears it).
- `src/ui/debug.ts` — binds the toggle in the "/" pane rendering folder
  (no onChange — the value is polled).
- `src/main.ts`
  - ringUpdate wrapper: `materializeField.setBirthHoloEnabled(state !==
    "settled" || RENDER_TUNING.values.holoChunkStreaming)` per frame — the
    toggle works even if the pane never opens, and far-teleport refocus
    (state → "sweeping") re-enables holo automatically.
  - `__sfVoid.birthHolo()` + `__sfVoid.setHoloChunkStreaming()` probe
    surface.
- `index.html` — worktree title marker re-added
  (`🌲 [wt: streaming-world] San Francisco`; stripped before merge).
- `feature-research/m13-terrain-concentric/audit.md` — this audit.

NOT touched (per concurrency instructions): `src/app/renderCore.ts`,
`src/world/citygen/render/shellBatch.ts` and all shellBatch buffer-lifetime
code, the concurrent session's `attributeDisposePatch`.

## Why the gate lives in applyMaterialize

Every holo-birth consumer routes through `applyMaterialize` /
`applyHoloBirth` / `configureBatchHoloBirth` (all in materialize.ts), so one
`max()` against the shared gate uniform covers the whole world without
touching any consumer file — critical because shellBatch.ts is owned by a
concurrent session. Forcing amount → 1 collapses colour/emissive/dissolve to
the original graph while each system's independent plain fade channel keeps
running: citygen fadeClones still animate `material.opacity` under alphaHash
(the C7 crossfade), shellBatch materials still drive `opacityNode = fade ×
cutaway` from the fade texel, tiles/regions simply attach (their pre-M5
behavior). No new pipelines; the graph existed since M5, the gate only
collapses the holo term.

## Test results

Vite preview build, headless Chrome WebGPU/Metal, fresh boots,
`?fullfps=1&profile=1`, no device-metrics override. Probe:
`m13-probe.mjs` (+ `pngstat.mjs` PNG luma/cyan metrics, `m11-probe.mjs`
smoothness) in the session scratchpad; screenshots `m13-*.png` beside them.

- `npx tsc --noEmit` clean; full clean `npm run build` (rm -rf dist first)
  passes; dist carries exactly one entry (`index-D01DwCCu.js`, referenced by
  dist/index.html) + one `main-*.js`; port-5240 preview restarted from this
  worktree and curl-verified serving the new title + fresh entry hash.
- **Vista scenario** (drone 380 m over downtown, `?j=3900,380,200,0.6,drone`),
  clean-host warm run — ALL PASS: control mark **1100 ms** (M12 record
  1327/1338), frontComplete **17.9 s** (M12 18.2–19.7; ≤ 35 s bound), settled
  fps **120.1** (M12 119.6 — no perf regression), front monotonic, settled by
  residency, post-settle audit gate empty / zero in-range hidden tiles / zero
  hidden landmarks, `__sf.materialize` hooks + voidFrame/frontComplete marks
  present (served build is current), zero console errors. birthHolo enabled
  during the whole sweep, `enabled:false gate:0` after settle.
- Screenshot metrics (mean luma 0-255 / holo-cyan pixel %, top-half = the
  distance region in the drone framing):
  - **Void moment**: OLD `m12-v0-void.png` top-half luma 113.3, cyan 18.3 %,
    lit 82.9 % (contour grid to the horizon) → NEW `m13-v0-void.png` top-half
    luma 55.6, **cyan 0.016 %**, with the full-frame 4.5 % cyan being the
    small lit holo patch hugging the collapsed front. Visual: cyan wireframe
    only in the immediate band around the player; black massing + faint dark
    ground beyond; no hard ring.
  - **Mid-sweep** (`m13-v1`/`v1b`, 0.5 s apart): shaded city to the edge,
    cyan dissolve band, dark ground + massing silhouettes beyond (the
    documented M12 noon-rim transient); the pair shows continuous band
    progression, no pop.
  - **Settled**: `m13-v2` vs `m12-v2` luma 113.5/148.8 vs 117.0/152.2 and
    cyan 4.21 vs 4.17 % (bay water; sun moved ~1.5 h of real wall-clock
    between shots) — settled look unchanged.
- **Holo default-off, REAL streaming A/B** (holo scenario; post-settle tile
  load-radius shrink → restore so ~43 tiles genuinely unload + re-stream
  through finalize → markBorn / batch-texel births near the camera):
  - Toggle OFF (default): all four shots during re-streaming hold
    **4.22–4.29 %** cyan = the 4.22 % settled baseline (bay water) — chunks
    appear plain. `m13-h-off-*.png`.
  - Toggle ON (`setHoloChunkStreaming(true)` → gate snaps to 1): first
    re-stream shot **10.76 %** cyan (+6.5 pp) — towers/piers visibly ramp in
    the full holo language — decaying back to baseline as the ~1 s ramps
    finish. `m13-h-on-*.png`. Toggle OFF again → gate lerps to 0, plain.
  - Three +420 m near hops after that: state stays `settled`, gate stays 0,
    tiles stream plain, zero errors.
  - Note: re-stamping an already-resident tile's birth uniform (markBorn on
    live keys) is visually inert — the honest path is the streamer's own
    finalize (fresh per-residency materials); the A/B above exercises that
    real path.
- **Smoothness** (M11 idle-orient methodology, best-of-3 as ambient load
  allowed — user's Ableton + WindowServer at 50–60 % throughout): control
  **1504 ms** (in-band), frontComplete **20.0 s**, FULL window over33 = 19
  with **motion-visible 5**, SETTLE window **0 visible**, TAIL **0 visible**,
  zero errors. All five visible frames are the pre-existing M10/M11
  streaming-attach / collision-arrival / shadow-held classes
  (`buildingBodyQ`, `collisionArrivalComplete`, `tileAttach`,
  `shadowRedrawHeldStreaming`); **none carry `frontUnhide`** and none touch
  the materialize/holo path. M12's own record: 3 visible clean-host and **5
  on the same build with the gate off** — M13 sits inside that documented
  band, i.e. no new hitch class and no regression (M13's runtime delta is a
  few shader ALU + one uniform write per frame). Second run same day: 4
  visible. `compileWindowStillHidden` 16–27, `compileWindowMotionVisible`
  ≤ 1 — M11 compile-gate behavior intact.

Timing caveat: first-run cold Chrome profiles compile the full WebGPU
pipeline set (control ~5–6 s, gpuCompileMs ~49 s spread across the boot);
warm-profile fresh-boot runs are the acceptance record (M11/M12 measured the
same way). A concurrent session's build (tsc + precompress, host load ≈ 14)
polluted the first vista run (control 14.3 s / fc 68 s / fps 39) — the M12
audit documents the identical contended-host signature.
