// The instrument contract for the generative score.
//
// Until now every region played the same five synth voices with the faders in
// different positions, which is why nowhere sounded like anywhere. A region now
// owns a *palette*: weighted mixes over four instrument families. The director
// blends those weight vectors across region influence and draws a voice per
// gesture, so crossing a boundary hears the two ensembles interleave instead of
// snapping.
//
// A voice is a pure scheduling function: it builds its own nodes, connects dry
// to `out` and wet to `rev` with its own send amount, and MUST stop() every
// source it starts (nothing here is pooled — the engine has no voice cap, only
// the director's 1.6 s lookahead keeps the node count sane).

export type VoiceCtx = {
  ctx: AudioContext;
  /** dry destination — the family bus the director owns. */
  out: AudioNode;
  /** shared convolver send; voices pick their own send depth. */
  rev: AudioNode;
  /** injected so a future seeded render can be deterministic. */
  rng: () => number;
};

export type NoteEvent = {
  /** ctx time to start. */
  t: number;
  midi: number;
  /** peak linear gain, ~0.02..0.3. The family bus applies region/section trim. */
  vel: number;
  /** seconds the note is musically held; decaying voices may ignore it. */
  dur: number;
  /** 0..1 daylight — voices open filters and shorten tails as this rises. */
  bright: number;
};

export type Voice = (v: VoiceCtx, n: NoteEvent) => void;

/* --------------------------------------------------------------- families */

/** Struck/plucked voices that sound the chord voicing. */
export type KeysVoiceId =
  | "rhodes" // worn electric piano — the house sound
  | "felt" // damped upright, hammers muffled with felt
  | "vibes" // vibraphone, motor tremolo
  | "nylon" // nylon-string guitar, fingerpicked
  | "celeste" // struck glass/celeste, pure and high
  | "reed" // harmonium/reed organ, sustained and breathing
  | "koto" // hard plucked string with a bent attack
  | "marimba"; // hollow rosewood, fast decay

/** Sustained voices that hold the harmony underneath. */
export type PadVoiceId =
  | "drift" // detuned sines, the original pad
  | "bow" // bowed strings, slow rosin swell
  | "choir" // formant-filtered vowel pad
  | "organ" // drawbar organ, additive and steady
  | "glass" // shimmer — octave-up partials, slow tremolo
  | "breath"; // filtered air + sine, shakuhachi-ish

/** Low register. */
export type BassVoiceId =
  | "sub" // pure sine, felt not heard
  | "upright" // pizzicato double bass with body thump
  | "round" // triangle through a lowpass, synthy and soft
  | "tape"; // saturated sine with a slow pitch-drift head

/** High melodic pings above the chord. */
export type SparkleVoiceId =
  | "musicBox" // the original bell ping
  | "glassBell" // longer, purer, wider
  | "kalimba" // metal tine + wooden knock
  | "harp" // soft-attack harmonic, no transient
  | "drop"; // short descending pluck

export type VoiceMix<Id extends string> = Partial<Record<Id, number>>;

export type KeysMix = VoiceMix<KeysVoiceId>;
export type PadMix = VoiceMix<PadVoiceId>;
export type BassMix = VoiceMix<BassVoiceId>;
export type SparkleMix = VoiceMix<SparkleVoiceId>;

export const KEYS_VOICE_IDS: readonly KeysVoiceId[] = [
  "rhodes",
  "felt",
  "vibes",
  "nylon",
  "celeste",
  "reed",
  "koto",
  "marimba"
];
export const PAD_VOICE_IDS: readonly PadVoiceId[] = [
  "drift",
  "bow",
  "choir",
  "organ",
  "glass",
  "breath"
];
export const BASS_VOICE_IDS: readonly BassVoiceId[] = ["sub", "upright", "round", "tape"];
export const SPARKLE_VOICE_IDS: readonly SparkleVoiceId[] = [
  "musicBox",
  "glassBell",
  "kalimba",
  "harp",
  "drop"
];

/* ----------------------------------------------------------------- shared */

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Dry + reverb send wiring every voice uses, so send depth stays consistent. */
export function voiceOutput(
  v: VoiceCtx,
  node: AudioNode,
  sendAmount: number,
  pan: number
): AudioNode {
  const { ctx } = v;
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  node.connect(panner);
  panner.connect(v.out);
  if (sendAmount > 0.001) {
    const send = ctx.createGain();
    send.gain.value = sendAmount;
    panner.connect(send).connect(v.rev);
  }
  return panner;
}

/** Exponential ramp helper that never touches zero (WebAudio throws on 0). */
export function ramp(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  release: number
): void {
  const safe = Math.max(0.0002, peak);
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(safe, t + Math.max(0.001, attack));
  param.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, release));
}
