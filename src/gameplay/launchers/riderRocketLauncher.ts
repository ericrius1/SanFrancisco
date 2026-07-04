import * as THREE from "three/webgpu";
import { buildRocket } from "./rocketMesh";
import type { AvatarTraits } from "../../player/avatar";
import type { FireContext, Launcher, Rider, RiderFactory } from "./types";

const RELOAD = 4.5; // seconds before a fresh rider is racked up

/**
 * A rail that flings a strapped-in performer skyward. The rider is a plugged-in
 * factory (`buildGuitarPlayer` today; a flute player, a DJ, whoever tomorrow),
 * so neither this launcher nor the flight sim knows or cares who's riding.
 * Firing hands a fresh rider to RocketRiders and reloads after a beat.
 */
export class RiderRocketLauncher implements Launcher {
  readonly group = new THREE.Group();
  #buildRider: RiderFactory;
  #avatar?: AvatarTraits;
  #prop = new THREE.Group(); // the parked rocket + idling rider
  #staticRider: Rider;
  #muzzle = new THREE.Object3D();
  #armed = true;
  #reloadT = 0;
  #t = 0;

  constructor(opts: { buildRider: RiderFactory; avatar?: AvatarTraits; tilt?: number }) {
    this.#buildRider = opts.buildRider;
    this.#avatar = opts.avatar;
    const tilt = opts.tilt ?? 0.62; // launch elevation (~35°)

    // rail bed + guide rails beneath the rocket
    const railMat = new THREE.MeshLambertMaterial({ color: 0x3b3f47 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 2.6), railMat);
    bed.position.y = -0.42;
    this.#prop.add(bed);
    for (const sx of [-0.26, 0.26]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 2.6), new THREE.MeshLambertMaterial({ color: 0x62666e }));
      rail.position.set(sx, -0.32, 0);
      this.#prop.add(rail);
    }
    // parked rocket + strapped rider, straddling
    const rocket = buildRocket();
    this.#prop.add(rocket);
    this.#staticRider = this.#buildRider(this.#avatar);
    this.#staticRider.group.position.set(0, 0.34, 0.1);
    this.#prop.add(this.#staticRider.group);
    // muzzle anchor at the nose; its world -Z is the launch direction
    this.#muzzle.position.set(0, 0.1, -1.35);
    this.#prop.add(this.#muzzle);

    this.#prop.rotation.x = tilt; // nose up-forward
    this.group.add(this.#prop);
  }

  update(dt: number) {
    this.#t += dt;
    if (this.#armed) {
      this.#staticRider.ride(this.#t * 0.5); // warming up on the rail
    } else {
      this.#reloadT -= dt;
      if (this.#reloadT <= 0) {
        this.#armed = true;
        this.#prop.visible = true;
      }
    }
  }

  fire(ctx: FireContext) {
    if (!this.#armed) return;
    const origin = new THREE.Vector3();
    const q = new THREE.Quaternion();
    this.#muzzle.getWorldPosition(origin);
    this.#muzzle.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
    const rider = this.#buildRider(this.#avatar);
    ctx.rocketRiders.launch(origin, dir, rider);
    this.#armed = false;
    this.#reloadT = RELOAD;
    this.#prop.visible = false;
  }
}
