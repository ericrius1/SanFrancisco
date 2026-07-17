// The Beach Pianist's voice: the real recording played back positionally in 3D.
// Rides NatureSoundscape's shared context and world bus (wave-organ / dog-park
// idiom) so the HUD volume/mute control, gesture unlock and limiter stay the
// single source of truth — no private AudioContext.
//
// Lazy: nothing is fetched at construction. arm() (called on first approach)
// downloads the AAC bytes; the AudioBuffer is decoded once the shared context
// exists. The transport is authoritative — the source is (re)started at the
// transport's song offset, and resynced if it drifts past RESYNC_DRIFT.

import type { NatureSoundscape } from "../../audio/natureSoundscape";

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

const AUDIO = {
  refDistance: 6,
  rolloffFactor: 0.95,
  maxDistance: 130,
  master: 0.95,
  wet: 0.12, // subtle beach-air reverb send
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
  /** True while the transport is inside a song (not the rest gap). */
  playing: boolean;
  /** Current song offset in seconds. */
  songTimeSec: number;
};

export class BeachPianistAudio {
  #nature: NatureSoundscape;
  #audioUrl: string;
  #io: NatureVoiceIO | null = null;

  // lazy asset state
  #armed = false;
  #encoded: ArrayBuffer | null = null;
  #buffer: AudioBuffer | null = null;
  #decoding = false;
  #disposed = false;
  #fetchError: string | null = null;

  // graph
  #master: GainNode | null = null;
  #panner: PannerNode | null = null;
  #send: GainNode | null = null;

  // playback
  #source: AudioBufferSourceNode | null = null;
  #srcStartCtx = 0; // ctx time that maps to song offset 0
  #playing = false;
  #awake = false;
  #vx = 0;
  #vy = 0;
  #vz = 0;

  constructor(nature: NatureSoundscape, audioUrl: string) {
    this.#nature = nature;
    this.#audioUrl = audioUrl;
  }

  get ready(): boolean {
    return this.#buffer != null;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get contextState(): string {
    return this.#io?.ctx.state ?? "none";
  }

  get error(): string | null {
    return this.#fetchError;
  }

  /** Seconds of the recording currently sounding, or null when silent. */
  audioSongTime(): number | null {
    if (!this.#playing || !this.#io) return null;
    return this.#io.ctx.currentTime - this.#srcStartCtx;
  }

  debugState() {
    return {
      armed: this.#armed,
      ready: this.ready,
      playing: this.#playing,
      ctx: this.contextState,
      hasPanner: this.#panner != null,
      awake: this.#awake,
      audioTime: this.audioSongTime(),
      error: this.#fetchError
    };
  }

  /** First-approach gate: download the recording bytes (idempotent, abortable
   * by disposal). Decode waits for the shared context. */
  arm(): void {
    if (this.#armed || this.#disposed) return;
    this.#armed = true;
    void fetch(this.#audioUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (this.#disposed) return;
        this.#encoded = buf;
      })
      .catch((error) => {
        this.#fetchError = String(error).slice(0, 120);
        console.warn("[beachPianist] audio fetch failed:", error);
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

    // keep the shared context alive while audibly near (hysteresis)
    if (dist < AUDIO.awakeOn) {
      if (!this.#awake) {
        this.#awake = true;
        this.#nature.setExternalAwake(true);
      }
    } else if (dist > AUDIO.awakeOff && this.#awake) {
      this.#awake = false;
      this.#nature.setExternalAwake(false);
    }

    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io) return;
    const ctx = io.ctx;

    this.#ensureGraph(io);
    if (this.#encoded && !this.#buffer && !this.#decoding) this.#decode(ctx);
    if (this.#panner) movePanner(this.#panner, ctx, this.#vx, this.#vy, this.#vz);

    // hysteretic audible window: only run the source when close enough to hear
    const wantAudible =
      this.#buffer != null &&
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

  #ensureGraph(io: NatureVoiceIO): void {
    if (this.#master) return;
    const ctx = io.ctx;
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
    panner.connect(io.musicBus);
    const send = ctx.createGain();
    send.gain.value = AUDIO.wet;
    panner.connect(send).connect(io.musicReverbSend);
    this.#master = master;
    this.#panner = panner;
    this.#send = send;
  }

  #decode(ctx: AudioContext): void {
    const encoded = this.#encoded;
    if (!encoded) return;
    this.#decoding = true;
    // decodeAudioData detaches the buffer; we no longer need the bytes after.
    ctx.decodeAudioData(encoded)
      .then((buffer) => {
        if (this.#disposed) return;
        this.#buffer = buffer;
        this.#encoded = null;
      })
      .catch((error) => {
        this.#fetchError = String(error).slice(0, 120);
        console.warn("[beachPianist] audio decode failed:", error);
      })
      .finally(() => {
        this.#decoding = false;
      });
  }

  #startSource(ctx: AudioContext, offsetSec: number): void {
    const buffer = this.#buffer;
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
      this.#nature.setExternalAwake(false);
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
    this.#send?.disconnect();
    this.#panner?.disconnect();
    this.#master?.disconnect();
    this.#master = null;
    this.#panner = null;
    this.#send = null;
    this.#buffer = null;
    this.#encoded = null;
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
