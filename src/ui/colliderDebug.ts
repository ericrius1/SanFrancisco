// Collider debug overlay — draws every ACTIVE physics collider as an x-ray
// wireframe box so a collider that has no matching visible mesh (the "invisible
// collision" bug) stands out immediately. Off by default; toggled in the "/"
// panel ("collider x-ray"). Colours name the source:
//   red    = baked building body (visual tile stream)
//   orange = baked building body (citywide index — regions no one is looking at)
//   green  = CityGen walk-in wall / roof (detail tier)
//   blue   = CityGen interior (floor slabs / stair / furniture)
// Rebuilt each frame it's on from caller-supplied box/mesh lists; depthTest off
// so the colliders read through geometry (that's the point — you want to see a
// shape that sits where nothing is drawn).
import * as THREE from "three/webgpu";

/** One oriented collider box in world space + its overlay colour. */
export interface DebugBox {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
  r: number; g: number; b: number;
}

/** One local-space indexed triangle mesh collider + its world origin/colour. */
export interface DebugMesh {
  x: number; y: number; z: number;
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  r: number; g: number; b: number;
}

// 8 corners (sign of hx,hy,hz) then the 12 cube edges as corner-index pairs.
const CORNERS: readonly [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
  [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
];
const EDGES: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom
  [4, 5], [5, 6], [6, 7], [7, 4], // top
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];
const VERTS_PER_BOX = EDGES.length * 2; // 24

export class ColliderDebug {
  #line: THREE.LineSegments;
  #pos: Float32Array;
  #col: Float32Array;
  #cap: number; // capacity in line vertices
  #cx = new Float64Array(8);
  #cy = new Float64Array(8);
  #cz = new Float64Array(8);
  visible = false;

  constructor(scene: THREE.Object3D) {
    // The active broadphase is capped below this in normal play. Reserving the
    // modest debug buffer up front avoids a geometry/vertex-layout mutation on
    // the first checkbox click; #grow remains as a safety valve for dense scenes.
    this.#cap = 1024 * VERTS_PER_BOX;
    this.#pos = new Float32Array(this.#cap * 3);
    this.#col = new Float32Array(this.#cap * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.#pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.#col, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.name = "colliderDebug";
    line.frustumCulled = false;
    line.renderOrder = 9999; // draw last so the x-ray sits over everything
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

  /** Rebuild the wireframe from the current active-collider set. */
  sync(boxes: readonly DebugBox[], meshes: readonly DebugMesh[] = []): void {
    if (!this.visible) return;
    let vertexCount = boxes.length * VERTS_PER_BOX;
    for (const mesh of meshes) vertexCount += mesh.indices.length * 2;
    this.#grow(vertexCount);
    const pos = this.#pos;
    const col = this.#col;
    // precompute the 8 world corners of each box, then stream its 12 edges
    const cx = this.#cx, cy = this.#cy, cz = this.#cz;
    let o = 0;
    for (const bx of boxes) {
      const cos = Math.cos(bx.yaw), sin = Math.sin(bx.yaw);
      for (let k = 0; k < 8; k++) {
        const lx = CORNERS[k][0] * bx.hx;
        const ly = CORNERS[k][1] * bx.hy;
        const lz = CORNERS[k][2] * bx.hz;
        cx[k] = bx.x + (lx * cos - lz * sin);
        cy[k] = bx.y + ly;
        cz[k] = bx.z + (lx * sin + lz * cos);
      }
      for (const [a, e] of EDGES) {
        pos[o] = cx[a]; pos[o + 1] = cy[a]; pos[o + 2] = cz[a];
        col[o] = bx.r; col[o + 1] = bx.g; col[o + 2] = bx.b;
        o += 3;
        pos[o] = cx[e]; pos[o + 1] = cy[e]; pos[o + 2] = cz[e];
        col[o] = bx.r; col[o + 1] = bx.g; col[o + 2] = bx.b;
        o += 3;
      }
    }
    // Draw every triangle edge. Duplicate shared edges are harmless in this
    // opt-in overlay and keep arbitrary static meshes debuggable without an
    // allocation-heavy edge-dedup pass each frame.
    for (const mesh of meshes) {
      const vertices = mesh.vertices;
      const indices = mesh.indices;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
          let k = u * 3;
          pos[o] = mesh.x + vertices[k]; pos[o + 1] = mesh.y + vertices[k + 1]; pos[o + 2] = mesh.z + vertices[k + 2];
          col[o] = mesh.r; col[o + 1] = mesh.g; col[o + 2] = mesh.b;
          o += 3;
          k = v * 3;
          pos[o] = mesh.x + vertices[k]; pos[o + 1] = mesh.y + vertices[k + 1]; pos[o + 2] = mesh.z + vertices[k + 2];
          col[o] = mesh.r; col[o + 1] = mesh.g; col[o + 2] = mesh.b;
          o += 3;
        }
      }
    }
    const geo = this.#line.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, o / 3);
  }

  dispose(): void {
    this.#line.geometry.dispose();
    (this.#line.material as THREE.Material).dispose();
    this.#line.removeFromParent();
  }
}
