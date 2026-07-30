import type { NatureSoundscape } from "../../audio/natureSoundscape";

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

const EPS = 0.0001;
const WAKE_RADIUS = 125;
const FULL_RADIUS = 54;

// C Hiraijoshi: C, D, E-flat, G, A-flat. Registers rise across the fan so the
// short wands glint above the long, low voices without leaving the scale.
const HIRAJOSHI_HZ = [
  130.81, 146.83, 155.56, 196.0, 207.65,
  261.63, 293.66, 311.13, 392.0, 415.3,
  523.25, 587.33
] as const;

type XYZ = Readonly<{ x: number; y: number; z: number }>;

export class HirajoshiWaveAudio {
  #nature: NatureSoundscape;
  #io: NatureVoiceIO | null = null;
  #layer: GainNode | null = null;
  #reverb: GainNode | null = null;
  #panners: PannerNode[] = [];
  #drone: OscillatorNode[] = [];
  #droneGain: GainNode | null = null;
  #releaseNatureHold: (() => void) | null = null;
  #awake = false;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  update(
    playerPos: Readonly<{ x: number; z: number }>,
    center: Readonly<{ x: number; z: number }>,
    bobPositions: readonly XYZ[]
  ): void {
    const distance = Math.hypot(playerPos.x - center.x, playerPos.z - center.z);
    if (distance > WAKE_RADIUS) {
      this.#sleep();
      return;
    }

    this.#releaseNatureHold ??= this.#nature.acquireExternalHold("hirajoshi-wave");
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state !== "running") return;
    this.#wake(io, bobPositions);
    this.#awake = true;

    const fade = Math.min(
      1,
      Math.max(0, (WAKE_RADIUS - distance) / (WAKE_RADIUS - FULL_RADIUS))
    );
    this.#layer!.gain.setTargetAtTime(0.62 * fade * fade, io.ctx.currentTime, 0.24);
    this.#reverb!.gain.setTargetAtTime(0.28 * fade * fade, io.ctx.currentTime, 0.3);
    this.#droneGain?.gain.setTargetAtTime(0.022 * fade * fade, io.ctx.currentTime, 0.4);
    for (let i = 0; i < this.#panners.length; i++) {
      const p = bobPositions[i];
      if (p) movePanner(this.#panners[i], io.ctx, p.x, p.y, p.z);
    }
  }

  /** One glass-and-bronze strike when a wand completes a visual cycle. */
  strike(index: number, strength = 1): void {
    const io = this.#io;
    const panner = this.#panners[index];
    if (!this.#awake || !io || !panner) return;
    const ctx = io.ctx;
    const now = ctx.currentTime;
    const fundamental = HIRAJOSHI_HZ[index % HIRAJOSHI_HZ.length];
    const level = Math.min(1, Math.max(0.15, strength));

    for (const [ratio, amplitude, duration] of [
      [1, 0.052, 3.4],
      [2.01, 0.021, 2.5],
      [3.98, 0.009, 1.8],
      [7.12, 0.0035, 1.1]
    ] as const) {
      const oscillator = ctx.createOscillator();
      oscillator.type = ratio === 1 ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(fundamental * ratio, now);
      oscillator.detune.setValueAtTime((index % 3 - 1) * 1.8, now);

      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(EPS, now);
      envelope.gain.exponentialRampToValueAtTime(amplitude * level, now + 0.014);
      envelope.gain.exponentialRampToValueAtTime(EPS, now + duration);
      oscillator.connect(envelope).connect(panner);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.05);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        envelope.disconnect();
      }, { once: true });
    }
  }

  /** Low ceremonial breath under the simultaneous realignment chord. */
  alignmentPulse(): void {
    const io = this.#io;
    const layer = this.#layer;
    if (!this.#awake || !io || !layer) return;
    const ctx = io.ctx;
    const now = ctx.currentTime;
    for (const [frequency, amplitude] of [
      [65.41, 0.12],
      [98.0, 0.055],
      [103.83, 0.035]
    ] as const) {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(EPS, now);
      envelope.gain.exponentialRampToValueAtTime(amplitude, now + 0.08);
      envelope.gain.exponentialRampToValueAtTime(EPS, now + 4.8);
      oscillator.connect(envelope).connect(layer);
      oscillator.start(now);
      oscillator.stop(now + 4.9);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        envelope.disconnect();
      }, { once: true });
    }
  }

  #wake(io: NatureVoiceIO, bobPositions: readonly XYZ[]): void {
    if (this.#layer) return;
    const ctx = io.ctx;
    this.#layer = ctx.createGain();
    this.#layer.gain.value = 0;
    this.#layer.connect(io.worldBus);

    this.#reverb = ctx.createGain();
    this.#reverb.gain.value = 0;
    this.#reverb.connect(io.worldReverbSend);

    for (let i = 0; i < HIRAJOSHI_HZ.length; i++) {
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 7;
      panner.rolloffFactor = 0.78;
      panner.maxDistance = 120;
      panner.connect(this.#layer);
      panner.connect(this.#reverb);
      const p = bobPositions[i];
      if (p) movePanner(panner, ctx, p.x, p.y, p.z, 0);
      this.#panners.push(panner);
    }

    // Nearly inaudible tonic air gives the pointillist strikes a harmonic
    // floor. It never bypasses the shared mixer or gesture gate.
    this.#droneGain = ctx.createGain();
    this.#droneGain.gain.value = 0;
    this.#droneGain.connect(this.#layer);
    for (const [frequency, amplitude] of [[65.41, 0.7], [77.78, 0.3]] as const) {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.value = amplitude;
      oscillator.connect(gain).connect(this.#droneGain);
      oscillator.start();
      this.#drone.push(oscillator);
    }
  }

  #sleep(): void {
    this.#releaseNatureHold?.();
    this.#releaseNatureHold = null;
    if (!this.#awake) return;
    this.#awake = false;
    const io = this.#io;
    if (!io) return;
    this.#layer?.gain.setTargetAtTime(0, io.ctx.currentTime, 0.3);
    this.#reverb?.gain.setTargetAtTime(0, io.ctx.currentTime, 0.3);
    this.#droneGain?.gain.setTargetAtTime(0, io.ctx.currentTime, 0.3);
  }

  dispose(): void {
    this.#sleep();
    for (const oscillator of this.#drone) {
      try { oscillator.stop(); } catch { /* already stopped */ }
      oscillator.disconnect();
    }
    this.#drone.length = 0;
    for (const panner of this.#panners) panner.disconnect();
    this.#panners.length = 0;
    this.#droneGain?.disconnect();
    this.#reverb?.disconnect();
    this.#layer?.disconnect();
    this.#droneGain = null;
    this.#reverb = null;
    this.#layer = null;
    this.#io = null;
  }
}

function movePanner(
  panner: PannerNode,
  ctx: AudioContext,
  x: number,
  y: number,
  z: number,
  timeConstant = 0.045
): void {
  const now = ctx.currentTime;
  if (panner.positionX) {
    panner.positionX.setTargetAtTime(x, now, timeConstant);
    panner.positionY.setTargetAtTime(y, now, timeConstant);
    panner.positionZ.setTargetAtTime(z, now, timeConstant);
  } else {
    panner.setPosition(x, y, z);
  }
}
