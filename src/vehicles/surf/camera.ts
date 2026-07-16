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
 * Dedicated surf rig: chase boom behind the board that slerps onto heading,
 * easing into a low over-tail barrel view in the tube. Never inherits orbit
 * state or mouse look from the normal-world camera.
 */
export type SurfCameraDiagnostics = {
  initialized: boolean
  snapped: boolean
  mode: "chase" | "transition" | "barrel"
  tubeBlend: number
  behindAlignment: number
  roofClearance: number
  lineDirection: -1 | 1
  followYaw: number
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
const MIN_ABOVE_ANCHOR = 1.8

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const smoothstep = (value: number) => value * value * (3 - 2 * value)
const expSmooth = (dt: number, response: number) => 1 - Math.exp(-dt * response)

/**
 * Exclusive surf camera: eye trails behind board facing, looks the same way,
 * and slerps through cutbacks. Position lerps; orientation slerps. Hard cuts
 * only on first enter / wave-reset teleport.
 */
export class SurfCameraController {
  readonly #baseFov: number
  readonly #position = new THREE.Vector3()
  readonly #basePosition = new THREE.Vector3()
  readonly #desiredPosition = new THREE.Vector3()
  readonly #chasePosition = new THREE.Vector3()
  readonly #tubePosition = new THREE.Vector3()
  readonly #target = new THREE.Vector3()
  readonly #desiredTarget = new THREE.Vector3()
  readonly #chaseTarget = new THREE.Vector3()
  readonly #tubeTarget = new THREE.Vector3()
  readonly #riderSightTarget = new THREE.Vector3()
  readonly #lastAnchor = new THREE.Vector3()
  readonly #lookMatrix = new THREE.Matrix4()
  readonly #desiredQuat = new THREE.Quaternion()
  readonly #orientation = new THREE.Quaternion()

  #initialized = false
  #snapped = false
  #lineDirection: -1 | 1 = 1
  /** Smoothed signed down-line travel direction (-1 north … +1 south). The
   *  boom follows this, never the nose, so carves and cutbacks play out under
   *  a steady frame instead of whipping the camera through 180°. */
  #dirSmooth = 1
  /** Yaw of the smoothed travel+shore frame (diagnostics only). */
  #followYaw = 0
  #viewYaw = 0
  #viewPitch = 0
  #fov: number
  #sightlineLiftSmooth = 0
  #waterClearance = 0
  #mode: SurfCameraDiagnostics["mode"] = "chase"
  #tubeBlend = 0
  #behindAlignment = 0
  #roofClearance = 0

  constructor(baseFov: number) {
    this.#baseFov = Number.isFinite(baseFov) ? baseFov : 60
    this.#fov = this.#baseFov
  }

  /** Forget all follow history so the next surf frame starts on the chase rig. */
  reset() {
    this.#initialized = false
    this.#snapped = false
    this.#lineDirection = 1
    this.#dirSmooth = 1
    this.#followYaw = 0
    this.#viewYaw = 0
    this.#viewPitch = 0
    this.#fov = this.#baseFov
    this.#sightlineLiftSmooth = 0
    this.#waterClearance = 0
    this.#mode = "chase"
    this.#tubeBlend = 0
    this.#behindAlignment = 0
    this.#roofClearance = 0
  }

  get viewYaw(): number {
    return this.#viewYaw
  }

  get viewPitch(): number {
    return this.#viewPitch
  }

  diagnostics(): SurfCameraDiagnostics {
    return {
      initialized: this.#initialized,
      snapped: this.#snapped,
      mode: this.#mode,
      tubeBlend: this.#tubeBlend,
      behindAlignment: this.#behindAlignment,
      roofClearance: this.#roofClearance,
      lineDirection: this.#lineDirection,
      followYaw: this.#followYaw,
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
    const smoothDt = Number.isFinite(dt) ? Math.min(MAX_SMOOTH_DT, Math.max(0, dt)) : 0

    // KSPS frame: the boom follows the smoothed down-line travel direction
    // blended TOWARD THE WAVE, from the flat side — the eye sits low over the
    // trough looking back at the rider with the wall as backdrop, and it never
    // crests behind the wave. Only a genuine travel reversal swings the frame,
    // pivoting through the face-on view.
    const rawDirection = telemetry.lineDirection >= 0 ? 1 : -1
    if (!this.#initialized) this.#dirSmooth = rawDirection
    else this.#dirSmooth += (rawDirection - this.#dirSmooth) * expSmooth(smoothDt, tuning.directionResponse)
    const waveLook = THREE.MathUtils.clamp(tuning.waveLook, 0.05, 0.95)
    let forwardX = -waveLook
    let forwardZ = (1 - waveLook) * this.#dirSmooth
    const forwardLen = Math.hypot(forwardX, forwardZ) || 1
    forwardX /= forwardLen
    forwardZ /= forwardLen
    this.#lineDirection = this.#dirSmooth >= 0 ? 1 : -1
    this.#followYaw = Math.atan2(-forwardX, -forwardZ)

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
      this.#tubeBlend >= 0.72 ? "barrel" : this.#tubeBlend > 0.035 ? "transition" : "chase"

    // Eye on the FLAT side of the rider (trailing −forward puts it shoreward
    // + behind travel), seated just above the local water there — not above
    // the rider — so airs launch the surfer up out of frame-center while the
    // camera stays low and looks up, exactly the KSPS read.
    const eyeX = anchor.x - forwardX * tuning.distance
    const eyeZ = anchor.z - forwardZ * tuning.distance
    const eyeWater = this.#waterFloor(eyeX, eyeZ, player.time)
    const airLift = Math.max(0, anchor.y - surfaceFloor) * tuning.airFollow
    this.#chasePosition.set(eyeX, eyeWater + tuning.height + airLift, eyeZ)
    // Aim at the rider with a small down-line lead — rider stays big and
    // near-centred, the wave ahead slides into the leading half of the frame.
    // During airs the aim follows only part of the altitude, so the camera
    // looks UP at the trick while the waterline stays in the bottom of frame.
    const aimY =
      surfaceFloor +
      tuning.targetHeight +
      Math.max(0, anchor.y - surfaceFloor) * tuning.airAim
    this.#chaseTarget.set(
      anchor.x,
      aimY,
      anchor.z + this.#dirSmooth * tuning.lookAhead
    )

    const chaseWater =
      this.#waterFloor(this.#chasePosition.x, this.#chasePosition.z, player.time) +
      tuning.waterClearance
    if (this.#chasePosition.y < chaseWater) this.#chasePosition.y = chaseWater

    // Barrel eye stays crest-relative so a peeling tube does not drag the cam
    // through the wall on long rides.
    const crest = nearestOceanBeachCrest(anchor.x, anchor.z, player.time)
    const riderFaceDistance = Number.isFinite(telemetry.crestDistance)
      ? THREE.MathUtils.clamp(telemetry.crestDistance, 0, OCEAN_BEACH_SURF.tubeSpan)
      : OCEAN_BEACH_SURF.tubeLineOffset
    const cameraFaceDistance = THREE.MathUtils.lerp(
      riderFaceDistance,
      OCEAN_BEACH_SURF.tubeLineOffset,
      tubeDepth
    )
    const tubeEyeZ = anchor.z - forwardZ * tuning.tubeDistance
    const eyeCrest = sampleOceanBeachWave(anchor.x, tubeEyeZ, player.time, crest.slot)
    const tubeEyeX =
      eyeCrest.crestX + cameraFaceDistance + tuning.tubeSideBias - forwardX * tuning.tubeDistance * 0.15
    const eyeSample = sampleOceanBeachWave(tubeEyeX, tubeEyeZ, player.time, crest.slot)
    const tubeEyeFloor = this.#waterFloor(tubeEyeX, tubeEyeZ, player.time)
    const tubeEyeMin = tubeEyeFloor + tuning.tubeWaterClearance
    const tubeEyeMax = Math.max(tubeEyeMin, eyeSample.tubeRoofY - tuning.tubeRoofClearance)
    this.#tubePosition.set(
      tubeEyeX,
      THREE.MathUtils.clamp(tubeEyeFloor + tuning.tubeHeight, tubeEyeMin, tubeEyeMax),
      tubeEyeZ
    )

    const tubeAimZ = anchor.z + forwardZ * tuning.tubeLookAhead
    const aimCrest = sampleOceanBeachWave(anchor.x, tubeAimZ, player.time, crest.slot)
    const tubeAimX = aimCrest.crestX + OCEAN_BEACH_SURF.tubeLineOffset + forwardX * 1.2
    const aimSample = sampleOceanBeachWave(tubeAimX, tubeAimZ, player.time, crest.slot)
    const tubeAimFloor = this.#waterFloor(tubeAimX, tubeAimZ, player.time)
    const tubeAimMin = tubeAimFloor + tuning.tubeWaterClearance
    const tubeAimMax = Math.max(tubeAimMin, aimSample.tubeRoofY - tuning.tubeRoofClearance)
    this.#tubeTarget.set(
      tubeAimX,
      THREE.MathUtils.clamp(tubeAimFloor + tuning.tubeTargetHeight, tubeAimMin, tubeAimMax),
      tubeAimZ
    )

    this.#desiredPosition.lerpVectors(this.#chasePosition, this.#tubePosition, this.#tubeBlend)
    this.#desiredTarget.lerpVectors(this.#chaseTarget, this.#tubeTarget, this.#tubeBlend)

    const teleportDistance = tuning.teleportSnapDistance
    const teleported =
      this.#initialized &&
      anchor.distanceToSquared(this.#lastAnchor) > teleportDistance * teleportDistance
    const snap = !this.#initialized || teleported

    if (snap) {
      this.#basePosition.copy(this.#desiredPosition)
      this.#target.copy(this.#desiredTarget)
      this.#dirSmooth = rawDirection
    } else {
      this.#basePosition.lerp(this.#desiredPosition, expSmooth(smoothDt, tuning.positionResponse))
      this.#target.lerp(this.#desiredTarget, expSmooth(smoothDt, tuning.aimResponse))
    }

    // Only the tube rig pins the eye relative to the rider; the KSPS chase
    // deliberately sits BELOW a rider who is high on the wall or in the air.
    if (this.#tubeBlend > 0.035) {
      const minimumAnchorLift = THREE.MathUtils.lerp(MIN_ABOVE_ANCHOR, 0.15, this.#tubeBlend)
      this.#basePosition.y = Math.max(
        this.#basePosition.y,
        Math.max(anchor.y, surfaceFloor) + minimumAnchorLift
      )
    }

    const activeWaterClearance = THREE.MathUtils.lerp(
      tuning.waterClearance,
      tuning.tubeWaterClearance,
      this.#tubeBlend
    )
    const targetFloor =
      this.#waterFloor(this.#target.x, this.#target.z, player.time) +
      THREE.MathUtils.lerp(0.55, tuning.tubeWaterClearance, this.#tubeBlend)
    if (this.#target.y < targetFloor) this.#target.y = targetFloor

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

    // How well the eye sits behind the rider along board forward.
    const fromCamX = anchor.x - this.#position.x
    const fromCamZ = anchor.z - this.#position.z
    const fromCamLen = Math.hypot(fromCamX, fromCamZ)
    this.#behindAlignment =
      fromCamLen > 1e-4
        ? THREE.MathUtils.clamp(
            (fromCamX * forwardX + fromCamZ * forwardZ) / fromCamLen,
            -1,
            1
          )
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

  #waterFloor(x: number, z: number, time: number): number {
    return waterHeight(x, z, time)
  }

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
