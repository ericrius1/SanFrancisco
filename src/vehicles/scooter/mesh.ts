import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor } from "../../player/lightPool";
import type { Cockpit } from "../../player/types";
import { applyVehicleShadowPolicy } from "../shadows";
import { rideHeightFromContact } from "../shared";
import {
  normalizeScooterConfig,
  scooterPaintHex,
  scooterSeatHex,
  scooterTrimHex,
  type ScooterConfig
} from "./config";

export type ScooterAnim = {
  wheels: THREE.Group[];
  fork: THREE.Group;
  handlebar: THREE.Group;
  battery: THREE.MeshStandardMaterial;
};

/** Wheel hub Y and tire outer radius (torus major + tube) in mesh space. */
export const SCOOTER_WHEEL_HUB_Y = 0.03;
export const SCOOTER_WHEEL_OUTER_RADIUS = 0.37 + 0.105;
/** Lowest tire contact in mesh space; chassis origin stays at body centre. */
export const SCOOTER_CONTACT_Y = SCOOTER_WHEEL_HUB_Y - SCOOTER_WHEEL_OUTER_RADIUS;
export const SCOOTER_RIDE_HEIGHT = rideHeightFromContact(SCOOTER_CONTACT_Y);

function roundedBox(w: number, h: number, d: number, r: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const rr = Math.min(r, x, y);
  shape.moveTo(-x + rr, -y);
  shape.lineTo(x - rr, -y);
  shape.quadraticCurveTo(x, -y, x, -y + rr);
  shape.lineTo(x, y - rr);
  shape.quadraticCurveTo(x, y, x - rr, y);
  shape.lineTo(-x + rr, y);
  shape.quadraticCurveTo(-x, y, -x, y - rr);
  shape.lineTo(-x, -y + rr);
  shape.quadraticCurveTo(-x, -y, -x + rr, -y);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 });
  geometry.translate(0, 0, -d / 2);
  return geometry;
}

export function buildScooterMesh(raw?: ScooterConfig): THREE.Group {
  const config = normalizeScooterConfig(raw);
  const root = new THREE.Group();
  root.name = "electric_scooter";
  const shadowCasters: THREE.Mesh[] = [];

  const paint = new THREE.MeshLambertMaterial({ color: scooterPaintHex(config) });
  const trim = new THREE.MeshLambertMaterial({ color: scooterTrimHex(config) });
  const rubber = new THREE.MeshLambertMaterial({ color: 0x12171a });
  const wall = new THREE.MeshLambertMaterial({ color: config.whitewalls ? 0xece9dc : 0x24292d });
  const seatMat = new THREE.MeshLambertMaterial({ color: scooterSeatHex(config) });
  const dark = new THREE.MeshLambertMaterial({ color: 0x172128 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9ed7e7, transparent: true, opacity: 0.32, roughness: 0.08, transmission: 0 });
  const head = new THREE.MeshLambertMaterial({ color: 0xfff3c4, emissive: 0xffe7a0, emissiveIntensity: 2.0 * LIGHT_SCALE });
  const tail = new THREE.MeshLambertMaterial({ color: 0xd82226, emissive: 0xff1c1c, emissiveIntensity: 2.2 * LIGHT_SCALE });
  const battery = new THREE.MeshStandardMaterial({ color: 0x60f0b0, emissive: 0x39e49b, emissiveIntensity: 0.7 * LIGHT_SCALE, roughness: 0.4 });

  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = [paint, trim, rubber, wall, seatMat, dark, glass, head, tail, battery];
  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = root,
    casts = false
  ) => {
    ownedGeometries.add(geometry);
    const item = new THREE.Mesh(geometry, material);
    item.position.set(x, y, z);
    parent.add(item);
    if (casts) shadowCasters.push(item);
    return item;
  };
  const box = (
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = root,
    casts = false
  ) => mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z, parent, casts);

  const wheels: THREE.Group[] = [];
  for (const z of [-0.98, 0.98]) {
    const wheel = new THREE.Group();
    wheel.position.set(0, SCOOTER_WHEEL_HUB_Y, z);
    root.add(wheel);
    const tireGeo = new THREE.TorusGeometry(0.37, 0.105, 10, 24);
    tireGeo.rotateY(Math.PI / 2);
    // One tyre per wheel carries the contact silhouette; whitewalls and hubs
    // reuse it and therefore only need to receive.
    mesh(tireGeo, rubber, 0, 0, 0, wheel, true);
    const wallGeo = new THREE.TorusGeometry(0.37, 0.065, 8, 24);
    wallGeo.rotateY(Math.PI / 2);
    mesh(wallGeo, wall, 0, 0, 0, wheel);
    const hubGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.18, 16);
    hubGeo.rotateZ(Math.PI / 2);
    mesh(hubGeo, trim, 0, 0, 0, wheel);
    wheels.push(wheel);
  }

  // Step-through silhouette: battery floor, rounded rear haunches, and the
  // signature protective front shield. Front is local -Z.
  box(dark, 0.52, 0.16, 1.22, 0, 0.24, 0.05);
  box(paint, 0.64, 0.22, 1.05, 0, 0.34, 0.32, root, true);
  const haunch = mesh(roundedBox(0.75, config.body === "sport" ? 0.66 : 0.76, 0.82, 0.18), paint, 0, 0.55, 0.63, root, true);
  haunch.rotation.x = -0.04;
  const shieldHeight = config.body === "touring" ? 1.16 : config.body === "sport" ? 0.88 : 1.03;
  const shield = mesh(roundedBox(config.body === "sport" ? 0.72 : 0.82, shieldHeight, 0.18, 0.2), paint, 0, 0.72, -0.67, root, true);
  shield.rotation.x = -0.12;
  box(trim, 0.62, 0.045, 0.88, 0, 0.45, -0.08); // feet platform
  box(battery, 0.3, 0.035, 0.36, 0, 0.475, 0.03); // battery status inset

  // Long two-up seat is invariant: every cosmetic seat option preserves room
  // for a human or the adopted-pet anchor behind the driver.
  const seatZ = config.seat === "saddle" ? 0.5 : 0.46;
  const seatLength = config.seat === "petpad" ? 1.42 : 1.32;
  const seat = mesh(roundedBox(0.58, 0.18, seatLength, 0.16), seatMat, 0, 1.02, seatZ, root, true);
  seat.rotation.x = -0.025;
  if (config.seat === "saddle") box(trim, 0.5, 0.035, 0.04, 0, 1.12, 0.56);
  if (config.seat === "petpad") {
    box(trim, 0.54, 0.045, 0.04, 0, 1.13, 0.92);
    box(seatMat, 0.08, 0.17, 0.56, -0.31, 1.16, 0.88);
    box(seatMat, 0.08, 0.17, 0.56, 0.31, 1.16, 0.88);
  }

  const fork = new THREE.Group();
  fork.position.set(0, 0.08, -0.97);
  root.add(fork);
  for (const x of [-0.2, 0.2]) {
    const leg = box(trim, 0.055, 0.88, 0.055, x, 0.42, 0, fork);
    leg.rotation.x = -0.18;
  }
  const handlebar = new THREE.Group();
  handlebar.position.set(0, 1.39, -0.73);
  root.add(handlebar);
  box(trim, 0.82, 0.055, 0.055, 0, 0, 0, handlebar);
  box(rubber, 0.2, 0.09, 0.1, -0.42, 0, 0, handlebar);
  box(rubber, 0.2, 0.09, 0.1, 0.42, 0, 0, handlebar);
  const lamp = mesh(new THREE.SphereGeometry(0.2, 18, 12), head, 0, 1.24, -0.84);
  lamp.scale.set(1.08, 0.9, 0.48);
  box(tail, 0.42, 0.14, 0.08, 0, 0.83, 1.08);
  root.add(lightAnchor({ color: 0xffedbd, intensity: 0.42 * LIGHT_SCALE, distance: 14 }, 0, 1.24, -1.05));

  if (config.screen !== "none") {
    const screen = mesh(new THREE.PlaneGeometry(config.screen === "touring" ? 0.82 : 0.62, config.screen === "touring" ? 0.82 : 0.4), glass, 0, config.screen === "touring" ? 1.64 : 1.48, -0.64);
    screen.rotation.x = -0.2;
  }

  if (config.cargo === "rack" || config.cargo === "topbox") {
    box(trim, 0.62, 0.045, 0.62, 0, 1.03, 1.28);
    for (const x of [-0.27, 0.27]) box(trim, 0.04, 0.28, 0.04, x, 0.91, 1.08);
  }
  if (config.cargo === "topbox") {
    const topbox = mesh(roundedBox(0.66, 0.42, 0.5, 0.13), paint, 0, 1.27, 1.29, root, true);
    topbox.rotation.x = -0.02;
    box(trim, 0.58, 0.04, 0.43, 0, 1.26, 1.29);
  }
  if (config.cargo === "basket") {
    const basket = new THREE.Group();
    basket.position.set(0, 1.08, -1.04);
    root.add(basket);
    box(trim, 0.7, 0.045, 0.48, 0, -0.2, 0, basket);
    for (const x of [-0.32, 0.32]) box(trim, 0.045, 0.4, 0.48, x, 0, 0, basket);
    for (const z of [-0.22, 0.22]) box(trim, 0.7, 0.4, 0.045, 0, 0, z, basket);
  }

  root.userData.contactY = SCOOTER_CONTACT_Y;
  root.userData.cockpit = { seat: [0, 1.05, 0.12] } satisfies Cockpit;
  root.userData.passengerSeat = [0, 1.08, 0.82] as [number, number, number];
  const petSeat = new THREE.Group();
  petSeat.name = "scooter_pet_seat";
  petSeat.position.set(0, 1.16, 0.86);
  petSeat.rotation.y = 0;
  root.add(petSeat);
  root.userData.petSeat = petSeat;
  root.userData.scooterAnim = { wheels, fork, handlebar, battery } satisfies ScooterAnim;
  applyVehicleShadowPolicy(root, shadowCasters);
  root.userData.dispose = () => {
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
  };
  return root;
}

export function animateScooter(root: THREE.Group, dt: number, speed: number, steer: number, boost: boolean): void {
  const anim = root.userData.scooterAnim as ScooterAnim | undefined;
  if (!anim) return;
  const spin = dt * speed / 0.37;
  for (const wheel of anim.wheels) wheel.rotation.x -= spin;
  const turn = THREE.MathUtils.clamp(steer, -1, 1) * 0.32;
  anim.fork.rotation.y += (turn - anim.fork.rotation.y) * Math.min(1, dt * 12);
  anim.handlebar.rotation.y += (turn - anim.handlebar.rotation.y) * Math.min(1, dt * 12);
  anim.battery.emissiveIntensity += ((boost ? 1.25 : 0.65) * LIGHT_SCALE - anim.battery.emissiveIntensity) * Math.min(1, dt * 8);
}
