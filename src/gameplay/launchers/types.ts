import type * as THREE from "three/webgpu";
import type { Fireworks } from "../../fx/fireworks";
import type { WorldMap } from "../../world/heightmap";
import type { AvatarTraits } from "../../player/avatar";
import type { RocketRiders } from "./rocketRiders";

/**
 * A performer that can be strapped to a rocket. Swap the factory to fly a flute
 * player, a DJ, whoever — the launcher and the flight sim never learn who's on
 * board. `ride` poses them straddling the rocket mid-flight; `jam` poses them
 * performing on the ground where they land.
 */
export type Rider = {
  group: THREE.Group;
  ride(t: number): void;
  jam(t: number): void;
};

export type RiderFactory = (avatar?: AvatarTraits) => Rider;

/**
 * Everything a mounted launcher needs to fire into the world. The launcher
 * reads its own muzzle position/orientation from its (parented) group, so the
 * host — truck today, speedboat tomorrow — never appears here.
 */
export type FireContext = {
  scene: THREE.Scene;
  fireworks: Fireworks;
  rocketRiders: RocketRiders;
  map: WorldMap;
  playerPos: THREE.Vector3;
};

/**
 * One mounted weapon. Its `group` is parented onto a host at an anchor by the
 * LauncherRig; `fire` reads the group's world transform to aim. Modular by
 * construction: a FireworkLauncher and a RiderRocketLauncher are peers.
 */
export interface Launcher {
  readonly group: THREE.Group;
  /** Idle/reload animation — muzzle glow, the strapped-in rider's warm-up. */
  update(dt: number): void;
  fire(ctx: FireContext): void;
}
