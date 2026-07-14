import type { FolderApi, Pane } from "tweakpane";
import { WALK_TUNING } from "./walk";
import { CAR_HEADLIGHT_TUNING, CAR_LANDING_TUNING, CAR_SKID_TUNING, CAR_TUNING } from "../vehicles/car";
import { PLANE_TUNING } from "../vehicles/plane";
import { BOAT_TUNING, SPEEDBOAT_TUNING } from "../vehicles/boat";
import { DRONE_TUNING } from "../vehicles/drone";
import { BOARD_TUNING } from "../vehicles/board";
import { BOARD_EFFECT_TUNING, HALO_TUNING } from "../vehicles/board/tuning";
import { BIRD_TUNING } from "../vehicles/bird";
import { SURF_TUNING } from "../vehicles/surf/tuning";
import { SURF_CAMERA_TUNING } from "../vehicles/surf/cameraTuning";
import { SCOOTER_TUNING } from "../vehicles/scooter";
import type { PlayerMode } from "./types";

type Folder = ReturnType<Pane["addFolder"]>;

/** All movement tunables in one place, keyed by mode. Each vehicle owns its
 * table (src/vehicles/<name>/tuning.ts); this is the aggregate view. */
export const MOVEMENT_TUNING = {
  walk: WALK_TUNING.values,
  drive: CAR_TUNING.values,
  scooter: SCOOTER_TUNING.values,
  plane: PLANE_TUNING.values,
  boat: BOAT_TUNING.values,
  speedboat: SPEEDBOAT_TUNING.values,
  drone: DRONE_TUNING.values,
  board: BOARD_TUNING.values,
  surf: SURF_TUNING.values,
  bird: BIRD_TUNING.values
};

/** Movement tuning is context-dependent: all six mode folders are built once,
 * and DebugPanel.setMode hides every folder except the active mode's. */
export function addMovementTuning(pane: Pane | FolderApi): Record<PlayerMode, Folder> {
  const movement = pane.addFolder({ title: "movement", expanded: false });
  const folders: Record<PlayerMode, Folder> = {
    walk: movement.addFolder({ title: "walk", expanded: false }),
    drive: movement.addFolder({ title: "car", expanded: false }),
    scooter: movement.addFolder({ title: "scooter", expanded: false }),
    plane: movement.addFolder({ title: "plane", expanded: false }),
    boat: movement.addFolder({ title: "boat", expanded: false }),
    speedboat: movement.addFolder({ title: "speedboat", expanded: false }),
    drone: movement.addFolder({ title: "drone", expanded: false }),
    board: movement.addFolder({ title: "board", expanded: false }),
    surf: movement.addFolder({ title: "surf", expanded: false }),
    bird: movement.addFolder({ title: "bird", expanded: false })
  };
  WALK_TUNING.bind(folders.walk);
  CAR_TUNING.bind(folders.drive);
  CAR_HEADLIGHT_TUNING.bind(folders.drive.addFolder({ title: "headlights · brake", expanded: false }));
  CAR_LANDING_TUNING.bind(folders.drive.addFolder({ title: "landing feedback", expanded: false }));
  CAR_SKID_TUNING.bind(folders.drive.addFolder({ title: "skid marks · audio", expanded: false }));
  SCOOTER_TUNING.bind(folders.scooter);
  PLANE_TUNING.bind(folders.plane);
  BOAT_TUNING.bind(folders.boat);
  SPEEDBOAT_TUNING.bind(folders.speedboat);
  DRONE_TUNING.bind(folders.drone);
  BOARD_TUNING.bind(folders.board);
  BOARD_EFFECT_TUNING.bind(folders.board.addFolder({ title: "effects", expanded: false }));
  HALO_TUNING.bind(folders.board.addFolder({ title: "halo comet", expanded: false }));
  SURF_TUNING.bind(folders.surf.addFolder({ title: "ride", expanded: false }));
  SURF_CAMERA_TUNING.bind(folders.surf.addFolder({ title: "locked camera", expanded: false }));
  BIRD_TUNING.bind(folders.bird);
  return folders;
}
