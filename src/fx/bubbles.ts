import * as THREE from "three/webgpu";
import { vec3, color, normalView, smoothstep, instancedBufferAttribute } from "three/tsl";
import { LIGHT_SCALE } from "../config";
import type { WorldMap } from "../world/heightmap";
import { waterHeight } from "../world/heightmap";
import type { Physics } from "../core/physics";

type N = any;

const MAX_BUBBLES = 160;
const MAX_POPS = 24;
const POP_TIME = 0.22;

type Bubble = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  age: number;
  life: number;
  seed: number;
};

type Pop = { pos: THREE.Vector3; radius: number; age: number };

/**
 * Soap bubbles: instanced spheres with a thin-film shell — iridescent bands
 * from the view-angle radial, additive so the city shows through. CPU sim is
 * tiny (≤160): buoyancy toward a gentle rise, sinusoidal wind drift, wobble in
 * the instance scale. Pop on buildings/ground/water or old age; the pop is a
 * one-frame-ish expanding flash ring from a second small pool.
 */
export class Bubbles {
  #bubbles: Bubble[] = [];
  #pops: Pop[] = [];
  #mesh: THREE.InstancedMesh;
  #popMesh: THREE.InstancedMesh;
  #anim: THREE.InstancedBufferAttribute;
  #popAnim: THREE.InstancedBufferAttribute;
  #map: WorldMap;
  #physics: Physics;
  #mat4 = new THREE.Matrix4();
  #quatI = new THREE.Quaternion();
  #pos = new THREE.Vector3();
  #scl = new THREE.Vector3();

  constructor(scene: THREE.Scene, map: WorldMap, physics: Physics) {
    this.#map = map;
    this.#physics = physics;

    // ---- bubble shell
    const geo = new THREE.SphereGeometry(1, 24, 16);
    this.#anim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BUBBLES * 2), 2);
    this.#anim.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshBasicNodeMaterial();
    const anim = instancedBufferAttribute(this.#anim) as unknown as N;
    const age = anim.x;
    const seed = anim.y;

    const nxy = (normalView as N).xy;
    const r = nxy.length(); // 0 facing the camera, 1 at the silhouette

    // soap-film interference: hue sweeps with the view angle, per-bubble phase
    const k = r.mul(7.0).add(seed.mul(37.0)).add(age.mul(1.4));
    const iri = vec3(k.cos(), k.add(2.094).cos(), k.add(4.188).cos()).mul(0.5).add(0.5);
    const film = smoothstep(0.3, 1.0, r).pow(1.8); // energy hugs the rim, centre nearly empty
    // fake sun glint: a hot dot where the view-space normal points up-left
    const glint = nxy.sub(vec3(-0.45, 0.55, 0).xy).length().mul(3.2).oneMinus().max(0.0).pow(3.0);

    mat.colorNode = iri
      .mul(film)
      .mul(0.5)
      .add((color(0xfff6e0) as N).mul(glint.mul(0.7)))
      .mul(LIGHT_SCALE * 0.5);
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.side = THREE.FrontSide;
    mat.fog = false;

    this.#mesh = new THREE.InstancedMesh(geo, mat, MAX_BUBBLES);
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.count = 0;
    this.#mesh.frustumCulled = false;
    scene.add(this.#mesh);

    // ---- pop flash: a bright ring that races outward and dies in ~0.2 s
    this.#popAnim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POPS), 1);
    this.#popAnim.setUsage(THREE.DynamicDrawUsage);
    const popMat = new THREE.MeshBasicNodeMaterial();
    const pAnim = instancedBufferAttribute(this.#popAnim) as unknown as N; // progress 0..1
    const pr = (normalView as N).xy.length();
    const ring = smoothstep(0.16, 0.0, pr.sub(pAnim.mul(0.9).add(0.1)).abs());
    popMat.colorNode = (color(0xcdf3ff) as N).mul(ring).mul(pAnim.oneMinus()).mul(LIGHT_SCALE * 0.8);
    popMat.transparent = true;
    popMat.blending = THREE.AdditiveBlending;
    popMat.depthWrite = false;
    popMat.fog = false;

    this.#popMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 12), popMat, MAX_POPS);
    this.#popMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#popMesh.count = 0;
    this.#popMesh.frustumCulled = false;
    scene.add(this.#popMesh);
  }

  /** One puff of bubbles from the wand. */
  blow(origin: THREE.Vector3, dir: THREE.Vector3, carrierVel: THREE.Vector3) {
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      if (this.#bubbles.length >= MAX_BUBBLES) this.#bubbles.shift();
      const spread = 0.16;
      this.#bubbles.push({
        pos: origin.clone().addScaledVector(dir, 1.6 + Math.random() * 0.8),
        vel: dir
          .clone()
          .multiplyScalar(7 + Math.random() * 4)
          .addScaledVector(carrierVel, 0.55)
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * spread * 14,
              Math.random() * 1.2,
              (Math.random() - 0.5) * spread * 14
            )
          ),
        radius: 0.3 + Math.random() * 0.55,
        age: 0,
        life: 7 + Math.random() * 6,
        seed: Math.random()
      });
    }
  }

  #pop(b: Bubble) {
    if (this.#pops.length >= MAX_POPS) this.#pops.shift();
    this.#pops.push({ pos: b.pos.clone(), radius: b.radius, age: 0 });
  }

  update(dt: number, elapsed: number) {
    // ---- sim
    for (let i = this.#bubbles.length - 1; i >= 0; i--) {
      const b = this.#bubbles[i];
      b.age += dt;
      // launch momentum bleeds off, buoyancy takes over
      const drag = Math.exp(-dt * 1.4);
      b.vel.x *= drag;
      b.vel.z *= drag;
      b.vel.y += (1.1 - b.vel.y) * (1 - Math.exp(-dt * 0.8));
      // lazy wind: two slow sine fields, plus a per-bubble waft
      const t = elapsed * 0.4 + b.seed * 20;
      b.vel.x += (Math.sin(b.pos.z * 0.013 + t) * 0.8 + Math.sin(t * 1.7) * 0.4) * dt;
      b.vel.z += (Math.cos(b.pos.x * 0.011 + t * 0.9) * 0.8 + Math.cos(t * 1.3) * 0.4) * dt;
      b.pos.addScaledVector(b.vel, dt);

      const ground = this.#map.effectiveGround(b.pos.x, b.pos.z);
      const water = this.#map.isWater(b.pos.x, b.pos.z);
      const floor = water ? Math.max(ground, waterHeight(b.pos.x, b.pos.z, elapsed)) : ground;
      const dead =
        b.age > b.life ||
        b.pos.y - b.radius < floor ||
        this.#physics.pointInBuilding(b.pos.x, b.pos.y, b.pos.z, b.radius * 0.4);
      if (dead) {
        this.#pop(b);
        this.#bubbles.splice(i, 1);
      }
    }

    // ---- instance sync
    const n = this.#bubbles.length;
    this.#mesh.count = n;
    for (let i = 0; i < n; i++) {
      const b = this.#bubbles[i];
      const w = 1 + Math.sin(b.age * 6.5 + b.seed * 40) * 0.055;
      // birth swell so bubbles bloom off the wand instead of popping into place
      const grow = Math.min(1, b.age * 4.5);
      this.#scl.set(b.radius * w * grow, (b.radius / w) * grow, b.radius * grow);
      this.#mat4.compose(this.#pos.copy(b.pos), this.#quatI, this.#scl);
      this.#mesh.setMatrixAt(i, this.#mat4);
      this.#anim.setXY(i, b.age, b.seed);
    }
    if (n > 0) {
      this.#mesh.instanceMatrix.needsUpdate = true;
      this.#anim.needsUpdate = true;
    }

    for (let i = this.#pops.length - 1; i >= 0; i--) {
      this.#pops[i].age += dt;
      if (this.#pops[i].age > POP_TIME) this.#pops.splice(i, 1);
    }
    const np = this.#pops.length;
    this.#popMesh.count = np;
    for (let i = 0; i < np; i++) {
      const p = this.#pops[i];
      const prog = p.age / POP_TIME;
      this.#scl.setScalar(p.radius * (1 + prog * 2.2));
      this.#mat4.compose(this.#pos.copy(p.pos), this.#quatI, this.#scl);
      this.#popMesh.setMatrixAt(i, this.#mat4);
      (this.#popAnim.array as Float32Array)[i] = prog;
    }
    if (np > 0) {
      this.#popMesh.instanceMatrix.needsUpdate = true;
      this.#popAnim.needsUpdate = true;
    }
  }
}
