// Procedurally synthesized wind bed. No samples: a looped pink-ish noise buffer
// feeds two bandpass "bands" —
//   howl   — low broadband body (~120-420 Hz) that rises in pitch and level with
//            the gust envelope,
//   rustle — bright hiss (~1.8-3.4 kHz) weighted by how deep in a region the
//            listener is (leaf/grass proximity).
// The gust envelope is the SAME windGustGlobal signal the vegetation shaders
// read, so audible swells match visible ones. A stereo
// panner leans the whole bed toward the world wind heading relative to the
// camera, so the wind audibly blows from the direction the grass bends.
//
// Ported from the fable-training garden build and de-coupled from THREE's
// AudioListener: it draws into a caller-supplied node on a shared AudioContext,
// so the whole nature soundscape lives in one context (the app is already near
// the browser's AudioContext budget).

import * as THREE from "three/webgpu";
import { WIND_DIR, windStrength } from "../world/vegetation/wind";

const tmpQuat = new THREE.Quaternion();

export class ProceduralWindSynth {
  #ctx: AudioContext;
  #source: AudioBufferSourceNode | null = null;
  #noise: AudioBuffer | null = null;
  #howlFilter: BiquadFilterNode;
  #howlGain: GainNode;
  #rustleFilter: BiquadFilterNode;
  #rustleGain: GainNode;
  #panner: StereoPannerNode;
  #out: GainNode;
  #running = false;
  #right = new THREE.Vector3();

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.#ctx = ctx;

    this.#howlFilter = ctx.createBiquadFilter();
    this.#howlFilter.type = "bandpass";
    this.#howlFilter.frequency.value = 160;
    this.#howlFilter.Q.value = 0.9;
    this.#howlGain = ctx.createGain();
    this.#howlGain.gain.value = 0;

    this.#rustleFilter = ctx.createBiquadFilter();
    this.#rustleFilter.type = "bandpass";
    this.#rustleFilter.frequency.value = 2300;
    this.#rustleFilter.Q.value = 0.45;
    this.#rustleGain = ctx.createGain();
    this.#rustleGain.gain.value = 0;

    this.#panner = ctx.createStereoPanner();
    this.#out = ctx.createGain();
    this.#out.gain.value = 1;

    this.#howlFilter.connect(this.#howlGain).connect(this.#panner);
    this.#rustleFilter.connect(this.#rustleGain).connect(this.#panner);
    this.#panner.connect(this.#out).connect(destination);
  }

  /** Installs worker-generated pink noise. Until it arrives the graph remains
   * silent instead of synthesizing four seconds of stereo noise on a keydown. */
  setNoiseBuffer(buffer: AudioBuffer): void {
    this.#noise = buffer;
    if (this.#running) this.#restartSource();
  }

  setRunning(on: boolean): void {
    if (on === this.#running) return;
    this.#running = on;
    if (on) {
      this.#restartSource();
    } else if (this.#source) {
      this.#source.stop();
      this.#source.disconnect();
      this.#source = null;
    }
  }

  #restartSource(): void {
    if (this.#source) {
      this.#source.stop();
      this.#source.disconnect();
      this.#source = null;
    }
    if (!this.#noise) return;
    const source = this.#ctx.createBufferSource();
    source.buffer = this.#noise;
    source.loop = true;
    source.connect(this.#howlFilter);
    source.connect(this.#rustleFilter);
    source.start(0, Math.random() * this.#noise.duration);
    this.#source = source;
  }

  /**
   * @param gust     shared vegetation wind envelope, 0..1
   * @param camera   listener camera (world quaternion → stereo pan)
   * @param level    overall synth level, 0..1 (tunable × region wind bias × fade)
   * @param nearMix  0..1 how "in the foliage" the listener is — weights rustle
   */
  update(gust: number, camera: THREE.Camera, level: number, nearMix: number): void {
    if (!this.#running) return;
    const now = this.#ctx.currentTime;
    const strength = Math.min(1, Math.max(0, windStrength.value as number));
    // Perceptual swell: quiet floor so lulls read as near-silence.
    const e = Math.pow(gust, 1.6) * (0.3 + 0.7 * strength);

    const howl = level * (0.04 + 0.62 * e);
    const rustle = level * nearMix * (0.015 + 0.5 * Math.pow(e, 1.25));
    this.#howlGain.gain.setTargetAtTime(howl, now, 0.14);
    this.#rustleGain.gain.setTargetAtTime(rustle, now, 0.09);
    // Gusts push the howl band up in pitch and widen the rustle band — the
    // classic rising "whoooh" as a swell moves through.
    this.#howlFilter.frequency.setTargetAtTime(130 + 290 * e, now, 0.18);
    this.#rustleFilter.frequency.setTargetAtTime(1900 + 1500 * e, now, 0.18);
    if (this.#source) this.#source.playbackRate.setTargetAtTime(0.88 + 0.34 * e, now, 0.25);

    // Pan toward the world wind heading: positive when the wind comes from the
    // camera's right. Kept partial (×0.6) so the bed never hard-pans.
    this.#right.set(1, 0, 0).applyQuaternion(camera.getWorldQuaternion(tmpQuat));
    const pan = THREE.MathUtils.clamp(this.#right.dot(WIND_DIR) * 0.6, -0.8, 0.8);
    this.#panner.pan.setTargetAtTime(pan, now, 0.2);
  }

  dispose(): void {
    this.setRunning(false);
    this.#out.disconnect();
  }
}
