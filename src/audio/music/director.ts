// Music director — a fully generative, client-side score for the whole city.
//
// Rides the shared AudioEngine "music" group (the HUD music slider + mute are
// applied by the engine group gain; nothing here reads a *AudioLevel() into its
// own gains).
//
// The brain is a slow chord walk (theory.ts) voiced with minimal motion, and
// the ears are a per-region instrument palette (voices/). Region data
// (regions.ts) blends texture AND timbre continuously as the listener moves, so
// crossing from the Mission into the Castro hears nylon guitar hand over to
// felt piano instead of a switch flipping. Key/mode/voicing/kit ownership moves
// with hysteresis and only at chord boundaries, and the new owner announces
// itself with a short arrival figure — a place saying its own name.
//
// Daylight bends everything: night stretches the harmonic rhythm, darkens the
// master lowpass, thins the sparkles and leans the mode minor. Layers run on
// unrelated clocks (chord duration jitter, Poisson-ish sparkles, an independent
// section arrangement), so the score never audibly repeats.

import { musicAudioLevel } from "../../core/audioSettings";
import { audioEngine } from "../engine";
import type { MusicBufferResult } from "./musicBuffersWorker";
import {
  MODES,
  arrivalFigure,
  bassLine,
  buildVoicing,
  gapForSpread,
  leadVoices,
  pentatonicPcs,
  pickCadence,
  pickNextDegree,
  type ModeName,
  type VoicingStyle
} from "./theory";
import {
  CITY_MUSIC_PROFILE,
  MUSIC_REGIONS,
  blendMusic,
  musicRegionInfluence,
  quietZoneDuck,
  type MusicProfile
} from "./regions";
import { StemPlayer } from "./stems";
import { GroovePlayer, type GrooveKitId } from "./groove";
import { PhrasePlayer } from "./phrases";
import { PHRASE_DEFS, PHRASE_REF_ROOT, type PhraseDef } from "./phraseManifest";
import {
  bassVoice,
  keysVoice,
  padVoice,
  pickBassVoice,
  pickKeysVoice,
  pickPadVoice,
  pickSparkleVoice,
  sparkleVoice
} from "./voices";
import type { VoiceCtx } from "./voiceTypes";
import { LOFI_MUSIC_TUNING } from "./tuning";

export { LOFI_MUSIC_TUNING };

const LOOKAHEAD = 1.6; // seconds of schedule horizon
const KEY_SWITCH_SECONDS = 5; // hysteresis before a region takes the key
const KEYS_LO = 50; // chord voicing register (MIDI)
const KEYS_HI = 74;

// ---- arrangement sections -------------------------------------------------
// The cure for statistical flatness: a slow arrangement brain. Each section
// holds for 30–90 s and scales the layers, so the score breathes through
// keys-forward passages, beatless pad drifts, groove-led stretches and short
// near-silent "breaths" instead of playing everything all the time.
type SectionId = "full" | "keysOnly" | "padDrift" | "beatFocus" | "breath";
type SectionMul = {
  keys: number;
  pad: number;
  bass: number;
  groove: number;
  sparkle: number;
  phrases: number;
  dust: number;
};
const SECTIONS: Record<SectionId, SectionMul & { minS: number; maxS: number }> = {
  full: { keys: 1, pad: 1, bass: 1, groove: 1, sparkle: 1, phrases: 1, dust: 1, minS: 45, maxS: 90 },
  keysOnly: { keys: 1.1, pad: 0.45, bass: 0.7, groove: 0.1, sparkle: 0.9, phrases: 1.2, dust: 1, minS: 35, maxS: 70 },
  padDrift: { keys: 0.15, pad: 1.2, bass: 0.5, groove: 0, sparkle: 0.7, phrases: 0.8, dust: 1.2, minS: 40, maxS: 80 },
  beatFocus: { keys: 0.5, pad: 0.6, bass: 1.15, groove: 1.25, sparkle: 0.5, phrases: 0.7, dust: 0.9, minS: 35, maxS: 70 },
  breath: { keys: 0.06, pad: 0.3, bass: 0, groove: 0, sparkle: 0.35, phrases: 0, dust: 1.3, minS: 10, maxS: 22 }
};
const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

// City key wanders slowly through friendly roots (D→A→G→C…) so hours in the
// city never sit in one tonal center. Region keys stay fixed.
const CITY_ROOTS = [2, 9, 7, 0]; // D A G C

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
  #revPre!: DelayNode; // pre-delay — the single strongest cue for room SIZE
  #revTone!: BiquadFilterNode; // tail damping — stone is bright, wood is dark
  #convolver!: ConvolverNode;
  #crackleGain!: GainNode;
  #crackleSrc: AudioBufferSourceNode | null = null;
  #keysCtx!: VoiceCtx;
  #padCtx!: VoiceCtx;
  #bassCtx!: VoiceCtx;
  #sparkleCtx!: VoiceCtx;
  #stemPlayer: StemPlayer | null = null;
  #groove: GroovePlayer | null = null;
  #phrasePlayer: PhrasePlayer | null = null;
  #nextPhraseT = -1;
  #phrasePending = false;
  #lastPhraseId = "-";
  // arrangement state
  #sectionId: SectionId = "full";
  #prevSectionId: SectionId = "full";
  #sectionT = 55;
  #sectionMul: SectionMul = { ...SECTIONS.full };
  #register = 0; // slow voicing-window wander, semitones
  #cityRoot = CITY_MUSIC_PROFILE.root;
  #cityKeyT = 300;
  #vinylBuffer: AudioBuffer | null = null;
  #bufferPreparation: Promise<void> | null = null;

  #holdRelease: (() => void) | null = null;
  #inf = new Float32Array(MUSIC_REGIONS.length);
  #blendT = 0;
  #dominantId = "city";
  #presence = 0;
  #duck = 1;
  #daylight = 1;

  // musical state
  #prevVoices: number[] | null = null;
  #degree = 0;
  #nextDegree = -1; // picked a chord early so the bass can approach it
  #cadenceQueue: number[] = [];
  #lastCadence = "-";
  #sinceCadence = 0;
  #keyOwnerId = "city";
  #keyCandidateId = "city";
  #keyCandidateT = 0;
  #keyRoot = CITY_MUSIC_PROFILE.root;
  #keyDayMode: ModeName = CITY_MUSIC_PROFILE.dayMode;
  #keyNightMode: ModeName = CITY_MUSIC_PROFILE.nightMode;
  #voicing: VoicingStyle = CITY_MUSIC_PROFILE.voicing;
  #kit: GrooveKitId = CITY_MUSIC_PROFILE.kit;
  #arrivalPending = false;
  #nextChordT = 0;
  #nextSparkleT = 0;
  #lastBassMidi: number | null = null;
  #texture: MusicProfile = { ...CITY_MUSIC_PROFILE };
  // debug
  #chordCount = 0;
  #sparkleCount = 0;
  #adventurePulseCount = 0;
  #arrivalCount = 0;
  #lastChord = "-";
  #lastKeysVoice = "-";
  #lastPadVoice = "-";
  #lastBassVoice = "-";

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      presence: +this.#presence.toFixed(3),
      duck: +this.#duck.toFixed(3),
      daylight: +this.#daylight.toFixed(3),
      keyOwner: this.#keyOwnerId,
      keyRoot: this.#keyRoot,
      cityRoot: this.#cityRoot,
      voicing: this.#voicing,
      kit: this.#kit,
      section: this.#sectionId,
      sectionIn: +this.#sectionT.toFixed(1),
      register: this.#register,
      degree: this.#degree,
      cadence: this.#lastCadence,
      cadenceQueued: this.#cadenceQueue.length,
      chordCount: this.#chordCount,
      sparkleCount: this.#sparkleCount,
      adventurePulseCount: this.#adventurePulseCount,
      arrivalCount: this.#arrivalCount,
      dayAdventure: +this.#cheer.toFixed(3),
      lastChord: this.#lastChord,
      keysVoice: this.#lastKeysVoice,
      padVoice: this.#lastPadVoice,
      bassVoice: this.#lastBassVoice,
      vinylReady: Boolean(this.#vinylBuffer),
      stems: this.#stemPlayer?.debugState ?? [],
      groove: this.#groove?.debugState ?? null,
      phrases: this.#phrasePlayer?.debugState ?? null,
      phrasePending: this.#phrasePending,
      nextPhraseIn: this.#ctx ? +(this.#nextPhraseT - this.#ctx.currentTime).toFixed(2) : 0,
      influence: MUSIC_REGIONS.map((r, i) => ({ id: r.id, inf: +this.#inf[i].toFixed(3) })),
      nextChordIn: this.#ctx ? +(this.#nextChordT - this.#ctx.currentTime).toFixed(2) : 0
    };
  }

  /** Daylight-scaled cheer bias — exactly 0 at night, so every formula that
   *  multiplies by it reduces to the untouched night behavior. */
  get #cheer(): number {
    const v = Number(LOFI_MUSIC_TUNING.values.dayCheer);
    return this.#daylight * Math.min(1.5, Math.max(0, v));
  }

  update(dt: number, o: MusicFrameInput): void {
    const T = LOFI_MUSIC_TUNING.values;
    // The HUD music level is an ACTIVITY gate here (don't keep the shared ctx
    // alive for an inaudible score) — never a gain term; the engine group owns
    // loudness (invariant: no double attenuation).
    const enabled = Boolean(T.enabled) && Number(T.master) > 0.001 && musicAudioLevel() > 0.001;

    const { x, z } = o.playerPos;
    // Influence + blend at 10 Hz, not per frame: the map has dozens of regions,
    // the listener moves at walking speed, and every texture value this feeds
    // lands on a setTargetAtTime with a 1.2–2 s constant. Per-frame blending was
    // pure garbage on the hot path for a result nobody could hear.
    this.#blendT -= dt;
    if (this.#blendT <= 0) {
      this.#blendT = 0.1;
      for (let i = 0; i < MUSIC_REGIONS.length; i++) {
        this.#inf[i] = musicRegionInfluence(MUSIC_REGIONS[i], x, z);
      }
      const blended = blendMusic(this.#inf);
      this.#texture = blended.profile;
      this.#dominantId = blended.dominant?.id ?? "city";
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

    this.#updateKeyOwnership(dt, this.#dominantId);
    this.#applyTexture(now);

    this.#out.gain.setTargetAtTime(Number(T.master) * this.#presence * 0.9, now, 0.2);

    if (!wantPlaying || this.#presence < 0.012) {
      // silent — let tails ring, schedule nothing; beds fade out and park
      this.#stemPlayer?.muteAll();
      this.#stemPlayer?.update(dt, now);
      this.#groove?.update(dt, now, {
        kit: this.#kit,
        gain: 0,
        bpm: this.#texture.bpm,
        swing: this.#texture.swing,
        density: 0,
        bright: this.#daylight
      });
      return;
    }

    // arrangement: advance the section clock and ease layer multipliers
    this.#sectionT -= dt;
    if (this.#sectionT <= 0) this.#pickSection();
    const sectionTarget = SECTIONS[this.#sectionId];
    for (const k of Object.keys(this.#sectionMul) as (keyof SectionMul)[]) {
      this.#sectionMul[k] = approach(this.#sectionMul[k], sectionTarget[k], dt, 0.35);
    }
    // the city's tonal center wanders every few minutes; regions keep theirs
    this.#cityKeyT -= dt;
    if (this.#cityKeyT <= 0) {
      const pool = CITY_ROOTS.filter((r) => r !== this.#cityRoot);
      this.#cityRoot = pool[Math.floor(Math.random() * pool.length)];
      this.#cityKeyT = 240 + Math.random() * 180;
      if (this.#keyOwnerId === "city") this.#keyRoot = this.#cityRoot; // next chord modulates
    }

    // stale clocks after a quiet spell (or first start) resume near "now"
    if (this.#nextChordT < now - 0.25) this.#nextChordT = now + 0.35;
    if (this.#nextSparkleT < now - 0.25) this.#nextSparkleT = now + 2.5;
    // first melodic phrase lands once the bed has established itself
    if (this.#nextPhraseT < now - 0.25) this.#nextPhraseT = now + 11 + Math.random() * 6;
    if (now >= this.#nextPhraseT) this.#phrasePending = true;

    this.#sinceCadence += dt;
    while (this.#nextChordT < now + LOOKAHEAD) this.#scheduleChord();
    while (this.#nextSparkleT < now + LOOKAHEAD) this.#scheduleSparkle();
    this.#phrasePlayer?.update(dt);

    // procedural percussion: the region names the kit and the tempo, the
    // section's groove multiplier lets the beat leave entirely
    if (this.#groove) {
      const p = this.#texture;
      const day = this.#daylight;
      // night thins the kit rather than swapping it — the half-time character
      // now lives in the pattern, not in a separate baked loop
      const nightThin = 0.55 + 0.45 * day;
      this.#groove.update(dt, now, {
        kit: this.#kit,
        gain: p.groove * Number(T.beats) * this.#sectionMul.groove * nightThin,
        bpm: p.bpm,
        swing: p.swing,
        density: Math.min(1, (0.45 + 0.55 * day) * (1 + 0.35 * Math.min(this.#cheer, 1))),
        bright: day
      });
    }

    if (this.#stemPlayer) {
      const p = this.#texture;
      const dayClarity = 1 - 0.62 * Math.min(this.#cheer, 1);
      this.#stemPlayer.setTarget("dust", p.dust * Number(T.dust) * this.#sectionMul.dust * dayClarity);
      this.#stemPlayer.update(dt, now);
    }
  }

  dispose(): void {
    try {
      this.#crackleSrc?.stop();
    } catch {
      /* already stopped */
    }
    this.#crackleSrc = null;
    this.#stemPlayer?.dispose();
    this.#stemPlayer = null;
    this.#groove?.dispose();
    this.#groove = null;
    this.#phrasePlayer?.dispose();
    this.#phrasePlayer = null;
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

    // One shared reverb, but its SHAPE is regional: pre-delay sells the size of
    // the room and the return damping sells what it is made of. A cathedral and
    // a warehouse can share an impulse response and still not sound alike.
    this.#convolver = ctx.createConvolver();
    this.#revPre = ctx.createDelay(0.2);
    this.#revPre.delayTime.value = 0.02;
    this.#revTone = ctx.createBiquadFilter();
    this.#revTone.type = "lowpass";
    this.#revTone.frequency.value = 4200;
    this.#revTone.Q.value = 0.2;
    const revReturn = ctx.createGain();
    revReturn.gain.value = 0.85;
    this.#revSend = ctx.createGain();
    this.#revSend.gain.value = 0.5;
    this.#revSend
      .connect(this.#revPre)
      .connect(this.#convolver)
      .connect(this.#revTone)
      .connect(revReturn)
      .connect(this.#sum);

    // vinyl crackle skips the wow (the "record surface" sits atop the music)
    this.#crackleGain = ctx.createGain();
    this.#crackleGain.gain.value = 0;
    this.#crackleGain.connect(this.#warm);

    const rng = Math.random;
    this.#keysCtx = { ctx, out: this.#keysBus, rev: this.#revSend, rng };
    this.#padCtx = { ctx, out: this.#padBus, rev: this.#revSend, rng };
    this.#bassCtx = { ctx, out: this.#bassBus, rev: this.#revSend, rng };
    this.#sparkleCtx = { ctx, out: this.#sparkleBus, rev: this.#revSend, rng };

    // the tape-dust bed is the one layer still worth streaming — it is 20 s of
    // unrepeatable noise that would cost more to synthesize than to fetch
    this.#stemPlayer = new StemPlayer(ctx, this.#sum);
    // percussion is fully procedural so every region can own its own kit
    this.#groove = new GroovePlayer(ctx, this.#sum);
    // baked melodic phrases join the same chain + share the score's reverb
    this.#phrasePlayer = new PhrasePlayer(ctx, this.#sum, this.#revSend);

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
    // the old voicing into the new key, so there is never a hard modulation.
    // The city's root comes from the slow session drift, not the static profile.
    this.#keyRoot = candidate === "city" ? this.#cityRoot : owner.root;
    this.#keyDayMode = owner.dayMode;
    this.#keyNightMode = owner.nightMode;
    this.#voicing = owner.voicing;
    this.#kit = owner.kit;
    // a new place gets to introduce itself, once, on the next chord
    this.#arrivalPending = Number(LOFI_MUSIC_TUNING.values.arrivals) > 0.01;
    // a modulation is the wrong moment to be mid-cadence
    this.#cadenceQueue.length = 0;
  }

  #applyTexture(now: number): void {
    const T = LOFI_MUSIC_TUNING.values;
    const p = this.#texture;
    const day = this.#daylight;
    const warmHz = (3200 + (1 - p.warmth) * 5200) * (0.62 + 0.38 * day);
    this.#warm.frequency.setTargetAtTime(warmHz, now, 1.2);
    const cheer = Math.min(this.#cheer, 1); // 0 at night — night gains unchanged
    const dayFocus = 1 - 0.42 * cheer;
    this.#wowLfoGain.gain.setTargetAtTime(0.0022 * Number(T.wobble) * dayFocus, now, 1);
    this.#flutterLfoGain.gain.setTargetAtTime(0.00013 * Number(T.wobble) * dayFocus, now, 1);
    // the record surface leans in as night settles — cozier, closer
    this.#crackleGain.gain.setTargetAtTime(
      p.crackle * Number(T.crackle) * (0.72 + 0.28 * (1 - day)) * (1 - 0.5 * cheer),
      now,
      1.5
    );
    const m = this.#sectionMul;
    this.#keysBus.gain.setTargetAtTime(p.keys * Number(T.keys) * 0.95 * m.keys * (1 + 0.12 * cheer), now, 1.5);
    this.#padBus.gain.setTargetAtTime(p.pad * Number(T.pads) * m.pad * (1 - 0.48 * cheer), now, 1.5);
    this.#bassBus.gain.setTargetAtTime(p.bass * Number(T.bass) * m.bass, now, 1.5);
    this.#sparkleBus.gain.setTargetAtTime(Number(T.sparkle) * 0.9 * m.sparkle * (1 + 0.24 * cheer), now, 1.5);
    this.#revSend.gain.setTargetAtTime(p.reverb * Number(T.reverb) * (1 - 0.34 * cheer), now, 1.5);
    // big rooms put more air before the first reflection; warm rooms eat the top
    this.#revPre.delayTime.setTargetAtTime(0.012 + p.reverb * 0.085, now, 2);
    this.#revTone.frequency.setTargetAtTime(1500 + (1 - p.warmth) * 6500, now, 2);
    // baked rhodes phrases belong to rhodes-ish places — a koto or organ region
    // leans on its own sparkles instead of an out-of-palette guest melody
    const k = p.keysMix;
    const affinity = (k.rhodes ?? 0) + (k.felt ?? 0) + (k.vibes ?? 0) + (k.celeste ?? 0);
    let total = 0;
    for (const v of Object.values(k)) total += Math.max(0, v);
    const rhodesLike = total > 0 ? affinity / total : 1;
    this.#phrasePlayer?.setGain(
      Number(T.phrases) * (0.3 + 0.7 * p.sparkle) * m.phrases * (0.3 + 0.7 * rhodesLike),
      now
    );
  }

  /** Weighted next section — no self-repeat, no back-to-back breaths, biased
   *  by the region's character (pad-heavy places drift, groovy places ride). */
  #pickSection(): void {
    const p = this.#texture;
    const cheer = this.#cheer; // 0 at night — night section odds unchanged
    const weights: Record<SectionId, number> = {
      full: 0.3 * (1 + 0.8 * cheer),
      keysOnly: (0.2 + 0.15 * p.keys) * (1 + 0.15 * cheer),
      padDrift: (0.16 + 0.3 * p.pad) * Math.max(0.08, 1 - 0.82 * cheer),
      beatFocus: (0.08 + 0.3 * p.groove) * 1.4 * (1 + 1.35 * cheer),
      breath: 0.1 * Math.max(0.08, 1 - 0.82 * cheer)
    };
    weights[this.#sectionId] = 0;
    if (this.#prevSectionId === "breath") weights.breath = 0;
    let total = 0;
    for (const id of SECTION_IDS) total += weights[id];
    let r = Math.random() * total;
    let next: SectionId = "full";
    for (const id of SECTION_IDS) {
      r -= weights[id];
      if (r <= 0) {
        next = id;
        break;
      }
    }
    this.#prevSectionId = this.#sectionId;
    this.#sectionId = next;
    const spec = SECTIONS[next];
    const dayTurnover = 1 - 0.3 * Math.min(cheer, 1);
    this.#sectionT = (spec.minS + Math.random() * (spec.maxS - spec.minS)) * dayTurnover;
  }

  /* ------------------------------------------------------------ composer */

  /** The next degree, taken from a cadence in progress or the drifting walk.
   *  Occasionally starts a cadence — a scripted two-or-three chord arrival is
   *  what separates a piece from a bed. */
  #advanceDegree(mode: readonly number[], cheer: number): number {
    if (this.#cadenceQueue.length > 0) return this.#cadenceQueue.shift()!;
    const p = this.#texture;
    // never twice in a row, and never before the last one has had room to land
    const ready = this.#sinceCadence > 45 + 60 * (1 - p.cadence);
    if (ready && Math.random() < p.cadence * 0.35) {
      const cadence = pickCadence(Math.random, p.warmth * 0.4 + Math.min(cheer, 1) * 0.6);
      this.#cadenceQueue = cadence.degrees.slice(1);
      this.#lastCadence = cadence.label;
      this.#sinceCadence = 0;
      return cadence.degrees[0];
    }
    return pickNextDegree(this.#degree, Math.random, mode, cheer);
  }

  #scheduleChord(): void {
    if (!this.#ctx) return;
    const t = this.#nextChordT;
    const p = this.#texture;
    const day = this.#daylight;
    const rng = Math.random;

    // dawn/dusk are a probability crossfade, so the two modes interleave
    const modeName = rng() < day ? this.#keyDayMode : this.#keyNightMode;
    const mode = MODES[modeName];
    const cheer = this.#cheer; // 0 at night — night harmony untouched

    this.#degree = this.#nextDegree >= 0 ? this.#nextDegree : this.#advanceDegree(mode, cheer);
    // looked at one chord ahead so the bass can walk into it
    this.#nextDegree = this.#advanceDegree(mode, cheer);

    const size = rng() < 0.35 + 0.15 * Math.min(cheer, 1) ? 5 : 4;
    const voicing = buildVoicing(this.#keyRoot, mode, this.#degree, size, this.#voicing);
    const pcs = voicing.pcs;
    const gap = gapForSpread(voicing.spread, pcs.length);
    const midis = leadVoices(
      this.#prevVoices,
      pcs,
      KEYS_LO + this.#register,
      KEYS_HI + this.#register,
      gap
    );
    this.#prevVoices = midis;

    const pace = Math.max(0.2, Number(LOFI_MUSIC_TUNING.values.pace));
    const dur =
      (p.chordSeconds / pace) *
      (1 + 0.5 * (1 - day)) *
      (0.9 + rng() * 0.25) *
      (1 - 0.36 * Math.min(cheer, 1));

    // the voicing window wanders a few semitones over minutes — verses sit
    // low and warm, later passages lift and open
    if (rng() < 0.3) {
      this.#register = Math.max(-4, Math.min(7, this.#register + (rng() < 0.5 ? -2 : 2)));
    }

    const keysId = pickKeysVoice(p.keysMix, rng);
    const playKeys = keysVoice(keysId);
    this.#lastKeysVoice = keysId;

    // a new region introduces itself with one rising figure in its own key and
    // its own instrument, right on the downbeat of the modulating chord
    if (this.#arrivalPending) {
      this.#arrivalPending = false;
      this.#arrivalCount++;
      const figure = arrivalFigure(this.#keyRoot, mode, KEYS_HI + this.#register - 8, rng);
      figure.forEach((midi, i) => {
        playKeys(this.#keysCtx, {
          t: t + 0.05 + i * (0.16 + rng() * 0.07),
          midi,
          vel: 0.13 + rng() * 0.05,
          dur: 1.4,
          bright: day
        });
      });
    }

    // gesture variety: how this chord is touched, not just which chord it is.
    // Sections with keys pulled far down skip the notes entirely (the pad
    // carries the harmony) instead of scheduling inaudible voices.
    if (this.#sectionMul.keys > 0.12) {
      const g = rng();
      if (g < 0.1) {
        // rest — the pad holds the room for one change
      } else {
        let picked = midis;
        let offsets: number[];
        if (g < 0.48) {
          // lazy upward roll (the classic touch)
          let acc = 0.02 + rng() * 0.05;
          offsets = midis.map(() => (acc += 0.055 + rng() * 0.1) - 0.055);
        } else if (g < 0.66) {
          // block chord — all voices land almost together
          offsets = midis.map(() => 0.008 + rng() * 0.025);
        } else if (g < 0.84) {
          // slow broken arpeggio spread across the bar
          let acc = 0.05;
          offsets = midis.map(() => (acc += 0.35 + rng() * 0.45) - 0.35);
        } else {
          // sparse — just the outer voices, wide open
          picked = midis.length > 2 ? [midis[0], midis[midis.length - 1]] : midis;
          offsets = picked.map((_, i) => 0.03 + i * (0.25 + rng() * 0.3));
        }
        picked.forEach((midi, i) => {
          playKeys(this.#keysCtx, {
            t: t + offsets[i],
            midi,
            vel: 0.14 + rng() * 0.08,
            dur,
            bright: day
          });
        });
        // occasional half-time echo of the top of the chord, quieter
        if (rng() < 0.4 && picked.length >= 2) {
          const echoT = t + dur * (0.45 + rng() * 0.15);
          for (const midi of picked.slice(-2)) {
            playKeys(this.#keysCtx, {
              t: echoT + rng() * 0.12,
              midi,
              vel: 0.07 + rng() * 0.04,
              dur: dur * 0.5,
              bright: day
            });
          }
        }
      }
    }

    // Daytime's defining exploration pulse. It outlines the current chord on
    // the region's own tempo grid with short notes in the region's own voice,
    // so the Financial District ticks and Chinatown rings. The velocity is
    // daylight-scaled, so dusk hands back to the ambient night arrangement.
    if (cheer > 0.02 && this.#sectionMul.keys > 0.12) {
      const beat = 60 / Math.max(50, p.bpm);
      const pulse = [0, 2, 1, 3, 0, 2, 4, 3];
      const steps = Math.min(14, Math.max(4, Math.floor((dur - 0.3) / beat)));
      const pulseVel = (0.05 + 0.04 * Math.min(cheer, 1)) * Math.min(1, cheer);
      for (let i = 0; i < steps; i++) {
        // A small breath before beat four keeps the loop buoyant instead of
        // reading as a mechanical sequencer.
        if (i % 8 === 6) continue;
        const midi = midis[pulse[i % pulse.length] % midis.length] + (i % 8 >= 4 ? 12 : 0);
        const accent = i % 4 === 0 ? 1.22 : i % 2 === 0 ? 1.05 : 0.82;
        playKeys(this.#keysCtx, {
          t: t + 0.12 + i * beat,
          midi,
          vel: pulseVel * accent,
          dur: 0.34,
          bright: day
        });
        this.#adventurePulseCount++;
      }
    }

    // pad holds the harmony; two tones is enough under a moving voicing
    const padId = pickPadVoice(p.padMix, rng);
    const playPad = padVoice(padId);
    this.#lastPadVoice = padId;
    const padRoot = 48 + pcs[0];
    const padTones = [padRoot, padRoot + 12 + ((fifthish(pcs) - pcs[0] + 12) % 12)];
    for (const midi of padTones) {
      playPad(this.#padCtx, { t, midi, vel: 0.11, dur, bright: day });
    }

    // bass: pedal in still places, a walking line where the region asks for one
    const bassId = pickBassVoice(p.bassMix, rng);
    const playBass = bassVoice(bassId);
    this.#lastBassVoice = bassId;
    const nextPcs = buildVoicing(this.#keyRoot, mode, this.#nextDegree, 3, this.#voicing).pcs;
    const line = bassLine({
      chordPcs: pcs,
      keyRoot: this.#keyRoot,
      mode,
      nextRootPc: nextPcs[0],
      prevMidi: this.#lastBassMidi,
      motion: p.motion * (0.5 + 0.5 * day),
      rng
    });
    const noteDur = line.length > 1 ? dur / line.length : dur;
    for (const step of line) {
      playBass(this.#bassCtx, {
        t: t + 0.1 + step.at * dur,
        midi: step.midi,
        vel: 0.26 * step.vel,
        dur: noteDur,
        bright: day
      });
    }
    this.#lastBassMidi = line[line.length - 1].midi;

    // hybrid conductor: a pending baked phrase enters just after this chord
    // lands, transposed into the key and matched to the chord's mode flavor.
    // Sections that silence phrases (breath) hold the pending flag instead.
    if (this.#phrasePending && this.#phrasePlayer && this.#sectionMul.phrases > 0.3) {
      const bright = modeName === "ionian" || modeName === "lydian" || modeName === "mixolydian";
      const pool = PHRASE_DEFS.filter(
        (d: PhraseDef) => d.flavor === (bright ? "bright" : "dusk") && d.id !== this.#lastPhraseId
      );
      // prefer a phrase that is already decoded — otherwise each retry would
      // roll a fresh random pick, fetch it, and never converge on playback
      const ready = pool.filter((d) => this.#phrasePlayer!.isReady(d.id));
      const pick = ready.length > 0 ? ready : pool;
      const def = pick[Math.floor(rng() * pick.length)];
      let semis = (this.#keyRoot - PHRASE_REF_ROOT + 12) % 12;
      if (semis > 6) semis -= 12; // nearest transposition, ±6 semitones max
      const drift = (rng() - 0.5) * 0.5; // ±¼-semitone tape drift per take
      if (def && this.#phrasePlayer.trigger(def, t + 0.5 + rng() * 0.9, semis + drift, 0.5 + rng() * 0.3)) {
        this.#lastPhraseId = def.id;
        this.#phrasePending = false;
        const gap =
          (70 - 46 * p.sparkle) *
          (1 + (1 - day) * 0.6) *
          (0.6 + rng() * 0.8) *
          (1 - 0.42 * Math.min(cheer, 1));
        this.#nextPhraseT = t + gap;
      }
      // a false trigger just started the fetch — stays pending for the next chord
    }

    this.#nextChordT = t + dur;
    this.#chordCount++;
    this.#lastChord = `${PC_NAMES[pcs[0]]}·${modeName.slice(0, 3)}·deg${this.#degree + 1}·${this.#voicing}`;
  }

  #scheduleSparkle(): void {
    if (!this.#ctx) return;
    const t = this.#nextSparkleT;
    const p = this.#texture;
    const day = this.#daylight;
    const rng = Math.random;

    const modeName = rng() < day ? this.#keyDayMode : this.#keyNightMode;
    const penta = pentatonicPcs(this.#keyRoot, MODES[modeName]);
    const pc = penta[Math.floor(rng() * penta.length)];
    // register varies: mostly high music-box, sometimes an octave higher,
    // and at night an occasional low, felt-muted answer
    const base = day < 0.5 && rng() < 0.3 ? 67 : 79;
    const midi = base + ((pc - base + 1200) % 12) + (rng() < 0.4 && base === 79 ? 12 : 0);
    const playSparkle = sparkleVoice(pickSparkleVoice(p.sparkleMix, rng));
    const ping = (at: number, m: number, vel: number) =>
      playSparkle(this.#sparkleCtx, { t: at, midi: m, vel, dur: 1.2, bright: day });

    ping(t, midi, 0.09 + rng() * 0.08);
    // sometimes a double-stop (two penta tones together), sometimes a soft
    // echo of the same note, sometimes a two-note motif completing itself
    const v = rng();
    if (v < 0.2) {
      const other = penta[(penta.indexOf(pc) + (rng() < 0.5 ? 2 : 3)) % penta.length];
      ping(t + 0.01, base + ((other - base + 1200) % 12) + 12, 0.05 + rng() * 0.04);
      this.#sparkleCount++;
    } else if (v < 0.45) {
      ping(t + 0.4 + rng() * 0.25, midi, 0.045 + rng() * 0.03);
      this.#sparkleCount++;
    } else if (v < 0.75) {
      const next = penta[(penta.indexOf(pc) + (rng() < 0.5 ? 1 : 4)) % penta.length];
      ping(t + 0.28 + rng() * 0.3, base + ((next - base + 1200) % 12), 0.06 + rng() * 0.05);
      this.#sparkleCount++;
    }
    this.#sparkleCount++;

    const interval = 20 - p.sparkle * 15; // dense regions ping every ~5s, sparse ~20s
    const nightStretch = 1 + (1 - day) * 0.8;
    const sectionStretch = 1 / Math.max(0.3, this.#sectionMul.sparkle);
    const cheerSqueeze = 1 - 0.34 * Math.min(this.#cheer, 1); // day-only densify
    this.#nextSparkleT =
      t + interval * nightStretch * sectionStretch * cheerSqueeze * (0.45 + rng() * 1.1);
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

/** The chord tone nearest a perfect fifth above the root — a safe pad partner
 *  under any voicing style, including the ones with no fifth in the stack. */
function fifthish(pcs: readonly number[]): number {
  let best = pcs[0];
  let bestCost = Infinity;
  for (const pc of pcs) {
    const iv = (pc - pcs[0] + 12) % 12;
    const cost = Math.abs(iv - 7);
    if (iv !== 0 && cost < bestCost) {
      bestCost = cost;
      best = pc;
    }
  }
  return best;
}
