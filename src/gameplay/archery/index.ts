import type * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { WorldQueries } from "../../core/worldQueries";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import { ArcheryGame } from "./game";

export { ArcheryGame, ARCHERY_SITE_PADS } from "./game";
export { ARCHERY_CENTER, inArcheryRange } from "./layout";
export { poseArcher, poseArcherIdle, ARCHER_BOW_GRIP } from "./poses";

/** Factory main.ts calls after the wildlands land (the range lives in GG
 *  Park's wild region). `physics` is accepted for parity with the other game
 *  factories — arrows resolve through worldQueries, so it is unused today. */
export function createArchery(
  map: WorldMap,
  _physics: Physics,
  worldQueries: WorldQueries,
  scene: THREE.Scene,
  opts: { nature: NatureSoundscape; daylight?: () => boolean }
): ArcheryGame {
  return new ArcheryGame(map, worldQueries, scene, opts);
}
