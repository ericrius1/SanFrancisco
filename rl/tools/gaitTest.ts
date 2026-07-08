/**
 * Fast Node proxy for gait CONTROL + stability on the real runtime ragdoll.
 * Commands walk / trot / gallop in turn and checks the horse actually tracks each
 * commanded speed while staying tall and never tipping. Complements the browser
 * paddock-verify (ground truth) with a quick iterate-able signal.
 *
 *   node --experimental-strip-types rl/tools/gaitTest.ts
 */
import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../../src/gameplay/horse/horseRagdoll.ts";
import { HORSE, qRot } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();
const upY = (q: readonly number[]) => 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
const dt = 1 / 60;

const GAITS = [
  { name: "walk", cmd: 0.25 },
  { name: "trot", cmd: 0.5 },
  { name: "gallop", cmd: 0.8 }
];

let allOK = true;
for (const g of GAITS) {
  const rag = new HorseRagdoll(box3d, HORSE, def, 2.3);
  const unit = rag.speedUnit; // sqrt(g*H) for this body
  rag.setSpeed(g.cmd);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let goalYaw = 0, gx = 0, gz = 1;
  let fell = false, tallSum = 0, spdSum = 0, n = 0;
  for (let i = 0; i < 780; i++) { // 13s
    if (i > 0 && i % 150 === 0) goalYaw += (rand() - 0.5) * 2.0; // gentle wander
    const tx = Math.sin(goalYaw), tz = Math.cos(goalYaw), k = 1 - Math.exp(-dt / 0.45);
    gx += (tx - gx) * k; gz += (tz - gz) * k;
    rag.setGoal(gx, gz);
    rag.setSpeed(g.cmd);
    rag.update(dt);
    const t = rag.torsoLink;
    if (i >= 120) { // after it settles into the gait
      if (upY(t.quat) < 0.35) fell = true;
      tallSum += t.pos[1] / rag.standY;
      const nose = qRot(t.quat, [0, 0, 1]);
      spdSum += (t.vel[0] * nose[0] + t.vel[2] * nose[2]) / unit; // non-dim nose speed
      n++;
    }
  }
  const gotND = spdSum / n; // achieved Froude speed
  const meanTall = tallSum / n;
  const err = Math.abs(gotND - g.cmd);
  const tol = 0.18 + 0.3 * g.cmd;
  const slowOK = g.cmd > 0.35 || gotND < 0.5; // a walk must actually be slow
  const fastOK = g.cmd < 0.65 || gotND > 0.55; // a gallop must actually be fast
  const speedOK = err < tol && slowOK && fastOK;
  const tallOK = meanTall > 0.72;
  const ok = speedOK && tallOK && !fell;
  allOK &&= ok;
  console.log(`${g.name.padEnd(6)} cmd ${g.cmd.toFixed(2)}  got ${gotND.toFixed(2)} (err ${err.toFixed(2)}/tol ${tol.toFixed(2)})  meanTall ${meanTall.toFixed(2)}  fell ${fell}  ${ok ? "OK" : "FAIL"}`);
}
console.log(allOK ? "PASS — tracks walk/trot/gallop, tall, never tips" : "FAIL — gait control or stability off");
