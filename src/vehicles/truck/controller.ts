import * as THREE from "three/webgpu";
import { BodyType } from "box3d-wasm";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { enterOnLand } from "../shared";
import { TRUCK_GROUND_PROBE_EXTENT, TRUCK_HALF_EXTENTS, TRUCK_RIDE_HEIGHT, TRUCK_SPAWN_LIFT } from "./dimensions";
import { TRUCK_TUNING } from "./tuning";

// Truck owns its own hull dims (it isn't a commandeered "drive" body, so it
// doesn't read ctx.driveSpec) — a big, tall, heavy flatbed box.
const HALF = TRUCK_HALF_EXTENTS;
const RIDE_HEIGHT = TRUCK_RIDE_HEIGHT;
const LIFT = TRUCK_SPAWN_LIFT;

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion()
};

/**
 * Ground handling for the parade truck — the same spring-ride / slope-follow /
 * lateral-grip model as the sports car (CarController), retuned heavier and
 * sized to its own hull. Front is local -Z.
 */
export class TruckController implements ModeController {
  readonly spawnLift = LIFT;
  steerVis = 0; // smoothed steer, read by the driver-arm/wheel animation

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    ctx.body = ctx.physics.world.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + LIFT, p.z],
      halfExtents: HALF,
      density: 150, // heavier than the car
      friction: 0.4,
      restitution: 0.08
    });
    return p.y + LIFT;
  }

  enter(ctx: PlayerCtx) {
    enterOnLand(ctx);
  }

  /** Ground the truck rides on — mirrors CarController#ground (bridge decks only
   * count when we're actually up at deck level). */
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
    // wide band (mirrors the car): perched on rubble / a wall lip must keep
    // throttle + down-spring or the truck strands in a no-control limbo. Scaled
    // to the truck's taller ride height.
    const grounded = ctx.position.y - ground < RIDE_HEIGHT * 2 && up.y > 0.35;

    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyD", "KeyA");
    const handbrake = input.down("Space");
    const boost = input.down("ShiftLeft");
    this.steerVis += (steer - this.steerVis) * Math.min(1, dt * 9);

    const td = TRUCK_TUNING.values;
    const fwdSpeed = ctx.velocity.dot(fwd);
    const maxSpeed = boost ? td.boostMaxSpeed : td.maxSpeed;

    if (grounded) {
      let targetSpeed = fwdSpeed;
      if (throttle > 0) {
        targetSpeed = Math.min(maxSpeed, Math.max(fwdSpeed + (boost ? td.boostAccel : td.accel) * dt, td.grindSpeed));
      } else if (throttle < 0) {
        targetSpeed = Math.max(-td.reverseMax, fwdSpeed - td.reverseAccel * dt);
        if (fwdSpeed < 0.5) targetSpeed = Math.min(targetSpeed, -td.reverseGrind);
      } else targetSpeed = fwdSpeed * (1 - td.coastDrag * dt);

      const latSpeed = ctx.velocity.dot(right);
      const keepLat = handbrake ? td.driftLat : td.gripLat;

      const newVx = fwd.x * targetSpeed + right.x * latSpeed * keepLat;
      const newVz = fwd.z * targetSpeed + right.z * latSpeed * keepLat;

      // vertical: ride a height spring (prevents tunneling) while still letting
      // ramps fling us up. Anti-snag = look a whole box-length ahead: the truck's
      // collider reaches ~9m past centre, so a rise the *nose* is already climbing
      // must lift the spring NOW, else the leading bottom edge digs into the slab
      // ahead and the solver eats all forward speed — the "stuck on the bridge /
      // can't ramp" report. The old code only peeked newV·dt (~0.3 m) in front.
      const travel = Math.sign(fwdSpeed) || (throttle > 0 ? 1 : throttle < 0 ? -1 : 1);
      const nose = HALF[2] + 0.6; // front-bumper reach + margin
      const ahead = this.#ground(
        ctx,
        ctx.position.x + fwd.x * nose * travel + newVx * dt,
        ctx.position.z + fwd.z * nose * travel + newVz * dt
      );
      const rise = ahead - ground;
      const rideY = Math.max(ground, ahead) + RIDE_HEIGHT; // float over the rise
      let vy = v.linear[1];
      if (ctx.position.y > rideY + 0.5) {
        // airborne off a ramp/crest: keep velocity, let gravity arc us down
        vy = v.linear[1];
      } else {
        // feedforward the climb rate (grade · ground speed) so the spring only
        // trims residual error…
        const horiz = Math.max(Math.abs(fwdSpeed), 2);
        const slopeRate = THREE.MathUtils.clamp((rise / nose) * horiz, -14, 40);
        vy = (rideY - ctx.position.y) * td.rideSpring + slopeRate;
        // …then a stuck-guard: pinned against a lip while still asking for real
        // speed → add lift to hop over it. Gated on the ground actually rising so
        // it bulldozes hills but never crawls a building wall.
        if (throttle > 0 && rise > 0.3 && Math.abs(fwdSpeed) < 3 && targetSpeed > 4) {
          vy = Math.max(vy, rise * 5 + 4);
        }
      }

      const dir = fwdSpeed >= -0.4 ? 1 : -1;
      const grip = Math.min(Math.abs(fwdSpeed) / 6, 1);
      const steerRate = steer * dir * grip * (handbrake ? td.driftSteerRate : td.steerRate);

      const e = TRUCK_GROUND_PROBE_EXTENT;
      const n = V.tmp.set(
        this.#ground(ctx, ctx.position.x - e, ctx.position.z) - this.#ground(ctx, ctx.position.x + e, ctx.position.z),
        2 * e,
        this.#ground(ctx, ctx.position.x, ctx.position.z - e) - this.#ground(ctx, ctx.position.x, ctx.position.z + e)
      ).normalize();
      const yaw = Math.atan2(-fwd.x, -fwd.z);
      V.qa.setFromAxisAngle(V.up, yaw);
      V.qb.setFromUnitVectors(V.up, n).multiply(V.qa);
      V.qa.copy(q).invert().premultiply(V.qb);
      const flip = V.qa.w < 0 ? -1 : 1;
      const wx = THREE.MathUtils.clamp(V.qa.x * flip * 2 * 8, -6, 6);
      const wz = THREE.MathUtils.clamp(V.qa.z * flip * 2 * 8, -6, 6);
      w.setBodyVelocity(ctx.body, [newVx, vy, newVz], [wx, steerRate, wz]);
    } else if (up.y < 0.2 && ctx.speed < 2.5) {
      const face = ctx.heading - Math.PI;
      const t2 = w.getBodyTransform(ctx.body);
      w.setBodyTransform(ctx.body, [t2.position[0], t2.position[1] + LIFT, t2.position[2]], [
        0,
        Math.sin(face / 2),
        0,
        Math.cos(face / 2)
      ]);
      w.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
    } else {
      // airborne off a ramp/hill (mirrors the car): gravity owns the linear arc,
      // but damp the ramp-edge spin and gently level toward upright at our launch
      // heading so a clean jump lands flat. Soft + capped: a wild launch can still
      // out-spin the fix and flip.
      const yaw = ctx.heading - Math.PI;
      V.qb.setFromAxisAngle(V.up, yaw);
      V.qa.copy(q).invert().premultiply(V.qb);
      const flip = V.qa.w < 0 ? -1 : 1;
      const g = td.airLevel;
      const cap = td.airLevelCap;
      const damp = Math.max(0, 1 - td.airDamp * dt);
      const wv = v.angular;
      const lx = THREE.MathUtils.clamp(V.qa.x * flip * g, -cap, cap);
      const ly = THREE.MathUtils.clamp(V.qa.y * flip * g, -cap, cap);
      const lz = THREE.MathUtils.clamp(V.qa.z * flip * g, -cap, cap);
      w.setBodyVelocity(ctx.body, [v.linear[0], v.linear[1], v.linear[2]], [
        wv[0] * damp + lx,
        wv[1] * damp + ly,
        wv[2] * damp + lz
      ]);
    }
    ctx.heading = Math.atan2(-fwd.x, -fwd.z) + Math.PI;
  }
}
