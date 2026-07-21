// Lo-fi music director — a fully generative, client-side ambient score.
//
// Rides the shared AudioEngine "music" group (the HUD music slider + mute are
// applied by the engine group gain; nothing here reads a *AudioLevel() into its
// own gains). Four synthesized layers — soft e-piano chords, a slow pad, a sub
// bass and pentatonic sparkles — run through a tape-wow delay, a warmth
// lowpass and vinyl crackle, so the whole mix reads as a worn record rather
// than a synth demo.
//
// The brain is a slow chord walk (theory.ts) voiced with minimal motion.
// Region data (regions.ts) blends texture continuously as the listener moves;
// key/mode ownership switches with hysteresis and only at chord boundaries.
// Daylight bends everything: night stretches the harmonic rhythm, darkens the
// master lowpass, thins the sparkles and leans the mode minor. Layers run on
// unrelated clocks (chord duration jitter, Poisson-ish sparkles), so the score
// never audibly repeats.

import { tunables } from "../../core/persist";
import { musicAudioLevel } from "../../core/audioSettings";
import { audioEngine } from "../engine";
import type { MusicBufferResult } from "./musicBuffersWorker";
import {
  MODES,
  degreeChordPcs,
  leadVoices,
  midiToFreq,
  pentatonicPcs,
  pickNextDegree,
  type ModeName
} from "./theory";
import {
  CITY_MUSIC_PROFILE,
  MUSIC_REGIONS,
  blendMusic,
  musicRegionInfluence,
  quietZoneDuck,
  type MusicProfile
} from "./regions";

export const LOFI_MUSIC_TUNING = tunables("lofiMusic", {
  enabled: { v: true, label: "enabled" },
  master: { v: 0.85, min: 0, max: 1, step: 0.01, label: "master" },
  keys: { v: 0.9, min: 0, max: 1, step: 0.01, label: "e-piano" },
  pads: { v: 0.85, min: 0, max: 1, step: 0.01, label: "pads" },
  bass: { v: 0.8, min: 0, max: 1, step: 0.01, label: "bass" },
  sparkle: { v: 0.9, min: 0, max: 1, step: 0.01, label: "sparkle" },
  crackle: { v: 0.75, min: 0, max: 1, step: 0.01, label: "vinyl" },
  wobble: { v: 0.8, min: 0, max: 1, step: 0.01, label: "tape wow" },
  reverb: { v: 0.9, min: 0, max: 1, step: 0.01, label: "reverb" },
  pace: { v: 1, min: 0.4, max: 2, step: 0.05, label: "pace ×" }
});

const LOOKAHEAD = 1.6; // seconds of schedule horizon
const KEY_SWITCH_SECONDS = 5; // hysteresis before a region takes the key
const KEYS_LO = 50; // chord voicing register (MIDI)
const KEYS_HI = 74;

export type MusicFrameInput = {
  playerPos: { x: number; y: number; z: number };
  /** hours 0..24 (sky clock) */
  timeOfDay: number;
};

export class LofiMusicDirector {
  #ctx: AudioContext | null = null;
  #sum!: GainNode;
  #wow!: DelayNode;
  #wowLfoGain!: GainNode;
  #flutterLfoGain!: GainNode;
  #warm!: BiquadFilterNode;
  #out!: GainNode; // presence × master → engine music group
  #keysBus!: GainNode;
  #padBus!: GainNode;
  #padFilter!: BiquadFilterNode;
  #bassBus!: GainNode;
  #sparkleBus!: GainNode;
  #revSend!: GainNode;
  #convolver!: ConvolverNode;
  #crackleGain!: GainNode;
  #crackleSrc: AudioBufferSourceNode | null = null;
  #vinylBuffer: AudioBuffer | null = null;
  #bufferPreparation: Promise<void> | null = null;

  #holdRelease: (() => void) | null = null;
  #inf = new Float32Array(MUSIC_REGIONS.length);
  #presence = 0;
  #duck = 1;
  #daylight = 1;

  // musical state
  #prevVoices: number[] | null = null;
  #degree = 0;
  #keyOwnerId = "city";
  #keyCandidateId = "city";
  #keyCandidateT = 0;
  #keyRoot = CITY_MUSIC_PROFILE.root;
  #keyDayMode: ModeName = CITY_MUSIC_PROFILE.dayMode;
  #keyNightMode: ModeName = CITY_MUSIC_PROFILE.nightMode;
  #nextChordT = 0;
  #nextSparkleT = 0;
  #texture: MusicProfile = { ...CITY_MUSIC_PROFILE };
  // debug
  #chordCount = 0;
  #sparkleCount = 0;
  #lastChord = "-";

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      presence: +this.#presence.toFixed(3),
      duck: +this.#duck.toFixed(3),
      daylight: +this.#daylight.toFixed(3),
      keyOwner: this.#keyOwnerId,
      keyRoot: this.#keyRoot,
      degree: this.#degree,
      chordCount: this.#chordCount,
      sparkleCount: this.#sparkleCount,
      lastChord: this.#lastChord,
      vinylReady: Boolean(this.#vinylBuffer),
      influence: MUSIC_REGIONS.map((r, i) => ({ id: r.id, inf: +this.#inf[i].toFixed(3) })),
      nextChordIn: this.#ctx ? +(this.#nextChordT - this.#ctx.currentTime).toFixed(2) : 0
    };
  }

  update(dt: number, o: MusicFrameInput): void {
    const T = LOFI_MUSIC_TUNING.values;
    // The HUD music level is an ACTIVITY gate here (don't keep the shared ctx
    // alive for an inaudible score) — never a gain term; the engine group owns
    // loudness (invariant: no double attenuation).
    const enabled = Boolean(T.enabled) && Number(T.master) > 0.001 && musicAudioLevel() > 0.001;

    const { x, z } = o.playerPos;
    for (let i = 0; i < MUSIC_REGIONS.length; i++) {
      this.#inf[i] = musicRegionInfluence(MUSIC_REGIONS[i], x, z);
    }
    this.#duck = quietZoneDuck(x, z);
    this.#daylight = daylight(o.timeOfDay);

    const wantPlaying = enabled && this.#duck > 0.003;
    if (!this.#ctx && wantPlaying && audioEngine.unlocked) this.#ensure();
    const ctx = this.#ctx;
    if (!ctx) return;

    // persistent engine hold while the score is (or is fading) audible
    const wantHold = wantPlaying || this.#presence > 0.01;
    if (wantHold && !this.#holdRelease) this.#holdRelease = audioEngine.acquireHold();
    else if (!wantHold && this.#holdRelease) {
      this.#holdRelease();
      this.#holdRelease = null;
    }

    const targetPresence = wantPlaying ? this.#duck : 0;
    // fades are musical: ease in gently, bow out a little faster near performers
    this.#presence = approach(this.#presence, targetPresence, dt, targetPresence > this.#presence ? 0.4 : 0.9);

    if (ctx.state !== "running") return;
    const now = ctx.currentTime;

    const blended = blendMusic(this.#inf);
    this.#texture = blended.profile;
    this.#updateKeyOwnership(dt, blended.dominant?.id ?? "city");
    this.#applyTexture(now);

    this.#out.gain.setTargetAtTime(Number(T.master) * this.#presence * 0.9, now, 0.2);

    if (!wantPlaying || this.#presence < 0.012) return; // silent — let tails ring, schedule nothing

    // stale clocks after a quiet spell (or first start) resume near "now"
    if (this.#nextChordT < now - 0.25) this.#nextChordT = now + 0.35;
    if (this.#nextSparkleT < now - 0.25) this.#nextSparkleT = now + 2.5;

    while (this.#nextChordT < now + LOOKAHEAD) this.#scheduleChord();
    while (this.#nextSparkleT < now + LOOKAHEAD) this.#scheduleSparkle();
  }

  dispose(): void {
    try {
      this.#crackleSrc?.stop();
    } catch {
      /* already stopped */
    }
    this.#crackleSrc = null;
    this.#out?.disconnect();
    this.#holdRelease?.();
    this.#holdRelease = null;
    this.#ctx = null;
  }

  /* ------------------------------------------------------------- graph */

  #ensure(): void {
    const bus = audioEngine.bus("music", 2);
    if (!bus) return;
    const ctx = bus.ctx;
    this.#ctx = ctx;

    this.#out = ctx.createGain();
    this.#out.gain.value = 0;
    this.#out.connect(bus.input);

    // gentle glue so layered tails never pump the group
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 18;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.02;
    comp.release.value = 0.4;
    comp.connect(this.#out);

    // master tone — the "worn cassette" lowpass; daylight opens it
    this.#warm = ctx.createBiquadFilter();
    this.#warm.type = "lowpass";
    this.#warm.frequency.value = 5200;
    this.#warm.Q.value = 0.3;
    this.#warm.connect(comp);

    // tape wow: everything musical passes through one modulated delay
    this.#wow = ctx.createDelay(0.08);
    this.#wow.delayTime.value = 0.03;
    this.#wow.connect(this.#warm);
    const wowLfo = ctx.createOscillator();
    wowLfo.frequency.value = 0.37;
    this.#wowLfoGain = ctx.createGain();
    this.#wowLfoGain.gain.value = 0.0022;
    wowLfo.connect(this.#wowLfoGain).connect(this.#wow.delayTime);
    wowLfo.start();
    const flutter = ctx.createOscillator();
    flutter.frequency.value = 5.6;
    this.#flutterLfoGain = ctx.createGain();
    this.#flutterLfoGain.gain.value = 0.00013;
    flutter.connect(this.#flutterLfoGain).connect(this.#wow.delayTime);
    flutter.start();

    this.#sum = ctx.createGain();
    this.#sum.gain.value = 1;
    this.#sum.connect(this.#wow);

    // layer buses
    this.#keysBus = ctx.createGain();
    this.#keysBus.connect(this.#sum);
    this.#padBus = ctx.createGain();
    this.#padFilter = ctx.createBiquadFilter();
    this.#padFilter.type = "lowpass";
    this.#padFilter.frequency.value = 1150;
    this.#padFilter.Q.value = 0.2;
    this.#padBus.connect(this.#padFilter).connect(this.#sum);
    this.#bassBus = ctx.createGain();
    this.#bassBus.connect(this.#sum);
    this.#sparkleBus = ctx.createGain();
    this.#sparkleBus.connect(this.#sum);

    // one shared reverb; per-layer sends are baked into voice send gains
    this.#convolver = ctx.createConvolver();
    const revReturn = ctx.createGain();
    revReturn.gain.value = 0.85;
    this.#revSend = ctx.createGain();
    this.#revSend.gain.value = 0.5;
    this.#revSend.connect(this.#convolver).connect(revReturn).connect(this.#sum);

    // vinyl crackle skips the wow (the "record surface" sits atop the music)
    this.#crackleGain = ctx.createGain();
    this.#crackleGain.gain.value = 0;
    this.#crackleGain.connect(this.#warm);

    void this.#prepareBuffers(ctx);
  }

  #prepareBuffers(ctx: AudioContext): Promise<void> {
    if (this.#bufferPreparation) return this.#bufferPreparation;
    const task = new Promise<MusicBufferResult>((resolve, reject) => {
      const worker = new Worker(new URL("./musicBuffersWorker.ts", import.meta.url), {
        type: "module"
      });
      const finish = () => worker.terminate();
      worker.onmessage = (event: MessageEvent<MusicBufferResult>) => {
        finish();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message || "music buffer worker failed"));
      };
      worker.postMessage({ sampleRate: ctx.sampleRate });
    })
      .then((result) => {
        if (this.#ctx !== ctx || ctx.state === "closed") return;
        const toBuffer = (channels: readonly ArrayBuffer[]): AudioBuffer => {
          const length = channels[0].byteLength / Float32Array.BYTES_PER_ELEMENT;
          const buffer = ctx.createBuffer(channels.length, Math.max(1, length), ctx.sampleRate);
          channels.forEach((channel, index) => {
            buffer.copyToChannel(new Float32Array(channel) as Float32Array<ArrayBuffer>, index);
          });
          return buffer;
        };
        this.#convolver.buffer = toBuffer([result.impulseLeft, result.impulseRight]);
        this.#vinylBuffer = toBuffer([result.vinyl]);
        this.#startCrackle();
      })
      .catch((error) => {
        // dry music still plays; only the record surface + reverb stay silent
        console.warn("[lofi-music] procedural buffers unavailable:", error);
        this.#bufferPreparation = null;
      });
    this.#bufferPreparation = task;
    return task;
  }

  #startCrackle(): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#vinylBuffer || this.#crackleSrc) return;
    const src = ctx.createBufferSource();
    src.buffer = this.#vinylBuffer;
    src.loop = true;
    src.connect(this.#crackleGain);
    src.start(0, Math.random() * this.#vinylBuffer.duration);
    this.#crackleSrc = src;
  }

  /* --------------------------------------------------- per-frame texture */

  #updateKeyOwnership(dt: number, candidate: string): void {
    if (candidate === this.#keyOwnerId) {
      this.#keyCandidateT = 0;
      return;
    }
    if (candidate !== this.#keyCandidateId) {
      this.#keyCandidateId = candidate;
      this.#keyCandidateT = 0;
    }
    this.#keyCandidateT += dt;
    if (this.#keyCandidateT < KEY_SWITCH_SECONDS) return;
    this.#keyOwnerId = candidate;
    this.#keyCandidateT = 0;
    const owner =
      MUSIC_REGIONS.find((r) => r.id === candidate)?.profile ?? CITY_MUSIC_PROFILE;
    // committed here, sounded at the next chord boundary — voice-leading walks
    // the old voicing into the new key, so there is never a hard modulation
    this.#keyRoot = owner.root;
    this.#keyDayMode = owner.dayMode;
    this.#keyNightMode = owner.nightMode;
  }

  #applyTexture(now: number): void {
    const T = LOFI_MUSIC_TUNING.values;
    const p = this.#texture;
    const day = this.#daylight;
    const warmHz = (3200 + (1 - p.warmth) * 5200) * (0.62 + 0.38 * day);
    this.#warm.frequency.setTargetAtTime(warmHz, now, 1.2);
    this.#wowLfoGain.gain.setTargetAtTime(0.0022 * Number(T.wobble), now, 1);
    this.#flutterLfoGain.gain.setTargetAtTime(0.00013 * Number(T.wobble), now, 1);
    // the record surface leans in as night settles — cozier, closer
    this.#crackleGain.gain.setTargetAtTime(
      p.crackle * Number(T.crackle) * (0.72 + 0.28 * (1 - day)),
      now,
      1.5
    );
    this.#keysBus.gain.setTargetAtTime(p.epiano * Number(T.keys) * 0.95, now, 1.5);
    this.#padBus.gain.setTargetAtTime(p.pad * Number(T.pads), now, 1.5);
    this.#bassBus.gain.setTargetAtTime(p.bass * Number(T.bass), now, 1.5);
    this.#sparkleBus.gain.setTargetAtTime(Number(T.sparkle) * 0.9, now, 1.5);
    this.#revSend.gain.setTargetAtTime(p.reverb * Number(T.reverb), now, 1.5);
  }

  /* ------------------------------------------------------------ composer */

  #scheduleChord(): void {
    if (!this.#ctx) return;
    const t = this.#nextChordT;
    const p = this.#texture;
    const day = this.#daylight;
    const rng = Math.random;

    // dawn/dusk are a probability crossfade, so the two modes interleave
    const mode = rng() < day ? this.#keyDayMode : this.#keyNightMode;
    this.#degree = pickNextDegree(this.#degree, rng);
    const size = rng() < 0.35 ? 5 : 4;
    const pcs = degreeChordPcs(this.#keyRoot, MODES[mode], this.#degree, size);
    const midis = leadVoices(this.#prevVoices, pcs, KEYS_LO, KEYS_HI);
    this.#prevVoices = midis;

    const pace = Math.max(0.2, Number(LOFI_MUSIC_TUNING.values.pace));
    const dur =
      (p.chordSeconds / pace) * (1 + 0.5 * (1 - day)) * (0.9 + rng() * 0.25);

    // rolled keys — a lazy upward strum, every voice its own touch
    let offset = 0.02 + rng() * 0.05;
    for (const midi of midis) {
      this.#epianoNote(t + offset, midi, 0.14 + rng() * 0.08, dur);
      offset += 0.055 + rng() * 0.1;
    }
    // occasional half-time echo of the top of the chord, quieter
    if (rng() < 0.4 && midis.length >= 2) {
      const echoT = t + dur * (0.45 + rng() * 0.15);
      for (const midi of midis.slice(-2)) {
        this.#epianoNote(echoT + rng() * 0.12, midi, 0.07 + rng() * 0.04, dur * 0.5);
      }
    }

    // pad + bass under the chord root
    const bassMidi = 36 + pcs[0];
    this.#padChord(t, [bassMidi + 12, bassMidi + 19], dur);
    this.#bassNote(t + 0.1, bassMidi, dur);

    this.#nextChordT = t + dur;
    this.#chordCount++;
    this.#lastChord = `${PC_NAMES[pcs[0]]}${mode === this.#keyDayMode ? "" : "m"}·deg${this.#degree + 1}`;
  }

  #scheduleSparkle(): void {
    if (!this.#ctx) return;
    const t = this.#nextSparkleT;
    const p = this.#texture;
    const day = this.#daylight;
    const rng = Math.random;

    const mode = rng() < day ? this.#keyDayMode : this.#keyNightMode;
    const penta = pentatonicPcs(this.#keyRoot, MODES[mode]);
    const pc = penta[Math.floor(rng() * penta.length)];
    const midi = 79 + ((pc - 79 + 1200) % 12) + (rng() < 0.4 ? 12 : 0);
    this.#sparkleNote(t, midi, 0.09 + rng() * 0.08);
    // little two-note motif now and then — a thought completing itself
    if (rng() < 0.4) {
      const idx = penta.indexOf(pc);
      const next = penta[(idx + (rng() < 0.5 ? 1 : 4)) % penta.length];
      this.#sparkleNote(t + 0.28 + rng() * 0.3, 79 + ((next - 79 + 1200) % 12), 0.06 + rng() * 0.05);
      this.#sparkleCount++;
    }
    this.#sparkleCount++;

    const base = 20 - p.sparkle * 15; // dense regions ping every ~5s, sparse ~20s
    const nightStretch = 1 + (1 - day) * 0.8;
    this.#nextSparkleT = t + base * nightStretch * (0.45 + rng() * 1.1);
  }

  /* -------------------------------------------------------------- voices */

  /** Rhodes-flavoured note: sine body, soft octave partial, fast "tine" ping. */
  #epianoNote(t: number, midi: number, vel: number, dur: number): void {
    const ctx = this.#ctx!;
    const f = midiToFreq(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.min(8500, f * 5.5);
    filter.Q.value = 0.4;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.4;
    filter.connect(pan).connect(this.#keysBus);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    pan.connect(send).connect(this.#revSend);

    const stopAt = t + Math.min(dur, 8) + 4;
    const partial = (freq: number, level: number, decay: number, sustain = 0) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.012);
      if (sustain > 0) {
        g.gain.setTargetAtTime(level * sustain, t + 0.02, 1.1);
        g.gain.setTargetAtTime(0.0001, t + Math.min(dur, 8), 0.9);
      } else {
        g.gain.setTargetAtTime(0.0001, t + 0.02, decay);
      }
      osc.connect(g).connect(filter);
      osc.start(t);
      osc.stop(stopAt);
    };
    partial(f, vel, 0, 0.25); // body rings and releases with the chord
    partial(f * 2.001, vel * 0.18, 0.45); // soft octave bloom
    partial(f * 3.98, vel * 0.13, 0.09); // tine attack
  }

  /** Two detuned sines per pitch, breathing in over ~3 s. */
  #padChord(t: number, midis: number[], dur: number): void {
    const ctx = this.#ctx!;
    for (const midi of midis) {
      const f = midiToFreq(midi);
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = f;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.11, t + 2.8);
        g.gain.setTargetAtTime(0.0001, t + dur, 1.6);
        osc.connect(g).connect(this.#padBus);
        const send = ctx.createGain();
        send.gain.value = 0.5;
        g.connect(send).connect(this.#revSend);
        osc.start(t);
        osc.stop(t + dur + 7);
      }
    }
  }

  #bassNote(t: number, midi: number, dur: number): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.value = midiToFreq(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.26, t + 1.2);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.85, 1.2);
    osc.connect(g).connect(this.#bassBus);
    osc.start(t);
    osc.stop(t + dur + 5);
  }

  /** High pentatonic ping with a heavy reverb send — the "music box" layer. */
  #sparkleNote(t: number, midi: number, vel: number): void {
    const ctx = this.#ctx!;
    const f = midiToFreq(midi);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.7;
    pan.connect(this.#sparkleBus);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    pan.connect(send).connect(this.#revSend);

    const mk = (freq: number, level: number, decay: number) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.008);
      g.gain.setTargetAtTime(0.0001, t + 0.015, decay);
      osc.connect(g).connect(pan);
      osc.start(t);
      osc.stop(t + 4);
    };
    mk(f, vel, 1.1);
    mk(f * 3.98, vel * 0.2, 0.07);
  }
}

/* --------------------------------------------------------------- helpers */

const PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

function approach(cur: number, target: number, dt: number, rate: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt * rate));
}

/** 0..1 daylight, matching the nature soundscape's dawn/dusk windows. */
function daylight(h: number): number {
  const up = smooth(5.2, 7.2, h);
  const down = 1 - smooth(18.5, 20.5, h);
  return up * down;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
