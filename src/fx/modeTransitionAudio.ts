/**
 * Short, tactile mode-change signatures. The sounds are intentionally
 * procedural and non-musical: a warm dismount/foot-settle, then material cues
 * that tell road, electric, water and air rides apart before their continuous
 * vehicle voices take over.
 *
 * This class owns no AudioContext. It borrows GameplaySfxBus so all voices use
 * the existing autoplay gate, effects-volume control, limiter, room and shared
 * noise buffer.
 */

import { effectsAudioLevel } from "../core/audioSettings";
import type { GameplaySfxBus, GameplaySfxVoiceBus } from "../audio/gameplaySfxBus";
import type { PlayerMode } from "../player/types";

type Signature =
  | "none"
  | "warm-dismount"
  | "mechanical-mount"
  | "electric-mount"
  | "water-mount"
  | "air-mount"
  | "organic-air-mount";

type Suppression = "none" | "same-mode" | "muted" | "locked" | "cooldown" | "stale";

type PendingEvent = {
  previousMode: PlayerMode;
  nextMode: PlayerMode;
  requestedAt: number;
  serial: number;
};

const GLOBAL_COOLDOWN_MS = 90;
const SAME_TRANSITION_COOLDOWN_MS = 280;
const RESUME_GRACE_MS = 320;

const nowMs = () => (typeof performance === "undefined" ? Date.now() : performance.now());

const signatureFor = (mode: PlayerMode): Exclude<Signature, "none" | "warm-dismount"> => {
  switch (mode) {
    case "drive":
      return "mechanical-mount";
    case "scooter":
    case "board":
    case "drone":
      return "electric-mount";
    case "boat":
    case "speedboat":
    case "surf":
      return "water-mount";
    case "plane":
      return "air-mount";
    case "bird":
      return "organic-air-mount";
    case "walk":
      // Only called for ride modes; this keeps the switch exhaustive.
      return "mechanical-mount";
  }
};

export class ModeTransitionAudio {
  readonly #bus: GameplaySfxBus;
  #lastPlayedAt = -Infinity;
  #lastPair = "";
  #lastSignature: Signature = "none";
  #lastSuppression: Suppression = "none";
  #played = 0;
  #suppressed = 0;
  #serial = 0;
  #pending: PendingEvent | null = null;

  constructor(bus: GameplaySfxBus) {
    this.#bus = bus;
  }

  /**
   * Fire once after the player mode actually changes. Same-mode calls and
   * switch spam are ignored; ride-to-ride transfers get a lighter dismount
   * followed by the new ride's identifying material cue.
   */
  event(previousMode: PlayerMode, nextMode: PlayerMode): void {
    if (previousMode === nextMode) {
      this.#suppress("same-mode");
      return;
    }
    if (effectsAudioLevel() <= 0.0001) {
      this.#suppress("muted");
      return;
    }

    const voice = this.#bus.voiceBus(1.05);
    if (!voice) {
      // GameplaySfxBus owns the first-gesture unlock. Do not queue a mode cue
      // across that boundary: a late mount sound is worse than a missed one.
      this.#suppress("locked");
      return;
    }

    if (voice.ctx.state !== "running") {
      const pending: PendingEvent = {
        previousMode,
        nextMode,
        requestedAt: nowMs(),
        serial: ++this.#serial
      };
      this.#pending = pending;
      void voice.ctx.resume().then(() => {
        if (this.#pending?.serial !== pending.serial) return;
        this.#pending = null;
        if (voice.ctx.state !== "running" || nowMs() - pending.requestedAt > RESUME_GRACE_MS) {
          this.#suppress("stale");
          return;
        }
        this.#play(voice, previousMode, nextMode);
      }).catch(() => {
        if (this.#pending?.serial === pending.serial) this.#pending = null;
        this.#suppress("locked");
      });
      return;
    }

    this.#play(voice, previousMode, nextMode);
  }

  get debugState() {
    return {
      signature: this.#lastSignature,
      lastSuppression: this.#lastSuppression,
      played: this.#played,
      suppressed: this.#suppressed,
      pending: this.#pending
        ? `${this.#pending.previousMode}->${this.#pending.nextMode}`
        : null,
      cooldownMs: Math.max(0, Math.round(GLOBAL_COOLDOWN_MS - (nowMs() - this.#lastPlayedAt)))
    };
  }

  #play(voice: GameplaySfxVoiceBus, previousMode: PlayerMode, nextMode: PlayerMode): void {
    if (effectsAudioLevel() <= 0.0001) {
      this.#suppress("muted");
      return;
    }

    const stamp = nowMs();
    const pair = `${previousMode}->${nextMode}`;
    const cooldown = pair === this.#lastPair ? SAME_TRANSITION_COOLDOWN_MS : GLOBAL_COOLDOWN_MS;
    if (stamp - this.#lastPlayedAt < cooldown) {
      this.#suppress("cooldown");
      return;
    }

    this.#lastPlayedAt = stamp;
    this.#lastPair = pair;
    this.#lastSuppression = "none";
    this.#played++;

    const t0 = voice.ctx.currentTime + 0.008;
    if (nextMode === "walk") {
      this.#lastSignature = "warm-dismount";
      this.#dismount(voice, t0, 1);
      return;
    }

    const transfer = previousMode !== "walk";
    if (transfer) this.#dismount(voice, t0, 0.52);
    const mountAt = t0 + (transfer ? 0.105 : 0);
    this.#lastSignature = signatureFor(nextMode);
    this.#mount(voice, mountAt, nextMode, transfer ? 0.86 : 1);
  }

  #suppress(reason: Suppression): void {
    this.#lastSuppression = reason;
    this.#suppressed++;
  }

  /** Warm foot-settle, fabric movement and a softly damped buckle release. */
  #dismount(voice: GameplaySfxVoiceBus, t: number, amount: number): void {
    const out = this.#output(voice, 0.72 * amount, 0.15, -0.04, 0.72);

    this.#tone(voice.ctx, out.input, t, 142, 76, 0.19, 0.24, "sine", 0.008);
    this.#tone(voice.ctx, out.input, t + 0.004, 215, 116, 0.12, 0.08, "triangle", 0.004);
    this.#noiseSweep(voice, out.input, t, 0.17, 310, 180, 0.19, "bandpass", 0.65);
    this.#noiseSweep(voice, out.input, t + 0.018, 0.22, 940, 520, 0.075, "bandpass", 0.52);

    // The release is a little double articulation: latch, then boot/scuff.
    this.#click(voice, out.input, t + 0.058, 1020, 0.11);
    this.#click(voice, out.input, t + 0.116, 690, 0.065);
    this.#noiseSweep(voice, out.input, t + 0.11, 0.1, 610, 360, 0.065, "bandpass", 0.75);
  }

  #mount(voice: GameplaySfxVoiceBus, t: number, mode: PlayerMode, amount: number): void {
    const out = this.#output(voice, 0.68 * amount, 0.18, 0.035, 0.95);

    // Shared physical contact: weight settling into a seat/deck/perch and a
    // tiny fastener. The following mode layer colors it, rather than replacing
    // tactile feedback with an abstract UI beep.
    this.#tone(voice.ctx, out.input, t, 128, 73, 0.16, 0.21, "sine", 0.007);
    this.#noiseSweep(voice, out.input, t, 0.13, 350, 205, 0.14, "bandpass", 0.7);
    this.#click(voice, out.input, t + 0.052, mode === "bird" ? 820 : 1280, 0.105);

    switch (mode) {
      case "drive":
        this.#mechanicalMount(voice, out.input, t);
        break;
      case "scooter":
      case "board":
      case "drone":
        this.#electricMount(voice, out.input, t, mode);
        break;
      case "boat":
      case "speedboat":
      case "surf":
        this.#waterMount(voice, out.input, t, mode);
        break;
      case "plane":
        this.#airMount(voice, out.input, t);
        break;
      case "bird":
        this.#organicAirMount(voice, out.input, t);
        break;
      case "walk":
        break;
    }
  }

  /** Damp latch + two starter contacts + restrained low mechanical catch. */
  #mechanicalMount(voice: GameplaySfxVoiceBus, out: AudioNode, t: number): void {
    this.#click(voice, out, t + 0.11, 1760, 0.09);
    this.#click(voice, out, t + 0.158, 1310, 0.07);
    this.#noiseSweep(voice, out, t + 0.12, 0.26, 230, 145, 0.095, "bandpass", 0.8);
    this.#tone(voice.ctx, out, t + 0.17, 58, 92, 0.34, 0.15, "triangle", 0.02);
    this.#tone(voice.ctx, out, t + 0.185, 118, 103, 0.28, 0.055, "sine", 0.012);
  }

  /** Fast actuator contact and a soft, functional electrical energize sweep. */
  #electricMount(
    voice: GameplaySfxVoiceBus,
    out: AudioNode,
    t: number,
    mode: "scooter" | "board" | "drone"
  ): void {
    const start = mode === "board" ? 185 : mode === "drone" ? 245 : 220;
    const end = mode === "board" ? 430 : mode === "drone" ? 590 : 515;
    this.#click(voice, out, t + 0.102, 2160, 0.075);
    this.#tone(voice.ctx, out, t + 0.095, start, end, 0.28, 0.075, "sine", 0.018);
    this.#tone(voice.ctx, out, t + 0.108, start * 2.06, end * 1.92, 0.21, 0.025, "triangle", 0.012);
    this.#noiseSweep(
      voice,
      out,
      t + 0.11,
      mode === "drone" ? 0.3 : 0.21,
      720,
      mode === "drone" ? 1550 : 1120,
      mode === "drone" ? 0.06 : 0.035,
      "bandpass",
      1.15
    );
  }

  /** Hull/deck contact with a short, wide slap of water around the craft. */
  #waterMount(
    voice: GameplaySfxVoiceBus,
    out: AudioNode,
    t: number,
    mode: "boat" | "speedboat" | "surf"
  ): void {
    const slap = mode === "surf" ? 0.13 : mode === "speedboat" ? 0.115 : 0.09;
    this.#tone(voice.ctx, out, t + 0.07, mode === "surf" ? 190 : 155, 82, 0.2, 0.12, "triangle", 0.01);
    this.#noiseSweep(voice, out, t + 0.075, 0.3, 930, 420, slap, "bandpass", 0.58);
    this.#noiseSweep(voice, out, t + 0.12, 0.24, 1780, 720, slap * 0.44, "lowpass", 0.7);
    if (mode === "speedboat") {
      this.#click(voice, out, t + 0.17, 1540, 0.075);
      this.#tone(voice.ctx, out, t + 0.18, 72, 106, 0.25, 0.1, "triangle", 0.016);
    }
  }

  /** Belt/servo closure under a compact pressure-air bloom. */
  #airMount(voice: GameplaySfxVoiceBus, out: AudioNode, t: number): void {
    this.#click(voice, out, t + 0.105, 1960, 0.095);
    this.#tone(voice.ctx, out, t + 0.115, 132, 214, 0.3, 0.075, "triangle", 0.018);
    this.#noiseSweep(voice, out, t + 0.09, 0.35, 480, 1480, 0.09, "bandpass", 0.48);
    this.#noiseSweep(voice, out, t + 0.16, 0.24, 2400, 980, 0.032, "highpass", 0.72);
  }

  /** Feather/wing displacement and a quiet organic body-settle, no chirp. */
  #organicAirMount(voice: GameplaySfxVoiceBus, out: AudioNode, t: number): void {
    this.#noiseSweep(voice, out, t + 0.045, 0.34, 620, 1740, 0.12, "bandpass", 0.42);
    this.#noiseSweep(voice, out, t + 0.12, 0.24, 2100, 820, 0.055, "lowpass", 0.65);
    this.#tone(voice.ctx, out, t + 0.11, 116, 83, 0.2, 0.08, "sine", 0.016);
  }

  #output(
    voice: GameplaySfxVoiceBus,
    level: number,
    roomLevel: number,
    pan: number,
    lifeSeconds: number
  ): { input: GainNode } {
    const input = voice.ctx.createGain();
    input.gain.value = level;
    const panner = voice.ctx.createStereoPanner();
    panner.pan.value = pan;
    const dry = voice.ctx.createGain();
    dry.gain.value = 1;
    const room = voice.ctx.createGain();
    room.gain.value = roomLevel;
    input.connect(panner);
    panner.connect(dry).connect(voice.dry);
    panner.connect(room).connect(voice.room);

    // Destination-side connections retain otherwise-finished Web Audio nodes;
    // explicitly sever this tiny per-event graph once every tail has decayed.
    globalThis.setTimeout(() => {
      input.disconnect();
      panner.disconnect();
      dry.disconnect();
      room.disconnect();
    }, Math.ceil((lifeSeconds + 0.25) * 1000));
    return { input };
  }

  #tone(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    fromHz: number,
    toHz: number,
    duration: number,
    gain: number,
    type: OscillatorType,
    attack: number
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(toHz, t + duration);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(gain, t + Math.max(0.002, attack));
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(envelope).connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.015);
    osc.onended = () => {
      osc.disconnect();
      envelope.disconnect();
    };
  }

  #noiseSweep(
    voice: GameplaySfxVoiceBus,
    out: AudioNode,
    t: number,
    duration: number,
    fromHz: number,
    toHz: number,
    gain: number,
    type: BiquadFilterType,
    q: number
  ): void {
    const src = voice.ctx.createBufferSource();
    src.buffer = voice.noise;
    const maxOffset = Math.max(0, voice.noise.duration - duration - 0.02);
    const offset = Math.random() * maxOffset;
    const filter = voice.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(fromHz, t);
    filter.frequency.exponentialRampToValueAtTime(toHz, t + duration);
    const envelope = voice.ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, duration * 0.18));
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(envelope).connect(out);
    src.start(t, offset);
    src.stop(t + duration + 0.012);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
  }

  #click(
    voice: GameplaySfxVoiceBus,
    out: AudioNode,
    t: number,
    frequency: number,
    gain: number
  ): void {
    this.#noiseSweep(voice, out, t, 0.022, frequency, frequency * 0.72, gain, "bandpass", 2.2);
    this.#tone(voice.ctx, out, t, frequency * 0.72, frequency * 0.46, 0.038, gain * 0.48, "triangle", 0.002);
  }
}
