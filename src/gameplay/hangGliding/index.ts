import type * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import { HangGlidingExperience } from "./experience";

export { HangGlidingExperience } from "./experience";
export { HANG_GLIDING_LABEL, HANG_GLIDING_SITE } from "./meta";
export { createHangGlidingCourse, sampleHangGlidingLift } from "./layout";

export function createHangGliding(
  map: WorldMap,
  physics: Physics,
  scene: THREE.Scene
): HangGlidingExperience {
  return new HangGlidingExperience(map, physics, scene);
}
