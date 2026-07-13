import type * as THREE from "three/webgpu";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import type { WorldMap } from "../../world/heightmap";
import { AfterlightExperience } from "./experience";

export { AfterlightExperience } from "./experience";
export {
  AFTERLIGHT_ARRIVAL,
  AFTERLIGHT_CENTER,
  AFTERLIGHT_TUNING,
  inAfterlightGroundcoverClear
} from "./layout";

export function createAfterlight(
  map: WorldMap,
  scene: THREE.Scene,
  nature: NatureSoundscape
): AfterlightExperience {
  return new AfterlightExperience(map, scene, nature);
}
