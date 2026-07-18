// The Beach Pianist's voice: the real recording played back positionally in 3D.
// Rides the shared AudioEngine music group (buskers idiom) so the HUD *Music*
// volume/mute, gesture unlock, listener and limiter stay the single source of
// truth — no private AudioContext. Routing through the music group is what ties
// the performance to the Music slider rather than the World/soundscape one.
//
// Lazy: nothing is fetched at construction. arm(songIndex) downloads only the
// selected AAC bytes; the AudioBuffer is decoded once the shared context exists.
// Decoded selections stay cached for later requests. Once requested, the
// transport is authoritative — the source is (re)started at the song offset and
// resynced if it drifts past RESYNC_DRIFT.

import { audioEngine } from "../../audio/engine";

const AUDIO = {
  refDistance: 6,
  rolloffFactor: 0.95,
  maxDistance: 130,
  master: 0.95,
  // keep the shared context awake a little past the audible edge (hysteresis)
  awakeOn: 140,
  awakeOff: 165,
  // start/keep the source running only when close enough to actually hear it
  audibleOn: 90,
  audibleOff: 110,
  resyncDrift: 0.12, // s — |audio − transport| beyond this restarts the source
  fadeIn: 0.05,
  fadeOut: 0.08
} as const;

export type TransportAudioState = {
  /** True while the requested one-shot performance is in progress. */
  playing: boolean;
  /** Playlist entry the transport is currently performing. */
  songIndex: number;
  /** Current song offset in seconds. */
  songTimeSec: number;
};

type AudioAssetState = {
  readonly url: string;
  armed: boolean;
  encoded: ArrayBuffer | null;
  buffer: AudioBuffer | null;
  decoding: boolean;
  error: string | null;
};

export class BeachPianistAudio {
  #assets: AudioAssetState[];
  #songIndex = 0;
  #ctx: AudioContext | null = null;

  #disposed = false;

  // graph
  #master: GainNode | null = null;
  #panner: PannerNode | null = null;

  // playback
  #source: AudioBufferSourceNode | null = null;
  #srcStartCtx = 0; // ctx time that maps to song offset 0
  #playing = false;
  #awake = false;
  #holdRelease: (() => void) | null = null; // engine hold while audibly near
  #vx = 0;
  #vy = 0;
  #vz = 0;

  constructor(audioUrls: readonly string[]) {
    if (audioUrls.length === 0) throw new Error("BeachPianistAudio needs at least one song");
    this.#assets = audioUrls.map((url) => ({
      url,
      armed: false,
      encoded: null,
      buffer: null,
      decoding: false,
      error: null
    }));
  }

  get ready(): boolean {
    return this.#activeAsset().buffer != null;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get contextState(): string {
    return this.#ctx?.state ?? "none";
  }

  get error(): string | null {
    return this.#activeAsset().error;
  }

  /** Seconds of the recording currently sounding, or null when silent. */
  audioSongTime(): number | null {
    if (!this.#playing || !this.#ctx) return null;
    return this.#ctx.currentTime - this.#srcStartCtx;
  }

  debugState() {
    const active = this.#activeAsset();
    return {
      songIndex: this.#songIndex,
      armed: active.armed,
      ready: this.ready,
      playing: this.#playing,
      ctx: this.contextState,
      hasPanner: this.#panner != null,
      awake: this.#awake,
      audioTime: this.audioSongTime(),
      error: active.error,
      songs: this.#assets.map((asset) => ({
        armed: asset.armed,
        ready: asset.buffer != null,
        decoding: asset.decoding,
        error: asset.error
      }))
    };
  }

  /** Selection/first-approach gate: download one recording (idempotent,
   * abortable by disposal). Decode waits for the shared context. */
  arm(songIndex = 0): void {
    const asset = this.#assets[songIndex];
    if (!asset || asset.armed || this.#disposed) return;
    asset.armed = true;
    void fetch(asset.url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (this.#disposed) return;
        asset.encoded = buf;
      })
      .catch((error) => {
        asset.error = String(error).slice(0, 120);
        console.warn(`[beachPianist] song ${songIndex} audio fetch failed:`, error);
      });
  }

  /** Panner position (the piano voice point). */
  setVoicePosition(x: number, y: number, z: number): void {
    this.#vx = x;
    this.#vy = y;
    this.#vz = z;
  }

  update(dist: number, transport: TransportAudioState): void {
    if (this.#disposed) return;
    this.#selectSong(transport.songIndex);

    // Hold the shared engine context alive while audibly near (hysteresis), so
    // the idle-suspend policy can't park it mid-performance. Released past
    // awakeOff so it costs nothing away from the beach.
    if (dist < AUDIO.awakeOn) {
      if (!this.#awake) {
        this.#awake = true;
        this.#holdRelease = audioEngine.acquireHold();
      }
    } else if (dist > AUDIO.awakeOff && this.#awake) {
      this.#awake = false;
      this.#holdRelease?.();
      this.#holdRelease = null;
    }

    // The engine owns the context + gesture gate: bus() is null until unlocked,
    // and touches/resumes the ctx each call. The music group applies the HUD
    // Music volume/mute; our master is just the feature's own fade trim.
    const bus = audioEngine.bus("music");
    if (!bus) return;
    const ctx = bus.ctx;
    this.#ctx = ctx;

    this.#ensureGraph(ctx, bus.input);
    const asset = this.#activeAsset();
    if (asset.encoded && !asset.buffer && !asset.decoding) this.#decode(ctx, asset);
    if (this.#panner) movePanner(this.#panner, ctx, this.#vx, this.#vy, this.#vz);

    // hysteretic audible window: only run the source when close enough to hear
    const wantAudible =
      asset.buffer != null &&
      ctx.state === "running" &&
      transport.playing &&
      (this.#playing ? dist < AUDIO.audibleOff : dist < AUDIO.audibleOn);

    if (!wantAudible) {
      if (this.#playing) this.#stopSource(ctx);
      return;
    }

    if (!this.#playing) {
      this.#startSource(ctx, transport.songTimeSec);
      return;
    }
    // running: correct drift against the authoritative transport
    const audioTime = ctx.currentTime - this.#srcStartCtx;
    if (Math.abs(audioTime - transport.songTimeSec) > AUDIO.resyncDrift) {
      this.#stopSource(ctx);
      this.#startSource(ctx, transport.songTimeSec);
    }
  }

  #activeAsset(): AudioAssetState {
    return this.#assets[this.#songIndex];
  }

  #selectSong(songIndex: number): void {
    if (!this.#assets[songIndex] || songIndex === this.#songIndex) return;
    if (this.#playing && this.#ctx) this.#stopSource(this.#ctx);
    this.#songIndex = songIndex;
  }

  #ensureGraph(ctx: AudioContext, busInput: GainNode): void {
    if (this.#master) return;
    const master = ctx.createGain();
    master.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = AUDIO.refDistance;
    panner.rolloffFactor = AUDIO.rolloffFactor;
    panner.maxDistance = AUDIO.maxDistance;
    movePanner(panner, ctx, this.#vx, this.#vy, this.#vz, 0);
    master.connect(panner);
    panner.connect(busInput); // engine music group input
    this.#master = master;
    this.#panner = panner;
  }

  #decode(ctx: AudioContext, asset: AudioAssetState): void {
    const encoded = asset.encoded;
    if (!encoded) return;
    asset.decoding = true;
    // decodeAudioData detaches the buffer; we no longer need the bytes after.
    ctx.decodeAudioData(encoded)
      .then((buffer) => {
        if (this.#disposed) return;
        asset.buffer = buffer;
        asset.encoded = null;
      })
      .catch((error) => {
        asset.error = String(error).slice(0, 120);
        console.warn("[beachPianist] audio decode failed:", error);
      })
      .finally(() => {
        asset.decoding = false;
      });
  }

  #startSource(ctx: AudioContext, offsetSec: number): void {
    const buffer = this.#activeAsset().buffer;
    const master = this.#master;
    if (!buffer || !master) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    const offset = Math.max(0, Math.min(offsetSec, buffer.duration - 0.02));
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(0.0001, now);
    master.gain.linearRampToValueAtTime(AUDIO.master, now + AUDIO.fadeIn);
    source.start(now, offset);
    this.#srcStartCtx = now - offset;
    this.#source = source;
    this.#playing = true;
    source.onended = () => {
      if (this.#source === source) {
        this.#source = null;
        this.#playing = false;
      }
      source.disconnect();
    };
  }

  #stopSource(ctx: AudioContext): void {
    const source = this.#source;
    const master = this.#master;
    this.#playing = false;
    this.#source = null;
    if (master) {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0.0001, now + AUDIO.fadeOut);
    }
    if (source) {
      source.onended = null;
      try {
        source.stop(ctx.currentTime + AUDIO.fadeOut + 0.02);
      } catch {
        /* already stopped */
      }
      const dead = source;
      dead.addEventListener("ended", () => dead.disconnect(), { once: true });
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#awake) {
      this.#awake = false;
      this.#holdRelease?.();
      this.#holdRelease = null;
    }
    if (this.#source) {
      this.#source.onended = null;
      try {
        this.#source.stop();
      } catch {
        /* already stopped */
      }
      this.#source.disconnect();
      this.#source = null;
    }
    this.#panner?.disconnect();
    this.#master?.disconnect();
    this.#master = null;
    this.#panner = null;
    for (const asset of this.#assets) {
      asset.buffer = null;
      asset.encoded = null;
    }
    this.#playing = false;
  }
}

function movePanner(p: PannerNode, ctx: AudioContext, x: number, y: number, z: number, tc = 0.05): void {
  const now = ctx.currentTime;
  if (p.positionX) {
    p.positionX.setTargetAtTime(x, now, tc);
    p.positionY.setTargetAtTime(y, now, tc);
    p.positionZ.setTargetAtTime(z, now, tc);
  } else {
    p.setPosition(x, y, z);
  }
}
