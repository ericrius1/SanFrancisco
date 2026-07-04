import * as THREE from "three/webgpu";
import { color, uniform, normalView, smoothstep } from "three/tsl";
import { LIGHT_SCALE } from "../config";

type N = any;

const POOL = 8;
const DURATION = 0.55;

type Shell = {
  mesh: THREE.Mesh;
  prog: ReturnType<typeof uniform>;
  radius: number;
  active: boolean;
};

/**
 * Impact ripple: an expanding translucent shell at the detonation point. The
 * silhouette-weighted alpha makes it read as a pressure bubble; concentric
 * bands slide outward across it so the surface visibly ripples as it grows.
 * Small fixed pool, meshes reused round-robin.
 */
export class Shockwaves {
  #shells: Shell[] = [];
  #next = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(1, 36, 20);
    for (let i = 0; i < POOL; i++) {
      const prog = uniform(0);
      const mat = new THREE.MeshBasicNodeMaterial();

      const nxy = (normalView as N).xy;
      const r = nxy.length(); // 0 facing the camera, 1 at the silhouette
      const shell = r.pow(3.0); // energy hugs the edge — bubble, not blob
      const bands = r.mul(22.0).sub((prog as N).mul(18.0)).sin().mul(0.5).add(0.5);
      const fade = (prog as N).oneMinus().pow(1.6);
      // soften the very first frames so the shell blooms in instead of popping
      const grow = smoothstep(0.0, 0.12, prog as N);

      mat.colorNode = (color(0xffd9a0) as N)
        .mul(shell)
        .mul(bands.mul(0.6).add(0.45))
        .mul(fade)
        .mul(grow)
        .mul(0.9)
        .mul(LIGHT_SCALE);
      mat.transparent = true;
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      mat.fog = false;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.#shells.push({ mesh, prog, radius: 1, active: false });
    }
  }

  spawn(pos: THREE.Vector3, radius: number) {
    const s = this.#shells[this.#next];
    this.#next = (this.#next + 1) % POOL;
    s.active = true;
    s.radius = radius;
    s.prog.value = 0;
    s.mesh.position.copy(pos);
    s.mesh.scale.setScalar(0.01);
    s.mesh.visible = true;
  }

  update(dt: number) {
    for (const s of this.#shells) {
      if (!s.active) continue;
      s.prog.value = Math.min(1, (s.prog.value as number) + dt / DURATION);
      const p = s.prog.value as number;
      const ease = 1 - (1 - p) ** 3;
      s.mesh.scale.setScalar(Math.max(0.01, s.radius * (0.15 + 1.05 * ease)));
      if (p >= 1) {
        s.active = false;
        s.mesh.visible = false;
      }
    }
  }
}
