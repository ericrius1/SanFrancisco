/**
 * Real-time Starlink trains in the night sky.
 *
 * Lazy-loaded after world reveal, only while the sky follows real SF time and
 * the sun is below the horizon. Fetches live GP element sets from /api/starlink
 * (CelesTrak via the local relay), propagates with SGP4, and draws sunlit
 * satellites above the SF horizon as faint star-like sprites.
 */

import * as THREE from "three/webgpu"
import {
  float,
  instanceIndex,
  instancedArray,
  saturate,
  uniform,
  uv,
  vec3,
  vec4,
  vertexStage
} from "three/tsl"
import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  json2satrec,
  jday,
  propagate,
  sunPos,
  type SatRec
} from "satellite.js"
import { SF_LAT, SF_LON, sfCivilToUtcMs, type SfCivilTime } from "./solar"

type N = any

const SKY_RADIUS = 11000
const MAX_VISIBLE = 384
const FULL_SWEEP_MS = 2500
const REFRESH_GP_MS = 2 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20_000
const MIN_ELEVATION_RAD = (8 * Math.PI) / 180
/** Match procedural star fade: sun below ~−6° (civil twilight). */
const NIGHT_START_ELEVATION = -4
const NIGHT_FULL_ELEVATION = -12
const EARTH_RADIUS_KM = 6378.137
const KM_PER_AU = 149597870.7

type StarlinkOmm = Record<string, unknown>

function sunDirectionKm(date: Date): { x: number; y: number; z: number } {
  const { rsun } = sunPos(jday(date))
  const sun = {
    x: rsun[0] * KM_PER_AU,
    y: rsun[1] * KM_PER_AU,
    z: rsun[2] * KM_PER_AU
  }
  const sunLen = Math.hypot(sun.x, sun.y, sun.z) || 1
  return { x: sun.x / sunLen, y: sun.y / sunLen, z: sun.z / sunLen }
}

function isSunlit(
  satEci: { x: number; y: number; z: number },
  sunUnit: { x: number; y: number; z: number }
): boolean {
  // Cylindrical umbra — sats behind Earth are dark.
  const along = satEci.x * sunUnit.x + satEci.y * sunUnit.y + satEci.z * sunUnit.z
  if (along > 0) return true
  const r2 = satEci.x * satEci.x + satEci.y * satEci.y + satEci.z * satEci.z
  const perp2 = r2 - along * along
  return perp2 > EARTH_RADIUS_KM * EARTH_RADIUS_KM
}

/** Azimuth clockwise from north, elevation from horizon → world unit direction. */
function lookToWorld(azimuthRad: number, elevationRad: number, out: THREE.Vector3) {
  const ce = Math.cos(elevationRad)
  out.set(
    Math.sin(azimuthRad) * ce,
    Math.sin(elevationRad),
    -Math.cos(azimuthRad) * ce
  )
  return out
}

function nightFactor(sunElevationDeg: number): number {
  if (sunElevationDeg >= NIGHT_START_ELEVATION) return 0
  if (sunElevationDeg <= NIGHT_FULL_ELEVATION) return 1
  return (
    (NIGHT_START_ELEVATION - sunElevationDeg) /
    (NIGHT_START_ELEVATION - NIGHT_FULL_ELEVATION)
  )
}

function brightnessFor(rangeKm: number, elevationRad: number): number {
  const rangeTerm = THREE.MathUtils.clamp(900 / Math.max(rangeKm, 1), 0.12, 1)
  const elevTerm = Math.pow(Math.sin(Math.max(elevationRad, 0)), 0.35)
  return rangeTerm * (0.35 + 0.65 * elevTerm)
}

export type StarlinkSkyHost = {
  realTime: boolean
  sunElevation: number
  civilTime: SfCivilTime
  mesh: THREE.Object3D
}

/**
 * Create the Starlink sky layer. Network + satellite.js stay inside this module
 * so the boot graph never pays for them until real-time night sky activates.
 */
export class StarlinkSky {
  #sprite: THREE.Sprite
  #posAttr: N
  #brightAttr: N
  #positions: Float32Array
  #brightness: Float32Array
  #opacity = uniform(0)
  #satrecs: SatRec[] = []
  #candidates: SatRec[] = []
  #observer = {
    longitude: degreesToRadians(SF_LON),
    latitude: degreesToRadians(SF_LAT),
    height: 0.05
  }
  #dir = new THREE.Vector3()
  #lastSweepMs = -Infinity
  #lastFetchMs = 0
  #fetching = false
  #ready = false
  #disposed = false
  #visibleCount = 0
  #pollTimer = 0
  #request: AbortController | null = null

  #onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      window.clearInterval(this.#pollTimer)
      this.#pollTimer = 0
      this.#request?.abort("page suspended")
      return
    }
    void this.#ensureElements()
    this.#startPolling()
  }

  constructor(scene: THREE.Scene) {
    this.#positions = new Float32Array(MAX_VISIBLE * 4)
    this.#brightness = new Float32Array(MAX_VISIBLE * 4)
    this.#posAttr = instancedArray(this.#positions, "vec4")
    this.#brightAttr = instancedArray(this.#brightness, "vec4")

    const material = new THREE.SpriteNodeMaterial()
    const led = this.#posAttr.element(instanceIndex) as N
    const data = this.#brightAttr.element(instanceIndex) as N
    material.positionNode = led.xyz
    // Tiny screen-space pinpricks — real Starlinks read as faint moving stars.
    material.scaleNode = float(2.4)

    const glow = vertexStage(vec3(0.82, 0.88, 1.0).mul(data.x)) as unknown as N
    const active = vertexStage(data.y) as unknown as N
    const q = uv().sub(0.5).mul(2)
    const r = q.length()
    const soft = saturate(r.oneMinus()).pow(2.8)
    const core = saturate(r.mul(2.2).oneMinus()).pow(5).mul(1.4)
    material.colorNode = vec4(
      glow.mul(soft.add(core)).mul(this.#opacity as N).mul(active),
      1
    )
    material.transparent = true
    material.blending = THREE.AdditiveBlending
    material.depthWrite = false
    material.depthTest = true
    material.fog = false

    this.#sprite = new THREE.Sprite(material)
    this.#sprite.count = 0
    this.#sprite.frustumCulled = false
    this.#sprite.renderOrder = 5
    this.#sprite.name = "starlink_sky"
    this.#sprite.visible = false
    scene.add(this.#sprite)

    document.addEventListener("visibilitychange", this.#onVisibilityChange)
    if (document.visibilityState === "visible") {
      void this.#ensureElements()
      this.#startPolling()
    }
  }

  #startPolling() {
    if (this.#disposed || this.#pollTimer || document.visibilityState === "hidden") return
    this.#pollTimer = window.setInterval(() => {
      if (this.#disposed) return
      void this.#ensureElements(true)
    }, REFRESH_GP_MS)
  }

  async #ensureElements(force = false) {
    if (this.#disposed || this.#fetching || document.visibilityState === "hidden") return
    if (!force && this.#ready && Date.now() - this.#lastFetchMs < REFRESH_GP_MS) return
    this.#fetching = true
    const controller = new AbortController()
    this.#request = controller
    const timeout = window.setTimeout(() => controller.abort("starlink timeout"), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch("/api/starlink", { signal: controller.signal })
      if (!response.ok) throw new Error(`starlink ${response.status}`)
      const rows = (await response.json()) as StarlinkOmm[]
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty starlink catalog")
      const next: SatRec[] = []
      for (const row of rows) {
        try {
          next.push(json2satrec(row as never))
        } catch {
          // Skip malformed / decayed rows.
        }
      }
      if (this.#disposed) return
      this.#satrecs = next
      this.#candidates = []
      this.#lastSweepMs = -Infinity
      this.#lastFetchMs = Date.now()
      this.#ready = next.length > 0
    } catch (error) {
      if (!this.#ready && document.visibilityState === "visible") {
        console.warn(
          "[starlink] GP feed unavailable:",
          error instanceof Error ? error.message : error
        )
      }
    } finally {
      window.clearTimeout(timeout)
      if (this.#request === controller) this.#request = null
      this.#fetching = false
      if (
        controller.signal.reason === "page suspended" &&
        !this.#disposed &&
        document.visibilityState === "visible"
      ) {
        void this.#ensureElements(force)
      }
    }
  }

  #sweep(date: Date) {
    const gmst = gstime(date)
    const sun = sunDirectionKm(date)
    const next: SatRec[] = []
    for (const satrec of this.#satrecs) {
      const pv = propagate(satrec, date)
      if (!pv) continue
      const pos = pv.position
      if (!pos || typeof pos === "boolean") continue
      if (!isSunlit(pos, sun)) continue
      const ecf = eciToEcf(pos, gmst)
      const look = ecfToLookAngles(this.#observer, ecf)
      if (look.elevation >= MIN_ELEVATION_RAD) next.push(satrec)
    }
    this.#candidates = next
    this.#lastSweepMs = date.getTime()
  }

  update(host: StarlinkSkyHost, cameraPos: THREE.Vector3) {
    if (this.#disposed) return
    const factor = host.realTime ? nightFactor(host.sunElevation) : 0
    this.#opacity.value = factor * 0.9
    if (factor <= 0.001 || !this.#ready) {
      this.#sprite.visible = false
      this.#sprite.count = 0
      return
    }

    const utcMs = sfCivilToUtcMs(host.civilTime)
    const date = new Date(utcMs)
    if (utcMs - this.#lastSweepMs >= FULL_SWEEP_MS) this.#sweep(date)

    const gmst = gstime(date)
    const sun = sunDirectionKm(date)
    let count = 0
    for (const satrec of this.#candidates) {
      if (count >= MAX_VISIBLE) break
      const pv = propagate(satrec, date)
      if (!pv) continue
      const pos = pv.position
      if (!pos || typeof pos === "boolean") continue
      if (!isSunlit(pos, sun)) continue
      const ecf = eciToEcf(pos, gmst)
      const look = ecfToLookAngles(this.#observer, ecf)
      if (look.elevation < MIN_ELEVATION_RAD) continue
      lookToWorld(look.azimuth, look.elevation, this.#dir)
      const i = count * 4
      this.#positions[i] = cameraPos.x + this.#dir.x * SKY_RADIUS
      this.#positions[i + 1] = cameraPos.y + this.#dir.y * SKY_RADIUS
      this.#positions[i + 2] = cameraPos.z + this.#dir.z * SKY_RADIUS
      this.#positions[i + 3] = 1
      this.#brightness[i] = brightnessFor(look.rangeSat, look.elevation)
      this.#brightness[i + 1] = 1
      this.#brightness[i + 2] = 0
      this.#brightness[i + 3] = 0
      count++
    }
    for (let i = count; i < this.#visibleCount; i++) {
      const o = i * 4
      this.#brightness[o + 1] = 0
    }
    this.#visibleCount = count
    const posBuf = this.#posAttr.value as THREE.StorageInstancedBufferAttribute
    const brightBuf = this.#brightAttr.value as THREE.StorageInstancedBufferAttribute
    posBuf.needsUpdate = true
    brightBuf.needsUpdate = true
    this.#sprite.count = count
    this.#sprite.visible = count > 0
  }

  dispose() {
    this.#disposed = true
    window.clearInterval(this.#pollTimer)
    this.#request?.abort("starlink disposed")
    document.removeEventListener("visibilitychange", this.#onVisibilityChange)
    this.#sprite.removeFromParent()
    this.#sprite.material.dispose()
    this.#satrecs = []
    this.#candidates = []
  }
}
