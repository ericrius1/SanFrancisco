import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  clamp,
  color,
  cross,
  float,
  fract,
  mix,
  mx_noise_float,
  normalWorld,
  normalize,
  positionGeometry,
  positionWorld,
  smoothstep,
  time,
  uniform,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";

type N = any;

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Cosmic energy web — the fractal light-net the Afterlight keepers hold aloft.
 * ───────────────────────────────────────────────────────────────────────────
 * A ring of celebrants each pin a "main vein" from their hand to a shared hub
 * above the loom orb. Every main vein sheds two recursive levels of side
 * branches, so the silhouette reads as a detailed fractal energy map rather
 * than a handful of arcs. All of it is one connected Verlet mass-spring net:
 * hands and hub are pinned, everything between them is distance-constrained
 * rope, and cross-links near the hub couple neighbouring veins so that lifting
 * one arm pulls and ripples through the whole structure — cloth + rope feel,
 * no rigid-body sim (Verlet is the right tool for a soft, art-directed net; the
 * app's box3d world is for solid bodies).
 *
 * Rendering: veins are camera-facing additive ribbons (same trick as the sky-
 * whale's tail); the membrane stretched between the main veins uses the whale's
 * two-tone Fresnel look with a drifting mx_noise sheet so it glows at the rim
 * and stays translucent through the middle. Everything is Verlet-driven, so the
 * light and the cloth ripple together off the same node positions.
 */

const UP = new THREE.Vector3(0, 1, 0);

export const WEB_TUNING = {
  hubY: 3.15, // local height of the shared hub (floats above the loom orb)
  segments: 16, // hub→hand nodes per main vein (2× linear resolution)
  bow: 2.35, // upward arch of a slack main vein
  branchAt: [2, 4, 6, 8, 10, 12, 14] as number[],
  branchChildren: 3,
  branchNodes: 4,
  branchLen: 2.05,
  subBranchNodes: 3,
  subBranchLen: 1.18,
  fixedStep: 1 / 60,
  maxSubsteps: 6,
  iterations: 3, // short links converge quickly; keep the 4× topology affordable
  damping: 0.958, // equivalent persistence after moving the solve to 60 Hz
  driftAmp: 1.58, // cosmic curl + standing-wave force
  driftScale: 0.56,
  buoyancy: 0.3,
  homeSpring: 2.25,
  crossStiff: 0.43,
  shearStiff: 0.2,
  longStiff: 0.13,
  rippleImpulse: 1.12,
  chainStiff: 0.88,
  mainWidth: 0.105,
  tipWidth: 0.009,
  membraneInnerRow: 3,
  membraneAngular: 6,
  flowSpeed: 0.48,
  flowFreq: 3.4,
  baseEnergy: 0.46
};

type Chain = { nodes: number[]; level: number; phase: number };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CosmicWebOptions = {
  /** Bind-pose hand positions (site-local), one per anchored vein. */
  anchorInit: THREE.Vector3[];
  seed?: number;
};

/**
 * The Verlet net plus its two render surfaces. Positions live in the site's
 * local space; add {@link root} under the site root at the origin.
 */
export class CosmicEnergyWeb {
  readonly root = new THREE.Group();
  /** Per-anchor hand target (site-local); the site writes these each frame. */
  readonly anchorTargets: THREE.Vector3[] = [];

  #count: number;
  #hub: number;

  // Verlet state (structure-of-arrays; the step loop stays allocation-free).
  #px: Float32Array;
  #py: Float32Array;
  #pz: Float32Array;
  #ox: Float32Array;
  #oy: Float32Array;
  #oz: Float32Array;
  #hx: Float32Array; // home / rest position for sprung tips
  #hy: Float32Array;
  #hz: Float32Array;
  #pin: Uint8Array;
  #sprung: Uint8Array;
  #drift: Float32Array;
  #nodeCount = 0;

  #linkA: number[] = [];
  #linkB: number[] = [];
  #linkRest: number[] = [];
  #linkStiff: number[] = [];

  #anchorNode: number[] = []; // node index pinned to each hand
  #chains: Chain[] = [];
  #mainNodes: number[][] = []; // [anchor][row] node index along each main vein

  #energy = uniform(WEB_TUNING.baseEnergy);
  #ripple = uniform(0);
  #hubYUniform = uniform(WEB_TUNING.hubY);

  // Vein ribbon geometry (all chains merged into one dynamic mesh).
  #veinPos!: THREE.BufferAttribute;
  #veinDir!: THREE.BufferAttribute;
  #veinVertChains: { chain: Chain; offset: number }[] = [];

  // Membrane geometry (annulus stretched across the main veins).
  #memGeom!: THREE.BufferGeometry;
  #memPos!: THREE.BufferAttribute;
  #memBind: { a: number; b: number; row: number; u: number; angle: number; radial: number }[] = [];

  // Explicit knot layer: one compact dynamic points draw over every main-vein
  // joint. This makes the solver topology readable without raymarching dozens
  // of tiny spheres.
  #jointNodes: number[] = [];
  #jointPos!: THREE.BufferAttribute;

  #anchorPrevious: THREE.Vector3[] = [];
  #accumulator = 0;
  #strain = 0;

  #elapsed = 0;
  #renderFrame = 0;

  constructor(opts: CosmicWebOptions) {
    this.#count = opts.anchorInit.length;
    const rand = mulberry32((opts.seed ?? 1) * 2654435761);

    const cap = this.#estimateNodeCap();
    this.#px = new Float32Array(cap);
    this.#py = new Float32Array(cap);
    this.#pz = new Float32Array(cap);
    this.#ox = new Float32Array(cap);
    this.#oy = new Float32Array(cap);
    this.#oz = new Float32Array(cap);
    this.#hx = new Float32Array(cap);
    this.#hy = new Float32Array(cap);
    this.#hz = new Float32Array(cap);
    this.#pin = new Uint8Array(cap);
    this.#sprung = new Uint8Array(cap);
    this.#drift = new Float32Array(cap);

    const hubPos = new THREE.Vector3(0, WEB_TUNING.hubY, 0);
    this.#hub = this.#addNode(hubPos.x, hubPos.y, hubPos.z, { pin: true });

    for (let a = 0; a < this.#count; a++) {
      const hand = opts.anchorInit[a];
      this.anchorTargets.push(hand.clone());
      this.#anchorPrevious.push(hand.clone());
      this.#buildMainVein(a, hubPos, hand, rand);
    }
    this.#buildCrossLinks();
    this.#buildVeinGeometry();
    this.#buildMembrane();
    this.#buildJoints();
  }

  setEnergy(value: number): void {
    this.#energy.value = THREE.MathUtils.clamp(value, 0, 1.6);
  }

  update(dt: number, elapsed: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.#elapsed += step;
    this.#hubYUniform.value = WEB_TUNING.hubY + Math.sin(elapsed * 0.72) * 0.08;
    this.#injectAnchorMotion();
    this.#accumulator += step;
    let substeps = 0;
    while (this.#accumulator >= WEB_TUNING.fixedStep && substeps < WEB_TUNING.maxSubsteps) {
      this.#integrate(WEB_TUNING.fixedStep, this.#elapsed - this.#accumulator);
      for (let it = 0; it < WEB_TUNING.iterations; it++) {
        this.#solveLinks();
        this.#pinNodes();
      }
      this.#accumulator -= WEB_TUNING.fixedStep;
      substeps++;
    }
    if (substeps === WEB_TUNING.maxSubsteps) this.#accumulator = 0;
    this.#renderFrame++;
    if ((this.#renderFrame & 1) === 0) this.#measureStrain();
    const ambientRipple = 0.24 + this.#energy.value * 0.16 + (Math.sin(this.#elapsed * 1.7) * 0.5 + 0.5) * 0.12;
    this.#ripple.value = Math.max(
      ambientRipple,
      this.#strain * 9.5,
      this.#ripple.value * Math.exp(-step * 1.45)
    );
    this.#writeVeins();
    this.#writeMembrane();
    this.#writeJoints();
  }

  debugState(): {
    solver: "verlet";
    fixedStep: number;
    nodes: number;
    links: number;
    anchors: number;
    detailMultiplier: number;
    strain: number;
    ripple: number;
  } {
    return {
      solver: "verlet",
      fixedStep: WEB_TUNING.fixedStep,
      nodes: this.#nodeCount,
      links: this.#linkA.length,
      anchors: this.#count,
      detailMultiplier: this.#nodeCount / 533,
      strain: this.#strain,
      ripple: this.#ripple.value
    };
  }

  dispose(): void {
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh || (object as THREE.Points).isPoints) {
        mesh.geometry?.dispose();
        const material = mesh.material;
        const list = Array.isArray(material) ? material : [material];
        for (const item of list) item?.dispose();
      }
    });
    this.root.removeFromParent();
  }

  // ─────────────────────────────────────────────────────────── topology

  #estimateNodeCap(): number {
    const perBranch = WEB_TUNING.branchNodes + WEB_TUNING.subBranchNodes;
    const branchesPerVein = WEB_TUNING.branchAt.length * WEB_TUNING.branchChildren;
    const perVein = WEB_TUNING.segments + branchesPerVein * perBranch + 8;
    return 1 + this.#count * perVein + 16;
  }

  #addNode(x: number, y: number, z: number, o: { pin?: boolean; sprung?: boolean; drift?: number } = {}): number {
    const i = this.#nodeCount++;
    this.#px[i] = this.#ox[i] = this.#hx[i] = x;
    this.#py[i] = this.#oy[i] = this.#hy[i] = y;
    this.#pz[i] = this.#oz[i] = this.#hz[i] = z;
    this.#pin[i] = o.pin ? 1 : 0;
    this.#sprung[i] = o.sprung ? 1 : 0;
    this.#drift[i] = o.drift ?? 0.5;
    return i;
  }

  #addLink(a: number, b: number, stiff = WEB_TUNING.chainStiff): void {
    const dx = this.#px[a] - this.#px[b];
    const dy = this.#py[a] - this.#py[b];
    const dz = this.#pz[a] - this.#pz[b];
    this.#linkA.push(a);
    this.#linkB.push(b);
    this.#linkRest.push(Math.hypot(dx, dy, dz));
    this.#linkStiff.push(stiff);
  }

  #buildMainVein(a: number, hub: THREE.Vector3, hand: THREE.Vector3, rand: () => number): void {
    const seg = WEB_TUNING.segments;
    const rows: number[] = [this.#hub];
    let prev = this.#hub;
    const dir = new THREE.Vector3().subVectors(hand, hub);
    for (let k = 1; k <= seg; k++) {
      const t = k / seg;
      const x = hub.x + dir.x * t;
      const y = hub.y + dir.y * t + Math.sin(Math.PI * t) * WEB_TUNING.bow;
      const z = hub.z + dir.z * t;
      const isHand = k === seg;
      const idx = this.#addNode(x, y, z, { pin: isHand, drift: isHand ? 0 : 0.35 + t * 0.5 });
      this.#addLink(prev, idx, WEB_TUNING.chainStiff);
      rows.push(idx);
      prev = idx;
    }
    this.#anchorNode.push(prev);
    this.#mainNodes.push(rows);
    this.#chains.push({ nodes: rows.slice(), level: 0, phase: a / Math.max(1, this.#count) });

    // Fractal side branches off interior nodes.
    const veinDir = dir.clone().normalize();
    for (const bp of WEB_TUNING.branchAt) {
      if (bp < 1 || bp >= rows.length - 1) continue;
      const base = rows[bp];
      for (let c = 0; c < WEB_TUNING.branchChildren; c++) {
        this.#buildBranch(base, veinDir, WEB_TUNING.branchLen, WEB_TUNING.branchNodes, 1, a / Math.max(1, this.#count), rand);
      }
    }
  }

  #buildBranch(
    base: number,
    veinDir: THREE.Vector3,
    length: number,
    count: number,
    level: number,
    phase: number,
    rand: () => number
  ): void {
    // Direction roughly perpendicular to the vein, fanned + lifted, seeded.
    const side = new THREE.Vector3().crossVectors(veinDir, UP);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const spin = (rand() - 0.5) * Math.PI * 1.4;
    const lift = 0.35 + rand() * 0.7;
    const bdir = side
      .clone()
      .applyAxisAngle(veinDir, spin)
      .addScaledVector(UP, lift)
      .addScaledVector(veinDir, (rand() - 0.3) * 0.5)
      .normalize();

    const chain: number[] = [base];
    let prev = base;
    const bx = this.#px[base];
    const by = this.#py[base];
    const bz = this.#pz[base];
    const stepLen = length / count;
    let midNode = base;
    for (let k = 1; k <= count; k++) {
      const d = stepLen * k;
      const jitterA = (rand() - 0.5) * 0.25;
      const x = bx + bdir.x * d + side.x * jitterA;
      const y = by + bdir.y * d + Math.sin(k * 1.3) * 0.12;
      const z = bz + bdir.z * d + side.z * jitterA;
      const isTip = k === count;
      const idx = this.#addNode(x, y, z, { sprung: isTip, drift: 0.6 + level * 0.3 });
      this.#addLink(prev, idx, WEB_TUNING.chainStiff * (level === 1 ? 0.85 : 0.7));
      chain.push(idx);
      if (k === Math.max(1, count - 1)) midNode = idx;
      prev = idx;
    }
    const branchPhase = phase + (rand() - 0.5) * 0.16 + level * 0.07;
    this.#chains.push({ nodes: chain, level, phase: branchPhase });

    if (level === 1 && WEB_TUNING.subBranchNodes > 0) {
      this.#buildBranch(midNode, bdir, WEB_TUNING.subBranchLen, WEB_TUNING.subBranchNodes, 2, branchPhase, rand);
    }
  }

  #buildCrossLinks(): void {
    if (this.#count < 2) return;
    for (let a = 0; a < this.#count; a++) {
      const next = (a + 1) % this.#count;
      // Hoop constraints carry tension around the entire ring, while diagonal
      // shear links stop the membrane acting like disconnected radial ropes.
      for (let row = 1; row < WEB_TUNING.segments; row++) {
        const na = this.#mainNodes[a][row];
        const nb = this.#mainNodes[next][row];
        if (na != null && nb != null) this.#addLink(na, nb, WEB_TUNING.crossStiff);
        const naNext = this.#mainNodes[a][row + 1];
        const nbNext = this.#mainNodes[next][row + 1];
        if (na != null && nbNext != null) this.#addLink(na, nbNext, WEB_TUNING.shearStiff);
        if (naNext != null && nb != null) this.#addLink(naNext, nb, WEB_TUNING.shearStiff);
      }
      const skip = (a + 2) % this.#count;
      for (let row = 3; row < WEB_TUNING.segments; row += 3) {
        const na = this.#mainNodes[a][row];
        const nb = this.#mainNodes[skip][row];
        if (na != null && nb != null) this.#addLink(na, nb, WEB_TUNING.longStiff);
      }
    }
  }

  // ─────────────────────────────────────────────────────────── simulation

  #integrate(dt: number, elapsed: number): void {
    const dt2 = dt * dt;
    const amp = WEB_TUNING.driftAmp;
    const sc = WEB_TUNING.driftScale;
    const energy = 0.55 + this.#energy.value * 0.9;
    for (let i = 0; i < this.#nodeCount; i++) {
      if (this.#pin[i]) continue;
      const x = this.#px[i];
      const y = this.#py[i];
      const z = this.#pz[i];
      let vx = (x - this.#ox[i]) * WEB_TUNING.damping;
      let vy = (y - this.#oy[i]) * WEB_TUNING.damping;
      let vz = (z - this.#oz[i]) * WEB_TUNING.damping;

      // Smooth divergence-free-ish curl from a sin field — cheap cosmic billow.
      const d = this.#drift[i] * amp * energy;
      const fx = Math.sin(y * sc + elapsed * 0.9) + Math.cos(z * sc * 0.8 - elapsed * 0.6);
      const fy = Math.sin(z * sc + elapsed * 0.7) + WEB_TUNING.buoyancy * this.#sprung[i] * 4;
      const fz = Math.sin(x * sc - elapsed * 0.8) + Math.cos(y * sc * 0.9 + elapsed * 0.5);

      let ax = fx * d;
      let ay = fy * d;
      let az = fz * d;

      // Two crossing wave families keep the sculpture breathing even when no
      // player is touching it. Phases come from the rest topology, so the
      // motion travels coherently through branches instead of reading as noise.
      const hx = this.#hx[i];
      const hz = this.#hz[i];
      const radius = Math.sqrt(hx * hx + hz * hz) || 1;
      const angle = Math.atan2(hz, hx);
      const waveA = Math.sin(radius * 1.08 - elapsed * 2.35 + angle * 4.0);
      const waveB = Math.cos(radius * 1.72 + elapsed * 1.28 - angle * 6.0);
      const wave = (waveA * 0.72 + waveB * 0.38) * d * (0.4 + energy * 0.36);
      ax += (hx / radius) * wave * 0.72;
      ay += wave * 0.62;
      az += (hz / radius) * wave * 0.72;

      if (this.#sprung[i]) {
        const k = WEB_TUNING.homeSpring;
        ax += (this.#hx[i] - x) * k;
        ay += (this.#hy[i] - y) * k;
        az += (this.#hz[i] - z) * k;
      }

      this.#ox[i] = x;
      this.#oy[i] = y;
      this.#oz[i] = z;
      this.#px[i] = x + vx + ax * dt2;
      this.#py[i] = y + vy + ay * dt2;
      this.#pz[i] = z + vz + az * dt2;
    }
  }

  #injectAnchorMotion(): void {
    let strongest = 0;
    const outerRow = Math.max(1, WEB_TUNING.segments - 1);
    for (let a = 0; a < this.#count; a++) {
      const target = this.anchorTargets[a];
      const previous = this.#anchorPrevious[a];
      const dx = target.x - previous.x;
      const dy = target.y - previous.y;
      const dz = target.z - previous.z;
      const magnitude = Math.hypot(dx, dy, dz);
      if (magnitude > 0.0001) {
        strongest = Math.max(strongest, magnitude);
        for (let depth = 0; depth < 5; depth++) {
          const row = Math.max(1, outerRow - depth * 2);
          const falloff = Math.pow(0.68, depth);
          const impulse = WEB_TUNING.rippleImpulse * falloff;
          const node = this.#mainNodes[a][row];
          const nextNode = this.#mainNodes[(a + 1) % this.#count][row];
          const prevNode = this.#mainNodes[(a + this.#count - 1) % this.#count][row];
          this.#ox[node] -= dx * impulse;
          this.#oy[node] -= dy * impulse;
          this.#oz[node] -= dz * impulse;
          this.#ox[nextNode] -= dx * impulse * 0.32;
          this.#oy[nextNode] -= dy * impulse * 0.32;
          this.#oz[nextNode] -= dz * impulse * 0.32;
          this.#ox[prevNode] -= dx * impulse * 0.24;
          this.#oy[prevNode] -= dy * impulse * 0.24;
          this.#oz[prevNode] -= dz * impulse * 0.24;
        }
      }
      previous.copy(target);
    }
    this.#ripple.value = Math.max(this.#ripple.value, Math.min(1.4, strongest * 4.8));
  }

  #measureStrain(): void {
    let total = 0;
    for (let i = 0; i < this.#linkA.length; i++) {
      const a = this.#linkA[i];
      const b = this.#linkB[i];
      const dx = this.#px[b] - this.#px[a];
      const dy = this.#py[b] - this.#py[a];
      const dz = this.#pz[b] - this.#pz[a];
      const rest = Math.max(0.0001, this.#linkRest[i]);
      total += Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) / rest - 1);
    }
    this.#strain = this.#linkA.length > 0 ? total / this.#linkA.length : 0;
  }

  #solveLinks(): void {
    const A = this.#linkA;
    const B = this.#linkB;
    const rest = this.#linkRest;
    const stiff = this.#linkStiff;
    for (let l = 0; l < A.length; l++) {
      const a = A[l];
      const b = B[l];
      const dx = this.#px[b] - this.#px[a];
      const dy = this.#py[b] - this.#py[a];
      const dz = this.#pz[b] - this.#pz[a];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-5;
      const diff = ((dist - rest[l]) / dist) * stiff[l];
      const pinA = this.#pin[a];
      const pinB = this.#pin[b];
      if (pinA && pinB) continue;
      // split the correction between the two ends (all of it onto the free end
      // when the other is pinned)
      const wa = pinA ? 0 : pinB ? 1 : 0.5;
      const wb = pinB ? 0 : pinA ? 1 : 0.5;
      this.#px[a] += dx * diff * wa;
      this.#py[a] += dy * diff * wa;
      this.#pz[a] += dz * diff * wa;
      this.#px[b] -= dx * diff * wb;
      this.#py[b] -= dy * diff * wb;
      this.#pz[b] -= dz * diff * wb;
    }
  }

  #pinNodes(): void {
    this.#px[this.#hub] = 0;
    this.#py[this.#hub] = this.#hubYUniform.value;
    this.#pz[this.#hub] = 0;
    for (let a = 0; a < this.#count; a++) {
      const idx = this.#anchorNode[a];
      const t = this.anchorTargets[a];
      this.#px[idx] = t.x;
      this.#py[idx] = t.y;
      this.#pz[idx] = t.z;
    }
  }

  // ─────────────────────────────────────────────────────────── vein render

  #buildVeinGeometry(): void {
    let vertCount = 0;
    for (const chain of this.#chains) {
      this.#veinVertChains.push({ chain, offset: vertCount });
      vertCount += chain.nodes.length * 2;
    }
    const geom = new THREE.BufferGeometry();
    const side = new Float32Array(vertCount);
    const span = new Float32Array(vertCount);
    const level = new Float32Array(vertCount);
    const phase = new Float32Array(vertCount);
    const indices: number[] = [];
    let v = 0;
    for (const chain of this.#chains) {
      const n = chain.nodes.length;
      for (let k = 0; k < n; k++) {
        const s = k / (n - 1);
        side[v] = -0.5;
        side[v + 1] = 0.5;
        span[v] = span[v + 1] = s;
        level[v] = level[v + 1] = chain.level;
        phase[v] = phase[v + 1] = chain.phase;
        if (k > 0) {
          const a = v - 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        v += 2;
      }
    }
    this.#veinPos = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.#veinDir = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("position", this.#veinPos);
    geom.setAttribute("aDir", this.#veinDir);
    geom.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geom.setAttribute("aSpan", new THREE.BufferAttribute(span, 1));
    geom.setAttribute("aLevel", new THREE.BufferAttribute(level, 1));
    geom.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    geom.setIndex(indices);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, WEB_TUNING.hubY, 0), 40);

    const mesh = new THREE.Mesh(geom, this.#veinMaterial());
    mesh.name = "afterlight-web-veins";
    mesh.frustumCulled = false;
    mesh.renderOrder = 16;
    this.root.add(mesh);
  }

  #veinMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    const dir = attribute("aDir", "vec3") as N;
    const sideN = attribute("aSide", "float") as N;
    const span = attribute("aSpan", "float") as N;
    const level = attribute("aLevel", "float") as N;
    const phase = attribute("aPhase", "float") as N;
    const energy = this.#energy as N;
    const rippleStrength = this.#ripple as N;

    const view = normalize(cameraPosition.sub(positionWorld)) as N;
    const lateral = normalize(cross(dir, view).add(vec3(0, 1e-4, 0))) as N;
    const levelWidth = float(1).sub(level.mul(0.32)) as N;
    const width = mix(float(WEB_TUNING.mainWidth), float(WEB_TUNING.tipWidth), span.pow(0.7))
      .mul(levelWidth)
      .mul(energy.mul(0.4).add(0.75)) as N;
    material.positionNode = (positionGeometry as N).add(lateral.mul(sideN.mul(width)));

    const drift = mx_noise_float((positionWorld as N).mul(0.35).add(vec3(time.mul(0.05), time.mul(-0.08), time.mul(0.06))))
      .mul(0.5)
      .add(0.5) as N;
    const indigo = color(0x4a48b0) as N;
    const cyan = color(0x74ecf0) as N;
    const violet = color(0xc39cff) as N;
    const rose = color(0xffa6d8) as N;
    const hot = color(0xfff1e6) as N;
    const auroraA = mix(indigo, cyan, span) as N;
    const auroraB = mix(violet, rose, span) as N;
    const aurora = mix(auroraA, auroraB, drift.mul(0.6).add(0.2)) as N;

    // travelling energy pulses hub→tip
    const flow = fract(span.mul(WEB_TUNING.flowFreq).sub(time.mul(WEB_TUNING.flowSpeed)).sub(level.mul(0.3))) as N;
    const pulse = smoothstep(0, 0.35, flow).mul(smoothstep(1, 0.55, flow)) as N;
    const rippleFlow = fract(span.mul(1.65).sub(time.mul(0.92)).add(phase)) as N;
    const rippleBand = smoothstep(0, 0.22, rippleFlow)
      .mul(smoothstep(0.52, 0.24, rippleFlow))
      .mul(rippleStrength) as N;
    const counterFlow = fract(span.mul(2.65).add(time.mul(0.68)).sub(phase.mul(1.7))) as N;
    const counterBand = smoothstep(0, 0.15, counterFlow)
      .mul(smoothstep(0.42, 0.18, counterFlow))
      .mul(rippleStrength.mul(0.72)) as N;
    const resonance = span
      .mul(15.0)
      .sub(time.mul(3.4))
      .add(phase.mul(9.0))
      .sin()
      .mul(0.5)
      .add(0.5)
      .pow(5)
      .mul(rippleStrength.mul(0.58)) as N;
    const edge = smoothstep(1, 0.12, sideN.abs().mul(2)) as N;
    const tipFade = smoothstep(1.02, 0.5, span).mul(0.55).add(0.45) as N;
    const glow = edge
      .mul(pulse.mul(0.72).add(rippleBand.mul(1.25)).add(counterBand).add(resonance).add(0.48))
      .mul(tipFade)
      .mul(energy.mul(0.7).add(0.5)) as N;

    material.colorNode = mix(
      aurora,
      hot,
      drift.pow(3).mul(0.35).add(pulse.mul(0.25)).add(rippleBand.mul(0.62)).add(counterBand.mul(0.48)).add(resonance)
    )
      .mul(glow)
      .mul(LIGHT_SCALE * 0.95);
    material.opacityNode = edge.mul(tipFade).mul(energy.mul(0.5).add(0.35)).mul(0.85);
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.fog = false;
    return material;
  }

  #writeVeins(): void {
    const pos = this.#veinPos.array as Float32Array;
    const dirs = this.#veinDir.array as Float32Array;
    for (const { chain, offset } of this.#veinVertChains) {
      const nodes = chain.nodes;
      const n = nodes.length;
      for (let k = 0; k < n; k++) {
        const idx = nodes[k];
        const prev = nodes[Math.max(0, k - 1)];
        const next = nodes[Math.min(n - 1, k + 1)];
        let tx = this.#px[next] - this.#px[prev];
        let ty = this.#py[next] - this.#py[prev];
        let tz = this.#pz[next] - this.#pz[prev];
        const tl = Math.hypot(tx, ty, tz) || 1e-5;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const x = this.#px[idx];
        const y = this.#py[idx];
        const z = this.#pz[idx];
        const base = (offset + k * 2) * 3;
        for (let s = 0; s < 2; s++) {
          const p = base + s * 3;
          pos[p] = x;
          pos[p + 1] = y;
          pos[p + 2] = z;
          dirs[p] = tx;
          dirs[p + 1] = ty;
          dirs[p + 2] = tz;
        }
      }
    }
    this.#veinPos.needsUpdate = true;
    this.#veinDir.needsUpdate = true;
  }

  // ─────────────────────────────────────────────────────────── membrane

  #buildMembrane(): void {
    const seg = WEB_TUNING.segments;
    const innerRow = WEB_TUNING.membraneInnerRow;
    const rows = seg - innerRow + 1; // inclusive rows from innerRow..seg
    const sub = WEB_TUNING.membraneAngular;
    const cols = this.#count * sub; // wraps around the ring
    const bind: { a: number; b: number; row: number; u: number; angle: number; radial: number }[] = [];
    const uvs: number[] = [];
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c / sub);
      const b = (a + 1) % this.#count;
      const u = (c % sub) / sub;
      for (let r = 0; r < rows; r++) {
        const row = innerRow + r;
        bind.push({ a, b, row, u, angle: (c / cols) * Math.PI * 2, radial: row / seg });
        uvs.push(c / cols, r / (rows - 1));
      }
    }
    const indices: number[] = [];
    for (let c = 0; c < cols; c++) {
      const cNext = (c + 1) % cols;
      for (let r = 0; r < rows - 1; r++) {
        const i0 = c * rows + r;
        const i1 = c * rows + r + 1;
        const i2 = cNext * rows + r;
        const i3 = cNext * rows + r + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }
    const geom = new THREE.BufferGeometry();
    this.#memPos = new THREE.BufferAttribute(new Float32Array(bind.length * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("position", this.#memPos);
    geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geom.setIndex(indices);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, WEB_TUNING.hubY, 0), 40);
    this.#memGeom = geom;
    this.#memBind = bind;

    // inner (translucent core) + outer additive rim shell — the whale trick.
    const inner = new THREE.Mesh(geom, this.#membraneMaterial(false));
    inner.name = "afterlight-web-membrane";
    inner.frustumCulled = false;
    inner.renderOrder = 15;
    const shell = new THREE.Mesh(geom, this.#membraneMaterial(true));
    shell.name = "afterlight-web-membrane-shell";
    shell.frustumCulled = false;
    shell.renderOrder = 15;
    this.root.add(inner, shell);
  }

  #membraneMaterial(shell: boolean): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    const energy = this.#energy as N;
    const view = normalize(cameraPosition.sub(positionWorld)) as N;
    const nDotV = clamp((normalWorld as N).dot(view).abs(), 0, 1) as N;
    const fres = float(1).sub(nDotV).pow(shell ? 1.5 : 2.6) as N;
    const soft = float(1).sub(nDotV).pow(shell ? 0.9 : 1.7) as N;

    const drift = mx_noise_float(
      (positionWorld as N)
        .mul(shell ? 0.09 : 0.05)
        .add(vec3(time.mul(shell ? 0.05 : -0.04), time.mul(0.02), time.mul(0.035)))
    )
      .mul(0.5)
      .add(0.5) as N;

    // Cosmic aurora, biased indigo→violet→rose so the veil reads magic, not pool-water.
    const indigo = color(shell ? 0x4a4fae : 0x2c2a68) as N;
    const violet = color(shell ? 0xc4a2ff : 0x8f6fd0) as N;
    const cyan = color(shell ? 0x7ceff0 : 0x4ec9d6) as N;
    const rose = color(shell ? 0xffa6dc : 0xe07aae) as N;
    const mint = color(shell ? 0x9bffe0 : 0x62d9b8) as N;
    const body = mix(indigo, mix(violet, cyan, drift), soft.mul(0.55).add(0.18)) as N;
    const shimmer = mix(body, mix(rose, mint, drift), drift.pow(2.4).mul(shell ? 0.5 : 0.28)) as N;
    const rim = mix(shimmer, mix(cyan, violet, drift), fres.mul(0.6)) as N;

    const brightness = shell
      ? fres.mul(1.15).add(soft.mul(0.26)).add(0.02)
      : fres.mul(0.44).add(soft.mul(0.2)).add(0.1);

    material.colorNode = rim
      .mul(brightness)
      .mul(energy.mul(0.7).add(0.45))
      .mul(LIGHT_SCALE * (shell ? 0.95 : 0.42));
    // Ethereal veil: nearly clear through the middle, glowing at the grazing rim.
    material.opacityNode = energy
      .mul(0.5)
      .add(0.12)
      .mul(shell ? fres.mul(0.85).add(soft.mul(0.08)).add(0.015) : fres.mul(0.34).add(soft.mul(0.12)).add(0.05));
    material.transparent = true;
    material.depthWrite = false;
    material.side = shell ? THREE.BackSide : THREE.DoubleSide;
    material.blending = shell ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.fog = false;
    return material;
  }

  #writeMembrane(): void {
    const pos = this.#memPos.array as Float32Array;
    const bind = this.#memBind;
    for (let i = 0; i < bind.length; i++) {
      const { a, b, row, u, angle, radial } = bind[i];
      const na = this.#mainNodes[a][row];
      const nb = this.#mainNodes[b][row];
      const p = i * 3;
      const x = this.#px[na] + (this.#px[nb] - this.#px[na]) * u;
      const y = this.#py[na] + (this.#py[nb] - this.#py[na]) * u;
      const z = this.#pz[na] + (this.#pz[nb] - this.#pz[na]) * u;
      const wave = Math.sin(radial * 14.5 - this.#elapsed * 2.65 + angle * 4.0)
        + Math.sin(radial * 23.0 + this.#elapsed * 1.48 - angle * 7.0) * 0.45;
      const amplitude = (0.025 + this.#ripple.value * 0.055) * (0.35 + radial * 0.65);
      pos[p] = x;
      pos[p + 1] = y + wave * amplitude;
      pos[p + 2] = z;
    }
    this.#memPos.needsUpdate = true;
    if ((this.#renderFrame & 1) === 0) this.#memGeom.computeVertexNormals();
  }

  #buildJoints(): void {
    for (let anchor = 0; anchor < this.#mainNodes.length; anchor++) {
      for (let row = 1; row < this.#mainNodes[anchor].length; row++) {
        this.#jointNodes.push(this.#mainNodes[anchor][row]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    this.#jointPos = new THREE.BufferAttribute(
      new Float32Array(this.#jointNodes.length * 3),
      3
    ).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.#jointPos);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, WEB_TUNING.hubY, 0), 40);
    const material = new THREE.PointsMaterial({
      color: 0xcbefff,
      size: 0.095,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });
    const points = new THREE.Points(geometry, material);
    points.name = "afterlight-web-joints";
    points.frustumCulled = false;
    points.renderOrder = 17;
    this.root.add(points);
  }

  #writeJoints(): void {
    const positions = this.#jointPos.array as Float32Array;
    for (let i = 0; i < this.#jointNodes.length; i++) {
      const node = this.#jointNodes[i];
      const offset = i * 3;
      positions[offset] = this.#px[node];
      positions[offset + 1] = this.#py[node];
      positions[offset + 2] = this.#pz[node];
    }
    this.#jointPos.needsUpdate = true;
  }
}
