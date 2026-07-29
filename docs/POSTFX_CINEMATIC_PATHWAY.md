# Candidate post-processing pathway: "cinematic chain"

Saved 2026-07-29 as a **candidate selectable look-and-quality mode**, not a
proposal to replace the live pipeline. Nothing here is implemented yet.

## The proposed chain, as authored

> TAA → SSAO → screen-space reflections on wet and icy surfaces only → very
> restrained depth of field → restrained bloom → ACES or AgX tonemapping →
> subtle film grain → post-TAA sharpening.

## Verdict

Sound as a cinematic-mode chain. Six of the eight stages are the right stages in
roughly the right places, and the two adjustments below are ordering/scope
issues, not taste disagreements. It is **not** viable as the live-play default on
the fanless M5 Air target — two of our benchmark stops (botanical meadow, ocean
pier) are already GPU-bound on grass and water, and this adds four fullscreen
screen-space passes to exactly the frames with no headroom. See
`PERF_LEVELUP.md` for the measured baseline.

The interesting part is that the temporal stage can pay for the rest of the
chain if it is built as an **upsampler** rather than as pure anti-aliasing. That
is the whole performance argument, and it is in "Making it real-time" below.

### Adjustment 1 — TAA goes after the screen-space effects, not before

SSAO and SSR are noisy, stochastic, half-resolution effects. Their single
biggest quality lever is having a temporal filter downstream of them. Resolving
TAA first and then compositing AO/SSR on the resolved image means the noise
never gets temporally integrated and each effect needs its own denoiser.

Corrected order:

```
jittered beauty pass (+ depth, normals, velocity)
  → SSAO            (half res, on the jittered G-buffer)
  → SSR             (half res, masked)
  → temporal resolve (TAA / TAAU)      ← cleans up AO + SSR noise for free
  → depth of field   (linear HDR)
  → bloom            (linear HDR)
  → display transform (grade LUT)
  → film grain        (display space)
  → sharpen           (display space, RCAS-style)
```

Everything after the resolve is already correct in the original: DOF and bloom
belong in linear HDR before the curve; grain and sharpen belong after it. Grain
in particular must stay downstream of the temporal pass — grain upstream of TAA
gets smeared into a moving stain.

### Adjustment 2 — the tonemapping step is the one regression

We deliberately moved off ACES. `src/render/gradeLooks.ts:18` records why:
three's ACES is the Narkowicz/Hill per-channel fit through AP1, which
desaturates and hue-twists exactly the bright saturated sky this world is built
around — an SF sunset renders as a near-achromatic blob. The current display
transform is a family of authored looks (`golden state`, `clear eye`,
`slide film`, `silver`, `reverie`, plus `ACES (legacy)` kept only for
comparison), baked to a 3D LUT in `src/render/grade.ts` and sampled at the one
scene-linear → display seam in `src/render/postfx.ts`.

So: **AgX is worth having, as a look, not as a pipeline stage.** Adding it costs
one entry in `gradeLooks.ts` and zero per-pixel work — every look is the same
single trilinear fetch, and switching looks rebinds nothing and recompiles
nothing. AgX's per-channel behavior is genuinely better than ACES on saturated
skies, so it is a real candidate for the cinematic default. Re-specifying ACES
as the mode's tonemapper would undo a deliberate, documented fix.

## What already exists (and what the chain would collide with)

| Chain stage | Status here |
| --- | --- |
| TAA | **Missing.** Live play is single-sample. Runtime MSAA is known-broken (`pipeline.ts:163` — raising `samples` multisamples the shared depth attachment, and the contact-shadow and underwater passes bind that depth as non-multisampled; the frame drops to clear colour). Only optional FXAA exists, plus 4× MSAA for offline capture and higher render scale for interior pockets (`pocketQuality.ts`). TAA is therefore the *right* AA for this project. |
| SSAO | **Partly present, and it overlaps.** `contactShadows.ts` is a half-res six-tap screen-space contact-shadow complement keyed to the sun direction. A full GTAO on top would double-darken contacts. Reconcile: contact shadows stay on the direct-sun term, AO applies to the ambient term only (or GTAO with bent normals replaces both). |
| SSR, wet/icy only | **No mask signal exists.** No wetness/roughness channel is authored anywhere; the only genuinely wet surfaces today are the ocean (which uses an analytic sky reflection in `waterShadingTSL.ts` — no render target, no PMREM) and shorebreak wet sand. The "wet-only" gate is the smartest idea in the chain, but it needs a new authored mask before it can gate anything. |
| DOF | **Missing** as a camera effect. Not worth much during first-person play; genuinely valuable for `src/cinematic/` shots. |
| Bloom | **Present and already restrained.** Linear HDR, pre-curve, `rtt`-wrapped, threshold measured at 2.2 so lit white geometry is left alone and only real emitters bleed (`postfx.ts:59`). This stage is done. |
| Tonemapping | **Present, better than proposed.** See Adjustment 2. |
| Film grain | Present only inside the `dream haze` style. Wants extraction as an independent display-space stage. |
| Sharpen | **Missing.** Cheapest win in the chain, and the natural partner to a temporal resolve. |

## Two integration landmines, both verified in `three@0.185.1`

**1. Reversed depth.** We render with `reversedDepthBuffer: true`
(`app/renderCore.ts:48`). Of the stock nodes, only `TRAANode` accounts for it
(`TRAANode.js:466`). `TAAUNode`, `GTAONode`, `SSRNode` and `DepthOfFieldNode`
contain no reversed-depth handling at all — each will read depth inverted and
fail in the plausible-looking way (AO inside-out, reflections tracing away from
the camera, focus plane mirrored). Budget a depth-convention fix-up per node.
This is the same class of trap as ground decals needing *positive* polygonOffset
under reversed depth.

**2. Velocity is rigid-body only.** Both temporal nodes require a velocity
buffer, which means adding a `velocity` MRT output to the beauty pass. Three's
`velocity` node transforms `positionPrevious`, which is
`positionGeometry.toVarying(...)` — the *undeformed* attribute
(`three/src/nodes/accessors/Position.js:54`). Every vertex-displaced surface in
this world — FFT ocean, grass blades, foliage wind, kite cloth, wake — would
report the velocity of its rigid transform and ghost under temporal
accumulation. This is the largest hidden cost of adopting TAA here, and it is
per-material work, not a pipeline switch. Water and grass are also precisely
where a temporal resolve helps most, so they cannot be waived.

Secondary: adding the velocity attachment changes the beauty pass's attachment
layout, which is worth a hard look given the depth-consumer breakage MSAA
already caused, and given that tiles/citygen/traffic cache WebGPU command
bundles.

## Making it real-time

The chain as written is a cost. Restructured, most of it is free.

**1. Temporal upsampling, not temporal anti-aliasing.** Use `TAAUNode` (r185
ships it) instead of `TRAANode`: render the beauty pass at 0.6–0.7 scale and let
the 9-tap Blackman-Harris resolve reconstruct at output resolution. The
adaptive-resolution governor already drops to 0.8× and 0.7× under load
(`adaptiveResolution.ts`) and today that just looks blurrier — routing those
levels through a temporal upsample turns the existing degradation ladder into a
quality feature. At 0.7 scale you render 49% of the pixels, which comfortably
funds AO + SSR + DOF + sharpen and can come out ahead of today's frame.
Caveat: `TAAUNode` has no reversed-depth handling (landmine 1) and needs
verifying against the FFT ocean before it can be trusted on the pier.

**2. Everything screen-space runs at half res, none of it full.** AO and SSR at
half res with a depth-aware upsample (`depthAwareBlend.js`, `BilateralBlurNode`,
`DenoiseNode` all ship in r185). DOF gather at half res. This is already how
contact shadows and the piano god rays are built here, so it matches house
style.

**3. SSR earns its keep only if the mask is tight.** Author a wet/reflective
mask channel and trace only masked pixels, with a low ray budget and a hard
screen-space step cap. On a dry sunny SF afternoon the mask is nearly empty and
the pass costs almost nothing; after rain it costs where it shows. If the mask
stays empty in practice, cut the stage — an unmasked full-screen SSR on the
water is strictly worse than the analytic sky reflection already in
`waterShadingTSL.ts`.

**4. Sharpen is ~free.** A single RCAS-style pass in display space, or fold it
into the existing final FXAA pipeline slot.

**5. DOF: cinematic-only.** Gate it to `src/cinematic/` shots and photo mode.
Restrained DOF at play FOV is mostly invisible and always costs.

**6. Structure it as one mode, not eight toggles.** `postfx.ts` caches eight
style-mask variants × two bloom families. Adding four independent toggles
multiplies that matrix and each new combination is a fresh TSL codegen window —
and long compile windows hold presented frames (`pipeline.ts:74`). Ship the
chain as a single `film` quality mode with one variant family, compiled through
the stillness-gated lane, and through the **priority** compile lane if a
cinematic arrival ever waits on it.

**7. Consider adding motion blur.** Conspicuously absent, and once velocity
exists for the temporal pass, per-object motion blur is nearly free
(`MotionBlur.js` ships in r185). For a *filmic* mode it buys more than the DOF
does.

## Suggested staged adoption

Each stage is independently shippable and independently revertable.

1. **AgX as a grade look.** Hours, not days. Zero runtime cost, zero pipeline
   risk, immediate visible payoff. Do this first regardless of the rest.
2. **Sharpen stage + grain extracted from `dream haze`.** Cheap, display-space,
   no depth or velocity involvement.
3. **Velocity MRT + `TAAU` at 0.7 scale.** The real project. Fix reversed depth
   in the node; fix vertex-animated velocity per material family (ocean, grass,
   foliage, cloth); verify at the pier and the meadow, which are the two
   GPU-bound stops and the two worst ghosting candidates. Gate behind a mode
   until it holds up.
4. **GTAO on the ambient term**, reconciled against contact shadows so contacts
   don't double-darken.
5. **DOF, cinematic-only.**
6. **SSR last**, and only after a wet/ice mask actually exists in materials.

## Measurement note

Do not accept probe numbers for any of this without looking at pixels — the
probe harness has a documented history of reporting improvements that were
frame-drops, and every stage in this chain can fail in a way that reads as
"faster". Compare stills at matched camera poses, at both the meadow and the
pier, before and after.
