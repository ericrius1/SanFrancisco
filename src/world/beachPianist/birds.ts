// Local bird life for the Beach Pianist grove. Forty-two low-poly coastal
// silhouettes share one geometry, one material and one draw call; all paths,
// headings and wing beats are evaluated in the WebGPU vertex stage from static
// instance data. Six stationary instances sit at canopy height and provide the
// positions for sparse procedural tree chirps on the shared World audio bus.

import * as THREE from "three/webgpu";
import { audioEngine } from "../../audio/engine";
import { VOICE_LIB, type NatureVoiceKind } from "../../audio/voices";
import { createPianoGroveBirdMaterial } from "./birdMaterial";

const CANOPY_FLYERS = 12;
const DISTANT_FLYERS = 24;
const PERCHED = 6;
const COUNT = CANOPY_FLYERS + DISTANT_FLYERS + PERCHED;
const CHIRP_RADIUS = 105;

type Vertex = {
  x: number;
  y: number;
  z: number;
  wingSide?: number;
  wingWeight?: number;
};

type ActiveCall = {
  ctx: AudioContext;
  panner: PannerNode;
  expires: number;
};

function hash(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** A faceted, tapered songbird/corvid silhouette with swept feather planes. */
function createBirdGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const wingData: number[] = [];
  const push = (v: Vertex) => {
    positions.push(v.x, v.y, v.z);
    wingData.push(v.wingSide ?? 0, v.wingWeight ?? 0);
  };
  const triangle = (a: Vertex, b: Vertex, c: Vertex) => {
    push(a);
    push(b);
    push(c);
  };

  // Six-sided cross sections give the body enough changing planes to catch a
  // rim without turning these sub-metre background animals into smooth toys.
  const sections = [
    { z: -0.27, rx: 0.035, ry: 0.03 },
    { z: -0.13, rx: 0.082, ry: 0.064 },
    { z: 0.06, rx: 0.108, ry: 0.084 },
    { z: 0.2, rx: 0.072, ry: 0.064 },
    { z: 0.29, rx: 0.042, ry: 0.04 }
  ] as const;
  const ring = sections.map((section) =>
    Array.from({ length: 6 }, (_, i): Vertex => {
      const a = (i / 6) * Math.PI * 2;
      return { x: Math.cos(a) * section.rx, y: Math.sin(a) * section.ry, z: section.z };
    })
  );
  for (let s = 0; s < ring.length - 1; s++) {
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      triangle(ring[s][i], ring[s + 1][i], ring[s][j]);
      triangle(ring[s][j], ring[s + 1][i], ring[s + 1][j]);
    }
  }
  const tailCenter = { x: 0, y: 0, z: -0.18 };
  triangle(tailCenter, { x: -0.115, y: -0.012, z: -0.47 }, { x: -0.012, y: 0.008, z: -0.29 });
  triangle(tailCenter, { x: 0.012, y: 0.008, z: -0.29 }, { x: 0.115, y: -0.012, z: -0.47 });

  // Small tetrahedral beak, just enough to keep the forward silhouette legible.
  const beakTip = { x: 0, y: -0.004, z: 0.395 };
  const beakTop = { x: 0, y: 0.032, z: 0.286 };
  const beakLeft = { x: -0.035, y: -0.014, z: 0.286 };
  const beakRight = { x: 0.035, y: -0.014, z: 0.286 };
  triangle(beakTop, beakLeft, beakTip);
  triangle(beakRight, beakTop, beakTip);
  triangle(beakLeft, beakRight, beakTip);

  // Broad swept wings are single, double-sided feather planes. Root-to-tip
  // weights feed the GPU deformation while the three panels preserve a subtle
  // articulated leading/trailing edge instead of a cartoon chevron.
  for (const side of [-1, 1] as const) {
    const rootFront = { x: side * 0.045, y: 0.018, z: 0.13, wingSide: side, wingWeight: 0 };
    const rootRear = { x: side * 0.055, y: -0.002, z: -0.12, wingSide: side, wingWeight: 0 };
    const midFront = { x: side * 0.31, y: 0.012, z: 0.1, wingSide: side, wingWeight: 0.52 };
    const rearMid = { x: side * 0.34, y: -0.015, z: -0.19, wingSide: side, wingWeight: 0.62 };
    const tip = { x: side * 0.61, y: -0.005, z: -0.075, wingSide: side, wingWeight: 1 };
    if (side < 0) {
      triangle(rootFront, rootRear, midFront);
      triangle(midFront, rootRear, rearMid);
      triangle(midFront, rearMid, tip);
    } else {
      triangle(rootFront, midFront, rootRear);
      triangle(midFront, rearMid, rootRear);
      triangle(midFront, tip, rearMid);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("birdWing", new THREE.Float32BufferAttribute(wingData, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.name = "beachPianist.birds.geometry";
  return geometry;
}

class PianoGroveBirdAudio {
  #timer = 2.4;
  #seed = 0x51f15e;
  #noise: AudioBuffer | null = null;
  #ctx: AudioContext | null = null;
  #calls: ActiveCall[] = [];
  #enabled = true;
  #voiceCount = 0;

  #random(): number {
    // xorshift32: repeatable enough to avoid a synchronized first call after
    // every site reload without keeping a global/randomized scheduler alive.
    let x = this.#seed | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#seed = x >>> 0;
    return this.#seed / 0x1_0000_0000;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.#clearCalls();
  }

  update(
    dt: number,
    distance: number,
    gust: number,
    active: boolean,
    perchCount: number,
    worldPosition: (index: number, out: THREE.Vector3) => THREE.Vector3
  ): void {
    const ctx = this.#ctx;
    if (ctx) this.#reap(ctx.currentTime);
    if (!this.#enabled || !active || distance > CHIRP_RADIUS || perchCount === 0) {
      this.#timer = Math.max(this.#timer, 0.8);
      return;
    }

    // Coastal gusts quiet the canopy instead of letting procedural calls fight
    // the wind and piano. The timer still advances gently so calm gaps feel alive.
    const shelter = 1 - Math.min(0.82, Math.max(0, gust) * 0.72);
    this.#timer -= Math.min(dt, 0.1) * shelter;
    if (this.#timer > 0) return;

    const bus = audioEngine.bus("world", 0.25);
    if (!bus || bus.ctx.state !== "running") {
      this.#timer = 0.5;
      return;
    }
    this.#ctx = bus.ctx;
    this.#noise ??= bus.ctx.createBuffer(1, 1, bus.ctx.sampleRate);

    const first = Math.floor(this.#random() * perchCount) % perchCount;
    const firstKind: NatureVoiceKind = this.#random() < 0.44 ? "sparrow" : "songbird";
    const now = bus.ctx.currentTime + 0.02;
    const firstDuration = this.#spawn(bus.ctx, bus.input, worldPosition(first, _audioPosition), now, firstKind);
    let tail = firstDuration;

    // Occasional quiet answer from another tree gives the grove depth without
    // turning the performance area into a constant dawn chorus.
    if (this.#random() < 0.28) {
      const second = (first + 1 + Math.floor(this.#random() * (perchCount - 1))) % perchCount;
      const delay = 0.48 + this.#random() * 0.58;
      const duration = this.#spawn(
        bus.ctx,
        bus.input,
        worldPosition(second, _audioAnswerPosition),
        now + delay,
        this.#random() < 0.55 ? "sparrow" : "songbird"
      );
      tail = Math.max(tail, delay + duration);
    }
    audioEngine.touch(tail + 0.7);
    this.#timer = 4.8 + this.#random() * 7.6;
  }

  #spawn(
    ctx: AudioContext,
    output: AudioNode,
    position: THREE.Vector3,
    at: number,
    kind: NatureVoiceKind
  ): number {
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 7;
    panner.rolloffFactor = 1;
    panner.maxDistance = 95;
    setPannerPosition(panner, ctx, position.x, position.y, position.z);
    panner.connect(output);
    const duration = VOICE_LIB[kind]({
      ctx,
      out: panner,
      t0: at,
      noise: this.#noise!,
      rng: () => this.#random(),
      level: 0.2
    });
    this.#calls.push({ ctx, panner, expires: at + duration + 0.3 });
    this.#voiceCount++;
    return duration;
  }

  #reap(now: number): void {
    for (let i = this.#calls.length - 1; i >= 0; i--) {
      if (this.#calls[i].expires > now) continue;
      this.#calls[i].panner.disconnect();
      this.#calls.splice(i, 1);
    }
  }

  #clearCalls(): void {
    for (const call of this.#calls) call.panner.disconnect();
    this.#calls.length = 0;
  }

  get debugState() {
    return {
      activeCalls: this.#calls.length,
      voiceCount: this.#voiceCount,
      nextCallSec: +this.#timer.toFixed(2),
      context: this.#ctx?.state ?? "none"
    };
  }

  dispose(): void {
    this.#enabled = false;
    this.#clearCalls();
    this.#ctx = null;
    this.#noise = null;
  }
}

const _audioPosition = new THREE.Vector3();
const _audioAnswerPosition = new THREE.Vector3();

function setPannerPosition(
  panner: PannerNode,
  ctx: AudioContext,
  x: number,
  y: number,
  z: number
): void {
  if (panner.positionX) {
    panner.positionX.setValueAtTime(x, ctx.currentTime);
    panner.positionY.setValueAtTime(y, ctx.currentTime);
    panner.positionZ.setValueAtTime(z, ctx.currentTime);
  } else {
    panner.setPosition(x, y, z);
  }
}

export class PianoGroveBirds {
  readonly group = new THREE.Group();
  #mesh: THREE.InstancedMesh;
  #material: THREE.MeshBasicNodeMaterial;
  #geometry: THREE.BufferGeometry;
  #perches: THREE.Vector3[] = [];
  #audio = new PianoGroveBirdAudio();
  #enabled = true;
  #matrix = new THREE.Matrix4();

  constructor() {
    this.group.name = "beachPianist.birds";
    const motionArray = new Float32Array(COUNT * 4);
    const styleArray = new Float32Array(COUNT * 4);
    const tintArray = new Float32Array(COUNT * 3);
    const motion = new THREE.InstancedBufferAttribute(motionArray, 4);
    const style = new THREE.InstancedBufferAttribute(styleArray, 4);
    const tint = new THREE.InstancedBufferAttribute(tintArray, 3);
    motion.setUsage(THREE.StaticDrawUsage);
    style.setUsage(THREE.StaticDrawUsage);
    tint.setUsage(THREE.StaticDrawUsage);

    this.#geometry = createBirdGeometry();
    this.#material = createPianoGroveBirdMaterial({ motion, style, tint });
    this.#mesh = new THREE.InstancedMesh(this.#geometry, this.#material, COUNT);
    this.#mesh.name = "beachPianist.birds.oneDraw";
    this.#mesh.castShadow = false;
    this.#mesh.receiveShadow = false;
    // Vertex-stage orbits extend well beyond the static geometry bounds. The
    // parent site's 260/300 m gate is the single, cheaper culling decision.
    this.#mesh.frustumCulled = false;
    this.#mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const palette = [0x34383a, 0x403832, 0x2b3034, 0x46413a, 0x30383b] as const;
    const color = new THREE.Color();
    let slot = 0;

    for (let i = 0; i < CANOPY_FLYERS; i++, slot++) {
      const centerAngle = hash(i, 11) * Math.PI * 2;
      const centerRadius = 4 + hash(i, 17) * 18;
      this.#writeInstance(
        slot,
        Math.cos(centerAngle) * centerRadius,
        11.5 + hash(i, 23) * 7.5,
        Math.sin(centerAngle) * centerRadius,
        5 + hash(i, 29) * 8,
        4 + hash(i, 31) * 7,
        0.18 + hash(i, 37) * 0.2,
        hash(i, 41) * Math.PI * 2,
        0.58 + hash(i, 43) * 0.2,
        0.7 + hash(i, 47) * 1.15,
        5.2 + hash(i, 53) * 2.4,
        0.68 + hash(i, 59) * 0.2,
        color.setHex(palette[i % palette.length]),
        motionArray,
        styleArray,
        tintArray
      );
    }

    // Twice as many slow, slightly enlarged silhouettes occupy the bridge/sky
    // depth. Their broad ellipses keep the background alive without requiring
    // additional LOD meshes or audio sources.
    for (let i = 0; i < DISTANT_FLYERS; i++, slot++) {
      const centerAngle = hash(i, 67) * Math.PI * 2;
      const centerRadius = 34 + hash(i, 71) * 62;
      this.#writeInstance(
        slot,
        Math.cos(centerAngle) * centerRadius,
        17 + hash(i, 73) * 22,
        Math.sin(centerAngle) * centerRadius,
        11 + hash(i, 79) * 18,
        9 + hash(i, 83) * 17,
        0.075 + hash(i, 89) * 0.09,
        hash(i, 97) * Math.PI * 2,
        0.67 + hash(i, 101) * 0.35,
        1.5 + hash(i, 103) * 3.2,
        3.7 + hash(i, 107) * 1.8,
        0.46 + hash(i, 109) * 0.2,
        color.setHex(palette[(i + 2) % palette.length]),
        motionArray,
        styleArray,
        tintArray
      );
    }

    // Fixed canopy-height silhouettes double as spatial-audio anchors. Tiny
    // non-zero radii keep the shader tangent finite; zero speed makes them read
    // as settled birds rather than hovering flyers.
    for (let i = 0; i < PERCHED; i++, slot++) {
      const angle = (i / PERCHED) * Math.PI * 2 + (hash(i, 113) - 0.5) * 0.48;
      const radius = 13 + hash(i, 127) * 14;
      const x = Math.cos(angle) * radius;
      const y = 7.4 + hash(i, 131) * 4.6;
      const z = Math.sin(angle) * radius;
      this.#perches.push(new THREE.Vector3(x, y, z));
      this.#writeInstance(
        slot,
        x,
        y,
        z,
        0.001,
        0.001,
        0,
        angle + Math.PI * 0.5,
        0.42 + hash(i, 137) * 0.1,
        0,
        1,
        0,
        color.setHex(palette[(i + 1) % palette.length]),
        motionArray,
        styleArray,
        tintArray
      );
    }

    this.#mesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.#mesh);
  }

  #writeInstance(
    slot: number,
    x: number,
    y: number,
    z: number,
    radiusX: number,
    radiusZ: number,
    angularSpeed: number,
    phase: number,
    scale: number,
    verticalWander: number,
    flapRate: number,
    flapAmplitude: number,
    tint: THREE.Color,
    motion: Float32Array,
    style: Float32Array,
    colors: Float32Array
  ): void {
    motion.set([radiusX, radiusZ, angularSpeed, phase], slot * 4);
    style.set([scale, verticalWander, flapRate, flapAmplitude], slot * 4);
    tint.toArray(colors, slot * 3);
    this.#matrix.makeTranslation(x, y, z);
    this.#mesh?.setMatrixAt(slot, this.#matrix);
  }

  #worldPerch = (index: number, out: THREE.Vector3): THREE.Vector3 => {
    out.copy(this.#perches[index]);
    return this.group.localToWorld(out);
  };

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.group.visible = enabled;
    this.#audio.setEnabled(enabled);
  }

  update(dt: number, distance: number, gust: number, active: boolean): void {
    const live = this.#enabled && active;
    this.group.visible = live;
    this.#audio.update(dt, distance, gust, live, this.#perches.length, this.#worldPerch);
  }

  get debugState() {
    return {
      instances: COUNT,
      canopyFlyers: CANOPY_FLYERS,
      distantFlyers: DISTANT_FLYERS,
      perched: PERCHED,
      drawCalls: 1,
      gpuAnimated: true,
      visible: this.group.visible,
      shadows: false,
      audio: this.#audio.debugState
    };
  }

  dispose(): void {
    this.#audio.dispose();
    this.group.removeFromParent();
    this.#geometry.dispose();
    this.#material.dispose();
    this.group.clear();
  }
}
