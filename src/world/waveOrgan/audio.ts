// The Wave Organ's voices. Each pipe is a resonant column: looped noise pushed
// through stacked bandpasses at the pipe's fundamental and its low overtones,
// plus a faint sine for body, all breathing on a slow per-pipe tide LFO with
// occasional gurgle surges (the real organ's irregular slosh). Rides
// NatureSoundscape's context and world bus so the HUD volume/mute control,
// gesture unlock and limiter stay the single source of truth (dog-park idiom).
//
// States per pipe: dormant (a breath you only notice up close) → listening
// (swells while the player keeps still beside the mouth) → awake (a steady
// quiet voice). When all five wake, the hymn starts: the five voices swell in
// slow rotation around the D-minor-9 chord, tide-phased, forever.

import type { NatureSoundscape } from "../../audio/natureSoundscape";
import { WAVE_ORGAN_CENTER, PIPES } from "./layout";

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

const EPS = 0.0001;

const ORGAN_AUDIO = {
  wakeRadius: 130, // m from the site centre — beyond this the layer sleeps
  fullRadius: 55, // layer at full gain inside this
  layerGain: 0.9,
  dormantLevel: 0.05,
  listenLevel: 1.0,
  awakeLevel: 0.34,
  hymnFloor: 0.22,
  hymnSwell: 0.78,
  hymnPeriod: 19, // seconds for one rotation of the chord
  reverbCharacter: 0.6
} as const;

type PipeVoice = {
  src: AudioBufferSourceNode;
  osc: OscillatorNode;
  filters: BiquadFilterNode[];
  gain: GainNode;
  panner: PannerNode;
  send: GainNode;
  lfoPhase: number;
  lfoRate: number;
  gurgleTimer: number;
};

export type PipeAudioState = {
  /** Pipe mouth in world space (for the panner). */
  x: number;
  y: number;
  z: number;
  /** 0..1 listening progress (drives the swell while attuning). */
  listen: number;
  awakened: boolean;
};

export class WaveOrganAudio {
  #nature: NatureSoundscape;
  #io: NatureVoiceIO | null = null;
  #layer: GainNode | null = null;
  #voices: PipeVoice[] = [];
  #awake = false;
  #hymn = false;
  #hymnT = 0;
  #t = 0;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  startHymn(): void {
    this.#hymn = true;
    this.#hymnT = 0;
  }

  /** A short spatial chime from one pipe when its voice wakes: three sine
   *  partials of the pipe's own note, plucked and left to ring. */
  chime(pipeIndex: number): void {
    const io = this.#io;
    const voice = this.#voices[pipeIndex];
    if (!io || !voice) return;
    const ctx = io.ctx;
    const now = ctx.currentTime;
    const note = PIPES[pipeIndex].note;
    for (const [ratio, amp] of [
      [2, 0.4],
      [3, 0.22],
      [4.98, 0.1]
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = note * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(EPS, now);
      g.gain.exponentialRampToValueAtTime(amp, now + 0.045);
      g.gain.exponentialRampToValueAtTime(EPS, now + 2.6);
      osc.connect(g).connect(voice.panner);
      osc.start(now);
      osc.stop(now + 2.7);
    }
  }

  update(dt: number, playerPos: { x: number; z: number }, pipes: readonly PipeAudioState[]): void {
    this.#t += dt;
    const dist = Math.hypot(playerPos.x - WAVE_ORGAN_CENTER.x, playerPos.z - WAVE_ORGAN_CENTER.z);
    if (dist > ORGAN_AUDIO.wakeRadius) {
      this.#sleep();
      return;
    }

    // The jetty tip sits outside every nature region; hold the shared context
    // awake while the organ is audibly near (dog-park / wave-audio idiom).
    this.#nature.setExternalAwake(true);
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state !== "running") return;
    this.#wake(io, pipes);
    this.#awake = true;

    const now = io.ctx.currentTime;
    const fade = Math.min(
      1,
      Math.max(0, (ORGAN_AUDIO.wakeRadius - dist) / (ORGAN_AUDIO.wakeRadius - ORGAN_AUDIO.fullRadius))
    );
    this.#layer!.gain.setTargetAtTime(ORGAN_AUDIO.layerGain * fade * fade, now, 0.25);

    if (this.#hymn) this.#hymnT += dt;

    for (let i = 0; i < this.#voices.length; i++) {
      const voice = this.#voices[i];
      const state = pipes[i];
      movePanner(voice.panner, io.ctx, state.x, state.y, state.z);

      // Tide breath: every pipe rides its own slow swell so the sleeping organ
      // already sounds alive up close.
      voice.lfoPhase += dt * voice.lfoRate;
      const breath = 0.62 + 0.38 * Math.sin(voice.lfoPhase);

      let level: number;
      if (this.#hymn) {
        // The remembered song: voices swell one after another around the
        // chord, a wave rolling through the pipes from shore to tip.
        const phase = (this.#hymnT / ORGAN_AUDIO.hymnPeriod) * Math.PI * 2 - (i * Math.PI * 2) / this.#voices.length;
        const crest = Math.max(0, Math.sin(phase));
        level = ORGAN_AUDIO.hymnFloor + ORGAN_AUDIO.hymnSwell * crest * crest;
      } else if (state.awakened) {
        level = ORGAN_AUDIO.awakeLevel * breath;
      } else {
        const l = Math.min(1, Math.max(0, state.listen));
        level =
          (ORGAN_AUDIO.dormantLevel + (ORGAN_AUDIO.listenLevel - ORGAN_AUDIO.dormantLevel) * l * l) * breath;
      }
      voice.gain.gain.setTargetAtTime(level, now, 0.22);

      // Irregular gurgle: a quick resonance wobble, the slosh in the throat.
      voice.gurgleTimer -= dt;
      if (voice.gurgleTimer <= 0) {
        voice.gurgleTimer = 5 + Math.random() * 9;
        const f0 = voice.filters[0];
        f0.detune.cancelScheduledValues(now);
        f0.detune.setValueAtTime(0, now);
        f0.detune.linearRampToValueAtTime(-140 - Math.random() * 160, now + 0.35);
        f0.detune.setTargetAtTime(0, now + 0.35, 0.9);
      }
    }
  }

  #wake(io: NatureVoiceIO, pipes: readonly PipeAudioState[]): void {
    if (this.#layer) return;
    const ctx = io.ctx;
    this.#layer = ctx.createGain();
    this.#layer.gain.value = 0;
    // Environmental ambience without a nature-region fade — the organ is
    // weather, not wildlife.
    this.#layer.connect(io.worldBus);

    for (let i = 0; i < PIPES.length; i++) {
      const spec = PIPES[i];
      const state = pipes[i];
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 5;
      panner.rolloffFactor = 0.85;
      panner.maxDistance = 90;
      panner.connect(this.#layer);
      movePanner(panner, ctx, state.x, state.y, state.z, 0);

      const send = ctx.createGain();
      send.gain.value = ORGAN_AUDIO.reverbCharacter;
      panner.connect(send).connect(io.worldReverbSend);

      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(panner);

      // Resonant column: fundamental + two soft overtones out of shared noise.
      const src = ctx.createBufferSource();
      src.buffer = io.noise;
      src.loop = true;
      const filters: BiquadFilterNode[] = [];
      for (const [ratio, q, amp] of [
        [1, 12, 1.0],
        [2, 9, 0.34],
        [4.02, 7, 0.13]
      ] as const) {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = spec.note * ratio;
        bp.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = amp;
        src.connect(bp).connect(g).connect(gain);
        filters.push(bp);
      }
      src.start();

      // A whisper of pure tone for body under the breath.
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = spec.note;
      const oscG = ctx.createGain();
      oscG.gain.value = 0.18;
      osc.connect(oscG).connect(gain);
      osc.start();

      this.#voices.push({
        src,
        osc,
        filters,
        gain,
        panner,
        send,
        lfoPhase: i * 1.7,
        lfoRate: (Math.PI * 2) / (9 + i * 2.3),
        gurgleTimer: 2 + i * 1.3
      });
    }
  }

  #sleep(): void {
    if (!this.#awake) return;
    this.#awake = false;
    this.#nature.setExternalAwake(false);
    const io = this.#io;
    if (!io || !this.#layer) return;
    this.#layer.gain.setTargetAtTime(0, io.ctx.currentTime, 0.3);
  }
}

function movePanner(p: PannerNode, ctx: AudioContext, x: number, y: number, z: number, tc = 0.05): void {
  const now = ctx.currentTime;
  if (p.positionX) {
    p.positionX.setTargetAtTime(x, now, tc);
    p.positionY.setTargetAtTime(y, now, tc);
    p.positionZ.setTargetAtTime(z, now, tc);
  } else {
    p.setPosition(x, y, z);
  }
}
