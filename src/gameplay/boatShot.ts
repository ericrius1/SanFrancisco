import * as THREE from "three/webgpu";
import { waterHeight, type WorldMap } from "../world/heightmap";
import type { Player } from "../player/player";
import type { Physics } from "../core/physics";

/**
 * The Golden Gate "Freedom Boat" hero shot, as pure math shared by the
 * deterministic frame capture (dev/demo.ts case "ggboat") and (later) a live,
 * in-game experience. It is the sea-borne twin of the Freedom Truck bridge shot
 * (gameplay/bridgeShot.ts): the speedboat sails the strait *underneath* the
 * Golden Gate main span while the guitarist jams and a rocket battery fires a
 * red/white/blue barrage forward over the water. Both the boat pose AND the
 * camera are a pure function of a single virtual time T, so the rendered reel is
 * glassy-smooth and any live version is frame-for-frame the same shot.
 */

export const BOAT_SHOT_SECONDS = 14;
export const BOAT_FIRE_AT = 9.4; // launch the barrage late so it peaks near the pass-under

const SPEED = 18; // m/s — a believable fast cruise up the strait
const SEAT = 0.2; // hull origin above the live water surface
const START_BACK = 216; // metres back from mid-span the run begins → passes under ~T12

export type BoatPath = {
  start: THREE.Vector3;
  dir: THREE.Vector3; // horizontal travel unit (toward + under the bridge)
  right: THREE.Vector3;
  heading: number;
  yawQ: THREE.Quaternion;
  speed: number;
  seat: number;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const mixf = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The strait path under the Golden Gate: travel perpendicular to the
 * tower-to-tower span, straight through the mid-point of the main span (so the
 * boat passes dead under the centre of the deck), heading out toward the ocean
 * and the twilight afterglow. START sits ~216 m back on the bay side so the
 * bridge looms ahead the whole shot and the boat slips under near the climax.
 */
export function boatPath(map: WorldMap): BoatPath {
  const br = map.meta.bridges.find((b) => b.name === "Golden Gate Bridge") ?? map.meta.bridges[0];
  const [t1, t2] = br.towers;
  const mid = new THREE.Vector3((t1[0] + t2[0]) / 2, 0, (t1[1] + t2[1]) / 2);
  // deck runs tower→tower; the strait runs perpendicular to it
  const deck = new THREE.Vector3(t2[0] - t1[0], 0, t2[1] - t1[1]).normalize();
  const perp = new THREE.Vector3(-deck.z, 0, deck.x).normalize(); // across the strait (≈ +X, toward the bay)
  const dir = perp.clone().negate(); // travel toward the ocean (≈ −X) so the sunset sits ahead
  const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const heading = Math.atan2(-dir.x, -dir.z); // boat front (−Z) → dir
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  const start = mid.clone().addScaledVector(dir, -START_BACK); // back on the bay side
  return { start, dir, right, heading, yawQ, speed: SPEED, seat: SEAT };
}

/** Water-seated boat position at virtual time T (T<=0 parks at the start). */
export function boatPos(T: number, path: BoatPath, _map: WorldMap, out: THREE.Vector3): THREE.Vector3 {
  const s = path.speed * Math.max(0, T);
  const px = path.start.x + path.dir.x * s;
  const pz = path.start.z + path.dir.z * s;
  const wy = waterHeight(px, pz, T); // wave time = virtual T → pure fn of T (deterministic capture)
  out.set(px, wy + path.seat, pz);
  return out;
}

/**
 * Camera move: azimuth starts ahead facing the boat (front 3/4), orbits round to
 * dead behind over T 3.4..8.2, then a slow crane-up push that tips the look
 * forward and up so the tall bridge + the barrage fill the frame at the climax.
 * `camPos`/`look` are caller-owned scratch vectors.
 */
export function applyBoatCamera(
  T: number,
  path: BoatPath,
  pos: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  camPos: THREE.Vector3,
  look: THREE.Vector3
) {
  const { dir, right } = path;
  const orbit = smooth((T - 3.4) / 4.8);
  const fin = smooth((T - 9.0) / 5.0);
  const a = mixf(0.55, Math.PI, orbit); // front-right 3/4 → dead behind
  const R = mixf(22, 30, orbit) - fin * 4; // ease in a slow push toward the show
  const H = mixf(4.2, 8.6, orbit) + fin * 2.6; // and crane up over the barrage
  camPos.copy(pos).addScaledVector(dir, Math.cos(a) * R).addScaledVector(right, Math.sin(a) * R);
  camPos.y = pos.y + H;
  const fwdLook = smooth((T - 7.6) / 2.8); // once behind, tip the look forward + up the towers
  look.copy(pos).addScaledVector(dir, mixf(0, 48, fwdLook));
  look.y = pos.y + mixf(2.2, 9, fwdLook); // lift hard at the end to catch the deck + high shells
  camera.position.copy(camPos);
  camera.lookAt(look);
}

/**
 * Pin the player's speedboat onto the rail pose so it can't drift/tumble under
 * the shot — render pose (mesh + camera read this) plus the physics body. A
 * gentle bob + heel keeps the hull working the swell, and it trims bow-up like a
 * boat under way.
 */
export function pinBoat(player: Player, physics: Physics, pos: THREE.Vector3, path: BoatPath, T: number) {
  const { yawQ, dir, speed } = path;
  const heel = Math.sin(T * 0.9) * 0.05;
  const pitch = Math.sin(T * 1.15) * 0.03 - 0.04; // slight, plus a steady bow-up trim
  const q = new THREE.Quaternion()
    .copy(yawQ)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), heel));
  player.renderPosition.copy(pos);
  player.position.copy(pos);
  player.renderQuaternion.copy(q);
  player.quaternion.copy(q);
  player.velocity.set(dir.x * speed, 0, dir.z * speed);
  player.speed = speed;
  player.meshes.speedboat.position.copy(pos);
  player.meshes.speedboat.quaternion.copy(q);
  physics.world.setBodyTransform(player.body, [pos.x, pos.y, pos.z], [q.x, q.y, q.z, q.w]);
  physics.world.setBodyVelocity(player.body, [dir.x * speed, 0, dir.z * speed], [0, 0, 0]);
}
