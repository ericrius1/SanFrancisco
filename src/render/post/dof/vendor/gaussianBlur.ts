/**
 * VENDORED FORK
 *
 *   upstream: node_modules/three/examples/jsm/tsl/display/GaussianBlurNode.js
 *   three:    0.185.1
 *
 * Vendored because `DepthOfFieldNode` nests one (DepthOfFieldNode.js:381) to
 * dilate the near-field CoC, and upstream's is `NodeUpdateType.FRAME`
 * (GaussianBlurNode.js:116). Under this chain's regime that is the exact hazard
 * the whole architecture exists to avoid: the nested node's `updateBefore` fires
 * from inside `_quadMesh.render()` — i.e. while the CoC-blur pass is OPEN — and
 * renders two more fullscreen passes there. WebGPU rejects the entire command
 * buffer when a pass both writes and binds a texture, and the frame comes out as
 * bare clear colour (contactShadows.ts:326-345 measured ~70% of captures for the
 * same shape). Driving it explicitly from `DofPass.render()` removes the whole
 * class of failure. See chain.ts:43-72.
 *
 * DEVIATIONS FROM UPSTREAM, and why:
 *
 *  1. NOT A NODE. No `TempNode`, no `setup( builder )`, no `passTexture`, no
 *     `updateBeforeType` left to be wrong. Same call as `ssao/vendor/gtao.ts`
 *     and `../bloom/vendor/bloom.ts`. `.context( builder.getSharedContext() )`
 *     (:290) goes with the builder: it strips a CONSUMER builder's
 *     material-scoped context off a graph born inside it (NodeBuilder.js:1092-1104),
 *     and a graph built with no builder has nothing to strip.
 *
 *  2. SIZE COMES FROM THE CALLER, not from `textureNode.value.image`
 *     (:183). The DOF fork sizes its whole blur chain from one place so the new
 *     `resolutionScale` knob has a single owner, and — more importantly — the
 *     input texture here is DOF's ALIASED `_CoCTextureNode`, whose `.value` is
 *     swapped three times per frame. Sizing off it would make the blur's targets
 *     depend on which alias happened to be bound.
 *
 *  3. FIXED FORMAT, set once. Upstream re-assigns `texture.type` every frame
 *     (:187-188) because it is generic; ours is only ever fed a single-channel
 *     half-float CoC, so both targets are r16float from birth. Mutating a
 *     Texture's `type` per frame is a re-create hazard for no benefit here.
 *
 *  4. The premultiplied-alpha branch (:245-257) is dropped. The only caller
 *     blurs a coverage scalar in `.r`; there is no alpha to premultiply, and
 *     keeping the branch would mean keeping a second codegen path nothing
 *     reaches.
 *
 * The kernel, the coefficient formula and the two-pass horizontal/vertical
 * structure are upstream's, unchanged — including the input-node swap and
 * restore around the vertical pass (:201, :211), which is what lets one material
 * serve both directions.
 */
import * as THREE from "three/webgpu"
import { Fn, float, uniform, uv, vec2, vec4 } from "three/tsl"
import { createStageQuad, type StageQuad } from "../../shared/fullscreen"
import type { N } from "../../types"

export type GaussianBlurPassOptions = {
  readonly name: string
  /**
   * The input texture NODE. Its `.value` may be aliased by the caller between
   * frames; this pass swaps it to its own horizontal target for the vertical
   * pass and restores whatever it found (upstream:179, :211).
   */
  readonly source: N
  /** Upstream's `sigma`. Kernel size is `3 + 2 * sigma` taps per side. */
  readonly sigma: number
}

/** Upstream:325-338. */
function coefficients(kernelRadius: number): number[] {
  const sigma = kernelRadius / 3
  const out: number[] = []
  for (let i = 0; i < kernelRadius; i++) {
    out.push((0.39894 * Math.exp((-0.5 * i * i) / (sigma * sigma))) / sigma)
  }
  return out
}

function makeTarget(name: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RedFormat,
    type: THREE.HalfFloatType,
    generateMipmaps: false
  })
  // Underscores only — some codegen paths emit this verbatim as a WGSL
  // identifier (pianoGodRays.ts:112-118); upstream's name has a dot in it.
  target.texture.name = name
  return target
}

export class GaussianBlurPass {
  readonly #horizontal: THREE.RenderTarget
  readonly #vertical: THREE.RenderTarget
  readonly #quad: StageQuad
  readonly #source: N
  readonly #invSize: N = uniform(new THREE.Vector2(1, 1))
  readonly #passDirection: N = uniform(new THREE.Vector2(1, 0))
  #disposed = false

  constructor(options: GaussianBlurPassOptions) {
    this.#source = options.source
    this.#horizontal = makeTarget(`${options.name}_h`)
    this.#vertical = makeTarget(`${options.name}_v`)

    const kernelSize = 3 + 2 * options.sigma
    const weights = coefficients(kernelSize)
    const invSize = this.#invSize
    const passDirection = this.#passDirection
    const source = this.#source

    this.#quad = createStageQuad(options.name)
    this.#quad.setFragment(
      Fn(() => {
        const uvNode = uv()
        // Unrolled, as upstream: the kernel size is a JS constant, so this is a
        // straight-line tap list rather than a Loop with a dynamic bound.
        const direction: N = vec2(passDirection)
        const sum = vec4(source.sample(uvNode).mul(weights[0])).toVar()
        for (let i = 1; i < kernelSize; i++) {
          const offset: N = vec2(direction.mul(invSize.mul(float(i)))).toVar()
          sum.addAssign(
            source
              .sample(uvNode.add(offset))
              .add(source.sample(uvNode.sub(offset)))
              .mul(float(weights[i]))
          )
        }
        return sum
      })()
    )
  }

  /** Stable across resizes — bind once. */
  get texture(): THREE.Texture {
    return this.#vertical.texture
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    ;(this.#invSize.value as THREE.Vector2).set(1 / w, 1 / h)
    this.#horizontal.setSize(w, h)
    this.#vertical.setSize(w, h)
  }

  /** Called ONLY by DofPass.render(), with no render pass open. */
  render(renderer: THREE.WebGPURenderer): void {
    if (this.#disposed) return
    // Restore whatever alias the caller had bound. DofPass swaps this node's
    // `.value` three times per frame and the second swap happens right after
    // this call returns — see dof.ts.
    const bound = this.#source.value
    ;(this.#passDirection.value as THREE.Vector2).set(1, 0)
    this.#quad.render(renderer, this.#horizontal)

    this.#source.value = this.#horizontal.texture
    ;(this.#passDirection.value as THREE.Vector2).set(0, 1)
    this.#quad.render(renderer, this.#vertical)

    this.#source.value = bound
  }

  quads(): THREE.QuadMesh[] {
    return [this.#quad.mesh]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#horizontal.dispose()
    this.#vertical.dispose()
    this.#quad.dispose()
  }
}
