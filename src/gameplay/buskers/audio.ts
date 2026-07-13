import * as THREE from "three/webgpu";
import { musicAudioLevel } from "../../core/audioSettings";
import type { BuskerId, MusicianAudio } from "./types";

/**
 * The trio's audio core: ONE AudioContext for all three musicians (the app
 * is already near the browser's context budget), a spatial HRTF panner per
 * musician placed at their seat, and a master gain that tracks the HUD
 * music-volume slider every frame. The context suspends itself when the
 * listener wanders out of earshot and quietly retries resume() while the
 * browser is still waiting for a user gesture.
 *
 * Musicians never see any of this — they get a `{ctx, out}` tap
 * (MusicianAudio) and connect self-cleaning voices to it.
 */

const AUDIBLE_RADIUS = 80; // beyond this the context suspends
const RESUME_HYSTERESIS = 8; // re-enter this much closer than we left
const RESUME_RETRY_SECONDS = 1.5;

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();

function setParam(p: AudioParam | undefined, v: number, t: number) {
  if (!p) return;
  p.setTargetAtTime(v, t, 0.08);
}

export class TrioAudio {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #comp: DynamicsCompressorNode | null = null; // final mix node (post master + reverb)
  #reverbIn: GainNode | null = null; // shared wet bus → convolver → master
  #convolver: ConvolverNode | null = null;
  #captureDest: MediaStreamAudioDestinationNode | null = null;
  #channels = new Map<BuskerId, {
    tap: MusicianAudio;
    gain: GainNode | null;
    panner: PannerNode | null;
    reverb: GainNode | null;
    position: [number, number, number];
  }>();
  #impulseWorker: Worker | null = null;
  #retryAt = 0;
  #wantSuspend = false;
  /** Force master gain to 0 (film cue: kill mid-song tails before the next pass). */
  #holdSilent = false;

  /** Null when Web Audio is unavailable (headless test contexts). */
  get ctx(): AudioContext | null {
    return this.#ctx;
  }

  get running(): boolean {
    return this.#ctx?.state === "running";
  }

  /**
   * A live MediaStream of the trio's FINAL mix — the compressor output, so it
   * carries the master gain, the shared "off the mountains" reverb, everything.
   * Lazily taps a MediaStreamAudioDestinationNode off the compressor (the tap
   * is cached; the compressor keeps feeding ctx.destination unchanged). The
   * render tool records this with MediaRecorder in a realtime pass. Null when
   * Web Audio is unavailable (headless test contexts).
   */
  captureStream(): MediaStream | null {
    this.#ensureLiveContext();
    const ctx = this.#ctx;
    const comp = this.#comp;
    if (!ctx || !comp) return null;
    if (!this.#captureDest) {
      this.#captureDest = ctx.createMediaStreamDestination();
      comp.connect(this.#captureDest);
    }
    return this.#captureDest.stream;
  }

  /** Mute the trio until the next playing phase (or an explicit clear). */
  holdSilent(on: boolean) {
    this.#holdSilent = on;
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    // Immediate cut — setTargetAtTime alone left audible tails through the Q gap.
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(on ? 0 : musicAudioLevel(), t);
    // Gate the wet bus too so the convolver can't spit a leftover hall into the
    // unmute that starts the next song.
    const reverbIn = this.#reverbIn;
    if (reverbIn) {
      reverbIn.gain.cancelScheduledValues(t);
      reverbIn.gain.setValueAtTime(on ? 0 : 1, t);
    }
  }

  /**
   * @param injectedCtx when supplied (an OfflineAudioContext for the
   * deterministic film render — see offlineRender.ts), the whole graph is built
   * on it instead of a fresh live AudioContext. Suspend/resume/capture-stream
   * are never exercised in that path, so the identical build works unchanged.
   * Omit it and the live game gets exactly the same `new AudioContext()` as before.
   */
  constructor(injectedCtx?: BaseAudioContext) {
    if (injectedCtx) {
      // OfflineAudioContext exposes every create*/gain method the graph uses;
      // the AudioContext-only bits (suspend, resume, createMediaStreamDestination)
      // are simply never called offline.
      this.#initialize(injectedCtx as unknown as AudioContext, true);
    }
  }

  #ensureLiveContext(): void {
    if (this.#ctx || typeof AudioContext === "undefined") return;
    // Do not create a heavyweight audio graph during boot or headless autostart.
    // The Start click (or any earlier real gesture) unlocks it; distance gating
    // in update() ensures a distant trio still costs nothing.
    if (typeof navigator !== "undefined" && navigator.userActivation?.hasBeenActive !== true) return;
    this.#initialize(new AudioContext(), false);
  }

  #initialize(ctx: AudioContext, synchronousImpulse: boolean): void {
    this.#ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    // gentle safety compressor so three simultaneous voices can't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;
    master.connect(comp).connect(ctx.destination);
    this.#master = master;
    this.#comp = comp;

    // "off the mountains" reverb: a synthetic exponential-decay impulse (a
    // long, slightly bright hall — the summit air), shared by all three
    // musicians. Voices send a wet fraction into #reverbIn; the convolved
    // return rejoins the master DOWNSTREAM of the panners, so the tail reads
    // as diffuse, non-localized reflection rather than a point source.
    const reverbIn = ctx.createGain();
    reverbIn.gain.value = 1;
    const convolver = ctx.createConvolver();
    if (synchronousImpulse) convolver.buffer = buildImpulse(ctx, 2.7, 3.2);
    else this.#buildImpulseOffThread(ctx, convolver, 2.7, 3.2);
    const wetReturn = ctx.createGain();
    wetReturn.gain.value = 0.9;
    reverbIn.connect(convolver).connect(wetReturn).connect(master);
    this.#reverbIn = reverbIn;
    this.#convolver = convolver;
    for (const [id, channel] of this.#channels) this.#materializeChannel(id, channel);
  }

  #buildImpulseOffThread(
    ctx: AudioContext,
    convolver: ConvolverNode,
    seconds: number,
    decay: number
  ): void {
    try {
      const worker = new Worker(new URL("./audioImpulseWorker.ts", import.meta.url), { type: "module" });
      this.#impulseWorker = worker;
      worker.onmessage = (event: MessageEvent<{ left: Float32Array; right: Float32Array }>) => {
        worker.terminate();
        if (this.#impulseWorker === worker) this.#impulseWorker = null;
        if (this.#ctx !== ctx || this.#convolver !== convolver) return;
        const { left, right } = event.data;
        const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
        buffer.getChannelData(0).set(left);
        buffer.getChannelData(1).set(right);
        convolver.buffer = buffer;
      };
      worker.onerror = () => {
        worker.terminate();
        if (this.#impulseWorker === worker) this.#impulseWorker = null;
        // Dry audio is a quality-safe fallback; never block play on reverb.
      };
      worker.postMessage({ sampleRate: ctx.sampleRate, seconds, decay });
    } catch {
      // Worker creation can be unavailable in restrictive embeds. Keep dry mix.
    }
  }

  /** The per-musician tap. Creates the spatial chain on first request. */
  channel(id: BuskerId): MusicianAudio | null {
    let ch = this.#channels.get(id);
    if (!ch) {
      const tap = {
        ctx: null as unknown as AudioContext,
        out: null as unknown as GainNode,
        reverb: null as unknown as GainNode
      };
      ch = { tap, gain: null, panner: null, reverb: null, position: [0, 0, 0] };
      this.#channels.set(id, ch);
      if (this.#ctx) this.#materializeChannel(id, ch);
    }
    return ch.tap;
  }

  #materializeChannel(
    _id: BuskerId,
    channel: {
      tap: MusicianAudio;
      gain: GainNode | null;
      panner: PannerNode | null;
      reverb: GainNode | null;
      position: [number, number, number];
    }
  ): void {
    const ctx = this.#ctx;
    const master = this.#master;
    const reverbIn = this.#reverbIn;
    if (!ctx || !master || !reverbIn || channel.gain) return;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 7;
    panner.rolloffFactor = 1.05;
    panner.maxDistance = 140;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(panner).connect(master);
    const reverb = ctx.createGain();
    reverb.gain.value = 1;
    reverb.connect(reverbIn);
    channel.gain = gain;
    channel.panner = panner;
    channel.reverb = reverb;
    channel.tap.ctx = ctx;
    channel.tap.out = gain;
    channel.tap.reverb = reverb;
    const [x, y, z] = channel.position;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else {
      (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /** World position of a musician's sound source (chest height at the seat). */
  setChannelPosition(id: BuskerId, x: number, y: number, z: number) {
    const ch = this.#channels.get(id);
    if (!ch) return;
    ch.position = [x, y, z];
    const ctx = this.#ctx;
    const p = ch.panner;
    if (!ctx || !p) return;
    if (p.positionX) {
      const t = ctx.currentTime;
      p.positionX.setTargetAtTime(x, t, 0.05);
      p.positionY.setTargetAtTime(y, t, 0.05);
      p.positionZ.setTargetAtTime(z, t, 0.05);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /**
   * Per-frame: move the listener onto the camera, track the HUD volume, and
   * suspend/resume with distance. `distance` = camera → platform centre.
   */
  update(camera: THREE.Camera, distance: number, elapsed: number) {
    if (!this.#ctx && distance < AUDIBLE_RADIUS - RESUME_HYSTERESIS) this.#ensureLiveContext();
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return;

    if (distance > AUDIBLE_RADIUS) {
      if (ctx.state === "running" && !this.#wantSuspend) {
        this.#wantSuspend = true;
        void ctx.suspend().catch(() => {});
      }
      return;
    }
    if (distance < AUDIBLE_RADIUS - RESUME_HYSTERESIS || this.#wantSuspend) {
      // inside earshot: (re)start — also covers the initial autoplay unlock,
      // which browsers may reject until the first user gesture, so retry.
      if (ctx.state !== "running" && elapsed >= this.#retryAt) {
        this.#retryAt = elapsed + RESUME_RETRY_SECONDS;
        this.#wantSuspend = false;
        void ctx.resume().catch(() => {});
      } else if (ctx.state === "running") {
        this.#wantSuspend = false;
      }
    }
    if (ctx.state !== "running") return;

    const t = ctx.currentTime;
    if (this.#holdSilent) {
      master.gain.setValueAtTime(0, t);
    } else {
      setParam(master.gain, musicAudioLevel(), t);
    }

    camera.getWorldPosition(_pos);
    camera.getWorldDirection(_fwd);
    _up.set(0, 1, 0).applyQuaternion((camera as THREE.Object3D).quaternion).normalize();
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = _pos.x;
      l.positionY.value = _pos.y;
      l.positionZ.value = _pos.z;
      l.forwardX.value = _fwd.x;
      l.forwardY.value = _fwd.y;
      l.forwardZ.value = _fwd.z;
      l.upX.value = _up.x;
      l.upY.value = _up.y;
      l.upZ.value = _up.z;
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(_pos.x, _pos.y, _pos.z);
      legacy.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  dispose() {
    this.#impulseWorker?.terminate();
    this.#impulseWorker = null;
    for (const ch of this.#channels.values()) {
      ch.gain?.disconnect();
      ch.panner?.disconnect();
      ch.reverb?.disconnect();
    }
    this.#channels.clear();
    this.#reverbIn?.disconnect();
    this.#convolver?.disconnect();
    this.#captureDest?.disconnect();
    // OfflineAudioContext has no close(); guard so an injected-context TrioAudio
    // can be disposed without throwing.
    const c = this.#ctx as AudioContext | null;
    if (c && typeof c.close === "function") void c.close().catch(() => {});
    this.#ctx = null;
    this.#master = null;
    this.#comp = null;
    this.#reverbIn = null;
    this.#convolver = null;
    this.#captureDest = null;
  }
}

/** Build a stereo exponential-decay noise impulse response — a cheap, warm
 * synthetic hall. `seconds` = tail length, `decay` = how fast it dies (bigger
 * = tighter). Slightly gentler on the highs so the flute echo stays soft, not
 * hissy. */
function buildImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      const white = Math.random() * 2 - 1;
      lp += 0.42 * (white - lp); // one-pole lowpass — softens the tail
      data[i] = lp * env;
    }
  }
  return buf;
}
