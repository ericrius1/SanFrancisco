import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { BOARD_TUNING } from "./tuning";

const JUMP_BUFFER_TIME = 0.26;
const COYOTE_TIME = 0.24;
const JUMP_LOCKOUT_TIME = 0.18;
const RELANDED_MAX_VY = 1.2;

const V = {
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  localX: new THREE.Vector3(1, 0, 0),
  localZ: new THREE.Vector3(0, 0, 1),
  quat: new THREE.Quaternion(),
  euler: new THREE.Euler()
};

/**
 * Hoverboard: surfs streets, hills AND the bay — the hover spring targets
 * whichever surface is higher, terrain or water, so you can carve down
 * Lombard and keep going straight out across the water. A/D carve the
 * heading (leaning the deck into the turn), Space ollies, and while airborne
 * gravity is integrated by hand (the body spawns with gravityScale 0 so the
 * hover spring owns the vertical everywhere else).
 *
 * Right-stick Y pitches the deck (stick back = nose up): manuals on the
 * ground, and a hard hold in the air spins full flips around the board's
 * lateral axis. Stick X still orbits the chase camera.
 */
export class BoardController implements ModeController {
  readonly spawnLift = 1.0;

  // carve yaw (raw body yaw) + visual lean, read by the rider-pose animation
  yaw = 0;
  lean = 0;
  pitch = 0; // deck pitch around local X: +ve = nose up (unbounded in air for flips)
  grounded = true;
  // Render-facing motion is kept separate from the looser jumpable `grounded`
  // flag above. These values are scalar, fixed-step state, so consuming them
  // from the render loop allocates nothing and cannot affect body physics.
  horizontalSpeed = 0;
  boosting = false;
  // Render-only telemetry for the independent rear/hover exhaust channels.
  // These are fixed-step scalars, so the mesh can feel the real controller
  // without reading physics or allocating per frame.
  driveThrust = 0;
  hoverThrust = 0.4;
  landingAssist = 0;
  takeoffPulse = 0;
  verticalVelocity = 0;
  #rest = 0; // seconds spent resting on a collider the heightmap can't see
  #jumpBuf = 0; // jump buffer: seconds a Space press stays pending
  #coyote = 0; // seconds after losing footing an ollie still fires
  #jumping = 0; // post-ollie lockout so the hover spring doesn't eat the launch
  #wasGrounded = true;

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 1.0, p.z],
      halfExtents: [0.55, 0.25, 1.15],
      density: 60,
      friction: 0.15,
      restitution: 0.1
    });
    w.setBodyGravityScale(ctx.body, 0); // vertical is hover-spring-owned
    this.yaw = facing;
    this.lean = 0;
    this.pitch = 0;
    this.grounded = true;
    this.horizontalSpeed = 0;
    this.boosting = false;
    this.driveThrust = 0;
    this.hoverThrust = 0.4;
    this.landingAssist = 0;
    this.takeoffPulse = 0;
    this.verticalVelocity = 0;
    this.#rest = 0;
    this.#jumpBuf = 0;
    this.#coyote = 0;
    this.#jumping = 0;
    this.#wasGrounded = true;
    return p.y + 1.0;
  }

  enter(ctx: PlayerCtx) {
    // the board rides land or water — settle just above whichever surface
    const surf = Math.max(
      ctx.map.rideGround(ctx.position.x, ctx.position.z, ctx.position.y),
      waterHeight(ctx.position.x, ctx.position.z, ctx.time)
    );
    ctx.position.y = Math.max(ctx.position.y, surf + BOARD_TUNING.values.hover + 0.4);
  }

  /** Buffer an ollie (also latched at render-frame rate from the main loop,
   * so high-refresh displays can't drop the press between physics steps). */
  requestJump() {
    this.#jumpBuf = JUMP_BUFFER_TIME;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const v = frame.v;
    const tb = BOARD_TUNING.values;

    const throttle = input.axis("KeyS", "KeyW");
    const steer = input.axis("KeyD", "KeyA");
    // Stick back (+) = nose up. Keyboard has no dedicated pitch axis yet.
    const pitchStick = input.padAxis("BoardNoseDown", "BoardNoseUp");
    const boost = input.down("ShiftLeft");
    this.boosting = boost;
    // `Player.speed` includes vertical launch/fall velocity; retain the actual
    // horizontal body speed so a stationary ollie does not read as full throttle.
    this.horizontalSpeed = Math.hypot(v.linear[0], v.linear[2]);
    this.takeoffPulse = Math.max(0, this.takeoffPulse - dt * 3.2);

    const surface = Math.max(
      ctx.map.rideGround(ctx.position.x, ctx.position.z, ctx.position.y),
      waterHeight(ctx.position.x, ctx.position.z, ctx.time)
    );
    const bob = Math.sin(ctx.time * 3.1) * 0.08;
    const rideY = surface + tb.hover + bob;
    const heightAbove = ctx.position.y - rideY;
    // footing is height-only — slope feedforward while boosting can push vy well
    // past 6 m/s even with the deck still hugging the surface; tying jump
    // eligibility to vy made ollies flake on hills and under boost
    const onFooting = heightAbove < 1.5;
    const onCollider = this.#rest > 0.12;
    const canJump = onFooting || onCollider;
    this.#jumping = Math.max(0, this.#jumping - dt);
    // Curb hops and collider landings can touch down before the launch lockout
    // expires; once vertical motion is slow on valid footing, re-arm jumping.
    if (this.#jumping > 0 && canJump && v.linear[1] <= RELANDED_MAX_VY) this.#jumping = 0;
    const grounded = heightAbove < 0.9 && this.#jumping <= 0;
    this.grounded = canJump && this.#jumping <= 0;
    // resting on a collider the heightmap doesn't know (roof, prop): contact
    // pins vy at ~0 while the ride spring says airborne — count that as a
    // jumpable footing so the board doesn't feel dead up there
    if (!onFooting && Math.abs(v.linear[1]) < 0.3) this.#rest += dt;
    else this.#rest = 0;
    // jump feel: buffer presses early; coyote keeps footing warm after the deck
    // leaves the surface (curb hops, landing spring overshoot)
    if (!input.suspended && input.pressed("Space")) this.requestJump();
    else this.#jumpBuf = Math.max(0, this.#jumpBuf - dt);
    if (canJump) this.#coyote = COYOTE_TIME;
    else this.#coyote = Math.max(0, this.#coyote - dt);

    const fwd = V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = V.right.set(-fwd.z, 0, fwd.x);
    const fwdSpeed = ctx.velocity.dot(fwd);
    const latSpeed = ctx.velocity.dot(right);

    // carve: steering authority even at a standstill, full lean at speed
    const steerDir = fwdSpeed >= -0.4 ? 1 : -1;
    const steerRate = steer * steerDir * tb.steerRate * (0.35 + Math.min(Math.abs(fwdSpeed) / 8, 1) * 0.65);
    this.yaw += steerRate * dt;

    const maxSpeed = boost ? tb.boostMaxSpeed : tb.maxSpeed;
    let targetSpeed = fwdSpeed;
    // Nose-up manuals bleed a little speed; nose-down digs in for a push.
    const pitchTrim = 1 - THREE.MathUtils.clamp(pitchStick, -1, 1) * 0.14;
    // grind floor, same trick as drive: a blocked board builds its target from
    // fwdSpeed ≈ 0 and only ever asks for accel·dt, which solver contacts eat —
    // so it wedged on curbs/props forever. Floor the request so it shoves free.
    if (throttle > 0)
      targetSpeed = Math.min(
        maxSpeed,
        Math.max(fwdSpeed + (boost ? tb.boostAccel : tb.accel) * dt * pitchTrim, tb.grindSpeed)
      );
    else if (throttle < 0) {
      targetSpeed = Math.max(-tb.reverseMax, fwdSpeed - tb.reverseAccel * dt);
      if (fwdSpeed < 0.5) targetSpeed = Math.min(targetSpeed, -tb.reverseGrind);
    } else targetSpeed = fwdSpeed * (1 - tb.coastDrag * dt);

    const forwardInput = Math.max(0, throttle);
    const speedLoad = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / tb.boostMaxSpeed, 0, 1);
    this.driveThrust = THREE.MathUtils.clamp(
      forwardInput * (0.4 + speedLoad * 0.3 + (boost ? 0.3 : 0)),
      0,
      1
    );

    const nvx = fwd.x * targetSpeed + right.x * latSpeed * tb.gripLat;
    const nvz = fwd.z * targetSpeed + right.z * latSpeed * tb.gripLat;

    let vy = v.linear[1];
    let jumpedThisStep = false;
    // Predictive landing jets wake before the ordinary hover spring. Proximity
    // handles normal drops; time-to-hover lets a fast, tall fall start braking
    // early enough to feel intentional instead of flashing only at contact.
    const descentSpeed = Math.max(0, -vy);
    const timeToHover = descentSpeed > 0.01 ? Math.max(0, heightAbove) / descentSpeed : Infinity;
    const nearHover = 1 - THREE.MathUtils.smoothstep(heightAbove, 0.55, tb.landingAssistRange);
    const timeUrgency = 1 - THREE.MathUtils.smoothstep(timeToHover, 0.22, 0.72);
    const descentLoad = THREE.MathUtils.smoothstep(descentSpeed, 1.5, 14);
    this.landingAssist =
      !grounded &&
      this.#jumping <= 0 &&
      heightAbove > 0.25 &&
      heightAbove < tb.landingAssistRange * 1.5
        ? THREE.MathUtils.clamp(Math.max(nearHover, timeUrgency * 0.9) * descentLoad, 0, 1)
        : 0;
    if (this.#jumpBuf > 0 && this.#jumping <= 0 && (canJump || this.#coyote > 0)) {
      // max() so a buffered ollie never nerfs a bigger launch (trampoline pad)
      vy = Math.max(vy, tb.jump);
      jumpedThisStep = true;
      this.takeoffPulse = 1;
      this.#jumpBuf = 0;
      this.#coyote = 0;
      this.#rest = 0;
      this.#jumping = JUMP_LOCKOUT_TIME;
    } else if (grounded) {
      // anti-snag look-ahead (car-parity, mirrors car/controller.ts): sample the
      // ride surface a full nose length ahead so the hover spring lifts the deck
      // BEFORE the leading edge reaches a rise — otherwise the front of the 2.3 m
      // collider digs into the carpet slab ahead and the solver eats all forward
      // speed (the "noses down uphill and wedges" report). The old peek was only
      // nvx·dt (~0.3 m) in front, far short of the box's 1.15 m reach.
      const travel = Math.sign(fwdSpeed) || (throttle > 0 ? 1 : throttle < 0 ? -1 : 1);
      const nose = 1.15 + 0.6; // front-edge reach (box half-length) + margin
      const ax = ctx.position.x + fwd.x * nose * travel + nvx * dt;
      const az = ctx.position.z + fwd.z * nose * travel + nvz * dt;
      const ahead = Math.max(
        ctx.map.rideGround(ax, az, ctx.position.y),
        waterHeight(ax, az, ctx.time)
      );
      // climb-rate feedforward = grade · horizontal speed (car-parity), so the
      // spring only trims residual error rather than being slammed at rise/dt.
      const horiz = Math.max(Math.abs(fwdSpeed), 2);
      const slopeRate = THREE.MathUtils.clamp(((ahead - surface) / nose) * horiz, -14, 28);
      const rideYnose = Math.max(surface, ahead) + tb.hover + bob; // float over the rise
      // Nose-up manuals ride a touch higher; nose-down hugs the carpet.
      const manualHover = pitchStick * tb.hover * 0.35;
      // clamp the spring: a board wedged far below its ride height (collider
      // gap, overhang) must climb out, not get slammed at error·9 m/s
      vy = THREE.MathUtils.clamp((rideYnose + manualHover - ctx.position.y) * 9, -12, 18) + slopeRate;
    } else {
      vy -= tb.fallGravity * dt; // hand-integrated fall (gravityScale is 0)
      if (this.landingAssist > 0 && vy < -0.6) {
        // Never turn the brake into a second jump. It only bleeds downward
        // velocity until the close-range hover spring takes ownership again.
        vy = Math.min(-0.6, vy + tb.landingAssistBrake * this.landingAssist * dt);
      }
      // Angle-of-attack lift: nose up floats the ollie, nose down dives.
      vy += Math.sin(this.pitch) * tb.pitchLift * dt;
    }

    const upwardCorrection = Math.max(0, vy - v.linear[1]);
    const springLoad = grounded
      ? THREE.MathUtils.clamp(
          0.35 + upwardCorrection / 18 + Math.max(0, -heightAbove) / Math.max(0.2, tb.hover) * 0.25,
          0.25,
          1
        )
      : 0.08;
    this.hoverThrust = THREE.MathUtils.clamp(
      Math.max(springLoad, this.landingAssist, this.takeoffPulse * (jumpedThisStep ? 1 : 0.75)),
      0,
      1
    );
    this.verticalVelocity = vy;

    w.setBodyVelocity(ctx.body, [nvx, vy, nvz], [0, 0, 0]);

    // attitude: yaw from carving, lean into the turn, pitch from slope + stick.
    // Compose yaw → pitch → lean as local axes so air flips past ±90° stay clean
    // (Euler YXZ would gimbal-lock mid-backflip).
    const lean = THREE.MathUtils.clamp(steerRate * tb.carveLean, -0.85, 0.85);
    this.lean += (lean - this.lean) * Math.min(1, dt * 7);
    const e = 2.0;
    const slopePitch = grounded
      ? Math.atan2(
          ctx.map.rideGround(ctx.position.x + fwd.x * e, ctx.position.z + fwd.z * e, ctx.position.y) -
            ctx.map.rideGround(ctx.position.x - fwd.x * e, ctx.position.z - fwd.z * e, ctx.position.y),
          2 * e
        ) * 0.8
      : 0;
    const stickAbs = Math.abs(pitchStick);
    const resp = Math.min(1, dt * tb.pitchResponse);

    if (grounded) {
      // Touchdown: wrap to the shortest upright path so a mid-flip landing
      // recovers toward the slope instead of spinning the long way around.
      if (!this.#wasGrounded) {
        this.pitch = Math.atan2(Math.sin(this.pitch), Math.cos(this.pitch));
      }
      const manual = pitchStick * tb.pitchManual;
      const targetPitch = slopePitch + manual;
      this.pitch += (targetPitch - this.pitch) * resp;
    } else {
      // Light stick = gentle air pitch; past the flip threshold the rate ramps
      // up so a hard hold completes a backflip / frontflip in under a second.
      const flipBlend =
        stickAbs <= tb.pitchFlipThresh
          ? 0
          : (stickAbs - tb.pitchFlipThresh) / Math.max(1e-4, 1 - tb.pitchFlipThresh);
      const rate = tb.pitchAirRate + flipBlend * flipBlend * (tb.pitchFlipRate - tb.pitchAirRate);
      this.pitch += pitchStick * rate * dt;
      // Stick released near upright: ease toward a mild velocity pitch. Mid-flip
      // freezes attitude so a half-commit doesn't auto-unwind through upright.
      if (stickAbs < 0.12) {
        const wrapped = Math.atan2(Math.sin(this.pitch), Math.cos(this.pitch));
        if (Math.abs(wrapped) < 0.9) {
          const coast = THREE.MathUtils.clamp(vy * 0.02, -0.35, 0.35);
          this.pitch = wrapped + (coast - wrapped) * Math.min(1, dt * 2.2);
        }
      }
    }
    this.#wasGrounded = grounded;

    // yaw (world Y) → pitch (local X, nose up) → lean (local Z)
    const q = ctx.quaternion.setFromAxisAngle(V.up, this.yaw);
    q.multiply(V.quat.setFromAxisAngle(V.localX, this.pitch));
    q.multiply(V.quat.setFromAxisAngle(V.localZ, this.lean));
    w.setBodyTransform(ctx.body, [ctx.position.x, ctx.position.y, ctx.position.z], [q.x, q.y, q.z, q.w]);
    ctx.heading = this.yaw + Math.PI;
  }
}
