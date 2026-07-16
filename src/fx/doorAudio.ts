/**
 * Layered procedural audio for generated building doors.
 *
 * The voice is intentionally sample-free and physical: a dark wooden-panel
 * resonance, filtered friction for the moving leaf, stick/slip hinge partials,
 * and a small bright latch. A blocked attempt swaps the sweep for a solid body
 * knock and a restrained handle rattle. All voices ride GameplaySfxBus, so this
 * module creates no AudioContext and inherits the shared autoplay gate, HUD
 * effects volume, limiter, room, suspend policy, and reusable noise buffer.
 */

import { effectsAudioLevel } from "../core/audioSettings";
import {
  type GameplaySfxBus,
  type GameplaySfxVoiceBus
} from "../audio/gameplaySfxBus";

export type DoorAudioEvent = "opened" | "closed" | "blocked";

export type DoorAudioEventOptions = {
  /** 0..1.5 physical force; values around 0.75 are natural. */
  intensity?: number;
  /** Listener-relative stereo position, -1 (left) to +1 (right). */
  pan?: number;
  /** 0..1 send into the shared short room. */
  room?: number;
  /** Optional stable door id so separate nearby doors do not share a cooldown. */
  sourceId?: string | number;
  /** 0 = light/hollow, 1 = heavy/solid; changes panel pitch and decay. */
  weight?: number;
};

const EPS = 0.0001;
const COOLDOWN: Record<DoorAudioEvent, number> = {
  opened: 0.18,
  closed: 0.2,
  blocked: 0.13
};
const TAIL: Record<DoorAudioEvent, number> = {
  opened: 0.86,
  closed: 0.72,
  blocked: 0.48
};

type LiveVoice = {
  nodes: AudioNode[];
  timer: ReturnType<typeof setTimeout>;
};

export class DoorAudio {
  #bus: GameplaySfxBus;
  #lastAt = new Map<string, number>();
  #voices = new Set<LiveVoice>();
  #emitted: Record<DoorAudioEvent, number> = { opened: 0, closed: 0, blocked: 0 };
  #cooldownDrops = 0;
  #lockedDrops = 0;
  #mutedDrops = 0;
  #lastEvent: DoorAudioEvent | null = null;

  constructor(bus: GameplaySfxBus) {
    this.#bus = bus;
  }

  /** Read-only state for `window.__sf`/headless audio probes. */
  get debugState() {
    return {
      ready: this.#bus.debugState.ctx !== "none",
      context: this.#bus.debugState.ctx,
      activeVoices: this.#voices.size,
      emitted: { ...this.#emitted },
      cooldownDrops: this.#cooldownDrops,
      lockedDrops: this.#lockedDrops,
      mutedDrops: this.#mutedDrops,
      lastEvent: this.#lastEvent
    };
  }

  /**
   * Sound a generated-door event. Returns false when muted, still autoplay
   * locked, or inside that door/event's debounce window.
   */
  event(kind: DoorAudioEvent, options: DoorAudioEventOptions = {}): boolean {
    if (effectsAudioLevel() <= EPS) {
      this.#mutedDrops++;
      return false;
    }

    const now = wallSeconds();
    const key = `${kind}:${options.sourceId ?? "local"}`;
    if (now - (this.#lastAt.get(key) ?? -Infinity) < COOLDOWN[kind]) {
      this.#cooldownDrops++;
      return false;
    }

    // Asking for the voice bus also holds/resumes the shared graph. Sources may
    // safely be scheduled while its context is resuming from a user gesture.
    const io = this.#bus.voiceBus(TAIL[kind]);
    if (!io || io.ctx.state === "closed") {
      this.#lockedDrops++;
      return false;
    }

    this.#lastAt.set(key, now);
    this.#trimCooldowns(now);
    this.#emitted[kind]++;
    this.#lastEvent = kind;

    const intensity = clamp(options.intensity ?? 0.76, 0.05, 1.5);
    const weight = clamp01(options.weight ?? 0.68);
    const room = clamp01(options.room ?? defaultRoom(kind));
    const voice = this.#voice(io, clamp(options.pan ?? 0, -1, 1), room, intensity, TAIL[kind]);
    const t0 = io.ctx.currentTime + 0.006;

    if (kind === "opened") this.#opened(io, voice, t0, weight);
    else if (kind === "closed") this.#closed(io, voice, t0, weight);
    else this.#blocked(io, voice, t0, weight);
    return true;
  }

  /** Disconnect this layer's live taps without disposing the shared bus. */
  dispose(): void {
    for (const voice of [...this.#voices]) this.#release(voice);
    this.#lastAt.clear();
  }

  #voice(
    io: GameplaySfxVoiceBus,
    pan: number,
    room: number,
    intensity: number,
    tail: number
  ): GainNode {
    const { ctx } = io;
    const sum = ctx.createGain();
    // Preserve force variation without letting an enthusiastic caller hammer
    // the shared limiter. Perceptual master volume remains GameplaySfxBus-owned.
    sum.gain.value = Math.pow(intensity, 0.78) * 0.72;
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = pan * 0.72;
    const roomSend = ctx.createGain();
    roomSend.gain.value = room * 0.42;
    sum.connect(stereo);
    stereo.connect(io.dry);
    stereo.connect(roomSend).connect(io.room);

    const live = {
      nodes: [sum, stereo, roomSend],
      timer: setTimeout(() => this.#release(live), (tail + 0.18) * 1000)
    } satisfies LiveVoice;
    this.#voices.add(live);
    return sum;
  }

  #release(voice: LiveVoice): void {
    if (!this.#voices.delete(voice)) return;
    clearTimeout(voice.timer);
    for (const node of voice.nodes) disconnect(node);
  }

  #opened(io: GameplaySfxVoiceBus, out: AudioNode, t0: number, weight: number): void {
    const pitch = lerp(1.12, 0.82, weight);

    // Thumb depresses the latch: a tiny metal transient followed by the muted
    // wooden response travelling through the panel.
    this.#noise(io, out, t0, 0.032, 3300, 2100, 1.45, 0.2, 0.002);
    this.#tone(io.ctx, out, t0, 0.052, "triangle", 2050, 1310, 0.038, 0.002);
    this.#tone(io.ctx, out, t0 + 0.004, 0.09, "sine", 690, 570, 0.026, 0.003);
    this.#panel(io.ctx, out, t0 + 0.008, 0.62, weight, pitch);

    // Hinge friction is a broad dark sweep. Four short, imperfect stick/slip
    // chirps stop it from reading as generic filtered noise.
    this.#noise(io, out, t0 + 0.048, 0.43, 980, 470, 0.8, 0.078, 0.018);
    this.#noise(io, out, t0 + 0.06, 0.34, 310, 180, 0.55, 0.055, 0.025, "lowpass");
    for (let i = 0; i < 4; i++) {
      const at = t0 + 0.075 + i * (0.069 + Math.random() * 0.018);
      const f = (520 + Math.random() * 330) * pitch;
      this.#tone(io.ctx, out, at, 0.055 + Math.random() * 0.035, "triangle", f, f * 0.7, 0.021, 0.008);
    }

    // Latch clears the strike plate as the door reaches open travel.
    this.#noise(io, out, t0 + 0.43, 0.026, 2700, 1900, 1.7, 0.075, 0.002);
    this.#tone(io.ctx, out, t0 + 0.432, 0.048, "sine", 1440, 1180, 0.014, 0.002);
  }

  #closed(io: GameplaySfxVoiceBus, out: AudioNode, t0: number, weight: number): void {
    const pitch = lerp(1.15, 0.8, weight);
    const contact = t0 + 0.255;

    // Shorter reverse hinge travel before the jamb contact.
    this.#noise(io, out, t0, 0.27, 720, 410, 0.72, 0.06, 0.015);
    for (let i = 0; i < 3; i++) {
      const at = t0 + 0.025 + i * (0.064 + Math.random() * 0.014);
      const f = (430 + Math.random() * 250) * pitch;
      this.#tone(io.ctx, out, at, 0.045 + Math.random() * 0.025, "triangle", f, f * 0.74, 0.018, 0.007);
    }

    // The broad low panel and short fibrous noise make the close feel wooden,
    // while the two tiny high notes are the latch tongue seating in the strike.
    this.#noise(io, out, contact, 0.12, 1450, 370, 0.65, 0.24, 0.003, "lowpass");
    this.#panel(io.ctx, out, contact, 1, weight, pitch);
    this.#tone(io.ctx, out, contact + 0.018, 0.062, "triangle", 2380, 1480, 0.045, 0.002);
    this.#noise(io, out, contact + 0.02, 0.026, 3650, 2200, 1.8, 0.12, 0.002);
    this.#tone(io.ctx, out, contact + 0.052, 0.075, "sine", 980, 760, 0.025, 0.002);
  }

  #blocked(io: GameplaySfxVoiceBus, out: AudioNode, t0: number, weight: number): void {
    const pitch = lerp(1.1, 0.78, weight);

    // A stopped leaf has no travel sweep: force goes straight into one compact,
    // dead panel knock, then the handle/lock hardware answers twice.
    this.#noise(io, out, t0, 0.08, 1180, 330, 0.72, 0.23, 0.002, "lowpass");
    this.#panel(io.ctx, out, t0, 0.92, weight, pitch);
    this.#tone(io.ctx, out, t0 + 0.008, 0.11, "triangle", 235 * pitch, 150 * pitch, 0.07, 0.003);

    for (let i = 0; i < 2; i++) {
      const at = t0 + 0.085 + i * 0.052;
      this.#noise(io, out, at, 0.022, 3900 - i * 500, 2300, 2.1, 0.075 - i * 0.016, 0.002);
      this.#tone(io.ctx, out, at, 0.06, "triangle", 2300 - i * 370, 1480 - i * 190, 0.026, 0.002);
    }
  }

  #panel(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    amount: number,
    weight: number,
    pitch: number
  ): void {
    const decay = 0.11 + weight * 0.09;
    this.#tone(ctx, out, at, decay, "sine", 142 * pitch, 92 * pitch, amount * 0.16, 0.004);
    this.#tone(ctx, out, at + 0.002, decay * 0.72, "triangle", 278 * pitch, 198 * pitch, amount * 0.057, 0.003);
    this.#tone(ctx, out, at + 0.004, decay * 0.48, "sine", 445 * pitch, 354 * pitch, amount * 0.025, 0.003);
  }

  #tone(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    duration: number,
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    level: number,
    attack: number
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = (Math.random() - 0.5) * 18;
    osc.frequency.setValueAtTime(Math.max(20, fromHz), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), at + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(EPS, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(EPS, level), at + attack);
    gain.gain.exponentialRampToValueAtTime(EPS, at + duration);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + duration + 0.01);
    osc.onended = () => {
      disconnect(osc);
      disconnect(gain);
    };
  }

  #noise(
    io: GameplaySfxVoiceBus,
    out: AudioNode,
    at: number,
    duration: number,
    fromHz: number,
    toHz: number,
    q: number,
    level: number,
    attack: number,
    type: BiquadFilterType = "bandpass"
  ): void {
    const { ctx } = io;
    const source = ctx.createBufferSource();
    source.buffer = io.noise;
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(40, fromHz), at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), at + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(EPS, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(EPS, level), at + attack);
    gain.gain.exponentialRampToValueAtTime(EPS, at + duration);
    source.connect(filter).connect(gain).connect(out);
    const offset = Math.random() * Math.max(0.01, io.noise.duration - duration - 0.02);
    source.start(at, offset, Math.min(duration + 0.015, io.noise.duration - offset));
    source.onended = () => {
      disconnect(source);
      disconnect(filter);
      disconnect(gain);
    };
  }

  #trimCooldowns(now: number): void {
    // sourceId is caller-defined; keep the debug-friendly map from growing if a
    // city generator uses ephemeral ids during a long session.
    if (this.#lastAt.size < 96) return;
    for (const [key, at] of this.#lastAt) if (now - at > 2) this.#lastAt.delete(key);
  }
}

function defaultRoom(kind: DoorAudioEvent): number {
  if (kind === "closed") return 0.28;
  if (kind === "blocked") return 0.2;
  return 0.34;
}

function wallSeconds(): number {
  return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
}

function disconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // One-shot cleanup may overlap disposal.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
