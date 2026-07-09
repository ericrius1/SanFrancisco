/**
 * Learner — the persistent, continually-learning "brain" bank for the AI-cars
 * fleet. Replaces the episodic GA in trainer.ts: instead of a shared genome
 * pool evaluated over fixed episodes, every car is a PERSISTENT INDIVIDUAL that
 * learns online, forever, every learn-tick while it drives.
 *
 * Algorithm (LOCKED by the continual-learning plan): online continuing
 * actor-critic in the average-reward formulation with accumulating eligibility
 * traces. Per car:
 *   - Actor MLP [16,16,2] (tanh everywhere, matching policy.ts so the brain
 *     overlay is untouched). Its 2 outputs are the MEAN of a Gaussian over
 *     [steer, accel]; exploration noise is a state-independent scalar `sigma`
 *     set by a schedule (not gradient) that shrinks as the car's reward rate
 *     rises but never below 0.06 — that floor is the visible "alive" texture.
 *   - Critic MLP [16,16,1] (tanh hidden, LINEAR value head) estimating the
 *     differential value V(s).
 *   - Average-reward baseline rhoBar (EMA via the TD error).
 *   - TD error delta = r - rhoBar + V(s') - V(s)  (no gamma — average reward).
 *   - Accumulating traces on BOTH nets, lambda 0.9.
 *
 * All maths is hand-rolled on flat Float32Arrays with ZERO allocation in the
 * hot paths (actorForward / learnStep) — every scratch buffer is preallocated.
 * The only import is the Policy *type/impl* from policy.ts (itself dependency-
 * free), used by syncPolicy to mirror actor weights into the overlay's Policy.
 *
 * REWARD CONVENTION (documented, matters for the sigma schedule + skill):
 *   `reward` passed to learnStep is the per-SECOND shaped reward value at that
 *   tick (a rate, in ~m/s units per the plan's reward spec), NOT integrated
 *   over dt. rhoBar therefore settles to the car's mean reward RATE, which is
 *   what the sigma schedule and the social-rescue skill metric both assume.
 *
 * HEADING/OBS layout is fleet's concern; the learner is agnostic — it only sees
 * a length-16 obs vector and a length-2 action.
 */

import type { Policy } from "./policy.ts";

// --- net shapes (LOCKED) ----------------------------------------------------
const IN = 16;
const H = 16;
export const ACTOR_SIZES = [IN, H, 2] as const;
export const CRITIC_SIZES = [IN, H, 1] as const;
export const ACTOR_PARAMS = IN * H + H + H * 2 + 2;
export const CRITIC_PARAMS = IN * H + H + H + 1;

// flat-layout offsets (per policy.ts: layer weights row-major [out][in], then bias)
// actor
const A_W0 = 0;
const A_B0 = A_W0 + H * IN;
const A_W1 = A_B0 + H;
const A_B1 = A_W1 + 2 * H;
// critic
const C_W0 = 0;
const C_B0 = C_W0 + H * IN;
const C_W1 = C_B0 + H;
const C_B1 = C_W1 + H;

// --- hyper-parameters (LOCKED) ----------------------------------------------
const LAMBDA = 0.9; // eligibility-trace decay (both nets)
const ALPHA_A = 3e-4; // actor step size (gentled: 1e-3 eroded a cloned driving policy)
const ALPHA_C = 3e-3; // critic step size
const ALPHA_RHO = 1e-3; // average-reward EMA rate
const GRAD_CLIP = 1.0; // per-net per-step gradient L2 clip
const PARAM_CLAMP = 8; // hard clamp on every weight
const WEIGHT_DECAY = 1e-5; // tiny L2 pull-to-zero each step
const SIGMA_MIN = 0.06;
const SIGMA_MAX = 0.12; // capped: 0.25 let a dipping car explode into a spin runaway
const SIGMA_START = 0.075; // warm-start policy needs exploration, not random thrashing
const DT_LEARN = 0.05; // 20 Hz learn tick → +0.05 s of age per learnStep
const SKILL_TAU = 60; // reward-rate EMA time constant (s)
// social rescue
const RESCUE_MEDIAN_K = 1.5; // relative threshold = median - K*MAD
// Absolute skill floor (reward/min): a car below this is struggling REGARDLESS of
// the fleet spread. The relative median−K·MAD trigger alone fails on a bimodal
// fleet (half great, half stuck): the median sits between the clusters and the
// stuck cars never fall below median−K·MAD, so they never get rescued and the
// fleet stays permanently split. The absolute floor catches exactly that case —
// but only once a genuinely good driver exists to learn from (see #floorActive).
const RESCUE_ABS_FLOOR = 45;
const RESCUE_FLOOR_MENTOR_MIN = 120; // need a mentor at least this good to floor-rescue
const RESCUE_BELOW_S = 8 * 60; // must stay below continuously this long (s)
const RESCUE_COOLDOWN_S = 20 * 60; // max 1 lesson per car per this window (s)
const LESSON_KEEP = 0.65;
const LESSON_MENTOR = 0.35;
const LESSON_NOISE = 0.02;

/** Per-car persistence blob (brain fields only; fleet owns pos/kind/hue). */
export type CarBrainBlob = {
  v: 3;
  actor: number[];
  critic: number[];
  rhoBar: number;
  sigma: number;
  ageS: number;
  odoM: number;
  lessons: number;
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export class Learner {
  readonly numCars: number;

  // per-car flat weights + eligibility traces (own storage, never re-rolled)
  private actorW: Float32Array[] = [];
  private criticW: Float32Array[] = [];
  private traceA: Float32Array[] = [];
  private traceC: Float32Array[] = [];

  // per-car scalar state
  private rhoBar: Float32Array;
  private sigma: Float32Array;
  private skillRate: Float32Array; // EMA of per-second reward (tau=60s)
  private ageS: Float64Array; // seconds this individual has lived (learn-time)
  private odoM: Float64Array; // metres driven (incremented by fleet)
  private lessons: Int32Array; // social-rescue lessons received

  // social-rescue bookkeeping
  private belowS: Float64Array; // continuous time below the rescue threshold (s)
  private lastLessonAge: Float64Array; // ageS at last lesson (cooldown gate)
  private lastCheckAge = 0; // ageS reference at the previous lessonCheck

  // shared scratch (single-threaded → one car processed at a time, reused)
  private aH = new Float32Array(H);
  private aMu = new Float32Array(2);
  private aDz1 = new Float32Array(H);
  private aGrad = new Float32Array(ACTOR_PARAMS);
  private cH = new Float32Array(H); // hidden(s) — kept for the grad pass
  private cH2 = new Float32Array(H); // hidden(s') — value-only, never grad'd
  private cGrad = new Float32Array(CRITIC_PARAMS);

  // rng + gaussian spare (Box-Muller), zero-alloc
  private rng: () => number;
  private gaussSpare: number | null = null;

  constructor(numCars: number, rng: () => number = Math.random) {
    this.numCars = numCars;
    this.rng = rng;
    this.rhoBar = new Float32Array(numCars);
    this.sigma = new Float32Array(numCars);
    this.skillRate = new Float32Array(numCars);
    this.ageS = new Float64Array(numCars);
    this.odoM = new Float64Array(numCars);
    this.lessons = new Int32Array(numCars);
    this.belowS = new Float64Array(numCars);
    this.lastLessonAge = new Float64Array(numCars);
    for (let i = 0; i < numCars; i++) {
      this.actorW.push(this.#seedActor());
      this.criticW.push(this.#seedCritic());
      this.traceA.push(new Float32Array(ACTOR_PARAMS));
      this.traceC.push(new Float32Array(CRITIC_PARAMS));
      this.sigma[i] = SIGMA_START;
      // lastLessonAge starts at -cooldown so an early lesson isn't blocked by age 0
      this.lastLessonAge[i] = -RESCUE_COOLDOWN_S;
    }
  }

  // ------------------------------------------------------------------ init

  #gauss(): number {
    if (this.gaussSpare !== null) {
      const s = this.gaussSpare;
      this.gaussSpare = null;
      return s;
    }
    let u = 0;
    const v = this.rng();
    while (u < 1e-9) u = this.rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.gaussSpare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }

  /**
   * Fresh actor: a deterministic road-driver warm start plus tiny per-car noise.
   * Pure random policies spend most early training embedded in recovery clamps,
   * which is a poor signal. This seed can already follow the road frame, prefer
   * the right lane, brake for close obstacles, and slow for red/yellow lights;
   * the online actor-critic then improves it from real reward.
   */
  #seedActor(): Float32Array {
    const w = new Float32Array(ACTOR_PARAMS);
    const setUnit = (unit: number, bias: number, terms: [number, number][]) => {
      for (const [input, gain] of terms) w[A_W0 + unit * IN + input] = gain;
      w[A_B0 + unit] = bias;
    };
    // Observation layout from fleet.ts:
    // 0 speed, 2 sin heading error, 4 curvature, 5 clearAhead, 8 laneErr,
    // 9 wrong-way, 10 signal-near, 11 red, 12 yellow, 14 must-stop, 15 bias.
    setUnit(0, 0, [[2, 1.45]]); // steering target
    setUnit(1, 0, [[8, 1.15]]); // right-lane error
    setUnit(2, 0, [[4, 0.85]]); // curvature preview
    setUnit(3, 0, [[0, 1.1]]); // signed speed
    setUnit(4, 1.5, [[5, -1.5]]); // 0 when clear, positive when close/blocked
    setUnit(5, -2.2, [[14, 1.4], [10, 1.4]]); // stoplight close enough to matter
    setUnit(6, -1.5, [[11, 1.1], [12, 0.75], [10, 1.15]]); // red/yellow pressure
    setUnit(7, 0, [[9, 1.25]]); // wrong-way brake pressure
    setUnit(8, 0, [[1, 0.75]]); // raw lateral sanity

    w[A_W1 + 0 * H + 0] = 1.05;
    w[A_W1 + 0 * H + 1] = 0.78;
    w[A_W1 + 0 * H + 2] = 0.18;
    w[A_W1 + 0 * H + 8] = 0.22;

    w[A_W1 + 1 * H + 3] = -1.0;
    w[A_W1 + 1 * H + 4] = -1.6;
    w[A_W1 + 1 * H + 5] = -0.8;
    w[A_W1 + 1 * H + 7] = -0.3;
    w[A_B1 + 1] = -0.25;

    for (let p = 0; p < ACTOR_PARAMS; p++) w[p] += (this.rng() * 2 - 1) * 0.004;
    return w;
  }

  #seedCritic(): Float32Array {
    const w = new Float32Array(CRITIC_PARAMS);
    const s0 = 1 / Math.sqrt(IN);
    for (let j = 0; j < H; j++) for (let i = 0; i < IN; i++) w[C_W0 + j * IN + i] = (this.rng() * 2 - 1) * s0 * 0.5;
    const s1 = 1 / Math.sqrt(H);
    for (let j = 0; j < H; j++) w[C_W1 + j] = (this.rng() * 2 - 1) * s1 * 0.5;
    return w;
  }

  // --------------------------------------------------------------- forward

  /** Actor mean into this.aH / this.aMu (no allocation). */
  #actorMean(w: Float32Array, x: ArrayLike<number>): void {
    const aH = this.aH;
    for (let j = 0; j < H; j++) {
      let s = w[A_B0 + j];
      const row = A_W0 + j * IN;
      for (let i = 0; i < IN; i++) s += w[row + i] * x[i];
      aH[j] = Math.tanh(s);
    }
    for (let k = 0; k < 2; k++) {
      let s = w[A_B1 + k];
      const row = A_W1 + k * H;
      for (let j = 0; j < H; j++) s += w[row + j] * aH[j];
      this.aMu[k] = Math.tanh(s);
    }
  }

  /** Critic value; fills `hbuf` with hidden activations. */
  #criticValue(w: Float32Array, x: ArrayLike<number>, hbuf: Float32Array): number {
    for (let j = 0; j < H; j++) {
      let s = w[C_B0 + j];
      const row = C_W0 + j * IN;
      for (let i = 0; i < IN; i++) s += w[row + i] * x[i];
      hbuf[j] = Math.tanh(s);
    }
    let v = w[C_B1];
    for (let j = 0; j < H; j++) v += w[C_W1 + j] * hbuf[j];
    return v;
  }

  // --------------------------------------------------------------- backward

  /** grad log pi(a|s) w.r.t actor params → this.aGrad. Uses this.aH / this.aMu
   *  (must be freshly filled by #actorMean for this obs). */
  #actorGrad(w: Float32Array, x: ArrayLike<number>, a: ArrayLike<number>, sigma: number): void {
    const g = this.aGrad;
    const inv = 1 / (sigma * sigma);
    const aH = this.aH;
    // output layer: dz2[k] = d logpi/dmu_k * dmu_k/dz2_k
    const dz2_0 = (a[0] - this.aMu[0]) * inv * (1 - this.aMu[0] * this.aMu[0]);
    const dz2_1 = (a[1] - this.aMu[1]) * inv * (1 - this.aMu[1] * this.aMu[1]);
    for (let j = 0; j < H; j++) {
      g[A_W1 + 0 * H + j] = dz2_0 * aH[j];
      g[A_W1 + 1 * H + j] = dz2_1 * aH[j];
    }
    g[A_B1 + 0] = dz2_0;
    g[A_B1 + 1] = dz2_1;
    // hidden layer
    for (let j = 0; j < H; j++) {
      const dh = dz2_0 * w[A_W1 + 0 * H + j] + dz2_1 * w[A_W1 + 1 * H + j];
      this.aDz1[j] = dh * (1 - aH[j] * aH[j]);
    }
    for (let j = 0; j < H; j++) {
      const dz1 = this.aDz1[j];
      const row = A_W0 + j * IN;
      for (let i = 0; i < IN; i++) g[row + i] = dz1 * x[i];
      g[A_B0 + j] = dz1;
    }
  }

  /** grad V(s) w.r.t critic params → this.cGrad. Uses this.cH (hidden(s)). */
  #criticGrad(w: Float32Array, x: ArrayLike<number>): void {
    const g = this.cGrad;
    const cH = this.cH;
    // linear head: dV/dz2 = 1
    for (let j = 0; j < H; j++) g[C_W1 + j] = cH[j];
    g[C_B1] = 1;
    for (let j = 0; j < H; j++) {
      const dz1 = w[C_W1 + j] * (1 - cH[j] * cH[j]);
      const row = C_W0 + j * IN;
      for (let i = 0; i < IN; i++) g[row + i] = dz1 * x[i];
      g[C_B0 + j] = dz1;
    }
  }

  // --------------------------------------------------------------- helpers

  static #clipNorm(v: Float32Array, max: number): void {
    let n2 = 0;
    for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
    if (n2 <= max * max) return;
    const s = max / Math.sqrt(n2);
    for (let i = 0; i < v.length; i++) v[i] *= s;
  }

  // --------------------------------------------------------- public API

  /** Sampled action (mean + Gaussian(sigma) noise) into out[0..1]. Zero-alloc. */
  actorForward(i: number, obs: Float32Array, out: Float32Array): void {
    const w = this.actorW[i];
    this.#actorMean(w, obs);
    const sg = this.sigma[i];
    out[0] = this.aMu[0] + sg * this.#gauss();
    out[1] = this.aMu[1] + sg * this.#gauss();
  }

  /** One online actor-critic update from a single 20 Hz transition. Zero-alloc. */
  learnStep(i: number, obs: Float32Array, action: Float32Array, reward: number, nextObs: Float32Array): void {
    const wA = this.actorW[i];
    const wC = this.criticW[i];
    const tA = this.traceA[i];
    const tC = this.traceC[i];

    // --- critic value at s (keep hidden for the grad pass) ---
    const Vs = this.#criticValue(wC, obs, this.cH);
    this.#criticGrad(wC, obs); // uses this.cH → this.cGrad
    // value at s' (value-only, separate hidden buffer)
    const Vn = this.#criticValue(wC, nextObs, this.cH2);

    // --- TD error (average-reward, no gamma) ---
    const delta = reward - this.rhoBar[i] + Vn - Vs;

    // --- critic trace + update ---
    Learner.#clipNorm(this.cGrad, GRAD_CLIP);
    const stepC = ALPHA_C * delta;
    const decC = ALPHA_C * WEIGHT_DECAY; // decay coupled to the step size (standard L2)
    for (let p = 0; p < CRITIC_PARAMS; p++) {
      const tr = LAMBDA * tC[p] + this.cGrad[p];
      tC[p] = tr;
      const nw = wC[p] + stepC * tr - decC * wC[p];
      wC[p] = clamp(nw, -PARAM_CLAMP, PARAM_CLAMP);
    }

    // --- average-reward baseline ---
    this.rhoBar[i] += ALPHA_RHO * delta;

    // --- actor grad log pi(a|s), trace + update ---
    this.#actorMean(wA, obs); // refresh aH/aMu for this obs (fills scratch)
    this.#actorGrad(wA, obs, action, this.sigma[i]); // → this.aGrad
    Learner.#clipNorm(this.aGrad, GRAD_CLIP);
    const stepA = ALPHA_A * delta;
    const decA = ALPHA_A * WEIGHT_DECAY; // decay coupled to the step size (standard L2)
    for (let p = 0; p < ACTOR_PARAMS; p++) {
      const tr = LAMBDA * tA[p] + this.aGrad[p];
      tA[p] = tr;
      const nw = wA[p] + stepA * tr - decA * wA[p];
      wA[p] = clamp(nw, -PARAM_CLAMP, PARAM_CLAMP);
    }

    // --- sigma schedule (not gradient): shrinks as reward rate rises ---
    const rb = this.rhoBar[i];
    this.sigma[i] = clamp(0.06 + 0.19 / (1 + Math.max(0, rb) * 2), SIGMA_MIN, SIGMA_MAX);

    // --- skill EMA (reward-rate, tau=60s) + age ---
    const a = DT_LEARN / SKILL_TAU;
    this.skillRate[i] += a * (reward - this.skillRate[i]);
    this.ageS[i] += DT_LEARN;
  }

  /** Rolling reward-rate skill, PER MINUTE (EMA, tau ~60 s). */
  skill(i: number): number {
    return this.skillRate[i] * 60;
  }

  /** Metres driven, added by fleet (learner keeps the blob complete). */
  addOdometer(i: number, m: number): void {
    this.odoM[i] += m;
  }

  /** Age in seconds this individual has lived (learn-time). */
  age(i: number): number {
    return this.ageS[i];
  }

  /** Metres driven so far by car i (odometer readout for the HUD). */
  odometer(i: number): number {
    return this.odoM[i];
  }

  /** Total lessons received (social rescue). */
  lessonCount(i: number): number {
    return this.lessons[i];
  }

  /** Current exploration sigma. */
  sigmaOf(i: number): number {
    return this.sigma[i];
  }

  /** Average-reward baseline. */
  rho(i: number): number {
    return this.rhoBar[i];
  }

  /**
   * Social rescue (anti-collapse). Call ~every 30 s. A car whose skill stays
   * below (median − 1.5·MAD) CONTINUOUSLY for 15 min gets a LESSON: its weights
   * (both nets) are blended toward a random top-quartile mentor plus small
   * noise. Max one lesson per car per 30 min. Returns car ids taught this call.
   */
  lessonCheck(): number[] {
    const n = this.numCars;
    const taught: number[] = [];
    if (n === 0) return taught;

    // elapsed since last check (use max age as a shared monotone clock — all
    // cars learn every tick so ages advance together, but max is robust).
    let now = 0;
    for (let i = 0; i < n; i++) if (this.ageS[i] > now) now = this.ageS[i];
    let dt = now - this.lastCheckAge;
    if (dt < 0) dt = 0;
    // clock-jump guard: legit gaps are ~30 s. A large dt means ages jumped
    // (bulk import / restore); charge zero elapsed so belowS timers don't blow
    // past RESCUE_BELOW_S and mass-fire lessons on the first post-restore check.
    if (dt > 120) dt = 0;
    this.lastCheckAge = now;

    // fleet skill stats: median + MAD
    const sk = new Float64Array(n);
    for (let i = 0; i < n; i++) sk[i] = this.skill(i);
    const median = Learner.#median(sk);
    const dev = new Float64Array(n);
    for (let i = 0; i < n; i++) dev[i] = Math.abs(sk[i] - median);
    const mad = Learner.#median(dev);
    const threshold = median - RESCUE_MEDIAN_K * mad;

    // top-quartile mentor candidates (by skill)
    const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => sk[q] - sk[p]);
    const qCount = Math.max(1, Math.floor(n / 4));
    const mentors = order.slice(0, qCount);
    // the absolute floor only propagates skill once a real driver exists to copy,
    // so early on (whole fleet flailing) we don't blend bad cars toward bad cars.
    const floorActive = sk[order[0]] >= RESCUE_FLOOR_MENTOR_MIN;

    for (let i = 0; i < n; i++) {
      const struggling = sk[i] < threshold || (floorActive && sk[i] < RESCUE_ABS_FLOOR);
      if (struggling) this.belowS[i] += dt;
      else this.belowS[i] = 0;

      if (
        this.belowS[i] >= RESCUE_BELOW_S &&
        now - this.lastLessonAge[i] >= RESCUE_COOLDOWN_S &&
        mentors.length > 0
      ) {
        // pick a mentor distinct from i when possible
        let m = mentors[Math.floor(this.rng() * mentors.length) % mentors.length];
        if (m === i && mentors.length > 1) {
          m = mentors[(mentors.indexOf(i) + 1) % mentors.length];
        }
        if (m !== i) {
          this.#applyLesson(i, m);
          this.lessons[i]++;
          this.lastLessonAge[i] = now;
          this.belowS[i] = 0;
          taught.push(i);
        }
      }
    }
    return taught;
  }

  /** w ← 0.8·w + 0.2·w_mentor + N(0,0.02) on BOTH nets. Traces/rho untouched. */
  #applyLesson(i: number, mentor: number): void {
    const wA = this.actorW[i];
    const mA = this.actorW[mentor];
    for (let p = 0; p < ACTOR_PARAMS; p++) {
      wA[p] = clamp(LESSON_KEEP * wA[p] + LESSON_MENTOR * mA[p] + this.#gauss() * LESSON_NOISE, -PARAM_CLAMP, PARAM_CLAMP);
    }
    const wC = this.criticW[i];
    const mC = this.criticW[mentor];
    for (let p = 0; p < CRITIC_PARAMS; p++) {
      wC[p] = clamp(LESSON_KEEP * wC[p] + LESSON_MENTOR * mC[p] + this.#gauss() * LESSON_NOISE, -PARAM_CLAMP, PARAM_CLAMP);
    }
  }

  static #median(a: Float64Array): number {
    const b = Float64Array.from(a).sort();
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  // --------------------------------------------------------- persistence

  /** Brain fields for this car (fleet merges pos/kind/hue and stamps v). */
  exportCar(i: number): CarBrainBlob {
    return {
      v: 3,
      actor: Array.from(this.actorW[i]),
      critic: Array.from(this.criticW[i]),
      rhoBar: this.rhoBar[i],
      sigma: this.sigma[i],
      ageS: this.ageS[i],
      odoM: this.odoM[i],
      lessons: this.lessons[i]
    };
  }

  /**
   * Adopt a brain blob into car `i`. Validates shape/finiteness/bounds; returns
   * false (and mutates nothing) on rejection. Weights are clamped to ±8 (server
   * gate is ±16; internal invariant is ±8). Traces reset; skill primed from rho.
   */
  importCar(i: number, blob: CarBrainBlob): boolean {
    if (!blob || blob.v !== 3) return false;
    if (!Array.isArray(blob.actor) || blob.actor.length !== ACTOR_PARAMS) return false;
    if (!Array.isArray(blob.critic) || blob.critic.length !== CRITIC_PARAMS) return false;
    for (let p = 0; p < ACTOR_PARAMS; p++) {
      const v = blob.actor[p];
      if (!Number.isFinite(v) || Math.abs(v) > 16) return false;
    }
    for (let p = 0; p < CRITIC_PARAMS; p++) {
      const v = blob.critic[p];
      if (!Number.isFinite(v) || Math.abs(v) > 16) return false;
    }
    if (!Number.isFinite(blob.rhoBar) || Math.abs(blob.rhoBar) > 1e3) return false;
    if (!Number.isFinite(blob.sigma) || blob.sigma <= 0 || blob.sigma > 1) return false;
    if (!Number.isFinite(blob.ageS) || blob.ageS < 0 || blob.ageS > 1e12) return false;
    if (!Number.isFinite(blob.odoM) || blob.odoM < 0 || blob.odoM > 1e12) return false;
    if (!Number.isFinite(blob.lessons) || blob.lessons < 0 || blob.lessons > 1e9) return false;

    const wA = this.actorW[i];
    const wC = this.criticW[i];
    for (let p = 0; p < ACTOR_PARAMS; p++) wA[p] = clamp(blob.actor[p], -PARAM_CLAMP, PARAM_CLAMP);
    for (let p = 0; p < CRITIC_PARAMS; p++) wC[p] = clamp(blob.critic[p], -PARAM_CLAMP, PARAM_CLAMP);
    this.traceA[i].fill(0);
    this.traceC[i].fill(0);
    this.rhoBar[i] = blob.rhoBar;
    this.sigma[i] = clamp(blob.sigma, SIGMA_MIN, SIGMA_MAX);
    this.ageS[i] = blob.ageS;
    this.odoM[i] = blob.odoM;
    this.lessons[i] = Math.round(blob.lessons);
    this.skillRate[i] = blob.rhoBar; // rho and skillRate share units (reward/s)
    this.belowS[i] = 0;
    // full cooldown after import (not COOLDOWN-expired) so a bulk restore can't
    // immediately trigger a lesson for this car.
    this.lastLessonAge[i] = blob.ageS;
    // advance the shared lessonCheck clock past this car's age so the first
    // post-restore check sees a tiny dt, not the hours the ages just jumped.
    this.lastCheckAge = Math.max(this.lastCheckAge, blob.ageS);
    return true;
  }

  /**
   * Reset car `i` to a fresh individual ("new resident"): reseed both nets,
   * clear traces and all per-car bookkeeping. Used when a partial brain-cache /
   * localStorage set leaves a slot uncovered — that slot gets fresh weights
   * rather than being stranded at a stale/zero state.
   */
  resetCar(i: number): void {
    this.actorW[i] = this.#seedActor();
    this.criticW[i] = this.#seedCritic();
    this.traceA[i].fill(0);
    this.traceC[i].fill(0);
    this.rhoBar[i] = 0;
    this.sigma[i] = SIGMA_START;
    this.skillRate[i] = 0;
    this.ageS[i] = 0;
    this.odoM[i] = 0;
    this.lessons[i] = 0;
    this.belowS[i] = 0;
    this.lastLessonAge[i] = -RESCUE_COOLDOWN_S;
  }

  /** Mirror actor weights into a policy.ts Policy (the brain-overlay path). */
  syncPolicy(i: number, policy: Policy): void {
    policy.setParams(this.actorW[i]);
  }

  // --------------------------------------------------------- test support

  /**
   * Analytic gradients for the gradient-check test (NOT used by the fleet).
   * Returns grad log pi(a|s) over actor params and grad V(s) over critic params,
   * plus the current mean and value, all at the car's current weights.
   */
  __debugGrads(
    i: number,
    obs: Float32Array,
    action: Float32Array
  ): { mu: [number, number]; v: number; gLogPi: Float32Array; gV: Float32Array } {
    const wA = this.actorW[i];
    const wC = this.criticW[i];
    this.#actorMean(wA, obs);
    const mu: [number, number] = [this.aMu[0], this.aMu[1]];
    this.#actorGrad(wA, obs, action, this.sigma[i]);
    const gLogPi = Float32Array.from(this.aGrad);
    const v = this.#criticValue(wC, obs, this.cH);
    this.#criticGrad(wC, obs);
    const gV = Float32Array.from(this.cGrad);
    return { mu, v, gLogPi, gV };
  }

  /** Read/patch raw weights (test-only). */
  __actorWeights(i: number): Float32Array {
    return this.actorW[i];
  }
  __criticWeights(i: number): Float32Array {
    return this.criticW[i];
  }
}
