// Procedural water sound for the Japanese Tea Garden's connected Drum Bridge
// stream and south pond. This module deliberately owns no AudioContext and
// fetches no sample: it shapes NatureSoundscape's shared noise buffer, routes
// through its shared FX/mute bus and leaves gesture unlock/listener updates to
// that engine. Construction is inert; the graph is built only on first approach
// and torn down after the distance fade reaches silence.

import { tunables } from "../../core/persist";
import {
  NATURE_AUDIO_TUNING,
  type NatureSoundscape
} from "../../audio/natureSoundscape";

export type TeaGardenStreamAudioPosition = {
  x: number;
  y: number;
  z: number;
};

/** Normalized simulation signals may override the pane defaults each frame. */
export type TeaGardenStreamAudioFrame = {
  playerPos: TeaGardenStreamAudioPosition;
  /** Unified-body downstream flow energy, normalized to 0..1. */
  flow?: number;
  /** Local obstacle/vorticity energy, normalized to 0..1. */
  turbulence?: number;
};

export type TeaGardenStreamAudioOptions = {
  /**
   * World-space water surface height. The garden can pass
   * `(x, z) => map.groundTop(x, z) + 0.16`; when omitted, the first nearby
   * player's foot-level is used as a conservative vertical fallback.
   */
  surfaceY?: (x: number, z: number) => number;
};

/**
 * Tweakpane-ready values live beside all of the audio behavior they control.
 * Import this from the garden's lazy chunk and call `.bind(folder)` when its
 * diagnostics folder is registered.
 */
export const TEA_GARDEN_STREAM_AUDIO_TUNING = tunables(
  "japaneseTeaGarden.streamAudio",
  {
    enabled: { v: true, label: "enabled" },
    master: { v: 0.62, min: 0, max: 1, step: 0.01, label: "water volume" },
    flow: { v: 0.58, min: 0, max: 1, step: 0.01, label: "flow energy" },
    turbulence: { v: 0.4, min: 0, max: 1, step: 0.01, label: "turbulence" },
    trickle: { v: 0.56, min: 0, max: 1, step: 0.01, label: "surface trickle" },
    brightness: { v: 0.54, min: 0, max: 1, step: 0.01, label: "water brightness" },
    eddyRate: { v: 0.9, min: 0, max: 2.5, step: 0.05, label: "eddy accents" },
    reverb: { v: 0.2, min: 0, max: 0.6, step: 0.01, label: "garden space" },
    audibleRadius: { v: 46, min: 18, max: 90, step: 1, label: "audible radius" }
  }
);

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;
type WaterAnchor = { x: number; z: number };

type ContinuousVoice = {
  source: AudioBufferSourceNode;
  highpass: BiquadFilterNode;
  bandpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  level: GainNode;
  panner: PannerNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
};

type ActiveEddy = {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  expires: number;
};

const BRIDGE_ANCHOR: WaterAnchor = { x: -2274.2, z: 2193.2 };
const POND_ENTRY_ANCHOR: WaterAnchor = { x: -2290.4, z: 2202.4 };

// Small Tatsuyama-style stones along the authored stream trace. Accents hop
// between these anchors so the turbulence reads as water moving around rocks,
// rather than a mono loop pinned under the bridge.
const EDDY_ANCHORS: readonly WaterAnchor[] = [
  { x: -2268.2, z: 2188.9 },
  { x: -2273.9, z: 2194.2 },
  { x: -2280.8, z: 2198.1 },
  { x: -2286.8, z: 2200.5 }
] as const;

const EPS = 0.0001;
const MAX_ACTIVE_EDDIES = 2;
const PARK_THRESHOLD = 0.0015;

/**
 * Lazy, procedural, positional stream/pond audio.
 *
 * Call update after NatureSoundscape.update so its shared listener and buses
 * already reflect the current camera, visibility, FX level and mute state.
 */
export class JapaneseTeaGardenStreamAudio {
  #nature: NatureSoundscape;
  #surfaceY?: (x: number, z: number) => number;
  #io: NatureVoiceIO | null = null;
  #dry: GainNode | null = null;
  #wet: GainNode | null = null;
  #bridge: ContinuousVoice | null = null;
  #pondEntry: ContinuousVoice | null = null;
  #eddies: ActiveEddy[] = [];
  #distanceGain = 0;
  #distance = Number.POSITIVE_INFINITY;
  #eddyTimer = 0.45;
  #lastEddy = -1;
  #graphBuilds = 0;
  #externalAwake = false;
  #disposed = false;

  constructor(nature: NatureSoundscape, options: TeaGardenStreamAudioOptions = {}) {
    this.#nature = nature;
    this.#surfaceY = options.surfaceY;
  }

  /** Read-only verification surface for lazy-load/node-lifecycle probes. */
  get debugState() {
    return {
      graph: this.#bridge !== null,
      graphBuilds: this.#graphBuilds,
      context: this.#io?.ctx.state ?? "none",
      distance: Number.isFinite(this.#distance) ? +this.#distance.toFixed(2) : null,
      distanceGain: +this.#distanceGain.toFixed(3),
      activeEddies: this.#eddies.length
    };
  }

  update(dt: number, frame: TeaGardenStreamAudioFrame): void {
    if (this.#disposed) return;
    const safeDt = Math.min(0.1, Math.max(0, dt));
    const tuning = TEA_GARDEN_STREAM_AUDIO_TUNING.values;
    const flow = clamp01(frame.flow ?? Number(tuning.flow));
    const turbulence = clamp01(frame.turbulence ?? Number(tuning.turbulence));
    const radius = Math.max(1, Number(tuning.audibleRadius));

    this.#distance = distanceToWaterAudio(frame.playerPos.x, frame.playerPos.z);
    const allowed = Boolean(tuning.enabled) && Number(tuning.master) > 0.001;
    // Full presence in the intimate near field, then a long smooth garden fade.
    const targetDistanceGain = allowed
      ? 1 - smoothstep(radius * 0.24, radius, this.#distance)
      : 0;
    this.#distanceGain = approach(this.#distanceGain, targetDistanceGain, safeDt, 3.2);

    // No call to voiceBus() at boot or while the player is elsewhere. This is
    // the feature's first-use gate and keeps the optional audio graph truly lazy.
    if (!this.#bridge && targetDistanceGain > PARK_THRESHOLD) {
      const io = (this.#io ??= this.#nature.voiceBus());
      if (!io || io.ctx.state === "closed") return;
      this.#requestSharedContext();
      this.#buildGraph(io, frame.playerPos.y - 1.15);
    }

    const io = this.#io;
    if (!io || !this.#bridge || !this.#pondEntry || !this.#dry || !this.#wet) return;
    // Reassert while audible because NatureSoundscape currently exposes one
    // shared sibling-awake bit and another optional feature may have released it
    // earlier in the same frame.
    if (targetDistanceGain > 0 || this.#distanceGain > PARK_THRESHOLD) {
      this.#requestSharedContext();
    }
    const now = io.ctx.currentTime;
    this.#reapEddies(now);

    const master = Number(tuning.master) * this.#distanceGain;
    this.#dry.gain.setTargetAtTime(master, now, 0.16);
    this.#wet.gain.setTargetAtTime(
      master * Number(tuning.reverb) * Number(NATURE_AUDIO_TUNING.values.reverb),
      now,
      0.2
    );

    const brightness = clamp01(Number(tuning.brightness));
    const trickle = clamp01(Number(tuning.trickle));
    this.#shapeBridge(this.#bridge, now, flow, turbulence, brightness);
    this.#shapePondEntry(this.#pondEntry, now, flow, trickle, brightness);

    if (io.ctx.state === "running" && master > 0.008) {
      const activity = Number(tuning.eddyRate) * (0.16 + turbulence * 1.45) * (0.55 + flow * 0.7);
      this.#eddyTimer -= safeDt * activity;
      if (this.#eddyTimer <= 0 && this.#eddies.length < MAX_ACTIVE_EDDIES) {
        this.#spawnEddy(io, flow, turbulence, brightness);
        this.#eddyTimer = randomBetween(0.55, 1.35);
      }
    }

    // Let the AudioParam fade complete before stopping sources. Re-entry always
    // builds exactly one fresh graph; update itself can never stack loop nodes.
    if (targetDistanceGain <= 0 && this.#distanceGain <= PARK_THRESHOLD) {
      this.#destroyGraph();
      this.#distanceGain = 0;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#destroyGraph();
    this.#io = null;
    this.#distanceGain = 0;
  }

  #buildGraph(io: NatureVoiceIO, fallbackY: number): void {
    if (this.#bridge || this.#disposed) return;
    const { ctx } = io;
    this.#dry = ctx.createGain();
    this.#dry.gain.value = 0;
    // Water is an environmental FX layer, independent of the wildlife/bed
    // enable switch. alwaysBus supplies HUD FX/mute + visibility through the
    // shared limiter; #requestSharedContext keeps it alive only while nearby.
    this.#dry.connect(io.alwaysBus);

    this.#wet = ctx.createGain();
    this.#wet.gain.value = 0;
    this.#wet.connect(io.reverbSend);

    this.#bridge = this.#makeContinuousVoice(io, BRIDGE_ANCHOR, fallbackY, {
      playbackRate: 0.773,
      highpass: 150,
      bandpass: 980,
      lowpass: 3600,
      q: 0.55,
      lfoRate: 0.087,
      offset: 0.17
    });
    this.#pondEntry = this.#makeContinuousVoice(io, POND_ENTRY_ANCHOR, fallbackY, {
      playbackRate: 1.173,
      highpass: 760,
      bandpass: 2300,
      lowpass: 5200,
      q: 0.82,
      lfoRate: 0.193,
      offset: 1.11
    });
    this.#eddyTimer = randomBetween(0.35, 0.85);
    this.#graphBuilds++;
  }

  #makeContinuousVoice(
    io: NatureVoiceIO,
    anchor: WaterAnchor,
    fallbackY: number,
    character: {
      playbackRate: number;
      highpass: number;
      bandpass: number;
      lowpass: number;
      q: number;
      lfoRate: number;
      offset: number;
    }
  ): ContinuousVoice {
    const { ctx } = io;
    const source = ctx.createBufferSource();
    source.buffer = io.noise;
    source.loop = true;
    source.playbackRate.value = character.playbackRate;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = character.highpass;
    highpass.Q.value = 0.25;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = character.bandpass;
    bandpass.Q.value = character.q;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = character.lowpass;
    lowpass.Q.value = 0.2;
    const level = ctx.createGain();
    level.gain.value = 0;

    const panner = ctx.createPanner();
    configureWaterPanner(panner);
    setPannerPosition(
      panner,
      ctx,
      anchor.x,
      this.#surfaceY?.(anchor.x, anchor.z) ?? fallbackY,
      anchor.z
    );

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = character.lfoRate;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth).connect(level.gain);

    source.connect(highpass).connect(bandpass).connect(lowpass).connect(level).connect(panner);
    panner.connect(this.#dry!);
    panner.connect(this.#wet!);
    source.start(0, character.offset % Math.max(0.01, io.noise.duration));
    lfo.start();
    return { source, highpass, bandpass, lowpass, level, panner, lfo, lfoDepth };
  }

  #shapeBridge(
    voice: ContinuousVoice,
    now: number,
    flow: number,
    turbulence: number,
    brightness: number
  ): void {
    const level = 0.035 + flow * 0.14 + turbulence * 0.025;
    voice.level.gain.setTargetAtTime(level, now, 0.18);
    voice.lfoDepth.gain.setTargetAtTime(level * (0.12 + turbulence * 0.14), now, 0.25);
    voice.highpass.frequency.setTargetAtTime(115 + flow * 145, now, 0.2);
    voice.bandpass.frequency.setTargetAtTime(620 + brightness * 1150 + flow * 260, now, 0.18);
    voice.bandpass.Q.setTargetAtTime(0.42 + turbulence * 0.42, now, 0.22);
    voice.lowpass.frequency.setTargetAtTime(1800 + brightness * 3500, now, 0.2);
  }

  #shapePondEntry(
    voice: ContinuousVoice,
    now: number,
    flow: number,
    trickle: number,
    brightness: number
  ): void {
    const level = trickle * (0.018 + flow * 0.075);
    voice.level.gain.setTargetAtTime(level, now, 0.16);
    voice.lfoDepth.gain.setTargetAtTime(level * (0.2 + trickle * 0.16), now, 0.24);
    voice.highpass.frequency.setTargetAtTime(620 + brightness * 520, now, 0.2);
    voice.bandpass.frequency.setTargetAtTime(1450 + brightness * 2250 + flow * 280, now, 0.16);
    voice.bandpass.Q.setTargetAtTime(0.72 + trickle * 0.68, now, 0.2);
    voice.lowpass.frequency.setTargetAtTime(3200 + brightness * 4200, now, 0.22);
  }

  #spawnEddy(io: NatureVoiceIO, flow: number, turbulence: number, brightness: number): void {
    if (!this.#dry || !this.#wet) return;
    const { ctx } = io;
    const now = ctx.currentTime + 0.01;
    const duration = randomBetween(0.28, 0.66) * (0.82 + turbulence * 0.42);
    const strength = 0.012 + turbulence * 0.058 + flow * 0.014;

    let index = Math.floor(Math.random() * EDDY_ANCHORS.length);
    if (EDDY_ANCHORS.length > 1 && index === this.#lastEddy) index = (index + 1) % EDDY_ANCHORS.length;
    this.#lastEddy = index;
    const anchor = EDDY_ANCHORS[index];

    const panner = ctx.createPanner();
    configureWaterPanner(panner);
    const fallbackY = this.#surfaceY
      ? this.#surfaceY(anchor.x, anchor.z)
      : this.#surfaceYForExistingGraph();
    setPannerPosition(panner, ctx, anchor.x, fallbackY, anchor.z);
    panner.connect(this.#dry);
    panner.connect(this.#wet);

    // A short filtered rush curls downward in pitch, while a tiny resonant
    // bubble gives the ear a readable vortex/rock interaction without turning
    // the unified stream into a field of discrete droplets.
    const noise = ctx.createBufferSource();
    noise.buffer = io.noise;
    noise.playbackRate.value = randomBetween(0.82, 1.28);
    const swirl = ctx.createBiquadFilter();
    swirl.type = "bandpass";
    const startFrequency = 1150 + brightness * 2300 + Math.random() * 700;
    swirl.frequency.setValueAtTime(startFrequency, now);
    swirl.frequency.exponentialRampToValueAtTime(Math.max(220, startFrequency * 0.32), now + duration);
    swirl.Q.value = 0.8 + turbulence * 2.1;
    const rushGain = ctx.createGain();
    rushGain.gain.setValueAtTime(EPS, now);
    rushGain.gain.exponentialRampToValueAtTime(strength, now + Math.min(0.045, duration * 0.18));
    rushGain.gain.exponentialRampToValueAtTime(EPS, now + duration);
    noise.connect(swirl).connect(rushGain).connect(panner);

    const bubble = ctx.createOscillator();
    bubble.type = "sine";
    const bubbleFrequency = 230 + brightness * 210 + Math.random() * 90;
    bubble.frequency.setValueAtTime(bubbleFrequency, now);
    bubble.frequency.exponentialRampToValueAtTime(bubbleFrequency * 0.72, now + duration * 0.72);
    const bubbleGain = ctx.createGain();
    bubbleGain.gain.setValueAtTime(EPS, now);
    bubbleGain.gain.exponentialRampToValueAtTime(strength * 0.12, now + duration * 0.22);
    bubbleGain.gain.exponentialRampToValueAtTime(EPS, now + duration * 0.82);
    bubble.connect(bubbleGain).connect(panner);

    const offsetLimit = Math.max(0, io.noise.duration - duration - 0.01);
    noise.start(now, Math.random() * offsetLimit, duration);
    bubble.start(now);
    bubble.stop(now + duration);
    this.#eddies.push({
      sources: [noise, bubble],
      nodes: [swirl, rushGain, bubbleGain, panner],
      expires: now + duration + 0.08
    });
  }

  #surfaceYForExistingGraph(): number {
    const panner = this.#bridge?.panner;
    return panner?.positionY?.value ?? 0;
  }

  #reapEddies(now: number): void {
    for (let i = this.#eddies.length - 1; i >= 0; i--) {
      if (this.#eddies[i].expires > now) continue;
      disconnectEddy(this.#eddies[i], false);
      this.#eddies.splice(i, 1);
    }
  }

  #destroyGraph(): void {
    for (const eddy of this.#eddies) disconnectEddy(eddy, true);
    this.#eddies.length = 0;
    disposeContinuousVoice(this.#bridge);
    disposeContinuousVoice(this.#pondEntry);
    this.#bridge = null;
    this.#pondEntry = null;
    disconnectSafely(this.#dry);
    disconnectSafely(this.#wet);
    this.#dry = null;
    this.#wet = null;
    if (this.#externalAwake) {
      this.#nature.setExternalAwake(false);
      this.#externalAwake = false;
    }
  }

  #requestSharedContext(): void {
    this.#nature.setExternalAwake(true);
    this.#externalAwake = true;
  }
}

function distanceToWaterAudio(x: number, z: number): number {
  return Math.min(
    Math.hypot(x - BRIDGE_ANCHOR.x, z - BRIDGE_ANCHOR.z),
    Math.hypot(x - POND_ENTRY_ANCHOR.x, z - POND_ENTRY_ANCHOR.z)
  );
}

function configureWaterPanner(panner: PannerNode): void {
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 5.5;
  panner.rolloffFactor = 0.72;
  panner.maxDistance = 95;
}

function setPannerPosition(
  panner: PannerNode,
  ctx: AudioContext,
  x: number,
  y: number,
  z: number
): void {
  if (panner.positionX) {
    const now = ctx.currentTime;
    panner.positionX.setValueAtTime(x, now);
    panner.positionY.setValueAtTime(y, now);
    panner.positionZ.setValueAtTime(z, now);
  } else {
    panner.setPosition(x, y, z);
  }
}

function disposeContinuousVoice(voice: ContinuousVoice | null): void {
  if (!voice) return;
  stopSafely(voice.source);
  stopSafely(voice.lfo);
  for (const node of [
    voice.source,
    voice.highpass,
    voice.bandpass,
    voice.lowpass,
    voice.level,
    voice.panner,
    voice.lfo,
    voice.lfoDepth
  ]) {
    disconnectSafely(node);
  }
}

function disconnectEddy(eddy: ActiveEddy, stop: boolean): void {
  if (stop) for (const source of eddy.sources) stopSafely(source);
  for (const source of eddy.sources) disconnectSafely(source);
  for (const node of eddy.nodes) disconnectSafely(node);
}

function stopSafely(source: AudioScheduledSourceNode): void {
  try {
    source.stop();
  } catch {
    // Already ended or never scheduled during context teardown.
  }
}

function disconnectSafely(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    // Shared-context teardown can race optional feature disposal.
  }
}

function approach(current: number, target: number, dt: number, rate: number): number {
  return current + (target - current) * (1 - Math.exp(-dt * rate));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
