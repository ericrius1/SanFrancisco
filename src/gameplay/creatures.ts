import * as THREE from "three/webgpu";
import { waterHeight } from "../world/heightmap";

/**
 * The kinematic bay serpent circling Alcatraz. It surfaces every so often and
 * has no physics body.
 */
const VISIBLE_RANGE = 1600;

export class Creatures {
  #serpent: THREE.InstancedMesh;
  #serpentSegs = 18;
  #serpentCenter = { x: 1848, z: -4058 };
  #serpentR = 170;

  #mat = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const serpentMat = new THREE.MeshStandardMaterial({ color: "#2f8f6b", roughness: 0.35, metalness: 0.2 });
    this.#serpent = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 14), serpentMat, this.#serpentSegs);
    this.#serpent.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#serpent.frustumCulled = false;
    this.#serpent.castShadow = false;
    this.#serpent.receiveShadow = false;
    scene.add(this.#serpent);
  }

  update(elapsed: number, viewPos: THREE.Vector3) {
    this.#updateSerpent(elapsed, viewPos);
  }

  #updateSerpent(elapsed: number, viewPos: THREE.Vector3) {
    const c = this.#serpentCenter;
    if (Math.hypot(c.x - viewPos.x, c.z - viewPos.z) > VISIBLE_RANGE + this.#serpentR) {
      this.#serpent.count = 0;
      return;
    }
    this.#serpent.count = this.#serpentSegs;
    const headA = elapsed * 0.055;
    // dive cycle: cruises just under the surface, arches out every ~40s
    const surface = (Math.sin(elapsed * 0.16) + 1) / 2; // 0 deep .. 1 breaching
    const baseDepth = -5 + surface * 6.2;
    for (let i = 0; i < this.#serpentSegs; i++) {
      const a = headA - i * 0.021; // arclength spacing along the circle
      const x = c.x + Math.cos(a) * this.#serpentR;
      const z = c.z + Math.sin(a) * this.#serpentR;
      // body wave: humps ripple down the spine, classic lake-monster silhouette
      const hump = Math.sin(elapsed * 1.4 - i * 0.9) * 1.4;
      const y = waterHeight(x, z, elapsed) + baseDepth + hump - i * 0.04;
      const s = i === 0 ? 2.3 : 1.9 - (i / this.#serpentSegs) * 1.3;
      this.#pos.set(x, y, z);
      this.#quat.identity();
      this.#mat.compose(this.#pos, this.#quat, this.#scale.set(s, s * 0.92, s * 1.15));
      this.#serpent.setMatrixAt(i, this.#mat);
    }
    this.#serpent.instanceMatrix.needsUpdate = true;
  }
}
