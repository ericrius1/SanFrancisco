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
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.44, 16, 14), white);
  chest.scale.set(0.82, 1.0, 0.62);
  chest.position.set(0, 0.5, -0.24);
  g.add(chest);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 14), white);
  head.position.set(0, 1.12, -0.14);
  head.castShadow = true;
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 12), gold);
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 1.06, -0.46);
  g.add(beak);
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
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.55, 12), white);
  tail.rotation.x = Math.PI / 2 - 0.35;
  tail.scale.set(1, 0.35, 1);
  tail.position.set(0, 0.38, 0.55);
  g.add(tail);
  for (const sx of [-0.22, 0.22]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.03, 0.22, 8), gold);
    foot.position.set(sx, 0.02, -0.08);
    g.add(foot);
  }
  return g;
}

/** A flag flying from a pole (bed rails, front fender). */
function poleFlag(height: number, flagW: number, flagH: number, phase = 0): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, height, 8),
    new THREE.MeshLambertMaterial({ color: 0x8a8f96 })
  );
  pole.position.y = height / 2;
  g.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshLambertMaterial({ color: 0xf2b01a }));
  knob.position.y = height + 0.03;
  g.add(knob);
  const flag = buildFlag({ w: flagW, h: flagH, amp: 0.13, speed: 6, phase });
  flag.position.set(0.02, height - flagH * 0.6, 0);
  g.add(flag);
  return g;
}

/**
 * The Freedom Truck: an epic flatbed monster (bigger than a heavy pickup,
 * shy of a semi) — tall crew cab up front, a vast open cargo bed behind, six
 * fat wheels. A blow-up eagle rides the cab roof and American flags/bunting fly
 * all over, every panel rippling in the wind. Two launchers sit way apart on
 * the bed: a firework honeycomb and a rider rocket. Front is local -Z (matches
 * TruckController's forward).
 *
 * The launchers hang off a LauncherRig on `userData.launcherRig`; the host is
 * dependency-free — main.ts injects the fireworks/rocket-rider systems at fire
 * time, so the same rig drops onto a boat later untouched.
 */
export function buildTruckMesh(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x262a31 });
  const panel = new THREE.MeshLambertMaterial({ color: 0x1c1f25 });
  const trim = new THREE.MeshLambertMaterial({ color: 0x0f1115 });
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x39312a }); // wood-ish flatbed
  const seatMat = new THREE.MeshLambertMaterial({ color: 0x6b4a30 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x0e141c });
  const chrome = new THREE.MeshLambertMaterial({ color: 0xc2c6cd });
  const headlight = new THREE.MeshLambertMaterial({ color: 0xfff4c9, emissive: 0xffedb0, emissiveIntensity: 2.6 * LIGHT_SCALE });
  const taillight = new THREE.MeshLambertMaterial({ color: 0xd41818, emissive: 0xff1a10, emissiveIntensity: 2.8 * LIGHT_SCALE });

  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // --- ladder frame running the whole length
  box(trim, 2.7, 0.42, 9.2, 0, -0.42, 0);
  box(panel, 3.0, 0.3, 9.0, 0, -0.66, 0); // rocker/skirt

  // --- tall crew cab up front (z −4.6 … −1.3)
  box(bodyMat, 2.86, 1.7, 3.3, 0, 0.62, -2.95);
  box(bodyMat, 2.9, 0.16, 3.4, 0, 1.52, -2.95); // roof
  box(glass, 2.66, 1.0, 0.12, 0, 0.95, -4.58, 0.28); // windshield
  box(glass, 2.66, 0.62, 0.1, 0, 0.86, -1.32); // rear cab glass
  for (const sx of [-1.44, 1.44]) box(glass, 0.08, 0.8, 2.2, sx, 0.9, -3.0); // side windows
  box(panel, 2.9, 0.2, 3.4, 0, 1.62, -2.95); // roof cap (eagle perch)
  // hood + snout
  box(bodyMat, 2.8, 0.66, 1.5, 0, 0.2, -5.05);
  box(trim, 3.0, 0.8, 0.4, 0, 0.0, -5.78); // front bumper
  box(chrome, 1.7, 0.5, 0.1, 0, 0.32, -5.84); // grille
  box(headlight, 0.5, 0.26, 0.14, -1.0, 0.32, -5.82);
  box(headlight, 0.5, 0.26, 0.14, 1.0, 0.32, -5.82);

  // --- huge flatbed (z −0.9 … 4.7, ~5.6 m of deck)
  box(deckMat, 3.0, 0.28, 5.7, 0, 0.02, 1.9);
  for (const px of [-0.9, -0.3, 0.3, 0.9]) box(trim, 0.05, 0.3, 5.7, px, 0.03, 1.9); // plank seams
  box(bodyMat, 3.0, 0.66, 0.18, 0, 0.4, -0.95); // headboard behind cab
  box(bodyMat, 0.18, 0.5, 5.7, 1.45, 0.32, 1.9); // side rail R
  box(bodyMat, 0.18, 0.5, 5.7, -1.45, 0.32, 1.9); // side rail L
  box(bodyMat, 3.0, 0.5, 0.18, 0, 0.32, 4.72); // tailgate
  box(taillight, 2.4, 0.16, 0.12, 0, 0.5, 4.8);

  g.userData.cockpit = { seat: [-0.62, 0.72, -3.0], wheel: [-0.62, 1.06, -3.75] } satisfies Cockpit;

  // cab interior: bench + dash (driver rig sits here, visible through the glass)
  box(seatMat, 2.4, 0.2, 0.7, 0, 0.5, -2.7);
  box(seatMat, 2.4, 0.7, 0.18, 0, 0.86, -2.3);
  box(trim, 2.5, 0.3, 0.24, 0, 0.7, -4.2); // dash

  // --- six fat off-road wheels (front axle + rear tandem)
  const wheelGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.6, 20);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.62, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.MeshLambertMaterial({ color: 0x14161a });
  for (const wz of [-3.5, 2.5, 3.9]) {
    for (const wx of [-1.42, 1.42]) {
      const wheel = new THREE.Mesh(wheelGeo, tyre);
      wheel.position.set(wx, -0.66, wz);
      wheel.castShadow = true;
      g.add(wheel);
      const hub = new THREE.Mesh(hubGeo, chrome);
      hub.position.set(wx, -0.66, wz);
      g.add(hub);
    }
  }

  // --- roof decor: a big blow-up eagle
  const eagle = buildEagle();
  eagle.position.set(0, 1.72, -2.7);
  eagle.scale.setScalar(1.7);
  g.add(eagle);

  // bunting swagged across the headboard, above the bed
  const bunting = buildBunting({ span: 2.8, count: 11, drop: 0.32, sag: 0.18 });
  bunting.position.set(-1.4, 0.95, -0.85);
  g.add(bunting);

  // a run of flags flying off both bed rails
  for (const sx of [-1.42, 1.42] as const) {
    for (let i = 0; i < 3; i++) {
      const f = poleFlag(1.1, 0.8, 0.5, i * 0.7 + (sx > 0 ? 0.3 : 1.5));
      f.position.set(sx, 0.5, 0.4 + i * 1.9);
      g.add(f);
    }
  }

  // --- big flag draped down the passenger side of the bed + a tall fender pole
  const sideFlag = buildDrape({ w: 3.0, h: 1.5, amp: 0.15, speed: 4.6 });
  sideFlag.rotation.y = Math.PI / 2; // face +X
  sideFlag.position.set(1.56, 0.9, 1.9);
  g.add(sideFlag);

  const frontPole = poleFlag(2.4, 1.3, 0.82);
  frontPole.position.set(-1.35, 0.2, -5.2);
  g.add(frontPole);

  // --- the two launchers, spaced way apart on the big deck
  const rig = new LauncherRig(g);
  const comb = rig.add(new FireworkLauncher({ rows: 4, cols: 6, fuse: 5 }), [-0.72, 0.42, 2.9], [-0.14, 0, 0.26]);
  comb.group.scale.setScalar(1.35);
  const rail = rig.add(new RiderRocketLauncher({ buildRider: buildGuitarPlayer }), [0.78, 0.5, 1.2], [0, -0.16, 0]);
  rail.group.scale.setScalar(1.25);
  g.userData.launcherRig = rig;

  return g;
}
