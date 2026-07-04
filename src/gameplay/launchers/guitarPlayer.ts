import * as THREE from "three/webgpu";
import { buildRig, type Rig } from "../../player/rig";
import { avatarFromSeed, type AvatarTraits } from "../../player/avatar";
import { LIGHT_SCALE } from "../../config";
import type { Rider, RiderFactory } from "./types";

/** An electric guitar prop, slung across the chest, neck up to the left. */
function buildGuitar(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xc11f2b });
  const guardMat = new THREE.MeshLambertMaterial({ color: 0xf3ede0 });
  const neckMat = new THREE.MeshLambertMaterial({ color: 0x3a2a18 });
  const headMat = new THREE.MeshLambertMaterial({ color: 0x1b140c });
  const steel = new THREE.MeshLambertMaterial({ color: 0xd8dde2, emissive: 0x2a2d31, emissiveIntensity: 0.6 * LIGHT_SCALE });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.07), bodyMat);
  body.castShadow = true;
  g.add(body);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.02), guardMat);
  guard.position.set(-0.02, -0.05, 0.045);
  g.add(guard);
  // neck rises toward +Y, offset to the guitar's upper edge
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.86, 0.045), neckMat);
  neck.position.set(0.02, 0.58, 0.01);
  g.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.05), headMat);
  head.position.set(0.02, 1.04, 0.01);
  g.add(head);
  // pickups / bridge glints
  for (const y of [0.02, -0.12]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.03), steel);
    p.position.set(-0.02, y, 0.05);
    g.add(p);
  }
  // slung across the torso: pivoted so the neck goes up-left, body at the hip
  g.rotation.set(0.15, 0.2, 0.9);
  g.position.set(-0.05, 0.16, -0.24);
  g.scale.setScalar(0.92);
  return g;
}

function set(gr: THREE.Group, x: number, y: number, z: number) {
  gr.rotation.set(x, y, z);
}

/** Straddle the rocket, hunched over the guitar, right hand strumming. */
function poseRideGuitar(r: Rig, t: number) {
  const strum = Math.sin(t * 13) * 0.28;
  const bang = Math.sin(t * 5) * 0.12;
  r.hips.position.y = 0;
  set(r.hips, 0.28, 0, 0); // pitched forward astride the fuselage
  set(r.torso, 0.16, 0, 0);
  set(r.head, -0.28 + bang, Math.sin(t * 0.7) * 0.1, 0); // chin up into the wind
  // legs splayed wide to grip the rocket's flanks, shins swept back
  set(r.legL, 0.35, 0, -0.72);
  set(r.legR, 0.35, 0, 0.72);
  set(r.shinL, -0.95, 0, 0);
  set(r.shinR, -0.95, 0, 0);
  // left hand up on the neck, right hand thrashing the strings
  set(r.armL, 1.15, -0.2, 0.5);
  set(r.foreL, 0.9, 0, 0);
  set(r.armR, 0.85 + strum, 0.1, -0.35);
  set(r.foreR, 0.55 - strum, 0, 0);
}

/** Landed and jamming: knees bent, hips rocking, headbanging, fast strum. */
function poseJam(r: Rig, t: number) {
  const strum = Math.sin(t * 15) * 0.34;
  const rock = Math.sin(t * 3.2);
  r.hips.position.y = -0.06 + Math.abs(Math.sin(t * 3.2)) * 0.05;
  set(r.hips, 0.06, rock * 0.05, rock * 0.04);
  set(r.torso, 0.12, rock * 0.06, -rock * 0.05);
  set(r.head, 0.14 + Math.sin(t * 6) * 0.22, rock * 0.1, 0); // headbang
  set(r.legL, 0.16, 0, -0.16);
  set(r.legR, 0.1, 0, 0.14);
  set(r.shinL, -0.42, 0, 0);
  set(r.shinR, -0.34, 0, 0);
  set(r.armL, 1.2, -0.25, 0.42);
  set(r.foreL, 0.95, 0, 0);
  set(r.armR, 0.8 + strum, 0.12, -0.3);
  set(r.foreR, 0.6 - strum, 0, 0);
}

/**
 * The default performer: a long-haired rocker with a slung electric guitar.
 * A RiderFactory — swap it for `buildFlutePlayer` etc. without touching the
 * launcher or the flight sim.
 */
export const buildGuitarPlayer: RiderFactory = (avatar?: AvatarTraits): Rider => {
  const a: AvatarTraits = { ...(avatar ?? avatarFromSeed("guitar-hero")), hair: "long", hat: "none", outfit: "tee" };
  const rig = buildRig(a);
  const group = new THREE.Group();
  group.add(rig.group);
  rig.group.add(buildGuitar());
  return {
    group,
    ride: (t: number) => poseRideGuitar(rig, t),
    jam: (t: number) => poseJam(rig, t)
  };
};
