/**
 * Whimsical procedural audio for the soap-bubble wand.
 *
 * `blow` layers a non-vocal filtered-air puff, a quiet inflating membrane and
 * a handful of soap-film glints. `pop` maps bubble radius to a delicate pitched
 * membrane snap, so a small bubble sounds bright while a large one sounds
 * rounder and lower. No samples or network requests are involved.
 *
 * This class deliberately owns no AudioContext. Every voice borrows the shared
 * GameplaySfxBus and therefore inherits its first-gesture unlock, effects mute
 * and volume, limiter, short room, visibility handling and idle suspension.
 */

import { effectsAudioLevel } from "../core/audioSettings";
import type { GameplaySfxBus, GameplaySfxVoiceBus } from "../audio/gameplaySfxBus";

export type BubbleBlowOptions = {
  /** Listener-relative stereo position, -1 (left) to +1 (right). */
  pan?: number;
  /** 0..1.5 amount of air. Values around 0.8 are soft and natural. */
  intensity?: number;
  /** Length of the wand breath in seconds, clamped to 0.2..0.8. */
  duration?: number;
  /** 0..1 amount of iridescent soap-film sparkle. */
  shimmer?: number;
};

export type BubblePopOptions = {
  /** Bubble world radius. The visual bubbles currently span roughly 0.3..0.85. */
  radius?: number;
  /** Listener-relative stereo position, -1 (left) to +1 (right). */
  pan?: number;
  /** 0..1.5 pop energy. */
  intensity?: number;
  /** Optional stable id; duplicate pop callbacks for one bubble are debounced. */
  sourceId?: string | number;
};

type BubbleVoiceKind = "blow" | "pop";
type DropReason = "none" | "muted" | "locked" | "cooldown";

type LiveVoice = {
  kind: BubbleVoiceKind;
  createdAt: number;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  timer: ReturnType<typeof setTimeout>;
};

export type BubbleAudioDebugState = {
  ready: boolean;
  context: AudioContextState | "none";
  activeVoices: number;
  activeBlows: number;
  activePops: number;
  blowCount: number;
  popCount: number;
  mutedDrops: number;
  lockedDrops: number;
  cooldownDrops: number;
  stolenVoices: number;
  lastEvent: BubbleVoiceKind | null;
  lastDrop: DropReason;
  lastRadius: number;
  lastPopPitch: number;
};

const EPS = 0.0001;
const BLOW_COOLDOWN_SECONDS = 0.075;
const SOURCE_POP_COOLDOWN_SECONDS = 0.09;
const MAX_BLOW_VOICES = 3;
const MAX_POP_VOICES = 18;
const MAX_TOTAL_VOICES = 20;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const finiteOr = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? (value as number) : fallback;
const wallSeconds = () =>
  (typeof performance === "undefined" ? Date.now() : performance.now()) / 1000;

export class BubbleAudio {
  readonly #bus: GameplaySfxBus;
  readonly #random: () => number;
  #voices: LiveVoice[] = [];
  #lastBlowAt = -Infinity;
  #lastPopBySource = new Map<string | number, number>();
  #blowCount = 0;
  #popCount = 0;
  #mutedDrops = 0;
  #lockedDrops = 0;
  #cooldownDrops = 0;
  #stolenVoices = 0;
  #lastEvent: BubbleVoiceKind | null = null;
  #lastDrop: DropReason = "none";
  #lastRadius = 0;
  #lastPopPitch = 0;

  constructor(bus: GameplaySfxBus, options: { random?: () => number } = {}) {
    this.#bus = bus;
    this.#random = options.random ?? Math.random;
  }

  /** Sound one puff from the bubble wand. */
  blow(options: BubbleBlowOptions = {}): boolean {
    if (effectsAudioLevel() <= EPS) return this.#drop("muted");

    const now = wallSeconds();
    if (now - this.#lastBlowAt < BLOW_COOLDOWN_SECONDS) return this.#drop("cooldown");

    const duration = clamp(finiteOr(options.duration, 0.46), 0.2, 0.8);
    const voiceBus = this.#bus.voiceBus(duration + 0.58);
    if (!voiceBus || voiceBus.ctx.state === "closed") return this.#drop("locked");

    const intensity = clamp(finiteOr(options.intensity, 0.82), 0.05, 1.5);
    const shimmer = clamp01(finiteOr(options.shimmer, 0.72));
    const pan = clamp(finiteOr(options.pan, 0), -1, 1);
    const tail = duration + 0.42;
    const voice = this.#makeVoice(voiceBus, "blow", pan, intensity, 0.17, tail);
    const at = voiceBus.ctx.currentTime + 0.006;

    this.#renderAirPuff(voiceBus, voice, at, duration, intensity);
    this.#renderInflatingFilm(voiceBus, voice, at, duration, shimmer);
    this.#renderShimmer(voiceBus, voice, at, duration, shimmer);

    this.#lastBlowAt = now;
    this.#blowCount++;
    this.#lastEvent = "blow";
    this.#lastDrop = "none";
    return true;
  }

  /**
   * Sound one bubble pop. The object form is preferred; the positional form is
   * convenient for a visual callback: `pop(radius, pan, intensity)`.
   */
  pop(options?: BubblePopOptions): boolean;
  pop(radius?: number, pan?: number, intensity?: number): boolean;
  pop(
    radiusOrOptions: number | BubblePopOptions = {},
    positionalPan = 0,
    positionalIntensity = 0.82
  ): boolean {
    const options: BubblePopOptions =
      typeof radiusOrOptions === "number"
        ? { radius: radiusOrOptions, pan: positionalPan, intensity: positionalIntensity }
        : radiusOrOptions;

    if (effectsAudioLevel() <= EPS) return this.#drop("muted");

    const now = wallSeconds();
    if (options.sourceId != null) {
      const previous = this.#lastPopBySource.get(options.sourceId) ?? -Infinity;
      if (now - previous < SOURCE_POP_COOLDOWN_SECONDS) return this.#drop("cooldown");
    }

    const voiceBus = this.#bus.voiceBus(0.46);
    if (!voiceBus || voiceBus.ctx.state === "closed") return this.#drop("locked");

    const radius = clamp(finiteOr(options.radius, 0.48), 0.08, 2);
    const pan = clamp(finiteOr(options.pan, 0), -1, 1);
    const intensity = clamp(finiteOr(options.intensity, 0.82), 0.05, 1.5);
    const size = clamp01((radius - 0.12) / 1.08);
    const pitchVariation = 0.94 + this.#random() * 0.12;
    const pitch = clamp(1950 * Math.pow(radius / 0.3, -0.64) * pitchVariation, 430, 2900);
    const duration = 0.055 + size * 0.075;
    const voice = this.#makeVoice(voiceBus, "pop", pan, intensity, 0.24, duration + 0.2);
    const at = voiceBus.ctx.currentTime + 0.004 + this.#random() * 0.004;

    this.#renderPop(voiceBus, voice, at, duration, pitch, size, intensity);

    if (options.sourceId != null) {
      this.#lastPopBySource.set(options.sourceId, now);
      this.#trimPopCooldowns(now);
    }
    this.#popCount++;
    this.#lastEvent = "pop";
    this.#lastDrop = "none";
    this.#lastRadius = radius;
    this.#lastPopPitch = pitch;
    return true;
  }

  get debugState(): BubbleAudioDebugState {
    let activeBlows = 0;
    let activePops = 0;
    for (const voice of this.#voices) {
      if (voice.kind === "blow") activeBlows++;
      else activePops++;
    }
    const bus = this.#bus.debugState;
    return {
      ready: bus.ctx !== "none",
      context: bus.ctx as AudioContextState | "none",
      activeVoices: this.#voices.length,
      activeBlows,
      activePops,
      blowCount: this.#blowCount,
      popCount: this.#popCount,
      mutedDrops: this.#mutedDrops,
      lockedDrops: this.#lockedDrops,
      cooldownDrops: this.#cooldownDrops,
      stolenVoices: this.#stolenVoices,
      lastEvent: this.#lastEvent,
      lastDrop: this.#lastDrop,
      lastRadius: +this.#lastRadius.toFixed(3),
      lastPopPitch: Math.round(this.#lastPopPitch)
    };
  }

  /** Disconnect only this layer's voices. The shared bus remains alive. */
  dispose(): void {
    for (const voice of [...this.#voices]) this.#release(voice, true);
    this.#lastPopBySource.clear();
  }

  #drop(reason: Exclude<DropReason, "none">): false {
    this.#lastDrop = reason;
    if (reason === "muted") this.#mutedDrops++;
    else if (reason === "locked") this.#lockedDrops++;
    else this.#cooldownDrops++;
    return false;
  }

  #makeVoice(
    io: GameplaySfxVoiceBus,
    kind: BubbleVoiceKind,
    pan: number,
    intensity: number,
    room: number,
    tail: number
  ): LiveVoice {
    const kindLimit = kind === "blow" ? MAX_BLOW_VOICES : MAX_POP_VOICES;
    while (
      this.#voices.length >= MAX_TOTAL_VOICES ||
      this.#voices.filter((voice) => voice.kind === kind).length >= kindLimit
    ) {
      const oldestOfKind = this.#voices.find((voice) => voice.kind === kind);
      const victim = oldestOfKind ?? this.#voices[0];
      if (!victim) break;
      this.#stolenVoices++;
      this.#release(victim, true);
    }

    const { ctx } = io;
    const sum = ctx.createGain();
    // Loudness grows more gently than physical input so enthusiastic callers do
    // not make a cluster of translucent bubbles dominate the gameplay mix.
    sum.gain.value = Math.pow(intensity, 0.72) * (kind === "blow" ? 0.7 : 0.78);
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = pan * 0.8;
    const drySend = ctx.createGain();
    drySend.gain.value = kind === "blow" ? 0.86 : 0.94;
    const roomSend = ctx.createGain();
    roomSend.gain.value = room;
    sum.connect(stereo);
    stereo.connect(drySend).connect(io.dry);
    stereo.connect(roomSend).connect(io.room);

    const voice = {
      kind,
      createdAt: wallSeconds(),
      nodes: [sum, stereo, drySend, roomSend],
      sources: [],
      timer: setTimeout(() => this.#release(voice, false), (tail + 0.08) * 1000)
    } satisfies LiveVoice;
    this.#voices.push(voice);
    return voice;
  }

  #release(voice: LiveVoice, stop: boolean): void {
    const index = this.#voices.indexOf(voice);
    if (index === -1) return;
    this.#voices.splice(index, 1);
    clearTimeout(voice.timer);
    if (stop) {
      for (const source of voice.sources) {
        try {
          source.stop();
        } catch {
          // An already-ended source is harmless; all nodes are disconnected below.
        }
      }
    }
    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // Disconnect is best-effort during scene teardown/voice stealing.
      }
    }
  }

  #node<T extends AudioNode>(voice: LiveVoice, node: T): T {
    voice.nodes.push(node);
    return node;
  }

  #source<T extends AudioScheduledSourceNode>(voice: LiveVoice, source: T): T {
    voice.sources.push(source);
    voice.nodes.push(source);
    return source;
  }

  #renderAirPuff(
    io: GameplaySfxVoiceBus,
    voice: LiveVoice,
    at: number,
    duration: number,
    intensity: number
  ): void {
    const { ctx } = io;
    const air = this.#source(voice, ctx.createBufferSource());
    air.buffer = io.noise;
    const body = this.#node(voice, ctx.createBiquadFilter());
    body.type = "bandpass";
    body.Q.value = 0.58;
    body.frequency.setValueAtTime(760 + this.#random() * 140, at);
    body.frequency.exponentialRampToValueAtTime(1320 + intensity * 230, at + duration * 0.42);
    body.frequency.exponentialRampToValueAtTime(920, at + duration);
    const veil = this.#node(voice, ctx.createBiquadFilter());
    veil.type = "lowpass";
    veil.Q.value = 0.45;
    veil.frequency.setValueAtTime(2600, at);
    veil.frequency.exponentialRampToValueAtTime(4700, at + duration * 0.34);
    veil.frequency.exponentialRampToValueAtTime(2500, at + duration);
    const gain = this.#node(voice, ctx.createGain());
    gain.gain.setValueAtTime(EPS, at);
    gain.gain.linearRampToValueAtTime(0.095, at + Math.min(0.045, duration * 0.18));
    gain.gain.linearRampToValueAtTime(0.072, at + duration * 0.58);
    gain.gain.exponentialRampToValueAtTime(EPS, at + duration);
    air.connect(body).connect(veil).connect(gain).connect(voice.nodes[0]);
    air.start(at, this.#noiseOffset(io.noise, duration));
    air.stop(at + duration + 0.015);

    // A delayed, brighter wisp keeps the breath light and explicitly non-vocal.
    const wispAt = at + duration * 0.18;
    const wispDuration = duration * 0.66;
    const wisp = this.#source(voice, ctx.createBufferSource());
    wisp.buffer = io.noise;
    const wispBand = this.#node(voice, ctx.createBiquadFilter());
    wispBand.type = "bandpass";
    wispBand.Q.value = 1.35;
    wispBand.frequency.setValueAtTime(2800, wispAt);
    wispBand.frequency.exponentialRampToValueAtTime(4100, wispAt + wispDuration * 0.5);
    wispBand.frequency.exponentialRampToValueAtTime(3200, wispAt + wispDuration);
    const wispGain = this.#node(voice, ctx.createGain());
    wispGain.gain.setValueAtTime(EPS, wispAt);
    wispGain.gain.linearRampToValueAtTime(0.018, wispAt + 0.035);
    wispGain.gain.exponentialRampToValueAtTime(EPS, wispAt + wispDuration);
    wisp.connect(wispBand).connect(wispGain).connect(voice.nodes[0]);
    wisp.start(wispAt, this.#noiseOffset(io.noise, wispDuration));
    wisp.stop(wispAt + wispDuration + 0.015);
  }

  #renderInflatingFilm(
    io: GameplaySfxVoiceBus,
    voice: LiveVoice,
    at: number,
    duration: number,
    shimmer: number
  ): void {
    const { ctx } = io;
    // As the membrane expands its resonance falls. It is deliberately quiet:
    // felt as a soft watery roundness beneath the air, never as a sung note.
    const film = this.#source(voice, ctx.createOscillator());
    film.type = "sine";
    const startPitch = 510 + this.#random() * 90;
    film.frequency.setValueAtTime(startPitch, at + 0.018);
    film.frequency.exponentialRampToValueAtTime(startPitch * 0.52, at + duration);
    const filmGain = this.#node(voice, ctx.createGain());
    filmGain.gain.setValueAtTime(EPS, at + 0.018);
    filmGain.gain.linearRampToValueAtTime(0.009 + shimmer * 0.006, at + duration * 0.32);
    filmGain.gain.exponentialRampToValueAtTime(EPS, at + duration + 0.045);
    film.connect(filmGain).connect(voice.nodes[0]);
    film.start(at + 0.018);
    film.stop(at + duration + 0.06);
  }

  #renderShimmer(
    io: GameplaySfxVoiceBus,
    voice: LiveVoice,
    at: number,
    duration: number,
    shimmer: number
  ): void {
    if (shimmer <= 0.01) return;
    const { ctx } = io;
    const count = 3 + Math.floor(shimmer * 2);
    for (let i = 0; i < count; i++) {
      const glintAt = at + duration * (0.24 + (i / count) * 0.62) + this.#random() * 0.025;
      const glintDuration = 0.055 + this.#random() * 0.065;
      const startPitch = 1120 + i * 390 + this.#random() * 260;
      const glint = this.#source(voice, ctx.createOscillator());
      glint.type = i % 2 === 0 ? "sine" : "triangle";
      glint.frequency.setValueAtTime(startPitch, glintAt);
      glint.frequency.exponentialRampToValueAtTime(startPitch * (1.22 + this.#random() * 0.16), glintAt + glintDuration);
      const glintGain = this.#node(voice, ctx.createGain());
      glintGain.gain.setValueAtTime(EPS, glintAt);
      glintGain.gain.linearRampToValueAtTime((0.0065 + this.#random() * 0.004) * shimmer, glintAt + 0.009);
      glintGain.gain.exponentialRampToValueAtTime(EPS, glintAt + glintDuration);
      glint.connect(glintGain).connect(voice.nodes[0]);
      glint.start(glintAt);
      glint.stop(glintAt + glintDuration + 0.012);
    }
  }

  #renderPop(
    io: GameplaySfxVoiceBus,
    voice: LiveVoice,
    at: number,
    duration: number,
    pitch: number,
    size: number,
    intensity: number
  ): void {
    const { ctx } = io;

    // The initial membrane rupture is filtered rather than a harsh digital tick.
    const snapDuration = 0.018 + size * 0.018;
    const snap = this.#source(voice, ctx.createBufferSource());
    snap.buffer = io.noise;
    const snapBand = this.#node(voice, ctx.createBiquadFilter());
    snapBand.type = "bandpass";
    snapBand.Q.value = 0.85 + size * 0.45;
    snapBand.frequency.setValueAtTime(clamp(pitch * 1.9, 760, 7200), at);
    snapBand.frequency.exponentialRampToValueAtTime(clamp(pitch * 0.9, 380, 4200), at + snapDuration);
    const snapGain = this.#node(voice, ctx.createGain());
    snapGain.gain.setValueAtTime(EPS, at);
    snapGain.gain.linearRampToValueAtTime(0.105 - size * 0.02, at + 0.0025);
    snapGain.gain.exponentialRampToValueAtTime(EPS, at + snapDuration);
    snap.connect(snapBand).connect(snapGain).connect(voice.nodes[0]);
    snap.start(at, this.#noiseOffset(io.noise, snapDuration));
    snap.stop(at + snapDuration + 0.01);

    // Radius controls the rounded soap-film chirp: inverse-size pitch, longer
    // decay for bigger bubbles, with slight variation to avoid a sample-gun feel.
    const membrane = this.#source(voice, ctx.createOscillator());
    membrane.type = "sine";
    membrane.frequency.setValueAtTime(pitch, at);
    membrane.frequency.exponentialRampToValueAtTime(pitch * (0.48 + size * 0.08), at + duration);
    const membraneGain = this.#node(voice, ctx.createGain());
    membraneGain.gain.setValueAtTime(EPS, at);
    membraneGain.gain.linearRampToValueAtTime(0.055 + size * 0.025, at + 0.004);
    membraneGain.gain.exponentialRampToValueAtTime(EPS, at + duration);
    membrane.connect(membraneGain).connect(voice.nodes[0]);
    membrane.start(at);
    membrane.stop(at + duration + 0.012);

    // A gossamer upper partial reads as iridescent film, not a UI blip.
    const sheenAt = at + 0.003;
    const sheenDuration = duration * 0.64;
    const sheen = this.#source(voice, ctx.createOscillator());
    sheen.type = "triangle";
    sheen.frequency.setValueAtTime(clamp(pitch * 2.34, 1200, 7600), sheenAt);
    sheen.frequency.exponentialRampToValueAtTime(clamp(pitch * 1.08, 620, 4100), sheenAt + sheenDuration);
    const sheenGain = this.#node(voice, ctx.createGain());
    sheenGain.gain.setValueAtTime(EPS, sheenAt);
    sheenGain.gain.linearRampToValueAtTime(0.0085 * intensity, sheenAt + 0.003);
    sheenGain.gain.exponentialRampToValueAtTime(EPS, sheenAt + sheenDuration);
    sheen.connect(sheenGain).connect(voice.nodes[0]);
    sheen.start(sheenAt);
    sheen.stop(sheenAt + sheenDuration + 0.01);

    // Larger bubbles release a touch more low, airy body after the membrane.
    if (size > 0.18) {
      const airAt = at + 0.005;
      const airDuration = 0.035 + size * 0.055;
      const air = this.#source(voice, ctx.createBufferSource());
      air.buffer = io.noise;
      const airBand = this.#node(voice, ctx.createBiquadFilter());
      airBand.type = "bandpass";
      airBand.Q.value = 0.55;
      airBand.frequency.setValueAtTime(clamp(pitch * 0.72, 260, 1600), airAt);
      airBand.frequency.exponentialRampToValueAtTime(clamp(pitch * 0.42, 180, 900), airAt + airDuration);
      const airGain = this.#node(voice, ctx.createGain());
      airGain.gain.setValueAtTime(EPS, airAt);
      airGain.gain.linearRampToValueAtTime(0.026 * size, airAt + 0.006);
      airGain.gain.exponentialRampToValueAtTime(EPS, airAt + airDuration);
      air.connect(airBand).connect(airGain).connect(voice.nodes[0]);
      air.start(airAt, this.#noiseOffset(io.noise, airDuration));
      air.stop(airAt + airDuration + 0.01);
    }
  }

  #noiseOffset(buffer: AudioBuffer, duration: number): number {
    return this.#random() * Math.max(0.01, buffer.duration - duration - 0.02);
  }

  #trimPopCooldowns(now: number): void {
    if (this.#lastPopBySource.size <= 256) return;
    for (const [id, time] of this.#lastPopBySource) {
      if (now - time > 2) this.#lastPopBySource.delete(id);
    }
  }
}
