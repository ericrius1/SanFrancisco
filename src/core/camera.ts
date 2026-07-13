import * as THREE from "three/webgpu"
import type { Input } from "./input"
import type { Player } from "../player/player"
import type { PlayerMode } from "../player/types"
import { waterHeight, type WorldMap } from "../world/heightmap"
import { oceanBeachWaveHeight } from "../world/oceanBeachWaves"
import type { Physics } from "./physics"
import { CAMERA_TUNING } from "../config"
import {
  clearCameraCutaway,
  updateCameraCutaway
} from "../render/cameraCutaway"
import type {
  SurfCameraController,
  SurfCameraDiagnostics
} from "../vehicles/surf/camera"
import { SURF_CAMERA_TUNING } from "../vehicles/surf/cameraTuning"

const OFFSETS: Record<PlayerMode, { back: number; up: number; look: number }> =
  {
    walk: { back: 6.5, up: 2.4, look: 1.4 },
    drive: { back: 9.5, up: 3.2, look: 1.2 },
    scooter: { back: 7.8, up: 2.8, look: 1.25 },
    plane: { back: 17, up: 4.6, look: 0 },
    boat: { back: 12, up: 4.2, look: 0.8 },
    speedboat: { back: 11, up: 3.6, look: 0.7 },
    drone: { back: 7, up: 1.9, look: 0.4 },
    board: { back: 7.5, up: 2.6, look: 1.3 },
    surf: { back: 9.2, up: 1.65, look: 2.6 },
    bird: { back: 15, up: 3.1, look: 0.55 }
  }

// Build the outdoor and indoor rigs independently, then blend the complete
// poses. Keeping these values together makes the transition easy to tune without
// letting chase-camera zoom or framing leak into the first-person endpoint.
const VIEW = {
  outdoorPitchMin: -0.62,
  outdoorPitchMax: 1.2,
  firstPersonPitchMin: -1.45,
  firstPersonPitchMax: 1.45,
  eyeHeight: 0.8,
  transitionRate: 7,
  firstPersonFollow: 48,
  // Wider indoor FOV reads as more room once the eye is inside the walls.
  firstPersonFovBoost: 15
} as const

const smoothstep = (t: number) => t * t * (3 - 2 * t)

// A continuous vehicle can cover this distance only over many rendered frames.
// Crossing it in one camera sample is therefore a world-space relocation, not
// follow motion. Keep this local fallback even when the normal teleport caller
// uses cutTo(), so restores/invites cannot accidentally fly the camera across SF.
const TELEPORT_SNAP_DISTANCE = 45
const TELEPORT_SNAP_DISTANCE_SQ = TELEPORT_SNAP_DISTANCE * TELEPORT_SNAP_DISTANCE

// Per-mode camera volume and minimum readable framing. `comfort` is the nearest
// boom distance we keep once the cutaway takes over; `cutRadius` is the visual
// tunnel radius around the sight line. Large/faster mounts need more context.
const OCCLUSION: Record<
  PlayerMode,
  { radius: number; comfort: number; cutRadius: number }
> = {
  walk: { radius: 0.34, comfort: 2.2, cutRadius: 1.4 },
  drive: { radius: 0.62, comfort: 5.0, cutRadius: 3.1 },
  scooter: { radius: 0.46, comfort: 3.6, cutRadius: 2.2 },
  plane: { radius: 0.9, comfort: 9.0, cutRadius: 5.2 },
  boat: { radius: 0.68, comfort: 6.0, cutRadius: 3.8 },
  speedboat: { radius: 0.68, comfort: 5.5, cutRadius: 3.6 },
  drone: { radius: 0.42, comfort: 3.4, cutRadius: 2.0 },
  board: { radius: 0.46, comfort: 3.5, cutRadius: 2.2 },
  surf: { radius: 0.58, comfort: 5.0, cutRadius: 3.0 },
  bird: { radius: 0.85, comfort: 8.0, cutRadius: 4.8 }
}

/**
 * Pointer-lock chase camera. The mouse owns yaw/pitch (no orbit button) and
 * the camera never recenters on its own.
 */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera
  yaw = 0
  pitch = 0.3
  zoom = 1
  shakeAmount = 0
  /** Set true while the player is inside a building. The camera blends to a
   *  zoom-independent eye pose with true yaw/pitch orientation. */
  indoor = false
  /** Activities such as archery can request the same eye rig outdoors. */
  activityFirstPerson = false
  #indoor = 0 // smoothed 0..1

  #chasePos = new THREE.Vector3()
  #eyePos = new THREE.Vector3()
  #orbitPos = new THREE.Vector3()
  #firstPersonPos = new THREE.Vector3()
  #orbitViewPos = new THREE.Vector3()
  #viewDir = new THREE.Vector3()
  #target = new THREE.Vector3()
  #orbitQuat = new THREE.Quaternion()
  #heldOrbitQuat = new THREE.Quaternion()
  #firstPersonQuat = new THREE.Quaternion()
  #lookMatrix = new THREE.Matrix4()
  #firstPersonEuler = new THREE.Euler(0, 0, 0, "YXZ")
  #up = new THREE.Vector3(0, 1, 0)
  #firstPersonAvatarHidden = false
  #safeBoomDistance = 0
  #cutaway = 0
  #buildingBlocked = false
  #lastHitDistance = Infinity
  #initialized = false
  #externallyOwned = false
  #holdOrbitPose = false
  #lastAnchor = new THREE.Vector3()
  #hasLastAnchor = false
  #cutOnResume = false
  #lastMode: PlayerMode | null = null
  #surfCamera: SurfCameraController | null = null
  #surfCameraLoading: Promise<void> | null = null
  #surfCameraLoadFailed = false
  #outdoorFov: number
  #map: WorldMap
  #physics: Physics

  constructor(camera: THREE.PerspectiveCamera, map: WorldMap, physics: Physics) {
    this.camera = camera
    this.#outdoorFov = camera.fov
    this.#map = map
    this.#physics = physics
  }

  shake(amount: number) {
    this.shakeAmount = Math.min(1.6, this.shakeAmount + amount)
  }

  /** Allocation-on-demand runtime probe; the hot update path remains allocation-free. */
  obstructionDiagnostics() {
    return {
      blocked: this.#buildingBlocked,
      hitDistance: this.#lastHitDistance,
      safeBoomDistance: this.#safeBoomDistance,
      cutaway: this.#cutaway
    }
  }

  surfCameraDiagnostics(): SurfCameraDiagnostics | null {
    return this.#surfCamera?.diagnostics() ?? null
  }

  /** First-use gate for the activity-only camera chunk. */
  ensureSurfCamera(): Promise<void> {
    if (this.#surfCamera) return Promise.resolve()
    if (this.#surfCameraLoadFailed) return Promise.resolve()
    if (this.#surfCameraLoading) return this.#surfCameraLoading
    this.#surfCameraLoading = import("../vehicles/surf/camera")
      .then(({ SurfCameraController }) => {
        this.#surfCamera ??= new SurfCameraController(this.#outdoorFov)
      })
      .catch((error) => {
        this.#surfCameraLoadFailed = true
        console.warn("[surf] camera failed to load", error)
      })
      .finally(() => {
        this.#surfCameraLoading = null
      })
    return this.#surfCameraLoading
  }

  /** Eased first-person contribution, used by interaction rays and diagnostics. */
  get firstPersonBlend(): number {
    return smoothstep(this.#indoor)
  }

  /** Blend the avatar's third-person muzzle into the actual eye in first person. */
  viewOrigin(out: THREE.Vector3, player: Player): THREE.Vector3 {
    out.copy(player.aimOrigin)
    const blend = player.mode === "walk" ? this.firstPersonBlend : 0
    return out.lerp(this.camera.position, blend)
  }

  /** Exact rendered direction during an indoor handoff; canonical look outdoors. */
  interactionDir(out: THREE.Vector3, player: Player): THREE.Vector3 {
    if (player.mode === "walk" && this.firstPersonBlend > 0.001)
      return this.camera.getWorldDirection(out)
    return this.lookDir(out)
  }

  /** Hand camera ownership to orbit/cinematics and restore the local avatar. */
  suspend(player: Player) {
    if (!this.#externallyOwned) {
      this.#externallyOwned = true
      this.#surfCamera?.reset()
    }
    this.#indoor = 0
    this.#holdOrbitPose = false
    this.#firstPersonAvatarHidden = false
    this.#safeBoomDistance = 0
    this.#cutaway = 0
    this.#buildingBlocked = false
    this.#lastHitDistance = Infinity
    clearCameraCutaway()
    player.setFirstPersonView(false)
    this.#applyFov(0)
  }

  #resume(player: Player) {
    if (!this.#externallyOwned) return
    this.#externallyOwned = false
    this.camera.getWorldDirection(this.#viewDir)
    this.yaw = Math.atan2(-this.#viewDir.x, -this.#viewDir.z)
    this.pitch = THREE.MathUtils.clamp(
      -Math.asin(THREE.MathUtils.clamp(this.#viewDir.y, -1, 1)),
      VIEW.firstPersonPitchMin,
      VIEW.firstPersonPitchMax
    )
    this.#orbitPos.copy(this.camera.position)
    this.#heldOrbitQuat.copy(this.camera.quaternion)
    this.#firstPersonPos.set(
      player.renderPosition.x,
      player.renderPosition.y + VIEW.eyeHeight,
      player.renderPosition.z
    )
    this.#holdOrbitPose = this.indoor && player.mode === "walk"
    this.#initialized = true
  }

  update(dt: number, player: Player, input: Input) {
    this.#resume(player)
    if (player.mode === "surf") {
      // Surf is a complete camera context. It deliberately consumes no Input,
      // orbit/zoom state, board roll, or Flow hero-shot rotation.
      this.#indoor = 0
      this.#holdOrbitPose = false
      this.#firstPersonAvatarHidden = false
      this.#safeBoomDistance = 0
      this.#cutaway = 0
      this.#buildingBlocked = false
      this.#lastHitDistance = Infinity
      player.setFirstPersonView(false)
      clearCameraCutaway()
      if (this.#surfCamera) {
        this.#surfCamera.update(dt, this.camera, player)
        this.yaw = this.#surfCamera.viewYaw
        this.pitch = this.#surfCamera.viewPitch
      } else {
        // The activity chunk normally arrives within a frame. Until then, use a
        // tiny authored fallback with the same invariant: no world-camera input,
        // shoreward eye, and visible line ahead.
        void this.ensureSurfCamera()
        const tuning = SURF_CAMERA_TUNING.values
        const direction = player.surfTelemetry.lineDirection < 0 ? -1 : 1
        const anchor = player.renderPosition
        this.#chasePos.set(
          anchor.x + tuning.shoreOffset,
          anchor.y + tuning.height,
          anchor.z - direction * tuning.distance
        )
        this.#chasePos.y = Math.max(
          this.#chasePos.y,
          Math.max(waterHeight(this.#chasePos.x, this.#chasePos.z, player.time), 0) + tuning.waterClearance
        )
        this.#target.set(
          anchor.x,
          anchor.y + tuning.targetHeight,
          anchor.z + direction * tuning.lookAhead
        )
        this.camera.position.copy(this.#chasePos)
        this.camera.up.copy(this.#up)
        this.camera.lookAt(this.#target)
        this.camera.getWorldDirection(this.#viewDir)
        this.yaw = Math.atan2(-this.#viewDir.x, -this.#viewDir.z)
        this.pitch = -Math.asin(THREE.MathUtils.clamp(this.#viewDir.y, -1, 1))
      }
      this.#lastMode = "surf"
      return
    }
    const leavingSurf = this.#lastMode === "surf"
    if (leavingSurf) {
      this.#surfCameraLoadFailed = false
      // Reset the dedicated rig. The ordinary walk pose is snapped below because
      // surf exit atomically teleports from the break to sand; interpolating that
      // distance would look like the camera had escaped player control.
      this.#orbitPos.copy(this.camera.position)
      this.#firstPersonPos.copy(this.camera.position)
      this.#initialized = true
      this.#surfCamera?.reset()
    }
    const indoorTarget = (this.indoor || this.activityFirstPerson) && player.mode === "walk" ? 1 : 0
    this.#indoor +=
      (indoorTarget - this.#indoor) *
      (1 - Math.exp(-Math.min(dt, 0.1) * VIEW.transitionRate))
    // A vehicle switch must drop the active eye rig immediately. The stored
    // scalar may decay in the background so returning to walk remains smooth.
    const firstPersonBlend = player.mode === "walk" ? this.firstPersonBlend : 0
    this.#applyFov(firstPersonBlend)
    // Hide late on entry, after the avatar nearly fills the frame, and restore
    // farther back on exit. The hysteresis avoids both clipped self-geometry and
    // a visible on/off flutter around the threshold.
    if (player.mode !== "walk" || firstPersonBlend < 0.5)
      this.#firstPersonAvatarHidden = false
    else if (firstPersonBlend > 0.9)
      this.#firstPersonAvatarHidden = true
    player.setFirstPersonView(this.#firstPersonAvatarHidden)

    if (player.mode === "plane") {
      // The mouse *flies the plane* (steerFly), so the camera must ride behind
      // the nose rather than orbit off the same mouse — integrating both at
      // different rates is what drifted the view around to the plane's side and
      // eventually flipped it. Ease yaw/pitch toward the plane's heading so the
      // chase cam always trails the flight path, no matter how hard you turn.
      const f = player.flyForward
      const targetYaw = Math.atan2(-f.x, -f.z)
      const targetPitch = THREE.MathUtils.clamp(
        -Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)),
        -0.62,
        1.2
      )
      const follow = 1 - Math.exp(-dt * 7)
      let dYaw = targetYaw - this.yaw
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw)) // shortest way round
      this.yaw += dYaw * follow
      this.pitch += (targetPitch - this.pitch) * follow
    } else {
      this.yaw -= input.mouseDX * 0.0032
      // Orbit mode keeps framing-safe limits. The range widens almost to vertical
      // as first person takes over, then contracts with the same smooth blend on
      // exit so an extreme indoor pitch never snaps back in one frame.
      const pitchMin = THREE.MathUtils.lerp(
        VIEW.outdoorPitchMin,
        VIEW.firstPersonPitchMin,
        firstPersonBlend
      )
      const pitchMax = THREE.MathUtils.lerp(
        VIEW.outdoorPitchMax,
        VIEW.firstPersonPitchMax,
        firstPersonBlend
      )
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + input.mouseDY * 0.0026,
        pitchMin,
        pitchMax
      )
    }
    // FPS ignores chase zoom, so do not silently mutate the outdoor boom while
    // the wheel appears to do nothing indoors. Vehicle modes remain unaffected.
    if (player.mode !== "walk" || (indoorTarget === 0 && firstPersonBlend < 0.001)) {
      this.zoom = THREE.MathUtils.clamp(
        this.zoom * (1 + input.wheel * 0.0009),
        0.45,
        2.6
      )
    }

    const o = OFFSETS[player.mode]
    const backBase = o.back * this.zoom
    let back = backBase
    let up = o.up * this.zoom
    // bigger phoenix needs more boom; tuck/stoop adds a little more so the mount
    // stays in frame instead of filling the viewport at triple speed
    if (player.mode === "bird") {
      const fast = THREE.MathUtils.clamp(player.speed / 110, 0, 1)
      back = backBase * (1 + fast * 0.38)
      up += fast * 1.1
    }

    // anchor on the interpolated render transform — the raw physics transform
    // only advances at the fixed step and stutters at high refresh rates
    const anchor = player.renderPosition
    this.#target.copy(anchor)
    this.#target.y += o.look
    const cx = anchor.x + Math.sin(this.yaw) * Math.cos(this.pitch) * back
    const cz = anchor.z + Math.cos(this.yaw) * Math.cos(this.pitch) * back
    const cy = anchor.y + up + Math.sin(this.pitch) * back

    this.#chasePos.set(cx, cy, cz)

    // keep above the terrain/seabed only — NOT above sea level. Clamping to y=0
    // used to pin the camera on the surface, so diving or a sinking car left the
    // view locked overhead. Following down to the bay floor lets the shot stay on
    // the player underwater; the seabed clamp still stops it clipping through.
    const floor = this.#map.effectiveGround(cx, cz) + 0.7
    if (this.#chasePos.y < floor) this.#chasePos.y = floor
    // Swim camera: surface rest stays above the live waterline (a low boom must
    // not flash the underwater overlay); a committed dive still ducks under.
    // Dive detection uses the calm/mean surface — Ocean Beach crests otherwise
    // spike waterY by metres and false-trigger the underwater path while the
    // body is still surface-swimming. Clearance sits above the overlay
    // hysteresis (~0.45 m) so swell bob doesn't flicker the tint.
    let surfaceSwimCam = false
    if (player.mode === "walk") {
      const waterY = waterHeight(anchor.x, anchor.z, player.time)
      const calmY =
        waterY - oceanBeachWaveHeight(anchor.x, anchor.z, player.time)
      const seabed = this.#map.effectiveGround(anchor.x, anchor.z)
      // threshold sits well below the surface-swim rest (~0.5 m down) so bobbing
      // at the top keeps the eye above water; only a committed dive ducks it under
      const deepDive = anchor.y < calmY - 1.6 && seabed < calmY - 2.5
      if (deepDive) {
        this.#chasePos.y = Math.min(this.#chasePos.y, waterY - 0.8)
      } else if (player.swimming) {
        surfaceSwimCam = true
        const camWater =
          waterHeight(this.#chasePos.x, this.#chasePos.z, player.time) + 0.55
        if (this.#chasePos.y < camWater) this.#chasePos.y = camWater
      }
    }

    // The walk rig's eyes are ~0.78 m above the capsule centre. This endpoint is
    // fixed to that eye line and deliberately ignores chase zoom; the local walk
    // embodiment is hidden near the end of the blend to prevent self-clipping.
    this.#eyePos.set(anchor.x, anchor.y + VIEW.eyeHeight, anchor.z)

    // critically-damped-ish follow; flying gets a floatier tail, the drone a
    // slightly loose one so swoops read as motion instead of a rigid rig
    let orbitStiff =
      player.mode === "plane"
        ? 6.5
        : player.mode === "bird" || player.mode === "drone"
          ? 8.5
          : 11
    // the bird's stoop (Shift) triples its speed; at a fixed stiffness the
    // exponential follow settles ~speed/stiff behind, so a boost trails ~13m
    // and the phoenix shrinks to a dot. Tighten the tail as airspeed climbs so
    // the boost pulls the camera along instead of away (~5m at full stoop).
    if (player.mode === "bird")
      orbitStiff = THREE.MathUtils.clamp(player.speed * 0.2, 7.5, 17)
    // clamp the smoothing step. A tile-upload spike inflates the *next* frame's
    // dt, and an uncapped 1-exp(-dt*stiff) then snaps an orbit a large fraction
    // of the way to target in that one frame — the visible "hitch" as chunks
    // stream in (worst in fly, whose floaty tail trails farthest). The anchor
    // (renderPosition) is interpolated and never jumps, so a small residual lag
    // after a spike is imperceptible and heals within a few frames.
    const smoothDt = Math.min(dt, 1 / 30)
    const modeChanged = this.#lastMode !== player.mode
    this.#lastMode = player.mode
    if (!this.#initialized) {
      this.#orbitPos.copy(this.camera.position)
      this.#firstPersonPos.copy(this.#eyePos)
      this.#initialized = true
    } else if (modeChanged && (player.mode !== "walk" || leavingSurf)) {
      // Leaving FPS for a vehicle must clear its geometry immediately rather than
      // easing the camera outward from the vehicle's centre for several frames.
      this.#orbitPos.copy(this.#chasePos)
    }
    if (this.#holdOrbitPose && indoorTarget === 1) {
      // Returning from an arbitrary orbit/cinematic inside should travel directly
      // from that camera to the eye. Moving this endpoint toward the chase boom at
      // the same time creates a visible outward-then-inward loop.
      if (firstPersonBlend > 0.995) {
        this.#holdOrbitPose = false
        this.#orbitPos.copy(this.#chasePos)
      }
    } else {
      this.#holdOrbitPose = false
      this.#orbitPos.lerp(
        this.#chasePos,
        1 - Math.exp(-smoothDt * orbitStiff)
      )
    }
    this.#firstPersonPos.lerp(
      this.#eyePos,
      1 - Math.exp(-smoothDt * VIEW.firstPersonFollow)
    )

    this.#orbitViewPos.copy(this.#orbitPos)
    this.#resolveBuildingOcclusion(
      smoothDt,
      player.mode,
      modeChanged,
      indoorTarget === 1,
      this.#orbitViewPos
    )
    this.camera.position.lerpVectors(
      this.#orbitViewPos,
      this.#firstPersonPos,
      firstPersonBlend
    )

    // Hard floor after orbit lag: a low boom while surface-swimming lifts the
    // chase endpoint immediately, but the smoothed orbit can trail below the
    // waterline for a few frames and flash the underwater overlay.
    if (surfaceSwimCam && firstPersonBlend < 0.5) {
      const camWater =
        waterHeight(this.camera.position.x, this.camera.position.z, player.time) +
        0.55
      if (this.camera.position.y < camWater) this.camera.position.y = camWater
      if (this.#orbitViewPos.y < camWater) this.#orbitViewPos.y = camWater
      if (this.#orbitPos.y < camWater) this.#orbitPos.y = camWater
    }

    if (this.shakeAmount > 0.002) {
      // shake position and look-target together so it reads as a jolt, not a wobble
      const sx = (Math.random() - 0.5) * this.shakeAmount * 0.5
      const sy = (Math.random() - 0.5) * this.shakeAmount * 0.4
      const sz = (Math.random() - 0.5) * this.shakeAmount * 0.5
      this.camera.position.x += sx
      this.camera.position.y += sy
      this.camera.position.z += sz
      this.#orbitViewPos.x += sx
      this.#orbitViewPos.y += sy
      this.#orbitViewPos.z += sz
      this.#target.x += sx * 0.6
      this.#target.y += sy * 0.6
      this.#target.z += sz * 0.6
      this.shakeAmount *= Math.exp(-dt * 6)
    }

    // Build complete rotations for both rigs. Orbit preserves the original
    // look-at framing; FPS uses the same canonical yaw/pitch as lookDir(), so the
    // rendered centre ray, movement heading and tools all agree. Nothing calls
    // lookAt after this slerp, leaving one clear owner of the final orientation.
    if (this.#holdOrbitPose) {
      this.#orbitQuat.copy(this.#heldOrbitQuat)
    } else {
      this.#lookMatrix.lookAt(this.#orbitViewPos, this.#target, this.#up)
      this.#orbitQuat.setFromRotationMatrix(this.#lookMatrix)
    }
    this.#firstPersonEuler.set(-this.pitch, this.yaw, 0, "YXZ")
    this.#firstPersonQuat.setFromEuler(this.#firstPersonEuler)
    this.camera.quaternion.slerpQuaternions(
      this.#orbitQuat,
      this.#firstPersonQuat,
      firstPersonBlend
    )
    updateCameraCutaway(
      this.camera.position,
      this.#target,
      (OCCLUSION[player.mode].cutRadius * CAMERA_TUNING.values.cutawayRadiusScale),
      this.#cutaway * (1 - firstPersonBlend)
    )
  }

  /** Resolve the smoothed orbit pose, so follow-lag can never carry the rendered
   * camera through a corner even when the raw desired chase endpoint is clear. */
  #resolveBuildingOcclusion(
    dt: number,
    mode: PlayerMode,
    modeChanged: boolean,
    indoor: boolean,
    candidate: THREE.Vector3
  ) {
    const cfg = OCCLUSION[mode]
    const dx = candidate.x - this.#target.x
    const dy = candidate.y - this.#target.y
    const dz = candidate.z - this.#target.z
    const desiredDistance = Math.hypot(dx, dy, dz)
    if (desiredDistance < 0.001) {
      this.#cutaway = 0
      clearCameraCutaway()
      return
    }

    const collisionOn = CAMERA_TUNING.values.collisionEnabled && !indoor
    const radius = cfg.radius * CAMERA_TUNING.values.collisionRadiusScale
    const hitDistance = collisionOn
      ? this.#physics.cameraObstructionDistance(this.#target, candidate, radius)
      : Infinity
    const blocked = Number.isFinite(hitDistance) && hitDistance < desiredDistance
    this.#buildingBlocked = blocked
    this.#lastHitDistance = blocked ? hitDistance : Infinity
    const safeDistance = blocked
      ? Math.max(0.65, Math.min(desiredDistance, hitDistance - 0.14))
      : desiredDistance

    if (modeChanged || this.#safeBoomDistance <= 0) {
      this.#safeBoomDistance = safeDistance
    } else if (safeDistance < this.#safeBoomDistance) {
      // Collision entry is immediate: never interpolate through a wall.
      this.#safeBoomDistance = safeDistance
    } else {
      // Release slowly with a continuous exponential response so clearing a
      // facade edge does not pump the boom at frame rate.
      this.#safeBoomDistance +=
        (safeDistance - this.#safeBoomDistance) *
        (1 - Math.exp(-dt * CAMERA_TUNING.values.collisionRelease))
    }

    const comfort = Math.min(desiredDistance, cfg.comfort)
    const crushRange = Math.max(0.8, comfort * 0.32)
    const severity = blocked
      ? THREE.MathUtils.clamp((comfort - safeDistance) / crushRange, 0, 1)
      : 0
    const cutTarget =
      CAMERA_TUNING.values.cutawayEnabled && !indoor ? smoothstep(severity) : 0
    const response = CAMERA_TUNING.values.cutawayResponse *
      (cutTarget > this.#cutaway ? 1 : 0.32)
    this.#cutaway +=
      (cutTarget - this.#cutaway) * (1 - Math.exp(-dt * response))
    if (this.#cutaway < 0.001 && cutTarget === 0) this.#cutaway = 0

    // Collision owns ordinary obstructions. Only when framing is crushed does
    // the cutaway pull the camera back toward a readable minimum distance.
    const resolvedDistance = THREE.MathUtils.lerp(
      this.#safeBoomDistance,
      comfort,
      this.#cutaway
    )
    const inv = resolvedDistance / desiredDistance
    candidate.set(
      this.#target.x + dx * inv,
      this.#target.y + dy * inv,
      this.#target.z + dz * inv
    )
  }

  #applyFov(blend: number) {
    const fov = this.#outdoorFov + VIEW.firstPersonFovBoost * blend
    if (Math.abs(this.camera.fov - fov) < 1e-4) return
    this.camera.fov = fov
    this.camera.updateProjectionMatrix()
  }

  /** True view direction — no shot bias. Drives drone movement so level look = level flight. */
  lookDir(out: THREE.Vector3): THREE.Vector3 {
    out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    )
    return out
  }

  /** Direction the player aims/fires along. */
  aimDir(out: THREE.Vector3): THREE.Vector3 {
    // derive from yaw/pitch, not the camera matrix, so it's stable mid-lerp
    out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch) + 0.12,
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    )
    return out.normalize()
  }
}
