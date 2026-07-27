import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { waterHeight } from "../../world/heightmap";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { poseBone, type BirdRig } from "./mesh";
import { featherAirspeed, featherBeat, featherWind } from "./wind";
import { BIRD_TUNING } from "./tuning";
import { Wingbeat, wobble, type FlightDrive, type WingSample } from "./wingbeat";
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

/** Scratch stroke samples — one per point sampled along the wing, reused every
 *  fixed step (see Wingbeat.sample). */
const S = {
  shoulder: Wingbeat.newSample(),
  elbow: Wingbeat.newSample(),
  hand: Wingbeat.newSample(),
  tail: Wingbeat.newSample()
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
  #beat = new Wingbeat(); // gait + stroke shape
  #drive: FlightDrive = { speedNorm: 0, climb: 0, throttle: 0, boost: 0, tuck: 0, twirl: 0 };
  #climb = 0; // smoothed sine of the flight-path angle, +1 up .. -1 down
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
    this.#climb = 0;
    this.#beat.reset();
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
    const posture = this.#beat.demand * 0.03
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
      ? waterHeight(ctx.position.x, ctx.position.z, ctx.time) + 0.12
      : ctx.map.effectiveGround(ctx.position.x, ctx.position.z) + 0.5;
    if (ctx.position.y < floor) {
      w.setBodyTransform(ctx.body, [ctx.position.x, floor, ctx.position.z], [q.x, q.y, q.z, q.w]);
      if (V.tmp2.y < 0) w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }
    if (ctx.position.y > 2200 && V.tmp2.y > 0) {
      w.setBodyVelocity(ctx.body, [V.tmp2.x, 0, V.tmp2.z], [0, 0, 0]);
    }

    this.#animateWings(dt, t);
    ctx.heading = yaw + Math.PI;
  }

  /** Pose the phoenix skeleton on the fixed step. The GLB holds no baked clip:
   * Blender owns the broad load-bearing rest silhouette and the flight goes on
   * top of it. `wingbeat.ts` answers where in the stroke we are; everything
   * here is how that lands on bone. The shoulder leads and the elbow and wrist
   * follow on delayed arcs so the span whips rather than swinging as a plank,
   * the wing shortens on the recovery and opens through the power stroke, the
   * hand feathers to hold a bite, the torso takes the impulse a beat before the
   * tip finishes it, and the tail resolves everything last. */
  #animateWings(dt: number, t: (typeof BIRD_TUNING)["values"]) {
    const r = (this.#rig ??= (this.#mesh.userData.rig as BirdRig | undefined) ?? null);
    if (!r) return;
    const beat = this.#beat;
    beat.update(dt, this.#drive, t.flapHz);
    const at = beat.t;
    const sn = Math.min(this.#speedNorm, 1.6);
    const demand = beat.demand;

    // One stroke, sampled at three points along the wing. The lag is what turns
    // three hinges into a single flexing span.
    const sh = beat.sample(0, S.shoulder);
    const el = beat.sample(0.075, S.elbow);
    const hd = beat.sample(0.145, S.hand);

    // Stroke travel, in radians of wingtip elevation. The gather reaches high
    // and the power stroke drives lower still — a wing that only swings level
    // reads as waving, not lifting — and working hard opens the gather further.
    const stroke = beat.amplitude(this.#drive) * (1 - this.#twirl * 0.55);
    const up = t.strokeUp * (1 + demand * 0.2);
    const down = t.strokeDown;
    // Share of that travel per joint. They sum to one at the tip, so the wrist
    // covers more ground than the shoulder does even though it rotates least.
    const swing = (s: WingSample, share: number) =>
      (s.elev >= 0 ? s.elev * up : s.elev * down) * stroke * share;
    const armL = beat.splitL();
    const armR = beat.splitR();

    // A glide is not stillness. The wing rides thermals, rocks slowly about the
    // flight axis, and its tips bow up under airload the faster the air moves —
    // all of it fading out as the wings pick the stroke back up.
    const soar = (1 - beat.beatW) * (1 - this.#tuck);
    const sway = (wobble(at * 0.62, 7) * 0.055 + wobble(at * 0.21, 13) * 0.032) * (0.28 + soar * 1.15);
    const rock = wobble(at * 0.27, 17) * 0.03 * soar * (0.5 + Math.min(sn, 1) * 0.5);
    const tipLoad = soar * (0.07 + Math.min(sn, 1) * 0.15);

    // Rake sweeps the whole wing back to streamline. A stoop and a twirl rake
    // hard, and so does a committed descent — riding one down is a swept, quiet
    // silhouette, not a spread soar. Plain airspeed barely rakes at all, so an
    // open powered cruise keeps beating big. It saturates below the angle where
    // the chain would carry the two tips past the tail plane and scissor them.
    const dive = Math.max(0, -this.#climb);
    const rake = Math.min(sn * 0.05 + this.#tuck * 0.45 + this.#twirl * 0.5 + dive * 0.3, 0.7);
    // In a hard bank the inside wing draws in — the phoenix carves the turn
    // instead of holding a flat plank through it.
    const carve = THREE.MathUtils.clamp(this.#roll * 0.22, -0.13, 0.13);

    // Span change through the stroke: the wing folds on the recovery and opens
    // through the power stroke. That, more than the arc, is what separates a
    // wingbeat from a wave. The sweep term is the fore/aft half of the tip's
    // oval — drawn back at the top, thrown forward through the bottom.
    const elbowFold = rake * 0.55 + el.recovery * stroke * 0.42 - el.sweep * stroke * 0.1;
    const handFold = rake * 0.4 + hd.recovery * stroke * 0.5 - hd.sweep * stroke * 0.18;
    // Feathering: the hand pronates through the downstroke so the primaries
    // bite, and supinates on the way up so they slice. It peaks with stroke
    // velocity, a quarter-cycle off the elevation, which is what closes the
    // wingtip's oval instead of leaving it a straight line.
    const twist = hd.vel * stroke * 0.4 + wobble(at * 1.4, 23) * 0.022 * featherAirspeed.value;

    // Sway lifts both wings together (a dihedral breath); rock lifts one and
    // drops the other, which is the slow roll a soaring bird rides a thermal on.
    const rootSwing = swing(sh, 0.5);
    const elbowSwing = swing(el, 0.3);
    const handSwing = swing(hd, 0.2);
    const shoulderSweep = rake * 0.72 + sh.recovery * stroke * 0.05;
    poseBone(r.wingL, 0, shoulderSweep + carve * 0.4, rootSwing * armL + sway + rock);
    poseBone(r.wingR, 0, -shoulderSweep + carve * 0.4, -(rootSwing * armR + sway - rock));
    poseBone(r.elbowL, -el.power * stroke * 0.09, elbowFold + carve, elbowSwing * armL + tipLoad * 0.5);
    poseBone(r.elbowR, -el.power * stroke * 0.09, -elbowFold + carve, -(elbowSwing * armR + tipLoad * 0.5));
    poseBone(r.handL, twist, handFold + carve * 0.7, handSwing * armL + tipLoad);
    poseBone(r.handR, twist, -handFold + carve * 0.7, -(handSwing * armR + tipLoad));

    // The torso accepts the downstroke before the wingtip finishes it. Spine
    // and chest counter-rotate slightly, giving the stroke mass without adding
    // a gameplay-space camera bob or disturbing collision motion.
    const impulse = sh.power * stroke;
    featherWind.value = Math.min(1, 0.2 + sn * 0.45 + demand * 0.35);
    featherAirspeed.value = THREE.MathUtils.clamp(this.#speedVis / 42, 0, 1);
    featherBeat.value = impulse;
    const breath = Math.sin(at * 0.92) * 0.012;
    poseBone(r.spine, -impulse * 0.085 + breath, 0, wobble(at * 0.3, 29) * 0.012);
    poseBone(r.chest, impulse * 0.14 - sh.recovery * stroke * 0.035, 0, 0);

    // Tail inertia is deliberately slower than body attitude. A turn begins at
    // the chest, then travels down five bones as two detuned wind waves plus a
    // weaker echo of the power stroke, which itself arrives later the further
    // out the bone sits. Local angles stay modest because they accumulate down
    // the chain.
    this.#tailBank += (this.#roll - this.#tailBank) * Math.min(1, dt * 1.25);
    this.#tailPitch += (this.#pitch - this.#tailPitch) * Math.min(1, dt * 1.05);
    const bankLag = this.#tailBank - this.#roll;
    const pitchLag = this.#tailPitch - this.#pitch;
    const flare = Math.sin(this.#pitch) * 0.08 + demand * 0.022;
    const windGain = 0.7 + sn * 0.42;
    const twirlCounter = THREE.MathUtils.clamp(-this.#spinVel * 0.008, -0.045, 0.045);
    for (let i = 0; i < r.tail.length; i++) {
      const along = (i + 1) / r.tail.length;
      const sideWave = Math.sin(at * (1.25 + sn * 0.12) - i * 0.64 + wobble(at * 0.12, 37) * 0.3)
        * (0.018 + along * 0.036) * windGain;
      const liftWave = Math.sin(at * (1.62 + sn * 0.16) - i * 0.78 + 1.05)
        * (0.014 + along * 0.03) * windGain;
      const wake = beat.sample(0.22 + i * 0.06, S.tail).power * impulse * (0.014 + along * 0.026);
      const pitch = -flare * (0.2 + along * 0.18) + pitchLag * (0.06 + along * 0.07) + liftWave + wake;
      const yaw = sideWave + bankLag * (0.12 + along * 0.13) - this.#roll * 0.008;
      poseBone(r.tail[i], pitch, yaw, twirlCounter * (0.2 + i * 0.2));
    }

    // neck leads the turn slightly — predators look where they're going; the
    // look spreads down the chain so the head never hinges, and the head keeps
    // its own level as the body angles onto a climb or a dive
    const lookY = THREE.MathUtils.clamp(this.#roll * 0.35, -0.5, 0.5);
    const lookX = -this.#tuck * 0.2 + this.#climb * 0.16;
    for (const c of r.neck) poseBone(c, lookX / 3, lookY / 3, 0);
  }
}
