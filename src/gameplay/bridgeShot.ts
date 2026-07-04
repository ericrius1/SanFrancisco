import * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import type { Player } from "../player/player";
import type { Physics } from "../core/physics";

/**
 * The Golden Gate "Freedom Truck" hero shot, as pure math shared by the
 * deterministic frame capture (dev/demo.ts case "bridge") and the live, in-game
 * experience (gameplay/bridgeShow.ts). Both drive the SAME truck path and camera
 * move as a function of a single virtual time T, so the playable version and the
 * rendered reel are frame-for-frame the same shot.
 */

export const BRIDGE_SHOT_SECONDS = 14;
export const BRIDGE_FIRE_AT = 9.4; // launch the barrage late so it peaks at the cut
const SPEED = 25; // m/s — a believable parade cruise (~350 m over the shot)
const RIDE_H = 3.0; // chassis centre above the deck (wheels planted)
const START_BACK = 500; // metres back from the mid-span tower the drive begins

export type BridgePath = {
  start: THREE.Vector3;
  dir: THREE.Vector3;
  right: THREE.Vector3;
  heading: number;
  yawQ: THREE.Quaternion;
  speed: number;
  rideH: number;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const mixf = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The main-span path (bridge 0; drive line[1]→line[3], the high deck between the
 * towers). START sits ~500 m back from the mid-span tower so it looms ahead the
 * whole shot and the orbit never swings the camera into it.
 */
export function bridgePath(map: WorldMap): BridgePath {
  const line = map.meta.bridges[0].line;
  const mid = new THREE.Vector3(line[2][0], 0, line[2][1]);
  const dir = new THREE.Vector3(line[3][0] - line[1][0], 0, line[3][1] - line[1][1]).normalize();
  const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const heading = Math.atan2(-dir.x, -dir.z); // truck front (-Z) → dir
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  const start = mid.clone().addScaledVector(dir, -START_BACK);
  return { start, dir, right, heading, yawQ, speed: SPEED, rideH: RIDE_H };
}

/** Deck-following truck position at virtual time T (T<=0 parks at the start). */
export function bridgeTruckPos(T: number, path: BridgePath, map: WorldMap, out: THREE.Vector3): THREE.Vector3 {
  const s = path.speed * Math.max(0, T);
  const px = path.start.x + path.dir.x * s;
  const pz = path.start.z + path.dir.z * s;
  let deck = map.bridgeDeck(px, pz);
  if (!Number.isFinite(deck)) deck = 66;
  out.set(px, deck + path.rideH, pz);
  return out;
}

/**
 * Camera move: azimuth 0 = dead ahead (facing the truck) sweeping to π = behind,
 * orbiting past the bay side over T 3.4..8.2, then a slow crane-up push as the
 * shells go up. `camPos`/`look` are caller-owned scratch vectors.
 */
export function applyBridgeCamera(
  T: number,
  path: BridgePath,
  truckPos: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  camPos: THREE.Vector3,
  look: THREE.Vector3
) {
  const { dir, right } = path;
  const orbit = smooth((T - 3.4) / 4.8);
  const fin = smooth((T - 9.0) / 5.0);
  const a = mixf(0.55, Math.PI, orbit); // front-right 3/4 → dead behind
  const R = mixf(23, 30, orbit) - fin * 4; // ease in a slow push toward the show
  const H = mixf(4.6, 9.2, orbit) + fin * 2.2; // and crane up over the barrage
  camPos.copy(truckPos).addScaledVector(dir, Math.cos(a) * R).addScaledVector(right, Math.sin(a) * R);
  camPos.y = truckPos.y + H;
  const fwdLook = smooth((T - 8.0) / 2.6); // once behind, tip the look forward+up
  look.copy(truckPos).addScaledVector(dir, mixf(0, 42, fwdLook));
  look.y = truckPos.y + mixf(2.4, 6, fwdLook);
  camera.position.copy(camPos);
  camera.lookAt(look);
}

/**
 * Pin the player's truck onto the rail pose so it can't drift/tumble under the
 * shot — render pose (mesh + camera read this) plus the physics body/velocity.
 */
export function pinBridgeTruck(player: Player, physics: Physics, truckPos: THREE.Vector3, path: BridgePath) {
  const { yawQ, dir, speed } = path;
  player.renderPosition.copy(truckPos);
  player.position.copy(truckPos);
  player.renderQuaternion.copy(yawQ);
  player.quaternion.copy(yawQ);
  player.velocity.set(dir.x * speed, 0, dir.z * speed);
  player.speed = speed;
  player.meshes.truck.position.copy(truckPos);
  player.meshes.truck.quaternion.copy(yawQ);
  physics.world.setBodyTransform(player.body, [truckPos.x, truckPos.y, truckPos.z], [yawQ.x, yawQ.y, yawQ.z, yawQ.w]);
  physics.world.setBodyVelocity(player.body, [dir.x * speed, 0, dir.z * speed], [0, 0, 0]);
}
