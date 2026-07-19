# Buffer-destroyed validation storm — root cause + fix audit

The M6 watch item / M9 open risk: nondeterministic storms of
`GPUValidationError: buffer used in submit while destroyed` (hundreds to
thousands of errors) previously blamed on citygen shellBatch arena grows and
correlated with `?m9norelease=1`. Both prior attributions are wrong.

## Method — instrumented attribution probe

`tools/bufstorm-probe.mjs` (playwright-core + system Chrome headless,
WebGPU/metal, vite dev on a fresh port):

- An init script wraps `GPUDevice.createBuffer` (unique label per buffer +
  creation stack + frame), `GPUBuffer.destroy` (destruction stack + frame) and
  `GPUQueue.submit` (per-submit `pushErrorScope("validation")` — every error
  is captured WITH the offending buffer's label, the encoder label and the
  frame index, then matched back to its create/destroy records).
- Scenario: M9's "leak roam" amplifier — settle at downtown, then 300 m
  teleport hops every 2.5 s around
  downtown→embarcadero→bayfront→marinaGreen→goldenGate→palaceReverie, 210 s.
- Post-roam adversarial step: dispose three's shared Sprite quad geometry
  in-page and watch for errors (validates the renderer patch directly).

## Findings

| run | config | errors | attribution |
|---|---|---|---|
| pre-fix | `?m9norelease=1` | **10,353** | all → ONE 80-byte buffer |
| pre-fix | shipping (releases on) | **10,176** | same buffer, same site |
| post-fix | shipping | **0** (incl. sprite-dispose stress) | — |

Every single error (500 captured per run, 1 distinct label) referenced one
80-byte `VERTEX|COPY_DST|COPY_SRC` buffer created at boot inside
`WebGPUAttributeUtils.createAttribute` — three's **module-global shared Sprite
quad geometry** (4 verts × interleaved position+uv × 4 B = 80 B exactly).
Destroy stack: `palaceReverie/memoryLamps.ts` `dispose()` traverse →
`geometry.dispose()` on lamp flame/halo **Sprites** during palace site unload.
Storm onset in both runs at t≈120 s = exactly the palace→downtown roam leg
(site unload distance). Errors then continue EVERY frame to the end of the
run (permanent poisoning, `renderContext_1` = main pass).

### Root cause 1 (app): site disposals destroy three's shared sprite geometry

`THREE.Sprite` lazily creates ONE module-level `_geometry` shared by every
Sprite (`three/src/objects/Sprite.js:12,69-93`). Five site disposal traverses
disposed sprite geometry as if per-object:

- `src/gameplay/palaceReverie/memoryLamps.ts` (the probe-confirmed destroyer)
- `src/gameplay/palaceReverie/lagoonLanterns.ts`
- `src/gameplay/palaceReverie/skiff.ts`
- `src/gameplay/afterlight/site.ts` (explicitly included `isSprite`)
- `src/gameplay/afterlight/energyWeb.ts` (explicitly included `isSprite`)

All other traverse-dispose sites in the repo guard on `isMesh`/`instanceof
Mesh` (Sprites excluded) — audited clean.

### Root cause 2 (three r185): interleaved destroyAttribute evicts the wrong key

`WebGPUAttributeUtils.destroyAttribute` resolves the backend data via
`_getBufferAttribute(attribute)` — for an interleaved attribute that is the
shared `InterleavedBuffer` — destroys that GPU buffer, then calls
`backend.delete( attribute )` with the RAW attribute key. The
InterleavedBuffer entry survives holding a destroyed `GPUBuffer`; every later
`createAttribute` finds `buffer !== undefined` and reuses it, so every
subsequent sprite draw binds the destroyed buffer: an unbounded per-frame
storm. Plain attributes delete symmetrically — which is why the constant
stream of cell/proxy/building geometry disposals (and the shellBatch/tileBatch
arena grows) never stormed.

### Exonerations

- **shellBatch/tileBatch `setGeometrySize` live grows**: both probes show
  1,100+ buffer destroys from streaming churn (including arena grows) BEFORE
  storm onset with zero errors, in both configs. Between-frames disposal is
  structurally safe here: all submits happen synchronously inside
  `pipeline.render`, and replaced BatchedMesh geometry re-collects through
  `RenderObjects.get → needsGeometryUpdate` next frame. C6 (no mid-frame
  arena growth) still stands for hitch reasons — see the M10 padded-attribute
  work — but arena grows were never the storm.
- **`?m9norelease=1` A/B**: coincidence. The storm reproduces identically in
  the shipping config (10,176 vs 10,353); M9's clean releases-enabled runs
  were nondeterministic luck about whether the roam's palace unload preceded
  observation windows.

## Fix

1. **Sites** — the five traverses now skip `isSprite` objects' geometry
   (their site-owned materials still dispose).
2. **`src/render/attributeDisposePatch.ts`** — installed in
   `src/app/renderCore.ts` beside the bundle-order/registry/padded patches:
   re-implements `destroyAttribute` with a symmetric key (destroy AND delete
   via `_getBufferAttribute`), so any future mis-keyed dispose fully evicts
   the cache and the next use recreates a live buffer instead of poisoning
   the session.

## Verification

- `npx tsc --noEmit` clean; full `npm run build` passes.
- Post-fix probe (shipping config, same 210 s roam incl. palace unload):
  **0 validation errors, 0 uncaptured errors**.
- Adversarial in-page test at the end of the run: `new THREE.Sprite()` +
  `sprite.geometry.dispose()` (exactly the old bug) → **+0 errors** over the
  following 6 s; sprites recreate a live buffer next frame.
- No hitch surface: both fixes are dispose-path-only (no per-frame work
  added; the site fixes REMOVE dispose work), and the patch performs the same
  operations as stock with a corrected key.

## Leftovers

- Upstream: the `destroyAttribute` keying bug is worth a three.js issue/PR
  (r185, `WebGPUAttributeUtils.destroyAttribute` — `backend.delete(attribute)`
  should be `backend.delete(this._getBufferAttribute(attribute))`).
- `tools/bufstorm-probe.mjs` retained as the attribution harness for any
  future storm class (reports land in `.data/`).
