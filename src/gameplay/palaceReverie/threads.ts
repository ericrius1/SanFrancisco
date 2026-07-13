import * as THREE from "three/webgpu";
import type { MemoryLamp } from "./memoryLamps";

/**
 * Soft luminous ribbons that stitch lit memory lamps together — a visible
 * "the gallery is remembering" cue as the quest progresses. Each pair is two
 * segments through a raised apex so the thread reads as an arc, not a rod.
 */
export class LampThreads {
  readonly group = new THREE.Group();
  #segs: THREE.Mesh[] = [];
  #mats: THREE.MeshBasicNodeMaterial[] = [];

  constructor() {
    this.group.name = "palace-reverie-threads";
    // 5 pairs × 2 segments (includes closing loop when all lamps lit)
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(0xffe0b0),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.#segs.push(mesh);
      this.#mats.push(mat);
    }
  }

  #placeSeg(
    idx: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number,
    opacity: number,
    hue: number
  ) {
    const mesh = this.#segs[idx];
    const mat = this.#mats[idx];
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = dir.length();
    if (len < 0.01) {
      mesh.visible = false;
      mat.opacity = 0;
      return;
    }
    dir.multiplyScalar(1 / len);
    mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    mesh.quaternion.setFromUnitVectors(up, dir);
    mesh.scale.set(radius, len, radius);
    mat.opacity = opacity;
    mat.color.setHex(hue);
    mesh.visible = true;
  }

  update(lamps: readonly MemoryLamp[], timeSec: number) {
    const lit = lamps.filter((l) => l.lit && l.awakenT > 0.35);
    const close = lit.length >= 5;
    const pairs = close ? lit.length : Math.max(0, lit.length - 1);

    for (let i = 0; i < 5; i++) {
      const a = lit[i];
      const b = lit[(i + 1) % lit.length];
      const use = i < pairs && a && b && (i < lit.length - 1 || close);
      if (!use || !a || !b) {
        this.#segs[i * 2].visible = false;
        this.#segs[i * 2 + 1].visible = false;
        this.#mats[i * 2].opacity = 0;
        this.#mats[i * 2 + 1].opacity = 0;
        continue;
      }
      const strength = Math.min(a.awakenT, b.awakenT);
      const bob = Math.sin(timeSec * 1.6 + i) * 0.14;
      const y0 = a.y + 1.25 + bob;
      const y1 = b.y + 1.25 - bob;
      const apexY = Math.max(y0, y1) + 3.4 + strength * 2.0 + Math.sin(timeSec * 2.1 + i) * 0.45;
      const sway = Math.sin(timeSec * 0.9 + i) * (1.2 + strength);
      const mx = (a.x + b.x) * 0.5 + Math.cos(timeSec * 0.55 + i) * sway * 0.15;
      const mz = (a.z + b.z) * 0.5 + Math.sin(timeSec * 0.55 + i) * sway * 0.15;
      const radius = 0.06 + strength * 0.12;
      const opacity = 0.45 + strength * 0.55 + Math.sin(timeSec * 3 + i) * 0.14;
      this.#placeSeg(i * 2, a.x, y0, a.z, mx, apexY, mz, radius, opacity, a.hue);
      this.#placeSeg(i * 2 + 1, mx, apexY, mz, b.x, y1, b.z, radius, opacity, b.hue);
    }
  }

  dispose() {
    for (const mesh of this.#segs) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
