import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Cockpit } from "../../player/types";
import { buildBunting, buildDrape, buildFlag } from "../../fx/cloth";
import { FireworkLauncher, LauncherRig, RiderRocketLauncher, buildGuitarPlayer } from "../../gameplay/launchers";

/**
 * A blow-up bald eagle for the roof: chunky inflatable body with a white head,
 * gold beak, and huge American-flag wings that ripple in the wind (the cloth
 * ripple from src/fx/cloth). Front is local -Z.
 */
function buildEagle(): THREE.Group {
  const g = new THREE.Group();
  const brown = new THREE.MeshLambertMaterial({ color: 0x4a3520 });
  const white = new THREE.MeshLambertMaterial({ color: 0xf1efe6 });
  const gold = new THREE.MeshLambertMaterial({ color: 0xf2b01a });
  const dark = new THREE.MeshLambertMaterial({ color: 0x121014 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 14), brown);
  body.scale.set(0.95, 1.2, 0.9);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  // pale chest
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.44, 16, 14), white);
  chest.scale.set(0.82, 1.0, 0.62);
  chest.position.set(0, 0.5, -0.24);
  g.add(chest);
  // white head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 14), white);
  head.position.set(0, 1.12, -0.14);
  head.castShadow = true;
  g.add(head);
  // gold hooked beak
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 12), gold);
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 1.06, -0.46);
  g.add(beak);
  // brow ridges + eyes for the stern glare
  for (const sx of [-0.13, 0.13]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), dark);
    eye.position.set(sx, 1.18, -0.32);
    g.add(eye);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.1), brown);
    brow.position.set(sx, 1.24, -0.3);
    brow.rotation.z = sx > 0 ? 0.4 : -0.4;
    g.add(brow);
  }
  // flag wings — spread up, out and back; the ripple flutters the fly tips
  const wing = (side: 1 | -1) => {
    const w = buildFlag({ w: 1.55, h: 0.9, amp: 0.17, speed: 5, phase: side > 0 ? 0 : 1.3 });
    w.rotation.order = "ZYX";
    w.position.set(side * 0.34, 0.86, 0.08);
    w.scale.x = side; // mirror the -x wing so both fan outward from the shoulder
    w.rotation.set(-1.25, side * -0.35, side * 0.55);
    g.add(w);
  };
  wing(1);
  wing(-1);
  // white tail fan
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.55, 12), white);
  tail.rotation.x = Math.PI / 2 - 0.35;
  tail.scale.set(1, 0.35, 1);
  tail.position.set(0, 0.38, 0.55);
  g.add(tail);
  // gold talons gripping the roof
  for (const sx of [-0.22, 0.22]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.03, 0.22, 8), gold);
    foot.position.set(sx, 0.02, -0.08);
    g.add(foot);
  }
  return g;
}

/** A small flag flying from a short pole (roof corners, front bumper). */
function poleFlag(height: number, flagW: number, flagH: number, phase = 0): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, height, 8),
    new THREE.MeshLambertMaterial({ color: 0x8a8f96 })
  );
  pole.position.y = height / 2;
  g.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), new THREE.MeshLambertMaterial({ color: 0xf2b01a }));
  knob.position.y = height + 0.02;
  g.add(knob);
  const flag = buildFlag({ w: flagW, h: flagH, amp: 0.12, speed: 6, phase });
  flag.position.set(0.02, height - flagH * 0.6, 0);
  g.add(flag);
  return g;
}

/**
 * The Freedom Truck: an open golf-cart pickup with a canopy roof, a blow-up
 * eagle and a spread of American flags/bunting up top, and two mounted
 * launchers in the bed (a firework honeycomb + a rider rocket). All the cloth
 * ripples in the wind. Front is local -Z (matches TruckController's forward).
 *
 * The launchers hang off a LauncherRig exposed on `userData.launcherRig`; the
 * host is dependency-free — main.ts injects the fireworks/rocket-rider systems
 * at fire time.
 */
export function buildTruckMesh(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x23262c });
  const trim = new THREE.MeshLambertMaterial({ color: 0x121419 });
  const seatMat = new THREE.MeshLambertMaterial({ color: 0x6b4a30 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x0e141c });
  const chrome = new THREE.MeshLambertMaterial({ color: 0xb9bdc4 });
  const headlight = new THREE.MeshLambertMaterial({ color: 0xfff4c9, emissive: 0xffedb0, emissiveIntensity: 2.4 * LIGHT_SCALE });
  const taillight = new THREE.MeshLambertMaterial({ color: 0xd41818, emissive: 0xff1a10, emissiveIntensity: 2.6 * LIGHT_SCALE });

  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // --- chassis: chunky low tub, front hood, raised rear cargo bed
  box(bodyMat, 2.2, 0.62, 4.0, 0, 0.05, 0);
  box(trim, 2.26, 0.2, 4.05, 0, -0.24, 0); // rocker skirt
  box(bodyMat, 2.08, 0.34, 1.2, 0, 0.28, -1.55); // hood
  // cab floor + bench
  box(trim, 1.94, 0.1, 1.7, 0, 0.42, -0.9);
  box(seatMat, 1.9, 0.18, 0.66, 0, 0.6, -0.5);
  box(seatMat, 1.9, 0.52, 0.16, 0, 0.86, -0.14);
  box(trim, 2.0, 0.34, 0.22, 0, 0.82, -1.55); // dash
  // cargo bed at the rear (launchers bolt in here)
  box(trim, 2.0, 0.12, 1.8, 0, 0.5, 1.2); // bed floor
  box(bodyMat, 0.12, 0.44, 1.8, 1.0, 0.7, 1.2); // bed wall R
  box(bodyMat, 0.12, 0.44, 1.8, -1.0, 0.7, 1.2); // bed wall L
  box(bodyMat, 2.0, 0.44, 0.12, 0, 0.7, 2.06); // tailgate
  // canopy roof on four posts over the cab
  for (const [px, pz] of [[-1.0, -1.95], [1.0, -1.95], [-1.0, 0.25], [1.0, 0.25]] as const) {
    box(trim, 0.1, 1.0, 0.1, px, 1.2, pz);
  }
  box(bodyMat, 2.34, 0.1, 2.5, 0, 1.72, -0.85); // roof panel
  box(trim, 2.4, 0.08, 0.16, 0, 1.68, -2.08); // front eave (bunting hangs here)
  box(glass, 2.0, 0.62, 0.06, 0, 1.2, -1.98, 0.32); // windshield
  // front face: bumper, grille, headlights
  box(trim, 2.3, 0.28, 0.24, 0, -0.06, -2.06);
  box(chrome, 1.0, 0.16, 0.06, 0, 0.16, -2.14);
  box(headlight, 0.34, 0.18, 0.1, -0.76, 0.16, -2.12);
  box(headlight, 0.34, 0.18, 0.1, 0.76, 0.16, -2.12);
  // rear: bumper + light bar
  box(trim, 2.3, 0.28, 0.24, 0, -0.06, 2.06);
  box(taillight, 1.7, 0.14, 0.1, 0, 0.36, 2.13);

  g.userData.cockpit = { seat: [-0.48, 0.74, -0.42], wheel: [-0.48, 0.98, -0.98] } satisfies Cockpit;

  // --- chunky off-road wheels
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.44, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.46, 10);
  hubGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.MeshLambertMaterial({ color: 0x14161a });
  for (const [wx, wz] of [[-1.02, -1.45], [1.02, -1.45], [-1.02, 1.5], [1.02, 1.5]] as const) {
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    wheel.position.set(wx, -0.28, wz);
    wheel.castShadow = true;
    g.add(wheel);
    const hub = new THREE.Mesh(hubGeo, chrome);
    hub.position.set(wx, -0.28, wz);
    g.add(hub);
  }

  // --- roof decor: blow-up eagle, bunting, corner flags
  const eagle = buildEagle();
  eagle.position.set(0, 1.78, -0.7);
  eagle.scale.setScalar(1.15);
  g.add(eagle);

  const bunting = buildBunting({ span: 2.0, count: 9, drop: 0.26, sag: 0.14 });
  bunting.position.set(-1.0, 1.66, -2.06);
  g.add(bunting);

  for (const sx of [-0.95, 0.95] as const) {
    const cf = poleFlag(0.7, 0.66, 0.42, sx > 0 ? 0.5 : 1.7);
    cf.position.set(sx, 1.74, 0.3);
    g.add(cf);
  }

  // --- big flags: draped over the passenger side + a tall pole up front
  const sideFlag = buildDrape({ w: 1.7, h: 1.15, amp: 0.13, speed: 4.6 });
  sideFlag.rotation.y = Math.PI / 2; // face +X (passenger side)
  sideFlag.position.set(1.12, 0.98, -0.55);
  g.add(sideFlag);

  const frontPole = poleFlag(1.5, 0.9, 0.58);
  frontPole.position.set(-0.98, 0.1, -2.0);
  g.add(frontPole);

  // --- the two launchers, bolted into the bed
  const rig = new LauncherRig(g);
  rig.add(new FireworkLauncher({ rows: 3, cols: 5, fuse: 5 }), [-0.62, 0.98, 1.28], [-0.16, 0, 0.34]);
  const rail = rig.add(new RiderRocketLauncher({ buildRider: buildGuitarPlayer }), [0.64, 0.86, 1.05], [0, -0.18, 0]);
  rail.group.scale.setScalar(0.82);
  g.userData.launcherRig = rig;

  return g;
}
