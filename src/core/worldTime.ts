/** Session-local world clock. Player controls, UI and networking use real dt. */
export class WorldTime {
  #scale = 1;
  #nowMs: number | null = null;
  get scale() { return this.#scale; }
  set scale(value: number) {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(1, value));
    if (next !== this.#scale) this.#nowMs ??= Date.now();
    this.#scale = next;
  }
  delta(realDt: number) { return realDt * this.#scale; }
  advance(realDt: number) {
    if (this.#nowMs !== null) this.#nowMs += this.delta(realDt) * 1000;
  }
  nowMs() { return this.#nowMs ?? Date.now(); }
}
export const worldTime = new WorldTime();
