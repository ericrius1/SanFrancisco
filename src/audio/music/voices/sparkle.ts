// The sparkle family — the single high tones that land above the chord every
// few seconds. They are the most exposed thing in the score: one of these is
// often the only note sounding, so each has to be worth the silence around it.
//
// `musicBox` is the director's original ping, ported whole. The rest trade its
// hard tine attack for something else: `glassBell` for length and beating,
// `kalimba` for wood, `harp` for no attack at all, `drop` for motion.

import {
  midiToFreq,
  ramp,
  voiceOutput,
  type SparkleVoiceId,
  type Voice,
  type VoiceCtx
} from "../voiceTypes";

// Short bed — the only sparkle voice that needs noise is kalimba's box knock.
const NOISE_SECONDS = 0.6;
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** One noise bed per context; a fresh buffer per ping would be pure churn. */
function noiseBed(v: VoiceCtx): AudioBuffer {
  const cached = noiseCache.get(v.ctx);
  if (cached) return cached;
  const len = Math.floor(v.ctx.sampleRate * NOISE_SECONDS);
  const buf = v.ctx.createBuffer(1, len, v.ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = v.rng() * 2 - 1;
  noiseCache.set(v.ctx, buf);
  return buf;
}

function burst(v: VoiceCtx, dest: AudioNode, t: number, dur: number): void {
  const src = v.ctx.createBufferSource();
  const bed = noiseBed(v);
  src.buffer = bed;
  src.connect(dest);
  const from = v.rng() * Math.max(0, bed.duration - dur - 0.02);
  src.start(t, from, dur);
  src.stop(t + dur + 0.05);
}

/* ------------------------------------------------------------------ voices */

/** High pentatonic ping with a heavy reverb send — the "music box" layer. */
const musicBox: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);

  const bus = ctx.createGain();
  voiceOutput(v, bus, 0.9, (v.rng() * 2 - 1) * 0.7);

  const stopAt = t + 4;
  const mk = (freq: number, level: number, decay: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.008);
    g.gain.setTargetAtTime(0.0001, t + 0.015, decay);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(stopAt);
  };
  // Daylight tightens the comb and hardens the tine; 3am lets it hang.
  mk(f, n.vel, 1.25 - n.bright * 0.3);
  mk(f * 3.98, n.vel * (0.17 + n.bright * 0.07), 0.07);
};

/** Two near-identical partials so the note beats against itself as it rings. */
const glassBell: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const ring = 2.6 - n.bright * 0.7;
  const stopAt = t + ring * 4 + 0.5;
  const peak = n.vel * 0.85; // long and pure carries much further than a ping

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(13000, f * (6 + n.bright * 5));
  tone.Q.value = 0.3;
  // Widest pan in the score, wettest send — this one is supposed to be a room.
  voiceOutput(v, tone, 0.95, (v.rng() * 2 - 1) * 0.85);

  // A couple of cents apart puts the beat around 1 Hz up here: slow enough to
  // read as breathing rather than as chorus.
  const spread = 0.8 + v.rng() * 1.2;
  for (const cents of [-spread, spread]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    osc.detune.value = cents;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.5), t + 0.016);
    g.gain.setTargetAtTime(0.0001, t + 0.025, ring);
    osc.connect(g).connect(tone);
    osc.start(t);
    osc.stop(stopAt);
  }

  // Just enough inharmonic glass to say "struck", not enough to say "bell".
  const glass = ctx.createOscillator();
  glass.frequency.value = f * 2.76;
  const glassGain = ctx.createGain();
  glassGain.gain.setValueAtTime(0.0001, t);
  glassGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.09), t + 0.012);
  glassGain.gain.setTargetAtTime(0.0001, t + 0.02, 0.45);
  glass.connect(glassGain).connect(tone);
  glass.start(t);
  glass.stop(t + 2.5);

  const ting = ctx.createOscillator();
  ting.frequency.value = f * 5.4;
  const tingGain = ctx.createGain();
  ramp(tingGain.gain, t, peak * (0.04 + n.bright * 0.03), 0.002, 0.03);
  ting.connect(tingGain).connect(tone);
  ting.start(t);
  ting.stop(t + 0.08);
};

/** A metal tine over a wooden box — the only sparkle voice with a body. */
const kalimba: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const ring = 0.85 - n.bright * 0.22;
  const stopAt = t + ring * 2.4 + 0.25;
  const peak = n.vel * 0.9;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(9500, f * (5 + n.bright * 3.5));
  tone.Q.value = 0.4;
  voiceOutput(v, tone, 0.45, (v.rng() * 2 - 1) * 0.5);

  const body = ctx.createOscillator();
  body.frequency.value = f;
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, t);
  bodyGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.005);
  bodyGain.gain.setTargetAtTime(0.0001, t + 0.01, ring / 3.5);
  body.connect(bodyGain).connect(tone);
  body.start(t);
  body.stop(stopAt);

  // A free steel tine is stiff and badly inharmonic — that ringing edge on the
  // attack is the whole reason to reach for this instrument.
  const tine = (mult: number, level: number, decay: number, until: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    const g = ctx.createGain();
    ramp(g.gain, t, peak * level, 0.002, decay);
    osc.connect(g).connect(tone);
    osc.start(t);
    osc.stop(t + until);
  };
  tine(4.62, 0.3 + n.bright * 0.08, 0.09, 0.14);
  tine(7.3, 0.11, 0.035, 0.07);

  // The thumb landing back on the soundboard.
  const box = ctx.createBiquadFilter();
  box.type = "lowpass";
  box.frequency.value = 240 + n.bright * 120;
  const boxGain = ctx.createGain();
  ramp(boxGain.gain, t, n.vel * 0.3, 0.001, 0.03);
  box.connect(boxGain).connect(tone);
  burst(v, box, t, 0.04);
};

/** No transient at all. This is the one that should read as light, not as a note. */
const harp: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  // Night fades in slower and hangs longer; noon arrives sooner and lets go.
  const attack = 0.03 + v.rng() * 0.025 + (1 - n.bright) * 0.02;
  const fall = 3.2 - n.bright * 0.9;
  const stopAt = t + fall + 0.6;
  const peak = n.vel * 0.9;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(10000, f * (4 + n.bright * 3));
  tone.Q.value = 0.3;
  voiceOutput(v, tone, 0.85, (v.rng() * 2 - 1) * 0.6);

  const swell = (mult: number, level: number, rise: number, tau: number, detune: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    osc.detune.value = detune;
    const g = ctx.createGain();
    // Exponential up to a third, linear the rest of the way: an exponential all
    // the way still has a corner at the top, and a corner is an attack.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.34), t + rise * 0.55);
    g.gain.linearRampToValueAtTime(level, t + rise);
    g.gain.setTargetAtTime(0.0001, t + rise + 0.002, tau);
    osc.connect(g).connect(tone);
    osc.start(t);
    osc.stop(stopAt);
  };
  swell(1, peak, attack, fall / 4, 0);
  swell(2, peak * 0.12, attack * 1.6, fall / 7, 3); // a touch of shine, arriving later
};

/** A pluck that falls out from under itself. The playful one. */
const drop: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  // Night drops further and lands slower — the same gesture, sighing.
  const semis = 2 + v.rng() * 0.7 + (1 - n.bright) * 0.35;
  const glide = 0.11 + (1 - n.bright) * 0.04;
  const end = Math.pow(2, -semis / 12);
  const decay = 0.24 - n.bright * 0.05;
  const stopAt = t + 1;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(9000, f * (4 + n.bright * 3));
  tone.Q.value = 0.5;
  voiceOutput(v, tone, 0.55, (v.rng() * 2 - 1) * 0.6);

  const fall = (mult: number, level: number, tau: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f * mult, t);
    osc.frequency.exponentialRampToValueAtTime(f * mult * end, t + glide);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.004);
    g.gain.setTargetAtTime(0.0001, t + 0.008, tau);
    osc.connect(g).connect(tone);
    osc.start(t);
    osc.stop(stopAt);
  };
  fall(1, n.vel, decay);
  // The octave slides with it, so the gesture stays one sound rather than two.
  fall(2.002, n.vel * 0.22, 0.04);
};

export const SPARKLE_VOICES: Record<SparkleVoiceId, Voice> = {
  musicBox,
  glassBell,
  kalimba,
  harp,
  drop
};
