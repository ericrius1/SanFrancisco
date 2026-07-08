import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { DRONE_TUNING } from "./tuning";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  right: new THREE.Vector3(),
  euler: new THREE.Euler()
};

/**
 * Camera drone: built for video shots — hover, swoop, flyby. The mouse owns
 * the chase camera (standard path, unlike fly); the drone eases its yaw in
 * behind the camera and moves along the camera's 3D aim, so "look down + W"
 * dives and "Space" kills velocity for a dead hover. Velocity chases a target
 * with a soft response, which gives the glidey ease-in/ease-out that makes
 * flybys read cinematic. Attitude (tilt into motion, quad-style) is code-owned;
 * the solver owns translation so collisions still land.
 */
export class DroneController implements ModeController {
  readonly spawnLift = 0.5;

  // smoothed yaw (chases the camera) and visual tilt into motion
  #yaw = 0;
  #tiltX = 0;
  #tiltZ = 0;
  #rotors: THREE.Group[];

  constructor(mesh: THREE.Group) {
    this.#rotors = mesh.userData.rotors as THREE.Group[];
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 0.5, p.z],
      halfExtents: [1.0, 0.25, 1.0],
      density: 25,
      friction: 0.3,
      restitution: 0.25
    });
    w.setBodyGravityScale(ctx.body, 0);
    this.#yaw = facing;
    this.#tiltX = 0;
    this.#tiltZ = 0;
    return p.y + 0.5;
  }

  enter(ctx: PlayerCtx) {
    // hover above nearby rooftops so entering from street level doesn't bury us in geometry
    const roof = ctx.physics.highestBuildingTop(ctx.position.x, ctx.position.z, 150);
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    ctx.position.y = Math.max(ctx.position.y, roof + 12, ground + 25);
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const td = DRONE_TUNING.values;
    const { camYaw, aim } = frame;

    const fwdIn =
      input.axis("KeyS", "KeyW") || input.axis("ArrowDown", "ArrowUp");
    const strafeIn = input.axis("KeyA", "KeyD");
    const vertIn = input.axis("KeyQ", "KeyU"); // E is exit-to-walk (main.ts)
    const boost = input.down("ShiftLeft");
    const brake = input.down("Space");

    // movement frame: full 3D camera aim forward, horizontal camera right
    const right = V.right.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const target = V.tmp.copy(aim).multiplyScalar(fwdIn).addScaledVector(right, strafeIn * td.strafeFactor);
    if (target.lengthSq() > 1) target.normalize();
    target.multiplyScalar(boost ? td.boostMaxSpeed : td.maxSpeed);
    target.y += vertIn * (boost ? td.boostVertSpeed : td.vertSpeed);
    if (brake) target.set(0, 0, 0);

    // ease velocity toward the target — low response = floaty glide, brake stops hard
    const k = 1 - Math.exp(-dt * (brake ? td.brakeResponse : td.response));
    V.tmp2.copy(ctx.velocity).lerp(target, k);
    w.setBodyVelocity(ctx.body, [V.tmp2.x, V.tmp2.y, V.tmp2.z], [0, 0, 0]);

    // yaw chases the camera so panning the mouse pans the drone; wrap-safe
    let dYaw = camYaw - this.#yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    this.#yaw += dYaw * Math.min(1, dt * td.yawFollow);

    // quad-style tilt into the local velocity (nose down when surging forward,
    // bank into a strafe); Space levels out as the velocity dies
    const yaw = this.#yaw;
    const localFwd = -V.tmp2.x * Math.sin(yaw) - V.tmp2.z * Math.cos(yaw); // speed along facing
    const localLat = V.tmp2.x * Math.cos(yaw) - V.tmp2.z * Math.sin(yaw); // speed to the right
    const tiltX = THREE.MathUtils.clamp(-localFwd * td.tiltPerSpeed, -td.maxTilt, td.maxTilt);
    const tiltZ = THREE.MathUtils.clamp(-localLat * td.tiltPerSpeed, -td.maxTilt, td.maxTilt);
    const smooth = Math.min(1, dt * td.tiltSmooth);
    this.#tiltX += (tiltX - this.#tiltX) * smooth;
    this.#tiltZ += (tiltZ - this.#tiltZ) * smooth;
    const q = ctx.quaternion.setFromEuler(V.euler.set(this.#tiltX, yaw, this.#tiltZ, "YXZ"));
    w.setBodyTransform(ctx.body, [ctx.position.x, ctx.position.y, ctx.position.z], [q.x, q.y, q.z, q.w]);

    // soft floor (street or water surface) + the same ceiling as the plane
    const floor = Math.max(
      ctx.map.effectiveGround(ctx.position.x, ctx.position.z),
      waterHeight(ctx.position.x, ctx.position.z, ctx.time)
    );
    if (ctx.position.y < floor + 0.6) {
      w.setBodyTransform(ctx.body, [ctx.position.x, floor + 0.6, ctx.position.z], [q.x, q.y, q.z, q.w]);
      if (V.tmp2.y < 0) w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }
    if (ctx.position.y > 2200 && V.tmp2.y > 0) {
      w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }

    // spin the props — idle whir plus speed; counter-rotating pairs
    const spin = (14 + ctx.speed * 1.2) * dt;
    for (const r of this.#rotors) r.rotation.y += spin * (r.userData.dir as number);

    ctx.heading = yaw + Math.PI;
  }
}
