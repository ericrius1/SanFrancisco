import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { waterHeight } from "../../world/heightmap";
import {
  OCEAN_BEACH_SURF,
  oceanBeachMask,
  sampleOceanBeachWave
} from "../../world/oceanBeachWaves";
import { SURF_TUNING } from "./tuning";

const JUMP_BUFFER = 0.22;
const V = {
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  euler: new THREE.Euler(0, 0, 0, "YXZ")
};

export type SurfTelemetry = {
  speed: number;
  face: number;
  lip: number;
  lean: number;
  grounded: boolean;
  airborne: boolean;
  airTime: number;
  landedAirTime: number;
  landingSerial: number;
  wipeoutSerial: number;
  inBreak: boolean;
};

/** Authored arcade surf physics: fixed-step rail motion over the analytic wave face. */
export class SurfController implements ModeController {
  readonly spawnLift = 0;
  yaw = Math.PI;
  lean = 0;
  pitch = 0;
  grounded = true;
  telemetry: SurfTelemetry = {
    speed: 0,
    face: 0,
    lip: 0,
    lean: 0,
    grounded: true,
    airborne: false,
    airTime: 0,
    landedAirTime: 0,
    landingSerial: 0,
    wipeoutSerial: 0,
    inBreak: true
  };
  #jumpBuffer = 0;
  #jumpLock = 0;
  #airTime = 0;
  #airborne = false;
  #wipeoutTimer = 0;

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    const water = waterHeight(p.x, p.z, ctx.time);
    if (oceanBeachMask(p.x, p.z) < 0.03 || p.y < water - 1) this.#placeOnFace(ctx);
    else p.y = Math.max(p.y, water + SURF_TUNING.values.railHeight);
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y, p.z],
      halfExtents: [0.5, 0.16, 1.55],
      density: 48,
      friction: 0.08,
      restitution: 0.04
    });
    w.setBodyGravityScale(ctx.body, 0);
    this.yaw = facing;
    this.lean = 0;
    this.pitch = 0;
    this.grounded = true;
    this.#jumpBuffer = 0;
    this.#jumpLock = 0;
    this.#airTime = 0;
    this.#airborne = false;
    this.#wipeoutTimer = 0;
    this.telemetry.landedAirTime = 0;
    return p.y;
  }

  enter(ctx: PlayerCtx) {
    const b = OCEAN_BEACH_SURF;
    const nearBreak =
      ctx.position.x > b.minX - 350 &&
      ctx.position.x < b.maxX + 450 &&
      ctx.position.z > b.minZ - 400 &&
      ctx.position.z < b.maxZ + 400;
    if (!nearBreak) ctx.position.set(b.entryX, 0, b.entryZ);
    const face = sampleOceanBeachWave(ctx.position.x, ctx.position.z, ctx.time);
    ctx.position.x = face.crestX + 4;
    ctx.position.y = waterHeight(ctx.position.x, ctx.position.z, ctx.time) + SURF_TUNING.values.railHeight;
    // Face north for the first clean line; A/D can immediately choose either shoulder.
    return Math.PI;
  }

  requestJump() {
    this.#jumpBuffer = JUMP_BUFFER;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const tb = SURF_TUNING.values;
    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyD", "KeyA");
    const tuck = input.down("ShiftLeft");
    if (!input.suspended && input.pressed("Space")) this.requestJump();
    this.#jumpBuffer = Math.max(0, this.#jumpBuffer - dt);
    this.#jumpLock = Math.max(0, this.#jumpLock - dt);

    const p = ctx.position;
    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);
    const baseWater = waterHeight(p.x, p.z, ctx.time) - sample.height;
    const surface = baseWater + sample.height;
    const rideY = surface + tb.railHeight;
    const heightAbove = p.y - rideY;
    const wasGrounded = this.grounded;
    if (this.#airborne && this.#jumpLock <= 0 && heightAbove < 0.62 && frame.v.linear[1] < 3) {
      this.#airborne = false;
    }
    // A moving analytic face is code-owned footing: losing a metre to one
    // coarse rendered vertex must not turn into an endless accidental aerial.
    // Only an explicit launch (or wipeout) enters the airborne state.
    this.grounded = !this.#airborne;

    if (this.#wipeoutTimer > 0) {
      this.#wipeoutTimer -= dt;
      w.setBodyVelocity(ctx.body, [3.5, -2.2, 0], [0, 0, 0]);
      if (this.#wipeoutTimer <= 0) {
        this.#placeOnFace(ctx);
        this.yaw = Math.PI;
        this.#airborne = false;
        this.grounded = true;
        this.#airTime = 0;
        w.setBodyTransform(ctx.body, [p.x, p.y, p.z], [0, 1, 0, 0]);
        w.setBodyVelocity(ctx.body, [0, 0, 11], [0, 0, 0]);
      }
      this.#syncTelemetry(frame, sample, false);
      return;
    }

    const fwd = V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = V.right.set(-fwd.z, 0, fwd.x);
    let fwdSpeed = ctx.velocity.dot(fwd);
    const latSpeed = ctx.velocity.dot(right);
    const steerAuthority = 0.45 + Math.min(1, Math.abs(fwdSpeed) / 12) * 0.55;
    const steerRate = steer * tb.steerRate * steerAuthority;
    this.yaw += steerRate * dt;

    const faceDrive = sample.face * tb.faceAccel;
    const maxSpeed = tuck ? tb.tuckMaxSpeed : tb.maxSpeed;
    const targetCruise = tb.cruiseSpeed + sample.face * 8 + (tuck ? 5 : 0);
    fwdSpeed += (targetCruise - fwdSpeed) * Math.min(1, dt * (1.4 + sample.face * 1.8));
    if (throttle > 0) fwdSpeed += tb.pumpAccel * throttle * dt;
    if (throttle < 0) fwdSpeed += tb.pumpAccel * 1.35 * throttle * dt;
    fwdSpeed += faceDrive * Math.max(0.2, -fwd.x * 0.7 + 0.3) * dt;
    fwdSpeed *= Math.max(0, 1 - tb.coastDrag * dt);
    fwdSpeed = THREE.MathUtils.clamp(fwdSpeed, 2.5, maxSpeed);

    // Breaking water carries the board east; aiming down the line converts most
    // of that energy into speed while a bottom turn crosses the face shoreward.
    const shorePush = sample.face * (OCEAN_BEACH_SURF.speed * 0.95 + sample.lip * 2.2);
    let nvx = fwd.x * fwdSpeed + right.x * latSpeed * tb.grip + shorePush;
    let nvz = fwd.z * fwdSpeed + right.z * latSpeed * tb.grip;
    let vy = frame.v.linear[1];

    if (this.#jumpBuffer > 0 && this.grounded && sample.face > 0.16) {
      vy = tb.jump + sample.lip * 4.5;
      this.#jumpBuffer = 0;
      this.#jumpLock = 0.28;
      this.#airborne = true;
      this.grounded = false;
      this.#airTime = 0;
    } else if (this.grounded) {
      const look = 1.25;
      const next = sampleOceanBeachWave(p.x + nvx * dt * look, p.z + nvz * dt * look, ctx.time + dt * look);
      const nextY = baseWater + next.height + tb.railHeight;
      vy = THREE.MathUtils.clamp((nextY - p.y) * 10, -14, 18);
    } else {
      vy -= tb.gravity * dt;
      this.#airTime += dt;
      // A/D adds a readable aerial roll without destabilising the collider.
      this.lean += steer * dt * 1.8;
      // The crest moves ~9 m/s underneath the arc. At low frame rates the
      // narrow height crossing can be skipped entirely; rejoin the analytic
      // rail at the end of the authored air window instead of falling forever.
      const maxAirTime = Number.isFinite(tb.maxAirTime) ? tb.maxAirTime : 1.65;
      if (this.#airTime >= maxAirTime) {
        p.y = rideY;
        vy = 0;
        this.#airborne = false;
        this.grounded = true;
      }
    }

    if (!wasGrounded && this.grounded) {
      this.telemetry.landedAirTime = this.#airTime;
      this.telemetry.landingSerial++;
      if (Math.abs(frame.v.linear[1]) > 18 || Math.abs(this.lean) > 1.25) this.#wipeout(ctx);
      this.#airTime = 0;
    }

    // Reaching dry sand or escaping the authored strip is the fail/retry path.
    const inBreak = oceanBeachMask(p.x, p.z) > 0.03;
    if ((!ctx.map.isWater(p.x, p.z) && p.x > OCEAN_BEACH_SURF.maxX - 30) || p.y < -3 || !inBreak) {
      this.#wipeout(ctx);
    }

    const targetLean = THREE.MathUtils.clamp(steerRate * tb.carveLean, -0.95, 0.95);
    this.lean += (targetLean - this.lean) * Math.min(1, dt * (this.grounded ? 7 : 2.2));
    const pitchTarget = this.grounded
      ? THREE.MathUtils.clamp(Math.atan(sample.slopeX) * -fwd.x * 0.8, -0.55, 0.55)
      : THREE.MathUtils.clamp(vy * 0.025, -0.36, 0.42);
    this.pitch += (pitchTarget - this.pitch) * Math.min(1, dt * 7);

    if (this.#wipeoutTimer <= 0) {
      w.setBodyVelocity(ctx.body, [nvx, vy, nvz], [0, 0, 0]);
      const q = ctx.quaternion.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
      w.setBodyTransform(ctx.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      ctx.heading = this.yaw + Math.PI;
    }
    this.#syncTelemetry(frame, sample, inBreak);
  }

  #wipeout(ctx: PlayerCtx) {
    if (this.#wipeoutTimer > 0) return;
    this.#wipeoutTimer = 1.15;
    this.telemetry.wipeoutSerial++;
    this.#airborne = true;
    this.grounded = false;
    ctx.physics.world.setBodyVelocity(ctx.body, [4, -3, 0], [0, 0, 0]);
  }

  #placeOnFace(ctx: PlayerCtx) {
    const p = ctx.position;
    p.set(OCEAN_BEACH_SURF.entryX, 0, OCEAN_BEACH_SURF.entryZ);
    const face = sampleOceanBeachWave(p.x, p.z, ctx.time);
    p.x = face.crestX + 4;
    p.y = waterHeight(p.x, p.z, ctx.time) + SURF_TUNING.values.railHeight;
  }

  #syncTelemetry(frame: ModeFrame, sample: ReturnType<typeof sampleOceanBeachWave>, inBreak: boolean) {
    const t = this.telemetry;
    t.speed = Math.hypot(frame.v.linear[0], frame.v.linear[2]);
    t.face = sample.face;
    t.lip = sample.lip;
    t.lean = this.lean;
    t.grounded = this.grounded;
    t.airborne = !this.grounded;
    t.airTime = this.#airTime;
    t.inBreak = inBreak;
  }
}
