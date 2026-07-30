// Ocean wave audio — a reusable environmental layer for anywhere the world has
// breaking or lapping water. It rides the shared NatureSoundscape AudioContext
// (voiceBus) so it respects the HUD World volume/mute and the browser's one-context
// budget, and it keeps that context awake while the player is near water.
//
// Three voices:
//   · wash    — a continuous filtered-noise sea hiss, brighter/louder with energy
//   · crash   — a wave BREAKING, fired when a crest actually reaches the break
//               line, at that crest's own place on the beach
//   · swash   — the same wave arriving at the sand, ten-odd seconds later
//
// The crashes are the point. They used to come off a free-running 2.2–5.5 s
// timer with a random pan, which meant the sea you were watching and the sea
// you were hearing were unrelated signals: a wall could stand up and dump in
// front of you in silence while a crash arrived from empty water behind your
// shoulder. Now a set of listening posts along the beach watch the shared
// analytic crest train cross the shared analytic break line
// (world/oceanBeachWaves), and every crash is one particular wave going off at
// one particular place — panned by where that place is, attenuated by how far
// away it is, and delayed by how long the sound takes to cover the distance.
// The irregular rhythm of real surf comes out of the geometry for free: the
// break line wanders along the beach over a couple of hundred metres, so
// neighbouring stretches go seconds apart instead of all at once.
//
// The continuous bed is still driven by `oceanWaveEnergyAt()`, which any system
// can call: it reads the authored Ocean Beach surf field plus generic shoreline
// proximity, so boating past the break, swimming, or standing on the sand all
// get the right wash.

import {
  OCEAN_BEACH_SURF,
  oceanBeachApproxShoreX,
  oceanBeachBreakX,
  oceanBeachMask,
  nearestOceanBeachCrest,
  sampleOceanBeachWave
} from "../world/oceanBeachWaves";
import type { WorldMap } from "../world/heightmap";
import type { NatureSoundscape } from "./natureSoundscape";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Metres per second, dry air. Two hundred metres of beach is most of a second. */
const SPEED_OF_SOUND = 343;

/** Listening posts: how far apart along the beach, and how many. */
const POST_SPACING = 105;
const POST_COUNT = 9;
/** Past this the crash is inaudible against the wash; skip the scheduling. */
const MAX_AUDIBLE = 760;

export type WaveEnergy = {
  /** overall loudness of the sea bed here, 0..1 */
  level: number;
  /** share of that which is heavy breaking surf (vs gentle wash), 0..1 */
  breaking: number;
};

/** Where the ears are, and which way is right — enough to place a crash. */
export type WaveListener = {
  x: number;
  z: number;
  /** Unit world XZ vector pointing to the listener's right. */
  rightX: number;
  rightZ: number;
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

/**
 * One stretch of beach being watched. `z` snaps to a fixed lattice so that
 * walking along the sand does not slide a post's phase and manufacture
 * crossings that no wave made; when a post does jump to a new cell its history
 * is dropped and it stays quiet for one wave.
 */
type Post = {
  z: number;
  /** crestX − breakX last frame; NaN until the post has a history. */
  breakGap: number;
  /** crestX − waterline last frame. */
  shoreGap: number;
};

export class WaveAudio {
  #nature: NatureSoundscape;
  #ready = false;
  #ctx: AudioContext | null = null;
  #out: GainNode | null = null;

  // continuous wash
  #washSource: AudioBufferSourceNode | null = null;
  #washGain: GainNode | null = null;
  #washFilter: BiquadFilterNode | null = null;
  #releaseNatureHold: (() => void) | null = null;
  #silentSeconds = 0;

  // break watcher
  #noise: AudioBuffer | null = null;
  #reverb: GainNode | null = null;
  #posts: Post[] = [];
  #level = 0; // smoothed energy
  #breaking = 0;
  #crashes = 0; // fired this session, for the debug surface
  #live = 0; // crashes currently ringing, so a teleport cannot storm the graph

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  get debugState() {
    return {
      ready: this.#ready,
      level: this.#level,
      breaking: this.#breaking,
      washGain: this.#washGain?.gain.value ?? 0,
      washRunning: this.#washSource !== null,
      holdingContext: this.#releaseNatureHold !== null,
      posts: this.#posts.map((p) => Math.round(p.z)),
      crashes: this.#crashes,
      live: this.#live
    };
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

    // continuous wash graph; its source is started only while water is audible
    // and stopped after the crash tail clears.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 0.4;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    filter.connect(wg);
    wg.connect(out);
    this.#washGain = wg;
    this.#washFilter = filter;

    this.#ready = true;
    return ctx;
  }

  /**
   * Per frame. `energy` is the local wave energy (see oceanWaveEnergyAt);
   * `listener` places and pans the breaking events, and is normally the camera
   * rather than the body — in a scripted shot they are hundreds of metres
   * apart and the ears belong with the lens.
   */
  update(dt: number, energy: WaveEnergy, listener: WaveListener, time: number) {
    const target = energy.level;
    if (target > 0.02) {
      this.#releaseNatureHold ??= this.#nature.acquireExternalHold("ocean-waves");
      this.#silentSeconds = 0;
    } else if (this.#releaseNatureHold) {
      // A breaker can ring for almost six seconds after local energy vanishes.
      // Keep the lease through that tail, then park the source and context.
      this.#silentSeconds += Math.max(0, dt);
      if (this.#silentSeconds >= 6.5) {
        this.#releaseNatureHold();
        this.#releaseNatureHold = null;
        this.#stopWash();
      }
    }
    if (target <= 0.001 && this.#level <= 0.002 && !this.#ctx) {
      return;
    }
    const ctx = this.#init();
    if (!ctx || !this.#washGain) return;
    if (target > 0.02) this.#startWash(ctx);
    if (ctx.state === "suspended") return; // waits for the first user gesture

    // smooth the energy so walking in/out of range doesn't click
    this.#level += (target - this.#level) * Math.min(1, dt * 2.5);
    this.#breaking += (energy.breaking - this.#breaking) * Math.min(1, dt * 2);
    const now = ctx.currentTime;

    // No fixed noise floor: as wave energy fades, the wash reaches actual
    // silence instead of leaving a permanent filtered hiss in enclosed sites.
    this.#washGain.gain.setTargetAtTime(this.#level * (0.05 + this.#level * 0.22), now, 0.1);
    if (this.#washFilter) this.#washFilter.frequency.setTargetAtTime(650 + this.#level * 1500, now, 0.1);

    if (target <= 0.001 && this.#level <= 0.002) {
      this.#level = 0;
      this.#breaking = 0;
      return;
    }

    this.#watchBreaks(ctx, listener, time);
  }

  dispose(): void {
    this.#releaseNatureHold?.();
    this.#releaseNatureHold = null;
    this.#stopWash();
    this.#washGain?.disconnect();
    this.#washFilter?.disconnect();
    this.#out?.disconnect();
    this.#washGain = null;
    this.#washFilter = null;
    this.#out = null;
    this.#ctx = null;
    this.#ready = false;
    this.#posts.length = 0;
  }

  /**
   * Walk the listening posts and fire on the frames where a crest crosses a
   * line. Costs nine analytic crest solves a frame — about the same as one
   * water-height query, and nothing at all when the listener is off the beach.
   */
  #watchBreaks(ctx: AudioContext, listener: WaveListener, time: number) {
    const b = OCEAN_BEACH_SURF;
    if (
      listener.z < b.minZ - 500 ||
      listener.z > b.maxZ + 500 ||
      listener.x < b.minX - 900 ||
      listener.x > b.maxX + 700
    ) {
      this.#posts.length = 0;
      return;
    }
    if (this.#posts.length !== POST_COUNT) {
      this.#posts = Array.from({ length: POST_COUNT }, () => ({
        z: NaN,
        breakGap: NaN,
        shoreGap: NaN
      }));
    }
    const middle = (POST_COUNT - 1) / 2;
    for (let i = 0; i < POST_COUNT; i++) {
      const post = this.#posts[i];
      // Snap to a fixed world lattice, offset by the post's index. A post that
      // moves cell forgets its history rather than inventing a crossing out of
      // the discontinuity.
      const wanted =
        Math.round((listener.z + (i - middle) * POST_SPACING) / POST_SPACING) * POST_SPACING;
      const z = Math.min(b.maxZ - 60, Math.max(b.minZ + 60, wanted));
      if (z !== post.z) {
        post.z = z;
        post.breakGap = NaN;
        post.shoreGap = NaN;
      }

      const breakX = oceanBeachBreakX(z, time);
      // `nearestOceanBeachCrest` reports x − crestX, so negate for "how far
      // past the line the crest has come".
      const breakGap = -nearestOceanBeachCrest(breakX, z, time).distance;
      // Ten metres outside the waterline: where the bore finally lands.
      const shoreLine = oceanBeachApproxShoreX(z) - 10;
      const shoreGap = -nearestOceanBeachCrest(shoreLine, z, time).distance;

      const dx = breakX - listener.x;
      const dz = z - listener.z;
      const distance = Math.hypot(dx, dz);
      if (
        Number.isFinite(post.breakGap) &&
        post.breakGap < 0 &&
        breakGap >= 0 &&
        distance < MAX_AUDIBLE
      ) {
        const wave = sampleOceanBeachWave(breakX, z, time);
        this.#crash(ctx, listener, breakX, z, distance, wave.amplitude * wave.mask);
      }
      if (
        Number.isFinite(post.shoreGap) &&
        post.shoreGap < 0 &&
        shoreGap >= 0 &&
        distance < MAX_AUDIBLE * 0.6
      ) {
        const sx = shoreLine;
        const sd = Math.hypot(sx - listener.x, dz);
        this.#swash(ctx, listener, sx, z, sd, oceanBeachMask(breakX, z));
      }
      post.breakGap = breakGap;
      post.shoreGap = shoreGap;
    }
  }

  /** Where a point on the beach sits in the stereo field, −1 … 1. */
  #panFor(listener: WaveListener, x: number, z: number, distance: number): number {
    if (distance < 1) return 0;
    const pan = ((x - listener.x) * listener.rightX + (z - listener.z) * listener.rightZ) / distance;
    // Never hard-panned: a wave is a wide source, and the sea in front of you
    // is not a point in one ear.
    return Math.max(-0.75, Math.min(0.75, pan * 0.85));
  }

  #startWash(ctx: AudioContext): void {
    if (this.#washSource || !this.#noise || !this.#washFilter) return;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    src.connect(this.#washFilter);
    src.start(0, Math.random() * Math.max(0.01, this.#noise.duration));
    this.#washSource = src;
  }

  #stopWash(): void {
    try { this.#washSource?.stop(); } catch { /* already stopped */ }
    this.#washSource?.disconnect();
    this.#washSource = null;
    if (this.#washGain && this.#ctx) {
      this.#washGain.gain.cancelScheduledValues(this.#ctx.currentTime);
      this.#washGain.gain.value = 0;
    }
  }

  /** Bookkeeping so a scrub or a teleport can never leave a node storm behind. */
  #retire(nodes: AudioNode[]): void {
    this.#live--;
    for (const node of nodes) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
  }

  /**
   * One wave breaking. Three layers, because a breaker is three sounds that
   * happen in order and a single filtered noise burst is none of them:
   *
   *   impact  the lip landing — a short, low thud you feel more than hear
   *   throw   the burst of aerated water it drives ahead of itself, bright and
   *           fast, the part that actually says "that just broke"
   *   tumble  the roar of the whitewater walking shoreward afterwards, which
   *           swells for a second or two and then takes four more to die
   *
   * `size` is the wave's own amplitude in metres, so a small one sounds small.
   */
  #crash(
    ctx: AudioContext,
    listener: WaveListener,
    x: number,
    z: number,
    distance: number,
    size: number
  ) {
    if (!this.#noise || !this.#out) return;
    if (this.#live > 20) return; // hard ceiling; the wash covers the rest
    const weight = clamp01(size / OCEAN_BEACH_SURF.amplitude);
    if (weight < 0.08) return;
    // Inverse-distance, with a soft floor so the far end of the beach is a
    // presence rather than a click. Distance also dulls it — air eats treble
    // long before it eats the roar.
    const reach = 1 / (1 + distance / 130);
    const gain = weight * reach * 0.85;
    if (gain < 0.006) return;
    const bright = clamp01(1 - distance / 620);
    // You see it break, then you hear it. At the far posts that is over two
    // seconds, and it is most of why a big beach sounds big.
    const at = ctx.currentTime + distance / SPEED_OF_SOUND;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.#panFor(listener, x, z, distance);
    pan.connect(this.#out);
    if (this.#reverb) pan.connect(this.#reverb);
    this.#live++;
    const nodes: AudioNode[] = [pan];

    // --- impact: the mass of the lip hitting the water --------------------
    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(78 + weight * 26, at);
    thud.frequency.exponentialRampToValueAtTime(30, at + 0.8);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, at);
    thudGain.gain.exponentialRampToValueAtTime(0.05 + weight * 0.12, at + 0.09);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
    thud.connect(thudGain);
    thudGain.connect(pan);
    thud.start(at);
    thud.stop(at + 1.2);
    nodes.push(thud, thudGain);

    // --- throw: the bright burst of water leaving the lip -----------------
    const throwSrc = ctx.createBufferSource();
    throwSrc.buffer = this.#noise;
    throwSrc.playbackRate.value = 0.95 + Math.random() * 0.35;
    const throwBand = ctx.createBiquadFilter();
    throwBand.type = "bandpass";
    throwBand.Q.value = 0.7;
    throwBand.frequency.setValueAtTime(400, at);
    throwBand.frequency.exponentialRampToValueAtTime(1500 + bright * 2100, at + 0.16);
    throwBand.frequency.exponentialRampToValueAtTime(520, at + 1.5);
    const throwGain = ctx.createGain();
    throwGain.gain.setValueAtTime(0.0001, at);
    throwGain.gain.exponentialRampToValueAtTime(gain * (0.5 + bright * 0.5), at + 0.13);
    throwGain.gain.exponentialRampToValueAtTime(0.0001, at + 1.9);
    throwSrc.connect(throwBand);
    throwBand.connect(throwGain);
    throwGain.connect(pan);
    throwSrc.start(at, Math.random() * 1.4, 2.1);
    throwSrc.stop(at + 2.1);
    nodes.push(throwSrc, throwBand, throwGain);

    // --- tumble: the whitewater walking in --------------------------------
    // The long one, and the reason a set sounds continuous rather than like a
    // row of hits: its swell overlaps the next post's impact.
    const roll = ctx.createBufferSource();
    roll.buffer = this.#noise;
    roll.playbackRate.value = 0.7 + Math.random() * 0.25;
    const rollLp = ctx.createBiquadFilter();
    rollLp.type = "lowpass";
    rollLp.Q.value = 0.5;
    rollLp.frequency.setValueAtTime(500, at);
    rollLp.frequency.linearRampToValueAtTime(900 + bright * 1500, at + 0.9);
    rollLp.frequency.exponentialRampToValueAtTime(300, at + 4.2 + weight);
    const rollGain = ctx.createGain();
    rollGain.gain.setValueAtTime(0.0001, at);
    rollGain.gain.linearRampToValueAtTime(gain * 0.72, at + 0.7);
    rollGain.gain.exponentialRampToValueAtTime(0.0001, at + 4.6 + weight);
    roll.connect(rollLp);
    rollLp.connect(rollGain);
    rollGain.connect(pan);
    const rollLength = 4.8 + weight;
    roll.start(at, Math.random() * 1.2, rollLength);
    roll.stop(at + rollLength);
    nodes.push(roll, rollLp, rollGain);

    this.#crashes++;
    roll.onended = () => this.#retire(nodes);
  }

  /**
   * The same wave arriving at the sand, which is a completely different sound
   * from the break that made it: no impact, no low end to speak of, just a
   * wide sheet of bubbles hissing up the beach and draining back.
   */
  #swash(
    ctx: AudioContext,
    listener: WaveListener,
    x: number,
    z: number,
    distance: number,
    mask: number
  ) {
    if (!this.#noise || !this.#out) return;
    if (this.#live > 24) return;
    const gain = clamp01(mask) * (1 / (1 + distance / 90)) * 0.5;
    if (gain < 0.005) return;
    const at = ctx.currentTime + distance / SPEED_OF_SOUND;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.playbackRate.value = 1.05 + Math.random() * 0.3;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 700;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2600, at);
    lp.frequency.exponentialRampToValueAtTime(1100, at + 2.6);
    const g = ctx.createGain();
    // Asymmetric on purpose: the rush up the sand is over in a second and the
    // drain back takes three, which is the shape of every wash on every beach.
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 3.4);
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.#panFor(listener, x, z, distance);
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(pan);
    pan.connect(this.#out);
    this.#live++;
    src.start(at, Math.random() * 1.5, 3.6);
    src.stop(at + 3.6);
    const nodes: AudioNode[] = [src, hp, lp, g, pan];
    src.onended = () => this.#retire(nodes);
  }
}
