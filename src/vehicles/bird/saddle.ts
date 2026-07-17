import * as THREE from "three/webgpu";
import { applyVehicleShadowPolicy } from "../shadows";
import { PHOENIX_DRIVER_SEAT, PHOENIX_PASSENGER_SEATS } from "./saddleContract";

/**
 * Build the Phoenix's three-person saddle after the Phoenix first-use gate.
 * It is deliberately procedural and texture-free: activating the mount still
 * fetches only the selected Phoenix GLB, with no eager catalog or saddle art.
 */
export function installPhoenixSaddle(root: THREE.Group): void {
  if (root.getObjectByName("phoenix_saddle")) return;

  const saddle = new THREE.Group();
  saddle.name = "phoenix_saddle";
  root.add(saddle);

  const blanket = new THREE.MeshStandardMaterial({
    color: 0x7f2630,
    roughness: 0.84,
    metalness: 0.02
  });
  const leather = new THREE.MeshStandardMaterial({
    color: 0x321b19,
    roughness: 0.68,
    metalness: 0.04
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xd7a744,
    roughness: 0.28,
    metalness: 0.72
  });
  const shadowCasters: THREE.Mesh[] = [];

  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = saddle
  ) => {
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    parent.add(part);
    shadowCasters.push(part);
    return part;
  };

  // A broad blanket protects the plumage beneath all three riders. The thin
  // ellipsoid reads as fabric without adding another texture or shader path.
  const pad = mesh(new THREE.SphereGeometry(1, 24, 12), blanket, 0, 0.56, 0.08);
  pad.name = "phoenix_saddle_blanket";
  pad.scale.set(1.28, 0.13, 1.14);

  const addSeat = (position: readonly [number, number, number], width: number, name: string) => {
    const seat = mesh(new THREE.SphereGeometry(1, 20, 10), leather, position[0], position[1] - 0.13, position[2]);
    seat.name = name;
    seat.scale.set(width, 0.16, 0.42);
    const rim = mesh(new THREE.TorusGeometry(width * 0.88, 0.025, 7, 22), brass, position[0], position[1] - 0.03, position[2]);
    rim.rotation.x = Math.PI / 2;
    rim.scale.y = 0.72;
  };
  addSeat(PHOENIX_DRIVER_SEAT, 0.55, "phoenix_saddle_driver");
  addSeat(PHOENIX_PASSENGER_SEATS[0], 0.49, "phoenix_saddle_passenger_left");
  addSeat(PHOENIX_PASSENGER_SEATS[1], 0.49, "phoenix_saddle_passenger_right");

  // Front pommel, rear hand rail, and two belly straps make the load path read
  // clearly while banking; riders are not balanced on three floating cushions.
  const pommel = mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.48, 10), brass, 0, 0.92, -0.91);
  pommel.rotation.x = -0.18;
  mesh(new THREE.SphereGeometry(0.095, 12, 8), brass, 0, 1.17, -0.95);

  const rail = new THREE.Group();
  rail.name = "phoenix_saddle_rear_rail";
  rail.position.set(0, 0.76, 0.88);
  saddle.add(rail);
  const railBar = mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.55, 10), brass, 0, 0.36, 0, rail);
  railBar.rotation.z = Math.PI / 2;
  for (const x of [-0.72, 0.72]) mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.72, 10), brass, x, 0, 0, rail);

  for (const z of [-0.45, 0.52]) {
    const strap = mesh(new THREE.TorusGeometry(0.93, 0.045, 8, 32), leather, 0, 0.31, z);
    strap.rotation.x = Math.PI / 2;
    strap.scale.y = 0.72;
  }

  applyVehicleShadowPolicy(saddle, shadowCasters);
  root.userData.saddle = saddle;
}
