/**
 * VENDORED FORK
 *
 *   upstream: node_modules/three/examples/jsm/tsl/display/GTAONode.js
 *   three:    0.185.1
 *   original: Activision GTAO — "Practical Real-Time Strategies for Accurate
 *             Indirect Occlusion" (Jimenez et al., SIGGRAPH 2016)
 *
 * The horizon-search kernel below is upstream's, line for line. Everything that
 * differs is listed here, with the reason.
 *
 * ---------------------------------------------------------------------------
 * 1. NOT A NODE AT ALL (upstream: `class GTAONode extends TempNode`,
 *    `updateBeforeType = NodeUpdateType.FRAME` at GTAONode.js:89).
 *
 *    The build order asked for `updateBeforeType = NodeUpdateType.NONE` plus a
 *    public `render(renderer)`. Dropping the Node base class is the stronger
 *    form of the same instruction: there is no `updateBeforeType` left to be
 *    wrong, and no `setup()` a foreign NodeBuilder can reach.
 *
 *    Why it matters, measured rather than theoretical: `Renderer.js:3778` calls
 *    `this._nodes.updateBefore(renderObject)` from `renderObject()`, i.e. WHILE
 *    A RENDER PASS IS OPEN. A FRAME-scoped node reached from there renders its
 *    quad inside somebody else's pass, and WebGPU rejects the entire command
 *    buffer when one pass both writes and binds the same texture — the frame
 *    comes out as bare clear colour. `contactShadows.ts:326-345` records the
 *    measurement for this exact shape of pass: ~70% of captures across one
 *    ten-second shot, and once it starts it repeats every frame. This pass
 *    samples the beauty depth attachment, so it is precisely the shape that
 *    trips it. `chain.ts:43-72` is the chain-wide statement of the same policy.
 *
 *    Consequence: upstream's `getTextureNode()` / `passTexture( this, … )` are
 *    gone too. `passTexture` exists to hand three's scheduler a handle on the
 *    producing node (`PassNode.js:60-67` stashes `properties.passNode`), which
 *    is the machinery we are deliberately not using. The stage owns a plain
 *    `texture()` node over the same target instead.
 *
 * 2. THE FRAGMENT GRAPH IS BUILT EAGERLY, IN THE CONSTRUCTOR (upstream builds
 *    it in `setup( builder )`, GTAONode.js:462).
 *
 *    Upstream's material only acquires a `fragmentNode` when some CONSUMER's
 *    NodeBuilder happens to walk the AO node. In this chain the consumer is the
 *    composite (order 50) and this stage's quad is handed to
 *    `compileFullscreenQuads` in chain order (30), so the lazy form would offer
 *    the warmup an empty material and then compile for real at first use — a
 *    codegen window that holds presented frames (`pipeline.ts:74-88`).
 *    Building in the constructor makes the quad compilable the moment the stage
 *    exists, and makes the "a second NodeBuilder clobbers `_material`" hazard
 *    the brief asked to guard against structurally impossible: no builder ever
 *    calls in here. `#built` keeps `buildMaterial()` idempotent regardless.
 *
 *    `.context( builder.getSharedContext() )` (GTAONode.js:462) goes with it.
 *    It exists only to strip the consumer builder's context off a graph that was
 *    born inside it; a graph built with no builder has nothing to strip. This is
 *    also what `composite/index.ts` and `display/index.ts` already do — assign
 *    `material.fragmentNode` directly, no context wrapper.
 *
 * 3. REVERSED DEPTH. `depth.greaterThanEqual( 1.0 ).discard()` (GTAONode.js:346)
 *    becomes `isGeometryDepth( … ).not().discard()`. `reversedDepthBuffer` is
 *    true (`app/renderCore.ts:48-51`), so background is 0.0 and near is 1.0, and
 *    upstream's test discards NEAR geometry and shades the SKY. See
 *    `shared/reversedDepth.ts`. Everything else is left alone on purpose:
 *    `getViewPosition` (:348, :408, :422) feeds raw depth straight into `clip.z`
 *    against a genuinely reversed `projectionMatrixInverse`, and
 *    `getScreenPosition` (:406, :420) is a pure forward projection — both are
 *    already correct. Do NOT add a `oneMinus()` to either.
 *
 * 4. THE LOG-DEPTH BRANCH (GTAONode.js:327-333) IS DELETED. It routes through
 *    `viewZToPerspectiveDepth`, which is one of the two helpers that is NOT
 *    reversed-aware (`ViewportDepthNode.js:203`; its reversed twin at :215 is
 *    called by nothing in three), so under this renderer it would be wrong. This
 *    project never enables `logarithmicDepthBuffer`. Deleting it also retires
 *    the `_cameraNear` / `_cameraFar` references, which nothing else read.
 *
 * 5. REAL NORMALS ARE REQUIRED (upstream: `normalNode` may be null,
 *    GTAONode.js:340). The null path is `getNormalFromDepth`, which is
 *    9 `textureLoad` + 5 `getViewPosition` per pixel. The beauty pass already
 *    publishes view normals in its second attachment (`shared/gbuffer.ts`), so
 *    the fallback is pure waste here and is not carried over. The dependency is
 *    a `normalViewAt( uv )` function rather than a texture node so the caller
 *    owns the unpack — `gbuffer.normalViewAt` already normalizes.
 *
 * 6. THE RENDER TARGET IS NOT OURS. Upstream allocates, sizes and disposes
 *    `_aoRenderTarget` (:97, :261, :477). In this chain `targets.ts` owns every
 *    intermediate; the pass is handed one and never allocates, resizes or
 *    disposes it. `setResolution()` therefore only updates the uniform the noise
 *    tiling reads.
 *
 * 7. NO MODULE-LEVEL `_quadMesh` / `_rendererState` (GTAONode.js:4, :10). Those
 *    are shared across every instance of the upstream node. We use the chain's
 *    `shared/fullscreen.ts` quad, which carries the same
 *    resetRendererState/restore discipline per instance.
 *
 * 8. `dispose()` DISPOSES THE MAGIC-SQUARE `DataTexture` (GTAONode.js:493
 *    allocates it; :475-481 leaks it upstream).
 *
 * 9. `scale` IS RENAMED `punch` (GTAONode.js:146, :456). Same final
 *    `pow( ao, punch )`. "scale" reads as resolution and this panel has real
 *    resolution knobs sitting next to it.
 *
 * 10. A HORIZON STEP MUST LAND IN A DIFFERENT DEPTH TEXEL, or it is not consumed.
 *     Upstream has no such test (GTAONode.js:404-434) and that is a real,
 *     shipping-frame defect, not a theoretical one — it is what put 25-32% of
 *     false occlusion on the open ocean.
 *
 *     THE MECHANISM, which is arithmetic and not noise. `radius` is a VIEW-SPACE
 *     length; the search that consumes it is a SCREEN-SPACE march. Their ratio is
 *     the projected size of the radius, which shrinks as 1/z — so past roughly
 *     `radius × (0.5 · height · P₁₁)` metres, every step of the march projects to
 *     less than one depth texel and re-samples the CENTRE PIXEL'S OWN DEPTH.
 *
 *     What that does is specific and it is not "nothing". `getViewPosition( uv_j,
 *     depth_centre, invProj )` reconstructs the point on ray `uv_j` whose CLIP Z
 *     is `depth_centre`, and for a perspective projection view-z is a function of
 *     clip-z alone. So the reconstructed sample has EXACTLY the centre's view z:
 *
 *       - `viewDelta.z === 0`, so `abs( viewDelta.z ) < thickness` — the one gate
 *         upstream has — can never reject the step;
 *       - `normalize( viewDelta )` is therefore a purely lateral direction, and
 *         `dot( viewDir, that )` reports a horizon lying in the plane
 *         PERPENDICULAR TO THE VIEW RAY rather than anywhere the scene put one.
 *
 *     `distanceFallOff: 1` makes the j = 0 weight exactly `2/(j+2) = 1`, so that
 *     bogus horizon does not merely bias the estimate — the very first step SNAPS
 *     the downhill horizon from its tangent-plane value `−sin γ` to 0. The
 *     closed-form integral (Eq. 7, below) then returns
 *
 *         cos γ + ½·γ·sin γ      instead of      cos γ + γ·sin γ
 *
 *     where γ is the angle between the projected normal and the view ray. That is
 *     a deterministic deficit of 0% at γ = 0°, 22% at 45°, 32% at 60° — i.e. it is
 *     invisible on surfaces facing the camera and maximal at GRAZING incidence.
 *     Open water at 0.5-3 km is the grazing case, which is why the measured
 *     symptom was a sea occluded to 0.68-0.75 in bands tracking the wave field
 *     (the FFT normals modulate γ) while the deck two metres away moved 0.12 luma.
 *
 *     THE FIX is to refuse the step, not to grow it. A step that cannot resolve a
 *     neighbouring texel carries no information about the scene, and the honest
 *     answer at that range is the one the horizons are already initialised to:
 *     the tangent plane, i.e. unoccluded. Growing the search to whatever ≥ 1 texel
 *     happens to be (~2 m at 1 km) would instead make `radius` mean something
 *     different at every distance, invent large-scale occlusion nobody authored,
 *     and pump under a dolly.
 *
 *     It is a no-op exactly where AO works: at 2 m a 0.9 m radius projects to
 *     hundreds of texels and every step passes, so the near field is unchanged.
 */
import * as THREE from "three/webgpu"
import {
  Fn,
  If,
  Loop,
  PI,
  abs,
  acos,
  add,
  clamp,
  cos,
  cross,
  div,
  dot,
  float,
  getScreenPosition,
  getViewPosition,
  int,
  mat3,
  max,
  mix,
  mul,
  normalize,
  pow,
  sin,
  textureSize,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl"
import { createStageQuad, type StageQuad } from "../../shared/fullscreen"
import { isGeometryDepth } from "../../shared/reversedDepth"
import type { N } from "../../types"

/**
 * From the Activision GTAO paper. Upstream adds `rotation / 360` to an angle
 * that is already in RADIANS (GTAONode.js:372), so a "60°" slice is really
 * ~9.5°. That is upstream's arithmetic and it is kept verbatim: the values only
 * have to decorrelate successive frames, the temporal resolve downstream is what
 * integrates them, and "fixing" the units would change the noise distribution
 * this stage's defaults were picked against.
 */
const TEMPORAL_ROTATIONS = [60, 300, 180, 240, 120, 0]

export type GtaoDeps = {
  readonly renderer: THREE.WebGPURenderer
  /** Raw depth from the beauty pass, INPUT resolution. Reversed-Z. */
  readonly depthNode: N
  /** View-space normal, already unpacked and normalized. See shared/gbuffer.ts. */
  readonly normalViewAt: (uv: N) => N
  /** Object reference; `uniform()` re-uploads it every frame so the TAA jitter
   *  reaches both the forward and the inverse projection automatically. */
  readonly camera: THREE.PerspectiveCamera
  /** Chain-owned. RedFormat + HalfFloatType. Never resized or disposed here. */
  readonly target: THREE.RenderTarget
}

export class GtaoPass {
  // --- live uniforms. None of these is baked into the graph, so every one of
  // --- them is a free slider (the stage's recompileKeys is empty and stays so).
  readonly radius: N = uniform(0.9)
  readonly thickness: N = uniform(1)
  readonly distanceExponent: N = uniform(1)
  readonly distanceFallOff: N = uniform(1)
  readonly punch: N = uniform(1.1)
  /** Drives DIRECTIONS/STEPS as dynamic loop bounds — a uniform, not a constant. */
  readonly samples: N = uniform(16)
  /** AO target size in pixels. Only the noise tiling reads it. */
  readonly resolution: N = uniform(new THREE.Vector2(1, 1))
  /**
   * THE DEPTH BUFFER'S size in pixels — NOT this pass's. Deviation 10's step
   * test measures a march step against the sampling rate of the thing it
   * samples, and the depth attachment is the beauty pass's, at INPUT resolution,
   * while this pass runs at `post.ssao.resolution` × that.
   *
   * Seeded to 1×1 so that a pass which somehow renders before its first
   * `setSize()` rejects every step and reports UNOCCLUDED. Of the two ways to be
   * wrong before the size is known, inventing occlusion is the one that reaches
   * the frame.
   */
  readonly depthResolution: N = uniform(new THREE.Vector2(1, 1))
  readonly temporalDirection: N = uniform(0)

  readonly #renderer: THREE.WebGPURenderer
  readonly #depthNode: N
  readonly #normalViewAt: (uv: N) => N
  readonly #target: THREE.RenderTarget
  readonly #noiseTexture: THREE.DataTexture
  readonly #noiseNode: N
  readonly #cameraProjectionMatrix: N
  readonly #cameraProjectionMatrixInverse: N
  readonly #quad: StageQuad
  #built = false
  #disposed = false

  constructor(deps: GtaoDeps) {
    this.#renderer = deps.renderer
    this.#depthNode = deps.depthNode
    this.#normalViewAt = deps.normalViewAt
    this.#target = deps.target
    this.#noiseTexture = generateMagicSquareNoise()
    this.#noiseNode = texture(this.#noiseTexture) as N
    this.#cameraProjectionMatrix = uniform(deps.camera.projectionMatrix) as N
    this.#cameraProjectionMatrixInverse = uniform(deps.camera.projectionMatrixInverse) as N
    this.#quad = createStageQuad("post_ssao_gtao")
    this.buildMaterial()
  }

  /** The quad `warmupQuads()` hands to `compileFullscreenQuads`. */
  get quadMesh(): THREE.QuadMesh {
    return this.#quad.mesh
  }

  /** Idempotent. Called from the constructor; see deviation 2. */
  buildMaterial(): void {
    if (this.#built || this.#disposed) return
    this.#built = true
    this.#quad.setFragment(this.#fragment())
  }

  /** AO target size in pixels. The chain owns the target itself. */
  setResolution(width: number, height: number): void {
    ;(this.resolution.value as THREE.Vector2).set(Math.max(1, width), Math.max(1, height))
  }

  /**
   * The DEPTH attachment's size in pixels — the chain's INPUT resolution, which
   * is not this pass's own. See deviation 10: the step test asks whether a march
   * step can resolve a neighbouring texel of the buffer it marches through.
   */
  setDepthResolution(width: number, height: number): void {
    ;(this.depthResolution.value as THREE.Vector2).set(Math.max(1, width), Math.max(1, height))
  }

  /**
   * `frameIndex` rotates the slice angles on a 6-frame cycle; pass `null` to
   * pin it (the `temporalRotation` toggle). Safe to leave on because the
   * temporal resolve is downstream and is what turns the rotation into detail
   * rather than shimmer.
   */
  setTemporalFrame(frameIndex: number | null): void {
    this.temporalDirection.value =
      frameIndex === null ? 0 : TEMPORAL_ROTATIONS[((frameIndex % 6) + 6) % 6] / 360
  }

  /**
   * THE ONLY ENTRY POINT. Called by the stage from `pipeline.render()`, with no
   * render pass open — see deviation 1 for what happens otherwise.
   *
   * Clears to WHITE: this target is an occlusion FACTOR, so every pixel the
   * kernel discards (sky, and anything the depth test calls background) has to
   * read back as "no occlusion", not as black.
   */
  render(renderer: THREE.WebGPURenderer): void {
    if (this.#disposed) return
    this.#quad.render(renderer, this.#target, 0xffffff, 1)
  }

  dispose(): void {
    this.#disposed = true
    // Upstream leaks this one (GTAONode.js:475-481 disposes the target and the
    // material and forgets the DataTexture it allocated at :493).
    this.#noiseTexture.dispose()
    this.#quad.dispose()
  }

  // ------------------------------------------------------------------ kernel

  #fragment(): N {
    const sampleDepth = (sampleUv: N): N => this.#depthNode.sample(sampleUv).r

    return Fn(() => {
      const uvNode = uv()

      /**
       * DEVIATION 10. True when a march step lands in a depth texel other than
       * the centre's — i.e. when it can possibly report something the centre
       * pixel does not already know.
       *
       * `|Δuv| · depthResolution ≥ 1` in either axis is SUFFICIENT for a
       * different texel (`floor( a + d ) > floor( a )` whenever `d ≥ 1`, because
       * `frac( a ) < 1`). It is not necessary — a 0.7-texel step can straddle a
       * boundary — and the stricter form is the deliberate one: whether a
       * sub-texel step crosses depends on the pixel's sub-texel PHASE, so
       * accepting those would make the accept/reject pattern shimmer under a
       * dolly. The magnitude test is monotone in distance instead, so a step
       * fades out once and stays out.
       *
       * The max-component form, not `length()`: this is asking "different
       * texel?", which is a per-axis question.
       */
      const stepResolvesATexel = (sampleUv: N): N => {
        const texels = sampleUv.sub(uvNode).mul(this.depthResolution).abs()
        return max(texels.x, texels.y).greaterThanEqual(1)
      }

      const depth = sampleDepth(uvNode).toVar()

      // Reversed depth: background is 0.0. See deviation 3.
      // `isGeometryDepth` only reads `builder.renderer.reversedDepthBuffer`, and
      // we build with no NodeBuilder in scope (deviation 2), so the renderer is
      // handed over directly. `reversedDepthBuffer` is a constructor option
      // (renderCore.ts:48-51) and is already final by the time the chain exists.
      isGeometryDepth({ renderer: this.#renderer }, depth).not().discard()

      const viewPosition = getViewPosition(
        uvNode,
        depth,
        this.#cameraProjectionMatrixInverse
      ).toVar()
      const viewNormal = this.#normalViewAt(uvNode).toVar()

      const radiusToUse = this.radius

      // `int( 0 )` where upstream writes a bare `0` (GTAONode.js:353): three's
      // typings declare the level parameter as a Node. Same mip, same codegen.
      const noiseResolution = textureSize(this.#noiseNode, int(0))
      let noiseUv = vec2(uvNode.x, uvNode.y.oneMinus()) as N
      noiseUv = noiseUv.mul(this.resolution.div(noiseResolution))

      const noiseTexel = this.#noiseNode.sample(noiseUv)
      const randomVec = noiseTexel.xyz.mul(2.0).sub(1.0)
      const tangent = vec3(randomVec.xy, 0.0).normalize()
      const bitangent = vec3(tangent.y.mul(-1.0), tangent.x, 0.0)
      const kernelMatrix = mat3(tangent, bitangent, vec3(0.0, 0.0, 1.0))

      // Dynamic loop bounds, not baked constants — which is why `samples` can be
      // a live uniform and this stage needs no recompile key.
      const DIRECTIONS = this.samples.lessThan(30).select(3, 5).toVar()
      const STEPS = add(this.samples, DIRECTIONS.sub(1)).div(DIRECTIONS).toVar()

      // Visibility, not occlusion: 1 = fully open. It is consumed as a
      // multiplier, which is why the target clears to white.
      const factor = float(0).toVar()

      // Each iteration analyzes one vertical "slice" of the 3D space around the fragment.

      Loop({ start: int(0), end: DIRECTIONS, type: "int", condition: "<" }, ({ i }: N) => {
        const angle = float(i)
          .div(float(DIRECTIONS))
          .mul(PI)
          .add(this.temporalDirection)
          .toVar()
        const sampleDir = vec4(cos(angle), sin(angle), 0, add(0.5, mul(0.5, noiseTexel.w)))
        sampleDir.xyz = normalize(kernelMatrix.mul(sampleDir.xyz))

        const viewDir = normalize(viewPosition.xyz.negate()).toVar()
        const sliceBitangent = normalize(cross(sampleDir.xyz, viewDir)).toVar()
        const sliceTangent = cross(sliceBitangent, viewDir).toVar()

        // Project the view normal onto the slice plane (remove component along sliceBitangent).
        // The unnormalized length is the foreshortening weight applied at slice integration.
        // (Activision GTAO paper, Section 3.2 "Per-pixel sampling".)
        const projNRaw = viewNormal.sub(sliceBitangent.mul(dot(viewNormal, sliceBitangent))).toVar()
        const projNLen = projNRaw.length().toVar()
        const projN = projNRaw.div(max(projNLen, float(0.0001))).toVar()

        // γ — angle of projN within the slice plane, signed by the tangent direction.
        const nSin = dot(projN, sliceTangent).toVar()
        const nCos = clamp(dot(projN, viewDir), 0, 1).toVar()
        const signNSin = nSin.greaterThanEqual(0).select(float(1), float(-1))
        const angleN = signNSin.mul(acos(nCos)).toVar()

        const tangentToNormalInSlice = cross(projN, sliceBitangent).toVar()
        const cosHorizons = vec2(
          dot(viewDir, tangentToNormalInSlice),
          dot(viewDir, tangentToNormalInSlice.negate())
        ).toVar()

        // For each slice, the inner loop performs ray marching to find the horizons.

        // `as N` on the descriptor: `LoopNodeObjectParameter` in three's typings
        // has no `name`, but `LoopNode` reads it at runtime (LoopNode.js) and it
        // is what makes the inner index destructure as `j` instead of shadowing
        // the outer `i`. Dropping it would silently reuse the outer counter.
        Loop({ end: STEPS, type: "int", name: "j", condition: "<" } as N, ({ j }: N) => {
          const sampleViewOffset = sampleDir.xyz
            .mul(radiusToUse)
            .mul(sampleDir.w)
            .mul(pow(div(float(j).add(1.0), float(STEPS)), this.distanceExponent))

          // The loop marches in two opposite directions (x and y) along the slice's line to find the horizon on both sides.

          // x

          const sampleScreenPositionX = getScreenPosition(
            viewPosition.add(sampleViewOffset),
            this.#cameraProjectionMatrix
          ).toVar()
          const sampleDepthX = sampleDepth(sampleScreenPositionX).toVar()
          const sampleSceneViewPositionX = getViewPosition(
            sampleScreenPositionX,
            sampleDepthX,
            this.#cameraProjectionMatrixInverse
          ).toVar()
          const viewDeltaX = sampleSceneViewPositionX.sub(viewPosition).toVar()

          // Deviation 10. `abs( viewDeltaX.z ) < thickness` alone cannot reject a
          // step that re-sampled the centre texel: such a step reconstructs at
          // the centre's own view z, so `viewDeltaX.z` is EXACTLY 0 and the gate
          // is maximally satisfied by the one case it must refuse.
          If(abs(viewDeltaX.z).lessThan(this.thickness).and(stepResolvesATexel(sampleScreenPositionX)), () => {
            const sampleCosHorizon = dot(viewDir, normalize(viewDeltaX))
            cosHorizons.x.addAssign(
              max(
                0,
                mul(
                  sampleCosHorizon.sub(cosHorizons.x),
                  mix(1.0, float(2.0).div(float(j).add(2)), this.distanceFallOff)
                )
              )
            )
          })

          // y

          const sampleScreenPositionY = getScreenPosition(
            viewPosition.sub(sampleViewOffset),
            this.#cameraProjectionMatrix
          ).toVar()
          const sampleDepthY = sampleDepth(sampleScreenPositionY).toVar()
          const sampleSceneViewPositionY = getViewPosition(
            sampleScreenPositionY,
            sampleDepthY,
            this.#cameraProjectionMatrixInverse
          ).toVar()
          const viewDeltaY = sampleSceneViewPositionY.sub(viewPosition).toVar()

          // Tested independently of the +x direction rather than sharing one
          // predicate: the two offsets project to different screen lengths under
          // perspective, and near a silhouette one side can resolve a texel while
          // the other cannot.
          If(abs(viewDeltaY.z).lessThan(this.thickness).and(stepResolvesATexel(sampleScreenPositionY)), () => {
            const sampleCosHorizon = dot(viewDir, normalize(viewDeltaY))
            cosHorizons.y.addAssign(
              max(
                0,
                mul(
                  sampleCosHorizon.sub(cosHorizons.y),
                  mix(1.0, float(2.0).div(float(j).add(2)), this.distanceFallOff)
                )
              )
            )
          })
        })

        // Cosine-weighted inner integral, closed-form (Activision GTAO paper, Eq. 7).
        // Per horizon h_i:    term_i = −cos( 2 h_i − γ ) + cos( γ ) + 2 h_i sin( γ )
        // The 0.25 factor is ½ (integral normalization) × ½ (averaging the two horizons).
        //
        // In this slice setup `sliceTangent = cross( sliceBitangent, viewDir )` works out
        // opposite to `sampleDir`, so the +sampleDir samples (cosHorizons.x) live on the
        // −T side of the slice and −sampleDir samples (cosHorizons.y) on the +T side.
        // γ is signed by +T (sliceTangent), so hPos must read from cosHorizons.y.

        const hPos = acos(cosHorizons.y).toVar()
        const hNeg = acos(cosHorizons.x).negate().toVar()

        const termPos = cos(hPos.mul(2).sub(angleN)).negate().add(nCos).add(hPos.mul(2).mul(nSin))
        const termNeg = cos(hNeg.mul(2).sub(angleN)).negate().add(nCos).add(hNeg.mul(2).mul(nSin))
        const a = termPos.add(termNeg).mul(0.25)

        // |projN| is the foreshortening weight from the per-slice normal projection.
        factor.addAssign(projNLen.mul(a))
      })

      factor.assign(clamp(factor.div(DIRECTIONS), 0, 1))
      factor.assign(pow(factor, this.punch))

      return factor
    })()
  }
}

/**
 * The AO's noise texture. Verbatim from GTAONode.js:493-523 — a magic square
 * gives every texel in a 5×5 tile a distinct rotation with no repeated angle,
 * which is what keeps the 3-direction slice fan from lining up into banding.
 */
function generateMagicSquareNoise(size = 5): THREE.DataTexture {
  const noiseSize = Math.floor(size) % 2 === 0 ? Math.floor(size) + 1 : Math.floor(size)
  const magicSquare = generateMagicSquare(noiseSize)
  const noiseSquareSize = magicSquare.length
  const data = new Uint8Array(noiseSquareSize * 4)

  for (let inx = 0; inx < noiseSquareSize; ++inx) {
    const iAng = magicSquare[inx]
    const angle = (2 * Math.PI * iAng) / noiseSquareSize
    const randomVec = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0).normalize()
    data[inx * 4] = (randomVec.x * 0.5 + 0.5) * 255
    data[inx * 4 + 1] = (randomVec.y * 0.5 + 0.5) * 255
    data[inx * 4 + 2] = 127
    data[inx * 4 + 3] = 255
  }

  const noiseTexture = new THREE.DataTexture(data, noiseSize, noiseSize)
  noiseTexture.wrapS = THREE.RepeatWrapping
  noiseTexture.wrapT = THREE.RepeatWrapping
  noiseTexture.needsUpdate = true

  return noiseTexture
}

/** Verbatim from GTAONode.js:531-581. */
function generateMagicSquare(size: number): number[] {
  const noiseSize = Math.floor(size) % 2 === 0 ? Math.floor(size) + 1 : Math.floor(size)
  const noiseSquareSize = noiseSize * noiseSize
  const magicSquare = Array(noiseSquareSize).fill(0)
  let i = Math.floor(noiseSize / 2)
  let j = noiseSize - 1

  for (let num = 1; num <= noiseSquareSize; ) {
    if (i === -1 && j === noiseSize) {
      j = noiseSize - 2
      i = 0
    } else {
      if (j === noiseSize) {
        j = 0
      }

      if (i < 0) {
        i = noiseSize - 1
      }
    }

    if (magicSquare[i * noiseSize + j] !== 0) {
      j -= 2
      i++
      continue
    } else {
      magicSquare[i * noiseSize + j] = num++
    }

    j++
    i--
  }

  return magicSquare
}
