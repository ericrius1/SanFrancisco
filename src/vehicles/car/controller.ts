import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { enterOnLand } from "../shared";
import {
  CarJumpState,
  landingImpactStrength,
  smoothstep01,
  stepAirAttitude,
  type AirAttitudeParams,
  type JumpSample,
  type JumpStateParams,
  type LandingImpactParams,
  type MutableVec3
} from "./jumpPhysics";
import { CAR_LANDING_TUNING, CAR_TUNING } from "./tuning";

const V = {
  tmp2: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  surface: new THREE.Vector3(),
  airTarget: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion(),
  upTuple: [0, 1, 0] as MutableVec3,
  targetTuple: [0, 1, 0] as MutableVec3,
  airAngular: [0, 0, 0] as MutableVec3
};

export type CarLandingFeedback = {
  /** Monotonic event id; presentation systems consume each landing once. */
  serial: number;
  /** Largest chassis clearance above its normal road ride target, in metres. */
  height: number;
  /** Vertical distance from the jump apex to touchdown, in metres. */
  fallDistance: number;
  /** Height/fall-distance response mapped into the authored 0..1 range. */
  strength: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
};

export class CarController implements ModeController {
  readonly spawnLift = 0.8;
  steerVis = 0; // smoothed steer input, read by the driver-arm/wheel animation

  #jump = new CarJumpState();
  #groundNormal = new THREE.Vector3(0, 1, 0);
  #groundBlend = 1;
  #supportClearance = 0;
  #positionYForDebug = 0;
  #jumpPeakY = 0;
  #jumpMaxClearance = 0;
  #landingFeedback: CarLandingFeedback = {
    serial: 0,
    height: 0,
    fallDistance: 0,
    strength: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0
  };
  #jumpSample: JumpSample = {
    supportClearance: 0,
    verticalSpeed: 0,
    yaw: 0
  };
  #jumpParams: JumpStateParams = {
    takeoffClearance: 0,
    takeoffMinVerticalSpeed: 0,
    minimumAirTime: 0,
    landingClearance: 0,
    landingMaxVerticalSpeed: 0,
    landingMaxFallSpeed: 0,
    landingConfirmSteps: 0
  };
  #airParams: AirAttitudeParams = {
    kp: 0,
    kd: 0,
    maxAcceleration: 0,
    yawDamping: 0,
    yawAcceleration: 0
  };
  #landingImpactParams: LandingImpactParams = {
    minHeight: 0,
    maxHeight: 0,
    minFallDistance: 0,
    maxFallDistance: 0,
    heightWeight: 0,
    responseCurve: 1
  };

  /** Read-only runtime state for the existing window.__sf diagnostics surface. */
  get jumpDebug() {
    return {
      airborne: this.#jump.airborne,
      airTime: this.#jump.airTime,
      supportClearance: this.#supportClearance,
      landingSteps: this.#jump.landingSteps,
      readyForTakeoff: this.#jump.readyForTakeoff,
      jumpHeight: this.#jumpMaxClearance,
      jumpFallDistance: Math.max(0, this.#jumpPeakY - this.#positionYForDebug),
      landingSerial: this.#landingFeedback.serial,
      landingStrength: this.#landingFeedback.strength
    };
  }

  /** Stable, read-only event buffer for camera/audio/VFX presentation. */
  get landingFeedback(): Readonly<CarLandingFeedback> {
    return this.#landingFeedback;
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    this.steerVis = 0;
    this.#jump.reset(facing);
    this.#groundBlend = 1;
    this.#supportClearance = 0;
    this.#jumpPeakY = p.y;
    this.#jumpMaxClearance = 0;
    this.#landingFeedback.height = 0;
    this.#landingFeedback.fallDistance = 0;
    this.#landingFeedback.strength = 0;
    this.#sampleGroundNormal(ctx, p.x, p.z, this.#groundNormal);
    // box stops at the rocker panels (y half 0.45, not 0.6): the ride spring
    // holds the centre at ground+0.85, so a taller box left only 0.25 m of
    // floor clearance — any carpet/heightmap mismatch buried it in the road
    ctx.body = ctx.physics.world.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 0.8, p.z],
      halfExtents: ctx.driveSpec.halfExtents,
      density: 133, // keeps the old box's mass despite the thinner profile
      friction: 0.35,
      restitution: 0.04
    });
    return p.y + 0.8;
  }

  enter(ctx: PlayerCtx) {
    enterOnLand(ctx); // need land under us
  }

  /**
   * Ground the car rides on — map.rideGround: the RENDERED road surface
   * (groundTop, same source the physics carpet seats on) with the bridge deck
   * counted only when the car is already up at deck level (driving *under* an
   * approach must not snap the spring target to the roadway overhead). The car
   * previously sampled the raw heightfield here, which sits up to ~0.9 m BELOW
   * the draped road on graded streets — the down-spring pressed the nose into
   * the climbing carpet and the solver ate all forward velocity (the Castro
   * hill stuck-car bug).
   */
  #ground(ctx: PlayerCtx, x: number, z: number): number {
    return ctx.map.rideGround(x, z, ctx.position.y);
  }

  #sampleGroundNormal(ctx: PlayerCtx, x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 2.5;
    return out.set(
      this.#ground(ctx, x - e, z) - this.#ground(ctx, x + e, z),
      2 * e,
      this.#ground(ctx, x, z - e) - this.#ground(ctx, x, z + e)
    ).normalize();
  }

  #beginJump(worldY: number) {
    this.#jumpPeakY = worldY;
    this.#jumpMaxClearance = Math.max(0, this.#supportClearance);
  }

  #trackJump(worldY: number) {
    this.#jumpPeakY = Math.max(this.#jumpPeakY, worldY);
    this.#jumpMaxClearance = Math.max(this.#jumpMaxClearance, this.#supportClearance);
  }

  #commitLanding(ctx: PlayerCtx, ground: number, yaw: number) {
    const tuning = CAR_LANDING_TUNING.values;
    const p = this.#landingImpactParams;
    p.minHeight = tuning.minHeight;
    p.maxHeight = Math.max(tuning.minHeight + 1e-4, tuning.maxHeight);
    p.minFallDistance = tuning.minFallDistance;
    p.maxFallDistance = Math.max(tuning.minFallDistance + 1e-4, tuning.maxFallDistance);
    p.heightWeight = tuning.heightWeight;
    p.responseCurve = tuning.responseCurve;

    const event = this.#landingFeedback;
    event.serial += 1;
    event.height = Math.max(0, this.#jumpMaxClearance);
    event.fallDistance = Math.max(0, this.#jumpPeakY - ctx.position.y);
    event.strength = landingImpactStrength(event.height, event.fallDistance, p);
    event.x = ctx.position.x;
    event.y = ground + 0.12;
    event.z = ctx.position.z;
    event.yaw = yaw;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const v = frame.v;
    this.#positionYForDebug = ctx.position.y;
    const q = ctx.quaternion;
    const fwd = V.fwd.set(0, 0, -1).applyQuaternion(q);
    fwd.y = 0;
    const fwdLen = fwd.length();
    let yaw: number;
    if (fwdLen > 1e-4) {
      fwd.multiplyScalar(1 / fwdLen);
      yaw = Math.atan2(-fwd.x, -fwd.z);
    } else {
      // Near vertical, the flattened nose has no stable heading. Keep the yaw
      // latched at takeoff instead of letting numerical noise flip it by π.
      yaw = this.#jump.airborne ? this.#jump.launchYaw : ctx.heading - Math.PI;
      fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    }
    const right = V.right.set(1, 0, 0).applyQuaternion(q);
    right.y = 0;
    if (right.lengthSq() > 1e-8) right.normalize();
    else right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const up = V.tmp2.set(0, 1, 0).applyQuaternion(q).normalize();

    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyD", "KeyA");
    const handbrake = input.down("Space");
    const boost = input.down("ShiftLeft");
    this.steerVis += (steer - this.steerVis) * Math.min(1, dt * 9);

    const td = CAR_TUNING.values;
    const spec = ctx.driveSpec;
    const ground = this.#ground(ctx, ctx.position.x, ctx.position.z);
    const fwdSpeed = ctx.velocity.dot(fwd);
    const maxSpeed = (boost ? td.boostMaxSpeed : td.maxSpeed) * spec.maxFactor;

    // Compute the ground-control request before deciding the phase. The same
    // nose probe defines the suspension target used for takeoff clearance, so a
    // car whose front axle is still climbing a ramp cannot be declared airborne.
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

    const latSpeed = ctx.velocity.dot(right);
    const keepLat = handbrake ? td.driftLat : td.gripLat;
    const newVx = fwd.x * targetSpeed + right.x * latSpeed * keepLat;
    const newVz = fwd.z * targetSpeed + right.z * latSpeed * keepLat;
    const travel = Math.sign(fwdSpeed) || (throttle > 0 ? 1 : throttle < 0 ? -1 : 1);
    const nose = spec.halfExtents[2] + 0.6;
    const ahead = this.#ground(
      ctx,
      ctx.position.x + fwd.x * nose * travel + newVx * dt,
      ctx.position.z + fwd.z * nose * travel + newVz * dt
    );
    const rise = ahead - ground;
    const rideY = Math.max(ground, ahead) + spec.rideHeight;
    this.#supportClearance = ctx.position.y - rideY;

    // Filter the road plane while supported and while approaching a landing. A
    // ramp-edge sample may change instantly; the chassis attitude never should.
    this.#sampleGroundNormal(ctx, ctx.position.x, ctx.position.z, V.surface);
    const normalFollow = 1 - Math.exp(-td.groundNormalResponse * dt);
    this.#groundNormal.lerp(V.surface, normalFollow).normalize();

    // Preserve the old wide near-ground band only for anti-snag/self-right
    // behavior. It no longer means the tyres are supported.
    const nearGround = ctx.position.y - ground < 3.0;
    if (up.y < 0.2 && ctx.speed < 2.5) {
      const face = ctx.heading - Math.PI;
      const t2 = w.getBodyTransform(ctx.body);
      w.setBodyTransform(ctx.body, [t2.position[0], t2.position[1] + 1.6, t2.position[2]], [
        0,
        Math.sin(face / 2),
        0,
        Math.cos(face / 2)
      ]);
      w.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
      this.#jump.reset(face);
      this.#groundBlend = 1;
      return;
    }

    const jp = this.#jumpParams;
    jp.takeoffClearance = td.takeoffClearance;
    jp.takeoffMinVerticalSpeed = td.takeoffMinVerticalSpeed;
    jp.minimumAirTime = td.minimumAirTime;
    jp.landingClearance = td.landingClearance;
    jp.landingMaxVerticalSpeed = td.landingMaxVerticalSpeed;
    jp.landingMaxFallSpeed = td.landingMaxFallSpeed;
    jp.landingConfirmSteps = td.landingConfirmSteps;
    const js = this.#jumpSample;
    js.supportClearance = this.#supportClearance;
    js.verticalSpeed = v.linear[1];
    js.yaw = yaw;
    const transition = this.#jump.update(js, dt, jp);
    if (transition !== "none") this.#groundBlend = 0;
    if (transition === "takeoff") this.#beginJump(ctx.position.y);
    if (this.#jump.airborne) this.#trackJump(ctx.position.y);
    else if (transition === "landing") this.#commitLanding(ctx, ground, yaw);

    const grounded = !this.#jump.airborne && nearGround && up.y > 0.35;
    if (grounded) {
      // Smoothly hand authority back from the contact solver/air assist. This
      // keeps touchdown momentum, then restores road grip and suspension over
      // roughly a quarter-second instead of snapping all six velocity channels.
      this.#groundBlend +=
        (1 - this.#groundBlend) * (1 - Math.exp(-td.landingBlendRate * dt));
      const blend = this.#groundBlend;

      let requestedVy = v.linear[1];
      if (ctx.position.y <= rideY + td.takeoffClearance) {
        const horiz = Math.max(Math.abs(fwdSpeed), 2);
        const slopeRate = THREE.MathUtils.clamp((rise / nose) * horiz, -14, 40);
        requestedVy = (rideY - ctx.position.y) * td.rideSpring + slopeRate;
        // Pinned against a terrain lip while still asking for real speed: add a
        // small hop. This remains ground-only and cannot fire during a jump.
        if (
          throttle > 0 &&
          rise > 0.3 &&
          Math.abs(fwdSpeed) < 3 &&
          targetSpeed >= td.grindSpeed - 0.01
        ) {
          requestedVy = Math.max(requestedVy, rise * 5 + 4);
        }
      }

      const dir = fwdSpeed >= -0.4 ? 1 : -1;
      const grip = Math.min(Math.abs(fwdSpeed) / 6, 1);
      const steerRate =
        steer *
        dir *
        grip *
        (handbrake ? td.driftSteerRate : td.steerRate) *
        spec.steerFactor;

      V.qa.setFromAxisAngle(V.up, yaw);
      V.qb.setFromUnitVectors(V.up, this.#groundNormal).multiply(V.qa);
      V.qa.copy(q).invert().premultiply(V.qb);
      const flip = V.qa.w < 0 ? -1 : 1;
      const wx = THREE.MathUtils.clamp(V.qa.x * flip * 2 * 8, -6, 6);
      const wz = THREE.MathUtils.clamp(V.qa.z * flip * 2 * 8, -6, 6);
      w.setBodyVelocity(
        ctx.body,
        [
          THREE.MathUtils.lerp(v.linear[0], newVx, blend),
          THREE.MathUtils.lerp(v.linear[1], requestedVy, blend),
          THREE.MathUtils.lerp(v.linear[2], newVz, blend)
        ],
        [
          THREE.MathUtils.lerp(v.angular[0], wx, blend),
          THREE.MathUtils.lerp(v.angular[1], steerRate, blend),
          THREE.MathUtils.lerp(v.angular[2], wz, blend)
        ]
      );
    } else {
      // The phase is latched even if the car rolls past the upright threshold.
      // Linear momentum remains purely ballistic; only attitude gets an arcade
      // assist, after a brief hold that lets the ramp's nose-up launch read.
      if (!this.#jump.airborne) {
        this.#jump.forceAir(yaw);
        this.#beginJump(ctx.position.y);
      }
      this.#trackJump(ctx.position.y);
      const fade = smoothstep01(
        (this.#jump.airTime - td.airHold) / Math.max(td.airBlendTime, 1e-4)
      );
      const landingHeight = smoothstep01(
        (td.landingAssistHeight - this.#supportClearance) /
          Math.max(td.landingAssistHeight, 1e-4)
      );
      const landingDescent = smoothstep01(
        -v.linear[1] / Math.max(td.landingAssistDescentSpeed, 1e-4)
      );
      const landing = landingHeight * landingDescent;
      V.airTarget.copy(V.up).lerp(this.#groundNormal, landing).normalize();
      V.upTuple[0] = up.x;
      V.upTuple[1] = up.y;
      V.upTuple[2] = up.z;
      V.targetTuple[0] = V.airTarget.x;
      V.targetTuple[1] = V.airTarget.y;
      V.targetTuple[2] = V.airTarget.z;
      const ap = this.#airParams;
      ap.kp = td.airKp;
      ap.kd = td.airKd;
      ap.maxAcceleration = td.airMaxAcceleration;
      ap.yawDamping = td.airYawDamping;
      ap.yawAcceleration = td.airYawAcceleration;
      stepAirAttitude(
        V.upTuple,
        V.targetTuple,
        v.angular,
        steer,
        Math.max(fade, landing),
        dt,
        ap,
        V.airAngular
      );
      w.setBodyVelocity(
        ctx.body,
        [v.linear[0], v.linear[1], v.linear[2]],
        V.airAngular
      );
    }
    ctx.heading = yaw + Math.PI;
  }
}
