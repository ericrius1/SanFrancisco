import * as THREE from "three/webgpu";
import { uniform, uv, smoothstep } from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { effectsAudioLevel } from "../core/audioSettings";

type N = any;

const POOL = 12;
const DURATION = 1.4;

// C major pentatonic across three octaves — every combination sounds fine
const SEMIS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33];
const BASE_HZ = 220; // A3

type Ring = {
  mesh: THREE.Mesh;
  prog: ReturnType<typeof uniform>;
  tint: ReturnType<typeof uniform>;
  maxR: number;
  active: boolean;
};

/**
 * Wind chimes: click a surface and it answers — an expanding ring lies flat on
 * whatever was struck (walls get vertical hoops) and a synth pluck plays, its
 * pitch keyed to the strike height so the skyline plays like a xylophone.
 * Pan follows the strike's bearing off the camera heading.
 */
export class Chimes {
  #rings: Ring[] = [];
  #next = 0;
  #audio = new ChimeAudio();
  #quat = new THREE.Quaternion();
  #zAxis = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(2, 2); // ring drawn procedurally in uv space
    for (let i = 0; i < POOL; i++) {
      const prog = uniform(0);
      const tint = uniform(new THREE.Color(0xffffff));
      const mat = new THREE.MeshBasicNodeMaterial();

      const p = (uv() as N).mul(2).sub(1);
      const r = p.length();
      const pr = prog as N;
      // the ring sweeps outward; a fainter echo ring trails it
      const head = pr.mul(0.85).add(0.08);
      const ring = smoothstep(0.17, 0.0, r.sub(head).abs()).mul(1.4);
      const echo = smoothstep(0.09, 0.0, r.sub(head.mul(0.55)).abs()).mul(0.6);
      const glow = smoothstep(0.3, 0.0, r).mul(pr.oneMinus()).mul(0.35); // struck-point bloom
      mat.colorNode = (tint as N).mul(ring.add(echo).add(glow)).mul(pr.oneMinus().pow(1.4)).mul(LIGHT_SCALE * 1.1);
      mat.transparent = true;
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      mat.fog = false;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.#rings.push({ mesh, prog, tint, maxR: 8, active: false });
    }
  }

  /** Ring the surface at `point`. Pitch comes from height, pan from bearing vs camera yaw. */
  strike(point: THREE.Vector3, normal: THREE.Vector3, kind: "building" | "ground" | "water", camYaw: number, camPos: THREE.Vector3) {
    const s = this.#rings[this.#next];
    this.#next = (this.#next + 1) % POOL;

    // height → note: streets rumble low, towers sparkle high
    const idx = Math.max(0, Math.min(SEMIS.length - 1, Math.floor(((point.y + 6) / 210) * SEMIS.length)));
    const freq = BASE_HZ * Math.pow(2, SEMIS[idx] / 12);
    const hue = 0.52 + (idx / SEMIS.length) * 0.42; // teal streets → violet-pink towers

    s.active = true;
    s.prog.value = 0;
    (s.tint.value as THREE.Color).setHSL(hue % 1, 0.85, 0.62);
    s.maxR = kind === "water" ? 13 : kind === "building" ? 7 : 10;
    // walls are true planes; terrain normals are 4m-smoothed, so a flush ring
    // would sink into the bumps — float ground rings well clear
    s.mesh.position.copy(point).addScaledVector(normal, kind === "building" ? 0.15 : 0.6);
    this.#quat.setFromUnitVectors(this.#zAxis, normal);
    s.mesh.quaternion.copy(this.#quat);
    s.mesh.scale.setScalar(0.01);
    s.mesh.visible = true;

    // stereo: which side of the view the strike landed on
    const bearing = Math.atan2(point.x - camPos.x, point.z - camPos.z);
    let rel = bearing - (camYaw + Math.PI); // camera looks along -z of its yaw frame
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const dist = point.distanceTo(camPos);
    this.#audio.pluck(freq, Math.sin(rel) * 0.75, Math.max(0.25, 1 - dist / 400), kind === "water");
  }

  update(dt: number) {
    for (const s of this.#rings) {
      if (!s.active) continue;
      s.prog.value = Math.min(1, (s.prog.value as number) + dt / DURATION);
      const p = s.prog.value as number;
      const ease = 1 - (1 - p) ** 3;
      s.mesh.scale.setScalar(Math.max(0.01, s.maxR * ease));
      if (p >= 1) {
        s.active = false;
        s.mesh.visible = false;
      }
    }
  }
}

/** Tiny synth: sine pluck + soft octave partial, exponential decay, stereo pan. */
class ChimeAudio {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    this.#ctx = new AudioContext();
    const limiter = this.#ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 6;
    limiter.connect(this.#ctx.destination);
    this.#master = this.#ctx.createGain();
    this.#master.gain.value = 0.5;
    this.#master.connect(limiter);
    return this.#ctx;
  }

  pluck(freq: number, pan: number, gain: number, deep: boolean) {
    const master = effectsAudioLevel(); // HUD effects volume slider
    if (master <= 0) return;
    const ctx = this.#ensure();
    if (!ctx || !this.#master) return;
    // the strike itself is a user gesture, so resume always succeeds here
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const dur = deep ? 2.6 : 1.8;

    const out = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner);
    panner.connect(this.#master);

    const env = out.gain;
    env.setValueAtTime(0, t);
    env.linearRampToValueAtTime(0.32 * gain * master, t + 0.006);
    env.exponentialRampToValueAtTime(0.0008, t + dur);

    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.value = deep ? freq / 2 : freq;
    const o2 = ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = (deep ? freq / 2 : freq) * 2.004; // barely-sharp octave shimmer
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;
    o1.connect(out);
    o2.connect(g2);
    g2.connect(out);
    o1.start(t);
    o2.start(t);
    o1.stop(t + dur + 0.1);
    o2.stop(t + dur + 0.1);
  }
}
