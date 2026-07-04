import * as THREE from "three/webgpu";
import type { FireContext, Launcher } from "./types";

/**
 * A honeycombed firework rack — a box of hex-packed tubes. Firing lofts one
 * shell out of every tube along the rack's barrel axis (local +Y, tilted
 * outward at mount time) so the whole comb goes up at once and bursts ~5s later
 * over the city. Knows nothing about the host it's bolted to.
 */
export class FireworkLauncher implements Launcher {
  readonly group = new THREE.Group();
  #tubes: THREE.Object3D[] = [];
  #glow: THREE.MeshBasicMaterial[] = [];
  #chargeT = 0;

  constructor(opts: { rows?: number; cols?: number; spacing?: number; fuse?: number } = {}) {
    const { rows = 3, cols = 5, spacing = 0.135 } = opts;
    this.#fuse = opts.fuse ?? 5;
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(cols * spacing + 0.12, 0.36, rows * spacing + 0.12),
      new THREE.MeshLambertMaterial({ color: 0x23262d })
    );
    housing.castShadow = true;
    this.group.add(housing);
    const tubeMat = new THREE.MeshLambertMaterial({ color: 0x111318 });
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xb22234 });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const off = (r % 2) * spacing * 0.5; // hex offset
        const x = (c - (cols - 1) / 2) * spacing + off;
        const z = (r - (rows - 1) / 2) * spacing;
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(spacing * 0.4, spacing * 0.4, 0.34, 8), tubeMat);
        tube.position.set(x, 0.03, z);
        this.group.add(tube);
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(spacing * 0.44, spacing * 0.44, 0.05, 8), rimMat);
        rim.position.set(x, 0.2, z);
        this.group.add(rim);
        // charge glow inside the mouth
        const gm = new THREE.MeshBasicMaterial({ color: 0xffb038, transparent: true, opacity: 0 });
        const glow = new THREE.Mesh(new THREE.CylinderGeometry(spacing * 0.34, spacing * 0.34, 0.02, 8), gm);
        glow.position.set(x, 0.19, z);
        this.group.add(glow);
        this.#glow.push(gm);
        const mouth = new THREE.Object3D();
        mouth.position.set(x, 0.22, z);
        this.group.add(mouth);
        this.#tubes.push(mouth);
      }
    }
  }

  #fuse: number;

  update(dt: number) {
    // subtle breathing ember in the tubes so the rack reads as "loaded"
    this.#chargeT += dt;
    const o = 0.12 + Math.sin(this.#chargeT * 2.4) * 0.06;
    for (const g of this.#glow) g.opacity = o;
  }

  fire(ctx: FireContext) {
    const origin = new THREE.Vector3();
    const barrel = new THREE.Vector3();
    const q = new THREE.Quaternion();
    this.group.getWorldQuaternion(q);
    barrel.set(0, 1, 0).applyQuaternion(q).normalize(); // barrel axis in world
    // a right vector to scatter shells laterally across the fan
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const target = new THREE.Vector3();
    for (const tube of this.#tubes) {
      tube.getWorldPosition(origin);
      const range = 84 + Math.random() * 26;
      const T = this.#fuse * (0.94 + Math.random() * 0.12);
      target
        .copy(origin)
        .addScaledVector(barrel, range)
        .addScaledVector(right, (Math.random() - 0.5) * 26);
      ctx.fireworks.launchShell(origin, target, T);
      // muzzle flash
      const idx = this.#tubes.indexOf(tube);
      if (this.#glow[idx]) this.#glow[idx].opacity = 1;
    }
  }
}
