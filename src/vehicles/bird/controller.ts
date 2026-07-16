import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { poseBone, type BirdRig } from "./mesh";
import { featherAirspeed, featherBeat, featherWind } from "./wind";
import { BIRD_TUNING } from "./tuning";
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
 * drone. The bird flavor is in the dynamics: it beats its wings to get going
 * (Space climbs, and pushing off from low airspeed auto-flaps), it can never
 * quite hover (idle sink), and Shift tucks into a stoop that triples the speed
 * cap. Attitude is code-owned — nose into the vertical motion, bank into
 * lateral speed; the solver owns translation so collisions still land. Over
 * the bay the floor is the swell itself, so a low fast pass skims the surface
 * (splash FX key off that).
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
  #flapPow = 0; // wingbeat envelope
  #flapPhase = 0;
  #animT = 0;
  #speedVis = 0;
  #speedNorm = 0;
  #tailBank = 0;
  #tailPitch = 0;
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
    this.#flapPow = 0;
    this.#tailBank = 0;
    this.#tailPitch = 0;
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
    const posture = this.#flapPow * 0.025 - Math.min(this.#speedNorm, 1) * 0.025 - this.#tuck * 0.055;
    V.qYaw.setFromAxisAngle(V.up, yaw);
    V.qPitch.setFromAxisAngle(V.localRight, this.#pitch * 0.95 + posture);
    V.qRoll.setFromAxisAngle(V.localBack, this.#roll + this.#spin);
    const q = ctx.quaternion.copy(V.qYaw).multiply(V.qPitch).multiply(V.qRoll);
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

  /** Pose the phoenix skeleton on the fixed step. The GLB contains no baked
   * clip: Blender owns the broad load-bearing rest silhouette, while this
   * controller adds a heavy recovery / power / glide cycle. The shoulder
   * leads, elbow and wrist fold on delayed arcs, the torso takes the impulse,
   * and the tail resolves attitude changes after the body. */
  #animateWings(dt: number, flapHz: number) {
    const r = (this.#rig ??= (this.#mesh.userData.rig as BirdRig | undefined) ?? null);
    if (!r) return;
    this.#animT += dt;
    const pow = this.#flapPow;
    const sn = Math.min(this.#speedNorm, 1.6);
    const flapSpeed = Math.min(this.#speedNorm, 1.35);

    // Beat rate rides effort and airspeed, plus a slow layered wander so a
    // powered cruise never ticks like a metronome. Most of each cycle is an
    // open glide; the rate therefore stays deliberately low for this span.
    const wander = Math.sin(this.#animT * 0.7) * 0.6 + Math.sin(this.#animT * 1.9 + 1.3) * 0.4;
    this.#flapPhase += dt * Math.PI * 2 * flapHz * (0.35 + 0.6 * pow) * (0.78 + 0.28 * flapSpeed) * (1 + 0.1 * wander);

    const cycle = ((this.#flapPhase / (Math.PI * 2)) % 1 + 1) % 1;
    const smooth = (value: number) => {
      const x = THREE.MathUtils.clamp(value, 0, 1);
      return x * x * (3 - 2 * x);
    };
    const sampleWing = (lag: number) => {
      const phase = (cycle - lag + 1) % 1;
      let lift = 0;
      let recovery = 0;
      let power = 0;
      if (phase < 0.17) {
        const u = smooth(phase / 0.17);
        lift = THREE.MathUtils.lerp(-0.035, 0.58, u);
        recovery = u;
      } else if (phase < 0.29) {
        const u = (phase - 0.17) / 0.12;
        lift = 0.58 + Math.sin(u * Math.PI) * 0.025;
        recovery = 1;
      } else if (phase < 0.52) {
        const u = smooth((phase - 0.29) / 0.23);
        lift = THREE.MathUtils.lerp(0.58, -0.72, u);
        recovery = 1 - u;
        power = Math.sin(u * Math.PI);
      } else if (phase < 0.67) {
        const u = smooth((phase - 0.52) / 0.15);
        lift = THREE.MathUtils.lerp(-0.72, -0.035, u);
        power = 1 - u;
      } else {
        const u = (phase - 0.67) / 0.33;
        lift = -0.035 + Math.sin(u * Math.PI) * 0.018;
      }
      return { lift, recovery, power };
    };

    // Gliding settles into a shallow thermal sway. It is intentionally small:
    // the Blender silhouette stays broad and authoritative between strokes.
    const sway = (Math.sin(this.#animT * 1.15) * 0.035 + Math.sin(this.#animT * 0.53 + 2) * 0.02)
      * (0.35 + Math.max(0, 1 - pow));
    // wings rake back in a stoop or a twirl (streamline for the dive); plain
    // airspeed barely folds them so an open powered cruise keeps beating big.
    // Fold saturates below the point where the chain would carry the L/R tips
    // past the tail plane and scissor them, and it calms the throw with it (a
    // tucked wing quivers, it doesn't thrash).
    const fold = Math.min(sn * 0.045 + this.#tuck * 0.42 + this.#twirl * 0.5, 0.7);
    const damp = 1 - 0.66 * (fold / 0.7);
    const speedRange = THREE.MathUtils.clamp(sn - 0.35, 0, 1.3) * (1 - this.#tuck);
    const drive = (0.2 + 0.64 * pow + 0.1 * speedRange) * (1 + wander * 0.055) * damp;

    // Shoulder → elbow → wrist. The later joints lag only a few percent of a
    // cycle but contribute progressively less flap rotation, avoiding the old
    // cumulative fan/propeller silhouette. Their main job is recovery folding
    // and feather pitch, followed by a visible re-extension on the power beat.
    const shoulder = sampleWing(0);
    const elbow = sampleWing(0.032);
    const hand = sampleWing(0.068);
    const rootLift = shoulder.lift * drive * 0.72 + sway;
    const elbowLift = elbow.lift * drive * 0.34;
    const handLift = hand.lift * drive * 0.2;
    const elbowFold = fold * 0.55 + elbow.recovery * drive * 0.28;
    const handFold = fold * 0.38 + hand.recovery * drive * 0.34;
    const feather = (-hand.power * 0.36 + hand.recovery * 0.18) * drive
      + Math.sin(this.#animT * 3.1 + 0.4) * 0.018 * featherAirspeed.value;
    poseBone(r.wingL, 0, fold * 0.72 + shoulder.recovery * drive * 0.025, rootLift);
    poseBone(r.wingR, 0, -fold * 0.72 - shoulder.recovery * drive * 0.025, -rootLift);
    poseBone(r.elbowL, -elbow.power * drive * 0.07, elbowFold, elbowLift);
    poseBone(r.elbowR, -elbow.power * drive * 0.07, -elbowFold, -elbowLift);
    poseBone(r.handL, feather, handFold, handLift);
    poseBone(r.handR, feather, -handFold, -handLift);
    featherWind.value = Math.min(1, 0.2 + sn * 0.45 + pow * 0.3);
    featherAirspeed.value = THREE.MathUtils.clamp(this.#speedVis / 42, 0, 1);
    featherBeat.value = shoulder.power * drive;

    // The torso accepts the downstroke before the wingtip finishes it. Spine
    // and chest counter-rotate slightly, giving the stroke mass without adding
    // a gameplay-space camera bob or disturbing collision motion.
    const bodyImpulse = shoulder.power * drive;
    const breath = Math.sin(this.#animT * 0.92) * 0.012;
    poseBone(r.spine, -bodyImpulse * 0.065 + breath, 0, Math.sin(this.#animT * 0.47) * 0.01);
    poseBone(r.chest, bodyImpulse * 0.11 - hand.recovery * drive * 0.025, 0, 0);

    // Tail inertia is deliberately slower than body attitude. A turn begins at
    // the chest, then travels down five bones as two detuned wind waves plus a
    // weaker echo of the power stroke. Local angles stay modest because they
    // accumulate down the chain.
    this.#tailBank += (this.#roll - this.#tailBank) * Math.min(1, dt * 1.25);
    this.#tailPitch += (this.#pitch - this.#tailPitch) * Math.min(1, dt * 1.05);
    const bankLag = this.#tailBank - this.#roll;
    const pitchLag = this.#tailPitch - this.#pitch;
    const flare = Math.sin(this.#pitch) * 0.08 + pow * 0.018;
    const windGain = 0.7 + sn * 0.42;
    const twirlCounter = THREE.MathUtils.clamp(-this.#spinVel * 0.008, -0.045, 0.045);
    for (let i = 0; i < r.tail.length; i++) {
      const along = (i + 1) / r.tail.length;
      const sideWave = Math.sin(this.#animT * (1.25 + sn * 0.12) - i * 0.64 + Math.sin(this.#animT * 0.31) * 0.28)
        * (0.018 + along * 0.036) * windGain;
      const liftWave = Math.sin(this.#animT * (1.62 + sn * 0.16) - i * 0.78 + 1.05)
        * (0.014 + along * 0.03) * windGain;
      const wake = Math.sin(this.#flapPhase - 0.5 - i * 0.44) * bodyImpulse * (0.008 + along * 0.015);
      const pitch = -flare * (0.2 + along * 0.18) + pitchLag * (0.06 + along * 0.07) + liftWave + wake;
      const yaw = sideWave + bankLag * (0.12 + along * 0.13) - this.#roll * 0.008;
      poseBone(r.tail[i], pitch, yaw, twirlCounter * (0.2 + i * 0.2));
    }

    // neck leads the turn slightly — predators look where they're going; the
    // look spreads down the chain so the head never hinges
    const lookY = THREE.MathUtils.clamp(this.#roll * 0.35, -0.5, 0.5);
    const lookX = -this.#tuck * 0.2; // eyes up onto the target in a stoop
    for (const c of r.neck) poseBone(c, lookX / 3, lookY / 3, 0);
  }
}
