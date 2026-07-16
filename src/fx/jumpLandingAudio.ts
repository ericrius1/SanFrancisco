/**
 * Procedural on-foot jump audio. A compact edge tracker turns grounded-state
 * changes into two deliberately layered one-shots:
 *
 * - takeoff: sole push, cloth lift and a quiet body pulse
 * - landing: weighty low-mid thud, soft shoe contact and speed-dependent scuff
 *
 * The module does not own an AudioContext. It borrows short-lived voices from
 * the shared gameplay SFX bus, so autoplay unlock, effects-volume changes and
 * idle suspension stay centralized. Edge tracking still runs without an audio
 * device, which makes `debugState` useful in headless probes.
 */

import type { GameplaySfxBus, GameplaySfxVoiceBus } from "../audio/gameplaySfxBus";

export type JumpLandingSignals = {
  /** False outside on-foot play (vehicles, swimming, paused, cinematics). */
  active: boolean;
  grounded: boolean;
  /** Signed vertical speed in metres/second. */
  verticalSpeed: number;
  /** Horizontal speed in metres/second; adds takeoff energy and landing scuff. */
  horizontalSpeed?: number;
  /** 0 = concrete/wood, 1 = soil/grass. Defaults to 0.2. */
  surfaceSoftness?: number;
};

type JumpEventKind = "takeoff" | "landing";

type JumpEvent = {
  kind: JumpEventKind;
  intensity: number;
  horizontalSpeed: number;
  softness: number;
  variant: number;
  ttl: number;
};

export type JumpLandingDebugState = {
  primed: boolean;
  grounded: boolean | null;
  airborneTime: number;
  peakDescentSpeed: number;
  pendingEvent: JumpEventKind | null;
  takeoffCount: number;
  landingCount: number;
  renderedTakeoffCount: number;
  renderedLandingCount: number;
  lastEvent: JumpEventKind | null;
  lastIntensity: number;
  lastVariant: number;
  lastRenderStatus: "idle" | "bus-unavailable" | "rendered";
};

const TAKEOFF_MIN_UP_SPEED = 0.55;
const TAKEOFF_COOLDOWN = 0.18;
const LANDING_COOLDOWN = 0.2;
const MIN_AIRBORNE_TIME = 0.085;
const EVENT_RETRY_WINDOW = 0.16;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const finiteOr = (v: number | undefined, fallback: number) =>
  Number.isFinite(v) ? (v as number) : fallback;

function connectVoiceOutput(
  ctx: AudioContext,
  dry: AudioNode,
  room: AudioNode,
  dryLevel: number,
  roomLevel: number,
  pan: number
): GainNode {
  const out = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const drySend = ctx.createGain();
  const roomSend = ctx.createGain();
  panner.pan.value = clamp(pan, -0.3, 0.3);
  drySend.gain.value = dryLevel;
  roomSend.gain.value = roomLevel;
  out.connect(panner);
  panner.connect(drySend);
  panner.connect(roomSend);
  drySend.connect(dry);
  roomSend.connect(room);
  globalThis.setTimeout(() => {
    for (const node of [out, panner, drySend, roomSend]) {
      try {
        node.disconnect();
      } catch {
        /* one-shot graph already released */
      }
    }
  }, 900);
  return out;
}

function noiseBurst(
  voice: GameplaySfxVoiceBus,
  destination: AudioNode,
  start: number,
  duration: number,
  peak: number,
  attack: number,
  filterType: BiquadFilterType,
  frequency: number,
  endFrequency: number,
  q: number,
  highCut: number,
  offset: number
): void {
  const { ctx } = voice;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const lowpass = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  source.buffer = voice.noise;
  filter.type = filterType;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(40, frequency), start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), start + duration);
  lowpass.type = "lowpass";
  lowpass.frequency.value = highCut;
  lowpass.Q.value = 0.55;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  source.connect(filter);
  filter.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(destination);
  source.start(start, offset % Math.max(0.01, voice.noise.duration - duration));
  source.stop(start + duration + 0.015);
}

function pitchedPulse(
  ctx: AudioContext,
  destination: AudioNode,
  start: number,
  duration: number,
  peak: number,
  startFrequency: number,
  endFrequency: number,
  type: OscillatorType
): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(startFrequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(peak, start + Math.min(0.012, duration * 0.2));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.015);
}

export class JumpLandingAudio {
  readonly #bus: GameplaySfxBus;
  readonly #random: () => number;
  #primed = false;
  #grounded: boolean | null = null;
  #airborneTime = 0;
  #peakDescentSpeed = 0;
  #takeoffCooldown = 0;
  #landingCooldown = 0;
  #pending: JumpEvent | null = null;
  #takeoffCount = 0;
  #landingCount = 0;
  #renderedTakeoffCount = 0;
  #renderedLandingCount = 0;
  #lastEvent: JumpEventKind | null = null;
  #lastIntensity = 0;
  #lastVariant = -1;
  #lastRenderStatus: JumpLandingDebugState["lastRenderStatus"] = "idle";

  constructor(bus: GameplaySfxBus, options: { random?: () => number } = {}) {
    this.#bus = bus;
    this.#random = options.random ?? Math.random;
  }

  /**
   * Call once per frame. Pass null (or active:false) while gameplay is paused or
   * not on foot. The first active sample primes state and never makes a sound.
   */
  update(dt: number, signals: JumpLandingSignals | null): void {
    const step = clamp(finiteOr(dt, 0), 0, 0.1);
    this.#takeoffCooldown = Math.max(0, this.#takeoffCooldown - step);
    this.#landingCooldown = Math.max(0, this.#landingCooldown - step);

    if (!signals?.active) {
      this.#primed = false;
      this.#grounded = null;
      this.#airborneTime = 0;
      this.#peakDescentSpeed = 0;
      this.#pending = null;
      return;
    }

    if (this.#pending) {
      this.#pending.ttl -= step;
      if (!this.#tryRender(this.#pending) && this.#pending.ttl <= 0) this.#pending = null;
    }

    const grounded = signals.grounded;
    const verticalSpeed = finiteOr(signals.verticalSpeed, 0);
    const horizontalSpeed = Math.max(0, finiteOr(signals.horizontalSpeed, 0));
    const softness = clamp01(finiteOr(signals.surfaceSoftness, 0.2));

    if (!this.#primed) {
      this.#primed = true;
      this.#grounded = grounded;
      this.#airborneTime = 0;
      this.#peakDescentSpeed = grounded ? 0 : Math.max(0, -verticalSpeed);
      return;
    }

    const wasGrounded = this.#grounded ?? grounded;

    if (wasGrounded && !grounded) {
      this.#airborneTime = 0;
      this.#peakDescentSpeed = Math.max(0, -verticalSpeed);
      if (verticalSpeed >= TAKEOFF_MIN_UP_SPEED && this.#takeoffCooldown <= 0) {
        const lift = clamp01((verticalSpeed - TAKEOFF_MIN_UP_SPEED) / 7.2);
        const run = clamp01(horizontalSpeed / 8);
        this.#queue({
          kind: "takeoff",
          intensity: clamp01(0.38 + lift * 0.47 + run * 0.15),
          horizontalSpeed,
          softness,
          variant: Math.floor(this.#random() * 6) % 6,
          ttl: EVENT_RETRY_WINDOW
        });
        this.#takeoffCooldown = TAKEOFF_COOLDOWN;
      }
    } else if (!grounded) {
      this.#airborneTime += step;
      this.#peakDescentSpeed = Math.max(this.#peakDescentSpeed, -verticalSpeed);
    } else if (!wasGrounded) {
      const impactSpeed = Math.max(this.#peakDescentSpeed, -verticalSpeed);
      if (this.#airborneTime >= MIN_AIRBORNE_TIME && this.#landingCooldown <= 0) {
        const impact = clamp01((impactSpeed - 0.6) / 8.5);
        const run = clamp01(horizontalSpeed / 8);
        this.#queue({
          kind: "landing",
          intensity: clamp01(0.28 + impact * 0.62 + run * 0.1),
          horizontalSpeed,
          softness,
          variant: Math.floor(this.#random() * 8) % 8,
          ttl: EVENT_RETRY_WINDOW
        });
        this.#landingCooldown = LANDING_COOLDOWN;
      }
      this.#airborneTime = 0;
      this.#peakDescentSpeed = 0;
    }

    this.#grounded = grounded;
  }

  /** Reset transition history after a teleport/respawn without emitting. */
  reset(): void {
    this.#primed = false;
    this.#grounded = null;
    this.#airborneTime = 0;
    this.#peakDescentSpeed = 0;
    this.#pending = null;
  }

  get debugState(): JumpLandingDebugState {
    return {
      primed: this.#primed,
      grounded: this.#grounded,
      airborneTime: this.#airborneTime,
      peakDescentSpeed: this.#peakDescentSpeed,
      pendingEvent: this.#pending?.kind ?? null,
      takeoffCount: this.#takeoffCount,
      landingCount: this.#landingCount,
      renderedTakeoffCount: this.#renderedTakeoffCount,
      renderedLandingCount: this.#renderedLandingCount,
      lastEvent: this.#lastEvent,
      lastIntensity: this.#lastIntensity,
      lastVariant: this.#lastVariant,
      lastRenderStatus: this.#lastRenderStatus
    };
  }

  #queue(event: JumpEvent): void {
    this.#lastEvent = event.kind;
    this.#lastIntensity = event.intensity;
    this.#lastVariant = event.variant;
    if (event.kind === "takeoff") this.#takeoffCount++;
    else this.#landingCount++;

    this.#pending = event;
    if (this.#tryRender(event)) this.#pending = null;
  }

  #tryRender(event: JumpEvent): boolean {
    const hold = event.kind === "takeoff" ? 0.42 : 0.62;
    const voice = this.#bus.voiceBus(hold);
    if (!voice || voice.ctx.state !== "running") {
      this.#lastRenderStatus = "bus-unavailable";
      return false;
    }

    if (event.kind === "takeoff") {
      this.#renderTakeoff(voice, event);
      this.#renderedTakeoffCount++;
    } else {
      this.#renderLanding(voice, event);
      this.#renderedLandingCount++;
    }
    this.#bus.touch(hold);
    this.#lastRenderStatus = "rendered";
    return true;
  }

  #renderTakeoff(voice: GameplaySfxVoiceBus, event: JumpEvent): void {
    const { ctx } = voice;
    const t0 = ctx.currentTime + 0.004;
    const v = event.variant;
    const energy = event.intensity;
    const softness = event.softness;
    const pan = ((v % 3) - 1) * 0.055 + (this.#random() - 0.5) * 0.04;
    const out = connectVoiceOutput(ctx, voice.dry, voice.room, 0.88, 0.1, pan);

    // Shoe sole unweights first: darker and longer on natural ground.
    noiseBurst(
      voice,
      out,
      t0,
      0.105 + softness * 0.035,
      (0.105 + energy * 0.055) * (1 - softness * 0.18),
      0.006,
      "bandpass",
      390 + v * 23 - softness * 90,
      230 + v * 11,
      0.85,
      1650 - softness * 350,
      this.#random() * 1.4
    );

    // Short fabric lift sells the body leaving the ground without a synthetic zap.
    noiseBurst(
      voice,
      out,
      t0 + 0.015,
      0.17 + (v % 2) * 0.018,
      0.052 + energy * 0.047,
      0.018,
      "bandpass",
      820 + v * 54,
      1450 + v * 37,
      0.58,
      3300,
      this.#random() * 1.5
    );

    // Quiet low-mid body pulse; intentionally above sub-bass for laptop speakers.
    pitchedPulse(
      ctx,
      out,
      t0,
      0.1,
      0.026 + energy * 0.028,
      118 + v * 3,
      72 + v * 2,
      "triangle"
    );
  }

  #renderLanding(voice: GameplaySfxVoiceBus, event: JumpEvent): void {
    const { ctx } = voice;
    const t0 = ctx.currentTime + 0.004;
    const v = event.variant;
    const energy = event.intensity;
    const softness = event.softness;
    const run = clamp01(event.horizontalSpeed / 8);
    const pan = ((v % 4) - 1.5) * 0.04 + (this.#random() - 0.5) * 0.025;
    const out = connectVoiceOutput(
      ctx,
      voice.dry,
      voice.room,
      0.94,
      0.07 + (1 - softness) * 0.055,
      pan
    );

    // Body weight: a compact low-mid pitch fall, not a cinematic sub hit.
    pitchedPulse(
      ctx,
      out,
      t0,
      0.15 + energy * 0.07,
      (0.075 + energy * 0.115) * (1 - softness * 0.15),
      126 + (v % 3) * 6 - softness * 18,
      53 + (v % 2) * 4,
      "triangle"
    );

    // Broad shoe/ground body, gently closing to keep repeated landings warm.
    noiseBurst(
      voice,
      out,
      t0,
      0.2 + softness * 0.075 + energy * 0.035,
      0.105 + energy * 0.12,
      0.008,
      "lowpass",
      980 + v * 31 - softness * 320,
      250 + softness * 45,
      0.64,
      2700 - softness * 750,
      this.#random() * 1.35
    );

    // Small sole contact brings definition on hard ground, but never a sharp click.
    noiseBurst(
      voice,
      out,
      t0 + 0.004 + (v % 2) * 0.005,
      0.065 + (v % 3) * 0.006,
      (0.025 + energy * 0.052) * (1 - softness * 0.72),
      0.003,
      "bandpass",
      1250 + v * 72,
      860 + v * 35,
      0.75,
      3600,
      this.#random() * 1.65
    );

    // Running landings carry a trailing sole drag; standing hops remain compact.
    if (run > 0.08) {
      noiseBurst(
        voice,
        out,
        t0 + 0.035,
        0.105 + run * 0.1,
        (0.02 + run * 0.07) * (0.75 + softness * 0.25),
        0.012,
        "bandpass",
        760 + v * 29 - softness * 140,
        420 + v * 16,
        0.58,
        2200 - softness * 300,
        this.#random() * 1.45
      );
    }
  }
}
