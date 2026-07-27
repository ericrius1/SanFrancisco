import * as THREE from "three/webgpu";

/**
 * The phoenix's wingbeat: how hard it is working, whether it is beating or
 * soaring right now, and the shape of the stroke it is part-way through.
 *
 * Split out of the controller because it is the one genuinely simulation-like
 * part of the bird — the controller owns flight dynamics and skeleton posing,
 * this owns the gait. It answers three questions per frame:
 *
 *   demand   — how much power the current flight path costs. Climbing is
 *              expensive, slow flight is expensive, a committed descent is
 *              free. This is the term the player feels: point the nose up and
 *              the wings dig in, push it over and they open out and ride.
 *   beating  — bursts of strokes separated by open glides. Real birds almost
 *              never beat as a metronome; the burst length and the gaps
 *              between them both fall out of demand, so a hard climb never
 *              stops beating and a dive never starts.
 *   sample() — where in the stroke a given joint is, sampled with a lag so the
 *              shoulder leads and the wrist trails.
 *
 * Everything that could repeat is driven by `wobble` rather than a cycle
 * counter, so the animation has no loop point.
 */

const TAU = Math.PI * 2;

/** Fraction of the stroke spent on the downstroke. The recovery is longer:
 *  the power stroke is a committed shove, the gather that follows is unhurried
 *  — that asymmetry is most of what separates a wingbeat from a sine wave. */
const DOWNSTROKE = 0.42;

/**
 * Smooth pseudo-noise in about [-1, 1]. Three sines at incommensurate rates,
 * so the sum has no practical period — the phoenix never repeats a sequence of
 * beats even after minutes of flight. `seed` decorrelates the layers that share
 * the clock (beat depth, beat rate, left/right split, thermal sway).
 */
export function wobble(t: number, seed: number): number {
  return Math.sin(t * 0.734 + seed * 1.73) * 0.52
    + Math.sin(t * 1.193 + seed * 4.11) * 0.31
    + Math.sin(t * 2.671 + seed * 9.37) * 0.17;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Redistribute time inside one half-stroke: linger at the extremes, snap
 *  through the middle. A wing this size has to look like it has mass, and mass
 *  is read almost entirely from the dwell at the top and bottom of the arc. */
function dwell(u: number, k: number): number {
  const s = u * u * (3 - 2 * u);
  return u + (s - u) * k;
}

/** Flight state the gait reacts to, all normalised by the controller. */
export type FlightDrive = {
  /** airspeed / cruise cap — over 1 in a stoop */
  speedNorm: number;
  /** sine of the flight-path angle: +1 straight up, -1 straight down */
  climb: number;
  /** stick demand, 0..1 */
  throttle: number;
  /** Space held — a deliberate power climb */
  boost: number;
  /** 0 cruise .. 1 full stoop */
  tuck: number;
  /** 0..1 barrel-roll envelope */
  twirl: number;
};

/** One joint's position in the stroke. Sampled into a caller-owned struct —
 *  the poser reads four of these every fixed step and this runs for the whole
 *  time the phoenix is in the air. */
export type WingSample = {
  /** -1 at the bottom of the power stroke, +1 at the top of the gather */
  elev: number;
  /** signed stroke velocity: +1 driving down, -1 recovering up */
  vel: number;
  /** 0..1, peaks mid-downstroke — thrust, and what the FX key off */
  power: number;
  /** 0..1, peaks mid-upstroke — the wing folds on this */
  recovery: number;
  /** -1 aft .. +1 forward. The fore/aft half of the wingtip's oval: the tip
   *  is drawn back at the top of the gather and thrown forward through the
   *  bottom of the power stroke, so it traces a loop rather than a line. */
  sweep: number;
};

export class Wingbeat {
  /** animation clock — the argument to every `wobble` layer */
  t = 0;
  /** smoothed aerodynamic demand, 0..1 */
  demand = 0;
  /** smoothed beating-vs-soaring blend, 0 open glide .. 1 full stroke */
  beatW = 0;
  /** true while the current burst is running */
  beating = true;

  #phase = 0; // 0..1 through the current stroke
  #glide = 0; // seconds of open-wing soar left before the next burst
  #beatsLeft = 3;
  #beatAmp = 1; // this stroke's depth
  #beatRate = 1; // this stroke's rate
  #splitL = 1; // per-wing depth split, re-rolled each stroke
  #splitR = 1;

  reset() {
    this.t = 0;
    this.demand = 0.5;
    this.beatW = 0;
    this.beating = true;
    this.#phase = 0;
    this.#glide = 0;
    this.#beatsLeft = 3;
    this.#beatAmp = 1;
    this.#beatRate = 1;
    this.#splitL = 1;
    this.#splitR = 1;
  }

  /** Advance the gait one fixed step. `baseHz` is the tuned cadence of a
   *  full stroke at moderate effort. */
  update(dt: number, d: FlightDrive, baseHz: number) {
    this.t += dt;

    // ---- Aerodynamic demand ------------------------------------------------
    // Weight has to go somewhere. Climbing buys height with muscle; a wing
    // below cruise speed makes less lift per beat so it has to beat harder;
    // and a descent is height being spent, which is lift for free. The descent
    // credit starts biting around 7° nose-down and is total by about 37°, past
    // which the wings simply stop and the bird rides it down.
    const rise = Math.max(0, d.climb);
    const sink = Math.max(0, -d.climb);
    const slow = 1 - smoothstep(0.15, 0.85, d.speedNorm);
    const descent = smoothstep(0.12, 0.6, sink);
    const target = THREE.MathUtils.clamp(
      0.2
      + 0.34 * d.throttle
      + 0.66 * slow
      + 1.3 * rise
      + 0.9 * d.boost
      - 1.6 * descent
      - 0.55 * d.tuck,
      0,
      1
    );
    // Effort answers the stick quickly and bleeds off slowly — the bird keeps
    // working for a moment after you push the nose over, then settles.
    this.demand += (target - this.demand) * Math.min(1, dt * (target > this.demand ? 5.5 : 1.9));
    const demand = this.demand;

    // ---- Burst / glide gait ------------------------------------------------
    if (this.#glide > 0) {
      // A gap rolled while coasting must not outlive the input that ends it:
      // powering up collapses whatever soar remains so the wings answer the
      // stick instead of finishing a decision made seconds ago.
      if (demand > 0.55) this.#glide = Math.min(this.#glide, 0.3);
      if (d.boost > 0.5) this.#glide = 0;
      this.#glide -= dt;
      if (this.#glide <= 0) {
        this.#glide = 0;
        this.#openBurst(demand);
      }
    }
    this.beating = this.#glide <= 0;

    // ---- Stroke phase ------------------------------------------------------
    // Under load the beat is both deeper and quicker; at speed the air does
    // more of the work and the cadence shortens again. The wander keeps even a
    // single long burst from ticking evenly.
    if (this.beating) {
      const rate = baseHz
        * (0.62 + 0.5 * demand)
        * (0.86 + 0.3 * Math.min(d.speedNorm, 1.4))
        * this.#beatRate
        * (1 + wobble(this.t, 3) * 0.07);
      this.#phase += dt * rate;
      while (this.#phase >= 1) {
        this.#phase -= 1;
        this.#rollStroke(demand);
        // A burst is a plan, not a contract: push the nose over mid-burst and
        // the phoenix abandons the strokes it had left and opens out to ride
        // the descent, finishing only the one it is in.
        if (--this.#beatsLeft <= 0 || demand < 0.14) {
          const gap = this.#glideGap(demand);
          if (gap > 0.05) {
            this.#glide = gap;
            this.beating = false;
            break;
          }
          this.#openBurst(demand);
        }
      }
    }

    // The envelope, not the phase, is what opens and closes a burst: amplitude
    // rises quickly into the first gather and spreads out slowly at the end, so
    // the wing eases into the soar silhouette from wherever the last stroke
    // left it rather than snapping to a parked pose.
    const want = this.beating ? 1 : 0;
    this.beatW += (want - this.beatW) * Math.min(1, dt * (this.beating ? 6.5 : 2.4));
  }

  /** Master stroke depth: 0 while soaring, ~0.8 at a level cruise, and up past
   *  1.3 on a full-power climb beat. Scales the tuned stroke travel. */
  amplitude(d: FlightDrive): number {
    // A trim flap while coasting still has to read from a distance, so the
    // floor is generous; speed flattens the stroke because the wing needs less
    // travel to make the same lift.
    const strength = 0.78 + 0.45 * this.demand;
    const flat = 1 - 0.1 * Math.min(d.speedNorm, 1.5);
    return this.beatW * this.#beatAmp * strength * flat * (1 - d.tuck * 0.72);
  }

  /** Per-wing depth split. Two wings that mirror perfectly look machined. */
  splitL(): number { return this.#splitL; }
  splitR(): number { return this.#splitR; }

  /** Where a joint is in the stroke, written into `out`. `lag` shifts it back
   *  down the wing chain (0 shoulder, ~0.14 wrist) so the span whips instead of
   *  swinging flat. */
  sample(lag: number, out: WingSample): WingSample {
    const phase = ((this.#phase - lag) % 1 + 1) % 1;
    const w = phase < DOWNSTROKE
      ? 0.5 * dwell(phase / DOWNSTROKE, 0.55)
      : 0.5 + 0.5 * dwell((phase - DOWNSTROKE) / (1 - DOWNSTROKE), 0.34);
    const a = TAU * w;
    out.elev = Math.cos(a);
    out.vel = Math.sin(a);
    out.power = Math.max(0, out.vel);
    out.recovery = Math.max(0, -out.vel);
    // Tilted ellipse: aft at the top, thrown forward through the bottom.
    out.sweep = out.vel * 0.85 - out.elev * 0.45;
    return out;
  }

  /** A sample struct for a caller to own and reuse, pre-filled with the pose at
   *  the top of the gather so a rig posed before the first update looks right. */
  static newSample(): WingSample {
    return { elev: 1, vel: 0, power: 0, recovery: 0, sweep: -0.45 };
  }

  /** Open a burst and roll its character. Low demand gets a couple of shallow
   *  trim beats; a hard climb runs long enough that the gaps never show. */
  #openBurst(demand: number) {
    this.#phase = 0;
    this.#beatsLeft = Math.max(2, Math.round(2 + demand * 7 + wobble(this.t, 11) * 1.6));
    this.beating = true;
    this.#rollStroke(demand);
  }

  /** Re-roll one stroke's depth, rate and left/right split. */
  #rollStroke(demand: number) {
    this.#beatAmp = 0.84 + wobble(this.t, 21) * 0.2 + demand * 0.18;
    this.#beatRate = 1 + wobble(this.t, 31) * 0.13;
    this.#splitL = 1 + wobble(this.t, 41) * 0.07;
    this.#splitR = 1 + wobble(this.t, 47) * 0.07;
  }

  /** Seconds the wings hold open before the next burst. At full demand this is
   *  zero — the strokes run together — and it opens up fast as effort falls, so
   *  a shallow descent soars for seconds and a dive soars indefinitely. */
  #glideGap(demand: number): number {
    const ease = 1 - demand;
    return Math.max(0, Math.pow(ease, 1.6) * 7 + wobble(this.t, 53) * 0.4);
  }
}
