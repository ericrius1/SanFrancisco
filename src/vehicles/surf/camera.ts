import * as THREE from "three/webgpu"
import type { Player } from "../../player/player"
import { waterHeight } from "../../world/heightmap"
import {
  OCEAN_BEACH_SURF,
  nearestOceanBeachCrest,
  sampleOceanBeachWave
} from "../../world/oceanBeachWaves"
import { SURF_CAMERA_TUNING } from "./cameraTuning"

/**
 * Dedicated surf rig: a readable shore-side arcade shot that eases into a low
 * over-tail barrel view. It never inherits orbit-camera state or mouse input
 * from the normal-world camera.
 */
export type SurfCameraDiagnostics = {
  initialized: boolean
  snapped: boolean
  mode: "side" | "transition" | "barrel"
  tubeBlend: number
  behindAlignment: number
  roofClearance: number
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
 * along-beach blend, then moves behind the board when it reaches the tube line.
 * Position always lerps; orientation always slerps. The only hard cut is first
 * enter / a true wave-reset teleport — never a mid-carve lineDirection flip.
 */
export class SurfCameraController {
  readonly #baseFov: number
  readonly #position = new THREE.Vector3()
  readonly #basePosition = new THREE.Vector3()
  readonly #desiredPosition = new THREE.Vector3()
  readonly #sidePosition = new THREE.Vector3()
  readonly #tubePosition = new THREE.Vector3()
  readonly #target = new THREE.Vector3()
  readonly #desiredTarget = new THREE.Vector3()
  readonly #sideTarget = new THREE.Vector3()
  readonly #tubeTarget = new THREE.Vector3()
  readonly #riderSightTarget = new THREE.Vector3()
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
  #sightlineLiftSmooth = 0
  #waterClearance = 0
  #mode: SurfCameraDiagnostics["mode"] = "side"
  #tubeBlend = 0
  #behindAlignment = 0
  #roofClearance = 0

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
    this.#sightlineLiftSmooth = 0
    this.#waterClearance = 0
    this.#mode = "side"
    this.#tubeBlend = 0
    this.#behindAlignment = 0
    this.#roofClearance = 0
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
      mode: this.#mode,
      tubeBlend: this.#tubeBlend,
      behindAlignment: this.#behindAlignment,
      roofClearance: this.#roofClearance,
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
    const smoothDt = Number.isFinite(dt) ? Math.min(MAX_SMOOTH_DT, Math.max(0, dt)) : 0

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
      this.#lineBlend += (desiredLine - this.#lineBlend) * expSmooth(smoothDt, tuning.lineResponse)
      this.#lineDirection = this.#lineBlend >= 0 ? 1 : -1
    }

    const surfaceFloor =
      Number.isFinite(telemetry.surfaceY) && telemetry.grounded
        ? telemetry.surfaceY
        : waterHeight(anchor.x, anchor.z, player.time) + 0.4

    const tubeDepth = smoothstep(clamp01((Math.max(0, telemetry.tubeDepth) - 0.12) / 0.78))
    let requestedTubeBlend = 0
    if (telemetry.tubeState === "entering") {
      requestedTubeBlend = 0.38 + tubeDepth * 0.62
    } else if (telemetry.tubeState === "inside") {
      requestedTubeBlend = 0.72 + tubeDepth * 0.28
    } else if (telemetry.tubeState === "exiting") {
      requestedTubeBlend = tubeDepth * 0.55
    }
    requestedTubeBlend = clamp01(requestedTubeBlend)
    if (!this.#initialized) this.#tubeBlend = requestedTubeBlend
    else {
      const blendResponse =
        requestedTubeBlend > this.#tubeBlend ? tuning.tubeBlendIn : tuning.tubeBlendOut
      this.#tubeBlend += (requestedTubeBlend - this.#tubeBlend) * expSmooth(smoothDt, blendResponse)
    }
    this.#tubeBlend = clamp01(this.#tubeBlend)
    this.#mode =
      this.#tubeBlend >= 0.72 ? "barrel" : this.#tubeBlend > 0.035 ? "transition" : "side"

    // Shoreward X is fixed; Z trail / look-ahead use the smoothed blend so a
    // cutback orbits the rider instead of cutting to the opposite side.
    this.#sidePosition.set(
      anchor.x + tuning.shoreOffset,
      Math.max(anchor.y, surfaceFloor) + tuning.height,
      anchor.z - this.#lineBlend * tuning.distance
    )
    this.#sideTarget.set(
      anchor.x,
      Math.max(anchor.y, surfaceFloor) + tuning.targetHeight,
      anchor.z + this.#lineBlend * tuning.lookAhead
    )

    const sideWater =
      this.#waterFloor(this.#sidePosition.x, this.#sidePosition.z, player.time) +
      tuning.waterClearance
    if (this.#sidePosition.y < sideWater) this.#sidePosition.y = sideWater

    // A tube is not another fixed offset from the player. The crest bends down
    // the beach, so both the eye and aperture are rebuilt from the locked live
    // crest at their own Z positions. That keeps the camera inside a peeling
    // barrel instead of drifting through its wall on long rides.
    const crest = nearestOceanBeachCrest(anchor.x, anchor.z, player.time)
    const riderFaceDistance = Number.isFinite(telemetry.crestDistance)
      ? THREE.MathUtils.clamp(telemetry.crestDistance, 0, OCEAN_BEACH_SURF.tubeSpan)
      : OCEAN_BEACH_SURF.tubeLineOffset
    const cameraFaceDistance = THREE.MathUtils.lerp(
      riderFaceDistance,
      OCEAN_BEACH_SURF.tubeLineOffset,
      tubeDepth
    )
    const tubeEyeZ = anchor.z - this.#lineBlend * tuning.tubeDistance
    const eyeCrest = sampleOceanBeachWave(anchor.x, tubeEyeZ, player.time, crest.slot)
    const tubeEyeX = eyeCrest.crestX + cameraFaceDistance + tuning.tubeShoreOffset
    const eyeSample = sampleOceanBeachWave(tubeEyeX, tubeEyeZ, player.time, crest.slot)
    const tubeEyeFloor = this.#waterFloor(tubeEyeX, tubeEyeZ, player.time)
    const tubeEyeMin = tubeEyeFloor + tuning.tubeWaterClearance
    const tubeEyeMax = Math.max(tubeEyeMin, eyeSample.tubeRoofY - tuning.tubeRoofClearance)
    this.#tubePosition.set(
      tubeEyeX,
      THREE.MathUtils.clamp(tubeEyeFloor + tuning.tubeHeight, tubeEyeMin, tubeEyeMax),
      tubeEyeZ
    )

    const tubeAimZ = anchor.z + this.#lineBlend * tuning.tubeLookAhead
    const aimCrest = sampleOceanBeachWave(anchor.x, tubeAimZ, player.time, crest.slot)
    const tubeAimX = aimCrest.crestX + OCEAN_BEACH_SURF.tubeLineOffset
    const aimSample = sampleOceanBeachWave(tubeAimX, tubeAimZ, player.time, crest.slot)
    const tubeAimFloor = this.#waterFloor(tubeAimX, tubeAimZ, player.time)
    const tubeAimMin = tubeAimFloor + tuning.tubeWaterClearance
    const tubeAimMax = Math.max(tubeAimMin, aimSample.tubeRoofY - tuning.tubeRoofClearance)
    this.#tubeTarget.set(
      tubeAimX,
      THREE.MathUtils.clamp(tubeAimFloor + tuning.tubeTargetHeight, tubeAimMin, tubeAimMax),
      tubeAimZ
    )

    this.#desiredPosition.lerpVectors(this.#sidePosition, this.#tubePosition, this.#tubeBlend)
    this.#desiredTarget.lerpVectors(this.#sideTarget, this.#tubeTarget, this.#tubeBlend)

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
      this.#basePosition.lerp(this.#desiredPosition, expSmooth(smoothDt, tuning.positionResponse))
      this.#target.lerp(this.#desiredTarget, expSmooth(smoothDt, tuning.aimResponse))
    }

    const minimumShoreOffset = THREE.MathUtils.lerp(MIN_SHORE_CLEARANCE, -0.75, this.#tubeBlend)
    this.#basePosition.x = Math.max(this.#basePosition.x, anchor.x + minimumShoreOffset)
    const minimumAnchorLift = THREE.MathUtils.lerp(MIN_ABOVE_ANCHOR, 0.15, this.#tubeBlend)
    this.#basePosition.y = Math.max(
      this.#basePosition.y,
      Math.max(anchor.y, surfaceFloor) + minimumAnchorLift
    )

    const activeWaterClearance = THREE.MathUtils.lerp(
      tuning.waterClearance,
      tuning.tubeWaterClearance,
      this.#tubeBlend
    )
    const targetFloor =
      this.#waterFloor(this.#target.x, this.#target.z, player.time) +
      THREE.MathUtils.lerp(0.55, tuning.tubeWaterClearance, this.#tubeBlend)
    if (this.#target.y < targetFloor) this.#target.y = targetFloor

    // Side view rises over an obstructing crest. Inside a tube that would erase
    // the defining roof silhouette, so the lift fades out with the rig blend.
    // Measure from the un-lifted base so the offset never accumulates.
    this.#riderSightTarget.set(
      anchor.x,
      Math.max(anchor.y, surfaceFloor) + 0.72,
      anchor.z
    )
    const rawLift =
      Math.max(
        this.#measureSightlineLift(
          this.#basePosition,
          this.#target,
          player.time,
          activeWaterClearance,
          tuning.sightlineClearance
        ),
        // The composition looks ahead down-line, but the rider is the hero.
        // Guard their own ray too or a low close camera can see its aperture
        // while the foreground ramp hides the board and body.
        this.#measureSightlineLift(
          this.#basePosition,
          this.#riderSightTarget,
          player.time,
          activeWaterClearance,
          Math.max(0.28, tuning.sightlineClearance * 0.72)
        )
      ) *
      (1 - smoothstep(this.#tubeBlend))
    if (snap) this.#sightlineLiftSmooth = rawLift
    else {
      this.#sightlineLiftSmooth +=
        (rawLift - this.#sightlineLiftSmooth) * expSmooth(smoothDt, tuning.positionResponse)
    }
    this.#position.copy(this.#basePosition)
    this.#position.y += this.#sightlineLiftSmooth

    const hardFloor =
      this.#waterFloor(this.#position.x, this.#position.z, player.time) + activeWaterClearance
    if (this.#position.y < hardFloor) this.#position.y = hardFloor

    // During the hand-off, ease under the analytic crown. Once gameplay says
    // the rider is inside (or the rig is substantially behind them), enforce
    // the envelope exactly: no camera-through-water and no camera-through-roof.
    const localWater = this.#waterFloor(this.#position.x, this.#position.z, player.time)
    const positionSample = sampleOceanBeachWave(
      this.#position.x,
      this.#position.z,
      player.time,
      crest.slot
    )
    const tubeFloor = localWater + tuning.tubeWaterClearance
    const tubeRoof = positionSample.tubeRoofY - tuning.tubeRoofClearance
    if (this.#tubeBlend > 0.035 && tubeRoof > tubeFloor) {
      const envelopeY = THREE.MathUtils.clamp(this.#position.y, tubeFloor, tubeRoof)
      const hardTubeClamp = telemetry.tubeState === "inside" || this.#mode === "barrel"
      const clampBlend = hardTubeClamp ? 1 : smoothstep(clamp01((this.#tubeBlend - 0.035) / 0.685))
      this.#position.y = THREE.MathUtils.lerp(this.#position.y, envelopeY, clampBlend)
    }

    if (this.#tubeBlend > 0.035) {
      const targetWater = this.#waterFloor(this.#target.x, this.#target.z, player.time)
      const targetSample = sampleOceanBeachWave(
        this.#target.x,
        this.#target.z,
        player.time,
        crest.slot
      )
      const apertureFloor = targetWater + tuning.tubeWaterClearance
      const apertureRoof = targetSample.tubeRoofY - tuning.tubeRoofClearance
      if (apertureRoof > apertureFloor) {
        const apertureY = THREE.MathUtils.clamp(this.#target.y, apertureFloor, apertureRoof)
        const hardApertureClamp = telemetry.tubeState === "inside" || this.#mode === "barrel"
        const clampBlend = hardApertureClamp
          ? 1
          : smoothstep(clamp01((this.#tubeBlend - 0.035) / 0.685))
        this.#target.y = THREE.MathUtils.lerp(this.#target.y, apertureY, clampBlend)
      }
    }

    this.#waterClearance = this.#position.y - localWater
    this.#roofClearance = this.#tubeBlend > 0.035 ? positionSample.tubeRoofY - this.#position.y : 0

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
      this.#orientation.slerp(this.#desiredQuat, expSmooth(smoothDt, tuning.orientationResponse))
    }
    camera.quaternion.copy(this.#orientation)

    const dx = this.#target.x - this.#position.x
    const dy = this.#target.y - this.#position.y
    const dz = this.#target.z - this.#position.z
    this.#viewYaw = Math.atan2(-dx, -dz)
    this.#viewPitch = -Math.atan2(dy, Math.hypot(dx, dz))
    const horizontalView = Math.hypot(dx, dz)
    this.#behindAlignment =
      horizontalView > 1e-4
        ? THREE.MathUtils.clamp((dz / horizontalView) * this.#lineDirection, -1, 1)
        : 0

    const speedRatio = clamp01(Math.max(0, telemetry.speed) / Math.max(1, tuning.fovSpeed))
    const desiredFov =
      this.#baseFov +
      tuning.fovBoost * smoothstep(speedRatio) +
      tuning.tubeFovOffset * smoothstep(this.#tubeBlend)
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
