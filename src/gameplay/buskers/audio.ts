import * as THREE from "three/webgpu";
import { effectsAudioLevel } from "../../core/audioSettings";
import type { BuskerId, MusicianAudio } from "./types";

/**
 * The trio's audio core: ONE AudioContext for all three musicians (the app
 * is already near the browser's context budget), a spatial HRTF panner per
 * musician placed at their seat, and a master gain that tracks the HUD
 * effects-volume slider every frame. The context suspends itself when the
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
  #channels = new Map<BuskerId, { gain: GainNode; panner: PannerNode; reverb: GainNode }>();
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
    master.gain.setValueAtTime(on ? 0 : effectsAudioLevel(), t);
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
    let ctx: AudioContext;
    if (injectedCtx) {
      // OfflineAudioContext exposes every create*/gain method the graph uses;
      // the AudioContext-only bits (suspend, resume, createMediaStreamDestination)
      // are simply never called offline.
      ctx = injectedCtx as unknown as AudioContext;
    } else {
      if (typeof AudioContext === "undefined") return;
      ctx = new AudioContext();
    }
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
    convolver.buffer = buildImpulse(ctx, 2.7, 3.2);
    const wetReturn = ctx.createGain();
    wetReturn.gain.value = 0.9;
    reverbIn.connect(convolver).connect(wetReturn).connect(master);
    this.#reverbIn = reverbIn;
    this.#convolver = convolver;
  }

  /** The per-musician tap. Creates the spatial chain on first request. */
  channel(id: BuskerId): MusicianAudio | null {
    const ctx = this.#ctx;
    const master = this.#master;
    const reverbIn = this.#reverbIn;
    if (!ctx || !master || !reverbIn) return null;
    let ch = this.#channels.get(id);
    if (!ch) {
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 7;
      panner.rolloffFactor = 1.05;
      panner.maxDistance = 140;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(panner).connect(master);
      // wet send node the musician connects voices to; routes into the shared
      // reverb bus. Its own gain is 1 — musicians decide how much to send.
      const reverb = ctx.createGain();
      reverb.gain.value = 1;
      reverb.connect(reverbIn);
      ch = { gain, panner, reverb };
      this.#channels.set(id, ch);
    }
    return { ctx, out: ch.gain, reverb: ch.reverb };
  }

  /** World position of a musician's sound source (chest height at the seat). */
  setChannelPosition(id: BuskerId, x: number, y: number, z: number) {
    const ctx = this.#ctx;
    const ch = this.#channels.get(id);
    if (!ctx || !ch) return;
    const p = ch.panner;
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
      setParam(master.gain, effectsAudioLevel(), t);
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
    for (const ch of this.#channels.values()) {
      ch.gain.disconnect();
      ch.panner.disconnect();
      ch.reverb.disconnect();
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
