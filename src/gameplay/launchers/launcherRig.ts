import type * as THREE from "three/webgpu";
import type { FireContext, Launcher } from "./types";

/**
 * A bank of launchers bolted onto a host (the truck now; a speedboat later —
 * the rig only needs an Object3D to parent onto). `fireAll` is the "both sides
 * at once" trigger; `update` runs their idle/reload animation. This is the unit
 * you move between vehicles: build one, add whatever launchers you like at
 * whatever anchors, hang it off any mesh.
 */
export class LauncherRig {
  #host: THREE.Object3D;
  #launchers: Launcher[] = [];

  constructor(host: THREE.Object3D) {
    this.#host = host;
  }

  /** Mount a launcher at a local anchor on the host. Returns it for chaining. */
  add(launcher: Launcher, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): Launcher {
    launcher.group.position.set(pos[0], pos[1], pos[2]);
    launcher.group.rotation.set(rot[0], rot[1], rot[2]);
    this.#host.add(launcher.group);
    this.#launchers.push(launcher);
    return launcher;
  }

  get launchers(): readonly Launcher[] {
    return this.#launchers;
  }

  update(dt: number) {
    for (const l of this.#launchers) l.update(dt);
  }

  /** Fire every launcher this frame — the parade money shot. */
  fireAll(ctx: FireContext) {
    for (const l of this.#launchers) l.fire(ctx);
  }

  fire(index: number, ctx: FireContext) {
    this.#launchers[index]?.fire(ctx);
  }
}
