/**
 * Procedural firework audio — no sample files. Each burst synthesizes a boom
 * (sub-bass sweep + mid thump + low rumble + filtered noise body + close-range
 * crack) plus a crackle tail, all fed into a ping-pong delay bus so the report
 * echoes across the sky.
 *
 * Physicality comes from the listener math, not the synthesis: every boom is
 * scheduled at burst time + distance/343 (speed of sound), attenuated and
 * low-pass muffled with distance, and stereo-panned by bearing relative to the
 * camera heading. A one-second token bucket thins dense volleys so a 200-rocket
 * barrage stays a rumble instead of clipping.
 */

import { tunables } from "../core/persist";
import { effectsAudioLevel } from "../core/audioSettings";

const SPEED_OF_SOUND = 343; // m/s
const MAX_BOOMS_PER_SEC = 18;

// Persisted mix tuning; lives in the fireworks folder of the "/" panel.
export const AUDIO_TUNING = tunables("fireworksAudio", {
  volume: { v: 0.6, min: 0, max: 1, step: 0.05, label: "boom volume" },
  bass: { v: 1, min: 0, max: 2, step: 0.05, label: "boom bass" },
  echo: { v: 0.55, min: 0, max: 1, step: 0.05, label: "sky echo" },
  muted: { v: false, label: "mute booms" }
});

export class FireworksAudio {
  params = AUDIO_TUNING.values;

  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #echoSend!: GainNode;
  #noise!: AudioBuffer;
  #crackle!: AudioBuffer;
  #recent: number[] = [];

  constructor() {
    // autoplay policy: context can only start after a user gesture, so unlock
    // on the first interaction (F to fire is itself a gesture)
    const unlock = () => {
      const ctx = this.#ensure();
      if (ctx && ctx.state === "suspended") void ctx.resume();
      if (ctx && ctx.state === "running") {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    this.#ctx = ctx;

    // master: gain -> soft limiter -> out
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 18;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    this.#master = ctx.createGain();
    this.#master.connect(limiter);

    // echo bus: cross-fed ping-pong delays with a darkening lowpass in the
    // feedback loop — each repeat is quieter and duller, like distant hills
    this.#echoSend = ctx.createGain();
    const dA = ctx.createDelay(2);
    const dB = ctx.createDelay(2);
    dA.delayTime.value = 0.35;
    dB.delayTime.value = 0.52;
    const fbA = ctx.createGain();
    const fbB = ctx.createGain();
    fbA.gain.value = 0.45;
    fbB.gain.value = 0.45;
    const lpA = ctx.createBiquadFilter();
    const lpB = ctx.createBiquadFilter();
    lpA.type = lpB.type = "lowpass";
    lpA.frequency.value = 750;
    lpB.frequency.value = 550;
    const panA = ctx.createStereoPanner();
    const panB = ctx.createStereoPanner();
    panA.pan.value = -0.6;
    panB.pan.value = 0.6;
    this.#echoSend.connect(dA);
    dA.connect(lpA);
    lpA.connect(panA);
    panA.connect(this.#master);
    lpA.connect(fbA);
    fbA.connect(dB);
    dB.connect(lpB);
    lpB.connect(panB);
    panB.connect(this.#master);
    lpB.connect(fbB);
    fbB.connect(dA);

    // 2s of white noise, reused by every voice at random offsets
    const sr = ctx.sampleRate;
    this.#noise = ctx.createBuffer(1, sr * 2, sr);
    const n = this.#noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;

    // crackle: sparse impulses whose density and amplitude decay over 1.6s
    this.#crackle = ctx.createBuffer(1, sr * 1.6, sr);
    const c = this.#crackle.getChannelData(0);
    for (let i = 0; i < c.length; i++) {
      const t = i / c.length;
      const density = 0.0035 * (1 - t) * (1 - t);
      if (Math.random() < density) {
        const amp = (Math.random() * 0.7 + 0.3) * (1 - t);
        const len = Math.min(c.length - i, 30 + Math.floor(Math.random() * 60));
        for (let j = 0; j < len; j++) c[i + j] += (Math.random() * 2 - 1) * amp * (1 - j / len);
        i += len;
      }
    }
    return ctx;
  }

  /**
   * One explosion at world position (x,y,z) heard from (lx,ly,lz) facing yaw.
   * `power` scales loudness/weight (≈1 for a normal shell).
   */
  boom(x: number, y: number, z: number, lx: number, ly: number, lz: number, yaw: number, power = 1) {
    if (this.params.muted || this.params.volume <= 0) return;
    const master = effectsAudioLevel(); // HUD effects volume slider
    if (master <= 0) return;
    const ctx = this.#ensure();
    if (!ctx || ctx.state !== "running") return;

    const dx = x - lx;
    const dy = y - ly;
    const dz = z - lz;
    const dist = Math.hypot(dx, dy, dz);
    const now = ctx.currentTime;
    const t0 = now + dist / SPEED_OF_SOUND;

    // thin dense volleys: at most MAX_BOOMS_PER_SEC audible per second of
    // arrival time (checked against scheduled arrivals, not emit time)
    this.#recent = this.#recent.filter((t) => t > t0 - 1);
    if (this.#recent.length >= MAX_BOOMS_PER_SEC) return;
    this.#recent.push(t0);

    const att = Math.min(1, 130 / (dist + 40)); // rolloff with a near-field cap
    const g = att * power * this.params.volume * this.params.volume * master;
    if (g < 0.003) return;
    const bass = g * this.params.bass; // scales the three low layers only

    // pan by bearing: project direction-to-burst onto the camera right vector
    const horiz = Math.hypot(dx, dz);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const pan = horiz > 1 ? ((dx * rx + dz * rz) / horiz) * 0.75 : 0;

    const out = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner);
    panner.connect(this.#master);
    panner.connect(this.#echoSend);
    this.#echoSend.gain.value = this.params.echo;

    // sub sweep: sine dropping 52→24Hz, the chest-hit of a big shell
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(52, t0);
    sub.frequency.exponentialRampToValueAtTime(24, t0 + 0.8);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0, t0);
    subG.gain.linearRampToValueAtTime(1.5 * bass, t0 + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.001, t0 + 1.8);
    sub.connect(subG);
    subG.connect(out);
    sub.start(t0);
    sub.stop(t0 + 1.9);

    // mid thump: triangle 110→45Hz — the depth small speakers can actually
    // reproduce, since they roll off everything under ~100Hz
    const thump = ctx.createOscillator();
    thump.type = "triangle";
    thump.frequency.setValueAtTime(110, t0);
    thump.frequency.exponentialRampToValueAtTime(45, t0 + 0.5);
    const thumpG = ctx.createGain();
    thumpG.gain.setValueAtTime(0, t0);
    thumpG.gain.linearRampToValueAtTime(0.7 * bass, t0 + 0.015);
    thumpG.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
    thump.connect(thumpG);
    thumpG.connect(out);
    thump.start(t0);
    thump.stop(t0 + 0.9);

    // rumble: heavily lowpassed noise rolling on after the hit, thunder-like;
    // the 90Hz cutoff strips most of the noise energy, hence the hot makeup gain
    const rum = ctx.createBufferSource();
    rum.buffer = this.#noise;
    rum.loop = true;
    const rumLp = ctx.createBiquadFilter();
    rumLp.type = "lowpass";
    rumLp.frequency.value = 90;
    rumLp.Q.value = 1.2;
    const rumG = ctx.createGain();
    rumG.gain.setValueAtTime(0, t0);
    rumG.gain.linearRampToValueAtTime(2.4 * bass, t0 + 0.08);
    rumG.gain.exponentialRampToValueAtTime(0.001, t0 + 2.8);
    rum.connect(rumLp);
    rumLp.connect(rumG);
    rumG.connect(out);
    rum.start(t0, Math.random() * 1.5);
    rum.stop(t0 + 2.9);

    // noise body: lowpass sweeping shut; farther booms start already muffled
    const body = ctx.createBufferSource();
    body.buffer = this.#noise;
    const bodyLp = ctx.createBiquadFilter();
    bodyLp.type = "lowpass";
    bodyLp.Q.value = 0.7;
    const cutoff = 140 + 1600 * att;
    bodyLp.frequency.setValueAtTime(cutoff, t0);
    bodyLp.frequency.exponentialRampToValueAtTime(90, t0 + 1.6);
    const bodyG = ctx.createGain();
    bodyG.gain.setValueAtTime(0, t0);
    bodyG.gain.linearRampToValueAtTime(1.0 * g, t0 + 0.015);
    bodyG.gain.exponentialRampToValueAtTime(0.001, t0 + 1.7);
    body.connect(bodyLp);
    bodyLp.connect(bodyG);
    bodyG.connect(out);
    body.start(t0, Math.random() * 0.2, 1.8);

    // crack transient: only survives up close (att² falloff)
    const crackGain = 0.5 * g * att;
    if (crackGain > 0.01) {
      const crack = ctx.createBufferSource();
      crack.buffer = this.#noise;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(crackGain, t0);
      cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
      crack.connect(hp);
      hp.connect(cg);
      cg.connect(out);
      crack.start(t0, Math.random() * 0.4, 0.12);
    }

    // crackle tail trailing the report, like the strobe sparks overhead
    const tail = ctx.createBufferSource();
    tail.buffer = this.#crackle;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 0.8;
    const tg = ctx.createGain();
    tg.gain.value = 0.35 * g;
    tail.connect(bp);
    bp.connect(tg);
    tg.connect(out);
    tail.start(t0 + 0.1 + Math.random() * 0.1);
  }
}
