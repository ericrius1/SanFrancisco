// FORKED from three/examples/jsm/tsl/display/SSRNode.js — three r185 (0.185.1).
//
// Line numbers below refer to that upstream file.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A FORK AND NOT A WRAPPER
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. SCHEDULING. Upstream is `NodeUpdateType.FRAME` (:160): the node graph calls
//    `updateBefore()` from `Renderer._nodes.updateBefore(renderObject)`, which
//    runs WHILE A RENDER PASS IS OPEN (Renderer.js:3778). A node that renders six
//    of its own quads from there is drawing inside somebody else's pass, and
//    WebGPU rejects the whole command buffer — the frame comes out as bare clear
//    colour. contactShadows.ts:326-345 measured that exact failure at ~70% of
//    captures across one ten-second shot. This fork has NO `updateBefore` at all;
//    it exposes `render(renderer)` and the chain calls it with no pass open.
//
// 2. REVERSED DEPTH. `renderCore.ts` sets `reversedDepthBuffer: true`, so the
//    background is 0.0 and the near plane is 1.0. Upstream's `depth.greaterThanEqual(1.0).discard()`
//    (:897) discards NEAR geometry and shades the SKY. Replaced with the repo's
//    `isGeometryDepth()`.
//
// 3. THE MASK. Upstream selects reflective surfaces with `reflectNonMetals`
//    (:909-913) — a build-time boolean over a metalness channel this project's
//    g-buffer does not carry. This fork reads an explicit reflectivity mask and
//    discards below a threshold as the FIRST statement of the kernel, before the
//    depth tap. On a dry SF afternoon that mask is empty and the pass costs one
//    texture fetch and one discard per pixel.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY DEVIATION, and why
// ─────────────────────────────────────────────────────────────────────────────
//
//  (a) `TempNode` → plain class. Upstream is a node whose fragment graph is only
//      built when some consumer's `setup(builder)` reaches it, and whose result is
//      published through `passTexture()`. Both are scheduling couplings we cannot
//      have: nothing in this chain samples an SSR node from a graph, and a stage
//      whose material might never be built cannot be warmed at boot. The graph is
//      built eagerly in the constructor instead.
//  (b) `.context( builder.getSharedContext() )` (:628) DROPPED. It exists so a
//      graph built inside another material's builder does not inherit that
//      material's `getUV`/`getOutput`/`material` context. Our materials are built
//      by their own NodeBuilder, so there is no outer context to strip.
//  (c) `isGeometryDepth()` takes a `{ renderer }` shim rather than the NodeBuilder.
//      The helper reads exactly one thing — `builder.renderer.reversedDepthBuffer`
//      — and the graph is built before any builder exists. Same answer, no lie.
//  (d) The logarithmic-depth branch (:851-857) DELETED. It routes through the
//      NON-reversed `viewZToPerspectiveDepth` (ViewportDepthNode.js:203), so under
//      reversed depth it silently produces garbage, and this project never enables
//      log depth. `perspectiveDepthToViewZ` (:835) is kept exactly as upstream has
//      it — it IS reversed-aware (ViewportDepthNode.js:229), which is also why the
//      march comparison at :1125 needs no change.
//  (e) ORTHOGRAPHIC branches (:839, :903, :1036, :1081) DELETED. `PostGBuffer.camera`
//      is typed `PerspectiveCamera` and the chain has exactly one camera.
//  (f) `stepExponent` PROMOTED from a baked constant (:498, whose setter rebuilds
//      the material) to a uniform, and now drives the MIRROR path as well as the
//      scatter path. Upstream only exponentially distributes steps when
//      `stochastic` is true (:1089-1094), which would have left this stage with a
//      slider that does nothing. `stepExponent === 1` reproduces upstream's uniform
//      march exactly, so the promotion is a superset, not a change of default
//      behaviour at the identity value.
//  (g) `screenEdgeFade` is now APPLIED on the mirror path. Upstream only fades hits
//      when `stochastic` is true (:1232), because its non-stochastic path has no
//      environment to blend toward. We have no environment either — so we fade to
//      black, which is the only correct option and is what makes a reflection stop
//      popping when its source pixel leaves the screen. This also means
//      `screenEdgeFadeBlack` (:559, another rebuild-on-assign constant) does not
//      exist here: black is the only branch that can be taken.
//  (h) `_cameraWorldMatrix` / `_cameraWorldPosition` DELETED. Upstream used them
//      only to express the hit distance in world space (:1224-1225). A camera world
//      matrix is rigid, so `distance(worldPos, hitWorldPos) === distance(viewPos, vP)`
//      exactly. Same number, one fewer per-frame uniform upload.
//  (i) The march step count is CLAMPED to `MAX_STEPS` on the mirror path too.
//      Upstream bounds only the scatter path (:1059-1061); the mirror path spends
//      `rayLength * quality` steps with no ceiling, and a grazing reflection on a
//      wet street spans the screen — ~225 iterations per pixel at half res. With
//      (f) concentrating the budget near the ray origin, 64 steps is the right
//      trade and it is what makes the cost figure in the brief achievable.
//  (j) `metalnessNode` is the MASK. Upstream's mirror path uses metalness as the
//      reflection weight (`finalSampleWeight = vec3(metalness)`, :930); our mask is
//      exactly that quantity, so wetness attenuates the reflection for free.
//  (k) `historyTexture` / `velocityTexture` multi-bounce (:993-1004) DELETED. It
//      needs a denoised previous frame, and the denoiser stack is out of scope.
//  (l) The environment fallback DELETED with `ImportanceSampledEnvironment`. Misses
//      are black. This project's sky is procedural (world/sky.ts); there is no
//      equirect HDR with CPU-side `image.data` for the CDF tables to be built from.
//  (m) Sampling of FILTERABLE textures inside conditional control flow uses an
//      explicit LOD (the caller's `colourAt`/`normalAt`/`maskAt` closures pass
//      `.level(0)`). WGSL's uniformity analysis rejects `textureSample` reached
//      through a non-uniform `Break`; `textureSampleLevel` is legal anywhere. The
//      depth tap needs no such care — depth is FloatType, which is unfilterable, so
//      three already emits `textureSampleLevel` for it (WGSLNodeBuilder.js:828).
//  (n) One `resetRendererState`/`restoreRendererState` envelope around ALL SIX
//      passes rather than per-quad, matching upstream's `updateBefore` and the
//      contact-shadow complement's discipline.
//
// WHAT IS STILL BAKED, and therefore still a `recompileKeys` entry:
//   `blurQuality` — `boxBlur`'s `(size*2+1)²` loop bounds must be constants.
//   `binaryRefine` — an 8-iteration bisection whose presence changes the graph.
// Both are behind an explicit Apply button in the panel; neither is ever a live
// slider, because a codegen window HOLDS PRESENTED FRAMES in this renderer.
import * as THREE from "three/webgpu"
import * as TSL from "three/tsl"
import { createStageQuad, type StageQuad } from "../../shared/fullscreen"
import { isGeometryDepth } from "../../shared/reversedDepth"
import type { N } from "../../types"
import { boxBlur } from "./boxBlur"
import { bindAnalyticNoise } from "./rnoise"
import { getSpecularDominantFactor, ggxReflectionSample } from "./specularHelpers"

// See ./boxBlur.ts for why the TSL namespace is taken loose in one place.
const {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  bool,
  cross,
  div,
  dot,
  float,
  getScreenPosition,
  getViewPosition,
  int,
  luminance,
  max,
  min,
  mix,
  mul,
  normalize,
  perspectiveDepthToViewZ,
  reference,
  reflect,
  sub,
  texture,
  trunc,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} = TSL as unknown as Record<string, N>

/** Upstream's per-ray ceiling. See deviation (i) — we apply it to both paths. */
const MAX_STEPS = 64

/** Mip levels in the roughness-blur chain. Level 0 is an unblurred copy. */
const BLUR_LEVELS = 5

/**
 * Smallest blur-target edge that can legally hold {@link BLUR_LEVELS} mips.
 *
 * `Textures.js:502-512` allocates exactly `texture.mipmaps.length` levels, and
 * WebGPU rejects a `mipLevelCount` larger than `floor(log2(maxEdge)) + 1`. A
 * pathologically small window — the chain runs input × 0.5, so a ~50 px tall
 * canvas gets here — would otherwise fail texture creation rather than degrade.
 */
export const MIN_SSR_TARGET_EDGE = 1 << (BLUR_LEVELS - 1)

export type MaskedSsrDeps = {
  readonly renderer: THREE.WebGPURenderer
  readonly camera: THREE.PerspectiveCamera
  /** Chain colour at `uv`, vec4, LOD-explicit. See deviation (m). */
  readonly colourAt: (uv: N) => N
  /** Raw beauty depth at `uv`, float. Reversed-Z: background 0.0, near 1.0. */
  readonly depthAt: (uv: N) => N
  /** View-space normal at `uv`, already normalized, LOD-explicit. */
  readonly normalAt: (uv: N) => N
  /** SSR reflectivity mask at `uv`, 0..1, LOD-explicit. THE MASK. */
  readonly maskAt: (uv: N) => N
  /** Perceptual roughness at `uv`, 0..1. Drives the blur mip and the GGX lobe. */
  readonly roughnessAt: (uv: N) => N
  /** Half-res reflection buffer. Owned and sized by the chain. */
  readonly ssrTarget: THREE.RenderTarget
  /** Roughness-blur mip chain. Owned and sized by the chain. */
  readonly blurTarget: THREE.RenderTarget
  /** Baked. `false` = one mirror ray + blur chain (first-generation SSR). */
  readonly stochastic?: boolean
  /** Baked — a `recompileKeys` entry. */
  readonly binaryRefine?: boolean
  /** Baked — a `recompileKeys` entry. Kernel half-width, [1,3]. */
  readonly blurQuality?: number
}

export class MaskedSsr {
  readonly #deps: MaskedSsrDeps
  readonly #stochastic: boolean
  #binaryRefine: boolean
  #blurQuality: number

  // ---- live uniforms. None of these can ever trigger a rebuild. -------------
  /** Reflection strength multiplier. */
  readonly intensity = uniform(1) as N
  /** How far, in metres, a fragment may reflect. Upstream defaults to 1, which is
   *  useless at city scale; the stage ships 18. */
  readonly maxDistance = uniform(18) as N
  /** Depth-crossing acceptance window. */
  readonly thickness = uniform(0.12) as N
  /** Screen-edge fade width in UV units. 0 disables. See deviation (g). */
  readonly screenEdgeFade = uniform(0.22) as N
  /** Firefly clamp on the gathered radiance. */
  readonly maxLuminance = uniform(8) as N
  /** 0..1 → per-ray step budget. */
  readonly quality = uniform(0.45) as N
  /** Below this the kernel discards, first statement. THE MASK THRESHOLD. */
  readonly maskThreshold = uniform(0.02) as N
  /** Non-linear step distribution. 1 = upstream's uniform march. Deviation (f). */
  readonly stepExponent = uniform(2) as N
  /** GGX lobe tightening; scatter path only. */
  readonly mirrorBias = uniform(0.5) as N
  /** 1 while the stage renders, 0 the frame it stops. Consumers multiply by it so
   *  a skipped stage reads as no reflection rather than as last frame's. */
  readonly active = uniform(0) as N

  readonly #resolution = uniform(new THREE.Vector2(1, 1)) as N
  readonly #blurSpread = uniform(1) as N
  readonly #noiseIndex = uniform(0) as N
  readonly #projection: N
  readonly #projectionInverse: N
  readonly #near: N
  readonly #far: N

  readonly #ssrQuad: StageQuad
  readonly #copyQuad: StageQuad
  readonly #blurQuad: StageQuad
  readonly #blurTexture: N

  #rendererState: any = undefined

  constructor(deps: MaskedSsrDeps) {
    this.#deps = deps
    this.#stochastic = deps.stochastic === true
    this.#binaryRefine = deps.binaryRefine === true
    this.#blurQuality = deps.blurQuality ?? 2

    const { camera } = deps
    // Object-reference uniforms: they re-upload every frame, so they track the
    // TAA jitter without anybody having to remember to push them. The march
    // reconstructs view positions with the inverse and re-projects with the
    // forward matrix, so both must come from the same (jittered) projection or
    // the ray lands a fraction of a pixel off its own surface.
    this.#projection = uniform(camera.projectionMatrix) as N
    this.#projectionInverse = uniform(camera.projectionMatrixInverse) as N
    // `reference`, not `uniform(camera.near)` — a value uniform snapshots the
    // number and never notices the camera changing its clip planes.
    this.#near = reference("near", "float", camera) as N
    this.#far = reference("far", "float", camera) as N

    // Manual mip chain. `mipmaps.length > 0` is what makes Textures.js allocate
    // levels (Textures.js:502-512) AND what suppresses auto-generation
    // (Textures.js:359), so pushing placeholders is both halves of the contract.
    // The chain's target pool cannot express this, so state it here, once.
    const blurTexture = deps.blurTarget.texture
    const mipmaps = blurTexture.mipmaps as unknown as unknown[]
    if (mipmaps.length === 0) {
      for (let i = 0; i < BLUR_LEVELS; i++) mipmaps.push({})
    }
    blurTexture.minFilter = THREE.LinearMipmapLinearFilter
    blurTexture.magFilter = THREE.LinearFilter
    blurTexture.needsUpdate = true

    this.#ssrQuad = createStageQuad("post_ssr")
    this.#copyQuad = createStageQuad("post_ssr_copy")
    this.#blurQuad = createStageQuad("post_ssr_blur")
    this.#blurTexture = texture(blurTexture) as N

    this.#copyQuad.setFragment(texture(deps.ssrTarget.texture) as N)
    this.#buildSsrMaterial()
    this.#buildBlurMaterial()
  }

  /** Every quad whose WGSL must exist before the first live frame. */
  get quads(): THREE.QuadMesh[] {
    return [this.#ssrQuad.mesh, this.#copyQuad.mesh, this.#blurQuad.mesh]
  }

  /**
   * Roughness-blurred reflection radiance at `uv`, scene-linear, ready to ADD.
   *
   * Mask-weighted and intensity-scaled HERE, exactly once — see deviation (j) for
   * why the buffer itself is unweighted. A consumer using this accessor must NOT
   * multiply by `gbuffer.reflectivityAt(uv)` as well; a consumer sampling the raw
   * texture MUST.
   *
   * Zero while the stage is skipped, because a skipped stage keeps its
   * last-rendered target contents and `active` is the only thing that knows.
   */
  reflectionAt(uvNode: N): N {
    const maxLevel = BLUR_LEVELS - 1
    // r² rather than r: perceptual roughness maps to lobe width quadratically, so
    // a nearly-smooth wet surface stays on the sharp mips where it belongs.
    const roughness = this.#deps.roughnessAt(uvNode)
    const lod = roughness.mul(roughness).mul(maxLevel).clamp(0, maxLevel)
    return this.#blurTexture
      .sample(uvNode)
      .level(lod)
      .rgb.mul(this.#deps.maskAt(uvNode))
      .mul(this.active)
  }

  /** The texture a consumer samples directly. Level 0 is the unblurred copy, so
   *  an implicit-LOD fullscreen sample of it is exactly the raw reflection. */
  get reflectionTexture(): THREE.Texture {
    return this.#deps.blurTarget.texture
  }

  /** Pass resolution in pixels. The chain owns the render targets' sizes. */
  setSize(width: number, height: number): void {
    ;(this.#resolution.value as THREE.Vector2).set(Math.max(1, width), Math.max(1, height))
  }

  /** Rebuild the baked graphs. Only ever reached through an explicit Apply.
   *  Returns true when a graph actually changed, i.e. when the caller owes the
   *  compile gate a `compileFullscreenQuads()` before the next presented frame. */
  rebuild(options: { blurQuality?: number; binaryRefine?: boolean }): boolean {
    let dirty = false
    if (options.binaryRefine !== undefined && options.binaryRefine !== this.#binaryRefine) {
      this.#binaryRefine = options.binaryRefine
      this.#buildSsrMaterial()
      dirty = true
    }
    if (options.blurQuality !== undefined && options.blurQuality !== this.#blurQuality) {
      this.#blurQuality = options.blurQuality
      this.#buildBlurMaterial()
      dirty = true
    }
    return dirty
  }

  /**
   * One SSR pass, one copy, four blur mips. Called ONLY by the stage, from the
   * chain driver, with no render pass open.
   */
  render(renderer: THREE.WebGPURenderer): void {
    this.#rendererState = THREE.RendererUtils.resetRendererState(renderer, this.#rendererState)
    try {
      renderer.setMRT(null)
      // Transparent black: discarded pixels (the whole frame on a dry day) keep
      // the clear, and the consumer adds rgb, so black is the identity.
      renderer.setClearColor(0x000000, 0)

      if (this.#stochastic) {
        this.#noiseIndex.value = (this.#noiseIndex.value + 1) % 0x7fffffff
      }

      renderer.setRenderTarget(this.#deps.ssrTarget)
      this.#ssrQuad.mesh.render(renderer)

      // Level 0 is an unblurred copy so a mirror surface keeps its detail; each
      // higher level widens the same single-pass box kernel by its separation
      // rather than by more taps, which is why the chain costs 4 passes and not
      // a progressive downsample.
      for (let level = 0; level < BLUR_LEVELS; level++) {
        this.#blurSpread.value = level
        renderer.setRenderTarget(this.#deps.blurTarget, 0, level)
        ;(level === 0 ? this.#copyQuad : this.#blurQuad).mesh.render(renderer)
      }
    } finally {
      THREE.RendererUtils.restoreRendererState(renderer, this.#rendererState)
    }
  }

  dispose(): void {
    this.#ssrQuad.dispose()
    this.#copyQuad.dispose()
    this.#blurQuad.dispose()
  }

  // ------------------------------------------------------------------ graphs

  #buildBlurMaterial(): void {
    this.#blurQuad.setFragment(
      boxBlur(texture(this.#deps.ssrTarget.texture), {
        size: this.#blurQuality,
        separation: this.#blurSpread
      }) as N
    )
  }

  #buildSsrMaterial(): void {
    const d = this.#deps
    const stochastic = this.#stochastic
    const binaryRefine = this.#binaryRefine
    // Deviation (c): the helper reads only `builder.renderer.reversedDepthBuffer`.
    const builderShim = { renderer: d.renderer }

    const pointToLineDistance = Fn(([point, linePointA, linePointB]: N[]): N =>
      cross(point.sub(linePointA), point.sub(linePointB))
        .length()
        .div(linePointB.sub(linePointA).length())
    )

    const pointPlaneDistance = Fn(([point, planePoint, planeNormal]: N[]): N => {
      // planeNormal is already normalized, so the denominator is 1.
      const dPlane = mul(planeNormal.x, planePoint.x)
        .add(mul(planeNormal.y, planePoint.y))
        .add(mul(planeNormal.z, planePoint.z))
        .negate()
        .toVar()
      return mul(planeNormal.x, point.x)
        .add(mul(planeNormal.y, point.y))
        .add(mul(planeNormal.z, point.z))
        .add(dPlane)
    })

    // Reversed-aware by construction (ViewportDepthNode.js:229). Raw depth →
    // viewZ is the safe direction of three's asymmetric helper pair; this stage
    // never converts back, so it lives entirely in ONE depth space.
    const getViewZ = (depth: N): N => perspectiveDepthToViewZ(depth, this.#near, this.#far)

    const sampleMarchNoise = stochastic ? bindAnalyticNoise(this.#resolution, 47) : null

    const computeScreenBorderFactor = Fn(([uvCoord, borderWidth]: N[]): N => {
      const border = borderWidth.max(1e-4)
      // Distance to the nearest screen edge — uniform falloff at corners.
      const edgeDist = min(
        min(uvCoord.x, float(1).sub(uvCoord.x)),
        min(uvCoord.y, float(1).sub(uvCoord.y))
      )
      // Two smoothsteps for a softer ease-in-out than a single ramp.
      return edgeDist.smoothstep(0, border).smoothstep(0, 1).pow(0.125)
    }).setLayout({
      name: "computeScreenBorderFactor",
      type: "float",
      inputs: [
        { name: "uvCoord", type: "vec2" },
        { name: "borderWidth", type: "float" }
      ]
    })

    const kernel = Fn(() => {
      const uvPos = uv().toVar()

      // ─── THE MASK ─────────────────────────────────────────────────────────
      // FIRST statement, before the depth tap, before anything. This is the
      // entire economic argument for the stage: on a dry SF afternoon nothing
      // has opted in via writeSsrMask(), so every pixel costs one RGBA8 fetch
      // and a discard. It also subsumes upstream's background test — the
      // g-buffer clears to zero, so sky is masked out here — but the depth test
      // below is kept anyway, because "the mask happens to be zero on sky" is a
      // property of the clear colour, not a contract.
      const mask = d.maskAt(uvPos).toVar()
      mask.lessThan(this.maskThreshold).discard()

      const depth = d.depthAt(uvPos).toVar()
      // Reversed depth: background is 0.0. Upstream's `.greaterThanEqual(1.0)`
      // here would discard NEAR geometry and shade the sky instead.
      isGeometryDepth(builderShim, depth).not().discard()

      const viewPosition = getViewPosition(uvPos, depth, this.#projectionInverse).toVar()
      const viewNormal = d.normalAt(uvPos).toVar()
      const viewIncidentDir = normalize(viewPosition).toVar()

      // Hoisted above the branch because the march's step jitter reads `.z` and
      // the GGX lobe reads `.xyw` — one four-dimensional draw per pixel, not two.
      // Arithmetic, not `mx_noise`, so it is safe anywhere including inside an
      // `If()` (the project's noise rule, postfx.ts:44-51).
      const noise = sampleMarchNoise === null ? null : sampleMarchNoise(uvPos, this.#noiseIndex).toVar()

      const roughness = d.roughnessAt(uvPos).toVar()
      const glossiness = min(roughness.div(0.25), 1).oneMinus()
      const V = viewIncidentDir.negate().normalize().toVar()

      let viewReflectDir: N
      let finalSampleWeight: N
      let specDominantFactor: N

      if (stochastic === false) {
        viewReflectDir = reflect(viewIncidentDir, viewNormal).normalize().toVar()
        // Deviation (j). Upstream weights the mirror path by metalness, which
        // this g-buffer does not carry — the equivalent quantity is the mask.
        // But the mask belongs to the RECEIVING surface, and every consumer
        // already has it at the receiving pixel (`gbuffer.reflectivityAt(uv)`,
        // which composite/index.ts:144 multiplies in). Applying it here too
        // would square it and erase the damp end of the swash band, so this
        // buffer holds UNWEIGHTED mirror radiance and the mask is applied
        // exactly once, at the consumer. `reflectionAt()` does the same.
        finalSampleWeight = vec3(1)
        specDominantFactor = float(1)
      } else {
        const Xi = noise!.toVar()
        // Mirror-bias: pull Xi.y toward the cap top to tighten the GGX lobe and
        // cut mid-roughness noise. Unbiased — bounded VNDF keeps brdf·cos/pdf
        // roughly constant (EA, "Stochastic SSR").
        Xi.y.assign(mix(Xi.y, 0.0, this.mirrorBias.mul(Xi.w.sqrt())))

        const albedo = vec3(1).toVar()
        const ggxSample = ggxReflectionSample(viewNormal, V, roughness, mask, albedo, Xi).toVar()
        If(ggxSample.get("reflectDir").dot(viewNormal).lessThan(0), () => {
          ggxSample.assign(
            ggxReflectionSample(viewNormal, V, roughness, mask, albedo, Xi.add(Xi.mul(7)).fract())
          )
        })
        // The mask reaches the lobe as metalness (it tints `f0`), and the linear
        // weight is applied once at the consumer — same contract as the mirror
        // path above.
        viewReflectDir = ggxSample.get("reflectDir").toVar()
        finalSampleWeight = ggxSample.get("sampleWeight").toVar()
        specDominantFactor = getSpecularDominantFactor(ggxSample.get("NdotV"), roughness).toVar()
      }

      const maxReflectRayLen = this.maxDistance
        .div(dot(viewIncidentDir.negate(), viewNormal))
        .toVar()
      const d1viewPosition = viewPosition.add(viewReflectDir.mul(maxReflectRayLen)).toVar()

      // Clamp the ray end to the near plane so the screen-space projection below
      // stays finite.
      If(d1viewPosition.z.greaterThan(this.#near.negate()), () => {
        const t = sub(this.#near.negate(), viewPosition.z).div(viewReflectDir.z)
        d1viewPosition.assign(viewPosition.add(viewReflectDir.mul(t)))
      })

      const d0 = uvPos.mul(this.#resolution).xy.toVar()
      const d1 = getScreenPosition(d1viewPosition, this.#projection).mul(this.#resolution).toVar()

      const xLen = d1.x.sub(d0.x).toVar()
      const yLen = d1.y.sub(d0.y).toVar()

      // Dominant-axis ray length in texels, used for the one-texel step floor.
      const rayLen = max(xLen.abs(), yLen.abs()).max(1).toVar()

      // Deviation (i): both paths are capped. Upstream's mirror path spends
      // `rayLength × quality` steps with no ceiling, and a grazing reflection on
      // a wet street spans the screen.
      const totalStep = int(
        stochastic === false
          ? min(trunc(max(abs(xLen), abs(yLen)).mul(this.quality.clamp())), float(MAX_STEPS))
              .max(int(1))
              .toConst()
          : this.quality.clamp().mul(MAX_STEPS).max(float(1))
      ).toConst()

      const stepVec = vec2(xLen.div(totalStep), yLen.div(totalStep)).toVar()
      const invResolution = vec2(float(1), float(1)).div(this.#resolution).toVar()
      const uvPixelStepX = vec2(invResolution.x, float(0)).toVar()

      const output = vec4(0).toVar()

      // Reflected-ray view-space Z at ray parameter s ∈ [0,1] — linear in 1/z for
      // a perspective camera. Hoisted so the march and the refinement evaluate it
      // identically.
      const recipVPZ = float(1).div(viewPosition.z).toConst()
      const recipD1VPZ = float(1).div(d1viewPosition.z).toConst()
      const reflectRayZAt = (sVal: N): N =>
        float(1).div(recipVPZ.add(sVal.mul(recipD1VPZ.sub(recipVPZ))))

      const screenPosAt = (sVal: N): N => d0.add(stepVec.mul(sVal.mul(totalStep)))

      // Deviation (f): the exponential remap now drives BOTH paths, with the
      // exponent as a uniform. `(idx/steps)^e` concentrates samples near the ray
      // origin — where short-range reflections are missed — and the `idx/rayLen`
      // floor keeps every step at least one texel long so the near end does not
      // waste iterations re-sampling the same texel. At `e === 1` this collapses
      // to upstream's uniform march, because `totalStep <= rayLen` always.
      const sampleFraction = (idx: N): N => {
        // The scatter path dissolves step banding with a sub-step jitter; the
        // mirror path is deterministic, because it has no downstream denoiser to
        // resolve the noise it would introduce.
        const base = noise === null ? idx : idx.add(noise.z.sub(0.5))
        return max(base.div(totalStep).pow(this.stepExponent), idx.div(rayLen))
      }

      // The hit is carried OUT of the loop so refinement runs after the march
      // rather than nested inside it — a loop inside a loop tripped shader
      // compiler bugs on some drivers (upstream's note, kept).
      const foundHit = bool(false).toVar()
      const hitSLo = float(0).toVar()
      const hitSHi = float(0).toVar()
      const hitUvS = vec2(0).toVar()
      const hitD = float(0).toVar()

      Loop({ start: int(1), end: totalStep }, ({ i }: N) => {
        const s = sampleFraction(float(i)).toVar()
        const xy = screenPosAt(s).toVar()

        If(
          xy.x
            .lessThan(0)
            .or(xy.x.greaterThan(this.#resolution.x))
            .or(xy.y.lessThan(0))
            .or(xy.y.greaterThan(this.#resolution.y)),
          () => {
            Break()
          }
        )

        const uvS = xy.mul(invResolution).toVar()
        const dSample = d.depthAt(uvS).toVar()
        const vZ = getViewZ(dSample).toVar()
        const viewReflectRayZ = reflectRayZAt(s).toVar()

        // Already correct under reversed depth: `getViewZ` routes through the
        // reversed-aware `perspectiveDepthToViewZ`, so both sides of this compare
        // are view-space Z. Do NOT "fix" it.
        If(viewReflectRayZ.lessThanEqual(vZ), () => {
          // Depth crossing. Gate by thickness before stopping, so a gap between
          // occluders does not end the march prematurely.
          const vP = getViewPosition(uvS, dSample, this.#projectionInverse).toVar()
          const away = pointToLineDistance(vP, viewPosition, d1viewPosition).toVar()

          const uvNeighbor = uvS.add(uvPixelStepX).toVar()
          const vPNeighbor = getViewPosition(uvNeighbor, dSample, this.#projectionInverse).toVar()
          const minThickness = vPNeighbor.x.sub(vP.x).mul(3).toVar()
          const tk = max(minThickness, this.thickness).toVar()

          If(away.lessThanEqual(tk), () => {
            if (stochastic === false) {
              const vN = d.normalAt(uvS).toVar()
              // The reflected ray points at the same side as the hit surface's
              // own normal, so it could not have reflected off it.
              If(dot(viewReflectDir, vN).greaterThanEqual(0), () => {
                Continue()
              })

              const planeDistance = pointPlaneDistance(vP, viewPosition, viewNormal).toVar()
              If(planeDistance.greaterThan(this.maxDistance), () => {
                Break()
              })
            }

            foundHit.assign(true)
            hitUvS.assign(uvS)
            hitD.assign(dSample)

            if (binaryRefine) {
              hitSLo.assign(sampleFraction(float(i).sub(1)))
              hitSHi.assign(s)
            }

            Break()
          })
        })
      })

      If(foundHit, () => {
        if (binaryRefine) {
          Loop({ start: int(0), end: int(8), type: "int", condition: "<" }, () => {
            const sMid = hitSLo.add(hitSHi).mul(0.5).toVar()
            const sceneZMid = getViewZ(d.depthAt(screenPosAt(sMid).mul(invResolution)))
            If(reflectRayZAt(sMid).lessThanEqual(sceneZMid), () => {
              hitSHi.assign(sMid)
            }).Else(() => {
              hitSLo.assign(sMid)
            })
          })
          hitUvS.assign(screenPosAt(hitSHi).mul(invResolution))
          hitD.assign(d.depthAt(hitUvS))
        }

        const uvS = hitUvS
        const vP = getViewPosition(uvS, hitD, this.#projectionInverse).toVar()

        // In mirror mode the ratio² falloff re-grows past maxDistance, so
        // over-range hits are dropped rather than shaded. The scatter path bounds
        // its reach through the ray length instead.
        const distancePointPlane =
          stochastic === false
            ? pointPlaneDistance(vP, viewPosition, viewNormal).toVar()
            : float(0)

        If(distancePointPlane.lessThanEqual(this.maxDistance), () => {
          // Deviation (h): a camera world matrix is rigid, so the view-space
          // distance IS the world distance. Upstream round-tripped both points
          // through `_cameraWorldMatrix` to get the same number.
          const hitDistance = vP.sub(viewPosition).length().mul(specDominantFactor).toVar()

          const reflectColor = d.colourAt(uvS).toVar()

          let weightedColor = reflectColor.rgb.mul(finalSampleWeight)

          if (stochastic === false) {
            const ratio = float(1).sub(distancePointPlane.div(this.maxDistance)).toVar()
            const attenuation = ratio.mul(ratio).toVar()
            const fresnelCoe = div(dot(viewIncidentDir, viewReflectDir).add(1), 2).toVar()
            weightedColor = weightedColor.mul(attenuation.mul(fresnelCoe))
          }

          // Deviation (g): fade a hit whose SOURCE pixel is near a screen border.
          // Without this a reflection vanishes the instant its source scrolls off
          // screen, which is the single most recognisable SSR artefact. Faded by
          // the hit UV, widened by glossiness so a mirror fades later than a damp
          // surface does.
          const borderWidth = this.screenEdgeFade.mul(glossiness.max(0.25))
          weightedColor = weightedColor.mul(computeScreenBorderFactor(uvS, borderWidth))

          output.assign(vec4(weightedColor, hitDistance))
        })
      })

      // A miss keeps `output` at zero — deviation (l), there is no environment to
      // fall back to, and the consumer ADDS this buffer, so zero is the identity.
      // Upstream's `If( hit.equal( 0 ) )` block only existed to shade the env.
      const lum = luminance(output.rgb).max(1e-4).toVar()
      output.rgb.mulAssign(this.maxLuminance.div(lum).min(1))
      output.rgb.mulAssign(this.intensity)

      return output.max(0)
    })

    this.#ssrQuad.setFragment(kernel())
  }
}
