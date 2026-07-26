// Procedural per-region groove engine — the replacement for the three baked
// beat stems.
//
// A fixed loop can only ever be the same eight bars in every neighbourhood.
// Here the kit is *synthesized* once off-thread (./percussionWorker) and then
// *performed*: 16/32-step pattern tables, swing and humanize ported straight
// from tools/music/render_stems.py, plus per-bar ghost/drop/fill rolls and
// round-robined sample variants. Two consecutive bars are never identical, and
// crossing a region boundary crossfades one rhythm section into another.
//
// Nothing here fetches — that is the whole point. Buffers are built on the
// first frame the groove is actually wanted and released again after a long
// quiet spell, so an ambient walk that never wants drums never pays for them
// (docs/LAZY_LOADING.md).

import type { PercussionDrumId, PercussionResult } from "./percussionWorker";

export type GrooveKitId =
  | "none"
  | "lofiSwing"
  | "brush"
  | "halfTime"
  | "boom"
  | "latin"
  | "metro"
  | "surf";

export type GrooveFrame = {
  /** blended winner from the region (the director picks). */
  kit: GrooveKitId;
  /** 0..1 target level; 0 means fade out and park. */
  gain: number;
  /** region tempo — changes slowly, taken at bar boundaries. */
  bpm: number;
  /** 0..1; 0.585 is the lo-fi position the baked stems used. */
  swing: number;
  /** 0..1 — thins/fills the pattern without changing the kit. */
  density: number;
  /** 0..1 daylight. */
  bright: number;
};

const LOOKAHEAD = 2.0; // seconds of scheduled bars ahead of ctx time
const CROSSFADE = 3.0; // seconds to hand one region's kit to the next
const UNLOAD_AFTER_QUIET = 60; // release the synthesized buffers (mirrors stems.ts)
const SILENT = 0.004; // at or below this the engine stops scheduling entirely

/* ------------------------------------------------------------------ kits */

type Hit = {
  drum: PercussionDrumId;
  /** step index inside the bar (0..steps-1). */
  step: number;
  vel: number;
  /** which bar of the kit's cycle; undefined = every bar. */
  bar?: number;
  /** 1 = structural, always plays. Lower thins out as `density` falls. */
  weight?: number;
};

export type GrooveKit = {
  label: string;
  /** grid resolution per bar: 16 = 16ths, 32 = 32nds for the fast kits. */
  steps: 16 | 32;
  /** bars in the pattern cycle — 2 lets the son clave state both halves. */
  cycle: number;
  /** how much of the caller's swing this kit uses; 0 = dead straight. */
  swingScale: number;
  /** region tempo × this. halfTime really is half-time, metro really hurries. */
  bpmScale: number;
  /** σ of the timing jitter, seconds. render_stems uses 0.008 throughout. */
  humanize: number;
  /** post-sum tanh drive then the "worn kit" lowpass — render_stems' glue. */
  drive: number;
  toneHz: number;
  gainTrim: number;
  pattern: Hit[];
  ghosts: Hit[];
  fill: Hit[];
  /** a fill takes over the last beat of every Nth bar; 0 disables. */
  fillEvery: number;
};

/** Swung 8ths on a 16-step grid: 0,2,4… with the odd 8ths pushed late. */
const swung8ths = (drum: PercussionDrumId, vel: number, offVel: number): Hit[] =>
  [0, 2, 4, 6, 8, 10, 12, 14].map((step) => ({
    drum,
    step,
    vel: step % 4 === 0 ? vel : offVel,
    weight: step % 4 === 0 ? 0.9 : 0.6
  }));

export const GROOVE_KITS: Record<GrooveKitId, GrooveKit | null> = {
  // silence — no worker load, no scheduling, no nodes
  none: null,

  // the classic swung city kit: what beat-warm.mp3 was (92 BPM, swing 0.585)
  lofiSwing: {
    label: "swung city",
    steps: 16,
    cycle: 1,
    swingScale: 1,
    bpmScale: 1,
    humanize: 0.008,
    drive: 1.25,
    toneHz: 3800,
    gainTrim: 0.5,
    pattern: [
      { drum: "kick", step: 0, vel: 0.92, weight: 1 },
      { drum: "kick", step: 10, vel: 0.72, weight: 0.85 },
      { drum: "rim", step: 4, vel: 0.6, weight: 1 },
      { drum: "rim", step: 12, vel: 0.62, weight: 1 },
      ...swung8ths("shakerClosed", 0.4, 0.32)
    ],
    ghosts: [
      { drum: "kick", step: 7, vel: 0.45, weight: 0.35 },
      { drum: "kick", step: 15, vel: 0.4, weight: 0.25 },
      { drum: "rimSoft", step: 6, vel: 0.14, weight: 0.2 },
      { drum: "rimSoft", step: 14, vel: 0.18, weight: 0.35 },
      { drum: "shakerOpen", step: 14, vel: 0.32, weight: 0.3 }
    ],
    fill: [
      { drum: "kick", step: 12, vel: 0.5, weight: 0.8 },
      { drum: "rimSoft", step: 13, vel: 0.3, weight: 0.7 },
      { drum: "rimSoft", step: 14, vel: 0.34, weight: 0.8 },
      { drum: "rim", step: 15, vel: 0.42, weight: 1 },
      { drum: "shakerOpen", step: 12, vel: 0.3, weight: 0.6 }
    ],
    fillEvery: 4
  },

  // brushed organic kit for parks and trails — beat-brush.mp3's character
  brush: {
    label: "brushed park",
    steps: 16,
    cycle: 1,
    swingScale: 1,
    bpmScale: 1,
    humanize: 0.01,
    drive: 1.15,
    toneHz: 3200,
    gainTrim: 0.5,
    pattern: [
      { drum: "kick", step: 0, vel: 0.48, weight: 1 },
      { drum: "kick", step: 10, vel: 0.3, weight: 0.7 },
      { drum: "brushHit", step: 4, vel: 0.38, weight: 1 },
      { drum: "brushHit", step: 12, vel: 0.4, weight: 1 },
      { drum: "brushSwirl", step: 8, vel: 0.3, weight: 0.6 },
      { drum: "tambourine", step: 4, vel: 0.12, weight: 0.45 },
      { drum: "tambourine", step: 12, vel: 0.14, weight: 0.45 },
      // the dense brushy 16ths render_brush drops ~15 % of
      ...Array.from({ length: 16 }, (_, step): Hit => ({
        drum: "shakerClosed",
        step,
        vel: step % 2 === 0 ? 0.22 : 0.17,
        weight: step % 2 === 0 ? 0.75 : 0.5
      }))
    ],
    ghosts: [
      { drum: "rimSoft", step: 11, vel: 0.18, weight: 0.4 },
      { drum: "brushHit", step: 14, vel: 0.15, weight: 0.3 },
      { drum: "tambourine", step: 7, vel: 0.1, weight: 0.25 },
      { drum: "brushSwirl", step: 0, vel: 0.22, weight: 0.25 }
    ],
    fill: [
      { drum: "brushSwirl", step: 10, vel: 0.34, weight: 0.9 },
      { drum: "tomLo", step: 12, vel: 0.32, weight: 0.8 },
      { drum: "brushHit", step: 14, vel: 0.26, weight: 0.8 },
      { drum: "tambourine", step: 15, vel: 0.2, weight: 0.6 }
    ],
    fillEvery: 8
  },

  // deep sparse night kit — beat-dusk.mp3 at 58 BPM, backbeat on 3
  halfTime: {
    label: "half-time dusk",
    steps: 16,
    cycle: 2,
    swingScale: 0.6,
    bpmScale: 0.63,
    humanize: 0.011,
    drive: 1.25,
    toneHz: 3400,
    gainTrim: 0.55,
    pattern: [
      { drum: "kickDeep", step: 0, vel: 0.92, weight: 1 },
      { drum: "rimSoft", step: 8, vel: 0.55, weight: 1 },
      // the lazy answer only lands on the second bar of the pair
      { drum: "kickDeep", step: 10, vel: 0.62, bar: 1, weight: 0.7 },
      { drum: "shakerOpen", step: 0, vel: 0.3, weight: 0.7 },
      { drum: "shakerOpen", step: 4, vel: 0.24, weight: 0.6 },
      { drum: "shakerOpen", step: 8, vel: 0.28, weight: 0.7 },
      { drum: "shakerOpen", step: 12, vel: 0.24, weight: 0.6 }
    ],
    ghosts: [
      { drum: "kickDeep", step: 7, vel: 0.5, weight: 0.3 },
      { drum: "kickDeep", step: 14, vel: 0.42, weight: 0.25 },
      { drum: "rimSoft", step: 14, vel: 0.18, weight: 0.3 },
      { drum: "shakerOpen", step: 14, vel: 0.2, weight: 0.25 }
    ],
    fill: [
      { drum: "tomLo", step: 12, vel: 0.42, weight: 0.9 },
      { drum: "tomLo", step: 14, vel: 0.36, weight: 0.8 },
      { drum: "kickDeep", step: 15, vel: 0.5, weight: 0.7 }
    ],
    fillEvery: 8
  },

  // heavy dusty boom-bap for industrial/warehouse districts
  boom: {
    label: "boom-bap",
    steps: 16,
    cycle: 2,
    swingScale: 0.55,
    bpmScale: 0.95,
    humanize: 0.008,
    drive: 1.45,
    toneHz: 4200,
    gainTrim: 0.5,
    pattern: [
      { drum: "kick", step: 0, vel: 1, weight: 1 },
      { drum: "kick", step: 6, vel: 0.55, weight: 0.7 },
      { drum: "kick", step: 10, vel: 0.85, weight: 0.85 },
      { drum: "snare", step: 4, vel: 0.85, weight: 1 },
      { drum: "snare", step: 12, vel: 0.88, weight: 1 },
      { drum: "woodblock", step: 14, vel: 0.24, bar: 1, weight: 0.4 },
      ...swung8ths("hatClosed", 0.34, 0.24)
    ],
    ghosts: [
      { drum: "snare", step: 11, vel: 0.2, weight: 0.35 },
      { drum: "snare", step: 15, vel: 0.22, weight: 0.3 },
      { drum: "kick", step: 14, vel: 0.5, weight: 0.3 },
      { drum: "hatOpen", step: 14, vel: 0.35, weight: 0.3 },
      { drum: "woodblock", step: 7, vel: 0.26, weight: 0.25 }
    ],
    fill: [
      { drum: "kick", step: 12, vel: 0.6, weight: 0.8 },
      { drum: "snare", step: 12, vel: 0.4, weight: 0.9 },
      { drum: "snare", step: 13, vel: 0.45, weight: 0.9 },
      { drum: "snare", step: 14, vel: 0.55, weight: 1 },
      { drum: "snare", step: 15, vel: 0.7, weight: 1 },
      { drum: "hatOpen", step: 15, vel: 0.3, weight: 0.6 }
    ],
    fillEvery: 4
  },

  // the Mission: a real 3-2 son clave over a tumbao conga marcha. The clave is
  // a two-bar figure — that is why this kit has cycle 2 and why the pattern
  // tags its clave hits with the bar they belong to.
  latin: {
    label: "son clave",
    steps: 16,
    cycle: 2,
    swingScale: 0.1,
    bpmScale: 1.05,
    humanize: 0.007,
    drive: 1.2,
    toneHz: 5200,
    gainTrim: 0.5,
    pattern: [
      // "3" side: 1, the & of 2, and 4
      { drum: "clave", step: 0, vel: 0.5, bar: 0, weight: 1 },
      { drum: "clave", step: 6, vel: 0.46, bar: 0, weight: 1 },
      { drum: "clave", step: 12, vel: 0.5, bar: 0, weight: 1 },
      // "2" side: beats 2 and 3
      { drum: "clave", step: 4, vel: 0.48, bar: 1, weight: 1 },
      { drum: "clave", step: 8, vel: 0.5, bar: 1, weight: 1 },
      // tumbao: heel/tip on the low drum, slap on 2, the open-tone pair on 4/&4
      { drum: "congaLo", step: 0, vel: 0.22, weight: 0.7 },
      { drum: "congaLo", step: 2, vel: 0.18, weight: 0.55 },
      { drum: "congaHi", step: 4, vel: 0.42, weight: 0.9 },
      { drum: "congaLo", step: 8, vel: 0.22, weight: 0.7 },
      { drum: "congaLo", step: 10, vel: 0.18, weight: 0.55 },
      { drum: "congaHi", step: 12, vel: 0.52, weight: 1 },
      { drum: "congaHi", step: 14, vel: 0.48, weight: 1 },
      // a soft bombo so the groove still lands under the score's low end
      { drum: "kick", step: 0, vel: 0.34, weight: 0.6 },
      ...swung8ths("shakerClosed", 0.26, 0.22)
    ],
    ghosts: [
      { drum: "congaLo", step: 6, vel: 0.16, weight: 0.3 },
      { drum: "congaHi", step: 15, vel: 0.2, weight: 0.25 },
      { drum: "woodblock", step: 6, vel: 0.18, weight: 0.2 },
      { drum: "shakerClosed", step: 3, vel: 0.16, weight: 0.3 },
      { drum: "shakerClosed", step: 7, vel: 0.16, weight: 0.3 },
      { drum: "shakerClosed", step: 11, vel: 0.16, weight: 0.3 },
      { drum: "shakerClosed", step: 15, vel: 0.16, weight: 0.3 }
    ],
    fill: [
      { drum: "congaHi", step: 12, vel: 0.5, weight: 1 },
      { drum: "congaHi", step: 13, vel: 0.46, weight: 0.9 },
      { drum: "congaLo", step: 14, vel: 0.4, weight: 0.9 },
      { drum: "congaHi", step: 15, vel: 0.5, weight: 1 }
    ],
    fillEvery: 8
  },

  // financial district: tight, dry, businesslike. 32nd grid so the hats can run
  // 16ths and the fill can double them without changing the pattern language.
  metro: {
    label: "metro 16ths",
    steps: 32,
    cycle: 1,
    swingScale: 0,
    bpmScale: 1.15,
    humanize: 0.005,
    drive: 1.3,
    toneHz: 6200,
    gainTrim: 0.45,
    pattern: [
      { drum: "kick", step: 0, vel: 0.78, weight: 1 },
      { drum: "kick", step: 20, vel: 0.52, weight: 0.7 },
      { drum: "rim", step: 8, vel: 0.46, weight: 1 },
      { drum: "rim", step: 24, vel: 0.5, weight: 1 },
      ...Array.from({ length: 16 }, (_, i): Hit => {
        const step = i * 2;
        return {
          drum: "hatClosed",
          step,
          vel: step % 8 === 0 ? 0.34 : step % 4 === 0 ? 0.24 : 0.17,
          weight: step % 8 === 0 ? 0.95 : step % 4 === 0 ? 0.75 : 0.6
        };
      })
    ],
    ghosts: [
      { drum: "kick", step: 12, vel: 0.42, weight: 0.3 },
      { drum: "kick", step: 30, vel: 0.35, weight: 0.25 },
      { drum: "rim", step: 22, vel: 0.16, weight: 0.3 },
      { drum: "hatOpen", step: 30, vel: 0.3, weight: 0.3 },
      { drum: "woodblock", step: 16, vel: 0.2, weight: 0.2 }
    ],
    fill: [
      { drum: "kick", step: 24, vel: 0.6, weight: 0.9 },
      ...Array.from({ length: 8 }, (_, i): Hit => ({
        drum: "hatClosed",
        step: 24 + i,
        vel: 0.26,
        weight: 0.85
      })),
      { drum: "rim", step: 31, vel: 0.4, weight: 1 }
    ],
    fillEvery: 8
  },

  // beaches: toms and wash instead of a backbeat. Slow, loose (2.5× the normal
  // timing jitter) and deliberately hard to tap your foot to.
  surf: {
    label: "surf wash",
    steps: 16,
    cycle: 2,
    swingScale: 0.75,
    bpmScale: 0.72,
    humanize: 0.02,
    drive: 1.1,
    toneHz: 3000,
    gainTrim: 0.45,
    pattern: [
      { drum: "kick", step: 0, vel: 0.4, weight: 0.9 },
      { drum: "tomLo", step: 0, vel: 0.46, weight: 0.8 },
      { drum: "splash", step: 6, vel: 0.3, weight: 0.6 },
      { drum: "brushSwirl", step: 8, vel: 0.3, weight: 0.7 },
      { drum: "tomLo", step: 9, vel: 0.34, weight: 0.55 },
      { drum: "kick", step: 11, vel: 0.24, weight: 0.4 },
      { drum: "tomLo", step: 13, vel: 0.28, bar: 1, weight: 0.45 }
    ],
    ghosts: [
      { drum: "tomLo", step: 4, vel: 0.24, weight: 0.3 },
      { drum: "splash", step: 12, vel: 0.26, weight: 0.3 },
      { drum: "brushSwirl", step: 2, vel: 0.2, weight: 0.25 },
      { drum: "tomLo", step: 15, vel: 0.22, weight: 0.25 },
      { drum: "shakerOpen", step: 14, vel: 0.18, weight: 0.2 }
    ],
    fill: [
      { drum: "tomLo", step: 8, vel: 0.34, weight: 0.8 },
      { drum: "tomLo", step: 10, vel: 0.38, weight: 0.9 },
      { drum: "tomLo", step: 12, vel: 0.42, weight: 1 },
      { drum: "splash", step: 14, vel: 0.34, weight: 0.9 }
    ],
    fillEvery: 4
  }
};

export const GROOVE_KIT_IDS = Object.keys(GROOVE_KITS) as GrooveKitId[];

/* ------------------------------------------------------------- kit seats */

/** Level balance between voices. The worker normalizes each drum to the same
 *  headroom, so this table is where the kit is actually mixed. */
const DRUM_TRIM: Record<PercussionDrumId, number> = {
  kick: 1,
  kickDeep: 1,
  rim: 0.8,
  rimSoft: 0.75,
  snare: 0.85,
  brushHit: 0.9,
  brushSwirl: 0.7,
  hatClosed: 0.5,
  hatOpen: 0.45,
  shakerClosed: 0.55,
  shakerOpen: 0.5,
  congaLo: 0.8,
  congaHi: 0.75,
  clave: 0.55,
  woodblock: 0.6,
  tomLo: 0.85,
  tambourine: 0.45,
  splash: 0.42
};

/** Where each voice sits in the image (render_stems' pans, extended). */
const DRUM_PAN: Record<PercussionDrumId, number> = {
  kick: -0.05,
  kickDeep: -0.05,
  rim: 0.12,
  rimSoft: 0.18,
  snare: 0.04,
  brushHit: 0.1,
  brushSwirl: 0.28,
  hatClosed: 0.26,
  hatOpen: 0.3,
  shakerClosed: 0.3,
  shakerOpen: 0.32,
  congaLo: -0.22,
  congaHi: 0.24,
  clave: 0.34,
  woodblock: -0.3,
  tomLo: -0.26,
  tambourine: 0.38,
  splash: -0.36
};

/** Daylight lifts the airy top of the kit; the low end stays put, so the
 *  groove gets brighter through the day rather than louder. */
const AIR_DRUMS: ReadonlySet<PercussionDrumId> = new Set<PercussionDrumId>([
  "hatClosed",
  "hatOpen",
  "shakerClosed",
  "shakerOpen",
  "tambourine",
  "splash",
  "brushSwirl"
]);

/* ---------------------------------------------------------------- player */

type Slot = {
  kit: GrooveKitId;
  /** hits land here; saturation and the kit lowpass sit downstream. */
  input: GainNode;
  shaper: WaveShaperNode;
  tone: BiquadFilterNode;
  /** crossfade level (equal-power), NOT the master gain. */
  fade: GainNode;
  level: number;
  target: number;
  bar: number;
  /** ctx time of the next unscheduled downbeat. */
  nextBarT: number;
  bpm: number;
  prevSig: string;
  sources: Set<AudioBufferSourceNode>;
};

export class GroovePlayer {
  #ctx: AudioContext;
  #out: GainNode;
  #slots: [Slot, Slot];
  #active = 0;
  #buffers: Map<PercussionDrumId, AudioBuffer[]> | null = null;
  #roundRobin = new Map<PercussionDrumId, number>();
  #worker: Worker | null = null;
  #loadToken: symbol | null = null;
  #failed = false;
  #bytes = 0;
  #quietSeconds = 0;
  #barsScheduled = 0;
  // frame state
  #kitWanted: GrooveKitId = "none";
  #gain = 0;
  #bpm = 92;
  #swing = 0.585;
  #density = 1;
  #bright = 1;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.#ctx = ctx;
    this.#out = ctx.createGain();
    this.#out.gain.value = 0;
    this.#out.connect(destination);
    this.#slots = [this.#makeSlot(), this.#makeSlot()];
  }

  get debugState() {
    return {
      kit: this.#kitWanted,
      gain: +this.#gain.toFixed(3),
      bpm: +this.#bpm.toFixed(1),
      swing: +this.#swing.toFixed(3),
      density: +this.#density.toFixed(2),
      ready: Boolean(this.#buffers),
      loading: this.#loadToken !== null,
      failed: this.#failed,
      bytes: this.#bytes,
      barsScheduled: this.#barsScheduled,
      quiet: +this.#quietSeconds.toFixed(1),
      slots: this.#slots.map((s) => ({
        kit: s.kit,
        level: +s.level.toFixed(3),
        bar: s.bar,
        bpm: +s.bpm.toFixed(1),
        sources: s.sources.size
      }))
    };
  }

  /** Per-frame. `now` is ctx.currentTime. */
  update(dt: number, now: number, o: GrooveFrame): void {
    const step = Math.max(0, dt);
    this.#kitWanted = o.kit;
    this.#gain = clamp01(o.gain);
    this.#swing = clamp01(o.swing);
    this.#density = clamp01(o.density);
    this.#bright = clamp01(o.bright);
    // tempo glides continuously but is only *read* when a bar is laid out, so
    // a moving region tempo bends the groove instead of shearing it
    const wantBpm = Math.min(200, Math.max(40, o.bpm));
    this.#bpm += (wantBpm - this.#bpm) * (1 - Math.exp(-step * 0.5));

    this.#out.gain.setTargetAtTime(this.#gain, now, 0.9);

    const wanted = this.#gain > SILENT && o.kit !== "none";
    if (!wanted) {
      // park: stop scheduling, let already-scheduled tails ring out
      this.#quietSeconds += step;
      for (const slot of this.#slots) slot.target = 0;
      this.#crossfade(step, now);
      if (this.#quietSeconds >= UNLOAD_AFTER_QUIET) this.#release();
      return;
    }
    this.#quietSeconds = 0;

    if (!this.#buffers && this.#loadToken === null && !this.#failed) void this.#build();
    this.#applyKitRequest(now);
    this.#crossfade(step, now);
    if (!this.#buffers) return;

    for (const slot of this.#slots) {
      // an outgoing kit takes no new bars — the ones already scheduled finish
      // under the fade, which is what "finishes its current bar" means here
      if (slot.target <= 0) continue;
      const kit = GROOVE_KITS[slot.kit];
      if (!kit) continue;
      slot.tone.frequency.setTargetAtTime(kit.toneHz * (0.78 + 0.44 * this.#bright), now, 1.2);
      if (slot.nextBarT < now - 0.05) {
        slot.nextBarT = now + 0.08; // resumed after a quiet spell
        slot.bar = 0;
      }
      while (slot.nextBarT < now + LOOKAHEAD) this.#scheduleBar(slot, kit);
    }
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#loadToken = null;
    this.#buffers = null;
    for (const slot of this.#slots) {
      this.#stopSlot(slot);
      slot.input.disconnect();
      slot.shaper.disconnect();
      slot.tone.disconnect();
      slot.fade.disconnect();
    }
    this.#out.disconnect();
  }

  /* --------------------------------------------------------------- graph */

  #makeSlot(): Slot {
    const ctx = this.#ctx;
    const input = ctx.createGain();
    // render_stems glued its mix with tanh saturation then a "worn kit"
    // lowpass; the same two stages sit on every slot's sum here
    const shaper = ctx.createWaveShaper();
    shaper.curve = tanhCurve(1.25);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3800;
    tone.Q.value = 0.4;
    const fade = ctx.createGain();
    fade.gain.value = 0;
    input.connect(shaper).connect(tone).connect(fade).connect(this.#out);
    return {
      kit: "none",
      input,
      shaper,
      tone,
      fade,
      level: 0,
      target: 0,
      bar: 0,
      nextBarT: 0,
      bpm: 92,
      prevSig: "",
      sources: new Set()
    };
  }

  /** Hand the requested kit to the free slot and start the crossfade. */
  #applyKitRequest(now: number): void {
    const active = this.#slots[this.#active];
    if (active.kit === this.#kitWanted) return;
    const other = this.#slots[1 - this.#active];
    if (other.kit === this.#kitWanted) {
      // flip-flopping across a boundary — hand it back mid-fade rather than
      // restarting the pattern from bar 0
      this.#swapActive();
      return;
    }
    if (other.level > 0.03) return; // still fading out; take the swap next frame
    const kit = GROOVE_KITS[this.#kitWanted];
    other.kit = this.#kitWanted;
    other.bar = 0;
    other.prevSig = "";
    other.bpm = this.#bpm * (kit?.bpmScale ?? 1);
    // the incoming kit starts on the outgoing kit's next downbeat, so a region
    // crossing never lands two conflicting "1"s on top of each other
    other.nextBarT = active.nextBarT > now + 0.05 ? active.nextBarT : 0;
    other.tone.frequency.value = (kit?.toneHz ?? 3800) * (0.78 + 0.44 * this.#bright);
    other.shaper.curve = tanhCurve(kit?.drive ?? 1.25); // reshaped, not rewired
    this.#swapActive();
  }

  #swapActive(): void {
    this.#active = 1 - this.#active;
    this.#slots[this.#active].target = 1;
    this.#slots[1 - this.#active].target = 0;
  }

  /** Equal-power crossfade — the two kits are uncorrelated, so summing their
   *  powers (not their amplitudes) is what keeps the level steady. */
  #crossfade(dt: number, now: number): void {
    const stepSize = dt / CROSSFADE;
    for (const slot of this.#slots) {
      const delta = slot.target - slot.level;
      slot.level += Math.sign(delta) * Math.min(Math.abs(delta), stepSize);
      slot.fade.gain.setTargetAtTime(Math.sqrt(Math.max(0, slot.level)), now, 0.12);
    }
  }

  /* ----------------------------------------------------------- scheduler */

  #scheduleBar(slot: Slot, kit: GrooveKit): void {
    slot.bpm = this.#bpm * kit.bpmScale; // tempo is taken once, at the downbeat
    const beat = 60 / slot.bpm;
    const barSeconds = 4 * beat;
    const cycleBar = slot.bar % kit.cycle;
    const swing = 0.5 + (this.#swing - 0.5) * kit.swingScale;
    const density = this.#density;

    const filling =
      kit.fillEvery > 0 &&
      (slot.bar + 1) % kit.fillEvery === 0 &&
      Math.random() < 0.55 + 0.4 * density;
    const fillFrom = kit.steps * 0.75; // the fill takes over the last beat

    const chosen: Hit[] = [];
    const roll = (hit: Hit): void => {
      if (hit.bar !== undefined && hit.bar !== cycleBar) return;
      const weight = hit.weight ?? 0.85;
      if (weight < 0.999 && Math.random() >= Math.min(1, weight + density * (1 - weight) * 1.6)) {
        return;
      }
      chosen.push(hit);
    };

    for (const hit of kit.pattern) {
      if (filling && hit.step >= fillFrom) continue;
      roll(hit);
    }
    for (const hit of kit.ghosts) {
      if (hit.bar !== undefined && hit.bar !== cycleBar) continue;
      // render_stems rolled its ghosts at 0.25–0.35 × density; same order here
      if (Math.random() < 0.35 * density * (hit.weight ?? 0.3) * 2.4) chosen.push(hit);
    }
    if (filling) for (const hit of kit.fill) roll(hit);

    // Two identical bars in a row is precisely what a loop sounds like. Force a
    // mutation rather than hoping the dice disagree.
    const signature = chosen.map((h) => `${h.drum}${h.step}`).join(",");
    if (signature === slot.prevSig && chosen.length > 1) {
      const index = Math.floor(Math.random() * chosen.length);
      if ((chosen[index].weight ?? 0.85) < 0.999) chosen.splice(index, 1);
      else if (kit.ghosts.length > 0) {
        chosen.push(kit.ghosts[Math.floor(Math.random() * kit.ghosts.length)]);
      }
    }
    slot.prevSig = signature;

    const voiced = chosen.map((hit) => {
      const step = hit.step % kit.steps;
      const stepBeats = step * (4 / kit.steps) + swingOffset(step, kit.steps, swing);
      // ±8 ms Gaussian-ish timing, ±15 % velocity — render_stems' humanize
      const at = slot.nextBarT + stepBeats * beat + gaussish() * kit.humanize;
      const wave = 1 + 0.16 * Math.sin(step * 1.1 + slot.bar);
      const air = AIR_DRUMS.has(hit.drum) ? 0.9 + 0.25 * this.#bright : 1;
      return {
        drum: hit.drum,
        at: Math.max(at, slot.nextBarT - 0.03),
        vel: hit.vel * DRUM_TRIM[hit.drum] * kit.gainTrim * wave * air * (0.85 + 0.3 * Math.random())
      };
    });
    // ghosts and fills were appended out of order; the round-robin only avoids
    // a repeat if it advances in the order the ear actually hears the hits
    voiced.sort((a, b) => a.at - b.at);
    for (const hit of voiced) this.#playHit(slot, hit.drum, hit.at, hit.vel);

    slot.nextBarT += barSeconds;
    slot.bar++;
    this.#barsScheduled++;
  }

  #playHit(slot: Slot, drum: PercussionDrumId, at: number, vel: number): void {
    const bank = this.#buffers?.get(drum);
    if (!bank || bank.length === 0 || vel <= 0.0005) return;
    const ctx = this.#ctx;
    const src = ctx.createBufferSource();
    src.buffer = bank[this.#nextVariant(drum, bank.length)];
    // the last tell of a sampled kit is identical pitch on every hit
    src.playbackRate.value = 0.975 + Math.random() * 0.05;
    const gain = ctx.createGain();
    gain.gain.value = vel;
    const panner = ctx.createStereoPanner();
    panner.pan.value = clampPan(DRUM_PAN[drum] + (Math.random() - 0.5) * 0.16);
    src.connect(gain).connect(panner).connect(slot.input);
    src.onended = () => {
      slot.sources.delete(src);
      try {
        src.disconnect();
        gain.disconnect();
        panner.disconnect();
      } catch {
        /* already gone */
      }
    };
    slot.sources.add(src);
    // Humanize can push the first hit of the very first bar before the clock's
    // origin, and a negative start time throws (killing the rest of the bar).
    // A past time is legal and means "now", which is the right answer anyway.
    src.start(Math.max(at, ctx.currentTime));
  }

  /** Never the buffer that just sounded — the repeat is the drum-machine tell. */
  #nextVariant(drum: PercussionDrumId, count: number): number {
    const prev = this.#roundRobin.get(drum) ?? -1;
    let next = (prev + 1) % count;
    if (count > 2 && Math.random() < 0.4) next = (next + 1) % count;
    if (next === prev) next = (next + 1) % count;
    this.#roundRobin.set(drum, next);
    return next;
  }

  /* ----------------------------------------------------------- residency */

  async #build(): Promise<void> {
    const ctx = this.#ctx;
    const token = Symbol("percussion");
    this.#loadToken = token;
    try {
      const result = await new Promise<PercussionResult>((resolve, reject) => {
        const worker = new Worker(new URL("./percussionWorker.ts", import.meta.url), {
          type: "module"
        });
        this.#worker = worker;
        const finish = (): void => {
          worker.terminate();
          if (this.#worker === worker) this.#worker = null;
        };
        worker.onmessage = (event: MessageEvent<PercussionResult>) => {
          finish();
          resolve(event.data);
        };
        worker.onerror = (event) => {
          finish();
          reject(new Error(event.message || "percussion worker failed"));
        };
        worker.postMessage({ sampleRate: ctx.sampleRate });
      });
      if (this.#loadToken !== token || ctx.state === "closed") return; // released mid-synthesis
      const banks = new Map<PercussionDrumId, AudioBuffer[]>();
      const entries = Object.entries(result.variants) as [PercussionDrumId, ArrayBuffer[]][];
      for (const [id, takes] of entries) {
        banks.set(
          id,
          takes.map((raw) => {
            const data = new Float32Array(raw);
            const buffer = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
            buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
            return buffer;
          })
        );
      }
      this.#buffers = banks;
      this.#bytes = result.bytes;
    } catch (error) {
      if (this.#loadToken === token) this.#failed = true;
      console.warn("[lofi-music] percussion synthesis failed:", error);
    } finally {
      if (this.#loadToken === token) this.#loadToken = null;
    }
  }

  #release(): void {
    if (!this.#buffers && this.#loadToken === null && !this.#failed) return;
    this.#worker?.terminate();
    this.#worker = null;
    this.#loadToken = null; // any synthesis in flight is abandoned by the token check
    this.#buffers = null;
    this.#bytes = 0;
    this.#failed = false; // a later approach may retry
    this.#roundRobin.clear();
    for (const slot of this.#slots) {
      this.#stopSlot(slot);
      slot.kit = "none";
      slot.level = 0;
      slot.target = 0;
      slot.bar = 0;
      slot.nextBarT = 0;
      slot.prevSig = "";
    }
  }

  #stopSlot(slot: Slot): void {
    for (const src of slot.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
    }
    slot.sources.clear();
  }
}

/* --------------------------------------------------------------- helpers */

const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0);
const clampPan = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Gaussian-ish: mean of three uniforms scaled to σ = 1. render_stems draws a
 *  true normal; the tails past ±3σ are inaudible as timing jitter either way. */
function gaussish(): number {
  return ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 6;
}

/**
 * Beats to push a step late. Mirrors render_stems exactly: the off-8th sits at
 * `swing` (0.585) inside its pair, and a 16th pair gets half that offset.
 */
function swingOffset(step: number, steps: number, swing: number): number {
  const per8 = steps / 8;
  const per16 = steps / 16;
  if (step % (per8 * 2) === per8) return swing - 0.5;
  if (per16 >= 1 && step % (per16 * 2) === per16) return (swing - 0.5) * 0.5;
  return 0;
}

/** tanh(x·drive)/tanh(drive) as a WaveShaper curve — render_stems' saturate(). */
function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) * norm;
  }
  return curve;
}
