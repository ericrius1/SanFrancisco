import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";

/**
 * Floating islands drifting over the city — little grass discs with a dirt
 * underbelly, a lone tree, gems, and a bunch of balloons tied to the edge.
 * Visible from blocks away, so they pull you across the map; each has a static
 * slab body, so anything that can reach one (drone, plane bail-out, a bold
 * rooftop jump) can LAND on it. One merged mesh per island + one shared
 * instanced balloon mesh: ~9 draw calls for the whole fleet.
 */

type Island = {
  x: number;
  y: number;
  z: number;
  r: number;
  balloons: { ox: number; oy: number; oz: number; phase: number; scale: number }[];
};

const SPOTS: [number, number, number, number][] = [
  // x, z, lift above ground, radius
  [4210, -240, 52, 11],
  [3560, -690, 62, 9],
  [3920, 470, 66, 12],
  [2620, -1580, 55, 10],
  [520, -2010, 48, 9],
  [-1480, 480, 55, 10],
  [1980, 1480, 60, 11],
  [1700, -3720, 42, 9] // over the bay by Alcatraz
];

const BALLOON_TINTS = [0xffb3c8, 0xa8e4ff, 0xc9ffc4, 0xfff3ad, 0xe0c4ff, 0xffd2a8];

function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

function islandGeometry(r: number, seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const grass = paint(new THREE.CylinderGeometry(r, r * 0.94, 1.6, 18), 0x6fae58);
  grass.translate(0, 0, 0);
  parts.push(grass);
  const dirt = paint(new THREE.ConeGeometry(r * 0.92, r * 0.85, 14), 0x6b4a33);
  dirt.rotateX(Math.PI);
  dirt.translate(0, -0.8 - r * 0.42, 0);
  parts.push(dirt);
  // lone tree
  const tx = (Math.sin(seed * 12.9898) * 0.5) * r * 0.5;
  const tz = (Math.sin(seed * 78.233) * 0.5) * r * 0.5;
  const trunk = paint(new THREE.CylinderGeometry(0.22, 0.3, 2.6, 8), 0x7a5230);
  trunk.translate(tx, 2.0, tz);
  parts.push(trunk);
  const leaves = paint(new THREE.ConeGeometry(1.9, 3.4, 10), 0x4d8f4a);
  leaves.translate(tx, 4.6, tz);
  parts.push(leaves);
  // scattered gems catching the light
  for (let i = 0; i < 3; i++) {
    const a = seed * 5 + i * 2.1;
    const gem = paint(new THREE.OctahedronGeometry(0.45, 0), [0xff4d88, 0x4dc3ff, 0xffd23d][i]);
    gem.translate(Math.cos(a) * r * 0.55, 1.1, Math.sin(a) * r * 0.55);
    parts.push(gem);
  }
  // the gems are polyhedra (non-indexed) while the rest are indexed primitives;
  // mergeGeometries refuses mixed indexing, so flatten everything first
  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  for (const p of parts) p.dispose();
  return merged;
}

export class Islands {
  #islands: Island[] = [];
  #balloonMesh: THREE.InstancedMesh;
  #strings: THREE.LineSegments;
  #mat = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    let totalBalloons = 0;

    for (let i = 0; i < SPOTS.length; i++) {
      const [x, z, lift, r] = SPOTS[i];
      const y = Math.max(map.effectiveGround(x, z), 0) + lift;
      const mesh = new THREE.Mesh(islandGeometry(r, i + 1), bodyMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      // landing slab (thin, flush with the grass top) — lives for the whole
      // session inside the physics world, so we don't retain a handle
      physics.world.createBox({
        type: BodyType.Static,
        position: [x, y - 0.3, z],
        halfExtents: [r * 0.95, 1.1, r * 0.95],
        friction: 0.85
      });

      const balloons: Island["balloons"] = [];
      const count = 3 + (i % 3);
      for (let b = 0; b < count; b++) {
        const a = (b / count) * Math.PI * 2 + i;
        balloons.push({
          ox: Math.cos(a) * (r + 1.2),
          oy: 4.5 + (b % 3) * 1.4,
          oz: Math.sin(a) * (r + 1.2),
          phase: Math.random() * Math.PI * 2,
          scale: 0.8 + (b % 2) * 0.25
        });
        totalBalloons++;
      }
      this.#islands.push({ x, y, z, r, balloons });
    }

    const balloonGeo = new THREE.SphereGeometry(0.62, 16, 12);
    const balloonMat = new THREE.MeshStandardMaterial({ roughness: 0.3 });
    this.#balloonMesh = new THREE.InstancedMesh(balloonGeo, balloonMat, totalBalloons);
    this.#balloonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#balloonMesh.frustumCulled = false;
    let bi = 0;
    const tint = new THREE.Color();
    for (const isl of this.#islands) {
      for (let b = 0; b < isl.balloons.length; b++) {
        tint.setHex(BALLOON_TINTS[bi % BALLOON_TINTS.length]);
        this.#balloonMesh.setColorAt(bi, tint);
        bi++;
      }
    }
    if (this.#balloonMesh.instanceColor) this.#balloonMesh.instanceColor.needsUpdate = true;
    scene.add(this.#balloonMesh);

    const stringGeo = new THREE.BufferGeometry();
    stringGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(totalBalloons * 6), 3));
    this.#strings = new THREE.LineSegments(
      stringGeo,
      new THREE.LineBasicMaterial({ color: 0xf5efdf, transparent: true, opacity: 0.7 })
    );
    this.#strings.frustumCulled = false;
    scene.add(this.#strings);
  }

  update(elapsed: number) {
    const attr = this.#strings.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let i = 0;
    for (const isl of this.#islands) {
      for (const b of isl.balloons) {
        const bob = Math.sin(elapsed * 0.8 + b.phase) * 0.5;
        const sway = Math.sin(elapsed * 0.5 + b.phase * 2) * 0.4;
        const bx = isl.x + b.ox + sway;
        const by = isl.y + b.oy + bob;
        const bz = isl.z + b.oz + sway * 0.6;
        this.#pos.set(bx, by, bz);
        this.#mat.compose(this.#pos, this.#quat, this.#scale.setScalar(b.scale));
        this.#balloonMesh.setMatrixAt(i, this.#mat);
        arr[i * 6] = isl.x + b.ox * 0.85;
        arr[i * 6 + 1] = isl.y + 0.6;
        arr[i * 6 + 2] = isl.z + b.oz * 0.85;
        arr[i * 6 + 3] = bx;
        arr[i * 6 + 4] = by - b.scale * 0.6;
        arr[i * 6 + 5] = bz;
        i++;
      }
    }
    this.#balloonMesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;
  }
}
