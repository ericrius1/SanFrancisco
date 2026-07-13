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

export const CLIPMAP_SHADOW_CONFIG = {
  hero: {
    extent: 32,
    resolution: 1024,
    depth: 480,
    normalBias: 0.02,
    depthBias: -0.00004,
    anchorStep: 0,
    sunAngle: 0,
    layer: SHADOW_LAYERS.HERO_DYNAMIC
  },
  local: {
    extent: 96,
    resolution: 1536,
    depth: 900,
    normalBias: 0.05,
    depthBias: -0.00008,
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
    normalBias: 0.5,
    depthBias: -0.0002,
    anchorStep: 8,
    sunAngle: THREE.MathUtils.degToRad(0.15),
    layer: SHADOW_LAYERS.FAR_PROXY
  }
} as const

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
  }

  get staticRevision(): number {
    return Math.max(this.#localStaticRevision, this.#farStaticRevision)
  }

  invalidateStatic(scope: StaticShadowScope = "all"): void {
    if (scope !== "far") this.#localStaticRevision = (this.#localStaticRevision + 1) >>> 0
    if (scope !== "local") this.#farStaticRevision = (this.#farStaticRevision + 1) >>> 0
  }

  /** Schedule map refreshes before the owning render call. */
  schedule(focus: THREE.Vector3, sunDirection: THREE.Vector3, nowMs = performance.now()): void {
    this.#focusUniform.value.copy(focus)
    this.#farOcclusion?.update(sunDirection, focus, nowMs)
    this.diagnostics.beginFrame(++this.#frame, nowMs)

    for (let i = 0; i < this.#domains.length; i++) {
      const domain = this.#domains[i]
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
    const farField = this.#farOcclusion?.replacementSampleNode() ?? null
    return Fn((builder: any) => {
      this.setupShadowPosition(builder)
      const visibility = (vec4(1) as N).toVar()

      // Gate against the actual light-space square, not radial world distance:
      // at low sun a long ground shadow can stay inside a 32 m projection even
      // when its receiver is tens of metres from the player.
      const heroOffset = positionWorld.sub(heroCenter)
      const heroInside = heroOffset.dot(heroRight).abs().lessThan(16.25)
        .and(heroOffset.dot(heroUp).abs().lessThan(16.25))
      If(heroInside, () => {
        visibility.mulAssign(hero as N)
      })

      // Representation handoffs follow each cached map's real light-space
      // square. This keeps long grazing-sun shadows in the high-resolution
      // domain instead of degrading them merely because XZ distance is large.
      const localOffset = positionWorld.sub(localCenter)
      const localRadius = localOffset.dot(localRight).abs()
        .max(localOffset.dot(localUp).abs())
      const farOffset = positionWorld.sub(farCenter)
      const farRadius = farOffset.dot(farRight).abs()
        .max(farOffset.dot(farUp).abs())

      If(localRadius.lessThan(42), () => {
        visibility.mulAssign(local as N)
      }).ElseIf(localRadius.lessThan(48), () => {
        const farWeight = smoothstep(42, 48, localRadius)
        visibility.mulAssign(mix(local as N, far as N, farWeight))
      }).Else(() => {
        if (!farField) {
          visibility.mulAssign(far as N)
        } else {
          If(farRadius.lessThan(420), () => {
            visibility.mulAssign(far as N)
          }).ElseIf(farRadius.lessThan(500), () => {
            const handoff = smoothstep(420, 500, farRadius).mul(farField.coverage)
            visibility.mulAssign((mix as N)(far as N, farField.visibility as N, handoff))
          }).Else(() => {
            // Stable interior pixels use only the atlas. During revision fades
            // or at atlas edges, retain the raster map as a correctness fallback.
            If(farField.coverage.greaterThan(0.995), () => {
              visibility.mulAssign(farField.visibility as N)
            }).Else(() => {
              visibility.mulAssign(
                (mix as N)(far as N, farField.visibility as N, farField.coverage)
              )
            })
          })
        }
      })

      return visibility
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
