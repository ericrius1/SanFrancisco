// One-shot impact voices for the player's thrown ball: a dry thud when it hits
// the ground and a wet plonk when it lands in water. The water plonk is fed
// through a persistent, tunable feedback delay — the "magic echo" — so a ball
// tossed into the Japanese Tea Garden's stream rings out with an otherworldly,
// fey-realm shimmer that ordinary ground bounces never get.
//
// Like the dog park and stream layers, this owns no AudioContext and fetches no
// sample: it rides NatureSoundscape's shared context, presence-independent
// #alwaysBus (HUD volume/mute + limiter) and reverb send, and its shared voice
// noise buffer. Construction is inert; the node graph is built on the first
// impact and the shared context is only kept awake for the brief tail after a
// hit (so a thud on open terrain, far from every nature region, still sounds).

import { tunables } from "../core/persist";
import { NATURE_AUDIO_TUNING, type NatureSoundscape } from "./natureSoundscape";

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

/**
 * Tunable beside the behavior it controls; bind into a debug folder so the
 * "magic echo" is adjustable at runtime (and persisted).
 */
export const BALL_IMPACT_AUDIO_TUNING = tunables("ballImpactAudio", {
  enabled: { v: true, label: "enabled" },
  groundVolume: { v: 0.85, min: 0, max: 2, step: 0.01, label: "ground volume" },
  waterVolume: { v: 1.0, min: 0, max: 2, step: 0.01, label: "water volume" },
  // Magic echo (fey realm) — only the water plonk feeds it.
  echoEnabled: { v: true, label: "magic echo" },
  echoDelay: { v: 0.26, min: 0.04, max: 0.9, step: 0.005, label: "echo delay (s)" },
  echoFeedback: { v: 0.52, min: 0, max: 0.92, step: 0.01, label: "echo feedback" },
  echoWet: { v: 0.7, min: 0, max: 1.5, step: 0.01, label: "echo wet" },
  echoTone: { v: 2100, min: 300, max: 8000, step: 50, label: "echo tone (Hz)" },
  echoShimmer: { v: 0.5, min: 0, max: 1, step: 0.01, label: "echo shimmer" },
  echoSpace: { v: 0.55, min: 0, max: 1, step: 0.01, label: "echo space" }
});

const EPS = 0.0001;
// Seconds the shared context is held awake after the last impact — long enough
// to let the magic-echo tail ring out before the out-of-region suspend returns.
const AWAKE_TAIL = 4.5;
// A ball can register several substep bounces in one frame; collapse near-
// simultaneous ground contacts into a single thud.
const GROUND_MIN_GAP = 0.05;

export class BallImpactAudio {
  #nature: NatureSoundscape;
  #io: NatureVoiceIO | null = null;

  // persistent output taps
  #groundOut: GainNode | null = null;
  #waterDry: GainNode | null = null;

  // persistent "magic echo" feedback line (built with the graph, shared by all
  // water plonks)
  #echoIn: GainNode | null = null;
  #echoDelay: DelayNode | null = null;
  #echoTone: BiquadFilterNode | null = null;
  #echoFeedback: GainNode | null = null;
  #echoWet: GainNode | null = null;
  #echoSpace: GainNode | null = null;
  #echoLfo: OscillatorNode | null = null;
  #echoLfoDepth: GainNode | null = null;

  #ready = false;
  #awakeHold = 0;
  #releaseNatureHold: (() => void) | null = null;
  #lastGroundAt = -Infinity;
  #groundCount = 0;
  #waterCount = 0;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  /** Read-only surface for headless audio probes. */
  get debugState() {
    return {
      ready: this.#ready,
      context: this.#io?.ctx.state ?? "none",
      awakeHold: +this.#awakeHold.toFixed(2),
      groundCount: this.#groundCount,
      waterCount: this.#waterCount
    };
  }

  /** Ball struck solid ground at `speed` m/s (downward contact speed). */
  ground(x: number, y: number, z: number, speed: number): void {
    const T = BALL_IMPACT_AUDIO_TUNING.values;
    if (!Boolean(T.enabled) || Number(T.groundVolume) <= 0.001) return;
    const ctx = this.#init();
    if (!ctx || ctx.state === "closed" || !this.#groundOut) return;
    const now = ctx.currentTime;
    if (now - this.#lastGroundAt < GROUND_MIN_GAP) return;
    this.#lastGroundAt = now;

    // 0 at a dead settle, 1 at a hard slam. A tennis ball is soft: a rounded
    // low body + a short mid "pat", both scaled by impact energy.
    const drive = clamp01((speed - 1.1) / 7);
    const level = (0.16 + drive * 0.7) * Number(T.groundVolume);
    const panner = this.#panner(ctx, x, y, z);
    panner.connect(this.#groundOut);

    const bodyFreq = 78 + Math.random() * 46 + drive * 26;
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(bodyFreq * 1.7, now);
    body.frequency.exponentialRampToValueAtTime(bodyFreq, now + 0.05);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(EPS, now);
    bodyGain.gain.exponentialRampToValueAtTime(level, now + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(EPS, now + 0.09 + drive * 0.05);
    body.connect(bodyGain).connect(panner);

    // dry mid transient: a short filtered noise pat, brighter on a harder hit
    const pat = ctx.createBufferSource();
    pat.buffer = this.#io!.noise;
    pat.playbackRate.value = 0.9 + Math.random() * 0.3;
    const patBp = ctx.createBiquadFilter();
    patBp.type = "bandpass";
    patBp.frequency.value = 720 + drive * 900;
    patBp.Q.value = 0.7;
    const patGain = ctx.createGain();
    patGain.gain.setValueAtTime(EPS, now);
    patGain.gain.exponentialRampToValueAtTime(level * 0.5, now + 0.003);
    patGain.gain.exponentialRampToValueAtTime(EPS, now + 0.035);
    pat.connect(patBp).connect(patGain).connect(panner);

    const stop = now + 0.16;
    body.start(now);
    body.stop(stop);
    pat.start(now, Math.random() * Math.max(0.01, this.#io!.noise.duration - 0.05));
    pat.stop(stop);
    body.onended = () => {
      disconnect(bodyGain);
      disconnect(patBp);
      disconnect(patGain);
      disconnect(panner);
    };

    this.#groundCount++;
    this.#keepAwake();
  }

  /** Ball broke a water surface at `speed` m/s — plonk + the magic echo tail. */
  water(x: number, y: number, z: number, speed: number): void {
    const T = BALL_IMPACT_AUDIO_TUNING.values;
    if (!Boolean(T.enabled) || Number(T.waterVolume) <= 0.001) return;
    const ctx = this.#init();
    if (!ctx || ctx.state === "closed" || !this.#waterDry || !this.#echoIn) return;
    const now = ctx.currentTime;

    const drive = clamp01((speed - 0.5) / 8);
    const level = (0.24 + drive * 0.62) * Number(T.waterVolume);

    // hitSum feeds both the positional dry plonk and the mono magic-echo line.
    const hitSum = ctx.createGain();
    hitSum.gain.value = 1;
    const panner = this.#panner(ctx, x, y, z);
    hitSum.connect(panner);
    panner.connect(this.#waterDry);
    if (Boolean(T.echoEnabled)) hitSum.connect(this.#echoIn);

    // cavity "ploop": a sine that pitches DOWN as the pocket collapses — the
    // canonical water-drop resonance — deeper and slower on a heavier splash.
    const f0 = 520 - drive * 150 + Math.random() * 70;
    const bubble = ctx.createOscillator();
    bubble.type = "sine";
    bubble.frequency.setValueAtTime(f0, now);
    bubble.frequency.exponentialRampToValueAtTime(f0 * 0.5, now + 0.09 + drive * 0.05);
    const bubbleGain = ctx.createGain();
    bubbleGain.gain.setValueAtTime(EPS, now);
    bubbleGain.gain.exponentialRampToValueAtTime(level, now + 0.006);
    bubbleGain.gain.exponentialRampToValueAtTime(EPS, now + 0.16 + drive * 0.08);
    bubble.connect(bubbleGain).connect(hitSum);

    // splash: a bright noise burst that darkens as it decays
    const splash = ctx.createBufferSource();
    splash.buffer = this.#io!.noise;
    splash.playbackRate.value = 1 + Math.random() * 0.3;
    const splashBp = ctx.createBiquadFilter();
    splashBp.type = "bandpass";
    splashBp.frequency.setValueAtTime(2600 + drive * 1800, now);
    splashBp.frequency.exponentialRampToValueAtTime(900, now + 0.18);
    splashBp.Q.value = 0.6;
    const splashGain = ctx.createGain();
    splashGain.gain.setValueAtTime(EPS, now);
    splashGain.gain.exponentialRampToValueAtTime(level * 0.6, now + 0.005);
    splashGain.gain.exponentialRampToValueAtTime(EPS, now + 0.2);
    splash.connect(splashBp).connect(splashGain).connect(hitSum);

    const stop = now + 0.3;
    bubble.start(now);
    bubble.stop(stop);
    splash.start(now, Math.random() * Math.max(0.01, this.#io!.noise.duration - 0.25));
    splash.stop(stop);
    splash.onended = () => {
      disconnect(bubbleGain);
      disconnect(splashBp);
      disconnect(splashGain);
      disconnect(hitSum);
      disconnect(panner);
    };

    this.#waterCount++;
    this.#keepAwake();
  }

  /** Per frame. Manages the shared-context keep-awake tail + live echo tuning. */
  update(dt: number): void {
    if (this.#awakeHold > 0) {
      this.#awakeHold = Math.max(0, this.#awakeHold - Math.max(0, dt));
      if (this.#awakeHold <= 0 && this.#releaseNatureHold) {
        this.#releaseNatureHold();
        this.#releaseNatureHold = null;
      }
    }
    if (this.#ready) this.#syncEcho();
  }

  dispose(): void {
    this.#releaseNatureHold?.();
    this.#releaseNatureHold = null;
    this.#echoLfo?.stop();
    for (const node of [
      this.#groundOut,
      this.#waterDry,
      this.#echoIn,
      this.#echoDelay,
      this.#echoTone,
      this.#echoFeedback,
      this.#echoWet,
      this.#echoSpace,
      this.#echoLfoDepth
    ]) {
      disconnect(node);
    }
    this.#groundOut = null;
    this.#waterDry = null;
    this.#echoIn = null;
    this.#echoDelay = null;
    this.#echoTone = null;
    this.#echoFeedback = null;
    this.#echoWet = null;
    this.#echoSpace = null;
    this.#echoLfo = null;
    this.#echoLfoDepth = null;
    this.#ready = false;
  }

  #init(): AudioContext | null {
    if (this.#ready) return this.#io!.ctx;
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state === "closed") return null;
    const { ctx, alwaysBus, effectsReverbSend } = io;

    this.#groundOut = ctx.createGain();
    this.#groundOut.gain.value = 1;
    this.#groundOut.connect(alwaysBus);

    this.#waterDry = ctx.createGain();
    this.#waterDry.gain.value = 1;
    this.#waterDry.connect(alwaysBus);

    // magic echo: hitSum → echoIn → delay → (tone → feedback ↺ delay) → wet
    // The wet tap goes both to the dry bus (audible repeats) and the reverb send
    // (ethereal space). An LFO on the delay time detunes the repeats to shimmer.
    this.#echoIn = ctx.createGain();
    this.#echoIn.gain.value = 1;
    this.#echoDelay = ctx.createDelay(1.5);
    this.#echoTone = ctx.createBiquadFilter();
    this.#echoTone.type = "lowpass";
    this.#echoTone.Q.value = 0.4;
    this.#echoFeedback = ctx.createGain();
    this.#echoWet = ctx.createGain();
    this.#echoWet.gain.value = 1;
    this.#echoSpace = ctx.createGain();

    this.#echoIn.connect(this.#echoDelay);
    this.#echoDelay.connect(this.#echoTone);
    this.#echoTone.connect(this.#echoFeedback);
    this.#echoFeedback.connect(this.#echoDelay); // feedback loop
    this.#echoTone.connect(this.#echoWet); // tap the repeats
    this.#echoWet.connect(alwaysBus);
    this.#echoWet.connect(this.#echoSpace);
    this.#echoSpace.connect(effectsReverbSend);

    this.#echoLfo = ctx.createOscillator();
    this.#echoLfo.type = "sine";
    this.#echoLfo.frequency.value = 0.19;
    this.#echoLfoDepth = ctx.createGain();
    this.#echoLfoDepth.gain.value = 0;
    this.#echoLfo.connect(this.#echoLfoDepth).connect(this.#echoDelay.delayTime);
    this.#echoLfo.start();

    this.#ready = true;
    this.#syncEcho();
    return ctx;
  }

  #syncEcho(): void {
    const ctx = this.#io?.ctx;
    if (!ctx || !this.#echoDelay || !this.#echoTone || !this.#echoFeedback || !this.#echoWet || !this.#echoSpace || !this.#echoLfoDepth) {
      return;
    }
    const T = BALL_IMPACT_AUDIO_TUNING.values;
    const now = ctx.currentTime;
    const on = Boolean(T.echoEnabled);
    const delay = clamp(Number(T.echoDelay), 0.02, 1.4);
    this.#echoDelay.delayTime.setTargetAtTime(delay, now, 0.08);
    this.#echoTone.frequency.setTargetAtTime(clamp(Number(T.echoTone), 200, 12000), now, 0.1);
    this.#echoFeedback.gain.setTargetAtTime(on ? clamp(Number(T.echoFeedback), 0, 0.95) : 0, now, 0.1);
    this.#echoWet.gain.setTargetAtTime(on ? Math.max(0, Number(T.echoWet)) : 0, now, 0.1);
    this.#echoSpace.gain.setTargetAtTime(
      clamp01(Number(T.echoSpace)) * Number(NATURE_AUDIO_TUNING.values.reverb),
      now,
      0.15
    );
    // Shimmer modulates the delay time by up to ~6 ms — a gentle chorused detune.
    this.#echoLfoDepth.gain.setTargetAtTime(on ? clamp01(Number(T.echoShimmer)) * 0.006 : 0, now, 0.15);
  }

  #panner(ctx: AudioContext, x: number, y: number, z: number): PannerNode {
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 6;
    panner.rolloffFactor = 0.8;
    panner.maxDistance = 90;
    if (panner.positionX) {
      const now = ctx.currentTime;
      panner.positionX.setValueAtTime(x, now);
      panner.positionY.setValueAtTime(y, now);
      panner.positionZ.setValueAtTime(z, now);
    } else {
      panner.setPosition(x, y, z);
    }
    return panner;
  }

  #keepAwake(): void {
    this.#awakeHold = AWAKE_TAIL;
    this.#releaseNatureHold ??= this.#nature.acquireExternalHold("ball-impact-tail");
  }
}

function disconnect(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    // Shared-context teardown can race one-shot cleanup.
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
