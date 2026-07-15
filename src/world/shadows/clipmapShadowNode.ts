import * as THREE from "three/webgpu"
import {
  Fn,
  If,
  mix,
  nodeObject,
  positionWorld,
  renderGroup,
  smoothstep,
  uniform,
  vec4
} from "three/tsl"
import {
  ShadowDiagnostics,
  SHADOW_UPDATE_REASON,
  type ShadowUpdateReason
} from "./diagnostics"
import { SHADOW_LAYERS, type ShadowLayer } from "./shadowLayers"
import type { FarOcclusionField } from "./farOcclusionField"
import { SHADOW_DEFAULTS } from "./defaults"
import { CLIPMAP_SHADOW_EDGES } from "./edgeConfig"
import { SHADOW_TUNING } from "./tuning"
import { composeRasterAtlasVisibility } from "./visibilityComposition"

export const CLIPMAP_SHADOW_CONFIG = {
  hero: {
    extent: 32,
    resolution: 1024,
    depth: 480,
    normalBias: SHADOW_DEFAULTS.heroNormalBias,
    depthBias: SHADOW_DEFAULTS.heroDepthBias,
    anchorStep: 0,
    sunAngle: 0,
    layer: SHADOW_LAYERS.HERO_DYNAMIC
  },
  local: {
    extent: 96,
    resolution: 1536,
    depth: 900,
    normalBias: SHADOW_DEFAULTS.localNormalBias,
    depthBias: SHADOW_DEFAULTS.localDepthBias,
    // Cached projections stay world-correct while the subject moves. Recenter
    // only before the 6 m local→far guard band is consumed.
    anchorStep: 4.5,
    sunAngle: THREE.MathUtils.degToRad(0.05),
    layer: SHADOW_LAYERS.LOCAL_STATIC
  },
  far: {
    extent: 1024,
    resolution: 1024,
    depth: 1800,
    normalBias: SHADOW_DEFAULTS.farNormalBias,
    depthBias: SHADOW_DEFAULTS.farDepthBias,
    anchorStep: 8,
    sunAngle: THREE.MathUtils.degToRad(0.15),
    layer: SHADOW_LAYERS.FAR_PROXY
  }
} as const

/**
 * Projection samples must be fully retired before a PCF footprint touches a
 * map boundary. Ending a fade at (or beyond) the camera extent can still expose
 * a clamped edge texel as a long screen-space wedge under a grazing sun.
 */
type DomainId = keyof typeof CLIPMAP_SHADOW_CONFIG
export type StaticShadowScope = "local" | "far" | "all"
type DomainConfig = (typeof CLIPMAP_SHADOW_CONFIG)[DomainId]
type N = any

/** Render one domain and record only completed map updates. */
class DomainShadowNode extends THREE.ShadowNode {
  readonly #onRendered: () => void

  constructor(
    light: THREE.Light,
    shadowConfig: THREE.DirectionalLight["shadow"],
    onRendered: () => void
  ) {
    super(light, shadowConfig)
    this.#onRendered = onRendered
  }

  renderShadow(frame: any): void {
    // A ShadowNode reached from Renderer.render() is nested after r185's outer
    // scene matrix walk. Skip that redundant walk for each shadow domain. The
    // compileAsync path never increments _callDepth and may only update its
    // compile object—not frame.scene—so it deliberately retains the base walk.
    const renderer = frame.renderer as THREE.WebGPURenderer & { _callDepth?: number }
    if (!(Number(renderer._callDepth) > 0)) {
      ;(THREE.ShadowNode.prototype as any).renderShadow.call(this, frame)
      return
    }
    const scene = frame.scene as THREE.Scene
    const previousAutoUpdate = scene.matrixWorldAutoUpdate
    try {
      scene.matrixWorldAutoUpdate = false
      ;(THREE.ShadowNode.prototype as any).renderShadow.call(this, frame)
    } finally {
      scene.matrixWorldAutoUpdate = previousAutoUpdate
    }
  }

  updateShadow(frame: any): void {
    // Completion means the whole base update finished: depth render, optional
    // VSM, camera-layer restoration, and renderer/scene state restoration.
    ;(THREE.ShadowNode.prototype as any).updateShadow.call(this, frame)
    this.#onRendered()
  }
}

/** A non-illuminating directional-light stand-in owned only by ShadowNode. */
class ProjectionLight extends THREE.Object3D {
  readonly target = new THREE.Object3D()
  readonly shadow: THREE.DirectionalLight["shadow"]
  castShadow = true

  constructor(shadowConfig: THREE.DirectionalLight["shadow"]) {
    super()
    this.shadow = shadowConfig
  }
}

type Domain = {
  id: DomainId
  config: DomainConfig
  light: ProjectionLight
  node: N
  initialized: boolean
  lastAnchor: THREE.Vector3
  lastSunDir: THREE.Vector3
  lastStaticRevision: number
  pendingReason: ShadowUpdateReason
}

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const FALLBACK_UP = new THREE.Vector3(0, 0, 1)

/**
 * Player-centric selective shadow maps:
 *
 * - hero: dynamic silhouettes, every displayed frame;
 * - local: cached nearby static proxies;
 * - far: cached coarse massing proxies.
 *
 * The maps use fixed light-space extents, so camera FOV, orbit, shake and indoor
 * handoffs cannot resize or phase-shift their texels. Static and dynamic shadow
 * factors are composed under the one real sun rather than adding extra lights.
 */
export class ClipmapShadowNode extends THREE.ShadowBaseNode {
  readonly diagnostics = new ShadowDiagnostics(
    (Object.entries(CLIPMAP_SHADOW_CONFIG) as [DomainId, DomainConfig][]).map(
      ([id, config]) => ({
        id,
        resolution: config.resolution,
        extentMeters: config.extent
      })
    )
  )

  /** Compatibility/debug surface used by existing probes and the inspector. */
  readonly lights: ProjectionLight[]

  #domains: Domain[]
  #farOcclusion: FarOcclusionField | null
  #focusUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #heroCenterUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #heroRightUniform = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup)
  #heroUpUniform = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup)
  #localCenterUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #localRightUniform = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup)
  #localUpUniform = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup)
  #farCenterUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #farRightUniform = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup)
  #farUpUniform = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup)
  #enabledUniform = uniform(SHADOW_TUNING.values.enabled ? 1 : 0).setGroup(renderGroup)
  #farFieldStrengthUniform = uniform(SHADOW_TUNING.values.farFieldStrength).setGroup(renderGroup)
  #enabled = SHADOW_TUNING.values.enabled
  #frame = 0
  #localStaticRevision = 0
  #farStaticRevision = 0
  #right = new THREE.Vector3()
  #shadowUp = new THREE.Vector3()
  #snapped = new THREE.Vector3()

  constructor(light: THREE.DirectionalLight, farOcclusion: FarOcclusionField | null = null) {
    super(light)
    this.#farOcclusion = farOcclusion
    this.#domains = (Object.entries(CLIPMAP_SHADOW_CONFIG) as [DomainId, DomainConfig][]).map(
      ([id, config]) => this.#createDomain(id, config)
    )
    this.lights = this.#domains.map((domain) => domain.light)
    this.applyTuning()
  }

  get staticRevision(): number {
    return Math.max(this.#localStaticRevision, this.#farStaticRevision)
  }

  invalidateStatic(scope: StaticShadowScope = "all"): void {
    if (scope !== "far") this.#localStaticRevision = (this.#localStaticRevision + 1) >>> 0
    if (scope !== "local") this.#farStaticRevision = (this.#farStaticRevision + 1) >>> 0
  }

  /** Apply persisted/live pane values without rebuilding materials or shadow maps. */
  applyTuning(): void {
    const values = SHADOW_TUNING.values
    const wasEnabled = this.#enabled
    this.#enabled = Boolean(values.enabled)
    this.#enabledUniform.value = this.#enabled ? 1 : 0
    this.#farFieldStrengthUniform.value = values.farFieldStrength

    const byDomain = {
      hero: {
        strength: values.heroStrength,
        normalBias: values.heroNormalBias,
        depthBias: values.heroDepthBias
      },
      local: {
        strength: values.localStrength,
        normalBias: values.localNormalBias,
        depthBias: values.localDepthBias
      },
      far: {
        strength: values.farStrength,
        normalBias: values.farNormalBias,
        depthBias: values.farDepthBias
      }
    } as const

    for (const domain of this.#domains) {
      const next = byDomain[domain.id]
      const wasActive = domain.light.shadow.intensity > 0
      domain.light.shadow.intensity = next.strength
      domain.light.shadow.normalBias = next.normalBias
      domain.light.shadow.bias = next.depthBias
      const active = this.#enabled && next.strength > 0
      if (active && (!wasEnabled || !wasActive)) domain.initialized = false
      if (!active) domain.light.shadow.needsUpdate = false
    }
  }

  /** Schedule map refreshes before the owning render call. */
  schedule(focus: THREE.Vector3, sunDirection: THREE.Vector3, nowMs = performance.now()): void {
    this.#focusUniform.value.copy(focus)
    this.diagnostics.beginFrame(++this.#frame, nowMs)
    if (!this.#enabled) return
    if (SHADOW_TUNING.values.farFieldStrength > 0) {
      this.#farOcclusion?.update(sunDirection, focus, nowMs)
    }

    for (let i = 0; i < this.#domains.length; i++) {
      const domain = this.#domains[i]
      if (domain.light.shadow.intensity <= 0) continue
      let reason: ShadowUpdateReason = 0

      if (!domain.initialized) reason |= SHADOW_UPDATE_REASON.INITIAL
      if (domain.id === "hero") reason |= SHADOW_UPDATE_REASON.EVERY_FRAME

      const movedSq = focus.distanceToSquared(domain.lastAnchor)
      if (domain.initialized && domain.config.anchorStep > 0 && movedSq >= domain.config.anchorStep ** 2) {
        reason |= movedSq >= 50 * 50
          ? SHADOW_UPDATE_REASON.TELEPORT
          : SHADOW_UPDATE_REASON.ANCHOR_MOVED
      }

      if (domain.initialized && domain.config.sunAngle > 0) {
        const dot = THREE.MathUtils.clamp(domain.lastSunDir.dot(sunDirection), -1, 1)
        if (Math.acos(dot) >= domain.config.sunAngle) reason |= SHADOW_UPDATE_REASON.SUN_MOVED
      }

      if (
        domain.id !== "hero" &&
        domain.initialized &&
        domain.lastStaticRevision !== this.#staticRevisionFor(domain.id)
      ) {
        reason |= SHADOW_UPDATE_REASON.STREAM_CHANGED
      }

      if (reason === 0) continue
      this.#placeDomain(domain, focus, sunDirection)
      domain.light.shadow.needsUpdate = true
      domain.initialized = true
      domain.lastAnchor.copy(focus)
      domain.lastSunDir.copy(sunDirection)
      domain.lastStaticRevision = this.#staticRevisionFor(domain.id)
      domain.pendingReason |= reason
    }
  }

  setup(_builder: unknown) {
    const [hero, local, far] = this.#domains.map((domain) => domain.node)
    const heroCenter = this.#heroCenterUniform
    const heroRight = this.#heroRightUniform
    const heroUp = this.#heroUpUniform
    const localCenter = this.#localCenterUniform
    const localRight = this.#localRightUniform
    const localUp = this.#localUpUniform
    const farCenter = this.#farCenterUniform
    const farRight = this.#farRightUniform
    const farUp = this.#farUpUniform
    const enabled = this.#enabledUniform
    const farFieldStrength = this.#farFieldStrengthUniform
    const farField = this.#farOcclusion?.replacementSampleNode() ?? null
    return Fn((builder: any) => {
      this.setupShadowPosition(builder)
      const visibility = (vec4(1) as N).toVar()

      // Gate against the actual light-space square, not radial world distance:
      // at low sun a long ground shadow can stay inside a 32 m projection even
      // when its receiver is tens of metres from the player.
      const heroOffset = positionWorld.sub(heroCenter)
      const heroAxisRight = heroOffset.dot(heroRight).abs()
      const heroAxisUp = heroOffset.dot(heroUp).abs()
      const heroRadius = heroAxisRight.max(heroAxisUp)
      const heroFadeEnd = CLIPMAP_SHADOW_CONFIG.hero.extent * 0.5
        - CLIPMAP_SHADOW_EDGES.hero.sampleMarginMeters
      const heroEdgeWeight = smoothstep(
        heroFadeEnd - CLIPMAP_SHADOW_EDGES.hero.fadeMeters,
        heroFadeEnd,
        heroRadius
      ).oneMinus()
      // This continuous weight is already zero inside the valid map boundary;
      // no branch or out-of-domain edge texel can become a visible hard line.
      visibility.mulAssign(mix(1, hero as N, heroEdgeWeight))

      // Representation handoffs follow each cached map's real light-space
      // square. This keeps long grazing-sun shadows in the high-resolution
      // domain instead of degrading them merely because XZ distance is large.
      const localOffset = positionWorld.sub(localCenter)
      const localRadius = localOffset.dot(localRight).abs()
        .max(localOffset.dot(localUp).abs())
      // Fade the far raster to lit before its own light-space square boundary.
      // When the world atlas is faded out this is the visible layer; without the
      // feather its 1024 m frustum edge draws a hard rotated square across the
      // fog. Interior far radii are unaffected (fade weight is 1 there), so the
      // atlas handoff and normal daytime far coverage are unchanged.
      const farOffset = positionWorld.sub(farCenter)
      const farRadius = farOffset.dot(farRight).abs()
        .max(farOffset.dot(farUp).abs())
      const farHalfExtent = CLIPMAP_SHADOW_CONFIG.far.extent * 0.5
      const farFadeEnd = farHalfExtent - CLIPMAP_SHADOW_EDGES.far.sampleMarginMeters
      const farEdgeFade = smoothstep(
        farFadeEnd - CLIPMAP_SHADOW_EDGES.far.fadeMeters,
        farFadeEnd,
        farRadius
      ).oneMinus()
      const farVisible = mix(1, far as N, farEdgeFade)
      const farFieldVisibility = farField
        ? mix(1, farField.visibility as N, farFieldStrength)
        : null
      // Coverage includes atlas availability and its world-edge guard. Fold it
      // into a neutral-to-atlas base once, then keep that base continuous under
      // both raster domains. `min` unions duplicated caster representations;
      // multiplying them here would darken buildings twice.
      const farFieldBase = farField && farFieldVisibility
        ? mix(1, farFieldVisibility as N, farField.coverage)
        : null
      // A focus-relative far-map edge is itself a moving square. Retiring the
      // raster only in that band made raster-only darkness appear/disappear as
      // the projection recentered, even though the atlas underneath was stable.
      // At full coverage the world-locked atlas therefore owns everything past
      // the local guard band; the far raster remains the exact fallback while
      // atlas availability or its edge guard fades in, and when the pane turns
      // atlas strength down.
      // Saturate the retire weight: once the world atlas has any real coverage
      // it should fully own the far domain, so the coarse 1 m far raster cannot
      // bleed a stepped, self-shadowed patch through a merely-partial (overcast,
      // low/stale-sun, mid-rebuild) linear dip. Near-zero coverage still keeps
      // the raster as the genuine fallback.
      const atlasOwnership = farField
        ? smoothstep(0, 0.6, farField.coverage as N).mul(farFieldStrength)
        : null
      const composeWithFarField = (rasterVisibility: N, rasterRetireWeight: N) => {
        if (!farFieldBase) return rasterVisibility
        return composeRasterAtlasVisibility(
          rasterVisibility,
          farFieldBase as N,
          rasterRetireWeight,
          (a, b) => (a as N).min(b as N),
          (a, b, weight) => (mix as N)(a, b, weight)
        )
      }
      If(localRadius.lessThan(CLIPMAP_SHADOW_EDGES.local.handoffStartMeters), () => {
        visibility.mulAssign(composeWithFarField(local as N, 0 as N))
      }).ElseIf(localRadius.lessThan(CLIPMAP_SHADOW_EDGES.local.handoffEndMeters), () => {
        const farWeight = smoothstep(
          CLIPMAP_SHADOW_EDGES.local.handoffStartMeters,
          CLIPMAP_SHADOW_EDGES.local.handoffEndMeters,
          localRadius
        )
        const rasterVisibility = mix(local as N, farVisible, farWeight)
        const rasterRetire = atlasOwnership
          ? farWeight.mul(atlasOwnership)
          : 0 as N
        visibility.mulAssign(composeWithFarField(rasterVisibility as N, rasterRetire))
      }).Else(() => {
        if (!farField || !farFieldBase || !atlasOwnership) {
          visibility.mulAssign(farVisible)
        } else {
          visibility.mulAssign(composeWithFarField(farVisible, atlasOwnership))
        }
      })

      return mix(vec4(1), visibility, enabled)
    })()
  }

  // ShadowBaseNode marks itself for render-time updates, but this composite has
  // no map of its own: the three child ShadowNodes perform their normal
  // updateBefore work. An explicit no-op avoids invoking the abstract base hook.
  updateBefore(): boolean {
    return true
  }

  dispose(): void {
    for (let i = 0; i < this.#domains.length; i++) this.#domains[i].node.dispose()
    super.dispose()
  }

  #createDomain(id: DomainId, config: DomainConfig): Domain {
    const shadowConfig = new THREE.DirectionalLight(0xffffff, 0).shadow
    const half = config.extent * 0.5
    const camera = shadowConfig.camera
    camera.left = -half
    camera.right = half
    camera.top = half
    camera.bottom = -half
    camera.near = 0.5
    camera.far = config.depth
    camera.layers.disableAll()
    camera.layers.enable(config.layer as ShadowLayer)
    camera.updateProjectionMatrix()

    shadowConfig.mapSize.set(config.resolution, config.resolution)
    shadowConfig.bias = config.depthBias
    shadowConfig.normalBias = config.normalBias
    shadowConfig.autoUpdate = false
    shadowConfig.needsUpdate = true

    const light = new ProjectionLight(shadowConfig)
    light.name = `shadow.${id}`
    const node = nodeObject(
      new DomainShadowNode(
        light as unknown as THREE.Light,
        shadowConfig,
        () => this.#recordCompletedUpdate(id)
      )
    )

    return {
      id,
      config,
      light,
      node,
      initialized: false,
      lastAnchor: new THREE.Vector3(),
      lastSunDir: new THREE.Vector3(),
      lastStaticRevision: -1,
      pendingReason: 0
    }
  }

  #placeDomain(domain: Domain, focus: THREE.Vector3, sunDirection: THREE.Vector3): void {
    const direction = sunDirection
    const up = Math.abs(direction.dot(WORLD_UP)) > 0.98 ? FALLBACK_UP : WORLD_UP
    this.#right.crossVectors(up, direction).normalize()
    this.#shadowUp.crossVectors(direction, this.#right).normalize()

    const texel = domain.config.extent / domain.config.resolution
    const rightCoord = focus.dot(this.#right)
    const upCoord = focus.dot(this.#shadowUp)
    const snappedRight = Math.round(rightCoord / texel) * texel
    const snappedUp = Math.round(upCoord / texel) * texel

    this.#snapped.copy(focus)
    this.#snapped.addScaledVector(this.#right, snappedRight - rightCoord)
    this.#snapped.addScaledVector(this.#shadowUp, snappedUp - upCoord)

    const centerUniform = domain.id === "hero"
      ? this.#heroCenterUniform
      : domain.id === "local"
        ? this.#localCenterUniform
        : this.#farCenterUniform
    const rightUniform = domain.id === "hero"
      ? this.#heroRightUniform
      : domain.id === "local"
        ? this.#localRightUniform
        : this.#farRightUniform
    const upUniform = domain.id === "hero"
      ? this.#heroUpUniform
      : domain.id === "local"
        ? this.#localUpUniform
        : this.#farUpUniform
    centerUniform.value.copy(this.#snapped)
    rightUniform.value.copy(this.#right)
    upUniform.value.copy(this.#shadowUp)

    // LightShadow.updateMatrices() calls camera.lookAt() later. Match the same
    // fallback up vector used by our snap basis at near-zenith directions.
    domain.light.shadow.camera.up.copy(up)

    // Keep the target inside the depth volume with room on both lightward and
    // lee sides for hill/building casters at grazing sun angles.
    domain.light.position
      .copy(this.#snapped)
      .addScaledVector(direction, domain.config.depth * 0.45)
    domain.light.target.position.copy(this.#snapped)
    domain.light.updateMatrix()
    domain.light.updateMatrixWorld(true)
    domain.light.target.updateMatrix()
    domain.light.target.updateMatrixWorld(true)
  }

  #recordCompletedUpdate(id: DomainId): void {
    let domain: Domain | undefined
    for (let i = 0; i < this.#domains.length; i++) {
      if (this.#domains[i].id === id) {
        domain = this.#domains[i]
        break
      }
    }
    if (!domain) return
    const reason = domain.pendingReason || SHADOW_UPDATE_REASON.FORCED
    this.diagnostics.recordUpdate(
      domain.id,
      reason,
      domain.config.extent,
      domain.config.resolution,
      Number.NaN,
      performance.now()
    )
    domain.pendingReason = 0
  }

  #staticRevisionFor(id: DomainId): number {
    return id === "local" ? this.#localStaticRevision : this.#farStaticRevision
  }
}
