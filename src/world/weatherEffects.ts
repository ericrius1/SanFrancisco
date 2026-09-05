import * as THREE from "three/webgpu";
import { audioEngine } from "../audio/engine";
import { soundscapeAudioLevel } from "../core/audioSettings";
import type { WeatherState } from "./weatherModel";

const DROP_COUNT = 520;
const FIELD_RADIUS = 34;
const FIELD_HEIGHT = 30;

function hash01(index: number, salt: number): number {
  let value = (index ^ Math.imul(salt, 0x9e3779b1)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 0xffffffff;
}

class WeatherAudio {
  #ctx: AudioContext | null = null;
  #source: AudioBufferSourceNode | null = null;
  #noise: AudioBuffer | null = null;
  #rainGain: GainNode | null = null;
  #rainFilter: BiquadFilterNode | null = null;
  #timeouts = new Set<number>();
  #disposed = false;

  get active(): boolean {
    return Boolean(this.#source);
  }

  update(rain: number, storm: number, indoor: boolean): void {
    const audible = rain * (indoor ? 0.18 : 1);
    if (!this.#source && audible > 0.012) this.#ensure();
    if (!this.#ctx || !this.#rainGain || !this.#rainFilter) return;
    const now = this.#ctx.currentTime;
    this.#rainGain.gain.setTargetAtTime(Math.pow(audible, 1.25) * 0.34, now, 2.4);
    this.#rainFilter.frequency.setTargetAtTime(1800 + rain * 3100 + storm * 1300, now, 3.5);
    if (audible > 0.004 && soundscapeAudioLevel() > 0.001) audioEngine.touch(0.72);
  }

  thunder(strength: number, indoor: boolean): void {
    if (this.#disposed || strength < 0.2) return;
    const delayMs = 550 + (1 - strength) * 1900 + hash01(this.#timeouts.size + 1, 47) * 900;
    const timer = window.setTimeout(() => {
      this.#timeouts.delete(timer);
      this.#playThunder(strength * (indoor ? 0.36 : 1));
    }, delayMs);
    this.#timeouts.add(timer);
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timeouts) window.clearTimeout(timer);
    this.#timeouts.clear();
    try {
      this.#source?.stop();
    } catch {
      // It may already have been stopped by browser teardown.
    }
    this.#source?.disconnect();
    this.#rainFilter?.disconnect();
    this.#rainGain?.disconnect();
  }

  #ensure(): void {
    const bus = audioEngine.bus("world", 1.2);
    if (!bus) return;
    const { ctx, input } = bus;
    this.#ctx = ctx;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 3));
    const noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < channel.length; i++) {
      brown = brown * 0.965 + (Math.random() * 2 - 1) * 0.035;
      const hiss = Math.random() * 2 - 1;
      channel[i] = brown * 2.6 + hiss * 0.22;
    }
    this.#noise = noise;

    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 230;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2600;
    filter.Q.value = 0.55;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(highpass).connect(filter).connect(gain).connect(input);
    source.start(0, Math.random() * noise.duration);
    this.#source = source;
    this.#rainFilter = filter;
    this.#rainGain = gain;
  }

  #playThunder(strength: number): void {
    if (soundscapeAudioLevel() <= 0.001) return;
    if (!this.#noise) this.#ensure();
    const bus = audioEngine.bus("world", 7);
    const noise = this.#noise;
    if (!bus || !noise || strength <= 0.01) return;
    const { ctx, input } = bus;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.35 + hash01(this.#timeouts.size + 9, 83) * 0.16;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 260;
    lowpass.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, strength * 0.62), now + 0.09);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 5.5);
    source.connect(lowpass).connect(gain).connect(input);
    source.start(now);
    source.stop(now + 5.6);
    source.addEventListener("ended", () => {
      source.disconnect();
      lowpass.disconnect();
      gain.disconnect();
    }, { once: true });
  }
}

/** First-rain-lazy visual and procedural-audio presentation. */
export class WeatherEffects {
  #scene: THREE.Scene;
  #group = new THREE.Group();
  #geometry: THREE.BufferGeometry;
  #material: THREE.LineBasicMaterial;
  #positions = new Float32Array(DROP_COUNT * 6);
  #x = new Float32Array(DROP_COUNT);
  #y = new Float32Array(DROP_COUNT);
  #z = new Float32Array(DROP_COUNT);
  #speed = new Float32Array(DROP_COUNT);
  #audio = new WeatherAudio();
  #flash: HTMLDivElement;
  #lastLightning = 0;
  #visibleRain = 0;

  get debugState() {
    return {
      drops: DROP_COUNT,
      visibleRain: +this.#visibleRain.toFixed(3),
      audio: this.#audio.active,
      lightning: +this.#lastLightning.toFixed(3)
    };
  }

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    this.#group.name = "living_weather_rain";
    for (let i = 0; i < DROP_COUNT; i++) {
      const angle = hash01(i, 11) * Math.PI * 2;
      const radius = Math.sqrt(hash01(i, 19)) * FIELD_RADIUS;
      this.#x[i] = Math.cos(angle) * radius;
      this.#z[i] = Math.sin(angle) * radius;
      this.#y[i] = hash01(i, 29) * FIELD_HEIGHT - 5;
      this.#speed[i] = 16 + hash01(i, 41) * 22;
    }
    this.#geometry = new THREE.BufferGeometry();
    this.#geometry.setAttribute("position", new THREE.BufferAttribute(this.#positions, 3));
    this.#material = new THREE.LineBasicMaterial({
      color: 0xa9d8eb,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
    const rain = new THREE.LineSegments(this.#geometry, this.#material);
    rain.frustumCulled = false;
    rain.renderOrder = 20;
    this.#group.add(rain);
    this.#group.visible = false;
    scene.add(this.#group);

    this.#flash = document.createElement("div");
    this.#flash.dataset.weatherFlash = "";
    Object.assign(this.#flash.style, {
      position: "fixed",
      inset: "0",
      zIndex: "18",
      pointerEvents: "none",
      background: "rgba(205,225,255,1)",
      mixBlendMode: "screen",
      opacity: "0",
      transition: "opacity 70ms linear"
    });
    document.body.appendChild(this.#flash);
  }

  update(dt: number, state: Readonly<WeatherState>, camera: THREE.Camera, indoor: boolean): void {
    const outside = indoor ? 0.07 : 1;
    this.#visibleRain = state.rain * outside;
    this.#group.visible = this.#visibleRain > 0.008;
    this.#material.opacity = Math.min(0.7, Math.pow(this.#visibleRain, 0.72) * 0.62);
    if (this.#group.visible) {
      this.#group.position.copy(camera.position);
      const slant = 0.17 + state.wind * 0.42;
      for (let i = 0; i < DROP_COUNT; i++) {
        let y = this.#y[i] - this.#speed[i] * dt * (0.55 + state.rain * 0.8);
        if (y < -7) y += FIELD_HEIGHT;
        this.#y[i] = y;
        const length = 0.55 + state.rain * 1.45 + this.#speed[i] * 0.015;
        const offset = i * 6;
        this.#positions[offset] = this.#x[i];
        this.#positions[offset + 1] = y;
        this.#positions[offset + 2] = this.#z[i];
        this.#positions[offset + 3] = this.#x[i] + slant;
        this.#positions[offset + 4] = y - length;
        this.#positions[offset + 5] = this.#z[i] + slant * 0.35;
      }
      (this.#geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }

    const lightningEdge = state.lightning > 0.55 && this.#lastLightning <= 0.55;
    this.#flash.style.opacity = String(Math.min(0.72, state.lightning * outside * 0.68));
    if (lightningEdge) this.#audio.thunder(state.storm, indoor);
    this.#lastLightning = state.lightning;
    this.#audio.update(state.rain, state.storm, indoor);
  }

  dispose(): void {
    this.#audio.dispose();
    this.#scene.remove(this.#group);
    this.#geometry.dispose();
    this.#material.dispose();
    this.#flash.remove();
  }
}
