import * as THREE from "three/webgpu";
import { BodyType } from "box3d-wasm";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { enterOnLand } from "../shared";
import { CAR_TUNING } from "./tuning";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion()
};

export class CarController implements ModeController {
  readonly spawnLift = 0.8;
  steerVis = 0; // smoothed steer input, read by the driver-arm/wheel animation

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    // box stops at the rocker panels (y half 0.45, not 0.6): the ride spring
    // holds the centre at ground+0.85, so a taller box left only 0.25 m of
    // floor clearance — any carpet/heightmap mismatch buried it in the road
    ctx.body = ctx.physics.world.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 0.8, p.z],
      halfExtents: ctx.driveSpec.halfExtents,
      density: 133, // keeps the old box's mass despite the thinner profile
      friction: 0.35,
      restitution: 0.1
    });
    return p.y + 0.8;
  }

  enter(ctx: PlayerCtx) {
    enterOnLand(ctx); // need land under us
  }

  /**
   * Ground the car rides on. Unlike effectiveGround, a bridge deck only counts
   * when the car is actually up at deck level — driving *under* an approach used
   * to snap the spring target to the roadway overhead and launch the car.
   */
  #ground(ctx: PlayerCtx, x: number, z: number): number {
    const terrain = ctx.map.groundHeight(x, z);
    const deck = ctx.map.bridgeDeck(x, z);
    return deck > -Infinity && ctx.position.y > deck - 3 ? Math.max(terrain, deck) : terrain;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const v = frame.v;
    const q = ctx.quaternion;
    const fwd = V.fwd.set(0, 0, -1).applyQuaternion(q);
    fwd.y = 0;
    fwd.normalize();
    const right = V.right.set(1, 0, 0).applyQuaternion(q);
    right.y = 0;
    right.normalize();
    const up = V.tmp2.set(0, 1, 0).applyQuaternion(q);

    const ground = this.#ground(ctx, ctx.position.x, ctx.position.z);
    // wide band: a car perched on rubble or a wall lip (~2m up) must keep throttle
    // and its down-spring, or it strands in a no-control limbo — beyond it (roofs,
    // big jumps) physics owns the fall until we're near street level again
    const grounded = ctx.position.y - ground < 3.0 && up.y > 0.35;

    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyD", "KeyA");
    const handbrake = input.down("Space");
    const boost = input.down("ShiftLeft");
    this.steerVis += (steer - this.steerVis) * Math.min(1, dt * 9);

    const td = CAR_TUNING.values;
    const spec = ctx.driveSpec;
    const fwdSpeed = ctx.velocity.dot(fwd);
    const maxSpeed = (boost ? td.boostMaxSpeed : td.maxSpeed) * spec.maxFactor;

    if (grounded) {
      // longitudinal: accelerate toward a target speed, hard-capped. The target
      // builds from *current* speed, so a blocked car (nose against rubble) would
      // otherwise only ever ask for fwdSpeed+accel·dt ≈ 0.3 m/s and stay wedged
      // forever — floor the request at a grind speed so it bulldozes light debris.
      let targetSpeed = fwdSpeed;
      if (throttle > 0) {
        targetSpeed = Math.min(
          maxSpeed,
          Math.max(fwdSpeed + (boost ? td.boostAccel : td.accel) * spec.accelFactor * dt, td.grindSpeed)
        );
      } else if (throttle < 0) {
        targetSpeed = Math.max(-td.reverseMax, fwdSpeed - td.reverseAccel * dt);
        if (fwdSpeed < 0.5) targetSpeed = Math.min(targetSpeed, -td.reverseGrind);
      } else targetSpeed = fwdSpeed * (1 - td.coastDrag * dt);

      // lateral grip: kill most sideways velocity (less when drifting)
      const latSpeed = ctx.velocity.dot(right);
      const keepLat = handbrake ? td.driftLat : td.gripLat;

      const newVx = fwd.x * targetSpeed + right.x * latSpeed * keepLat;
      const newVz = fwd.z * targetSpeed + right.z * latSpeed * keepLat;

      // vertical: ride the terrain on a height spring instead of preserving raw
      // fall velocity (prevents high-speed tunneling) while still letting ramps
      // fling us into the air. The anti-snag move is looking a whole box-length
      // ahead: the collider reaches ~2.3 m past centre, so a rise the *nose* is
      // already climbing must lift the spring NOW — otherwise the leading bottom
      // edge digs into the carpet slab ahead and the solver eats all forward
      // speed. That is the "stuck on a normal slope, hitting an invisible snag"
      // report: the old feedforward only peeked newV·dt (~0.3 m) in front.
      const travel = Math.sign(fwdSpeed) || (throttle > 0 ? 1 : throttle < 0 ? -1 : 1);
      const nose = spec.halfExtents[2] + 0.6; // front-bumper reach + margin
      const ahead = this.#ground(
        ctx,
        ctx.position.x + fwd.x * nose * travel + newVx * dt,
        ctx.position.z + fwd.z * nose * travel + newVz * dt
      );
      const rise = ahead - ground;
      const rideY = Math.max(ground, ahead) + spec.rideHeight; // float over the rise
      let vy = v.linear[1];
      if (ctx.position.y > rideY + 0.5) {
        // airborne off a ramp/crest: keep our velocity and let gravity arc us
        // back down. Clamping upward speed to 0 here is what used to kill every
        // jump before the car could ever leave the ground.
        vy = v.linear[1];
      } else {
        // feedforward the climb rate (grade · ground speed) so the spring only
        // trims residual error…
        const horiz = Math.max(Math.abs(fwdSpeed), 2);
        const slopeRate = THREE.MathUtils.clamp((rise / nose) * horiz, -14, 40);
        vy = (rideY - ctx.position.y) * td.rideSpring + slopeRate;
        // …then a stuck-guard: pinned against a terrain lip while still asking
        // for real speed → add lift to hop over it. Gated on the ground actually
        // rising, so it bulldozes hills but never crawls up a building wall.
        if (throttle > 0 && rise > 0.3 && Math.abs(fwdSpeed) < 3 && targetSpeed > 4) {
          vy = Math.max(vy, rise * 5 + 4);
        }
      }

      // steering yaw, scaled by speed and capped
      const dir = fwdSpeed >= -0.4 ? 1 : -1;
      const grip = Math.min(Math.abs(fwdSpeed) / 6, 1);
      const steerRate = steer * dir * grip * (handbrake ? td.driftSteerRate : td.steerRate) * spec.steerFactor;

      // pitch/roll chase the road plane (yaw stays steering-owned). Without this
      // the car sat horizontal on every hill — nose clipping into the climb — and
      // contact impulses could leave it permanently tilted on a buried corner.
      const e = 2.5;
      const n = V.tmp.set(
        this.#ground(ctx, ctx.position.x - e, ctx.position.z) - this.#ground(ctx, ctx.position.x + e, ctx.position.z),
        2 * e,
        this.#ground(ctx, ctx.position.x, ctx.position.z - e) - this.#ground(ctx, ctx.position.x, ctx.position.z + e)
      ).normalize();
      const yaw = Math.atan2(-fwd.x, -fwd.z);
      V.qa.setFromAxisAngle(V.up, yaw);
      V.qb.setFromUnitVectors(V.up, n).multiply(V.qa); // desired = tilt ∘ yaw
      // error rotation current→desired; small-angle: ω ≈ 2·(x,z)·gain
      V.qa.copy(q).invert().premultiply(V.qb);
      const flip = V.qa.w < 0 ? -1 : 1;
      const wx = THREE.MathUtils.clamp(V.qa.x * flip * 2 * 8, -6, 6);
      const wz = THREE.MathUtils.clamp(V.qa.z * flip * 2 * 8, -6, 6);
      w.setBodyVelocity(ctx.body, [newVx, vy, newVz], [wx, steerRate, wz]);
    } else if (up.y < 0.2 && ctx.speed < 2.5) {
      // flipped and stopped: self-right, nose kept the way we were driving
      const face = ctx.heading - Math.PI;
      const t2 = w.getBodyTransform(ctx.body);
      w.setBodyTransform(ctx.body, [t2.position[0], t2.position[1] + 1.6, t2.position[2]], [
        0,
        Math.sin(face / 2),
        0,
        Math.cos(face / 2)
      ]);
      w.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
    }
    ctx.heading = Math.atan2(-fwd.x, -fwd.z) + Math.PI;
  }
}
