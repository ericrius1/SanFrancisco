export { PickleballGame } from "./game";
export { PickleballCourtView } from "./court";
export { PickleballPlayerRig } from "./playerRig";
export { PickleballBallPhysics } from "./physics";
export { posePickleball, type PickleballRigPose } from "./poses";
export {
  PickleballAmbient,
  type AmbientCourtAnchor,
  type PickleballAmbientFrame,
  type PickleballAmbientInteraction,
  type PickleballAmbientOptions
} from "./ambient";
export { PickleballAudio } from "./audio";
export { PickleballUI, type PickleballBannerKind } from "./ui";
export { PICKLEBALL_COURT, PICKLEBALL_TUNING } from "./constants";
export * from "./types";

import { PickleballGame } from "./game";
import type { PickleballOptions } from "./types";

export function createPickleball(options?: PickleballOptions): PickleballGame {
  return new PickleballGame(options);
}
