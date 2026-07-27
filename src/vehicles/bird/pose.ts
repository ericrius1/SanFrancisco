import * as THREE from "three/webgpu";
import { poseBone, type BirdRig } from "./mesh";
import { BIRD_TUNING } from "./tuning";
import { Wingbeat, wobble, type FlightDrive, type WingSample } from "./wingbeat";
import type { FeatherDrive } from "./wind";

/**
 * How a phoenix's flight lands on its skeleton.
 *
 * Split out of `controller.ts` because the pilot is not the only one who has to
 * see the wings work. The local controller owns input and flight dynamics; a
 * remote phoenix — the mount you are riding shotgun on, or one crossing the bay
 * a hundred metres away — arrives as nothing but an interpolated transform and
 * a speed. Both feed the SAME poser, so a passenger sees the same stroke the
 * driver does: the wings dig in on a climb, open out and rake back down a dive,
 * and carve into a hard bank.
 *
 * `wingbeat.ts` still answers where in the stroke we are; this is how that
 * lands on bone. Nothing here reads input or writes physics.
 */

/** Body attitude, on top of the gait drive the wings answer. */
export type PhoenixAttitude = {
  /** bank into the turn, radians — the wings carve on this; a barrel roll about
   *  the same axis does not count, it belongs to `drive.twirl` */
  roll: number;
  /** nose elevation, radians */
  pitch: number;
  /** roll rate — the tail counter-twists against a spin */
  spinVel: number;
  /** m/s through the air; the feathers stream on this */
  airspeed: number;
};

/** Scratch stroke samples — one per point sampled along the wing. Reused by
 *  every poser: a sample is written and read inside one update, never held. */
const S = {
  shoulder: Wingbeat.newSample(),
  elbow: Wingbeat.newSample(),
  hand: Wingbeat.newSample(),
  tail: Wingbeat.newSample()
};

export class PhoenixPoser {
  /** gait + stroke shape */
  readonly beat = new Wingbeat();
  /** what this bird wants the shared plumage uniforms to read (see wind.ts) */
  readonly feather: FeatherDrive = { wind: 0.3, airspeed: 0.2, beat: 0 };

  #tailBank = 0;
  #tailPitch = 0;

  /** Aerodynamic demand, 0..1 — the controller leans the chest on it. */
  get demand(): number {
    return this.beat.demand;
  }

  reset() {
    this.beat.reset();
    this.#tailBank = 0;
    this.#tailPitch = 0;
  }

  /**
   * Pose the phoenix skeleton for one step. The GLB holds no baked clip:
   * Blender owns the broad load-bearing rest silhouette and the flight goes on
   * top of it. The shoulder leads and the elbow and wrist follow on delayed
   * arcs so the span whips rather than swinging as a plank, the wing shortens
   * on the recovery and opens through the power stroke, the hand feathers to
   * hold a bite, the torso takes the impulse a beat before the tip finishes it,
   * and the tail resolves everything last.
   */
  update(r: BirdRig, dt: number, drive: FlightDrive, att: PhoenixAttitude) {
    const t = BIRD_TUNING.values;
    const beat = this.beat;
    beat.update(dt, drive, t.flapHz);
    const at = beat.t;
    const sn = Math.min(drive.speedNorm, 1.6);
    const demand = beat.demand;
    const twirl = drive.twirl;
    const tuck = drive.tuck;
    const climb = drive.climb;
    const roll = att.roll;
    const airN = THREE.MathUtils.clamp(att.airspeed / 42, 0, 1);

    // One stroke, sampled at three points along the wing. The lag is what turns
    // three hinges into a single flexing span.
    const sh = beat.sample(0, S.shoulder);
    const el = beat.sample(0.075, S.elbow);
    const hd = beat.sample(0.145, S.hand);

    // Stroke travel, in radians of wingtip elevation. The gather reaches high
    // and the power stroke drives lower still — a wing that only swings level
    // reads as waving, not lifting — and working hard opens the gather further.
    const stroke = beat.amplitude(drive) * (1 - twirl * 0.55);
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
    const soar = (1 - beat.beatW) * (1 - tuck);
    const sway = (wobble(at * 0.62, 7) * 0.055 + wobble(at * 0.21, 13) * 0.032) * (0.28 + soar * 1.15);
    const rock = wobble(at * 0.27, 17) * 0.03 * soar * (0.5 + Math.min(sn, 1) * 0.5);
    const tipLoad = soar * (0.07 + Math.min(sn, 1) * 0.15);

    // Rake sweeps the whole wing back to streamline. A stoop and a twirl rake
    // hard, and so does a committed descent — riding one down is a swept, quiet
    // silhouette, not a spread soar. Plain airspeed barely rakes at all, so an
    // open powered cruise keeps beating big. It saturates below the angle where
    // the chain would carry the two tips past the tail plane and scissor them.
    const dive = Math.max(0, -climb);
    const rake = Math.min(sn * 0.05 + tuck * 0.45 + twirl * 0.5 + dive * 0.3, 0.7);
    // In a hard bank the inside wing draws in — the phoenix carves the turn
    // instead of holding a flat plank through it.
    const carve = THREE.MathUtils.clamp(roll * 0.22, -0.13, 0.13);

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
    const twist = hd.vel * stroke * 0.4 + wobble(at * 1.4, 23) * 0.022 * airN;

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
    this.feather.wind = Math.min(1, 0.2 + sn * 0.45 + demand * 0.35);
    this.feather.airspeed = airN;
    this.feather.beat = impulse;
    const breath = Math.sin(at * 0.92) * 0.012;
    poseBone(r.spine, -impulse * 0.085 + breath, 0, wobble(at * 0.3, 29) * 0.012);
    poseBone(r.chest, impulse * 0.14 - sh.recovery * stroke * 0.035, 0, 0);

    // Tail inertia is deliberately slower than body attitude. A turn begins at
    // the chest, then travels down five bones as two detuned wind waves plus a
    // weaker echo of the power stroke, which itself arrives later the further
    // out the bone sits. Local angles stay modest because they accumulate down
    // the chain.
    this.#tailBank += (roll - this.#tailBank) * Math.min(1, dt * 1.25);
    this.#tailPitch += (att.pitch - this.#tailPitch) * Math.min(1, dt * 1.05);
    const bankLag = this.#tailBank - roll;
    const pitchLag = this.#tailPitch - att.pitch;
    const flare = Math.sin(att.pitch) * 0.08 + demand * 0.022;
    const windGain = 0.7 + sn * 0.42;
    const twirlCounter = THREE.MathUtils.clamp(-att.spinVel * 0.008, -0.045, 0.045);
    for (let i = 0; i < r.tail.length; i++) {
      const along = (i + 1) / r.tail.length;
      const sideWave = Math.sin(at * (1.25 + sn * 0.12) - i * 0.64 + wobble(at * 0.12, 37) * 0.3)
        * (0.018 + along * 0.036) * windGain;
      const liftWave = Math.sin(at * (1.62 + sn * 0.16) - i * 0.78 + 1.05)
        * (0.014 + along * 0.03) * windGain;
      const wake = beat.sample(0.22 + i * 0.06, S.tail).power * impulse * (0.014 + along * 0.026);
      const pitch = -flare * (0.2 + along * 0.18) + pitchLag * (0.06 + along * 0.07) + liftWave + wake;
      const yaw = sideWave + bankLag * (0.12 + along * 0.13) - roll * 0.008;
      poseBone(r.tail[i], pitch, yaw, twirlCounter * (0.2 + i * 0.2));
    }

    // neck leads the turn slightly — predators look where they're going; the
    // look spreads down the chain so the head never hinges, and the head keeps
    // its own level as the body angles onto a climb or a dive
    const lookY = THREE.MathUtils.clamp(roll * 0.35, -0.5, 0.5);
    const lookX = -tuck * 0.2 + climb * 0.16;
    for (const c of r.neck) poseBone(c, lookX / 3, lookY / 3, 0);
  }
}

const EULER = new THREE.Euler(0, 0, 0, "YXZ");

/**
 * Rebuild the gait inputs for a phoenix somebody else is flying.
 *
 * The wire carries a pose, a scalar speed and nothing else — no stick, no
 * wingbeat phase — so the viewer reconstructs the flight the same way the
 * gait already reads it: how fast, how steeply up or down, how hard rolling.
 * That is enough for `wingbeat.ts` to reach the same conclusions the pilot's
 * client does (climb → dig in, dive → open out and ride it, stoop →
 * streamline). The individual strokes are re-rolled locally rather than
 * replicated: two clients agree on how hard the phoenix is working, not on
 * which wobble it is part-way through. The one input that cannot be inferred
 * is the pilot's discretionary Space climb — a bird already flying level with
 * the key held reads here as the level flight it is, and beats a little less
 * fiercely than the pilot sees. Everything the flight path shows, this sees.
 *
 * The transmitted quaternion is exactly the controller's yaw × pitch × roll
 * composition, so a YXZ decomposition hands back its pitch and bank unchanged.
 */
export class RemotePhoenixFlight implements PhoenixAttitude {
  readonly drive: FlightDrive = { speedNorm: 0, climb: 0, throttle: 0, boost: 0, tuck: 0, twirl: 0 };
  roll = 0;
  pitch = 0;
  spinVel = 0;
  airspeed = 0;

  /** m/s up, differentiated from the interpolated altitude */
  vertical = 0;

  #started = false;
  #rolled = 0; // last raw roll angle, for the rate that separates bank from spin
  #altitude = 0;

  /** `speed` is the transmitted scalar; `altitude`/`quaternion` come from this
   *  frame's interpolated pose. */
  update(dt: number, speed: number, altitude: number, quaternion: THREE.Quaternion) {
    const t = BIRD_TUNING.values;
    const d = this.drive;
    EULER.setFromQuaternion(quaternion, "YXZ");
    const roll = EULER.z;
    this.pitch = EULER.x;

    // First sight of this bird: adopt its state outright. Easing up from zero
    // would open a phoenix that came into range mid-climb on a glide silhouette
    // and only work out its mistake a second later.
    const first = !this.#started;
    this.#started = true;
    if (first) {
      this.airspeed = speed;
      this.#rolled = roll;
      this.#altitude = altitude;
    }

    // Climb rate comes off the INTERPOLATED altitude, not off a snapshot pair:
    // the relay re-broadcasts an unchanged row whenever its tick outruns the
    // sender, and differencing two of those reads a hard climb as level flight.
    // The interpolated curve moves every frame and averages out correctly. A
    // jump no bird could fly is a teleport, not a climb — skip it rather than
    // let the gait saturate for the half second the smoothing takes to forget.
    if (dt > 0) {
      const raw = (altitude - this.#altitude) / dt;
      if (Math.abs(raw) < 200) this.vertical += (raw - this.vertical) * Math.min(1, dt * 8);
    }
    this.#altitude = altitude;

    // Snapshots land at 12 Hz rounded to 0.1 m/s: ease onto them so the whole
    // gait doesn't step once per packet.
    this.airspeed += (speed - this.airspeed) * Math.min(1, dt * 6);
    d.speedNorm = THREE.MathUtils.clamp(this.airspeed / t.maxSpeed, 0, 2);

    // The wire carries bank and barrel-roll wrapped into one angle. Rate
    // separates them: a bank settles within a couple of rad/s, a held twirl
    // runs at the tuned spin rate and stays there. So sustained rotation folds
    // the wings in (twirl) and stops counting as bank — the carve, the tail lag
    // and the head's lean all belong to the turn, not to the barrel roll
    // sweeping through the same angles.
    const dRoll = Math.atan2(Math.sin(roll - this.#rolled), Math.cos(roll - this.#rolled));
    this.spinVel += ((dt > 0 ? dRoll / dt : 0) - this.spinVel) * Math.min(1, dt * 8);
    this.#rolled = roll;
    d.twirl = THREE.MathUtils.smoothstep(Math.abs(this.spinVel), 2.6, t.twirlRate * 0.85);
    this.roll = THREE.MathUtils.clamp(roll, -t.maxBank, t.maxBank) * (1 - d.twirl);

    // Flight-path angle: the term the whole gait hangs on. Same smoothing as
    // the pilot's own so a noisy vertical estimate can't strobe the beat.
    const climb = this.airspeed > 1
      ? THREE.MathUtils.clamp(this.vertical / Math.max(this.airspeed, 3), -1, 1)
      : 0;
    // No stick to read: carrying cruise speed IS the throttle, and only a stoop
    // pushes a phoenix past its powered cap, so overspeed reads as the tuck.
    const tuck = THREE.MathUtils.smoothstep(d.speedNorm, 1.15, 1.85);
    d.throttle = THREE.MathUtils.clamp(d.speedNorm / 0.45, 0, 1);
    d.boost = 0;
    if (first) {
      d.climb = climb;
      d.tuck = tuck;
    } else {
      d.climb += (climb - d.climb) * Math.min(1, dt * 3.5);
      d.tuck += (tuck - d.tuck) * Math.min(1, dt * 6);
    }
  }
}
