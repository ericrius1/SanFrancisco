import type * as THREE from "three/webgpu";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import type { PickleballEvent } from "./types";

/**
 * Pickleball court sounds, riding the shared nature soundscape context (the
 * dogPark.ts pattern): no new AudioContext, and every one-shot flows through
 * nature's foreground-effects bus — HUD FX volume/mute and the shared limiter
 * are already applied there, so this layer never re-multiplies them. The
 * Goldman courts sit inside the "ggpark" nature region, which keeps the shared
 * context alive whenever a court is audible.
 *
 * One class serves every court: handle(event, at) spatializes each one-shot at
 * the event's world position (falling back to `at`, the court center, for
 * events that carry none — serve/point/game).
 */

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

const PB_AUDIO = {
  layerGain: 0.9,
  /** Round-robin spatial one-shot slots — rallies overlap across courts. */
  voices: 6,
  refDistance: 5,
  rolloff: 1.2,
  maxDistance: 90,
  reverbSend: 0.3,
  paddle: 0.5,
  serve: 0.62,
  bounce: 0.16,
  net: 0.4,
  chime: 0.3,
  crowd: 0.34
} as const;

const EPS = 0.0001;

type Voice = { panner: PannerNode };

export class PickleballAudio {
  #nature: NatureSoundscape;
  #io: NatureVoiceIO | null = null;
  #layer: GainNode | null = null;
  #voices: Voice[] = [];
  #next = 0;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  /** Voice a match event. `at` = court-center world position, used for events
   *  without their own worldPosition. Safe to call every event — silently a
   *  no-op until the shared context is unlocked and running. */
  handle(event: PickleballEvent, at: THREE.Vector3): void {
    const io = this.#ensure();
    if (!io) return;
    const t0 = io.ctx.currentTime + 0.01;
    switch (event.kind) {
      case "paddle":
        this.#thock(io, event.worldPosition, t0, PB_AUDIO.paddle, 1);
        break;
      case "serve":
        this.#thock(io, at, t0, PB_AUDIO.serve, 0.86); // deeper opening pop
        break;
      case "bounce":
        this.#tick(io, event.worldPosition, t0);
        break;
      case "net":
        this.#thud(io, event.worldPosition, t0);
        break;
      case "point":
        this.#chime(io, at, t0, event.scoringSide !== null);
        break;
      case "game":
        this.#chime(io, at, t0, true);
        this.#crowd(io, at, t0 + 0.12);
        break;
      default:
        break;
    }
  }

  dispose(): void {
    for (const voice of this.#voices) voice.panner.disconnect();
    this.#voices.length = 0;
    this.#layer?.disconnect();
    this.#layer = null;
  }

  #ensure(): NatureVoiceIO | null {
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state !== "running") return null;
    if (!this.#layer) {
      this.#layer = io.ctx.createGain();
      this.#layer.gain.value = PB_AUDIO.layerGain;
      this.#layer.connect(io.alwaysBus);
      for (let i = 0; i < PB_AUDIO.voices; i++) {
        const panner = io.ctx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "inverse";
        panner.refDistance = PB_AUDIO.refDistance;
        panner.rolloffFactor = PB_AUDIO.rolloff;
        panner.maxDistance = PB_AUDIO.maxDistance;
        panner.connect(this.#layer);
        const send = io.ctx.createGain();
        send.gain.value = PB_AUDIO.reverbSend;
        panner.connect(send).connect(io.effectsReverbSend);
        this.#voices.push({ panner });
      }
    }
    return io;
  }

  #voice(io: NatureVoiceIO, at: THREE.Vector3): PannerNode {
    const voice = this.#voices[this.#next];
    this.#next = (this.#next + 1) % this.#voices.length;
    const p = voice.panner;
    const now = io.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(at.x, now);
      p.positionY.setValueAtTime(at.y, now);
      p.positionZ.setValueAtTime(at.z, now);
    } else {
      p.setPosition(at.x, at.y, at.z);
    }
    return p;
  }

  /** Hollow paddle "thock": bandpassed noise burst + a short falling sine
   *  knock. `bright` 0..1 shifts the body — serves sit a touch deeper. */
  #thock(io: NatureVoiceIO, at: THREE.Vector3, t0: number, level: number, bright: number): void {
    const ctx = io.ctx;
    const out = this.#voice(io, at);
    const detune = 0.92 + Math.random() * 0.16;

    const noise = ctx.createBufferSource();
    noise.buffer = io.noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = (760 + 380 * bright) * detune;
    band.Q.value = 1.1;
    const burst = ctx.createGain();
    burst.gain.setValueAtTime(level, t0);
    burst.gain.exponentialRampToValueAtTime(EPS, t0 + 0.055);
    noise.connect(band).connect(burst).connect(out);
    noise.start(t0, Math.random() * 2, 0.09);

    const knock = ctx.createOscillator();
    knock.type = "sine";
    knock.frequency.setValueAtTime(210 * detune * (0.8 + 0.35 * bright), t0);
    knock.frequency.exponentialRampToValueAtTime(120 * detune, t0 + 0.05);
    const knockGain = ctx.createGain();
    knockGain.gain.setValueAtTime(level * 0.8, t0);
    knockGain.gain.exponentialRampToValueAtTime(EPS, t0 + 0.07);
    knock.connect(knockGain).connect(out);
    knock.start(t0);
    knock.stop(t0 + 0.09);
  }

  /** Soft court bounce tick. */
  #tick(io: NatureVoiceIO, at: THREE.Vector3, t0: number): void {
    const ctx = io.ctx;
    const out = this.#voice(io, at);
    const noise = ctx.createBufferSource();
    noise.buffer = io.noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1500 * (0.9 + Math.random() * 0.2);
    band.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(PB_AUDIO.bounce, t0);
    g.gain.exponentialRampToValueAtTime(EPS, t0 + 0.035);
    noise.connect(band).connect(g).connect(out);
    noise.start(t0, Math.random() * 2, 0.05);
  }

  /** Net cord thud: dull lowpassed noise + an 80 Hz body. */
  #thud(io: NatureVoiceIO, at: THREE.Vector3, t0: number): void {
    const ctx = io.ctx;
    const out = this.#voice(io, at);
    const noise = ctx.createBufferSource();
    noise.buffer = io.noise;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 280;
    const g = ctx.createGain();
    g.gain.setValueAtTime(PB_AUDIO.net, t0);
    g.gain.exponentialRampToValueAtTime(EPS, t0 + 0.13);
    noise.connect(low).connect(g).connect(out);
    noise.start(t0, Math.random() * 2, 0.16);

    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(86, t0);
    body.frequency.exponentialRampToValueAtTime(58, t0 + 0.1);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(PB_AUDIO.net * 0.9, t0);
    bodyGain.gain.exponentialRampToValueAtTime(EPS, t0 + 0.14);
    body.connect(bodyGain).connect(out);
    body.start(t0);
    body.stop(t0 + 0.16);
  }

  /** Point chime: two quick sine partials; side-outs get the softer single. */
  #chime(io: NatureVoiceIO, at: THREE.Vector3, t0: number, scored: boolean): void {
    const ctx = io.ctx;
    const out = this.#voice(io, at);
    const notes = scored ? [880, 1318.5] : [660];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      const at0 = t0 + i * 0.09;
      g.gain.setValueAtTime(EPS, at0);
      g.gain.linearRampToValueAtTime(PB_AUDIO.chime, at0 + 0.012);
      g.gain.exponentialRampToValueAtTime(EPS, at0 + 0.34);
      osc.connect(g).connect(out);
      osc.start(at0);
      osc.stop(at0 + 0.38);
    });
  }

  /** Tiny crowd "oh!" on game point: three staggered filtered noise swells. */
  #crowd(io: NatureVoiceIO, at: THREE.Vector3, t0: number): void {
    const ctx = io.ctx;
    const out = this.#voice(io, at);
    for (let i = 0; i < 3; i++) {
      const start = t0 + i * 0.07 + Math.random() * 0.04;
      const noise = ctx.createBufferSource();
      noise.buffer = io.noise;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 2.2;
      band.frequency.setValueAtTime(420 + i * 90, start);
      band.frequency.exponentialRampToValueAtTime(660 + i * 110, start + 0.28);
      const g = ctx.createGain();
      g.gain.setValueAtTime(EPS, start);
      g.gain.linearRampToValueAtTime(PB_AUDIO.crowd * (0.7 + Math.random() * 0.3), start + 0.14);
      g.gain.exponentialRampToValueAtTime(EPS, start + 0.55);
      noise.connect(band).connect(g).connect(out);
      noise.start(start, Math.random() * 1.5, 0.6);
    }
  }
}
