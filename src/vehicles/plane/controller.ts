import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, PlayerCtx } from "../../player/types";
import { PLANE_TUNING } from "./tuning";
import { TYPICAL_TREE_HEIGHT } from "../shared";
import type { HangGliderFlightProfile, HangGliderFlightState } from "./hangGliderPhysics";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  mat: new THREE.Matrix4(),
  quat: new THREE.Quaternion()
};
const HANG_GLIDER_LAUNCH_FALLBACK = 22;
const HANG_GLIDER_SINK_FALLBACK = 0.78;

export type HangGliderTelemetry = {
  active: boolean;
  airspeed: number;
  verticalSpeed: number;
  sinkRate: number;
  lift: number;
  bank: number;
  pitch: number;
  altitude: number;
  stalled: boolean;
  landed: boolean;
  touchdownSink: number;
  touchdownSpeed: number;
};

export class FlyController implements ModeController {
  readonly spawnLift = 2.5;

  // the plane's smoothed forward, speed and visual bank
  fwd = new THREE.Vector3(0, 0, -1);
  #speed = 45;
  #bank = 0;
  #hangGliding = false;
  #hangRoll = 0;
  #hangPitch = 0;
  #hangProfile: HangGliderFlightProfile | null = null;
  #hangLiftSampler: ((x: number, z: number, time: number) => number) | null = null;
  #hangState: HangGliderFlightState = {
    heading: 0,
    pitch: -0.04,
    bank: 0,
    airspeed: HANG_GLIDER_LAUNCH_FALLBACK
  };
  #hangTelemetry: HangGliderTelemetry = {
    active: false,
    airspeed: HANG_GLIDER_LAUNCH_FALLBACK,
    verticalSpeed: -HANG_GLIDER_SINK_FALLBACK,
    sinkRate: HANG_GLIDER_SINK_FALLBACK,
    lift: 0,
    bank: 0,
    pitch: -0.04,
    altitude: 0,
    stalled: false,
    landed: false,
    touchdownSink: 0,
    touchdownSpeed: 0
  };

  /** Visual bank angle — drives the pilot pose and yoke spin. */
  get bank(): number {
    return this.#bank;
  }

  get hangGliding(): boolean {
    return this.#hangGliding;
  }

  get hangGliderTelemetry(): Readonly<HangGliderTelemetry> {
    return this.#hangTelemetry;
  }

  setHangGliding(
    active: boolean,
    liftSampler: ((x: number, z: number, time: number) => number) | null = null,
    profile: HangGliderFlightProfile | null = null
  ): void {
    if (active && !profile) throw new Error("[plane] hang-glider flight profile is required");
    this.#hangGliding = active;
    this.#hangProfile = active ? profile : null;
    this.#hangLiftSampler = active ? liftSampler : null;
    this.#hangRoll = 0;
    this.#hangPitch = 0;
    this.#hangTelemetry.active = active;
    this.#hangTelemetry.landed = false;
    this.#hangTelemetry.touchdownSink = 0;
    this.#hangTelemetry.touchdownSpeed = 0;
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 2.5, p.z],
      halfExtents: this.#hangGliding ? [0.9, 0.42, 1.45] : [1.1, 0.5, 2.6],
      density: 70,
      friction: 0.3,
      restitution: 0.2
    });
    w.setBodyGravityScale(ctx.body, 0);
    // face the way the body was just spawned
    this.fwd.set(-Math.sin(facing), 0, -Math.cos(facing)).normalize();
    this.#speed = PLANE_TUNING.values.spawnSpeed;
    this.#bank = 0;
    this.#hangState.heading = facing;
    this.#hangState.pitch = -0.04;
    this.#hangState.bank = 0;
    const launchSpeed = this.#hangProfile?.launchSpeed ?? HANG_GLIDER_LAUNCH_FALLBACK;
    const baseSink = this.#hangProfile?.baseSink ?? HANG_GLIDER_SINK_FALLBACK;
    this.#hangState.airspeed = launchSpeed;
    this.#hangTelemetry.active = this.#hangGliding;
    this.#hangTelemetry.airspeed = launchSpeed;
    this.#hangTelemetry.verticalSpeed = -baseSink;
    this.#hangTelemetry.sinkRate = baseSink;
    this.#hangTelemetry.lift = 0;
    this.#hangTelemetry.bank = 0;
    this.#hangTelemetry.pitch = -0.04;
    this.#hangTelemetry.stalled = false;
    this.#hangTelemetry.landed = false;
    return p.y + 2.5;
  }

  enter(ctx: PlayerCtx) {
    if (this.#hangGliding) return;
    // same XZ as the previous mode; climb to ~2× tree height (+ a little) and
    // clear the local skyline so the first seconds of flight aren't a canyon
    const roof = ctx.physics.highestBuildingTop(ctx.position.x, ctx.position.z, 150);
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    const cruise = ground + TYPICAL_TREE_HEIGHT * 2 + 12;
    ctx.position.y = Math.max(ctx.position.y, cruise, roof + 25);
  }

  /**
   * Frame-rate flight steering: the mouse flies the nose, while A/D own a
   * separate banked turn rate so held keys always yaw the plane left/right.
   * Pitch is kept off vertical so heading stays well-defined.
   */
  steerFly(input: Input, dt: number) {
    if (this.#hangGliding) {
      if (input.suspended) {
        this.#hangRoll = 0;
        this.#hangPitch = 0;
        return;
      }
      const mouseRoll = THREE.MathUtils.clamp(input.mouseDX * 0.0075, -0.7, 0.7);
      const mousePitch = THREE.MathUtils.clamp(-input.mouseDY * 0.007, -0.7, 0.7);
      this.#hangRoll = THREE.MathUtils.clamp(input.axis("KeyA", "KeyD") + mouseRoll, -1, 1);
      // W / stick-forward lowers the nose; S / stick-back pulls the bar in.
      this.#hangPitch = THREE.MathUtils.clamp(input.axis("KeyW", "KeyS") + mousePitch, -1, 1);
      return;
    }
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
    if (this.#hangGliding) {
      this.#updateHangGlider(ctx, dt, input);
      return;
    }
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

  #updateHangGlider(ctx: PlayerCtx, dt: number, input: Input): void {
    const w = ctx.physics.world;
    const state = this.#hangState;
    const profile = this.#hangProfile;
    if (!profile) throw new Error("[plane] active hang glider lost its flight profile");
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);

    if (this.#hangTelemetry.landed) {
      const yaw = state.heading;
      const q = ctx.quaternion.setFromAxisAngle(V.up, yaw);
      w.setBodyTransform(
        ctx.body,
        [ctx.position.x, ground + 1.08, ctx.position.z],
        [q.x, q.y, q.z, q.w]
      );
      w.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
      return;
    }

    const lift = THREE.MathUtils.clamp(
      this.#hangLiftSampler?.(ctx.position.x, ctx.position.z, ctx.time) ?? 0,
      0,
      8.5
    );
    const result = profile.step(
      state,
      {
        roll: this.#hangRoll,
        pitch: this.#hangPitch,
        tuck: input.down("ShiftLeft"),
        flare: input.down("Space")
      },
      dt,
      lift
    );
    this.#bank = state.bank;
    this.#speed = state.airspeed;

    const c = Math.cos(state.pitch);
    const fwd = this.fwd.set(
      -Math.sin(state.heading) * c,
      Math.sin(state.pitch),
      -Math.cos(state.heading) * c
    ).normalize();
    const horizontal = result.horizontalSpeed;
    w.setBodyVelocity(
      ctx.body,
      [fwd.x * horizontal, result.verticalSpeed, fwd.z * horizontal],
      [0, 0, 0]
    );

    const m = V.mat.lookAt(V.tmp.set(0, 0, 0), V.tmp2.copy(fwd), V.up);
    const q = ctx.quaternion.setFromRotationMatrix(m);
    // Flight math uses positive bank for a rightward weight shift. Three's
    // forward axis points down -Z, so the same positive angle visually drops
    // the right wing; negating it made the glider lean out of its turn.
    q.premultiply(V.quat.setFromAxisAngle(fwd, state.bank));
    w.setBodyTransform(
      ctx.body,
      [ctx.position.x, ctx.position.y, ctx.position.z],
      [q.x, q.y, q.z, q.w]
    );

    const clearance = ctx.position.y - ground;
    if (clearance <= 1.12 && result.verticalSpeed <= 0.4) {
      this.#hangTelemetry.landed = true;
      this.#hangTelemetry.touchdownSink = Math.max(0, -result.verticalSpeed);
      this.#hangTelemetry.touchdownSpeed = state.airspeed;
      w.setBodyTransform(
        ctx.body,
        [ctx.position.x, ground + 1.08, ctx.position.z],
        [q.x, q.y, q.z, q.w]
      );
      w.setBodyVelocity(ctx.body, [0, 0, 0], [0, 0, 0]);
    }
    if (ctx.position.y > 1800 && result.verticalSpeed > 0) {
      w.setBodyVelocity(ctx.body, [fwd.x * horizontal, 0, fwd.z * horizontal], [0, 0, 0]);
    }

    this.#hangTelemetry.active = true;
    this.#hangTelemetry.airspeed = state.airspeed;
    this.#hangTelemetry.verticalSpeed = result.verticalSpeed;
    this.#hangTelemetry.sinkRate = result.sinkRate;
    this.#hangTelemetry.lift = result.thermalLift;
    this.#hangTelemetry.bank = state.bank;
    this.#hangTelemetry.pitch = state.pitch;
    this.#hangTelemetry.altitude = Math.max(0, clearance);
    this.#hangTelemetry.stalled = result.stalled;
    ctx.heading = state.heading + Math.PI;
  }
}
