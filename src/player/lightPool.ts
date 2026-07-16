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

export type LightAnchorSpec = {
  color: number;
  intensity: number;
  distance: number;
  /** Ambient anchors only: claim a pool light only while the player is within
   * this many metres — a lit-but-distant feature must not hog a slot. */
  range?: number;
};

export const POOL_SIZE = 4;

/** A pool-lit lamp position on an embodiment (first POOL_SIZE found win). */
export function lightAnchor(spec: LightAnchorSpec, x: number, y: number, z: number): THREE.Object3D {
  const a = new THREE.Object3D();
  a.position.set(x, y, z);
  a.userData.lightSpec = spec;
  return a;
}

/**
 * World features (exhibit fills, act lighting) may NEVER add their own scene
 * lights — a light entering or leaving the visible set invalidates every lit
 * pipeline (observed as a 7s full-stop flying over the busker trio at night).
 * Instead they register an anchor here; whatever pool lights the active
 * embodiment doesn't claim serve the nearest-registered ambient anchors each
 * frame. An anchor whose spec intensity is 0 consumes no light, so a dormant
 * or daylight feature costs nothing. Degrades gracefully: with every pool
 * light claimed by the vehicle, the feature simply stays unlit.
 */
const ambientAnchors: THREE.Object3D[] = [];
const _anchorPos = new THREE.Vector3();

export function registerAmbientLightAnchor(anchor: THREE.Object3D): () => void {
  ambientAnchors.push(anchor);
  return () => {
    const index = ambientAnchors.indexOf(anchor);
    if (index >= 0) ambientAnchors.splice(index, 1);
  };
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

  /** Per-frame, after the active mesh's transform is set. `viewX/viewZ` (the
   * player) range-gate ambient anchors so distant features release their slot. */
  update(viewX?: number, viewZ?: number) {
    let next = 0;
    const feed = (anchor: THREE.Object3D) => {
      const l = this.lights[next++];
      const s = anchor.userData.lightSpec as LightAnchorSpec;
      anchor.getWorldPosition(l.position);
      l.color.setHex(s.color);
      l.intensity = s.intensity;
      l.distance = s.distance;
    };
    for (const anchor of this.#anchors) {
      if (next >= this.lights.length) break;
      feed(anchor);
    }
    // Leftover lights serve world features (see registerAmbientLightAnchor).
    for (const anchor of ambientAnchors) {
      if (next >= this.lights.length) break;
      const s = anchor.userData.lightSpec as LightAnchorSpec | undefined;
      if (!s || s.intensity <= 0) continue;
      if (s.range !== undefined && viewX !== undefined && viewZ !== undefined) {
        anchor.getWorldPosition(_anchorPos);
        if (Math.hypot(_anchorPos.x - viewX, _anchorPos.z - viewZ) > s.range) continue;
      }
      feed(anchor);
    }
    while (next < this.lights.length) this.lights[next++].intensity = 0;
  }
}
