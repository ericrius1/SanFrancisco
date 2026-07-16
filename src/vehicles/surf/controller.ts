import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { waterHeight } from "../../world/heightmap";
import {
  OCEAN_BEACH_SURF,
  nearestOceanBeachCrest,
  oceanBeachApproxShoreX,
  oceanBeachCrestX,
  sampleOceanBeachWave,
  type OceanBeachWaveSample
} from "../../world/oceanBeachWaves";
import {
  normalizeSurfboardConfig,
  surfboardHandling,
  type SurfboardConfig,
  type SurfboardHandlingProfile,
  type SurfboardShape
} from "./config";
import { SURF_TUNING } from "./tuning";
import { isOceanBeachSurfApproach } from "./entry";

const V = {
  euler: new THREE.Euler(0, 0, 0, "YXZ"),
  supportQ: new THREE.Quaternion(),
  supportProbe: new THREE.Vector3()
};

const FLOW_REQUEST_BUFFER = 0.45;

const SURFBOARD_FOOTPRINT: Record<SurfboardShape, { halfLength: number; halfWidth: number }> = {
  shortboard: { halfLength: 1.58, halfWidth: 0.5 },
  fish: { halfLength: 1.66, halfWidth: 0.59 },
  longboard: { halfLength: 2.12, halfWidth: 0.59 }
};

/** Recovery is an invisible board-on-water assist, never a wipeout/fall state. */
export type SurfPhase = "ride" | "air" | "recover";
export type SurfTubeState = "outside" | "entering" | "inside" | "exiting";

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
  assistSerial: number;
  waveSerial: number;
  inBreak: boolean;
  phase: SurfPhase;

  /** Single-source-of-truth surface diagnostics. Clearance must never be < 0. */
  surfaceY: number;
  clearance: number;
  /** -1 north, +1 south along Ocean Beach. */
  lineDirection: number;
  /** 0..1 climb effort (W / RT held) — drives HUD + rider pose. */
  pump: number;
  stalling: boolean;
  /** -1 nose at the lip … 0 trim … +1 dropped to the flats (from the carve). */
  faceLine: number;
  /** Deliberate roundhouse reversals (double-tap a carve side). */
  cutbackSerial: number;

  /** Automatic launch / landing / VFX event bridge. */
  autoLaunchCharge: number;
  launchSerial: number;
  splashSerial: number;
  splashEnergy: number;
  landingQuality: number;
  /** 0..1 short-lived knee/hip load after a real aerial touchdown. */
  landingCompression: number;

  /** Flow is local rider time only; the world clock and waves never slow. */
  flow: number;
  flowReady: boolean;
  flowActive: boolean;
  flowSerial: number;
  flowTimeRemaining: number;
  flowRequestBuffered: boolean;
  riderMotionRate: number;
  shape: SurfboardShape;

  /** Wave-local contact diagnostics and gameplay regions. */
  crestDistance: number;
  slopeX: number;
  slopeZ: number;
  supportError: number;
  /** Minimum clearance across the board centre, nose, tail and both rails. */
  hullClearance: number;
  railContact: boolean;
  relativeFaceSpeed: number;
  carveInput: number;

  /** Signed, unwrapped yaw accumulated during the current / last aerial. */
  airSpin: number;
  landedSpin: number;
  /** Signed, unwrapped pitch (W/S flips) during the current / last aerial. */
  airFlip: number;
  landedFlip: number;
  /** Seconds of grab (Shift / pad B) held during the current / last aerial. */
  grabTime: number;
  landedGrab: number;
  /** Barrel envelope strength ~55 m ahead down-line (0..1) — HUD telegraph. */
  barrelAhead: number;
  /** Exit spit events: leaving a real barrel grants a speed burst. */
  spitSerial: number;

  /** Concave barrel region shared with the roof renderer and camera. */
  tubeState: SurfTubeState;
  tubeDepth: number;
  tubeCoverage: number;
  tubeRoofY: number;
  tubeClearance: number;
  tubeDwell: number;
  tubeSerial: number;
};

/**
 * Cozy arcade surfing with one hard invariant: the board never goes below the
 * live `waterHeight()` floor. The dynamic body is velocity-driven exactly once
 * by the fixed physics step; controller code no longer advances X/Z and then
 * asks physics to advance the same displacement a second time.
 *
 * Controls (one stick):
 *  - A/D swing the nose around the remembered travel direction, clamped short
 *    of vertical — a hold can never accidentally reverse. The nose IS the face
 *    position: steer toward the wave to climb, toward the beach to drop, and
 *    the drop pays speed while the climb spends it (A/D alone is the pump).
 *    DOUBLE-TAP a side to commit a roundhouse cutback.
 *  - Space/pad-A always jumps (big off the lip); in the air A/D spins, W/S
 *    flips, Shift / pad-B grabs; X spends Flow. Camera never orbits.
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
    assistSerial: 0,
    waveSerial: 0,
    inBreak: true,
    phase: "ride",
    surfaceY: 0,
    clearance: 0,
    lineDirection: 1,
    pump: 0,
    stalling: false,
    faceLine: 0,
    cutbackSerial: 0,
    autoLaunchCharge: 0,
    launchSerial: 0,
    splashSerial: 0,
    splashEnergy: 0,
    landingQuality: 1,
    landingCompression: 0,
    flow: 0,
    flowReady: false,
    flowActive: false,
    flowSerial: 0,
    flowTimeRemaining: 0,
    flowRequestBuffered: false,
    riderMotionRate: 1,
    shape: "shortboard",
    crestDistance: 0,
    slopeX: 0,
    slopeZ: 0,
    supportError: 0,
    hullClearance: 0,
    railContact: true,
    relativeFaceSpeed: 0,
    carveInput: 0,
    airSpin: 0,
    landedSpin: 0,
    airFlip: 0,
    landedFlip: 0,
    grabTime: 0,
    landedGrab: 0,
    barrelAhead: 0,
    spitSerial: 0,
    tubeState: "outside",
    tubeDepth: 0,
    tubeCoverage: 0,
    tubeRoofY: 0,
    tubeClearance: 0,
    tubeDwell: 0,
    tubeSerial: 0
  };

  #config: SurfboardConfig = normalizeSurfboardConfig(null);
  #phase: SurfPhase = "ride";
  /** Remembered down-line travel direction. Changes ONLY on a deliberate
   *  cutback (double-tap), the Z-boundary reflection, or a landing re-seat —
   *  never as a side effect of working the face. */
  #lineDirection = 1;
  /** Smoothed A/D rail swing relative to travel, clamped short of vertical. */
  #steerSwing = 0;
  /** Smoothed 0..1 climb effort (for HUD/pose + launch charge). */
  #climbEffort = 0;
  /** Double-tap cutback state: last tap sign + seconds since that tap. */
  #prevSteer = 0;
  #steerTapSign = 0;
  #steerTapAge = 999;
  #lineSpeed = 0;
  #carve = 0;
  #entryAssist = 0;
  #airVy = 0;
  #airTime = 0;
  #airSpin = 0;
  #airFlip = 0;
  #grabTime = 0;
  /** Flow's velocity scale is applied once per air, not per step. */
  #airFlowApplied = false;
  #landingCompression = 0;
  #launchCharge = 0;
  #launchCooldown = 0;
  /** Seconds a Space/A press stays pending for a lip pop (or Flow fallback). */
  #popRequest = 0;
  #recoveryTimer = 0;
  #flow = 0;
  #flowTimer = 0;
  #flowRequest = 0;
  #relativeFaceSpeed = 0;
  #tubeState: SurfTubeState = "outside";
  #tubeDwell = 0;
  #tubeExit = 0;
  /** Locked crest slot so nearest-crest flips never yank the face magnet. */
  #crestSlot: number | null = null;

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

  /** Buffer a jump: big lip pop when launchable, small chop hop otherwise. */
  requestJump() {
    this.#popRequest = Math.max(this.#popRequest, SURF_TUNING.values.popBuffer);
  }

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    // Ordinary mode entry projects onto a crest in enter(), before this body is
    // created. Restore/invite/history paths intentionally bypass enter() because
    // their supplied pose is already authoritative; never silently relocate X/Z
    // here and invalidate the visual/collision destination that was just primed.
    // The five-point floor reads this.pitch/yaw/lean — seat with the fresh
    // entry attitude, never the pose left over from an exited mid-trick.
    {
      const vx0 = OCEAN_BEACH_SURF.speed;
      const vz0 = this.#lineDirection * SURF_TUNING.values.trimSpeed;
      this.yaw = Math.atan2(-vx0, -vz0);
    }
    this.lean = 0;
    this.pitch = 0;
    this.#crestSlot = null;
    const y = this.#contactFloor(p.x, p.z, ctx.time, SURF_TUNING.values.railHeight);
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

    const vx = OCEAN_BEACH_SURF.speed;
    const vz = this.#lineDirection * SURF_TUNING.values.trimSpeed;
    this.yaw = Math.atan2(-vx, -vz);
    this.lean = 0;
    this.pitch = 0;
    this.grounded = true;
    this.#phase = "ride";
    this.#steerSwing = 0;
    this.#climbEffort = 0;
    this.#prevSteer = 0;
    this.#steerTapSign = 0;
    this.#steerTapAge = 999;
    this.#lineSpeed = SURF_TUNING.values.trimSpeed;
    this.#carve = 0;
    this.#entryAssist = SURF_TUNING.values.entryAssistDuration;
    this.#airVy = 0;
    this.#airTime = 0;
    this.#airSpin = 0;
    this.#airFlip = 0;
    this.#grabTime = 0;
    this.#landingCompression = 0;
    this.#launchCharge = 0;
    this.#launchCooldown = 0;
    this.#popRequest = 0;
    this.#recoveryTimer = 0;
    this.#flowTimer = 0;
    this.#flowRequest = 0;
    this.#relativeFaceSpeed = 0;
    this.#tubeState = "outside";
    this.#tubeDwell = 0;
    this.#tubeExit = 0;
    w.setBodyVelocity(ctx.body, [vx, 0, vz], [0, 0, 0]);
    this.telemetry.landedAirTime = 0;
    this.telemetry.airSpin = 0;
    this.telemetry.landedSpin = 0;
    this.telemetry.airFlip = 0;
    this.telemetry.landedFlip = 0;
    this.telemetry.grabTime = 0;
    this.telemetry.landedGrab = 0;
    this.telemetry.landingCompression = 0;
    this.telemetry.phase = "ride";
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
    this.telemetry.tubeState = "outside";
    this.telemetry.tubeDepth = 0;
    this.telemetry.tubeCoverage = 0;
    this.telemetry.tubeDwell = 0;
    return y;
  }

  enter(ctx: PlayerCtx) {
    this.#placeOnWave(ctx, isOceanBeachSurfApproach(ctx.position.x, ctx.position.z));
    const vx = OCEAN_BEACH_SURF.speed;
    const vz = this.#lineDirection * SURF_TUNING.values.trimSpeed;
    return Math.atan2(-vx, -vz);
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const throttle = input.axis("KeyS", "KeyW");
    // Board-relative carve: A / stick-left always turns left of the nose, D
    // right — independent of north vs south peel. Chase cam sits behind so
    // screen-left matches board-left. Lean/spin share this `steer` sign.
    const steer = input.axis("KeyD", "KeyA");
    this.#launchCooldown = Math.max(0, this.#launchCooldown - dt);
    this.#popRequest = Math.max(0, this.#popRequest - dt);
    this.#flowRequest = Math.max(0, this.#flowRequest - dt);
    if (!input.suspended && input.pressed("Space")) this.requestJump();
    // Explicit Flow bind (keyboard X). Space also falls through to Flow when
    // a buffered pop cannot launch.
    if (!input.suspended && input.pressed("KeyX")) this.requestFlow();
    if (
      this.#flowRequest > 0 &&
      this.#flowTimer <= 0 &&
      this.#flow >= SURF_TUNING.values.flowReadyThreshold
    ) {
      this.#flow = 0;
      this.#flowTimer = SURF_TUNING.values.flowDuration;
      this.#flowRequest = 0;
      this.telemetry.flowSerial++;
    }
    if (this.#flowTimer > 0) this.#flowTimer = Math.max(0, this.#flowTimer - dt);

    const riderRate = this.#flowTimer > 0 ? SURF_TUNING.values.flowTimeScale : 1;
    const motionDt = dt * riderRate;
    this.#entryAssist = Math.max(0, this.#entryAssist - dt);
    this.#landingCompression *= Math.exp(-Math.max(0, dt) * 5.2);

    const grab = !input.suspended && input.held("ShiftLeft");
    if (this.#phase === "air") this.#updateAir(ctx, dt, motionDt, throttle, steer, grab, frame, riderRate);
    else if (this.#phase === "recover") this.#updateRecovery(ctx, dt, motionDt, steer, frame, riderRate);
    else this.#updateRide(ctx, dt, motionDt, throttle, steer, frame, riderRate);
    this.#updateTubeState(dt);
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
    if (this.#shouldResetWave(p.x, p.z, tb.waveResetMargin)) {
      this.#placeOnWave(ctx, true, true);
    }
    const sample = this.#sampleLockedCrest(p.x, p.z, ctx.time);

    const entryBlend =
      tb.entryAssistDuration > 0
        ? THREE.MathUtils.clamp(1 - this.#entryAssist / tb.entryAssistDuration, 0.45, 1)
        : 1;
    // --- A/D: rail swing relative to the REMEMBERED travel direction, clamped
    // short of vertical — working the wave can never accidentally flip you.
    const steerTarget = THREE.MathUtils.clamp(steer, -1, 1) * entryBlend;
    this.#steerSwing +=
      (steerTarget - this.#steerSwing) *
      (1 - Math.exp(-motionDt * tb.carveResponse * shape.carve));
    // Deliberate roundhouse: DOUBLE-TAP the carve direction. Holding full
    // lock is ordinary hard carving and must never reverse on its own — a
    // second rising edge with the same sign inside the tap window commits.
    const steerSign = steer > 0.6 ? 1 : steer < -0.6 ? -1 : 0;
    // Hysteresis: a new tap only registers after a real release below 0.3, so
    // pad jitter around the threshold cannot fire a phantom double-tap.
    const prevSign = this.#prevSteer > 0.3 ? 1 : this.#prevSteer < -0.3 ? -1 : 0;
    this.#steerTapAge += dt;
    if (steerSign !== 0 && prevSign === 0) {
      if (this.#steerTapSign === steerSign && this.#steerTapAge <= tb.cutbackTapWindow) {
        this.#lineDirection = -this.#lineDirection;
        this.#steerSwing = -this.#steerSwing;
        this.#steerTapSign = 0;
        this.#steerTapAge = 999;
        this.telemetry.cutbackSerial++;
        this.#emitSplash(0.95);
      } else {
        this.#steerTapSign = steerSign;
        this.#steerTapAge = 0;
      }
    }
    this.#prevSteer = steer;
    const baseYaw = this.#lineDirection > 0 ? Math.PI : 0;
    const yawTarget = baseYaw + this.#steerSwing * tb.carveMaxAngle;
    this.yaw +=
      shortestAngle(yawTarget, this.yaw) * (1 - Math.exp(-motionDt * tb.yawResponse));
    const crestward = Math.sin(this.yaw);
    this.#carve +=
      (crestward - this.#carve) *
      (1 - Math.exp(-motionDt * tb.carveResponse * shape.carve));

    // --- One-stick surfing: the nose IS the face position. Steering toward
    // the wave climbs, toward the beach drops — and the drop pays speed while
    // the climb spends it, so A/D alone carries the whole pump rhythm
    // (#carve = smoothed crestward nose, +1 = pointed at the wall).
    this.#climbEffort +=
      (Math.max(0, this.#carve) - this.#climbEffort) * Math.min(1, motionDt * 6);

    const targetSpeed = Math.min(tb.trimSpeed * shape.speed, tb.maxTrim * shape.speed);
    if (this.#lineSpeed < targetSpeed) {
      this.#lineSpeed +=
        (targetSpeed - this.#lineSpeed) *
        Math.min(1, motionDt * tb.speedResponse * shape.acceleration);
    } else {
      // Above trim, earned speed bleeds gently — the trim spring must never
      // out-pull the drop gain or carving down the face would LOSE speed.
      this.#lineSpeed +=
        (targetSpeed - this.#lineSpeed) * Math.min(1, motionDt * tb.speedDecay);
    }
    if (this.#carve < 0) {
      const headroom = Math.max(0, tb.maxTrim * shape.speed * 1.12 - this.#lineSpeed);
      this.#lineSpeed += Math.min(headroom, -this.#carve * tb.dropCarveGain * motionDt);
    } else if (this.#carve > 0) {
      this.#lineSpeed = Math.max(
        tb.stallSpeed,
        this.#lineSpeed -
          this.#carve * tb.climbCarveCost * motionDt * (this.#lineSpeed / Math.max(1, tb.maxTrim))
      );
    }

    // Board yaw authors the turn, but grounded X motion is resolved in the
    // moving crest frame. This is the rail contact the old height-only floor
    // lacked: velocity is projected back into a bounded face corridor instead
    // of crossing through the visible wall.
    const speed = this.#lineSpeed * riderRate;
    const authoredVx = -Math.sin(this.yaw) * speed;
    let vz = -Math.cos(this.yaw) * speed;
    const upRange = Math.max(1, tb.faceOffset - tb.faceLineLipOffset);
    let desiredFaceOffset =
      tb.faceOffset +
      (this.#carve > 0 ? -this.#carve * upRange : -this.#carve * tb.faceLineDropRange);
    // Riding the pocket under an available roof settles onto the tube line —
    // holding position (not a hidden snap) is what earns the barrel.
    if (sample.barrel > 0.05 && Math.abs(this.#carve) < 0.45) {
      desiredFaceOffset = THREE.MathUtils.lerp(
        desiredFaceOffset,
        OCEAN_BEACH_SURF.tubeLineOffset,
        THREE.MathUtils.clamp(sample.barrel * tb.tubeStallAssist, 0, 1)
      );
    }
    const faceError = desiredFaceOffset - sample.crestDistance;

    const nextZ = p.z + vz * dt;
    if (nextZ < OCEAN_BEACH_SURF.minZ + tb.boundaryMargin && vz < 0) {
      this.#lineDirection = 1;
      this.#steerSwing = -this.#steerSwing;
      // Boundary is an emergency assist — snap the heading so the reflection
      // cannot re-trigger while a smoothed yaw drifts back into the edge.
      this.yaw = Math.PI + this.#steerSwing * tb.carveMaxAngle;
      vz = Math.abs(vz);
      this.telemetry.assistSerial++;
      this.#emitSplash(0.7);
    } else if (nextZ > OCEAN_BEACH_SURF.maxZ - tb.boundaryMargin && vz > 0) {
      this.#lineDirection = -1;
      this.#steerSwing = -this.#steerSwing;
      this.yaw = this.#steerSwing * tb.carveMaxAngle;
      vz = -Math.abs(vz);
      this.telemetry.assistSerial++;
      this.#emitSplash(0.7);
    }

    const nz = p.z + vz * dt;
    const nextCrestX = oceanBeachCrestX(sample.slot, nz, ctx.time + dt);
    const crestVx = (nextCrestX - sample.crestX) / Math.max(dt, 1e-4);
    const authoredRelativeVx = authoredVx - crestVx;
    const targetRelativeVx = THREE.MathUtils.clamp(
      faceError * tb.faceTrack + authoredRelativeVx * tb.faceYawInfluence,
      -tb.maxFaceCorrection,
      tb.maxFaceCorrection
    );
    const railBlend = 1 - Math.exp(-motionDt * tb.railGrip * shape.grip);
    // Cross-face velocity is stateful. Blending anew from authored yaw every
    // frame made rail grip frame-rate dependent and unable to overcome the
    // crest's own 9 m/s translation; the board slowly leaked through the lip.
    this.#relativeFaceSpeed +=
      (targetRelativeVx - this.#relativeFaceSpeed) * railBlend;
    let vx = crestVx + this.#relativeFaceSpeed;
    let nx = p.x + vx * dt;

    // Continuous face contact: prevent one fast fixed step from tunnelling
    // through the crest or out through the spent back of the rideable wall.
    const predictedFaceDistance = nx - nextCrestX;
    const supportedFaceDistance = THREE.MathUtils.clamp(
      predictedFaceDistance,
      tb.faceCorridorMin,
      tb.faceCorridorMax
    );
    if (supportedFaceDistance !== predictedFaceDistance) {
      nx = nextCrestX + supportedFaceDistance;
      vx = (nx - p.x) / Math.max(dt, 1e-4);
    }
    this.#relativeFaceSpeed = vx - crestVx;

    const y = this.#safeY(ctx, tb.railHeight);
    const nextFloor = this.#contactFloor(nx, nz, ctx.time + dt, tb.railHeight);
    const rawVy = (nextFloor - y) / Math.max(dt, 1e-4);
    const vy = THREE.MathUtils.clamp(rawVy, -tb.maxSurfaceVy, tb.maxSurfaceVy);
    const totalSpeed = Math.hypot(vx, vz);
    // Aiming the nose up the face collapses the down-line velocity component, so
    // the frame speed cannot gate takeoff — the board is still carrying its
    // pumped line speed. Launch off that.
    const launchSpeed = Math.max(totalSpeed, speed);
    const fastEnough = launchSpeed >= tb.launchMinSpeed * (2 - shape.launch);
    const lipEnergy = THREE.MathUtils.clamp(
      (sample.lip - tb.autoLaunchLip) / Math.max(0.05, 1 - tb.autoLaunchLip),
      0,
      1
    );
    // Nose committed toward the wall + dwelling near the lip arms auto-launch.
    const highLineIntent = this.#carve > 0.5;
    const approachingLip =
      this.#relativeFaceSpeed < -tb.launchFacewardSpeed ||
      (highLineIntent && sample.crestDistance <= 6.5);
    const speedEnergy = THREE.MathUtils.clamp(
      (launchSpeed - tb.launchMinSpeed) / Math.max(1, tb.maxTrim - tb.launchMinSpeed),
      0,
      1
    );
    // Faceward speed (m/s) while climbing — carried into the launch as vert.
    const climbVertical = Math.max(0, -this.#relativeFaceSpeed) * 0.6;

    // Space/A always jumps: a big pop off the lip when you're there with
    // speed, otherwise a small chop hop — never a dead button. Flow lives on
    // its own bind (keyboard/pad X).
    if (this.#popRequest > 0 && this.#launchCooldown <= 0) {
      const manualLip = THREE.MathUtils.clamp(
        (sample.lip - tb.manualLaunchLip) / Math.max(0.05, 1 - tb.manualLaunchLip),
        0,
        1
      );
      const nearLip =
        manualLip > 0 ||
        sample.crestDistance <= tb.manualLaunchCrest ||
        (highLineIntent && sample.crestDistance <= 7.2);
      const popFastEnough = launchSpeed >= tb.manualLaunchMinSpeed * (2 - shape.launch);
      this.#popRequest = 0;
      if (nearLip && popFastEnough) {
        this.#beginAutoLaunch(launchSpeed, Math.max(sample.lip, 0.35), shape, climbVertical);
      } else {
        this.#beginOllie(launchSpeed, shape);
      }
      this.#orientRide(ctx, motionDt, steer, vx, vz, vy, sample);
      this.#commit(ctx, y, vx, this.#airVy * riderRate, vz);
      this.#syncTelemetry(ctx, frame, sample, totalSpeed, y, riderRate);
      return;
    }

    if (
      fastEnough &&
      lipEnergy > 0 &&
      this.#launchCooldown <= 0 &&
      (this.#climbEffort > 0.15 || speedEnergy > 0.3) &&
      highLineIntent &&
      approachingLip
    ) {
      // Carried momentum charges the lip like an active climb: drop for
      // speed, then riding high with pace alone arms the launch.
      this.#launchCharge = Math.min(
        1,
        this.#launchCharge +
          dt *
            tb.launchChargeRate *
            (0.18 + Math.max(this.#climbEffort, speedEnergy) * 0.82) *
            (0.4 + lipEnergy * 0.8 + speedEnergy)
      );
    } else {
      this.#launchCharge = Math.max(0, this.#launchCharge - dt * tb.launchChargeDecay);
    }

    this.#chargeFlow(dt, totalSpeed, sample.face, Math.abs(this.#carve));
    if (this.#launchCharge >= 1 && this.#launchCooldown <= 0) {
      this.#beginAutoLaunch(launchSpeed, sample.lip, shape, climbVertical);
      this.#orientRide(ctx, motionDt, steer, vx, vz, vy, sample);
      this.#commit(ctx, y, vx, this.#airVy * riderRate, vz);
      this.#syncTelemetry(ctx, frame, sample, totalSpeed, y, riderRate);
      return;
    }

    this.grounded = true;
    this.#orientRide(ctx, motionDt, steer, vx, vz, vy, sample);
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, totalSpeed, y, riderRate);
  }

  /** Small anywhere-hop for a Space press away from the lip. Keeps the line,
   *  keeps the button honest, and leaves the big pop to the lip. */
  /** Double-tap tracking must not straddle phase changes: a tap before a
   *  jump and a tap after landing are not one gesture. */
  #resetTapState() {
    this.#prevSteer = 0;
    this.#steerTapSign = 0;
    this.#steerTapAge = 999;
  }

  #beginOllie(speed: number, shape: SurfboardHandlingProfile) {
    const tb = SURF_TUNING.values;
    this.#phase = "air";
    this.grounded = false;
    this.#resetTapState();
    this.#airTime = 0;
    this.#airSpin = 0;
    this.#airFlip = 0;
    this.#grabTime = 0;
    this.#landingCompression = 0;
    this.#airVy = (tb.ollieVelocity + speed * tb.ollieSpeedLift) * shape.launch;
    // Launching during Flow: the ride commit already carried the scaled speed.
    this.#airFlowApplied = this.#flowTimer > 0;
    this.#launchCooldown = tb.ollieCooldown;
    this.telemetry.launchSerial++;
    this.#emitSplash(0.45);
  }

  #beginAutoLaunch(
    speed: number,
    lip: number,
    shape: SurfboardHandlingProfile,
    climbVertical = 0
  ) {
    const tb = SURF_TUNING.values;
    this.#phase = "air";
    this.grounded = false;
    this.#resetTapState();
    this.#airTime = 0;
    this.#airSpin = 0;
    this.#airFlip = 0;
    this.#grabTime = 0;
    this.#landingCompression = 0;
    this.#airVy =
      (tb.launchVelocity +
        speed * tb.launchSpeedLift +
        lip * tb.launchLipLift +
        climbVertical * tb.launchClimbLift) *
      shape.launch;
    this.#airFlowApplied = this.#flowTimer > 0;
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
    throttle: number,
    steer: number,
    grab: boolean,
    frame: ModeFrame,
    riderRate: number
  ) {
    const tb = SURF_TUNING.values;
    const shape = surfboardHandling(this.#config);
    const p = ctx.position;
    const sample = sampleOceanBeachWave(
      p.x,
      p.z,
      ctx.time,
      this.#crestSlot ?? undefined
    );
    this.#airTime += dt;
    this.#airVy -= tb.gravity * motionDt;

    // Preserve horizontal momentum from the body. Flow scales only the rider's
    // velocity, so observers see a long, dreamy arc while the ocean stays live.
    let vx = frame.v.linear[0];
    let vz = frame.v.linear[2];
    // Flow slows only rider-authored motion, applied ONCE per transition: the
    // body already holds last step's scaled commit, so rescaling every fixed
    // step decayed the arc geometrically (0.38^n) to a dead stop in ~0.15 s.
    if (riderRate < 1 && !this.#airFlowApplied) {
      vx = OCEAN_BEACH_SURF.speed + (vx - OCEAN_BEACH_SURF.speed) * riderRate;
      vz *= riderRate;
      this.#airFlowApplied = true;
    } else if (riderRate >= 1 && this.#airFlowApplied) {
      const scale = Math.max(0.05, SURF_TUNING.values.flowTimeScale);
      vx = OCEAN_BEACH_SURF.speed + (vx - OCEAN_BEACH_SURF.speed) / scale;
      vz /= scale;
      this.#airFlowApplied = false;
    }
    // Stay in the moving frame of the crest that launched us. This preserves a
    // real arc while preventing a faceward takeoff from crossing through the
    // wave or snapping to a neighbouring set during landing.
    if (this.#crestSlot != null) {
      const nextZ = p.z + vz * dt;
      const crestNow = oceanBeachCrestX(this.#crestSlot, p.z, ctx.time);
      const crestNext = oceanBeachCrestX(this.#crestSlot, nextZ, ctx.time + dt);
      const crestVx = (crestNext - crestNow) / Math.max(dt, 1e-4);
      const predictedD = p.x + vx * dt - crestNext;
      const targetRelativeVx = THREE.MathUtils.clamp((3.8 - predictedD) * 0.9, -2.2, 2.2);
      const relativeVx = vx - crestVx;
      vx = crestVx + THREE.MathUtils.lerp(relativeVx, targetRelativeVx, Math.min(1, dt * 1.7));
    }
    const vy = this.#airVy * riderRate;
    // Air A/D stays screen-relative with the same fixed sign as ride. A held
    // grab (Shift / pad B) slows every rotation for style + control.
    const grabScale = grab ? tb.grabRotationScale : 1;
    if (grab) this.#grabTime += dt;
    // Same sign convention as the grounded carve (A increases yaw).
    const spinStep = steer * tb.airYawStyle * shape.carve * grabScale * motionDt;
    this.yaw += spinStep;
    this.#airSpin += spinStep;
    // W/S = front / back flip. Once a flip has begun, pitch free-runs (the
    // vy-based glide pose below would fight the rotation).
    const flipStep =
      Math.abs(throttle) > 0.25
        ? -throttle * tb.airFlipStyle * grabScale * motionDt
        : 0;
    this.pitch += flipStep;
    this.#airFlip += flipStep;
    const targetLean = steer * tb.airRollStyle;
    this.lean +=
      (targetLean - this.lean) *
      (1 - Math.exp(-motionDt * tb.airAlignResponse * 0.72));

    // Keep a soft travel align so landings stay recoverable.
    const travelYaw = Math.atan2(-vx, -vz);
    if (Math.abs(steer) < 0.15) {
      this.yaw +=
        shortestAngle(travelYaw, this.yaw) *
        (1 - Math.exp(-motionDt * tb.airAlignResponse * 0.35));
    }
    // Auto-complete assist: with W/S released mid-flip, ease pitch toward the
    // nearest level revolution so near-complete flips land clean.
    if (Math.abs(throttle) <= 0.25 && Math.abs(this.#airFlip) > 0.3) {
      const level = Math.round(this.pitch / (Math.PI * 2)) * Math.PI * 2;
      const step =
        shortestAngle(level, this.pitch) *
        (1 - Math.exp(-motionDt * tb.airAlignResponse * 0.5));
      this.pitch += step;
      this.#airFlip += step;
    }

    let y = this.#safeY(ctx, tb.railHeight);
    const nx = p.x + vx * dt;
    const nz = p.z + vz * dt;
    const landingFloor = this.#surface(nx, nz, ctx.time, tb.railHeight);
    const predictedY = y + vy * dt;
    const magnet = tb.landingMagnet * shape.landingAssist + Math.min(0.8, Math.hypot(vx, vz) * 0.018);
    const descending = this.#airVy <= 0;

    if (descending && predictedY <= landingFloor + magnet) {
      const alignment = Math.abs(shortestAngle(this.yaw, travelYaw));
      // Unfinished flip rotation counts against the landing like yaw misalign.
      const level = Math.round(this.pitch / (Math.PI * 2)) * Math.PI * 2;
      const flipError = Math.abs(shortestAngle(level, this.pitch));
      const impact = Math.abs(this.#airVy);
      const quality = THREE.MathUtils.clamp(
        1 -
          alignment / Math.PI * 0.7 -
          flipError / Math.PI * 0.55 -
          Math.max(0, impact - tb.softLandingSpeed) / tb.hardLandingRange,
        0,
        1
      );
      this.telemetry.landedAirTime = this.#airTime;
      this.telemetry.landedSpin = this.#airSpin;
      this.telemetry.landedFlip = this.#airFlip;
      this.telemetry.landedGrab = this.#grabTime;
      this.telemetry.landingQuality = quality;
      this.#landingCompression = THREE.MathUtils.clamp(0.48 + impact / 22, 0.55, 1);
      this.telemetry.landingSerial++;
      this.#flow = Math.min(1, this.#flow + this.#airTime * tb.flowLandingBoost * (0.5 + quality * 0.5));
      this.#emitSplash(THREE.MathUtils.clamp(0.35 + impact / 18 + this.#airTime * 0.18, 0.3, 1.6));

      y = this.#contactFloor(p.x, p.z, ctx.time, tb.railHeight);
      const trackVy = THREE.MathUtils.clamp(
        (landingFloor - y) / Math.max(dt, 1e-4),
        -tb.maxSurfaceVy,
        tb.maxSurfaceVy
      );
      this.#airVy = 0;
      this.#airTime = 0;
      this.#airSpin = 0;
      this.#airFlip = 0;
      this.#grabTime = 0;
      this.grounded = true;
      if (quality < tb.recoveryQuality) this.#beginRecovery(1 - quality);
      else this.#phase = "ride";
      this.yaw += shortestAngle(travelYaw, this.yaw) * 0.75;
      // Re-seat travel + face placement from the actual landing direction so
      // the grounded model resumes on a clean line.
      this.#lineDirection = vz >= 0 ? 1 : -1;
      this.#steerSwing = 0;
      this.#resetTapState();
      this.lean *= 0.35;
      // Snap to the WRAPPED residual, never the absolute revolution count: a
      // landed 360 must resume at pitch 0, not ease 2π back through the board
      // (which read as a slow reverse flip + a 2 m contact-floor pop).
      this.pitch =
        flipError <= tb.flipSnapTolerance
          ? 0
          : shortestAngle(this.pitch, level) * 0.5;
      this.#commit(ctx, y, vx, trackVy, vz);
      this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
      return;
    }

    this.grounded = false;
    // The vy-based glide pose only applies when no flip is being ridden.
    if (Math.abs(throttle) <= 0.25 && Math.abs(this.#airFlip) < 0.3) {
      const pitchTarget = THREE.MathUtils.clamp(this.#airVy * 0.024, -0.48, 0.52);
      this.pitch += (pitchTarget - this.pitch) * Math.min(1, motionDt * 4.5);
    }
    this.lean = THREE.MathUtils.clamp(this.lean, -1.45, 1.45);
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
  }

  // --- surface-skimming auto-save --------------------------------------------

  #beginRecovery(severity: number) {
    this.#phase = "recover";
    this.#recoveryTimer = SURF_TUNING.values.recoveryDuration * THREE.MathUtils.lerp(0.7, 1.25, severity);
    this.#lineSpeed = Math.max(SURF_TUNING.values.recoverySpeed, this.#lineSpeed * 0.62);
    this.#launchCharge = 0;
    this.#launchCooldown = Math.max(this.#launchCooldown, SURF_TUNING.values.recoveryLaunchLock);
    this.grounded = true;
    this.telemetry.assistSerial++;
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
    const recoveryTrimYaw = this.#lineDirection < 0 ? 0 : Math.PI;
    const recoveryYaw = recoveryTrimYaw + steer * tb.carveYawAngle * 0.55;
    this.yaw +=
      shortestAngle(recoveryYaw, this.yaw) *
      (1 - Math.exp(-motionDt * tb.yawResponse * 0.7));
    const crestward = Math.sin(this.yaw);
    this.#carve += (crestward - this.#carve) * (1 - Math.exp(-motionDt * tb.carveResponse));
    const sample = this.#sampleLockedCrest(p.x, p.z, ctx.time);
    const speed = tb.recoverySpeed * riderRate;
    const authoredVx = -Math.sin(this.yaw) * speed;
    let vz = -Math.cos(this.yaw) * speed;
    const desiredFaceOffset = tb.faceOffset - this.#carve * tb.faceLineDropRange * 0.2;
    const faceError = desiredFaceOffset - sample.crestDistance;
    this.#lineDirection = vz >= 0 ? 1 : -1;
    const nz = p.z + vz * dt;
    const nextCrestX = oceanBeachCrestX(sample.slot, nz, ctx.time + dt);
    const crestVx = (nextCrestX - sample.crestX) / Math.max(dt, 1e-4);
    const authoredRelativeVx = authoredVx - crestVx;
    const targetRelativeVx = THREE.MathUtils.clamp(
      faceError * tb.recoveryFaceTrack + authoredRelativeVx * tb.faceYawInfluence,
      -tb.maxFaceCorrection,
      tb.maxFaceCorrection
    );
    this.#relativeFaceSpeed +=
      (targetRelativeVx - this.#relativeFaceSpeed) *
      (1 - Math.exp(-motionDt * tb.railGrip));
    let vx = crestVx + this.#relativeFaceSpeed;
    let nx = p.x + vx * dt;
    const predictedFaceDistance = nx - nextCrestX;
    const supportedFaceDistance = THREE.MathUtils.clamp(
      predictedFaceDistance,
      tb.faceCorridorMin,
      tb.faceCorridorMax
    );
    if (predictedFaceDistance !== supportedFaceDistance) {
      nx = nextCrestX + supportedFaceDistance;
      vx = (nx - p.x) / Math.max(dt, 1e-4);
    }
    this.#relativeFaceSpeed = vx - crestVx;
    const y = this.#safeY(ctx, tb.railHeight);
    const nextFloor = this.#contactFloor(nx, nz, ctx.time + dt, tb.railHeight);
    const rawVy = (nextFloor - y) / Math.max(dt, 1e-4);
    const vy = THREE.MathUtils.clamp(rawVy, -tb.maxSurfaceVy, tb.maxSurfaceVy);

    this.#orientRide(ctx, motionDt, steer * 0.35, vx, vz, vy, sample);
    this.grounded = true;
    if (this.#recoveryTimer <= 0) {
      this.#phase = "ride";
      this.#steerSwing = 0;
      this.#resetTapState();
    }
    this.#commit(ctx, y, vx, vy, vz);
    this.#syncTelemetry(ctx, frame, sample, Math.hypot(vx, vz), y, riderRate);
  }

  // --- helpers ----------------------------------------------------------------

  #shouldResetWave(x: number, z: number, waveResetMargin: number): boolean {
    // Shore wash-in / blown out the back of the set. Hand off while the current
    // face is still optically dense; waiting for the mask to reach zero leaves
    // several seconds of flat water at the end of an otherwise live ride.
    if (x > OCEAN_BEACH_SURF.maxX - waveResetMargin) return true;
    if (x < OCEAN_BEACH_SURF.minX + 18) return true;
    const shore = oceanBeachApproxShoreX(z);
    return x > shore - waveResetMargin;
  }

  /**
   * Sample the locked crest when possible so a nearest-crest flip mid-pocket
   * cannot yank faceDistance by a full spacing (and feel like a teleport).
   */
  #sampleLockedCrest(x: number, z: number, time: number) {
    const nearest = nearestOceanBeachCrest(x, z, time);
    if (this.#crestSlot == null) this.#crestSlot = nearest.slot;
    const lockedX = oceanBeachCrestX(this.#crestSlot, z, time);
    const lockedDist = x - lockedX;
    // Retarget only when clearly closer to a neighbour / washed past the face.
    if (
      Math.abs(nearest.distance) + 18 < Math.abs(lockedDist) ||
      lockedDist > SURF_TUNING.values.faceOffset + 22
    ) {
      this.#crestSlot = nearest.slot;
    }
    const slot = this.#crestSlot;
    return sampleOceanBeachWave(x, z, time, slot);
  }

  #surface(x: number, z: number, time: number, clearance: number): number {
    // Exact continuous twin of the rendered contact sheet. The old -0.2 m
    // trough clamp became another hidden collision plane once the high-res
    // shoulder exposed the full analytic draw-down.
    return waterHeight(x, z, time) + clearance;
  }

  /**
   * Five-point board support. The centre, nose, tail and both rails are
   * transformed by the same attitude committed to physics; root height is the
   * least value that leaves every probe above the continuous analytic water.
   * This closes the gap a centre-only floor left on the tightly curved lip.
   */
  #contactFloor(x: number, z: number, time: number, clearance: number): number {
    const footprint = SURFBOARD_FOOTPRINT[this.#config.shape];
    const q = V.supportQ.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
    const probes: readonly [number, number][] = [
      [0, 0],
      [0, -footprint.halfLength],
      [0, footprint.halfLength],
      [-footprint.halfWidth, 0],
      [footprint.halfWidth, 0]
    ];
    let floor = -Infinity;
    for (const [localX, localZ] of probes) {
      const offset = V.supportProbe.set(localX, 0, localZ).applyQuaternion(q);
      floor = Math.max(
        floor,
        this.#surface(x + offset.x, z + offset.z, time, clearance) - offset.y
      );
    }
    return floor;
  }

  #minimumHullClearance(x: number, y: number, z: number, time: number, clearance: number): number {
    const footprint = SURFBOARD_FOOTPRINT[this.#config.shape];
    const q = V.supportQ.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
    const probes: readonly [number, number][] = [
      [0, 0],
      [0, -footprint.halfLength],
      [0, footprint.halfLength],
      [-footprint.halfWidth, 0],
      [footprint.halfWidth, 0]
    ];
    let minimum = Infinity;
    for (const [localX, localZ] of probes) {
      const offset = V.supportProbe.set(localX, 0, localZ).applyQuaternion(q);
      const probeFloor = this.#surface(x + offset.x, z + offset.z, time, clearance);
      minimum = Math.min(minimum, y + offset.y - probeFloor);
    }
    return minimum;
  }

  /** Immediate correction for any stale/low body pose before the next physics step. */
  #safeY(ctx: PlayerCtx, clearance: number): number {
    if (this.#phase === "air") {
      const floor = this.#surface(ctx.position.x, ctx.position.z, ctx.time, clearance);
      return Math.max(ctx.position.y, floor);
    }
    // Grounded surf is a constrained contact, not a hover spring. Pin the root
    // to the footprint solve every fixed step so descending the face cannot
    // leave the board visibly floating above it.
    return this.#contactFloor(ctx.position.x, ctx.position.z, ctx.time, clearance);
  }

  #commit(ctx: PlayerCtx, y: number, vx: number, vy: number, vz: number) {
    // Use the full five-point footprint floor in the air too. Centre-only let a
    // rail/nose probe of the tilted board dip a millimetre or two under the wave
    // on the takeoff and touchdown frames; the max() only binds when a probe is
    // actually at/below the surface, so it never interferes with the arc.
    const floor = this.#contactFloor(
      ctx.position.x,
      ctx.position.z,
      ctx.time,
      SURF_TUNING.values.railHeight
    );
    const safeY = this.#phase === "air" ? Math.max(y, floor) : floor;
    const q = ctx.quaternion.setFromEuler(V.euler.set(this.pitch, this.yaw, this.lean, "YXZ"));
    const w = ctx.physics.world;
    w.setBodyTransform(ctx.body, [ctx.position.x, safeY, ctx.position.z], [q.x, q.y, q.z, q.w]);
    w.setBodyVelocity(ctx.body, [vx, vy, vz], [0, 0, 0]);
    ctx.position.y = safeY;
    ctx.heading = this.yaw + Math.PI;
  }

  #orientRide(
    ctx: PlayerCtx,
    motionDt: number,
    steer: number,
    vx: number,
    vz: number,
    vy: number,
    _sample: OceanBeachWaveSample
  ) {
    const tb = SURF_TUNING.values;
    const shape = surfboardHandling(this.#config);
    const speed = Math.hypot(vx, vz);
    // Heading is fully owned by the across-face carve model (#linePos) now, so
    // no travel-align nudge here — it would fight the bounded carve and its
    // neutral re-center.
    void speed;
    // Align the deck to the analytic surface normal, then layer a smaller
    // rider-authored rail set on top. The old version rolled only from input,
    // which left the board visually flat while crossing a near-vertical face.
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const eps = 0.55;
    const epsZ = 0.8;
    const slopeX =
      (waterHeight(ctx.position.x + eps, ctx.position.z, ctx.time) -
        waterHeight(ctx.position.x - eps, ctx.position.z, ctx.time)) /
      (2 * eps);
    const slopeZ =
      (waterHeight(ctx.position.x, ctx.position.z + epsZ, ctx.time) -
        waterHeight(ctx.position.x, ctx.position.z - epsZ, ctx.time)) /
      (2 * epsZ);
    const slopeRight = slopeX * rightX + slopeZ * rightZ;
    const slopeForward = slopeX * forwardX + slopeZ * forwardZ;
    const surfaceBank = Math.atan(slopeRight) * tb.surfaceBankFollow;
    const carveBank = -steer * tb.carveLean * shape.carve * 0.38;
    // Cap well short of horizontal: a planted surfer cants into the wall, never
    // rolls onto their side (which read as a prone rider bleeding into the face).
    const targetLean = THREE.MathUtils.clamp(surfaceBank + carveBank, -0.9, 0.9);
    this.lean += (targetLean - this.lean) * Math.min(1, motionDt * tb.leanResponse * shape.stability);

    const slopePitch = Math.atan(slopeForward) * tb.pitchFollow;
    const pitchTarget = THREE.MathUtils.clamp(slopePitch + vy * 0.004, -0.58, 0.58);
    this.pitch += (pitchTarget - this.pitch) * Math.min(1, motionDt * tb.pitchResponse);
  }

  #chargeFlow(dt: number, speed: number, face: number, carve: number) {
    if (this.#flowTimer > 0) return;
    const tb = SURF_TUNING.values;
    const speedK = THREE.MathUtils.clamp((speed - tb.stallSpeed) / Math.max(1, tb.maxTrim - tb.stallSpeed), 0, 1);
    this.#flow = Math.min(1, this.#flow + dt * tb.flowChargeRate * (0.25 + speedK * 0.55 + face * 0.35 + carve * 0.2));
  }

  #updateTubeState(dt: number) {
    const tm = this.telemetry;
    const tb = SURF_TUNING.values;
    const supported =
      this.#phase === "ride" &&
      tm.railContact &&
      tm.tubeDepth >= tb.tubeEnterDepth &&
      tm.speed >= tb.tubeMinSpeed &&
      tm.tubeClearance > 1.7;

    if (supported) {
      this.#tubeExit = 0;
      this.#tubeDwell += dt * (tm.stalling ? tb.tubeStallDwellBoost : 1);
      if (this.#tubeState === "outside" || this.#tubeState === "exiting") {
        this.#tubeState = "entering";
      }
      if (this.#tubeDwell >= tb.tubeEnterTime && this.#tubeState !== "inside") {
        this.#tubeState = "inside";
        tm.tubeSerial++;
      }
    } else {
      this.#tubeDwell = Math.max(0, this.#tubeDwell - dt * 0.65);
      if (this.#tubeState === "inside" || this.#tubeState === "entering") {
        // Spit: a real barrel rewards the exit with a speed burst + spray.
        if (this.#tubeState === "inside" && this.#tubeDwell >= tb.spitMinDwell) {
          this.#lineSpeed = Math.min(tb.maxTrim * 1.15, this.#lineSpeed + tb.spitBoost);
          tm.spitSerial++;
          this.#emitSplash(1.5);
        }
        this.#tubeState = "exiting";
        this.#tubeExit = 0;
      } else if (this.#tubeState === "exiting") {
        this.#tubeExit += dt;
        if (this.#tubeExit >= tb.tubeExitTime) {
          this.#tubeState = "outside";
          this.#tubeDwell = 0;
        }
      }
    }

    tm.tubeState = this.#tubeState;
    tm.tubeDwell = this.#tubeDwell;
  }

  #emitSplash(energy: number) {
    this.telemetry.splashEnergy = energy;
    this.telemetry.splashSerial++;
  }

  /**
   * Project onto a clean incoming pocket. Used by every entry path and again
   * when the current crest reaches shore, keeping the activity endless without
   * a paddle, beaching, fall, or failure state.
   */
  #placeOnWave(ctx: PlayerCtx, keepZ: boolean, nextWave = false) {
    const b = OCEAN_BEACH_SURF;
    const p = ctx.position;
    const tb = SURF_TUNING.values;
    const z = keepZ
      ? THREE.MathUtils.clamp(p.z, b.minZ + tb.boundaryMargin + 4, b.maxZ - tb.boundaryMargin - 4)
      : b.entryZ;
    // Prefer the player's local crest. On wash-in, step one slot offshore so the
    // reset is a nearby next-wave hop rather than a jump to entryX's pocket.
    let crest = nearestOceanBeachCrest(keepZ ? p.x : b.entryX, z, ctx.time);
    // A fresh entry starts on a fully developed offshore set, never the nearest
    // crest after it has already entered the shoreline attenuation band.
    const cleanCrestLimit = oceanBeachApproxShoreX(z) - tb.waveResetMargin - tb.faceOffset;
    if (!nextWave && crest.crestX > cleanCrestLimit) {
      const slot = crest.slot - 1;
      const crestX = oceanBeachCrestX(slot, z, ctx.time);
      crest = { slot, crestX, distance: p.x - crestX };
    }
    if (nextWave && keepZ && p.x > crest.crestX + tb.faceOffset * 0.35) {
      const slot = crest.slot - 1;
      crest = {
        slot,
        crestX: oceanBeachCrestX(slot, z, ctx.time),
        distance: p.x - oceanBeachCrestX(slot, z, ctx.time)
      };
    }
    this.#crestSlot = crest.slot;
    const x = crest.crestX + tb.faceOffset;
    if (!nextWave) {
      const northRun = z - (b.minZ + tb.boundaryMargin);
      const southRun = b.maxZ - tb.boundaryMargin - z;
      this.#lineDirection = southRun >= northRun ? 1 : -1;
    }
    this.#lineSpeed = nextWave
      ? Math.max(tb.trimSpeed, this.#lineSpeed * 0.82)
      : tb.trimSpeed;
    this.#steerSwing = 0;
    this.#climbEffort = 0;
    this.#prevSteer = 0;
    this.#steerTapSign = 0;
    this.#steerTapAge = 999;
    this.#carve = 0;
    this.#entryAssist = tb.entryAssistDuration;
    this.#phase = "ride";
    this.#airVy = 0;
    this.#airTime = 0;
    this.#airSpin = 0;
    this.#airFlip = 0;
    this.#grabTime = 0;
    this.#landingCompression = 0;
    this.#launchCharge = 0;
    this.#launchCooldown = Math.max(this.#launchCooldown, nextWave ? 0.45 : 0);
    this.#popRequest = 0;
    this.#relativeFaceSpeed = 0;
    this.#tubeState = "outside";
    this.#tubeDwell = 0;
    this.#tubeExit = 0;
    const vx = b.speed;
    const vz = this.#lineDirection * this.#lineSpeed;
    this.yaw = Math.atan2(-vx, -vz);
    this.lean = 0;
    this.pitch = 0;
    this.grounded = true;
    const y = this.#contactFloor(x, z, ctx.time, tb.railHeight);
    p.set(x, y, z);
    const sample = sampleOceanBeachWave(x, z, ctx.time, crest.slot);
    const tm = this.telemetry;
    // Camera and HUD read telemetry before the first fixed step on entry. Keep
    // their very first frame on the same side/phase/speed as the body instead of
    // briefly composing from the constructor defaults.
    tm.speed = Math.hypot(vx, vz);
    tm.face = sample.face;
    tm.lip = sample.lip;
    tm.lean = 0;
    tm.grounded = true;
    tm.airborne = false;
    tm.airTime = 0;
    tm.phase = "ride";
    tm.surfaceY = y;
    tm.clearance = 0;
    tm.lineDirection = this.#lineDirection;
    tm.pump = 0;
    tm.stalling = false;
    tm.autoLaunchCharge = 0;
    tm.inBreak = sample.mask > 0.025;
    tm.crestDistance = sample.crestDistance;
    tm.slopeX = sample.slopeX;
    tm.slopeZ = sample.slopeZ;
    tm.supportError = 0;
    tm.hullClearance = 0;
    tm.railContact = true;
    tm.relativeFaceSpeed = 0;
    tm.carveInput = 0;
    tm.faceLine = 0;
    tm.airSpin = 0;
    tm.airFlip = 0;
    tm.grabTime = 0;
    tm.barrelAhead = 0;
    tm.landingCompression = 0;
    tm.tubeState = "outside";
    tm.tubeDepth = sample.tubeDepth;
    tm.tubeCoverage = sample.barrel;
    tm.tubeRoofY = sample.tubeRoofY;
    tm.tubeClearance = sample.tubeRoofY - y;
    tm.tubeDwell = 0;
    if (nextWave) {
      this.telemetry.waveSerial++;
      this.#emitSplash(1.05);
    }
    if (ctx.body) {
      const q = ctx.quaternion.setFromEuler(V.euler.set(0, this.yaw, 0, "YXZ"));
      ctx.physics.world.setBodyTransform(ctx.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      ctx.physics.world.setBodyVelocity(ctx.body, [vx, 0, vz], [0, 0, 0]);
    }
    ctx.snapRenderPose?.();
  }

  #syncTelemetry(
    ctx: PlayerCtx,
    _frame: ModeFrame,
    sample: ReturnType<typeof sampleOceanBeachWave>,
    speed: number,
    _committedY: number,
    riderRate: number
  ) {
    const tm = this.telemetry;
    const clearance = SURF_TUNING.values.railHeight;
    const surfaceY = this.#phase === "air"
      ? this.#surface(ctx.position.x, ctx.position.z, ctx.time, clearance)
      : this.#contactFloor(ctx.position.x, ctx.position.z, ctx.time, clearance);
    const rootY = ctx.position.y;
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
    const signedClearance = rootY - surfaceY;
    tm.clearance = Math.abs(signedClearance) < 1e-6 ? 0 : signedClearance;
    tm.lineDirection = this.#lineDirection;
    tm.pump = this.#climbEffort;
    tm.faceLine = -this.#carve;
    tm.stalling = this.#phase === "ride" && this.#lineSpeed <= SURF_TUNING.values.stallSpeed * 1.2;
    tm.autoLaunchCharge = this.#launchCharge;
    tm.flow = this.#flow;
    tm.flowReady = this.#flow >= SURF_TUNING.values.flowReadyThreshold;
    tm.flowActive = this.#flowTimer > 0;
    tm.flowTimeRemaining = this.#flowTimer;
    tm.flowRequestBuffered = this.#flowRequest > 0;
    tm.riderMotionRate = riderRate;
    tm.shape = this.#config.shape;
    tm.crestDistance = sample.crestDistance;
    tm.slopeX = sample.slopeX;
    tm.slopeZ = sample.slopeZ;
    tm.hullClearance = this.#minimumHullClearance(
      ctx.position.x,
      rootY,
      ctx.position.z,
      ctx.time,
      clearance
    );
    tm.supportError = tm.hullClearance;
    tm.railContact =
      this.#phase !== "air" &&
      tm.hullClearance >= -0.001 &&
      tm.hullClearance <= 0.16 &&
      sample.crestDistance >= SURF_TUNING.values.faceCorridorMin - 0.05 &&
      sample.crestDistance <= SURF_TUNING.values.faceCorridorMax + 0.05;
    tm.relativeFaceSpeed = this.#relativeFaceSpeed;
    tm.carveInput = this.#carve;
    tm.airSpin = this.#airSpin;
    tm.airFlip = this.#airFlip;
    tm.grabTime = this.#grabTime;
    tm.landingCompression = this.#landingCompression;
    // Barrel telegraph: envelope strength ~55 m ahead down the line.
    tm.barrelAhead =
      this.#phase === "ride"
        ? sampleOceanBeachWave(
            ctx.position.x,
            ctx.position.z + this.#lineDirection * 55,
            ctx.time,
            this.#crestSlot ?? undefined
          ).barrel
        : 0;
    tm.tubeDepth = sample.tubeDepth;
    tm.tubeCoverage = sample.barrel;
    tm.tubeRoofY = sample.tubeRoofY;
    tm.tubeClearance = sample.tubeRoofY - rootY;
  }
}
