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
  #channels = new Map<BuskerId, { gain: GainNode; panner: PannerNode }>();
  #retryAt = 0;
  #wantSuspend = false;

  /** Null when Web Audio is unavailable (headless test contexts). */
  get ctx(): AudioContext | null {
    return this.#ctx;
  }

  get running(): boolean {
    return this.#ctx?.state === "running";
  }

  constructor() {
    if (typeof AudioContext === "undefined") return;
    const ctx = new AudioContext();
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
  }

  /** The per-musician tap. Creates the spatial chain on first request. */
  channel(id: BuskerId): MusicianAudio | null {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return null;
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
      ch = { gain, panner };
      this.#channels.set(id, ch);
    }
    return { ctx, out: ch.gain };
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
    setParam(master.gain, effectsAudioLevel(), t);

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
    }
    this.#channels.clear();
    void this.#ctx?.close().catch(() => {});
    this.#ctx = null;
    this.#master = null;
  }
}
