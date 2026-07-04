import * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import { buildBoosterFlame, buildChute, buildRocket } from "./rocketMesh";
import type { Rider } from "./types";

/**
 * Performers launched off a rocket that then live their own lives — the flight
 * sim behind the truck's guitar-rocket launcher, kept deliberately generic so
 * any Rider can ride it. Each one is CPU-kinematic (no physics body, like a
 * projectile): it boosts across the sky toward a random spot in the city for
 * ~10s, pops a parachute, drifts down, and jams on that spot forever. Modelled
 * on AbandonedMounts' lifecycle (spawn → per-frame update → distance despawn),
 * minus the solver.
 */

const BOOST_TIME = 10; // seconds of powered flight before the chute
const LAUNCH_SPEED = 26; // initial pop off the rail
const MAX_RIDERS = 6; // oldest jammer retired past this
const DESPAWN = 1500; // horizontal metres from the player before we let one go
const STAND_H = 0.92; // rig hip origin height above ground when landed
const GRAV = 9;

type Phase = "boost" | "chute" | "jam";

type FlyingRider = {
  rider: Rider;
  group: THREE.Group;
  rocket: THREE.Group;
  flame: THREE.Group;
  chute: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  groundY: number;
  yaw: number;
  phase: Phase;
  age: number;
  phaseT: number;
  animT: number;
};

const V = {
  dir: new THREE.Vector3(),
  hv: new THREE.Vector3(),
  want: new THREE.Vector3(),
  fwd: new THREE.Vector3(0, 0, -1),
  up: new THREE.Vector3(0, 1, 0),
  q: new THREE.Quaternion()
};

export class RocketRiders {
  #scene: THREE.Scene;
  #map: WorldMap;
  #items: FlyingRider[] = [];

  constructor(scene: THREE.Scene, map: WorldMap) {
    this.#scene = scene;
    this.#map = map;
  }

  get count(): number {
    return this.#items.length;
  }

  /**
   * Send a rider off from `origin` along `dir` (the rail's aim). They pick a
   * random target somewhere out in the city and boost toward it.
   */
  launch(origin: THREE.Vector3, dir: THREE.Vector3, rider: Rider) {
    const group = new THREE.Group();
    // rider hip at the group origin; the rocket hangs just below (straddled),
    // the chute rigs above — so landing is just "drop the origin to standing
    // height" without unpicking offsets
    const rocket = buildRocket();
    rocket.position.y = -0.34;
    const flame = buildBoosterFlame();
    rocket.add(flame);
    const chute = buildChute();
    group.add(rocket, chute, rider.group);
    this.#scene.add(group);

    const pos = origin.clone();
    const d = dir.clone();
    if (d.lengthSq() < 1e-5) d.set(0, 1, 0);
    d.normalize();
    const vel = d.multiplyScalar(LAUNCH_SPEED);
    vel.y = Math.max(vel.y, 12); // guarantee some loft off the rail

    // a random spot out in the city to boost toward
    const target = this.#pickTarget(origin);

    const item: FlyingRider = {
      rider,
      group,
      rocket,
      flame,
      chute,
      pos,
      vel,
      target,
      groundY: target.y,
      yaw: Math.atan2(-vel.x, -vel.z),
      phase: "boost",
      age: 0,
      phaseT: 0,
      animT: 0
    };
    group.position.copy(pos);
    this.#items.push(item);
    while (this.#items.length > MAX_RIDERS) this.#retire(0);
  }

  /** A patriotically random landing spot: out in a random direction, on land if
   * we can find it within a few tries (nobody wants to jam underwater). */
  #pickTarget(origin: THREE.Vector3): THREE.Vector3 {
    let tx = origin.x;
    let tz = origin.z;
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const dist = 240 + Math.random() * 520;
      tx = origin.x + Math.cos(a) * dist;
      tz = origin.z + Math.sin(a) * dist;
      if (!this.#map.isWater(tx, tz)) break;
    }
    return new THREE.Vector3(tx, this.#map.effectiveGround(tx, tz), tz);
  }

  update(dt: number, playerPos: THREE.Vector3) {
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const it = this.#items[i];
      it.age += dt;
      it.phaseT += dt;
      it.animT += dt;

      if (it.phase === "boost") this.#boost(it, dt);
      else if (it.phase === "chute") this.#descend(it, dt);
      else this.#jam(it);

      const dist = Math.hypot(it.pos.x - playerPos.x, it.pos.z - playerPos.z);
      if (dist > DESPAWN || it.pos.y < -60) this.#retire(i);
    }
  }

  /** Powered climb: thrust up early then arc over, steering toward the target. */
  #boost(it: FlyingRider, dt: number) {
    // horizontal steer toward the target, speed ramping up as the boosters bite
    V.hv.set(it.target.x - it.pos.x, 0, it.target.z - it.pos.z);
    if (V.hv.lengthSq() > 1e-4) V.hv.normalize();
    const sp = THREE.MathUtils.lerp(LAUNCH_SPEED, 82, Math.min(1, it.phaseT / BOOST_TIME));
    V.want.copy(V.hv).multiplyScalar(sp);
    const k = Math.min(1, dt * 1.6);
    it.vel.x += (V.want.x - it.vel.x) * k;
    it.vel.z += (V.want.z - it.vel.z) * k;
    // vertical: hard thrust for the first stretch (climbs), then gravity arcs him over
    const thrust = 30 * Math.max(0, 1 - it.phaseT / 4);
    it.vel.y += (thrust - GRAV) * dt;

    it.pos.addScaledVector(it.vel, dt);
    it.group.position.copy(it.pos);
    this.#orientAlongVel(it);

    // exhaust roar visuals
    it.flame.visible = true;
    const pulse = 1 + Math.sin(it.animT * 45) * 0.22;
    it.flame.scale.set(1, 1, pulse);

    it.rider.ride(it.animT);

    if (it.age >= BOOST_TIME) {
      it.phase = "chute";
      it.phaseT = 0;
      it.flame.visible = false;
      it.chute.visible = true;
      it.yaw = Math.atan2(-it.vel.x, -it.vel.z);
    }
  }

  /** Canopy out: inflate, shed speed, settle to a gentle terminal descent. */
  #descend(it: FlyingRider, dt: number) {
    // inflate the canopy over ~0.6s
    const s = Math.min(1, it.chute.scale.x + dt * 1.8);
    it.chute.scale.setScalar(s);

    // approach a soft terminal velocity, bleed off the horizontal charge
    it.vel.y += (-5.5 - it.vel.y) * Math.min(1, dt * 1.4);
    const damp = Math.exp(-1.1 * dt);
    it.vel.x *= damp;
    it.vel.z *= damp;
    // lazy pendulum drift
    it.vel.x += Math.sin(it.animT * 1.3) * 1.6 * dt;
    it.vel.z += Math.cos(it.animT * 1.1) * 1.6 * dt;

    it.pos.addScaledVector(it.vel, dt);

    const ground = this.#map.effectiveGround(it.pos.x, it.pos.z);
    if (it.pos.y <= ground + STAND_H) {
      // touchdown — step off, stow the gear, and start the set
      it.pos.y = ground + STAND_H;
      it.groundY = ground;
      it.phase = "jam";
      it.phaseT = 0;
      it.chute.visible = false;
      it.rocket.visible = false;
    }

    it.group.position.copy(it.pos);
    // upright under the canopy, swinging a touch
    V.q.setFromAxisAngle(V.up, it.yaw);
    it.group.quaternion.copy(V.q);
    it.group.rotation.z = Math.sin(it.animT * 1.2) * 0.07;
    it.rider.ride(it.animT);
  }

  /** Landed for good — keep the show going right where he touched down. */
  #jam(it: FlyingRider) {
    it.pos.y = it.groundY + STAND_H + Math.abs(Math.sin(it.animT * 3.2)) * 0.03;
    it.group.position.copy(it.pos);
    V.q.setFromAxisAngle(V.up, it.yaw);
    it.group.quaternion.copy(V.q);
    it.group.rotation.z = 0;
    it.rider.jam(it.animT);
  }

  /** Point the rocket nose (local -Z) along the current velocity. */
  #orientAlongVel(it: FlyingRider) {
    const speed = it.vel.length();
    if (speed < 0.5) return;
    V.dir.copy(it.vel).divideScalar(speed);
    V.q.setFromUnitVectors(V.fwd, V.dir);
    it.group.quaternion.copy(V.q);
  }

  #retire(index: number) {
    const it = this.#items[index];
    this.#items.splice(index, 1);
    it.group.removeFromParent();
    // rig box geometries are shared via a global cache (player/rig.ts) — never
    // dispose them here; the handful of unique rocket/chute geos GC with the mesh
  }
}
