import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { waterHeight } from "../../world/heightmap";
import {
  OCEAN_BEACH_SURF,
  oceanBeachMask,
  oceanBeachCrestX,
  nearestOceanBeachCrest,
  sampleOceanBeachWave
} from "../../world/oceanBeachWaves";
import { SURF_TUNING } from "./tuning";

const V = {
  fwd: new THREE.Vector3(),
  euler: new THREE.Euler(0, 0, 0, "YXZ")
};

export type SurfPhase = "paddle" | "ride" | "wipeout";

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
  /** which phase of the ride we're in — drives the HUD + pose */
  phase: SurfPhase;
  /** true the moment the board runs up onto dry sand; main.ts stands you up */
  beached: boolean;
  /** bumps each time a wave is caught (paddle → pop-up) for HUD/audio cues */
  caughtSerial: number;
};

/**
 * Arcade surf, Kelly-Slater-Pro-Surfer style. The board is kinematic and rides
 * an analytic Pacific wave face:
 *  · paddle — prone; W paddles, A/D steer. Drift into a steep crest to pop up.
 *  · ride   — pinned to the moving face. A/D carves up (lip) / down (shoulder),
 *             W pumps for line speed, Shift tucks, Space launches off the lip.
 * X is slaved to the crest so the wave can never sweep you onto the sand; a
 * closed-out or missed wave just drops you back to paddling in the lineup.
 */
export class SurfController implements ModeController {
  readonly spawnLift = 0;
  yaw = Math.PI / 2; // face offshore to paddle out
  lean = 0;
  pitch = 0;
  grounded = true;
  telemetry: SurfTelemetry = {
    speed: 0, face: 0, lip: 0, lean: 0,
    grounded: true, airborne: false, airTime: 0,
    landedAirTime: 0, landingSerial: 0, wipeoutSerial: 0,
    inBreak: true, phase: "paddle", beached: false, caughtSerial: 0
  };

  #phase: SurfPhase = "paddle";
  #paddleSpeed = 0;
  #ridingSlot = 0;
  #peelDir = -1; // +1 south / −1 north along the beach
  #faceT = 0.4; // 0 shoulder … 1 lip
  #trim = 0; // current down-the-line speed
  #airborne = false;
  #airTime = 0;
  #jumpBuffer = 0;
  #wipeoutTimer = 0;
  #popup = 0; // brief pop-up animation lockout

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    // Drop into the water. If we're on sand / outside the break, wade west into it.
    if (oceanBeachMask(p.x, p.z) < 0.03) this.#toLineup(ctx, false);
    else p.y = Math.max(p.y, waterHeight(p.x, p.z, ctx.time) + SURF_TUNING.values.proneHeight);
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
    this.#phase = "paddle";
    this.#paddleSpeed = 0;
    this.#airborne = false;
    this.#airTime = 0;
    this.#jumpBuffer = 0;
    this.#wipeoutTimer = 0;
    this.#popup = 0;
    this.telemetry.landedAirTime = 0;
    this.telemetry.beached = false;
    return p.y;
  }

  enter(ctx: PlayerCtx) {
    const b = OCEAN_BEACH_SURF;
    const nearBreak =
      ctx.position.x > b.minX - 400 &&
      ctx.position.x < b.maxX + 500 &&
      ctx.position.z > b.minZ - 400 &&
      ctx.position.z < b.maxZ + 400;
    if (!nearBreak) {
      ctx.position.set(b.entryX, 0, b.entryZ);
    }
    // Start prone in the water; nudge west off the sand so you paddle OUT.
    if (oceanBeachMask(ctx.position.x, ctx.position.z) < 0.05 || ctx.position.x > b.maxX - 40) {
      this.#toLineup(ctx, false);
    } else {
      ctx.position.y = waterHeight(ctx.position.x, ctx.position.z, ctx.time) + SURF_TUNING.values.proneHeight;
    }
    this.#phase = "paddle";
    return Math.PI / 2; // face offshore to paddle out
  }

  requestJump() {
    this.#jumpBuffer = 0.2;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const throttle = input.axis("KeyS", "KeyW"); // +1 forward (W)
    const steer = input.axis("KeyA", "KeyD"); // +1 right (D)
    const tuck = input.down("ShiftLeft");
    if (!input.suspended && input.pressed("Space")) this.requestJump();
    this.#jumpBuffer = Math.max(0, this.#jumpBuffer - dt);
    this.#popup = Math.max(0, this.#popup - dt);

    if (this.#wipeoutTimer > 0) return this.#updateWipeout(ctx, dt, frame);
    if (this.#phase === "ride") return this.#updateRide(ctx, dt, throttle, steer, tuck, frame);
    return this.#updatePaddle(ctx, dt, throttle, steer, frame);
  }

  // --- paddle -----------------------------------------------------------------

  #updatePaddle(ctx: PlayerCtx, dt: number, throttle: number, steer: number, frame: ModeFrame) {
    const tb = SURF_TUNING.values;
    const p = ctx.position;
    const w = ctx.physics.world;

    this.yaw += steer * tb.paddleTurn * dt;
    this.#paddleSpeed += (Math.max(0, throttle) * tb.paddleSpeed - this.#paddleSpeed) * Math.min(1, dt * 3);
    if (throttle < 0) this.#paddleSpeed = Math.max(0, this.#paddleSpeed + throttle * tb.paddleAccel * dt);

    const fwd = V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    let nx = p.x + fwd.x * this.#paddleSpeed * dt;
    let nz = p.z + fwd.z * this.#paddleSpeed * dt;

    // stand up on dry sand (main.ts converts this to a walk with the board)
    const beached = !ctx.map.isWater(nx, nz) && nx > OCEAN_BEACH_SURF.maxX - 24;
    this.telemetry.beached = beached;
    if (!beached) {
      // keep the paddler inside the surf strip
      nx = THREE.MathUtils.clamp(nx, OCEAN_BEACH_SURF.minX + 8, OCEAN_BEACH_SURF.maxX - 6);
      nz = THREE.MathUtils.clamp(nz, OCEAN_BEACH_SURF.minZ + 12, OCEAN_BEACH_SURF.maxZ - 12);
    }
    p.x = nx;
    p.z = nz;
    const surface = waterHeight(p.x, p.z, ctx.time);
    p.y = surface + tb.proneHeight;

    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);
    // Catch: a steep crest reaching the board (crest at/just behind) lifts you in.
    const crest = nearestOceanBeachCrest(p.x, p.z, ctx.time);
    const d = crest.distance; // + shoreward of crest
    if (!beached && sample.face > tb.catchFace && d > -2.5 && d < 7 && throttle > -0.2) {
      this.#popUp(ctx, crest.slot, d);
    } else {
      this.pitch += (-0.28 - this.pitch) * Math.min(1, dt * 6); // prone nose-down
      this.lean += (steer * 0.3 - this.lean) * Math.min(1, dt * 5);
      const q = ctx.quaternion.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
      w.setBodyVelocity(ctx.body, [fwd.x * this.#paddleSpeed, 0, fwd.z * this.#paddleSpeed], [0, 0, 0]);
      w.setBodyTransform(ctx.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      ctx.heading = this.yaw + Math.PI;
    }
    this.grounded = true;
    this.#airborne = false;
    this.#syncTelemetry(frame, sample, true);
  }

  #popUp(ctx: PlayerCtx, slot: number, crestDistance: number) {
    const tb = SURF_TUNING.values;
    this.#phase = "ride";
    this.#ridingSlot = slot;
    // map current crest distance → face position (base far, lip near)
    this.#faceT = THREE.MathUtils.clamp((tb.baseOffset - crestDistance) / (tb.baseOffset - tb.lipOffset), 0.05, 0.9);
    this.#trim = Math.max(tb.trimSpeed * 0.7, this.#paddleSpeed);
    // peel toward the middle of the beach so the ride lasts
    this.#peelDir = ctx.position.z > OCEAN_BEACH_SURF.centerZ ? -1 : 1;
    this.#popup = 0.35;
    this.#airborne = false;
    this.#airTime = 0;
    this.telemetry.caughtSerial++;
  }

  // --- ride -------------------------------------------------------------------

  #updateRide(ctx: PlayerCtx, dt: number, throttle: number, steer: number, tuck: boolean, frame: ModeFrame) {
    const tb = SURF_TUNING.values;
    const p = ctx.position;
    const w = ctx.physics.world;
    const t = ctx.time;

    // carve up/down the face; the face has a slight downhill pull toward the base
    this.#faceT = THREE.MathUtils.clamp(
      this.#faceT + steer * tb.climbRate * dt - tb.faceGravity * dt * 0.5,
      -0.15,
      1.12
    );

    // line speed: pump (W), tuck (Shift), a touch faster in the steep pocket
    const pocket = 1 - Math.abs(this.#faceT - 0.55) * 1.4;
    let target = tb.trimSpeed + Math.max(0, pocket) * 4 + (throttle > 0 ? tb.pumpBoost : 0) + (tuck ? tb.tuckBoost : 0);
    target = Math.min(target, tb.maxTrim);
    this.#trim += (target - this.#trim) * Math.min(1, dt * 2.2);

    const faceT = THREE.MathUtils.clamp(this.#faceT, 0, 1);
    const faceOffset = THREE.MathUtils.lerp(tb.baseOffset, tb.lipOffset, faceT);
    const crestX = oceanBeachCrestX(this.#ridingSlot, p.z, t);
    const targetX = crestX + faceOffset;

    // advance down the line, ease X onto the moving face
    const nz = p.z + this.#peelDir * this.#trim * dt;
    const nx = p.x + (targetX - p.x) * Math.min(1, dt * tb.trackGain);

    const prevX = p.x, prevZ = p.z, prevY = p.y;
    p.z = nz;
    p.x = nx;

    const sample = sampleOceanBeachWave(p.x, p.z, t);
    const surfaceY = sample.height + tb.railHeight;

    // launch off the lip
    let vy = frame.v.linear[1];
    if (this.#jumpBuffer > 0 && !this.#airborne && faceT > 0.5) {
      vy = tb.jump + sample.lip * 5;
      this.#airborne = true;
      this.#airTime = 0;
      this.#jumpBuffer = 0;
    }

    if (this.#airborne) {
      vy -= tb.gravity * dt;
      this.#airTime += dt;
      p.y = prevY + vy * dt;
      this.lean += steer * dt * 2.2; // aerial roll
      if (p.y <= surfaceY && vy < 0) {
        p.y = surfaceY;
        this.#airborne = false;
        this.telemetry.landedAirTime = this.#airTime;
        this.telemetry.landingSerial++;
        if (Math.abs(this.lean) > 1.3) return this.#wipeout(ctx);
        this.#airTime = 0;
        // re-seat on the face from where we landed
        this.#faceT = THREE.MathUtils.clamp((tb.baseOffset - sample.crestDistance) / (tb.baseOffset - tb.lipOffset), 0, 1);
      }
    } else {
      p.y = surfaceY;
    }

    // end-of-ride conditions → back to paddling in the lineup
    const closedOut = crestX > OCEAN_BEACH_SURF.maxX - 18;
    const offBack = this.#faceT < -0.1; // slid off the back onto flat water
    const outOfBounds = p.z < OCEAN_BEACH_SURF.minZ + 10 || p.z > OCEAN_BEACH_SURF.maxZ - 10;
    if (!this.#airborne && (closedOut || offBack || outOfBounds)) {
      this.#toLineup(ctx, true);
      this.#phase = "paddle";
      this.#paddleSpeed = tb.paddleSpeed * 0.6;
      this.grounded = true;
      this.#syncTelemetry(frame, sample, true);
      return;
    }
    // over the falls
    if (this.#faceT > 1.08 && !this.#airborne) return this.#wipeout(ctx);

    // orientation: heading down the line, rolled into the carve
    const dx = (p.x - prevX) / Math.max(dt, 1e-3);
    const dz = (p.z - prevZ) / Math.max(dt, 1e-3);
    this.grounded = !this.#airborne;
    const targetLean = THREE.MathUtils.clamp(steer * tb.carveLean, -1.0, 1.0);
    this.lean += (targetLean - this.lean) * Math.min(1, dt * (this.#airborne ? 2 : 7));
    const pitchTarget = this.#airborne
      ? THREE.MathUtils.clamp(vy * 0.02, -0.4, 0.5)
      : THREE.MathUtils.clamp(-Math.atan(sample.slopeX) * 0.7, -0.5, 0.5);
    this.pitch += (pitchTarget - this.pitch) * Math.min(1, dt * 7);

    const heading = Math.atan2(-dx, -dz);
    this.yaw = heading;
    const q = ctx.quaternion.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
    w.setBodyVelocity(ctx.body, [dx, this.#airborne ? vy : 0, dz], [0, 0, 0]);
    w.setBodyTransform(ctx.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
    ctx.heading = this.yaw + Math.PI;
    this.#syncTelemetry(frame, sample, true);
  }

  // --- wipeout ----------------------------------------------------------------

  #wipeout(ctx: PlayerCtx) {
    this.#phase = "wipeout";
    this.#wipeoutTimer = 1.1;
    this.#airborne = false;
    this.grounded = false;
    this.telemetry.wipeoutSerial++;
    ctx.physics.world.setBodyVelocity(ctx.body, [3, -3, this.#peelDir * 3], [2, 1, 2]);
  }

  #updateWipeout(ctx: PlayerCtx, dt: number, frame: ModeFrame) {
    this.#wipeoutTimer -= dt;
    const p = ctx.position;
    const w = ctx.physics.world;
    if (this.#wipeoutTimer <= 0) {
      this.#toLineup(ctx, true);
      this.#phase = "paddle";
      this.#paddleSpeed = 0;
      this.lean = 0;
      this.pitch = 0;
      this.grounded = true;
      w.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
    } else {
      w.setBodyVelocity(ctx.body, [2.5, -1.5, this.#peelDir * 2], [0, 0, 0]);
    }
    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);
    this.#syncTelemetry(frame, sample, true);
  }

  // --- helpers ----------------------------------------------------------------

  /** Reset into the lineup (just outside the break) to paddle for the next wave. */
  #toLineup(ctx: PlayerCtx, keepZ: boolean) {
    const b = OCEAN_BEACH_SURF;
    const p = ctx.position;
    const z = keepZ ? THREE.MathUtils.clamp(p.z, b.minZ + 40, b.maxZ - 40) : b.entryZ;
    p.set(b.offshoreCrest + 55, 0, z); // offshore of the shoreward-breaking crests
    p.y = waterHeight(p.x, p.z, ctx.time) + SURF_TUNING.values.proneHeight;
    this.yaw = Math.PI / 2; // face offshore
    this.#faceT = 0.4;
    this.#airborne = false;
    this.#airTime = 0;
    if (ctx.body) {
      const q = ctx.quaternion.setFromEuler(V.euler.set(-0.2, this.yaw, 0, "YXZ"));
      ctx.physics.world.setBodyTransform(ctx.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      ctx.physics.world.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
    }
  }

  #syncTelemetry(frame: ModeFrame, sample: ReturnType<typeof sampleOceanBeachWave>, inBreak: boolean) {
    const tm = this.telemetry;
    tm.speed = Math.hypot(frame.v.linear[0], frame.v.linear[2]);
    tm.face = sample.face;
    tm.lip = sample.lip;
    tm.lean = this.lean;
    tm.grounded = this.grounded;
    tm.airborne = this.#airborne;
    tm.airTime = this.#airTime;
    tm.inBreak = inBreak;
    tm.phase = this.#phase;
  }
}
