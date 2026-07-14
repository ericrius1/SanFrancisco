// Shared WebGPU line-buffer for debug overlays. Node materials do not honor
// the legacy `vertexColors` flag — color must be bound via `colorNode` (see
// fx/cloth.ts). That was why the old collider x-ray drew nothing.
import * as THREE from "three/webgpu";
import { attribute } from "three/tsl";

/** One oriented collider box in world space + its overlay colour. */
export interface DebugBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  /** Yaw-only orientation (buildings, walls). Ignored when `quat` is set. */
  yaw?: number;
  /** Full orientation (carpet slabs). Takes precedence over `yaw`. */
  quat?: readonly [number, number, number, number];
  r: number;
  g: number;
  b: number;
}

/** One local-space indexed triangle mesh collider + its world origin/colour. */
export interface DebugMesh {
  x: number;
  y: number;
  z: number;
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  r: number;
  g: number;
  b: number;
}

/** A single coloured polyline (raycast beam, grid line, outline). */
export interface DebugPolyline {
  points: ArrayLike<number>; // xyz triples
  r: number;
  g: number;
  b: number;
}

const CORNERS: readonly [number, number, number][] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, -1, 1],
  [-1, -1, 1],
  [-1, 1, -1],
  [1, 1, -1],
  [1, 1, 1],
  [-1, 1, 1]
];
const EDGES: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7]
];
export const VERTS_PER_BOX = EDGES.length * 2;

export class LineOverlay {
  #line: THREE.LineSegments;
  #pos: Float32Array;
  #col: Float32Array;
  #cap: number;
  #cx = new Float64Array(8);
  #cy = new Float64Array(8);
  #cz = new Float64Array(8);
  #q = new THREE.Quaternion();
  #v = new THREE.Vector3();
  visible = false;

  constructor(scene: THREE.Object3D, name: string) {
    this.#cap = 1024 * VERTS_PER_BOX;
    this.#pos = new Float32Array(this.#cap * 3);
    this.#col = new Float32Array(this.#cap * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.#pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.#col, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicNodeMaterial({
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false
    });
    // Explicit attribute bind — legacy vertexColors is a no-op on node mats.
    mat.colorNode = attribute("color", "vec3");
    const line = new THREE.LineSegments(geo, mat);
    line.name = name;
    line.frustumCulled = false;
    line.renderOrder = 9999;
    line.visible = false;
    scene.add(line);
    this.#line = line;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.#line.visible = on;
  }

  #grow(vertices: number): void {
    if (vertices <= this.#cap) return;
    this.#cap = Math.max(vertices, Math.ceil(this.#cap * 1.5), 64);
    this.#pos = new Float32Array(this.#cap * 3);
    this.#col = new Float32Array(this.#cap * 3);
    const geo = this.#line.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(this.#pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.#col, 3));
  }

  /**
   * Rebuild the wireframe from boxes / triangle meshes / polylines.
   * Caller should only invoke when visible.
   */
  sync(
    boxes: readonly DebugBox[] = [],
    meshes: readonly DebugMesh[] = [],
    polylines: readonly DebugPolyline[] = []
  ): void {
    if (!this.visible) return;
    let vertexCount = boxes.length * VERTS_PER_BOX;
    for (const mesh of meshes) vertexCount += mesh.indices.length * 2;
    for (const line of polylines) {
      const n = Math.floor(line.points.length / 3);
      if (n >= 2) vertexCount += (n - 1) * 2;
    }
    this.#grow(vertexCount);
    const pos = this.#pos;
    const col = this.#col;
    const cx = this.#cx;
    const cy = this.#cy;
    const cz = this.#cz;
    let o = 0;

    for (const bx of boxes) {
      const useQuat = bx.quat != null;
      if (useQuat) {
        this.#q.set(bx.quat![0], bx.quat![1], bx.quat![2], bx.quat![3]);
      }
      const cos = useQuat ? 0 : Math.cos(bx.yaw ?? 0);
      const sin = useQuat ? 0 : Math.sin(bx.yaw ?? 0);
      for (let k = 0; k < 8; k++) {
        const lx = CORNERS[k][0] * bx.hx;
        const ly = CORNERS[k][1] * bx.hy;
        const lz = CORNERS[k][2] * bx.hz;
        if (useQuat) {
          this.#v.set(lx, ly, lz).applyQuaternion(this.#q);
          cx[k] = bx.x + this.#v.x;
          cy[k] = bx.y + this.#v.y;
          cz[k] = bx.z + this.#v.z;
        } else {
          cx[k] = bx.x + (lx * cos - lz * sin);
          cy[k] = bx.y + ly;
          cz[k] = bx.z + (lx * sin + lz * cos);
        }
      }
      for (const [a, e] of EDGES) {
        pos[o] = cx[a];
        pos[o + 1] = cy[a];
        pos[o + 2] = cz[a];
        col[o] = bx.r;
        col[o + 1] = bx.g;
        col[o + 2] = bx.b;
        o += 3;
        pos[o] = cx[e];
        pos[o + 1] = cy[e];
        pos[o + 2] = cz[e];
        col[o] = bx.r;
        col[o + 1] = bx.g;
        col[o + 2] = bx.b;
        o += 3;
      }
    }

    for (const mesh of meshes) {
      const vertices = mesh.vertices;
      const indices = mesh.indices;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        for (const [u, v] of [
          [a, b],
          [b, c],
          [c, a]
        ] as const) {
          let k = u * 3;
          pos[o] = mesh.x + vertices[k];
          pos[o + 1] = mesh.y + vertices[k + 1];
          pos[o + 2] = mesh.z + vertices[k + 2];
          col[o] = mesh.r;
          col[o + 1] = mesh.g;
          col[o + 2] = mesh.b;
          o += 3;
          k = v * 3;
          pos[o] = mesh.x + vertices[k];
          pos[o + 1] = mesh.y + vertices[k + 1];
          pos[o + 2] = mesh.z + vertices[k + 2];
          col[o] = mesh.r;
          col[o + 1] = mesh.g;
          col[o + 2] = mesh.b;
          o += 3;
        }
      }
    }

    for (const line of polylines) {
      const pts = line.points;
      const n = Math.floor(pts.length / 3);
      for (let i = 0; i + 1 < n; i++) {
        const a = i * 3;
        const b = (i + 1) * 3;
        pos[o] = pts[a];
        pos[o + 1] = pts[a + 1];
        pos[o + 2] = pts[a + 2];
        col[o] = line.r;
        col[o + 1] = line.g;
        col[o + 2] = line.b;
        o += 3;
        pos[o] = pts[b];
        pos[o + 1] = pts[b + 1];
        pos[o + 2] = pts[b + 2];
        col[o] = line.r;
        col[o + 1] = line.g;
        col[o + 2] = line.b;
        o += 3;
      }
    }

    const geo = this.#line.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, o / 3);
  }

  clear(): void {
    if (!this.visible) return;
    this.#line.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.#line.geometry.dispose();
    (this.#line.material as THREE.Material).dispose();
    this.#line.removeFromParent();
  }
}
