import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { seaTime, waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import type { BirdRig } from "./mesh";
import { FEATHER_RANK, publishFeatherDrive } from "./wind";
import { BIRD_TUNING } from "./tuning";
import { PhoenixPoser, type PhoenixAttitude } from "./pose";
import type { FlightDrive } from "./wingbeat";
import { TYPICAL_TREE_HEIGHT } from "../shared";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  right: new THREE.Vector3(),
  qYaw: new THREE.Quaternion(),
  qPitch: new THREE.Quaternion(),
  qRoll: new THREE.Quaternion(),
  up: new THREE.Vector3(0, 1, 0),
  localRight: new THREE.Vector3(1, 0, 0),
  localBack: new THREE.Vector3(0, 0, 1)
};

/**
 * Playable peregrine, flown drone-style: the mouse owns the chase camera and
 * W flies along the camera's 3D aim ("look down + W" dives), A/D strafe, and
 * the bird eases its yaw in behind the camera — the same muscle memory as the
 * drone. The bird flavor is in the dynamics: it can never quite hover (idle
 * sink), Space adds a hard climb, and Shift tucks into a stoop that triples the
 * speed cap. Attitude is code-owned — nose into the vertical motion, bank into
 * lateral speed; the solver owns translation so collisions still land. Over
 * the bay the floor is the swell itself, so a low fast pass skims the surface
 * (splash FX key off that).
 *
 * The wings answer the flight path rather than the keys: this feeds airspeed,
 * climb angle, throttle and stoop into `wingbeat.ts`, which decides how hard the
 * phoenix is working and whether it is mid-stroke or riding an open glide. Point
 * the nose up and it digs in and never stops beating; push it over and the wings
 * open out, rake back and ride the descent down.
 */
export class BirdController implements ModeController {
  readonly spawnLift = 3.5;

  // smoothed yaw (chases the camera) + visual attitude and wing state
  #yaw = 0;
  #pitch = 0;
  #roll = 0;
  #tuck = 0; // 0 cruise .. 1 full stoop (speed cap only; the wings keep beating)
  #spin = 0; // aerobatic barrel-roll angle, on top of the bank
  #spinVel = 0;
  #twirl = 0; // 0..1 spin envelope, folds the wings in while rolling
  #poser = new PhoenixPoser(); // gait + how it lands on the skeleton
  #drive: FlightDrive = { speedNorm: 0, climb: 0, throttle: 0, boost: 0, tuck: 0, twirl: 0 };
  #att: PhoenixAttitude = { roll: 0, pitch: 0, spinVel: 0, airspeed: 0 };
  #climb = 0; // smoothed sine of the flight-path angle, +1 up .. -1 down
  #speedVis = 0;
  #speedNorm = 0;
  #mesh: THREE.Group;
  #rig: BirdRig | null = null; // populated once the GLB resolves

  constructor(mesh: THREE.Group) {
    this.#mesh = mesh;
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 1.5, p.z],
      halfExtents: [1.86, 0.84, 1.86],
      density: 20,
      friction: 0.3,
      restitution: 0.2
    });
    w.setBodyGravityScale(ctx.body, 0);
    this.#yaw = facing;
    this.#pitch = 0;
    this.#roll = 0;
    this.#tuck = 0;
    this.#spin = 0;
    this.#spinVel = 0;
    this.#twirl = 0;
    this.#climb = 0;
    this.#poser.reset();
    return p.y + 1.5;
  }

  enter(ctx: PlayerCtx) {
    // same XZ; phoenix climbs above the plane's cruise band (and clear of water)
    const roof = ctx.physics.highestBuildingTop(ctx.position.x, ctx.position.z, 80);
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    const water = ctx.map.isWater(ctx.position.x, ctx.position.z) ? 12 : -Infinity;
    const cruise = ground + TYPICAL_TREE_HEIGHT * 2 + 45;
    ctx.position.y = Math.max(ctx.position.y, cruise, roof + 45, water);
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const w = ctx.physics.world;
    const t = BIRD_TUNING.values;
    const { camYaw, aim } = frame;

    const fwdIn = input.axis("KeyS", "KeyW") || input.axis("ArrowDown", "ArrowUp");
    const strafeIn = input.axis("KeyA", "KeyD");
    const flapKey = input.down("Space");
    const tucking = input.down("ShiftLeft");
    this.#tuck += ((tucking ? 1 : 0) - this.#tuck) * Math.min(1, dt * 6);

    // Q/E: barrel-roll twirl in either direction — hold to keep rolling.
    // Release settles to the nearest upright turn, so a half-finished twirl
    // never leaves the bird flying inverted.
    const twirlIn = input.axis("KeyQ", "KeyE");
    this.#spinVel += (-twirlIn * t.twirlRate - this.#spinVel) * Math.min(1, dt * 9);
    this.#spin += this.#spinVel * dt;
    if (!twirlIn) {
      const off = Math.atan2(Math.sin(this.#spin), Math.cos(this.#spin));
      this.#spin -= off * Math.min(1, dt * 6);
      if (Math.abs(this.#spinVel) < 0.05 && Math.abs(off) < 0.03) this.#spin = 0;
    }
    this.#twirl = Math.min(1, Math.abs(this.#spinVel) / t.twirlRate);

    // movement frame: full 3D camera aim forward, horizontal camera right
    const right = V.right.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const target = V.tmp.copy(aim).multiplyScalar(fwdIn).addScaledVector(right, strafeIn * t.strafeFactor);
    if (target.lengthSq() > 1) target.normalize();
    target.multiplyScalar(tucking ? t.tuckMax : t.maxSpeed);

    const spd = ctx.velocity.length();
    this.#speedNorm = THREE.MathUtils.clamp(spd / t.maxSpeed, 0, 2);
    if (flapKey) target.y += t.flapClimb;
    // a bird never quite hovers — idle it settles toward the ground
    if (!flapKey && fwdIn === 0 && strafeIn === 0) target.y -= t.sink;

    // ease velocity toward the target — the low response is the glide feel
    const k = 1 - Math.exp(-dt * t.response);
    V.tmp2.copy(ctx.velocity).lerp(target, k);
    w.setBodyVelocity(ctx.body, [V.tmp2.x, V.tmp2.y, V.tmp2.z], [0, 0, 0]);

    // yaw chases the camera so panning the mouse pans the bird; wrap-safe
    let dYaw = camYaw - this.#yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    this.#yaw += dYaw * Math.min(1, dt * t.yawFollow);
    const yaw = this.#yaw;

    // attitude: nose into the vertical motion, bank into lateral speed and the
    // turn itself; wingbeats hold the chest proud, a stoop streamlines flat
    const speed = V.tmp2.length();
    this.#speedVis = speed;
    // Flight-path angle drives the whole gait: the wings work for height and
    // coast for descent. Smoothed so a gust of stick doesn't strobe the beat.
    const climb = speed > 1 ? THREE.MathUtils.clamp(V.tmp2.y / Math.max(speed, 3), -1, 1) : 0;
    this.#climb += (climb - this.#climb) * Math.min(1, dt * 3.5);
    const d = this.#drive;
    d.speedNorm = this.#speedNorm;
    d.climb = this.#climb;
    d.throttle = Math.min(1, Math.abs(fwdIn) + Math.abs(strafeIn) * 0.6);
    d.boost = flapKey ? 1 : 0;
    d.tuck = this.#tuck;
    d.twirl = this.#twirl;
    const targetPitch = speed > 2 ? Math.asin(THREE.MathUtils.clamp(V.tmp2.y / Math.max(speed, 4), -1, 1)) : 0;
    this.#pitch += (targetPitch - this.#pitch) * Math.min(1, dt * 5);
    // bank INTO the turn. Lean on the COMMANDED velocity (`target`), not the eased
    // actual velocity: in a sustained mouse turn the real velocity slips to the
    // OUTSIDE of the turn (it lags the rotating heading), so banking into it rolled
    // the bird the wrong way. The command instead points where we're steering — the
    // strafe axis for A/D, the aim-lead for a mouse turn — so both bank the same way,
    // and the yaw-rate term (dYaw) reinforces the same direction.
    const cmdLat = target.x * Math.cos(yaw) - target.z * Math.sin(yaw); // commanded speed to the right
    const targetRoll = THREE.MathUtils.clamp(-cmdLat * t.bankPerSpeed + dYaw * 1.4, -t.maxBank, t.maxBank);
    this.#roll += (targetRoll - this.#roll) * Math.min(1, dt * 5);
    // Compose attitude explicitly as yaw × pitch × local-flight-axis roll.
    // This keeps a twirl axial even while climbing/diving and avoids Euler
    // order ambiguity. The Blender-authored flight rest no longer needs the
    // old permanent nose-up chest compensation.
    // Chest proud when working, streamlined at speed and in a stoop, and the
    // nose lifts a touch into a climb the way a bird's body angles off its
    // flight path.
    const posture = this.#poser.demand * 0.03
      - Math.min(this.#speedNorm, 1) * 0.025
      - this.#tuck * 0.055
      + Math.max(0, this.#climb) * 0.05;
    V.qYaw.setFromAxisAngle(V.up, yaw);
    V.qPitch.setFromAxisAngle(V.localRight, this.#pitch * 0.95 + posture);
    V.qRoll.setFromAxisAngle(V.localBack, this.#roll + this.#spin);
    const q = ctx.quaternion.copy(V.qYaw).multiply(V.qPitch).multiply(V.qRoll);
    w.setBodyTransform(ctx.body, [ctx.position.x, ctx.position.y, ctx.position.z], [q.x, q.y, q.z, q.w]);

    // floor: over the bay it's the swell itself — skim it; over land, graze
    const overWater = ctx.map.isWater(ctx.position.x, ctx.position.z);
    const floor = overWater
      ? waterHeight(ctx.position.x, ctx.position.z, seaTime()) + 0.12
      : ctx.map.effectiveGround(ctx.position.x, ctx.position.z) + 0.5;
    if (ctx.position.y < floor) {
      w.setBodyTransform(ctx.body, [ctx.position.x, floor, ctx.position.z], [q.x, q.y, q.z, q.w]);
      if (V.tmp2.y < 0) w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }
    if (ctx.position.y > 2200 && V.tmp2.y > 0) {
      w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }

    this.#animateWings(dt);
    ctx.heading = yaw + Math.PI;
  }

  /** Hand this step's flight to the shared poser (`pose.ts`), which is the
   * same one every viewer runs on a phoenix they are riding or watching, and
   * claim the shared plumage uniforms: the bird you are flying always outranks
   * one you are only looking at. */
  #animateWings(dt: number) {
    const r = (this.#rig ??= (this.#mesh.userData.rig as BirdRig | undefined) ?? null);
    if (!r) return;
    const att = this.#att;
    att.roll = this.#roll;
    att.pitch = this.#pitch;
    att.spinVel = this.#spinVel;
    att.airspeed = this.#speedVis;
    this.#poser.update(r, dt, this.#drive, att);
    publishFeatherDrive(FEATHER_RANK.local, this.#poser.feather);
  }
}
