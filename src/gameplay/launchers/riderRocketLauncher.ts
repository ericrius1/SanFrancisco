import * as THREE from "three/webgpu";
import { buildRocket } from "./rocketMesh";
import type { AvatarTraits } from "../../player/avatar";
import type { FireContext, Launcher, Rider, RiderFactory } from "./types";

const RELOAD = 4.5; // seconds before a fresh rider is racked up
const PARKED_RIDER_POS = [-0.5, 0.45, -0.7] as const; // hip height puts feet on the truck bed
const PARKED_ROCKET_POS = [PARKED_RIDER_POS[0], 0, PARKED_RIDER_POS[2]] as const;

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
    // parked rocket on the rail
    const rocket = buildRocket();
    this.#prop.add(rocket);
    // muzzle anchor at the nose; its world -Z is the launch direction
    this.#muzzle.position.set(0, 0.1, -1.35);
    this.#prop.add(this.#muzzle);

    this.#prop.position.set(PARKED_ROCKET_POS[0], PARKED_ROCKET_POS[1], PARKED_ROCKET_POS[2]);
    this.#prop.rotation.x = tilt; // nose up-forward
    this.group.add(this.#prop);

    // The parked performer stays upright on the flatbed while the tilted rocket
    // sits directly between his legs, ready to carry the fresh launched rider.
    this.#staticRider = this.#buildRider(this.#avatar);
    this.#staticRider.group.position.set(PARKED_RIDER_POS[0], PARKED_RIDER_POS[1], PARKED_RIDER_POS[2]);
    this.group.add(this.#staticRider.group);
    this.#staticRider.jam(0); // pose standing even before the rig is ticked
  }

  update(dt: number) {
    this.#t += dt;
    this.#staticRider.jam(this.#t); // always jamming on the bed, armed or reloading
    if (!this.#armed) {
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
    this.#muzzle.getWorldPosition(origin);
    // launch FORWARD over the truck with a strong upward tilt (~40° elevation),
    // so he flies out ahead in view before veering off later
    const fwd = ctx.forward.clone();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-5) fwd.set(0, 0, -1);
    fwd.normalize();
    const dir = fwd.multiplyScalar(0.74).addScaledVector(new THREE.Vector3(0, 1, 0), 0.67).normalize();
    const rider = this.#buildRider(this.#avatar);
    ctx.rocketRiders.launch(origin, dir, rider, ctx.hostVelocity);
    this.#armed = false;
    this.#reloadT = RELOAD;
    this.#prop.visible = false;
  }
}
