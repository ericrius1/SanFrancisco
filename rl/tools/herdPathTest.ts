import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../core/nodeRagdoll.ts";
import { HORSE } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();

// Real trainer up-axis (full quaternion rotate of +Y), same as reward()/observe().
function upYfull(rag: HorseRagdoll): number {
  const q = rag.torsoLink.quat as [number, number, number, number];
  const [x, y, z, w] = q;
  // rotate (0,1,0): result.y = 1 - 2*(x^2+z^2) for a UNIT quat, but compute full form
  const ty = 2 * (z * 0 - x * 0); // unused axis terms; do it properly below
  void ty;
  // (0,1,0)
  const vx = 0, vy = 1, vz = 0;
  const txx = 2 * (y * vz - z * vy);
  const tyy = 2 * (z * vx - x * vz);
  const tzz = 2 * (x * vy - y * vx);
  return vy + w * tyy + (z * txx - x * tzz);
}
function torsoY(rag: HorseRagdoll): number { return rag.torsoLink.pos[1]; }

const PARK = { x: -5250, z: 2380 };
const ROAM = 78;
const DT = 1 / 60;

// ---- Mirror horseHerd.prePhysics WANDER path for one horse over 30 sim-seconds.
function wanderRun(seed: number) {
  let rng = seed;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const rag = new HorseRagdoll(box3d, HORSE, def);
  const a = rand() * Math.PI * 2, r = 6 + rand() * (ROAM - 8);
  const anchor = { x: PARK.x + Math.cos(a) * r, z: PARK.z + Math.sin(a) * r };
  let wanderYaw = rand() * Math.PI * 2;
  let wanderTimer = 2 + rand() * 4;
  rag.setGoal(Math.sin(wanderYaw), Math.cos(wanderYaw));
  let minUp = 1, minTorso = 9, resets = 0, framesLow = 0;
  const N = Math.round(30 / DT);
  for (let i = 0; i < N; i++) {
    wanderTimer -= DT;
    const t = rag.torsoLink;
    const wx = anchor.x + t.pos[0], wz = anchor.z + t.pos[2];
    const toCx = PARK.x - wx, toCz = PARK.z - wz;
    if (Math.hypot(toCx, toCz) > ROAM) { wanderYaw = Math.atan2(toCx, toCz); wanderTimer = 2 + rand() * 3; }
    else if (wanderTimer <= 0) { wanderYaw += (rand() - 0.5) * 1.6; wanderTimer = 3 + rand() * 5; }
    rag.setGoal(Math.sin(wanderYaw), Math.cos(wanderYaw));
    rag.update(DT);
    if (rag.fallen) { rag.reset(); resets++; }
    const uy = upYfull(rag);
    if (uy < minUp) minUp = uy;
    if (torsoY(rag) < minTorso) minTorso = torsoY(rag);
    if (uy < 0.4) framesLow++; // trainer's real fall gate
  }
  rag.dispose();
  return { seed, minUp: minUp.toFixed(3), minTorso: minTorso.toFixed(3), resets, framesLowPct: (100 * framesLow / N).toFixed(1) };
}

// ---- Mirror the MOUNT transition: horse walking forward, then rider mounts and
// the goal flips to the NEGATED steer convention while facing a fresh direction.
function mountRun(steerYaw: number) {
  const rag = new HorseRagdoll(box3d, HORSE, def);
  // walk forward 3 s to reach the settled gait
  rag.setGoal(0, 1);
  for (let i = 0; i < Math.round(3 / DT); i++) rag.update(DT);
  const before = { up: upYfull(rag).toFixed(3), y: torsoY(rag).toFixed(3) };
  // now "mount": ridden branch feeds goal=(-sin,-cos) of the camera yaw
  let minUp = 1;
  for (let i = 0; i < Math.round(4 / DT); i++) {
    rag.setGoal(-Math.sin(steerYaw), -Math.cos(steerYaw));
    rag.update(DT);
    if (rag.fallen) rag.reset();
    const uy = upYfull(rag);
    if (uy < minUp) minUp = uy;
  }
  const after = { up: upYfull(rag).toFixed(3), y: torsoY(rag).toFixed(3) };
  rag.dispose();
  return { steerYaw: steerYaw.toFixed(2), before, minUpDuringMount: minUp.toFixed(3), after };
}

console.log("== WANDER path (real herd goal logic), 30s each, trainer up-gate<0.4 ==");
for (const s of [1, 7, 42, 1234, 99999]) console.log(JSON.stringify(wanderRun(s)));

console.log("\n== MOUNT transition (goal flips to -(sin,cos) of cam yaw) ==");
for (const y of [0, Math.PI, Math.PI / 2, 2.5]) console.log(JSON.stringify(mountRun(y)));
