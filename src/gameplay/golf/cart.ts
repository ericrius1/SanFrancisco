import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Cockpit, DriveSpec } from "../../player/types";

/**
 * A stylized two-seat golf cart, built to ride the shared drive embodiment via
 * setDriveStyle (same mechanism as the ridden animals): swap in this mesh +
 * GOLF_CART_SPEC and the car controller drives it, just lighter, slower and
 * tippier so a hot corner can put it up on two wheels. Front is local -Z to
 * match CarController's forward.
 *
 * Two golf-bag props ride the rear deck, one per occupant: `setCartBags(mesh, n)`
 * shows the driver's bag at n≥1 and the passenger's at n≥2. The bags are plain
 * children so a network occupant-count update is a single visibility flip.
 */

// short, narrow, low — a putt-putt runabout, not a sports car
export const GOLF_CART_SPEC: DriveSpec = {
  halfExtents: [0.66, 0.42, 1.28],
  rideHeight: 0.52,
  maxFactor: 0.5, // ~half the sports car's top speed
  accelFactor: 0.72,
  steerFactor: 1.4 // twitchy: lean it into a fast corner and it'll tip
};

/** A single stylized golf bag: tube body, a hood, a stand leg, and a fan of
 *  club heads poking out the top. Origin at the base so it stands on the deck. */
function buildGolfBag(bodyColor: number, accent: number): THREE.Group {
  const bag = new THREE.Group();
  bag.name = "golfbag";
  const body = new THREE.MeshLambertMaterial({ color: bodyColor });
  const trim = new THREE.MeshLambertMaterial({ color: accent });
  const dark = new THREE.MeshLambertMaterial({ color: 0x20242b });
  const chrome = new THREE.MeshLambertMaterial({ color: 0xc8ccd2 });

  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.92, 12), body);
  tube.position.y = 0.46;
  bag.add(tube);
  // color band + a pocket
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.16, 12), trim);
  band.position.y = 0.34;
  bag.add(band);
  const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.1), trim);
  pocket.position.set(0, 0.4, -0.16);
  bag.add(pocket);
  // padded top cuff
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.12, 12), dark);
  cuff.position.y = 0.95;
  bag.add(cuff);
  // carry strap arcing across the body
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 6, 14, Math.PI), dark);
  strap.position.set(0, 0.6, 0.02);
  strap.rotation.set(Math.PI / 2, 0, 0.4);
  bag.add(strap);
  // a stand leg kicked out (that classic carry-stand look)
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.7, 6), chrome);
  leg.position.set(0.13, 0.5, 0.12);
  leg.rotation.x = 0.32;
  bag.add(leg);
  // a fan of clubs: shafts + heads spraying out the mouth
  const headMat = [chrome, dark, new THREE.MeshLambertMaterial({ color: 0x9aa0a8 })];
  let hi = 0;
  for (const [sx, sz, lean] of [
    [-0.07, -0.05, -0.2],
    [0.06, -0.06, 0.15],
    [-0.02, 0.07, -0.05],
    [0.09, 0.03, 0.28],
    [-0.09, 0.02, -0.3]
  ] as [number, number, number][]) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 5), chrome);
    shaft.position.set(sx, 1.16, sz);
    shaft.rotation.z = lean;
    bag.add(shaft);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.08), headMat[hi % headMat.length]);
    head.position.set(sx + Math.sin(lean) * 0.24, 1.4, sz);
    bag.add(head);
    hi++;
  }
  return bag;
}

// Front of the cart is local -Z (matches CarController's forward).
export function buildGolfCartMesh(): THREE.Group {
  const g = new THREE.Group();
  const bodyColor = 0xf2ede0; // cream body — the country-club classic
  const roofColor = 0x2f7d54; // forest-green canopy
  const paint = new THREE.MeshLambertMaterial({ color: bodyColor });
  const roof = new THREE.MeshLambertMaterial({ color: roofColor });
  const trim = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
  const seatMat = new THREE.MeshLambertMaterial({ color: 0x3a6f4c });
  const chrome = new THREE.MeshLambertMaterial({ color: 0xc8ccd2 });
  const headlight = new THREE.MeshLambertMaterial({ color: 0xfff4c9, emissive: 0xffedb0, emissiveIntensity: 1.8 * LIGHT_SCALE });
  const taillight = new THREE.MeshLambertMaterial({ color: 0xd41818, emissive: 0xff1a10, emissiveIntensity: 2.0 * LIGHT_SCALE });

  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // floor pan + rocker sills
  box(paint, 1.28, 0.16, 2.5, 0, -0.16, 0);
  box(trim, 1.34, 0.08, 2.3, 0, -0.26, 0);
  // rounded nose cowl (stacked boxes dropping toward the bumper)
  box(paint, 1.24, 0.34, 0.7, 0, 0.02, -1.06);
  box(paint, 1.12, 0.24, 0.4, 0, 0.2, -0.86, 0.2);
  box(trim, 1.24, 0.12, 0.16, 0, -0.14, -1.4); // front bumper
  box(headlight, 0.24, 0.14, 0.08, -0.42, 0.02, -1.42);
  box(headlight, 0.24, 0.14, 0.08, 0.42, 0.02, -1.42);
  // little front basket / grille badge
  box(chrome, 0.5, 0.02, 0.34, 0, 0.2, -1.02);

  // bench seat for two: one long cushion + split backrest
  box(seatMat, 1.16, 0.16, 0.62, 0, 0.16, 0.18);
  for (const sx of [-0.29, 0.29]) {
    box(seatMat, 0.54, 0.46, 0.14, sx, 0.42, 0.5); // seat back per rider
  }
  box(trim, 1.2, 0.06, 0.66, 0, 0.06, 0.18); // seat frame lip
  // hip bolster / grab bar between deck and seat
  box(chrome, 1.2, 0.04, 0.04, 0, 0.62, 0.58);

  // dash + steering column (driver = left, local +X? front -Z → left is +X)
  box(trim, 1.16, 0.34, 0.14, 0, 0.34, -0.28);
  const column = box(trim, 0.06, 0.06, 0.44, 0.34, 0.42, -0.12, -0.7);
  void column;
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 18), trim);
  wheel.position.set(0.34, 0.56, 0.02);
  wheel.rotation.x = 1.15;
  wheel.castShadow = true;
  g.add(wheel);

  // canopy: 4 posts + a flat roof with a slight lip
  for (const [px, pz] of [
    [-0.58, -0.5],
    [0.58, -0.5],
    [-0.58, 0.86],
    [0.58, 0.86]
  ] as [number, number][]) {
    box(chrome, 0.06, 1.32, 0.06, px, 1.06, pz);
  }
  box(roof, 1.4, 0.1, 1.86, 0, 1.74, 0.16);
  box(roof, 1.5, 0.05, 0.14, 0, 1.7, -0.78); // front roof lip / sun visor
  box(trim, 1.4, 0.02, 1.86, 0, 1.68, 0.16); // underside shade

  // rear bag deck + a low well the bags drop into
  box(paint, 1.2, 0.5, 0.66, 0, 0.12, 1.28);
  box(trim, 1.16, 0.08, 0.6, 0, 0.4, 1.28); // deck floor (bags stand on this)
  for (const bx of [-0.28, 0.28]) box(chrome, 0.03, 0.42, 0.03, bx, 0.6, 1.02); // upright bag rails
  box(chrome, 0.6, 0.03, 0.03, 0, 0.82, 1.02); // rail crossbar the bags lean on
  box(taillight, 1.0, 0.1, 0.08, 0, 0.28, 1.62);
  box(trim, 1.24, 0.12, 0.16, 0, -0.14, 1.6); // rear bumper

  // two golf bags on the deck, hidden until an occupant claims each seat
  const bagPos: [number, number][] = [
    [-0.28, 1.24],
    [0.28, 1.24]
  ];
  const bagColors: [number, number][] = [
    [0xc23b3b, 0xf2c14e], // driver: red/gold
    [0x2f5fb0, 0xe8edf2] // passenger: blue/white
  ];
  bagPos.forEach(([bx, bz], i) => {
    const bag = buildGolfBag(bagColors[i][0], bagColors[i][1]);
    bag.name = `golfbag-${i}`;
    bag.position.set(bx, 0.42, bz);
    bag.rotation.y = i === 0 ? 0.2 : -0.2;
    bag.visible = false;
    g.add(bag);
  });

  // wheels: small, four corners
  const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.2, 16);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.22, 10);
  hubGeo.rotateZ(Math.PI / 2);
  for (const [wx, wz] of [
    [-0.62, -0.92],
    [0.62, -0.92],
    [-0.62, 1.0],
    [0.62, 1.0]
  ] as [number, number][]) {
    const w = new THREE.Mesh(wheelGeo, trim);
    w.position.set(wx, -0.28, wz);
    w.castShadow = true;
    g.add(w);
    const hub = new THREE.Mesh(hubGeo, chrome);
    hub.position.set(wx, -0.28, wz);
    g.add(hub);
  }

  // driver sits left cushion; passenger right. Wheel is at the driver's hands.
  g.userData.cockpit = { seat: [-0.29, 0.42, 0.2], wheel: [0.34, 0.56, 0.02] } satisfies Cockpit;
  g.userData.passengerSeat = [0.29, 0.42, 0.2];
  return g;
}

/** Show golf bags for the number of occupants (0..2): driver's bag first. */
export function setCartBags(cart: THREE.Group, occupants: number): void {
  for (let i = 0; i < 2; i++) {
    const bag = cart.getObjectByName(`golfbag-${i}`);
    if (bag) bag.visible = occupants > i;
  }
}
