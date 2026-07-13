// Drifting sea-mist motes over the Lands End headland — faint glowing specks
// that hover and bob in the marine air, like bioluminescent spray caught in the
// dusk. One InstancedMesh (one draw), CPU-drifted; parented into the region's
// live (unfrozen) subtree so its per-frame matrices take effect.

import * as THREE from "three/webgpu";
import { color, uniform } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { LABYRINTH } from "./layout";

const COUNT = 240;
const FIELD_R = 34; // horizontal radius of the drifting field
const FIELD_H = 18; // ceiling above the labyrinth

const MOTE_TIME = uniform(0);

function hash(n: number): number {
  const s = Math.sin(n * 45.31 + 7.7) * 43758.5453;
  return s - Math.floor(s);
}

type Mote = { bx: number; by: number; bz: number; ph: number; amp: number; rise: number };

export class SeaMotes {
  readonly group = new THREE.Group();
  #mesh: THREE.InstancedMesh;
  #motes: Mote[] = [];
  #m = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #p = new THREE.Vector3();
  #s = new THREE.Vector3();

  constructor(centerY: number) {
    this.group.name = "landsEnd.motes";
    const geo = new THREE.SphereGeometry(0.07, 6, 5);
    const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
    mat.colorNode = color(0x0a1a1a);
    // soft teal-white glow, gently breathing via the shared clock
    const pulse = MOTE_TIME.mul(1.0).sin().mul(0.2).add(0.8);
    (mat as unknown as { emissiveNode: unknown }).emissiveNode = color(0xbafff0).mul(pulse).mul(1.1 * LIGHT_SCALE);
    mat.opacity = 0.85;
    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.name = "landsEnd.motes.mesh";

    for (let i = 0; i < COUNT; i++) {
      const a = hash(i) * Math.PI * 2;
      const r = Math.sqrt(hash(i + 1)) * FIELD_R;
      this.#motes.push({
        bx: LABYRINTH.x + Math.cos(a) * r,
        by: centerY + 0.6 + hash(i + 2) * FIELD_H,
        bz: LABYRINTH.z + Math.sin(a) * r,
        ph: hash(i + 3) * Math.PI * 2,
        amp: 0.5 + hash(i + 4) * 1.6,
        rise: 0.15 + hash(i + 5) * 0.5
      });
    }
    this.#mesh = mesh;
    this.#writeMatrices(0);
    this.group.add(mesh);
  }

  #writeMatrices(t: number) {
    const mesh = this.#mesh;
    for (let i = 0; i < COUNT; i++) {
      const mo = this.#motes[i];
      const drift = Math.sin(t * 0.25 + mo.ph) * mo.amp;
      const bob = Math.sin(t * 0.6 + mo.ph * 1.7) * 0.6;
      // slow upward drift toward the sea (−x/−z), wrapping through the ceiling
      const climb = ((t * mo.rise + mo.ph) % FIELD_H);
      this.#p.set(
        mo.bx + drift - climb * 0.25,
        mo.by + bob + climb * 0.3 - FIELD_H * 0.15,
        mo.bz + Math.cos(t * 0.22 + mo.ph) * mo.amp - climb * 0.12
      );
      const sc = 0.6 + Math.sin(t * 0.8 + mo.ph) * 0.3 + 0.4;
      this.#s.setScalar(sc);
      this.#m.compose(this.#p, this.#q, this.#s);
      mesh.setMatrixAt(i, this.#m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, elapsed: number) {
    MOTE_TIME.value += dt;
    this.#writeMatrices(elapsed);
  }
}
