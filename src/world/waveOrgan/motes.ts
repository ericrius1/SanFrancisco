// Bioluminescent spray over the jetty tip — the organ's completion payoff.
// Hidden until the song is remembered, then the field breathes in with the
// shared bloom uniform. One InstancedMesh (one draw), CPU-drifted, parented
// into the region's live (unfrozen) subtree.

import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { HEART } from "./layout";

const COUNT = 170;
const FIELD_R = 22; // spills off the tip onto the water
const FIELD_H = 13;

function hash(n: number): number {
  const s = Math.sin(n * 45.31 + 7.7) * 43758.5453;
  return s - Math.floor(s);
}

type Mote = { bx: number; by: number; bz: number; ph: number; amp: number; rise: number };

type N = any; // TSL node generics fight composition; `any` is the house idiom.

export class TideMotes {
  readonly group = new THREE.Group();
  #mesh: THREE.InstancedMesh;
  #motes: Mote[] = [];
  #m = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #p = new THREE.Vector3();
  #s = new THREE.Vector3();

  constructor(centerY: number, bloom: N, time: N) {
    this.group.name = "waveOrgan.motes";
    const geo = new THREE.SphereGeometry(0.065, 6, 5);
    const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
    mat.colorNode = color(0x081a17);
    // sea-glow speck, breathing on the shared clock, blooming in with the song
    const pulse: N = time.mul(1.1).sin().mul(0.2).add(0.8);
    (mat as unknown as { emissiveNode: unknown }).emissiveNode = color(0x9ffbe8)
      .mul(pulse)
      .mul(bloom)
      .mul(1.15 * LIGHT_SCALE);
    mat.opacity = 0.85;
    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.name = "waveOrgan.motes.mesh";

    for (let i = 0; i < COUNT; i++) {
      const a = hash(i) * Math.PI * 2;
      const r = Math.sqrt(hash(i + 1)) * FIELD_R;
      this.#motes.push({
        bx: HEART.x + Math.cos(a) * r,
        by: centerY + 0.4 + hash(i + 2) * FIELD_H,
        bz: HEART.z + Math.sin(a) * r,
        ph: hash(i + 3) * Math.PI * 2,
        amp: 0.4 + hash(i + 4) * 1.4,
        rise: 0.12 + hash(i + 5) * 0.45
      });
    }
    this.#mesh = mesh;
    this.#writeMatrices(0);
    this.group.add(mesh);
    this.group.visible = false;
  }

  #writeMatrices(t: number) {
    const mesh = this.#mesh;
    for (let i = 0; i < COUNT; i++) {
      const mo = this.#motes[i];
      const drift = Math.sin(t * 0.22 + mo.ph) * mo.amp;
      const bob = Math.sin(t * 0.55 + mo.ph * 1.7) * 0.5;
      const climb = (t * mo.rise + mo.ph) % FIELD_H;
      this.#p.set(
        mo.bx + drift,
        mo.by + bob + climb * 0.3 - FIELD_H * 0.15,
        mo.bz + Math.cos(t * 0.2 + mo.ph) * mo.amp
      );
      const sc = 0.55 + Math.sin(t * 0.75 + mo.ph) * 0.28 + 0.4;
      this.#s.setScalar(sc);
      this.#m.compose(this.#p, this.#q, this.#s);
      mesh.setMatrixAt(i, this.#m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  update(_dt: number, elapsed: number) {
    if (!this.group.visible) return;
    this.#writeMatrices(elapsed);
  }
}
