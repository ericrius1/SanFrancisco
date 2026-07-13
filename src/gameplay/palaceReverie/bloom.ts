import * as THREE from "three/webgpu";
import { PALACE_LAGOON } from "../../world/heightmap";
import { REVERIE_ROTUNDA } from "./layout";

/**
 * Soft aurora ribbons + floating light rings that bloom over the lagoon when
 * the quest completes. Pure art — no gameplay cost when intensity is 0.
 */

type Ribbon = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicNodeMaterial;
  phase: number;
  speed: number;
  radius: number;
  y0: number;
};

export class CompletionBloom {
  readonly group = new THREE.Group();
  #ribbons: Ribbon[] = [];
  #rings: THREE.Mesh[] = [];
  #intensity = 0;
  #target = 0;

  constructor() {
    this.group.name = "palace-reverie-bloom";
    const hues = [0x9ef0ff, 0xffd6a0, 0xf4b4ff, 0xa8ffd2, 0xffc4d8];
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(hues[i]).convertSRGBToLinear(),
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      // Thin curved strip approximated as a bent plane ribbon via scaled torus arc
      const geo = new THREE.TorusGeometry(20 + i * 5.5, 0.28, 8, 56, Math.PI * 1.4);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = Math.PI / 2.35 + i * 0.1;
      mesh.position.set(PALACE_LAGOON.x, 12 + i * 2.6, PALACE_LAGOON.z);
      this.group.add(mesh);
      this.#ribbons.push({
        mesh,
        mat,
        phase: i * 1.1,
        speed: 0.1 + i * 0.035,
        radius: 20 + i * 5.5,
        y0: 12 + i * 2.6
      });
    }

    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(hues[i]).convertSRGBToLinear(),
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(2.5 + i * 2.8, 2.95 + i * 2.8, 56), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(REVERIE_ROTUNDA.x, 3.0 + i * 0.45, REVERIE_ROTUNDA.z);
      ring.name = `reverie-ring-${i}`;
      this.group.add(ring);
      this.#rings.push(ring);
    }

    // Soft vertical light shaft above the rotunda
    const shaftMat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(0xc8e8ff).convertSRGBToLinear(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 5.2, 48, 18, 1, true), shaftMat);
    shaft.position.set(REVERIE_ROTUNDA.x, 30, REVERIE_ROTUNDA.z);
    shaft.name = "reverie-shaft";
    this.group.add(shaft);
    this.#rings.push(shaft); // reuse for opacity drive via material
  }

  setComplete(on: boolean) {
    this.#target = on ? 1 : 0;
  }

  /** Instant set for cinematics. */
  snap(intensity: number) {
    this.#intensity = this.#target = THREE.MathUtils.clamp(intensity, 0, 1);
  }

  get intensity() {
    return this.#intensity;
  }

  update(dt: number, timeSec: number) {
    this.#intensity += (this.#target - this.#intensity) * Math.min(1, dt * 1.05);
    const i = this.#intensity;
    if (i < 0.001 && this.#target === 0) {
      for (const r of this.#ribbons) r.mat.opacity = 0;
      for (const ring of this.#rings) {
        const m = ring.material as THREE.MeshBasicNodeMaterial;
        m.opacity = 0;
      }
      return;
    }

    for (const r of this.#ribbons) {
      r.mat.opacity = i * (0.68 + 0.24 * Math.sin(timeSec * 1.3 + r.phase));
      r.mesh.rotation.z = timeSec * r.speed + r.phase;
      r.mesh.rotation.y = Math.sin(timeSec * 0.2 + r.phase) * 0.18 * i;
      r.mesh.position.y = r.y0 + Math.sin(timeSec * 0.6 + r.phase) * 2.2 * i;
      const swell = 0.9 + i * 0.14 + Math.sin(timeSec * 0.5 + r.phase) * 0.05 * i;
      r.mesh.scale.set(swell * 1.15, swell, swell * 1.15);
    }
    for (let k = 0; k < this.#rings.length; k++) {
      const ring = this.#rings[k];
      const m = ring.material as THREE.MeshBasicNodeMaterial;
      if (ring.name === "reverie-shaft") {
        m.opacity = i * 0.62;
        ring.rotation.y = timeSec * 0.12;
        ring.scale.set(1 + i * 0.35, 1, 1 + i * 0.35);
        continue;
      }
      m.opacity = i * (0.78 - k * 0.1);
      ring.rotation.z = timeSec * (0.18 + k * 0.05) * (k % 2 === 0 ? 1 : -1);
      ring.scale.setScalar(1 + Math.sin(timeSec * 0.9 + k) * 0.07 * i);
      ring.position.y = 2.8 + k * 0.5 + i * 2.6;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
  }
}
