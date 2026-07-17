// Lands End region — Archetype A (always in scene, distance-LOD self-gating).
// The cliff-top Labyrinth, a lantern-keeper at its mouth, wind-bent cypress on
// the rim, and drifting sea-mist motes overhead. Beyond DETAIL_RANGE the whole
// group hides and update() early-returns.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { Labyrinth } from "./labyrinth";
import { LanternKeeper } from "./lanternKeeper";
import { SeaMotes } from "./motes";
import { EyeWalker } from "./eyeWalker";
import type { LandsEndFoliage } from "./vegetation";
import { LABYRINTH, LANDS_END_CENTER } from "./layout";

export { LABYRINTH, LANDS_END_CENTER, KEEPER, RUINS, inLandsEnd, distToLabyrinth } from "./layout";
export { Labyrinth } from "./labyrinth";
export { LanternKeeper } from "./lanternKeeper";
export { EyeWalker } from "./eyeWalker";

const DETAIL_RANGE = 760; // m from the headland centre — draw nothing beyond

export class LandsEndRegion {
  readonly group = new THREE.Group();
  readonly foliage = new THREE.Group();
  /** Warms the lazily planted foliage subtree off-frame before it attaches. */
  prepareFoliage: ((group: THREE.Group) => Promise<void>) | null = null;
  #labyrinth: Labyrinth;
  #keeper: LanternKeeper;
  #motes: SeaMotes;
  #walker: EyeWalker;
  #map: WorldMap;
  #foliageOn = true;
  #foliageRuntime: LandsEndFoliage | null = null;
  #foliageLoading: Promise<void> | null = null;
  #disposed = false;
  #foliageFocus: { x: number; z: number } = { x: LABYRINTH.x, z: LABYRINTH.z };

  constructor(map: WorldMap) {
    this.group.name = "landsEnd";
    this.foliage.name = "landsEnd.foliage";
    this.#map = map;

    this.#labyrinth = new Labyrinth(map);
    this.#keeper = new LanternKeeper(map);
    this.#motes = new SeaMotes(map.groundTop(LABYRINTH.x, LABYRINTH.z));
    this.#walker = new EyeWalker(map);

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
    this.#foliageOn = visible;
    this.foliage.visible = visible && this.foliage.visible;
  }

  /** First-approach gate: imports the unified vegetation module, plants the
   *  cypress grove through the shared NativeTreeForest, warms it off-frame,
   *  then attaches. The region stays fully usable while this resolves. */
  #ensureFoliage() {
    if (this.#foliageRuntime || this.#foliageLoading || this.#disposed) return;
    this.#foliageLoading = import("./vegetation")
      .then(async ({ createLandsEndFoliage }) => {
        const patch = createLandsEndFoliage(this.#map);
        patch.update(this.#foliageFocus);
        await patch.ready;
        patch.update(this.#foliageFocus);
        // Attach only after any owner-provided warm pass; hidden roots skip
        // rendering, and attaching first would hitch a live frame.
        await this.prepareFoliage?.(patch.group);
        if (this.#disposed) {
          patch.dispose();
          return;
        }
        this.#foliageRuntime = patch;
        this.foliage.add(patch.group);
        // `foliage` was frozen with the other static subtrees before this lazy
        // child existed, so explicitly establish its first world matrix.
        this.foliage.updateMatrixWorld(true);
      })
      .catch((error) => {
        this.#foliageLoading = null;
        console.warn("[lands end] unified foliage unavailable:", error);
      });
  }

  /** Full teardown for a distance unload. The lantern-keeper's rig boxes come
   * from player/rig's shared geometry cache, so that subtree is detached
   * rather than disposed; everything else here is locally built. */
  dispose() {
    this.#disposed = true;
    this.#foliageRuntime?.dispose();
    this.#foliageRuntime = null;
    this.#foliageLoading = null;
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
    if (!near) {
      this.foliage.visible = false;
      return;
    }
    this.foliage.visible = this.#foliageOn;
    if (this.foliage.visible) {
      this.#foliageFocus.x = playerPos.x;
      this.#foliageFocus.z = playerPos.z;
      this.#ensureFoliage();
      this.#foliageRuntime?.update(this.#foliageFocus);
    }
    this.#labyrinth.update(dt, playerPos.x, playerPos.z);
    this.#keeper.update(dt, elapsed);
    this.#motes.update(dt, elapsed);
    this.#walker.update(dt, elapsed, playerPos, camera, gust);
  }
}
