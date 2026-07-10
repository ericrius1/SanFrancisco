import type * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import { GolfCourse } from "./data";
import { GolfGame } from "./game";

export type { GolfNetMsg } from "./game";
export { GolfGame } from "./game";

/** Fetch the baked Presidio course + build the whole playable golf feature. */
export async function createGolf(map: WorldMap, physics: Physics, scene: THREE.Scene): Promise<GolfGame> {
  const course = await GolfCourse.load(map);
  return new GolfGame(course, map, physics, scene);
}
