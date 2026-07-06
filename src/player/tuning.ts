import type { FolderApi, Pane } from "tweakpane";
import { WALK_TUNING } from "./walk";
import { CAR_TUNING } from "../vehicles/car";
import { PLANE_TUNING } from "../vehicles/plane";
import { BOAT_TUNING, SPEEDBOAT_TUNING } from "../vehicles/boat";
import { DRONE_TUNING } from "../vehicles/drone";
import { BOARD_TUNING } from "../vehicles/board";
import { BIRD_TUNING } from "../vehicles/bird";
import type { PlayerMode } from "./types";

type Folder = ReturnType<Pane["addFolder"]>;

/** All movement tunables in one place, keyed by mode. Each vehicle owns its
 * table (src/vehicles/<name>/tuning.ts); this is the aggregate view. */
export const MOVEMENT_TUNING = {
  walk: WALK_TUNING.values,
  drive: CAR_TUNING.values,
  plane: PLANE_TUNING.values,
  boat: BOAT_TUNING.values,
  speedboat: SPEEDBOAT_TUNING.values,
  drone: DRONE_TUNING.values,
  board: BOARD_TUNING.values,
  bird: BIRD_TUNING.values
};

/** Movement tuning is context-dependent: all six mode folders are built once,
 * and DebugPanel.setMode hides every folder except the active mode's. */
export function addMovementTuning(pane: Pane | FolderApi): Record<PlayerMode, Folder> {
  const movement = pane.addFolder({ title: "movement" });
  const folders: Record<PlayerMode, Folder> = {
    walk: movement.addFolder({ title: "walk" }),
    drive: movement.addFolder({ title: "drive" }),
    plane: movement.addFolder({ title: "plane" }),
    boat: movement.addFolder({ title: "boat" }),
    speedboat: movement.addFolder({ title: "speedboat" }),
    drone: movement.addFolder({ title: "drone" }),
    board: movement.addFolder({ title: "board" }),
    bird: movement.addFolder({ title: "bird" })
  };
  WALK_TUNING.bind(folders.walk);
  CAR_TUNING.bind(folders.drive);
  PLANE_TUNING.bind(folders.plane);
  BOAT_TUNING.bind(folders.boat);
  SPEEDBOAT_TUNING.bind(folders.speedboat);
  DRONE_TUNING.bind(folders.drone);
  BOARD_TUNING.bind(folders.board);
  BIRD_TUNING.bind(folders.bird);
  return folders;
}
