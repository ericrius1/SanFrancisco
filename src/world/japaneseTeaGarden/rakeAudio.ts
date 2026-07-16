// Procedural ASMR sand-rake sound for the karesansui dry garden. Like the
// stream audio sibling, this module owns no AudioContext and fetches no sample:
// it shapes NatureSoundscape's shared noise buffer, routes through the shared
// FX/mute + reverb buses, and leaves gesture-unlock/listener updates to that
// engine. Construction is inert; the graph is built only once the player is
// actually carrying the rake and torn down after the stroke fades to silence.
//
// The sound is three continuous filtered-noise voices — a warm low body, the
// main sandy wash, and a fine airy grain layer — whose loudness and brightness
// follow how fast the tines drag. A flutter LFO adds the granular texture; its
// rate tracks grains-per-second (drag speed ÷ tine spacing), so raking faster
// speeds up the grain shimmer exactly as real sand under a wooden rake does.

import { tunables } from "../../core/persist";
import { type NatureSoundscape } from "../../audio/natureSoundscape";

export type RakeAudioFrame = {
  /** Player is carrying the rake — keep the shared context/graph alive. */
  holding: boolean;
  /** Tines are on the sand (not the path or a rock) — gate the wash on/off. */
  onSand: boolean;
  /** Tine drag speed through the sand, world metres/second. */
  speed: number;
  /** Contact point in the sand — where the sound is spatialised from. */
  x: number;
  y: number;
  z: number;
};

/** Tine spacing of the seven-tine rake (m); the flutter tracks grains/second. */
const TINE_SPACING = 0.15;
const PARK_THRESHOLD = 0.0016;

export const TEA_GARDEN_RAKE_AUDIO_TUNING = tunables("japaneseTeaGarden.rakeAudio", {
  enabled: { v: true, label: "enabled" },
  master: { v: 0.6, min: 0, max: 1, step: 0.01, label: "rake volume" },
  body: { v: 0.55, min: 0, max: 1.5, step: 0.01, label: "low body" },
  wash: { v: 1, min: 0, max: 1.5, step: 0.01, label: "sandy wash" },
  air: { v: 0.62, min: 0, max: 1.5, step: 0.01, label: "fine grain" },
  brightness: { v: 0.5, min: 0, max: 1, step: 0.01, label: "brightness" },
  grain: { v: 0.5, min: 0, max: 1, step: 0.01, label: "grain flutter" },
  reverb: { v: 0.2, min: 0, max: 0.6, step: 0.01, label: "garden space" },
  // Drag speed (m/s) that maps to a full-bodied stroke. Foot speed is halved
  // while raking, so a brisk stroke lands around here.
  refSpeed: { v: 1.7, min: 0.4, max: 4, step: 0.1, label: "full-stroke speed" }
});

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

type SandVoice = {
  source: AudioBufferSourceNode;
  highpass: BiquadFilterNode;
  bandpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  level: GainNode;
};

type VoiceCharacter = {
  playbackRate: number;
  highpass: number;
  bandpass: number;
  lowpass: number;
  q: number;
  offset: number;
};

/**
 * Lazy, procedural, positional sand-rake audio. Call once per frame from the
 * dry-landscape update with the live drag signals; it is silent until the tines
 * are moving through the sand.
 */
export class TeaGardenRakeAudio {
  #nature: NatureSoundscape;
  #io: NatureVoiceIO | null = null;
  #dry: GainNode | null = null;
  #wet: GainNode | null = null;
  #panner: PannerNode | null = null;
  #body: SandVoice | null = null;
  #wash: SandVoice | null = null;
  #air: SandVoice | null = null;
  // Flutter: one LFO whose rate is grains/second; it shimmers the wash band and
  // trembles the grain level so the texture reads as discrete sand under tines.
  #flutter: OscillatorNode | null = null;
  #flutterShimmer: GainNode | null = null; // → wash.bandpass.frequency
  #flutterTremolo: GainNode | null = null; // → air.level.gain
  #env = 0; // smoothed 0..1 stroke energy
  #idle = 0; // seconds silent while not holding, for teardown
  #graphBuilds = 0;
  #externalAwake = false;
  #disposed = false;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  /** Read-only surface for lazy-load / node-lifecycle probes. */
  get debugState() {
    return {
      graph: this.#wash !== null,
      graphBuilds: this.#graphBuilds,
      context: this.#io?.ctx.state ?? "none",
      env: +this.#env.toFixed(3)
    };
  }

  update(dt: number, frame: RakeAudioFrame): void {
    if (this.#disposed) return;
    const safeDt = Math.min(0.1, Math.max(0, dt));
    const tuning = TEA_GARDEN_RAKE_AUDIO_TUNING.values;
    const allowed = Boolean(tuning.enabled) && Number(tuning.master) > 0.001;

    // Normalised stroke energy: only the tines actually moving through the sand
    // make sound. Standing still on the sand is silent; the path and rocks too.
    const refSpeed = Math.max(0.1, Number(tuning.refSpeed));
    const rawSpeed = Number.isFinite(frame.speed) ? Math.max(0, frame.speed) : 0;
    const target = allowed && frame.holding && frame.onSand ? clamp01(rawSpeed / refSpeed) : 0;
    // Attack a touch faster than release so each stroke reads crisply but the
    // tail stays soft and chill.
    const rate = target > this.#env ? 9 : 5;
    this.#env = approach(this.#env, target, safeDt, rate);

    // First-use gate: no voiceBus() call at boot or while the rake is racked.
    if (!this.#wash && allowed && frame.holding) {
      const io = (this.#io ??= this.#nature.voiceBus());
      if (!io || io.ctx.state === "closed") return;
      this.#requestSharedContext();
      this.#buildGraph(io, frame);
    }

    const io = this.#io;
    if (!io || !this.#wash || !this.#body || !this.#air || !this.#dry || !this.#wet || !this.#panner) {
      // Nothing built yet — track idle for symmetry, then bail.
      return;
    }

    if (frame.holding) {
      this.#requestSharedContext();
      this.#idle = 0;
    }

    const now = io.ctx.currentTime;
    this.#setPannerPosition(io, frame.x, frame.y, frame.z);

    const master = Number(tuning.master);
    this.#dry.gain.setTargetAtTime(master, now, 0.12);
    this.#wet.gain.setTargetAtTime(master * Number(tuning.reverb), now, 0.18);

    const env = this.#env;
    const brightness = clamp01(Number(tuning.brightness));
    const grain = clamp01(Number(tuning.grain));

    // ---- per-layer loudness (grain grows fastest with speed) ---------------
    const bodyLevel = env * 0.06 * Number(tuning.body);
    const washLevel = Math.pow(env, 0.85) * 0.12 * Number(tuning.wash);
    const airLevel = Math.pow(env, 1.3) * 0.06 * Number(tuning.air);
    this.#body.level.gain.setTargetAtTime(bodyLevel, now, 0.06);
    this.#wash.level.gain.setTargetAtTime(washLevel, now, 0.05);
    this.#air.level.gain.setTargetAtTime(airLevel, now, 0.05);

    // ---- brightness opens with speed (brisker strokes sound crisper) -------
    this.#body.lowpass.frequency.setTargetAtTime(360 + env * 240, now, 0.12);
    this.#wash.bandpass.frequency.setTargetAtTime(
      780 + brightness * 620 + env * 520,
      now,
      0.1
    );
    this.#wash.lowpass.frequency.setTargetAtTime(2600 + brightness * 2600 + env * 1400, now, 0.12);
    this.#air.bandpass.frequency.setTargetAtTime(
      3100 + brightness * 1500 + env * 1900,
      now,
      0.1
    );

    // ---- flutter: grains per second = drag speed ÷ tine spacing ------------
    if (this.#flutter && this.#flutterShimmer && this.#flutterTremolo) {
      const grainsPerSecond = clamp(rawSpeed / TINE_SPACING, 1.4, 22);
      this.#flutter.frequency.setTargetAtTime(grainsPerSecond, now, 0.08);
      // Depth follows the layers so silence stays clean; grain knob scales it.
      this.#flutterShimmer.gain.setTargetAtTime((90 + env * 260) * grain, now, 0.1);
      this.#flutterTremolo.gain.setTargetAtTime(airLevel * grain * 0.55, now, 0.08);
    }

    // ---- teardown once faded silent and the rake is put away ---------------
    if (!frame.holding) {
      this.#idle += safeDt;
      if (this.#env <= PARK_THRESHOLD && this.#idle > 0.4) {
        this.#destroyGraph();
        this.#env = 0;
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#destroyGraph();
    this.#io = null;
    this.#env = 0;
  }

  #buildGraph(io: NatureVoiceIO, frame: RakeAudioFrame): void {
    if (this.#wash || this.#disposed) return;
    const { ctx } = io;

    this.#dry = ctx.createGain();
    this.#dry.gain.value = 0;
    // The rake is player-action feedback independent of the wildlife/bed
    // enable switch, so it rides alwaysBus (HUD FX/mute + visibility).
    this.#dry.connect(io.alwaysBus);
    this.#wet = ctx.createGain();
    this.#wet.gain.value = 0;
    this.#wet.connect(io.effectsReverbSend);

    this.#panner = ctx.createPanner();
    this.#panner.panningModel = "HRTF";
    this.#panner.distanceModel = "inverse";
    this.#panner.refDistance = 3.2;
    this.#panner.rolloffFactor = 0.85;
    this.#panner.maxDistance = 40;
    this.#setPannerPosition(io, frame.x, frame.y, frame.z);
    this.#panner.connect(this.#dry);
    this.#panner.connect(this.#wet);

    this.#body = this.#makeVoice(io, {
      playbackRate: 0.72,
      highpass: 120,
      bandpass: 430,
      lowpass: 520,
      q: 0.5,
      offset: 0.31
    });
    this.#wash = this.#makeVoice(io, {
      playbackRate: 0.98,
      highpass: 420,
      bandpass: 1050,
      lowpass: 4200,
      q: 0.7,
      offset: 1.27
    });
    this.#air = this.#makeVoice(io, {
      playbackRate: 1.24,
      highpass: 2400,
      bandpass: 3800,
      lowpass: 9200,
      q: 0.9,
      offset: 2.53
    });

    // Flutter LFO: shimmer the wash band and tremolo the grains at grains/sec.
    this.#flutter = ctx.createOscillator();
    this.#flutter.type = "triangle";
    this.#flutter.frequency.value = 6;
    this.#flutterShimmer = ctx.createGain();
    this.#flutterShimmer.gain.value = 0;
    this.#flutterTremolo = ctx.createGain();
    this.#flutterTremolo.gain.value = 0;
    this.#flutter.connect(this.#flutterShimmer).connect(this.#wash.bandpass.frequency);
    this.#flutter.connect(this.#flutterTremolo).connect(this.#air.level.gain);
    this.#flutter.start();

    this.#graphBuilds++;
  }

  #makeVoice(io: NatureVoiceIO, character: VoiceCharacter): SandVoice {
    const { ctx } = io;
    const source = ctx.createBufferSource();
    source.buffer = io.noise;
    source.loop = true;
    source.playbackRate.value = character.playbackRate;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = character.highpass;
    highpass.Q.value = 0.3;
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

    source.connect(highpass).connect(bandpass).connect(lowpass).connect(level).connect(this.#panner!);
    source.start(0, character.offset % Math.max(0.01, io.noise.duration));
    return { source, highpass, bandpass, lowpass, level };
  }

  #setPannerPosition(io: NatureVoiceIO, x: number, y: number, z: number): void {
    const panner = this.#panner;
    if (!panner) return;
    if (panner.positionX) {
      const now = io.ctx.currentTime;
      // Glide so a moving contact point never zippers the pan.
      panner.positionX.setTargetAtTime(x, now, 0.05);
      panner.positionY.setTargetAtTime(y, now, 0.05);
      panner.positionZ.setTargetAtTime(z, now, 0.05);
    } else {
      panner.setPosition(x, y, z);
    }
  }

  #destroyGraph(): void {
    stopSafely(this.#flutter);
    disconnectSafely(this.#flutter);
    disconnectSafely(this.#flutterShimmer);
    disconnectSafely(this.#flutterTremolo);
    this.#flutter = null;
    this.#flutterShimmer = null;
    this.#flutterTremolo = null;
    disposeVoice(this.#body);
    disposeVoice(this.#wash);
    disposeVoice(this.#air);
    this.#body = null;
    this.#wash = null;
    this.#air = null;
    disconnectSafely(this.#panner);
    disconnectSafely(this.#dry);
    disconnectSafely(this.#wet);
    this.#panner = null;
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

function disposeVoice(voice: SandVoice | null): void {
  if (!voice) return;
  stopSafely(voice.source);
  for (const node of [voice.source, voice.highpass, voice.bandpass, voice.lowpass, voice.level]) {
    disconnectSafely(node);
  }
}

function stopSafely(source: AudioScheduledSourceNode | null): void {
  try {
    source?.stop();
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
