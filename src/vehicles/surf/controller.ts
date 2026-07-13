import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { waterHeight } from "../../world/heightmap";
import {
  OCEAN_BEACH_SURF,
  nearestOceanBeachCrest,
  oceanBeachMask,
  sampleOceanBeachWave
} from "../../world/oceanBeachWaves";
import {
  normalizeSurfboardConfig,
  surfboardHandling,
  type SurfboardConfig,
  type SurfboardHandlingProfile,
  type SurfboardShape
} from "./config";
import { SURF_TUNING } from "./tuning";

const V = {
  fwd: new THREE.Vector3(),
  euler: new THREE.Euler(0, 0, 0, "YXZ")
};

const FLOW_REQUEST_BUFFER = 0.45;

export type SurfPhase = "paddle" | "ride" | "air" | "recover";

function shortestAngle(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

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
  phase: SurfPhase;
  beached: boolean;
  caughtSerial: number;

  /** Single-source-of-truth surface diagnostics. Clearance must never be < 0. */
  surfaceY: number;
  clearance: number;
  /** -1 north, +1 south along Ocean Beach. */
  lineDirection: number;
  pump: number;
  stalling: boolean;

  /** Automatic launch / landing / VFX event bridge. */
  autoLaunchCharge: number;
  launchSerial: number;
  splashSerial: number;
  splashEnergy: number;
  landingQuality: number;

  /** Flow is local rider time only; the world clock and waves never slow. */
  flow: number;
  flowReady: boolean;
  flowActive: boolean;
  flowSerial: number;
  flowTimeRemaining: number;
  flowRequestBuffered: boolean;
  riderMotionRate: number;
  shape: SurfboardShape;
};

/**
 * Cozy arcade surfing with one hard invariant: the board never goes below the
 * live `waterHeight()` floor. The dynamic body is velocity-driven exactly once
 * by the fixed physics step; controller code no longer advances X/Z and then
 * asks physics to advance the same displacement a second time.
 *
 * Controls:
 *  - W pumps for line speed; S stalls without reversing.
 *  - A/D directly choose north/south down the line and carve toward that choice.
 *  - A fast pass through the lip launches automatically. Space is not a launch.
 *  - X spends a full flow meter. Only rider motion slows; world/wave time stays live.
 */
export class SurfController implements ModeController {
  readonly spawnLift = 0;
  yaw = Math.PI / 2;
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
    inBreak: true,
    phase: "paddle",
    beached: false,
    caughtSerial: 0,
    surfaceY: 0,
    clearance: 0,
    lineDirection: 1,
    pump: 0,
    stalling: false,
    autoLaunchCharge: 0,
    launchSerial: 0,
    splashSerial: 0,
    splashEnergy: 0,
    landingQuality: 1,
    flow: 0,
    flowReady: false,
    flowActive: false,
    flowSerial: 0,
    flowTimeRemaining: 0,
    flowRequestBuffered: false,
    riderMotionRate: 1,
    shape: "shortboard"
  };

  #config: SurfboardConfig = normalizeSurfboardConfig(null);
  #phase: SurfPhase = "paddle";
  #paddleSpeed = 0;
  #paddleTime = 0;
  #lineDirection = 1;
  #lineSpeed = 0;
  #pump = 0;
  #airVy = 0;
  #airTime = 0;
  #launchCharge = 0;
  #launchCooldown = 0;
  #recoveryTimer = 0;
  #flow = 0;
  #flowTimer = 0;
  #flowRequest = 0;

  setConfig(config: SurfboardConfig) {
    this.#config = normalizeSurfboardConfig(config);
    this.telemetry.shape = this.#config.shape;
  }

  get config(): Readonly<SurfboardConfig> {
    return this.#config;
  }

  /** Render-frame-safe request latch. Callers may invoke this before a fixed step. */
  requestFlow(): boolean {
    if (this.#flowTimer > 0) return false;
    this.#flowRequest = FLOW_REQUEST_BUFFER;
    return this.#flow >= SURF_TUNING.values.flowReadyThreshold && this.#flowTimer <= 0;
  }

  /** Kept for Player's existing public API; surf launches are intentionally automatic. */
  requestJump() {
    // No-op by design. Speed + lip energy own takeoff, never a special jump button.
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    if (oceanBeachMask(p.x, p.z) < 0.03) this.#toLineup(ctx, false);
    const y = Math.max(p.y, this.#surface(p.x, p.z, ctx.time, SURF_TUNING.values.proneHeight));
    p.y = y;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, y, p.z],
      halfExtents: [0.5, 0.16, 1.55],
      density: 48,
      friction: 0.05,
      restitution: 0
    });
    w.setBodyGravityScale(ctx.body, 0);

    this.yaw = facing;
    this.lean = 0;
    this.pitch = 0;
    this.grounded = true;
    this.#phase = "paddle";
    this.#paddleSpeed = 0;
    this.#paddleTime = 0;
    this.#lineSpeed = 0;
    this.#pump = 0;
    this.#airVy = 0;
    this.#airTime = 0;
    this.#launchCharge = 0;
    this.#launchCooldown = 0;
    this.#recoveryTimer = 0;
    this.#flowTimer = 0;
    this.#flowRequest = 0;
    this.telemetry.landedAirTime = 0;
    this.telemetry.beached = false;
    this.telemetry.phase = "paddle";
    this.telemetry.grounded = true;
    this.telemetry.airborne = false;
    this.telemetry.pump = 0;
    this.telemetry.flow = this.#flow;
    this.telemetry.flowReady = this.#flow >= SURF_TUNING.values.flowReadyThreshold;
    this.telemetry.flowActive = false;
    this.telemetry.flowTimeRemaining = 0;
    this.telemetry.flowRequestBuffered = false;
    this.telemetry.riderMotionRate = 1;
    this.telemetry.shape = this.#config.shape;
    return y;
  }

  enter(ctx: PlayerCtx) {
    const b = OCEAN_BEACH_SURF;
    const nearBreak =
      ctx.position.x > b.minX - 400 &&
      ctx.position.x < b.maxX + 500 &&
      ctx.position.z > b.minZ - 400 &&
      ctx.position.z < b.maxZ + 400;
    if (!nearBreak) ctx.position.set(b.entryX, 0, b.entryZ);
    this.#phase = "paddle";
    this.#toLineup(ctx, nearBreak);
    // Face SHOREWARD by default: paddling in (W) drops you into the wave you're
    // sitting on within a stroke. Turn offshore to paddle OUT (the catch gate then
    // lets you stroke through the sets without being swept back in).
    return -Math.PI / 2;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyA", "KeyD");
    if (!input.suspended && input.pressed("KeyX")) this.requestFlow();

    this.#launchCooldown = Math.max(0, this.#launchCooldown - dt);
    this.#flowRequest = Math.max(0, this.#flowRequest - dt);
    if (
      this.#flowRequest > 0 &&
      this.#flowTimer <= 0 &&
      this.#flow >= SURF_TUNING.values.flowReadyThreshold &&
      this.#phase !== "paddle"
    ) {
      this.#flow = 0;
      this.#flowTimer = SURF_TUNING.values.flowDuration;
      this.#flowRequest = 0;
      this.telemetry.flowSerial++;
    }
    if (this.#flowTimer > 0) this.#flowTimer = Math.max(0, this.#flowTimer - dt);

    const riderRate = this.#flowTimer > 0 ? SURF_TUNING.values.flowTimeScale : 1;
    const motionDt = dt * riderRate;
    this.telemetry.beached = false;

    if (this.#phase === "paddle") this.#updatePaddle(ctx, dt, motionDt, throttle, steer, frame, riderRate);
    else if (this.#phase === "air") this.#updateAir(ctx, dt, motionDt, throttle, steer, frame, riderRate);
    else if (this.#phase === "recover") this.#updateRecovery(ctx, dt, motionDt, steer, frame, riderRate);
    else this.#updateRide(ctx, dt, motionDt, throttle, steer, frame, riderRate);
  }

  // --- paddle -----------------------------------------------------------------

  #updatePaddle(
    ctx: PlayerCtx,
    dt: number,
    motionDt: number,
    throttle: number,
    steer: number,
    frame: ModeFrame,
    riderRate: number
  ) {
    const tb = SURF_TUNING.values;
    const p = ctx.position;
    const shape = surfboardHandling(this.#config);
    this.yaw += steer * tb.paddleTurn * shape.carve * motionDt;
    const paddleTarget = Math.max(0, throttle) * tb.paddleSpeed;
    const paddleResponse = throttle < 0 ? tb.paddleBrake : tb.paddleAccel;
    this.#paddleSpeed += (paddleTarget - this.#paddleSpeed) * Math.min(1, motionDt * paddleResponse);

    const fwd = V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    let vx = fwd.x * this.#paddleSpeed * riderRate;
    let vz = fwd.z * this.#paddleSpeed * riderRate;
    const nx = p.x + vx * dt;
    const nz = p.z + vz * dt;

    const beached = !ctx.map.isWater(nx, nz) && nx > OCEAN_BEACH_SURF.maxX - 24;
    this.telemetry.beached = beached;
    if (beached) vx = vz = 0;
    if (nx < OCEAN_BEACH_SURF.minX + 7) vx = Math.max(vx, 2.5);
    if (nz < OCEAN_BEACH_SURF.minZ + 10) vz = Math.max(vz, 2.5);
    if (nz > OCEAN_BEACH_SURF.maxZ - 10) vz = Math.min(vz, -2.5);

    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);
    this.#paddleTime += dt;

    // Only a wave you're NOT paddling away from can catch you: stroking offshore
    // (vx strongly negative) lets you paddle out through the sets without being
    // swept straight back in. Idle or paddling shoreward, the next wave picks you up.
    const paddlingOut = vx < -1.5;
    if (
      !beached &&
      !paddlingOut &&
      this.#paddleTime > tb.catchDelay &&
      sample.face > tb.catchFace &&
      sample.crestDistance > -8 &&
      sample.crestDistance < 18 &&
      throttle > -0.5
    ) {
      this.#popUp(ctx, steer);
    }

    // Pop-up changes the required deck clearance in this same fixed step. Lift
    // straight onto the standing rail floor so telemetry/rendering never gets a
    // one-frame prone-height dip at the transition.
    const supportClearance = this.#phase === "ride" ? tb.railHeight : tb.proneHeight;
    const y = this.#safeY(ctx, supportClearance);
    // Player.time is advanced before ModeController.update, so it already names
    // this fixed step's endpoint. Predict X/Z, but sample the same world time.
    const nextFloor = this.#surface(p.x + vx * dt, p.z + vz * dt, ctx.time, supportClearance);
    const vy = (nextFloor - y) / Math.max(dt, 1e-4);

    this.pitch += (-0.18 - this.pitch) * Math.min(1, motionDt * 6);
    this.lean += (steer * 0.24 - this.lean) * Math.min(1, motionDt * 6);
    this.grounded = true;
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
  }

  #popUp(ctx: PlayerCtx, steer: number) {
    const tb = SURF_TUNING.values;
    this.#phase = "ride";
    this.#lineDirection = Math.abs(steer) > 0.15 ? Math.sign(steer) : ctx.position.z > OCEAN_BEACH_SURF.centerZ ? -1 : 1;
    this.#lineSpeed = Math.max(tb.trimSpeed * 0.72, this.#paddleSpeed);
    this.#paddleTime = 0;
    this.#launchCharge = 0;
    this.#airVy = 0;
    this.#airTime = 0;
    this.telemetry.caughtSerial++;
  }

  // --- riding -----------------------------------------------------------------

  #updateRide(
    ctx: PlayerCtx,
    dt: number,
    motionDt: number,
    throttle: number,
    steer: number,
    frame: ModeFrame,
    riderRate: number
  ) {
    const tb = SURF_TUNING.values;
    const shape = surfboardHandling(this.#config);
    const p = ctx.position;
    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);

    if (Math.abs(steer) > 0.12) {
      const response = 1 - Math.exp(-motionDt * tb.carveResponse * shape.carve);
      this.#lineDirection += (Math.sign(steer) - this.#lineDirection) * response;
      if (Math.abs(this.#lineDirection) < 0.08) this.#lineDirection = Math.sign(steer) * 0.08;
    }
    this.#lineDirection = THREE.MathUtils.clamp(this.#lineDirection, -1, 1);

    this.#pump += (Math.max(0, throttle) - this.#pump) * Math.min(1, motionDt * tb.pumpResponse);
    let targetSpeed: number;
    if (throttle < -0.1) targetSpeed = tb.stallSpeed;
    else targetSpeed = (tb.trimSpeed + this.#pump * tb.pumpBoost) * shape.speed;
    targetSpeed = Math.min(targetSpeed, tb.maxTrim * shape.speed);
    const response = throttle < -0.1 ? tb.stallResponse : tb.speedResponse * shape.acceleration;
    this.#lineSpeed += (targetSpeed - this.#lineSpeed) * Math.min(1, motionDt * response);

    // The moving crest carries X in world time. Rider-time scaling only affects
    // the player's own line motion and carve response, never the wave clock.
    const faceError = tb.faceOffset - sample.crestDistance;
    const vx = THREE.MathUtils.clamp(
      OCEAN_BEACH_SURF.speed + faceError * tb.faceTrack * shape.grip,
      -tb.maxFaceCorrection,
      OCEAN_BEACH_SURF.speed + tb.maxFaceCorrection
    );
    let vz = this.#lineDirection * this.#lineSpeed * riderRate;
    const nextZ = p.z + vz * dt;
    if (nextZ < OCEAN_BEACH_SURF.minZ + tb.boundaryMargin) {
      this.#lineDirection = 1;
      vz = Math.abs(vz);
    } else if (nextZ > OCEAN_BEACH_SURF.maxZ - tb.boundaryMargin) {
      this.#lineDirection = -1;
      vz = -Math.abs(vz);
    }

    const nx = p.x + vx * dt;
    const nz = p.z + vz * dt;
    if (!ctx.map.isWater(nx, nz) && nx > OCEAN_BEACH_SURF.maxX - 22) this.telemetry.beached = true;

    const y = this.#safeY(ctx, tb.railHeight);
    const nextFloor = this.#surface(nx, nz, ctx.time, tb.railHeight);
    const vy = (nextFloor - y) / Math.max(dt, 1e-4);
    const speed = Math.hypot(vx, vz);
    const fastEnough = speed >= tb.launchMinSpeed * (2 - shape.launch);
    const lipEnergy = THREE.MathUtils.clamp(
      (sample.lip - tb.autoLaunchLip) / Math.max(0.05, 1 - tb.autoLaunchLip),
      0,
      1
    );
    if (fastEnough && lipEnergy > 0 && this.#launchCooldown <= 0 && throttle > -0.15) {
      const speedEnergy = THREE.MathUtils.clamp(
        (speed - tb.launchMinSpeed) / Math.max(1, tb.maxTrim - tb.launchMinSpeed),
        0,
        1
      );
      this.#launchCharge = Math.min(
        1,
        this.#launchCharge +
          dt *
            tb.launchChargeRate *
            (0.18 + this.#pump * 0.82) *
            (0.4 + lipEnergy * 0.8 + speedEnergy)
      );
    } else {
      this.#launchCharge = Math.max(0, this.#launchCharge - dt * tb.launchChargeDecay);
    }

    this.#chargeFlow(dt, speed, sample.face, Math.abs(steer));
    if (this.#launchCharge >= 1 && this.#launchCooldown <= 0) {
      this.#beginAutoLaunch(speed, sample.lip, shape);
      this.#orientRide(ctx, motionDt, steer, vx, vz, vy);
      this.#commit(ctx, y, vx, this.#airVy * riderRate, vz);
      this.#syncTelemetry(ctx, frame, sample, speed, y, riderRate);
      return;
    }

    if (sample.mask < 0.025) {
      this.#beginRecovery(0.45);
    }

    this.grounded = true;
    this.#orientRide(ctx, motionDt, steer, vx, vz, vy);
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, speed, y, riderRate);
  }

  #beginAutoLaunch(speed: number, lip: number, shape: SurfboardHandlingProfile) {
    const tb = SURF_TUNING.values;
    this.#phase = "air";
    this.grounded = false;
    this.#airTime = 0;
    this.#airVy = (tb.launchVelocity + speed * tb.launchSpeedLift + lip * tb.launchLipLift) * shape.launch;
    this.#launchCharge = 0;
    this.#launchCooldown = tb.launchCooldown;
    this.telemetry.launchSerial++;
    this.#emitSplash(THREE.MathUtils.clamp(0.35 + speed / tb.maxTrim + lip * 0.35, 0.3, 1.6));
  }

  // --- air + magnetic landing -------------------------------------------------

  #updateAir(
    ctx: PlayerCtx,
    dt: number,
    motionDt: number,
    _throttle: number,
    steer: number,
    frame: ModeFrame,
    riderRate: number
  ) {
    const tb = SURF_TUNING.values;
    const shape = surfboardHandling(this.#config);
    const p = ctx.position;
    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);
    this.#airTime += dt;
    this.#airVy -= tb.gravity * motionDt;

    // Preserve horizontal momentum from the body. Flow scales only the rider's
    // velocity, so observers see a long, dreamy arc while the ocean stays live.
    let vx = frame.v.linear[0];
    let vz = frame.v.linear[2];
    if (riderRate < 1) {
      const h = Math.hypot(vx, vz);
      if (h > 1e-4) {
        const targetH = this.#lineSpeed * riderRate;
        vx = (vx / h) * targetH;
        vz = (vz / h) * targetH;
      }
    }
    const vy = this.#airVy * riderRate;
    this.yaw += steer * tb.airSpinRate * motionDt * shape.carve;
    this.lean += steer * tb.airRollRate * motionDt;

    let y = this.#safeY(ctx, tb.railHeight);
    const nx = p.x + vx * dt;
    const nz = p.z + vz * dt;
    const landingFloor = this.#surface(nx, nz, ctx.time, tb.railHeight);
    const predictedY = y + vy * dt;
    const magnet = tb.landingMagnet * shape.landingAssist + Math.min(0.8, Math.hypot(vx, vz) * 0.018);
    const descending = this.#airVy <= 0;

    if (descending && predictedY <= landingFloor + magnet) {
      const travelYaw = Math.atan2(-vx, -vz);
      const alignment = Math.abs(shortestAngle(this.yaw, travelYaw));
      const impact = Math.abs(this.#airVy);
      const quality = THREE.MathUtils.clamp(
        1 - alignment / Math.PI * 0.7 - Math.max(0, impact - tb.softLandingSpeed) / tb.hardLandingRange,
        0,
        1
      );
      this.telemetry.landedAirTime = this.#airTime;
      this.telemetry.landingQuality = quality;
      this.telemetry.landingSerial++;
      this.#flow = Math.min(1, this.#flow + this.#airTime * tb.flowLandingBoost * (0.5 + quality * 0.5));
      this.#emitSplash(THREE.MathUtils.clamp(0.35 + impact / 18 + this.#airTime * 0.18, 0.3, 1.6));

      y = Math.max(y, this.#surface(p.x, p.z, ctx.time, tb.railHeight));
      const trackVy = (landingFloor - y) / Math.max(dt, 1e-4);
      this.#airVy = 0;
      this.#airTime = 0;
      this.grounded = true;
      if (quality < tb.recoveryQuality) this.#beginRecovery(1 - quality);
      else this.#phase = "ride";
      this.yaw += shortestAngle(travelYaw, this.yaw) * 0.75;
      this.lean *= 0.35;
      this.pitch *= 0.5;
      this.#commit(ctx, y, vx, trackVy, vz);
      this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
      return;
    }

    this.grounded = false;
    const pitchTarget = THREE.MathUtils.clamp(this.#airVy * 0.024, -0.48, 0.52);
    this.pitch += (pitchTarget - this.pitch) * Math.min(1, motionDt * 4.5);
    this.lean = THREE.MathUtils.clamp(this.lean, -1.45, 1.45);
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
  }

  // --- surface-skimming recovery ---------------------------------------------

  #beginRecovery(severity: number) {
    this.#phase = "recover";
    this.#recoveryTimer = SURF_TUNING.values.recoveryDuration * THREE.MathUtils.lerp(0.7, 1.25, severity);
    this.#lineSpeed = Math.max(SURF_TUNING.values.recoverySpeed, this.#lineSpeed * 0.62);
    this.#launchCharge = 0;
    this.#launchCooldown = Math.max(this.#launchCooldown, SURF_TUNING.values.recoveryLaunchLock);
    this.grounded = true;
    this.telemetry.wipeoutSerial++;
  }

  #updateRecovery(
    ctx: PlayerCtx,
    dt: number,
    motionDt: number,
    steer: number,
    frame: ModeFrame,
    riderRate: number
  ) {
    const tb = SURF_TUNING.values;
    const p = ctx.position;
    this.#recoveryTimer = Math.max(0, this.#recoveryTimer - dt);
    if (Math.abs(steer) > 0.15) this.#lineDirection += (Math.sign(steer) - this.#lineDirection) * Math.min(1, motionDt * 2.5);
    const sample = sampleOceanBeachWave(p.x, p.z, ctx.time);
    const faceError = tb.faceOffset - sample.crestDistance;
    const vx = THREE.MathUtils.clamp(
      OCEAN_BEACH_SURF.speed + faceError * tb.recoveryFaceTrack,
      -tb.maxFaceCorrection,
      OCEAN_BEACH_SURF.speed + tb.maxFaceCorrection
    );
    const vz = this.#lineDirection * tb.recoverySpeed * riderRate;
    const y = this.#safeY(ctx, tb.railHeight);
    const nextFloor = this.#surface(p.x + vx * dt, p.z + vz * dt, ctx.time, tb.railHeight);
    const vy = (nextFloor - y) / Math.max(dt, 1e-4);

    this.lean += (0 - this.lean) * Math.min(1, motionDt * 7);
    this.pitch += (0 - this.pitch) * Math.min(1, motionDt * 6);
    this.yaw = Math.atan2(-vx, -vz);
    this.grounded = true;
    if (this.#recoveryTimer <= 0) this.#phase = "ride";
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
  }

  // --- helpers ----------------------------------------------------------------

  #surface(x: number, z: number, time: number, clearance: number): number {
    // Ride the wave where it stands above the sea, but never sink below the flat
    // ocean between sets: the analytic trough dips below 0, and tracking it put the
    // board (and the chase eye) underwater. Sea level (0) is the hard floor.
    return Math.max(waterHeight(x, z, time), 0) + clearance;
  }

  /** Immediate correction for any stale/low body pose before the next physics step. */
  #safeY(ctx: PlayerCtx, clearance: number): number {
    const floor = this.#surface(ctx.position.x, ctx.position.z, ctx.time, clearance);
    return Math.max(ctx.position.y, floor);
  }

  #commit(ctx: PlayerCtx, y: number, vx: number, vy: number, vz: number) {
    const q = ctx.quaternion.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
    const w = ctx.physics.world;
    w.setBodyTransform(ctx.body, [ctx.position.x, y, ctx.position.z], [q.x, q.y, q.z, q.w]);
    w.setBodyVelocity(ctx.body, [vx, vy, vz], [0, 0, 0]);
    ctx.heading = this.yaw + Math.PI;
  }

  #orientRide(ctx: PlayerCtx, motionDt: number, steer: number, vx: number, vz: number, vy: number) {
    const tb = SURF_TUNING.values;
    const shape = surfboardHandling(this.#config);
    const speed = Math.hypot(vx, vz);
    if (speed > 0.1) this.yaw = Math.atan2(-vx, -vz);
    const targetLean = THREE.MathUtils.clamp(steer * tb.carveLean * shape.carve, -1.05, 1.05);
    this.lean += (targetLean - this.lean) * Math.min(1, motionDt * tb.leanResponse * shape.stability);

    const h = Math.max(0.1, speed);
    const fx = vx / h;
    const fz = vz / h;
    const e = tb.pitchSampleDistance;
    const front = waterHeight(ctx.position.x + fx * e, ctx.position.z + fz * e, ctx.time);
    const back = waterHeight(ctx.position.x - fx * e, ctx.position.z - fz * e, ctx.time);
    const slopePitch = Math.atan2(front - back, e * 2) * tb.pitchFollow;
    const pitchTarget = THREE.MathUtils.clamp(slopePitch + vy * 0.004, -0.58, 0.58);
    this.pitch += (pitchTarget - this.pitch) * Math.min(1, motionDt * tb.pitchResponse);
  }

  #chargeFlow(dt: number, speed: number, face: number, carve: number) {
    if (this.#flowTimer > 0) return;
    const tb = SURF_TUNING.values;
    const speedK = THREE.MathUtils.clamp((speed - tb.stallSpeed) / Math.max(1, tb.maxTrim - tb.stallSpeed), 0, 1);
    this.#flow = Math.min(1, this.#flow + dt * tb.flowChargeRate * (0.25 + speedK * 0.55 + face * 0.35 + carve * 0.2));
  }

  #emitSplash(energy: number) {
    this.telemetry.splashEnergy = energy;
    this.telemetry.splashSerial++;
  }

  #toLineup(ctx: PlayerCtx, keepZ: boolean) {
    const b = OCEAN_BEACH_SURF;
    const p = ctx.position;
    const z = keepZ ? THREE.MathUtils.clamp(p.z, b.minZ + 40, b.maxZ - 40) : b.entryZ;
    const crest = nearestOceanBeachCrest(b.entryX + 20, z, ctx.time);
    p.set(crest.crestX + 6, this.#surface(crest.crestX + 6, z, ctx.time, SURF_TUNING.values.proneHeight), z);
    this.yaw = -Math.PI / 2; // face shoreward — paddle in to drop into the wave
    this.#paddleTime = 0;
    this.#paddleSpeed = 0;
    this.#airVy = 0;
    this.#airTime = 0;
    if (ctx.body) {
      const q = ctx.quaternion.setFromEuler(V.euler.set(-0.18, this.yaw, 0, "YXZ"));
      ctx.physics.world.setBodyTransform(ctx.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      ctx.physics.world.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
    }
  }

  #syncTelemetry(
    ctx: PlayerCtx,
    _frame: ModeFrame,
    sample: ReturnType<typeof sampleOceanBeachWave>,
    speed: number,
    committedY: number,
    riderRate: number
  ) {
    const tm = this.telemetry;
    const clearance = this.#phase === "paddle" ? SURF_TUNING.values.proneHeight : SURF_TUNING.values.railHeight;
    const surfaceY = this.#surface(ctx.position.x, ctx.position.z, ctx.time, clearance);
    tm.speed = speed;
    tm.face = sample.face;
    tm.lip = sample.lip;
    tm.lean = this.lean;
    tm.grounded = this.grounded;
    tm.airborne = this.#phase === "air";
    tm.airTime = this.#airTime;
    tm.inBreak = sample.mask > 0.025;
    tm.phase = this.#phase;
    tm.surfaceY = surfaceY;
    const signedClearance = committedY - surfaceY;
    tm.clearance = Math.abs(signedClearance) < 1e-6 ? 0 : signedClearance;
    tm.lineDirection = this.#lineDirection;
    tm.pump = this.#pump;
    tm.stalling = this.#phase === "ride" && this.#lineSpeed <= SURF_TUNING.values.stallSpeed * 1.2;
    tm.autoLaunchCharge = this.#launchCharge;
    tm.flow = this.#flow;
    tm.flowReady = this.#flow >= SURF_TUNING.values.flowReadyThreshold;
    tm.flowActive = this.#flowTimer > 0;
    tm.flowTimeRemaining = this.#flowTimer;
    tm.flowRequestBuffered = this.#flowRequest > 0;
    tm.riderMotionRate = riderRate;
    tm.shape = this.#config.shape;
  }
}
