import * as THREE from "three/webgpu";
import {
  vec2,
  vec3,
  color,
  time,
  smoothstep,
  normalView,
  mx_noise_float,
  instancedBufferAttribute
} from "three/tsl";
import { CONFIG, LIGHT_SCALE } from "../config";
import type { Physics } from "../core/physics";

type N = any;

const MAX_TRACERS = 64;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Tracer rounds: instanced energy orbs stretched along their velocity. The
 * shell is unlit + additive; the interior fakes depth with
 * three filament layers sampled at different scales of the view-space normal,
 * so they parallax against each other as the orb streaks past — cheap
 * matcap-style parallax, no raymarch.
 *
 * anim attr: x = age (s since fire), y = per-shot seed 0..1.
 */
export class ProjectileTracers {
  mesh: THREE.InstancedMesh;
  #anim: THREE.InstancedBufferAttribute;
  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scl = new THREE.Vector3();
  #dir = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(CONFIG.projectileRadius * 1.6, 20, 14);
    // not attached to the geometry: instancedBufferAttribute() owns the upload,
    // same pattern as the debris material's per-instance attributes
    this.#anim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRACERS * 2), 2);
    this.#anim.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshBasicNodeMaterial();
    const anim = instancedBufferAttribute(this.#anim) as unknown as N;
    const age = anim.x;
    const seed = anim.y;

    // radial coordinate over the visible disc: 0 facing the camera, 1 at the
    // silhouette. All the layering is built on this + the view-space normal,
    // which is instance-rotation safe (the orb spins along its velocity).
    const nxy = (normalView as N).xy;
    const r = nxy.length();

    // a filament layer: ridged noise over the view-space normal; smaller scale
    // moves less across the disc as the view shifts, reading as deeper inside
    const filaments = (scale: number, drift: number, width: number): N => {
      const q = vec3(
        nxy.mul(scale).add(vec2(seed.mul(31.7), seed.mul(17.3))),
        time.mul(drift).add(seed.mul(87.0))
      );
      return smoothstep(width, 0.0, mx_noise_float(q).abs());
    };
    const deep = filaments(1.3, 0.4, 0.16);
    const mid = filaments(2.6, 0.9, 0.13);
    const near = filaments(4.4, 1.7, 0.09);

    const core = r.mul(r).oneMinus().pow(2); // hot centre
    const edgeFade = smoothstep(1.0, 0.7, r); // gas ball, not a hard sphere
    const rim = smoothstep(0.5, 0.92, r).mul(smoothstep(1.0, 0.93, r)); // thin shell ring

    // birth ripple: a ring sweeps out over the first third of a second
    const ringR = age.mul(2.8).clamp(0.0, 1.0);
    const ring = smoothstep(0.14, 0.0, r.sub(ringR).abs()).mul(ringR.oneMinus());
    const pulse = age.mul(6.0).negate().exp().mul(0.9).add(1.0); // muzzle flash-out
    const flicker = time.mul(37.0).add(seed.mul(113.0)).sin().mul(0.08).add(0.96);

    const col = (color(0xfff3d0) as N)
      .mul(core.mul(1.25))
      .add((color(0x9a3cff) as N).mul(deep.mul(0.4)))
      .add((color(0xff8a3c) as N).mul(mid.mul(0.8)))
      .add((color(0xffe9b0) as N).mul(near.mul(1.0)))
      .add((color(0xffc86e) as N).mul(rim.mul(0.7)))
      .add((color(0xffffff) as N).mul(ring.mul(0.9)))
      .mul(edgeFade)
      .mul(pulse)
      .mul(flicker)
      .mul(LIGHT_SCALE);

    mat.colorNode = col;
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.fog = false;

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_TRACERS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Pose every live projectile: oriented along velocity, stretched by speed. */
  sync(physics: Physics) {
    const list = physics.projectiles;
    const n = Math.min(list.length, MAX_TRACERS);
    this.mesh.count = n;
    for (let i = 0; i < n; i++) {
      const pr = list[i];
      const t = physics.world.getBodyTransform(pr.handle);
      const v = physics.world.getBodyVelocity(pr.handle).linear;
      const speed = Math.hypot(v[0], v[1], v[2]);
      if (speed > 1) this.#dir.set(v[0] / speed, v[1] / speed, v[2] / speed);
      else this.#dir.copy(Z_AXIS);
      this.#quat.setFromUnitVectors(Z_AXIS, this.#dir);
      const stretch = 1 + Math.min(speed * 0.02, 2.2);
      this.#scl.set(1, 1, stretch);
      this.#pos.set(t.position[0], t.position[1], t.position[2]);
      this.#mat4.compose(this.#pos, this.#quat, this.#scl);
      this.mesh.setMatrixAt(i, this.#mat4);
      this.#anim.setXY(i, pr.age, pr.seed);
    }
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.#anim.needsUpdate = true;
    }
  }
}
