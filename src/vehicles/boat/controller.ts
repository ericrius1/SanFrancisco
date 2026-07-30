import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { seaTime, waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { enterOnWater } from "../shared";
import { BOAT_TUNING } from "./tuning";
import { makeHullFloat, sampleHullFloat, SAILBOAT_HULL, type HullSpec } from "./buoyancy";

const V = {
  tmp: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion()
};

/** Vertical speed ceiling (m/s). Only a guard against a pathological frame — a
 *  hull dropped off a 3 m crest lands at ~8 m/s and stays well inside it. */
const MAX_HEAVE = 16;

export class BoatController implements ModeController {
  readonly spawnLift = 0.8;
  steerVis = 0; // smoothed steer input, read by the helm-arm/wheel animation
  /** 0 = every probe clear of the water (airborne), 1 = riding on her lines. */
  hullSub = 1;
  /** Closing speed of the last splashdown (m/s), 0 on every other step. Read by
   *  whoever wants to answer a landing — spray, foley, camera shake. */
  slamSpeed = 0;
  /** Smoothed sea-as-encountered (m/s of surface running past the hull). Drives
   *  added resistance in waves; also the honest "how rough is it" number. */
  seaRough = 0;
  #tuning: typeof BOAT_TUNING;
  #hull: HullSpec;
  #float = makeHullFloat();
  // Wave surge is tracked apart from the drive velocity: the throttle model
  // eases toward a target speed and would otherwise swallow (or fight) a
  // gravity-fed run down a wave face on the very next step.
  #surgeX = 0;
  #surgeZ = 0;

  // the sailboat and the speedboat share this controller — only the tunables
  // and the hull dimensions differ, so pass the right pair in
  constructor(tuning: typeof BOAT_TUNING = BOAT_TUNING, hull: HullSpec = SAILBOAT_HULL) {
    this.#tuning = tuning;
    this.#hull = hull;
  }

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    this.#surgeX = 0;
    this.#surgeZ = 0;
    this.seaRough = 0;
    this.hullSub = 1;
    this.slamSpeed = 0;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, waterHeight(p.x, p.z, seaTime()) + 0.4, p.z],
      halfExtents: [1.3, 0.75, 3.2],
      density: 40,
      friction: 0.2,
      restitution: 0.1
    });
    // Gravity is ours: buoyancy and weight are integrated together against the
    // sampled sea, so the solver must not add a second g on top.
    w.setBodyGravityScale(ctx.body, 0);
    return waterHeight(p.x, p.z, seaTime()) + 0.15;
  }

  enter(ctx: PlayerCtx): number | void {
    // land / bridge / shallows → nearest navigable water (enterOnWater)
    enterOnWater(ctx);
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

    // Sample the sea at the clock the water RENDERS with, not the sim clock —
    // the two drift seconds apart (arrival holds, rides), which had the hull
    // riding an invisible sea: airborne over rendered troughs, buried in
    // rendered crests. See seaTime() in world/heightmap.
    const t = seaTime();
    const px = ctx.position.x;
    const pz = ctx.position.z;
    const tb = this.#tuning.values;

    // The sea under the hull: four keel probes → buoyancy, trim plane, and how
    // much of the boat is actually in the water this step.
    const float = this.#float;
    sampleHullFloat(this.#hull, ctx.position, q, v.linear[1], t, tb.heaveDamp, float);
    const wet = THREE.MathUtils.clamp(float.sub, 0, 1); // 0 airborne … 1 on her lines
    const wasWet = this.hullSub;
    this.hullSub = wet;
    // Splashdown: the frame the hull first touches water again after flying.
    this.slamSpeed = wasWet <= 0.001 && wet > 0.001 ? Math.max(0, float.surfaceRate - v.linear[1]) : 0;
    // Prop, rudder and skeg all live on the transom — lift the stern clear and
    // the throttle and the wheel stop being connected to anything.
    const bite = THREE.MathUtils.clamp(float.sternSub, 0, 1);

    // shore handling: hard-stop only for actual land ahead; shallows just slow you
    const aheadX = px + fwd.x * 6;
    const aheadZ = pz + fwd.z * 6;
    const aheadGround = ctx.map.groundHeight(aheadX, aheadZ);
    const beached = aheadGround > 0.05 && throttle > 0;
    const shallowFactor = aheadGround > -1.0 ? tb.shallowFactor : 1;

    const right = V.right.set(1, 0, 0).applyQuaternion(q);
    right.y = 0;
    right.normalize();

    // Drive speed is measured on the velocity WITHOUT the wave surge, so the
    // throttle governs the boat, not the boat plus whatever the sea is doing.
    const rel = V.tmp.copy(ctx.velocity);
    rel.x -= this.#surgeX;
    rel.z -= this.#surgeZ;
    const fwdSpeed = rel.dot(fwd);
    const latSpeed = rel.dot(right);

    // Added resistance in waves. The flat-water top speed is a fiction in a
    // seaway: what the hull actually meets is the surface rising past it at
    // ∂η/∂t + v·∇η, and driving into that is what a real boat spends its power
    // on. Without this the runabout holds 27 m/s through a 3.4 m sea, which
    // puts a wave under it every 0.9 s — no hull can answer that, so it flies
    // off every crest and the next one closes over the deck. Throttling back
    // is not a fudge, it is the thing that makes the ride possible.
    const n = float.normal;
    const enc =
      float.surfaceRate - (n.x * ctx.velocity.x + n.z * ctx.velocity.z) / Math.max(n.y, 0.2);
    this.seaRough += (Math.abs(enc) - this.seaRough) * Math.min(1, dt * 1.5);
    const maxSpeed =
      ((boost ? tb.boostMaxSpeed : tb.maxSpeed) * shallowFactor) /
      (1 + tb.waveDrag * this.seaRough * this.seaRough);

    // longitudinal: ease toward target speed (hard-capped), heavy water drag.
    // Everything the hull does to the water scales with how much of it is in
    // the water — a boat in mid-air neither accelerates nor drags.
    let targetSpeed = fwdSpeed;
    if (throttle > 0 && !beached)
      targetSpeed = Math.min(maxSpeed, fwdSpeed + (boost ? tb.boostAccel : tb.accel) * bite * dt);
    else if (throttle < 0) targetSpeed = Math.max(-tb.reverseMax, fwdSpeed - tb.reverseAccel * bite * dt);
    else targetSpeed = fwdSpeed * (1 - tb.coastDrag * wet * dt);
    if (beached) targetSpeed = Math.min(targetSpeed, 0);

    // Heave: integrate buoyancy − weight − damping. Airborne (sub = 0) this is
    // exactly −g, so a hull that leaves a crest flies a real arc and lands.
    const vy = THREE.MathUtils.clamp(v.linear[1] + float.accelY * dt, -MAX_HEAVE, MAX_HEAVE);

    // Surge: gravity resolved down the wave face. Accumulated separately and
    // bled off by water drag, so she genuinely runs away down a big front and
    // grinds against the back of the next one.
    const surgeDecay = Math.exp(-tb.surgeDrag * dt);
    this.#surgeX = (this.#surgeX + float.surgeX * tb.waveSurge * dt) * surgeDecay;
    this.#surgeZ = (this.#surgeZ + float.surgeZ * tb.waveSurge * dt) * surgeDecay;
    const surgeMag = Math.hypot(this.#surgeX, this.#surgeZ);
    if (surgeMag > tb.surgeMax) {
      const k = tb.surgeMax / surgeMag;
      this.#surgeX *= k;
      this.#surgeZ *= k;
    }

    // recompose horizontal velocity: forward + damped lateral (hull grip) +
    // surge. Off the water there is no grip to lose, so nothing is damped.
    const keepLat = THREE.MathUtils.lerp(1, tb.gripLat, wet);
    const nvx = fwd.x * targetSpeed + right.x * latSpeed * keepLat + this.#surgeX;
    const nvz = fwd.z * targetSpeed + right.z * latSpeed * keepLat + this.#surgeZ;

    const steerRate =
      steer * Math.min(Math.abs(fwdSpeed) / 4 + 0.15, 1) * tb.steerRate * bite * (fwdSpeed >= -0.5 ? 1 : -1);

    // Roll/pitch chase the wave plane fitted through the hull's own footprint
    // (yaw stays steering-owned) — that plane IS the trim a rigid hull takes on
    // this piece of water, so she pitches up a face and rolls in a beam sea.
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    V.qa.setFromAxisAngle(V.up, yaw);
    V.qb.setFromUnitVectors(V.up, float.normal).multiply(V.qa);
    // under way the hull trims bow-up like a real day-sailer on plane; also
    // guarantees the nose never reads as digging into the swell
    const trim = 0.045 * THREE.MathUtils.clamp(fwdSpeed / tb.maxSpeed, 0, 1) * bite;
    V.qb.multiply(V.qa.setFromAxisAngle(V.right.set(1, 0, 0), trim));
    V.qa.copy(q).invert().premultiply(V.qb);
    const flip = V.qa.w < 0 ? -1 : 1;
    const gain = 2 * tb.trimRate;
    let wx = THREE.MathUtils.clamp(V.qa.x * flip * gain, -2.8, 2.8);
    let wz = THREE.MathUtils.clamp(V.qa.z * flip * gain, -2.8, 2.8);
    if (wet < 1) {
      // In the air nothing is levelling her: she keeps the rotation she left
      // the crest with (bleeding slowly), and the water takes the attitude back
      // over as the probes re-enter.
      const spin = Math.exp(-1.2 * dt);
      wx = wx * wet + v.angular[0] * spin * (1 - wet);
      wz = wz * wet + v.angular[2] * spin * (1 - wet);
    }
    w.setBodyVelocity(ctx.body, [nvx, vy, nvz], [wx, steerRate, wz]);

    ctx.heading = Math.atan2(-fwd.x, -fwd.z) + Math.PI;
  }
}
