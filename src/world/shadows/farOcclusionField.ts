import * as THREE from "three/webgpu"
import { mix, positionWorld, renderGroup, smoothstep, texture, uniform, vec2 } from "three/tsl"
import { FAR_OCCLUDER_STRIDE } from "./farOcclusionCore"
import { composeDualEnvelopeVisibility } from "./visibilityComposition"

type N = any

/**
 * Radius (in atlas texels) of the rotated 4-tap softening kernel sampled per
 * fragment. A single 16 m-texel tap gives far shadow edges a hard, stair-
 * stepped silhouette; averaging four taps ~0.65 texel out spreads a ~1.3-texel
 * penumbra so mid-distance shadows read soft instead of blocky. Sentinel
 * (no-occlusion) taps resolve to fully lit, so the average feathers cleanly
 * toward light at edges.
 */
const FAR_OCCLUSION_SOFTEN_TEXELS = 0.65

export const FAR_OCCLUSION_DEFAULTS = {
  /** 16 m resolves skyline-scale massing while keeping the full SF atlas < 4 MB. */
  targetTexelSize: 16,
  maxResolution: 1024,
  /** Weak darkness for the conservative half-texel-padded outer envelope. */
  outerShadowStrength: 0.18,
  /** Full directional darkness for the tightly stamped core envelope. */
  coreShadowStrength: 0.68,
  /** Weak base contact merged only into tight occupied cells. */
  footprintHeightMeters: 3,
  outerVerticalSoftnessMeters: 2,
  receiverBiasMeters: 1.5,
  // Atlas filtering already supplies a ~one-texel horizontal penumbra. Keep
  // vertical softness tight so ordinary flat ground (the propagated ray sits
  // just below it) remains fully lit instead of receiving blanket grey AO.
  coreVerticalSoftnessMeters: 1.5,
  edgeFadeTexels: 2,
  sunRebuildAngleDegrees: 2,
  sunStaleAngleDegrees: 7,
  minimumSunElevationDegrees: 7,
  minimumSunFadeDegrees: 3,
  minRebuildIntervalMs: 500,
  /** Coalesce a burst of streamed tiles into one worker rebuild. */
  contentQuietPeriodMs: 750,
  /** A moving streamer cannot postpone correctness indefinitely. */
  contentMaxLatencyMs: 2500,
  availabilityResponseHz: 5
} as const

export type FarOcclusionConfig = {
  [Key in keyof typeof FAR_OCCLUSION_DEFAULTS]: number
}
export type FarOcclusionOptions = Partial<FarOcclusionConfig>

/** Structural subset of WorldMap; no runtime import/cycle is required. */
export type FarHeightFieldSource = Readonly<{
  meta: Readonly<{
    grid: Readonly<{
      width: number
      height: number
      cellSize: number
      minX: number
      minZ: number
    }>
  }>
  groundTops: Float32Array
}>

/** Compatible with baked BuildingCollider and CityGen/Garden ColliderBox. */
export type FarBoxOccluder = Readonly<{
  x: number
  y: number
  z: number
  hx: number
  hy: number
  hz: number
  yaw?: number
  cosYaw?: number
  sinYaw?: number
}>

export type FarOcclusionStats = {
  width: number
  height: number
  texelSize: number
  gpuBytes: number
  tileSets: number
  submittedOccluders: number
  rasterizedOccluders: number
  occupiedTexels: number
  contentRevision: number
  builtRevision: number
  buildMs: number
  generation: number
  ready: boolean
  pending: boolean
  availability: number
  failedReason: string | null
}

type WorkerBuiltMessage = {
  type: "built"
  generation: number
  contentRevision: number
  sunX: number
  sunY: number
  sunZ: number
  data: Uint16Array
  buildMs: number
  occluders: number
  occupiedTexels: number
}

type WorkerFailedMessage = {
  type: "failed"
  generation: number
  contentRevision: number
  message: string
}

type FieldAtlas = {
  width: number
  height: number
  minX: number
  minZ: number
  texelSize: number
  cellsPerTexel: number
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`)
  return value
}

function describeTerrainAtlas(source: FarHeightFieldSource, options: FarOcclusionConfig): FieldAtlas {
  const grid = source.meta.grid
  if (!Number.isInteger(grid.width) || grid.width <= 1 || !Number.isInteger(grid.height) || grid.height <= 1) {
    throw new Error("FarOcclusionField requires a valid height grid")
  }
  if (source.groundTops.length !== grid.width * grid.height) {
    throw new Error("FarOcclusionField groundTops length does not match map metadata")
  }
  finitePositive(grid.cellSize, "map cellSize")
  const worldWidth = grid.width * grid.cellSize
  const worldHeight = grid.height * grid.cellSize
  const requiredTexel = Math.max(
    options.targetTexelSize,
    worldWidth / options.maxResolution,
    worldHeight / options.maxResolution
  )
  // An integer source-cell multiple avoids resampling phase changes and makes
  // every atlas texel own the same deterministic block of terrain samples.
  const cellsPerTexel = Math.max(1, Math.ceil(requiredTexel / grid.cellSize))
  const texelSize = cellsPerTexel * grid.cellSize
  const width = Math.ceil(grid.width / cellsPerTexel)
  const height = Math.ceil(grid.height / cellsPerTexel)
  return { width, height, minX: grid.minX, minZ: grid.minZ, texelSize, cellsPerTexel }
}

function validBox(box: FarBoxOccluder): boolean {
  return Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.z) &&
    Number.isFinite(box.hx) && Number.isFinite(box.hy) && Number.isFinite(box.hz) &&
    box.hx > 0 && box.hy > 0 && box.hz > 0
}

/**
 * Whole-world, low-frequency directional occlusion with no render pass.
 *
 * The worker sweeps conservative and tight terrain/collider envelopes in
 * light-space order. The resulting RG16F texture is world locked, so
 * camera/FOV/shake never move its texels. Stream changes and >=2 degree sun
 * changes rebuild off-thread; a stale field fades out rather than projecting
 * in the wrong direction.
 *
 * Integration:
 * - construct once after WorldMap.load(): `new FarOcclusionField(map)`;
 * - feed tile colliders with `setBoxOccluders(key, colliders)` / `deleteOccluders`;
 * - call `update(SUN_DIR, player.renderPosition)` before render;
 * - let `replacementSampleNode()` own the far domain once the atlas is valid.
 */
export class FarOcclusionField {
  readonly texture: THREE.DataTexture
  readonly options: Readonly<FarOcclusionConfig>
  readonly bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>

  #worker: Worker | null = null
  #boundsUniform: N
  #availabilityUniform = uniform(0).setGroup(renderGroup)
  #stats: FarOcclusionStats
  #setCounts = new Map<string, number>()
  #contentRevision = 0
  #builtRevision = -1
  #generation = 0
  #inFlight = false
  #disposed = false
  #hasRequested = false
  #hasBuilt = false
  #lastRequestMs = -Infinity
  #lastContentChangeMs = -Infinity
  #firstDirtyMs = -1
  #lastUpdateMs = -1
  #targetAvailability = 0
  #pendingBuilt: WorkerBuiltMessage | null = null
  #requestedSun = new THREE.Vector3()
  #builtSun = new THREE.Vector3()
  #currentSun = new THREE.Vector3()
  #rebuildCos: number
  #staleCos: number
  #minimumSunY: number
  #fullSunY: number

  constructor(source: FarHeightFieldSource, options: FarOcclusionOptions = {}) {
    this.options = Object.freeze({ ...FAR_OCCLUSION_DEFAULTS, ...options })
    finitePositive(this.options.targetTexelSize, "targetTexelSize")
    finitePositive(this.options.maxResolution, "maxResolution")
    // Only dimension math runs here. The millions of source-height comparisons
    // that build the terrain atlas now run in farOcclusionWorker.
    const atlas = describeTerrainAtlas(source, this.options)
    const extentX = atlas.width * atlas.texelSize
    const extentZ = atlas.height * atlas.texelSize
    this.bounds = Object.freeze({
      minX: atlas.minX,
      minZ: atlas.minZ,
      maxX: atlas.minX + extentX,
      maxZ: atlas.minZ + extentZ
    })
    this.#boundsUniform = uniform(
      new THREE.Vector4(atlas.minX, atlas.minZ, extentX, extentZ)
    ).setGroup(renderGroup)

    // WebGPU textures cannot be resized in place. Starting at 1x1 and changing
    // `texture.image.width/height` when the worker replied left Three's cached
    // GPU allocation at 1x1, then attempted a full-atlas queue.writeTexture.
    // Allocate the final shape once; availability remains zero until real data
    // arrives, so the zero-filled bootstrap pixels are never visible.
    const initialData = new Uint16Array(atlas.width * atlas.height * 2)
    this.texture = new THREE.DataTexture(
      initialData,
      atlas.width,
      atlas.height,
      THREE.RGFormat,
      THREE.HalfFloatType
    )
    this.texture.name = "farOcclusionField.rg16f"
    this.texture.magFilter = THREE.LinearFilter
    this.texture.minFilter = THREE.LinearFilter
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.texture.needsUpdate = true

    this.#rebuildCos = Math.cos(THREE.MathUtils.degToRad(this.options.sunRebuildAngleDegrees))
    this.#staleCos = Math.cos(THREE.MathUtils.degToRad(this.options.sunStaleAngleDegrees))
    this.#minimumSunY = Math.sin(THREE.MathUtils.degToRad(this.options.minimumSunElevationDegrees))
    this.#fullSunY = Math.sin(THREE.MathUtils.degToRad(
      this.options.minimumSunElevationDegrees + this.options.minimumSunFadeDegrees
    ))
    this.#stats = {
      width: atlas.width,
      height: atlas.height,
      texelSize: atlas.texelSize,
      gpuBytes: atlas.width * atlas.height * 4,
      tileSets: 0,
      submittedOccluders: 0,
      rasterizedOccluders: 0,
      occupiedTexels: 0,
      contentRevision: 0,
      builtRevision: -1,
      buildMs: 0,
      generation: 0,
      ready: false,
      pending: false,
      availability: 0,
      failedReason: null
    }

    if (typeof Worker === "undefined") {
      this.#stats.failedReason = "Worker is unavailable; far occlusion stays neutral"
      return
    }

    this.#worker = new Worker(new URL("./farOcclusionWorker.ts", import.meta.url), { type: "module" })
    this.#worker.onmessage = (event: MessageEvent<WorkerBuiltMessage | WorkerFailedMessage>) => {
      if (this.#disposed) return
      const message = event.data
      this.#inFlight = false
      this.#stats.pending = false
      if (message.type === "failed") {
        // Suppress a tight deterministic-error retry loop. A later sun/content
        // revision still gets a fresh attempt.
        this.#builtRevision = message.contentRevision
        this.#targetAvailability = 0
        this.#stats.builtRevision = message.contentRevision
        this.#stats.failedReason = message.message
        return
      }
      if (message.generation < this.#stats.generation) return
      // A newer stream revision landed while the worker was sweeping. Do not
      // crossfade through an already-obsolete field; the max-latency scheduler
      // below requests the current content promptly.
      if (message.contentRevision !== this.#contentRevision) {
        this.#stats.pending = false
        return
      }
      if (!this.#hasBuilt) this.#applyBuilt(message)
      else {
        // Fade to the still-valid raster far map, swap while effectively
        // invisible, then fade the new field in. This avoids a 3.1 MiB revision
        // popping in one frame without paying two atlas samples forever.
        this.#pendingBuilt = message
        this.#targetAvailability = 0
        this.#stats.pending = true
      }
    }
    this.#worker.onerror = (event) => {
      this.#inFlight = false
      this.#targetAvailability = 0
      this.#stats.pending = false
      this.#stats.failedReason = event.message || "far occlusion worker failed"
      this.#worker?.terminate()
      this.#worker = null
    }
    const groundTops = source.groundTops.slice()
    this.#worker.postMessage({
      type: "init",
      width: atlas.width,
      height: atlas.height,
      sourceWidth: source.meta.grid.width,
      sourceHeight: source.meta.grid.height,
      cellsPerTexel: atlas.cellsPerTexel,
      minX: atlas.minX,
      minZ: atlas.minZ,
      texelSize: atlas.texelSize,
      groundTops,
      minimumSunSlope: Math.tan(THREE.MathUtils.degToRad(this.options.minimumSunElevationDegrees)),
      footprintHeightMeters: this.options.footprintHeightMeters
    }, [groundTops.buffer])
  }

  get stats(): Readonly<FarOcclusionStats> {
    return this.#stats
  }

  /** Replace one stream unit atomically. Empty input removes its contribution. */
  setBoxOccluders(key: string, boxes: readonly FarBoxOccluder[]): void {
    if (this.#disposed) return
    if (!key) throw new Error("FarOcclusionField occluder key cannot be empty")
    let validCount = 0
    for (let i = 0; i < boxes.length; i++) if (validBox(boxes[i])) validCount++
    if (validCount === 0) {
      this.deleteOccluders(key)
      return
    }

    const packed = new Float32Array(validCount * FAR_OCCLUDER_STRIDE)
    let cursor = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (!validBox(box)) continue
      const yaw = Number.isFinite(box.yaw) ? box.yaw! : 0
      let cos = Number.isFinite(box.cosYaw) ? box.cosYaw! : Math.cos(yaw)
      let sin = Number.isFinite(box.sinYaw) ? box.sinYaw! : Math.sin(yaw)
      const rotationLength = Math.hypot(cos, sin)
      if (rotationLength < 1e-6) {
        cos = 1
        sin = 0
      } else {
        cos /= rotationLength
        sin /= rotationLength
      }
      packed[cursor++] = box.x
      packed[cursor++] = box.z
      packed[cursor++] = box.y + box.hy
      packed[cursor++] = box.hx
      packed[cursor++] = box.hz
      packed[cursor++] = cos
      packed[cursor++] = sin
    }

    const previous = this.#setCounts.get(key) ?? 0
    this.#setCounts.set(key, validCount)
    this.#stats.submittedOccluders += validCount - previous
    this.#stats.tileSets = this.#setCounts.size
    this.#markContentChanged()
    this.#worker?.postMessage({ type: "set", key, occluders: packed }, [packed.buffer])
  }

  deleteOccluders(key: string): boolean {
    if (this.#disposed) return false
    const previous = this.#setCounts.get(key)
    if (previous === undefined) return false
    this.#setCounts.delete(key)
    this.#stats.submittedOccluders -= previous
    this.#stats.tileSets = this.#setCounts.size
    this.#markContentChanged()
    this.#worker?.postMessage({ type: "delete", key })
    return true
  }

  /** Hot-path scheduler: no rebuild work runs on the main thread. */
  update(sunDirection: THREE.Vector3, _focus: THREE.Vector3, nowMs = performance.now()): void {
    if (this.#disposed) return
    const length = Math.hypot(sunDirection.x, sunDirection.y, sunDirection.z)
    if (!Number.isFinite(length) || length < 1e-6 || sunDirection.y <= 0) {
      this.#targetAvailability = 0
      this.#stepAvailability(nowMs)
      return
    }
    this.#currentSun.copy(sunDirection).multiplyScalar(1 / length)
    const elevationWeight = THREE.MathUtils.smoothstep(
      this.#currentSun.y,
      this.#minimumSunY,
      this.#fullSunY
    )

    if (this.#hasBuilt) {
      this.#targetAvailability = this.#builtSun.dot(this.#currentSun) >= this.#staleCos
        ? elevationWeight
        : 0
    }
    if (this.#pendingBuilt && this.#pendingBuilt.contentRevision !== this.#contentRevision) {
      this.#pendingBuilt = null
      this.#stats.pending = false
    }
    if (this.#pendingBuilt) this.#targetAvailability = 0

    const sunNeedsBuild = !this.#hasRequested || this.#requestedSun.dot(this.#currentSun) < this.#rebuildCos
    const contentNeedsBuild = this.#builtRevision !== this.#contentRevision
    const quietContentNeedsBuild = contentNeedsBuild &&
      nowMs - this.#lastContentChangeMs >= this.options.contentQuietPeriodMs
    const overdueContentNeedsBuild = contentNeedsBuild &&
      this.#firstDirtyMs >= 0 &&
      nowMs - this.#firstDirtyMs >= this.options.contentMaxLatencyMs
    if (
      this.#worker && !this.#inFlight && !this.#pendingBuilt &&
      elevationWeight > 0 &&
      (sunNeedsBuild || quietContentNeedsBuild || overdueContentNeedsBuild) &&
      nowMs - this.#lastRequestMs >= this.options.minRebuildIntervalMs
    ) {
      this.#requestedSun.copy(this.#currentSun)
      this.#hasRequested = true
      this.#lastRequestMs = nowMs
      this.#inFlight = true
      const generation = ++this.#generation
      this.#stats.generation = generation
      this.#stats.pending = true
      this.#worker.postMessage({
        type: "build",
        generation,
        contentRevision: this.#contentRevision,
        sunX: this.#currentSun.x,
        sunY: this.#currentSun.y,
        sunZ: this.#currentSun.z
      })
    }
    this.#stepAvailability(nowMs)
    if (this.#pendingBuilt && Number(this.#availabilityUniform.value) <= 0.02) {
      const pending = this.#pendingBuilt
      this.#pendingBuilt = null
      this.#applyBuilt(pending)
      this.#targetAvailability = this.#builtSun.dot(this.#currentSun) >= this.#staleCos
        ? elevationWeight
        : 0
    }
  }

  /** Combined weak outer plus strong core visibility from one RG16F sample. */
  shadowVisibilityNode(worldPositionNode: N = positionWorld): N {
    const { rawVisibility, coverage } = this.#visibilityContext(worldPositionNode)
    return mix(1, rawVisibility, coverage)
  }

  /** Raw field plus validity weight for a continuous base/detail raster union. */
  replacementSampleNode(worldPositionNode: N = positionWorld): { visibility: N; coverage: N } {
    const { rawVisibility, coverage } = this.#visibilityContext(worldPositionNode)
    return { visibility: rawVisibility, coverage }
  }

  #visibilityContext(worldPositionNode: N): {
    rawVisibility: N
    coverage: N
  } {
    const uv = worldPositionNode.xz.sub(this.#boundsUniform.xy).div(this.#boundsUniform.zw)
    const receiverY = worldPositionNode.y.add(this.options.receiverBiasMeters)
    const outerSoftness = this.options.outerVerticalSoftnessMeters
    const coreSoftness = this.options.coreVerticalSoftnessMeters
    const outerStrength = this.options.outerShadowStrength as N
    const coreStrength = this.options.coreShadowStrength as N
    // One dual-envelope visibility sample at a given atlas UV.
    const sampleVisibility = (sampleUv: N): N => {
      const field = texture(this.texture, sampleUv)
      const outerCeilingVisibility = smoothstep(
        field.r.sub(outerSoftness),
        field.r.add(outerSoftness),
        receiverY
      )
      const coreCeilingVisibility = smoothstep(
        field.g.sub(coreSoftness),
        field.g.add(coreSoftness),
        receiverY
      )
      return composeDualEnvelopeVisibility(
        outerCeilingVisibility as N,
        coreCeilingVisibility as N,
        1 as N,
        outerStrength,
        coreStrength,
        (a, b, weight) => (mix as N)(a, b, weight),
        (a, b) => (a as N).min(b as N)
      )
    }
    // Rotated 4-tap kernel: average visibility (not raw ceiling heights, which
    // carry a large no-occlusion sentinel that would corrupt an average) so the
    // 16 m-quantized shadow edge gains a soft penumbra instead of a hard step.
    const du = FAR_OCCLUSION_SOFTEN_TEXELS / this.#stats.width
    const dv = FAR_OCCLUSION_SOFTEN_TEXELS / this.#stats.height
    const rawVisibility = sampleVisibility(uv.add(vec2(du, dv)))
      .add(sampleVisibility(uv.add(vec2(-du, dv))))
      .add(sampleVisibility(uv.add(vec2(du, -dv))))
      .add(sampleVisibility(uv.add(vec2(-du, -dv))))
      .mul(0.25)
    // Availability + world-edge guard (sampled once at the fragment centre).
    const edgeDistance = uv.x.min(uv.y).min(uv.x.oneMinus()).min(uv.y.oneMinus())
    const edgeFadeUv = this.options.edgeFadeTexels / Math.min(this.#stats.width, this.#stats.height)
    const coverage = smoothstep(0, edgeFadeUv, edgeDistance).mul(this.#availabilityUniform)
    return { rawVisibility, coverage }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#worker?.terminate()
    this.#worker = null
    this.texture.dispose()
    this.#setCounts.clear()
  }

  #applyBuilt(message: WorkerBuiltMessage): void {
    const image = this.texture.image as { data: Uint16Array; width: number; height: number }
    image.data = message.data
    image.width = this.#stats.width
    image.height = this.#stats.height
    this.texture.needsUpdate = true
    this.#builtSun.set(message.sunX, message.sunY, message.sunZ).normalize()
    this.#hasBuilt = true
    this.#builtRevision = message.contentRevision
    this.#firstDirtyMs = -1
    this.#stats.rasterizedOccluders = message.occluders
    this.#stats.occupiedTexels = message.occupiedTexels
    this.#stats.builtRevision = message.contentRevision
    this.#stats.buildMs = message.buildMs
    this.#stats.ready = true
    this.#stats.pending = false
    this.#stats.failedReason = null
  }

  #markContentChanged(): void {
    const now = performance.now()
    if (this.#firstDirtyMs < 0) this.#firstDirtyMs = now
    this.#contentRevision = (this.#contentRevision + 1) >>> 0
    this.#lastContentChangeMs = now
    this.#stats.contentRevision = this.#contentRevision
  }

  #stepAvailability(nowMs: number): void {
    if (this.#lastUpdateMs < 0) this.#lastUpdateMs = nowMs
    const dt = Math.max(0, Math.min(0.1, (nowMs - this.#lastUpdateMs) / 1000))
    this.#lastUpdateMs = nowMs
    const response = 1 - Math.exp(-dt * this.options.availabilityResponseHz)
    const current = this.#availabilityUniform.value as number
    const next = current + (this.#targetAvailability - current) * response
    this.#availabilityUniform.value = Math.abs(next - this.#targetAvailability) < 0.001
      ? this.#targetAvailability
      : next
    this.#stats.availability = this.#availabilityUniform.value as number
  }
}
