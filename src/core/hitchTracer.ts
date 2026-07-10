// Hitch tracer — always-on, near-zero-cost smoothness instrumentation.
//
// The app's steady frame rate is fine; what hurts is the intermittent spike
// (a burst of building/body/upload work landing in one frame). This module
// makes every such spike ATTRIBUTABLE the moment it happens, instead of a
// vague "it stuttered somewhere":
//
//   • phases   — tick sections bracketed with begin()/end() ("physics",
//                "world", "render"…): ms per phase, per frame.
//   • counters — systems report discrete work as it happens (bodies created,
//                geometries uploaded, buildings assembled…) via count().
//   • spikes   — any frame beyond the spike threshold snapshots its phase
//                timings + counters into a small ring log (last 48).
//
// Contract for new systems (this is the extensible part): if a feature does
// bursty work at runtime, it calls tracer.count("myThing", n). That one line
// is what turns a future "it hitches sometimes" into "myThing=40 on every
// spike frame". Costs nothing when frames are clean.
//
// Read it from the console / probes via __sf.tracer:
//   tracer.spikes            → the ring log, newest last
//   tracer.summary()         → quick stats since last reset
//   tracer.reset()           → clear stats + spikes

export interface HitchSpike {
  /** performance.now() when the spiking frame ENDED (ms) */
  at: number;
  /** the frame's rAF-to-rAF duration (ms) */
  dt: number;
  /** bracketed phase costs for that frame (ms) */
  phases: Record<string, number>;
  /** counters incremented during that frame */
  counts: Record<string, number>;
}

const SPIKE_FLOOR_MS = 20; // never call a frame under this a spike
const SPIKE_EMA_MULT = 2.5; // …or under 2.5× the running mean
const RING = 48;

class HitchTracer {
  spikes: HitchSpike[] = [];
  /** frames observed since reset */
  frames = 0;
  /** running EMA of frame dt (ms) */
  ema = 0;
  /** worst frame since reset (ms) */
  worst = 0;
  /** frames over 33ms since reset */
  over33 = 0;

  #phase = new Map<string, number>(); // name → ms this frame
  #open = new Map<string, number>(); // name → begin() timestamp
  #counts = new Map<string, number>(); // name → n this frame
  #countsTotal = new Map<string, number>(); // name → n since reset

  /** Bracket a tick section. Nesting/overlap is fine; costs one now() each. */
  begin(name: string): void {
    this.#open.set(name, performance.now());
  }
  end(name: string): void {
    const t0 = this.#open.get(name);
    if (t0 === undefined) return;
    this.#open.delete(name);
    this.#phase.set(name, (this.#phase.get(name) ?? 0) + (performance.now() - t0));
  }

  /** Report discrete bursty work (bodies created, geoms uploaded, …). */
  count(name: string, n = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + n);
  }

  /** Close a frame. Call once per rendered frame with the true rAF delta. */
  frame(dtMs: number): void {
    this.frames++;
    this.ema = this.ema === 0 ? dtMs : this.ema + 0.05 * (dtMs - this.ema);
    if (dtMs > this.worst) this.worst = dtMs;
    if (dtMs > 33.4) this.over33++;
    const spiking = dtMs > Math.max(SPIKE_FLOOR_MS, this.ema * SPIKE_EMA_MULT);
    if (spiking) {
      const phases: Record<string, number> = {};
      for (const [k, v] of this.#phase) phases[k] = +v.toFixed(2);
      const counts: Record<string, number> = {};
      for (const [k, v] of this.#counts) counts[k] = v;
      this.spikes.push({ at: performance.now(), dt: +dtMs.toFixed(1), phases, counts });
      if (this.spikes.length > RING) this.spikes.shift();
    }
    for (const [k, v] of this.#counts) this.#countsTotal.set(k, (this.#countsTotal.get(k) ?? 0) + v);
    this.#phase.clear();
    this.#counts.clear();
    // leave #open alone: an unbalanced begin() simply never lands
  }

  summary(): { frames: number; emaMs: number; worstMs: number; over33: number; spikes: number; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    for (const [k, v] of this.#countsTotal) counts[k] = v;
    return { frames: this.frames, emaMs: +this.ema.toFixed(2), worstMs: +this.worst.toFixed(1), over33: this.over33, spikes: this.spikes.length, counts };
  }

  reset(): void {
    this.spikes.length = 0;
    this.frames = 0;
    this.ema = 0;
    this.worst = 0;
    this.over33 = 0;
    this.#countsTotal.clear();
  }
}

/** The app-wide tracer singleton (importing a shared instance keeps call sites
 *  one-liners and avoids threading it through every constructor). */
export const tracer = new HitchTracer();
