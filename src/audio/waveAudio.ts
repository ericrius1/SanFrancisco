// Ocean wave audio — a reusable environmental layer for anywhere the world has
// breaking or lapping water. It rides the shared NatureSoundscape AudioContext
// (voiceBus) so it respects the HUD World volume/mute and the browser's one-context
// budget, and it keeps that context awake while the player is near water.
//
// Two voices, both driven by a single `energy` signal (0 calm … 1 heavy surf):
//   · wash    — a continuous filtered-noise sea hiss, brighter/louder with energy
//   · breaker — periodic swelling crashes (a set marching in), panned across the
//               break, their cadence + weight scaling with energy
//
// The energy is computed by `oceanWaveEnergyAt()`, which any system can call: it
// reads the authored Ocean Beach surf field plus generic shoreline proximity, so
// boating past the break, swimming, or standing on the sand all get the right bed.

import { oceanBeachMask, sampleOceanBeachWave } from "../world/oceanBeachWaves";
import type { WorldMap } from "../world/heightmap";
import type { NatureSoundscape } from "./natureSoundscape";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export type WaveEnergy = {
  /** overall loudness of the sea bed here, 0..1 */
  level: number;
  /** share of that which is heavy breaking surf (vs gentle wash), 0..1 */
  breaking: number;
};

/**
 * Reusable: how much wave sound belongs at (x,z) right now. Ocean Beach's
 * analytic surf drives strong breaking energy; elsewhere a gentle wash fades in
 * near any shoreline (water on one side, land close on the other).
 */
export function oceanWaveEnergyAt(map: WorldMap, x: number, z: number, t: number): WaveEnergy {
  const surf = oceanBeachMask(x, z);
  let breaking = 0;
  let wash = 0;
  if (surf > 0.01) {
    const s = sampleOceanBeachWave(x, z, t);
    breaking = surf * clamp01(0.35 + s.lip * 0.9 + s.face * 0.5);
    wash = surf * 0.7;
  }
  // Generic shoreline wash: strong when you straddle the waterline (water near
  // on one side, dry land near on the other) — a beach, a bank, a seawall.
  const here = map.isWater(x, z);
  const R = 26;
  let waterN = 0;
  let landN = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const wx = x + Math.cos(a) * R;
    const wz = z + Math.sin(a) * R;
    if (map.isWater(wx, wz)) waterN++;
    else landN++;
  }
  const shore = Math.min(waterN, landN) / 3; // 0 fully inland/open water … 1 right on the edge
  const nearWater = here || waterN > 0;
  wash = Math.max(wash, nearWater ? clamp01(shore) * 0.5 : 0);
  const level = clamp01(Math.max(breaking, wash));
  return { level, breaking: level > 0.001 ? clamp01(breaking / level) : 0 };
}

export class WaveAudio {
  #nature: NatureSoundscape;
  #ready = false;
  #ctx: AudioContext | null = null;
  #out: GainNode | null = null;

  // continuous wash
  #washGain: GainNode | null = null;
  #washFilter: BiquadFilterNode | null = null;

  // breaking-crash scheduler
  #noise: AudioBuffer | null = null;
  #reverb: GainNode | null = null;
  #crashTimer = 1.5;
  #level = 0; // smoothed energy
  #breaking = 0;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  #init() {
    if (this.#ready) return this.#ctx;
    const vb = this.#nature.voiceBus();
    if (!vb) return null;
    const { ctx, worldBus, worldReverbSend, noise } = vb;
    this.#ctx = ctx;
    this.#noise = noise;
    this.#reverb = worldReverbSend;
    // Waves ride the presence-independent bus: the sea is heard at the coast even
    // when the inland nature bed has faded out.
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(worldBus);
    this.#out = out;

    // continuous wash: looped noise through a gentle low/band shelf
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 0.4;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    src.connect(filter);
    filter.connect(wg);
    wg.connect(out);
    src.start();
    this.#washGain = wg;
    this.#washFilter = filter;

    this.#ready = true;
    return ctx;
  }

  /** Per frame. `energy` is the local wave energy (see oceanWaveEnergyAt). */
  update(dt: number, energy: WaveEnergy) {
    const target = energy.level;
    // keep the shared context alive while there's meaningful sea near us
    this.#nature.setExternalAwake(target > 0.02);
    if (target <= 0.001 && this.#level <= 0.002) {
      if (this.#washGain && this.#ctx) this.#washGain.gain.setTargetAtTime(0, this.#ctx.currentTime, 0.2);
      this.#level = 0;
      return;
    }
    const ctx = this.#init();
    if (!ctx || !this.#washGain) return;
    if (ctx.state === "suspended") return; // waits for the first user gesture

    // smooth the energy so walking in/out of range doesn't click
    this.#level += (target - this.#level) * Math.min(1, dt * 2.5);
    this.#breaking += (energy.breaking - this.#breaking) * Math.min(1, dt * 2);
    const now = ctx.currentTime;

    // wash gets louder + brighter with energy
    this.#washGain.gain.setTargetAtTime(0.05 + this.#level * 0.22, now, 0.1);
    if (this.#washFilter) this.#washFilter.frequency.setTargetAtTime(650 + this.#level * 1500, now, 0.1);

    // schedule breaking crashes — cadence tightens with energy, weighted by the
    // breaking share (gentle shores wash but rarely "crash")
    this.#crashTimer -= dt;
    if (this.#crashTimer <= 0) {
      const heavy = this.#level * (0.4 + this.#breaking * 0.6);
      if (heavy > 0.06) this.#crash(ctx, heavy);
      // 2.2–5.5 s between sets, faster when the surf is up
      this.#crashTimer = 2.2 + (1 - this.#level) * 3.3 + Math.random() * 1.4;
    }
  }

  #crash(ctx: AudioContext, weight: number) {
    if (!this.#noise || !this.#out) return;
    const now = ctx.currentTime;
    const w = clamp01(weight);
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    // a lowpass that opens as the wave pitches then closes as it washes out
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, now);
    lp.frequency.linearRampToValueAtTime(1600 + w * 1800, now + 0.35);
    lp.frequency.exponentialRampToValueAtTime(240, now + 1.4 + w);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.12 + w * 0.3, now + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5 + w);
    // spread the sets across the stereo field
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.7;
    src.connect(lp);
    lp.connect(g);
    g.connect(pan);
    pan.connect(this.#out);
    if (this.#reverb) g.connect(this.#reverb);
    src.start(now, Math.random() * 1.5, 2.8 + w);
    src.stop(now + 2.8 + w);
  }
}
