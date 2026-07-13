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
  lineBlend: number
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
const SIGHTLINE_SAMPLES = 10
// Even after follow lag, preserve an unmistakable shore-side (+X) viewpoint.
const MIN_SHORE_CLEARANCE = 0.75
// Never let follow lag put the eye below the rider's deck by more than this.
const MIN_ABOVE_ANCHOR = 2.5
// Ignore near-zero Z travel so a carve through east/west never flips the trail.
const LINE_HYSTERESIS = 0.28

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const smoothstep = (value: number) => value * value * (3 - 2 * value)
const expSmooth = (dt: number, response: number) => 1 - Math.exp(-dt * response)

/**
 * Exclusive surf camera: shoreward eye (+X), trails/looks along a *smoothed*
 * along-beach blend. Position always lerps; orientation always slerps. The only
 * hard cut is first enter / a true wave-reset teleport — never a mid-carve
 * lineDirection flip (that used to read as the player teleporting).
 */
export class SurfCameraController {
  readonly #baseFov: number
  readonly #position = new THREE.Vector3()
  readonly #basePosition = new THREE.Vector3()
  readonly #desiredPosition = new THREE.Vector3()
  readonly #target = new THREE.Vector3()
  readonly #desiredTarget = new THREE.Vector3()
  readonly #lastAnchor = new THREE.Vector3()
  readonly #lookMatrix = new THREE.Matrix4()
  readonly #desiredQuat = new THREE.Quaternion()
  readonly #orientation = new THREE.Quaternion()

  #initialized = false
  #snapped = false
  /** Discrete telemetry side, for diagnostics only. */
  #lineDirection: -1 | 1 = 1
  /** Continuous trail/look blend in [-1, 1]; this is what framing actually uses. */
  #lineBlend = 1
  #viewYaw = 0
  #viewPitch = 0
  #fov: number
  #sightlineLift = 0
  #sightlineLiftSmooth = 0
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
    this.#lineBlend = 1
    this.#viewYaw = 0
    this.#viewPitch = 0
    this.#fov = this.#baseFov
    this.#sightlineLift = 0
    this.#sightlineLiftSmooth = 0
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
      lineBlend: this.#lineBlend,
      viewYaw: this.#viewYaw,
      viewPitch: this.#viewPitch,
      fov: this.#fov,
      sightlineLift: this.#sightlineLiftSmooth,
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
    const telemetryLine: -1 | 1 = telemetry.lineDirection < 0 ? -1 : 1
    const smoothDt = Number.isFinite(dt)
      ? Math.min(MAX_SMOOTH_DT, Math.max(0, dt))
      : 0

    // Board facing (storage heading is facing + π). Prefer that over raw
    // lineDirection so a carve through east/west does not bang the trail side.
    const facingYaw = player.heading - Math.PI
    const travelZ = -Math.cos(facingYaw)
    let desiredLine = this.#lineDirection
    if (travelZ > LINE_HYSTERESIS) desiredLine = 1
    else if (travelZ < -LINE_HYSTERESIS) desiredLine = -1
    else if (telemetryLine === this.#lineDirection) desiredLine = telemetryLine

    if (!this.#initialized) {
      this.#lineBlend = desiredLine
      this.#lineDirection = desiredLine
    } else {
      this.#lineBlend +=
        (desiredLine - this.#lineBlend) * expSmooth(smoothDt, tuning.lineResponse)
      this.#lineDirection = this.#lineBlend >= 0 ? 1 : -1
    }

    const surfaceFloor =
      Number.isFinite(telemetry.surfaceY) && telemetry.grounded
        ? telemetry.surfaceY
        : waterHeight(anchor.x, anchor.z, player.time) + 0.4

    // Shoreward X is fixed; Z trail / look-ahead use the smoothed blend so a
    // cutback orbits the rider instead of cutting to the opposite side.
    this.#desiredPosition.set(
      anchor.x + tuning.shoreOffset,
      Math.max(anchor.y, surfaceFloor) + tuning.height,
      anchor.z - this.#lineBlend * tuning.distance
    )
    this.#desiredTarget.set(
      anchor.x,
      Math.max(anchor.y, surfaceFloor) + tuning.targetHeight,
      anchor.z + this.#lineBlend * tuning.lookAhead
    )

    const desiredWater =
      this.#waterFloor(this.#desiredPosition.x, this.#desiredPosition.z, player.time) +
      tuning.waterClearance
    if (this.#desiredPosition.y < desiredWater)
      this.#desiredPosition.y = desiredWater

    // Only hard-cut on first enter or a real wave-reset pocket hop. Mid-ride
    // line flips must never snap — that read as a player teleport.
    const teleportDistance = tuning.teleportSnapDistance
    const teleported =
      this.#initialized &&
      anchor.distanceToSquared(this.#lastAnchor) > teleportDistance * teleportDistance
    const snap = !this.#initialized || teleported

    if (snap) {
      this.#basePosition.copy(this.#desiredPosition)
      this.#target.copy(this.#desiredTarget)
      this.#lineBlend = desiredLine
      this.#lineDirection = desiredLine
    } else {
      this.#basePosition.lerp(
        this.#desiredPosition,
        expSmooth(smoothDt, tuning.positionResponse)
      )
      this.#target.lerp(
        this.#desiredTarget,
        expSmooth(smoothDt, tuning.aimResponse)
      )
    }

    this.#basePosition.x = Math.max(
      this.#basePosition.x,
      anchor.x + MIN_SHORE_CLEARANCE
    )
    this.#basePosition.y = Math.max(
      this.#basePosition.y,
      Math.max(anchor.y, surfaceFloor) + MIN_ABOVE_ANCHOR
    )

    const targetFloor =
      this.#waterFloor(this.#target.x, this.#target.z, player.time) + 0.55
    if (this.#target.y < targetFloor) this.#target.y = targetFloor

    // Measure lift from the un-lifted base so the offset never accumulates.
    const rawLift = this.#measureSightlineLift(
      this.#basePosition,
      this.#target,
      player.time,
      tuning.waterClearance,
      tuning.sightlineClearance
    )
    if (snap) this.#sightlineLiftSmooth = rawLift
    else {
      this.#sightlineLiftSmooth +=
        (rawLift - this.#sightlineLiftSmooth) *
        expSmooth(smoothDt, tuning.positionResponse)
    }
    this.#sightlineLift = this.#sightlineLiftSmooth
    this.#position.copy(this.#basePosition)
    this.#position.y += this.#sightlineLiftSmooth

    const hardFloor =
      this.#waterFloor(this.#position.x, this.#position.z, player.time) +
      tuning.waterClearance
    if (this.#position.y < hardFloor) this.#position.y = hardFloor

    const localWater = this.#waterFloor(this.#position.x, this.#position.z, player.time)
    this.#waterClearance = this.#position.y - localWater

    this.#lastAnchor.copy(anchor)
    this.#initialized = true
    this.#snapped = snap

    camera.position.copy(this.#position)
    camera.up.copy(WORLD_UP)
    this.#lookMatrix.lookAt(this.#position, this.#target, WORLD_UP)
    this.#desiredQuat.setFromRotationMatrix(this.#lookMatrix)
    if (snap || !this.#orientationStable()) {
      this.#orientation.copy(this.#desiredQuat)
    } else {
      this.#orientation.slerp(
        this.#desiredQuat,
        expSmooth(smoothDt, tuning.orientationResponse)
      )
    }
    camera.quaternion.copy(this.#orientation)

    const dx = this.#target.x - this.#position.x
    const dy = this.#target.y - this.#position.y
    const dz = this.#target.z - this.#position.z
    this.#viewYaw = Math.atan2(-dx, -dz)
    this.#viewPitch = -Math.atan2(dy, Math.hypot(dx, dz))

    const speedRatio = clamp01(Math.max(0, telemetry.speed) / Math.max(1, tuning.fovSpeed))
    const desiredFov = this.#baseFov + tuning.fovBoost * smoothstep(speedRatio)
    this.#fov = snap
      ? desiredFov
      : this.#fov + (desiredFov - this.#fov) * expSmooth(smoothDt, tuning.fovResponse)
    if (Math.abs(camera.fov - this.#fov) > 1e-4) {
      camera.fov = this.#fov
      camera.updateProjectionMatrix()
    }
  }

  #orientationStable(): boolean {
    return (
      Number.isFinite(this.#orientation.x) &&
      Number.isFinite(this.#orientation.y) &&
      Number.isFinite(this.#orientation.z) &&
      Number.isFinite(this.#orientation.w) &&
      this.#orientation.lengthSq() > 0.5
    )
  }

  /** Surf never treats troughs as dry land; keep the analytic surface intact. */
  #waterFloor(x: number, z: number, time: number): number {
    return waterHeight(x, z, time)
  }

  /**
   * How far the eye must rise so samples along the view ray clear the wave.
   * Applied as a smoothed offset by the caller — never written as a hard jump.
   */
  #measureSightlineLift(
    position: THREE.Vector3,
    target: THREE.Vector3,
    time: number,
    localClearance: number,
    rayClearance: number
  ): number {
    const eyeY = Math.max(
      position.y,
      this.#waterFloor(position.x, position.z, time) + localClearance
    )
    let lift = Math.max(0, eyeY - position.y)
    for (let i = 1; i <= SIGHTLINE_SAMPLES; i++) {
      const along = i / (SIGHTLINE_SAMPLES + 1)
      const x = position.x + (target.x - position.x) * along
      const z = position.z + (target.z - position.z) * along
      const rayY = eyeY + (target.y - eyeY) * along
      const requiredY = this.#waterFloor(x, z, time) + rayClearance
      if (rayY >= requiredY) continue
      lift = Math.max(lift, (requiredY - rayY) / (1 - along) + (eyeY - position.y))
    }
    return lift
  }
}
