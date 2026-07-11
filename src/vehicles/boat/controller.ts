import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { BOAT_TUNING } from "./tuning";

const V = {
  tmp: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion()
};

export class BoatController implements ModeController {
  readonly spawnLift = 0.8;
  steerVis = 0; // smoothed steer input, read by the helm-arm/wheel animation
  #tuning: typeof BOAT_TUNING;

  // the sailboat and the speedboat share this controller — only the tunables
  // differ (top speed, accel, steer), so pass the right table in
  constructor(tuning: typeof BOAT_TUNING = BOAT_TUNING) {
    this.#tuning = tuning;
  }

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, waterHeight(p.x, p.z, ctx.time) + 0.4, p.z],
      halfExtents: [1.3, 0.75, 3.2],
      density: 40,
      friction: 0.2,
      restitution: 0.1
    });
    w.setBodyGravityScale(ctx.body, 0);
    return waterHeight(p.x, p.z, ctx.time) + 0.15;
  }

  enter(ctx: PlayerCtx): number | void {
    if (ctx.map.isWater(ctx.position.x, ctx.position.z)) {
      ctx.position.y = waterHeight(ctx.position.x, ctx.position.z, ctx.time) + 0.5;
      return;
    }
    // same-spot mode switch: stay put (beached) — don't yank downtown walkers
    // out to the bay spawn on their first boat keypress
    ctx.position.y = Math.max(
      ctx.position.y,
      ctx.map.effectiveGround(ctx.position.x, ctx.position.z) + 0.8
    );
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const v = frame.v;
    const q = ctx.quaternion;
    const fwd = V.fwd.set(0, 0, -1).applyQuaternion(q);
    fwd.y = 0;
    fwd.normalize();

    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyD", "KeyA");
    const boost = input.down("ShiftLeft");
    this.steerVis += (steer - this.steerVis) * Math.min(1, dt * 6);

    const t = ctx.time;
    const px = ctx.position.x;
    const pz = ctx.position.z;
    const sampleWater = (x: number, z: number) => waterHeight(x, z, t);

    // buoyancy: track wave surface with slope feedforward so the hull glides
    // across swell instead of pitching nose-down into each wave
    const waterY = sampleWater(px, pz);
    const targetY = waterY + 0.15;

    // shore handling: hard-stop only for actual land ahead; shallows just slow you
    const aheadX = px + fwd.x * 6;
    const aheadZ = pz + fwd.z * 6;
    const aheadGround = ctx.map.groundHeight(aheadX, aheadZ);
    const tb = this.#tuning.values;
    const beached = aheadGround > 0.05 && throttle > 0;
    const shallowFactor = aheadGround > -1.0 ? tb.shallowFactor : 1;

    const right = V.right.set(1, 0, 0).applyQuaternion(q);
    right.y = 0;
    right.normalize();

    const fwdSpeed = ctx.velocity.dot(fwd);
    const latSpeed = ctx.velocity.dot(right);
    const maxSpeed = (boost ? tb.boostMaxSpeed : tb.maxSpeed) * shallowFactor;

    // longitudinal: ease toward target speed (hard-capped), heavy water drag
    let targetSpeed = fwdSpeed;
    if (throttle > 0 && !beached) targetSpeed = Math.min(maxSpeed, fwdSpeed + (boost ? tb.boostAccel : tb.accel) * dt);
    else if (throttle < 0) targetSpeed = Math.max(-tb.reverseMax, fwdSpeed - tb.reverseAccel * dt);
    else targetSpeed = fwdSpeed * (1 - tb.coastDrag * dt);
    if (beached) targetSpeed = Math.min(targetSpeed, 0);

    // feedforward scales with how fast the surface actually rises under the
    // hull: wave slope × boat speed, plus the wave's own temporal rate. The
    // spring only has to absorb the residual, so the hull glides.
    const aheadWater = sampleWater(aheadX, aheadZ);
    const surfaceRate = ((aheadWater - waterY) / 6) * fwdSpeed + (waterHeight(px, pz, t + 0.1) - waterY) / 0.1;
    const vy = THREE.MathUtils.clamp((targetY - ctx.position.y) * 4.2 - v.linear[1] * 0.85 + surfaceRate, -6, 8);

    // recompose horizontal velocity: forward + damped lateral (hull grip)
    const keepLat = tb.gripLat;
    const nvx = fwd.x * targetSpeed + right.x * latSpeed * keepLat;
    const nvz = fwd.z * targetSpeed + right.z * latSpeed * keepLat;

    const steerRate = steer * Math.min(Math.abs(fwdSpeed) / 4 + 0.15, 1) * tb.steerRate * (fwdSpeed >= -0.5 ? 1 : -1);
    // roll/pitch chase the local wave plane (yaw stays steering-owned)
    const e = 3.8;
    const n = V.tmp.set(
      sampleWater(px - e, pz) - sampleWater(px + e, pz),
      2 * e,
      sampleWater(px, pz - e) - sampleWater(px, pz + e)
    ).normalize();
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    V.qa.setFromAxisAngle(V.up, yaw);
    V.qb.setFromUnitVectors(V.up, n).multiply(V.qa);
    // under way the hull trims bow-up like a real day-sailer on plane; also
    // guarantees the nose never reads as digging into the swell
    const trim = 0.045 * THREE.MathUtils.clamp(fwdSpeed / tb.maxSpeed, 0, 1);
    V.qb.multiply(V.qa.setFromAxisAngle(V.right.set(1, 0, 0), trim));
    V.qa.copy(q).invert().premultiply(V.qb);
    const flip = V.qa.w < 0 ? -1 : 1;
    const wx = THREE.MathUtils.clamp(V.qa.x * flip * 2 * 5, -2.8, 2.8);
    const wz = THREE.MathUtils.clamp(V.qa.z * flip * 2 * 5, -2.8, 2.8);
    w.setBodyVelocity(ctx.body, [nvx, vy, nvz], [wx, steerRate, wz]);

    ctx.heading = Math.atan2(-fwd.x, -fwd.z) + Math.PI;
  }
}
