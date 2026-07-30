// Sampled surf stems for WaveAudio — the recordings behind the crashes and the
// wash. Mirrors the music StemPlayer residency contract (src/audio/music/stems.ts):
// nothing fetches at construction, buffers decode only on demand, and a long
// quiet spell releases the decoded memory again.
//
// Two players in one:
//   · beds     two long shoreline recordings, overlap-scheduled as crossfading
//              segments on independent slow clocks — never source.loop (MP3
//              encoder padding would gap the seam) and never the same stretch
//              twice, so the wash evolves without ever audibly looping.
//   · one-shots crash/swash/sub variants drawn per event with a
//              no-immediate-repeat rule. The first demand for a kind loads one
//              variant; each later draw hydrates one more in the background
//              until the kind is complete, so the network cost tracks actual
//              listening instead of front-loading the catalog.

import { WAVE_STEM_DEFS, type WaveStemDef, type WaveStemKind } from "./waveStemManifest";

const UNLOAD_AFTER_QUIET = 60; // seconds with no wave energy before buffers release
const SCHEDULE_HORIZON = 2.5; // seconds of scheduled bed lookahead
const BED_XFADE = 5; // equal-power segment crossfade
const BED_SEGMENT_MIN = 14;
const BED_SEGMENT_MAX = 22;
const FIRST_FADE = 0.6; // the opening segment rises quickly; WaveAudio's wash gain does the real fade

export type WaveOneShotKind = Exclude<WaveStemKind, "bed">;

export type WaveStemDraw = {
  buffer: AudioBuffer;
  def: WaveStemDef;
};

type StemState = {
  def: WaveStemDef;
  buffer: AudioBuffer | null;
  loadToken: symbol | null;
  failed: boolean;
};

type BedSource = {
  src: AudioBufferSourceNode;
  envelope: GainNode;
  trim: GainNode;
};

type BedVoice = {
  /** next segment start on the context clock; each voice drifts independently. */
  nextAt: number;
  /** cycles through the bed defs so back-to-back segments differ. */
  stemCursor: number;
  first: boolean;
  sources: Set<BedSource>;
};

const ONE_SHOT_KINDS: readonly WaveOneShotKind[] = [
  "crash-big",
  "crash-mid",
  "crash-small",
  "swash",
  "sub"
];

// Shared quarter-sine fade curves for equal-power segment crossfades.
const CURVE_POINTS = 33;
const FADE_IN_CURVE = new Float32Array(CURVE_POINTS);
const FADE_OUT_CURVE = new Float32Array(CURVE_POINTS);
for (let i = 0; i < CURVE_POINTS; i++) {
  const t = i / (CURVE_POINTS - 1);
  FADE_IN_CURVE[i] = Math.sin((t * Math.PI) / 2);
  FADE_OUT_CURVE[i] = Math.cos((t * Math.PI) / 2);
}

export class WaveStems {
  #ctx: AudioContext;
  #stems: StemState[];
  #byKind = new Map<WaveStemKind, StemState[]>();
  #lastDraw = new Map<WaveStemKind, string>();
  #bedDestination: AudioNode | null = null;
  #bedVoices: BedVoice[] = [];
  #quietSeconds = 0;
  #disposed = false;

  constructor(ctx: AudioContext) {
    this.#ctx = ctx;
    this.#stems = WAVE_STEM_DEFS.map((def) => ({
      def,
      buffer: null,
      loadToken: null,
      failed: false
    }));
    for (const stem of this.#stems) {
      const list = this.#byKind.get(stem.def.kind);
      if (list) list.push(stem);
      else this.#byKind.set(stem.def.kind, [stem]);
    }
  }

  get debugState() {
    let decodedBytes = 0;
    let loaded = 0;
    let loading = 0;
    let failed = 0;
    for (const stem of this.#stems) {
      if (stem.buffer) {
        loaded++;
        decodedBytes += stem.buffer.length * stem.buffer.numberOfChannels * 4;
      }
      if (stem.loadToken) loading++;
      if (stem.failed) failed++;
    }
    return {
      decodedMiB: +(decodedBytes / (1024 * 1024)).toFixed(2),
      loaded,
      loading,
      failed,
      bedsActive: this.#bedDestination !== null,
      quietSeconds: Math.round(this.#quietSeconds)
    };
  }

  /**
   * The activation-edge kick: both beds plus ONE variant of each one-shot kind.
   * Further variants hydrate one at a time as events actually draw them.
   */
  ensureLoaded(): void {
    for (const stem of this.#byKind.get("bed") ?? []) void this.#load(stem);
    for (const kind of ONE_SHOT_KINDS) {
      const first = this.#byKind.get(kind)?.[0];
      if (first) void this.#load(first);
    }
  }

  get bedsReady(): boolean {
    return (this.#byKind.get("bed") ?? []).some((stem) => stem.buffer !== null);
  }

  /**
   * Random loaded variant of a kind, never the same one twice in a row (once
   * two are resident). Returns null while nothing has decoded yet — the caller
   * keeps its procedural fallback for exactly that window.
   */
  draw(kind: WaveOneShotKind): WaveStemDraw | null {
    const list = this.#byKind.get(kind) ?? [];
    if (list.length === 0) return null;
    const loadedList = list.filter((stem) => stem.buffer !== null);
    if (loadedList.length < list.length) {
      const pending = list.find((stem) => !stem.buffer && !stem.loadToken && !stem.failed);
      if (pending) void this.#load(pending);
    }
    if (loadedList.length === 0) return null;
    const last = this.#lastDraw.get(kind);
    const pool = loadedList.length > 1
      ? loadedList.filter((stem) => stem.def.id !== last)
      : loadedList;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.#lastDraw.set(kind, pick.def.id);
    return { buffer: pick.buffer!, def: pick.def };
  }

  /** Start the crossfading bed voices into `destination` (WaveAudio's wash filter). */
  startBeds(destination: AudioNode): void {
    if (this.#bedDestination || this.#disposed) return;
    this.#bedDestination = destination;
    const now = this.#ctx.currentTime;
    this.#bedVoices = [
      { nextAt: now + 0.05, stemCursor: 0, first: true, sources: new Set() },
      // The second clock starts mid-thought: a short first segment offsets the
      // two voices so their crossfades never land together again.
      { nextAt: now + 0.05 + Math.random() * 4, stemCursor: 1, first: true, sources: new Set() }
    ];
  }

  stopBeds(): void {
    for (const voice of this.#bedVoices) {
      for (const active of voice.sources) this.#stopBedSource(active);
      voice.sources.clear();
    }
    this.#bedVoices = [];
    this.#bedDestination = null;
  }

  /** Per frame. `active` is "the sea is audible" — it gates the unload clock. */
  update(dt: number, active: boolean, now: number): void {
    if (this.#bedDestination) this.#scheduleBeds(now);
    if (active) {
      this.#quietSeconds = 0;
      // Re-hydrate after a quiet-spell unload: once nothing is resident or in
      // flight, a fresh approach kicks the whole activation spread again.
      if (!this.#stems.some((stem) => stem.buffer || stem.loadToken)) this.ensureLoaded();
      return;
    }
    this.#quietSeconds += Math.max(0, dt);
    if (this.#quietSeconds >= UNLOAD_AFTER_QUIET) this.#unloadAll();
  }

  dispose(): void {
    this.#disposed = true;
    this.stopBeds();
    for (const stem of this.#stems) {
      stem.buffer = null;
      stem.loadToken = null;
    }
  }

  #scheduleBeds(now: number): void {
    const beds = this.#byKind.get("bed") ?? [];
    if (beds.length === 0) return;
    for (const voice of this.#bedVoices) {
      if (voice.nextAt < now - 0.05) voice.nextAt = now + 0.05;
      while (voice.nextAt < now + SCHEDULE_HORIZON) {
        const stem = beds[voice.stemCursor % beds.length];
        voice.stemCursor++;
        const buffer = stem.buffer;
        if (!buffer) {
          // Nothing decoded for this slot yet — try again shortly rather than
          // burning the schedule forward.
          voice.nextAt = now + 1;
          break;
        }
        const segment = Math.min(
          BED_SEGMENT_MIN + Math.random() * (BED_SEGMENT_MAX - BED_SEGMENT_MIN),
          Math.max(2, buffer.duration - 0.15)
        );
        const fadeIn = Math.min(voice.first ? FIRST_FADE : BED_XFADE, segment * 0.45);
        const fadeOut = Math.min(BED_XFADE, segment * 0.45);
        const offset = Math.random() * Math.max(0, buffer.duration - segment - 0.1);
        const t0 = voice.nextAt;

        const src = this.#ctx.createBufferSource();
        src.buffer = buffer;
        const envelope = this.#ctx.createGain();
        // no setValueAtTime before the curve: same-time events can collide,
        // and the source is silent before t0 anyway (curve starts at 0)
        envelope.gain.setValueCurveAtTime(FADE_IN_CURVE, t0, fadeIn);
        envelope.gain.setValueCurveAtTime(FADE_OUT_CURVE, t0 + segment - fadeOut, fadeOut);
        const trim = this.#ctx.createGain();
        // Two voices share the wash bus; 0.7 each keeps their overlap honest.
        trim.gain.value = stem.def.gainTrim * 0.7;
        src.connect(envelope);
        envelope.connect(trim);
        trim.connect(this.#bedDestination!);
        src.start(t0, offset, segment + 0.05);
        src.stop(t0 + segment + 0.1);

        const active: BedSource = { src, envelope, trim };
        voice.sources.add(active);
        src.onended = () => {
          voice.sources.delete(active);
          try {
            src.disconnect();
            envelope.disconnect();
            trim.disconnect();
          } catch {
            /* already gone */
          }
        };

        voice.first = false;
        voice.nextAt = t0 + segment - fadeOut;
      }
    }
  }

  #stopBedSource(active: BedSource): void {
    try {
      active.src.stop();
    } catch {
      /* already stopped */
    }
    try {
      active.src.disconnect();
      active.envelope.disconnect();
      active.trim.disconnect();
    } catch {
      /* already gone */
    }
  }

  #unloadAll(): void {
    this.stopBeds();
    for (const stem of this.#stems) {
      stem.buffer = null;
      stem.failed = false; // a later approach may retry transient network faults
      stem.loadToken = null; // orphan any in-flight decode
    }
  }

  async #load(stem: StemState): Promise<void> {
    if (stem.buffer || stem.loadToken || stem.failed || this.#disposed) return;
    const token = Symbol(stem.def.id);
    stem.loadToken = token;
    try {
      const res = await fetch(stem.def.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      const buf = await this.#ctx.decodeAudioData(arr);
      if (stem.loadToken !== token || this.#disposed) return; // unloaded meanwhile
      stem.buffer = buf;
    } catch (error) {
      if (stem.loadToken === token) stem.failed = true;
      console.warn(`[wave-audio] stem failed: ${stem.def.id}`, error);
    } finally {
      if (stem.loadToken === token) stem.loadToken = null;
    }
  }
}
