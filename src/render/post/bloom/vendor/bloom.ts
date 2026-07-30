/**
 * VENDORED FORK
 *
 *   upstream: node_modules/three/examples/jsm/tsl/display/BloomNode.js
 *   three:    0.185.1
 *   original: UnrealBloomPass — a luminance high pass followed by five
 *             progressively halved separable-gaussian mips, recombined with
 *             per-mip weights.
 *
 * The blur kernel, the mip weights and the `lerpBloomFactor` mirror trick are
 * upstream's, unchanged. Everything that differs is listed here with the reason.
 *
 * ---------------------------------------------------------------------------
 * 1. NOT A NODE (upstream: `class BloomNode extends TempNode`,
 *    `updateBeforeType = NodeUpdateType.FRAME` at BloomNode.js:266).
 *
 *    The build order asked for `updateBeforeType = NodeUpdateType.NONE` plus a
 *    public `render( renderer )`; dropping the Node base class is the stronger
 *    form of the same instruction, and it is what `ssao/vendor/gtao.ts` already
 *    does in this chain. There is no `updateBeforeType` left to be wrong and no
 *    `setup()` a foreign NodeBuilder can reach.
 *
 *    Measured, not theoretical: `Renderer.js:3778` calls
 *    `this._nodes.updateBefore( renderObject )` from `renderObject()`, i.e.
 *    WHILE A RENDER PASS IS OPEN. A FRAME-scoped node reached from there renders
 *    its quads inside somebody else's pass and WebGPU rejects the whole command
 *    buffer — the frame comes out as bare clear colour. `contactShadows.ts:326-345`
 *    records the measurement: ~70% of captures across one ten-second shot, and
 *    once it starts it repeats every frame. Twelve nested quad draws (1 high pass
 *    + 10 blur + 1 composite) is the widest such surface in this chain.
 *
 *    `passTexture( this, … )` and `getTextureNode()` go with it. They exist to
 *    hand three's scheduler a handle on the producing node; the stage owns a
 *    plain `texture()` over `outputTexture` instead.
 *
 * 2. THE MATERIALS ARE BUILT EAGERLY, IN THE CONSTRUCTOR (upstream builds them
 *    in `setup( builder )`, BloomNode.js:400-464).
 *
 *    Two consequences, both wanted. First, `warmup.ts` can hand every quad to
 *    `compileFullscreenQuads` the moment the stage exists, so no toggle can open
 *    a codegen window on a presented frame. Second — and this is the upstream
 *    bug the build order named — `_separableBlurMaterials` is initialised in the
 *    constructor ONLY (BloomNode.js:201) while `setup()` PUSHES five more per
 *    NodeBuilder with no reset (:415-419), and `setSize` (:320-330) and
 *    `updateBefore` (:361-379) only ever index the first five. One instance
 *    reached by eight cached style variants therefore built forty materials and
 *    orphaned thirty-five. Here the five blur stages are built once, in the
 *    constructor, into a `readonly` array that nothing can push to a second
 *    time — the leak is not fixed so much as made unreachable. (The build order
 *    asked for `_separableBlurMaterials = []` at the top of `setup()`; that is
 *    the same fix expressed against upstream's lazy shape, and it is what this
 *    fork replaces rather than inherits.)
 *
 *    `.context( builder.getSharedContext() )` (:405, :456, :546) goes with the
 *    builder. It only strips a CONSUMER builder's material-scoped context
 *    overrides off a graph born inside it (NodeBuilder.js:1092-1104); a graph
 *    built with no builder has nothing to strip. `composite/index.ts` and
 *    `display/index.ts` already assign `material.fragmentNode` the same way.
 *
 * 3. `texture( null )` (:518) IS SEEDED WITH A REAL TEXTURE. Upstream can get
 *    away with a null placeholder because `updateBefore` assigns `.value` before
 *    the first draw; we compile at boot, before any draw, and codegen needs a
 *    bound texture. Every target in this file is `rgba16float` + LinearFilter,
 *    so the seed and every later `.value` share one WGSL sampler binding type —
 *    the hazard `shared/textureSlot.ts:18-23` documents.
 *
 * 4. SIZE COMES FROM THE CALLER, NOT `renderer.getDrawingBufferSize()` (:347-348).
 *    Bloom runs AFTER the temporal resolve, so its size is the chain's OUTPUT
 *    size, which the frame context already carries; asking the renderer would
 *    also re-derive it once per frame for no reason.
 *
 * 5. `smoothWidth` stays a uniform but is no longer public API, and the
 *    `highPassFn` extension point is dropped — there is exactly one caller.
 */
import * as THREE from "three/webgpu"
import {
  Fn,
  Loop,
  add,
  float,
  int,
  luminance,
  mix,
  smoothstep,
  texture,
  uniform,
  uniformArray,
  uv,
  vec4
} from "three/tsl"
import { createStageQuad, type StageQuad } from "../../shared/fullscreen"
import type { N } from "../../types"

/** Shared direction vectors, assigned to the blur uniform per pass (upstream:7-8). */
const BLUR_X = /*#__PURE__*/ new THREE.Vector2(1, 0)
const BLUR_Y = /*#__PURE__*/ new THREE.Vector2(0, 1)

const MIPS = 5

/**
 * Upstream:413. "These sizes have been changed to account for the altered
 * coefficients-calculation to avoid blockiness, while retaining the same
 * blur-strength" — three.js PR #31528. Kernel radii are in TEXELS OF THEIR OWN
 * MIP, so the reach of the whole chain in output pixels is inversely
 * proportional to `resolutionScale`. That is the one thing to know before
 * touching `BLOOM_TUNING.resolution`; see bloom/tuning.ts.
 */
const KERNEL_RADII = [6, 10, 14, 18, 22]

/** Upstream:423. Mip weights, mirrored around 1.2 by `radius`. */
const MIP_FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2]

export type BloomPassOptions = {
  /** Scene-linear HDR source. A TEXTURE node, never an expression — see index.ts. */
  readonly source: N
  readonly strength: N
  readonly radius: N
  readonly threshold: N
}

type BlurStage = {
  readonly quad: StageQuad
  readonly colorTexture: N
  readonly direction: N
  readonly invSize: N
}

function makeTarget(name: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.HalfFloatType,
    generateMipmaps: false
  })
  // Underscores only: some codegen paths emit a texture name verbatim as a WGSL
  // identifier and a dot is a parse error (pianoGodRays.ts:112-118). Upstream's
  // names are 'UnrealBloomPass.bright' &c., which would be exactly that.
  target.texture.name = name
  return target
}

export class BloomPass {
  readonly #bright = makeTarget("bloom_bright")
  readonly #horizontal: THREE.RenderTarget[] = []
  readonly #vertical: THREE.RenderTarget[] = []
  readonly #blurs: BlurStage[] = []
  readonly #highPassQuad: StageQuad
  readonly #compositeQuad: StageQuad
  #resolutionScale = 0.5
  #disposed = false

  constructor(options: BloomPassOptions) {
    for (let i = 0; i < MIPS; i++) {
      this.#horizontal.push(makeTarget(`bloom_h${i}`))
      this.#vertical.push(makeTarget(`bloom_v${i}`))
    }

    // ---------------------------------------------------------- high pass
    //
    // Upstream:12-19. `smoothWidth` is deliberately tiny: the threshold is the
    // artistic control and a wide knee turns it into a soft glow over the whole
    // frame, which is exactly what the measured 2.2 exists to prevent.
    const smoothWidth = uniform(0.01) as N
    this.#highPassQuad = createStageQuad("bloom_high_pass")
    this.#highPassQuad.setFragment(
      Fn(() => {
        // `.toVar()` because the sample is read twice (luminance, then the mix)
        // and an un-var'd texture node emits a second fetch.
        const input = options.source.sample(uv()).toVar() as N
        const alpha = smoothstep(
          options.threshold,
          options.threshold.add(smoothWidth),
          luminance(input.rgb)
        )
        return mix(vec4(0), input, alpha)
      })()
    )

    // ---------------------------------------------------- separable blurs
    for (let i = 0; i < MIPS; i++) {
      this.#blurs.push(this.#createBlur(i))
    }

    // ----------------------------------------------------------- composite
    const factors = uniformArray(MIP_FACTORS.slice()) as N
    const tints = uniformArray(
      MIP_FACTORS.map(() => new THREE.Vector3(1, 1, 1))
    ) as N

    // Upstream:426-438. Kept as a laid-out Fn so it stays one WGSL function
    // instead of five inlined copies.
    const lerpBloomFactor = Fn(([factor, radius]: N[]): N =>
      mix(factor, float(1.2).sub(factor), radius)
    ).setLayout({
      name: "bloomLerpFactor",
      type: "float",
      inputs: [
        { name: "factor", type: "float" },
        { name: "radius", type: "float" }
      ]
    })

    const blurTextures = this.#vertical.map((target, i) => {
      const node = texture(target.texture) as N
      node.name = `bloom_blur${i}`
      return node
    })

    this.#compositeQuad = createStageQuad("bloom_composite")
    this.#compositeQuad.setFragment(
      Fn(() => {
        const uvNode = uv()
        let sum: N = null
        for (let i = 0; i < MIPS; i++) {
          const term = lerpBloomFactor(factors.element(i), options.radius)
            .mul(vec4(tints.element(i), 1.0))
            .mul(blurTextures[i].sample(uvNode))
          sum = sum === null ? term : sum.add(term)
        }
        return (sum as N).mul(options.strength)
      })()
    )
  }

  /** Upstream:505-557, minus the builder. */
  #createBlur(index: number): BlurStage {
    const kernelRadius = KERNEL_RADII[index]
    const sigma = kernelRadius / 3
    const coefficients: number[] = []
    for (let i = 0; i < kernelRadius; i++) {
      coefficients.push((0.39894 * Math.exp((-0.5 * i * i) / (sigma * sigma))) / sigma)
    }

    // Seeded, not `texture( null )` — see deviation 3 in the header.
    const colorTexture = texture(this.#bright.texture) as N
    colorTexture.name = `bloom_blur_src${index}`
    const gaussian = uniformArray(coefficients) as N
    const invSize = uniform(new THREE.Vector2(1, 1)) as N
    const direction = uniform(new THREE.Vector2(0.5, 0.5)) as N

    const quad = createStageQuad(`bloom_blur${index}`)
    quad.setFragment(
      Fn(() => {
        const uvNode = uv()
        const sum = colorTexture.sample(uvNode).rgb.mul(gaussian.element(0)).toVar()
        Loop(
          { start: int(1), end: int(kernelRadius), type: "int", condition: "<" },
          ({ i }: N) => {
            const w = gaussian.element(i)
            const uvOffset = direction.mul(invSize).mul(float(i))
            const a = colorTexture.sample(uvNode.add(uvOffset)).rgb
            const b = colorTexture.sample(uvNode.sub(uvOffset)).rgb
            sum.addAssign(add(a, b).mul(w))
          }
        )
        return vec4(sum, 1.0)
      })()
    )

    return { quad, colorTexture, direction, invSize }
  }

  /**
   * The bloom contribution, at `output × resolutionScale`. A stable Texture
   * object: `RenderTarget.setSize()` keeps its texture identity, so a consumer
   * may bind this once and never rebind.
   */
  get texture(): THREE.Texture {
    return this.#horizontal[0].texture
  }

  getResolutionScale(): number {
    return this.#resolutionScale
  }

  /** Structural: the caller must `setSize()` again afterwards. */
  setResolutionScale(scale: number): void {
    this.#resolutionScale = Math.max(0.05, Math.min(1, scale))
  }

  /** Upstream:313-332. `width`/`height` are the chain's OUTPUT size. */
  setSize(width: number, height: number): void {
    let resx = Math.max(1, Math.floor(Math.max(1, width) * this.#resolutionScale))
    let resy = Math.max(1, Math.floor(Math.max(1, height) * this.#resolutionScale))

    this.#bright.setSize(resx, resy)

    for (let i = 0; i < MIPS; i++) {
      this.#horizontal[i].setSize(resx, resy)
      this.#vertical[i].setSize(resx, resy)
      ;(this.#blurs[i].invSize.value as THREE.Vector2).set(1 / resx, 1 / resy)
      resx = Math.max(1, Math.floor(resx / 2))
      resy = Math.max(1, Math.floor(resy / 2))
    }
  }

  /**
   * Upstream:339-392, minus the state guard around each individual draw.
   *
   * Called ONLY from the chain, with no render pass open. `StageQuad.render`
   * carries the `RendererUtils.resetRendererState` / `restore` pair per draw
   * rather than once around all twelve: it is a handful of field reads and it
   * keeps every r185 private-shape contact point in `shared/fullscreen.ts`.
   */
  render(renderer: THREE.WebGPURenderer): void {
    if (this.#disposed) return

    // 1. Extract bright areas.
    this.#highPassQuad.render(renderer, this.#bright)

    // 2. Blur each mip progressively, horizontal then vertical. The two draws
    //    share one material and one `direction` uniform — three uploads uniforms
    //    per draw, which is what makes the in-frame mutation legal.
    let input = this.#bright
    for (let i = 0; i < MIPS; i++) {
      const blur = this.#blurs[i]
      blur.colorTexture.value = input.texture
      blur.direction.value = BLUR_X
      blur.quad.render(renderer, this.#horizontal[i])

      blur.colorTexture.value = this.#horizontal[i].texture
      blur.direction.value = BLUR_Y
      blur.quad.render(renderer, this.#vertical[i])

      input = this.#vertical[i]
    }

    // 3. Recombine. Writes into horizontal[0] while sampling vertical[0..4] —
    //    no target is both bound and written in one pass.
    this.#compositeQuad.render(renderer, this.#horizontal[0])
  }

  /** Every quad whose WGSL must exist before the first presented frame. */
  quads(): THREE.QuadMesh[] {
    return [
      this.#highPassQuad.mesh,
      ...this.#blurs.map((blur) => blur.quad.mesh),
      this.#compositeQuad.mesh
    ]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#bright.dispose()
    for (const target of this.#horizontal) target.dispose()
    for (const target of this.#vertical) target.dispose()
    this.#highPassQuad.dispose()
    this.#compositeQuad.dispose()
    for (const blur of this.#blurs) blur.quad.dispose()
    this.#blurs.length = 0
    this.#horizontal.length = 0
    this.#vertical.length = 0
  }
}
