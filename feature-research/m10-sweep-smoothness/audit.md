# M10 sweep smoothness — implementation audit

## Files changed

Created or modified by THIS task (the tree also carries the uncommitted
M1–M9 work plus a concurrent session's bufstorm fixes — only these deltas are
M10's):

- `src/render/paddedAttributePatch.ts` — NEW: r185 WebGPU padded-attribute
  create/update hotfix (persistent padded mirror + range-scoped pad/upload)
- `src/app/renderCore.ts` — installs the padded-attribute patch (one import +
  call; the file also gained `attributeDisposePatch` from a concurrent
  session's bufstorm task — NOT mine)
- `src/render/warmStaticRegion.ts` — `warmScenePaced` chunk budget 35→8 ms;
  NEW `warmUnseenMeshSignatures` helper
- `src/render/pipeline.ts` — exposes `compileHeld`; labels exclusive compile
  windows > 100 ms (`[compile] <owner> window <ms>`)
- `src/world/tiles.ts` — NEW `onTileFinalized` hook (fired with a tile's part
  meshes before any attaches); NEW `isRenderHeld` gate that pauses the live
  drain during exclusive compile windows
- `src/app/boot/bootTiles.ts` — wires `onTileFinalized` → signature-deduped
  gated warm for the FIRST TWO tile finalizes only
- `src/world/shadows/clipmapShadowNode.ts` — static-domain sun-move redraws
  latch dirt instead of re-rendering directly; global 700 ms min-interval
  between static-domain redraws + settle-release cushion; post-hold-release
  redraws fade the domain's shadow contribution in over 1.5 s
  (`shadow.intensity` reactive reference — no recompiles)
- `src/main.ts` — P4 pipeline warmup re-run deferred until the ring
  coordinator settles (bounded 120 s) + 12 s settle cushion; `tiles.isRenderHeld`
  wiring
- `feature-research/m10-sweep-smoothness/audit.md` — this audit

Probe artifacts (scratchpad, not in repo): `m10-probe.mjs`, `m10-diag.mjs`,
`m10-diag-ab.mjs`, `m10-trace.mjs`, `m10-jsprof.mjs`, `m10-*.log`,
`m10-trace.json`, `m10-*-frames.json`, `m10-settle-plus{0,1,2,5}.png`,
`m10-base-settled.png`.

## What the user's glitches actually were (ranked by measured share)

All measurements: `vite preview` build, headless Chrome (WebGPU/Metal),
`?autostart=1&fullfps=1&profile=1&spawn=downtown` (pinned worst-case dense
spawn), window = `control` bootMark → `frontComplete` + 10 s.

1. **~280 ms main-thread stall on EVERY streamed-tile batch attach**
   (~15×/sweep, the dominant "glitchy while materializing" class). V8 profile:
   `WebGPUAttributeUtils.updateAttribute` = **7.9 s self time in a 10 s
   mid-sweep window**. r185 pads vertex attributes whose stride is not a
   4-byte multiple (16-bit-quantized tile geometry: position Int16×3, normal
   Int8×3) and REBUILDS THE WHOLE padded arena array per update in a
   per-vertex `subarray()` loop — ~1 M-vertex shared BatchedMesh arenas →
   ~280 ms per `setGeometryAt`. (First hypothesis — the 2 MB alive-atlas
   `writeTexture` per attach — was A/B-refuted by dropping those uploads
   in-page: stalls persisted.)
2. **Early post-control burst (first ~3 s): 130–560 ms frames** — exclusive
   compile windows for monster TSL graphs, labeled: water sheets (~210–260 ms
   each), `tileBuildingBatch` ~290 ms, first facade `bld_*` ~480 ms,
   `tileParkBatch` ~185–215 ms, `floating_island_trees` ~230 ms; plus
   `createAttribute`'s padding loop at arena creation (491 ms V8 self-time in
   the first 5 s) and a first-live-frame lump (45 sync pipelines + 38 bundle
   records in one frame after a long held window).
3. **Settle-moment redraw burst + lighting pop** — a real-sun-drift
   (SUN_MOVED) static local-domain re-render slipped through the M7 streaming
   hold near settle: 167–170 synchronous `createRenderPipeline` calls + an
   extra render pass in ONE frame (GPU diag), and (at low sun) the post-hold
   redraw flipped whole streets into building shade in one frame
   (screenshot-verified pop).
4. **P4 warmup chunk carpet** — the post-construction paced warmup ran DURING
   the sweep at ~35–40 ms chunks: a wall of 40 ms frames for its entire
   duration.
5. Intermittent 0.3–0.9 s (up to 12–14 s on first-ever district visit after a
   rebuild) synchronous pipeline compiles in Chrome's GPU process — Metal
   shader-cache misses; every creation blocks the single WebGPU decoder thread
   (renderer main thread then stalls in `DawnClientSerializer::GetCmdSpace`).

## Fixes (file:line map)

1. **Padded-attribute patch** (`src/render/paddedAttributePatch.ts`, installed
   in `renderCore.ts`): keeps a persistent padded mirror per attribute; when
   updateRanges exist, pads + uploads only the touched vertex spans with tight
   indexed loops; creation path pre-pads the same way and seeds the mirror.
   Everything unusual (storage attrs already swapped to padded layout,
   interleaved data, int16→int32 converted attrs, range-less updates) falls
   through to stock. Effect: the ~280 ms/attach class vanished
   (`paddedAttrRanged` ~170/run at ~0–2 ms total).
2. **P4 warmup deferral** (`main.ts` ~4863): the safety re-warm now waits for
   ring-coordinator settle (bounded 120 s) + 12 s cushion + background quiet;
   `warmScenePaced` chunk budget 35→8 ms (`warmStaticRegion.ts:144`). The
   sweep window no longer carries the chunk carpet. Rationale: content
   streamed during the sweep warms through its own gated hooks; C2 is owned by
   the front never crossing unwarmed ground.
3. **Shadow redraw discipline** (`clipmapShadowNode.ts`):
   - static-domain SUN_MOVED no longer re-renders directly — it latches the
     domain's static dirt (schedule() ~360), so the streaming hold, quiet
     window, and pacing all apply; `lastSunDir` only updates on a real render
     so the latch re-fires correctly.
   - global `STATIC_REDRAW_MIN_INTERVAL_MS = 700` between static-domain
     redraws, and hold-release stamps the timer (settle cushion) — the two
     post-settle redraws land as isolated, spaced frames ~0.9 s and ~1.6 s
     after the reveal.
   - post-hold redraws fade the domain's contribution in over 1.5 s
     (`POST_HOLD_INTRO_FADE_MS`, quadratic ease via `shadow.intensity`, a
     reactive reference uniform — no recompiles, C1/C3 untouched). This
     removed the one-frame street-into-shade lighting pop at settle
     (before/after screenshots).
4. **First-tile signature warm** (`tiles.ts` `onTileFinalized` +
   `bootTiles.ts` + `warmStaticRegion.ts` `warmUnseenMeshSignatures`): the
   first two tile finalizes compile their first-seen material/geometry
   signatures through the gated compileAsync before any part attaches.
   Warming EVERY tile was measured as a 30–55 ms window carpet (per-instance
   program cache keys never saturate the signature set) and reverted to the
   2-finalize cap; Dawn-level pipelines dedupe for tiles 3..N.
5. **Held-frame drain gate** (`tiles.ts` `isRenderHeld` + `pipeline.ts`
   `compileHeld` + `main.ts` wiring): the live tile drain pauses while an
   exclusive compile window holds presented frames, so bundle-dirtying
   attaches can't pile up unseen and re-record en masse on the first live
   frame. (Measured effect small in the end — the big lump was the compile
   codegen itself — but it structurally caps that failure mode.)
6. **Attribution instrumentation** (kept): `[compile] <owner> window <ms>`
   info line for exclusive windows > 100 ms (`pipeline.ts` ~585);
   `paddedAttr*`, `tileSignatureWarm`, `shadowIntroFade` tracer counters.

## Iteration log (downtown, warm profile, window = control → fc+10 s)

| stage | worst | >33 ms | >20 ms | settle worst (fc−1..fc+3) | notes |
|---|---|---|---|---|---|
| baseline (random spawn, warm) | 791.7 | 35 | 50 | 41.6 | ~15×275–300 ms attach storm t+8..13 s |
| baseline (downtown, first visit) | 12 181 | 36 | 67 | 92.7 | 12.2 s cold-citygen compile outlier |
| + padded-attr update patch | 574–1 165 | 15–17 | 26–28 | 66–68 | attach storm GONE; early burst + 40 ms warm carpet remain |
| + 8 ms chunks (warmup still mid-sweep) | 1 583 | 50 | 161 | 141.7 | REGRESSION: carpet of 20–30 ms frames — reverted direction |
| + warmup deferred to post-settle | 574–892 | 15–18 | 23–30 | 58–66 | carpet gone |
| + per-tile signature warm (uncapped) | 574 | 16→44 | 64 | 66 | REGRESSION (30–55 ms window carpet) — capped to 2 finalizes |
| + sun-latch + min-interval + drain gate | 557–566 | 16–18 | 24–26 | 58.3 | settle burst now 2 spaced frames (41.9 + 58.3) |
| **final (+ intro fade)** | **558.1** | **15** | **26** | **58.3 (2 >33)** | zero console errors |
| final, fresh Chrome profile ("cold") | 565.4 | 17 | 29 | 65.2 | OS-level Metal cache makes fresh-profile ≈ warm on this machine |

Boot timings final: control 1 255–1 311 ms (band 1.0–1.7 s ✓), frontComplete
18.4–18.8 s (≤ 35 s ✓). Zero console errors in every final-config run.

## Success-target verdict (honest)

- **Settle moment**: worst 58.3 ms — the two paced post-settle shadow-domain
  redraws (each is a full-domain map render whose fresh casters pay their
  first shadow-pass draws). Target "no frame > 33 ms at settle" NOT literally
  met (2 frames >33), but the settle burst went from 7–8 stacked redraws + a
  hard lighting pop to two isolated ~40–60 ms frames under a 1.5 s
  contribution fade — perceptually the pop is gone (screenshots).
- **Full window**: worst 558 ms, 15 >33 ms, 26 >20 ms. NOT the "zero >33"
  target: the residue is almost entirely the first ~3 s after control —
  serial exclusive compile windows for single monster TSL materials (water
  sheets, facade family, batch materials; 200–480 ms of node-build/WGSL
  codegen EACH, unsliceable below one material at three r185's API) plus the
  first live frame's sync pipeline creations. Moving them pre-control blows
  the 1.0–1.7 s control budget (~2.2 s of codegen); slicing them needs
  three-level codegen surgery (out of scope, flagged below).
- **The user's actual complaint** (glitches while the world materializes from
  the shader view + at settle) — the measured causes (attach storm, warmup
  carpet, settle redraw burst, lighting pop) are fixed; the mid-sweep window
  t+4 s → settle now typically shows 1–3 frames >33 ms total.

## Visual checks

- Dissolve boundary + settle screenshot series (`m10-settle-plus{0,1,2,5}.png`,
  real-SF dusk lighting — worst case for the shadow pop): before the fix the
  street flipped into building shade between +0 and +0.7 s (one-frame pop);
  after, +0.7 s is unchanged, +2 s is mid-fade, +5 s settled — a gradual
  ~1.5–2 s lighting transition. (The "before" pair was captured in-session
  before the fix; the files were then overwritten by the after-run — the
  before-state is described from the recorded observation.)
- No material-swap flash or water reveal step observed at the boundary in any
  settled screenshot; `m10-base-settled.png` = fully settled downtown.

## Deviations from the task's suggested directions

- "Stagger held redraws one domain per 400–700 ms" — implemented as a global
  700 ms min-interval + release cushion (same effect, simpler invariant), and
  KEPT permanently for all static redraws (task's "consider permanently" —
  adopted).
- "Slice the compile chain toward ≤8 ms" — done for `warmScenePaced`; the P3
  construction warms cannot be sliced below one material and were left in
  place (documented leftover) rather than moved pre-control.
- Tile finalize sub-step slicing (suspect 3) and GLB parseAsync mitigation
  (suspect 4) were NOT needed: profiling attributed the storm to the padded
  attribute path, not finalize lumps; `#drainReady`/parse never surfaced in
  the final spike lists.
- GC/allocation spikes (suspect 6): V8 profiles showed GC at 105–180 ms per
  10 s windows, diffuse, never the spike driver — no action.

## Accepted leftovers (why + future lever)

1. **Early-window codegen lumps** (first ~3 s post-control, ~10 frames >33 ms,
   worst ~560 ms): single-material TSL node-build/codegen inside exclusive
   windows (water sheets, facade family, tile batch materials). Lever: slice
   three's node build/codegen (upstream surgery), a worker-side WGSL codegen,
   or pipeline-cache persistence; alternatively accept +1 s of control time by
   warming under the P1 cover.
2. **Two ~40–60 ms post-settle shadow redraw frames**: a full static-domain
   redraw with fresh casters is one frame of first-draw shadow-pass work.
   Lever: shadow-pass pipeline/render-object prewarm during the hold, or
   scissored partial domain redraws.
3. **First-ever district visit after a REBUILD** can still hit 0.3–12 s
   synchronous GPU-process pipeline compiles (Metal cache misses; shader text
   varies with build/graph-construction order). Lever: Dawn pipeline-cache
   persistence (Chrome-side), or stabilizing TSL codegen naming so WGSL text
   is build-stable.
4. The `[compile]` info line logs in production preview when windows exceed
   100 ms — deliberate (cheap, high-value attribution).
5. Warming per-tile signatures beyond the first two finalizes is disabled by
   design; if per-instance program cache keys ever become stable, the
   signature set would saturate and the cap could lift.

## Test results

- `npx tsc --noEmit` clean; full `npm run build` (contract tests + tsc + vite
  build + precompress) passes.
- Final probe matrix: 3 final-config warm runs + 1 fresh-profile run, all
  downtown-pinned, all zero console errors (table above).
- Worktree preview on port 5240 serves the FINAL dist
  (`http://localhost:5240/?autostart=1` → 200). All probe vite servers +
  headless Chromes killed.
- Nothing committed.
