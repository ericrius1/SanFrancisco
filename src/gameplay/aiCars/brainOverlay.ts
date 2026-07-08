/**
 * Per-car floating neural-net lattice.
 *
 * Adapted from the horse-herd "brain bubble" (git f938c00
 * src/gameplay/horse/horseHerd.ts #buildBrain / #updateBrain): one
 * THREE.LineSegments lattice + an InstancedMesh of glowing nodes per car. The
 * geometry is static; each update only rewrites the per-vertex colour buffers
 * (DynamicDrawUsage). Node brightness tracks |activation|; edge brightness the
 * product of its two endpoints. Cyan = negative, warm orange = positive.
 *
 * Layer 0 activations come from the observation vector (`obs`); every later
 * layer from `policy.layerOut`. Two output nodes are drawn larger. The lattice
 * billboards toward the camera each update and caps colour writes to ~20 Hz per
 * car regardless of call rate.
 *
 * All maxCars lattices are pre-allocated up front and start hidden; `update`
 * reveals a car, `hide` conceals it, `setEnabled(false)` hides everything and
 * short-circuits work.
 */

import * as THREE from "three/webgpu";

const LATTICE_WIDTH = 1.6; // metres across the whole graph
const LAYER_GAP = 0.62;
const COL_HEIGHT = 1.28;
const NODE_R = 0.05;
const OUT_NODE_BOOST = 2.1; // output nodes drawn this much bigger
const WRITE_HZ = 20;

// warm orange (positive) ↔ cool cyan (negative)
const POS = new THREE.Color(1.0, 0.52, 0.16);
const NEG = new THREE.Color(0.18, 0.78, 1.0);

type Lattice = {
  group: THREE.Group;
  line: THREE.LineSegments;
  lineCol: Float32Array;
  lineAttr: THREE.BufferAttribute;
  edgeSrc: Int32Array; // flat node index of each edge's source endpoint
  edgeDst: Int32Array;
  nodes: THREE.InstancedMesh;
  nodeLayer: Uint8Array; // layer of each node instance
  nodeIdx: Uint16Array; // index within that layer
  lastWrite: number;
  shown: boolean;
};

/** Flatten (layer, idx) → global node id; also lets edges index activations. */
function flatId(sizes: readonly number[], layer: number, idx: number): number {
  let base = 0;
  for (let l = 0; l < layer; l++) base += sizes[l];
  return base + idx;
}

function nodePos(sizes: readonly number[], layer: number, idx: number, out: THREE.Vector3): void {
  const nL = sizes.length;
  const x = (layer - (nL - 1) / 2) * LAYER_GAP;
  const n = sizes[layer];
  const y = n <= 1 ? 0 : (0.5 - idx / (n - 1)) * COL_HEIGHT;
  out.set(x, y, 0);
}

export class BrainOverlay {
  #scene: THREE.Scene;
  #sizes: readonly number[];
  #getCamera: () => THREE.Camera;
  #lattices: Lattice[] = [];
  #enabled = true;

  // scratch
  #col = new THREE.Color();
  #act: Float32Array; // combined activation buffer (all layers concatenated)

  constructor(scene: THREE.Scene, sizes: readonly number[], maxCars: number, getCamera: () => THREE.Camera) {
    this.#scene = scene;
    this.#sizes = sizes.slice();
    this.#getCamera = getCamera;
    let total = 0;
    for (const s of sizes) total += s;
    this.#act = new Float32Array(total);
    for (let i = 0; i < maxCars; i++) this.#lattices.push(this.#build());
  }

  #build(): Lattice {
    const sizes = this.#sizes;
    const nL = sizes.length;
    const nodeCount = this.#act.length;

    // --- edges: fully connect consecutive layers ---
    const edgeSrc: number[] = [];
    const edgeDst: number[] = [];
    for (let l = 0; l + 1 < nL; l++) {
      for (let a = 0; a < sizes[l]; a++) {
        for (let b = 0; b < sizes[l + 1]; b++) {
          edgeSrc.push(flatId(sizes, l, a));
          edgeDst.push(flatId(sizes, l + 1, b));
        }
      }
    }
    const linePos = new Float32Array(edgeSrc.length * 2 * 3);
    const posV = new THREE.Vector3();
    for (let e = 0; e < edgeSrc.length; e++) {
      const [sl, si] = this.#unflat(edgeSrc[e]);
      const [dl, di] = this.#unflat(edgeDst[e]);
      nodePos(sizes, sl, si, posV);
      linePos[e * 6] = posV.x;
      linePos[e * 6 + 1] = posV.y;
      linePos[e * 6 + 2] = posV.z;
      nodePos(sizes, dl, di, posV);
      linePos[e * 6 + 3] = posV.x;
      linePos[e * 6 + 4] = posV.y;
      linePos[e * 6 + 5] = posV.z;
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    const lineCol = new Float32Array(linePos.length);
    const lineAttr = new THREE.BufferAttribute(lineCol, 3);
    lineAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute("color", lineAttr);
    const lineMat = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    lineMat.opacity = 0.5;
    lineMat.depthTest = false;
    lineMat.toneMapped = false;
    const line = new THREE.LineSegments(lineGeo, lineMat);
    line.frustumCulled = false;

    // --- nodes ---
    const nodeLayer = new Uint8Array(nodeCount);
    const nodeIdx = new Uint16Array(nodeCount);
    const nodeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    nodeMat.depthTest = false;
    nodeMat.toneMapped = false;
    const nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(NODE_R, 8, 6), nodeMat, nodeCount);
    nodes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodes.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const seed = new THREE.Color(0.2, 0.7, 1.0);
    let gi = 0;
    for (let l = 0; l < nL; l++) {
      const isOut = l === nL - 1;
      for (let i = 0; i < sizes[l]; i++) {
        nodeLayer[gi] = l;
        nodeIdx[gi] = i;
        nodePos(sizes, l, i, posV);
        scl.setScalar(isOut ? OUT_NODE_BOOST : l === 0 ? 1.15 : 1.0);
        m.compose(posV, q, scl);
        nodes.setMatrixAt(gi, m);
        nodes.setColorAt(gi, seed);
        gi++;
      }
    }
    nodes.instanceMatrix.needsUpdate = true;
    nodes.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;

    const group = new THREE.Group();
    group.add(line, nodes);
    // normalise the whole graph to ~LATTICE_WIDTH across
    const span = (nL - 1) * LAYER_GAP;
    group.scale.setScalar(LATTICE_WIDTH / Math.max(0.001, span));
    group.visible = false;
    this.#scene.add(group);

    return {
      group,
      line,
      lineCol,
      lineAttr,
      edgeSrc: Int32Array.from(edgeSrc),
      edgeDst: Int32Array.from(edgeDst),
      nodes,
      nodeLayer,
      nodeIdx,
      lastWrite: 0,
      shown: false
    };
  }

  #unflat(id: number): [number, number] {
    const sizes = this.#sizes;
    let base = 0;
    for (let l = 0; l < sizes.length; l++) {
      if (id < base + sizes[l]) return [l, id - base];
      base += sizes[l];
    }
    return [sizes.length - 1, 0];
  }

  /** activation → glow colour written into `out`. */
  #tint(out: THREE.Color, act: number, gain: number): void {
    const a = Math.max(-1, Math.min(1, act));
    const t = Math.abs(a);
    const base = a >= 0 ? POS : NEG;
    const heat = (0.32 + t * t * 1.7) * gain;
    const white = t > 0.7 ? (t - 0.7) * 1.4 : 0;
    out.setRGB((base.r * (1 - white) + white) * heat, (base.g * (1 - white) + white) * heat, (base.b * (1 - white) + white) * heat);
  }

  update(carId: number, worldPos: THREE.Vector3, layerOut: Float32Array[], obs: Float32Array): void {
    if (!this.#enabled) return;
    const lat = this.#lattices[carId];
    if (!lat) return;
    if (!lat.shown) {
      lat.group.visible = true;
      lat.shown = true;
    }

    // billboard toward the camera (yaw only keeps text-like graph upright)
    const cam = this.#getCamera();
    const yaw = Math.atan2(cam.position.x - worldPos.x, cam.position.z - worldPos.z);
    lat.group.position.copy(worldPos);
    lat.group.rotation.set(-0.14, yaw, 0);

    const now = performance.now();
    if (now - lat.lastWrite < 1000 / WRITE_HZ) return;
    lat.lastWrite = now;

    // gather activations: layer 0 from obs, rest from layerOut
    const sizes = this.#sizes;
    const act = this.#act;
    let gi = 0;
    for (let i = 0; i < sizes[0]; i++) act[gi++] = obs[i] ?? 0;
    for (let l = 1; l < sizes.length; l++) {
      const src = layerOut[l - 1];
      for (let i = 0; i < sizes[l]; i++) act[gi++] = src ? src[i] : 0;
    }

    // edges: brightness ∝ src·dst, signed
    const lc = lat.lineCol;
    for (let e = 0; e < lat.edgeSrc.length; e++) {
      const prod = act[lat.edgeSrc[e]] * act[lat.edgeDst[e]];
      this.#tint(this.#col, prod, 0.9);
      const o = e * 6;
      lc[o] = lc[o + 3] = this.#col.r;
      lc[o + 1] = lc[o + 4] = this.#col.g;
      lc[o + 2] = lc[o + 5] = this.#col.b;
    }
    lat.lineAttr.needsUpdate = true;

    // nodes: brightness ∝ |activation|
    for (let n = 0; n < lat.nodeLayer.length; n++) {
      this.#tint(this.#col, act[n], 1.25);
      lat.nodes.setColorAt(n, this.#col);
    }
    if (lat.nodes.instanceColor) lat.nodes.instanceColor.needsUpdate = true;
  }

  hide(carId: number): void {
    const lat = this.#lattices[carId];
    if (lat && lat.shown) {
      lat.group.visible = false;
      lat.shown = false;
    }
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (!on) {
      for (const lat of this.#lattices) {
        lat.group.visible = false;
        lat.shown = false;
      }
    }
  }

  dispose(): void {
    for (const lat of this.#lattices) {
      this.#scene.remove(lat.group);
      lat.line.geometry.dispose();
      (lat.line.material as THREE.Material).dispose();
      lat.nodes.geometry.dispose();
      (lat.nodes.material as THREE.Material).dispose();
    }
    this.#lattices = [];
  }
}
