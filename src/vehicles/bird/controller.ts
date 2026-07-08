import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { poseBone, type BirdRig } from "./mesh";
import { featherWind } from "./feathers";
import { BIRD_TUNING } from "./tuning";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  right: new THREE.Vector3(),
  euler: new THREE.Euler()
};

/**
 * Playable peregrine, flown drone-style: the mouse owns the chase camera and
 * W flies along the camera's 3D aim ("look down + W" dives), A/D strafe, and
 * the bird eases its yaw in behind the camera — the same muscle memory as the
 * drone. The bird flavor is in the dynamics: it beats its wings to get going
 * (Space climbs, and pushing off from low airspeed auto-flaps), it can never
 * quite hover (idle sink), and Shift tucks into a stoop that triples the speed
 * cap. Attitude is code-owned — nose into the vertical motion, bank into
 * lateral speed; the solver owns translation so collisions still land. Over
 * the bay the floor is the swell itself, so a low fast pass skims the surface
 * (splash FX key off that).
 */
export class BirdController implements ModeController {
  readonly spawnLift = 1.5;

  // smoothed yaw (chases the camera) + visual attitude and wing state
  #yaw = 0;
  #pitch = 0;
  #roll = 0;
  #tuck = 0; // 0 cruise .. 1 full stoop (speed cap only; the wings keep beating)
  #spin = 0; // aerobatic barrel-roll angle, on top of the bank
  #spinVel = 0;
  #twirl = 0; // 0..1 spin envelope, folds the wings in while rolling
  #flapPow = 0; // wingbeat envelope
  #flapPhase = 0;
  #animT = 0;
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
      halfExtents: [0.62, 0.28, 0.62],
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
    this.#flapPow = 0;
    return p.y + 1.5;
  }

  enter(ctx: PlayerCtx) {
    // launch clear of the local rooftops — lower than the plane, birds live in
    // the canyons — and never underwater (effectiveGround over the bay is the
    // bay floor)
    const roof = ctx.physics.highestBuildingTop(ctx.position.x, ctx.position.z, 80);
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    const water = ctx.map.isWater(ctx.position.x, ctx.position.z) ? 12 : -Infinity;
    ctx.position.y = Math.max(ctx.position.y, roof + 8, ground + 16, water);
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

    // wingbeat effort follows how hard we're flying: full beats under power,
    // harder still the faster we go (a stoop is all wing), and barely a
    // flutter when coasting on a glide
    const spd = ctx.velocity.length();
    const speedNorm = THREE.MathUtils.clamp(spd / t.maxSpeed, 0, 2);
    const moving = Math.abs(fwdIn) > 0.05 || Math.abs(strafeIn) > 0.05 || flapKey;
    const effort = moving ? Math.min(1, 0.55 + speedNorm * 0.4) : 0.08;
    this.#flapPow += (effort - this.#flapPow) * Math.min(1, dt * (effort > this.#flapPow ? 6 : 2.5));
    this.#speedNorm = speedNorm;
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
    const targetPitch = speed > 2 ? Math.asin(THREE.MathUtils.clamp(V.tmp2.y / Math.max(speed, 4), -1, 1)) : 0;
    this.#pitch += (targetPitch - this.#pitch) * Math.min(1, dt * 5);
    const localLat = V.tmp2.x * Math.cos(yaw) - V.tmp2.z * Math.sin(yaw); // speed to the right
    // bank INTO the turn from two sources that MUST agree in sign: lateral speed
    // (A/D strafe) and yaw rate (mouse steer). Both terms are negated so a mouse
    // turn leans the same way an A/D strafe does. The yaw term used to be +dYaw,
    // which banked the bird the wrong way whenever you steered with the mouse.
    const targetRoll = THREE.MathUtils.clamp(-localLat * t.bankPerSpeed - dYaw * 1.4, -t.maxBank, t.maxBank);
    this.#roll += (targetRoll - this.#roll) * Math.min(1, dt * 5);
    const posture = this.#flapPow * 0.16 - this.#tuck * 0.08;
    const q = ctx.quaternion.setFromEuler(V.euler.set(this.#pitch * 0.9 + posture, yaw, this.#roll + this.#spin, "YXZ"));
    w.setBodyTransform(ctx.body, [ctx.position.x, ctx.position.y, ctx.position.z], [q.x, q.y, q.z, q.w]);

    // floor: over the bay it's the swell itself — skim it; over land, graze
    const overWater = ctx.map.isWater(ctx.position.x, ctx.position.z);
    const floor = overWater
      ? waterHeight(ctx.position.x, ctx.position.z, ctx.time) + 0.12
      : ctx.map.effectiveGround(ctx.position.x, ctx.position.z) + 0.5;
    if (ctx.position.y < floor) {
      w.setBodyTransform(ctx.body, [ctx.position.x, floor, ctx.position.z], [q.x, q.y, q.z, q.w]);
      if (V.tmp2.y < 0) w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }
    if (ctx.position.y > 2200 && V.tmp2.y > 0) {
      w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }

    this.#animateWings(dt, t.flapHz);
    ctx.heading = yaw + Math.PI;
  }

  /** Pose the phoenix skeleton — runs on the fixed step like the drone's
   * rotors. The GLB's baked clip never plays; beat rate and amplitude ride
   * the wingbeat effort with a modest airspeed boost, the outer wing bones
   * trail the shoulder in phase so the big wing whips, the tail chain streams
   * and ripples, and the neck leads the turn. All angles are rig-space via
   * poseBone, so the skeleton's rest twists never leak in here. */
  #animateWings(dt: number, flapHz: number) {
    const r = (this.#rig ??= (this.#mesh.userData.rig as BirdRig | undefined) ?? null);
    if (!r) return;
    this.#animT += dt;
    const pow = this.#flapPow;
    const sn = Math.min(this.#speedNorm, 1.6);
    const flapSpeed = Math.min(this.#speedNorm, 1.35);
    // beat rate rides effort and airspeed, plus a slow layered wander so the
    // wingbeat breathes instead of ticking along like a metronome
    const wander = Math.sin(this.#animT * 0.7) * 0.6 + Math.sin(this.#animT * 1.9 + 1.3) * 0.4;
    this.#flapPhase += dt * Math.PI * 2 * flapHz * (0.35 + 0.6 * pow) * (0.78 + 0.28 * flapSpeed) * (1 + 0.1 * wander);

    // anharmonic wingbeat: warp time so the wing lingers at the top then whips
    // through the powered downstroke, and a lick of second harmonic sharpens
    // the peak into a flick — a clean sine is exactly what reads as robotic.
    // Downstrokes stay shaped shallower than upstrokes so a hard fast beat
    // never swings both wings under the belly into each other.
    const wingBeat = (ph: number) => {
      const w = ph - 0.35 * Math.sin(ph);
      const s = Math.sin(w) + 0.15 * Math.sin(2 * w - 0.5);
      return s > 0 ? s : s * 0.4;
    };
    // gliding settles into a shallow thermal sway — two detuned beats so it
    // never repeats cleanly
    const sway = (Math.sin(this.#animT * 1.4) * 0.05 + Math.sin(this.#animT * 0.63 + 2) * 0.03) * Math.max(0, 1 - pow);
    // wings rake back in a stoop or a twirl (streamline for the dive); plain
    // airspeed barely folds them so an open powered cruise keeps beating big.
    // Fold saturates below the point where the chain would carry the L/R tips
    // past the tail plane and scissor them, and it calms the throw with it (a
    // tucked wing quivers, it doesn't thrash).
    const fold = Math.min(sn * 0.06 + this.#tuck * 0.34 + this.#twirl * 0.22, 0.45);
    const damp = 1 - 0.45 * (fold / 0.45);
    // stroke amplitude climbs with effort and, in open powered flight, with
    // airspeed — a fast wing digs a deeper beat (the boost is gated off in a
    // tuck so a stoop stays streamlined, not flailing)
    const speedRange = THREE.MathUtils.clamp(sn - 0.35, 0, 1.3) * (1 - this.#tuck);
    const drive = (0.08 + 0.5 * pow + 0.2 * speedRange) * (1 + wander * 0.08) * damp;

    // TRAVELLING WAVE down the wing: shoulder → forearm → hand each run the
    // same beat but a growing phase-delay behind, and the OUTER joints throw
    // progressively harder, so the stroke rolls out along the span and the tip
    // cracks through last instead of the whole plank swinging as one. (Flip the
    // sign of `seg` to make the tip lead instead of trail.)
    const seg = 1.05; // flap-phase radians between successive joints
    const wave = (i: number) => wingBeat(this.#flapPhase - i * seg);
    const beat = wave(0) * drive * 0.85;
    const fore = wave(1) * drive * 1.0;
    const tip = wave(2) * drive * 1.18;
    // the hand also feathers — a touch of pitch trailing the stroke so the
    // primaries slice through the air rather than paddle it flat
    const feather = wave(2.5) * drive * 0.3;
    const up = 0.08 + sway + beat;
    poseBone(r.wingL, 0, fold, up);
    poseBone(r.wingR, 0, -fold, -up);
    poseBone(r.elbowL, 0, fold * 0.8, fore);
    poseBone(r.elbowR, 0, -fold * 0.8, -fore);
    poseBone(r.handL, feather, fold * 0.6, tip);
    poseBone(r.handR, feather, -fold * 0.6, -tip);
    featherWind.value = Math.min(1, 0.2 + sn * 0.45 + pow * 0.3);

    // chest rocks against the downstroke
    poseBone(r.chest, Math.sin(this.#flapPhase - 0.4) * 0.05 * pow, 0, 0);

    // tail: drop into a flare when climbing (air brake), stream flat at
    // speed, ripple sinuously when drifting slow, side-curl into the bank.
    // Angles accumulate down the chain, so per-bone values stay small.
    const flare = Math.sin(this.#pitch) * 0.14 + pow * 0.04;
    const ripple = 0.04 + 0.1 * Math.max(0, 1 - this.#speedVis / 25);
    const curl = THREE.MathUtils.clamp(this.#roll * 0.12, -0.14, 0.14);
    for (let i = 0; i < r.tail.length; i++) {
      const sway = Math.sin(this.#animT * 2.1 - i * 0.75) * ripple * (0.3 + i * 0.3);
      poseBone(r.tail[i], -flare, sway + curl, 0);
    }

    // neck leads the turn slightly — predators look where they're going; the
    // look spreads down the chain so the head never hinges
    const lookY = THREE.MathUtils.clamp(this.#roll * 0.35, -0.5, 0.5);
    const lookX = -this.#tuck * 0.2; // eyes up onto the target in a stoop
    for (const c of r.neck) poseBone(c, lookX / 3, lookY / 3, 0);
  }
}
