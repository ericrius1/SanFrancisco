import type { Physics } from "../../core/physics";
import type { AbandonedMounts } from "../../gameplay/abandonedMounts";
import type { AnimalKind, Forest } from "../../gameplay/forest";
import type { Player } from "../../player/player";
import type { PlayerMode } from "../../player/types";
import type { HUD } from "../../ui/hud";
import { waterHeight } from "../../world/heightmap";
import { oceanBeachShoreline } from "../../world/oceanBeachWaves";
import { findLand, findWater } from "../../vehicles/shared";
import { oceanBeachSurfEntryPose } from "../../vehicles/surf/entry";

export type ReleaseMotion = {
  linear: [number, number, number];
  angular: [number, number, number];
  speed: number;
  horizontalSpeed: number;
};

/**
 * Owns the player's current creature/passenger attachment and every transition
 * back to an on-foot embodiment. Navigation and minigames call this narrow API
 * instead of duplicating vehicle/physics handoff rules.
 */
export class EmbodimentController {
  currentAnimal: AnimalKind | null = null;
  passengerOf: number | null = null;

  #player: Player;
  #physics: Physics;
  #hud: HUD;
  #abandonedMounts: AbandonedMounts;
  #getForest: () => Forest | null;

  constructor(opts: {
    player: Player;
    physics: Physics;
    hud: HUD;
    abandonedMounts: AbandonedMounts;
    getForest: () => Forest | null;
  }) {
    this.#player = opts.player;
    this.#physics = opts.physics;
    this.#hud = opts.hud;
    this.#abandonedMounts = opts.abandonedMounts;
    this.#getForest = opts.getForest;
  }

  startPassengerRide(remoteId: number): void {
    this.passengerOf = remoteId;
    this.#player.startRide();
  }

  leaveRide(): void {
    if (this.passengerOf === null) return;
    this.passengerOf = null;
    this.#player.endRide();
  }

  readMotion(): ReleaseMotion {
    const player = this.#player;
    let linear: [number, number, number] = [player.velocity.x, player.velocity.y, player.velocity.z];
    let angular: [number, number, number] = [0, 0, 0];
    if (player.body) {
      const velocity = this.#physics.world.getBodyVelocity(player.body);
      linear = [velocity.linear[0], velocity.linear[1], velocity.linear[2]];
      angular = [velocity.angular[0], velocity.angular[1], velocity.angular[2]];
    }
    return {
      linear,
      angular,
      speed: Math.hypot(linear[0], linear[1], linear[2]),
      horizontalSpeed: Math.hypot(linear[0], linear[2])
    };
  }

  dropCurrentDriveMount(motion = this.readMotion()): boolean {
    const forest = this.#getForest();
    if (!this.currentAnimal || !forest) return false;
    const mount = this.#player.meshes.drive.position;
    forest.dropAnimal(this.currentAnimal, mount.x, mount.z, this.#player.heading - Math.PI, {
      speed: motion.horizontalSpeed
    });
    this.currentAnimal = null;
    this.#player.setDriveStyle(null);
    return true;
  }

  /** E (or pad Y): leave any vehicle, creature, or passenger seat for on-foot. */
  exitToWalk(): boolean {
    const player = this.#player;
    if (this.passengerOf !== null) {
      this.passengerOf = null;
      player.position.x += Math.cos(player.heading) * 2.4;
      player.position.z -= Math.sin(player.heading) * 2.4;
      player.endRide();
      this.#hud.message("Hopped out", 1.8);
      return true;
    }
    if (player.mode === "walk") return false;

    const exitMode = player.mode;
    if (exitMode === "surf") {
      // Surf is an activity, not a mount. Exit atomically to the sand: no
      // abandoned board, swimming interlude, paddle-out, or stale surf body.
      const shore = oceanBeachShoreline(player.map, player.position.z, 3);
      player.position.set(
        shore.x,
        player.map.effectiveGround(shore.x, shore.z) + 1.5,
        shore.z
      );
      player.heading = Math.PI * 1.5; // face offshore toward the break
      player.swimEnter = false;
      player.trySwitch("walk");
      this.#hud.message("Back on the beach — E to surf again", 2.2);
      return true;
    }

    const clearance = this.#exitClearance(exitMode);
    const motion = this.readMotion();
    const handedToWorld = this.dropCurrentDriveMount(motion);
    if (!handedToWorld) {
      const mount = player.meshes[exitMode];
      this.#abandonedMounts.spawn(exitMode, {
        position: mount.position,
        quaternion: mount.quaternion,
        linear: motion.linear,
        angular: motion.angular
      });
    }

    if (exitMode === "boat" || exitMode === "speedboat") {
      const side = 2.2;
      player.position.x += Math.sin(player.heading) * side;
      player.position.z += Math.cos(player.heading) * side;
      player.position.y = waterHeight(player.position.x, player.position.z, player.time) + 0.45;
      if (motion.speed > 0.5) {
        player.position.x += (motion.linear[0] / motion.speed) * 0.35;
        player.position.z += (motion.linear[2] / motion.speed) * 0.35;
      }
      player.swimEnter = true;
    } else {
      player.position.x += Math.cos(player.heading) * clearance;
      player.position.z -= Math.sin(player.heading) * clearance;
      if (motion.speed > 0.5) {
        player.position.x += (motion.linear[0] / motion.speed) * 0.35;
        player.position.z += (motion.linear[2] / motion.speed) * 0.35;
      }
    }
    player.trySwitch("walk");
    this.#hud.message("Hopped out", 1.8);
    return true;
  }

  switchMode(mode: PlayerMode): void {
    const player = this.#player;
    if (mode === player.mode) return;
    if (mode === "walk") {
      this.exitToWalk();
      return;
    }
    this.leaveRide();
    if (this.currentAnimal && mode !== "drive" && mode !== "drone") this.dropCurrentDriveMount();
    if (mode === "drive" && !this.currentAnimal) player.setDriveStyle(null);
    if (mode === "drone") player.clearDroneStyle();
    player.trySwitch(mode);
  }

  /**
   * Pure preview of mode-entry helpers that would move X/Z discontinuously.
   * Navigation uses this to cover/prime the destination before trySwitch runs;
   * local same-place embodiment swaps stay immediate.
   */
  modeSwitchRelocation(mode: PlayerMode): { x: number; y: number; z: number; label: string } | null {
    const player = this.#player;
    const p = player.position;
    if (mode === "surf") {
      return { ...oceanBeachSurfEntryPose(p.x, p.z, player.time), label: "Ocean Beach" };
    }
    if (mode === "boat" || mode === "speedboat") {
      const openHere =
        player.map.isWater(p.x, p.z) &&
        player.map.bridgeDeck(p.x, p.z) === -Infinity &&
        player.map.groundHeight(p.x, p.z) <= -1;
      if (!openHere) {
        const spot = findWater(player);
        if (spot) {
          return {
            x: spot.x,
            y: waterHeight(spot.x, spot.z, player.time) + 0.5,
            z: spot.z,
            label: "Open water"
          };
        }
      }
    }
    if (mode === "drive" || mode === "scooter") {
      const onBridge = player.map.bridgeDeck(p.x, p.z) > -Infinity;
      if (!onBridge && player.map.isWater(p.x, p.z)) {
        const spot = findLand(player);
        if (spot) {
          return {
            x: spot.x,
            y: player.map.effectiveGround(spot.x, spot.z) + 1.2,
            z: spot.z,
            label: "Nearest road"
          };
        }
      }
    }
    if (mode === "walk" && player.mode === "surf") {
      const shore = oceanBeachShoreline(player.map, p.z, 3);
      return {
        x: shore.x,
        y: player.map.effectiveGround(shore.x, shore.z) + 1.5,
        z: shore.z,
        label: "Ocean Beach shore"
      };
    }
    return null;
  }

  #exitClearance(mode: PlayerMode): number {
    if (mode === "drive" && this.currentAnimal) return this.currentAnimal === "bear" ? 3 : 2.4;
    if (mode === "plane" || mode === "boat" || mode === "bird") return 6.5;
    if (mode === "drone" || mode === "board" || mode === "scooter") return 2.8;
    return 2.4;
  }
}
