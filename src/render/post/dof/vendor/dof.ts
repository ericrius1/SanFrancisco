/**
 * VENDORED FORK
 *
 *   upstream: node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js
 *   three:    0.185.1
 *   original: Vogel-disc bokeh gather (pixelmischief, "Bokeh Depth of Field")
 *             with the near/far split of the DOOM 2016 study.
 *
 * Nine fullscreen passes and, at the default half-resolution blur chain, ~160
 * taps per output pixel. By a wide margin the most expensive stage in this
 * chain, which is why `DOF_TUNING.enabled` ships false.
 *
 * REVERSED DEPTH: nothing to do, and that is worth stating rather than assuming.
 * This pass never touches raw depth. It consumes a viewZ node, and the only
 * producer of one — `perspectiveDepthToViewZ` — is genuinely reversed-aware
 * (ViewportDepthNode.js:229; `PassNode.getViewZNode()` at PassNode.js:695-706
 * routes through it). Do not add an `oneMinus()` anywhere in here, and do not
 * introduce a `viewZ -> depth` conversion: those helpers are NOT reversed-aware
 * (ViewportDepthNode.js:203, :153) and mixing the two spaces is the failure
 * shared/reversedDepth.ts warns about.
 *
 * ---------------------------------------------------------------------------
 * DEVIATIONS FROM UPSTREAM, and why:
 *
 * 1. NOT A NODE (upstream: `class DepthOfFieldNode extends TempNode`,
 *    `updateBeforeType = NodeUpdateType.FRAME` at DepthOfFieldNode.js:224).
 *    Same call as `ssao/vendor/gtao.ts` and `../../bloom/vendor/bloom.ts`, and
 *    for the same measured reason: `Renderer.js:3778` fires `updateBefore` from
 *    inside `renderObject()`, i.e. while a render pass is open, and nine nested
 *    fullscreen draws from there make WebGPU reject the whole command buffer
 *    (contactShadows.ts:326-345 — ~70% of captures across one ten-second shot).
 *    The materials are built eagerly in the constructor instead of in
 *    `setup( builder )`, so `warmup.ts` can compile every quad before the first
 *    presented frame; `.context( builder.getSharedContext() )` goes with the
 *    builder, since it only strips a consumer builder's material-scoped context
 *    off a graph born inside it (NodeBuilder.js:1092-1104).
 *
 *    The NESTED `GaussianBlurNode` (upstream:381) had the same problem one level
 *    deeper — it would have rendered its two passes from inside the CoC-blur
 *    pass. It is forked alongside, in ./gaussianBlur.ts, and driven explicitly
 *    from `render()` below.
 *
 * 2. `resolutionScale`, WHICH STOCK HAS NO KNOB FOR. Upstream's `setSize` (:234)
 *    is called from `updateBefore` with the input texture's own
 *    `image.width/height` (:275-276) and hardcodes the blur chain at half of it
 *    (:243-244). Here the caller passes the size and `resolutionScale` replaces
 *    that hardcoded 0.5, so `resolutionScale = 0.5` is bit-for-bit upstream's
 *    layout and `0.25` / `1.0` are the cheaper and sharper ends.
 *
 *    `_invSize` deliberately stays at 1 / (FULL size) rather than tracking the
 *    blur targets. It scales the gather step in UV, so pinning it to the full
 *    size makes the bokeh's angular diameter invariant to `resolutionScale` — a
 *    resolution knob that also changed the look would be a bad knob.
 *
 *    The CoC pass and the composite stay at full size. The composite writes the
 *    WHOLE image, in-focus regions included, so scaling it would throw away the
 *    temporal resolve's upsample for the 95% of the frame that is sharp.
 *
 * 3. THE `_CoCTextureNode` ALIAS IS PRESERVED EXACTLY (upstream:294, :303, :319).
 *    One texture node is rebound three times per frame so the near and far
 *    fields can share the blur64/blur16 materials. It is not tidiness debt: undo
 *    it and the two fields cross-contaminate. All three aliases are r16float
 *    with the same filter, so every rebind is a binding update rather than a
 *    codegen (Bindings.js compares generations; shared/textureSlot.ts:14-23).
 *
 *    The composite needs the far CoC as well, and takes it through its OWN
 *    `#farCoc` node rather than reading the alias's final value. Depending on
 *    where a rebinding node happens to be pointing at the end of a sequence is
 *    exactly the fragility the paragraph above is about.
 *
 * 4. THE NEAR-FIELD BLEND TODO (upstream:453-459) IS FIXED. See `#buildBlur64`
 *    and `#buildComposite` for the full argument; in short, upstream's
 *    `min( CoC, 0.5 ) * 2` is a stand-in for a coverage term it never computes,
 *    and the artifact it apologises for is the classic foreground halo.
 *
 * ---------------------------------------------------------------------------
 * KNOWN AND DELIBERATELY NOT CHANGED: THE FAR FIELD GETS BRIGHTER.
 *
 * Browser measurement, this stage isolated at the Golden Gate deck: the frame
 * changes by 2.67 over 18.7% of pixels, and the band-limited direction is WRONG
 * at large scale — sky +14.89 luma, water +5.15/+4.41, near deck +0.02. The
 * out-of-focus background gains about 10%.
 *
 * MECHANISM, and it is not the near-field halo above. `#buildBlur16` is a 16-tap
 * MAX filter, and `#buildComposite` blends the far field by the pixel's OWN far
 * CoC — which saturates at 1 across a distant background. So for every fully
 * defocused pixel the composite does not blend toward the 64-tap weighted
 * AVERAGE; it replaces the pixel outright with the LOCAL MAXIMUM of that average
 * over a disc. A max filter is >= the mean on every non-constant field, with
 * equality only where the field is flat, so a smooth bright sky can only get
 * brighter, everywhere, by roughly (gradient x disc radius).
 *
 * That is upstream's bokeh model, not a slip in this fork: the max pass is what
 * makes a bright point expand into a disc instead of dissolving, and upstream
 * maxes both fields for the same reason. Replacing it for the far field (or
 * gating it on a highlight threshold) is a decision about what defocus should
 * LOOK like, and this stage ships disabled (`post.dof.enabled: false`), so it
 * cannot reach a frame. Diagnosed here rather than changed, because a repair pass
 * silently redesigning the bokeh of a stage nobody has art-directed is worse than
 * a stage with a known, located, written-down behaviour.
 *
 * The near field does not have this problem for a structural reason worth
 * keeping: it blends by COVERAGE, which `#buildBlur64` actually computes.
 */
import * as THREE from "three/webgpu"
import {
  Fn,
  Loop,
  float,
  max,
  mix,
  outputStruct,
  property,
  smoothstep,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  vec3,
  vec4
} from "three/tsl"
import { createStageQuad, type StageQuad } from "../../shared/fullscreen"
import type { N } from "../../types"
import { GaussianBlurPass } from "./gaussianBlur"

/** Upstream:483-484. Vogel disc, 80 points split 64 / 16. */
const GOLDEN_ANGLE = 2.39996323
const KERNEL_SAMPLES = 80

function generateKernels(): { points64: THREE.Vector2[]; points16: THREE.Vector2[] } {
  const points64: THREE.Vector2[] = []
  const points16: THREE.Vector2[] = []
  for (let i = 0; i < KERNEL_SAMPLES; i++) {
    const theta = i * GOLDEN_ANGLE
    const r = Math.sqrt(i) / Math.sqrt(KERNEL_SAMPLES)
    const p = new THREE.Vector2(r * Math.cos(theta), r * Math.sin(theta))
    if (i % 5 === 0) points16.push(p)
    else points64.push(p)
  }
  return { points64, points16 }
}

function makeTarget(
  name: string,
  options: THREE.RenderTargetOptions = {}
): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    ...options
  })
  // Underscores only — a dot in a texture name is a WGSL parse error on some
  // codegen paths (pianoGodRays.ts:112-118), and upstream's names all have one.
  target.texture.name = name
  for (let i = 1; i < target.textures.length; i++) target.textures[i].name = `${name}_${i}`
  return target
}

export type DofPassOptions = {
  /** The chain colour, at OUTPUT resolution. A texture node. */
  readonly source: N
  /**
   * View-space Z, negative in front of the camera. Reversed-depth-safe by
   * construction — see the header.
   *
   * NOTE ON RESOLUTION: depth lives at INPUT resolution (the beauty pass) while
   * this stage runs at OUTPUT resolution, so every viewZ tap here is a bilinear
   * read of a lower-resolution buffer. That is fine and deliberate: the circle
   * of confusion is a low-frequency field, and the CoC pass's own output is
   * immediately dilated by a gaussian anyway. Do NOT add a depth upsample pass
   * for this.
   */
  readonly viewZ: N
  /** Metres along the camera's look direction. */
  readonly focusDistance: N
  /** Metres from the focal plane to full defocus. Small = dramatic. */
  readonly focalLength: N
  /** Unitless artistic multiplier on the gather radius. */
  readonly bokehScale: N
}

export class DofPass {
  readonly #coc: THREE.RenderTarget
  readonly #cocBlurred: THREE.RenderTarget
  readonly #blur64: THREE.RenderTarget
  readonly #blur16Near: THREE.RenderTarget
  readonly #blur16Far: THREE.RenderTarget
  readonly #composite: THREE.RenderTarget

  /** THE ALIAS. Rebound three times per `render()` — deviation 3. */
  readonly #cocTexture: N
  readonly #farCoc: N
  readonly #blur64Texture: N
  readonly #blur16NearTexture: N
  readonly #blur16FarTexture: N

  readonly #cocBlur: GaussianBlurPass
  readonly #invSize: N = uniform(new THREE.Vector2(1, 1))

  readonly #cocQuad: StageQuad
  readonly #cocBlurredQuad: StageQuad
  readonly #blur64Quad: StageQuad
  readonly #blur16Quad: StageQuad
  readonly #compositeQuad: StageQuad

  #resolutionScale = 0.5
  #disposed = false

  constructor(options: DofPassOptions) {
    // Two attachments, one pass: near field in [0], far field in [1]
    // (upstream:88-90).
    this.#coc = makeTarget("dof_coc", { format: THREE.RedFormat, count: 2 })
    this.#cocBlurred = makeTarget("dof_coc_blurred", { format: THREE.RedFormat })
    this.#blur64 = makeTarget("dof_blur64")
    this.#blur16Near = makeTarget("dof_blur16_near")
    this.#blur16Far = makeTarget("dof_blur16_far")
    this.#composite = makeTarget("dof_composite")

    this.#cocTexture = texture(this.#coc.textures[0]) as N
    this.#cocTexture.name = "dof_coc_alias"
    this.#farCoc = texture(this.#coc.textures[1]) as N
    this.#farCoc.name = "dof_coc_far"
    this.#blur64Texture = texture(this.#blur64.texture) as N
    this.#blur16NearTexture = texture(this.#blur16Near.texture) as N
    this.#blur16FarTexture = texture(this.#blur16Far.texture) as N

    // sigma 2 -> a 7-tap kernel per direction (upstream:381).
    this.#cocBlur = new GaussianBlurPass({
      name: "dof_coc_blur",
      source: this.#cocTexture,
      sigma: 2
    })

    const kernels = generateKernels()
    this.#cocQuad = this.#buildCoC(options)
    this.#cocBlurredQuad = this.#buildCoCBlurred()
    this.#blur64Quad = this.#buildBlur64(options, kernels.points64)
    this.#blur16Quad = this.#buildBlur16(options, kernels.points16)
    this.#compositeQuad = this.#buildComposite(options)
  }

  /**
   * Upstream:363-377. Signed distance to the focal plane, split into the two
   * attachments by its sign.
   *
   * This is the one material in the file that uses `colorNode` + `outputNode`
   * rather than `fragmentNode`, and it has to: `outputNode` is only honoured
   * when `fragmentNode === null` (NodeMaterial.js:522-547), and the two
   * `property()` writes below are side effects that need somewhere in the flow
   * to happen. Setting `fragmentNode` here would silently drop the second
   * attachment.
   */
  #buildCoC(options: DofPassOptions): StageQuad {
    const quad = createStageQuad("dof_coc")
    const nearField = property("float") as N
    const farField = property("float") as N
    const material = quad.material as N

    material.colorNode = Fn(() => {
      // viewZ is negative in front of the camera; negate to get distance.
      // Positive signedDist = behind the focal plane (far field).
      const signedDist = options.viewZ.negate().sub(options.focusDistance)
      const coc = smoothstep(0, options.focalLength, signedDist.abs())
      nearField.assign(step(signedDist, 0).mul(coc))
      farField.assign(step(0, signedDist).mul(coc))
      return float(0)
    })()
    material.outputNode = outputStruct(nearField, farField)
    material.needsUpdate = true
    return quad
  }

  /**
   * Upstream:381-382. Dilates the NEAR CoC so the foreground has coverage
   * outside its own silhouette — without this the near field can only ever be
   * gathered where the object already is, and it cannot spread over the
   * background at all.
   *
   * Upstream expressed this as `colorNode = gaussianBlur( … )`, which made the
   * blur a nested node. Here the blur is driven explicitly one line earlier in
   * `render()` and this pass is the downsampling copy of its result into the
   * blur chain's working resolution — which is what upstream's `_CoCBlurredRT`
   * always was, since its gaussian ran at the full CoC resolution.
   */
  #buildCoCBlurred(): StageQuad {
    const quad = createStageQuad("dof_coc_blurred")
    const blurred = texture(this.#cocBlur.texture) as N
    quad.setFragment(Fn(() => vec4(blurred.sample(uv()).r, 0, 0, 1))())
    return quad
  }

  /**
   * Upstream:388-412, with the premultiplied gather that fixes the TODO at
   * :453-459.
   *
   * WHAT UPSTREAM DOES: averages 64 unweighted taps of the beauty texture over a
   * disc whose radius is the CENTRE pixel's CoC, and carries that centre CoC out
   * as alpha. The composite then blends with `min( CoC, 0.5 ) * 2`, and the
   * comment there admits the result: "blending issues around edges of blurred
   * foreground objects when they are rendered above the background". That is the
   * classic foreground halo, and it is structural — an unweighted average has no
   * idea which of its taps belong to the foreground, and a centre-pixel CoC is
   * not a coverage term no matter what curve is fitted to it.
   *
   * WHAT THIS DOES: weights every tap by that tap's own CoC and accumulates the
   * weight. The result is a genuine premultiplied layer —
   *
   *     coverage = mean( CoC(q) )                    over the disc
   *     colour   = sum( C(q) * CoC(q) ) / sum( CoC(q) )
   *
   * — so `coverage` is how much of this pixel the out-of-focus field actually
   * covers, and `colour` is that field's colour with in-focus taps excluded
   * instead of averaged in. The composite can then blend with `coverage`
   * directly and the `* 2` fudge disappears.
   *
   * The near path reaches outside the silhouette because its CoC input is the
   * DILATED one from `#buildCoCBlurred`; the far path uses the raw far CoC,
   * where the same weighting is what stops an in-focus foreground from being
   * smeared into the background blur.
   *
   * COST: 64 extra single-channel taps per pixel on top of upstream's 64 RGBA
   * taps, in the blur chain's resolution. Unmeasured — this stage is off by
   * default and there is no browser in this wave — but it is the cheap half of
   * the pass, and the artifact it removes is the reason DOF looked wrong.
   */
  #buildBlur64(options: DofPassOptions, points: THREE.Vector2[]): StageQuad {
    const quad = createStageQuad("dof_blur64")
    const bokeh = uniformArray(points) as N
    const cocTexture = this.#cocTexture
    const invSize = this.#invSize

    quad.setFragment(
      Fn(() => {
        const uvNode = uv()
        const coc = cocTexture.sample(uvNode).r.toVar()
        const sampleStep = invSize.mul(options.bokehScale).mul(coc)

        const acc = vec3(0).toVar()
        const coverage = float(0).toVar()

        Loop(64, ({ i }: N) => {
          const sUV = uvNode.add(sampleStep.mul(bokeh.element(i)))
          const w = cocTexture.sample(sUV).r
          acc.addAssign(options.source.sample(sUV).rgb.mul(w))
          coverage.addAssign(w)
        })

        // Unpremultiply for storage so the max filter downstream compares
        // colours rather than colour-times-coverage. `max(1e-4)` is the fully
        // in-focus case, where acc is exactly zero and coverage is too — the
        // composite discards it on coverage anyway.
        return vec4(acc.div(coverage.max(1e-4)), coverage.div(64))
      })()
    )
    return quad
  }

  /**
   * Upstream:418-438, unchanged apart from what alpha now means. A 16-tap MAX
   * filter: bokeh is defined by bright samples expanding over dark ones, and a
   * second averaging pass would just wash the discs out.
   *
   * The gather radius keys off the incoming coverage rather than upstream's
   * centre CoC. They are the same quantity to within the disc average, and using
   * coverage keeps the expansion consistent with what the composite blends by.
   */
  #buildBlur16(options: DofPassOptions, points: THREE.Vector2[]): StageQuad {
    const quad = createStageQuad("dof_blur16")
    const bokeh = uniformArray(points) as N
    const blur64Texture = this.#blur64Texture
    const invSize = this.#invSize

    quad.setFragment(
      Fn(() => {
        const uvNode = uv()
        // `.toVar()` first: `col` is read twice below, and an un-var'd texture
        // node emits a second fetch per read.
        const col = blur64Texture.sample(uvNode).toVar()
        const coverage = col.a.toVar()
        const maxVal = col.rgb.toVar()
        const sampleStep = invSize.mul(options.bokehScale).mul(coverage)

        Loop(16, ({ i }: N) => {
          const sUV = uvNode.add(sampleStep.mul(bokeh.element(i)))
          maxVal.assign(max(blur64Texture.sample(sUV).rgb, maxVal))
        })

        return vec4(maxVal, coverage)
      })()
    )
    return quad
  }

  /**
   * Upstream:445-467, with the TODO resolved.
   *
   * The two fields are asymmetric and upstream blended them symmetrically, which
   * is half of why the `* 2` fudge was needed:
   *
   *  - THE FAR FIELD IS BEHIND. Whether a pixel is blurred is a property of THAT
   *    PIXEL, so its blend weight is its own far CoC, read straight from the CoC
   *    attachment. No coverage term, no clamping curve.
   *  - THE NEAR FIELD IS IN FRONT. It is a semi-transparent layer scattered over
   *    whatever is behind it, so its blend weight is COVERAGE — how much of this
   *    pixel the defocused foreground actually occupies — which is exactly what
   *    `#buildBlur64` now accumulates.
   *
   * `#farCoc` is its own texture node rather than the three-times-rebound alias,
   * even though the alias happens to be pointing at the same attachment by the
   * time this pass runs. Reading a rebinding node's terminal value is the
   * fragility the alias comment warns about.
   */
  #buildComposite(options: DofPassOptions): StageQuad {
    const quad = createStageQuad("dof_composite")
    const near = this.#blur16NearTexture
    const far = this.#blur16FarTexture
    const farCoc = this.#farCoc

    quad.setFragment(
      Fn(() => {
        const uvNode = uv()
        // `.toVar()` on the near tap: both its rgb and its coverage are read.
        const nearTap = near.sample(uvNode).toVar()
        const farTap = far.sample(uvNode)
        const rgb = options.source.sample(uvNode).rgb.toVar()
        rgb.assign(mix(rgb, farTap.rgb, farCoc.sample(uvNode).r.saturate()))
        rgb.assign(mix(rgb, nearTap.rgb, nearTap.a.saturate()))
        return vec4(rgb, 1.0)
      })()
    )
    return quad
  }

  /** Stable across resizes — bind once. */
  get texture(): THREE.Texture {
    return this.#composite.texture
  }

  getResolutionScale(): number {
    return this.#resolutionScale
  }

  /** Structural: the caller must `setSize()` again afterwards. */
  setResolutionScale(scale: number): void {
    this.#resolutionScale = Math.max(0.05, Math.min(1, scale))
  }

  /** Upstream:234-251. `width`/`height` are the chain's OUTPUT size. */
  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))

    // Pinned to the FULL size on purpose — deviation 2.
    ;(this.#invSize.value as THREE.Vector2).set(1 / w, 1 / h)

    this.#coc.setSize(w, h)
    this.#composite.setSize(w, h)
    // The CoC dilation runs at the CoC's own resolution, as upstream's did
    // (it sized itself from `_CoCRT`), and `#buildCoCBlurred` downsamples.
    this.#cocBlur.setSize(w, h)

    const bw = Math.max(1, Math.round(w * this.#resolutionScale))
    const bh = Math.max(1, Math.round(h * this.#resolutionScale))
    this.#cocBlurred.setSize(bw, bh)
    this.#blur64.setSize(bw, bh)
    this.#blur16Near.setSize(bw, bh)
    this.#blur16Far.setSize(bw, bh)
  }

  /**
   * Upstream:269-344. Called ONLY by the stage, with no render pass open.
   *
   * Clear colour is transparent black throughout (upstream:282): every target
   * here is fully covered by its quad, so the clear only matters for the first
   * frame after a resize.
   */
  render(renderer: THREE.WebGPURenderer): void {
    if (this.#disposed) return

    // CoC -> [near, far]
    this.#cocQuad.render(renderer, this.#coc, 0x000000, 0)

    // Dilate the near field so it has coverage outside its silhouette.
    // ALIAS 1 of 3 (upstream:294).
    this.#cocTexture.value = this.#coc.textures[0]
    this.#cocBlur.render(renderer)
    this.#cocBlurredQuad.render(renderer, this.#cocBlurred, 0x000000, 0)

    // Near field. ALIAS 2 of 3 (upstream:303).
    this.#cocTexture.value = this.#cocBlurred.texture
    this.#blur64Quad.render(renderer, this.#blur64, 0x000000, 0)
    this.#blur16Quad.render(renderer, this.#blur16Near, 0x000000, 0)

    // Far field, same two materials. ALIAS 3 of 3 (upstream:319).
    this.#cocTexture.value = this.#coc.textures[1]
    this.#blur64Quad.render(renderer, this.#blur64, 0x000000, 0)
    this.#blur16Quad.render(renderer, this.#blur16Far, 0x000000, 0)

    this.#compositeQuad.render(renderer, this.#composite, 0x000000, 0)
  }

  /**
   * The quads it is SAFE to hand to `compileFullscreenQuads` at boot.
   *
   * THE CoC QUAD IS DELIBERATELY NOT IN THIS LIST. It is the only material in
   * the chain with two fragment outputs (`outputStruct`, upstream:361), and
   * `compileGate.ts`'s `compileFullscreenQuads` never binds a render target — it
   * compiles against whatever is ambient, which at boot is the canvas. Creating
   * a pipeline whose fragment stage writes @location(1) against a context with
   * one colour attachment is a WebGPU validation error, not a cache miss, and it
   * would take the whole boot down for a stage that ships disabled.
   *
   * The cost of leaving it out is one synchronous material build on the first
   * frame after somebody enables DOF. The alternative — packing near and far
   * into one RG target — would cost the `_CoCTextureNode` alias, which is the
   * one thing about this node the build order said to preserve exactly.
   *
   * Everything else here is a single-output vec4 material, which compiles
   * against any colour attachment.
   */
  quads(): THREE.QuadMesh[] {
    return [
      ...this.#cocBlur.quads(),
      this.#cocBlurredQuad.mesh,
      this.#blur64Quad.mesh,
      this.#blur16Quad.mesh,
      this.#compositeQuad.mesh
    ]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#coc.dispose()
    this.#cocBlurred.dispose()
    this.#blur64.dispose()
    this.#blur16Near.dispose()
    this.#blur16Far.dispose()
    this.#composite.dispose()
    this.#cocBlur.dispose()
    this.#cocQuad.dispose()
    this.#cocBlurredQuad.dispose()
    this.#blur64Quad.dispose()
    this.#blur16Quad.dispose()
    this.#compositeQuad.dispose()
  }
}
