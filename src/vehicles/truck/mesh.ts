import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Cockpit } from "../../player/types";
import { buildBunting, buildFlag } from "../../fx/cloth";
import { GuitaristStand, LauncherRig, RocketBattery, buildGuitarPlayer } from "../../gameplay/launchers";
import { TRUCK_RIDE_HEIGHT } from "./dimensions";
import { buildEagle } from "./eagle";

/**
 * The Freedom Truck — now a real flag-wrapped F-450 crew-cab dually flatbed,
 * loaded from /models/truck.glb (Tripo export, 27 parts under a ROOT node).
 * Replaces the old procedural box build. The GLB is dropped into the same group
 * frame the rest of the game expects: front is local -Z, group y=0 is the chassis
 * centre (TRUCK_RIDE_HEIGHT above the ground, wheels planted at y=-RIDE), and the
 * bald eagle / rocket battery / jamming guitarist ride the bed + cab roof.
 *
 * The launchers hang off a LauncherRig on `userData.launcherRig`; the host is
 * dependency-free — main.ts injects the fireworks/rocket-rider systems at fire
 * time, so the same rig drops onto a boat later untouched.
 */

// --- GLB fit. Measured in Blender (Z-up) → THREE (Y-up) the axes are:
//   THREE +X = truck length, cab/grille at +X;  THREE +Y = up;  THREE +Z = width.
// A uniform scale F ≈ makes the model ~18.7 m long (≈ the collider's 18.4 m) and
// a +90° yaw turns the cab (+X) to face game-front (-Z).
const F = 19; // GLB → game uniform scale
const RIDE = TRUCK_RIDE_HEIGHT; // wheels planted this far below the group origin

// Raw model heights (THREE-Y, before recentre) sampled from the mesh in Blender.
const RAW = {
  wheelBottom: -0.181, // lowest tyre contact → mapped to group y = -RIDE
  bedFloor: 0.029, // deck surface the rockets/eagle rest on
  bedRail: 0.09, // top of the wooden bed rails
  cabRoof: 0.144 // flat cab roof the guitarist stands on
};
// Raw model length-axis centres (THREE-X); yaw maps game z = -x.
const RAW_X = {
  bedCentre: -0.2525, // middle of the open bed
  bedRear: -0.485, // tailgate end of the bed (nearest the chase cam)
  cabCentre: 0.106 // over the cab roof
};

// group-local anchors derived from the fit (tweak F and everything follows)
const anchorY = (rawY: number) => -RIDE + F * (rawY - RAW.wheelBottom);
const anchorZ = (rawX: number) => -rawX * F; // +90° yaw: THREE +X → game -Z
const BED_FLOOR_Y = anchorY(RAW.bedFloor); // ≈ 0.99
const BED_RAIL_Y = anchorY(RAW.bedRail); // ≈ 2.15
const CAB_ROOF_Y = anchorY(RAW.cabRoof); // ≈ 3.18
const BED_CENTRE_Z = anchorZ(RAW_X.bedCentre); // ≈ 4.80
const BED_REAR_Z = anchorZ(RAW_X.bedRear); // ≈ 9.2
const CAB_Z = anchorZ(RAW_X.cabCentre); // ≈ -2.0
const BED_HALF_W = 2.5; // interior half-width of the bed (rails at ±2.6)

const BATTERY_SCALE = 1.7;
const GUITARIST_SCALE = 1.5;
const GUITARIST_FOOT_DROP = 0.05; // hips→sole in the guitarist's own units

/** A flag flying from a pole (bed rails). Sizes in game metres. */
function poleFlag(height: number, flagW: number, flagH: number, phase = 0): THREE.Group {
  const g = new THREE.Group();
  const poleRadius = 0.08;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleRadius, poleRadius, height, 8),
    new THREE.MeshLambertMaterial({ color: 0x8a8f96 })
  );
  pole.position.y = height / 2;
  g.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshLambertMaterial({ color: 0xf2b01a }));
  knob.position.y = height + 0.06;
  g.add(knob);
  const flag = buildFlag({ w: flagW, h: flagH, amp: 0.13, speed: 6, phase });
  flag.position.set(0.04, height - flagH * 0.6, 0);
  g.add(flag);
  return g;
}

export function buildTruckMesh(): THREE.Group {
  const g = new THREE.Group();

  // --- the truck body itself, loaded async (the group is returned empty and
  // populated on arrival, like the eagle/phoenix/guitarist). Recentre so the
  // model straddles x/z = 0 with its wheels at the recentre origin, then scale,
  // yaw the cab to face -Z, and drop it so the tyres plant at group y = -RIDE.
  new GLTFLoader().load("/models/truck.glb", (gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const ctr = box.getCenter(new THREE.Vector3());
    scene.position.set(-ctr.x, -box.min.y, -ctr.z); // centre x/z, wheels at y=0

    const holder = new THREE.Group();
    holder.add(scene);
    holder.scale.setScalar(F);
    holder.rotation.y = Math.PI / 2; // cab (+X) → game front (-Z)
    holder.position.y = -RIDE; // wheels plant on the ground plane

    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
    });
    g.add(holder);
  });

  // closed cab — the driver rides inside behind tinted glass, so the driver rig
  // is parked (player.ts honours `hide`). Seat/wheel kept for anyone who reads it.
  g.userData.cockpit = {
    seat: [-0.9, 1.5, CAB_Z + 0.4],
    wheel: [-0.9, 2.05, CAB_Z - 0.7],
    hide: true
  } satisfies Cockpit;

  // --- the blow-up eagle: perched at the very BACK of the bed on a low riser,
  // towering behind the launchers, facing forward down the truck (-Z). This is
  // the element the chase cam frames as it swings behind at the climax.
  const riser = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.7, 1.6),
    new THREE.MeshLambertMaterial({ color: 0x1c1f25 })
  );
  riser.position.set(0, BED_FLOOR_Y + 0.35, BED_REAR_Z - 1.0);
  riser.castShadow = true;
  g.add(riser);
  const eagle = buildEagle();
  eagle.position.set(0, BED_FLOOR_Y + 0.7, BED_REAR_Z - 1.0);
  eagle.scale.setScalar(1.7);
  g.add(eagle);

  // bunting swagged across the headboard (front wall of the bed, behind the cab)
  const bunting = buildBunting({ span: BED_HALF_W * 2, count: 11, drop: 0.55, sag: 0.32 });
  bunting.position.set(-BED_HALF_W, BED_RAIL_Y + 0.35, 0.3);
  g.add(bunting);

  // a run of rippling flags flying off both bed rails, framing the show
  for (const sx of [-1, 1] as const) {
    for (let i = 0; i < 3; i++) {
      const f = poleFlag(1.9, 1.35, 0.85, i * 0.7 + (sx > 0 ? 0.3 : 1.5));
      f.position.set(sx * (BED_HALF_W + 0.15), BED_RAIL_Y - 0.15, 1.6 + i * 2.6);
      g.add(f);
    }
  }

  // --- the show: a rack of rockets lies in the open bed (one click launches
  // them all into a red/white/blue firework barrage), and the guitarist jams on
  // the cab roof, well clear of the eagle at the back.
  const rig = new LauncherRig(g);
  // battery rows sit at local z {0.4,1.7}·scale; offset the origin so they centre
  // on the bed and nose forward toward the cab.
  const rowMid = ((0.4 + 1.7) / 2) * BATTERY_SCALE;
  const battery = rig.add(new RocketBattery(), [0, BED_FLOOR_Y, BED_CENTRE_Z - rowMid], [0, 0, 0]);
  battery.group.scale.setScalar(BATTERY_SCALE);
  const guitarist = rig.add(new GuitaristStand({ buildRider: buildGuitarPlayer }), [
    0,
    CAB_ROOF_Y + GUITARIST_FOOT_DROP * GUITARIST_SCALE,
    CAB_Z
  ], [0, 0, 0]);
  guitarist.group.scale.setScalar(GUITARIST_SCALE);
  g.userData.launcherRig = rig;

  return g;
}
