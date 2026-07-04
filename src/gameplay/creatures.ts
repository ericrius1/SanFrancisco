import * as THREE from "three/webgpu";
import { time, hash, instanceIndex, positionLocal, abs, sin, vec3, float } from "three/tsl";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "../world/heightmap";
import { waterHeight } from "../world/heightmap";

/**
 * Ambient wildlife. Gull flocks wheel over the landmarks — one InstancedMesh,
 * with the wing flap done in the vertex shader (per-instance phase from a
 * hashed instance index), so 100+ birds cost one draw call and zero per-bird
 * skeleton work. And something big and green circles Alcatraz; it surfaces
 * every so often. Everything here is kinematic — no physics bodies.
 */

type Gull = {
  flock: number;
  radius: number;
  speed: number; // angular, rad/s (sign = direction)
  phase: number;
  height: number;
  bobPhase: number;
};

type Flock = { x: number; z: number; y: number; drift: number };

const GULLS_PER_FLOCK = 22;
const VISIBLE_RANGE = 1600;

function gullGeometry(): THREE.BufferGeometry {
  const white = new THREE.Color("#f4f2ec");
  const grey = new THREE.Color("#b9bcc0");
  const dark = new THREE.Color("#3a3d42");
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  };
  const body = paint(new THREE.BoxGeometry(0.16, 0.14, 0.52), white);
  const head = paint(new THREE.BoxGeometry(0.12, 0.1, 0.16), white);
  head.translate(0, 0.05, -0.3);
  const beak = paint(new THREE.BoxGeometry(0.05, 0.04, 0.12), dark);
  beak.translate(0, 0.03, -0.42);
  const wingL = paint(new THREE.BoxGeometry(0.92, 0.02, 0.3), grey);
  wingL.translate(-0.53, 0.05, 0);
  const wingR = paint(new THREE.BoxGeometry(0.92, 0.02, 0.3), grey);
  wingR.translate(0.53, 0.05, 0);
  const tipL = paint(new THREE.BoxGeometry(0.2, 0.021, 0.26), dark);
  tipL.translate(-0.95, 0.05, 0);
  const tipR = paint(new THREE.BoxGeometry(0.2, 0.021, 0.26), dark);
  tipR.translate(0.95, 0.05, 0);
  return mergeGeometries([body, head, beak, wingL, wingR, tipL, tipR]);
}

export class Creatures {
  #gullMesh: THREE.InstancedMesh;
  #gulls: Gull[] = [];
  #flocks: Flock[] = [];

  #serpent: THREE.InstancedMesh;
  #serpentSegs = 18;
  #serpentCenter = { x: 1848, z: -4058 };
  #serpentR = 170;

  #mat = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #euler = new THREE.Euler();

  constructor(map: WorldMap, scene: THREE.Scene) {
    // flocks over the postcard spots
    const spots: [number, number, number][] = [
      [4425, -608, 42], // Ferry Building
      [1848, -4058, 55], // Alcatraz
      [-700, -2380, 38], // Marina Green
      [3366, -1360, 70], // Coit Tower
      [-2947, -2289, 90] // Golden Gate south tower
    ];
    for (const [x, z, lift] of spots) {
      this.#flocks.push({ x, z, y: Math.max(map.effectiveGround(x, z), 0) + lift, drift: Math.random() * Math.PI * 2 });
    }
    for (let f = 0; f < this.#flocks.length; f++) {
      for (let i = 0; i < GULLS_PER_FLOCK; i++) {
        this.#gulls.push({
          flock: f,
          radius: 12 + Math.random() * 34,
          speed: (0.25 + Math.random() * 0.3) * (Math.random() < 0.5 ? 1 : -1),
          phase: Math.random() * Math.PI * 2,
          height: (Math.random() - 0.5) * 18,
          bobPhase: Math.random() * Math.PI * 2
        });
      }
    }

    const gullMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9 });
    // wing flap in the shader: outboard vertices swing up/down, phase per instance
    const phase = hash(instanceIndex).mul(6.283);
    const flap = sin(time.mul(9).add(phase)).mul(abs(positionLocal.x).mul(0.55));
    gullMat.positionNode = positionLocal.add(vec3(float(0), flap, float(0)));
    this.#gullMesh = new THREE.InstancedMesh(gullGeometry(), gullMat, this.#gulls.length);
    this.#gullMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#gullMesh.frustumCulled = false;
    this.#gullMesh.castShadow = false;
    this.#gullMesh.receiveShadow = false;
    scene.add(this.#gullMesh);

    const serpentMat = new THREE.MeshStandardMaterial({ color: "#2f8f6b", roughness: 0.35, metalness: 0.2 });
    this.#serpent = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 14), serpentMat, this.#serpentSegs);
    this.#serpent.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#serpent.frustumCulled = false;
    this.#serpent.castShadow = false;
    this.#serpent.receiveShadow = false;
    scene.add(this.#serpent);
  }

  update(elapsed: number, viewPos: THREE.Vector3) {
    this.#updateGulls(elapsed, viewPos);
    this.#updateSerpent(elapsed, viewPos);
  }

  #updateGulls(elapsed: number, viewPos: THREE.Vector3) {
    // skip matrix churn for flocks nobody can see
    const active: boolean[] = this.#flocks.map(
      (f) => Math.hypot(f.x - viewPos.x, f.z - viewPos.z) < VISIBLE_RANGE
    );
    if (!active.some(Boolean)) {
      this.#gullMesh.count = 0;
      return;
    }
    this.#gullMesh.count = this.#gulls.length;
    for (let i = 0; i < this.#gulls.length; i++) {
      const g = this.#gulls[i];
      const f = this.#flocks[g.flock];
      if (!active[g.flock]) {
        // park it far underground rather than reshuffling instance ids
        this.#mat.makeTranslation(f.x, -500, f.z);
        this.#gullMesh.setMatrixAt(i, this.#mat);
        continue;
      }
      const a = g.phase + elapsed * g.speed;
      const bob = Math.sin(elapsed * 0.7 + g.bobPhase) * 3;
      this.#pos.set(f.x + Math.cos(a) * g.radius, f.y + g.height + bob, f.z + Math.sin(a) * g.radius);
      // face along the direction of travel (mesh forward is -Z); bank into the circle
      const yaw = g.speed > 0 ? Math.PI - a : -a;
      this.#euler.set(0, yaw, g.speed > 0 ? 0.22 : -0.22, "YXZ");
      this.#quat.setFromEuler(this.#euler);
      this.#mat.compose(this.#pos, this.#quat, this.#scale.setScalar(1.3));
      this.#gullMesh.setMatrixAt(i, this.#mat);
    }
    this.#gullMesh.instanceMatrix.needsUpdate = true;
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
