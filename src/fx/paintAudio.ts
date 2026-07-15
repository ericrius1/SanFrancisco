/**
 * Tactile procedural audio for the paint launcher and its impacts.
 *
 * The launcher is a tight valve click, compressed-air cough and damp plunger
 * recoil. Impacts combine the contacted material with a deliberately wetter,
 * wider paint slap and a few irregular satellite droplets. Frequent events use
 * variant pools and per-source cooldowns so automatic fire stays articulate.
 *
 * PaintAudio does not own an AudioContext. Every voice borrows the shared
 * GameplaySfxBus, inheriting its autoplay unlock, limiter, effects volume/mute,
 * room response, visibility handling, and idle suspension.
 */

import type { GameplaySfxBus, GameplaySfxVoiceBus } from "../audio/gameplaySfxBus";
import { effectsAudioLevel } from "../core/audioSettings";

export type PaintAudioColor =
  | number
  | string
  | { r: number; g: number; b: number };

export type PaintImpactMaterial =
  | "concrete"
  | "wood"
  | "metal"
  | "glass"
  | "foliage"
  | "fabric"
  | "water"
  | "generic";

export type PaintShotOptions = {
  /** Cosmetic paint color; seeds subtle timbre/variant changes. */
  color?: PaintAudioColor;
  /** 0..1 propellant pressure. Defaults to 0.82. */
  pressure?: number;
  /** 0..1.5 event loudness/force. Defaults to 0.82. */
  intensity?: number;
  /** Listener-relative stereo position, -1 (left) to +1 (right). */
  pan?: number;
  /** 0..1 send into the shared short room. */
  room?: number;
  /** Stable shooter id; cooldowns are independent for different shooters. */
  sourceId?: string | number;
};

export type PaintImpactOptions = {
  material?: PaintImpactMaterial;
  /** Cosmetic paint color; seeds subtle timbre/variant changes. */
  color?: PaintAudioColor;
  /** Incoming speed in metres/second. Defaults to 38. */
  speed?: number;
  /** 0..1.5 event loudness/force; overrides the speed-derived default. */
  intensity?: number;
  /** 0..1 paint viscosity/wetness. Defaults to 0.9. */
  wetness?: number;
  /** Listener-relative stereo position, -1 (left) to +1 (right). */
  pan?: number;
  /** 0..1 send into the shared short room. Defaults by material. */
  room?: number;
  /** Stable projectile/shooter id for an independent impact cooldown. */
  sourceId?: string | number;
};

export type PaintAudioDebugState = {
  ready: boolean;
  context: string;
  activeVoices: number;
  shots: number;
  impacts: number;
  cooldownDrops: number;
  mutedDrops: number;
  lockedDrops: number;
  lastEvent: "shot" | "impact" | null;
  lastVariant: number;
  lastMaterial: PaintImpactMaterial | null;
  lastPan: number;
  cooldownEntries: number;
};

type LiveVoice = {
  nodes: AudioNode[];
  timer: ReturnType<typeof setTimeout>;
};

type MaterialProfile = {
  bodyHz: number;
  strikeHz: number;
  hardness: number;
  brightness: number;
  room: number;
};

const EPS = 0.0001;
const SHOT_COOLDOWN_SECONDS = 0.052;
const IMPACT_COOLDOWN_SECONDS = 0.036;
const SHOT_TAIL_SECONDS = 0.36;
const IMPACT_TAIL_SECONDS = 0.64;
const MAX_COOLDOWN_ENTRIES = 96;

const MATERIALS: Record<PaintImpactMaterial, MaterialProfile> = {
  concrete: { bodyHz: 185, strikeHz: 1280, hardness: 0.82, brightness: 0.72, room: 0.13 },
  wood: { bodyHz: 145, strikeHz: 690, hardness: 0.52, brightness: 0.4, room: 0.1 },
  metal: { bodyHz: 225, strikeHz: 2180, hardness: 1, brightness: 1, room: 0.17 },
  glass: { bodyHz: 285, strikeHz: 3450, hardness: 0.92, brightness: 1, room: 0.2 },
  foliage: { bodyHz: 98, strikeHz: 540, hardness: 0.12, brightness: 0.48, room: 0.035 },
  fabric: { bodyHz: 112, strikeHz: 420, hardness: 0.08, brightness: 0.2, room: 0.025 },
  water: { bodyHz: 82, strikeHz: 730, hardness: 0.03, brightness: 0.38, room: 0.015 },
  generic: { bodyHz: 155, strikeHz: 940, hardness: 0.58, brightness: 0.55, room: 0.09 }
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
const clamp01 = (value: number) => clamp(value, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const nowSeconds = () =>
  (typeof performance === "undefined" ? Date.now() : performance.now()) / 1000;

export class PaintAudio {
  readonly #bus: GameplaySfxBus;
  readonly #random: () => number;
  #lastAt = new Map<string, number>();
  #voices = new Set<LiveVoice>();
  #shots = 0;
  #impacts = 0;
  #cooldownDrops = 0;
  #mutedDrops = 0;
  #lockedDrops = 0;
  #lastEvent: PaintAudioDebugState["lastEvent"] = null;
  #lastVariant = { shot: -1, impact: -1 };
  #lastMaterial: PaintImpactMaterial | null = null;
  #lastPan = 0;

  constructor(bus: GameplaySfxBus, options: { random?: () => number } = {}) {
    this.#bus = bus;
    this.#random = options.random ?? Math.random;
  }

  /**
   * Fire one paint-launcher report. Returns false while muted/autoplay locked or
   * when the same source is still inside the short automatic-fire cooldown.
   */
  shot(options: PaintShotOptions = {}): boolean {
    if (effectsAudioLevel() <= EPS) {
      this.#mutedDrops++;
      return false;
    }

    const stamp = nowSeconds();
    const key = `shot:${options.sourceId ?? "local"}`;
    if (stamp - (this.#lastAt.get(key) ?? -Infinity) < SHOT_COOLDOWN_SECONDS) {
      this.#cooldownDrops++;
      return false;
    }

    const io = this.#bus.voiceBus(SHOT_TAIL_SECONDS);
    if (!io || io.ctx.state === "closed") {
      this.#lockedDrops++;
      return false;
    }

    this.#lastAt.set(key, stamp);
    this.#trimCooldowns(stamp);
    const colorSeed = colorFingerprint(options.color);
    const variant = this.#chooseVariant("shot", 7, colorSeed);
    const pressure = clamp01(options.pressure ?? 0.82);
    const intensity = clamp(options.intensity ?? 0.82, 0.05, 1.5);
    const pan = clamp(options.pan ?? 0, -1, 1);
    const room = clamp01(options.room ?? 0.075);
    const out = this.#voice(io, pan, room, intensity, SHOT_TAIL_SECONDS);

    this.#renderShot(io, out, variant, pressure, colorSeed);
    this.#shots++;
    this.#lastEvent = "shot";
    this.#lastPan = pan;
    return true;
  }

  /**
   * Sound a wet paint impact, with a restrained contact signature for the hit
   * material underneath it. Returns true only when a voice was scheduled.
   */
  impact(options: PaintImpactOptions = {}): boolean {
    if (effectsAudioLevel() <= EPS) {
      this.#mutedDrops++;
      return false;
    }

    const stamp = nowSeconds();
    const key = `impact:${options.sourceId ?? "local"}`;
    if (stamp - (this.#lastAt.get(key) ?? -Infinity) < IMPACT_COOLDOWN_SECONDS) {
      this.#cooldownDrops++;
      return false;
    }

    const io = this.#bus.voiceBus(IMPACT_TAIL_SECONDS);
    if (!io || io.ctx.state === "closed") {
      this.#lockedDrops++;
      return false;
    }

    this.#lastAt.set(key, stamp);
    this.#trimCooldowns(stamp);
    const material = options.material ?? "generic";
    const profile = MATERIALS[material];
    const speedEnergy = clamp01(((options.speed ?? 38) - 7) / 48);
    const intensity = clamp(options.intensity ?? 0.62 + speedEnergy * 0.38, 0.05, 1.5);
    const wetness = clamp01(options.wetness ?? 0.9);
    const pan = clamp(options.pan ?? 0, -1, 1);
    const room = clamp01(options.room ?? profile.room);
    const colorSeed = colorFingerprint(options.color);
    const variant = this.#chooseVariant("impact", 9, colorSeed + material.length * 0.071);
    const out = this.#voice(io, pan, room, intensity, IMPACT_TAIL_SECONDS);

    this.#renderImpact(io, out, variant, profile, wetness, colorSeed);
    this.#impacts++;
    this.#lastEvent = "impact";
    this.#lastMaterial = material;
    this.#lastPan = pan;
    return true;
  }

  get debugState(): PaintAudioDebugState {
    const bus = this.#bus.debugState;
    return {
      ready: bus.ctx !== "none",
      context: bus.ctx,
      activeVoices: this.#voices.size,
      shots: this.#shots,
      impacts: this.#impacts,
      cooldownDrops: this.#cooldownDrops,
      mutedDrops: this.#mutedDrops,
      lockedDrops: this.#lockedDrops,
      lastEvent: this.#lastEvent,
      lastVariant: this.#lastEvent ? this.#lastVariant[this.#lastEvent] : -1,
      lastMaterial: this.#lastMaterial,
      lastPan: +this.#lastPan.toFixed(3),
      cooldownEntries: this.#lastAt.size
    };
  }

  /** Disconnect this feature's live taps without disposing the shared bus. */
  dispose(): void {
    for (const voice of [...this.#voices]) this.#release(voice);
    this.#lastAt.clear();
  }

  #chooseVariant(kind: "shot" | "impact", count: number, seed: number): number {
    let variant = Math.floor((this.#random() * 0.78 + seed * 0.22) * count) % count;
    if (variant === this.#lastVariant[kind]) variant = (variant + 1 + Math.floor(this.#random() * 2)) % count;
    this.#lastVariant[kind] = variant;
    return variant;
  }

  #voice(
    io: GameplaySfxVoiceBus,
    pan: number,
    room: number,
    intensity: number,
    tail: number
  ): GainNode {
    const sum = io.ctx.createGain();
    sum.gain.value = Math.pow(intensity, 0.76) * 0.78;
    const stereo = io.ctx.createStereoPanner();
    stereo.pan.value = pan * 0.82;
    const dry = io.ctx.createGain();
    dry.gain.value = 1;
    const roomSend = io.ctx.createGain();
    roomSend.gain.value = room * 0.48;
    sum.connect(stereo);
    stereo.connect(dry).connect(io.dry);
    stereo.connect(roomSend).connect(io.room);

    const live = {
      nodes: [sum, stereo, dry, roomSend],
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

  #renderShot(
    io: GameplaySfxVoiceBus,
    out: AudioNode,
    variant: number,
    pressure: number,
    colorSeed: number
  ): void {
    const t0 = io.ctx.currentTime + 0.006;
    const pitch = 0.955 + colorSeed * 0.09 + (variant - 3) * 0.006;
    const force = 0.72 + pressure * 0.38;

    // Crisp valve articulation keeps the event readable in a busy city mix.
    this.#noise(io, out, t0, 0.024, 5200 + variant * 130, 2500, 1.55, 0.105 * force, 0.0015, 760, 7600);
    this.#tone(io.ctx, out, t0, 0.038, "triangle", 1820 * pitch, 920 * pitch, 0.035 * force, 0.0015);

    // The main report is air, not a firearm: a dense pressure cough with a
    // darker secondary chamber release behind the bright transient.
    this.#noise(io, out, t0 + 0.002, 0.098 + pressure * 0.026, 1550 + variant * 45, 360, 0.62, 0.235 * force, 0.003, 145, 5200);
    this.#noise(io, out, t0 + 0.022, 0.13, 620 + variant * 22, 205, 0.74, 0.11 * force, 0.014, 80, 1850);

    // Damp plunger recoil adds physical mass without turning the launcher into
    // a conventional gunshot. A tiny spring answer varies shot to shot.
    this.#tone(io.ctx, out, t0 + 0.003, 0.105, "sine", 218 * pitch, 76 * pitch, 0.14 * force, 0.004);
    this.#tone(io.ctx, out, t0 + 0.006, 0.066, "triangle", 475 * pitch, 142 * pitch, 0.045 * force, 0.003);
    this.#tone(
      io.ctx,
      out,
      t0 + 0.055 + (variant % 3) * 0.004,
      0.072,
      "triangle",
      (780 + variant * 34) * pitch,
      (490 + variant * 18) * pitch,
      0.013 + pressure * 0.009,
      0.003
    );
  }

  #renderImpact(
    io: GameplaySfxVoiceBus,
    out: AudioNode,
    variant: number,
    profile: MaterialProfile,
    wetness: number,
    colorSeed: number
  ): void {
    const t0 = io.ctx.currentTime + 0.006;
    const pitch = 0.94 + colorSeed * 0.12 + (variant - 4) * 0.009;
    const wet = 0.5 + wetness * 0.5;

    // First arrival: a very short material cue survives underneath the paint.
    // Hard glass/metal get a brighter note; foliage and fabric remain mostly
    // fibrous so impacts never read as pellets or bullets.
    this.#noise(
      io,
      out,
      t0,
      lerp(0.058, 0.025, profile.hardness),
      profile.strikeHz * (1.18 + variant * 0.018),
      profile.strikeHz * 0.56,
      0.72 + profile.hardness,
      0.075 + profile.hardness * 0.105,
      0.0015,
      90,
      lerp(1600, 7600, profile.brightness)
    );
    this.#tone(
      io.ctx,
      out,
      t0 + 0.001,
      0.055 + profile.hardness * 0.055,
      profile.hardness > 0.75 ? "triangle" : "sine",
      profile.strikeHz * pitch,
      profile.strikeHz * pitch * 0.58,
      0.018 + profile.hardness * 0.036,
      0.0015
    );

    // The signature wet slap: broad paint-body noise, low liquid displacement,
    // and two descending viscosity chirps. Its timing is offset a few ms from
    // the contact so the ear hears both the surface and the paint coating it.
    const slapAt = t0 + 0.004;
    this.#noise(io, out, slapAt, 0.18 + wetness * 0.055, 1080 + variant * 43, 155, 0.58, 0.29 * wet, 0.004, 65, 3300 + wetness * 1050);
    this.#noise(io, out, slapAt + 0.014, 0.135, 410 + variant * 17, 92, 0.9, 0.17 * wet, 0.008, 45, 980);
    this.#tone(io.ctx, out, slapAt, 0.15, "sine", profile.bodyHz * pitch, 52 * pitch, 0.115 * wet, 0.003);
    this.#tone(io.ctx, out, slapAt + 0.01, 0.105, "triangle", (455 + variant * 18) * pitch, 96 * pitch, 0.043 * wet, 0.006);
    this.#tone(io.ctx, out, slapAt + 0.027, 0.092, "sine", (310 + variant * 11) * pitch, 72 * pitch, 0.034 * wet, 0.005);

    // Small satellite droplets keep repeated splats organic. Count, timing and
    // pitch all vary, while remaining quiet enough not to smear rapid fire.
    const droplets = 2 + (variant % 3);
    for (let i = 0; i < droplets; i++) {
      const at = slapAt + 0.058 + i * (0.031 + this.#random() * 0.018);
      const startHz = 1850 + this.#random() * 1200 + profile.brightness * 560;
      this.#noise(io, out, at, 0.043 + this.#random() * 0.032, startHz, 520 + this.#random() * 310, 0.85, (0.025 + this.#random() * 0.025) * wet, 0.002, 180, 4300);
      this.#tone(io.ctx, out, at, 0.055 + this.#random() * 0.025, "sine", (690 + this.#random() * 380) * pitch, 180 * pitch, 0.009 + wetness * 0.008, 0.002);
    }
  }

  #noise(
    io: GameplaySfxVoiceBus,
    out: AudioNode,
    at: number,
    duration: number,
    startFrequency: number,
    endFrequency: number,
    q: number,
    peak: number,
    attack: number,
    highpass: number,
    lowpass: number
  ): void {
    const source = io.ctx.createBufferSource();
    source.buffer = io.noise;
    const hp = io.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = highpass;
    hp.Q.value = 0.5;
    const band = io.ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = q;
    band.frequency.setValueAtTime(Math.max(40, startFrequency), at);
    band.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), at + duration);
    const lp = io.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lowpass;
    lp.Q.value = 0.55;
    const gain = io.ctx.createGain();
    gain.gain.setValueAtTime(EPS, at);
    gain.gain.linearRampToValueAtTime(Math.max(EPS, peak), at + Math.min(attack, duration * 0.35));
    gain.gain.exponentialRampToValueAtTime(EPS, at + duration);
    source.connect(hp).connect(band).connect(lp).connect(gain).connect(out);
    const available = Math.max(0.01, io.noise.duration - duration - 0.01);
    source.start(at, this.#random() * available);
    source.stop(at + duration + 0.012);
  }

  #tone(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    duration: number,
    type: OscillatorType,
    startFrequency: number,
    endFrequency: number,
    peak: number,
    attack: number
  ): void {
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(30, startFrequency), at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), at + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(EPS, at);
    gain.gain.linearRampToValueAtTime(Math.max(EPS, peak), at + Math.min(attack, duration * 0.35));
    gain.gain.exponentialRampToValueAtTime(EPS, at + duration);
    oscillator.connect(gain).connect(out);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.012);
  }

  #trimCooldowns(now: number): void {
    if (this.#lastAt.size <= MAX_COOLDOWN_ENTRIES) return;
    for (const [key, at] of this.#lastAt) {
      if (now - at > 2) this.#lastAt.delete(key);
    }
    while (this.#lastAt.size > MAX_COOLDOWN_ENTRIES) {
      const oldest = this.#lastAt.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.#lastAt.delete(oldest);
    }
  }
}

function colorFingerprint(color: PaintAudioColor | undefined): number {
  if (typeof color === "number") {
    return ((Math.abs(Math.trunc(color)) >>> 0) % 16_777_216) / 16_777_215;
  }
  if (typeof color === "string") {
    let hash = 2166136261;
    for (let i = 0; i < color.length; i++) {
      hash ^= color.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4_294_967_295;
  }
  if (color) {
    const r = clamp01(color.r);
    const g = clamp01(color.g);
    const b = clamp01(color.b);
    // Favor hue differences over simple luminance while staying deterministic.
    return (r * 0.37 + g * 0.53 + b * 0.71) % 1;
  }
  return 0.5;
}

function disconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // HMR teardown may race a scheduled release.
  }
}
