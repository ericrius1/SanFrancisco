// Local bird life for the Beach Pianist grove. Forty-two low-poly coastal
// silhouettes share one geometry, one material and one draw call; all paths,
// climb/pitch, turn banking, burst/glide wing beats AND the perch cycle
// (cruise → glide in → sit on a real grove crown → take off) are evaluated in
// the WebGPU vertex stage from static instance data. The perch crowns double
// as the positions for sparse procedural tree chirps on the shared World
// audio bus.

import * as THREE from "three/webgpu";
import { audioEngine } from "../../audio/engine";
import { VOICE_LIB, type NatureVoiceKind } from "../../audio/voices";
import { createPianoGroveBirdMaterial } from "./birdMaterial";

const CANOPY_FLYERS = 10;
const DISTANT_FLYERS = 20;
const PERCH_CYCLERS = 12;
const COUNT = CANOPY_FLYERS + DISTANT_FLYERS + PERCH_CYCLERS;
const CHIRP_RADIUS = 105;

/** Marks an instance that never enters the perch segment (flyEnd beyond the
 *  cycle's [0,1) phase range keeps the landing weight identically zero). */
const ALWAYS_FLY = 2;

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

  // Broad swept wings are single, double-sided feather planes. The side marker
  // lets the GPU rotate each complete wing rigidly around its root; the retained
  // root-to-tip value is used only for a restrained feather value break.
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
  // Deliberately NO normal attribute: the flat-tinted basic material never
  // shades, and the freed vertex-buffer slot keeps the six instanced streams
  // within WebGPU's 8-buffer limit (exceeding it silently kills the draw).
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

type InstanceSpec = {
  /** Orbit centre in site-local space (instance matrix translation). */
  center: { x: number; y: number; z: number };
  /** Loose-orbit half sizes (m) and base angular speed (rad/s). */
  radiusX: number;
  radiusZ: number;
  angularSpeed: number;
  phase: number;
  scale: number;
  verticalWander: number;
  flapRate: number;
  flapAmplitude: number;
  /** Perch cycle: seconds per full cycle, fly fraction (ALWAYS_FLY disables). */
  cyclePeriod: number;
  flyEnd: number;
  cyclePhase: number;
  /** Landing point relative to the orbit centre + settled facing. */
  perchOffset: { x: number; y: number; z: number };
  perchYaw: number;
  tint: THREE.Color;
};

export class PianoGroveBirds {
  readonly group = new THREE.Group();
  #mesh: THREE.InstancedMesh;
  #material: THREE.MeshBasicNodeMaterial;
  #geometry: THREE.BufferGeometry;
  #perches: THREE.Vector3[] = [];
  #audio = new PianoGroveBirdAudio();
  #enabled = true;
  #attributes: THREE.InstancedBufferAttribute[] = [];
  #centers: Float32Array;
  #motion: Float32Array;
  #style: Float32Array;
  #cycle: Float32Array;
  #perch: Float32Array;
  #tints: Float32Array;

  /**
   * `perches` are crown landing points in SITE-LOCAL space (already transformed
   * out of world space by the caller). Without any — vegetation missing or an
   * all-water ring — the cyclers gracefully stay airborne and chirps fall back
   * to canopy-height anchor points.
   */
  constructor(perches: { position: THREE.Vector3; yaw: number }[] = []) {
    this.group.name = "beachPianist.birds";
    this.#centers = new Float32Array(COUNT * 3);
    this.#motion = new Float32Array(COUNT * 4);
    this.#style = new Float32Array(COUNT * 4);
    this.#cycle = new Float32Array(COUNT * 4);
    this.#perch = new Float32Array(COUNT * 4);
    this.#tints = new Float32Array(COUNT * 3);
    const center = new THREE.InstancedBufferAttribute(this.#centers, 3);
    const motion = new THREE.InstancedBufferAttribute(this.#motion, 4);
    const style = new THREE.InstancedBufferAttribute(this.#style, 4);
    const cycle = new THREE.InstancedBufferAttribute(this.#cycle, 4);
    const perch = new THREE.InstancedBufferAttribute(this.#perch, 4);
    const tint = new THREE.InstancedBufferAttribute(this.#tints, 3);
    for (const attributeBuffer of [center, motion, style, cycle, perch, tint]) {
      attributeBuffer.setUsage(THREE.StaticDrawUsage);
    }
    this.#attributes = [center, motion, style, cycle, perch];

    this.#geometry = createBirdGeometry();
    this.#material = createPianoGroveBirdMaterial({ center, motion, style, cycle, perch, tint });
    this.#mesh = new THREE.InstancedMesh(this.#geometry, this.#material, COUNT);
    this.#mesh.name = "beachPianist.birds.oneDraw";
    this.#mesh.castShadow = false;
    this.#mesh.receiveShadow = false;
    // Vertex-stage orbits extend well beyond the static geometry bounds. The
    // parent site's 260/300 m gate is the single, cheaper culling decision.
    this.#mesh.frustumCulled = false;
    // Instance matrices stay IDENTITY: r185 applies them to positionLocal
    // before the custom positionNode, so any translation here would be
    // scaled/rotated by the flight frame. Centres live in the attribute.
    this.#mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const palette = [0x34383a, 0x403832, 0x2b3034, 0x46413a, 0x30383b] as const;
    const color = new THREE.Color();
    let slot = 0;

    // Lively canopy circuits directly over the grove. Tangential speed is what
    // separates "flying" from "hovering": radius × angular speed lands in the
    // 4–9 m/s small-bird cruise band, with the wander a clear subordinate.
    for (let i = 0; i < CANOPY_FLYERS; i++, slot++) {
      const centerAngle = hash(i, 11) * Math.PI * 2;
      const centerRadius = 5 + hash(i, 17) * 17;
      this.#writeInstance(slot, {
        center: {
          x: Math.cos(centerAngle) * centerRadius,
          y: 12 + hash(i, 23) * 7,
          z: Math.sin(centerAngle) * centerRadius
        },
        radiusX: 7 + hash(i, 29) * 7,
        radiusZ: 6 + hash(i, 31) * 6,
        angularSpeed: 0.42 + hash(i, 37) * 0.3,
        phase: hash(i, 41) * Math.PI * 2,
        scale: 0.55 + hash(i, 43) * 0.16,
        verticalWander: 1 + hash(i, 47) * 1.2,
        flapRate: 19 + hash(i, 53) * 8,
        flapAmplitude: 0.66 + hash(i, 59) * 0.18,
        cyclePeriod: 30,
        flyEnd: ALWAYS_FLY,
        cyclePhase: hash(i, 61),
        perchOffset: { x: 0, y: 0, z: 0 },
        perchYaw: 0,
        tint: color.setHex(palette[i % palette.length])
      });
    }

    // Slow, slightly enlarged silhouettes occupy the bridge/sky depth. Their
    // broad ellipses keep the background alive without additional LOD meshes.
    for (let i = 0; i < DISTANT_FLYERS; i++, slot++) {
      const centerAngle = hash(i, 67) * Math.PI * 2;
      const centerRadius = 34 + hash(i, 71) * 62;
      this.#writeInstance(slot, {
        center: {
          x: Math.cos(centerAngle) * centerRadius,
          y: 17 + hash(i, 73) * 22,
          z: Math.sin(centerAngle) * centerRadius
        },
        radiusX: 13 + hash(i, 79) * 16,
        radiusZ: 11 + hash(i, 83) * 15,
        angularSpeed: 0.2 + hash(i, 89) * 0.22,
        phase: hash(i, 97) * Math.PI * 2,
        scale: 0.67 + hash(i, 101) * 0.35,
        verticalWander: 1.4 + hash(i, 103) * 1.8,
        flapRate: 13 + hash(i, 107) * 6,
        flapAmplitude: 0.5 + hash(i, 109) * 0.2,
        cyclePeriod: 30,
        flyEnd: ALWAYS_FLY,
        cyclePhase: hash(i, 113),
        perchOffset: { x: 0, y: 0, z: 0 },
        perchYaw: 0,
        tint: color.setHex(palette[(i + 2) % palette.length])
      });
    }

    // Perch cyclers: each owns a real grove crown and endlessly cycles
    // cruise → glide in → settle → take off, staggered so a few birds are
    // always sitting in the trees while others wheel overhead.
    for (let i = 0; i < PERCH_CYCLERS; i++, slot++) {
      const perchSource = perches.length > 0 ? perches[i % perches.length] : null;
      // When crowns are shared, a per-bird lateral nudge keeps two silhouettes
      // from ever settling into the same triangle of canopy.
      const perchPosition = perchSource
        ? perchSource.position
            .clone()
            .add(
              new THREE.Vector3((hash(i, 227) - 0.5) * 0.9, 0, (hash(i, 229) - 0.5) * 0.9)
            )
        : null;
      const offsetAngle = hash(i, 127) * Math.PI * 2;
      const offsetRadius = 3.5 + hash(i, 131) * 4.5;
      const center = perchPosition
        ? {
            x: perchPosition.x + Math.cos(offsetAngle) * offsetRadius,
            y: perchPosition.y + 4 + hash(i, 137) * 3,
            z: perchPosition.z + Math.sin(offsetAngle) * offsetRadius
          }
        : {
            x: Math.cos(offsetAngle) * (13 + hash(i, 139) * 14),
            y: 11 + hash(i, 137) * 5,
            z: Math.sin(offsetAngle) * (13 + hash(i, 139) * 14)
          };
      if (perchPosition) this.#perches.push(perchPosition);
      const period = 24 + hash(i, 149) * 18;
      this.#writeInstance(slot, {
        center,
        radiusX: 6 + hash(i, 151) * 5,
        radiusZ: 5 + hash(i, 157) * 5,
        angularSpeed: 0.5 + hash(i, 163) * 0.3,
        phase: hash(i, 167) * Math.PI * 2,
        scale: 0.5 + hash(i, 173) * 0.15,
        verticalWander: 0.8 + hash(i, 179) * 0.8,
        flapRate: 20 + hash(i, 181) * 8,
        flapAmplitude: 0.68 + hash(i, 191) * 0.16,
        cyclePeriod: period,
        // Airborne fallback when the grove has no crowns to land on.
        flyEnd: perchPosition ? 0.52 + hash(i, 193) * 0.18 : ALWAYS_FLY,
        cyclePhase: hash(i, 197),
        perchOffset: perchPosition
          ? {
              x: perchPosition.x - center.x,
              y: perchPosition.y - center.y,
              z: perchPosition.z - center.z
            }
          : { x: 0, y: 0, z: 0 },
        perchYaw: perchSource?.yaw ?? 0,
        tint: color.setHex(palette[(i + 1) % palette.length])
      });
    }

    // Chirp anchors survive a perchless grove: fall back to canopy-height ring
    // points so the audio layer never divides by a zero perch count.
    if (this.#perches.length === 0) {
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + (hash(i, 199) - 0.5) * 0.48;
        const radius = 13 + hash(i, 211) * 14;
        this.#perches.push(
          new THREE.Vector3(Math.cos(angle) * radius, 7.4 + hash(i, 223) * 4.6, Math.sin(angle) * radius)
        );
      }
    }

    this.group.add(this.#mesh);
  }

  #writeInstance(slot: number, spec: InstanceSpec): void {
    this.#centers.set([spec.center.x, spec.center.y, spec.center.z], slot * 3);
    this.#motion.set([spec.radiusX, spec.radiusZ, spec.angularSpeed, spec.phase], slot * 4);
    this.#style.set([spec.scale, spec.verticalWander, spec.flapRate, spec.flapAmplitude], slot * 4);
    this.#cycle.set(
      [
        1 / Math.max(1, spec.cyclePeriod),
        spec.flyEnd,
        spec.cyclePhase,
        // Transition width in cycle phase: ~3 s of glide-in/take-off.
        Math.min(0.2, 3 / Math.max(1, spec.cyclePeriod))
      ],
      slot * 4
    );
    this.#perch.set(
      [spec.perchOffset.x, spec.perchOffset.y, spec.perchOffset.z, spec.perchYaw],
      slot * 4
    );
    spec.tint.toArray(this.#tints, slot * 3);
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

  /** Site-local crown landing points (QA surface for probes). */
  get perchPoints(): readonly THREE.Vector3[] {
    return this.#perches;
  }

  /** Raw per-instance data (QA surface for probes; do not mutate). */
  get instanceData() {
    return {
      center: this.#centers,
      motion: this.#motion,
      style: this.#style,
      cycle: this.#cycle,
      perch: this.#perch
    };
  }

  /** QA-only: clone one slot's flight data into every instance so probes can
   *  observe a single behaviour with 42× visibility. Irreversible until the
   *  site reloads; never call outside headless verification. */
  debugCloneSlot(source: number): void {
    for (let slot = 0; slot < COUNT; slot++) {
      if (slot === source) continue;
      this.#centers.copyWithin(slot * 3, source * 3, source * 3 + 3);
      for (const array of [this.#motion, this.#style, this.#cycle, this.#perch]) {
        array.copyWithin(slot * 4, source * 4, source * 4 + 4);
      }
    }
    for (const attributeBuffer of this.#attributes) attributeBuffer.needsUpdate = true;
  }

  get debugState() {
    return {
      instances: COUNT,
      canopyFlyers: CANOPY_FLYERS,
      distantFlyers: DISTANT_FLYERS,
      perchCyclers: PERCH_CYCLERS,
      perchPoints: this.#perches.length,
      drawCalls: 1,
      gpuAnimated: true,
      flightModel: "banked-harmonic-perch-cycle",
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
