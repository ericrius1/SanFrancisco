import * as THREE from "three/webgpu";
import type { Input } from "./input";
import type { Player } from "../player/player";
import type { PlayerMode } from "../player/types";
import type { WorldMap } from "../world/heightmap";

const OFFSETS: Record<PlayerMode, { back: number; up: number; look: number }> = {
  walk: { back: 6.5, up: 2.4, look: 1.4 },
  drive: { back: 9.5, up: 3.2, look: 1.2 },
  plane: { back: 17, up: 4.6, look: 0 },
  boat: { back: 12, up: 4.2, look: 0.8 },
  speedboat: { back: 11, up: 3.6, look: 0.7 },
  drone: { back: 7, up: 1.9, look: 0.4 },
  board: { back: 7.5, up: 2.6, look: 1.3 },
  bird: { back: 8, up: 2.1, look: 0.4 }
};

/**
 * Pointer-lock chase camera. The mouse owns yaw/pitch (no orbit button) and
 * the camera never recenters on its own.
 */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0.3;
  zoom = 1;
  shakeAmount = 0;

  #pos = new THREE.Vector3();
  #target = new THREE.Vector3();
  #map: WorldMap;

  constructor(camera: THREE.PerspectiveCamera, map: WorldMap) {
    this.camera = camera;
    this.#map = map;
  }

  shake(amount: number) {
    this.shakeAmount = Math.min(1.6, this.shakeAmount + amount);
  }

  update(dt: number, player: Player, input: Input) {
    if (player.mode === "plane") {
      // The mouse *flies the plane* (steerFly), so the camera must ride behind
      // the nose rather than orbit off the same mouse — integrating both at
      // different rates is what drifted the view around to the plane's side and
      // eventually flipped it. Ease yaw/pitch toward the plane's heading so the
      // chase cam always trails the flight path, no matter how hard you turn.
      const f = player.flyForward;
      const targetYaw = Math.atan2(-f.x, -f.z);
      const targetPitch = THREE.MathUtils.clamp(-Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)), -0.62, 1.2);
      const follow = 1 - Math.exp(-dt * 7);
      let dYaw = targetYaw - this.yaw;
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw)); // shortest way round
      this.yaw += dYaw * follow;
      this.pitch += (targetPitch - this.pitch) * follow;
    } else {
      this.yaw -= input.mouseDX * 0.0032;
      this.pitch = THREE.MathUtils.clamp(this.pitch + input.mouseDY * 0.0026, -0.62, 1.2);
    }
    this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + input.wheel * 0.0009), 0.45, 2.6);

    const o = OFFSETS[player.mode];
    const back = o.back * this.zoom;
    const up = o.up * this.zoom;

    // anchor on the interpolated render transform — the raw physics transform
    // only advances at the fixed step and stutters at high refresh rates
    const anchor = player.renderPosition;
    const cx = anchor.x + Math.sin(this.yaw) * Math.cos(this.pitch) * back;
    const cz = anchor.z + Math.cos(this.yaw) * Math.cos(this.pitch) * back;
    const cy = anchor.y + up + Math.sin(this.pitch) * back;

    this.#pos.set(cx, cy, cz);

    // keep above the terrain/seabed only — NOT above sea level. Clamping to y=0
    // used to pin the camera on the surface, so diving or a sinking car left the
    // view locked overhead. Following down to the bay floor lets the shot stay on
    // the player underwater; the seabed clamp still stops it clipping through.
    const floor = this.#map.effectiveGround(cx, cz) + 0.7;
    if (this.#pos.y < floor) this.#pos.y = floor;

    // critically-damped-ish follow; flying gets a floatier tail, the drone a
    // slightly loose one so swoops read as motion instead of a rigid rig
    let stiff = player.mode === "plane" ? 6.5 : player.mode === "bird" || player.mode === "drone" ? 8.5 : 11;
    // the bird's stoop (Shift) triples its speed; at a fixed stiffness the
    // exponential follow settles ~speed/stiff behind, so a boost trails ~13m
    // and the phoenix shrinks to a dot. Tighten the tail as airspeed climbs so
    // the boost pulls the camera along instead of away (~5m at full stoop).
    if (player.mode === "bird") stiff = THREE.MathUtils.clamp(player.speed * 0.25, 8.5, 22);
    // clamp the smoothing step. A tile-upload spike inflates the *next* frame's
    // dt, and an uncapped 1-exp(-dt*stiff) then snaps the camera a large fraction
    // of the way to target in that one frame — the visible "hitch" as chunks
    // stream in (worst in fly, whose floaty tail trails farthest). The anchor
    // (renderPosition) is interpolated and never jumps, so a small residual lag
    // after a spike is imperceptible and heals within a few frames.
    const smoothDt = Math.min(dt, 1 / 30);
    this.camera.position.lerp(this.#pos, 1 - Math.exp(-smoothDt * stiff));

    this.#target.copy(anchor);
    this.#target.y += o.look;

    if (this.shakeAmount > 0.002) {
      // shake position and look-target together so it reads as a jolt, not a wobble
      const sx = (Math.random() - 0.5) * this.shakeAmount * 0.5;
      const sy = (Math.random() - 0.5) * this.shakeAmount * 0.4;
      const sz = (Math.random() - 0.5) * this.shakeAmount * 0.5;
      this.camera.position.x += sx;
      this.camera.position.y += sy;
      this.camera.position.z += sz;
      this.#target.x += sx * 0.6;
      this.#target.y += sy * 0.6;
      this.#target.z += sz * 0.6;
      this.shakeAmount *= Math.exp(-dt * 6);
    }

    this.camera.lookAt(this.#target);
  }

  /** True view direction — no shot bias. Drives drone movement so level look = level flight. */
  lookDir(out: THREE.Vector3): THREE.Vector3 {
    out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    return out;
  }

  /** Direction the player aims/fires along. */
  aimDir(out: THREE.Vector3): THREE.Vector3 {
    // derive from yaw/pitch, not the camera matrix, so it's stable mid-lerp
    out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch) + 0.12,
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    return out.normalize();
  }
}
