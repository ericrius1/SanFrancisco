import { NATURE_AUDIO_TUNING, type NatureSoundscape } from "../../audio/natureSoundscape";

/** World-space anchor used by the ambient harp and non-collect event cues. */
export type AfterlightAudioPosition = Readonly<{ x: number; y: number; z: number }>;

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

type AmbientGraph = {
  panner: PannerNode;
  send: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
};

type ActiveShot = {
  input: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  timer: number;
};

type ToneOptions = {
  at: number;
  frequency: number;
  endFrequency?: number;
  duration: number;
  level: number;
  attack?: number;
  type?: OscillatorType;
};

type NoiseOptions = {
  at: number;
  duration: number;
  level: number;
  attack?: number;
  filter: BiquadFilterType;
  frequency: number;
  endFrequency?: number;
  q?: number;
};

const EPS = 0.0001;
const DRY_LAYER_GAIN = 0.72;
const WET_LAYER_GAIN = 0.9;
const AMBIENT_REVERB = 0.24;
const COLLECT_SCALE = [392, 440, 523.25, 587.33, 659.25] as const;

function stopSafely(source: AudioScheduledSourceNode): void {
  try {
    source.stop();
  } catch {
    // A source that naturally ended (or was never started after context loss)
    // may reject a second stop. It is still safe to disconnect below.
  }
}

function disconnectSafely(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // Idempotent cleanup for HMR and partial construction failures.
  }
}

function setPannerPosition(panner: PannerNode, ctx: AudioContext, x: number, y: number, z: number): void {
  const t = ctx.currentTime;
  if (panner.positionX) {
    panner.positionX.setValueAtTime(x, t);
    panner.positionY.setValueAtTime(y, t);
    panner.positionZ.setValueAtTime(z, t);
    return;
  }
  (panner as unknown as { setPosition(px: number, py: number, pz: number): void }).setPosition(x, y, z);
}

function configurePanner(
  panner: PannerNode,
  ctx: AudioContext,
  position: AfterlightAudioPosition,
  refDistance: number,
  rolloff: number,
  maxDistance: number
): void {
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = refDistance;
  panner.rolloffFactor = rolloff;
  panner.maxDistance = maxDistance;
  setPannerPosition(panner, ctx, position.x, position.y, position.z);
}

/**
 * Procedural Afterlight sound layer.
 *
 * It owns no AudioContext. The wind-harp ambience follows NatureSoundscape's
 * regional bus, while quest one-shots use its presence-independent gameplay tap
 * so a disabled nature layer cannot swallow collection feedback. Both still
 * respect the shared limiter, their matching HUD mix group, visibility, and mute.
 */
export class AfterlightAudio {
  #nature: NatureSoundscape;
  #center: { x: number; y: number; z: number };
  #io: NatureVoiceIO | null = null;
  #dryLayer: GainNode | null = null;
  #wetLayer: GainNode | null = null;
  #eventLayer: GainNode | null = null;
  #eventWetLayer: GainNode | null = null;
  #ambient: AmbientGraph | null = null;
  #shots = new Set<ActiveShot>();
  #parkTimer: number | null = null;
  #awake = false;
  #disposed = false;

  constructor(nature: NatureSoundscape, center: AfterlightAudioPosition) {
    this.#nature = nature;
    this.#center = { x: center.x, y: center.y, z: center.z };
  }

  get debugState() {
    return {
      awake: this.#awake,
      context: this.#io?.ctx.state ?? "none",
      ambient: this.#ambient !== null,
      activeShots: this.#shots.size,
      route: "regional-ambience/always-gameplay" as const
    };
  }

  /** Update the world anchor after map.groundTop resolves or the site is moved. */
  setCenter(x: number, y: number, z: number): void {
    if (this.#disposed) return;
    this.#center = { x, y, z };
    const io = this.#io;
    if (io && this.#ambient) setPannerPosition(this.#ambient.panner, io.ctx, x, y, z);
  }

  /** Site-gate follower: fades the wind harp and every owned event path. */
  setAwake(on: boolean): void {
    if (this.#disposed || this.#awake === on) return;
    this.#awake = on;
    this.#nature.setExternalAwake(on);
    if (on) {
      if (this.#parkTimer !== null) window.clearTimeout(this.#parkTimer);
      this.#parkTimer = null;
      this.#ensureGraph();
    } else {
      // Let the gain ramp finish, then stop the looping noise/LFO graph entirely.
      // A quick boundary re-entry cancels this park and reuses the warm graph.
      this.#parkTimer = window.setTimeout(() => {
        this.#parkTimer = null;
        if (this.#awake || this.#disposed) return;
        this.#disposeAmbient();
        const now = this.#io?.ctx.currentTime ?? 0;
        for (const layer of [this.#dryLayer, this.#wetLayer, this.#eventLayer, this.#eventWetLayer]) {
          if (!layer) continue;
          layer.gain.cancelScheduledValues(now);
          layer.gain.value = 0;
        }
      }, 900);
    }
    const io = this.#io;
    if (!io || !this.#dryLayer || !this.#wetLayer || !this.#eventLayer || !this.#eventWetLayer || io.ctx.state === "closed") return;
    const now = io.ctx.currentTime;
    this.#dryLayer.gain.setTargetAtTime(on ? DRY_LAYER_GAIN : 0, now, on ? 0.3 : 0.2);
    this.#wetLayer.gain.setTargetAtTime(on ? WET_LAYER_GAIN : 0, now, on ? 0.38 : 0.24);
    this.#eventLayer.gain.setTargetAtTime(on ? 0.9 : 0, now, on ? 0.08 : 0.16);
    this.#eventWetLayer.gain.setTargetAtTime(on ? 0.9 : 0, now, on ? 0.08 : 0.16);
    if (this.#ambient) {
      this.#ambient.send.gain.setTargetAtTime(
        AMBIENT_REVERB * Number(NATURE_AUDIO_TUNING.values.reverb),
        now,
        0.2
      );
    }
  }

  /** Reassert shared-context ownership after other optional sibling layers. */
  update(): void {
    if (this.#awake && !this.#disposed) this.#nature.setExternalAwake(true);
  }

  /** Quest begins: fog breath, a low bronze fundamental, then its open fifth. */
  begin(): void {
    const io = this.#readyEvent();
    if (!io) return;
    const t = io.ctx.currentTime + 0.015;
    const shot = this.#makeShot(io, this.#center, 1.8, 0.34);
    this.#noise(shot, io, {
      at: t,
      duration: 0.72,
      level: 0.026,
      attack: 0.26,
      filter: "bandpass",
      frequency: 430,
      endFrequency: 1850,
      q: 1.1
    });
    this.#bell(shot, io, t + 0.03, 196, 1.18, 0.072);
    this.#bell(shot, io, t + 0.2, 293.66, 1.25, 0.064);
  }

  /** One of the five world echoes is gathered. `index` is zero-based. */
  collect(index: number, x: number, y: number, z: number): void {
    const io = this.#readyEvent();
    if (!io) return;
    const noteIndex = Math.min(COLLECT_SCALE.length - 1, Math.max(0, Math.round(index)));
    const frequency = COLLECT_SCALE[noteIndex];
    const t = io.ctx.currentTime + 0.012;
    const shot = this.#makeShot(io, { x, y, z }, 1.25, 0.42);
    this.#bell(shot, io, t, frequency, 0.88, 0.074 + noteIndex * 0.006);
    this.#tone(shot, io, {
      at: t + 0.045,
      frequency: frequency * 1.5,
      endFrequency: frequency * 1.492,
      duration: 0.44,
      level: 0.035,
      attack: 0.008,
      type: "sine"
    });
    this.#noise(shot, io, {
      at: t,
      duration: 0.24,
      level: 0.026,
      attack: 0.006,
      filter: "highpass",
      frequency: 2200 + noteIndex * 280,
      endFrequency: 5600,
      q: 0.4
    });
  }

  /** Timer failure: a softened descending minor shape and a low fog exhale. */
  fail(): void {
    const io = this.#readyEvent();
    if (!io) return;
    const t = io.ctx.currentTime + 0.015;
    const shot = this.#makeShot(io, this.#center, 1.9, 0.28);
    [293.66, 246.94, 196].forEach((frequency, i) => {
      this.#tone(shot, io, {
        at: t + i * 0.13,
        frequency,
        endFrequency: frequency * 0.965,
        duration: 0.82 + i * 0.12,
        level: 0.062 - i * 0.009,
        attack: 0.018,
        type: "triangle"
      });
    });
    this.#noise(shot, io, {
      at: t + 0.08,
      duration: 1.2,
      level: 0.024,
      attack: 0.18,
      filter: "lowpass",
      frequency: 1250,
      endFrequency: 250,
      q: 0.7
    });
  }

  /** All echoes returned: ascending brass harmonics resolving into a high bell. */
  complete(): void {
    const io = this.#readyEvent();
    if (!io) return;
    const t = io.ctx.currentTime + 0.02;
    const shot = this.#makeShot(io, this.#center, 3.1, 0.5);
    [392, 493.88, 587.33, 783.99].forEach((frequency, i) => {
      this.#bell(shot, io, t + i * 0.115, frequency, 1.55 + i * 0.1, 0.07 + i * 0.006);
    });
    this.#tone(shot, io, {
      at: t + 0.24,
      frequency: 196,
      endFrequency: 195,
      duration: 2.05,
      level: 0.05,
      attack: 0.08,
      type: "sine"
    });
    this.#noise(shot, io, {
      at: t + 0.1,
      duration: 1.45,
      level: 0.022,
      attack: 0.2,
      filter: "bandpass",
      frequency: 1700,
      endFrequency: 6200,
      q: 0.8
    });
  }

  /** Replay/retry: two quick breaths turn the motif back toward its root. */
  replay(): void {
    const io = this.#readyEvent();
    if (!io) return;
    const t = io.ctx.currentTime + 0.012;
    const shot = this.#makeShot(io, this.#center, 1.35, 0.32);
    this.#bell(shot, io, t, 329.63, 0.7, 0.06);
    this.#bell(shot, io, t + 0.16, 392, 0.88, 0.066);
    this.#noise(shot, io, {
      at: t,
      duration: 0.34,
      level: 0.018,
      attack: 0.03,
      filter: "bandpass",
      frequency: 900,
      endFrequency: 3000,
      q: 1.2
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#awake = false;
    this.#nature.setExternalAwake(false);
    if (this.#parkTimer !== null) window.clearTimeout(this.#parkTimer);
    this.#parkTimer = null;
    for (const shot of [...this.#shots]) this.#cleanupShot(shot, true);
    this.#disposeAmbient();
    if (this.#dryLayer) disconnectSafely(this.#dryLayer);
    if (this.#wetLayer) disconnectSafely(this.#wetLayer);
    if (this.#eventLayer) disconnectSafely(this.#eventLayer);
    if (this.#eventWetLayer) disconnectSafely(this.#eventWetLayer);
    this.#dryLayer = null;
    this.#wetLayer = null;
    this.#eventLayer = null;
    this.#eventWetLayer = null;
    this.#io = null;
  }

  #ensureGraph(): NatureVoiceIO | null {
    if (this.#disposed) return null;
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state === "closed") return null;
    if (!this.#dryLayer || !this.#wetLayer || !this.#eventLayer || !this.#eventWetLayer) {
      this.#dryLayer = io.ctx.createGain();
      this.#dryLayer.gain.value = 0;
      this.#dryLayer.connect(io.bus);
      this.#wetLayer = io.ctx.createGain();
      this.#wetLayer.gain.value = 0;
      this.#wetLayer.connect(io.regionalReverbSend);
      this.#eventLayer = io.ctx.createGain();
      this.#eventLayer.gain.value = 0;
      this.#eventLayer.connect(io.alwaysBus);
      this.#eventWetLayer = io.ctx.createGain();
      this.#eventWetLayer.gain.value = 0;
      this.#eventWetLayer.connect(io.effectsReverbSend);
    }
    if (!this.#ambient) this.#ambient = this.#buildAmbient(io);
    return io;
  }

  #readyEvent(): NatureVoiceIO | null {
    if (!this.#awake || this.#disposed) return null;
    const io = this.#ensureGraph();
    if (io?.ctx.state === "suspended") void io.ctx.resume().catch(() => {});
    return io;
  }

  #buildAmbient(io: NatureVoiceIO): AmbientGraph {
    const { ctx } = io;
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const source = ctx.createBufferSource();
    source.buffer = io.noise;
    source.loop = true;
    sources.push(source);

    const sum = ctx.createGain();
    sum.gain.value = 0.82;
    const bed = ctx.createGain();
    bed.gain.value = 0.9;
    const panner = ctx.createPanner();
    configurePanner(panner, ctx, this.#center, 22, 0.48, 180);
    const send = ctx.createGain();
    send.gain.value = AMBIENT_REVERB * Number(NATURE_AUDIO_TUNING.values.reverb);
    nodes.push(sum, bed, panner, send);

    // A single shared-noise source excites four narrow resonances. Very slow,
    // staggered gain LFOs make the partials appear and disappear like wind moving
    // across separate harp strings, without a periodic melody loop.
    const strings = [
      { frequency: 196, gain: 0.014, rate: 0.043, phase: 0.0 },
      { frequency: 293.66, gain: 0.011, rate: 0.057, phase: 1.7 },
      { frequency: 392, gain: 0.008, rate: 0.071, phase: 3.1 },
      { frequency: 587.33, gain: 0.0055, rate: 0.089, phase: 4.6 }
    ] as const;
    for (const string of strings) {
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = string.frequency;
      filter.Q.value = 28;
      const gain = ctx.createGain();
      gain.gain.value = string.gain;
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = string.rate;
      const depth = ctx.createGain();
      depth.gain.value = string.gain * 0.52;
      lfo.connect(depth).connect(gain.gain);
      source.connect(filter).connect(gain).connect(sum);
      lfo.start(ctx.currentTime + string.phase * 0.01);
      nodes.push(filter, gain, depth);
      sources.push(lfo);
    }

    // A nearly subliminal high, filtered breath keeps silence between partials
    // alive and ties the harp to Buena Vista's fog bank.
    const breathHigh = ctx.createBiquadFilter();
    breathHigh.type = "highpass";
    breathHigh.frequency.value = 900;
    const breathLow = ctx.createBiquadFilter();
    breathLow.type = "lowpass";
    breathLow.frequency.value = 3200;
    breathLow.Q.value = 0.35;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.006;
    const breathLfo = ctx.createOscillator();
    breathLfo.frequency.value = 0.031;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.003;
    breathLfo.connect(breathDepth).connect(breathGain.gain);
    source.connect(breathHigh).connect(breathLow).connect(breathGain).connect(sum);
    nodes.push(breathHigh, breathLow, breathGain, breathDepth);
    sources.push(breathLfo);

    sum.connect(bed).connect(panner);
    panner.connect(this.#dryLayer!);
    panner.connect(send).connect(this.#wetLayer!);
    source.start(0, Math.random() * Math.max(0.01, io.noise.duration));
    breathLfo.start(ctx.currentTime + 0.03);
    return { panner, send, nodes, sources };
  }

  #disposeAmbient(): void {
    const ambient = this.#ambient;
    if (!ambient) return;
    for (const source of ambient.sources) {
      stopSafely(source);
      disconnectSafely(source);
    }
    for (const node of ambient.nodes) disconnectSafely(node);
    this.#ambient = null;
  }

  #makeShot(
    io: NatureVoiceIO,
    position: AfterlightAudioPosition,
    lifeSeconds: number,
    reverb: number
  ): ActiveShot {
    const input = io.ctx.createGain();
    const panner = io.ctx.createPanner();
    configurePanner(panner, io.ctx, position, 6, 0.95, 120);
    const send = io.ctx.createGain();
    send.gain.value = reverb * Number(NATURE_AUDIO_TUNING.values.reverb);
    input.connect(panner);
    panner.connect(this.#eventLayer!);
    panner.connect(send).connect(this.#eventWetLayer!);
    const shot: ActiveShot = {
      input,
      nodes: [input, panner, send],
      sources: [],
      timer: 0
    };
    shot.timer = window.setTimeout(() => this.#cleanupShot(shot, false), (lifeSeconds + 0.55) * 1000);
    this.#shots.add(shot);
    return shot;
  }

  #cleanupShot(shot: ActiveShot, stop: boolean): void {
    if (!this.#shots.delete(shot)) return;
    window.clearTimeout(shot.timer);
    for (const source of shot.sources) {
      if (stop) stopSafely(source);
      disconnectSafely(source);
    }
    for (const node of shot.nodes) disconnectSafely(node);
  }

  #tone(shot: ActiveShot, io: NatureVoiceIO, options: ToneOptions): void {
    const osc = io.ctx.createOscillator();
    osc.type = options.type ?? "sine";
    osc.frequency.setValueAtTime(Math.max(20, options.frequency), options.at);
    if (options.endFrequency !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.endFrequency),
        options.at + options.duration
      );
    }
    const gain = io.ctx.createGain();
    const attack = Math.min(options.duration * 0.45, Math.max(0.004, options.attack ?? 0.012));
    gain.gain.setValueAtTime(EPS, options.at);
    gain.gain.exponentialRampToValueAtTime(Math.max(EPS * 2, options.level), options.at + attack);
    gain.gain.exponentialRampToValueAtTime(EPS, options.at + options.duration);
    osc.connect(gain).connect(shot.input);
    osc.start(options.at);
    osc.stop(options.at + options.duration + 0.035);
    shot.sources.push(osc);
    shot.nodes.push(gain);
  }

  #bell(
    shot: ActiveShot,
    io: NatureVoiceIO,
    at: number,
    frequency: number,
    duration: number,
    level: number
  ): void {
    const partials = [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 2.01, gain: 0.32, decay: 0.72 },
      { ratio: 3.97, gain: 0.1, decay: 0.48 }
    ] as const;
    for (const partial of partials) {
      this.#tone(shot, io, {
        at,
        frequency: frequency * partial.ratio,
        endFrequency: frequency * partial.ratio * 0.997,
        duration: duration * partial.decay,
        level: level * partial.gain,
        attack: 0.009,
        type: "sine"
      });
    }
  }

  #noise(shot: ActiveShot, io: NatureVoiceIO, options: NoiseOptions): void {
    const source = io.ctx.createBufferSource();
    source.buffer = io.noise;
    source.loop = true;
    const filter = io.ctx.createBiquadFilter();
    filter.type = options.filter;
    filter.frequency.setValueAtTime(Math.max(20, options.frequency), options.at);
    if (options.endFrequency !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.endFrequency),
        options.at + options.duration
      );
    }
    filter.Q.value = options.q ?? 0.8;
    const gain = io.ctx.createGain();
    const attack = Math.min(options.duration * 0.7, Math.max(0.004, options.attack ?? 0.01));
    gain.gain.setValueAtTime(EPS, options.at);
    gain.gain.exponentialRampToValueAtTime(Math.max(EPS * 2, options.level), options.at + attack);
    gain.gain.exponentialRampToValueAtTime(EPS, options.at + options.duration);
    source.connect(filter).connect(gain).connect(shot.input);
    source.start(options.at, Math.random() * Math.max(0.01, io.noise.duration));
    source.stop(options.at + options.duration + 0.035);
    shot.sources.push(source);
    shot.nodes.push(filter, gain);
  }
}
