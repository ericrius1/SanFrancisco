import type { FolderApi, Pane } from "tweakpane";
import { WALK_TUNING } from "./walk";
import { CAR_LANDING_TUNING, CAR_TUNING } from "../vehicles/car";
import { PLANE_TUNING } from "../vehicles/plane";
import { BOAT_TUNING, SPEEDBOAT_TUNING } from "../vehicles/boat";
import { DRONE_TUNING } from "../vehicles/drone";
import { BOARD_TUNING } from "../vehicles/board";
import { BOARD_EFFECT_TUNING, HALO_TUNING } from "../vehicles/board/tuning";
import { BIRD_TUNING } from "../vehicles/bird";
import { SURF_TUNING } from "../vehicles/surf";
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
  const movement = pane.addFolder({ title: "movement" });
  const folders: Record<PlayerMode, Folder> = {
    walk: movement.addFolder({ title: "walk" }),
    drive: movement.addFolder({ title: "car" }),
    scooter: movement.addFolder({ title: "scooter" }),
    plane: movement.addFolder({ title: "plane" }),
    boat: movement.addFolder({ title: "boat" }),
    speedboat: movement.addFolder({ title: "speedboat" }),
    drone: movement.addFolder({ title: "drone" }),
    board: movement.addFolder({ title: "board" }),
    surf: movement.addFolder({ title: "surf" }),
    bird: movement.addFolder({ title: "bird" })
  };
  WALK_TUNING.bind(folders.walk);
  CAR_TUNING.bind(folders.drive);
  CAR_LANDING_TUNING.bind(folders.drive.addFolder({ title: "landing feedback" }));
  SCOOTER_TUNING.bind(folders.scooter);
  PLANE_TUNING.bind(folders.plane);
  BOAT_TUNING.bind(folders.boat);
  SPEEDBOAT_TUNING.bind(folders.speedboat);
  DRONE_TUNING.bind(folders.drone);
  BOARD_TUNING.bind(folders.board);
  BOARD_EFFECT_TUNING.bind(folders.board.addFolder({ title: "effects" }));
  HALO_TUNING.bind(folders.board.addFolder({ title: "halo comet" }));
  SURF_TUNING.bind(folders.surf);
  BIRD_TUNING.bind(folders.bird);
  return folders;
}
