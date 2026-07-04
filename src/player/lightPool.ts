import * as THREE from "three/webgpu";

/**
 * Shared vehicle light pool. The scene's light set must never change size —
 * adding/removing a light rebuilds every lit pipeline (the old 7s boat-switch
 * freeze) — but every light in the set also costs full punctual-light math in
 * every lit fragment on screen, all the time, even at intensity 0. The old
 * setup carried 11 per-vehicle PointLights permanently (boat 9, board 2); this
 * pool caps that scene-wide per-pixel tax at POOL_SIZE lights total.
 *
 * Embodiment meshes place `lightAnchor` markers (plain Object3Ds with a spec)
 * where their lamps sit. On mode switch the pool claims the active mesh's
 * anchors; each frame it copies anchor world positions + specs into its fixed
 * lights. Unclaimed lights idle at intensity 0.
 */

export type LightAnchorSpec = { color: number; intensity: number; distance: number };

export const POOL_SIZE = 4;

/** A pool-lit lamp position on an embodiment (first POOL_SIZE found win). */
export function lightAnchor(spec: LightAnchorSpec, x: number, y: number, z: number): THREE.Object3D {
  const a = new THREE.Object3D();
  a.position.set(x, y, z);
  a.userData.lightSpec = spec;
  return a;
}

function collectAnchors(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.lightSpec) out.push(o);
  });
  return out.slice(0, POOL_SIZE);
}

export class LightPool {
  lights: THREE.PointLight[] = [];
  #anchors: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1, 2);
      scene.add(l);
      this.lights.push(l);
    }
  }

  /** Point the pool at this embodiment's anchors (null → all dark). */
  claim(root: THREE.Object3D | null) {
    this.#anchors = root ? collectAnchors(root) : [];
  }

  /** Per-frame, after the active mesh's transform is set. */
  update() {
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const a = this.#anchors[i];
      if (!a) {
        l.intensity = 0;
        continue;
      }
      const s = a.userData.lightSpec as LightAnchorSpec;
      a.getWorldPosition(l.position);
      l.color.setHex(s.color);
      l.intensity = s.intensity;
      l.distance = s.distance;
    }
  }
}
