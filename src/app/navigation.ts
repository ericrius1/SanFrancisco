import type { Player } from "../player/player";
import type { PlayerMode } from "../player/types";
import type { RemotePlayers } from "../net/remotes";
import type { HUD } from "../ui/hud";
import type { TileStreamer } from "../world/tiles";
import type { WorldMap } from "../world/heightmap";
import { findOpenSpawn } from "../world/spawn";
import { isOceanBeachSurfApproach } from "../vehicles/surf/entry";
import type { EmbodimentController } from "./player/embodimentController";
import type { ResolvedWorldArrival, WorldArrivalCoordinator } from "./worldArrival";

type AuthoredArrivalPose = {
  x: number;
  y: number;
  z: number;
  heading: number;
};

type RelocationPose = {
  x: number;
  y: number;
  z: number;
  facing: number;
  mode: PlayerMode;
};

type PlaceHistoryEntry = {
  x: number;
  y: number;
  z: number;
  heading: number;
  mode: PlayerMode;
  label: string;
};

const PLACE_HISTORY_LIMIT = 32;
// Recovery helpers begin with 10–20 m probes. Treat any meaningful helper
// relocation as an arrival cut so a short shore/deck correction can never
// leak through the chase camera as a visible lerp.
const COVERED_MODE_RELOCATION_DISTANCE = 8;
const aborted = () => new DOMException("Navigation superseded", "AbortError");

/** Teleport/mode history and remote-player navigation, isolated from UI wiring. */
export class NavigationController {
  onTeleported: () => void = () => {};

  #player: Player;
  #hud: HUD;
  #map: WorldMap;
  #tiles: TileStreamer;
  #remotes: RemotePlayers;
  #embodiments: EmbodimentController;
  #arrival: WorldArrivalCoordinator;
  #resolveAuthoredArrival: (x: number, z: number, label?: string) => AuthoredArrivalPose | null;
  #releaseGameplay: () => void;
  #history: PlaceHistoryEntry[] = [];
  #historyIndex = -1;

  constructor(opts: {
    player: Player;
    hud: HUD;
    map: WorldMap;
    tiles: TileStreamer;
    remotes: RemotePlayers;
    embodiments: EmbodimentController;
    arrival: WorldArrivalCoordinator;
    resolveAuthoredArrival?: (x: number, z: number, label?: string) => AuthoredArrivalPose | null;
    releaseGameplay: () => void;
  }) {
    this.#player = opts.player;
    this.#hud = opts.hud;
    this.#map = opts.map;
    this.#tiles = opts.tiles;
    this.#remotes = opts.remotes;
    this.#embodiments = opts.embodiments;
    this.#arrival = opts.arrival;
    this.#resolveAuthoredArrival = opts.resolveAuthoredArrival ?? (() => null);
    this.#releaseGameplay = opts.releaseGameplay;
  }

  applyHistory(step: -1 | 1): void {
    const nextIndex = this.#historyIndex + step;
    if (nextIndex < 0 || nextIndex >= this.#history.length) {
      this.#hud.message(step < 0 ? "No earlier place" : "No later place", 1.8);
      this.#updateHud();
      return;
    }
    const origin = this.#capture(
      this.#historyIndex >= 0 ? this.#history[this.#historyIndex].label : "Previous place"
    );
    const spot = this.#history[nextIndex];
    void this.#arrival.arrive({
      label: spot.label,
      resolve: async (signal) => {
        if (signal.aborted) throw aborted();
        return {
          x: spot.x,
          y: spot.y,
          z: spot.z,
          cameraYaw: spot.heading + Math.PI,
          commit: () => {
            this.#releaseGameplay();
            this.#embodiments.exitToWalk();
            if (spot.mode === "drive") this.#player.setDriveStyle(null);
            if (spot.mode === "drone") this.#player.clearDroneStyle();
            this.#player.restoreState(spot);
          }
        };
      },
      onCommitted: () => {
        if (this.#historyIndex >= 0) this.#history[this.#historyIndex] = origin;
        this.#historyIndex = nextIndex;
        this.#updateHud();
        this.#hud.message(spot.label, 2.2);
        this.onTeleported();
      },
      onVisualBlocked: () => this.#hud.message("This place is still loading — press M and choose another spot", 6),
      onCollisionBlocked: () => this.#hud.message("Still settling the ground — movement is held safely", 3),
      onError: () => this.#hud.message("That place could not be restored", 2.2)
    });
  }

  switchMode(mode: PlayerMode): void {
    if (mode === this.#player.mode || this.#arrival.active) return;
    const relocation = this.#embodiments.modeSwitchRelocation(mode);
    // Surf from its own beach is a local hop onto an activity-owned analytic
    // surface: the break is visible from the shack, the controller never
    // consults collider tiles, and entering shrinks the streamed radius —
    // which can strand the covered arrival's collision epoch and leave the
    // rider pinned forever (the "surf freezes the game" bug). Switch directly;
    // the surf camera and placeOnWave handle the cut.
    const localSurfHop =
      mode === "surf" &&
      isOceanBeachSurfApproach(this.#player.position.x, this.#player.position.z);
    if (
      relocation &&
      !localSurfHop &&
      Math.hypot(relocation.x - this.#player.position.x, relocation.z - this.#player.position.z) >=
        COVERED_MODE_RELOCATION_DISTANCE
    ) {
      void this.#arrival.arrive({
        label: relocation.label,
        resolve: async (signal) => {
          if (signal.aborted) throw aborted();
          return {
            x: relocation.x,
            y: relocation.y,
            z: relocation.z,
            cameraYaw: this.#player.heading + Math.PI,
            commit: () => {
              this.#releaseGameplay();
              // Seed the previewed destination first. The mode's own enter()
              // still runs under cover and performs its exact wave/shore/body
              // placement, but now sees the intended region as already local.
              this.#player.position.set(relocation.x, relocation.y, relocation.z);
              this.#embodiments.switchMode(mode);
            }
          };
        },
        onCommitted: () => this.onTeleported(),
        onVisualBlocked: () => this.#hud.message("This place is still loading — press M and choose another spot", 6),
        onCollisionBlocked: () => this.#hud.message("Still settling the ground — movement is held safely", 3),
        onError: () => this.#hud.message("That mode could not find a safe starting place", 2.2)
      });
      return;
    }
    this.#releaseGameplay();
    this.#embodiments.switchMode(mode);
  }

  teleportToTarget(x: number, z: number, toName?: string, playerId?: number): void {
    if (playerId !== undefined && !this.#remotes.stateOf(playerId)) {
      this.#hud.message(`${toName ?? "Player"} is no longer available`, 2.2);
      return;
    }
    const origin = this.#capture("Previous place");
    void this.#arrival.arrive({
      label: toName,
      resolve: async (signal) => {
        const target = playerId !== undefined ? this.#remotes.stateOf(playerId) : null;
        if (playerId !== undefined && !target) throw new Error(`${toName ?? "Player"} is no longer available`);
        if (signal.aborted) throw aborted();

        const tx = target?.x ?? x;
        const tz = target?.z ?? z;
        const dx = tx - this.#player.position.x;
        const dz = tz - this.#player.position.z;
        const distance = Math.hypot(dx, dz) || 1;
        const back = target ? Math.min(3, distance) : 0;
        const heading = Math.atan2(-dx, -dz);

        if (target) {
          const arrivalX = tx - (dx / distance) * back;
          const arrivalZ = tz - (dz / distance) * back;
          return {
            x: arrivalX,
            y: target.y,
            z: arrivalZ,
            cameraYaw: heading,
            commit: () => {
              this.#releaseGameplay();
              this.#embodiments.leaveRide();
              if (this.#player.mode !== "walk" && this.#player.mode !== target.mode) {
                this.#embodiments.exitToWalk();
              }
              if (target.mode !== "drive") this.#embodiments.dropCurrentDriveMount();
              this.#player.teleportTo({
                x: arrivalX,
                y: target.y,
                z: arrivalZ,
                facing: heading,
                mode: target.mode
              });
            }
          };
        }

        const authored = this.#resolveAuthoredArrival(tx, tz, toName);
        if (authored) {
          return {
            x: authored.x,
            y: authored.y,
            z: authored.z,
            cameraYaw: authored.heading,
            commit: () => {
              this.#releaseGameplay();
              this.#embodiments.leaveRide();
              this.#embodiments.exitToWalk();
              this.#player.respawn(authored);
            }
          };
        }

        const open = await findOpenSpawn(
          this.#map,
          this.#tiles.manifest,
          { x: tx, z: tz, heading },
          12,
          200,
          { signal }
        );
        if (signal.aborted) throw aborted();
        const faceDx = tx - open.x;
        const faceDz = tz - open.z;
        const faceHeading = Math.hypot(faceDx, faceDz) > 0.5
          ? Math.atan2(-faceDx, -faceDz)
          : open.heading;
        return {
          x: open.x,
          z: open.z,
          cameraYaw: faceHeading,
          commit: () => {
            this.#releaseGameplay();
            this.#embodiments.leaveRide();
            this.#embodiments.exitToWalk();
            this.#player.respawn({ x: open.x, z: open.z, heading: faceHeading });
          }
        };
      },
      onCommitted: () => {
        this.#commitNewPlace(origin, toName ?? "Teleported place");
        this.#hud.message(toName ? `Teleported to ${toName}` : "Teleported", 2.4);
        this.onTeleported();
      },
      onVisualBlocked: () => this.#hud.message("This place is still loading — press M and choose another spot", 6),
      onCollisionBlocked: () => this.#hud.message("Still settling the ground — movement is held safely", 3),
      onError: (error) => {
        const message = error instanceof Error && error.message.includes("no longer available")
          ? error.message
          : "That destination could not be loaded";
        this.#hud.message(message, 2.2);
      }
    });
  }

  /**
   * Map teleport whose resolve/commit own the destination (e.g. boarding a
   * moving world ride). Shares arrival cover, place history, and error UX.
   */
  teleportCustom(options: {
    label: string;
    resolve: (signal: AbortSignal) => Promise<ResolvedWorldArrival>;
    /** Pass null when commit already showed the arrival toast. */
    successMessage?: string | null;
  }): void {
    const origin = this.#capture("Previous place");
    void this.#arrival.arrive({
      label: options.label,
      resolve: options.resolve,
      onCommitted: () => {
        this.#commitNewPlace(origin, options.label);
        if (options.successMessage !== null) {
          this.#hud.message(options.successMessage ?? `Teleported to ${options.label}`, 2.4);
        }
        this.onTeleported();
      },
      onVisualBlocked: () => this.#hud.message("This place is still loading — press M and choose another spot", 6),
      onCollisionBlocked: () => this.#hud.message("Still settling the ground — movement is held safely", 3),
      onError: (error) => {
        const message = error instanceof Error && error.message
          ? error.message
          : "That destination could not be loaded";
        this.#hud.message(message, 2.2);
      }
    });
  }

  /** Route authored/tutorial relocation through the same atomic arrival path. */
  teleportToPose(
    target: RelocationPose,
    label = "Tutorial place"
  ): void {
    this.#relocateToPose(target, label, false);
  }

  /** Shared relocation path for the HUD exit; lands on foot at the saved start. */
  returnToMinigameStart(target: RelocationPose, minigameLabel: string): void {
    this.#relocateToPose(target, `${minigameLabel} start`, true);
  }

  #relocateToPose(target: RelocationPose, label: string, forceWalkLanding: boolean): void {
    const origin = this.#capture("Previous place");
    void this.#arrival.arrive({
      label,
      resolve: async (signal) => {
        if (signal.aborted) throw aborted();
        return {
          x: target.x,
          y: target.y,
          z: target.z,
          cameraYaw: target.facing,
          commit: () => {
            this.#releaseGameplay();
            this.#embodiments.leaveRide();
            this.#embodiments.dropCurrentDriveMount();
            if (forceWalkLanding) {
              this.#embodiments.exitToWalk();
              this.#player.restoreState({
                x: target.x,
                y: target.y,
                z: target.z,
                heading: target.facing + Math.PI,
                mode: "walk"
              });
            } else {
              this.#player.teleportTo(target);
            }
          }
        };
      },
      onCommitted: () => {
        this.#commitNewPlace(origin, label);
        if (forceWalkLanding) this.#hud.message(`Returned to ${label}`, 2.4);
        this.onTeleported();
      },
      onVisualBlocked: () => this.#hud.message("This place is still loading — press M and choose another spot", 6),
      onCollisionBlocked: () => this.#hud.message("Still settling the ground — movement is held safely", 3),
      onError: () => this.#hud.message("That destination could not be loaded", 2.2)
    });
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

  /** Apply the old begin+finish pair atomically after relocation commits. */
  #commitNewPlace(origin: PlaceHistoryEntry, destinationLabel: string): void {
    if (this.#historyIndex < 0) {
      this.#history = [origin];
      this.#historyIndex = 0;
    } else {
      this.#history[this.#historyIndex] = origin;
      this.#history = this.#history.slice(0, this.#historyIndex + 1);
    }

    const destination = this.#capture(destinationLabel);
    if (this.#same(this.#history[this.#historyIndex], destination)) {
      this.#history[this.#historyIndex] = destination;
    } else {
      this.#history.push(destination);
      if (this.#history.length > PLACE_HISTORY_LIMIT) this.#history.shift();
      this.#historyIndex = this.#history.length - 1;
    }
    this.#updateHud();
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
