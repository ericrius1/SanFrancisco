/**
 * Shared procedural gameplay-SFX graph.
 *
 * Footsteps and interaction sounds are fundamental, local sounds, but each one
 * owning an AudioContext would quickly exhaust the browser's context budget.
 * This small bus gives every procedural voice one limiter, one generated room,
 * and one reusable noise bed on the shared engine effects group. The engine now
 * owns the context, the gesture unlock, the effects volume/mute contract, and
 * the visibility/idle-suspend policy; this bus keeps only its own sonic glue.
 */

import { audioEngine } from "./engine";
import { effectsAudioLevel } from "../core/audioSettings";

export type GameplaySfxVoiceBus = {
  ctx: AudioContext;
  /** Presence-independent dry FX tap. */
  dry: GainNode;
  /** Send-only tap into a short, dark room impulse. */
  room: GainNode;
  /** Reusable stereo noise; callers randomize offsets and filter it. */
  noise: AudioBuffer;
};

export class GameplaySfxBus {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #dry!: GainNode;
  #room!: GainNode;
  #noise!: AudioBuffer;

  get debugState() {
    // Level/hold/unlock live on the engine now; mirror them so tuning peeks and
    // headless probes keep the same shape.
    return {
      ctx: this.#ctx?.state ?? "none",
      unlocked: audioEngine.unlocked,
      level: +audioEngine.debugState.levels.effects.toFixed(3),
      hold: audioEngine.debugState.hold
    };
  }

  /** Build the modest no-network graph under the loading cover, pre-gesture. */
  prewarm(): void {
    this.#ensure();
  }

  /** Force the normal browser gate open for headless audio probes. */
  async unlock(): Promise<void> {
    await audioEngine.unlock();
    this.#ensure();
  }

  /** Keep the shared graph alive long enough for a newly scheduled tail. */
  touch(seconds = 0.8): void {
    audioEngine.touch(seconds);
  }

  voiceBus(holdSeconds = 0.8): GameplaySfxVoiceBus | null {
    // bus() applies the unlocked gate, extends the idle hold, and resumes the
    // ctx — exactly the gate/touch/resume this used to do by hand. We build the
    // graph ourselves and only need its non-null (unlocked) signal.
    if (!audioEngine.bus("effects", holdSeconds)) return null;
    const ctx = this.#ensure();
    if (!ctx) return null;
    return { ctx, dry: this.#dry, room: this.#room, noise: this.#noise };
  }

  /**
   * Advance the shared voices once per frame. `continuous` keeps rustles or
   * other sustained voices alive; one-shots call touch() when scheduled. The
   * engine owns the master gain and idle-suspend, so this only extends the hold.
   */
  update(_dt: number, continuous = false): void {
    // Gate, not gain: continuous foley shouldn't hold the shared ctx awake
    // while the FX group is muted.
    if (continuous && effectsAudioLevel() > 0.0001) audioEngine.touch(0.15);
  }

  dispose(): void {
    // Never close the shared engine ctx — just drop our own graph.
    this.#master?.disconnect();
    this.#ctx = null;
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    const bus = audioEngine.prewarmBus("effects");
    if (!bus) return null; // no AudioContext (Node probes)
    const { ctx, input } = bus;
    this.#ctx = ctx;

    // limiter (feature glue) -> constant trim -> engine effects input. The
    // engine effects group applies the HUD volume/mute; the trim holds unity.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -15;
    limiter.knee.value = 20;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;

    this.#master = ctx.createGain();
    this.#master.gain.value = 1;
    this.#master.connect(input);
    limiter.connect(this.#master);

    this.#dry = ctx.createGain();
    this.#dry.gain.value = 1;
    this.#dry.connect(limiter);

    // A compact, dark stereo room glues dry procedural layers together without
    // turning close footsteps into a cavern. Voices opt into it with send gains.
    const convolver = ctx.createConvolver();
    const impulseSeconds = 0.52;
    const impulse = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * impulseSeconds), ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let low = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        const white = Math.random() * 2 - 1;
        low += (white - low) * 0.16;
        data[i] = (white * 0.32 + low * 0.68) * Math.pow(1 - t, 3.6) * 0.36;
      }
    }
    convolver.buffer = impulse;
    const roomReturn = ctx.createGain();
    roomReturn.gain.value = 0.65;
    convolver.connect(roomReturn).connect(limiter);
    this.#room = ctx.createGain();
    this.#room.gain.value = 1;
    this.#room.connect(convolver);

    // 1.35 seconds avoids obvious short-loop texture while staying cheap enough
    // for a loading-cover prewarm. Stereo decorrelation makes foliage feel wide.
    const noiseSeconds = 1.35;
    this.#noise = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * noiseSeconds), ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = this.#noise.getChannelData(channel);
      let pink = 0;
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        pink = pink * 0.965 + white * 0.035;
        data[i] = white * 0.72 + pink * 1.9;
      }
    }
    return ctx;
  }
}
