import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Cockpit } from "../../player/types";
import { applyVehicleShadowPolicy } from "../shadows";
import { rideHeightFromContact } from "../shared";

/** Wheel hub Y and cylinder radius in mesh space (car chassis origin at body centre). */
export const CAR_WHEEL_HUB_Y = -0.42;
export const CAR_WHEEL_RADIUS = 0.42;
export const CAR_CONTACT_Y = CAR_WHEEL_HUB_Y - CAR_WHEEL_RADIUS;
export const CAR_RIDE_HEIGHT = rideHeightFromContact(CAR_CONTACT_Y);

export type CarAnim = {
  wheels: THREE.Group[];
  steering: THREE.Group[];
};

const carAnimations = new WeakMap<THREE.Object3D, CarAnim>();

export function collectCarAnim(root: THREE.Object3D): CarAnim {
  const wheels: THREE.Group[] = [];
  const steering: THREE.Group[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Group)) return;
    if (object.name.startsWith("car_wheel_")) wheels.push(object);
    if (object.name.startsWith("car_steer_")) steering.push(object);
  });
  return { wheels, steering };
}

// Front of the car is local -Z (matches CarController's forward).
export function buildCarMesh(): THREE.Group {
  const g = new THREE.Group();
  const shadowCasters: THREE.Mesh[] = [];
  const paint = new THREE.MeshLambertMaterial({ color: 0xc8332b });
  const trim = new THREE.MeshLambertMaterial({ color: 0x1b1d22 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x101820 });
  // intensities sized against the old 0.62-exposure grade, carried into the new
  // photometric scale by LIGHT_SCALE — lower reads unlit
  const headlight = new THREE.MeshLambertMaterial({ color: 0xfff4c9, emissive: 0xffedb0, emissiveIntensity: 2.2 * LIGHT_SCALE });
  const taillight = new THREE.MeshLambertMaterial({ color: 0xd41818, emissive: 0xff1a10, emissiveIntensity: 2.6 * LIGHT_SCALE });
  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, casts = false) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
    if (casts) shadowCasters.push(m);
    return m;
  };

  const cabin = new THREE.MeshLambertMaterial({ color: 0x201c18 });
  const seat = new THREE.MeshLambertMaterial({ color: 0x8c4a32 });
  // body: low chassis, hood dipping toward the nose, higher trunk deck at the rear
  // Three overlapping body volumes carry the complete silhouette for only
  // three shadow draws; cockpit furniture, lamps, mirrors, and wheel trim only
  // receive. The low chassis already covers the tyres in ground projection.
  box(paint, 2.3, 0.56, 4.6, 0, -0.02, 0, 0, true);
  box(paint, 2.12, 0.3, 1.9, 0, 0.34, -1.32, 0.06, true);
  box(paint, 2.12, 0.34, 1.04, 0, 0.38, 1.78, 0, true);
  // open cockpit: raked windshield, dark tub with tan seats, dash, roll hoops
  box(glass, 1.8, 0.5, 0.08, 0, 0.6, -0.68, 0.42);
  box(cabin, 1.7, 0.1, 1.9, 0, 0.3, 0.55);
  box(cabin, 1.78, 0.22, 0.4, 0, 0.5, -0.42);
  for (const sx of [-0.42, 0.42]) {
    box(seat, 0.6, 0.14, 0.6, sx, 0.36, 0.72);
    box(seat, 0.6, 0.44, 0.14, sx, 0.6, 1.02, 0.12);
    box(trim, 0.14, 0.3, 0.12, sx, 0.66, 1.32); // roll hoop
  }
  // front face: bumper, grille between the headlights
  box(trim, 2.34, 0.26, 0.3, 0, -0.24, -2.22);
  box(trim, 0.92, 0.18, 0.08, 0, 0.14, -2.3);
  box(headlight, 0.4, 0.16, 0.1, -0.74, 0.14, -2.31);
  box(headlight, 0.4, 0.16, 0.1, 0.74, 0.14, -2.31);
  // rear face: bumper, full-width light bar, spoiler on posts
  box(trim, 2.34, 0.26, 0.3, 0, -0.24, 2.22);
  box(taillight, 1.8, 0.14, 0.1, 0, 0.3, 2.31);
  box(trim, 0.1, 0.18, 0.14, -0.62, 0.62, 2.05);
  box(trim, 0.1, 0.18, 0.14, 0.62, 0.62, 2.05);
  box(paint, 1.78, 0.07, 0.42, 0, 0.76, 2.08);
  // mirrors flanking the windshield base
  box(trim, 0.22, 0.12, 0.14, -1.03, 0.52, -0.66);
  box(trim, 0.22, 0.12, 0.14, 1.03, 0.52, -0.66);
  g.userData.cockpit = { seat: [-0.42, 0.55, 0.66], wheel: [-0.42, 0.66, 0.12] } satisfies Cockpit;

  const wheelGeo = new THREE.CylinderGeometry(CAR_WHEEL_RADIUS, CAR_WHEEL_RADIUS, 0.36, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.38, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const hubMat = new THREE.MeshLambertMaterial({ color: 0xb9bdc4 });
  const placements = [
    [-1.05, -1.55, "fl"],
    [1.05, -1.55, "fr"],
    [-1.05, 1.55, "rl"],
    [1.05, 1.55, "rr"]
  ] as const;
  for (const [wx, wz, id] of placements) {
    const steering = new THREE.Group();
    steering.name = wz < 0 ? `car_steer_${id}` : `car_axle_${id}`;
    steering.position.set(wx, CAR_WHEEL_HUB_Y, wz);
    g.add(steering);
    const spin = new THREE.Group();
    spin.name = `car_wheel_${id}`;
    steering.add(spin);
    const w = new THREE.Mesh(wheelGeo, trim);
    spin.add(w);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    spin.add(hub);
  }
  g.userData.contactY = CAR_CONTACT_Y;
  carAnimations.set(g, collectCarAnim(g));
  applyVehicleShadowPolicy(g, shadowCasters);
  return g;
}

/** Visible tire rotation and front-wheel steering for local and cloned cars. */
export function animateCar(root: THREE.Group, dt: number, speed: number, steer: number): void {
  let anim = carAnimations.get(root);
  if (!anim) {
    anim = collectCarAnim(root);
    carAnimations.set(root, anim);
  }
  const spin = dt * speed / CAR_WHEEL_RADIUS;
  for (const wheel of anim.wheels) wheel.rotation.x -= spin;
  const turn = THREE.MathUtils.clamp(steer, -1, 1) * 0.34;
  for (const pivot of anim.steering) {
    pivot.rotation.y += (turn - pivot.rotation.y) * Math.min(1, dt * 11);
  }
}
