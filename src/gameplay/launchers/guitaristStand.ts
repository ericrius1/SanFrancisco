import * as THREE from "three/webgpu";
import type { AvatarTraits } from "../../player/avatar";
import type { FireContext, Launcher, Rider, RiderFactory } from "./types";

/**
 * A performer bolted to the truck — the guitarist jamming on the cab roof. He's
 * a Launcher only so the LauncherRig ticks his animation every frame; he never
 * fires anything (the rockets live in their own battery now). Reuses the pluggable
 * RiderFactory so any performer can take the stage.
 */
export class GuitaristStand implements Launcher {
  readonly group = new THREE.Group();
  #rider: Rider;
  #t = 0;

  constructor(opts: { buildRider: RiderFactory; avatar?: AvatarTraits }) {
    this.#rider = opts.buildRider(opts.avatar);
    this.group.add(this.#rider.group);
    this.#rider.jam(0); // stand and play even before the first tick
  }

  update(dt: number) {
    this.#t += dt;
    this.#rider.jam(this.#t);
  }

  fire(_ctx: FireContext) {
    // the show must go on — the performer has no trigger
  }
}
