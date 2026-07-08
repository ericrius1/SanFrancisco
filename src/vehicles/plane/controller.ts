import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, PlayerCtx } from "../../player/types";
import { PLANE_TUNING } from "./tuning";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  mat: new THREE.Matrix4(),
  quat: new THREE.Quaternion()
};

export class FlyController implements ModeController {
  readonly spawnLift = 2.5;

  // the plane's smoothed forward, speed and visual bank
  fwd = new THREE.Vector3(0, 0, -1);
  #speed = 45;
  #bank = 0;

  /** Visual bank angle — drives the pilot pose and yoke spin. */
  get bank(): number {
    return this.#bank;
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 2.5, p.z],
      halfExtents: [1.1, 0.5, 2.6],
      density: 70,
      friction: 0.3,
      restitution: 0.2
    });
    w.setBodyGravityScale(ctx.body, 0);
    // face the way the body was just spawned
    this.fwd.set(-Math.sin(facing), 0, -Math.cos(facing)).normalize();
    this.#speed = PLANE_TUNING.values.spawnSpeed;
    this.#bank = 0;
    return p.y + 2.5;
  }

  enter(ctx: PlayerCtx) {
    // take off above the skyline, not in a canyon between towers; the radius
    // covers the first few seconds of forward flight at spawn speed
    const roof = ctx.physics.highestBuildingTop(ctx.position.x, ctx.position.z, 150);
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    ctx.position.y = Math.max(ctx.position.y, roof + 20, ground + 40);
  }

  /**
   * Frame-rate flight steering: the mouse flies the nose, while A/D own a
   * separate banked turn rate so held keys always yaw the plane left/right.
   * Pitch is kept off vertical so heading stays well-defined.
   */
  steerFly(input: Input, dt: number) {
    if (input.suspended) return;

    const tf = PLANE_TUNING.values;
    const maxStep = tf.turnRate * dt;
    const keySteer = input.axis("KeyD", "KeyA"); // A = left, D = right
    const mouseYawDelta = THREE.MathUtils.clamp(-input.mouseDX * tf.mouseYaw, -maxStep, maxStep);
    const keyYawDelta = keySteer * tf.keyYaw * dt;
    const yawDelta = THREE.MathUtils.clamp(
      mouseYawDelta + keyYawDelta,
      -(maxStep + tf.keyYaw * dt),
      maxStep + tf.keyYaw * dt
    );
    const pitchDelta = THREE.MathUtils.clamp(
      -input.mouseDY * tf.mousePitch,
      -maxStep,
      maxStep
    );

    const fwd = this.fwd;
    const yaw = Math.atan2(-fwd.x, -fwd.z) + yawDelta;
    const pitch = THREE.MathUtils.clamp(
      Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)) + pitchDelta,
      -1.15,
      1.15
    );
    const c = Math.cos(pitch);
    fwd.set(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);

    // visual bank into the turn
    const targetBank = THREE.MathUtils.clamp((-yawDelta / Math.max(dt, 1e-4)) * tf.bankAmount, -1.0, 1.0);
    this.#bank += (targetBank - this.#bank) * Math.min(1, dt * tf.bankSmooth);
  }

  // Direct flight: steerFly() (frame-rate, mouse + A/D) owns the forward vector;
  // this step just flies along it. W/S throttle, Shift boost, Space airbrake.
  // Attitude is code-owned (banked into turns); the solver owns translation so
  // collisions still land hits.
  update(ctx: PlayerCtx, dt: number, input: Input) {
    const w = ctx.physics.world;
    const tf = PLANE_TUNING.values;

    // throttle
    const keyThrottle = (input.down("KeyW") ? 1 : 0) - (input.down("KeyS") ? 1 : 0);
    const throttle = THREE.MathUtils.clamp(keyThrottle + input.padAxis("ArrowDown", "ArrowUp"), -1, 1);
    const boost = input.down("ShiftLeft");
    const brake = input.down("Space");
    const maxSpeed = boost ? tf.boostMaxSpeed : tf.maxSpeed;
    this.#speed += throttle * tf.throttleAccel * dt + (boost ? tf.boostAccel * dt : 0) - (brake ? tf.brakeDecel * dt : 0);
    this.#speed = THREE.MathUtils.clamp(this.#speed, tf.minSpeed, maxSpeed);

    const fwd = this.fwd;
    const yaw = Math.atan2(-fwd.x, -fwd.z);

    // low-speed sag: the nose can't hold altitude near stall
    const sag = Math.max(0, 1 - this.#speed / tf.stallThreshold) * tf.stallSag;
    w.setBodyVelocity(
      ctx.body,
      [fwd.x * this.#speed, fwd.y * this.#speed - sag, fwd.z * this.#speed],
      [0, 0, 0]
    );

    // attitude: look along fwd, then roll around it
    const m = V.mat.lookAt(V.tmp.set(0, 0, 0), V.tmp2.copy(fwd), V.up);
    const q = ctx.quaternion.setFromRotationMatrix(m);
    q.premultiply(V.quat.setFromAxisAngle(fwd, this.#bank));
    w.setBodyTransform(ctx.body, [ctx.position.x, ctx.position.y, ctx.position.z], [q.x, q.y, q.z, q.w]);

    // soft floor + ceiling
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    if (ctx.position.y < ground + 2.0) {
      w.setBodyTransform(ctx.body, [ctx.position.x, ground + 2.1, ctx.position.z], [q.x, q.y, q.z, q.w]);
      if (fwd.y < 0) {
        fwd.y = 0.05;
        fwd.normalize();
      }
    }
    if (ctx.position.y > 2200 && fwd.y > 0) {
      fwd.y *= 0.9;
      fwd.normalize();
    }
    ctx.heading = yaw + Math.PI;
  }
}
