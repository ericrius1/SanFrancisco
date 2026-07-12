import type * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import { GolfCourse } from "./data";
import { GolfGame } from "./game";

export type { GolfNetMsg, GolfOptions } from "./game";
export { GolfGame, GOLF_SITE_PADS } from "./game";
export { GolfCourse } from "./data";

export async function loadGolfCourse(map: WorldMap): Promise<GolfCourse> {
  return GolfCourse.load(map);
}

/** Fetch the baked Presidio course + build the whole playable golf feature.
 *  `opts.daylight` (e.g. `() => sky.sunElevation > 0.05`) lets the NPC golfer
 *  groups pack up at night; omitted = they play around the clock. */
export async function createGolf(
  map: WorldMap,
  physics: Physics,
  scene: THREE.Scene,
  loaded?: GolfCourse,
  opts?: import("./game").GolfOptions
): Promise<GolfGame> {
  const course = loaded ?? (await GolfCourse.load(map));
  return new GolfGame(course, map, physics, scene, opts);
}
