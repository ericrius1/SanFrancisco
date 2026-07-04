import * as THREE from "three/webgpu";
import { buildBoosterFlame, buildRocket } from "./rocketMesh";
import type { Fireworks } from "../../fx/fireworks";
import type { FireContext, Launcher } from "./types";

const FLIGHT = 1.75; // seconds of powered climb before a rocket detonates
const LAUNCH_SPEED = 46; // fast off the deck, so they carry well out ahead
const RELOAD = 3.2; // seconds before a fresh rack of rockets is loaded
const PARK_TILT = 0.34; // nose pitched up-forward while racked in the bed
const GRAVITY = 4; // gentle — the rockets are still under thrust the whole climb

// Where each rocket sits in the bed (local units; the mesh scales the group).
// Seven, in two staggered rows, all nosed up toward the truck's front.
const LAYOUT: { x: number; z: number; yaw: number }[] = [
  { x: -0.9, z: 0.4, yaw: -0.2 },
  { x: -0.3, z: 0.4, yaw: -0.07 },
  { x: 0.3, z: 0.4, yaw: 0.07 },
  { x: 0.9, z: 0.4, yaw: 0.2 },
  { x: -0.6, z: 1.7, yaw: -0.13 },
  { x: 0.0, z: 1.7, yaw: 0.0 },
  { x: 0.6, z: 1.7, yaw: 0.13 }
];

const V = {
  fwd: new THREE.Vector3(0, 0, -1),
  up: new THREE.Vector3(0, 1, 0),
  dir: new THREE.Vector3(),
  q: new THREE.Quaternion()
};

type Parked = { mesh: THREE.Group; flame: THREE.Group };
type Flyer = { mesh: THREE.Group; flame: THREE.Group; pos: THREE.Vector3; vel: THREE.Vector3; age: number; flight: number };

function dispose(obj: THREE.Object3D) {
  obj.traverse((o) => {
    // sprites (the booster glow) share a module-wide geometry AND material — never
    // dispose them, or we destroy GPU buffers still in flight for other rockets
    if ((o as THREE.Sprite).isSprite) return;
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}

/**
 * A rack of patriotic rockets lying in the truck bed. One trigger (the click)
 * launches the whole rack at once: each rocket lifts off under booster glow,
 * flies up and out ahead of the truck, then detonates into a huge red/white/blue
 * firework that bursts a second time into even more (Fireworks.burstAt with a
 * secondary ring). Reloads a fresh rack after a beat so you can fire again.
 *
 * The GPU firework system does the explosions; this launcher only flies the
 * physical rockets and calls the detonation seam. `fire`'s ctx carries the
 * Fireworks/scene refs; they're stashed so `update` (dt-only) can finish the
 * flights and reload.
 */
export class RocketBattery implements Launcher {
  readonly group = new THREE.Group();
  #parked: Parked[] = [];
  #flying: Flyer[] = [];
  #fx?: Fireworks;
  #scene?: THREE.Scene;
  #armed = true;
  #reloadT = 0;

  constructor() {
    this.#loadRack();
  }

  #loadRack() {
    for (const slot of LAYOUT) {
      const mesh = buildRocket();
      mesh.name = "battery-rocket";
      const flame = buildBoosterFlame();
      mesh.add(flame);
      mesh.position.set(slot.x, 0.24, slot.z);
      mesh.rotation.set(PARK_TILT, slot.yaw, 0);
      this.group.add(mesh);
      this.#parked.push({ mesh, flame });
    }
  }

  update(dt: number) {
    // advance every airborne rocket, detonate at apex
    for (let i = this.#flying.length - 1; i >= 0; i--) {
      const f = this.#flying[i];
      f.age += dt;
      f.vel.y -= GRAVITY * dt;
      f.pos.addScaledVector(f.vel, dt);
      f.mesh.position.copy(f.pos);
      // nose (local -Z) points along travel
      const speed = f.vel.length();
      if (speed > 0.5) {
        V.dir.copy(f.vel).divideScalar(speed);
        V.q.setFromUnitVectors(V.fwd, V.dir);
        f.mesh.quaternion.copy(V.q);
      }
      // exhaust roar: flicker the glow
      f.flame.scale.setScalar(1 + Math.sin(f.age * 44) * 0.2);

      if (f.age >= f.flight) {
        this.#fx?.burstAt(f.pos, { secondary: 7, sizeScale: 1.5 });
        this.#scene?.remove(f.mesh);
        dispose(f.mesh);
        this.#flying.splice(i, 1);
      }
    }

    if (!this.#armed) {
      this.#reloadT -= dt;
      if (this.#reloadT <= 0) {
        this.#loadRack();
        this.#armed = true;
      }
    }
  }

  fire(ctx: FireContext) {
    this.#fx = ctx.fireworks;
    this.#scene = ctx.scene;
    if (!this.#armed || this.#parked.length === 0) return;

    // base launch direction: a flat, forward arc (~28° up) so the shells shoot
    // OUT ahead down the road and burst low enough to stay in a chase-cam frame,
    // rather than rocketing near-vertical and popping way overhead
    const fwd = ctx.forward.clone();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-5) fwd.set(0, 0, -1);
    fwd.normalize();
    const base = fwd.clone().multiplyScalar(0.9).addScaledVector(V.up, 0.34).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, V.up).normalize();

    const n = this.#parked.length;
    for (let i = 0; i < n; i++) {
      const p = this.#parked[i];
      // hand the rocket to the world, preserving exactly how it looked in the bed
      const wp = p.mesh.getWorldPosition(new THREE.Vector3());
      const wq = p.mesh.getWorldQuaternion(new THREE.Quaternion());
      const ws = p.mesh.getWorldScale(new THREE.Vector3());
      ctx.scene.add(p.mesh);
      p.mesh.position.copy(wp);
      p.mesh.quaternion.copy(wq);
      p.mesh.scale.copy(ws);
      p.flame.visible = true;

      // fan the rack WIDE across the sky so the shells burst spread far apart
      // (else the flashes stack into one white blob) and vary the elevation
      const yaw = (i - (n - 1) / 2) * 0.22 + (Math.random() - 0.5) * 0.1;
      const pitch = (Math.random() - 0.5) * 0.22;
      const dir = base
        .clone()
        .applyAxisAngle(V.up, yaw)
        .applyAxisAngle(right, pitch)
        .normalize();
      const vel = dir.multiplyScalar(LAUNCH_SPEED * (0.9 + Math.random() * 0.2));
      if (ctx.hostVelocity) vel.addScaledVector(ctx.hostVelocity, 0.5); // lead with the truck

      // stagger the detonations so the display cascades rather than one big flash
      const flight = FLIGHT + i * 0.1 + Math.random() * 0.12;
      this.#flying.push({ mesh: p.mesh, flame: p.flame, pos: wp.clone(), vel, age: 0, flight });
    }

    this.#parked = [];
    this.#armed = false;
    this.#reloadT = RELOAD;
  }
}
