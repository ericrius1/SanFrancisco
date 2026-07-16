/**
 * Evolution Strategies (OpenAI-ES flavour) over a flat parameter vector.
 *
 * Gradient-free: it only ever calls `fitness(params)`. That is the whole reason
 * we can train against a WASM physics engine with no autodiff anywhere — the
 * "gradient" is estimated from a cloud of perturbed policies scored by rollout.
 *
 * Uses antithetic (mirrored) sampling and fitness-rank normalisation, which are
 * the two tricks that make plain ES competitive and low-variance. Deterministic
 * given a seed, so a training run reproduces exactly (matters for the write-up).
 *
 * Node-only (the trainer). Run under `node --experimental-strip-types`.
 */

export type Fitness = (params: Float32Array, tag: { member: number; mirror: 1 | -1; gen: number }) => number;

export type ESConfig = {
  dim: number;
  /** Number of antithetic PAIRS per generation (total rollouts = 2*pairs). */
  pairs?: number;
  sigma?: number; // perturbation std
  lr?: number; // step size
  weightDecay?: number; // L2 pull toward 0 (keeps torques sane)
  sigmaDecay?: number; // multiply sigma each gen (anneal exploration)
  seed?: number;
  init?: Float32Array; // warm start (else zeros)
};

export type GenReport = {
  gen: number;
  meanFitness: number;
  bestFitness: number;
  centerFitness: number; // fitness of the current mean policy (the one we ship)
  sigma: number;
  best: Float32Array; // best single perturbed member this gen
  center: Float32Array; // current distribution mean
};

/** Deterministic PRNG (mulberry32) — seedable, fast, good enough for ES noise. */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform RNG. */
function gauss(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Map raw fitnesses to centered ranks in [-0.5, 0.5] (utility, not raw scale). */
function rankNormalize(f: number[]): Float32Array {
  const idx = f.map((_, i) => i).sort((a, b) => f[a] - f[b]);
  const u = new Float32Array(f.length);
  const n = f.length;
  for (let r = 0; r < n; r++) u[idx[r]] = r / (n - 1) - 0.5;
  return u;
}

export class ES {
  readonly dim: number;
  center: Float32Array;
  sigma: number;
  lr: number;
  weightDecay: number;
  sigmaDecay: number;
  gen = 0;
  private rand: () => number;
  private pairs: number;
  // Adam moments on the estimated gradient — plain SGD-ES stalls; Adam is the
  // standard fix and costs two more vectors.
  private m: Float32Array;
  private v: Float32Array;
  private readonly b1 = 0.9;
  private readonly b2 = 0.999;

  constructor(cfg: ESConfig) {
    this.dim = cfg.dim;
    this.pairs = cfg.pairs ?? 64;
    this.sigma = cfg.sigma ?? 0.1;
    this.lr = cfg.lr ?? 0.02;
    this.weightDecay = cfg.weightDecay ?? 0.002;
    this.sigmaDecay = cfg.sigmaDecay ?? 1.0;
    this.rand = rng32(cfg.seed ?? 1);
    this.center = cfg.init ? cfg.init.slice() : new Float32Array(this.dim);
    this.m = new Float32Array(this.dim);
    this.v = new Float32Array(this.dim);
  }

  /**
   * One generation: sample `pairs` antithetic perturbations, score each with
   * `fitness`, and step the mean along the fitness-weighted noise. Returns a
   * report (mean/best fitness, the current center policy, etc.).
   */
  step(fitness: Fitness): GenReport {
    const P = this.pairs;
    const eps: Float32Array[] = new Array(P);
    const scores: number[] = new Array(2 * P);
    let best = -Infinity;
    let bestParams = this.center;
    let sum = 0;

    const cand = new Float32Array(this.dim);
    for (let p = 0; p < P; p++) {
      const e = new Float32Array(this.dim);
      for (let i = 0; i < this.dim; i++) e[i] = gauss(this.rand);
      eps[p] = e;
      for (const mirror of [1, -1] as const) {
        for (let i = 0; i < this.dim; i++) cand[i] = this.center[i] + mirror * this.sigma * e[i];
        const f = fitness(cand, { member: p, mirror, gen: this.gen });
        const slot = mirror === 1 ? p : P + p;
        scores[slot] = f;
        sum += f;
        if (f > best) {
          best = f;
          bestParams = cand.slice();
        }
      }
    }

    // rank-normalised utilities, then g = (1/2P) Σ u_i * ε_i  (antithetic combine)
    const util = rankNormalize(scores);
    const grad = new Float32Array(this.dim);
    for (let p = 0; p < P; p++) {
      const up = util[p] - util[P + p]; // + and − mirror difference
      const e = eps[p];
      for (let i = 0; i < this.dim; i++) grad[i] += up * e[i];
    }
    const norm = 1 / (2 * P * this.sigma);
    for (let i = 0; i < this.dim; i++) grad[i] = grad[i] * norm - this.weightDecay * this.center[i];

    // Adam ascent on the estimated gradient
    this.gen++;
    const b1t = 1 - Math.pow(this.b1, this.gen);
    const b2t = 1 - Math.pow(this.b2, this.gen);
    for (let i = 0; i < this.dim; i++) {
      this.m[i] = this.b1 * this.m[i] + (1 - this.b1) * grad[i];
      this.v[i] = this.b2 * this.v[i] + (1 - this.b2) * grad[i] * grad[i];
      const mh = this.m[i] / b1t;
      const vh = this.v[i] / b2t;
      this.center[i] += (this.lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
    this.sigma *= this.sigmaDecay;

    const centerFitness = fitness(this.center, { member: -1, mirror: 1, gen: this.gen });
    return {
      gen: this.gen,
      meanFitness: sum / (2 * P),
      bestFitness: best,
      centerFitness,
      sigma: this.sigma,
      best: bestParams,
      center: this.center.slice()
    };
  }
}
