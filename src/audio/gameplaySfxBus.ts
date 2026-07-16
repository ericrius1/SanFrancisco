/**
 * Shared procedural gameplay-SFX graph.
 *
 * Footsteps and interaction sounds are fundamental, local sounds, but each one
 * owning an AudioContext would quickly exhaust the browser's context budget.
 * This small bus gives every procedural voice one limiter, one generated room,
 * one reusable noise bed, and the HUD effects-volume/mute contract.
 */

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

const approach = (current: number, target: number, dt: number, rate: number) =>
  current + (target - current) * Math.min(1, dt * rate);

export class GameplaySfxBus {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #dry!: GainNode;
  #room!: GainNode;
  #noise!: AudioBuffer;
  #unlocked = false;
  #hold = 0;
  #level = 0;

  constructor() {
    const unlock = () => {
      this.#unlocked = true;
      const ctx = this.#ensure();
      if (ctx?.state === "suspended") void ctx.resume();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock, { passive: true });
  }

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      unlocked: this.#unlocked,
      level: +this.#level.toFixed(3),
      hold: +this.#hold.toFixed(3)
    };
  }

  /** Build the modest no-network graph under the loading cover. */
  prewarm(): void {
    this.#ensure();
  }

  /** Force the normal browser gate open for headless audio probes. */
  async unlock(): Promise<void> {
    const ctx = this.#ensure();
    if (!ctx) return;
    await ctx.resume().catch(() => {});
    this.#unlocked = true;
  }

  /** Keep the shared graph alive long enough for a newly scheduled tail. */
  touch(seconds = 0.8): void {
    this.#hold = Math.max(this.#hold, seconds);
  }

  voiceBus(holdSeconds = 0.8): GameplaySfxVoiceBus | null {
    if (!this.#unlocked) return null;
    const ctx = this.#ensure();
    if (!ctx) return null;
    this.touch(holdSeconds);
    const target = document.visibilityState === "visible" ? effectsAudioLevel() : 0;
    this.#level = target;
    this.#master.gain.cancelScheduledValues(ctx.currentTime);
    this.#master.gain.setValueAtTime(target, ctx.currentTime);
    if (ctx.state === "suspended") void ctx.resume();
    return { ctx, dry: this.#dry, room: this.#room, noise: this.#noise };
  }

  /**
   * Advance the shared master once per frame. `continuous` keeps rustles or
   * other sustained voices alive; one-shots call touch() when scheduled.
   */
  update(dt: number, continuous = false): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#hold = continuous ? Math.max(this.#hold, 0.15) : Math.max(0, this.#hold - dt);
    const visible = document.visibilityState === "visible";
    const target = visible && this.#hold > 0 ? effectsAudioLevel() : 0;
    this.#level = approach(this.#level, target, dt, target > 0 ? 8 : 14);

    if (ctx.state === "running") {
      this.#master.gain.setTargetAtTime(this.#level, ctx.currentTime, 0.025);
      if (this.#hold <= 0 && this.#level <= 0.001) void ctx.suspend();
    } else if (this.#unlocked && this.#hold > 0 && target > 0.0001 && visible) {
      void ctx.resume();
    }
  }

  dispose(): void {
    const ctx = this.#ctx;
    if (ctx && ctx.state !== "closed") void ctx.close();
    this.#ctx = null;
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    this.#ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -15;
    limiter.knee.value = 20;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    limiter.connect(ctx.destination);

    this.#master = ctx.createGain();
    this.#master.gain.value = 0;
    this.#master.connect(limiter);

    this.#dry = ctx.createGain();
    this.#dry.gain.value = 1;
    this.#dry.connect(this.#master);

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
    convolver.connect(roomReturn).connect(this.#master);
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
