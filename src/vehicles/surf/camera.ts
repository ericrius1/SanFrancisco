import * as THREE from "three/webgpu"
import type { Player } from "../../player/player"
import { waterHeight } from "../../world/heightmap"
import { SURF_CAMERA_TUNING } from "./cameraTuning"

/**
 * One fixed, shore-side arcade shot. Camera framing and its practical tweak
 * ranges live together so the dedicated surf rig never inherits orbit-camera
 * state or mouse input from the normal-world camera.
 */
export type SurfCameraDiagnostics = {
  initialized: boolean
  snapped: boolean
  lineDirection: -1 | 1
  viewYaw: number
  viewPitch: number
  fov: number
  sightlineLift: number
  waterClearance: number
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
}

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const MAX_SMOOTH_DT = 0.1
const SIGHTLINE_SAMPLES = 6
// Even after follow lag, preserve an unmistakable shore-side (+X) viewpoint.
const MIN_SHORE_CLEARANCE = 0.75

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const smoothstep = (value: number) => value * value * (3 - 2 * value)

/**
 * Exclusive surf camera: it consumes no Input and has no orbit state. The eye
 * is always shoreward (+X), slightly behind the rider along the chosen line,
 * and aims modestly ahead along Z. Assisted end-of-break turns reframe through
 * a side shot instead of making a disorienting 180-degree orbit.
 */
export class SurfCameraController {
  readonly #baseFov: number
  readonly #position = new THREE.Vector3()
  readonly #desiredPosition = new THREE.Vector3()
  readonly #target = new THREE.Vector3()
  readonly #desiredTarget = new THREE.Vector3()
  readonly #lastAnchor = new THREE.Vector3()
  readonly #lookMatrix = new THREE.Matrix4()

  #initialized = false
  #snapped = false
  #lineDirection: -1 | 1 = 1
  #viewYaw = 0
  #viewPitch = 0
  #fov: number
  #sightlineLift = 0
  #waterClearance = 0

  constructor(baseFov: number) {
    this.#baseFov = Number.isFinite(baseFov) ? baseFov : 60
    this.#fov = this.#baseFov
  }

  /** Forget all follow history so the next surf frame starts on the arcade rig. */
  reset() {
    this.#initialized = false
    this.#snapped = false
    this.#lineDirection = 1
    this.#viewYaw = 0
    this.#viewPitch = 0
    this.#fov = this.#baseFov
    this.#sightlineLift = 0
    this.#waterClearance = 0
  }

  /** Canonical yaw of the locked shot, for systems that need the rendered view. */
  get viewYaw(): number {
    return this.#viewYaw
  }

  /** Canonical pitch of the locked shot; zero is level and negative looks up. */
  get viewPitch(): number {
    return this.#viewPitch
  }

  /** Allocation-on-demand probe; the per-frame update path allocates nothing. */
  diagnostics(): SurfCameraDiagnostics {
    return {
      initialized: this.#initialized,
      snapped: this.#snapped,
      lineDirection: this.#lineDirection,
      viewYaw: this.#viewYaw,
      viewPitch: this.#viewPitch,
      fov: this.#fov,
      sightlineLift: this.#sightlineLift,
      waterClearance: this.#waterClearance,
      position: {
        x: this.#position.x,
        y: this.#position.y,
        z: this.#position.z
      },
      target: {
        x: this.#target.x,
        y: this.#target.y,
        z: this.#target.z
      }
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, player: Player) {
    const tuning = SURF_CAMERA_TUNING.values
    const anchor = player.renderPosition
    const telemetry = player.surfTelemetry
    const lineDirection: -1 | 1 = telemetry.lineDirection < 0 ? -1 : 1

    // The camera cannot cross the break: X is always shoreward. Z trails the
    // rider so the target's opposite, modest look-ahead reveals the open line.
    this.#desiredPosition.set(
      anchor.x + tuning.shoreOffset,
      anchor.y + tuning.height,
      anchor.z - lineDirection * tuning.distance
    )
    this.#desiredTarget.set(
      anchor.x,
      anchor.y + tuning.targetHeight,
      anchor.z + lineDirection * tuning.lookAhead
    )

    const desiredWater = Math.max(
      waterHeight(
        this.#desiredPosition.x,
        this.#desiredPosition.z,
        player.time
      ),
      0
    ) + tuning.waterClearance
    if (this.#desiredPosition.y < desiredWater)
      this.#desiredPosition.y = desiredWater

    const teleportDistance = tuning.teleportSnapDistance
    const teleported = this.#initialized &&
      anchor.distanceToSquared(this.#lastAnchor) > teleportDistance * teleportDistance
    // Reversing the assisted line swaps which Z side trails the rider. A short
    // arcade cut preserves identical composition; orbiting 15 m around the board
    // would make the locked camera feel as though the player had moved it.
    const directionChanged = this.#initialized && lineDirection !== this.#lineDirection
    const snap = !this.#initialized || teleported || directionChanged
    const smoothDt = Number.isFinite(dt)
      ? Math.min(MAX_SMOOTH_DT, Math.max(0, dt))
      : 0

    if (snap) {
      this.#position.copy(this.#desiredPosition)
      this.#target.copy(this.#desiredTarget)
    } else {
      this.#position.lerp(
        this.#desiredPosition,
        1 - Math.exp(-smoothDt * tuning.positionResponse)
      )
      this.#target.lerp(
        this.#desiredTarget,
        1 - Math.exp(-smoothDt * tuning.aimResponse)
      )
    }

    // Absolute-space damping can lag behind a fast shoreward carve. Enforce the
    // shot's defining invariant after damping rather than letting one frame cross
    // to the seaward side and flip the composition.
    this.#position.x = Math.max(
      this.#position.x,
      anchor.x + MIN_SHORE_CLEARANCE
    )

    // Aim never dips the look-at under the live surface — keeps the rider and
    // the wave face above the waterline in every frame.
    const targetFloor = Math.max(
      waterHeight(this.#target.x, this.#target.z, player.time),
      0
    ) + 0.35
    if (this.#target.y < targetFloor) this.#target.y = targetFloor

    this.#sightlineLift = this.#clearWaveSightline(
      this.#position,
      this.#target,
      player.time,
      tuning.waterClearance,
      tuning.sightlineClearance
    )

    // Final hard floor: eye must stay above water after every correction.
    const hardFloor = Math.max(
      waterHeight(this.#position.x, this.#position.z, player.time),
      0
    ) + tuning.waterClearance
    if (this.#position.y < hardFloor) this.#position.y = hardFloor

    const localWater = Math.max(
      waterHeight(this.#position.x, this.#position.z, player.time),
      0
    )
    this.#waterClearance = this.#position.y - localWater

    this.#lineDirection = lineDirection
    this.#lastAnchor.copy(anchor)
    this.#initialized = true
    this.#snapped = snap

    camera.position.copy(this.#position)
    camera.up.copy(WORLD_UP)
    this.#lookMatrix.lookAt(this.#position, this.#target, WORLD_UP)
    camera.quaternion.setFromRotationMatrix(this.#lookMatrix)

    const dx = this.#target.x - this.#position.x
    const dy = this.#target.y - this.#position.y
    const dz = this.#target.z - this.#position.z
    this.#viewYaw = Math.atan2(-dx, -dz)
    this.#viewPitch = -Math.atan2(dy, Math.hypot(dx, dz))

    // Speed only adds a restrained sense of motion. Aerial/Flow state never
    // changes the rig or rolls/orbits it, so hero moments retain the same frame.
    const speedRatio = clamp01(Math.max(0, telemetry.speed) / Math.max(1, tuning.fovSpeed))
    const desiredFov = this.#baseFov + tuning.fovBoost * smoothstep(speedRatio)
    this.#fov = snap
      ? desiredFov
      : this.#fov +
        (desiredFov - this.#fov) *
          (1 - Math.exp(-smoothDt * tuning.fovResponse))
    if (Math.abs(camera.fov - this.#fov) > 1e-4) {
      camera.fov = this.#fov
      camera.updateProjectionMatrix()
    }
  }

  /**
   * Lift the eye until samples along the complete view ray clear the animated
   * wave. Raising only the endpoint is insufficient when a crest stands between
   * the shoreward eye and the surfer.
   */
  #clearWaveSightline(
    position: THREE.Vector3,
    target: THREE.Vector3,
    time: number,
    localClearance: number,
    rayClearance: number
  ): number {
    const originalY = position.y
    const cameraFloor = Math.max(waterHeight(position.x, position.z, time), 0) +
      localClearance
    if (position.y < cameraFloor) position.y = cameraFloor

    let lift = 0
    for (let i = 1; i <= SIGHTLINE_SAMPLES; i++) {
      const along = i / (SIGHTLINE_SAMPLES + 1)
      const x = position.x + (target.x - position.x) * along
      const z = position.z + (target.z - position.z) * along
      const rayY = position.y + (target.y - position.y) * along
      const requiredY = Math.max(waterHeight(x, z, time), 0) + rayClearance
      if (rayY >= requiredY) continue
      // A lift at the eye contributes (1-along) of itself at this sample.
      lift = Math.max(lift, (requiredY - rayY) / (1 - along))
    }
    position.y += lift
    return position.y - originalY
  }
}
