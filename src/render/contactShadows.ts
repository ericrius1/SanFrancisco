import * as THREE from "three/webgpu"
import {
  Continue,
  Fn,
  If,
  Loop,
  NodeUpdateType,
  float,
  getScreenPosition,
  getViewPosition,
  lightPosition,
  lightTargetPosition,
  passTexture,
  smoothstep,
  uniform,
  unpackRGBToNormal,
  uv,
  vec3,
  vec4
} from "three/tsl"

/**
 * A deliberately small complement to the clipmap shadows. It covers the
 * sub-metre gaps that shadow maps tend to lose (feet, wheels, rails and small
 * props), then fades away before the medium clipmap becomes the visual anchor.
 *
 * Cost at the default settings is bounded to one receiver-depth lookup plus six
 * ray taps over a half-width, half-height R8 target: 1.75 full-resolution depth
 * tap equivalents per frame, plus one filtered R8 sample in the final composite.
 * Hardware bilinear upsampling and derivative-only receiver-edge damping add no
 * texture lookups. There is no history, temporal jitter, random rotation or
 * frame state.
 */
export const CONTACT_SHADOW_DEFAULTS = Object.freeze({
  resolutionScale: 0.5,
  maxDistance: 0.8,
  thickness: 0.12,
  intensity: 0.14,
  fadeStart: 10,
  fadeEnd: 18,
  normalBias: 0.012,
  samples: 6 as ContactShadowSampleCount
})

/** Fixed stability shaping, deliberately not another set of runtime knobs. */
export const CONTACT_SHADOW_STABILITY = Object.freeze({
  rayExponent: 1.35,
  evidenceWeightBase: 0.42,
  evidenceWeightFalloff: 0.14,
  depthLowerStartRatio: 0.025,
  depthLowerStartMin: 0.002,
  depthLowerFullRatio: 0.1,
  depthLowerFullMin: 0.007,
  depthUpperFullRatio: 0.65,
  receiverEdgeSlopeStart: 0.035,
  receiverEdgeSlopeEnd: 0.28,
  receiverEdgeMinFactor: 0.35
})

export type ContactShadowSampleCount = 4 | 6 | 8
export type ContactShadowNormalEncoding = "packed-rgb" | "view"

export type ContactShadowOptions = {
  /** Width and height scale of the R8 contact target. Default 0.5 = 1/4 pixels. */
  resolutionScale: number
  /** Maximum ray length in metres. Keep this below roughly one metre. */
  maxDistance: number
  /** Maximum accepted camera-depth gap around the marched ray, in metres. */
  thickness: number
  /** Maximum darkening applied to scene color. */
  intensity: number
  /** Camera distance at which contact shadows begin to fade. */
  fadeStart: number
  /** Camera distance at which the pass becomes neutral. */
  fadeEnd: number
  /** Receiver-normal offset used to suppress self-intersection. */
  normalBias: number
  /** Fixed compile-time ray budget. */
  samples: ContactShadowSampleCount
}

export type ContactShadowRuntimeOptions = Omit<ContactShadowOptions, "samples">

export type ContactShadowDependencies = {
  /** Depth TextureNode from an opaque scene/prepass. */
  depthTex?: any | null
  /** Optional view-space normal TextureNode; otherwise derive a stable flat normal from depth. */
  normalTex?: any | null
  /** The camera used to produce depthTex. */
  camera?: THREE.Camera | null
  /** The scene's sun/moon DirectionalLight. */
  light?: THREE.DirectionalLight | null
  normalEncoding?: ContactShadowNormalEncoding
  enabled?: boolean
  options?: Partial<ContactShadowOptions>
}

export type ContactShadowComplement = {
  /** False means apply() is an exact graph-level passthrough with zero GPU work. */
  readonly available: boolean
  readonly reason: string | null
  readonly pass: ContactShadowPassNode | null
  /** PassTextureNode, or null for the graph-level no-op. */
  readonly textureNode: any | null
  /** White/one when unavailable; otherwise the filtered R8 shadow factor. */
  readonly factorNode: any
  /** Sample the factor at an explicit UV (useful inside stylized post stages). */
  sample(sampleUv?: any): any
  /** Multiply only RGB, preserving the input alpha. */
  apply(sceneColor: any, sampleUv?: any): any
  /** Update live uniforms and resolution without rebuilding the node graph. */
  configure(options: Partial<ContactShadowRuntimeOptions>): void
  dispose(): void
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

const nearestSampleCount = (value: number): ContactShadowSampleCount => {
  if (value <= 5) return 4
  if (value <= 7) return 6
  return 8
}

const smooth01 = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-8), 0, 1)
  return t * t * (3 - 2 * t)
}

/** CPU reference for the shader's continuous lower/upper depth confidence. */
export function contactShadowDepthConfidence(depthDelta: number, thickness: number) {
  const s = CONTACT_SHADOW_STABILITY
  const safeThickness = clamp(thickness, 0.005, 0.5)
  const lowerStart = Math.max(s.depthLowerStartMin, safeThickness * s.depthLowerStartRatio)
  const lowerFull = Math.max(s.depthLowerFullMin, safeThickness * s.depthLowerFullRatio)
  const upperFull = safeThickness * s.depthUpperFullRatio
  return (
    smooth01(lowerStart, lowerFull, depthDelta) *
    (1 - smooth01(upperFull, safeThickness, depthDelta))
  )
}

/** CPU reference for the fixed shader accumulation; useful to regression-test stability. */
export function combineContactShadowEvidence(evidence: readonly number[]) {
  const s = CONTACT_SHADOW_STABILITY
  const count = Math.max(1, evidence.length)
  let visibility = 1
  for (let i = 0; i < evidence.length; i++) {
    const t = Math.pow((i + 1) / count, s.rayExponent)
    const weight = s.evidenceWeightBase - t * s.evidenceWeightFalloff
    visibility *= 1 - clamp(evidence[i], 0, 1) * weight
  }
  return 1 - visibility
}

/** Normalize user/tweak values once at the CPU boundary. */
export function normalizeContactShadowOptions(
  options: Partial<ContactShadowOptions> = {}
): ContactShadowOptions {
  const d = CONTACT_SHADOW_DEFAULTS
  const fadeStart = clamp(options.fadeStart ?? d.fadeStart, 1, 50)
  const fadeEnd = clamp(options.fadeEnd ?? d.fadeEnd, fadeStart + 0.25, 60)
  return {
    resolutionScale: clamp(options.resolutionScale ?? d.resolutionScale, 0.25, 1),
    maxDistance: clamp(options.maxDistance ?? d.maxDistance, 0.05, 2),
    thickness: clamp(options.thickness ?? d.thickness, 0.005, 0.5),
    intensity: clamp(options.intensity ?? d.intensity, 0, 1),
    fadeStart,
    fadeEnd,
    normalBias: clamp(options.normalBias ?? d.normalBias, 0, 0.1),
    samples: nearestSampleCount(options.samples ?? d.samples)
  }
}

/**
 * Fixed-budget, reversed-depth-safe screen-space sun shadow.
 *
 * This intentionally does not use Three's r185 SSSNode: that implementation
 * derives sampled view-Z with perspectiveDepthToViewZ(), assumes a clear depth
 * of one, and chooses a dynamic step count from projected ray length. This
 * project uses reversed depth and needs a hard upper cost bound. Here every
 * sampled point is reconstructed with the live inverse projection matrix, so
 * both regular and reversed projection matrices use the same code path.
 */
export class ContactShadowPassNode extends THREE.TempNode {
  static get type() {
    return "ContactShadowPassNode"
  }

  readonly maxDistance = uniform(CONTACT_SHADOW_DEFAULTS.maxDistance)
  readonly thickness = uniform(CONTACT_SHADOW_DEFAULTS.thickness)
  readonly intensity = uniform(CONTACT_SHADOW_DEFAULTS.intensity)
  readonly fadeStart = uniform(CONTACT_SHADOW_DEFAULTS.fadeStart)
  readonly fadeEnd = uniform(CONTACT_SHADOW_DEFAULTS.fadeEnd)
  readonly normalBias = uniform(CONTACT_SHADOW_DEFAULTS.normalBias)

  resolutionScale: number

  readonly #depthNode: any
  readonly #normalNode: any | null
  readonly #normalEncoding: ContactShadowNormalEncoding
  readonly #light: THREE.DirectionalLight
  readonly #sampleCount: ContactShadowSampleCount
  readonly #cameraViewMatrix: any
  readonly #cameraProjectionMatrix: any
  readonly #cameraProjectionMatrixInverse: any
  readonly #renderTarget: THREE.RenderTarget
  readonly #material: THREE.NodeMaterial
  readonly #quad: THREE.QuadMesh
  readonly #textureNode: any
  readonly #size = new THREE.Vector2()
  #rendererState: any = undefined
  #disposed = false

  constructor(
    depthNode: any,
    normalNode: any | null,
    camera: THREE.Camera,
    light: THREE.DirectionalLight,
    options: ContactShadowOptions,
    normalEncoding: ContactShadowNormalEncoding
  ) {
    super("float")
    this.updateBeforeType = NodeUpdateType.FRAME
    this.#depthNode = depthNode
    this.#normalNode = normalNode
    this.#normalEncoding = normalEncoding
    this.#light = light
    this.#sampleCount = options.samples
    this.resolutionScale = options.resolutionScale

    // Object-reference uniforms track matrices mutated in place by Three.
    this.#cameraViewMatrix = uniform(camera.matrixWorldInverse)
    this.#cameraProjectionMatrix = uniform(camera.projectionMatrix)
    this.#cameraProjectionMatrixInverse = uniform(camera.projectionMatrixInverse)

    this.#renderTarget = new THREE.RenderTarget(1, 1, {
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      // This single hardware-filtered lookup is the spatial softening stage;
      // keeping it here avoids a second fullscreen blur pass and its bandwidth.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false
    })
    this.#renderTarget.texture.name = "ContactShadowComplement"
    this.#material = new THREE.NodeMaterial()
    this.#material.name = "ContactShadowComplement"
    this.#quad = new THREE.QuadMesh(this.#material)
    this.#quad.name = "ContactShadowComplement"
    // @types/three narrows passTexture() to PassNode even though Three's own
    // GTAO/SSS TempNodes use this same public PassTextureNode pattern.
    this.#textureNode = passTexture(this as any, this.#renderTarget.texture)
    this.configure(options)
  }

  getTextureNode() {
    return this.#textureNode
  }

  configure(options: Partial<ContactShadowRuntimeOptions>) {
    const normalized = normalizeContactShadowOptions({
      resolutionScale: options.resolutionScale ?? this.resolutionScale,
      maxDistance: options.maxDistance ?? Number(this.maxDistance.value),
      thickness: options.thickness ?? Number(this.thickness.value),
      intensity: options.intensity ?? Number(this.intensity.value),
      fadeStart: options.fadeStart ?? Number(this.fadeStart.value),
      fadeEnd: options.fadeEnd ?? Number(this.fadeEnd.value),
      normalBias: options.normalBias ?? Number(this.normalBias.value),
      samples: this.#sampleCount
    })
    this.resolutionScale = normalized.resolutionScale
    this.maxDistance.value = normalized.maxDistance
    this.thickness.value = normalized.thickness
    this.intensity.value = normalized.intensity
    this.fadeStart.value = normalized.fadeStart
    this.fadeEnd.value = normalized.fadeEnd
    this.normalBias.value = normalized.normalBias
  }

  updateBefore(frame: any): boolean | undefined {
    if (this.#disposed) return undefined
    const renderer = frame.renderer as THREE.WebGPURenderer
    const size = renderer.getDrawingBufferSize(this.#size)
    const width = Math.max(1, Math.round(size.x * this.resolutionScale))
    const height = Math.max(1, Math.round(size.y * this.resolutionScale))
    if (this.#renderTarget.width !== width || this.#renderTarget.height !== height) {
      this.#renderTarget.setSize(width, height)
    }

    // Size allocation can throw on device loss. Do it before resetting renderer
    // state so every state mutation below is covered by the restoration guard.
    this.#rendererState = THREE.RendererUtils.resetRendererState(
      renderer,
      this.#rendererState
    )
    try {
      // Discarded sky/far pixels remain neutral white.
      renderer.setClearColor(0xffffff, 1)
      renderer.setRenderTarget(this.#renderTarget)
      this.#quad.render(renderer)
    } finally {
      THREE.RendererUtils.restoreRendererState(renderer, this.#rendererState)
    }
    return undefined
  }

  setup(builder: any) {
    const uvNode = uv()
    const reversedDepth = builder.renderer.reversedDepthBuffer === true
    const sampleDepth = (sampleUv: any) => this.#depthNode.sample(sampleUv).r
    const isGeometryDepth = (depth: any) =>
      reversedDepth ? depth.greaterThan(1e-7) : depth.lessThan(0.9999999)

    const evaluate = Fn(() => {
      const receiverDepth = sampleDepth(uvNode).toVar()
      isGeometryDepth(receiverDepth).not().discard()

      const receiverPosition = getViewPosition(
        uvNode,
        receiverDepth,
        this.#cameraProjectionMatrixInverse
      ).toVar("contactReceiverPosition")
      const cameraDistance = receiverPosition.length().toVar()
      cameraDistance.greaterThanEqual(this.fadeEnd).discard()

      const lightDirection = this.#cameraViewMatrix
        .transformDirection(
          lightPosition(this.#light).sub(lightTargetPosition(this.#light))
        )
        .normalize()
        .toConst("contactLightDirection")

      // Derivatives are shared by flat-normal reconstruction and a mild edge
      // confidence. Large receiver depth jumps are where quarter-resolution
      // bilinear upsampling would otherwise bleed a dark texel over silhouettes.
      const receiverDx = receiverPosition.dFdx()
      const receiverDy = receiverPosition.dFdy()
      const receiverDepthSlope = receiverDx.z
        .abs()
        .max(receiverDy.z.abs())
      const edgeStability = float(1).sub(
        smoothstep(
          CONTACT_SHADOW_STABILITY.receiverEdgeSlopeStart,
          CONTACT_SHADOW_STABILITY.receiverEdgeSlopeEnd,
          receiverDepthSlope
        ).mul(1 - CONTACT_SHADOW_STABILITY.receiverEdgeMinFactor)
      )

      let receiverNormal: any
      if (this.#normalNode !== null) {
        const sampledNormal = this.#normalNode.sample(uvNode).rgb
        receiverNormal =
          this.#normalEncoding === "packed-rgb"
            ? unpackRGBToNormal(sampledNormal).normalize()
            : sampledNormal.normalize()
      } else {
        // Same derivative normal used by Three's normalFlat accessor. This lets
        // the already-rendered beauty depth drive the pass without forcing the
        // separate ink normal prepass on, which is the faster default graph.
        receiverNormal = receiverDx.cross(receiverDy).normalize()
      }
      // Contact darkening is useful only on surfaces receiving direct light;
      // suppressing grazing/back faces avoids crushing already-shadowed color.
      const facing = smoothstep(
        0.025,
        0.22,
        receiverNormal.dot(lightDirection)
      )

      const rayStart = receiverPosition
        .add(receiverNormal.mul(this.normalBias))
        .toVar()
      // Visibility-product accumulation is a continuous saturating union. One
      // tap entering an occluder contributes only its bounded weight instead of
      // flipping the entire R8 pixel from neutral to maximum darkness.
      const visibility = float(1).toVar()
      const lowerStart = this.thickness
        .mul(CONTACT_SHADOW_STABILITY.depthLowerStartRatio)
        .max(CONTACT_SHADOW_STABILITY.depthLowerStartMin)
      const lowerFull = this.thickness
        .mul(CONTACT_SHADOW_STABILITY.depthLowerFullRatio)
        .max(CONTACT_SHADOW_STABILITY.depthLowerFullMin)
      const upperFull = this.thickness.mul(
        CONTACT_SHADOW_STABILITY.depthUpperFullRatio
      )

      // Fixed and deterministic. The power concentrates taps close to the
      // receiver where foot/wheel contact matters most without temporal noise.
      Loop(this.#sampleCount, ({ i }: any) => {
        const t = float(i)
          .add(1)
          .div(this.#sampleCount)
          .pow(CONTACT_SHADOW_STABILITY.rayExponent)
        const rayPosition = rayStart
          .add(lightDirection.mul(this.maxDistance).mul(t))
          .toVar()
        const sampleUv = getScreenPosition(
          rayPosition,
          this.#cameraProjectionMatrix
        ).toVar()

        If(
          sampleUv.x
            .lessThanEqual(0)
            .or(sampleUv.x.greaterThanEqual(1))
            .or(sampleUv.y.lessThanEqual(0))
            .or(sampleUv.y.greaterThanEqual(1)),
          () => Continue()
        )

        const sceneDepth = sampleDepth(sampleUv).toVar()
        If(isGeometryDepth(sceneDepth).not(), () => Continue())

        const scenePosition = getViewPosition(
          sampleUv,
          sceneDepth,
          this.#cameraProjectionMatrixInverse
        ).toVar()
        // View Z is negative. A positive delta means visible geometry lies in
        // front of the ray; the thickness limit rejects unrelated foreground.
        const depthDelta = scenePosition.z.sub(rayPosition.z).toVar()
        const depthConfidence = smoothstep(
          lowerStart,
          lowerFull,
          depthDelta
        ).mul(
          smoothstep(upperFull, this.thickness, depthDelta).oneMinus()
        )
        const tapWeight = float(
          CONTACT_SHADOW_STABILITY.evidenceWeightBase
        ).sub(t.mul(CONTACT_SHADOW_STABILITY.evidenceWeightFalloff))
        visibility.mulAssign(
          float(1).sub(depthConfidence.mul(tapWeight))
        )
      })

      const occlusion = visibility.oneMinus()
      const distanceFade = smoothstep(
        this.fadeStart,
        this.fadeEnd,
        cameraDistance
      ).oneMinus()
      return occlusion
        .mul(this.intensity)
        .mul(distanceFade)
        .mul(facing)
        .mul(edgeStability)
        .oneMinus()
    })

    this.#material.fragmentNode = evaluate().context(builder.getSharedContext())
    this.#material.needsUpdate = true
    return this.#textureNode
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#renderTarget.dispose()
    this.#material.dispose()
  }
}

const unavailableComplement = (reason: string): ContactShadowComplement => {
  const neutral = float(1)
  return {
    available: false,
    reason,
    pass: null,
    textureNode: null,
    factorNode: neutral,
    sample: () => neutral,
    apply: (sceneColor: any) => sceneColor,
    configure: () => undefined,
    dispose: () => undefined
  }
}

/**
 * Build the optional complement. Missing buffers/light/camera return a strict
 * passthrough, so callers can use one integration path across reduced modes.
 *
 * Integration:
 *
 *   const contacts = createContactShadowComplement({
 *     depthTex: prePassDepth,
 *     normalTex: prePassNormal,
 *     camera,
 *     light: sky.sun
 *   })
 *   renderPipeline.outputNode = contacts.apply(sceneColor)
 */
export function createContactShadowComplement(
  dependencies: ContactShadowDependencies
): ContactShadowComplement {
  if (dependencies.enabled === false) {
    return unavailableComplement("disabled")
  }
  if (dependencies.depthTex == null) {
    return unavailableComplement("depth buffer unavailable")
  }
  if (dependencies.camera == null) {
    return unavailableComplement("camera unavailable")
  }
  if (
    dependencies.light == null ||
    dependencies.light.isDirectionalLight !== true
  ) {
    return unavailableComplement("directional light unavailable")
  }

  const options = normalizeContactShadowOptions(dependencies.options)
  const pass = new ContactShadowPassNode(
    dependencies.depthTex,
    dependencies.normalTex ?? null,
    dependencies.camera,
    dependencies.light,
    options,
    dependencies.normalEncoding ?? "packed-rgb"
  )
  const textureNode = pass.getTextureNode()
  const factorNode = textureNode.r
  const sample = (sampleUv?: any) =>
    sampleUv === undefined ? factorNode : textureNode.sample(sampleUv).r

  return {
    available: true,
    reason: null,
    pass,
    textureNode,
    factorNode,
    sample,
    // Preserve alpha so this can wrap linear HDR scene color before any of the
    // existing renderOutput/stylized post stages.
    apply: (sceneColor: any, sampleUv?: any) =>
      sceneColor.mul(vec4(vec3(sample(sampleUv)), 1)),
    configure: (runtimeOptions) => pass.configure(runtimeOptions),
    dispose: () => pass.dispose()
  }
}
