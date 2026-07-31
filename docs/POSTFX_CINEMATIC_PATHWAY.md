# The cinematic post chain, as built

This document described a *candidate plan* until 2026-07-30. It is now a
description of shipped code (commits `3a754dd` Wave 0, `4deff8d` Wave 1,
`5774a22` Wave 2, plus the repair passes recorded in
`.data/postfx/wave2-repairs.md`). Every stage below exists, renders, and has been
looked at in pixels at seven world stops with zero WebGPU validation errors and
zero uncaptured device errors.

Line-number citations have been removed almost everywhere on purpose. The
previous version of this file cited hard line numbers into `pipeline.ts`,
`postfx.ts`, `gradeLooks.ts`, `renderCore.ts`, `TRAANode.js` and `Position.js`;
within one wave of work `postfx.ts` was superseded and every other number had
moved. Where a line number genuinely carries the evidence (a specific line of
vendored three source) it is kept and was re-verified; otherwise things are named
by symbol, which does not rot.

Reading order if you have never seen this code: **§1** (what the chain is),
**§2** (why it is driven the way it is — this is the decision everything else
follows from), then **§5** (the reversed-depth rule) before you touch any stage.

---

## 1. The chain

One beauty pass publishes colour + depth + a packed g-buffer. One explicitly
driven chain consumes them. One `THREE.RenderPipeline` presents.

```
beauty pass (jittered, MRT: rgba16float colour | depth32float | rgba8 gbuffer)
  ├─ velocity        aux     input res   depth reprojection → rg16float
  ├─ jitter          inline  input res   camera.setViewOffset, applied by the frame driver
  ├─ ssao            aux     input×0.5   forked GTAO → r16float occlusion factor
  ├─ ssr             aux     input×0.5   forked SSR, mask-gated → 5-mip blur chain
  ├─ godrays         colour  input res   piano-grove volumetrics (area-gated, lazy)
  ├─ composite       colour  input res   min(contact, ao) × beauty + ssr, then underwater
  ├─ temporal        colour  input→OUTPUT  forked TAAU: resolve AND upsample
  ├─ dof             colour  output res  forked DepthOfField — ships OFF
  ├─ bloom           colour  output res  forked Bloom, linear HDR, pre-curve
  ├─ grade           inline  output res  the display transform (LUT), incl. AgX
  ├─ sharpen         inline  output res  RCAS
  ├─ grain           inline  output res  film grain
  └─ display         inline  output res  THE ONLY RenderPipeline; hosts grade/sharpen/grain
```

The order lives in exactly one place: `src/render/post/order.ts`
(`STAGE_ORDER`). Stages report the constant that belongs to their id; the chain
sorts by it. Gaps of 10 are deliberate so a stage inserted later takes a free
slot instead of renumbering a file some other unit owns.

`kind` is the contract that decides what happens to the chain colour:

- **`colour`** — replaces it. The next stage samples this stage's output.
- **`aux`** — publishes a buffer some later stage reads by name. It does not
  touch the chain colour, so isolating one in a probe correctly shows *no image
  change* (velocity isolated at the Golden Gate deck measured 0.0002 meanAbsDelta
  against a 0.0002 noise floor — that is the pass, not a failure).
- **`inline`** — owns a *look*, not a *pass*. Grade, sharpen and grain are fused
  into the display tail's single fragment shader, because two extra RGBA8 round
  trips would quantise away any grain amplitude below 1/255 at the pass boundary.

**Caveat on `chain.state()`**: it reports the stages that actually *rendered* on
the last presented frame, so the three inline stages never appear in
`state().enabled` even when they are visibly changing the image. `passes ===
enabled.length` is true by construction; it is not a "what is on" readout.

### Deliberately not a variant matrix

What this replaced: **8 style masks × 2 bloom families = up to 16 base
`RenderPipeline`s, plus up to 16 god-ray variants, plus FXAA — 33 retained
pipelines**, each its own TSL codegen window, with a `warmupPostFx` that existed
purely to pre-build them one per frame and a debug panel that warmed them on
folder expand. There is now **one** pipeline. `chain.displayPipeline` returns a
stable object identity that no toggle can invalidate.

---

## 2. Why the chain is driven from `pipeline.render()` and never by the node graph

**The one structural decision: the chain is driven explicitly, in a fixed order,
from `pipeline.render()`. No stage is ever scheduled by the node graph. Every
node this codebase owns — including the beauty pass itself — sets
`updateBeforeType = NodeUpdateType.NONE`.**

Three's normal mechanism is that a display node declares
`updateBeforeType = NodeUpdateType.FRAME` and the renderer calls its
`updateBefore` once per frame. The problem is *where* from:
`Renderer.js:3778` calls `this._nodes.updateBefore(renderObject)` from inside
`renderObject()`, **while a render pass is open**. A FRAME-scoped node that
renders its own fullscreen quad from there renders it inside somebody else's
pass, and WebGPU rejects a pass that both writes and binds the same texture —
taking the entire command buffer with it. The frame comes out as bare clear
colour.

This is measured, not theorised. `src/render/contactShadows.ts` records it
verbatim: across the same ten-second shot, **~70% of captures came back as clear
colour and the rest were clean**, and once it starts it repeats every frame. The
fix that shipped there was to call `contactShadows.renderNow(renderer)` at the
top of `render()` with the node's update type forced to `NONE` — which is exactly
the pattern this chain generalises.

Every stock display node three ships is FRAME-scoped: `GTAONode.js:89`,
`SSRNode.js:160`, `TAAUNode.js:68`, `TRAANode.js:58`,
`DepthOfFieldNode.js:224`, `BloomNode.js:266`, `SharpenNode.js:100`. Only
`RTTNode` is `RENDER`-scoped, which is why the old `rtt(bloom(...))` wrapper
worked and why nobody hit this before. Dropping seven FRAME-scoped depth-samplers
into this renderer unmodified is asking for the contact-shadow failure seven more
times, non-deterministically. So every one of them is vendored under
`post/<stage>/vendor/` with `updateBeforeType = NONE` and a public
`render(renderer)`.

Driving explicitly buys four more things, each of which was a requirement:

1. **Free toggles.** See §3.
2. **A deterministic order that is a contract**, rather than an emergent property
   of graph dependency resolution.
3. **Jitter ownership.** We call `camera.setViewOffset` ourselves before the
   beauty pass and `clearViewOffset` immediately after. We never touch
   `RenderPipeline.context.onBeforeRenderPipeline`, which is a *single assignable
   slot* that both `TRAANode` and `TAAUNode` write to — two temporal nodes in one
   scene and the second silently wins.
4. **History control.** Warmup covered renders and `captureStillRgba` do not go
   through the frame driver, so they cannot poison the temporal history.
   `frameIndex` advances only on **presented** frames — not on compile-held ones
   (`render()` early-returns while an exclusive compile window is open) — so the
   jitter sequence and the accumulated history can never desync from the
   projection sequence.

### The one thing explicit driving broke, and how it is held

Because the beauty pass is no longer reachable from any graph the display
pipeline builds, `PassNode.setup()` may never run — and `setup()` is what
normally forces the HDR colour type and the `FloatType` depth under
`reversedDepthBuffer`. Both would silently fall back to RGBA8 and
`depth24plus`: banded HDR plus a depth format nothing else in the chain can copy.
`pipeline.ts` therefore states both explicitly after constructing the pass rather
than hoping something builds the node.

Related, and written into `pipeline.ts` as a shouted comment: **do not rename the
g-buffer texture.** `MRTNode.setup()` resolves each MRT key to an attachment
index by matching `texture.name`, and silently `continue`s on -1. Renaming it
makes the fragment stage emit one output while the target has two attachments,
and every material in the world then fails pipeline creation with *"Color target
has no corresponding fragment stage output but writeMask is not zero"*. Measured:
the whole frame comes back as clear colour.

---

## 3. Why a stage toggle is free

The entire toggle mechanism is one line in `post/chain.ts`:

```ts
for (const stage of ordered) {
  if (!stage.enabled()) continue          // ← that is all of it
  ...
  slots.get(stage.id)?.bind(colour)       // binding update, never a recompile
  stage.render(frame)
  if (stage.kind === "colour") colour = stage.output() ?? colour
}
```

A disabled stage is **skipped** — not blitted through, not cleared, not rendered.
Its targets stay allocated, so re-enabling is free too. The mechanism that makes
this work is `shared/textureSlot.ts`: each stage samples a `texture()` node whose
`.value` the chain rebinds every frame to whatever the last *enabled* upstream
stage produced. Rebinding a `Texture` object updates a binding, not a shader —
three's own `DepthOfFieldNode` swaps `_CoCTextureNode.value` three times per
frame for the same reason.

So there is no variant matrix, no style mask, no `getVariantPipeline`, and
nothing recompiles when you tick a checkbox. Three mechanisms cover the rest:

- **Zeroed uniform identity** for anything fused into the display tail. `grain.strength = 0`
  and `sharpen.amount = 0` are *exact* identities (verified byte-for-byte, §6.4),
  and `surfFlow`'s `flowAmount = 0` is arithmetic-only.
- **Uniform `If()` early-out** only where the identity would still cost real
  work: the underwater package (16 taps + ~220 ALU) and sharpen's four extra
  grade evaluations. The condition must be a uniform-buffer read so the branch is
  uniform control flow for the whole draw — the GPU skips the block rather than
  masking it, and `textureSample` inside stays legal WGSL. **Never put a noise
  node inside one**; `mx_noise` inside a conditional corrupts the branch.
- **Skip the render call** for everything that owns a pass.

Exactly two things in the whole chain can still force a shader rebuild, and both
are declared in `PostStage.tuning.recompileKeys`: `post.ssr.blurQuality` (the box
blur's `(size*2+1)²` loop bounds must be constants) and `post.ssr.binaryRefine`.
The standing invariant is that **`recompileKeys` must be empty for any stage that
is enabled by default**, which SSR currently violates — see §8.

Structural keys (a resolution dropdown, `temporal.scale`) reallocate targets but
do not recompile; the panel gates them on slider release and routes them through
`pipeline.applyPostStructure()`, which re-warms the affected quads inside an
exclusive compile window so the frame is *held*, not corrupted.

---

## 4. Where each stage lives, and what its knobs do

Every stage owns `src/render/post/<id>/` with an `index.ts` (the stage wrapper),
a `tuning.ts` (its persisted group, at its own dotted path `post.<id>`), and a
`vendor/` folder if it forks a stock three node. The dotted path matters:
`core/persist.ts` fingerprints per group and `clearGroupOverrides` only deletes
keys one segment deep, so editing one stage's spec never collaterals a sibling's
saved overrides.

| Stage | Vendored from | Key defaults | What the knobs are for |
|---|---|---|---|
| `velocity` | — (ours) | `enabled true`, `source "reproject"` | `source` flips to `"mrt"` for offline capture only. Structural, not a recompile key — a default-enabled stage may declare none. |
| `jitter` | Halton(2,3) concept from `TAAUNode.js:819-822` | `amount 1`, `sequenceLength 32`, `space "input"` | `amount 0` is the debug identity. `space` is an A/B TAAU's own source is inconsistent about — see §6.5. |
| `ssao` | `GTAONode` | `intensity 0.55`, `radius 0.9 m`, `samples 16`, **`resolution 0.25`** | Stock's radius default (0.25 m) is far too small at city scale. `intensity` is deliberately low because it multiplies the final colour, not the ambient term, and contact shadows already darken contacts. `punch` is stock's `scale`, renamed because "scale" reads as resolution. **`resolution` moved 0.5 → 0.25 in the closing pass** and the cost/quality tables that decided it are in `ssao/tuning.ts`; the short version is §8.6. Every §6 measurement below was taken at 0.5. |
| `ssr` | `SSRNode` | `intensity 0.8`, `maxDistance 18 m`, `maskThreshold 0.02`, `resolution 0.5`, `autoSkipWhenDry true` | The **mask** is the design: `mask < threshold` discards as the first statement of the ray-march kernel — but a discard prices the fragments, not the six render passes, so the stage now also MEASURES the mask (a 64×1 probe, 1024 jittered taps, async readback) and removes itself from the frame entirely when nobody has opted in. `autoSkipWhenDry` can only ever subtract from `enabled`, never grant it. See §8.2. Stock's `maxDistance 1` is useless at city scale. `stepExponent` was promoted from a baked constant to a uniform by the fork. |
| `godrays` | — (adapter over `render/pianoGodRays.ts`) | `enabled true`, area-gated | Lazily imported; the module is never fetched for a player who does not enter the piano grove. Lifecycle is *level*-triggered from `updatePromotion()` — see §8. |
| `composite` | — (ours) | `occlusionCombine "min"`, `ssrIntensity 0.8` | Folds occlusion and reflections into the beauty colour in linear HDR, then runs the underwater package. `min` rather than a product so AO and contact shadows cannot stack. |
| `temporal` | `TAAUNode` (+ `TRAANode` as a declared fallback) | `scale 0.77`, `currentFrameWeight 0.06`, `maxVelocityLength 48`, `mode "taau"` | `scale` is the whole performance argument: the beauty pass renders 59% of the pixels. **It shipped at 0.667 through §6's measurements and moved to 0.77 in the performance pass** — every number in §6 and §8.3 below was taken at 0.667 and is labelled as such. `maxVelocityLength` (stock 128) is the primary defence against moving-object ghosting under reprojection-only velocity. |
| `dof` | `DepthOfFieldNode` | **`enabled false`**, `focusDistance 24 m`, `resolution 0.5` | Nine fullscreen passes, ~160 taps/px at half res — by a wide margin the most expensive stage. On for cinematics and photo mode. **Nothing is built until it is enabled**: no targets, no materials, and no quads in the boot compile (which fell 267 → 130 ms when that landed). `enabled` is a *structural* key here and nowhere else in the chain, so the panel routes it through build-then-re-warm; `applyStructure` also frees everything on the way back down. |
| `bloom` | `BloomNode` | `strength 0.42`, `radius 0.55`, `threshold 2.2`, `resolution 0.5` | `threshold 2.2` is load-bearing and pre-exposure — see §6.6. `resolution 0.5` is **not** the 1.0 the build spec asked for: stock `BloomNode` constructs at 0.5, every measurement above was taken at 0.5, and kernel radii are in texels of their own mip, so shipping 1.0 would silently halve the bloom's angular width while leaving `strength`/`radius` untouched. |
| `grade` | — (adapter over `render/grade.ts` + `gradeLooks.ts`) | look `goldenState` | Adds `agx` and `agxPunch` as `curve` branches inside `evaluateLook`, so `tools/grade-probe.mjs`, `calibration-probe.mjs` and `grade-compare-probe.mjs` predict them without changes. `post.grade.agxLive` is opt-in and off. |
| `sharpen` | RCAS math from `SharpenNode` | `amount 0.55`, `denoise true` | `amount` is *wrapped*: stock's `sharpness` is inverted (0 = maximum), we expose `[0,1]` and pass `2·(1−amount)`. 0 is an exact identity, which is the toggle — there is no separate `enabled`. |
| `grain` | — (ours; stock `FilmNode` is unusable) | `strength 0.018`, `size 1.35 px`, `response 0.85`, `chroma 0.35` | `FilmNode.js:69` is `base + base·clamp(noise+0.1)`, so its output is always 1.0–2.1× the input: it cannot darken a pixel and its `+0.1` is a flat exposure lift disguised as grain. Ours is zero-mean, luminance-responsive, resolution-independent, channel-decorrelated, and seeded by `frameIndex` rather than `time` — as a HASHED vec2 lattice offset, not the scalar it started as: a scalar broadcasts across the vec2 cell coordinate, which made the "seed" a pure translation of the grain field along (1,1) at ~81 px/s. It scrolled; it now scintillates. |
| `display` | — (ours) | `upscaleFilter "linear"` (not yet wired) | The only `RenderPipeline`. `outputColorTransform = false`; `grade.toDisplay` owns the display transform and `renderCore.ts` sets `renderer.toneMapping = NoToneMapping` so nothing applies a second one. |

### The display tail's internal order

```
uv = surfFlowLens(screenUV)                    // SURVIVOR, carried verbatim
c  = grade.toDisplay(colourSlot.sample(uv))
If (sharpenAmount > 0): c = rcas(gradeAt, uv)  // 4 more grade evals, uniform branch
c += filmGrain(c, screenCoord)                 // unconditional, zeroed identity
c  = surfFlowGrade(c)                          // SURVIVOR, carried verbatim
```

This document used to specify `grade → grain → sharpen`. **It ships
`grade → sharpen → grain`.** Sharpening on top of grain amplifies the grain into
crunchy speckle and keys RCAS's local-contrast estimate off noise instead of
edges; AMD's own RCAS guidance and every film pipeline put grain last, right
before display encode. Because both live in the same fused pass, flipping it is
one constant (`GRAIN_BEFORE_SHARPEN` in `post/display/index.ts`) and costs
nothing — grain is a pure function of screen position, so evaluating it at all
five RCAS taps is still cheap.

The surf-flow lens and grade both moved here from the old `postfx.ts`. Moving the
lens to the *end* is strictly better than warping the beauty tap: it now warps a
resolved image, so a UV warp the velocity buffer knows nothing about can no
longer fight the temporal history. Gameplay's contract (`setFlowPostFx(amount,
phase)`) is unchanged — uniforms only, never persisted, never in tweakpane.

---

## 5. Reversed depth is the trap, and the helpers are asymmetric

`reversedDepthBuffer: true` (`src/app/renderCore.ts:50`). Under it a raw depth
sample means the **opposite** of what every snippet on the internet assumes:
**background is 0.0 and the near plane is 1.0**.

Exactly **two lines in three's entire display folder** account for this:
`TRAANode.js:466` and `:511`. So every `depth.greaterThanEqual(1.0).discard()`
copied out of that folder discards *near geometry* and shades the *sky*. That is
the single most likely defect in any new stage here, and it is instantly visible:
capture the raw stage output at the Golden Gate deck and the sky is lit while the
near plane is black. Make that plate a hard gate before tuning anything — all
three shipped stages that needed it were verified this way (§6.1).

Every vendored node substitutes `post/shared/reversedDepth.ts`:

```ts
export const isGeometryDepth = (builder: any, depth: N): N =>
  builder.renderer.reversedDepthBuffer === true
    ? depth.greaterThan(1e-7)     // reversed: background is 0.0
    : depth.lessThan(0.9999999)   // standard: background is 1.0
```

Two further facts live next to that helper because both have already cost
someone a day:

- **`getViewPosition(uv, rawDepth, camera.projectionMatrixInverse)` is already
  correct** under reversed depth. `Renderer.js:3454` sets `camera._reversedDepth`,
  `Matrix4.js:1159` builds a genuinely reversed projection, and
  `PostProcessingUtils.js:18-37` feeds raw depth straight into `clip.z`. **Do not
  add a `oneMinus()` there.**
- **The depth↔viewZ helpers are asymmetric.** `perspectiveDepthToViewZ` and
  `orthographicDepthToViewZ` *are* reversed-aware
  (`ViewportDepthNode.js:229`, `:179`). `viewZToPerspectiveDepth` and
  `viewZToOrthographicDepth` are **not** (`:203`, `:153`), and their reversed
  twins at `:215` / `:165` are called by nothing in three. Raw depth → viewZ is
  safe with the stock helper; viewZ → depth is not. A stage that mixes the two
  compares depths in two different spaces. **Pick one space per stage and name it
  in a comment.** This asymmetry produced the worst TAAU defect in the fork.

Related standing rule, recorded in `PERF_LEVELUP.md` and repeated here because it
bites draw order rather than shaders: reversed-Z makes `RenderList.sort()` reverse
the whole sorted list, which inverts `groupOrder` and `renderOrder` too. **In this
app a HIGHER `renderOrder` draws EARLIER.**

The TAAU fork's four reversed-depth-adjacent fixes, in severity order: the
previous-depth `DepthTexture` must be forced to `FloatType` or
`copyTextureToTexture` tries `depth32float → depth24plus-stencil8` and WebGPU
rejects it outright (a **hard runtime failure**, not an artefact); the 3×3 depth
dilation seeded `float(2)` and took a `min()`, which under reversed Z picks the
*farthest* neighbour and points the velocity tap *away* from silhouettes; the
mixed depth spaces that follow from it; and the global velocity singleton
(`velocity.setProjectionMatrix` + the `onBeforeRenderPipeline` assignment), which
is deleted because we own jitter and our velocity is unjittered by construction.

The depth copy was verified by instrumenting `renderer.copyTextureToTexture`
rather than reasoning about it: **24 of 24 calls were `depth (depth32float) →
post_temporal_previous_depth (depth32float)`, 853×533 → 853×533, zero throws,
zero uncaptured errors.**

---

## 6. Measured results

Everything here was measured in a browser against a `curl`-verified dev server,
with the deterministic preamble (manual rAF via `frameDriver.manualTick`, dynamic
resolution off, pocket quality off, sky pinned at 18.6, `pixelRatio 1`), every
sample gated on `compileHeld === false && compileQueueDepth === 0`. Full write-ups
in `.data/postfx/wave2-correctness.md`, `.data/postfx/wave2-matrix.json` and
`.data/postfx/wave2-repairs.md`; plates under `.data/postfx/plates/`.

Seven boots — Ocean Beach ×3, downtown FiDi, Golden Gate deck, Embarcadero,
Mission Dolores, Sutro Baths. **Zero page errors, zero console errors, zero
uncaptured WebGPU errors in any run**, including the runs where TAAU, SSR, SSAO,
DOF, bloom and the piano god-rays all rendered together. The predicted
clear-colour command-buffer rejection did not occur on any captured frame.

### 6.1 The three reversed-depth plates — all pass

| Stage | Required signature | Measured |
|---|---|---|
| SSAO (`post_ssao_factor`, r16float) | sky WHITE (unoccluded) | sky-top mean **0.9970**, sky-upper 0.9842; real occlusion elsewhere (mid-centre min 0.1989, global min 0.0083) |
| SSR (`post_ssr_blur`, rgba16float) | sky BLACK | sky-top mean/min/max **exactly 0.0000** |
| Temporal (`post_temporal_history_a`) | *not* lit-sky-over-black-near-plane | sky-top 0.4833 linear vs near-bottom 0.0233 linear, and 0.0233 matches the beauty pass's own sRGB 41-43 |

### 6.2 G-buffer normals — pass everywhere except water

Read from the real attachment (hook `setRenderTarget`, then `copyTextureToBuffer`
on `textures[1]`), not from a debug shader.

- **Facades (FiDi): PASS.** Two 140×90 facade patches contain **994 and 949
  distinct quantised normals** with mean per-pixel Laplacian 3.86 / 3.43 — that
  is a normal *map*, not window geometry. The flat street beside them has **7**
  unique normals, Laplacian 0.563.
- **Terrain clipmap: PASS.** Horizon-band normalStd `[0.356, 0.473, 0.353]`; the
  deck road correctly flat at `[0.037, 0.0015, 0.028]`.
- **Water: FAILED, and has since been fixed.** The measurement and the fix are
  both in §8.1, because the reason it failed is worth more than the number.

The reason the g-buffer carries *material* normals rather than geometry normals:
the deleted half-res outline prepass used geometry normals deliberately, because
sampling material normals there meant re-running every material's `normalNode`
chain (the facade brick-bump fractal) a second time purely to feed edge
detection. In the *beauty* pass that chain is already being evaluated for
shading, so writing it to a second attachment costs the write, not the
evaluation. Normal-mapped normals for SSAO and SSR, for free — which the prepass
could never afford. **Net draw calls went down**: the prepass was a whole second
geometry pass and it is gone.

### 6.3 AgX — pass on all three sub-tests

`node --experimental-strip-types tools/grade-probe.mjs --check` → **PASS**.

**Grey card at the anchor condition** (t = 12.0, sun 64°), display-linear:
`goldenState` **0.177**, `agx` **0.180**, `agxPunch` **0.178** — −0.02 / +0.00 /
−0.02 stops. At the curve level, `evaluateLook(look, 0.18)` returns **0.492088 /
0.492118 / 0.492155** sRGB for the three looks: 7×10⁻⁵ apart. The bisected
exposure anchors hold, which is the whole "switching looks changes character, not
brightness" contract.

At t = 18.6 the card reads −2.65 / −2.62 / **−3.44** stops. `agxPunch` sitting
0.8 stops below is a **toe shape, not an exposure offset**: its 90% card is only
4% below `agx`'s while its 5% card is 45% below. An exposure error would shift all
four cards by one ratio.

**Matrix orientation — the thing that silently ruins AgX.** `mul3` in
`gradeLooks.ts` is row-major; three writes the AgX matrices with a *column*
constructor, so every array here must be that file's transpose. The invariant
that catches a transpose on sight is that every row of all four matrices sums to
1.0, because all four preserve white.

- `agxWhitePreservationError()` = **1.0×10⁻⁴** — exactly the 4-decimal rounding
  of the published sRGB→Rec.2020 matrix. Both AgX matrices are 1.0 to float64. **A
  transposed matrix lands in the 10⁻²–10⁻¹ range.**
- A neutral grey stays neutral through both AgX looks to within **9×10⁻⁵** across
  0.005 → 4.0 linear (`goldenState`'s own deviation is 3.2×10⁻², by design).
- Chroma on the sunset sky behaves as AgX should: saturation 0.573 (`goldenState`)
  → **0.274** (`agx`) → 0.371 (`agxPunch`); hue −138.1° → −145.5° / −145.9°. The
  two AgX variants agree to **0.4°**, which a transpose would not produce
  alongside a correct neutral axis.

**One number to know before touching the shaper:** AgX base's stress p99 is
**11.595** against the 12.0 gate — the tightest look in the file. And it is
**11.585 / 11.595 / 11.598 at 33³ / 48³ / 64³**: it does *not* fall with LUT size,
while every other look halves per step. That is not interpolation error, it is the
C0 kink where the log encode's hard `clamp01` meets the sigmoid at linear ≈2.93.
**Raising the cube size will not buy margin.**

`goldenState` stays the default. AgX holds ~16.5% chroma on the sun surround
against `goldenState`'s 50.5%; shipping AgX as the default would partially
reinstate the exact failure that got ACES dropped in the first place — three's
ACES is the Narkowicz/Hill per-channel fit through AP1, which desaturates and
hue-twists exactly the bright saturated sky this world is built around. AgX is
worth having **as a look**, and it costs one entry plus a curve branch and zero
per-pixel work: every look is the same single trilinear fetch.

### 6.4 Grain — zero-mean and resolution-independent, both decisively

**Zero-mean**, Golden Gate deck, `animate false`, everything else frozen:

| strength | lumMean | lumStd |
|---|---|---|
| 0 | 105.64 | 57.21 |
| 0.05 | 105.59 | 57.43 |
| 0.20 | 105.52 | 60.84 |
| 0.40 | 105.80 | 69.02 |

Deltas −0.05 / −0.12 / **+0.16** on a 0–255 scale — non-monotonic, i.e. noise —
while the added RMS noise reaches ~38 luma units. Independently at the pier:
strength 0.25 moves the frame by 23.55 meanAbsDelta and lumMean by **−0.18**
(−0.07%). **Stock `FilmNode`'s `+0.1` bias would be roughly +25 luma.** Returning
strength to 0 restores the frame to within the frozen noise floor (0.043).

**Resolution independence**, measured by isolating the pure grain field (strength
0.20 frame minus strength 0 frame at the same scale) and taking its horizontal
autocorrelation:

| `temporal.scale` | field variance | lag 1 | lag 2 | lag 3 |
|---|---|---|---|---|
| 1.0 | 434.25 | **0.2597** | 0.0006 | 0.0000 |
| 0.667 | 435.62 | **0.2595** | 0.0004 | −0.0001 |
| 0.5 | 439.51 | **0.2606** | 0.0019 | 0.0005 |

Identical cell size and identical amplitude across a 2× span of internal render
scale. The lag-1/lag-2 profile puts the cell at ~1.35 px, exactly `size: 1.35`.

**Sharpen's identity is a real byte comparison.** Pier, jitter off, grain off,
frozen ticks: `amount 0 → 1 → 0` gives `maxDelta 0`, `meanAbsDelta 0`, **buffers
byte-identical**. `amount 0 → 1` moves the deck edge gradient **0.3166 → 0.5081
(+60%)** with lumMean unchanged (105.64 → 105.69) — a sharpener must not move the
mean, and it does not.

### 6.5 Temporal — the resolve is correct; the default scale is a look decision

**Moving object: history is REJECTED, and the designed failure mode is the
observed one.** A 1.6 m white box 16 m in front of a locked camera, swept at
0.30 m/frame (~22 output px/frame) for 24 frames: **the box body is fully opaque,
correctly positioned and hard-edged under TAA — no comet, no translucency, no
smear.** What survives is two faint 1–2 px vertical ghost lines trailing the
silhouette and a slightly doubled edge on the leading side. `maxVelocityLength:
48` plus the previous-depth disocclusion test catch the body and leak only at the
silhouette. **That is aliasing-shaped, not smearing-shaped** — which is exactly
the trade §7 predicts.

**The FFT ocean**, the stop where reprojection velocity is blind by construction
(camera locked, world time advancing):

| config | ocean h-gradient | frame→frame | 8 frames | unique colours |
|---|---|---|---|---|
| TAA @ 0.667 (then shipping; now 0.77) | 2.896 | 0.851 | 5.811 | 69,499 |
| TAA @ 1.0 | 3.318 | 0.000 † | 8.231 | 75,411 |
| no temporal (@1.0) | 5.083 | 2.979 | 10.332 | 102,121 |
| TAA, currentFrameWeight 0.25 | 2.686 | 1.764 | 8.436 | 83,953 |

The water stays **alive**: 56% of the 8-frame motion energy survives the resolve,
and raising `currentFrameWeight` 0.06→0.25 doubles frame-to-frame motion as it
should. No freezing, no ghost trails. Every wave form is in the right place and
correctly shaped; what is lost is fine chop striation and glitter. († the
single-frame delta of exactly 0.000 at scale 1.0 is unexplained — the 8-frame
delta at that setting is 8.23, so the world was clearly advancing. Flagged, not
claimed.)

**Static convergence.** Golden Gate deck, dt = 0, consecutive frames:
`meanAbsDelta 0.255`. With `jitter.amount 0` and temporal on it drops to
**0.0068**, so the entire residual is the jitter sequence — a jittered TAA is not
supposed to produce byte-identical consecutive frames, it is supposed to converge,
and it does. A 3 cm dolly moves the image by 0.995 and the next frame settles back
to 0.262; the same dolly with temporal off moves it by **1.559**, so the temporal
path's response is *smaller* than ground truth, not larger.

**Jitter sign.** A wrong y sign would leave vertical aliasing untouched while x
still worked. Jitter-on/off gradient ratios on the deck region (which has both
axes of structure): at scale 0.667 horizontal **0.952** / vertical **0.939**; at
scale 1.0 horizontal **0.905** / vertical **0.881**. Vertical is anti-aliased at
least as hard as horizontal at both scales, and jitter *raises* unique colour
count while lowering gradient (57,822 vs 53,391) — reconstruction, not blur.

**Jitter span** (`post.jitter.space`) stays `"input"`. At scale 0.667, `"output"`
is 4% sharper (far-cable h-gradient 5.859 vs 5.624) and 20% less temporally stable
(0.247 vs 0.205). Small, opposed differences; `"input"` is what upstream's shipped
code and FSR2 do, it is the only setting whose samples cover the whole input-pixel
footprint the reconstruction filter integrates over, and at scale 1.0 the two are
identical anyway. Changing a default on a 4% single-stop reading would be picking
a winner from noise.

### 6.6 Bloom, occlusion, underwater

**Bloom's threshold 2.2 does exactly the discrimination it exists for.** Sutro
bath hall, lamp off vs on: bloom off, the lamp globe is a hard-edged orange
rectangle under a crisp black shade, no glow. Bloom on, the same globe carries a
soft warm halo about 1.5× its width bleeding onto shade, column and beam — and the
pale *lit planking a few pixels away is untouched*. Numerically, bloom adds
+0.2415 mean luma of positive energy and the strongest 24×24 blocks are the two
ceiling lamps at **+12.16** and **+9.62** mean luma, ~150× the frame mean.

The threshold is measured in **pre-exposure scene-linear** — exposure is applied
inside `grade.toDisplay`, downstream. Any future auto-exposure must go in the same
place or this number silently changes meaning. (A white diffuse surface in full
sun lands near 1.0–1.3 linear here; at threshold 1.05 the player's plain-white
head became a blazing orb outdoors and an outdoor frame's mean luma rose 83 → 106.)

**The `min()` occlusion invariant holds.** Mission Dolores nave, per band, `both
with min()` versus the darker single term: never darker by more than **0.014
luma**. No stacking. But say plainly why it is a weak pass: `contactVsNone` is
**0.087** meanAbsDelta against `aoVsNone` 0.909, because contact shadows key off
the direct-sun term and there is no direct sun in the nave. `min` and `multiply`
differ by 0.14 luma there. **To referee min() vs multiply for real you need a stop
where a sunlit contact shadow and a GTAO crease land on the same pixels** — a
sunlit arcade, or a colonnade with sun raking through it. No such measurement
exists yet.

SSAO itself is real but gentle in the nave: AO-only vs neither is 0.909
meanAbsDelta with `maxDelta 44`, visible darkening at column-base/floor junctions
and in wall-to-column crevices. Sweeping intensity 0 → 0.55 → 1.2 moves the
colonnade band 121.62 → 120.02 → 117.75, i.e. −1.3% at the shipped 0.55.

**Underwater fog survives bloom, and the private-traversal bug is gone.** In the
old `postfx.ts` the underwater depth binding was reached by a private traversal
(`(sceneTex as {passNode?}).passNode?.getTextureNode?.("depth")`) with a build-time
`if (uwDepthTex)`, so it vanished with no error whenever `sceneTex` was anything
but a `PassTextureNode` — which the bloomed family already made it. The composite
now takes `gbuffer.depth` explicitly. Measured, fog-only versus dry:

| | meanAbsDelta | per-channel R / G / B |
|---|---|---|
| bloom **off** | 31.856 | 50.15 / 17.49 / 27.93 |
| bloom **on** | 31.852 | 50.14 / 17.49 / 27.93 |

Identical to four significant figures. The per-channel signature is right too:
red is attenuated 2.9× harder than blue, which is Beer-Lambert with
σ = (0.38, 0.085, 0.05). Returning submersion to 0 restores the dry plate to
within 2.615 meanAbsDelta against a 2.618 noise floor — the uniform branch
degrades to identity. God rays now run *before* bloom rather than sampling an
already-bloomed image: rays-only contribution 17.663 with bloom off, **18.571**
with bloom on, i.e. bloom is smearing them, which is the improvement.

### 6.7 SSR mask coverage at three stops

The mask is the whole design, and it reaches the g-buffer exactly as authored.

| stop | mask coverage | SSR on↔off | A/A noise floor | verdict |
|---|---|---|---|---|
| Ocean Beach, open water | 87.4% of frame @ 0.9 | 2.683 | **2.794** | below noise |
| Ocean Beach, swash | 37.2%, graded | 2.838 | 2.618 | one band above noise |
| Golden Gate deck | 3.2% | band deltas ≤ 0.1 | — | inert |
| Downtown FiDi (dry) | **0.0%** — `nonZeroRatio 0.00000`, `max 0.000`, plate is pure black | 1.935 | **1.940** | free, as designed |

The swash plate is the one to look at: sky black, open water near-white (0.897 =
the authored 0.9 with no foam), and a smooth grey **wetness ramp** climbing the
beach from ~0.5 at the waterline to 0 up the dry sand — histogram spread across
every bucket from 0.06 to 0.85 plus a 50,627-px spike at 0.9. Authored, graded
wetness, reaching the g-buffer.

Mask authoring sites, opting in through `writeSsrMask(material, node)`:
`world/terrainClipmap.ts` (`wetSand`), `world/oceanBeachShorebreak/index.ts`,
`world/sutroBaths/staticWater.ts`, `world/japaneseTeaGarden/waterSimulation.ts`,
`world/ghostShip/hotTubWater.ts`, and `world/water.ts`'s Palace lagoon
(`0.9 × (1 − foam)`). The bay sheets in `world/water.ts` write the same
attachment through a local `writeWaterGBuffer` instead, for the reason in §8.1;
the camera-following annulus carries `0.9 × (1 − foam)` and the far horizon sheet
carries **0** — it has never opted into SSR and the normal fix was not the place
to decide that it should, but it writes its *normal* regardless, because the two
sheets meet at an alpha-tested ring at 1.9–2.1 km and one writing wave normals
while the other wrote flat up would leave a hard normal discontinuity there for
SSAO to shade as a ring.

A material that never opts in writes 0 and SSR skips it entirely — which is what
makes FiDi's `nonZeroRatio 0.00000` a design outcome rather than a lucky one.

Caveat inherited from `MRTNode`: non-`output` attachments get `_noBlending`, so
transparent and additive surfaces **overwrite** the g-buffer behind them at full
weight. For water and glass that is desirable — their normals and mask are the
ones SSR wants. For additive sprite emitters it is not; see §8.5.

### 6.8 The SSAO sub-texel bias, found and fixed by measurement

Worth recording because the mechanism is not obvious and the symptom looked like
a tuning problem. GTAO's `radius` is a **view-space length** but the horizon
search that spends it is a **screen-space march**, and nothing reconciled the two.
Past roughly `radius × (0.5·height·P11)` metres every step projects below one
depth texel and re-samples the centre pixel's own depth; `getViewPosition` then
reconstructs at the centre's view z, so `viewDelta.z` is **exactly 0** and
upstream's only gate (`|viewDelta.z| < thickness`) is *maximally satisfied by the
one case it must refuse*. The closed-form integral returns `cos γ + 0.5·γ·sin γ`
instead of `cos γ + γ·sin γ` — a deficit of 0% at γ=0, 22% at 45°, **32% at 60°**.

That predicts 0.68–0.78 at grazing incidence; the measurement was **0.683–0.747**
on open water at 0.5–3 km. The fix refuses a step that cannot land in a different
depth texel rather than enlarging the search. After: raw AO water-left
**0.747 → 0.9803**, band delta with SSAO isolated **−6.53 → −0.364**, deck-near
unchanged at 0.992 → 0.9925 (the real contact AO survives), whole-frame isolated
delta 1.1564/18.0% → 0.3239/6.7%.

The causal test rather than the symptom test: before the fix, AO was **not
monotone in `radius`** at long range — shrinking the radius pushes *more* steps
under a texel and fabricates *more* occlusion, which nothing but this mechanism
predicts. After: water-left 0.9907 / 0.9888 / 0.9803 / 0.9693 / 0.9629 at radius
0.1 / 0.3 / 0.9 / 2.0 / 3.0 — monotone, always above 0.96.

---

## 7. The velocity decision, and its honest failure mode

**Ships: screen-space depth reprojection. Available, off, for offline capture:
true per-object MRT velocity.**

The reprojection pass is one fullscreen pass at input resolution:

```
viewPos  = getViewPosition(uv, depth, projInvUnjittered)   // 1 depth tap
worldPos = cameraWorldMatrix · vec4(viewPos, 1)
prevNdc  = (prevUnjitteredViewProjection · worldPos).xy / .w
velocity = currentNdc − prevNdc                            // → rg16float
```

It is **exact** for every static surface — terrain, city, buildings, roads,
unmoving foliage — which is the overwhelming majority of screen coverage at every
benchmark stop. It changes **no world material**, costs ~0.2 ms at 0.66 Mpx, and
is computed from the *unjittered* projection on both sides so jitter can never
leak into motion vectors. (There is a NaN/Inf fence at 4.0 NDC: a surface that was
*behind* the previous camera reprojects through a near-zero or negative `w`, and
an Inf in rg16float poisons every neighbourhood the resolve reads it into, not
just its own texel.)

Verified: static (rig at rest, 6 real frames) `meanMag 0.000000`, `maxMag
0.000000`, `nonZeroRatio 0.00000`. Panning through the game's own chase rig, 0.02
rad/tick → meanMag 0.014684; 0.06 rad/tick → meanMag 0.047692 — a ratio of 3.25
against an angular ratio of 3.0. *(Note for future probes: writing
`camera.rotation.y` directly is clobbered by the chase rig before the chain runs,
and reads as "velocity is dead".)*

### Why true MRT velocity is not the default

Three findings, each independently disqualifying on a fanless M5 Air:

1. **It destroys the static-BundleGroup fast path across the whole city, every
   frame.** `NodeMaterialObserver.needsRefresh` returns `true` *unconditionally*
   when the renderer MRT has `velocity` (`NodeMaterialObserver.js:719`), bypassing
   the `isStatic || isBundle` early-out. `Renderer._renderBundle`'s cached path
   then runs `updateBefore` + `geometries/nodes/bindings.updateForRender` +
   `updateAfter` for **every object in every static BundleGroup, every frame** —
   `tiles.ts`, `citygen/render.ts`, `trafficLights.ts`, i.e. downtown, the marina
   and the Golden Gate deck. This is a CPU regression no amount of per-material
   work removes.
2. **The velocity it produces is wrong on the surfaces with the largest screen
   coverage.** `Batch.js` contains no `positionPrevious` handling at all — only
   `Skinning.js` and `Instance.js` write it in all of three — so every
   `BatchedMesh` (all building shells and windows, all road/park/pier decks, the
   batched facade path) reports the velocity of untransformed local coordinates.
   Add ~50 `positionNode` sites and 21 `SpriteNodeMaterial` sites on top.
3. **`VelocityNode.setup()` runs in the fragment stage** — both `positionLocal`
   and `positionPrevious` are varyings — evaluating three `mat4 × mat4` products
   per pixel in every material. ~192 MACs/px of pure overhead on two stops that
   are already fragment-bound.

And the failure a neighbourhood clamp *cannot* catch: `wake.ts`, `birdTrail.ts`,
`skyWhale.ts` and `energyWeb.ts` rewrite their position attribute on the CPU each
frame with `DynamicDrawUsage`. `positionPrevious` samples the **same already
updated buffer**, so velocity reports exactly **zero** for geometry sweeping
across the screen — and zero is a perfectly plausible value that the clamp accepts
happily.

### The failure mode, stated honestly

**A moving object reports camera-only motion.** That does *not* smear, because
TAAU's history rejection is driven by previous **depth** as much as by velocity
(`TAAUNode.js:678` `isDisocclusion`, `:744` `isDepthChanged`): when a car, a bird,
a kite or a wave moves, the depth at that pixel changes and the history is thrown
away. **The failure mode is "moving objects are less anti-aliased", not "moving
objects smear"** — and §6.5's box sweep is the measurement that says so.

That is strictly the better failure. A *partially* correct velocity field — which
is all the MRT path would give until every one of ~75 sites is fixed — produces
confident-but-wrong reprojection, which is worse than no reprojection at all.

If someone does upgrade the MRT path per material family, start with the terrain
clipmap (previous local == current local, so one `positionPrevious.assign(...)`
inside a `needsPreviousData()` gate makes the largest-area surface exact) and
**do not index any per-instance fix by `instanceIndex`** — `gpuIndirect.ts`
resolves instances through `visibleIndices.element(instanceIndex)` and the
compaction order changes every frame, so `instanceIndex` does not identify the
same blade or tree across frames. Placement is a pure function of `trueIndex`
plus static attributes; evaluate the previous placement with a `uPrevTime`
uniform and no cross-frame index mapping is needed.

---

## 8. Known open

Recorded with evidence rather than adjectives. None of these is a blocker; all of
them are things a reader will otherwise rediscover the hard way.

### 8.1 Water wrote a flat g-buffer normal — FIXED; the after-plate is not taken

**What was measured.** At an ocean-facing stop, **88.8% of the frame carried one
single quantised normal**, `[128,243,182]` → view-space `(0.004, 0.906, 0.427)`,
which is world-up under a 25.5° down-pitch. `normalStd` was **exactly `[0,0,0]`**
in the horizon, mid-centre, near-bottom, lower-left and lower-right bands, over a
beauty plate full of wave structure. Downstream, SSR traced the bay as a
mirror-flat plane and returned almost nothing (§8.2).

**Why the obvious fix does not work, which is the part worth keeping.** The bay
sheets are `MeshBasicNodeMaterial` with `lights = false`, and
`MeshBasicNodeMaterial.js:67` **overrides `setupNormal()` to hard-return
`negateOnBackSide(normalViewGeometry)` and never reads `this.normalNode`** —
"basic materials are not affected by normal and bump maps", in its own words. The
shared `writeSsrMask()` helper packs `normalView`, which resolves through
`builder.context.setupNormal()` → `material.setupNormal()`, so on these materials
`mat.normalNode = …` is **silently discarded: it type-checks, it compiles, it
runs, and the attachment still receives the interpolated plane normal.** An
assignment that is ignored looks exactly like a fix. (`NodeMaterial.js:935` is
the version that honours `normalNode`, which is why the Palace lagoon — a
`MeshPhysicalNodeMaterial` — was the only water in the world whose g-buffer
normal was ever right, and why it keeps using `writeSsrMask`.) Vertex
displacement in `positionNode` does not update the normal attribute either, so
even the FFT-displaced near/hero sheets wrote flat up.

**The fix**, in the working tree: `water.ts` writes its own `mrtNode` through a
local `writeWaterGBuffer(mat, worldNormal, ssrAmount)` that states the normal
term explicitly rather than routing it through a hook this material class
deliberately does not implement. Packing stays byte-identical to
`writeSsrMask()`; the two must be kept in step if the attachment format ever
changes. `worldNormal` is the sheet's own `rippleNormal`, already a `.toVar()`
built from the `oceanDetail()` cascade fetch the BRDF needs anyway, so it
re-evaluates nothing — no second cascade texture fetch on the highest-coverage
material in the world. It adds a `mat4×vec4` with `w = 0` plus a normalize
(~24 fragment ALU) and removes the now-unreferenced `normalViewGeometry` chain
(a vertex-stage `modelNormalMatrix` multiply and a `vec3` varying across 42.6k
displaced near/hero vertices). The beauty pass is unchanged to the code value.

**CLOSED — the after-plate was taken.** At the same wave-2 `c1-ob` framing, the
five bands that read `normalStd [0,0,0]` now read 0.17–0.27; `dominantNormalShare`
**0.8884 → 0.0143**; `uniqueNormals` **3 398 → 32 597**; the mean world normal is
`(−0.04, 0.93, −0.05)`, a horizontal sheet, so the view→world transform is right.
The *sign* was checked with two independent instruments rather than assumed —
Pearson r of the beauty attachment against Fresnel predicted from the decoded
normal, 8×8 blocks, player rect excluded: **as shipped +0.933**, flip-x −0.432,
flip-z +0.629, flip-xz −0.649; and SSR's own contribution against Fresnel: as
shipped +0.246, flip-x −0.152. Both rank `asShipped` first and `flipX` negative.
Plates and JSON: `.data/postfx/plates/f2/`, `.data/postfx/f2-report.json`,
`.data/postfx/f2b-reflection-direction.json`.

### 8.2 SSR on open water — RE-MEASURED after the normal fix; it earns its cost, and it now costs nothing when dry

**The premise that argued for cutting water out of the SSR mask is false.** Every
number in the original write-up below predates §8.1's fix and was computed against
a mirror-flat water g-buffer. Re-measured at the same Ocean Beach stop, for the
same 1.36–1.44 ms:

| | before | after |
|---|---|---|
| reflection buffer `nonZeroRatio` | 0.0163 | **0.10905** (6.7×) |
| reflection buffer `mean` | 0.0037 | **0.01305** (3.5×) |
| non-zero sampled rows | 1 of 34 | **29 of 35** |
| band-mean luma, SSR on − off | +0.55 at one seam | **+1.39 … +3.69**, against an A/A floor of ≤0.025 |

Wave-locked, on the crests, in the direction the geometry predicts. It reads as
sheen on water rather than a mirror with noise on it. Bloom costs more at that
stop.

**And the dry frame is now genuinely free.** SSR used to cost 0.274 ms at FiDi on
a frame whose mask is provably all zero, because "the kernel discards on the first
statement" prices the fragments and not the six render passes. The stage now
measures the mask itself — one 64×1 draw, 1024 jittered taps on a 32×32 lattice,
read back asynchronously — and removes itself from the frame when nobody has
opted in. Verified live at FiDi: `chain.state()` settles at `passes 6`,
`velocity>ssao>composite>temporal>bloom>display`, with `post.ssr.enabled` still
`true`; defeating the gate (`post.ssr.autoSkipWhenDry = false`) brings it straight
back to 7. Cost at FiDi 0.274 → **0.088 ms**, which is the probe itself.

The gate can only ever *subtract*: nothing writes `enabled`, it fails open on a
readback failure and on every `invalidateHistory`, and skipping is a bit-exact
identity because the composite multiplies by a zeroed `active`. Design notes and
the reason a CPU-side gate was rejected (at FiDi the bay IS in the frustum — the
mask is empty because buildings occlude it) are in `post/ssr/index.ts`.

<details><summary>The pre-fix write-up, kept because its analysis of WHY screen space finds so little over open water is still correct</summary>

SSR is correct: reversed-depth plate passes, mask coverage is exactly as authored,
and it is **exactly free when dry** (FiDi: `nonZeroRatio 0.00000`, on↔off delta
1.935 against a 1.940 noise floor). What is unproven is whether it earns its
~1.6 ms at a wet stop.

The raw reflection buffer at the swash: `mean 0.0037`, `max 4.84`,
**`nonZeroRatio 0.0163`** — 1.6% of pixels carry any reflection, and 33 of 34
sampled rows are exactly zero. A signed row profile of off→on puts **+1.20 luma
at the breaking-surf row and nothing anywhere else**; forcing `ssrIntensity` to 6
(7.5×) raises that to +3.86 and still moves no other row. So there *is* a real
contribution and it is confined to the surf line.

**The mask is not the reason.** `maskThreshold 0.02 → 0` changed the image by
**exactly 0.0**, which rules out the discard. The march runs and misses: a
near-horizontal water surface reflects **sky**, screen space cannot supply sky,
and this fork ships `environmentNode: null` on purpose (vendoring
`ImportanceSampledEnvironment` was ruled out of scope). `waterShadingTSL.ts`
already owns the analytic sky term, so SSR's correct contribution over water is
the *geometry* reflection the analytic term cannot know about — which is precisely
the shoreline sliver that was measured, landing exactly where such a reflection
belongs.

The honest statement is therefore not "SSR on the ocean looks worse than the
analytic reflection". It is: **SSR on the ocean paid for a near-fullscreen trace
to add half a code value at the horizon and one code value at the surf line,
computed off a normal that had no waves in it.**

**Every number in this section predates the water-normal fix in §8.1**, which is
precisely the input SSR was missing. A wave-distorted normal scatters reflected
rays that were previously all leaving the screen in the same direction, so the
hit rate could change materially — or not at all, since the missing term is still
sky. **Re-measure before deciding anything.** Nobody has.

`post.ssr.enabled` still ships `true`, deliberately. Every stop measured so far —
Ocean Beach, Lands End, the Golden Gate deck — is **open coast**, the case with
the least on-screen geometry above the waterline this world contains. The mask's
other authoring sites (Sutro Baths pools, the tea-garden pond, ghostShip's hot
tub, `terrainClipmap`'s `wetSand`) are all enclosed by geometry and **none has
ever been under a camera**. Cutting the stage on coastal evidence would be cutting
it on the evidence least able to speak for it. The next verification pass should
stand in the Sutro Baths pools and the tea-garden pond before anyone decides.

If the call is ever to cut it, note that flipping that default also retires SSR's
`RECOMPILE_EXCEPTIONS` entry in `tools/post-chain-contract-test.mjs` — SSR is the
only default-enabled stage with non-empty `recompileKeys`, which is the §3
invariant the contract test currently pins as a known exception.

**A spec collision, left at its current value rather than silently rescaled:** the
reflection is multiplied by `post.ssr.intensity` (0.8, in the kernel) **and** by
`post.composite.ssrIntensity` (0.8, at the consumer). Two sliders in two panels
multiply to 0.64 and neither says so. Collapsing them changes the shipping
strength of a stage by 1.25×.

</details>

**Still open on SSR:** the mask's *enclosed* authoring sites — the Sutro Baths
pools, the tea-garden pond, ghostShip's hot tub, `terrainClipmap`'s `wetSand` —
have **still never been under a camera**, and they are the case screen-space
reflection is actually good at (geometry above the waterline, in frame). Every
coastal number above is the case it is worst at.

### 8.3 `temporal.scale` is a sharpness/cost trade nobody has art-directed — OPEN

This is the knob the entire performance argument rests on: at 0.667 the beauty
pass renders **44% of the pixels**, and that is what was supposed to fund
AO + SSR + the tail.

**It does not, and the performance pass proved it — the default is now 0.77.**
Only velocity / SSAO / SSR / composite run at beauty resolution; the temporal
resolve, bloom and the display tail all run at OUTPUT resolution and do not
shrink with `scale` at all (measured at FiDi: 2.27 ms of a 4.23 ms chain). So
`scale` can only ever attack ~46% of the chain's cost while the beauty-pass
saving it buys has to cover 100% of it. The acceptance gate — full chain at
0.667 no more expensive than the chain bypassed at 1.0 — **fails at both
designated stops** (botanical meadow +1.65 ms, Ocean Beach open water
+5.09 ms). See §8.6.

The resolve itself is correct — **TAAU at scale 1.0 and TRAA at scale 1.0 agree
within 3% on every metric**, so the accumulation, the clamp, the thin-feature lock
and the jitter are all fine. The entire cost is in the scale.

**Every number in the rest of this section was taken at 0.667**, which was the
default when they were measured. The 0.77 choice is the knee of the same curve:
+1.2 ms buys back 30% of the lost detail, where 0.77 → 1.0 costs a further
+3.8…+6.5 ms for the remaining 70%.

Golden Gate deck, far suspender group (sub-input-pixel at 0.667), mean |horizontal
luma gradient|:

| config | far-cable gradient | near-cable core p02 | deck texture gradient |
|---|---|---|---|
| no temporal (beauty at 1.0) | 23.553 | 35.3 | 1.188 |
| TAAU scale 1.0 | 12.773 | 36.3 | 0.677 |
| TRAA (scale 1) | 13.213 | 35.3 | 0.764 |
| **TAAU scale 0.667 (default when measured; now 0.77)** | **6.060** | **61.4** | 0.386 |
| shipping full chain (+RCAS/grain) | 7.457 | 59.0 | 1.338 |

Dropping to 0.667 halves far-cable gradient energy and lifts near-cable line cores
from 36 to 61 luma — the lines lose ~40% of their depth. Visually the far cables
go from five continuous lines to faint dotted traces, and at the default spawn
individual grass blades become a painterly smear. RCAS recovers deck texture
(0.386 → 1.338) but does not bring the cables back.

The other side of the same coin, at the same stop: with the chain **off**, edge
energy is 11.18 and the deck is a staircase; with it on at 0.667 it is 5.63 with
clean sub-pixel edges and the water moiré gone. Two correct behaviours. It is an
artist's call, and no default has been softened to make it go away.

### 8.4 The temporal resolve is load-bearing for citygen's LOD crossfade — PRE-EXISTING

Anyone running a temporal-off control needs to know this before they file a bug.
At the Embarcadero, `temporal.enabled = false` produces a **catastrophically
shredded frame**. It is not a post-chain defect: it is **citygen's `alphaHash` LOD
crossfade** (`src/world/citygen/render.ts`, `render/moduleLayer.ts`,
`render/shellBatch.ts` — "dithered fade in the OPAQUE pass") rendered with nothing
downstream to resolve the stochastic discard. **Every crossfading building becomes
1-px confetti.**

Two consequences. First, **the temporal resolve is load-bearing for the city's
appearance, not just its edges** — the master post toggle, `?fastcapture`, and any
future no-TAA path will all show this. Second, it invalidated a measurement:
the first "ocean band" reading at the pier was buildings, which is why the FFT
ocean temporal test in §6.5 was redone at Ocean Beach open water.

**This is pre-existing behaviour that TAA now conceals, not a regression this work
introduced.** The dithered fade was always going to need a resolve; before this
chain there was nothing to notice it with.

### 8.5 Smaller open items

- **DOF brightens the out-of-focus background by ~10%** (sky +14.89, water +5.15
  band delta). Root cause is upstream's bokeh model, not a slip in the fork:
  the 16-tap pass is a **MAX** filter and the composite blends the far field by
  the pixel's own far CoC, which saturates at 1 across a distant background, so a
  fully defocused pixel is *replaced* by the local maximum rather than blended
  toward the 64-tap weighted average. `max ≥ mean` on every non-constant field.
  Diagnosed and written into `dof/vendor/dof.ts`; **not** redesigned, because the
  fix is a decision about what defocus should look like and the stage ships off.
- **The raw SSAO factor is speckled** at 16 samples / half res, with horizontal
  banding and blocky repeats over the distant city band. AO quality is therefore
  coupled to the temporal resolve being on. Fixing it means more samples or a
  spatial denoiser — cost decisions, not repairs. **The default is now 16 samples
  at QUARTER res** (§8.6), which trades in the same direction; the measured cost
  of doing so in the final image is ~6% of the difference AO makes at all, and the
  thing no measurement here covers is halo and crawl on a MOVING camera. That is
  the one item on this page most worth a pair of human eyes.
- **A GTAO residual**: on a flat *grazing* surface the fixed kernel returns
  0.96–0.99 rather than exactly 1.0. That is upstream's `factor / DIRECTIONS`
  normalisation evaluated with only 3 slices — 3-direction quadrature error,
  averaged out by the 6-frame rotation and the TAA resolve. For scale: it costs
  the water −0.36 luma out of 135, against the −6.53 it used to cost (§6.8).
- **The Sutro bloom regression number (58.8 → 61.8 hall mean) did not reproduce**
  at the framing it was re-attempted from (70.39 → 70.47). The re-attempt's hall
  mean is 70.4, not 58.8, so it is demonstrably a different shot — and a threshold
  sweep 6.0 → 0.8 moved that frame's mean only 70.387 → 70.543, i.e. it contains
  almost no scene-linear content above even 0.8. Whoever owns the original
  measurement should re-take it from the original camera.
- **The swimming player's wake-ripple quads punch a hard trapezoid through the
  SSR mask** — `src/fx/wake.ts`, additive, `depthWrite: false`, no `mrtNode`, so
  they overwrite the attachment with the pass default (mask 0 + the quad's flat
  normal). The `_noBlending` mechanism from §6.7 caught in the act, and the class
  to watch for is additive markers corrupting normals now that layer 31 writes to
  the g-buffer too — steam at the Sutro hall, fireflies in the Afterlight grove.
  **The mitigation this document used to give — `writeSsrMask(mat, float(0))` on
  the offenders — is a NO-OP and was never going to work**: for a material that
  has not opted in, that call writes byte-for-byte what the pass MRT already
  writes for it. The three routes that would work, and why none is a one-liner,
  are written into `post/shared/gbuffer.ts` at `writeSsrMask`. The short version:
  per-attachment blending is the right answer, r185 has the API
  (`MRTNode.setBlendMode`, honoured by `WebGPUPipelineUtils.js:147-165`), and it
  is **defeated by an upstream typo** — `MRTNode.merge()` assigns the combined map
  to `mrtTarget.blendings` while `getBlendMode` reads `this.blendModes`, so every
  merged material MRT silently falls back to `_noBlending`. Still open, still
  cosmetically minor.
- **Transparent water sheets overwriting the g-buffer is mostly a non-issue, and
  here is the accounting** (it gets raised, so it is written down at
  `water.ts`'s `writeWaterGBuffer`). Every bay sheet sets
  `mat.maskNode = coverage.greaterThan(0.5)`, and a maskNode is a **discard** —
  it kills the whole fragment and every attachment with it. So the shoreline, the
  dry-land cut and the 1.9–2.1 km annulus handoff overwrite nothing; they are an
  alpha *test*, not a fade. The residual is the feather at `coverage ∈ (0.5, 1]`,
  i.e. pixels the sheet has already won. The one genuinely soft edge in the file
  is the Palace lagoon (`MeshPhysicalNodeMaterial`, no maskNode), whose outermost
  transparent pixels do stamp mask 0.9 over the ground behind. Not plated.
- **`post.display.upscaleFilter` is not wired.** Honouring it means changing
  min/magFilter on a target the chain's target pool owns and a sampler bind group
  already references — a resource-level edit, deliberately left to whoever owns
  `post/targets.ts`.
- **`src/render/postfx.ts` is deleted** (all 583 lines), along with
  `tools/ukiyo-postfx-probe.mjs`, whose hard assertions were entirely about the
  ukiyo style mask. Its survivors were carried into
  `post/composite/underwater.ts` and `post/display/surfFlow.ts`. The four
  comments that still named it as a live seam (`fx/underwater.ts`,
  `fx/underwaterRig.ts`, `app/renderCore.ts`, `render/grade.ts`) have all been
  repointed. What remains under `post/**` are provenance citations —
  `postfx.ts:44-51` and friends — which are deliberate historical references to
  where a hazard was first hit, not claims that the file exists.
- **`tools/mission-dolores-probe.mjs` is broken, and was broken before this
  work.** It reads `POSTFX_TUNING.values.museumRays`, `applyRadialLightFx()` and
  `radialLightState`, none of which existed on main before the rebuild either.
  Left alone deliberately; it needs its own owner, not a search-and-replace.

---

### 8.6 The acceptance gate FAILS — SETTLED: the chain ships on, and the waste was taken

**DECIDED. `post.enabled` ships `true`.** The gate below still fails; it fails by
a lot less than it did, and the reasoning for shipping anyway is recorded at the
tunable itself (`post/tuning.ts`) rather than only here:

- This is no longer "the chain" versus "the old image". The four style treatments
  and FXAA are deleted, so bypassing runs the display tail alone — an image
  nobody has art-directed.
- The temporal resolve is load-bearing beyond edges (§8.4): with it off,
  citygen's alphaHash LOD crossfade renders every crossfading building as 1-px
  confetti. Turning the chain off is a *worse* picture, not a cheaper one.
- The master toggle and the quality presets exist precisely so the cost is the
  user's call, and the panel reports what ran honestly.

**What the closing pass took, both measured rather than argued.**

| change | before | after | where |
|---|---|---|---|
| **SSAO `resolution` ½ → ¼** | 1.29 ms at FiDi, 1.8–2.9× budget | **0.248 ms** at FiDi, 0.38 at the meadow, 0.02 on open water | `post/ssao/tuning.ts` carries the full cost and quality tables |
| **SSR skips itself on a dry frame** | 0.274 ms at FiDi for a mask measured `nonZeroRatio 0.00000` | **0.088 ms** — the probe's own cost; the stage does not run | `post/ssr/index.ts`, "the dry probe" |
| **DOF no longer built or compiled at boot** | 7 quads incl. `Loop(64)` in the boot compile for a stage that ships off | `chain-compile` **267 ms → 130 ms** | `post/dof/index.ts` |

SSAO's ¼-resolution default is chosen on a measured curve, not to make a budget
line go green: at the **botanical meadow** — the AO-richest stop in the world,
`occludedFraction 0.593` — quarter-res gives up ~6% of the difference AO makes at
all, and it is both **cheaper than** and **closer to the reference than** halving
the sample count instead. Downtown at the §9.4 heading turned out to be a useless
stop for this question (`occludedFraction 0.059`, nothing separates); that is
recorded in the tuning file so nobody re-measures it there.

**The gate, re-run at the shipped defaults.** Same instrument, same machine, one
session per stop, same-round differences.

| stop | shipped | bypass @1.0 | verdict | was |
|---|---|---|---|---|
| **botanical meadow** | **12.31** | **11.81** | **FAIL +0.50 ms (+4.3%)** | +1.65 / +2.08 |
| **Ocean Beach, open water** | **10.84** | **8.61** | **FAIL +2.15 ms (+25%)** | +5.09 |
| **downtown FiDi** | **6.56** | **5.47** | **FAIL +1.09 ms (+20%)** | (chain was 4.23 ms) |

Per-stage at the shipped defaults, same-round difference against `shipped`:

| stage | budget | meadow | Ocean Beach | FiDi |
|---|---|---|---|---|
| velocity | 0.20 | 0.83 | ~0 | 0.14 |
| SSAO | 0.45 | 0.38 | 0.02 | **0.25** |
| SSR | 0.10 dry / 1.60 wet | 0.36 | **0.83** | **0.09** (skipped) |
| composite | 0.25 | 0.96 | 0.11 | 0.24 |
| temporal (at scale 1) | 1.20 | 1.47 | 0.26 | 0.79 |
| **bloom** | 0.80 | **1.96** | **1.57** | **0.86** |

**Bloom is now the most expensive stage in the chain at every stop**, and it is
the only one still clearly over budget. That is the next millisecond, and it was
not touched here.

The meadow column carries ±0.8–1 ms of round-to-round noise (it did before too);
FiDi is the credible column. Raw: `.data/postfx/perf/final-totals-{meadow,oceanBeach,fidi}.json`.

<details><summary>The pre-closing measurement, kept for the record</summary>

#### The gate as it stood before the closing pass

The gate: the full chain at the shipped `temporal.scale` must cost no more than
the same build with the chain bypassed at scale 1. Throughput, ms/frame,
1512×982 at pixelRatio 1, median-of-rounds with round 0 discarded, MacBook Air
M5 24 GB.

| stop | full @0.667 | bypass @1.0 | verdict |
|---|---|---|---|
| **botanical meadow** (7 rounds) | **17.64** | **15.99** | **FAIL +1.65 ms (+10.3%)** |
| botanical meadow (independent 4-round session) | 17.96 | 15.88 | FAIL +2.08 ms (+13.1%) |
| **Ocean Beach, open water** (6 rounds) | **13.95** | **8.87** | **FAIL +5.09 ms (+57%)** |
| Golden Gate deck (4 rounds) | 7.01 | 6.38 | fail +0.63 ms (+10%) |
| Embarcadero street (6 rounds) | 9.64 | 9.62 | tie |
| Golden Gate deck **@ pixelRatio 2** | 27.54 | 30.50 | pass −2.97 ms (−10%) |

It passes in exactly one regime — pixelRatio 2, which is 4× the shipping
fragment load and not what this app renders. Two independent meadow sessions
agree within 0.43 ms, and throughput, latency and the pixelRatio-2 run all rank
the same way.

**The failure is structural, not a tuning miss** — see §8.3. Whole-chain cost at
matched resolution (full@1.0 − bypass@1.0): meadow **8.17 ms**, Ocean Beach
**7.81**, Golden Gate **4.41**, street **5.16**.

Per-stage, measured at pixelRatio 2 and divided by 4, against the §9.2 budget.
Golden Gate and FiDi are the credible columns (round-to-round spread 1.5–2%):

| stage | budget | GG deck | FiDi | verdict |
|---|---|---|---|---|
| velocity | 0.20 | 0.147 | 0.188 | within |
| **SSAO** | 0.45 | **0.817** | **1.291** | **OVER, 1.8–2.9×** |
| **SSR (dry)** | 0.10 | **0.287** | **0.274** | **OVER, 2.7–2.9×** |
| composite | 0.25 | 0.228 | 0.208 | within |
| temporal (TAAU) | 1.20 | 1.217 | 1.119 | at budget |
| **DOF** (ships off) | 2.00 | **3.635** | **3.240** | **OVER, 1.6–1.8×** |
| bloom | 0.80 | 0.690 | 0.604 | within |
| **display tail** | 0.40 | **≥0.538** | **≥0.542** | **OVER**, and a floor |
| **total, DOF off** | **≈3.6** | **3.92** | **4.23** | over, and incomplete |

The totals are **floors**: the g-buffer attachment, the grade transform and the
tail's own blit are not separately ablatable and are missing from them.

**What this was evidence for**, and it is what the closing pass acted on: the
chain cost 4–8 ms at 1512×982 on the target machine, `scale` is not the lever
that can pay for it, and the two stages furthest over budget (SSAO at 1.8–2.9×,
SSR at 2.7–2.9× on frames whose mask is provably all zero) are where the next
millisecond actually was. Both were taken; see the top of this section.

</details>

**One thing that was tried and did NOT pay, recorded so it is not re-derived.**
With TAAU running the whole governor ladder rides `temporalScale`, so the drawing
buffer never shrinks and the ladder has no lever over the ~54% of the chain that
runs at output resolution. Splitting the ladder — put a share `r` on the drawing
buffer and divide the internal scale by it, so the beauty pass lands on an
*identical* pixel count while the tail shrinks by `r²` — predicts ~0.5–0.6 ms
back at L4. Measured directly, both halves round-robin in one session with the
beauty pass at the same 815 px wide either way:

| stop | ladder on internal only | split, r = 0.85 |
|---|---|---|
| downtown FiDi | 4.728 ms | 4.990 ms (**0.26 slower**) |
| Ocean Beach | 8.657 ms | 8.627 ms (a wash) |
| botanical meadow | 10.443 ms | 10.317 ms (0.13 faster) |

FiDi has the largest output-resolution share, i.e. the biggest predicted saving,
and it is where the split lost. Net: noise, for a softer presented image at the
two rungs that already give up hero shadows, contact shadows, FFT and foliage.
Reverted; the arithmetic and the numbers are in `adaptiveResolution.ts` on
`computeEffects`.

**Method notes that changed what was measured with**, worth keeping before
anyone re-baselines:
- **Per-pass GPU timestamps exist on this backend and are unusable as costs.**
  `WebGPUTimestampQueryPool.timestamps` can be read per pass, and it disagreed
  with the wall clock: the sum was 12.52 ms against a 7.83 ms sustained frame,
  and the display tail alone reported **4.27 ms when it directly followed the
  beauty pass and 0.36 ms when eleven passes separated them**. Apple's tiler
  overlaps the next pass's vertex stage with the previous pass's fragment drain
  and `MTLCounterSamplingPointAtStageBoundary` reports both windows in full.
  They describe structure, not cost, and **must never be summed**.
- **Ticks that render nothing poison medians.** `pipeline.render()` early-returns
  while the compile gate holds, in ~0.1 ms, indistinguishable from a fast frame —
  13 of 60 ticks in one block. The city keeps issuing `compileAsync` at a
  "settled" stop (41 calls over 40 samples at the Golden Gate deck), so this is
  not a transient. Count frames through a hook on `chain.render`.
- **The Embarcadero pier stop in §9.4 faces inland**, at an empty street with no
  water in frame. Ocean Beach `{x: -6180, z: 3200, facing: π/2}` was substituted
  as the water stop and the pier numbers are relabelled as a city street.
  Whoever owns §9.4 should re-derive that heading.

---

## 9. What is deliberately not done

- **No motion blur.** Once velocity exists, per-object motion blur is nearly free
  and three ships `MotionBlur.js`. It is not in the chain because reprojection
  velocity is camera-only (§7), so a motion blur built on it would smear the
  *background* correctly and leave moving objects sharp — precisely backwards.
  It becomes worth doing if and when the MRT velocity path is upgraded.
- **No denoiser.** `DenoiseNode`, `TemporalReprojectNode` and
  `RecurrentDenoiseNode` are all out of scope. The temporal resolve *is* the
  denoiser for AO and SSR, which is the entire reason the resolve sits downstream
  of them (resolving first and compositing noisy effects onto a resolved image
  means the noise never gets temporally integrated and each effect needs its own).
  The cost is §8.5's speckle when temporal is off.
- **No environment fallback for SSR.** `ImportanceSampledEnvironment` is not
  vendored and `environmentNode` is `null` by design, which is exactly why SSR
  cannot supply sky (§8.2).
- **No runtime MSAA, and `setCinematicMultisampling` is a logged no-op.** Raising
  `samples` on the beauty pass multisamples its **depth** attachment, and six
  consumers bind that depth as an ordinary non-multisampled texture — the contact
  complement, the composite's underwater package, SSAO, SSR, velocity, the
  temporal resolve. WebGPU rejects the bind group and the whole frame drops to
  clear colour. TRAA/TAAU require MSAA off outright anyway. Interior pockets buy
  coverage with **resolution** instead (`render/pocketQuality.ts`), which costs
  only fragment work and leaves every depth consumer's format untouched.
- **No ACES as the pipeline tonemapper.** It exists as `ACES (legacy)`, a look, an
  A/B reference, and nothing else. See §6.3.
- **No auto-exposure.** If one is ever added it must go inside `grade.toDisplay`,
  where exposure already lives, or bloom's pre-exposure threshold silently changes
  meaning.
- **No stage variants, no style-mask matrix, no `warmupPostFx`.** Every stage's
  quad compiles once, unconditionally, at boot scope; after that no toggle can
  create a pipeline at runtime.
- **The `min()` vs `multiply` occlusion A/B is untested in practice**, because no
  stop yet measured has both occlusion systems active on the same pixels (§6.6).
  `min` ships because it is the option that cannot stack, not because it won a
  comparison.

---

## 10. Measurement note

Unchanged from the candidate version, and it earned its keep twice during this
build: **do not accept probe numbers for any of this without looking at pixels.**
The probe harness has a documented history of reporting improvements that were
frame-drops (`PERF_LEVELUP.md` Wave 7), and every stage in this chain can fail in
a way that reads as "faster". Compare stills at matched camera poses.

Two harness hazards specific to this chain, both discovered the expensive way:

- **`await sf.pipeline.applyPostStructure()` inside a single `page.evaluate`
  deadlocks under manual ticking.** The promise needs presented frames and no
  frame can be driven while the evaluate is suspended. It hung one probe for 22
  minutes with no output and no error. Fire it un-awaited, set a flag in
  `.then()`, then tick until the flag flips.
- **A tick that does not present leaves `state()` reporting the previous frame.**
  `state()` is a pure read of the last *presented* frame, and the compile gate
  holds frames, so "chain state advanced without incrementing draw calls" at a
  batch boundary after a real await is the documented semantics, not a fault.
