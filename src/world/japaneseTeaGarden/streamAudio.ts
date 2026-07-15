// Procedural water sound for the Japanese Tea Garden's connected Drum Bridge
// stream and south pond. This module deliberately owns no AudioContext and
// fetches no sample: it shapes NatureSoundscape's shared noise buffer, routes
// through its shared World/mute bus and leaves gesture unlock/listener updates to
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

export type TeaGardenWaterRippleKind = "paint" | "foot" | "ball" | "koi";

export type TeaGardenWaterRippleColor = {
  /** Linear or sRGB channel in the normalized 0..1 range. */
  r: number;
  g: number;
  b: number;
};

/**
 * One accepted visual water impulse. Values are deliberately normalized at
 * the garden boundary so the compute bloom and procedural sound share a
 * single expressive envelope.
 */
export type TeaGardenWaterRippleAudioEvent = TeaGardenStreamAudioPosition & {
  kind: TeaGardenWaterRippleKind;
  /** Normalized impact energy, 0..1. */
  energy: number;
  /** Dye concentration (paint currently uses 0.72..1.18). */
  dyeAmount?: number;
  /** Accepted visual impulse footprint in world metres. */
  rippleRadius?: number;
  /** Visual dye footprint in world metres (paint currently uses 0.48..0.82). */
  dyeRadius?: number;
  color?: TeaGardenWaterRippleColor;
  /** Local downstream velocity energy, normalized to 0..1. */
  flow?: number;
  /** Local curl/obstacle energy, normalized to 0..1. */
  turbulence?: number;
};

export type TeaGardenPaintRippleAudioEvent = Omit<TeaGardenWaterRippleAudioEvent, "kind"> & {
  dyeAmount: number;
  dyeRadius: number;
  color: TeaGardenWaterRippleColor;
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
    audibleRadius: { v: 46, min: 18, max: 90, step: 1, label: "audible radius" },
    rippleImpacts: { v: true, label: "ripple impacts" },
    impactVolume: { v: 0.72, min: 0, max: 1.5, step: 0.01, label: "impact volume" },
    plop: { v: 0.72, min: 0, max: 1.5, step: 0.01, label: "entry plop" },
    rippleTail: { v: 0.56, min: 0, max: 1.5, step: 0.01, label: "ripple tail" },
    feyBloom: { v: 0.34, min: 0, max: 1.2, step: 0.01, label: "fey bloom" },
    colorTimbre: { v: 0.28, min: 0, max: 1, step: 0.01, label: "color timbre" },
    impactReverb: { v: 0.32, min: 0, max: 0.8, step: 0.01, label: "impact space" },
    impactCooldown: { v: 0.045, min: 0.02, max: 0.2, step: 0.005, label: "paint cooldown (s)" },
    koiVolume: { v: 0.55, min: 0, max: 1.5, step: 0.01, label: "koi movement" },
    koiCooldown: { v: 0.68, min: 0.45, max: 1.4, step: 0.01, label: "koi gap (s)" },
    koiAudibleRadius: { v: 30, min: 12, max: 55, step: 1, label: "koi audible radius" },
    maxImpactVoices: { v: 10, min: 2, max: 16, step: 1, label: "impact voices" }
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

type ActiveRippleImpact = {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  expires: number;
};

// Small Tatsuyama-style stones along the authored stream trace. Accents hop
// between these anchors so the turbulence reads as water moving around rocks,
// rather than a mono loop pinned under the bridge.
export const TEA_GARDEN_STREAM_AUDIO_ANCHORS = {
  bridge: { x: -2274.2, z: 2193.2 },
  pondEntry: { x: -2290.4, z: 2202.4 },
  eddies: [
    { x: -2265.8, z: 2186.8 },
    { x: -2267, z: 2187.4 },
    { x: -2280.6, z: 2197.4 },
    { x: -2283.8, z: 2198 },
    { x: -2288.2, z: 2200.6 }
  ]
} as const satisfies {
  bridge: WaterAnchor;
  pondEntry: WaterAnchor;
  eddies: readonly WaterAnchor[];
};

const BRIDGE_ANCHOR = TEA_GARDEN_STREAM_AUDIO_ANCHORS.bridge;
const POND_ENTRY_ANCHOR = TEA_GARDEN_STREAM_AUDIO_ANCHORS.pondEntry;
const EDDY_ANCHORS = TEA_GARDEN_STREAM_AUDIO_ANCHORS.eddies;

const EPS = 0.0001;
const MAX_ACTIVE_EDDIES = 2;
const PARK_THRESHOLD = 0.0015;
const IMPACT_AWAKE_PAD = 0.35;
const DEFAULT_WATER_COLOR: TeaGardenWaterRippleColor = { r: 0.2, g: 0.78, b: 0.84 };
const RIPPLE_KIND_COOLDOWN: Record<TeaGardenWaterRippleKind, number> = {
  paint: 0.045,
  foot: 0.12,
  ball: 0.12,
  koi: 0.45
};
const RIPPLE_KIND_CHARACTER: Record<
  TeaGardenWaterRippleKind,
  { transient: number; ripple: number; fey: number }
> = {
  paint: { transient: 1, ripple: 1, fey: 1 },
  foot: { transient: 0.34, ripple: 0.58, fey: 0.08 },
  // BallImpactAudio already supplies the weighty plonk. This voice adds only
  // the surface-sized ripple detail so the two systems do not double the hit.
  ball: { transient: 0.12, ripple: 0.5, fey: 0.12 },
  koi: { transient: 0, ripple: 1, fey: 0 }
};

/**
 * Lazy, procedural, positional stream/pond audio.
 *
 * Call once per frame near NatureSoundscape.update. Calling first lets the
 * shared context observe this feature's awake request in the same frame; the
 * nature pass then refreshes listener orientation, visibility and FX/mute state.
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
  #impactDry: GainNode | null = null;
  #impactWet: GainNode | null = null;
  #rippleImpacts: ActiveRippleImpact[] = [];
  #distanceGain = 0;
  #distance = Number.POSITIVE_INFINITY;
  #eddyTimer = 0.45;
  #lastEddy = -1;
  #graphBuilds = 0;
  #impactGraphBuilds = 0;
  #impactAwakeHold = 0;
  #lastRippleAt: Record<TeaGardenWaterRippleKind, number> = {
    paint: -Infinity,
    foot: -Infinity,
    ball: -Infinity,
    koi: -Infinity
  };
  #rippleAccepted: Record<TeaGardenWaterRippleKind, number> = {
    paint: 0,
    foot: 0,
    ball: 0,
    koi: 0
  };
  #rippleDropped = 0;
  #rippleDroppedByKind: Record<TeaGardenWaterRippleKind, number> = {
    paint: 0,
    foot: 0,
    ball: 0,
    koi: 0
  };
  #lastRippleEnergy = 0;
  #lastRippleHue = 0;
  #lastKoiMotion = 0;
  #lastKoiRippleDuration = 0;
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
      activeEddies: this.#eddies.length,
      impactGraph: this.#impactDry !== null,
      impactGraphBuilds: this.#impactGraphBuilds,
      impactAwakeHold: +this.#impactAwakeHold.toFixed(2),
      activeRippleImpacts: this.#rippleImpacts.length,
      rippleAccepted: { ...this.#rippleAccepted },
      rippleDropped: this.#rippleDropped,
      rippleDroppedByKind: { ...this.#rippleDroppedByKind },
      lastRippleEnergy: +this.#lastRippleEnergy.toFixed(3),
      lastRippleHue: +this.#lastRippleHue.toFixed(3),
      lastKoiMotion: +this.#lastKoiMotion.toFixed(3),
      lastKoiRippleDuration: +this.#lastKoiRippleDuration.toFixed(3)
    };
  }

  /**
   * Sonify an impulse only after the visual simulation accepted it. Returns
   * false when audio is disabled, still gesture-locked, or deliberately
   * coalesced by the bounded cooldown/polyphony guard.
   */
  playRippleImpact(event: TeaGardenWaterRippleAudioEvent): boolean {
    if (this.#disposed) return false;
    const tuning = TEA_GARDEN_STREAM_AUDIO_TUNING.values;
    if (
      !Boolean(tuning.enabled) ||
      !Boolean(tuning.rippleImpacts) ||
      Number(tuning.master) <= 0.001 ||
      Number(tuning.impactVolume) <= 0.001
    ) {
      return false;
    }

    const io = (this.#io ??= this.#nature.voiceBus());
    // Visual impulses remain authoritative while gesture-locked, but do not
    // queue suspended one-shots that would all begin together on the first
    // unlock gesture.
    if (!io || io.ctx.state !== "running") return false;
    const now = io.ctx.currentTime;
    this.#reapRippleImpacts(now);
    const kind = event.kind;
    const cooldown = kind === "paint"
      ? Math.max(RIPPLE_KIND_COOLDOWN.paint, Number(tuning.impactCooldown))
      : kind === "koi"
        ? Math.max(RIPPLE_KIND_COOLDOWN.koi, Number(tuning.koiCooldown))
        : RIPPLE_KIND_COOLDOWN[kind];
    if (now - this.#lastRippleAt[kind] < cooldown) {
      this.#rippleDropped++;
      this.#rippleDroppedByKind[kind]++;
      return false;
    }
    const maxVoices = Math.round(clamp(Number(tuning.maxImpactVoices), 2, 16));
    if (this.#rippleImpacts.length >= maxVoices) {
      this.#rippleDropped++;
      this.#rippleDroppedByKind[kind]++;
      return false;
    }

    this.#ensureImpactGraph(io);
    if (!this.#impactDry || !this.#impactWet) return false;
    this.#syncImpactMix(io.ctx.currentTime);
    const duration = this.#spawnRippleImpact(io, event);
    this.#lastRippleAt[kind] = now;
    this.#rippleAccepted[kind]++;
    this.#lastRippleEnergy = clamp01(finiteOr(event.energy, 0));
    this.#impactAwakeHold = Math.max(this.#impactAwakeHold, duration + IMPACT_AWAKE_PAD);
    this.#requestSharedContext();
    return true;
  }

  /** Paint-specific convenience API used by the garden's dye injection path. */
  playPaintRippleImpact(event: TeaGardenPaintRippleAudioEvent): boolean {
    return this.playRippleImpact({ ...event, kind: "paint" });
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
    // One-shot impacts have an independent positional output graph. Keep their
    // tails alive and reap them even if the continuous stream graph is parked.
    if (io) {
      const impactNow = io.ctx.currentTime;
      this.#reapRippleImpacts(impactNow);
      if (this.#impactAwakeHold > 0 || this.#rippleImpacts.length > 0) {
        this.#impactAwakeHold = Math.max(0, this.#impactAwakeHold - safeDt);
        this.#requestSharedContext();
        this.#syncImpactMix(impactNow);
      }
      if (
        this.#impactDry &&
        this.#impactAwakeHold <= 0 &&
        this.#rippleImpacts.length === 0
      ) {
        this.#destroyImpactGraph();
      }
    }
    if (!io || !this.#bridge || !this.#pondEntry || !this.#dry || !this.#wet) {
      this.#releaseSharedContextIfIdle();
      return;
    }
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
    this.#releaseSharedContextIfIdle();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#destroyGraph();
    this.#destroyImpactGraph();
    this.#io = null;
    this.#distanceGain = 0;
  }

  #buildGraph(io: NatureVoiceIO, fallbackY: number): void {
    if (this.#bridge || this.#disposed) return;
    const { ctx } = io;
    this.#dry = ctx.createGain();
    this.#dry.gain.value = 0;
    // Water is environmental ambience, independent of the wildlife/bed enable
    // switch. worldBus supplies HUD World/mute + visibility through the
    // shared limiter; #requestSharedContext keeps it alive only while nearby.
    this.#dry.connect(io.worldBus);

    this.#wet = ctx.createGain();
    this.#wet.gain.value = 0;
    this.#wet.connect(io.worldReverbSend);

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

  #ensureImpactGraph(io: NatureVoiceIO): void {
    if (this.#impactDry || this.#disposed) return;
    const { ctx } = io;
    this.#impactDry = ctx.createGain();
    this.#impactDry.gain.value = 0;
    this.#impactDry.connect(io.alwaysBus);
    this.#impactWet = ctx.createGain();
    this.#impactWet.gain.value = 0;
    // Tail flicks, footsteps, balls, and paint are gameplay one-shots. Follow
    // the current mixer split so the FX slider/reverb owns them independently
    // from the continuous regional water bed.
    this.#impactWet.connect(io.effectsReverbSend);
    this.#impactGraphBuilds++;
  }

  #syncImpactMix(now: number): void {
    if (!this.#impactDry || !this.#impactWet) return;
    const tuning = TEA_GARDEN_STREAM_AUDIO_TUNING.values;
    const enabled = Boolean(tuning.enabled) && Boolean(tuning.rippleImpacts);
    const master = enabled
      ? Math.max(0, Number(tuning.master)) * Math.max(0, Number(tuning.impactVolume))
      : 0;
    this.#impactDry.gain.setTargetAtTime(master, now, 0.035);
    this.#impactWet.gain.setTargetAtTime(
      master * clamp(Number(tuning.impactReverb), 0, 1) * Number(NATURE_AUDIO_TUNING.values.reverb),
      now,
      0.05
    );
  }

  #spawnRippleImpact(io: NatureVoiceIO, event: TeaGardenWaterRippleAudioEvent): number {
    const dry = this.#impactDry;
    const wet = this.#impactWet;
    if (!dry || !wet) return 0;
    const { ctx } = io;
    const tuning = TEA_GARDEN_STREAM_AUDIO_TUNING.values;
    const now = ctx.currentTime + 0.008;
    const energy = clamp01(finiteOr(event.energy, 0));
    const dye = clamp(finiteOr(event.dyeAmount, 0), 0, 1.18) / 1.18;
    const radius = clamp(finiteOr(event.rippleRadius ?? event.dyeRadius, 0.48), 0.2, 1.2);
    const radiusN = clamp01((radius - 0.42) / 0.52);
    const flow = clamp01(finiteOr(event.flow, 0));
    const turbulence = clamp01(finiteOr(event.turbulence, energy * 0.55));
    const koiMotion = event.kind === "koi"
      ? clamp01(flow * 2.4 + energy * 1.4 + turbulence * 0.25)
      : 0;
    const character = RIPPLE_KIND_CHARACTER[event.kind];
    const color = sanitizeColor(event.color ?? DEFAULT_WATER_COLOR);
    const hsl = rgbToHsl(color.r, color.g, color.b);
    this.#lastRippleHue = hsl.h;
    if (event.kind === "koi") this.#lastKoiMotion = koiMotion;

    const panner = ctx.createPanner();
    configureImpactPanner(panner, event.kind, Number(tuning.koiAudibleRadius));
    setPannerPosition(
      panner,
      ctx,
      finiteOr(event.x, 0),
      finiteOr(event.y, 0),
      finiteOr(event.z, 0)
    );
    panner.connect(dry);
    panner.connect(wet);

    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [panner];
    const koiRadiusN = clamp01((radius - 0.2) / 0.16);
    const entryDuration = event.kind === "koi" ? 0 : 0.06 + energy * 0.12;
    const rippleDuration = event.kind === "koi"
      ? clamp(0.18 + koiMotion * 0.2 + koiRadiusN * 0.08 + turbulence * 0.04, 0.18, 0.52)
      : clamp(
          0.45 + energy * 0.46 + radiusN * 0.22 + turbulence * 0.27,
          0.45,
          1.4
        );
    const feyDuration = event.kind === "koi"
      ? 0
      : clamp(
          0.7 + energy * 0.58 + dye * 0.4 + radiusN * 0.22 + turbulence * 0.3,
          0.7,
          2.2
        );
    if (event.kind === "koi") this.#lastKoiRippleDuration = rippleDuration;

    // Concise entry cavity plus a filtered splash — firmly water-first, with
    // no decal-like sustained hiss after the visual entry crown has collapsed.
    if (character.transient > 0.001 && Number(tuning.plop) > 0.001) {
      const transientLevel =
        (0.055 + energy * 0.16) * character.transient * Number(tuning.plop);
      const bubble = ctx.createOscillator();
      bubble.type = "sine";
      const bubbleHz = 470 - energy * 145 + radiusN * 35;
      bubble.frequency.setValueAtTime(bubbleHz, now);
      bubble.frequency.exponentialRampToValueAtTime(bubbleHz * 0.52, now + entryDuration);
      const bubbleGain = ctx.createGain();
      bubbleGain.gain.setValueAtTime(EPS, now);
      bubbleGain.gain.exponentialRampToValueAtTime(transientLevel, now + 0.006);
      bubbleGain.gain.exponentialRampToValueAtTime(EPS, now + entryDuration);
      bubble.connect(bubbleGain).connect(panner);

      const splash = ctx.createBufferSource();
      splash.buffer = io.noise;
      splash.playbackRate.value = randomBetween(0.92, 1.28);
      const splashBand = ctx.createBiquadFilter();
      splashBand.type = "bandpass";
      splashBand.frequency.setValueAtTime(1850 + energy * 2100, now);
      splashBand.frequency.exponentialRampToValueAtTime(720 + flow * 260, now + entryDuration);
      splashBand.Q.value = 0.55 + turbulence * 0.7;
      const splashGain = ctx.createGain();
      splashGain.gain.setValueAtTime(EPS, now);
      splashGain.gain.exponentialRampToValueAtTime(transientLevel * 0.7, now + 0.004);
      splashGain.gain.exponentialRampToValueAtTime(EPS, now + entryDuration);
      splash.connect(splashBand).connect(splashGain).connect(panner);

      const splashOffset = Math.random() * Math.max(0.01, io.noise.duration - entryDuration - 0.01);
      bubble.start(now);
      bubble.stop(now + entryDuration + 0.02);
      splash.start(now, splashOffset, entryDuration + 0.01);
      sources.push(bubble, splash);
      nodes.push(bubbleGain, splashBand, splashGain);
    }

    // A narrow noise ring falls in pitch as the visible ring expands. A slow
    // filter wobble follows local flow/turbulence, reading as moving surface
    // water rather than a static reverb tail.
    if (character.ripple > 0.001 && Number(tuning.rippleTail) > 0.001) {
      const ripple = ctx.createBufferSource();
      ripple.buffer = io.noise;
      ripple.playbackRate.value = event.kind === "koi"
        ? randomBetween(0.68, 0.92)
        : randomBetween(0.72, 1.05);
      const rippleBand = ctx.createBiquadFilter();
      rippleBand.type = "bandpass";
      const rippleStartHz = event.kind === "koi"
        ? 650 + koiMotion * 640 + turbulence * 180
        : 1180 + energy * 920 + turbulence * 360;
      rippleBand.frequency.setValueAtTime(rippleStartHz, now);
      rippleBand.frequency.exponentialRampToValueAtTime(
        event.kind === "koi" ? 260 + flow * 150 : 330 + flow * 210,
        now + rippleDuration
      );
      rippleBand.Q.value = event.kind === "koi"
        ? 1.15 + koiRadiusN * 0.8
        : 2.2 + radiusN * 2.1;
      const rippleLevel = event.kind === "koi"
        ? (0.0035 + koiMotion * 0.012) *
          character.ripple *
          Number(tuning.rippleTail) *
          Number(tuning.koiVolume)
        : (0.014 + energy * 0.045 + radiusN * 0.014) *
          character.ripple *
          Number(tuning.rippleTail);
      const rippleGain = ctx.createGain();
      rippleGain.gain.setValueAtTime(EPS, now);
      rippleGain.gain.exponentialRampToValueAtTime(
        Math.max(EPS, rippleLevel),
        now + (event.kind === "koi" ? 0.014 + koiMotion * 0.012 : 0.035)
      );
      rippleGain.gain.exponentialRampToValueAtTime(EPS, now + rippleDuration);
      const rippleLfo = ctx.createOscillator();
      rippleLfo.type = "sine";
      rippleLfo.frequency.value = event.kind === "koi"
        ? 4.8 + koiMotion * 2.2
        : 3.6 + flow * 1.8 + turbulence * 1.2;
      const rippleDepth = ctx.createGain();
      rippleDepth.gain.value = event.kind === "koi"
        ? 24 + koiMotion * 52
        : 45 + turbulence * 105;
      rippleLfo.connect(rippleDepth).connect(rippleBand.detune);
      ripple.connect(rippleBand).connect(rippleGain).connect(panner);

      const rippleOffset = Math.random() * Math.max(0.01, io.noise.duration - rippleDuration - 0.01);
      ripple.start(now, rippleOffset, rippleDuration + 0.01);
      rippleLfo.start(now);
      rippleLfo.stop(now + rippleDuration + 0.02);
      sources.push(ripple, rippleLfo);
      nodes.push(rippleBand, rippleGain, rippleDepth);
    }

    // The dye bloom gets a restrained glass overtone. Hue moves less than a
    // whole tone around the wheel; saturation/luminance alter overtone balance
    // and brightness, keeping color audible without becoming a melody/UI cue.
    if (character.fey > 0.001 && Number(tuning.feyBloom) > 0.001) {
      const timbre = clamp01(Number(tuning.colorTimbre));
      const huePhase = Math.sin((hsl.h + 0.08) * Math.PI * 2);
      const semitones = huePhase * 0.85 * timbre;
      const glassHz = (505 + energy * 72 + flow * 34) * Math.pow(2, semitones / 12);
      const feyLevel =
        (0.008 + dye * 0.024 + energy * 0.009) * character.fey * Number(tuning.feyBloom);
      const glass = ctx.createOscillator();
      glass.type = "sine";
      glass.frequency.setValueAtTime(glassHz, now);
      glass.frequency.exponentialRampToValueAtTime(
        glassHz * (1.012 + flow * 0.018),
        now + feyDuration
      );
      const glassGain = ctx.createGain();
      glassGain.gain.setValueAtTime(EPS, now);
      glassGain.gain.exponentialRampToValueAtTime(feyLevel, now + 0.055 + radiusN * 0.025);
      glassGain.gain.exponentialRampToValueAtTime(EPS, now + feyDuration);
      glass.connect(glassGain).connect(panner);

      const overtone = ctx.createOscillator();
      overtone.type = "sine";
      overtone.frequency.setValueAtTime(glassHz * (2.002 + huePhase * 0.006 * timbre), now);
      overtone.frequency.exponentialRampToValueAtTime(
        glassHz * (2.025 + flow * 0.014),
        now + feyDuration * 0.82
      );
      const overtoneGain = ctx.createGain();
      const overtoneMix = 0.12 + hsl.s * 0.11 + hsl.l * 0.05;
      overtoneGain.gain.setValueAtTime(EPS, now);
      overtoneGain.gain.exponentialRampToValueAtTime(
        Math.max(EPS, feyLevel * overtoneMix * timbre),
        now + 0.085
      );
      overtoneGain.gain.exponentialRampToValueAtTime(EPS, now + feyDuration * 0.84);
      overtone.connect(overtoneGain).connect(panner);

      glass.start(now);
      glass.stop(now + feyDuration + 0.03);
      overtone.start(now + 0.018);
      overtone.stop(now + feyDuration + 0.03);
      sources.push(glass, overtone);
      nodes.push(glassGain, overtoneGain);
    }

    const duration = Math.max(entryDuration, rippleDuration, feyDuration);
    this.#rippleImpacts.push({ sources, nodes, expires: now + duration + 0.08 });
    return duration;
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

  #reapRippleImpacts(now: number): void {
    for (let i = this.#rippleImpacts.length - 1; i >= 0; i--) {
      if (this.#rippleImpacts[i].expires > now) continue;
      disconnectRippleImpact(this.#rippleImpacts[i], false);
      this.#rippleImpacts.splice(i, 1);
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
    this.#releaseSharedContextIfIdle();
  }

  #destroyImpactGraph(): void {
    for (const impact of this.#rippleImpacts) disconnectRippleImpact(impact, true);
    this.#rippleImpacts.length = 0;
    disconnectSafely(this.#impactDry);
    disconnectSafely(this.#impactWet);
    this.#impactDry = null;
    this.#impactWet = null;
    this.#impactAwakeHold = 0;
    this.#releaseSharedContextIfIdle();
  }

  #requestSharedContext(): void {
    this.#nature.setExternalAwake(true);
    this.#externalAwake = true;
  }

  #releaseSharedContextIfIdle(): void {
    if (
      this.#externalAwake &&
      !this.#bridge &&
      this.#impactAwakeHold <= 0 &&
      this.#rippleImpacts.length === 0
    ) {
      this.#nature.setExternalAwake(false);
      this.#externalAwake = false;
    }
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

function configureImpactPanner(
  panner: PannerNode,
  kind: TeaGardenWaterRippleKind,
  koiAudibleRadius: number
): void {
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  if (kind === "koi") {
    // Koi are intimate surface details, not a pond-wide emitter. Their faster
    // inverse falloff leaves them readable near the fish and effectively
    // absent across the garden, while motion still scales the source envelope.
    panner.refDistance = 2.6;
    panner.rolloffFactor = 1.35;
    panner.maxDistance = clamp(koiAudibleRadius, 12, 55);
  } else {
    panner.refDistance = 4.5;
    panner.rolloffFactor = 0.85;
    panner.maxDistance = 72;
  }
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

function disconnectRippleImpact(impact: ActiveRippleImpact, stop: boolean): void {
  if (stop) for (const source of impact.sources) stopSafely(source);
  for (const source of impact.sources) disconnectSafely(source);
  for (const node of impact.nodes) disconnectSafely(node);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function sanitizeColor(color: TeaGardenWaterRippleColor): TeaGardenWaterRippleColor {
  return {
    r: clamp01(finiteOr(color.r, DEFAULT_WATER_COLOR.r)),
    g: clamp01(finiteOr(color.g, DEFAULT_WATER_COLOR.g)),
    b: clamp01(finiteOr(color.b, DEFAULT_WATER_COLOR.b))
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) * 0.5;
  if (delta <= EPS) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return { h: ((h / 6) + 1) % 1, s: clamp01(s), l: clamp01(l) };
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
