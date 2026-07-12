import type { ChaseCamera } from "../core/camera";
import type { Player } from "../player/player";
import type { PlayerMode } from "../player/types";
import type { RemotePlayers } from "../net/remotes";
import type { HUD } from "../ui/hud";
import type { TileStreamer } from "../world/tiles";
import type { WorldMap } from "../world/heightmap";
import { findOpenSpawn } from "../world/spawn";
import type { EmbodimentController } from "./player/embodimentController";

type PlaceHistoryEntry = {
  x: number;
  y: number;
  z: number;
  heading: number;
  mode: PlayerMode;
  label: string;
};

const PLACE_HISTORY_LIMIT = 32;

/** Teleport/mode history and remote-player navigation, isolated from UI wiring. */
export class NavigationController {
  onTeleported: () => void = () => {};

  #player: Player;
  #chase: ChaseCamera;
  #hud: HUD;
  #map: WorldMap;
  #tiles: TileStreamer;
  #remotes: RemotePlayers;
  #embodiments: EmbodimentController;
  #releaseGameplay: () => void;
  #history: PlaceHistoryEntry[] = [];
  #historyIndex = -1;

  constructor(opts: {
    player: Player;
    chase: ChaseCamera;
    hud: HUD;
    map: WorldMap;
    tiles: TileStreamer;
    remotes: RemotePlayers;
    embodiments: EmbodimentController;
    releaseGameplay: () => void;
  }) {
    this.#player = opts.player;
    this.#chase = opts.chase;
    this.#hud = opts.hud;
    this.#map = opts.map;
    this.#tiles = opts.tiles;
    this.#remotes = opts.remotes;
    this.#embodiments = opts.embodiments;
    this.#releaseGameplay = opts.releaseGameplay;
  }

  begin(label: string): void {
    const current = this.#capture(label);
    if (this.#historyIndex < 0) {
      this.#history = [current];
      this.#historyIndex = 0;
    } else {
      this.#history[this.#historyIndex] = current;
      this.#history = this.#history.slice(0, this.#historyIndex + 1);
    }
    this.#updateHud();
  }

  finish(label: string): void {
    const next = this.#capture(label);
    if (this.#historyIndex >= 0 && this.#same(this.#history[this.#historyIndex], next)) {
      this.#history[this.#historyIndex] = next;
      this.#updateHud();
      return;
    }
    this.#history = this.#history.slice(0, this.#historyIndex + 1);
    this.#history.push(next);
    if (this.#history.length > PLACE_HISTORY_LIMIT) this.#history.shift();
    this.#historyIndex = this.#history.length - 1;
    this.#updateHud();
  }

  applyHistory(step: -1 | 1): void {
    const nextIndex = this.#historyIndex + step;
    if (nextIndex < 0 || nextIndex >= this.#history.length) {
      this.#hud.message(step < 0 ? "No earlier place" : "No later place", 1.8);
      this.#updateHud();
      return;
    }
    this.#releaseGameplay();
    if (this.#historyIndex >= 0) {
      this.#history[this.#historyIndex] = this.#capture(this.#history[this.#historyIndex].label);
    }
    const spot = this.#history[nextIndex];
    this.#embodiments.exitToWalk();
    if (spot.mode === "drive") this.#player.setDriveStyle(null);
    if (spot.mode === "drone") this.#player.clearDroneStyle();
    this.#player.restoreState({
      mode: spot.mode,
      x: spot.x,
      y: spot.y,
      z: spot.z,
      heading: spot.heading
    });
    this.#chase.yaw = spot.heading + Math.PI;
    this.#historyIndex = nextIndex;
    this.#updateHud();
    this.#hud.message(spot.label, 2.2);
  }

  switchMode(mode: PlayerMode): void {
    if (mode === this.#player.mode) return;
    this.#releaseGameplay();
    this.#embodiments.switchMode(mode);
  }

  teleportToTarget(x: number, z: number, toName?: string, playerId?: number): void {
    this.#releaseGameplay();
    void this.#teleport(x, z, toName, playerId);
  }

  async #teleport(x: number, z: number, toName?: string, playerId?: number): Promise<void> {
    const target = playerId !== undefined ? this.#remotes.stateOf(playerId) : null;
    if (playerId !== undefined && !target) {
      this.#hud.message(`${toName ?? "Player"} is no longer available`, 2.2);
      return;
    }
    this.begin("Previous place");
    this.#embodiments.leaveRide();
    const tx = target?.x ?? x;
    const tz = target?.z ?? z;
    const dx = tx - this.#player.position.x;
    const dz = tz - this.#player.position.z;
    const distance = Math.hypot(dx, dz) || 1;
    const back = target ? Math.min(3, distance) : 0;
    const heading = Math.atan2(-dx, -dz);

    if (target) {
      if (target.mode !== "drive") this.#embodiments.dropCurrentDriveMount();
      this.#player.teleportTo({
        x: tx - (dx / distance) * back,
        y: target.y,
        z: tz - (dz / distance) * back,
        facing: heading,
        mode: target.mode
      });
    } else {
      const open = await findOpenSpawn(this.#map, this.#tiles.manifest, { x: tx, z: tz, heading });
      const faceDx = tx - open.x;
      const faceDz = tz - open.z;
      const faceHeading = Math.hypot(faceDx, faceDz) > 0.5 ? Math.atan2(-faceDx, -faceDz) : open.heading;
      this.#player.respawn({ x: open.x, z: open.z, heading: faceHeading });
    }

    this.finish(toName ?? "Teleported place");
    this.#hud.message(toName ? `Teleported to ${toName}` : "Teleported", 2.4);
    this.onTeleported();
  }

  #capture(label: string): PlaceHistoryEntry {
    return {
      x: this.#player.position.x,
      y: this.#player.position.y,
      z: this.#player.position.z,
      heading: this.#player.heading,
      mode: this.#player.mode,
      label
    };
  }

  #same(a: PlaceHistoryEntry, b: PlaceHistoryEntry): boolean {
    return (
      a.mode === b.mode &&
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.5 &&
      Math.abs(Math.atan2(Math.sin(a.heading - b.heading), Math.cos(a.heading - b.heading))) < 0.05
    );
  }

  #updateHud(): void {
    this.#hud.setTeleportHistory(
      this.#historyIndex > 0,
      this.#historyIndex >= 0 && this.#historyIndex < this.#history.length - 1
    );
  }
}

