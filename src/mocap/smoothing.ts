import type { PoseLandmark } from "./landmarks";

class LowPass {
  #ready = false;
  #value = 0;

  filter(value: number, alpha: number): number {
    if (!this.#ready) {
      this.#ready = true;
      this.#value = value;
      return value;
    }
    this.#value += (value - this.#value) * alpha;
    return this.#value;
  }
}

class OneEuro {
  #position = new LowPass();
  #velocity = new LowPass();
  #previous: number | null = null;

  constructor(
    readonly minCutoff = 1.2,
    readonly beta = 0.05,
    readonly derivativeCutoff = 1
  ) {}

  filter(value: number, dt: number): number {
    const safeDt = dt > 0 ? dt : 1 / 60;
    const rawVelocity = this.#previous === null ? 0 : (value - this.#previous) / safeDt;
    this.#previous = value;
    const velocity = this.#velocity.filter(rawVelocity, OneEuro.alpha(this.derivativeCutoff, safeDt));
    return this.#position.filter(value, OneEuro.alpha(this.minCutoff + this.beta * Math.abs(velocity), safeDt));
  }

  static alpha(cutoff: number, dt: number): number {
    return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  }
}

export class LandmarkSmoother {
  #filters: Array<{ x: OneEuro; y: OneEuro; z: OneEuro }>;

  constructor(count: number) {
    this.#filters = Array.from({ length: count }, () => ({
      x: new OneEuro(),
      y: new OneEuro(),
      z: new OneEuro()
    }));
  }

  apply(landmarks: PoseLandmark[], dt: number): PoseLandmark[] {
    return landmarks.map((point, index) => {
      const filter = this.#filters[index];
      return {
        x: filter.x.filter(point.x, dt),
        y: filter.y.filter(point.y, dt),
        z: filter.z.filter(point.z, dt),
        visibility: point.visibility
      };
    });
  }
}
