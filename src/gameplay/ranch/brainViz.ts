import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";

/**
 * The glowing activation lattice that floats over a learning creature — layer
 * columns of nodes joined by soft additive lines, colored per-frame from the
 * live MLP activations. Shared by every ranch pen (and originally by the pup).
 * Fixed geometry; only colors change per frame.
 */

const LAYER_COLORS = [0x12a8ff, 0x38d8ff, 0x8d67ff, 0xff8d2a] as const;
export const BRAIN_LINE_GLOW = LIGHT_SCALE * 0.14;
export const BRAIN_NODE_GLOW = LIGHT_SCALE * 0.34;

function layerColor(layer: number): THREE.Color {
  return new THREE.Color(LAYER_COLORS[Math.min(LAYER_COLORS.length - 1, layer)]);
}

export function writeActivationColor(out: Float32Array, i3: number, activation: number, layer: number, boost: number): void {
  const tt = activation < -1 ? 0 : activation > 1 ? 1 : (activation + 1) / 2;
  const base = layerColor(layer);
  const heat = 0.36 + tt * tt * 1.55;
  const white = tt > 0.72 ? (tt - 0.72) * 1.3 : 0;
  out[i3] = (base.r * (1 - white) + white) * heat * boost;
  out[i3 + 1] = (base.g * (1 - white) + white) * heat * boost;
  out[i3 + 2] = (base.b * (1 - white) + white) * heat * boost;
}

export function setActivationColor(color: THREE.Color, activation: number, layer: number, boost: number): void {
  const tt = activation < -1 ? 0 : activation > 1 ? 1 : (activation + 1) / 2;
  const base = layerColor(layer);
  const heat = 0.54 + tt * tt * 1.7;
  const white = tt > 0.66 ? (tt - 0.66) * 1.55 : 0;
  color.setRGB(
    (base.r * (1 - white) + white) * heat * boost,
    (base.g * (1 - white) + white) * heat * boost,
    (base.b * (1 - white) + white) * heat * boost
  );
}

export type Brain = {
  group: THREE.Group;
  lineColors: Float32Array;
  lineAttr: THREE.BufferAttribute;
  lineLayer: Uint8Array;
  lineNode: Uint16Array;
  pointLayer: Uint8Array;
  pointNode: Uint16Array;
  nodes: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
};

export function buildBrain(sizes: number[], scale: number): Brain {
  const nL = sizes.length;
  const GAP = 0.72;
  const HEIGHT = 1.42;
  const DEPTH = 0.86;
  const layerX = (li: number) => (li - (nL - 1) / 2) * GAP;
  const nodePos = (li: number, j: number, out: number[]) => {
    const n = sizes[li];
    const cols = li === 0 || li === nL - 1 ? 1 : 4;
    const rows = Math.ceil(n / cols);
    const col = j % cols;
    const row = Math.floor(j / cols);
    const dz = cols <= 1 ? 0 : (col / (cols - 1) - 0.5) * DEPTH;
    const dy = rows <= 1 ? 0 : (0.5 - row / (rows - 1)) * HEIGHT;
    const curve = Math.sin((row + 1) * 0.68 + li * 0.9) * 0.025;
    out.push(layerX(li), dy, dz + curve);
  };
  const linePos: number[] = [];
  const pointPos: number[] = [];
  const lineLayer: number[] = [];
  const lineNode: number[] = [];
  const pointLayer: number[] = [];
  const pointNode: number[] = [];
  const addVert = (li: number, j: number) => {
    nodePos(li, j, linePos);
    lineLayer.push(li);
    lineNode.push(j);
  };
  const addEdge = (aLi: number, aJ: number, bLi: number, bJ: number) => {
    addVert(aLi, aJ);
    addVert(bLi, bJ);
  };
  for (let li = 0; li < nL; li++) {
    const cols = li === 0 || li === nL - 1 ? 1 : 4;
    const rows = Math.ceil(sizes[li] / cols);
    for (let j = 0; j < sizes[li]; j++) {
      nodePos(li, j, pointPos);
      pointLayer.push(li);
      pointNode.push(j);
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const j = row * cols + col;
        if (j >= sizes[li]) continue;
        const right = row * cols + col + 1;
        const down = (row + 1) * cols + col;
        if (col + 1 < cols && right < sizes[li]) addEdge(li, j, li, right);
        if (row + 1 < rows && down < sizes[li]) addEdge(li, j, li, down);
      }
    }
    if (li + 1 < nL) {
      for (let j = 0; j < sizes[li]; j++) {
        for (let b = 0; b < sizes[li + 1]; b++) addEdge(li, j, li + 1, b);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  const linePosArr = new Float32Array(linePos);
  const lineColArr = new Float32Array(linePosArr.length);
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePosArr, 3));
  const lineAttr = new THREE.BufferAttribute(lineColArr, 3);
  lineAttr.setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute("color", lineAttr);
  const lineMat = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  lineMat.opacity = 0.46;
  lineMat.depthTest = false;
  lineMat.toneMapped = false;
  const line = new THREE.LineSegments(lineGeo, lineMat);
  line.frustumCulled = false;

  const mkInstanced = (radius: number, opacity: number): THREE.InstancedMesh => {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
      blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    mat.depthTest = false;
    mat.toneMapped = false;
    const im = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), mat, pointLayer.length);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.frustumCulled = false;
    return im;
  };
  const nodes = mkInstanced(0.045, 1);
  const halos = mkInstanced(0.11, 0.32);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const seed = new THREE.Color(0.35, 0.85, 1.1);
  for (let i = 0; i < pointLayer.length; i++) {
    const i3 = i * 3;
    p.set(pointPos[i3], pointPos[i3 + 1], pointPos[i3 + 2]);
    const boost = pointLayer[i] === 0 || pointLayer[i] === nL - 1 ? 1.12 : 1;
    m.compose(p, q, s.setScalar(boost));
    nodes.setMatrixAt(i, m);
    halos.setMatrixAt(i, m);
    nodes.setColorAt(i, seed);
    halos.setColorAt(i, seed);
  }
  nodes.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  halos.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  const group = new THREE.Group();
  group.add(line, halos, nodes);
  group.scale.setScalar(scale);
  return {
    group,
    lineColors: lineColArr,
    lineAttr,
    lineLayer: Uint8Array.from(lineLayer),
    lineNode: Uint16Array.from(lineNode),
    pointLayer: Uint8Array.from(pointLayer),
    pointNode: Uint16Array.from(pointNode),
    nodes,
    halos
  };
}
