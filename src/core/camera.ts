import * as THREE from "three/webgpu"
import type { Input } from "./input"
import type { Player } from "../player/player"
import type { PlayerMode } from "../player/types"
import { waterHeight, type WorldMap } from "../world/heightmap"

const OFFSETS: Record<PlayerMode, { back: number; up: number; look: number }> =
  {
    walk: { back: 6.5, up: 2.4, look: 1.4 },
    drive: { back: 9.5, up: 3.2, look: 1.2 },
    plane: { back: 17, up: 4.6, look: 0 },
    boat: { back: 12, up: 4.2, look: 0.8 },
    speedboat: { back: 11, up: 3.6, look: 0.7 },
    drone: { back: 7, up: 1.9, look: 0.4 },
    board: { back: 7.5, up: 2.6, look: 1.3 },
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
  firstPersonFollow: 48
} as const

const smoothstep = (t: number) => t * t * (3 - 2 * t)

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
  #initialized = false
  #externallyOwned = false
  #holdOrbitPose = false
  #lastMode: PlayerMode | null = null
  #map: WorldMap

  constructor(camera: THREE.PerspectiveCamera, map: WorldMap) {
    this.camera = camera
    this.#map = map
  }

  shake(amount: number) {
    this.shakeAmount = Math.min(1.6, this.shakeAmount + amount)
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
    if (!this.#externallyOwned) this.#externallyOwned = true
    this.#indoor = 0
    this.#holdOrbitPose = false
    this.#firstPersonAvatarHidden = false
    player.setFirstPersonView(false)
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
    const indoorTarget = this.indoor && player.mode === "walk" ? 1 : 0
    this.#indoor +=
      (indoorTarget - this.#indoor) *
      (1 - Math.exp(-Math.min(dt, 0.1) * VIEW.transitionRate))
    // A vehicle switch must drop the active eye rig immediately. The stored
    // scalar may decay in the background so returning to walk remains smooth.
    const firstPersonBlend = player.mode === "walk" ? this.firstPersonBlend : 0
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

    // When you're swimming BELOW the surface, duck the camera under with you.
    // The `up` offset otherwise keeps the eye above the waterline on a shallow
    // dive, so you'd watch yourself through the surface instead of being under
    // it — the underwater world (surface ceiling, tint) never reads. Only kicks
    // in over water deep enough to submerge the rig, never at the surface rest.
    if (player.mode === "walk") {
      const waterY = waterHeight(anchor.x, anchor.z, player.time)
      const seabed = this.#map.effectiveGround(anchor.x, anchor.z)
      // threshold sits well below the surface-swim rest (~0.8 m down) so bobbing
      // at the top keeps the eye above water; only a committed dive ducks it under
      if (anchor.y < waterY - 1.6 && seabed < waterY - 2.5) {
        this.#chasePos.y = Math.min(this.#chasePos.y, waterY - 0.8)
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
    } else if (modeChanged && player.mode !== "walk") {
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
    this.camera.position.lerpVectors(
      this.#orbitPos,
      this.#firstPersonPos,
      firstPersonBlend
    )
    this.#orbitViewPos.copy(this.#orbitPos)

    this.#target.copy(anchor)
    this.#target.y += o.look

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
