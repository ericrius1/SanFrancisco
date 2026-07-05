/**
 * A tiny feed-forward MLP policy — the "brain" of an RL creature.
 *
 * This one file is imported by BOTH runtimes, so it must stay dependency-free:
 *  - the Node trainer (`rl/`) runs it under `node --experimental-strip-types`
 *  - the browser game runs it for live in-world inference
 * No relative imports, no `three`, no DOM — pure arithmetic on Float32Arrays.
 *
 * `forward()` returns the squashed action AND the hidden-layer activations, so
 * the same call that steers the creature also feeds the neural-net bubble that
 * floats over its head (and, later, the sonified voice).
 */

export type PolicyDef = {
  /** Layer sizes, input first: [obs, h1, h2, ..., act]. */
  sizes: number[];
  /** Flat params, per layer in order: weights (out*in, row-major) then bias (out). */
  weights: number[];
  /** Optional label so exported policies are self-describing. */
  creature?: string;
  /** Optional running-mean/std observation normalizer (obs-length each). */
  obsMean?: number[];
  obsStd?: number[];
};

const tanh = Math.tanh;

/** Number of scalar params an MLP of these sizes needs. */
export function paramCount(sizes: number[]): number {
  let n = 0;
  for (let l = 0; l < sizes.length - 1; l++) n += sizes[l] * sizes[l + 1] + sizes[l + 1];
  return n;
}

export class Policy {
  readonly sizes: number[];
  readonly creature: string;
  private W: Float32Array[] = []; // per layer, out*in row-major
  private B: Float32Array[] = []; // per layer, out
  /** Post-activation output of every layer (index 0 = first hidden). Reused each frame. */
  readonly layerOut: Float32Array[] = [];
  private obsMean: Float32Array | null;
  private obsStd: Float32Array | null;
  private normObs: Float32Array;

  constructor(def: PolicyDef) {
    this.sizes = def.sizes.slice();
    this.creature = def.creature ?? "creature";
    this.setParams(def.weights);
    for (let l = 1; l < this.sizes.length; l++) this.layerOut.push(new Float32Array(this.sizes[l]));
    this.obsMean = def.obsMean ? Float32Array.from(def.obsMean) : null;
    this.obsStd = def.obsStd ? Float32Array.from(def.obsStd) : null;
    this.normObs = new Float32Array(this.sizes[0]);
  }

  static random(sizes: number[], rng: () => number, creature = "creature"): Policy {
    const n = paramCount(sizes);
    const w = new Array<number>(n);
    // small init keeps the untrained creature limp rather than convulsing
    let k = 0;
    for (let l = 0; l < sizes.length - 1; l++) {
      const fanIn = sizes[l];
      const scale = 1 / Math.sqrt(fanIn);
      for (let i = 0; i < sizes[l] * sizes[l + 1]; i++) w[k++] = (rng() * 2 - 1) * scale;
      for (let i = 0; i < sizes[l + 1]; i++) w[k++] = 0; // biases start at 0
    }
    return new Policy({ sizes, weights: w, creature });
  }

  /** Total scalar params (matches the flat weight vector length). */
  get paramCount(): number {
    return paramCount(this.sizes);
  }

  setParams(flat: ArrayLike<number>): void {
    this.W = [];
    this.B = [];
    let k = 0;
    for (let l = 0; l < this.sizes.length - 1; l++) {
      const inN = this.sizes[l];
      const outN = this.sizes[l + 1];
      const w = new Float32Array(inN * outN);
      for (let i = 0; i < w.length; i++) w[i] = flat[k++];
      const b = new Float32Array(outN);
      for (let i = 0; i < outN; i++) b[i] = flat[k++];
      this.W.push(w);
      this.B.push(b);
    }
  }

  getParams(): Float32Array {
    const out = new Float32Array(this.paramCount);
    let k = 0;
    for (let l = 0; l < this.W.length; l++) {
      out.set(this.W[l], k);
      k += this.W[l].length;
      out.set(this.B[l], k);
      k += this.B[l].length;
    }
    return out;
  }

  /**
   * obs -> action in [-1, 1] (tanh-squashed). Hidden layers use tanh too.
   * `hidden` aliases the widest hidden layer's activations — cheap handle for
   * the over-head bubble / voice. Do not mutate it.
   */
  forward(obs: ArrayLike<number>): { action: Float32Array; hidden: Float32Array } {
    let x: ArrayLike<number> = obs;
    if (this.obsMean && this.obsStd) {
      for (let i = 0; i < this.normObs.length; i++) {
        this.normObs[i] = (obs[i] - this.obsMean[i]) / (this.obsStd[i] + 1e-6);
      }
      x = this.normObs;
    }
    const L = this.W.length;
    for (let l = 0; l < L; l++) {
      const w = this.W[l];
      const b = this.B[l];
      const inN = this.sizes[l];
      const outN = this.sizes[l + 1];
      const out = this.layerOut[l];
      for (let o = 0; o < outN; o++) {
        let s = b[o];
        const row = o * inN;
        for (let i = 0; i < inN; i++) s += w[row + i] * x[i];
        out[o] = tanh(s); // squash every layer; output stays in [-1,1]
      }
      x = out;
    }
    return { action: this.layerOut[L - 1], hidden: this.widestHidden() };
  }

  private _widest = -1;
  private widestHidden(): Float32Array {
    if (this._widest < 0) {
      let best = 0;
      let bestI = 0;
      for (let l = 0; l < this.layerOut.length - 1; l++) {
        if (this.layerOut[l].length > best) {
          best = this.layerOut[l].length;
          bestI = l;
        }
      }
      this._widest = this.layerOut.length > 1 ? bestI : this.layerOut.length - 1;
    }
    return this.layerOut[this._widest];
  }

  toDef(): PolicyDef {
    return {
      sizes: this.sizes.slice(),
      weights: Array.from(this.getParams()),
      creature: this.creature,
      obsMean: this.obsMean ? Array.from(this.obsMean) : undefined,
      obsStd: this.obsStd ? Array.from(this.obsStd) : undefined
    };
  }
}
