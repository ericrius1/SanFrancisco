import { audioEngine } from "./engine";
import { musicAudioLevel } from "../core/audioSettings";
import { scoreDirectionAt, type ScoreDirection, type ScoreProfileId } from "./livingScoreRegions";

export type StemRole = "drums" | "bass" | "harmony" | "melody" | "texture" | "accent";

export type LivingScoreStem = {
  id: string;
  role: StemRole;
  url: string;
  /** Gain trim after Suno Studio separation and the offline delivery encode. */
  gain: number;
  /** Optional low-pass parking point for intentionally soft source material. */
  cutoffHz?: number;
  day?: number;
  night?: number;
};

export type LivingScoreSet = {
  id: string;
  title: string;
  profile: ScoreProfileId;
  bpm: number;
  key: string;
  durationSeconds: number;
  loopStartSeconds: number;
  loopEndSeconds: number;
  sourceSongId: string;
  stems: LivingScoreStem[];
};

export type LivingScoreManifest = {
  schema: 1;
  generatedWith: string;
  totalStemSeconds: number;
  sets: LivingScoreSet[];
};

export type LivingScoreInput = {
  x: number;
  z: number;
  speed: number;
  timeOfDay: number;
  indoor: boolean;
  allowNewLoads: boolean;
};

type StemVoice = {
  spec: LivingScoreStem;
  media: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
};

const MANIFEST_URL = "/audio/music/manifest.json";
// Separated stems are substantially quieter than a mastered stereo song. The
// deck restores that lost summing gain before the shared Music slider; a
// stem-count normalization and compressor below keep sparse and dense sets in
// the same musical neighborhood.
const MASTER_GAIN = 3.2;
const REGION_HOLD_SECONDS = 7;
const PASSAGE_MIN_SECONDS = 26;
const PASSAGE_SPREAD_SECONDS = 22;
const PLAYLIST_MIN_SECONDS = 330;
const PLAYLIST_SPREAD_SECONDS = 210;
const CROSSFADE_SECONDS = 14;
const TARGET_DECK_DB = -20;
const MAX_MAKEUP_GAIN = 8;
const SILENCE_DB = -52;
const SILENCE_SKIP_SECONDS = 3.5;

const ROLE_BASE: Record<StemRole, number> = {
  drums: 0.76,
  bass: 0.74,
  harmony: 0.86,
  melody: 0.64,
  texture: 0.72,
  accent: 0.52
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function hashText(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function unitHash(seed: number): number {
  let h = seed | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function isNight(hour: number): boolean {
  return hour >= 19.5 || hour < 6.5;
}

function assertManifest(value: unknown): LivingScoreManifest {
  const manifest = value as Partial<LivingScoreManifest> | null;
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.sets)) {
    throw new Error("living-score manifest has an unsupported schema");
  }
  for (const set of manifest.sets) {
    if (
      !set ||
      typeof set.id !== "string" ||
      typeof set.profile !== "string" ||
      !Array.isArray(set.stems) ||
      set.stems.length === 0
    ) {
      throw new Error("living-score manifest contains an invalid stem set");
    }
  }
  return manifest as LivingScoreManifest;
}

class ScoreDeck {
  readonly set: LivingScoreSet;
  readonly master: GainNode;
  readonly voices: StemVoice[] = [];
  #ctx: AudioContext;
  #highpass: BiquadFilterNode;
  #makeup: GainNode;
  #compressor: DynamicsCompressorNode;
  #meter: AnalyserNode;
  // ~170 ms at 48 kHz: long enough that an ambient zero crossing does not look
  // like silence, short enough to react before a musical pause feels broken.
  #meterData = new Float32Array(8192);
  #ready = false;
  #started = false;
  #passage = 0;
  #passageLeft = 0;
  #syncLeft = 0;
  #levelSampleLeft = 0;
  #silentFor = 0;
  #density = 0.55;

  get playbackState() {
    const leader = this.voices[0]?.media;
    return {
      playingStemCount: this.voices.filter((voice) => !voice.media.paused && !voice.media.ended).length,
      leaderTime: leader ? +leader.currentTime.toFixed(3) : 0,
      outputDb: +this.#readOutputDb().toFixed(1),
      gainReductionDb: +this.#compressor.reduction.toFixed(1),
      makeupGain: +this.#makeup.gain.value.toFixed(2)
    };
  }

  constructor(ctx: AudioContext, destination: AudioNode, set: LivingScoreSet) {
    this.#ctx = ctx;
    this.set = set;
    this.master = ctx.createGain();
    this.master.gain.value = 0;

    const highpass = ctx.createBiquadFilter();
    this.#highpass = highpass;
    highpass.type = "highpass";
    highpass.frequency.value = 28;
    highpass.Q.value = 0.6;
    const makeup = ctx.createGain();
    this.#makeup = makeup;
    makeup.gain.value = 1;
    const compressor = ctx.createDynamicsCompressor();
    this.#compressor = compressor;
    compressor.threshold.value = -14;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.24;
    const meter = ctx.createAnalyser();
    this.#meter = meter;
    meter.fftSize = 8192;
    meter.smoothingTimeConstant = 0.72;
    this.master.connect(highpass);
    highpass.connect(makeup);
    makeup.connect(compressor);
    compressor.connect(meter);
    meter.connect(destination);

    for (const stem of set.stems) {
      const media = document.createElement("audio");
      media.preload = "auto";
      media.crossOrigin = "anonymous";
      media.src = stem.url;
      media.loop = false;
      // Safari exposes this property without carrying it in the base DOM type.
      (media as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;

      const source = ctx.createMediaElementSource(media);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = stem.cutoffHz ?? 20_000;
      filter.Q.value = 0.35;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      this.voices.push({ spec: stem, media, source, filter, gain });
    }
  }

  async prepare(offsetSeconds: number): Promise<void> {
    await Promise.all(this.voices.map((voice) => this.#waitForMedia(voice.media)));
    const start = Math.min(
      Math.max(this.set.loopStartSeconds, this.set.loopStartSeconds + offsetSeconds),
      Math.max(this.set.loopStartSeconds, this.set.loopEndSeconds - 8)
    );
    for (const voice of this.voices) voice.media.currentTime = start;
    this.#ready = true;
  }

  async start(): Promise<void> {
    if (!this.#ready || this.#started) return;
    this.#started = true;
    const results = await Promise.allSettled(this.voices.map((voice) => voice.media.play()));
    if (results.every((result) => result.status === "rejected")) {
      this.#started = false;
      throw new Error("living score could not start its media elements");
    }
  }

  pause(): void {
    if (!this.#started) return;
    for (const voice of this.voices) voice.media.pause();
  }

  async resume(): Promise<void> {
    if (!this.#ready || !this.#started) return;
    const results = await Promise.allSettled(this.voices.map((voice) => voice.media.play()));
    if (results.every((result) => result.status === "rejected")) {
      throw new Error("living score could not resume its media elements");
    }
  }

  setMaster(value: number, seconds: number): void {
    const now = this.#ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(value, now + Math.max(0.02, seconds));
  }

  update(dt: number, input: LivingScoreInput, direction: ScoreDirection): void {
    if (!this.#started) return;
    this.#passageLeft -= dt;
    if (this.#passageLeft <= 0) {
      this.#passage++;
      const seed = hashText(this.set.id) ^ this.#passage;
      this.#density = 0.32 + unitHash(seed) * 0.58;
      this.#passageLeft = PASSAGE_MIN_SECONDS + unitHash(seed ^ 0x9e3779b9) * PASSAGE_SPREAD_SECONDS;
    }

    const moving = clamp01(input.speed / 14);
    const directedDensity = clamp01(this.#density * 0.72 + moving * 0.28);
    const night = isNight(input.timeOfDay);
    const now = this.#ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i]!;
      const stem = voice.spec;
      const seed = hashText(`${this.set.id}:${stem.id}`) ^ this.#passage;
      const chance = unitHash(seed);
      let presence = 1;
      if (stem.role === "drums") presence = directedDensity > 0.46 ? 0.45 + directedDensity * 0.55 : 0.08;
      else if (stem.role === "bass") presence = directedDensity > 0.3 ? 0.72 + directedDensity * 0.28 : 0.42;
      else if (stem.role === "melody") presence = chance < 0.58 ? 0.86 : 0.16;
      else if (stem.role === "accent") presence = chance < 0.35 + directedDensity * 0.2 ? 0.78 : 0.04;
      else if (stem.role === "texture") presence = 0.58 + (1 - moving) * 0.42;
      else presence = 0.72 + chance * 0.28;

      const dayPart = night ? (stem.night ?? 1) : (stem.day ?? 1);
      const interior = input.indoor ? (stem.role === "texture" ? 0.42 : 0.66) : 1;
      const target = stem.gain * ROLE_BASE[stem.role] * presence * dayPart * interior;
      voice.gain.gain.setTargetAtTime(target, now, stem.role === "accent" ? 1.8 : 3.2);
    }

    const leader = this.voices[0]?.media;
    if (!leader) return;
    if (leader.currentTime >= this.set.loopEndSeconds - 0.12) {
      for (const voice of this.voices) voice.media.currentTime = this.set.loopStartSeconds;
      return;
    }

    this.#syncLeft -= dt;
    if (this.#syncLeft <= 0) {
      this.#syncLeft = 1.8;
      for (let i = 1; i < this.voices.length; i++) {
        const voice = this.voices[i]!;
        const drift = voice.media.currentTime - leader.currentTime;
        if (Math.abs(drift) > 0.18 && voice.gain.gain.value < 0.04) {
          voice.media.currentTime = leader.currentTime;
          voice.media.playbackRate = 1;
        } else {
          voice.media.playbackRate = Math.min(1.015, Math.max(0.985, 1 - drift * 0.08));
        }
      }
    }

    // Studio-separated sources do not share a mastered loudness: a sparse pad
    // set can be 20 dB below a dense band. Sample four times a second and ride
    // only upward, slowly, before the compressor. Do not normalize away the
    // intentional indoor attenuation or the score's duck around live players.
    this.#levelSampleLeft -= dt;
    if (this.#levelSampleLeft <= 0) {
      const sampleDt = 0.25 - Math.min(0, this.#levelSampleLeft);
      this.#levelSampleLeft = 0.25;
      const outputDb = this.#readOutputDb();
      if (outputDb <= SILENCE_DB) {
        this.#silentFor += sampleDt;
        if (this.#silentFor >= SILENCE_SKIP_SECONDS) {
          this.#seekTogether(11.3);
          this.#silentFor = 0;
        }
      } else {
        this.#silentFor = 0;
        if (!input.indoor && direction.liveMusicDuck > 0.85) {
          const current = Math.max(1, this.#makeup.gain.value);
          const desired = Math.min(
            MAX_MAKEUP_GAIN,
            Math.max(1, current * 10 ** ((TARGET_DECK_DB - outputDb) / 20))
          );
          this.#makeup.gain.setTargetAtTime(desired, now, desired > current ? 2.8 : 1.2);
        }
      }
    }

    // Direction intensity and live-performer duck move the deck as one coherent
    // mix. Per-stem automation remains relative underneath it.
    const targetMaster = this.#masterFor(direction);
    this.master.gain.setTargetAtTime(targetMaster, now, 1.1);
  }

  targetFor(direction: ScoreDirection): number {
    return this.#masterFor(direction);
  }

  dispose(): void {
    for (const voice of this.voices) {
      voice.media.pause();
      voice.media.removeAttribute("src");
      voice.media.load();
      voice.source.disconnect();
      voice.filter.disconnect();
      voice.gain.disconnect();
    }
    this.master.disconnect();
    this.#highpass.disconnect();
    this.#makeup.disconnect();
    this.#compressor.disconnect();
    this.#meter.disconnect();
    this.voices.length = 0;
  }

  #masterFor(direction: ScoreDirection): number {
    const countNormalization = Math.sqrt(6 / Math.max(1, this.voices.length));
    return MASTER_GAIN * countNormalization * direction.intensity * direction.liveMusicDuck;
  }

  #readOutputDb(): number {
    this.#meter.getFloatTimeDomainData(this.#meterData);
    let energy = 0;
    for (const sample of this.#meterData) energy += sample * sample;
    const rms = Math.sqrt(energy / this.#meterData.length);
    return 20 * Math.log10(Math.max(0.000001, rms));
  }

  #seekTogether(deltaSeconds: number): void {
    const leader = this.voices[0]?.media;
    if (!leader) return;
    const span = Math.max(1, this.set.loopEndSeconds - this.set.loopStartSeconds);
    const next = this.set.loopStartSeconds +
      ((leader.currentTime - this.set.loopStartSeconds + deltaSeconds) % span + span) % span;
    for (const voice of this.voices) voice.media.currentTime = next;
  }

  #waitForMedia(media: HTMLAudioElement): Promise<void> {
    if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error(`timed out loading ${media.src}`)), 25_000);
      const finish = (error?: Error) => {
        window.clearTimeout(timeout);
        media.removeEventListener("canplay", onReady);
        media.removeEventListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => finish();
      const onError = () => finish(new Error(`failed to load ${media.src}`));
      media.addEventListener("canplay", onReady, { once: true });
      media.addEventListener("error", onError, { once: true });
      media.load();
    });
  }
}

/**
 * Region-aware, continuously re-orchestrating score made from Suno Studio
 * stems. Construction is network-free; the manifest and selected set cross the
 * first post-gesture activation gate in update().
 */
export class LivingScore {
  #manifest: LivingScoreManifest | null = null;
  #manifestLoading: Promise<void> | null = null;
  #deck: ScoreDeck | null = null;
  #incoming: ScoreDeck | null = null;
  #profile: ScoreProfileId | null = null;
  #candidate: ScoreProfileId | null = null;
  #candidateAge = 0;
  #playlistLeft = 0;
  #transitionLoading = false;
  #releaseHold: (() => void) | null = null;
  #failed = false;
  #muted = false;
  #lastDirection: ScoreDirection | null = null;
  #lastSetId: string | null = null;
  #lastInput: LivingScoreInput | null = null;

  get debugState() {
    const playback = this.#deck?.playbackState ?? this.#incoming?.playbackState ?? {
      playingStemCount: 0,
      leaderTime: 0,
      outputDb: -120,
      gainReductionDb: 0,
      makeupGain: 1
    };
    return {
      status: this.#failed ? "failed" : this.#manifest ? "ready" : this.#manifestLoading ? "loading" : "dormant",
      profile: this.#profile,
      candidate: this.#candidate,
      direction: this.#lastDirection?.label ?? null,
      set: this.#deck?.set.id ?? null,
      incoming: this.#incoming?.set.id ?? null,
      loadedStemCount: (this.#deck?.voices.length ?? 0) + (this.#incoming?.voices.length ?? 0),
      playingStemCount: playback.playingStemCount,
      leaderTime: playback.leaderTime,
      outputDb: playback.outputDb,
      gainReductionDb: playback.gainReductionDb,
      makeupGain: playback.makeupGain,
      libraryStemSeconds: this.#manifest?.totalStemSeconds ?? 0
    };
  }

  update(dt: number, input: LivingScoreInput): void {
    if (this.#failed) return;
    this.#lastInput = input;
    const direction = scoreDirectionAt(input.x, input.z, input.timeOfDay);
    this.#lastDirection = direction;

    const muted = musicAudioLevel() <= 0.0001;
    if (muted) {
      if (!this.#muted) {
        this.#muted = true;
        this.#deck?.pause();
        this.#incoming?.pause();
        this.#releaseHold?.();
        this.#releaseHold = null;
      }
      return;
    }
    if (this.#muted) {
      this.#muted = false;
      void this.#deck?.resume().catch((error) => console.warn("[living-score] resume failed", error));
      void this.#incoming?.resume().catch((error) => console.warn("[living-score] resume failed", error));
      if ((this.#deck || this.#incoming) && !this.#releaseHold) {
        this.#releaseHold = audioEngine.acquireHold();
      }
    }

    if (!this.#manifest) {
      if (input.allowNewLoads) this.#ensureManifest(direction.profile);
      return;
    }
    if (!this.#deck && !this.#transitionLoading) {
      if (input.allowNewLoads) void this.#transitionTo(direction.profile, input, true);
      return;
    }

    if (input.allowNewLoads && direction.profile !== this.#profile) {
      if (this.#candidate !== direction.profile) {
        this.#candidate = direction.profile;
        this.#candidateAge = 0;
      } else {
        this.#candidateAge += dt;
        if (this.#candidateAge >= REGION_HOLD_SECONDS && !this.#transitionLoading) {
          void this.#transitionTo(direction.profile, input, false);
        }
      }
    } else if (direction.profile === this.#profile) {
      this.#candidate = null;
      this.#candidateAge = 0;
      this.#playlistLeft -= dt;
      if (this.#playlistLeft <= 0 && !this.#transitionLoading) {
        void this.#transitionTo(direction.profile, input, false);
      }
    }

    this.#deck?.update(dt, input, direction);
    this.#incoming?.update(dt, input, direction);
    if (this.#deck || this.#incoming) audioEngine.touch(0.9);
  }

  dispose(): void {
    this.#deck?.dispose();
    this.#incoming?.dispose();
    this.#deck = null;
    this.#incoming = null;
    this.#releaseHold?.();
    this.#releaseHold = null;
  }

  #ensureManifest(initialProfile: ScoreProfileId): void {
    if (this.#manifestLoading) return;
    this.#manifestLoading = fetch(MANIFEST_URL, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`living-score manifest returned ${response.status}`);
        return response.json();
      })
      .then((value) => {
        this.#manifest = assertManifest(value);
        if (!this.#manifest.sets.length) throw new Error("living-score manifest is empty");
      })
      .then(() => {
        this.#manifestLoading = null;
        const input: LivingScoreInput = this.#lastInput ?? {
          x: 0,
          z: 0,
          speed: 0,
          timeOfDay: 12,
          indoor: false,
          allowNewLoads: true
        };
        return this.#transitionTo(initialProfile, input, true);
      })
      .catch((error) => {
        console.warn("[living-score] activation failed", error);
        this.#failed = true;
        this.#manifestLoading = null;
      });
  }

  async #transitionTo(profile: ScoreProfileId, input: LivingScoreInput, immediate: boolean): Promise<void> {
    const manifest = this.#manifest;
    if (!manifest || this.#transitionLoading) return;
    const candidates = manifest.sets.filter((set) => set.profile === profile);
    const pool = candidates.length ? candidates : manifest.sets;
    if (!pool.length) return;

    this.#transitionLoading = true;
    try {
      const seed = hashText(`${profile}:${Math.floor(performance.now() / 1000)}`);
      let set = pool[Math.floor(unitHash(seed) * pool.length)]!;
      if (pool.length > 1 && set.id === this.#lastSetId) {
        set = pool[(pool.indexOf(set) + 1) % pool.length]!;
      }

      const bus = audioEngine.bus("music", 1.5);
      if (!bus) return;
      const deck = new ScoreDeck(bus.ctx, bus.input, set);
      this.#incoming = deck;
      // Enter on the authored post-intro cue. Random time offsets can land in a
      // breakdown where every separated stem rests at once; the live passage
      // director below already supplies variation without a silent first read.
      await deck.prepare(0);
      await deck.start();
      if (this.#muted) deck.pause();
      else if (!this.#releaseHold) this.#releaseHold = audioEngine.acquireHold();

      const old = this.#deck;
      this.#deck = deck;
      this.#incoming = null;
      this.#profile = profile;
      this.#candidate = null;
      this.#candidateAge = 0;
      this.#lastSetId = set.id;
      this.#playlistLeft = PLAYLIST_MIN_SECONDS + unitHash(seed ^ 0x63d83595) * PLAYLIST_SPREAD_SECONDS;
      const transitionDirection = this.#lastDirection ?? scoreDirectionAt(input.x, input.z, input.timeOfDay);
      deck.update(0, input, transitionDirection);
      deck.setMaster(deck.targetFor(transitionDirection), immediate ? 3.5 : CROSSFADE_SECONDS);
      if (old) {
        old.setMaster(0, CROSSFADE_SECONDS);
        window.setTimeout(() => old.dispose(), CROSSFADE_SECONDS * 1000 + 500);
      }
    } catch (error) {
      console.warn(`[living-score] could not load profile ${profile}`, error);
      this.#incoming?.dispose();
      this.#incoming = null;
    } finally {
      this.#transitionLoading = false;
    }
  }
}
