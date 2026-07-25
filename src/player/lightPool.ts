import * as THREE from "three/webgpu";

/**
 * The scene's single contextual light. Together with the permanent sun/moon
 * DirectionalLight this is the complete two-light render budget.
 *
 * The scene's light set must never change size — adding/removing a light
 * rebuilds every lit pipeline (the old 7s boat-switch freeze) — but every light
 * in the set also costs full punctual-light math in every lit fragment on
 * screen, all the time, even at intensity 0. The old setup carried 11
 * per-vehicle PointLights permanently (boat 9, board 2), then four shared
 * PointLights. This pool keeps exactly one PointLight alive for the lifetime of
 * the world.
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

export const POOL_SIZE = 1;

/** A pool-lit lamp position on an embodiment (the first ELIGIBLE ones win). */
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
 * Instead they register an anchor here. The active embodiment owns the
 * contextual light whenever it has an enabled anchor; otherwise the nearest
 * eligible world anchor owns it. An anchor whose spec intensity is 0 consumes
 * no light, so a dormant or daylight feature costs nothing.
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

// Keep every anchor an embodiment declares, not the first POOL_SIZE found:
// update() filters on intensity/visibility, so truncating here would make a
// zeroed or hidden lead anchor swallow the slot and leave the later markers
// unreachable dead code instead of the fallbacks they are authored to be.
function collectAnchors(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.lightSpec) out.push(o);
  });
  return out;
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
      const s = anchor.userData.lightSpec as LightAnchorSpec | undefined;
      if (!s || s.intensity <= 0 || !isEffectivelyVisible(anchor)) continue;
      feed(anchor);
    }
    // If the embodiment does not need the slot, pick the nearest eligible world
    // feature. Registration order must not decide lighting in an open world.
    if (next < this.lights.length) {
      let nearest: THREE.Object3D | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const anchor of ambientAnchors) {
        const s = anchor.userData.lightSpec as LightAnchorSpec | undefined;
        if (!s || s.intensity <= 0 || !isEffectivelyVisible(anchor)) continue;
        anchor.getWorldPosition(_anchorPos);
        const distance = viewX === undefined || viewZ === undefined
          ? 0
          : Math.hypot(_anchorPos.x - viewX, _anchorPos.z - viewZ);
        if (s.range !== undefined && distance > s.range) continue;
        if (distance >= nearestDistance) continue;
        nearest = anchor;
        nearestDistance = distance;
      }
      if (nearest) feed(nearest);
    }
    while (next < this.lights.length) this.lights[next++].intensity = 0;
  }
}

function isEffectivelyVisible(anchor: THREE.Object3D): boolean {
  for (let object: THREE.Object3D | null = anchor; object; object = object.parent) {
    if (!object.visible) return false;
    if ((object as THREE.Scene).isScene) return true;
  }
  return false;
}
