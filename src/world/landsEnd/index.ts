// Lands End region — Archetype A (always in scene, distance-LOD self-gating).
// The cliff-top Labyrinth, a lantern-keeper at its mouth, wind-bent cypress on
// the rim, and drifting sea-mist motes overhead. Beyond DETAIL_RANGE the whole
// group hides and update() early-returns.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { Labyrinth } from "./labyrinth";
import { LanternKeeper } from "./lanternKeeper";
import { SeaMotes } from "./motes";
import { buildCypressGrove } from "./cypress";
import { EyeWalker } from "./eyeWalker";
import { LABYRINTH, LANDS_END_CENTER } from "./layout";

export { LABYRINTH, LANDS_END_CENTER, KEEPER, RUINS, inLandsEnd, distToLabyrinth } from "./layout";
export { Labyrinth } from "./labyrinth";
export { LanternKeeper } from "./lanternKeeper";
export { EyeWalker } from "./eyeWalker";

const DETAIL_RANGE = 760; // m from the headland centre — draw nothing beyond

export class LandsEndRegion {
  readonly group = new THREE.Group();
  readonly foliage = new THREE.Group();
  #labyrinth: Labyrinth;
  #keeper: LanternKeeper;
  #motes: SeaMotes;
  #walker: EyeWalker;

  constructor(map: WorldMap) {
    this.group.name = "landsEnd";
    this.foliage.name = "landsEnd.foliage";

    this.#labyrinth = new Labyrinth(map);
    this.#keeper = new LanternKeeper(map);
    this.#motes = new SeaMotes(map.groundTop(LABYRINTH.x, LABYRINTH.z));
    this.#walker = new EyeWalker(map);
    this.foliage.add(buildCypressGrove(map));

    // static subtrees (frozen after one flush)
    this.group.add(this.#labyrinth.group);
    this.group.add(this.foliage);
    // live subtrees (kept unfrozen so their per-frame transforms take effect)
    const live = new Set<THREE.Object3D>([
      this.#labyrinth.activity,
      this.#keeper.group,
      this.#motes.group,
      this.#walker.group
    ]);
    for (const o of live) this.group.add(o);

    for (const child of this.group.children) {
      if (live.has(child)) continue;
      child.updateMatrixWorld(true);
      child.matrixWorldAutoUpdate = false;
    }
  }

  get labyrinth(): Labyrinth {
    return this.#labyrinth;
  }

  get keeper(): LanternKeeper {
    return this.#keeper;
  }

  get walker(): EyeWalker {
    return this.#walker;
  }

  setFoliageVisible(visible: boolean) {
    this.foliage.visible = visible;
  }

  /** Full teardown for a distance unload. The lantern-keeper's rig boxes come
   * from player/rig's shared geometry cache, so that subtree is detached
   * rather than disposed; everything else here is locally built. */
  dispose() {
    this.#walker.dispose();
    this.#keeper.group.removeFromParent();
    this.group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) return;
      geometries.add((object as THREE.Mesh).geometry);
      const material = (object as THREE.Mesh).material;
      const list = Array.isArray(material) ? material : [material];
      for (const m of list) materials.add(m);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.clear();
  }

  update(
    dt: number,
    elapsed: number,
    playerPos: { x: number; z: number },
    camera?: THREE.Camera,
    gust = 0
  ) {
    const dist = Math.hypot(playerPos.x - LANDS_END_CENTER.x, playerPos.z - LANDS_END_CENTER.z);
    const near = dist < DETAIL_RANGE;
    // Always assign visibility so a debug perf-suppress that hid the group while
    // near can restore cleanly on the next enabled frame.
    this.group.visible = near;
    if (!near) return;
    this.#labyrinth.update(dt, playerPos.x, playerPos.z);
    this.#keeper.update(dt, elapsed);
    this.#motes.update(dt, elapsed);
    this.#walker.update(dt, elapsed, playerPos, camera, gust);
  }
}
